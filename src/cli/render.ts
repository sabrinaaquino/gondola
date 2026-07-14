import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { theme } from "./theme";

const PREVIEW_LIMIT = 120;

function preview(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  return firstLine.length > PREVIEW_LIMIT ? `${firstLine.slice(0, PREVIEW_LIMIT - 1)}…` : firstLine;
}

function toolArgsPreview(args: unknown): string {
  try {
    const text = JSON.stringify(args);
    if (!text || text === "{}") return "";
    return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT - 1)}…` : text;
  } catch {
    return "";
  }
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  return content?.map((part) => (part.type === "text" ? part.text ?? "" : "")).join(" ").trim() ?? "";
}

/**
 * The harness's presentation layer. It owns everything printed to stdout for a
 * turn, including streamed assistant text, tool activity, and errors, and tracks the
 * per-turn signals the turn runner needs (whether any text was produced and the
 * last model error) so that orchestration logic stays free of I/O concerns.
 */
export class HarnessRenderer {
  /** True once the current attempt has streamed any assistant text. */
  sawText = false;
  /** Error message from the current attempt, if the model failed. */
  lastError = "";
  private midLine = false;

  constructor(agent: Agent) {
    agent.subscribe((event) => this.onEvent(event));
  }

  /** Reset per-attempt state before a prompt attempt. */
  beginAttempt(): void {
    this.sawText = false;
    this.lastError = "";
  }

  /** Ensure any in-progress assistant line is terminated with a newline. */
  flush(): void {
    if (this.midLine) {
      this.write("\n");
      this.midLine = false;
    }
  }

  write(text: string): void {
    process.stdout.write(text);
  }

  error(message: string): void {
    this.flush();
    this.write(theme.red(`  ✗ ${message}\n`));
  }

  notice(message: string): void {
    this.flush();
    this.write(theme.yellow(`  ${message}\n`));
  }

  info(message: string): void {
    this.write(theme.dim(`  ${message}\n`));
  }

  private onEvent(event: AgentEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!this.midLine) this.write(theme.bold(theme.green("● ")));
      this.write(event.assistantMessageEvent.delta);
      this.midLine = true;
      this.sawText = true;
    } else if (event.type === "tool_execution_start") {
      this.flush();
      const args = toolArgsPreview(event.args);
      this.write(theme.dim(`  ⚙ ${event.toolName}${args ? ` ${args}` : ""}\n`));
    } else if (event.type === "tool_execution_end") {
      const summary = preview(resultText(event.result));
      const mark = event.isError ? theme.red("  ✗") : theme.dim("  ✓");
      this.write(`${mark} ${theme.dim(summary)}\n`);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      this.flush();
      if (event.message.stopReason === "error") {
        this.lastError = event.message.errorMessage ?? "The Venice model returned an error.";
      }
    }
  }
}
