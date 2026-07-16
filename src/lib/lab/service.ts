import os from "node:os";
import {
  createChallenger,
  deleteProposal as deleteProposalRecord,
  getChampion,
  getConfigState,
  getEvaluation,
  getProposal,
  getVersion,
  initChampion,
  listProposals,
  listTraces,
  promoteVersion,
  rollbackChampion,
  saveProposal,
  saveTrace,
  undoRollbackChampion,
} from "./store";
import {
  autonomyTier,
  CASE_REGISTRY,
  JUDGE_CONFIG,
  gradeDeterministic,
  naiveChampionConfig,
  reviewerVisibleCases,
  runEvaluation,
  simulatedJudge,
  simulatedTaskRunner,
} from "./evaluation";
import { applyWorkflowPatch, assertAllowedProposalCategory, diffWorkflowPolicy, proposalSignature, reviewReliability, reviewTraces, type ProposalDraft, type ProposerFeedback } from "./reviewer";
import { createLiveJudge, createLiveTaskRunner, makeLiveRunAgent } from "./runner";
import type { ConfigVersion, EvaluationRecord, ImprovementProposal, RunTrace } from "./types";

// Behaviors the champion already gets right; every proposal must preserve them.
// Fed to the proposer as the "records of passing behaviors" side of the loop.
const PRESERVED_BEHAVIORS = [
  "complete the task within budget",
  "inspect media before animating",
  "never animate an unapproved image",
];

export async function ensureChampion(): Promise<ConfigVersion> {
  const existing = await getChampion();
  if (existing) return existing;
  return initChampion(naiveChampionConfig(), "Initial naive champion workflow policy.");
}

/** Seed the demo: record the current (naive champion) behavior as finalized traces. */
export async function seedDemo(): Promise<{ champion: ConfigVersion; traces: number }> {
  const champion = await ensureChampion();
  const existing = await listTraces();
  const alreadySeeded = existing.some((trace) => trace.configVersionId === champion.versionId);
  if (alreadySeeded) return { champion, traces: existing.length };
  let created = 0;
  for (const testCase of reviewerVisibleCases()) {
    const trace = await simulatedTaskRunner({
      config: champion.config,
      taskCase: testCase,
      workspaceDir: os.tmpdir(),
      role: "champion",
      configVersionId: champion.versionId,
      seed: 1,
    });
    const deterministic = gradeDeterministic(trace);
    await saveTrace({
      ...trace,
      deterministic,
      semantic: { judgeConfigVersion: JUDGE_CONFIG.version, score: simulatedJudge(trace), rationale: "Baseline champion run." },
      finalized: true,
      finalizedAt: new Date().toISOString(),
    });
    created += 1;
  }
  return { champion, traces: created };
}

/** True when two config patches make the same change (key order-independent). */
function sameConfigPatch(a: ImprovementProposal["configPatch"], b: ImprovementProposal["configPatch"]): boolean {
  const normalize = (patch: ImprovementProposal["configPatch"]) =>
    JSON.stringify(Object.fromEntries(Object.entries(patch).sort(([left], [right]) => left.localeCompare(right))));
  return normalize(a) === normalize(b);
}

/**
 * Reviewer proposes one bounded change and creates a challenger. Each reviewer is
 * tried in order, and a candidate that duplicates an existing proposal is skipped
 * so the next reviewer still gets a chance. This is important: without it, a
 * recurring creative proposal (already in the store) would dedup to null and the
 * reliability reviewer would never propose the timeout fix. `hint` carries an
 * optional agent-stated reason (from propose_harness_change) onto the proposal.
 */
