import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatRouteModel, resolveRoutedModel } from "./apply";
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

test("resolveChatRouteModel never uses the generic default (never overrides the model picker)", () => {
  // A champion with a default but no explicit chat rule must NOT steer live chat.
  const naive = config({ defaultModel: "zai-org-glm-5-2", rules: [{ role: "creator", model: "zai-org-glm-5-2" }] });
  assert.equal(resolveChatRouteModel(naive), undefined);
  assert.equal(resolveChatRouteModel(undefined), undefined);
  // Only an explicit chat rule steers chat (still just a fallback in pi-agent).
  const explicit = config({ defaultModel: "zai-org-glm-5-2", rules: [{ role: "chat", model: "some-chat-model" }] });
  assert.equal(resolveChatRouteModel(explicit), "some-chat-model");
});
