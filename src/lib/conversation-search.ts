import { createHash } from "node:crypto";
import type { ConversationSummary, WorkspaceMessage } from "./app-types";
import { embedText, embedTexts } from "./embeddings";
import { getConversation, getWorkspaceSnapshot } from "./workspace";
import {
  chunkCount,
  getConversationChunkHashes,
  getConversationSignatures,
  getLexicalByConversation,
  indexedConversationCount,
  removeConversationVectors,
  replaceConversation,
  searchChunks,
  type ChunkRecord,
} from "./vector-store";

// Hybrid conversation search, indexed the way Cursor indexes a codebase: the
// unit of embedding and retrieval is a *chunk* (a small window of a
// conversation), not the whole conversation. Each conversation is split into
// many chunks; every chunk is (a) embedded with Venice for semantic recall and
// (b) kept as a lowercased text blob for lexical recall. At query time we take
// each conversation's *best* chunk score, so a proper noun mentioned once
// mid-conversation ("Alfredo") surfaces on the strength of the single chunk that
// contains it instead of being averaged into a blended conversation vector.
// Meaning-based queries ("my dog") and exact names both work: cosine drives the
// former, lexical coverage rescues the latter (embeddings recall rare tokens
// poorly). Re-indexing is incremental. Unchanged windows reuse their vector via
// a content hash, so only new/edited windows are re-embedded.

const MAX_REINDEX_PER_SEARCH = 60;
// Chunk windows: a handful of consecutive turns, bounded by characters so a
// single long message still forms its own chunk. Small enough that one mention
// dominates its chunk's vector; large enough to stay cheap to embed.
const CHUNK_MAX_MESSAGES = 3;
const CHUNK_MAX_CHARS = 700;
// Per-chunk lexical text kept for keyword matching (a name said anywhere).
const CHUNK_LEXICAL_CHARS = 1_200;
// Blend weights: semantic score is raw cosine of the best matching chunk; a full
// lexical match adds enough to decisively outrank a purely-topical near-miss.
const LEXICAL_COVERAGE_WEIGHT = 0.6;
const LEXICAL_PHRASE_BONUS = 0.25;
const TITLE_MATCH_BONUS = 0.06;

export interface ConversationSearchHit {
  conversationId: string;
  agentId: string;
  title: string;
  snippet: string;
  updatedAt: string;
  score: number;
}

interface ConversationChunk {
  chunkIndex: number;
  embedInput: string;
  lexical: string;
  hash: string;
}

// Changes whenever the conversation gains messages, gating a re-chunk.
function signatureFor(summary: ConversationSummary): string {
  return `${summary.updatedAt}|${summary.messageCount}`;
}

function roleLabel(message: WorkspaceMessage): string {
  return message.role === "assistant" ? "Assistant" : "User";
}

// Split a conversation into small, self-contained windows on turn boundaries.
// The title rides along with the first chunk only (so later chunks stay clean
// and a rare token in one of them isn't diluted by the title's tokens).
function chunkConversation(summary: ConversationSummary, messages: WorkspaceMessage[]): ConversationChunk[] {
  const meaningful = messages.filter((message) => message.text.trim());
  const chunks: ConversationChunk[] = [];
  let window: WorkspaceMessage[] = [];
  let windowChars = 0;

  const flush = () => {
    if (!window.length) return;
    const chunkIndex = chunks.length;
    const body = window
      .map((message) => `${roleLabel(message)}: ${message.text.replace(/\s+/g, " ").trim()}`)
      .join("\n");
    const embedInput = (chunkIndex === 0 ? `${summary.title}\n${body}` : body).trim();
    const lexical = window
      .map((message) => message.text.replace(/\s+/g, " ").trim())
      .join("\n")
      .slice(0, CHUNK_LEXICAL_CHARS)
      .toLowerCase();
    chunks.push({
      chunkIndex,
      embedInput,
      lexical,
      hash: createHash("sha256").update(embedInput).digest("hex"),
    });
    window = [];
    windowChars = 0;
  };

  for (const message of meaningful) {
    const length = message.text.length;
    if (window.length && (window.length >= CHUNK_MAX_MESSAGES || windowChars + length > CHUNK_MAX_CHARS)) {
      flush();
    }
    window.push(message);
    windowChars += length;
  }
  flush();

  // A conversation with a title but no messages still gets a title-only chunk so
  // it's findable by title before anyone has replied.
  if (!chunks.length && summary.title.trim()) {
    const embedInput = summary.title.trim();
    chunks.push({
      chunkIndex: 0,
      embedInput,
      lexical: summary.title.trim().toLowerCase(),
      hash: createHash("sha256").update(embedInput).digest("hex"),
    });
  }
  return chunks;
}

