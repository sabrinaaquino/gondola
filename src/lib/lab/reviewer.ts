import {
  ALLOWED_PROPOSAL_CATEGORIES,
  DISALLOWED_PROPOSAL_CATEGORIES,
  type ConfigFieldDiff,
  type ImprovementProposal,
  type LabConfig,
  type ProposalCategory,
  type RunTrace,
  type WorkflowPolicy,
} from "./types";

// The reviewer runs with a different prompt from the acting runtime and may only
// propose bounded configuration changes. In this first slice it uses
// deterministic heuristics over finalized traces; a model-based reviewer can
// slot in later behind the same interface (and, per the design, may use a
// different model than the one that performed the task).
export const REVIEWER_SYSTEM_PROMPT = `You are Gondola Lab's reviewer, a separate control-plane role distinct from the acting runtime. You observe finalized, immutable run traces and the current champion configuration, and you propose exactly one small, testable improvement with concrete trace evidence. You may only propose changes to: workflow policy, model routing, agent role definitions, or tool descriptions. You may never change permissions, credentials, budget enforcement, grader prompts, promotion thresholds, control-plane code, or trace history. You never grade, apply, or promote your own proposal.`;

export function assertAllowedProposalCategory(category: string): asserts category is ProposalCategory {
  if ((DISALLOWED_PROPOSAL_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`Proposal category "${category}" is disallowed by Gondola Lab.`);
  }
  if (!(ALLOWED_PROPOSAL_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`Unknown proposal category "${category}".`);
  }
}

export function applyWorkflowPatch(config: LabConfig, patch: Partial<WorkflowPolicy>): LabConfig {
  return {
    ...config,
    workflowPolicy: { ...config.workflowPolicy, ...patch },
    routing: { defaultModel: config.routing.defaultModel, rules: config.routing.rules.map((rule) => ({ ...rule })) },
    roles: config.roles.map((role) => ({ ...role })),
    toolDescriptions: { ...config.toolDescriptions },
  };
}

export function diffWorkflowPolicy(from: WorkflowPolicy, patch: Partial<WorkflowPolicy>): ConfigFieldDiff[] {
  const diffs: ConfigFieldDiff[] = [];
  for (const key of Object.keys(patch) as Array<keyof WorkflowPolicy>) {
    if (from[key] !== patch[key]) diffs.push({ field: `workflowPolicy.${key}`, from: from[key], to: patch[key] });
  }
  return diffs;
}

function animatedUnapproved(trace: RunTrace): boolean {
  const video = trace.toolCalls.findIndex((call) => call.tool === "generate_video");
  if (video === -1) return false;
  const analyze = trace.toolCalls.findIndex((call) => call.tool === "analyze_media");
  return !(analyze !== -1 && analyze < video);
}

export type ProposalDraft = Omit<ImprovementProposal, "proposalId" | "createdAt" | "status" | "challengerVersionId" | "evaluationId" | "proposerFeedback" | "autonomyTier">;

export interface ProposerFeedback {
  /** category:patch signatures already attempted — do not re-propose these. */
  avoidSignatures: string[];
  /** Behaviors the champion already gets right; a proposal must not regress them. */
  preserved: string[];
}

/** Stable signature for an attempted edit, so the proposer can avoid repeats. */
export function proposalSignature(category: string, patch: Partial<WorkflowPolicy>): string {
  const normalized = JSON.stringify(
    Object.fromEntries(Object.entries(patch).sort(([a], [b]) => a.localeCompare(b))),
  );
  return `${category}:${normalized}`;
}

/**
 * Inspect finalized traces (trigger + validation only; held-out cases are never
 * shown to the reviewer) and, if a bounded improvement is warranted, return a
 * single workflow-policy proposal. Never edits the champion.
 */
