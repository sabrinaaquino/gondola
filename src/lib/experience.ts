import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Lightweight experience log, the raw material for self-improvement.
//
// After each successful, tool-using turn we record what the user asked and
// which tools the agent used. The skill distiller later clusters these to spot
// recurring workflows worth turning into a reusable SKILL.md. It stores only
// the user's phrasing + tool names (no assistant output), capped in size.

const ROOT = path.join(process.cwd(), ".gondola");
const FILE = path.join(ROOT, "experience.json");
const MAX_RECORDS = 500;

export interface ExperienceRecord {
  id: string;
  agentId: string;
  conversationId: string;
  message: string;
  tools: string[];
  at: number;
}

interface ExperienceStore {
  version: 1;
  records: ExperienceRecord[];
}

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function read(): Promise<ExperienceStore> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Partial<ExperienceStore>;
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch {
    return { version: 1, records: [] };
  }
}

export async function appendExperience(input: {
  agentId: string;
  conversationId: string;
  message: string;
  tools: string[];
}): Promise<void> {
  const message = input.message.replace(/\s+/g, " ").trim().slice(0, 600);
  if (message.length < 8) return;
  return serial(async () => {
    await mkdir(ROOT, { recursive: true });
    const store = await read();
    store.records.push({
      id: crypto.randomUUID(),
      agentId: input.agentId,
      conversationId: input.conversationId,
      message,
      tools: [...new Set(input.tools)].slice(0, 16),
      at: Date.now(),
    });
    if (store.records.length > MAX_RECORDS) store.records = store.records.slice(-MAX_RECORDS);
    const temporary = `${FILE}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporary, FILE);
  });
}

export async function readExperience(agentId?: string): Promise<ExperienceRecord[]> {
  const store = await read();
  return agentId ? store.records.filter((record) => record.agentId === agentId) : store.records;
}
