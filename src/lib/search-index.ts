import path from "node:path";

// Cross-session recall backed by SQLite + FTS5.
//
// Hermes indexes every conversation message into an FTS5 table so the agent can
// retrieve details from old sessions by relevance (BM25) instead of the naive
// term-overlap scan the app shipped with. We use Node's built-in `node:sqlite`
// (no native build step). If it is unavailable for any reason, callers fall
// back to the previous keyword scan, so search never hard-fails.

const ROOT = path.join(process.cwd(), ".gondola");
const DB_FILE = path.join(ROOT, "index.db");

export interface IndexedMessage {
  id: string;
  sessionId: string;
  agentId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface IndexMatch {
  id: string;
  sessionId: string;
  agentId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

interface SqliteStatement {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
}

const globalCache = globalThis as typeof globalThis & {
  __novaSearchDb?: SqliteDatabase | null;
  __novaSearchInit?: Promise<SqliteDatabase | null>;
};

async function openDatabase(): Promise<SqliteDatabase | null> {
  if (globalCache.__novaSearchDb !== undefined) return globalCache.__novaSearchDb;
  if (!globalCache.__novaSearchInit) {
    globalCache.__novaSearchInit = (async () => {
      try {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(ROOT, { recursive: true });
        const sqlite = (await import("node:sqlite")) as unknown as {
          DatabaseSync: new (file: string) => SqliteDatabase;
        };
        const db = new sqlite.DatabaseSync(DB_FILE);
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            msg_id UNINDEXED,
            session_id UNINDEXED,
            agent_id UNINDEXED,
            role UNINDEXED,
            created_at UNINDEXED,
            text,
            tokenize = 'porter unicode61'
          );`,
        );
        globalCache.__novaSearchDb = db;
        return db;
      } catch {
        // node:sqlite missing, FTS5 unavailable, or filesystem issue.
        globalCache.__novaSearchDb = null;
        return null;
      }
    })();
  }
  return globalCache.__novaSearchInit;
}

export async function isSearchIndexAvailable(): Promise<boolean> {
  return (await openDatabase()) !== null;
}

export async function indexMessage(message: IndexedMessage): Promise<void> {
  const db = await openDatabase();
  if (!db || !message.text.trim()) return;
  try {
    const exists = db
      .prepare("SELECT 1 FROM messages_fts WHERE msg_id = ? LIMIT 1")
      .get(message.id);
    if (exists) return;
    db.prepare(
      "INSERT INTO messages_fts (msg_id, session_id, agent_id, role, created_at, text) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(message.id, message.sessionId, message.agentId, message.role, message.createdAt, message.text);
  } catch {
    // Best-effort indexing; recall degrades gracefully to keyword scan.
  }
}

export async function indexMessages(messages: IndexedMessage[]): Promise<void> {
  for (const message of messages) await indexMessage(message);
}

export async function removeSessionFromIndex(sessionId: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    db.prepare("DELETE FROM messages_fts WHERE session_id = ?").run(sessionId);
  } catch {
    // ignore
  }
}

// Build a safe FTS5 MATCH expression: quote each term to neutralise FTS
// operators, and OR them so partial matches still rank.
function toMatchQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 24)
    .map((term) => `"${term.replace(/"/g, "")}"`);
  return terms.join(" OR ");
}

export async function searchIndex(
  query: string,
  limit = 5,
  agentId?: string,
): Promise<IndexMatch[] | undefined> {
  const db = await openDatabase();
  if (!db) return undefined;
  const match = toMatchQuery(query);
  if (!match) return [];
  const capped = Math.max(1, Math.min(limit, 10));
  try {
    const rows = db
      .prepare(
        `SELECT msg_id, session_id, agent_id, role, created_at, text
         FROM messages_fts
         WHERE messages_fts MATCH ?${agentId ? " AND agent_id = ?" : ""}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...(agentId ? [match, agentId, capped] : [match, capped]));
    return rows.map((row) => ({
      id: String(row.msg_id ?? ""),
      sessionId: String(row.session_id ?? ""),
      agentId: String(row.agent_id ?? ""),
      role: row.role === "assistant" ? "assistant" : "user",
      text: String(row.text ?? ""),
      createdAt: Number(row.created_at ?? 0),
    }));
  } catch {
    return undefined;
  }
}
