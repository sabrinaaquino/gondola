import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SMART_FAST_CHAT_MODEL } from "../app-types";
import { getVersion, saveEvaluation, saveTrace } from "./store";
import {
  RUNTIME_VERSION,
  type AgentRole,
  type CaseComparison,
  type ComparisonReport,
  type ConfigVersion,
  type DeterministicCheck,
  type DeterministicEvaluation,
  type EvaluationCase,
  type EvaluationRecord,
  type GateResult,
  type JudgeConfig,
  type LabConfig,
  type ModelCallRecord,
  type PromotionThresholds,
  type RoutingConfig,
  type RunGrade,
  type RunTrace,
  type ToolCallRecord,
  type TraceArtifact,
  type WorkflowPolicy,
} from "./types";

// ── Fixed, versioned control-plane configuration ─────────────────────────────
// These are NOT proposable. Proposals may never change graders, the judge, or
// the promotion thresholds.

export const JUDGE_CONFIG: JudgeConfig = Object.freeze({
  version: "judge-v1",
  model: SMART_FAST_CHAT_MODEL,
  prompt: "You are a fixed, versioned quality judge for short vertical AI-brand videos. Score 0-10 for technical feel, personal voice, and avoidance of generic advertisement tropes. Judge only the described result and process evidence.",
});

export const PROMOTION_THRESHOLDS: PromotionThresholds = Object.freeze({
  minQualityImprovementPct: 5,
  maxCostIncreasePct: 25,
});

// ── Default champion configuration + fixed evaluation cases ───────────────────

export const NAIVE_WORKFLOW_POLICY: WorkflowPolicy = {
  conceptCount: 1,
  useSeparateCritic: false,
  requireAnalyzeBeforeAnimate: false,
  reviseBelowQuality: null,
  maxRevisions: 0,
  budgetUsd: 1.0,
};

export const DEFAULT_ROUTING: RoutingConfig = {
  defaultModel: SMART_FAST_CHAT_MODEL,
  rules: [{ role: "creator", model: SMART_FAST_CHAT_MODEL }, { role: "critic", model: SMART_FAST_CHAT_MODEL }],
};

const DEFAULT_ROLES: AgentRole[] = [{ name: "creator", instructions: "Create the requested media end to end." }];

export function naiveChampionConfig(): LabConfig {
  return {
    workflowPolicy: { ...NAIVE_WORKFLOW_POLICY },
    routing: { defaultModel: DEFAULT_ROUTING.defaultModel, rules: DEFAULT_ROUTING.rules.map((rule) => ({ ...rule })) },
    roles: DEFAULT_ROLES.map((role) => ({ ...role })),
    toolDescriptions: {},
  };
}

// Fixed case registry (versioned by being source-controlled). The proposal
// generator only ever sees trigger + validation cases; held-out and replay
// cases are reserved for the evaluator.
export const CASE_REGISTRY: EvaluationCase[] = [
  { id: "trigger-intro", kind: "trigger", difficulty: 0.6, task: "Create a short vertical visual introducing Gondola; it should feel technical, personal, and not like a conventional product ad. Concept, inspect, revise where needed, then a short video from the approved image." },
  { id: "validation-feature", kind: "validation", difficulty: 0.55, task: "Create a short vertical clip showing Gondola orchestrating multiple AI models." },
  { id: "validation-quote", kind: "validation", difficulty: 0.45, task: "Create a short vertical visual of a single striking sentence about building your own AI agent." },
  { id: "heldout-behindscenes", kind: "held_out", difficulty: 0.7, task: "Create a short vertical behind-the-scenes visual of an AI agent editing its own tools." },
  { id: "replay-titlecard", kind: "replay", difficulty: 0.3, championBaselinePass: true, task: "Create a simple vertical title card image and animate it subtly." },
];

export function reviewerVisibleCases(): EvaluationCase[] {
  return CASE_REGISTRY.filter((testCase) => testCase.kind === "trigger" || testCase.kind === "validation");
}

// ── Simulated, policy-aware task runner (behind the TaskRunner seam) ──────────

export interface TaskRunInput {
  config: LabConfig;
  taskCase: EvaluationCase;
  workspaceDir: string;
  role: "champion" | "challenger";
  configVersionId: string;
  seed: number;
}

export type TaskRunner = (input: TaskRunInput) => Promise<RunTrace>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function firstIndex(toolCalls: ToolCallRecord[], tool: string): number {
  return toolCalls.findIndex((call) => call.tool === tool);
}

function analyzeBeforeVideo(trace: RunTrace): boolean {
  const video = firstIndex(trace.toolCalls, "generate_video");
  const analyze = firstIndex(trace.toolCalls, "analyze_media");
  return video !== -1 && analyze !== -1 && analyze < video;
}

