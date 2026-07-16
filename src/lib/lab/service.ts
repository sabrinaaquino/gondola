import os from "node:os";
import {
  createChallenger,
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
} from "./store";
import {
  CASE_REGISTRY,
  JUDGE_CONFIG,
  gradeDeterministic,
  naiveChampionConfig,
  reviewerVisibleCases,
  runEvaluation,
  simulatedJudge,
  simulatedTaskRunner,
} from "./evaluation";
import { applyWorkflowPatch, assertAllowedProposalCategory, diffWorkflowPolicy, reviewTraces } from "./reviewer";
import { createLiveJudge, createLiveTaskRunner, makeLiveRunAgent } from "./runner";
import { createEvalTools } from "./eval-tools";
import type { ConfigVersion, EvaluationRecord, ImprovementProposal, RunTrace } from "./types";

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

/** Reviewer proposes one bounded workflow-policy change and creates a challenger. */
export async function generateProposal(): Promise<ImprovementProposal | null> {
  const champion = await ensureChampion();
  const visibleTasks = new Set(reviewerVisibleCases().map((testCase) => testCase.task));
  const traces = (await listTraces()).filter((trace) => visibleTasks.has(trace.goal));
  const draft = reviewTraces(traces, champion.config);
  if (!draft) return null;
  assertAllowedProposalCategory(draft.category);

  const proposalId = crypto.randomUUID();
  const challengerConfig = applyWorkflowPatch(champion.config, draft.configPatch);
  const challenger = await createChallenger(challengerConfig, {
    parentVersionId: champion.versionId,
    sourceProposalId: proposalId,
    changeSummary: draft.observedProblem,
  });

  const proposal: ImprovementProposal = {
    ...draft,
    proposalId,
    challengerVersionId: challenger.versionId,
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  return saveProposal(proposal);
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
    ...(opts?.live
      ? {
        // The live runner instantiates each config's workflow policy (champion vs
        // challenger behave differently), with real, budget-capped creative tools.
        runTask: createLiveTaskRunner(makeLiveRunAgent(), {
          buildTools: (config) => createEvalTools({ maxUsd: config.workflowPolicy.budgetUsd }),
        }),
        judge: createLiveJudge(),
      }
      : {}),
  });
  await saveProposal({
    ...proposal,
    status: record.report.readyForReview ? "ready_for_review" : "failed",
    evaluationId: record.evaluationId,
  });
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
