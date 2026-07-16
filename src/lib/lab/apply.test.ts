import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoutedModel } from "./apply";
import type { LabConfig } from "./types";

function config(routing: LabConfig["routing"]): LabConfig {
  return {
    workflowPolicy: {
      conceptCount: 1,
      useSeparateCritic: false,
      requireAnalyzeBeforeAnimate: false,
      reviseBelowQuality: null,
      maxRevisions: 0,
      budgetUsd: 1,
    },
    routing,
    roles: [],
    toolDescriptions: {},
  };
}

test("resolveRoutedModel is a no-op without a config (keeps existing selection)", () => {
  assert.equal(resolveRoutedModel(undefined, "chat"), undefined);
});

test("resolveRoutedModel prefers a matching role rule, then the default", () => {
  const cfg = config({ defaultModel: "default-model", rules: [{ role: "chat", model: "chat-model" }] });
  assert.equal(resolveRoutedModel(cfg, "chat"), "chat-model");
  // A role without a specific rule falls back to the default model.
  assert.equal(resolveRoutedModel(cfg, "vision"), "default-model");
});

test("resolveRoutedModel returns undefined when nothing routes", () => {
  const cfg = config({ defaultModel: "  ", rules: [] });
  assert.equal(resolveRoutedModel(cfg, "chat"), undefined);
});
