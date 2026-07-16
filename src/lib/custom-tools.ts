import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runSubAgent, type SubAgentStatus } from "./subagent";

// Agent-authored "ability" tools.
//
// This is how the companion extends itself without executing arbitrary code. An
// ability is a saved *recipe*: a name, a description, some named string inputs,
// a natural-language playbook, and the subset of existing tools the recipe may
// use. When the ability is called, it runs a scoped worker sub-agent whose
// system prompt is the playbook and whose toolset is exactly the allowed tools.
//
// Because "create a tool" and "coordinate sub-agents" collapse onto the same
// primitive, an ability whose allowed tools include `orchestrate`/`delegate_task`
// is literally a tool that coordinates sub-agents.

const ROOT = path.join(process.cwd(), ".gondola");
const FILE = path.join(ROOT, "custom-tools.json");
const MAX_TOOLS_PER_AGENT = 64;
const MAX_INPUTS = 8;
const MAX_ALLOWED_TOOLS = 32;

export interface CustomToolDef {
  id: string;
  /** The agent that authored (and owns) this ability. */
  agentId: string;
  /** snake_case, unique per agent, safe as an OpenAI tool name. */
  name: string;
  description: string;
  /** Named string parameters the ability accepts. */
  inputs: string[];
  /** Natural-language instructions the worker follows to fulfil the ability. */
  playbook: string;
  /** Names of existing tools the worker is allowed to use. */
  allowedTools: string[];
  /** Optional model override for this ability's worker; falls back to the default. */
  model?: string;
  /**
   * Governance gate. An authored ability is always "pending" and is NOT loaded
   * into the live toolset until the owner approves it. Only "approved" abilities
   * become callable. This is what keeps self-extension from being self-approval.
   */
  status: "pending" | "approved";
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
}

interface CustomToolStore {
  version: 1;
  tools: CustomToolDef[];
}

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function read(): Promise<CustomToolStore> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Partial<CustomToolStore>;
    const tools = (Array.isArray(parsed.tools) ? parsed.tools : []).map((tool) => ({
      ...tool,
      // Anything not explicitly approved is treated as pending, so nothing runs
      // without approval even if the file was hand-edited or predates this field.
      status: tool.status === "approved" ? "approved" : "pending",
    })) as CustomToolDef[];
    return { version: 1, tools };
  } catch {
    return { version: 1, tools: [] };
  }
}

async function write(store: CustomToolStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, FILE);
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
const INPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export function normalizeToolName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function sanitizeInputs(inputs: string[] | undefined): string[] {
  if (!Array.isArray(inputs)) return [];
  const cleaned = inputs
    .map((value) => normalizeToolName(String(value)))
    .filter((value) => INPUT_NAME_PATTERN.test(value));
  return [...new Set(cleaned)].slice(0, MAX_INPUTS);
}

function sanitizeAllowedTools(allowed: string[] | undefined): string[] {
  if (!Array.isArray(allowed)) return [];
  const cleaned = allowed.map((value) => String(value).trim()).filter(Boolean);
  return [...new Set(cleaned)].slice(0, MAX_ALLOWED_TOOLS);
}

export async function listCustomTools(agentId?: string, status?: "pending" | "approved"): Promise<CustomToolDef[]> {
  const store = await read();
  return store.tools.filter((tool) =>
    (!agentId || tool.agentId === agentId) && (!status || tool.status === status));
}

/** Only the abilities the owner has approved (the set that becomes callable). */
export async function listApprovedCustomTools(agentId?: string): Promise<CustomToolDef[]> {
  return listCustomTools(agentId, "approved");
}

export async function createCustomTool(input: {
  agentId: string;
  name: string;
  description: string;
  playbook: string;
  inputs?: string[];
  allowedTools?: string[];
  model?: string;
  /** Built-in / already-taken names that an ability must not shadow. */
  reservedNames?: string[];
}): Promise<CustomToolDef> {
  const name = normalizeToolName(input.name);
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error("Ability name must be snake_case, 2-48 chars, starting with a letter.");
  }
  const description = input.description.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!description) throw new Error("An ability needs a one-line description of when to use it.");
  const playbook = input.playbook.trim().slice(0, 8_000);
  if (!playbook) throw new Error("An ability needs a playbook describing the steps to follow.");
  if (input.reservedNames?.includes(name)) {
    throw new Error(`"${name}" is already a built-in tool name. Choose a different ability name.`);
  }
  const def: CustomToolDef = {
    id: crypto.randomUUID(),
    agentId: input.agentId,
    name,
    description,
    inputs: sanitizeInputs(input.inputs),
    playbook,
    allowedTools: sanitizeAllowedTools(input.allowedTools),
    ...(input.model?.trim() ? { model: input.model.trim().slice(0, 64) } : {}),
    // Governance: born pending. It cannot run until the owner approves it.
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  return serial(async () => {
    const store = await read();
    const mine = store.tools.filter((tool) => tool.agentId === input.agentId);
    if (mine.some((tool) => tool.name === name)) {
      throw new Error(`You already have an ability named "${name}". Delete it first or pick another name.`);
    }
    if (mine.length >= MAX_TOOLS_PER_AGENT) {
      throw new Error("You have reached the maximum number of custom abilities. Delete an unused one first.");
    }
    store.tools.push(def);
    await write(store);
    return def;
  });
}

export async function deleteCustomTool(input: { agentId: string; name?: string; id?: string }): Promise<boolean> {
  return serial(async () => {
    const store = await read();
    const before = store.tools.length;
    store.tools = store.tools.filter((tool) => {
      if (tool.agentId !== input.agentId) return true;
      const matches = (input.id && tool.id === input.id) || (input.name && tool.name === normalizeToolName(input.name));
      return !matches;
    });
    if (store.tools.length === before) return false;
    await write(store);
    return true;
  });
}