export async function generateProposal(hint?: string): Promise<ImprovementProposal | null> {
  const champion = await ensureChampion();
  const allTraces = await listTraces();
  const visibleTasks = new Set(reviewerVisibleCases().map((testCase) => testCase.task));
  const visibleTraces = allTraces.filter((trace) => visibleTasks.has(trace.goal));
  const existing = await listProposals();
  const isDuplicate = (candidate: ProposalDraft) =>
    existing.some((proposal) => proposal.category === candidate.category && sameConfigPatch(proposal.configPatch, candidate.configPatch));

  // The proposer <-> Lab loop: give the reviewers the outcomes of prior attempts
  // (what to avoid) plus the behaviors to preserve, and record that context on
  // the proposal so the dialogue is auditable and proposals stop rediscovering
  // dead ends.
  const feedback: ProposerFeedback = {
    avoidSignatures: [...new Set(existing.map((proposal) => proposalSignature(proposal.category, proposal.configPatch)))],
    preserved: PRESERVED_BEHAVIORS,
  };
  const rejectedCount = existing.filter((proposal) => proposal.status === "rejected" || proposal.status === "failed").length;
  const feedbackNote = [
    existing.length ? `Informed by ${existing.length} prior attempt(s).` : "First proposal in this lineage.",
    rejectedCount ? `Avoiding ${rejectedCount} already-rejected edit(s).` : "",
    `Preserving: ${PRESERVED_BEHAVIORS.join("; ")}.`,
  ].filter(Boolean).join(" ");

  // Creative-quality review over reviewer-visible cases, then reliability review
  // over the live failure traces the supervisor tagged. Skip empty or duplicate
  // candidates and fall through to the next reviewer.
  const reviewers: Array<() => ProposalDraft | null> = [
    () => reviewTraces(visibleTraces, champion.config, feedback),
    () => reviewReliability(allTraces, champion.config, feedback),
  ];
  let draft: ProposalDraft | null = null;
  for (const review of reviewers) {
    const candidate = review();
    if (candidate && !isDuplicate(candidate)) { draft = candidate; break; }
  }
  if (!draft) return null;
  assertAllowedProposalCategory(draft.category);

  const trimmedHint = hint?.trim();
  const proposalId = crypto.randomUUID();
  const challengerConfig = applyWorkflowPatch(champion.config, draft.configPatch);
  const challenger = await createChallenger(challengerConfig, {
    parentVersionId: champion.versionId,
    sourceProposalId: proposalId,
    changeSummary: draft.observedProblem,
  });

  const proposal: ImprovementProposal = {
    ...draft,
    ...(trimmedHint ? { observedProblem: `${draft.observedProblem} (Flagged by the agent: ${trimmedHint})` } : {}),
    proposalId,
    challengerVersionId: challenger.versionId,
    proposerFeedback: feedbackNote,
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  return saveProposal(proposal);
}

/**
 * A short, human-readable note about the agent's own recent failures, for
 * self-awareness in the live system prompt. Empty when nothing notable recurs.
 */
export async function recentFailureSummary(limit = 12): Promise<string> {
  const traces = await listTraces(limit).catch(() => [] as RunTrace[]);
  const failures = traces.filter((trace) => trace.failureCategory);
  if (failures.length < 2) return "";
  const counts = new Map<string, number>();
  for (const trace of failures) {
    const key = trace.failureCategory as string;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([category, n]) => `${n} ${category.replace(/_/g, " ")}`);
  return `Reliability note: ${failures.length} of your recent turns hit errors (${parts.join(", ")}). If a pattern like this keeps recurring, you may call propose_harness_change to flag it to Gondola Lab for a reviewed, bounded fix.`;
}

/** Whether the Lab autopilot may promote low-risk, passed proposals without a human. */
export function autopilotEnabled(): boolean {
  return process.env.GONDOLA_LAB_AUTOPILOT === "1";
}

/**
 * Promote a passed proposal without a human ONLY when autopilot is enabled and
 * the proposal earned the "auto" autonomy tier (deterministic, held-out,
 * non-regressive, low-risk, live evidence — computed at evaluation time).
 * Everything else waits for a human. A rollback is always available afterward,
 * and the promotion is audited under the "gondola-auto" approver.
 */
export async function maybeAutoPromote(proposalId: string): Promise<ConfigVersion | null> {
  if (!autopilotEnabled()) return null;
  const proposal = await getProposal(proposalId);
  if (!proposal || proposal.status !== "ready_for_review") return null;
  if (proposal.autonomyTier !== "auto") return null;
  return promoteProposal(proposalId, "gondola-auto").catch(() => null);
}

/**
 * Evaluate a proposal's challenger against the champion across all cases.
 * With `live`, it runs the actual agent (real Venice inference, real judge)
 * instead of the deterministic simulation; otherwise it stays offline.
 */
export async function evaluateProposal(proposalId: string, opts?: { live?: boolean }): Promise<EvaluationRecord> {
  const proposal = await getProposal(proposalId);
  if (!proposal?.challengerVersionId) throw new Error("Proposal has no challenger to evaluate.");
  const champion = await ensureChampion();
  const challenger = await getVersion(proposal.challengerVersionId);
  if (!challenger) throw new Error("Challenger configuration is missing.");

  await saveProposal({ ...proposal, status: "evaluating" });
  const record = await runEvaluation({
    proposalId,
    championVersion: champion,
    challengerVersion: challenger,
    cases: CASE_REGISTRY,
    seed: 1,
    reviewerVisibleCaseIds: reviewerVisibleCases().map((testCase) => testCase.id),
    targetMetric: proposal.targetMetric,
    live: opts?.live === true,
    ...(opts?.live ? { runTask: createLiveTaskRunner(makeLiveRunAgent()), judge: createLiveJudge() } : {}),
  });
  const tier = autonomyTier({
    category: proposal.category,
    riskLevel: proposal.riskLevel,
    targetMetric: proposal.targetMetric,
    live: record.live === true,
    report: record.report,
  });
  await saveProposal({
    ...proposal,
    status: record.report.readyForReview ? "ready_for_review" : "failed",
    evaluationId: record.evaluationId,
    autonomyTier: tier,
  });
  // Bounded autonomy: with autopilot on, an "auto"-tier proposal (deterministic,
  // held-out, non-regressive, low-risk, live) is promoted automatically (audited,
  // reversible). Off by default, so promotion stays human-gated unless the owner
  // opts in, and subjective/protected changes always wait for a human.
  if (record.report.readyForReview) await maybeAutoPromote(proposalId).catch(() => null);
  return record;
}

/** Promote a challenger. Requires explicit approval and a passed evaluation. */
export async function promoteProposal(proposalId: string, approvedBy: string): Promise<ConfigVersion> {
  const trimmedApprover = approvedBy.trim();
  if (!trimmedApprover) throw new Error("Promotion requires an explicit approver.");
  const proposal = await getProposal(proposalId);
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.status !== "ready_for_review") throw new Error(`Proposal is "${proposal.status}", not ready for review; it cannot be promoted.`);
  if (!proposal.challengerVersionId || !proposal.evaluationId) throw new Error("Proposal is missing its challenger or evaluation.");
  const evaluation = await getEvaluation(proposal.evaluationId);
  if (!evaluation?.report.readyForReview) throw new Error("The proposal's evaluation did not pass the promotion gates.");

  const promoted = await promoteVersion(proposal.challengerVersionId, {
    proposalId,
    evaluationId: proposal.evaluationId,
    approvedBy: trimmedApprover,
  });
  await saveProposal({ ...proposal, status: "promoted" });
  return promoted;
}