function hasUnapprovedAnimation(trace: RunTrace): boolean {
  const video = firstIndex(trace.toolCalls, "generate_video");
  if (video === -1) return false;
  return !analyzeBeforeVideo(trace);
}

// The quality model, computed only from evidence a judge could observe in the
// trace (never from the hidden case difficulty), so champion vs challenger on a
// case is a fair comparison and fully reproducible.
function qualityFromFeatures(features: { concepts: number; critic: boolean; revisions: number; animatedUnapproved: boolean; toolFailures: number }): number {
  let score = 5;
  if (features.concepts > 1) score += 1;
  if (features.critic) score += 1.5;
  score += Math.min(2, features.revisions);
  if (features.animatedUnapproved) score -= 2;
  score -= features.toolFailures;
  return clamp(round1(score), 0, 10);
}

function simulateCreativeRun(input: TaskRunInput): RunTrace {
  const policy = input.config.workflowPolicy;
  const textModel = input.config.routing.defaultModel;
  const videoModel = "wan-2-7-text-to-video";
  const modelCalls: ModelCallRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const artifacts: TraceArtifact[] = [];
  let cost = 0;

  const concepts = Math.max(1, policy.conceptCount);
  for (let index = 0; index < concepts; index += 1) {
    modelCalls.push({ model: textModel, purpose: "concept", costUsd: 0.02, latencyMs: 1200 });
    cost += 0.02;
  }
  const image: TraceArtifact = { id: `img-${input.configVersionId}-${input.taskCase.id}`, kind: "image", approved: false };
  artifacts.push(image);

  if (policy.useSeparateCritic) toolCalls.push({ tool: "analyze_media", ok: true });

  let revisions = 0;
  if (policy.reviseBelowQuality !== null) {
    while (revisions < policy.maxRevisions && cost + 0.02 <= policy.budgetUsd) {
      const provisional = qualityFromFeatures({ concepts, critic: policy.useSeparateCritic, revisions, animatedUnapproved: false, toolFailures: 0 });
      if (provisional >= policy.reviseBelowQuality) break;
      modelCalls.push({ model: textModel, purpose: "revise", costUsd: 0.02, latencyMs: 1000 });
      cost += 0.02;
      revisions += 1;
    }
  }

  let inspectedBeforeAnimation = false;
  if (policy.requireAnalyzeBeforeAnimate) {
    toolCalls.push({ tool: "analyze_media", ok: true });
    inspectedBeforeAnimation = true;
  }
  image.approved = inspectedBeforeAnimation || policy.useSeparateCritic;

  const animateCost = 0.2;
  let completed = true;
  let animatedUnapproved = false;
  if (cost + animateCost <= policy.budgetUsd) {
    toolCalls.push({ tool: "generate_video", ok: true });
    modelCalls.push({ model: videoModel, purpose: "animate", costUsd: animateCost, latencyMs: 8000 });
    cost += animateCost;
    artifacts.push({ id: `vid-${input.configVersionId}-${input.taskCase.id}`, kind: "video", approved: image.approved });
    animatedUnapproved = !inspectedBeforeAnimation;
  } else {
    completed = false;
  }

  let humanInterventions = 0;
  if (animatedUnapproved) humanInterventions += 2;
  if (!policy.useSeparateCritic) humanInterventions += 1;

  const latencyMs = modelCalls.reduce((total, call) => total + call.latencyMs, 0) + toolCalls.length * 200;

  return {
    runId: crypto.randomUUID(),
    runtimeVersion: RUNTIME_VERSION,
    configVersionId: input.configVersionId,
    goal: input.taskCase.task,
    constraints: [`budget<=${policy.budgetUsd}`],
    modelsSelected: [...new Set([textModel, videoModel])],
    modelCalls,
    toolCalls,
    toolErrors: toolCalls.filter((call) => !call.ok).map((call) => call.error ?? call.tool),
    artifacts,
    humanInterventions,
    costUsd: round2(cost),
    latencyMs,
    completed,
    finalOutput: completed
      ? `A ${revisions ? "revised " : ""}vertical intro video for: ${input.taskCase.task}`
      : `Incomplete: budget exhausted before animation for: ${input.taskCase.task}`,
    finalized: false,
    createdAt: new Date().toISOString(),
  };
}

export const simulatedTaskRunner: TaskRunner = async (input) => simulateCreativeRun(input);

// ── Graders ──────────────────────────────────────────────────────────────────

