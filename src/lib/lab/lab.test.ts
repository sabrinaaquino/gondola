import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import {
  CASE_REGISTRY,
  JUDGE_CONFIG,
  PROMOTION_THRESHOLDS,
  naiveChampionConfig,
  runEvaluation,
  type TaskRunner,
} from "./evaluation";
import { applyWorkflowPatch, assertAllowedProposalCategory, reviewReliability } from "./reviewer";
import {
  createChallenger,
  getChampion,
  getConfigState,
  initChampion,
  saveProposal,
  saveTrace,
} from "./store";
import {
  evaluateProposal,
  generateProposal,
  promoteProposal,
  rollback,
  seedDemo,
} from "./service";
import type { ImprovementProposal, JudgeConfig, PromotionThresholds, RunTrace, ToolCallRecord } from "./types";

beforeEach(() => {
  process.env.GONDOLA_LAB_ROOT = mkdtempSync(path.join(os.tmpdir(), "gondola-lab-test-"));
});

function buildTrace(configVersionId: string, goal: string, opts: { approved: boolean; concepts: number; cost: number; interventions: number }): RunTrace {
  const modelCalls = Array.from({ length: opts.concepts }, () => ({ model: "m", purpose: "concept", costUsd: 0, latencyMs: 100 }));
  const toolCalls: ToolCallRecord[] = opts.approved
    ? [{ tool: "analyze_media", ok: true }, { tool: "generate_video", ok: true }]
    : [{ tool: "generate_video", ok: true }];
  return {
    runId: crypto.randomUUID(),
    runtimeVersion: "test",
    configVersionId,
    goal,
    constraints: [],
    modelsSelected: ["m"],
    modelCalls,
    toolCalls,
    toolErrors: [],
    artifacts: [],
    humanInterventions: opts.interventions,
    costUsd: opts.cost,
    latencyMs: 100,
    completed: true,
    finalOutput: "x",
    finalized: false,
    createdAt: new Date().toISOString(),
  };
}

test("finalized traces cannot be mutated", async () => {
  const trace = { ...buildTrace("v", "goal", { approved: true, concepts: 1, cost: 0.1, interventions: 0 }), finalized: true };
  await saveTrace(trace);
  await assert.rejects(() => saveTrace({ ...trace, goal: "tampered" }), /immutable/i);
});

test("a challenger cannot overwrite the champion", async () => {
  const champion = await initChampion(naiveChampionConfig(), "init");
  const challenger = await createChallenger(applyWorkflowPatch(champion.config, { conceptCount: 3 }), {
    parentVersionId: champion.versionId,
    sourceProposalId: null,
    changeSummary: "more concepts",
  });
  const state = await getConfigState();
  assert.equal(state.championVersionId, champion.versionId);
  assert.notEqual(challenger.versionId, champion.versionId);
  assert.ok(state.versions.some((version) => version.versionId === challenger.versionId));
});

test("candidate and champion runs use isolated configuration roots", async () => {
  const champion = await initChampion(naiveChampionConfig(), "init");
  const challenger = await createChallenger(applyWorkflowPatch(champion.config, { useSeparateCritic: true, requireAnalyzeBeforeAnimate: true }), {
    parentVersionId: champion.versionId,
    sourceProposalId: null,
    changeSummary: "critic",
  });
  const roots: Record<string, Set<string>> = { champion: new Set(), challenger: new Set() };
  const capture: TaskRunner = async (input) => {
    roots[input.role].add(path.dirname(input.workspaceDir));
    return buildTrace(input.configVersionId, input.taskCase.task, { approved: true, concepts: 3, cost: 0.2, interventions: 0 });
  };
  await runEvaluation({ proposalId: "p", championVersion: champion, challengerVersion: challenger, runTask: capture, persist: false });
  assert.equal(roots.champion.size, 1);
  assert.equal(roots.challenger.size, 1);
  const [championRoot] = [...roots.champion];
  const [challengerRoot] = [...roots.challenger];
  assert.notEqual(championRoot, challengerRoot);
});

test("the proposal generator cannot modify evaluation cases", async () => {
  const snapshot = JSON.parse(JSON.stringify(CASE_REGISTRY));
  await seedDemo();
  const proposal = await generateProposal();
  assert.ok(proposal);
  assert.equal(proposal?.category, "workflow_policy");
  assert.deepEqual(CASE_REGISTRY, snapshot);
});

test("generateProposal does not create the same proposal twice", async () => {
  await seedDemo();
  const first = await generateProposal();
  assert.ok(first, "the first proposal should be generated");
  const second = await generateProposal();
  assert.equal(second, null, "the same change must not be proposed twice");
});

test("generateProposal falls through to reliability when the creative proposal is a duplicate", async () => {
  await seedDemo();
  const creative = await generateProposal();
  assert.ok(creative, "the creative proposal is generated first");
  // Regenerating alone would yield the same (now duplicate) creative proposal.
  // Add live timeout failures so the reliability reviewer has something to say.
  const champion = await getChampion();
  const failing = (): RunTrace => ({
    ...buildTrace(champion?.versionId ?? "v", "a live user goal", { approved: true, concepts: 1, cost: 0, interventions: 0 }),
    completed: false,
    failureCategory: "timeout",
  });
  await saveTrace(failing());
  await saveTrace(failing());
  const next = await generateProposal();
  assert.ok(next, "the reliability proposal is generated even though the creative one is a duplicate");
  assert.equal(next?.configPatch.latencyMode, "fast");
});