export async function rejectProposal(proposalId: string): Promise<ImprovementProposal> {
  const proposal = await getProposal(proposalId);
  if (!proposal) throw new Error("Proposal not found.");
  return saveProposal({ ...proposal, status: "rejected" });
}

/** Delete a proposal record entirely (declutter). Leaves traces, config versions,
 * and evaluations intact for audit. */
export async function deleteProposal(proposalId: string): Promise<boolean> {
  return deleteProposalRecord(proposalId);
}

/** Roll back to the previous champion in one operation. */
export async function rollback(approvedBy: string): Promise<ConfigVersion | undefined> {
  const before = await getConfigState();
  const previousChampionId = before.championVersionId;
  const restored = await rollbackChampion(approvedBy.trim() || "user");
  if (restored && previousChampionId) {
    const proposals = await listProposals();
    const promoted = proposals.find((proposal) => proposal.status === "promoted" && proposal.challengerVersionId === previousChampionId);
    if (promoted) await saveProposal({ ...promoted, status: "rolled_back" });
  }
  return restored;
}

/**
 * Undo the most recent rollback: restore the champion the rollback demoted and
 * return its proposal to "promoted". No-op (returns undefined) when there is
 * nothing to undo or the champion moved since the rollback.
 */
export async function undoRollback(approvedBy: string): Promise<ConfigVersion | undefined> {
  const before = await getConfigState();
  const lastRollback = [...before.history].reverse().find((record) => record.action === "rollback");
  const restored = await undoRollbackChampion(approvedBy.trim() || "user");
  if (restored && lastRollback) {
    const proposals = await listProposals();
    const demoted = proposals.find((proposal) => proposal.status === "rolled_back" && proposal.challengerVersionId === restored.versionId);
    if (demoted) await saveProposal({ ...demoted, status: "promoted" });
  }
  return restored;
}

// ── Snapshots for the UI ──────────────────────────────────────────────────────

export interface TraceSummary {
  runId: string;
  goal: string;
  completed: boolean;
  humanInterventions: number;
  costUsd: number;
  quality: number;
  deterministicPassed: boolean;
}

function summarizeTrace(trace: RunTrace): TraceSummary {
  return {
    runId: trace.runId,
    goal: trace.goal,
    completed: trace.completed,
    humanInterventions: trace.humanInterventions,
    costUsd: trace.costUsd,
    quality: trace.semantic?.score ?? 0,
    deterministicPassed: trace.deterministic?.passed ?? false,
  };
}

export interface LabSnapshot {
  champion: ConfigVersion | null;
  history: Awaited<ReturnType<typeof getConfigState>>["history"];
  traces: TraceSummary[];
  proposals: ImprovementProposal[];
}

export async function getLabSnapshot(): Promise<LabSnapshot> {
  const [champion, state, traces, proposals] = await Promise.all([
    getChampion(),
    getConfigState(),
    listTraces(12),
    listProposals(),
  ]);
  return {
    champion: champion ?? null,
    history: state.history,
    traces: traces.map(summarizeTrace),
    proposals,
  };
}

export interface ProposalDetail {
  proposal: ImprovementProposal;
  championVersionId: string | null;
  diff: ReturnType<typeof diffWorkflowPolicy>;
  evaluation: EvaluationRecord | null;
}

export async function getProposalDetail(proposalId: string): Promise<ProposalDetail | null> {
  const proposal = await getProposal(proposalId);
  if (!proposal) return null;
  const champion = await getChampion();
  const evaluation = proposal.evaluationId ? (await getEvaluation(proposal.evaluationId)) ?? null : null;
  return {
    proposal,
    championVersionId: champion?.versionId ?? null,
    diff: champion ? diffWorkflowPolicy(champion.config.workflowPolicy, proposal.configPatch) : [],
    evaluation,
  };
}
