import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogModel } from "./app-types";
import { findFastModelPair, supportedReasoningEfforts } from "./model-capabilities";

function model(id: string, name: string, capabilities: CatalogModel["capabilities"] = {}): CatalogModel {
  return { id, name, type: "text", capabilities };
}

test("shows reasoning effort only when the model advertises support", () => {
  assert.deepEqual(supportedReasoningEfforts(model("plain", "Plain")), []);
  assert.deepEqual(
    supportedReasoningEfforts(model("openai-gpt-56-sol", "GPT-5.6 Sol", { supportsReasoningEffort: true })),
    ["low", "medium", "high", "xhigh"],
  );
});

test("uses explicit reasoning effort constraints when provided", () => {
  const constrained = {
    ...model("gemini", "Gemini", { supportsReasoningEffort: true }),
    constraints: { reasoning_effort: { options: ["low", "high"] } },
  };
  assert.deepEqual(supportedReasoningEfforts(constrained), ["low", "high"]);
});

test("pairs a base model with its fast variant", () => {
  const base = model("claude-opus-4-6", "Claude Opus 4.6");
  const fast = model("claude-opus-4-6-fast", "Claude Opus 4.6 Fast");
  assert.deepEqual(findFastModelPair([base, fast], base), { base, fast });
  assert.deepEqual(findFastModelPair([base, fast], fast), { base, fast });
});
