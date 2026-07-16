import assert from "node:assert/strict";
import test from "node:test";
import { policyDirectives, policyPromptBlock } from "./policy";
import type { LabConfig, WorkflowPolicy } from "./types";

function policy(overrides: Partial<WorkflowPolicy>): WorkflowPolicy {
  return { conceptCount: 1, useSeparateCritic: false, requireAnalyzeBeforeAnimate: false, reviseBelowQuality: null, maxRevisions: 0, budgetUsd: 1, ...overrides };
}

function config(p: WorkflowPolicy): LabConfig {
  return { workflowPolicy: p, routing: { defaultModel: "m", rules: [] }, roles: [], toolDescriptions: {} };
}

test("a neutral policy produces no directives (callers stay a no-op)", () => {
  assert.deepEqual(policyDirectives(policy({})), []);
  assert.equal(policyPromptBlock(config(policy({}))), "");
  assert.equal(policyPromptBlock(undefined), "");
});

test("requireAnalyzeBeforeAnimate becomes an explicit ordering directive", () => {
  const lines = policyDirectives(policy({ requireAnalyzeBeforeAnimate: true }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /analyze_media/);
  assert.match(lines[0], /before/i);
  // And it renders into a promptable block.
  const block = policyPromptBlock(config(policy({ requireAnalyzeBeforeAnimate: true })));
  assert.match(block, /Active workflow policy/);
  assert.match(block, /analyze_media/);
});

test("each enabled knob adds exactly one directive", () => {
  const lines = policyDirectives(policy({
    requireAnalyzeBeforeAnimate: true,
    useSeparateCritic: true,
    conceptCount: 3,
    reviseBelowQuality: 7,
    maxRevisions: 2,
  }));
  assert.equal(lines.length, 4);
  assert.ok(lines.some((line) => /3 distinct/.test(line)));
  assert.ok(lines.some((line) => /7\/10/.test(line)));
});

test("revision directive requires both a threshold and a positive max", () => {
  assert.deepEqual(policyDirectives(policy({ reviseBelowQuality: 7, maxRevisions: 0 })), []);
  assert.deepEqual(policyDirectives(policy({ reviseBelowQuality: null, maxRevisions: 2 })), []);
});
