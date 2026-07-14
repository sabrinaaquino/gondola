import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dot } from "./embeddings";

// Local, in-process vector store for conversation embeddings.
//
// This is the "Qdrant Edge"-style piece: on-device vector search with no server
// and no network. It keeps the index in memory and persists it to a JSON file,
// searched with brute-force cosine (instant for a single user's conversation
// set). We deliberately avoid the experimental `node:sqlite` here because it can
// silently no-op inside the Next.js server runtime, which would make semantic
// search fall back to keywords. A plain JSON file is bulletproof at this scale.
//
// Granularity mirrors Cursor's codebase index: the unit of embedding and
// retrieval is a *chunk* (a small window of a conversation), not the whole
// conversation. A conversation is split into many chunks; each chunk gets its
// own vector plus a content hash. This keeps a proper noun mentioned once
// mid-conversation from being averaged away in a single blended vector. The
// chunk that contains it scores on its own. Two dedup layers, like Cursor:
//   1. conversation `signature` (updatedAt|messageCount) gates whether a
//      conversation is re-chunked at all, and
//   2. per-chunk content hashes let unchanged windows reuse their existing
//      vector so only new/edited windows are re-embedded.

const ROOT = path.join(process.cwd(), ".gondola");
const FILE = path.join(ROOT, "vectors.json");
const SCHEMA_VERSION = 2;

// A single embedded chunk (a window of one conversation).
export interface ChunkRecord {
  chunkIndex: number;
  // sha256 of the normalized embed text; identical windows share a hash so their
  // vector can be reused instead of re-embedded.
  hash: string;
  vector: number[];
  // Lowercased chunk text, kept for lexical (exact keyword / proper-noun)
  // matching that embeddings alone recall poorly.
  text: string;
}

// One nearest-neighbor hit, at chunk granularity (callers group by conversation).
export interface ChunkMatch {
  conversationId: string;
  agentId: string;
  chunkIndex: number;
  score: number;
}

interface StoredChunk extends ChunkRecord {
  conversationId: string;
  agentId: string;
}

interface StoredConversationMeta {
  agentId: string;
  signature: string;
}

interface VectorStoreState {
  loaded: boolean;
  // key: `${conversationId}#${chunkIndex}`
  chunks: Map<string, StoredChunk>;
  conversations: Map<string, StoredConversationMeta>;
  writeQueue: Promise<unknown>;
}

// Bumped alongside SCHEMA_VERSION so a hot-reloaded dev server doesn't reuse an
// in-memory state object shaped for the old (conversation-keyed) index.
const globalCache = globalThis as typeof globalThis & {
  __novaVectorStateV2?: VectorStoreState;
};

const state: VectorStoreState = globalCache.__novaVectorStateV2 ?? {
  loaded: false,
  chunks: new Map<string, StoredChunk>(),
  conversations: new Map<string, StoredConversationMeta>(),
  writeQueue: Promise.resolve(),
};
globalCache.__novaVectorStateV2 = state;

function chunkKey(conversationId: string, chunkIndex: number): string {
  return `${conversationId}#${chunkIndex}`;
}

async function ensureLoaded(): Promise<void> {
  if (state.loaded) return;
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as {
      version?: number;
      chunks?: Record<string, Partial<StoredChunk>>;
      conversations?: Record<string, Partial<StoredConversationMeta>>;
    };
    // Anything written by an older (conversation-keyed) build is silently
    // dropped; the next search re-indexes it into the new chunked format.
    if (parsed.version === SCHEMA_VERSION) {
      for (const [key, entry] of Object.entries(parsed.chunks ?? {})) {
        if (!Array.isArray(entry?.vector) || !entry.vector.length) continue;
        state.chunks.set(key, {
          conversationId: String(entry.conversationId ?? ""),
          agentId: String(entry.agentId ?? ""),
          chunkIndex: Number(entry.chunkIndex ?? 0),
          hash: String(entry.hash ?? ""),
          vector: entry.vector,
          text: typeof entry.text === "string" ? entry.text : "",
        });
      }
      for (const [id, meta] of Object.entries(parsed.conversations ?? {})) {
        state.conversations.set(id, {
          agentId: String(meta?.agentId ?? ""),
          signature: String(meta?.signature ?? ""),
        });
      }
    }
  } catch {
    // No file yet (first run) or unreadable, so start empty.
  }
  state.loaded = true;
}

