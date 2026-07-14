// OpenClaw-style two-lane run queue.
//
// OpenClaw serializes agent turns per session (so a session's tools and state
// never race) while a global lane bounds total concurrency across sessions.
// Every entry point that starts an agent turn, including the HTTP route, scheduled
// heartbeats, and inbound channel messages, funnels through here, so two turns
// for the same conversation can never run at once regardless of source.

interface QueueEntry {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface SessionLane {
  chain: Promise<void>;
  depth: number;
}

const MAX_GLOBAL_CONCURRENCY = 3;

const globalCache = globalThis as typeof globalThis & {
  __novaRunLanes?: Map<string, SessionLane>;
  __novaGlobalWaiters?: Array<() => void>;
  __novaGlobalActive?: { count: number };
};

const lanes = globalCache.__novaRunLanes ?? new Map<string, SessionLane>();
globalCache.__novaRunLanes = lanes;
const globalWaiters = globalCache.__novaGlobalWaiters ?? [];
globalCache.__novaGlobalWaiters = globalWaiters;
const globalActive = globalCache.__novaGlobalActive ?? { count: 0 };
globalCache.__novaGlobalActive = globalActive;

async function acquireGlobalSlot(): Promise<void> {
  if (globalActive.count < MAX_GLOBAL_CONCURRENCY) {
    globalActive.count += 1;
    return;
  }
  await new Promise<void>((resolve) => globalWaiters.push(resolve));
  globalActive.count += 1;
}

function releaseGlobalSlot(): void {
  globalActive.count -= 1;
  const next = globalWaiters.shift();
  if (next) next();
}

export interface EnqueueOptions {
  /** When true (default) the task waits behind other tasks for the same session. */
  serializePerSession?: boolean;
}

/**
 * Enqueue an agent turn. Tasks for the same `sessionId` run strictly one at a
 * time (session lane); across sessions, at most `MAX_GLOBAL_CONCURRENCY` run
 * concurrently (global lane).
 */
export function enqueueRun<T>(
  sessionId: string,
  task: () => Promise<T>,
  options: EnqueueOptions = {},
): Promise<T> {
  const serializePerSession = options.serializePerSession !== false;
  const guarded = async (): Promise<T> => {
    await acquireGlobalSlot();
    try {
      return await task();
    } finally {
      releaseGlobalSlot();
    }
  };

  if (!serializePerSession) return guarded();

  const lane = lanes.get(sessionId) ?? { chain: Promise.resolve(), depth: 0 };
  lane.depth += 1;
  lanes.set(sessionId, lane);

  const result = lane.chain.then(guarded, guarded);
  lane.chain = result.then(() => undefined, () => undefined).then(() => {
    lane.depth -= 1;
    if (lane.depth <= 0 && lanes.get(sessionId) === lane) lanes.delete(sessionId);
  });
  return result;
}

/** Number of queued or running turns for a session (0 when idle). */
export function sessionQueueDepth(sessionId: string): number {
  return lanes.get(sessionId)?.depth ?? 0;
}

export function isSessionBusy(sessionId: string): boolean {
  return sessionQueueDepth(sessionId) > 0;
}

export function runQueueStats(): { activeSessions: number; globalActive: number; globalWaiting: number } {
  return {
    activeSessions: lanes.size,
    globalActive: globalActive.count,
    globalWaiting: globalWaiters.length,
  };
}
