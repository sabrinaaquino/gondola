import assert from "node:assert/strict";
import test from "node:test";
import { createLiveTaskRunner, parseJudgeScore, type AgentRun } from "./runner";
import type { EvaluationCase, LabConfig } from "./types";

function config(): LabConfig {
  return {
    workflowPolicy: { conceptCount: 1, useSeparateCritic: false, requireAnalyzeBeforeAnimate: false, reviseBelowQuality: null, maxRevisions: 0, budgetUsd: 1 },
    routing: { defaultModel: "default-model", rules: [{ role: "creator", model: "creator-model" }] },
    roles: [{ name: "creator", instructions: "Make the thing." }],
    toolDescriptions: {},
  };
}

const taskCase: EvaluationCase = { id: "c1", kind: "trigger", difficulty: 0.5, task: "Make a short vertical intro." };

test("createLiveTaskRunner shapes an injected agent run into a graded-ready trace", async () => {
  const fakeRun: AgentRun = {
    text: "done",
    toolCalls: [
      { tool: "generate_image", ok: true },
      { tool: "generate_video", ok: false, error: "timeout" },
    ],
    modelCalls: [
      { model: "creator-model", purpose: "chat", costUsd: 0.01, latencyMs: 0 },
      { model: "creator-model", purpose: "chat", costUsd: 0.02, latencyMs: 0 },
    ],
    latencyMs: 4200,
    completed: true,
  };
  const runner = createLiveTaskRunner(async () => fakeRun);
  const trace = await runner({ config: config(), taskCase, workspaceDir: "/tmp/x", role: "challenger", configVersionId: "v1", seed: 1 });

  // Uses the config's creator route for the model.
  assert.ok(trace.modelsSelected.includes("creator-model"));
  assert.equal(trace.goal, taskCase.task);
  assert.equal(trace.configVersionId, "v1");
  assert.equal(trace.costUsd, 0.03);
  assert.equal(trace.latencyMs, 4200);
  assert.equal(trace.completed, true);
  assert.equal(trace.finalized, false);
  // Failed tools surface as errors; only the successful media tool becomes an artifact.
  assert.deepEqual(trace.toolErrors, ["timeout"]);
  assert.equal(trace.artifacts.length, 1);
  assert.equal(trace.artifacts[0].kind, "image");
});

test("createLiveTaskRunner passes the resolved model to the agent run", async () => {
  let seenModel = "";
  const runner = createLiveTaskRunner(async ({ model }) => {
    seenModel = model;
    return { text: "ok", toolCalls: [], modelCalls: [], latencyMs: 1, completed: true };
  });
  await runner({ config: config(), taskCase, workspaceDir: "/tmp/x", role: "champion", configVersionId: "v1", seed: 1 });
  assert.equal(seenModel, "creator-model");
});

test("parseJudgeScore reads a labeled score, a bare number, and clamps to 0-10", () => {
  assert.equal(parseJudgeScore('{"score": 7.5}'), 7.5);
  assert.equal(parseJudgeScore("Score = 9"), 9);
  assert.equal(parseJudgeScore("8"), 8);
  assert.equal(parseJudgeScore("42"), 10);
  assert.equal(parseJudgeScore("-3"), 0);
  assert.equal(parseJudgeScore("no number here"), 0);
});
