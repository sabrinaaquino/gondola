import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createVeniceStreamFn, makeModel } from "./venice-model";

// Hermes-style scoped sub-agent delegation.
//
// A parent agent can spin off a worker to run a focused sub-task against a
// restricted toolset and its own bounded iteration budget, then fold only the
// worker's final result back into the parent conversation. The worker is
// deliberately scoped: it cannot delegate again (no recursion), cannot spend
// money on media, and cannot rewrite the entity's identity. This mirrors the
// "sub-agents should be scoped, not autonomous" safety pattern.

export const MAX_SUBAGENT_DEPTH = 1;

// Tools a worker may use. Includes research (web + past conversations + camera)
// and the constructive coding tools (read/list/create/write/edit/move), so a
// worker can carry out a real coding sub-task. Deliberately excludes the
// destructive coding tools (delete_path, run_command), plus delegate_task,
// rewrite_self, media generation, avatar/presence, and memory writes. The
// remaining destructive path — overwriting an existing file — is blocked at the
// tool level for workers (see pi-agent.ts), since a worker can't stop to ask for
// confirmation the way the primary agent does.
export const SUBAGENT_TOOL_ALLOWLIST = new Set([
  "search_web",
  "session_search",
  "inspect_camera",
  "read_file",
  "list_directory",
  "create_directory",
  "write_file",
  "edit_file",
  "move_path",
]);

const WORKER_SYSTEM_PROMPT = `You are a focused worker sub-agent spawned by a primary AI companion to complete one specific task.

- Work autonomously and efficiently. Use the tools available to you to gather what you need.
- Do not chat, greet, role-play, or add persona. You are an internal worker.
- For coding or file tasks: explore with list_directory and read_file before changing anything, then create files with write_file and modify existing ones with edit_file (use a unique old_string). You cannot overwrite existing files wholesale, delete anything, or run terminal commands; leave those to the primary agent. Never write secrets or credentials.
- When done, reply with a single concise, self-contained result that the primary agent can use directly. Prefer tight prose. List the files you created or changed with their paths, include concrete findings, and add source URLs when you researched the web.
- If you cannot complete the task, say briefly what you did, what you found, and what is blocking you.`;

export interface SubAgentResult {
  text: string;
  turns: number;
  toolCalls: number;
  hitBudget: boolean;
}

// Structured progress a worker reports as it runs, so the primary turn can show
// a live task card (which tool the worker is using, and how many steps it took).
export type SubAgentStatus =
  | { phase: "tool"; tool: string }
  | { phase: "turn"; turn: number };

export async function runSubAgent(input: {
  task: string;
  model: string;
  tools: AgentTool[];
  maxTurns?: number;
  signal?: AbortSignal;
  onStatus?: (status: SubAgentStatus) => void;
}): Promise<SubAgentResult> {
  const maxTurns = input.maxTurns ?? 8;
  const scopedTools = input.tools.filter((tool) => SUBAGENT_TOOL_ALLOWLIST.has(tool.name));

  const agent = new Agent({
    initialState: {
      systemPrompt: WORKER_SYSTEM_PROMPT,
      model: makeModel(input.model),
      thinkingLevel: "off",
      tools: scopedTools,
      messages: [],
    },
    streamFn: createVeniceStreamFn(20_000),
    toolExecution: "parallel",
    maxRetryDelayMs: 2_500,
    onPayload: (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
      const record = payload as Record<string, unknown>;
      const existing = record.venice_parameters;
      return {
        ...record,
        venice_parameters: {
          ...(existing && typeof existing === "object" ? existing : {}),
          enable_web_search: "off",
          enable_web_scraping: false,
          disable_thinking: true,
          strip_thinking_response: true,
        },
      };
    },
  });

  let turns = 0;
  let toolCalls = 0;
  let hitBudget = false;
  let latestText = "";

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      input.onStatus?.({ phase: "tool", tool: event.toolName });
    } else if (event.type === "turn_end") {
      turns += 1;
      input.onStatus?.({ phase: "turn", turn: turns });
      if (turns >= maxTurns && agent.state.isStreaming) {
        hitBudget = true;
        agent.abort();
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
      if (text && event.message.stopReason !== "error") latestText = text;
    }
  });

  try {
    await agent.prompt(input.task);
  } finally {
    unsubscribe();
  }

  const text = latestText
    || (hitBudget
      ? "The worker reached its step budget before finishing. Partial progress may be available."
      : "The worker did not produce a result.");
  return { text, turns, toolCalls, hitBudget };
}