/**
 * Owner approval: flip a pending ability to approved so it can be materialized
 * into the live toolset. This is the human gate in the self-extension loop; the
 * agent can author and test, but only an approval here makes an ability callable.
 */
export async function approveCustomTool(input: {
  agentId: string;
  id?: string;
  name?: string;
  approvedBy?: string;
}): Promise<CustomToolDef | undefined> {
  const targetName = input.name ? normalizeToolName(input.name) : undefined;
  return serial(async () => {
    const store = await read();
    const tool = store.tools.find((candidate) =>
      candidate.agentId === input.agentId
      && ((input.id && candidate.id === input.id) || (targetName && candidate.name === targetName)));
    if (!tool) return undefined;
    tool.status = "approved";
    tool.approvedAt = new Date().toISOString();
    if (input.approvedBy?.trim()) tool.approvedBy = input.approvedBy.trim().slice(0, 80);
    await write(store);
    return tool;
  });
}

// ── Materialization ──────────────────────────────────────────────────────────

export interface MaterializeContext {
  /** Model the worker sub-agent runs on. */
  model: string;
  /** Depth of the *parent* that owns these abilities (primary agent = 0). */
  parentDepth: number;
  /** Hard nesting cap; abilities are inert once this depth is reached. */
  maxDepth: number;
  /**
   * Resolve the candidate tool instances a worker may use for a given
   * allow-list (empty means "the safe base set") and the depth the worker runs
   * at. Supplied by the caller so this module stays decoupled from how the full
   * toolset is assembled. The returned tools are still safety-scoped by depth
   * inside runSubAgent.
   */
  buildWorkerTools: (allowedNames: string[], childDepth: number) => AgentTool[];
  /** Forward live worker progress to the client (subagent_* events). */
  emit?: (event: Record<string, unknown>) => void;
  /** Reserve one worker slot against the per-turn budget; false when exhausted. */
  reserveWorker?: () => boolean;
}

function playbookSystemPrompt(def: CustomToolDef): string {
  return [
    `You are executing the "${def.name}" ability for a primary AI companion.`,
    `Purpose: ${def.description}`,
    "",
    "Playbook to follow:",
    def.playbook,
    "",
    "Rules: work autonomously with the tools you have; do not chat or add persona.",
    "When finished, reply with a single concise, self-contained result the primary agent can use directly.",
  ].join("\n");
}

function taskFromParams(def: CustomToolDef, params: Record<string, unknown>): string {
  if (!def.inputs.length) return "Run the ability now and return the final result.";
  const lines = def.inputs.map((key) => `- ${key}: ${String(params[key] ?? "").trim() || "(not provided)"}`);
  return `Run the ability now with these inputs:\n${lines.join("\n")}`;
}

/** Turn saved ability recipes into callable AgentTools. */
export function materializeCustomTools(defs: CustomToolDef[], ctx: MaterializeContext): AgentTool[] {
  return defs.map((def): AgentTool => {
    const properties: Record<string, TSchema> = {};
    for (const key of def.inputs) {
      properties[key] = Type.String({ maxLength: 4_000 });
    }
    return {
      name: def.name,
      label: `Ability: ${def.name}`,
      description: `${def.description} (Self-authored ability that runs a scoped worker.)`,
      parameters: Type.Object(properties),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, onUpdate) {
        if (ctx.parentDepth >= ctx.maxDepth) {
          return {
            content: [{ type: "text", text: `The "${def.name}" ability can't run this deep in a chain of sub-agents.` }],
            details: { kind: "custom_tool", tool: def.name, blocked: "max_depth" },
          };
        }
        if (ctx.reserveWorker && !ctx.reserveWorker()) {
          return {
            content: [{ type: "text", text: `The "${def.name}" ability was skipped: this turn already reached its worker budget.` }],
            details: { kind: "custom_tool", tool: def.name, blocked: "budget" },
          };
        }
        const childDepth = ctx.parentDepth + 1;
        const workerTools = ctx.buildWorkerTools(def.allowedTools, childDepth);
        const runId = crypto.randomUUID();
        ctx.emit?.({ type: "subagent_start", id: runId, task: `${def.name}` });
        let ended = false;
        const finish = (extra: Record<string, unknown>) => {
          if (ended) return;
          ended = true;
          ctx.emit?.({ type: "subagent_end", id: runId, ...extra });
        };
        try {
          const result = await runSubAgent({
            task: taskFromParams(def, params as Record<string, unknown>),
            systemPrompt: playbookSystemPrompt(def),
            model: def.model || ctx.model,
            tools: workerTools,
            depth: childDepth,
            signal,
            onStatus: (status: SubAgentStatus) => {
              ctx.emit?.({ type: "subagent_step", id: runId, ...status });
              onUpdate?.({
                content: [{ type: "text", text: status.phase === "tool" ? `Ability using ${status.tool}` : `Ability step ${status.turn}` }],
                details: { kind: "custom_tool", tool: def.name, ...status },
              });
            },
          });
          finish({ turns: result.turns, toolCalls: result.toolCalls, hitBudget: result.hitBudget, ok: true });
          return {
            content: [{ type: "text", text: result.text }],
            details: { kind: "custom_tool", tool: def.name, turns: result.turns, toolCalls: result.toolCalls, hitBudget: result.hitBudget },
          };
        } catch (error) {
          finish({ ok: false });
          throw error;
        }
      },
    };
  });
}
