// Background turns (scheduled heartbeats, inbound channel messages) have no live
// browser stream to receive NDJSON events. This sink captures the streamed
// assistant text and tool activity so the caller can act on the final result.

export interface TextSink {
  emit: (event: Record<string, unknown>) => void;
  getText: () => string;
  getToolNames: () => string[];
  getError: () => string | undefined;
}

export function createTextSink(): TextSink {
  let text = "";
  let error: string | undefined;
  const toolNames: string[] = [];
  return {
    emit(event) {
      if (event.type === "text_delta" && typeof event.delta === "string") {
        text += event.delta;
      } else if (event.type === "tool_start" && typeof event.name === "string") {
        toolNames.push(event.name);
      } else if (event.type === "error" && typeof event.message === "string") {
        error = event.message;
      }
    },
    getText: () => text.trim(),
    getToolNames: () => [...toolNames],
    getError: () => error,
  };
}
