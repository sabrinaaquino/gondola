import { getChampion, saveTrace } from "./store";
import { RUNTIME_VERSION, type ModelCallRecord, type RunTrace, type ToolCallRecord, type TraceArtifact, type TraceRouting } from "./types";

// Bridge from the live acting runtime into the Lab's immutable trace store.
//
// Every non-hidden turn writes ONE draft (non-finalized) RunTrace here. These
// traces are the feedstock the Lab reviewer/evaluation reads to spot repeated
// failures and propose bounded improvements. This module is observation only:
// writing a trace never grades, changes, promotes, or rolls back anything, so
// the acting runtime still never grades its own homework.
//
// It is best-effort by contract: callers invoke it fire-and-forget and a trace
// failure must never affect the turn the user actually asked for.

// Live turns are not produced by a Lab-versioned config. Tag them so the Lab can
// tell observed production runs apart from its own champion/challenger runs.
export const LIVE_CONFIG_VERSION = "live-runtime";

const MEDIA_ARTIFACT_KIND: Record<string, TraceArtifact["kind"]> = {
  generate_image: "image",
  generate_video: "video",
  generate_music: "audio",
};

export interface LiveTraceInput {
  /** The user's request for this turn (the goal the run tried to satisfy). */
  goal: string;
  /** Models actually used or attempted this turn. */
  modelsSelected: string[];
  /** One entry per assistant model call, with its reported spend. */
  modelCosts: Array<{ model: string; costUsd: number }>;
  /** Every tool outcome observed this turn, in execution order. */
  toolCalls: ToolCallRecord[];
  /** Number of times the turn had to stop and ask the human to proceed. */
  humanInterventions?: number;
  latencyMs: number;
  completed: boolean;
  finalOutput: string;
  /** Explainable routing recommendation vs. what actually ran. */
  routing?: TraceRouting;
}

/**
 * Persist a single live turn as a draft RunTrace under .gondola/lab/traces.
 * Returns the stored trace, or undefined if persistence failed (never throws
 * for a reason the caller should surface to the user).
 */
export async function recordLiveTrace(input: LiveTraceInput): Promise<RunTrace | undefined> {
  try {
    const champion = await getChampion().catch(() => undefined);
    const modelCalls: ModelCallRecord[] = input.modelCosts.map((call) => ({
      model: call.model,
      purpose: "chat",
      costUsd: round(call.costUsd),
      latencyMs: 0,
    }));
    const costUsd = round(modelCalls.reduce((sum, call) => sum + call.costUsd, 0));
    const artifacts: TraceArtifact[] = input.toolCalls
      .filter((call) => call.ok && MEDIA_ARTIFACT_KIND[call.tool])
      .map((call) => ({ id: crypto.randomUUID(), kind: MEDIA_ARTIFACT_KIND[call.tool], approved: false }));
    const trace: RunTrace = {
      runId: crypto.randomUUID(),
      runtimeVersion: RUNTIME_VERSION,
      configVersionId: champion?.versionId ?? LIVE_CONFIG_VERSION,
      goal: input.goal.replace(/\s+/g, " ").trim().slice(0, 2_000),
      constraints: [],
      modelsSelected: [...new Set(input.modelsSelected.filter(Boolean))],
      modelCalls,
      toolCalls: input.toolCalls,
      toolErrors: input.toolCalls.filter((call) => !call.ok).map((call) => call.error ?? `${call.tool} failed`),
      artifacts,
      humanInterventions: Math.max(0, Math.floor(input.humanInterventions ?? 0)),
      costUsd,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      completed: input.completed,
      finalOutput: (input.finalOutput ?? "").slice(0, 4_000),
      ...(input.routing ? { routing: input.routing } : {}),
      finalized: false,
      createdAt: new Date().toISOString(),
    };
    return await saveTrace(trace);
  } catch {
    return undefined;
  }
}

function round(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}
