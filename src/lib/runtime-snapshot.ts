import os from "node:os";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  createIdentityManifest,
  isNamed as identityIsNamed,
  resolveEntityName,
} from "./identity";
import {
  currentStepTitle,
  executionCompletionPct,
  getExecutionState,
  isExecutionBlocked,
} from "./execution-state";
import { listMediaTasks } from "./media-tasks";
import { listAssets } from "./assets";
import { listFailures } from "./failure-journal";
import { getChampionConfig } from "./lab/apply";
import { autopilotEnabled, getLabSnapshot } from "./lab/service";
import { policyDirectives } from "./lab/policy";
import { getMemorySnapshot } from "./memory";
import { guardedToolList, listApprovals, listGrants } from "./approval-store";
import { gondolaConstitution } from "./constitution";
import { loadModelRegistry } from "./model-registry";
import type {
  CapabilityEntry,
  RuntimeSnapshot,
} from "./runtime-state";

// Server-only assembler for the Runtime Introspection Layer. Every source is
// read live and guarded independently, so a single failing subsystem degrades
// that one section rather than blanking the whole snapshot. Kept separate from
// runtime-state.ts (types + pure renderers) so the client never pulls node deps.

const CAPABILITY_CATEGORY: Record<string, string> = {
  generate_image: "media", generate_video: "media", generate_music: "media",
  media_task_list: "media", media_task_await: "media", analyze_media: "media",
  inspect_camera: "vision",
  read_file: "files", list_directory: "files", create_directory: "files",
  write_file: "files", edit_file: "files", move_path: "files", delete_path: "files",
  run_command: "shell",
  search_web: "web",
  session_search: "memory", search_memory: "memory", memory: "memory",
  use_skill: "skills",
  delegate_task: "coordination", orchestrate: "coordination",
  rewrite_self: "self", propose_harness_change: "self", create_ability: "self", test_ability: "self",
  set_model: "models", list_models: "models", route_model: "models",
  venice_api: "venice", venice_reference: "venice",
  runtime_status: "runtime", runtime_explain: "runtime", set_plan: "runtime", update_step: "runtime", checkpoint: "runtime",
  animate_avatar: "presence", shape_presence: "presence",
  asset_list: "assets", asset_get: "assets",
};

function categorize(name: string): string {
  return CAPABILITY_CATEGORY[name] ?? (name.startsWith("Ability:") ? "ability" : "other");
}

