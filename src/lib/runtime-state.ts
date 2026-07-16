import type { ExecutionStep } from "./execution-state";

// ── Runtime Introspection Layer: types + renderers ────────────────────────────
//
// A RuntimeSnapshot is the single, authoritative description of the current
// execution. It is assembled from live sources (identity, the tool registry,
// media tasks, assets, models, memory, the Lab, the supervisor, the budget, and
// the durable execution/failure stores) rather than reconstructed from the chat.
//
// Three renderings sit on top of it:
//   renderRuntimeHeader  -> compact block injected at the top of every turn, so
//                           the agent always knows itself without asking.
//   renderRuntimeExplain -> the natural-language runtime.explain() self-model.
//   renderRuntimeSection -> structured JSON for a runtime.status() query.

export interface RuntimeIdentity {
  entity: string;
  isNamed: boolean;
  orchestrator: string;
  executionRuntime: string;
  controlPlane: string;
  currentModel: string;
  ownerStatus: "unknown" | "configured";
  ownerName: string | null;
  harnessVersion: string | null;
  championPolicyId: string | null;
  sessionId: string;
  conversationId: string;
  agentId: string;
}

export interface RuntimeObjective {
  goal: string | null;
  plan: string | null;
  currentStep: string | null;
  phase: string | null;
  completionPct: number;
  blocked: boolean;
  waitingForHuman: boolean;
  waitingForTool: boolean;
  waitingForMedia: boolean;
  recovering: boolean;
}

export interface CapabilityEntry {
  name: string;
  category: string;
  available: boolean;
  label?: string;
  lastOutcome?: "ok" | "error";
  note?: string;
}

export interface RuntimeJob {
  id: string;
  type: string;
  status: string;
  startedAt: string;
  prompt?: string;
  assetId?: string;
  etaSeconds?: number;
  costUsd?: number;
  goal?: string;
  sourceAssetIds?: string[];
  retrievalAttempts?: number;
}

export interface RuntimeAsset {
  id: string;
  kind: string;
  status: string;
  prompt?: string;
  url?: string;
  costUsd?: number;
}

export interface RuntimeModel {
  id: string;
  kind: string;
  available: boolean;
}

export interface RuntimeMemory {
  semantic: number;
  conversation: number;
  workingItems: number;
  compacted: boolean;
  scope: string;
}

export interface RuntimePermissions {
  canReadWriteFiles: boolean;
  canRunCommands: boolean;
  canDelete: boolean;
  canChangeModel: boolean;
  canProposeHarnessChange: boolean;
  canPromoteHarness: boolean;
  canChangePermissions: boolean;
  canModifyRuntime: boolean;
  cameraConditional: boolean;
}

export interface RuntimeBudget {
  currency: string;
  allocatedUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  perOperationCapUsd: number;
  largestOperations: { label: string; costUsd: number }[];
  estimatedRemainingCostUsd: number;
}

export interface RuntimeSupervisor {
  available: boolean;
  active: boolean;
  currentStrategy: string | null;
  retriesUsed: number;
  retriesRemaining: number;
  currentFailure: string | null;
  recoverable: boolean | null;
  alternativeModels: string[];
  resumePoint: string | null;
}

export interface RuntimeFailure {
  capability: string;
  category: string;
  count: number;
  status: "open" | "recovered" | "abandoned";
  lastError?: string;
  lastAt: string;
}

export interface RuntimeCheckpoint {
  id: string;
  label: string;
  createdAt: string;
}

export interface RuntimeLab {
  championVersion: string | null;
  autopilotEnabled: boolean;
  promotionAllowed: boolean;
  openProposals: { id: string; status: string; summary: string }[];
  recentProposals: { id: string; status: string; summary: string }[];
  activePolicies: string[];
}

export interface RuntimeEnvironment {
  workspacePath: string;
  os: string;
  node: string | null;
  git: boolean;
  availableCommands: string[];
}

export interface RuntimeSnapshot {
  generatedAt: string;
  identity: RuntimeIdentity;
  objective: RuntimeObjective;
  executionGraph: ExecutionStep[];
  capabilities: CapabilityEntry[];
  jobs: RuntimeJob[];
  assets: RuntimeAsset[];
  models: RuntimeModel[];
  memory: RuntimeMemory;
  permissions: RuntimePermissions;
  budget: RuntimeBudget;
  supervisor: RuntimeSupervisor;
  failures: RuntimeFailure[];
  checkpoints: RuntimeCheckpoint[];
  lab: RuntimeLab;
  environment: RuntimeEnvironment;
}

export type RuntimeSection =
  | "identity"
  | "objective"
  | "plan"
  | "execution"
  | "capabilities"
  | "jobs"
  | "assets"
  | "models"
  | "memory"
  | "permissions"
  | "budget"
  | "supervisor"
  | "failures"
  | "checkpoints"
  | "lab"
  | "environment";

