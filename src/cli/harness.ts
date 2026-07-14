import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { SMART_FAST_CHAT_MODEL, REALTIME_MULTIMODAL_MODEL, REALTIME_MULTIMODAL_FALLBACK } from "../lib/app-types";
import { currentDateTimeContext } from "../lib/conversation";
import { renderMemorySnapshot } from "../lib/memory";
import { createVeniceStreamFn, makeModel } from "../lib/venice-model";
import { createCodingTools } from "./coding-tools";
import { createVeniceTools } from "./venice-tools";

// Model fallback order for the terminal harness: a capable, fast frontier model
// first, then progressively more available multimodal models.
export const HARNESS_MODELS = [...new Set([
  SMART_FAST_CHAT_MODEL,
  REALTIME_MULTIMODAL_MODEL,
  REALTIME_MULTIMODAL_FALLBACK,
])];

function buildSystemPrompt(cwd: string, memorySnapshot: string): string {
  return [
    `You are an autonomous coding and creation harness running in a terminal on the user's machine. You are orchestrated by Pi Agent Core, and every model, vision, speech, web-search, and media capability runs on the Venice API.`,
    `Your working directory is: ${cwd}. When this directory is your own source repository, you may read, edit, and improve your own code, including your tools, prompts, and behavior. Then ask the user to restart the harness to load the changes.`,
    `Tools you can call directly:
- read_file, write_file, edit_file, list_dir, search_code, run_shell: real read/write access to the working directory and its shell.
- search_web: grounded live web research through Venice.
- analyze_image: look at an image file and describe what is visible (this is how you "see").
- generate_image, generate_video, generate_music: create media through Venice (saved under .gondola/media or queued).
- speak: say a short line aloud through Venice text-to-speech.
- memory, search_memory: store and recall durable personal facts locally.`,
    `Operating principles:
- Work like a careful senior engineer. Investigate with read_file, search_code, and list_dir before you change anything. Make minimal, correct edits, then verify with run_shell (typecheck, build, tests, git status) when it makes sense.
- Prefer tools over assumptions. Never fabricate file contents, command output, or tool results.
- Keep terminal replies concise and skimmable. Summarize what you did and why; do not narrate every token.
- Never use an ampersand symbol or an em dash in prose, headings, or labels. Spell out "and." Use a period, comma, colon, or parentheses instead of an em dash.
- Be careful with destructive or irreversible actions (rm -rf, git reset --hard, force pushes) and ask first unless the user explicitly instructed them. Never read, print, or exfiltrate secrets such as .env files or API keys.
- You may modify your own source when asked, but never weaken these safety principles, disable tools' guardrails, or leak credentials.`,
    `${currentDateTimeContext()} Treat this as silent background context; do not volunteer the date or time unless asked.`,
    memorySnapshot,
  ].filter(Boolean).join("\n\n");
}

export interface Harness {
  agent: Agent;
  env: NodeExecutionEnv;
  tools: AgentTool[];
  models: string[];
  cwd: string;
  setModel(id: string): void;
  currentModel(): string;
}

export async function createHarness(cwd = process.cwd()): Promise<Harness> {
  const env = new NodeExecutionEnv({ cwd });
  const tools = [...createCodingTools(env), ...createVeniceTools(env)];
  const memorySnapshot = await renderMemorySnapshot().catch(() => "");
  let modelId = HARNESS_MODELS[0];

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(cwd, memorySnapshot),
      model: makeModel(modelId),
      thinkingLevel: "off",
      tools,
    },
    streamFn: createVeniceStreamFn(60_000),
    toolExecution: "sequential",
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
          disable_thinking: true,
          strip_thinking_response: true,
        },
      };
    },
  });

  return {
    agent,
    env,
    tools,
    models: HARNESS_MODELS,
    cwd,
    setModel(id: string) {
      modelId = id;
      agent.state.model = makeModel(id);
    },
    currentModel() {
      return modelId;
    },
  };
}