export function gradeDeterministic(trace: RunTrace): DeterministicEvaluation {
  const hasVideo = firstIndex(trace.toolCalls, "generate_video") !== -1;
  const checks: DeterministicCheck[] = [
    { name: "completed", critical: true, passed: trace.completed, detail: trace.completed ? "run completed" : "did not finish" },
    { name: "inspected_before_animation", critical: true, passed: hasVideo && analyzeBeforeVideo(trace), detail: "analyze_media must precede generate_video" },
    { name: "no_unapproved_animation", critical: true, passed: !hasUnapprovedAnimation(trace), detail: "no animation of an uninspected image" },
    { name: "no_tool_failures", critical: false, passed: trace.toolCalls.every((call) => call.ok) },
    { name: "limited_human_intervention", critical: false, passed: trace.humanInterventions <= 1, detail: `${trace.humanInterventions} interventions` },
  ];
  return { checks, passed: checks.every((check) => check.passed) };
}

export function simulatedJudge(trace: RunTrace): number {
  return qualityFromFeatures({
    concepts: trace.modelCalls.filter((call) => call.purpose === "concept").length,
    critic: trace.toolCalls.some((call) => call.tool === "analyze_media"),
    revisions: trace.modelCalls.filter((call) => call.purpose === "revise").length,
    animatedUnapproved: hasUnapprovedAnimation(trace),
    toolFailures: trace.toolCalls.filter((call) => !call.ok).length,
  });
}

function toGrade(trace: RunTrace): RunGrade {
  return {
    completed: trace.completed,
    deterministic: trace.deterministic ?? { checks: [], passed: false },
    semanticScore: trace.semantic?.score ?? 0,
    toolFailures: trace.toolCalls.filter((call) => !call.ok).length,
    modelFailures: 0,
    humanInterventions: trace.humanInterventions,
    costUsd: trace.costUsd,
    latencyMs: trace.latencyMs,
    modelCalls: trace.modelCalls.length,
    toolCalls: trace.toolCalls.length,
  };
}

// ── Isolated champion vs challenger evaluation ────────────────────────────────

export async function createIsolatedRoots(): Promise<{ championRoot: string; challengerRoot: string }> {
  const championRoot = await mkdtemp(path.join(os.tmpdir(), "gondola-lab-champion-"));
  const challengerRoot = await mkdtemp(path.join(os.tmpdir(), "gondola-lab-challenger-"));
  return { championRoot, challengerRoot };
}

export interface RunEvaluationInput {
  proposalId: string;
  championVersion: ConfigVersion;
  challengerVersion: ConfigVersion;
  cases?: EvaluationCase[];
  seed?: number;
  runTask?: TaskRunner;
  judge?: (trace: RunTrace) => number | Promise<number>;
  reviewerVisibleCaseIds?: string[];
  persist?: boolean;
}

