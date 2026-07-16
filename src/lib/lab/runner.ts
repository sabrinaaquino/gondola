import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { makeModel, createVeniceStreamFn } from "../venice-model";
import { veniceJson } from "../venice";
import { resolveRoutedModel } from "./apply";
import { policyPromptBlock } from "./policy";
import { createEvalTools } from "./eval-tools";
import { JUDGE_CONFIG, type TaskRunInput, type TaskRunner } from "./evaluation";
import { RUNTIME_VERSION, type LabConfig, type ModelCallRecord, type RunTrace, type ToolCallRecord, type TraceArtifact } from "./types";

// Phase 4b: a REAL task runner behind the existing TaskRunner seam. Instead of
// synthesizing a trace from policy (the simulation), it runs the actual agent on
// an evaluation case and shapes the outcome into a RunTrace the graders can score.
//
// Split so the shaping is pure and unit-testable offline (createLiveTaskRunner
// takes an injected RunAgentFn), while the parts that make real Venice calls
// (makeLiveRunAgent, createLiveJudge) are isolated and used only when the owner
// opts into a live evaluation (which costs inference).

const MEDIA_ARTIFACT_KIND: Record<string, TraceArtifact["kind"]> = {
  generate_image: "image",
  generate_video: "video",
  generate_music: "audio",
};

export interface AgentRun {
  text: string;
  toolCalls: ToolCallRecord[];
  modelCalls: ModelCallRecord[];
  latencyMs: number;
  completed: boolean;
  humanInterventions?: number;
}

export type RunAgentFn = (input: {
  task: string;
  systemPrompt: string;
  model: string;
  tools?: AgentTool[];
  workspaceDir?: string;
  signal?: AbortSignal;
}) => Promise<AgentRun>;