export const RUNTIME_SECTIONS: RuntimeSection[] = [
  "identity", "objective", "plan", "execution", "capabilities", "jobs", "assets",
  "models", "memory", "permissions", "budget", "supervisor", "failures",
  "checkpoints", "lab", "environment",
];

// ── Selection (runtime.status(section)) ───────────────────────────────────────

export function selectRuntimeSection(snapshot: RuntimeSnapshot, section?: RuntimeSection): unknown {
  switch (section) {
    case undefined: return snapshot;
    case "identity": return snapshot.identity;
    case "objective":
    case "plan": return { objective: snapshot.objective, executionGraph: snapshot.executionGraph };
    case "execution": return { objective: snapshot.objective, executionGraph: snapshot.executionGraph, checkpoints: snapshot.checkpoints };
    case "capabilities": return snapshot.capabilities;
    case "jobs": return snapshot.jobs;
    case "assets": return snapshot.assets;
    case "models": return snapshot.models;
    case "memory": return snapshot.memory;
    case "permissions": return snapshot.permissions;
    case "budget": return snapshot.budget;
    case "supervisor": return snapshot.supervisor;
    case "failures": return snapshot.failures;
    case "checkpoints": return snapshot.checkpoints;
    case "lab": return snapshot.lab;
    case "environment": return snapshot.environment;
    default: return snapshot;
  }
}

// ── Renderers ─────────────────────────────────────────────────────────────────

const STATUS_MARK: Record<string, string> = {
  done: "[x]", skipped: "[x]", running: "[~]", not_started: "[ ]",
  blocked: "[!]", waiting: "[…]", failed: "[x!]",
};

function activeJobs(jobs: RuntimeJob[]): RuntimeJob[] {
  return jobs.filter((job) => job.status === "queued" || job.status === "running");
}

/**
 * Compact, always-on runtime header injected at the top of every turn. Kept
 * short: it exists so the agent never reconstructs its own state or denies a
 * capability it actually has. Facts, not prose.
 */
export function renderRuntimeHeader(snapshot: RuntimeSnapshot): string {
  const id = snapshot.identity;
  const obj = snapshot.objective;
  const lines: string[] = ["# Runtime state (authoritative — trust this over memory; query runtime_status for detail)"];

  lines.push(
    `You are ${id.entity}, running on model ${id.currentModel} inside ${id.orchestrator} (execution runtime ${id.executionRuntime}); control plane ${id.controlPlane}. `
    + `Harness ${id.harnessVersion ?? "base"}${id.championPolicyId ? ` · policy ${id.championPolicyId}` : ""}. `
    + `Owner: ${id.ownerStatus === "configured" ? (id.ownerName ?? "configured") : "unknown"}.`,
  );

  if (obj.goal) {
    const waits = [
      obj.waitingForHuman && "human", obj.waitingForTool && "tool", obj.waitingForMedia && "media",
    ].filter(Boolean).join("/");
    lines.push(
      `Objective: ${obj.goal} — ${obj.completionPct}% done${obj.currentStep ? `, current step: ${obj.currentStep}` : ""}`
      + `${obj.phase ? ` (phase: ${obj.phase})` : ""}${obj.recovering ? " · recovering" : ""}${waits ? ` · waiting on ${waits}` : ""}.`,
    );
  }

  const have = snapshot.capabilities.filter((cap) => cap.available).map((cap) => cap.name);
  const cannot = snapshot.capabilities.filter((cap) => !cap.available).map((cap) => cap.name);
  if (have.length) lines.push(`Capabilities you HAVE right now: ${have.join(", ")}.`);
  if (cannot.length) lines.push(`You CANNOT (needs Lab/owner): ${cannot.join(", ")}.`);

  const running = activeJobs(snapshot.jobs);
  if (running.length) {
    lines.push(`In-flight jobs: ${running.map((job) => `${job.type} ${job.id.slice(0, 8)} (${job.status})`).join(", ")}. Deliver finished jobs with media_task_await; do not claim delivery otherwise.`);
  }

  const openFailures = snapshot.failures.filter((failure) => failure.status === "open");
  if (openFailures.length) {
    lines.push(`Open failure patterns: ${openFailures.map((failure) => `${failure.capability}/${failure.category} x${failure.count}`).join(", ")}.`);
  }

  if (snapshot.budget.allocatedUsd != null) {
    lines.push(`Budget: $${snapshot.budget.spentUsd.toFixed(2)} spent of $${snapshot.budget.allocatedUsd.toFixed(2)} (remaining $${(snapshot.budget.remainingUsd ?? 0).toFixed(2)}).`);
  }

  lines.push("Never say you lack a capability listed above, and never reconstruct jobs, assets, budget, or failures from the conversation — read runtime_status.");
  return lines.join("\n");
}

