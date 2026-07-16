import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderRuntimeExplain,
  renderRuntimeHeader,
  renderRuntimeSummary,
  selectRuntimeSection,
  type RuntimeSnapshot,
} from "./runtime-state";

function sampleSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  const base: RuntimeSnapshot = {
    generatedAt: "2026-07-16T20:00:00.000Z",
    identity: {
      entity: "Entity",
      isNamed: false,
      orchestrator: "Gondola",
      executionRuntime: "Pi Agent Core",
      controlPlane: "Gondola Lab",
      currentModel: "zai-org-glm-5-2",
      ownerStatus: "unknown",
      ownerName: null,
      harnessVersion: "v18",
      championPolicyId: "workflow-policy-v18",
      sessionId: "conv-1234abcd",
      conversationId: "conv-1234abcd",
      agentId: "default",
    },
    objective: {
      goal: "Ship two vertical videos",
      plan: null,
      currentStep: "Video generation",
      phase: "production",
      completionPct: 60,
      blocked: false,
      waitingForHuman: false,
      waitingForTool: false,
      waitingForMedia: true,
      recovering: false,
    },
    executionGraph: [
      { id: "step-1", title: "Research", status: "done", updatedAt: "2026-07-16T19:00:00.000Z" },
      { id: "step-2", title: "Video generation", status: "running", updatedAt: "2026-07-16T19:30:00.000Z" },
    ],
    capabilities: [
      { name: "generate_video", category: "media", available: true },
      { name: "media_task_await", category: "media", available: true, lastOutcome: "ok" },
      { name: "promote_harness", category: "governance", available: false, note: "Gondola Lab / owner only" },
    ],
    jobs: [
      { id: "job-abcd1234", type: "video", status: "running", startedAt: "2026-07-16T19:45:00.000Z", costUsd: 0.72 },
    ],
    assets: [
      { id: "asset-1", kind: "image", status: "approved" },
    ],
    models: [],
    memory: { semantic: 4, conversation: 0, workingItems: 1, compacted: false, scope: "personal" },
    permissions: {
      canReadWriteFiles: true,
      canRunCommands: true,
      canDelete: true,
      canChangeModel: true,
      canProposeHarnessChange: true,
      canPromoteHarness: false,
      canChangePermissions: false,
      canModifyRuntime: false,
      cameraConditional: true,
    },
    budget: {
      currency: "USD",
      allocatedUsd: 2,
      spentUsd: 0.72,
      remainingUsd: 1.28,
      perOperationCapUsd: 1,
      largestOperations: [{ label: "video job-abcd", costUsd: 0.72 }],
      estimatedRemainingCostUsd: 0.72,
    },
    supervisor: {
      available: true,
      active: false,
      currentStrategy: null,
      retriesUsed: 0,
      retriesRemaining: 3,
      currentFailure: "generate_video/provider_4xx",
      recoverable: true,
      alternativeModels: [],
      resumePoint: "images saved",
    },
    failures: [
      { capability: "generate_video", category: "provider_4xx", count: 2, status: "open", lastAt: "2026-07-16T19:50:00.000Z" },
    ],
    checkpoints: [
      { id: "cp-1", label: "images saved", createdAt: "2026-07-16T19:20:00.000Z" },
    ],
    lab: {
      championVersion: "v18",
      autopilotEnabled: false,
      promotionAllowed: false,
      openProposals: [],
      recentProposals: [{ id: "p-1", status: "rejected", summary: "image-to-video failed" }],
      activePolicies: ["Analyze media before animating."],
    },
    approvals: { pending: [], sessionGrants: [], guardedTools: [{ tool: "run_command", risk: "high" }] },
    architecture: {
      version: "1.0.0",
      purpose: "Gondola is an experiment in operational intelligence.",
      principles: [{ title: "Evidence over assertion", text: "traces, not opinion" }],
      roles: [{ role: "Entity", responsibility: "acts on goals", boundary: "needs approval for protected change" }],
      subsystems: [{ name: "Runtime introspection", purpose: "authoritative live state" }],
    },
    environment: {
      workspacePath: "/tmp/ws",
      os: "Darwin 25.5.0",
      node: "v22.0.0",
      git: true,
      availableCommands: ["node", "npm", "git"],
    },
  };
  return { ...base, ...overrides };
}

test("renderRuntimeHeader states identity, capabilities, jobs, and budget as facts", () => {
  const header = renderRuntimeHeader(sampleSnapshot());
  assert.match(header, /You are Entity/);
  assert.match(header, /running on model zai-org-glm-5-2/);
  assert.match(header, /Harness v18/);
  // Capabilities the agent HAS are listed so it never denies them.
  assert.match(header, /Capabilities you HAVE right now:[^\n]*generate_video/);
  // Governance limits are listed as things it CANNOT do.
  assert.match(header, /You CANNOT[^\n]*promote_harness/);
  // In-flight jobs are surfaced with the delivery instruction.
  assert.match(header, /In-flight jobs:[^\n]*video/);
  assert.match(header, /media_task_await/);
  // Open failure patterns and budget are surfaced.
  assert.match(header, /generate_video\/provider_4xx x2/);
  assert.match(header, /\$0\.72 spent of \$2\.00/);
});

test("renderRuntimeExplain narrates capabilities, limitations, and jobs", () => {
  const explain = renderRuntimeExplain(sampleSnapshot());
  assert.match(explain, /You are Entity, currently running on model zai-org-glm-5-2/);
  assert.match(explain, /current objective is: Ship two vertical videos/);
  assert.match(explain, /current capabilities are:[^\n]*generate_video/);
  assert.match(explain, /current limitations[^\n]*promote_harness/);
  assert.match(explain, /in flight right now/);
  assert.match(explain, /supervisor is available/);
});

test("renderRuntimeExplain guides declaring a plan when there is no goal", () => {
  const explain = renderRuntimeExplain(sampleSnapshot({
    objective: {
      goal: null, plan: null, currentStep: null, phase: null, completionPct: 0,
      blocked: false, waitingForHuman: false, waitingForTool: false, waitingForMedia: false, recovering: false,
    },
  }));
  assert.match(explain, /no active declared goal/);
  assert.match(explain, /set_plan/);
});

test("selectRuntimeSection returns focused slices", () => {
  const snapshot = sampleSnapshot();
  assert.equal(selectRuntimeSection(snapshot, "identity"), snapshot.identity);
  assert.equal(selectRuntimeSection(snapshot, "jobs"), snapshot.jobs);
  assert.equal(selectRuntimeSection(snapshot, "budget"), snapshot.budget);
  assert.equal(selectRuntimeSection(snapshot, undefined), snapshot);
  const execution = selectRuntimeSection(snapshot, "execution") as { executionGraph: unknown[] };
  assert.equal(execution.executionGraph, snapshot.executionGraph);
});

test("renderRuntimeSummary lists the execution graph with status marks", () => {
  const summary = renderRuntimeSummary(sampleSnapshot());
  assert.match(summary, /Entity @ Gondola \(harness v18\)/);
  assert.match(summary, /\[x\] Research/);
  assert.match(summary, /\[~\] Video generation/);
});
