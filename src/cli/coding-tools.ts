import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const MAX_OUTPUT = 24_000;

function clip(text: string): string {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} chars]`
    : text;
}

function shquote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: clip(text) }], details };
}

/**
 * Filesystem and shell tools that turn the companion into a real coding harness.
 * Every operation is scoped to the execution environment's working directory, so
 * when the harness runs inside its own repo it can read, edit, and rebuild itself.
 */
export function createCodingTools(env: NodeExecutionEnv): AgentTool[] {
  const readFile: AgentTool = {
    name: "read_file",
    label: "Read file",
    description: "Read a UTF-8 text file relative to the working directory. Optionally read a line range.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Number({ minimum: 1, description: "1-based first line to read." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 4000 })),
    }),
    async execute(_id, params) {
      const input = params as { path: string; offset?: number; limit?: number };
      const result = await env.readTextFile(input.path);
      if (!result.ok) throw new Error(`Cannot read ${input.path}: ${result.error.message}`);
      const lines = result.value.split("\n");
      const start = input.offset ? input.offset - 1 : 0;
      const end = input.limit ? start + input.limit : lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice
        .map((line, index) => `${String(start + index + 1).padStart(6)}|${line}`)
        .join("\n");
      return textResult(numbered || "(empty file)", { kind: "read_file", path: input.path, lines: slice.length });
    },
  };

  const writeFile: AgentTool = {
    name: "write_file",
    label: "Write file",
    description: "Create or overwrite a text file relative to the working directory (parent directories are created).",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const input = params as { path: string; content: string };
      const result = await env.writeFile(input.path, input.content);
      if (!result.ok) throw new Error(`Cannot write ${input.path}: ${result.error.message}`);
      const bytes = Buffer.byteLength(input.content, "utf8");
      return textResult(`Wrote ${bytes} bytes to ${input.path}.`, { kind: "write_file", path: input.path, bytes });
    },
  };

  const editFile: AgentTool = {
    name: "edit_file",
    label: "Edit file",
    description: "Replace an exact string in a file. old_string must be unique unless replace_all is true.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      old_string: Type.String({ minLength: 1 }),
      new_string: Type.String(),
      replace_all: Type.Optional(Type.Boolean()),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const input = params as { path: string; old_string: string; new_string: string; replace_all?: boolean };
      const read = await env.readTextFile(input.path);
      if (!read.ok) throw new Error(`Cannot read ${input.path}: ${read.error.message}`);
      const original = read.value;
      const occurrences = original.split(input.old_string).length - 1;
      if (occurrences === 0) throw new Error(`old_string was not found in ${input.path}.`);
      if (occurrences > 1 && !input.replace_all) {
        throw new Error(`old_string matched ${occurrences} times in ${input.path}. Provide more context or set replace_all.`);
      }
      const updated = input.replace_all
        ? original.split(input.old_string).join(input.new_string)
        : original.replace(input.old_string, input.new_string);
      const write = await env.writeFile(input.path, updated);
      if (!write.ok) throw new Error(`Cannot write ${input.path}: ${write.error.message}`);
      return textResult(`Edited ${input.path} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`, {
        kind: "edit_file",
        path: input.path,
        replacements: occurrences,
      });
    },
  };

  const listDir: AgentTool = {
    name: "list_dir",
    label: "List directory",
    description: "List the direct children of a directory relative to the working directory.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const input = params as { path?: string };
      const target = input.path?.trim() || ".";
      const result = await env.listDir(target);
      if (!result.ok) throw new Error(`Cannot list ${target}: ${result.error.message}`);
      const rows = result.value
        .slice()
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1))
        .map((entry) => `${entry.kind === "directory" ? "dir " : "file"}  ${entry.name}`)
        .join("\n");
      return textResult(rows || "(empty directory)", { kind: "list_dir", path: target, count: result.value.length });
    },
  };

  const searchCode: AgentTool = {
    name: "search_code",
    label: "Search code",
    description: "Search file contents with ripgrep. Returns matching lines with file paths and line numbers.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String({ description: "Optional file glob, e.g. *.ts" })),
    }),
    async execute(_id, params, signal) {
      const input = params as { pattern: string; path?: string; glob?: string };
      const parts = ["rg", "--line-number", "--no-heading", "--color", "never", "--max-count", "200"];
      if (input.glob) parts.push("--glob", shquote(input.glob));
      parts.push("--regexp", shquote(input.pattern));
      if (input.path) parts.push(shquote(input.path));
      const result = await env.exec(parts.join(" "), { timeout: 30, abortSignal: signal });
      if (!result.ok) throw new Error(`Search failed: ${result.error.message}`);
      const { stdout, exitCode } = result.value;
      if (exitCode === 1 && !stdout.trim()) return textResult("No matches found.", { kind: "search_code", matches: 0 });
      return textResult(stdout.trim() || "No matches found.", { kind: "search_code" });
    },
  };

  const runShell: AgentTool = {
    name: "run_shell",
    label: "Run shell command",
    description:
      "Run a shell command in the working directory (build, test, git, install, run scripts). Use for anything not covered by the file tools. Avoid destructive commands unless explicitly asked.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 900 })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = params as { command: string; timeout_seconds?: number };
      const result = await env.exec(input.command, {
        timeout: input.timeout_seconds ?? 180,
        abortSignal: signal,
      });
      if (!result.ok) throw new Error(`Command failed to run: ${result.error.message}`);
      const { stdout, stderr, exitCode } = result.value;
      const body = [
        stdout.trim() && `stdout:\n${stdout.trim()}`,
        stderr.trim() && `stderr:\n${stderr.trim()}`,
        `exit code: ${exitCode}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      return textResult(body, { kind: "run_shell", exitCode });
    },
  };

  return [readFile, writeFile, editFile, listDir, searchCode, runShell];
}
