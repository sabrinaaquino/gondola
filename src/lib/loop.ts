import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { REALTIME_MULTIMODAL_MODEL } from "./app-types";
import { createTextSink } from "./emit-sink";
import { enqueueAgentTurn } from "./pi-agent";
import { veniceJson } from "./venice";

// Boris Cherny-style "loops": act -> verify against a checkable finish line ->
// log the failure as a lesson -> retry, until it passes or hits a hard cap.
//
// The two ingredients that make this a real loop (not just a rerun) are:
//   1. A separate JUDGE model that never sees how the output was produced, only
//      the goal and the final output. "The judge can't be the worker."
//   2. A persistent lessons journal the worker reads on every attempt, so each
//      cycle starts a little wiser instead of repeating the same mistake.
//
// Because this is a paid, unattended runtime with tool access, every loop is
// hard-capped (iterations + the worker's own per-turn timeouts + the scoped,
// no-spend toolset already enforced for background turns).

const ROOT = path.join(process.cwd(), ".gondola");
const LOOP_DIR = path.join(ROOT, "loops");

const MAX_ITERATIONS_CAP = 6;
const DEFAULT_ITERATIONS = 3;
const MAX_INJECTED_LESSONS = 12;

// Default the verifier to a different family than the default worker chat model
// (GLM) so it does not rubber-stamp its own style.
const DEFAULT_JUDGE_MODEL = REALTIME_MULTIMODAL_MODEL;
const JUDGE_FALLBACK_MODEL = "qwen3-5-9b";

interface JournalEntry {
  at: string;
  iteration: number;
  reason: string;
}

function journalPath(taskId: string): string {
  return path.join(LOOP_DIR, `${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

async function readLessons(taskId: string): Promise<string[]> {
  try {
    const raw = await readFile(journalPath(taskId), "utf8");
    const reasons: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (entry.reason) reasons.push(entry.reason);
      } catch {
        // Skip a torn line.
      }
    }
    // Most recent lessons are the most relevant; de-duplicate.
    return [...new Set(reasons.reverse())].slice(0, MAX_INJECTED_LESSONS);
  } catch {
    return [];
  }
}

async function appendLesson(taskId: string, iteration: number, reason: string): Promise<void> {
  await mkdir(LOOP_DIR, { recursive: true });
  const entry: JournalEntry = { at: new Date().toISOString(), iteration, reason };
  await appendFile(journalPath(taskId), `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined);
}

export interface JudgeVerdict {
  passed: boolean;
  reason: string;
}

function parseVerdict(text: string): JudgeVerdict | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as { passed?: unknown; reason?: unknown };
    if (typeof parsed.passed === "boolean") {
      return { passed: parsed.passed, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
    }
  } catch {
    // Fall through to a lenient scan below.
  }
  if (/"passed"\s*:\s*true/i.test(cleaned)) return { passed: true, reason: "Verifier approved the output." };
  if (/"passed"\s*:\s*false/i.test(cleaned)) return { passed: false, reason: cleaned.slice(0, 240) };
  return undefined;
}

const JUDGE_SYSTEM = "You are a strict, skeptical verifier. You are given a GOAL (a finish line) and an OUTPUT produced by a different AI. Decide whether the OUTPUT fully satisfies EVERY explicit requirement in the GOAL. Be conservative: if any requirement is missing, unverifiable from the output alone, contradicted, or only partially met, it FAILS. You only see the final output, never how it was produced, and you must not assume unstated work happened. Respond with ONLY a single JSON object of the form {\"passed\": boolean, \"reason\": string}. The reason must be one or two sentences naming exactly which requirement is unmet (on failure) or confirming each was met (on pass).";

export async function judgeAgainstGoal(
  goal: string,
  output: string,
  model = DEFAULT_JUDGE_MODEL,
  signal?: AbortSignal,
): Promise<JudgeVerdict> {
  if (!output.trim()) return { passed: false, reason: "The worker produced no output to verify." };
  const user = `GOAL:\n${goal.trim()}\n\nOUTPUT:\n${output.trim().slice(0, 12_000)}`;
  for (const candidate of [...new Set([model, JUDGE_FALLBACK_MODEL])]) {
    try {
      const response = await veniceJson<{ choices?: Array<{ message?: { content?: string } }> }>(
        "/chat/completions",
        {
          model: candidate,
          messages: [
            { role: "system", content: JUDGE_SYSTEM },
            { role: "user", content: user },
          ],
          max_completion_tokens: 220,
          temperature: 0,
          response_format: { type: "json_object" },
          venice_parameters: {
            enable_web_search: "off",
            disable_thinking: true,
            strip_thinking_response: true,
          },
        },
        signal,
      );
      const verdict = parseVerdict(response.choices?.[0]?.message?.content ?? "");
      if (verdict) return verdict;
    } catch {
      // Try the fallback judge model before giving up.
    }
  }
  // If the verifier itself is unavailable, fail closed: never declare success
  // we could not confirm.
  return { passed: false, reason: "The verifier was unavailable, so the result could not be confirmed." };
}

export interface LoopResult {
  passed: boolean;
  output: string;
  iterations: number;
  reason: string;
  error?: string;
}

export async function runGoalLoop(input: {
  conversationId: string;
  agentId: string;
  prompt: string;
  goal: string;
  maxIterations?: number;
  judgeModel?: string;
  taskId: string;
  signal?: AbortSignal;
}): Promise<LoopResult> {
  const maxIterations = Math.max(1, Math.min(MAX_ITERATIONS_CAP, Math.floor(input.maxIterations ?? DEFAULT_ITERATIONS)));
  const lessons = await readLessons(input.taskId);
  let lastOutput = "";
  let lastReason = "";

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const lessonBlock = lessons.length
      ? `\n\nLESSONS FROM PREVIOUS ATTEMPTS (do not repeat these mistakes):\n${lessons.map((lesson) => `- ${lesson}`).join("\n")}`
      : "";
    const message = `${input.prompt}\n\nFINISH LINE: your output must fully satisfy this before you are done:\n${input.goal}${lessonBlock}\n\nProduce only the finished result that meets the finish line.`;

    const sink = createTextSink();
    try {
      await enqueueAgentTurn({
        sessionId: input.conversationId,
        agentId: input.agentId,
        message,
        emit: sink.emit,
        source: "schedule",
      });
    } catch (error) {
      return {
        passed: false,
        output: sink.getText(),
        iterations: iteration,
        reason: "The worker turn failed.",
        error: error instanceof Error ? error.message : "The worker turn failed",
      };
    }

    lastOutput = sink.getText();
    const turnError = sink.getError();
    if (turnError && !lastOutput) {
      return { passed: false, output: "", iterations: iteration, reason: "The worker turn errored.", error: turnError };
    }

    const verdict = await judgeAgainstGoal(input.goal, lastOutput, input.judgeModel, input.signal);
    lastReason = verdict.reason;
    if (verdict.passed) {
      return { passed: true, output: lastOutput, iterations: iteration, reason: verdict.reason };
    }
    // Log the failure so the next attempt (this run or a future scheduled run)
    // starts wiser, then feed it back in immediately.
    await appendLesson(input.taskId, iteration, verdict.reason);
    lessons.unshift(verdict.reason);
    while (lessons.length > MAX_INJECTED_LESSONS) lessons.pop();
  }

  return {
    passed: false,
    output: lastOutput,
    iterations: maxIterations,
    reason: lastReason || "The finish line was not met within the attempt budget.",
  };
}
