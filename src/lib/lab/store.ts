import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConfigState,
  ConfigVersion,
  DeterministicEvaluation,
  EvaluationRecord,
  ImprovementProposal,
  LabConfig,
  PromotionRecord,
  RunTrace,
  SemanticEvaluation,
} from "./types";

// All Lab state lives under .gondola/lab, separate from the acting runtime's
// data. Finalized traces are written once and never mutated.

// Root is resolved lazily so tests (and isolated runs) can point at a temp dir
// via GONDOLA_LAB_ROOT without touching real Lab state.
function labRoot(): string {
  return process.env.GONDOLA_LAB_ROOT?.trim() || path.join(process.cwd(), ".gondola", "lab");
}
function tracesDir(): string { return path.join(labRoot(), "traces"); }
function configFile(): string { return path.join(labRoot(), "config.json"); }
function proposalsFile(): string { return path.join(labRoot(), "proposals.json"); }
function evalsFile(): string { return path.join(labRoot(), "evaluations.json"); }

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function hashConfig(config: LabConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

// ── Traces ────────────────────────────────────────────────────────────────────

function traceFile(runId: string): string {
  return path.join(tracesDir(), `${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

export async function getTrace(runId: string): Promise<RunTrace | undefined> {
  try {
    return JSON.parse(await readFile(traceFile(runId), "utf8")) as RunTrace;
  } catch {
    return undefined;
  }
}

export async function listTraces(limit?: number): Promise<RunTrace[]> {
  const dir = tracesDir();
  await mkdir(dir, { recursive: true });
  const files = (await readdir(dir).catch(() => [])).filter((file) => file.endsWith(".json"));
  const traces: RunTrace[] = [];
  for (const file of files) {
    const parsed = await readJson<RunTrace | null>(path.join(dir, file), null);
    if (parsed) traces.push(parsed);
  }
  const sorted = traces.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return limit ? sorted.slice(0, limit) : sorted;
}

/** Write a trace once. Refuses to overwrite a finalized trace (immutability). */
export async function saveTrace(trace: RunTrace): Promise<RunTrace> {
  return serial(async () => {
    const existing = await getTrace(trace.runId);
    if (existing?.finalized) throw new Error("Finalized traces are immutable and cannot be modified.");
    await atomicWrite(traceFile(trace.runId), trace);
    return trace;
  });
}

/** Finalize a draft trace with its evaluations. Refuses to re-finalize. */
export async function finalizeTrace(runId: string, evals: { deterministic: DeterministicEvaluation; semantic: SemanticEvaluation }): Promise<RunTrace> {
  return serial(async () => {
    const existing = await getTrace(runId);
    if (!existing) throw new Error(`No trace with id ${runId}`);
    if (existing.finalized) throw new Error("Finalized traces are immutable and cannot be modified.");
    const finalized: RunTrace = { ...existing, ...evals, finalized: true, finalizedAt: new Date().toISOString() };
    await atomicWrite(traceFile(runId), finalized);
    return finalized;
  });
}

// ── Versioned configuration ────────────────────────────────────────────────────

export async function getConfigState(): Promise<ConfigState> {
  return readJson<ConfigState>(configFile(), { championVersionId: null, versions: [], history: [] });
}

export async function getVersion(versionId: string): Promise<ConfigVersion | undefined> {
  const state = await getConfigState();
  return state.versions.find((version) => version.versionId === versionId);
}

export async function getChampion(): Promise<ConfigVersion | undefined> {
  const state = await getConfigState();
  return state.championVersionId ? state.versions.find((version) => version.versionId === state.championVersionId) : undefined;
}

function newVersion(config: LabConfig, parentVersionId: string | null, sourceProposalId: string | null, changeSummary: string): ConfigVersion {
  return {
    versionId: crypto.randomUUID(),
    parentVersionId,
    sourceProposalId,
    createdAt: new Date().toISOString(),
    contentHash: hashConfig(config),
    changeSummary,
    config,
  };
}

/** Create the first champion. No-op if a champion already exists. */
export async function initChampion(config: LabConfig, changeSummary: string): Promise<ConfigVersion> {
  return serial(async () => {
    const state = await getConfigState();
    if (state.championVersionId) {
      const existing = state.versions.find((version) => version.versionId === state.championVersionId);
      if (existing) return existing;
    }
    const version = newVersion(config, null, null, changeSummary);
    state.versions.push(version);
    state.championVersionId = version.versionId;
    await atomicWrite(configFile(), state);
    return version;
  });
}

/** Create a challenger version. Never touches the champion pointer. */
export async function createChallenger(config: LabConfig, options: { parentVersionId: string | null; sourceProposalId: string | null; changeSummary: string }): Promise<ConfigVersion> {
  return serial(async () => {
    const state = await getConfigState();
    const version = newVersion(config, options.parentVersionId, options.sourceProposalId, options.changeSummary);
    state.versions.push(version);
    await atomicWrite(configFile(), state);
    return version;
  });
}

/** Low-level promotion: sets the champion pointer and records history. */
export async function promoteVersion(versionId: string, meta: { proposalId: string | null; evaluationId: string | null; approvedBy: string }): Promise<ConfigVersion> {
  return serial(async () => {
    const state = await getConfigState();
    const version = state.versions.find((candidate) => candidate.versionId === versionId);
    if (!version) throw new Error(`No config version ${versionId}`);
    const record: PromotionRecord = {
      action: "promote",
      fromVersionId: state.championVersionId,
      toVersionId: versionId,
      proposalId: meta.proposalId,
      evaluationId: meta.evaluationId,
      approvedBy: meta.approvedBy,
      approvedAt: new Date().toISOString(),
    };
    state.championVersionId = versionId;
    state.history.push(record);
    await atomicWrite(configFile(), state);
    return version;
  });
}

/** Restore the previous champion in a single operation. */
export async function rollbackChampion(approvedBy: string): Promise<ConfigVersion | undefined> {
  return serial(async () => {
    const state = await getConfigState();
    const lastPromotion = [...state.history].reverse().find((record) => record.action === "promote" && record.fromVersionId);
    if (!lastPromotion?.fromVersionId) return undefined;
    const previous = state.versions.find((version) => version.versionId === lastPromotion.fromVersionId);
    if (!previous) return undefined;
    state.history.push({
      action: "rollback",
      fromVersionId: state.championVersionId,
      toVersionId: previous.versionId,
      proposalId: lastPromotion.proposalId,
      evaluationId: lastPromotion.evaluationId,
      approvedBy,
      approvedAt: new Date().toISOString(),
    });
    state.championVersionId = previous.versionId;
    await atomicWrite(configFile(), state);
    return previous;
  });
}

// ── Proposals ──────────────────────────────────────────────────────────────────

export async function listProposals(): Promise<ImprovementProposal[]> {
  const store = await readJson<{ proposals: ImprovementProposal[] }>(proposalsFile(), { proposals: [] });
  return [...store.proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProposal(proposalId: string): Promise<ImprovementProposal | undefined> {
  const store = await readJson<{ proposals: ImprovementProposal[] }>(proposalsFile(), { proposals: [] });
  return store.proposals.find((proposal) => proposal.proposalId === proposalId);
}

export async function saveProposal(proposal: ImprovementProposal): Promise<ImprovementProposal> {
  return serial(async () => {
    const store = await readJson<{ proposals: ImprovementProposal[] }>(proposalsFile(), { proposals: [] });
    const index = store.proposals.findIndex((candidate) => candidate.proposalId === proposal.proposalId);
    if (index >= 0) store.proposals[index] = proposal;
    else store.proposals.push(proposal);
    await atomicWrite(proposalsFile(), store);
    return proposal;
  });
}

/** Remove a proposal record. Returns true if one was removed. Immutable traces,
 * config versions, and evaluations are left intact for audit. */
export async function deleteProposal(proposalId: string): Promise<boolean> {
  return serial(async () => {
    const store = await readJson<{ proposals: ImprovementProposal[] }>(proposalsFile(), { proposals: [] });
    const remaining = store.proposals.filter((proposal) => proposal.proposalId !== proposalId);
    if (remaining.length === store.proposals.length) return false;
    await atomicWrite(proposalsFile(), { proposals: remaining });
    return true;
  });
}

// ── Evaluations ────────────────────────────────────────────────────────────────

export async function saveEvaluation(evaluation: EvaluationRecord): Promise<EvaluationRecord> {
  return serial(async () => {
    const store = await readJson<{ evaluations: EvaluationRecord[] }>(evalsFile(), { evaluations: [] });
    const index = store.evaluations.findIndex((candidate) => candidate.evaluationId === evaluation.evaluationId);
    if (index >= 0) store.evaluations[index] = evaluation;
    else store.evaluations.push(evaluation);
    await atomicWrite(evalsFile(), store);
    return evaluation;
  });
}

export async function getEvaluation(evaluationId: string): Promise<EvaluationRecord | undefined> {
  const store = await readJson<{ evaluations: EvaluationRecord[] }>(evalsFile(), { evaluations: [] });
  return store.evaluations.find((evaluation) => evaluation.evaluationId === evaluationId);
}