test("reviewReliability proposes fast latency mode after repeated timeouts", () => {
  const champion = naiveChampionConfig();
  const failing = (): RunTrace => ({
    ...buildTrace("v", "a live user goal", { approved: true, concepts: 1, cost: 0, interventions: 0 }),
    completed: false,
    failureCategory: "timeout",
  });
  const draft = reviewReliability([failing(), failing()], champion);
  assert.ok(draft, "repeated timeouts should yield a proposal");
  assert.equal(draft?.configPatch.latencyMode, "fast");
  assert.equal(draft?.category, "workflow_policy");
  // Below the threshold (a single failure), nothing is proposed.
  assert.equal(reviewReliability([failing()], champion), null);
});

test("the candidate cannot modify graders or promotion thresholds", () => {
  assert.throws(() => assertAllowedProposalCategory("grader_prompts"));
  assert.throws(() => assertAllowedProposalCategory("promotion_thresholds"));
  assert.throws(() => assertAllowedProposalCategory("credentials"));
  assert.throws(() => assertAllowedProposalCategory("permissions"));
  assert.throws(() => { (PROMOTION_THRESHOLDS as PromotionThresholds).minQualityImprovementPct = 0; });
  assert.throws(() => { (JUDGE_CONFIG as JudgeConfig).version = "hacked"; });
});

test("replay regressions block readiness", async () => {
  const champion = await initChampion(naiveChampionConfig(), "init");
  const challenger = await createChallenger(applyWorkflowPatch(champion.config, { useSeparateCritic: true }), { parentVersionId: champion.versionId, sourceProposalId: null, changeSummary: "c" });
  const regressReplay: TaskRunner = async (input) => {
    const approved = !(input.role === "challenger" && input.taskCase.kind === "replay");
    return buildTrace(input.configVersionId, input.taskCase.task, { approved, concepts: 3, cost: 0.2, interventions: approved ? 0 : 3 });
  };
  const record = await runEvaluation({ proposalId: "p", championVersion: champion, challengerVersion: challenger, runTask: regressReplay, persist: false });
  assert.ok(record.report.replayRegressions.includes("replay-titlecard"));
  assert.equal(record.report.gates.find((gate) => gate.name === "no_replay_regression")?.passed, false);
  assert.equal(record.report.readyForReview, false);
});

test("cost tolerance violations block readiness", async () => {
  const champion = await initChampion(naiveChampionConfig(), "init");
  const challenger = await createChallenger(applyWorkflowPatch(champion.config, { conceptCount: 3 }), { parentVersionId: champion.versionId, sourceProposalId: null, changeSummary: "c" });
  const expensive: TaskRunner = async (input) => buildTrace(input.configVersionId, input.taskCase.task, {
    approved: true,
    concepts: 3,
    cost: input.role === "challenger" ? 2.0 : 0.2,
    interventions: 0,
  });
  const record = await runEvaluation({ proposalId: "p", championVersion: champion, challengerVersion: challenger, runTask: expensive, persist: false });
  assert.equal(record.report.gates.find((gate) => gate.name === "cost_within_tolerance")?.passed, false);
  assert.equal(record.report.readyForReview, false);
});

test("failed evaluations cannot be promoted", async () => {
  const champion = await initChampion(naiveChampionConfig(), "init");
  const challenger = await createChallenger(champion.config, { parentVersionId: champion.versionId, sourceProposalId: null, changeSummary: "c" });
  const proposal: ImprovementProposal = {
    proposalId: crypto.randomUUID(),
    sourceRunIds: [],
    observedProblem: "x",
    traceEvidence: [],
    hypothesis: "x",
    category: "workflow_policy",
    configPatch: {},
    targetMetric: "semantic_quality",
    expectedTradeoffs: "",
    riskLevel: "low",
    evaluationPlan: "",
    status: "failed",
    challengerVersionId: challenger.versionId,
    evaluationId: "missing",
    createdAt: new Date().toISOString(),
  };
  await saveProposal(proposal);
  await assert.rejects(() => promoteProposal(proposal.proposalId, "me"), /not ready/i);
});

test("promotion requires explicit approval, is never automatic, and rollback restores the previous champion", async () => {
  await seedDemo();
  const proposal = await generateProposal();
  assert.ok(proposal);
  const before = await getChampion();
  assert.ok(before);

  const record = await evaluateProposal(proposal!.proposalId);
  assert.equal(record.report.readyForReview, true);

  // No automatic promotion: champion is unchanged after evaluation.
  assert.equal((await getChampion())?.versionId, before?.versionId);

  // Empty approver is rejected.
  await assert.rejects(() => promoteProposal(proposal!.proposalId, "   "), /approver/i);

  const promoted = await promoteProposal(proposal!.proposalId, "sabrina");
  assert.equal((await getChampion())?.versionId, promoted.versionId);
  assert.notEqual(promoted.versionId, before?.versionId);

  const restored = await rollback("sabrina");
  assert.equal(restored?.versionId, before?.versionId);
  assert.equal((await getChampion())?.versionId, before?.versionId);
});

test("an evaluation reproduces identically from its stored inputs and versions", async () => {
  const champion = await initChampion(naiveChampionConfig(), "init");
  const challenger = await createChallenger(applyWorkflowPatch(champion.config, { conceptCount: 3, useSeparateCritic: true, requireAnalyzeBeforeAnimate: true, reviseBelowQuality: 7, maxRevisions: 2 }), {
    parentVersionId: champion.versionId,
    sourceProposalId: null,
    changeSummary: "improve",
  });
  const first = await runEvaluation({ proposalId: "p", championVersion: champion, challengerVersion: challenger, cases: CASE_REGISTRY, seed: 1, persist: false });
  const second = await runEvaluation({ proposalId: "p", championVersion: champion, challengerVersion: challenger, cases: CASE_REGISTRY, seed: 1, persist: false });
  assert.deepEqual(first.report, second.report);
});