// Lexical relevance in [0, LEXICAL_COVERAGE_WEIGHT + LEXICAL_PHRASE_BONUS]:
// fraction of query terms present, plus a bonus when the whole query appears
// verbatim. Returns 0 when nothing matches so it never penalizes semantic hits.
function lexicalScore(terms: string[], phrase: string, text: string): number {
  if (!text || !terms.length) return 0;
  let matched = 0;
  for (const term of terms) if (text.includes(term)) matched += 1;
  if (!matched) return 0;
  const coverage = (matched / terms.length) * LEXICAL_COVERAGE_WEIGHT;
  const phraseBonus = phrase.length > 1 && text.includes(phrase) ? LEXICAL_PHRASE_BONUS : 0;
  return coverage + phraseBonus;
}

function queryTerms(lowerQuery: string): string[] {
  return lowerQuery.split(/\W+/).filter((term) => term.length > 1);
}

function lexicalTextFor(conversation: ConversationSummary, lexicalById: Map<string, string>): string {
  return lexicalById.get(conversation.id) ?? `${conversation.title}\n${conversation.lastMessage}`.toLowerCase();
}

// Re-chunk + re-embed conversations whose content changed since we last indexed
// them. Windows whose content hash is unchanged reuse their existing vector, so
// a new message only costs the embedding of the tail chunk it lands in.
async function reindexStale(conversations: ConversationSummary[], limit = MAX_REINDEX_PER_SEARCH): Promise<void> {
  const signatures = await getConversationSignatures();
  const stale = conversations
    .filter((conversation) => conversation.messageCount > 0 && signatures.get(conversation.id) !== signatureFor(conversation))
    .slice(0, limit);
  if (!stale.length) return;

  interface Plan {
    summary: ConversationSummary;
    chunks: Array<{ chunkIndex: number; hash: string; lexical: string; vector?: number[] }>;
  }
  const plans: Plan[] = [];
  const toEmbed: Array<{ planIndex: number; chunkPos: number; text: string }> = [];

  for (const summary of stale) {
    const conversation = await getConversation(summary.id).catch(() => undefined);
    if (!conversation) continue;
    const chunks = chunkConversation(summary, conversation.messages);
    if (!chunks.length) continue;
    const reuse = await getConversationChunkHashes(summary.id);
    const planChunks = chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      hash: chunk.hash,
      lexical: chunk.lexical,
      vector: reuse.get(chunk.hash),
    }));
    const planIndex = plans.length;
    plans.push({ summary, chunks: planChunks });
    chunks.forEach((chunk, position) => {
      if (!planChunks[position].vector) toEmbed.push({ planIndex, chunkPos: position, text: chunk.embedInput });
    });
  }

  if (toEmbed.length) {
    const vectors = await embedTexts(toEmbed.map((item) => item.text));
    toEmbed.forEach((item, index) => {
      plans[item.planIndex].chunks[item.chunkPos].vector = vectors[index];
    });
  }

  let embeddedChunks = 0;
  for (const plan of plans) {
    const records: ChunkRecord[] = plan.chunks
      .filter((chunk) => chunk.vector && chunk.vector.length)
      .map((chunk) => ({ chunkIndex: chunk.chunkIndex, hash: chunk.hash, vector: chunk.vector as number[], text: chunk.lexical }));
    if (!records.length) continue;
    embeddedChunks += records.length;
    await replaceConversation(plan.summary.id, plan.summary.agentId, signatureFor(plan.summary), records);
  }
  console.log(`[conv-search] indexed ${plans.length} conversation(s), ${embeddedChunks} chunk(s) (${toEmbed.length} newly embedded)`);
}

