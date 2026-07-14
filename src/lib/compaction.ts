import { estimateContextTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import { SMART_FAST_CHAT_MODEL } from "./app-types";
import { veniceJson } from "./venice";

// Hermes-style preflight context compression.
//
// Long sessions blow the context window and cost. Hermes keeps a stable core
// (recent turns + the very start of the conversation) and folds the middle of
// the conversation into a running summary produced by an auxiliary model. We do
// the same here, before each turn:
//   [ protected head ] [ rolling summary of the middle ] [ recent tail ]
// The summary is stored as a normal assistant message, so it persists in the
// durable transcript and is reused (and iteratively extended) on later
// compactions instead of being regenerated from scratch.

export const COMPACTION_MARKER = "[Compacted earlier conversation summary]";

// Tuned for this app's short voice/vision turns and small max output. The point
// is to keep the working window lean and cheap while never dropping the thread.
const TRIGGER_TOKENS = 6_000;
const KEEP_RECENT_TOKENS = 2_400;
const PROTECT_HEAD_MESSAGES = 2;
const MIN_MIDDLE_MESSAGES = 4;

const SUMMARY_MODELS = [SMART_FAST_CHAT_MODEL, "qwen3-5-9b"];

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageText(message: AgentMessage): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ");
  }
  if (message.role === "assistant") {
    return message.content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "toolCall") return `[called ${part.name}]`;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (message.role === "toolResult") {
    const text = message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ");
    return `[result of ${message.toolName}] ${text}`;
  }
  return "";
}

function isCompactionSummary(message: AgentMessage): boolean {
  return (
    message.role === "assistant"
    && message.content.some((part) => part.type === "text" && part.text.startsWith(COMPACTION_MARKER))
  );
}

function makeSummaryMessage(summary: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `${COMPACTION_MARKER}\n${summary}` }],
    api: "openai-completions",
    provider: "venice" as never,
    model: "compaction",
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function serializeForSummary(messages: AgentMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role === "toolResult" ? "tool" : message.role;
      return `${role.toUpperCase()}: ${messageText(message).replace(/\s+/g, " ").trim()}`;
    })
    .filter((line) => line.length > 6)
    .join("\n")
    .slice(0, 14_000);
}

async function summarizeMiddle(
  middle: AgentMessage[],
  previousSummary: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const transcript = serializeForSummary(middle);
  if (!transcript) return undefined;
  const system = "You compress a conversation between a user and an AI companion into a compact running memory. Preserve durable facts, user preferences and identity details, decisions, task state, unresolved threads, and anything needed to continue seamlessly. Drop chit-chat and pleasantries. Do NOT answer or continue the conversation. Output only the summary as tight bullet-style prose, at most 220 words.";
  const user = [
    previousSummary ? `Existing summary to extend and merge:\n${previousSummary}` : "",
    `Conversation to fold into the summary:\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  for (const model of SUMMARY_MODELS) {
    try {
      const response = await veniceJson<{ choices?: Array<{ message?: { content?: string } }> }>(
        "/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_completion_tokens: 420,
          temperature: 0.2,
          venice_parameters: {
            enable_web_search: "off",
            disable_thinking: true,
            strip_thinking_response: true,
          },
        },
        signal,
      );
      const text = response.choices?.[0]?.message?.content?.trim();
      if (text) return text.replace(/\^\d+(?:,\d+)*\^/g, "").trim();
    } catch {
      // Try the next fallback model before giving up on compaction.
    }
  }
  return undefined;
}

export interface CompactionOutcome {
  messages: AgentMessage[];
  compacted: boolean;
  tokensBefore: number;
  tokensAfter?: number;
}

// Advance to the next clean user-turn boundary so we never orphan a toolResult
// from the assistant message that requested it.
function nextUserBoundary(messages: AgentMessage[], from: number): number {
  for (let index = from; index < messages.length; index += 1) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

export async function compactMessages(
  messages: AgentMessage[],
  signal?: AbortSignal,
): Promise<CompactionOutcome> {
  const tokensBefore = estimateContextTokens(messages).tokens;
  if (messages.length < PROTECT_HEAD_MESSAGES + MIN_MIDDLE_MESSAGES + 2 || tokensBefore <= TRIGGER_TOKENS) {
    return { messages, compacted: false, tokensBefore };
  }

  // Locate an existing rolling summary so we extend it instead of regenerating.
  const summaryIndex = messages.findIndex(isCompactionSummary);
  const previousSummary = summaryIndex >= 0
    ? messageText(messages[summaryIndex]).slice(COMPACTION_MARKER.length).trim()
    : undefined;
  const head = summaryIndex >= 0 ? messages.slice(0, summaryIndex) : messages.slice(0, PROTECT_HEAD_MESSAGES);
  const middleStart = summaryIndex >= 0 ? summaryIndex + 1 : PROTECT_HEAD_MESSAGES;

  // Walk back from the end until we have ~KEEP_RECENT_TOKENS of recent context.
  let recentTokens = 0;
  let tailStart = messages.length;
  for (let index = messages.length - 1; index > middleStart; index -= 1) {
    recentTokens = estimateContextTokens(messages.slice(index)).tokens;
    tailStart = index;
    if (recentTokens >= KEEP_RECENT_TOKENS) break;
  }
  const boundary = nextUserBoundary(messages, tailStart);
  if (boundary <= middleStart) return { messages, compacted: false, tokensBefore };
  tailStart = boundary;

  const middle = messages.slice(middleStart, tailStart);
  if (middle.length < MIN_MIDDLE_MESSAGES) return { messages, compacted: false, tokensBefore };

  const summary = await summarizeMiddle(middle, previousSummary, signal);
  if (!summary) return { messages, compacted: false, tokensBefore };

  const next = [...head, makeSummaryMessage(summary), ...messages.slice(tailStart)];
  return {
    messages: next,
    compacted: true,
    tokensBefore,
    tokensAfter: estimateContextTokens(next).tokens,
  };
}
