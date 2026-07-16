import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerAsset, type AssetKind } from "./assets";
import { isTerminalFailureStatus, retrieveMediaOnce, type MediaRetrieveInput, type MediaRetrieveOutcome } from "./media-service";

type Retriever = (input: MediaRetrieveInput, signal?: AbortSignal) => Promise<MediaRetrieveOutcome>;

// Durable asynchronous media task lifecycle.
//
// Venice video/music generation is a queue: generate_* returns a queueId and
// the finished file must be retrieved later. Previously only the browser polled
// for results, so the agent could request creative work but never own its
// completion. A MediaTask makes that ownership durable: it survives restarts,
// exposes explicit states, and awaitMediaTask() downloads the finished binary,
// saves it under .gondola/media, and registers it in the asset manifest.

const ROOT = path.join(process.cwd(), ".gondola");
const FILE = path.join(ROOT, "media-tasks.json");
export const MEDIA_DIR = path.join(ROOT, "media");
const MAX_TASKS = 500;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 8;
// How long the shared retrieval loop keeps trying, independent of any single
// caller's wait. Also the lease window used to detect a stale retrieval after a
// crash so a fresh await can safely take over.
const MAX_RETRIEVAL_MS = 30 * 60 * 1000;
const RETRIEVAL_LEASE_MS = 60 * 1000;

export type MediaTaskType = "image" | "video" | "music" | "speech";
export type MediaTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface MediaTask {
  id: string;
  /** Venice queue id. */
  providerTaskId: string;
  /** Which retrieval endpoint family this job uses. */
  kind: "video" | "music";
  type: MediaTaskType;
  status: MediaTaskStatus;
  createdAt: string;
  updatedAt: string;
  prompt?: string;
  model?: string;
  downloadUrl?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  outputPath?: string;
  outputUrl?: string;
  error?: string;
  assetId?: string;
  originatingRunId?: string;
  originatingAgentId?: string;
  projectId?: string;
  /** The conversation this job belongs to — ties a queued job to runtime state
   *  so it can never become detached from the agent that started it. */
  conversationId?: string;
  /** The goal/objective that was active when the job was queued. */
  goal?: string;
  /** Asset ids used as source material (e.g. an image-to-video reference). */
  sourceAssetIds?: string[];
  /** How many times retrieval has polled the provider for this job. */
  retrievalAttempts?: number;
  /** ISO timestamp of the most recent retrieval poll. */
  lastPolledAt?: string;
  /** Wall-clock ms until which the active retrieval owner holds its lease. */
  retrievalLeaseUntil?: number;
}