function persist(): void {
  // Serialize writes; snapshot the current maps so concurrent upserts don't
  // corrupt the file mid-write.
  state.writeQueue = state.writeQueue.then(async () => {
    const chunks: Record<string, StoredChunk> = {};
    for (const [key, entry] of state.chunks) chunks[key] = entry;
    const conversations: Record<string, StoredConversationMeta> = {};
    for (const [id, meta] of state.conversations) conversations[id] = meta;
    await mkdir(ROOT, { recursive: true });
    const temporary = `${FILE}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: SCHEMA_VERSION, conversations, chunks })}\n`, "utf8");
    await rename(temporary, FILE);
  }).catch(() => undefined);
}

// Freshness signatures so callers can skip re-chunking unchanged conversations.
export async function getConversationSignatures(): Promise<Map<string, string>> {
  await ensureLoaded();
  const map = new Map<string, string>();
  for (const [id, meta] of state.conversations) map.set(id, meta.signature);
  return map;
}

// hash -> vector for one conversation's existing chunks, so a re-index can reuse
// the vectors of windows whose content didn't change (the per-chunk cache).
export async function getConversationChunkHashes(conversationId: string): Promise<Map<string, number[]>> {
  await ensureLoaded();
  const map = new Map<string, number[]>();
  for (const entry of state.chunks.values()) {
    if (entry.conversationId === conversationId && entry.hash) map.set(entry.hash, entry.vector);
  }
  return map;
}

// Atomically swap in the full set of chunks for one conversation (removing any
// stale windows) and record its freshness signature.
export async function replaceConversation(
  conversationId: string,
  agentId: string,
  signature: string,
  chunks: ChunkRecord[],
): Promise<void> {
  await ensureLoaded();
  for (const key of [...state.chunks.keys()]) {
    if (state.chunks.get(key)?.conversationId === conversationId) state.chunks.delete(key);
  }
  for (const chunk of chunks) {
    if (!chunk.vector.length) continue;
    state.chunks.set(chunkKey(conversationId, chunk.chunkIndex), {
      conversationId,
      agentId,
      chunkIndex: chunk.chunkIndex,
      hash: chunk.hash,
      vector: chunk.vector,
      text: chunk.text,
    });
  }
  state.conversations.set(conversationId, { agentId, signature });
  persist();
}

// Drop a conversation and all its chunks from the index (deleted-file analog).
export async function removeConversationVectors(conversationId: string): Promise<void> {
  await ensureLoaded();
  let changed = state.conversations.delete(conversationId);
  for (const key of [...state.chunks.keys()]) {
    if (state.chunks.get(key)?.conversationId === conversationId) {
      state.chunks.delete(key);
      changed = true;
    }
  }
  if (changed) persist();
}

// Lowercased full-text blob per conversation (its chunk texts concatenated), for
// lexical keyword matching. Reconstructed from chunks so a name said anywhere in
// a long chat is still findable.
export async function getLexicalByConversation(agentId?: string): Promise<Map<string, string>> {
  await ensureLoaded();
  const parts = new Map<string, Array<{ index: number; text: string }>>();
  for (const entry of state.chunks.values()) {
    if (agentId && entry.agentId !== agentId) continue;
    if (!entry.text) continue;
    const list = parts.get(entry.conversationId) ?? [];
    list.push({ index: entry.chunkIndex, text: entry.text });
    parts.set(entry.conversationId, list);
  }
  const map = new Map<string, string>();
  for (const [id, list] of parts) {
    list.sort((a, b) => a.index - b.index);
    map.set(id, list.map((item) => item.text).join("\n"));
  }
  return map;
}

// Brute-force cosine search over every stored chunk (vectors are normalized, so
// cosine reduces to a dot product). Returns per-chunk hits; callers aggregate to
// the conversation level (typically by best chunk score).
export async function searchChunks(query: number[], limit: number, agentId?: string): Promise<ChunkMatch[]> {
  await ensureLoaded();
  const scored: ChunkMatch[] = [];
  for (const entry of state.chunks.values()) {
    if (agentId && entry.agentId !== agentId) continue;
    if (!entry.vector.length) continue;
    scored.push({
      conversationId: entry.conversationId,
      agentId: entry.agentId,
      chunkIndex: entry.chunkIndex,
      score: dot(query, entry.vector),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}

/** Number of chunks currently indexed (diagnostics). */
export async function chunkCount(): Promise<number> {
  await ensureLoaded();
  return state.chunks.size;
}

/** Number of conversations currently indexed (diagnostics). */
export async function indexedConversationCount(): Promise<number> {
  await ensureLoaded();
  return state.conversations.size;
}
