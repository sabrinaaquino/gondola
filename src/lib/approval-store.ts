import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Durable approval ledger + session grants. Destructive actions (delete, move,
// overwrite, run a command) still require the owner's approval, but instead of a
// stateless `confirmed` flag this records an auditable trail (who tried what,
// what was decided) and supports owner-granted, session-scoped auto-approval so
// a long task doesn't re-prompt for the same tool. This is the governed
// human-in-the-loop boundary the constitution calls for: the agent may act, but
// approval is owned by the human, recorded, and inspectable via the runtime.

const ROOT = path.join(process.cwd(), ".gondola");
const FILE = path.join(ROOT, "approvals.json");
const MAX_RECORDS = 300;

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalScope = "once" | "session";
export type ToolRisk = "low" | "medium" | "high";

// Declarative source of truth for which tools are destructive and their risk.
// The gate enforces approval; this makes the guarded set explicit, exposes it to
// the owner (what can be granted for a session) and the runtime, and tags the
// audit trail with a risk level.
export const GUARDED_TOOLS: Record<string, ToolRisk> = {
  delete_path: "high",
  run_command: "high",
  write_file: "medium",
  move_path: "medium",
};

export function toolRisk(tool: string): ToolRisk | undefined {
  return GUARDED_TOOLS[tool];
}

export function guardedToolList(): { tool: string; risk: ToolRisk }[] {
  return Object.entries(GUARDED_TOOLS).map(([tool, risk]) => ({ tool, risk }));
}

export interface ApprovalRecord {
  id: string;
  conversationId: string;
  tool: string;
  summary: string;
  status: ApprovalStatus;
  scope: ApprovalScope;
  risk?: ToolRisk;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface SessionGrant {
  conversationId: string;
  tool: string;
  grantedAt: string;
  grantedBy: string;
}

interface ApprovalStore {
  version: 1;
  records: ApprovalRecord[];
  grants: SessionGrant[];
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function read(): Promise<ApprovalStore> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Partial<ApprovalStore>;
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records : [],
      grants: Array.isArray(parsed.grants) ? parsed.grants : [],
    };
  } catch {
    return { version: 1, records: [], grants: [] };
  }
}

async function write(store: ApprovalStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  if (store.records.length > MAX_RECORDS) store.records = store.records.slice(-MAX_RECORDS);
  const temporary = `${FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, FILE);
}

/** Pure: is there a live session grant for this tool in this conversation? */
export function hasSessionGrant(grants: SessionGrant[], conversationId: string, tool: string): boolean {
  return grants.some((grant) => grant.conversationId === conversationId && grant.tool === tool);
}

/** Whether a destructive action should be auto-approved (owner granted the tool for the session). */
export async function isToolAutoApproved(conversationId: string, tool: string): Promise<boolean> {
  const store = await read();
  return hasSessionGrant(store.grants, conversationId, tool);
}

/** Record a pending approval request (destructive action awaiting the owner). */
export async function recordApprovalRequest(input: { conversationId: string; tool: string; summary: string }): Promise<ApprovalRecord> {
  const now = new Date().toISOString();
  const record: ApprovalRecord = {
    id: crypto.randomUUID(),
    conversationId: input.conversationId,
    tool: input.tool,
    summary: input.summary.slice(0, 300),
    status: "pending",
    scope: "once",
    risk: toolRisk(input.tool),
    createdAt: now,
  };
  return serial(async () => {
    const store = await read();
    store.records.push(record);
    await write(store);
    return record;
  });
}

/** Record an already-decided action (e.g. the owner confirmed inline) for the audit trail. */
export async function recordApprovalDecision(input: { conversationId: string; tool: string; summary: string; status: Exclude<ApprovalStatus, "pending">; decidedBy?: string }): Promise<ApprovalRecord> {
  const now = new Date().toISOString();
  const record: ApprovalRecord = {
    id: crypto.randomUUID(),
    conversationId: input.conversationId,
    tool: input.tool,
    summary: input.summary.slice(0, 300),
    status: input.status,
    scope: "once",
    risk: toolRisk(input.tool),
    createdAt: now,
    decidedAt: now,
    decidedBy: input.decidedBy ?? "owner",
  };
  return serial(async () => {
    const store = await read();
    store.records.push(record);
    await write(store);
    return record;
  });
}

/** Resolve a pending request by id. */
export async function resolveApprovalRequest(id: string, status: Exclude<ApprovalStatus, "pending">, decidedBy = "owner"): Promise<ApprovalRecord | undefined> {
  return serial(async () => {
    const store = await read();
    const record = store.records.find((entry) => entry.id === id);
    if (!record) return undefined;
    record.status = status;
    record.decidedAt = new Date().toISOString();
    record.decidedBy = decidedBy;
    await write(store);
    return record;
  });
}

/** Owner grants session-scoped auto-approval for a tool in a conversation. */
export async function grantSession(input: { conversationId: string; tool: string; grantedBy?: string }): Promise<SessionGrant> {
  const grant: SessionGrant = {
    conversationId: input.conversationId,
    tool: input.tool,
    grantedAt: new Date().toISOString(),
    grantedBy: input.grantedBy ?? "owner",
  };
  return serial(async () => {
    const store = await read();
    if (!hasSessionGrant(store.grants, grant.conversationId, grant.tool)) {
      store.grants.push(grant);
      await write(store);
    }
    return grant;
  });
}

export async function revokeSession(conversationId: string, tool: string): Promise<boolean> {
  return serial(async () => {
    const store = await read();
    const before = store.grants.length;
    store.grants = store.grants.filter((grant) => !(grant.conversationId === conversationId && grant.tool === tool));
    if (store.grants.length === before) return false;
    await write(store);
    return true;
  });
}

export async function listApprovals(options?: { conversationId?: string; status?: ApprovalStatus; limit?: number }): Promise<ApprovalRecord[]> {
  const store = await read();
  let records = store.records;
  if (options?.conversationId) records = records.filter((record) => record.conversationId === options.conversationId);
  if (options?.status) records = records.filter((record) => record.status === options.status);
  const sorted = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return options?.limit ? sorted.slice(0, options.limit) : sorted;
}

export async function listGrants(conversationId?: string): Promise<SessionGrant[]> {
  const store = await read();
  return conversationId ? store.grants.filter((grant) => grant.conversationId === conversationId) : store.grants;
}