function round(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

function roleSystemPrompt(config: LabConfig): string {
  const creator = config.roles.find((role) => role.name === "creator") ?? config.roles[0];
  const base = creator?.instructions ?? "Complete the requested task end to end.";
  // Inject the SAME policy -> behavior block the live agent uses, so a challenger
  // config actually behaves differently here (harness benefit in evaluation), not
  // just in production. Without this, champion vs challenger would be identical
  // for every workflow-policy field and the Lab would grade descriptions, not
  // genuinely different harnesses.
  const policy = policyPromptBlock(config.workflowPolicy);
  return [base, policy, "Work autonomously with the tools you have. When finished, reply with a single concise, self-contained result."]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Turn an injected agent run into a graded-ready RunTrace. Pure: no Venice calls,
 * so it is fully unit-testable with a fake RunAgentFn.
 */
export function createLiveTaskRunner(runAgent: RunAgentFn): TaskRunner {
  return async (input: TaskRunInput): Promise<RunTrace> => {
    const model = resolveRoutedModel(input.config, "creator") ?? input.config.routing.defaultModel;
    const run = await runAgent({
      task: input.taskCase.task,
      systemPrompt: roleSystemPrompt(input.config),
      model,
      // Give the evaluation agent the same kind of (budget-capped, auto-confirm)
      // media tools the live agent has, so a challenger's workflow policy can
      // manifest as a genuinely different tool sequence the graders can score.
      tools: createEvalTools({ budgetUsd: input.config.workflowPolicy.budgetUsd }),
      workspaceDir: input.workspaceDir,
    });
    const costUsd = round(run.modelCalls.reduce((sum, call) => sum + (call.costUsd || 0), 0));
    const artifacts: TraceArtifact[] = run.toolCalls
      .filter((call) => call.ok && MEDIA_ARTIFACT_KIND[call.tool])
      .map((call) => ({ id: crypto.randomUUID(), kind: MEDIA_ARTIFACT_KIND[call.tool], approved: false }));
    return {
      runId: crypto.randomUUID(),
      runtimeVersion: RUNTIME_VERSION,
      configVersionId: input.configVersionId,
      goal: input.taskCase.task,
      constraints: [`budget<=${input.config.workflowPolicy.budgetUsd}`],
      modelsSelected: [...new Set([model, ...run.modelCalls.map((call) => call.model)].filter(Boolean))],
      modelCalls: run.modelCalls,
      toolCalls: run.toolCalls,
      toolErrors: run.toolCalls.filter((call) => !call.ok).map((call) => call.error ?? `${call.tool} failed`),
      artifacts,
      humanInterventions: Math.max(0, Math.floor(run.humanInterventions ?? 0)),
      costUsd,
      latencyMs: Math.max(0, Math.round(run.latencyMs)),
      completed: run.completed,
      finalOutput: (run.text ?? "").slice(0, 4_000),
      finalized: false,
      createdAt: new Date().toISOString(),
    };
  };
}

/**
 * Live RunAgentFn: actually runs the agent (fresh, isolated) and collects tool
 * outcomes and per-call cost. Makes real Venice calls, so it is used only for
 * opt-in live evaluations and is not part of the offline test surface.
 */
export function makeLiveRunAgent(options?: { tools?: AgentTool[]; maxTurns?: number }): RunAgentFn {
  return async ({ task, systemPrompt, model, tools, signal }) => {
    const startedAt = Date.now();
    const toolCalls: ToolCallRecord[] = [];
    const modelCalls: ModelCallRecord[] = [];
    let text = "";
    let turns = 0;
    const maxTurns = options?.maxTurns ?? 8;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: makeModel(model),
        thinkingLevel: "off",
        tools: tools ?? options?.tools ?? [],
        messages: [],
      },
      streamFn: createVeniceStreamFn(30_000),
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

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        toolCalls.push({ tool: event.toolName, ok: !event.isError, ...(event.isError ? { error: "tool error" } : {}) });
      } else if (event.type === "turn_end") {
        turns += 1;
        if (turns >= maxTurns && agent.state.isStreaming) agent.abort();
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const assistant = event.message;
        const body = assistant.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
        if (body && assistant.stopReason !== "error") text = body;
        modelCalls.push({
          model: assistant.model ?? model,
          purpose: "chat",
          costUsd: assistant.usage?.cost?.total ?? 0,
          latencyMs: 0,
        });
      }
    });

    const onAbort = () => { if (agent.state.isStreaming) agent.abort(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await agent.prompt(task);
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    }

    return { text, toolCalls, modelCalls, latencyMs: Date.now() - startedAt, completed: Boolean(text) };
  };
}

/** Extract a 0-10 score from a judge model's reply. Pure and unit-testable. */
export function parseJudgeScore(text: string): number {
  const labeled = text.match(/"?score"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const raw = labeled ? labeled[1] : (text.match(/-?\d+(?:\.\d+)?/) ?? [])[0];
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, value));
}

/**
 * Live judge: scores a trace with the fixed judge model. Makes a real Venice
 * call, so it is used only for opt-in live evaluations. Returns 0 on any failure
 * (fail closed: an unverifiable run is not credited quality).
 */
export function createLiveJudge(model: string = JUDGE_CONFIG.model): (trace: RunTrace) => Promise<number> {
  return async (trace) => {
    try {
      const response = await veniceJson<{ choices?: Array<{ message?: { content?: string } }> }>(
        "/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: `${JUDGE_CONFIG.prompt} Respond with ONLY a JSON object of the form {"score": number} from 0 to 10.` },
            {
              role: "user",
              content: `GOAL:\n${trace.goal}\n\nRESULT:\n${trace.finalOutput.slice(0, 4_000)}\n\nEVIDENCE: ${trace.toolCalls.length} tool call(s), ${trace.modelCalls.length} model call(s), completed=${trace.completed}.`,
            },
          ],
          max_completion_tokens: 60,
          temperature: 0,
          response_format: { type: "json_object" },
          venice_parameters: { enable_web_search: "off", disable_thinking: true, strip_thinking_response: true },
        },
      );
      return parseJudgeScore(response.choices?.[0]?.message?.content ?? "");
    } catch {
      return 0;
    }
  };
}
