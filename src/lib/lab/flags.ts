import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Durable log of problems the acting agent flags via propose_harness_change.
//
// Previously a flag that did not produce a bounded proposal was silently
// dropped: nothing was persisted, so a failure could recur many times and the
// Lab kept no memory of it and the owner saw nothing. This store records EVERY
// flag, coalesces repeats of the same problem into a running count, and stays
// visible until it is addressed - so recurring failures actually surface.

function labRoot(): string {
  return process.env.GONDOLA_LAB_ROOT?.trim() || path.join(process.cwd(), ".gondola", "lab");
}
function flagsFile(): string {
  return path.join(labRoot(), "flags.json");
}

const MAX_FLAGS = 200;

export interface HarnessFlag {
  id: string;
  /** A representative reason (the first time this problem was flagged). */
  reason: string;
  /** How many times this problem has been flagged. */
  count: number;
  status: "open" | "addressed";
  /** Conversations this problem was flagged from. */
  conversationIds: string[];
  /** Whether any flag of this problem led the Lab to draft a proposal. */
  proposalDrafted: boolean;
  firstFlaggedAt: string;
  lastFlaggedAt: string;
}

interface FlagStore {
  version: 1;
  flags: HarnessFlag[];
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function read(): Promise<FlagStore> {
  try {
    const parsed = JSON.parse(await readFile(flagsFile(), "utf8")) as Partial<FlagStore>;
    return { version: 1, flags: Array.isArray(parsed.flags) ? parsed.flags : [] };
  } catch {
    return { version: 1, flags: [] };
  }
}

async function write(store: FlagStore): Promise<void> {
  await mkdir(labRoot(), { recursive: true });
  if (store.flags.length > MAX_FLAGS) store.flags = store.flags.slice(-MAX_FLAGS);
  const temporary = `${flagsFile()}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, flagsFile());
}

/** A stable signature so repeats of the same problem coalesce into one entry. */
export function flagSignature(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export interface RecordFlagInput {
  reason: string;
  conversationId?: string;
  proposalDrafted?: boolean;
}

/**
 * Record a flagged problem. Coalesces repeats of the same problem (by signature)
 * into a running count so the Lab remembers that it keeps happening. Always
 * persists - a flag is never silently dropped.
 */
export async function recordFlag(input: RecordFlagInput): Promise<HarnessFlag> {
  const reason = input.reason.trim().slice(0, 600);
  const signature = flagSignature(reason);
  const now = new Date().toISOString();
  return serial(async () => {
    const store = await read();
    const existing = store.flags.find((flag) => flag.status === "open" && flagSignature(flag.reason) === signature);
    if (existing) {
      existing.count += 1;
      existing.lastFlaggedAt = now;
      existing.proposalDrafted = existing.proposalDrafted || Boolean(input.proposalDrafted);
      if (input.conversationId && !existing.conversationIds.includes(input.conversationId)) {
        existing.conversationIds.push(input.conversationId);
      }
      await write(store);
      return existing;
    }
    const flag: HarnessFlag = {
      id: crypto.randomUUID(),
      reason,
      count: 1,
      status: "open",
      conversationIds: input.conversationId ? [input.conversationId] : [],
      proposalDrafted: Boolean(input.proposalDrafted),
      firstFlaggedAt: now,
      lastFlaggedAt: now,
    };
    store.flags.push(flag);
    await write(store);
    return flag;
  });
}

/** List flags, newest activity first. */
export async function listFlags(options?: { status?: HarnessFlag["status"]; limit?: number }): Promise<HarnessFlag[]> {
  const store = await read();
  let flags = store.flags;
  if (options?.status) flags = flags.filter((flag) => flag.status === options.status);
  const sorted = [...flags].sort((a, b) => b.lastFlaggedAt.localeCompare(a.lastFlaggedAt));
  return options?.limit ? sorted.slice(0, options.limit) : sorted;
}

/** Mark a flag addressed (e.g. once a proposal targeting it is promoted). */
export async function resolveFlag(id: string): Promise<boolean> {
  return serial(async () => {
    const store = await read();
    const flag = store.flags.find((entry) => entry.id === id);
    if (!flag) return false;
    flag.status = "addressed";
    await write(store);
    return true;
  });
}
