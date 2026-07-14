import { veniceJson } from "./venice";

// Venice embeddings client. Venice exposes an OpenAI-compatible
// POST /api/v1/embeddings endpoint; text-embedding-bge-m3 is the private,
// RAG-recommended model (1024 dimensions). Used to turn conversation content
// into vectors for semantic search.

export const EMBEDDING_MODEL = process.env.VENICE_EMBEDDING_MODEL ?? "text-embedding-bge-m3";
const MAX_BATCH = 64;
const MAX_INPUT_CHARS = 6_000;

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum);
  if (!magnitude || !Number.isFinite(magnitude)) return vector;
  return vector.map((value) => value / magnitude);
}

// Cosine similarity for L2-normalized vectors reduces to a dot product.
export function dot(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) total += a[index] * b[index];
  return total;
}

/**
 * Embed a batch of texts, returning one L2-normalized vector per input (in
 * order). Inputs are chunked to respect the model's array limit.
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const clean = texts.map((text) => text.replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS) || " ");
  const vectors: number[][] = [];
  for (let start = 0; start < clean.length; start += MAX_BATCH) {
    const chunk = clean.slice(start, start + MAX_BATCH);
    const response = await veniceJson<EmbeddingResponse>(
      "/embeddings",
      { model: EMBEDDING_MODEL, input: chunk, encoding_format: "float" },
      signal,
    );
    const rows = [...(response.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== chunk.length) throw new Error("Venice returned an unexpected number of embeddings");
    for (const row of rows) {
      if (!Array.isArray(row.embedding) || !row.embedding.length) throw new Error("Venice returned an empty embedding");
      vectors.push(normalize(row.embedding));
    }
  }
  return vectors;
}

export async function embedText(text: string, signal?: AbortSignal): Promise<number[]> {
  const [vector] = await embedTexts([text], signal);
  return vector;
}