// No-embeddings fallback: rank purely by lexical match over the stored full-text
// index (falling back to title + last message for anything not yet indexed).
function keywordFallback(
  query: string,
  conversations: ConversationSummary[],
  lexicalById: Map<string, string>,
  limit: number,
): ConversationSearchHit[] {
  const lowerQuery = query.toLowerCase();
  const terms = queryTerms(lowerQuery);
  if (!terms.length) return [];
  return conversations
    .map((conversation) => ({
      conversation,
      score: lexicalScore(terms, lowerQuery, lexicalTextFor(conversation, lexicalById)),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.conversation.updatedAt.localeCompare(a.conversation.updatedAt))
    .slice(0, limit)
    .map(({ conversation, score }) => ({
      conversationId: conversation.id,
      agentId: conversation.agentId,
      title: conversation.title,
      snippet: conversation.lastMessage,
      updatedAt: conversation.updatedAt,
      score,
    }));
}

// For the handful of results we actually show, replace the snippet with the line
// that contains the query so the user sees why it matched. Bounded: only the
// returned hits are read from disk, never the whole index.
async function withMatchingSnippets(hits: ConversationSearchHit[], terms: string[]): Promise<ConversationSearchHit[]> {
  if (!terms.length) return hits;
  return Promise.all(hits.map(async (hit) => {
    const conversation = await getConversation(hit.conversationId).catch(() => undefined);
    const match = conversation?.messages.find((message) => {
      const lower = message.text.toLowerCase();
      return terms.some((term) => lower.includes(term));
    });
    if (!match) return hit;
    return { ...hit, snippet: match.text.replace(/\s+/g, " ").trim().slice(0, 160) };
  }));
}

export async function searchConversations(query: string, limit = 8, agentId?: string): Promise<{ hits: ConversationSearchHit[]; semantic: boolean }> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], semantic: false };
  const snapshot = await getWorkspaceSnapshot();
  const conversations = snapshot.conversations.filter((conversation) => !agentId || conversation.agentId === agentId);
  const lowerQuery = trimmed.toLowerCase();
  const terms = queryTerms(lowerQuery);

  try {
    await reindexStale(conversations);
    // Prune index entries for conversations that no longer exist.
    const liveIds = new Set(conversations.map((conversation) => conversation.id));
    for (const [id] of await getConversationSignatures()) {
      if (!liveIds.has(id)) await removeConversationVectors(id).catch(() => undefined);
    }

    const queryVector = await embedText(trimmed);
    // Pull a generous slice of chunk hits so each conversation's best chunk is
    // represented, then reduce to one semantic score per conversation (its max).
    const chunkMatches = await searchChunks(queryVector, Math.max(limit * 15, 150), agentId);
    const semanticById = new Map<string, number>();
    for (const match of chunkMatches) {
      const previous = semanticById.get(match.conversationId) ?? -Infinity;
      if (match.score > previous) semanticById.set(match.conversationId, match.score);
    }
    const lexicalById = await getLexicalByConversation(agentId);

    // Hybrid score: best-chunk cosine + full-text lexical coverage. Semantic wins
    // topical queries ("my dog"); lexical rescues exact names/rare tokens spoken
    // anywhere in the chat ("alfredo") that embeddings recall poorly.
    const scored: ConversationSearchHit[] = [];
    for (const conversation of conversations) {
      if (conversation.messageCount <= 0) continue;
      const semantic = semanticById.get(conversation.id) ?? 0;
      const lexical = lexicalScore(terms, lowerQuery, lexicalTextFor(conversation, lexicalById));
      const titleBoost = conversation.title.toLowerCase().includes(lowerQuery) ? TITLE_MATCH_BONUS : 0;
      const score = semantic + lexical + titleBoost;
      if (score <= 0) continue;
      scored.push({
        conversationId: conversation.id,
        agentId: conversation.agentId,
        title: conversation.title,
        snippet: conversation.lastMessage,
        updatedAt: conversation.updatedAt,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    console.log(`[conv-search] query=${JSON.stringify(trimmed)} conversations=${await indexedConversationCount()} chunks=${await chunkCount()} chunkMatches=${chunkMatches.length} hits=${scored.length} -> hybrid`);
    if (scored.length) return { hits: await withMatchingSnippets(scored.slice(0, limit), terms), semantic: true };

    // Embeddings returned but matched nothing above zero, so try lexical-only.
    const lexicalOnly = keywordFallback(trimmed, conversations, lexicalById, limit);
    if (lexicalOnly.length) return { hits: lexicalOnly, semantic: false };
  } catch (error) {
    console.warn("[conv-search] semantic path failed; keyword fallback:", error instanceof Error ? error.message : error);
    const lexicalById = await getLexicalByConversation(agentId).catch(() => new Map<string, string>());
    return { hits: keywordFallback(trimmed, conversations, lexicalById, limit), semantic: false };
  }
  return { hits: [], semantic: false };
}