export interface RuntimeSnapshotInput {
  entityName: string;
  ownerName?: string | null;
  ownerConfigured?: boolean;
  sessionId: string;
  conversationId: string;
  agentId: string;
  perOperationCapUsd: number;
  chatModel: string;
  approvalPolicy?: "always_ask" | "risk_based" | "always_allow" | "never_allow";
  persistentTasks?: boolean;
  /** The live toolset for this session (name + optional label). */
  tools: { name: string; label?: string }[];
  /** This turn's tool outcomes, from the turn trace, to mark ✓/✗ per capability. */
  toolOutcomes?: { tool: string; ok: boolean }[];
  /** Which memory store this session reads/writes. */
  memoryAgentId?: string;
  /** Load the (network) model catalog. Skipped for the per-turn header. */
  includeModels?: boolean;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function buildCapabilities(input: RuntimeSnapshotInput): CapabilityEntry[] {
  const outcomeByTool = new Map<string, boolean>();
  for (const outcome of input.toolOutcomes ?? []) outcomeByTool.set(outcome.tool, outcome.ok);

  const entries: CapabilityEntry[] = input.tools.map((tool) => ({
    name: tool.name,
    category: categorize(tool.name),
    available: true,
    label: tool.label,
    ...(outcomeByTool.has(tool.name) ? { lastOutcome: outcomeByTool.get(tool.name) ? "ok" as const : "error" as const } : {}),
  }));

  // Conceptual limitations — real, but never held by the agent autonomously.
  entries.push(
    { name: "promote_harness", category: "governance", available: false, note: "Gondola Lab / owner only" },
    { name: "change_permissions", category: "governance", available: false, note: "owner only" },
    { name: "modify_runtime", category: "governance", available: false, note: "owner-approved changes only" },
  );
  return entries;
}

export async function buildRuntimeSnapshot(input: RuntimeSnapshotInput): Promise<RuntimeSnapshot> {
  const toolNames = new Set(input.tools.map((tool) => tool.name));

  const [execution, mediaTasks, assets, failures, champion, lab, memory, approvalsPending, grants] = await Promise.all([
    getExecutionState(input.conversationId).catch(() => undefined),
    listMediaTasks({ limit: 20 }).catch(() => []),
    listAssets({ limit: 20 }).catch(() => []),
    listFailures({ limit: 12 }).catch(() => []),
    getChampionConfig().catch(() => undefined),
    getLabSnapshot().catch(() => undefined),
    getMemorySnapshot(input.memoryAgentId).catch(() => undefined),
    listApprovals({ conversationId: input.conversationId, status: "pending", limit: 10 }).catch(() => []),
    listGrants(input.conversationId).catch(() => []),
  ]);

  const manifest = createIdentityManifest({
    entity: { name: input.entityName },
    owner: input.ownerConfigured ? { profileStatus: "configured", preferredName: input.ownerName ?? null } : undefined,
  });

  const workflowBudget = champion?.config.workflowPolicy.budgetUsd;
  const allocatedUsd = execution?.budgetUsd ?? (typeof workflowBudget === "number" ? workflowBudget : null);

  const jobCost = (task: { actualCostUsd?: number; estimatedCostUsd?: number }): number => task.actualCostUsd ?? task.estimatedCostUsd ?? 0;
  const spentUsd = mediaTasks.reduce((sum, task) => sum + jobCost(task), 0)
    + assets.reduce((sum, asset) => sum + (asset.actualCostUsd ?? 0), 0);
  const estimatedRemainingCostUsd = mediaTasks
    .filter((task) => task.status === "queued" || task.status === "running")
    .reduce((sum, task) => sum + (task.estimatedCostUsd ?? 0), 0);
  const largestOperations = [...mediaTasks]
    .map((task) => ({ label: `${task.type} ${task.id.slice(0, 8)}`, costUsd: jobCost(task) }))
    .filter((entry) => entry.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 3);

  const models = input.includeModels
    ? await loadModelRegistry().then((list) => list.map((model) => ({
      id: model.id,
      kind: model.modalities.output.includes("video") ? "video"
        : model.modalities.output.includes("image") ? "image"
        : model.modalities.output.includes("audio") ? "audio"
        : model.modalities.output.includes("embedding") ? "embedding"
        : "chat",
      available: true,
    }))).catch(() => [])
    : [];

  const memStats = (memory as { stats?: { active?: number; pending?: number } } | undefined)?.stats;
  const openFailure = failures.find((failure) => failure.status === "open");
  const lastCheckpoint = execution?.checkpoints[execution.checkpoints.length - 1];

  const proposals = lab?.proposals ?? [];
  const openStatuses = new Set(["draft", "evaluating", "ready_for_review"]);

  return {
    generatedAt: new Date().toISOString(),
    identity: {
      entity: resolveEntityName(manifest.entity),
      isNamed: identityIsNamed(manifest.entity),
      orchestrator: manifest.orchestrator.name,
      executionRuntime: manifest.orchestrator.runtime,
      controlPlane: manifest.lab.name,
      currentModel: input.chatModel,
      ownerStatus: manifest.owner.profileStatus,
      ownerName: manifest.owner.preferredName,
      harnessVersion: champion?.versionId ?? null,
      championPolicyId: champion ? `workflow-policy-${champion.versionId}` : null,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      agentId: input.agentId,
    },
    objective: {
      goal: execution?.goal ?? null,
      plan: execution?.plan ?? null,
      currentStep: execution ? currentStepTitle(execution) : null,
      phase: execution?.phase ?? null,
      completionPct: execution ? executionCompletionPct(execution) : 0,
      blocked: execution ? isExecutionBlocked(execution) : false,
      waitingForHuman: execution?.waitingForHuman ?? false,
      waitingForTool: execution?.waitingForTool ?? false,
      waitingForMedia: execution?.waitingForMedia ?? false,
      recovering: execution?.recovering ?? false,
    },
    executionGraph: execution?.steps ?? [],
    capabilities: buildCapabilities(input),
    jobs: mediaTasks.map((task) => ({
      id: task.id,
      type: task.type,
      status: task.status,
      startedAt: task.createdAt,
      prompt: task.prompt,
      assetId: task.assetId,
      costUsd: jobCost(task) || undefined,
      goal: task.goal,
      sourceAssetIds: task.sourceAssetIds,
      retrievalAttempts: task.retrievalAttempts,
    })),
    assets: assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      status: asset.status,
      prompt: asset.prompt,
      url: asset.url,
      costUsd: asset.actualCostUsd ?? asset.estimatedCostUsd,
    })),
    models,
    memory: {
      semantic: memStats?.active ?? 0,
      conversation: 0,
      workingItems: memStats?.pending ?? 0,
      compacted: false,
      scope: input.memoryAgentId ? "agent-private" : "personal",
    },
    permissions: {
      canReadWriteFiles: toolNames.has("write_file") || toolNames.has("edit_file"),
      canRunCommands: toolNames.has("run_command"),
      canDelete: toolNames.has("delete_path"),
      canChangeModel: toolNames.has("set_model"),
      canProposeHarnessChange: toolNames.has("propose_harness_change"),
      canPromoteHarness: false,
      canChangePermissions: false,
      canModifyRuntime: false,
      cameraConditional: true,
      approvalPolicy: input.approvalPolicy ?? "risk_based",
      persistentTasks: input.persistentTasks !== false,
    },
    budget: {
      currency: "USD",
      allocatedUsd,
      spentUsd,
      remainingUsd: allocatedUsd != null ? Math.max(0, allocatedUsd - spentUsd) : null,
      perOperationCapUsd: input.perOperationCapUsd,
      largestOperations,
      estimatedRemainingCostUsd,
    },
    supervisor: {
      available: true,
      active: execution?.recovering ?? false,
      currentStrategy: execution?.recovering ? "assisted recovery" : null,
      retriesUsed: 0,
      retriesRemaining: 3,
      currentFailure: openFailure ? `${openFailure.capability}/${openFailure.category}` : null,
      recoverable: openFailure ? openFailure.category !== "permission" : null,
      alternativeModels: [],
      resumePoint: lastCheckpoint?.label ?? null,
    },
    failures: failures.map((failure) => ({
      capability: failure.capability,
      category: failure.category,
      count: failure.count,
      status: failure.status,
      lastError: failure.lastError,
      lastAt: failure.lastAt,
    })),
    checkpoints: (execution?.checkpoints ?? []).map((checkpoint) => ({
      id: checkpoint.id,
      label: checkpoint.label,
      createdAt: checkpoint.createdAt,
    })),
    lab: {
      championVersion: champion?.versionId ?? null,
      autopilotEnabled: (() => { try { return autopilotEnabled(); } catch { return false; } })(),
      promotionAllowed: proposals.some((proposal) => proposal.status === "ready_for_review"),
      openProposals: proposals
        .filter((proposal) => openStatuses.has(proposal.status))
        .map((proposal) => ({ id: proposal.proposalId, status: proposal.status, summary: proposal.observedProblem })),
      recentProposals: proposals
        .slice(0, 6)
        .map((proposal) => ({ id: proposal.proposalId, status: proposal.status, summary: proposal.observedProblem })),
      activePolicies: champion ? policyDirectives(champion.config.workflowPolicy) : [],
    },
    approvals: {
      pending: approvalsPending.map((record) => ({ id: record.id, tool: record.tool, summary: record.summary, createdAt: record.createdAt })),
      sessionGrants: grants.map((grant) => ({ tool: grant.tool, grantedAt: grant.grantedAt })),
      guardedTools: guardedToolList(),
    },
    architecture: (() => {
      const constitution = gondolaConstitution();
      return {
        version: constitution.version,
        purpose: constitution.purpose,
        principles: constitution.principles.map((principle) => ({ title: principle.title, text: principle.text })),
        roles: constitution.roles.map((role) => ({ role: role.role, responsibility: role.responsibility, boundary: role.boundary })),
        subsystems: constitution.subsystems.map((subsystem) => ({ name: subsystem.name, purpose: subsystem.purpose })),
      };
    })(),
    environment: {
      workspacePath: process.cwd(),
      os: `${os.type()} ${os.release()}`,
      node: process.version,
      git: await fileExists(path.join(process.cwd(), ".git")),
      availableCommands: toolNames.has("run_command") ? ["node", "npm", "git", "python3"] : [],
    },
  };
}