interface MediaTaskStore {
  version: 1;
  tasks: MediaTask[];
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function read(): Promise<MediaTaskStore> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Partial<MediaTaskStore>;
    return { version: 1, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

async function write(store: MediaTaskStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, FILE);
}

export interface CreateMediaTaskInput {
  providerTaskId: string;
  kind: "video" | "music";
  type: MediaTaskType;
  status?: MediaTaskStatus;
  prompt?: string;
  model?: string;
  downloadUrl?: string;
  estimatedCostUsd?: number;
  originatingRunId?: string;
  originatingAgentId?: string;
  projectId?: string;
  conversationId?: string;
  goal?: string;
  sourceAssetIds?: string[];
}

export async function createMediaTask(input: CreateMediaTaskInput): Promise<MediaTask> {
  const now = new Date().toISOString();
  const task: MediaTask = {
    id: crypto.randomUUID(),
    providerTaskId: input.providerTaskId,
    kind: input.kind,
    type: input.type,
    status: input.status ?? "queued",
    createdAt: now,
    updatedAt: now,
    prompt: input.prompt,
    model: input.model,
    downloadUrl: input.downloadUrl,
    estimatedCostUsd: input.estimatedCostUsd,
    originatingRunId: input.originatingRunId,
    originatingAgentId: input.originatingAgentId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    goal: input.goal,
    sourceAssetIds: input.sourceAssetIds,
    retrievalAttempts: 0,
  };
  return serial(async () => {
    const store = await read();
    store.tasks.push(task);
    if (store.tasks.length > MAX_TASKS) store.tasks = store.tasks.slice(-MAX_TASKS);
    await write(store);
    return task;
  });
}

export async function getMediaTask(id: string): Promise<MediaTask | undefined> {
  const store = await read();
  return store.tasks.find((task) => task.id === id);
}

export async function getMediaTaskByProviderId(providerTaskId: string): Promise<MediaTask | undefined> {
  const store = await read();
  return [...store.tasks].reverse().find((task) => task.providerTaskId === providerTaskId);
}

export async function listMediaTasks(options?: { limit?: number; status?: MediaTaskStatus }): Promise<MediaTask[]> {
  const store = await read();
  let tasks = store.tasks;
  if (options?.status) tasks = tasks.filter((task) => task.status === options.status);
  const sorted = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return options?.limit ? sorted.slice(0, options.limit) : sorted;
}

export async function updateMediaTask(id: string, patch: Partial<Omit<MediaTask, "id" | "createdAt">>): Promise<MediaTask | undefined> {
  return serial(async () => {
    const store = await read();
    const index = store.tasks.findIndex((task) => task.id === id);
    if (index === -1) return undefined;
    const next: MediaTask = { ...store.tasks[index], ...patch, id, updatedAt: new Date().toISOString() };
    store.tasks[index] = next;
    await write(store);
    return next;
  });
}

export async function deleteMediaTask(id: string): Promise<boolean> {
  return serial(async () => {
    const store = await read();
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((task) => task.id !== id);
    if (store.tasks.length === before) return false;
    await write(store);
    return true;
  });
}

export async function cancelMediaTask(id: string): Promise<MediaTask | undefined> {
  const task = await getMediaTask(id);
  if (!task) return undefined;
  if (task.status === "succeeded" || task.status === "failed") return task;
  // Venice has no cancel endpoint for a queued job; we mark it cancelled locally
  // so awaiters stop and the app stops owning it. The provider job may still run.
  return updateMediaTask(id, { status: "cancelled" });
}

function extensionForContentType(contentType: string): string {
  const subtype = contentType.split(";")[0].split("/")[1] ?? "";
  const map: Record<string, string> = {
    mp4: "mp4",
    webm: "webm",
    quicktime: "mov",
    mpeg: "mp3",
    mp3: "mp3",
    wav: "wav",
    "x-wav": "wav",
    ogg: "ogg",
    webp: "webp",
    png: "png",
    jpeg: "jpg",
  };
  return map[subtype] ?? (contentType.startsWith("video/") ? "mp4" : contentType.startsWith("audio/") ? "mp3" : "bin");
}

async function saveMediaBytes(task: MediaTask, bytes: ArrayBuffer, contentType: string): Promise<{ path: string; bytes: number }> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = extensionForContentType(contentType);
  const filePath = path.join(MEDIA_DIR, `${task.type}-${task.id}.${ext}`);
  const buffer = Buffer.from(bytes);
  await writeFile(filePath, buffer);
  return { path: filePath, bytes: buffer.byteLength };
}

/** Persist a base64 data URL (e.g. a synchronously generated image) to the media folder. */
export async function saveDataUrlToMedia(dataUrl: string, baseName: string): Promise<{ path: string; bytes: number; contentType: string } | undefined> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return undefined;
  await mkdir(MEDIA_DIR, { recursive: true });
  const contentType = match[1];
  const ext = extensionForContentType(contentType);
  const buffer = Buffer.from(match[2], "base64");
  const filePath = path.join(MEDIA_DIR, `${baseName}.${ext}`);
  await writeFile(filePath, buffer);
  return { path: filePath, bytes: buffer.byteLength, contentType };
}

