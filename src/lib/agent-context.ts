import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Build the exact user message that belongs in the durable agent transcript. */
export function createUserAgentMessage(
  text: string,
  images: ImageContent[] = [],
  timestamp = Date.now(),
): AgentMessage {
  return {
    role: "user",
    content: images.length ? [{ type: "text", text }, ...images] : text,
    timestamp,
  };
}

/**
 * Keep a failed or interrupted user turn available for the next request.
 * The agent runtime rolls failed attempts back before trying a fallback model,
 * so this restores only the user's unanswered message without retaining an
 * error completion or replayable tool calls.
 */
export function retainUnansweredUserMessage(
  messages: AgentMessage[],
  userMessage: AgentMessage,
): AgentMessage[] {
  if (userMessage.role !== "user") return messages;
  const lastMessage = messages.at(-1);
  if (
    lastMessage?.role === "user"
    && JSON.stringify(lastMessage.content) === JSON.stringify(userMessage.content)
  ) {
    return messages;
  }
  return [...messages, userMessage];
}