/** The natural-language runtime.explain() self-model, generated from state. */
export function renderRuntimeExplain(snapshot: RuntimeSnapshot): string {
  const id = snapshot.identity;
  const have = snapshot.capabilities.filter((cap) => cap.available);
  const cannot = snapshot.capabilities.filter((cap) => !cap.available);
  const running = activeJobs(snapshot.jobs);
  const pendingAssets = snapshot.assets.filter((asset) => asset.status !== "ready" && asset.status !== "succeeded");
  const openFailures = snapshot.failures.filter((failure) => failure.status === "open");
  const blocks: string[] = [];

  blocks.push(
    `You are ${id.entity}, currently running on model ${id.currentModel}. You operate inside ${id.orchestrator}, whose execution runtime is ${id.executionRuntime}. `
    + `${id.orchestrator} provides your models, tools, memory, media pipeline, permissions, and persistence. `
    + `${id.controlPlane} is a separate external control plane that evaluates proposed harness changes; you may propose improvements but you cannot approve, promote, or apply them yourself.`,
  );

  blocks.push(
    `Current harness version: ${id.harnessVersion ?? "base"}${id.championPolicyId ? ` (champion policy ${id.championPolicyId})` : ""}. `
    + `Owner: ${id.ownerStatus === "configured" ? (id.ownerName ?? "configured") : "unknown — do not assume who they are"}. `
    + `Session ${id.sessionId.slice(0, 8)}, conversation ${id.conversationId.slice(0, 8)}.`,
  );

  if (snapshot.objective.goal) {
    blocks.push(
      `Your current objective is: ${snapshot.objective.goal}. `
      + `It is ${snapshot.objective.completionPct}% complete`
      + `${snapshot.objective.currentStep ? `, and the current step is "${snapshot.objective.currentStep}"` : ""}. `
      + (snapshot.objective.recovering ? "You are currently recovering from a failure. " : ""),
    );
  } else {
    blocks.push("You have no active declared goal. When you take on a multi-step task, declare it with set_plan so the runtime can track progress and recover.");
  }

  blocks.push(`Your current capabilities are: ${have.length ? have.map((cap) => cap.name).join(", ") : "none reported"}.`);
  if (cannot.length) {
    blocks.push(`Your current limitations (only the Lab or the owner can change these): ${cannot.map((cap) => cap.name).join(", ")}.`);
  }

  if (running.length) {
    blocks.push(`These jobs are in flight right now: ${running.map((job) => `${job.type} ${job.id.slice(0, 8)} (${job.status}, started ${job.startedAt})`).join("; ")}. Use media_task_await to deliver them; do not claim they are done until then.`);
  }
  if (pendingAssets.length) {
    blocks.push(`Pending assets: ${pendingAssets.map((asset) => `${asset.kind} (${asset.status})`).join(", ")}.`);
  }

  blocks.push(
    `The supervisor ${snapshot.supervisor.available ? "is available" : "is not available"} to recover failed turns`
    + `${snapshot.supervisor.active ? `; it is currently active with strategy "${snapshot.supervisor.currentStrategy ?? "unknown"}"` : ""}. You may cooperate with it.`,
  );

  if (openFailures.length) {
    blocks.push(`Known open failure patterns: ${openFailures.map((failure) => `${failure.capability}/${failure.category} (x${failure.count})`).join(", ")}. If one recurs, flag the pattern to ${id.controlPlane} rather than the raw error.`);
  }

  if (snapshot.budget.allocatedUsd != null) {
    blocks.push(`Budget: $${snapshot.budget.spentUsd.toFixed(2)} spent of $${snapshot.budget.allocatedUsd.toFixed(2)}, $${(snapshot.budget.remainingUsd ?? 0).toFixed(2)} remaining.`);
  }

  blocks.push(
    `${id.controlPlane} can change your workflow policy, routing, and other bounded configuration through evaluated, approved proposals. `
    + "Only the owner can rename you, change permissions, or apply protected changes. Everything above is read from live runtime state, not remembered.",
  );

  return blocks.join("\n\n");
}

/** A short human summary for the status route / debugging. */
export function renderRuntimeSummary(snapshot: RuntimeSnapshot): string {
  const lines: string[] = [];
  lines.push(`${snapshot.identity.entity} @ ${snapshot.identity.orchestrator} (harness ${snapshot.identity.harnessVersion ?? "base"})`);
  if (snapshot.objective.goal) lines.push(`Goal: ${snapshot.objective.goal} (${snapshot.objective.completionPct}%)`);
  if (snapshot.executionGraph.length) {
    lines.push("Execution:");
    for (const step of snapshot.executionGraph) lines.push(`  ${STATUS_MARK[step.status] ?? "[ ]"} ${step.title}`);
  }
  const running = activeJobs(snapshot.jobs);
  if (running.length) lines.push(`Jobs in flight: ${running.length}`);
  return lines.join("\n");
}