/** True only when a candidate path resolves inside the managed media folder. */
export function isPathWithinMediaDir(candidate: string): boolean {
  const dir = path.resolve(MEDIA_DIR);
  const resolved = path.resolve(candidate);
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export interface AwaitMediaOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Injectable retriever for tests; defaults to the real Venice retrieval. */
  retrieve?: Retriever;
}

export interface AwaitMediaResult {
  task: MediaTask;
  state: "succeeded" | "failed" | "cancelled" | "timeout";
}

// Exactly one retrieval runs per task per process. Concurrent awaiters (the
// agent's media_task_await and the UI's status polling) share this promise, so
// Venice is polled once, the binary is saved once, and one asset is registered.
const inFlightRetrievals = new Map<string, Promise<AwaitMediaResult>>();

function ensureRetrieval(id: string, retrieve: Retriever): Promise<AwaitMediaResult> {
  const existing = inFlightRetrievals.get(id);
  if (existing) return existing;
  const promise = runRetrieval(id, retrieve).finally(() => {
    if (inFlightRetrievals.get(id) === promise) inFlightRetrievals.delete(id);
  });
  inFlightRetrievals.set(id, promise);
  return promise;
}

// The single owner loop. Runs to its own completion/timeout, decoupled from any
// caller's signal, so one observer going away never interrupts retrieval.
async function runRetrieval(id: string, retrieve: Retriever): Promise<AwaitMediaResult> {
  const startedAt = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - startedAt < MAX_RETRIEVAL_MS) {
    const current = await getMediaTask(id);
    if (!current) throw new Error(`Media task ${id} disappeared`);
    if (current.status === "succeeded") return { task: current, state: "succeeded" };
    if (current.status === "failed") return { task: current, state: "failed" };
    if (current.status === "cancelled") return { task: current, state: "cancelled" };
    if (!current.model) {
      const failed = await updateMediaTask(id, { status: "failed", error: "Task is missing its model." });
      return { task: failed ?? current, state: "failed" };
    }
    // Claim/refresh the retrieval lease so a stale "running" task left by a crash
    // can be recovered by a later await.
    await updateMediaTask(id, {
      status: "running",
      retrievalLeaseUntil: Date.now() + RETRIEVAL_LEASE_MS,
      retrievalAttempts: (current.retrievalAttempts ?? 0) + 1,
      lastPolledAt: new Date().toISOString(),
    });

    try {
      const outcome = await retrieve({ kind: current.kind, model: current.model, queueId: current.providerTaskId, downloadUrl: current.downloadUrl });
      consecutiveErrors = 0;
      if (outcome.state === "ready") {
        // Never save or register twice if another path already finished it.
        const latest = await getMediaTask(id);
        if (latest?.status === "succeeded" && latest.assetId) return { task: latest, state: "succeeded" };
        const saved = await saveMediaBytes(current, outcome.bytes, outcome.contentType);
        const assetKind: AssetKind = current.type === "music" ? "audio" : "video";
        const asset = await registerAsset({
          kind: assetKind,
          projectId: current.projectId,
          path: saved.path,
          sourceTaskId: current.id,
          prompt: current.prompt,
          model: current.model,
          estimatedCostUsd: current.estimatedCostUsd,
          metadata: { contentType: outcome.contentType, bytes: saved.bytes, providerTaskId: current.providerTaskId },
        });
        const updated = await updateMediaTask(id, { status: "succeeded", outputPath: saved.path, assetId: asset.id });
        return { task: updated ?? current, state: "succeeded" };
      }
      if (isTerminalFailureStatus(outcome.body.status)) {
        const message = String(outcome.body.message ?? outcome.body.error ?? outcome.body.status ?? "Media generation failed");
        const updated = await updateMediaTask(id, { status: "failed", error: message });
        return { task: updated ?? current, state: "failed" };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      consecutiveErrors += 1;
      if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
        const message = error instanceof Error ? error.message : "Retrieval failed repeatedly.";
        const updated = await updateMediaTask(id, { status: "failed", error: message });
        return { task: updated ?? current, state: "failed" };
      }
    }

    await wait(DEFAULT_POLL_INTERVAL_MS);
  }

  const timedOut = await getMediaTask(id);
  if (!timedOut) throw new Error(`Media task ${id} disappeared`);
  return { task: timedOut, state: "timeout" };
}

