import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTextSink } from "./emit-sink";
import { enqueueAgentTurn } from "./pi-agent";
import { createConversation, getConversation } from "./workspace";
import { deliverToTelegram } from "./gateway";
import { runGoalLoop } from "./loop";

// Heartbeat and scheduled tasks are the slow "temporal loops" that let the agent
// act proactively instead of only reacting to a live user. A scheduled task is
// a stored instruction plus a cadence; when due, the scheduler runs it as an
// agent-initiated turn through the same run queue as interactive turns and
// delivers the result to a conversation and/or a messaging channel.

const ROOT = path.join(process.cwd(), ".gondola");
const SCHEDULES_FILE = path.join(ROOT, "schedules.json");
const SCHEDULE_LOCK_DIR = path.join(ROOT, "schedule-locks");
const TICK_INTERVAL_MS = 30_000;
const LOCK_STALE_MS = 15 * 60_000;

export type ScheduleDelivery = "conversation" | "telegram";

export interface ScheduledTask {
  id: string;
  title: string;
  agentId: string;
  conversationId?: string;
  prompt: string;
  intervalMinutes: number; // <= 0 means run once
  enabled: boolean;
  deliver: ScheduleDelivery;
  // When set, the task runs as a verified loop: it retries until a separate
  // judge confirms the output meets this finish line, or maxIterations is hit.
  goal?: string;
  maxIterations?: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastResult?: string;
  lastError?: string;
  lastVerified?: boolean;
  lastIterations?: number;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleStore {
  version: 1;
  tasks: ScheduledTask[];
}

const globalCache = globalThis as typeof globalThis & {
  __novaSchedulerTimer?: ReturnType<typeof setInterval> | null;
  __novaSchedulerRunning?: boolean;
};

let mutationQueue: Promise<unknown> = Promise.resolve();

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function now(): string {
  return new Date().toISOString();
}

async function readStore(): Promise<ScheduleStore> {
  try {
    const parsed = JSON.parse(await readFile(SCHEDULES_FILE, "utf8")) as Partial<ScheduleStore>;
    return { version: 1, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch (error) {
    if (isNotFound(error)) return { version: 1, tasks: [] };
    throw error;
  }
}

async function writeStore(store: ScheduleStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const temporary = `${SCHEDULES_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, SCHEDULES_FILE);
}

function taskLockPath(id: string): string {
  return path.join(SCHEDULE_LOCK_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`);
}

async function acquireTaskLock(id: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(SCHEDULE_LOCK_DIR, { recursive: true });
  const lockPath = taskLockPath(id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (attempt === 0 && lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

export async function listSchedules(): Promise<ScheduledTask[]> {
  return (await readStore()).tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createSchedule(input: {
  title: string;
  agentId: string;
  prompt: string;
  intervalMinutes: number;
  deliver?: ScheduleDelivery;
  conversationId?: string;
  startDelayMinutes?: number;
  goal?: string;
  maxIterations?: number;
}): Promise<ScheduledTask> {
  return serial(async () => {
    const store = await readStore();
    const timestamp = now();
    const interval = Number.isFinite(input.intervalMinutes) ? Math.max(0, Math.floor(input.intervalMinutes)) : 0;
    const startDelayMs = Math.max(0, (input.startDelayMinutes ?? (interval > 0 ? interval : 0))) * 60_000;
    const goal = input.goal?.trim().slice(0, 2_000);
    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      title: input.title.trim().slice(0, 120) || "Scheduled task",
      agentId: input.agentId,
      conversationId: input.conversationId,
      prompt: input.prompt.trim().slice(0, 4_000),
      intervalMinutes: interval,
      enabled: true,
      deliver: input.deliver ?? "conversation",
      ...(goal ? { goal, maxIterations: Math.max(1, Math.min(6, Math.floor(input.maxIterations ?? 3))) } : {}),
      nextRunAt: Date.now() + startDelayMs,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!task.prompt) throw new Error("A schedule prompt is required");
    if (!task.agentId) throw new Error("A schedule agent is required");
    store.tasks.push(task);
    await writeStore(store);
    return task;
  });
}

export async function updateSchedule(id: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask> {
  return serial(async () => {
    const store = await readStore();
    const index = store.tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new Error("Schedule not found");
    const current = store.tasks[index];
    const interval = typeof patch.intervalMinutes === "number"
      ? Math.max(0, Math.floor(patch.intervalMinutes))
      : current.intervalMinutes;
    const next: ScheduledTask = {
      ...current,
      ...(typeof patch.title === "string" ? { title: patch.title.trim().slice(0, 120) || current.title } : {}),
      ...(typeof patch.prompt === "string" ? { prompt: patch.prompt.trim().slice(0, 4_000) || current.prompt } : {}),
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(patch.deliver ? { deliver: patch.deliver } : {}),
      ...(typeof patch.goal === "string" ? { goal: patch.goal.trim().slice(0, 2_000) || undefined } : {}),
      ...(typeof patch.maxIterations === "number" ? { maxIterations: Math.max(1, Math.min(6, Math.floor(patch.maxIterations))) } : {}),
      intervalMinutes: interval,
      updatedAt: now(),
    };
    // Re-enabling or shortening the interval reschedules the next run.
    if (patch.enabled === true && current.enabled === false) {
      next.nextRunAt = Date.now() + (interval > 0 ? interval * 60_000 : 0);
    }
    store.tasks[index] = next;
    await writeStore(store);
    return next;
  });
}

export async function deleteSchedule(id: string): Promise<void> {
  return serial(async () => {
    const store = await readStore();
    store.tasks = store.tasks.filter((task) => task.id !== id);
    await writeStore(store);
  });
}

async function ensureConversation(task: ScheduledTask): Promise<string> {
  if (task.conversationId) {
    const ok = await getConversation(task.conversationId).then(() => true, () => false);
    if (ok) return task.conversationId;
  }
  const { conversation } = await createConversation(task.agentId);
  await serial(async () => {
    const store = await readStore();
    const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index >= 0) {
      store.tasks[index] = { ...store.tasks[index], conversationId: conversation.id };
      await writeStore(store);
    }
  });
  return conversation.id;
}

export async function runScheduleNow(id: string): Promise<ScheduledTask> {
  const store = await readStore();
  const task = store.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error("Schedule not found");
  const result = await executeTaskWithLock(task);
  if (!result) throw new Error("This scheduled task is already running");
  return result;
}

async function executeTask(task: ScheduledTask): Promise<ScheduledTask> {
  const conversationId = await ensureConversation(task);
  let result = "";
  let error: string | undefined;
  let verified: boolean | undefined;
  let iterations: number | undefined;

  if (task.goal && task.goal.trim()) {
    // Verified loop: retry until a separate judge confirms the finish line.
    const loop = await runGoalLoop({
      conversationId,
      agentId: task.agentId,
      prompt: `[Scheduled loop] ${task.prompt}`,
      goal: task.goal,
      maxIterations: task.maxIterations,
      taskId: task.id,
    });
    result = loop.output;
    error = loop.error;
    verified = loop.passed;
    iterations = loop.iterations;
  } else {
    // Plain heartbeat: a single agent-initiated turn.
    const sink = createTextSink();
    try {
      await enqueueAgentTurn({
        sessionId: conversationId,
        agentId: task.agentId,
        message: `[Scheduled heartbeat] ${task.prompt}`,
        emit: sink.emit,
        source: "schedule",
      });
    } catch (runError) {
      error = runError instanceof Error ? runError.message : "The scheduled turn failed";
    }
    result = sink.getText();
    error = error ?? sink.getError();
  }

  if (!error && result && task.deliver === "telegram") {
    const status = verified === false ? " (unverified because it did not meet the finish line)" : "";
    try {
      await deliverToTelegram(`${task.title}${status}\n\n${result}`);
    } catch (deliveryError) {
      error = `Telegram delivery failed: ${deliveryError instanceof Error ? deliveryError.message : "unknown error"}`;
    }
  }

  return serial(async () => {
    const store = await readStore();
    const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index === -1) return task;
    const current = store.tasks[index];
    const runAt = Date.now();
    const updated: ScheduledTask = {
      ...current,
      conversationId,
      lastRunAt: runAt,
      lastResult: result ? result.slice(0, 500) : current.lastResult,
      lastError: error,
      lastVerified: verified,
      lastIterations: iterations,
      enabled: current.intervalMinutes > 0 ? current.enabled : false,
      nextRunAt: current.intervalMinutes > 0 ? runAt + current.intervalMinutes * 60_000 : current.nextRunAt,
      updatedAt: now(),
    };
    store.tasks[index] = updated;
    await writeStore(store);
    return updated;
  });
}

async function recordTaskFailure(task: ScheduledTask, runError: unknown): Promise<ScheduledTask> {
  return serial(async () => {
    const store = await readStore();
    const index = store.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index === -1) return task;
    const current = store.tasks[index];
    const runAt = Date.now();
    const updated: ScheduledTask = {
      ...current,
      lastRunAt: runAt,
      lastError: runError instanceof Error ? runError.message.slice(0, 500) : "The scheduled task failed",
      enabled: current.intervalMinutes > 0 ? current.enabled : false,
      nextRunAt: current.intervalMinutes > 0
        ? runAt + Math.max(1, current.intervalMinutes) * 60_000
        : current.nextRunAt,
      updatedAt: now(),
    };
    store.tasks[index] = updated;
    await writeStore(store);
    return updated;
  });
}

async function executeTaskWithLock(task: ScheduledTask): Promise<ScheduledTask | undefined> {
  const release = await acquireTaskLock(task.id);
  if (!release) return undefined;
  try {
    return await executeTask(task);
  } catch (error) {
    return recordTaskFailure(task, error);
  } finally {
    await release();
  }
}

export async function tickSchedules(): Promise<number> {
  const store = await readStore();
  const due = store.tasks.filter((task) => task.enabled && task.nextRunAt <= Date.now());
  let ran = 0;
  for (const task of due) {
    if (await executeTaskWithLock(task)) ran += 1;
  }
  return ran;
}

export function ensureSchedulerStarted(): void {
  if (globalCache.__novaSchedulerTimer) return;
  globalCache.__novaSchedulerTimer = setInterval(() => {
    if (globalCache.__novaSchedulerRunning) return;
    globalCache.__novaSchedulerRunning = true;
    void tickSchedules()
      .catch(() => undefined)
      .finally(() => {
        globalCache.__novaSchedulerRunning = false;
      });
  }, TICK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (globalCache.__novaSchedulerTimer) {
    clearInterval(globalCache.__novaSchedulerTimer);
    globalCache.__novaSchedulerTimer = null;
  }
}
