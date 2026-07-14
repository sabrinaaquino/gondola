import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createUserAgentMessage, retainUnansweredUserMessage } from "./agent-context";

const assistantMessage: AgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Nice. What are you up to tonight?" }],
  api: "openai-completions",
  provider: "venice" as never,
  model: "conversation-history",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

test("retains the latest unanswered turn after a failed model attempt", () => {
  const question = createUserAgentMessage("When is the next Brazil game?", [], 2);
  const restored = retainUnansweredUserMessage([assistantMessage], question);

  assert.equal(restored.length, 2);
  assert.equal(restored[1], question);
  assert.equal(restored[0], assistantMessage);
});

test("does not duplicate an unanswered turn that is already retained", () => {
  const question = createUserAgentMessage("When is the next Brazil game?", [], 2);
  const restored = retainUnansweredUserMessage([assistantMessage, question], question);

  assert.equal(restored.length, 2);
});

test("preserves images with the unanswered user turn", () => {
  const image = { type: "image" as const, mimeType: "image/jpeg", data: "frame" };
  const question = createUserAgentMessage("What gesture am I making?", [image], 2);

  assert.equal(question.role, "user");
  if (question.role !== "user") throw new Error("Expected a user message");
  assert.ok(Array.isArray(question.content));
  assert.deepEqual(question.content, [{ type: "text", text: "What gesture am I making?" }, image]);
});
