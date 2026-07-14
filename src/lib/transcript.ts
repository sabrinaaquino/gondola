import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// Durable, full-fidelity agent transcripts.
//
// The existing workspace store keeps a human-readable, text-only message log
// (used by the UI and search). That log is lossy: it drops tool calls, tool
// results, and assistant metadata, so a server restart forces the agent to
// replay a flattened text history and lose its true state.
//
// This module persists the complete `AgentMessage[]` transcript (tool calls,
// tool results, usage, stop reasons, compaction summaries) as JSONL, one
// message per line, mirroring how OpenClaw and the Pi harness record sessions.
// On restart the agent is rehydrated from this file with no loss of fidelity.

const ROOT = path.join(process.cwd(), ".gondola");
const TRANSCRIPT_DIR = path.join(ROOT, "transcripts");

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function transcriptPath(sessionId: string): string {
  return path.join(TRANSCRIPT_DIR, `${safeId(sessionId)}.jsonl`);
}

async function ensureDir(): Promise<void> {
  await mkdir(TRANSCRIPT_DIR, { recursive: true });
}

// Serialize per-session writes so overlapping turns never interleave a
// full-file rewrite (compaction mutates history, so we always rewrite).
const writeQueues = new Map<string, Promise<unknown>>();

function serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(sessionId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  writeQueues.set(sessionId, tail);
  void tail.then(() => {
    if (writeQueues.get(sessionId) === tail) writeQueues.delete(sessionId);
  });
  return result;
}

export async function loadTranscript(sessionId: string): Promise<AgentMessage[]> {
  try {
    const raw = await readFile(transcriptPath(sessionId), "utf8");
    const messages: AgentMessage[] = [];
    const lines = raw.split("\n");
    const lastContentLine = lines.findLastIndex((line) => line.trim().length > 0);
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as AgentMessage);
      } catch (error) {
        // A process interruption can leave only the final JSONL record torn.
        // Earlier corruption must be surfaced so a later save cannot erase it.
        if (index !== lastContentLine) throw error;
      }
    }
    return messages;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function hasTranscript(sessionId: string): Promise<boolean> {
  try {
    await readFile(transcriptPath(sessionId), "utf8");
    return true;
  } catch {
    return false;
  }
}

// Rewrite the whole transcript atomically. Full rewrite (rather than append)
// keeps the file correct after compaction rewrites earlier history.
export async function saveTranscript(sessionId: string, messages: AgentMessage[]): Promise<void> {
  return serialize(sessionId, async () => {
    await ensureDir();
    const target = transcriptPath(sessionId);
    const temporary = `${target}.${process.pid}.tmp`;
    const body = messages.map((message) => JSON.stringify(message)).join("\n");
    await writeFile(temporary, messages.length ? `${body}\n` : "", "utf8");
    await rename(temporary, target);
  });
}

export async function deleteTranscript(sessionId: string): Promise<void> {
  return serialize(sessionId, async () => {
    await unlink(transcriptPath(sessionId)).catch(() => undefined);
  });
}