export async function runEvaluation(input: RunEvaluationInput): Promise<EvaluationRecord> {
  const cases = input.cases ?? CASE_REGISTRY;
  const seed = input.seed ?? 1;
  const runTask = input.runTask ?? simulatedTaskRunner;
  const judge = input.judge ?? simulatedJudge;
  const persist = input.persist !== false;
  const { championRoot, challengerRoot } = await createIsolatedRoots();
  try {
    await writeFile(path.join(championRoot, "config.json"), JSON.stringify(input.championVersion.config)).catch(() => undefined);
    await writeFile(path.join(challengerRoot, "config.json"), JSON.stringify(input.challengerVersion.config)).catch(() => undefined);

    const comparisons: CaseComparison[] = [];
    for (const taskCase of cases) {
      const championTrace = await gradeAndFinalize(
        await runTask({ config: input.championVersion.config, taskCase, workspaceDir: path.join(championRoot, taskCase.id), role: "champion", configVersionId: input.championVersion.versionId, seed }),
        judge,
        persist,
      );
      const challengerTrace = await gradeAndFinalize(
        await runTask({ config: input.challengerVersion.config, taskCase, workspaceDir: path.join(challengerRoot, taskCase.id), role: "challenger", configVersionId: input.challengerVersion.versionId, seed }),
        judge,
        persist,
      );
      comparisons.push({
        caseId: taskCase.id,
        kind: taskCase.kind,
        championTraceId: championTrace.runId,
        challengerTraceId: challengerTrace.runId,
        champion: toGrade(championTrace),
        challenger: toGrade(challengerTrace),
      });
    }

    const contaminationFree = cases
      .filter((testCase) => testCase.kind === "held_out")
      .every((testCase) => !(input.reviewerVisibleCaseIds ?? []).includes(testCase.id));
    const report = buildReport(cases, comparisons, contaminationFree);
    const record: EvaluationRecord = {
      evaluationId: crypto.randomUUID(),
      proposalId: input.proposalId,
      championVersionId: input.championVersion.versionId,
      challengerVersionId: input.challengerVersion.versionId,
      judgeConfigVersion: JUDGE_CONFIG.version,
      seed,
      caseIds: cases.map((testCase) => testCase.id),
      cases: comparisons,
      report,
      contaminationFree,
      createdAt: new Date().toISOString(),
    };
    if (persist) await saveEvaluation(record);
    return record;
  } finally {
    await rm(championRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(challengerRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function gradeAndFinalize(trace: RunTrace, judge: (trace: RunTrace) => number | Promise<number>, persist: boolean): Promise<RunTrace> {
  const deterministic = gradeDeterministic(trace);
  const semantic = { judgeConfigVersion: JUDGE_CONFIG.version, score: await judge(trace), rationale: "Fixed judge score from trace evidence." };
  const finalized: RunTrace = { ...trace, deterministic, semantic, finalized: true, finalizedAt: new Date().toISOString() };
  if (persist) await saveTrace(finalized);
  return finalized;
}

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function buildReport(cases: EvaluationCase[], comparisons: CaseComparison[], contaminationFree: boolean): ComparisonReport {
  const championQuality = round1(average(comparisons.map((comparison) => comparison.champion.semanticScore)));
  const challengerQuality = round1(average(comparisons.map((comparison) => comparison.challenger.semanticScore)));
  const championCost = round2(comparisons.reduce((total, comparison) => total + comparison.champion.costUsd, 0));
  const challengerCost = round2(comparisons.reduce((total, comparison) => total + comparison.challenger.costUsd, 0));
  const qualityDeltaPct = championQuality > 0 ? round1(((challengerQuality - championQuality) / championQuality) * 100) : (challengerQuality > 0 ? 100 : 0);
  const costDeltaPct = championCost > 0 ? round1(((challengerCost - championCost) / championCost) * 100) : (challengerCost > 0 ? 100 : 0);

  const criticalRegressions: string[] = [];
  const replayRegressions: string[] = [];
  for (const comparison of comparisons) {
    const championCritical = new Map(comparison.champion.deterministic.checks.filter((check) => check.critical).map((check) => [check.name, check.passed]));
    for (const check of comparison.challenger.deterministic.checks.filter((candidate) => candidate.critical)) {
      if (championCritical.get(check.name) === true && !check.passed) criticalRegressions.push(`${comparison.caseId}:${check.name}`);
    }
    if (comparison.kind === "replay") {
      const baselinePass = cases.find((testCase) => testCase.id === comparison.caseId)?.championBaselinePass === true;
      if (baselinePass && !comparison.challenger.deterministic.passed) replayRegressions.push(comparison.caseId);
    }
  }

  const gates: GateResult[] = [
    { name: "no_critical_regression", passed: criticalRegressions.length === 0, detail: criticalRegressions.join(", ") || "none" },
    { name: "no_replay_regression", passed: replayRegressions.length === 0, detail: replayRegressions.join(", ") || "none" },
    { name: "target_metric_improved", passed: qualityDeltaPct >= PROMOTION_THRESHOLDS.minQualityImprovementPct, detail: `quality ${qualityDeltaPct}% vs required ${PROMOTION_THRESHOLDS.minQualityImprovementPct}%` },
    { name: "cost_within_tolerance", passed: costDeltaPct <= PROMOTION_THRESHOLDS.maxCostIncreasePct, detail: `cost ${costDeltaPct}% vs tolerance ${PROMOTION_THRESHOLDS.maxCostIncreasePct}%` },
    { name: "no_contamination", passed: contaminationFree, detail: contaminationFree ? "held-out cases were hidden from the generator" : "held-out contamination detected" },
  ];

  return {
    targetMetric: "semantic_quality",
    championQuality,
    challengerQuality,
    qualityDeltaPct,
    championCost,
    challengerCost,
    costDeltaPct,
    championLatencyMs: Math.round(average(comparisons.map((comparison) => comparison.champion.latencyMs))),
    challengerLatencyMs: Math.round(average(comparisons.map((comparison) => comparison.challenger.latencyMs))),
    championInterventions: comparisons.reduce((total, comparison) => total + comparison.champion.humanInterventions, 0),
    challengerInterventions: comparisons.reduce((total, comparison) => total + comparison.challenger.humanInterventions, 0),
    replayRegressions,
    criticalRegressions,
    gates,
    readyForReview: gates.every((gate) => gate.passed),
  };
}

/** Re-run an evaluation from its stored inputs and versions; deterministic. */
export async function reproduceEvaluation(record: EvaluationRecord): Promise<EvaluationRecord> {
  const championVersion = await getVersion(record.championVersionId);
  const challengerVersion = await getVersion(record.challengerVersionId);
  if (!championVersion || !challengerVersion) throw new Error("Cannot reproduce: missing config versions.");
  const cases = record.caseIds
    .map((id) => CASE_REGISTRY.find((testCase) => testCase.id === id))
    .filter((testCase): testCase is EvaluationCase => Boolean(testCase));
  return runEvaluation({
    proposalId: record.proposalId,
    championVersion,
    challengerVersion,
    cases,
    seed: record.seed,
    persist: false,
  });
}