// Wait on the shared retrieval without cancelling it: whichever of the shared
// result, the caller's timeout, or the caller's abort settles first wins for
// this caller only.
function raceAgainstCaller(promise: Promise<AwaitMediaResult>, timeoutMs: number, signal?: AbortSignal): Promise<AwaitMediaResult | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const timer = setTimeout(() => finish(() => resolve(undefined)), timeoutMs);
    const onAbort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

/**
 * Await a task's completion. Idempotent and concurrency-safe: the underlying
 * retrieval runs at most once per task per process, a completed task returns its
 * existing asset immediately, and this call never cancels the shared retrieval
 * when its own timeout or signal fires. Survives restarts because task state is
 * persisted and a stale lease lets a later await resume.
 */
export async function awaitMediaTask(id: string, options?: AwaitMediaOptions): Promise<AwaitMediaResult> {
  const existing = await getMediaTask(id);
  if (!existing) throw new Error(`No media task with id ${id}`);
  if (existing.status === "succeeded" || existing.status === "failed" || existing.status === "cancelled") {
    return { task: existing, state: existing.status };
  }
  const shared = ensureRetrieval(id, options?.retrieve ?? retrieveMediaOnce);
  const result = await raceAgainstCaller(shared, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, options?.signal);
  if (result) return result;
  const snapshot = await getMediaTask(id);
  return { task: snapshot ?? existing, state: "timeout" };
}

/** Pure selection of tasks eligible for resume (queued/running), scoped + capped. */
export function selectResumableTasks(
  tasks: MediaTask[],
  options?: { conversationId?: string; limit?: number },
): MediaTask[] {
  const pending = tasks.filter((task) =>
    (task.status === "queued" || task.status === "running")
    && (!options?.conversationId || task.conversationId === options.conversationId));
  return options?.limit ? pending.slice(0, options.limit) : pending;
}

/**
 * Re-drive retrieval for any queued/running media tasks (optionally scoped to a
 * conversation). Safe to call repeatedly and concurrently: awaitMediaTask shares
 * one retrieval per task via the in-flight map + lease, so a detached job resumes
 * exactly once. Fire-and-forget — kicks the shared retrieval and returns the
 * tasks it resumed. This is the supervisor/turn-start recovery hook that stops a
 * queued job from becoming orphaned from the agent's runtime state.
 */
export async function resumePendingMediaTasks(
  options?: { conversationId?: string; limit?: number; retrieve?: Retriever },
): Promise<MediaTask[]> {
  const store = await read();
  const resumable = selectResumableTasks(store.tasks, options);
  for (const task of resumable) {
    void awaitMediaTask(task.id, { retrieve: options?.retrieve }).catch(() => undefined);
  }
  return resumable;
}

export interface MediaTaskStatusView {
  taskId: string;
  status: MediaTaskStatus;
  type: MediaTaskType;
  createdAt: string;
  updatedAt: string;
  assetId?: string;
  assetUrl?: string;
  error?: string;
}

/** UI-safe projection of a task: no credentials, provider ids, or local paths. */
export function toTaskStatusView(task: MediaTask): MediaTaskStatusView {
  return {
    taskId: task.id,
    status: task.status,
    type: task.type,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.status === "succeeded" && task.assetId
      ? { assetId: task.assetId, assetUrl: `/api/media/asset?id=${encodeURIComponent(task.assetId)}` }
      : {}),
    ...(task.status === "failed" && task.error ? { error: task.error.slice(0, 300) } : {}),
  };
}