export function reviewTraces(traces: RunTrace[], champion: LabConfig, feedback?: ProposerFeedback): ProposalDraft | null {
  if (!traces.length) return null;
  const evidence = new Set<string>();
  const problems: string[] = [];
  const patch: Partial<WorkflowPolicy> = {};

  const unapproved = traces.filter(animatedUnapproved);
  if (unapproved.length) {
    problems.push("Generated images were animated without inspection or approval.");
    patch.requireAnalyzeBeforeAnimate = true;
    unapproved.forEach((trace) => evidence.add(trace.runId));
  }

  const highIntervention = traces.filter((trace) => trace.humanInterventions > 1);
  if (highIntervention.length) {
    problems.push("Runs repeatedly required human intervention.");
    patch.useSeparateCritic = true;
    highIntervention.forEach((trace) => evidence.add(trace.runId));
  }

  const singleConcept = traces.some((trace) => trace.modelCalls.filter((call) => call.purpose === "concept").length <= 1);
  if (singleConcept) {
    patch.conceptCount = Math.max(3, champion.workflowPolicy.conceptCount);
    patch.reviseBelowQuality = 7;
    patch.maxRevisions = 2;
    traces.forEach((trace) => evidence.add(trace.runId));
  }

  // Requiring inspection is only meaningful with a critic role selecting/approving.
  if (patch.requireAnalyzeBeforeAnimate && patch.useSeparateCritic === undefined && !champion.workflowPolicy.useSeparateCritic) {
    patch.useSeparateCritic = true;
  }

  if (!Object.keys(patch).length) return null;
  // The proposer <-> Lab loop: never re-propose an edit already attempted.
  if (feedback?.avoidSignatures.includes(proposalSignature("workflow_policy", patch))) return null;

  return {
    sourceRunIds: [...evidence],
    observedProblem: problems.join(" ") || "Creative workflow quality can be improved.",
    traceEvidence: [...evidence],
    hypothesis: "Generating several low-cost concepts, using a separate critic, requiring inspection before animation, and allowing bounded revision will raise quality and cut human intervention while staying within cost tolerance.",
    category: "workflow_policy",
    configPatch: patch,
    targetMetric: "semantic_quality",
    expectedTradeoffs: "Modestly higher cost from extra concepts and an inspection step.",
    riskLevel: "low",
    evaluationPlan: "Champion vs challenger across the trigger case, two validation cases, one held-out case, and one replay case; require the target metric to improve within cost tolerance with no critical or replay regressions.",
  };
}

/**
 * Reliability review over live failure traces (the ones the supervisor tagged
 * with a failureCategory). When the same category recurs, propose a bounded fix
 * the acting agent will actually feel through the policy -> behavior mapping.
 * Currently: repeated timeouts -> switch the workflow to fast latency mode.
 */
export function reviewReliability(traces: RunTrace[], champion: LabConfig, feedback?: ProposerFeedback): ProposalDraft | null {
  const failures = traces.filter((trace) => trace.failureCategory);
  if (failures.length < 2) return null;

  const byCategory = new Map<string, RunTrace[]>();
  for (const trace of failures) {
    const key = trace.failureCategory as string;
    byCategory.set(key, [...(byCategory.get(key) ?? []), trace]);
  }

  const timeouts = byCategory.get("timeout") ?? [];
  if (timeouts.length >= 2 && champion.workflowPolicy.latencyMode !== "fast") {
    if (feedback?.avoidSignatures.includes(proposalSignature("workflow_policy", { latencyMode: "fast" }))) return null;
    const evidence = timeouts.map((trace) => trace.runId);
    return {
      sourceRunIds: evidence,
      observedProblem: `Turns repeatedly failed with timeouts (${timeouts.length} recent).`,
      traceEvidence: evidence,
      hypothesis: "Switching the workflow to a fast latency mode (tighter answers, less deliberation, fewer tool calls) will reduce timeouts while keeping answers useful.",
      category: "workflow_policy",
      configPatch: { latencyMode: "fast" },
      targetMetric: "completion_rate",
      expectedTradeoffs: "Slightly terser answers and less deliberation in exchange for fewer failed turns.",
      riskLevel: "low",
      evaluationPlan: "Champion vs challenger across the standard cases; require reliability to improve with no quality regression beyond tolerance.",
    };
  }
  return null;
}
