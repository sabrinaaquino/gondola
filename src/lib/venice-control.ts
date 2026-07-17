import { parseVeniceJson, toPublicError, veniceFetch } from "./venice";

// Full, direct control of the Venice API for the agent.
//
// Two capabilities back the two agent tools:
//   veniceApiCall  -> a guarded generic passthrough to any Venice endpoint,
//                     with any method, query, and JSON body, through the shared
//                     authenticated client (auth, retries, tracing, billing).
//   veniceReference -> authoritative, always-current knowledge: the live model
//                      catalog (every model with capabilities/constraints/
//                      pricing/traits/voices) and the official endpoint docs.
//
// Knowledge is sourced live from Venice itself (the /models endpoint and the
// llms-full.txt docs bundle) rather than hardcoded, so it never drifts.

const DOCS_URL = "https://docs.venice.ai/llms-full.txt";
const DOCS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_DOC_CHARS = 7_000;
const MAX_STRING_FIELD = 400;

interface RawModel {
  id: string;
  type: string;
  model_spec?: {
    name?: string;
    description?: string;
    capabilities?: Record<string, unknown>;
    constraints?: Record<string, unknown>;
    pricing?: Record<string, unknown>;
    traits?: string[];
    voices?: string[];
    default_voice?: string;
  };
}

// Endpoints served only by the admin-scoped key (billing, key management,
// wallet). Requests to these automatically use the admin key.
const ADMIN_PATH = /^\/(billing|api_keys|x402)\b/;

/** Full, accurate orientation injected into the system prompt. */
export const VENICE_API_OVERVIEW = `Venice API control. You have direct, full access to the entire Venice API (base https://api.venice.ai/api/v1) through two tools, on top of your dedicated media tools:
- venice_reference: look up authoritative, current knowledge before you call. Pass models:true (optionally type: text|image|tts|asr|embedding|upscale|inpaint|video|code) for the live model catalog with each model's capabilities, constraints, pricing, traits, and voices; pass topic (an endpoint slug or keyword like "image/generate", "audio/speech", "chat/completions", "upscale", "embeddings", "characters") for the official docs and exact parameters.
- venice_api: call any endpoint directly with method, path, query (JSON object string), and body (JSON object string). This is how you use every model, parameter, and endpoint that the dedicated tools do not cover.

Endpoint families: chat (/chat/completions, with venice_parameters for web search/scraping/citations, characters, and thinking); models (/models, /models/compatibility_mapping, /models/traits); images (/image/generate, OpenAI-compatible /images/generations, /image/edit, /image/multi-edit, /image/upscale, /image/background-remove, /image/styles); audio (/audio/speech for TTS, /audio/transcriptions for STT, and /audio/quote + /audio/queue + /audio/retrieve for music); video (/video/quote, /video/queue, /video/retrieve, /video/complete); embeddings (/embeddings); characters (/characters); web augmentation (/augment/search, /augment/scrape, /augment/text-parser); billing and account (/billing/balance, /billing/usage, /billing/usage-analytics, /api_keys...); crypto (/crypto/networks, /crypto/rpc) and wallet (/x402...).

Rules: verify exact model ids, sizing fields, and parameters with venice_reference rather than guessing, because they differ per model. Generation endpoints cost money; when unsure of price, call the matching /*/quote endpoint first. Billing and key endpoints use the admin key automatically. Account, credential, and payment changes (POST/PUT/DELETE on /api_keys or /x402, or any DELETE) open the owner's approval card automatically; do not ask for a conversational confirmation. Binary responses are not shown inline; prefer JSON/base64 responses or the dedicated media tools. Before you call any endpoint you have not already used successfully this session, any generation endpoint, or immediately after a 4xx error, FIRST call venice_reference (topic for that endpoint, models:true for ids) and use the exact documented parameters and model ids - never guess a field or resend a failed call unchanged, because models accept different fields (for example some video models reject aspect_ratio). Prefer your dedicated tools (generate_image, generate_video, generate_music, media_task_await) for media; use venice_api only for what they do not cover.`;

function capText(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

// Recursively shorten long strings (e.g. base64 image payloads) and large
// arrays so an API response can never flood the model's context.
function truncateDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_FIELD ? `${value.slice(0, MAX_STRING_FIELD)}…[+${value.length - MAX_STRING_FIELD} chars]` : value;
  }
  if (Array.isArray(value)) {
    if (depth > 8) return `[array of ${value.length}]`;
    const capped = value.slice(0, 50).map((item) => truncateDeep(item, depth + 1));
    if (value.length > 50) capped.push(`…[+${value.length - 50} more items]`);
    return capped;
  }
  if (value && typeof value === "object") {
    if (depth > 8) return "{…}";
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, truncateDeep(item, depth + 1)]));
  }
  return value;
}

export function normalizeVenicePath(raw: string): string {
  let path = raw.trim();
  if (/^https?:\/\//i.test(path)) {
    const url = new URL(path);
    path = `${url.pathname}${url.search}`;
  }
  // Drop an accidental base prefix so "/api/v1/models" and "models" both work.
  path = path.replace(/^\/?api\/v1(?=\/|$)/i, "");
  if (!path.startsWith("/")) path = `/${path}`;
  return path;
}

function parseJsonObjectArg(value: string | undefined, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`The ${label} must be a valid JSON object string: ${error instanceof Error ? error.message : "parse error"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The ${label} must be a JSON object (for example {"model":"..."}).`);
  }
  return parsed as Record<string, unknown>;
}

/** A protected account/credential/payment operation that needs confirmation. */
export function isGuardedVeniceCall(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  if (upper === "DELETE") return true;
  if (upper !== "GET" && upper !== "HEAD" && /^\/(api_keys|x402)\b/.test(path)) return true;
  return false;
}

export interface VeniceApiInput {
  method?: string;
  path: string;
  query?: string;
  body?: string;
  admin?: boolean;
  confirmed?: boolean;
}

export interface VeniceApiResult {
  ok: boolean;
  status?: number;
  text: string;
  method: string;
  path: string;
  needsConfirmation?: boolean;
  guarded?: boolean;
}

export async function veniceApiCall(input: VeniceApiInput, signal?: AbortSignal): Promise<VeniceApiResult> {
  const method = (input.method ?? "GET").toUpperCase();
  let path: string;
  try {
    path = normalizeVenicePath(input.path);
  } catch (error) {
    return { ok: false, method, path: input.path, text: `Invalid path: ${error instanceof Error ? error.message : "could not parse"}` };
  }

  let query: Record<string, unknown> | undefined;
  let body: Record<string, unknown> | undefined;
  try {
    query = parseJsonObjectArg(input.query, "query");
    body = parseJsonObjectArg(input.body, "body");
  } catch (error) {
    return { ok: false, method, path, text: error instanceof Error ? error.message : "Invalid arguments" };
  }

  if (query && Object.keys(query).length) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) search.set(key, typeof value === "string" ? value : JSON.stringify(value));
    path += `${path.includes("?") ? "&" : "?"}${search.toString()}`;
  }

  if (isGuardedVeniceCall(method, path) && input.confirmed !== true) {
    return {
      ok: false,
      method,
      path,
      guarded: true,
      needsConfirmation: true,
      text: `${method} ${path} changes account, credential, or payment state. Tell the user exactly what this will do and get their approval, then retry with confirmed:true.`,
    };
  }

  const admin = input.admin === true || ADMIN_PATH.test(path);
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }

  try {
    const response = await veniceFetch(path, init, { admin, signal });
    const status = response.status;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = await parseVeniceJson<unknown>(response);
      return { ok: true, status, method, path, text: capText(JSON.stringify(truncateDeep(json), null, 2)) };
    }
    if (/^text\//.test(contentType) || /(?:csv|xml|yaml|javascript)/.test(contentType)) {
      return { ok: true, status, method, path, text: capText(await response.text()) };
    }
    const bytes = (await response.arrayBuffer()).byteLength;
    return {
      ok: true,
      status,
      method,
      path,
      text: `Received a ${contentType || "binary"} response of ${bytes} bytes. Binary bodies are not shown inline. Use a request/parameter that returns JSON or base64 (for example return_binary:false on image generation), or the dedicated media tools.`,
    };
  } catch (error) {
    const pub = toPublicError(error);
    return { ok: false, status: pub.status, method, path, text: `Venice API error (${pub.status}): ${pub.message}${pub.requestId ? ` [request ${pub.requestId}]` : ""}` };
  }
}

// ── Reference (models + docs) ─────────────────────────────────────────────────

const docsCache = globalThis as typeof globalThis & {
  __veniceDocsCache?: { text: string; expiresAt: number };
};

async function loadVeniceDocs(signal?: AbortSignal): Promise<string> {
  const cached = docsCache.__veniceDocsCache;
  if (cached && cached.expiresAt > Date.now()) return cached.text;
  const response = await fetch(DOCS_URL, { signal, headers: { "User-Agent": "nova-venice-agent" } });
  if (!response.ok) throw new Error(`docs fetch failed (${response.status})`);
  const text = await response.text();
  docsCache.__veniceDocsCache = { text, expiresAt: Date.now() + DOCS_TTL_MS };
  return text;
}

function listEndpointSlugs(docs: string): string[] {
  const slugs = new Set<string>();
  for (const match of docs.matchAll(/Source: https:\/\/docs\.venice\.ai\/api-reference\/endpoint\/(\S+)/g)) {
    slugs.add(match[1]);
  }
  return [...slugs].sort();
}

export function extractDocSection(docs: string, topic: string): string {
  const needle = topic.trim().toLowerCase().replace(/^\/+/, "");
  const terms = needle.split(/[^a-z0-9]+/).filter(Boolean);
  const sections = docs.split(/\n(?=# )/);
  const scored = sections
    .map((section) => {
      const head = section.slice(0, 400).toLowerCase();
      const title = (section.match(/^#\s+(.+)/)?.[1] ?? "").toLowerCase();
      let score = 0;
      if (head.includes(`endpoint/${needle}`)) score += 100;
      if (needle.length >= 4 && head.includes(needle)) score += 20;
      if (title.includes(needle)) score += 40;
      for (const term of terms) {
        if (term.length >= 3 && title.includes(term)) score += 8;
      }
      return { section: section.trim(), score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return "";
  return scored.slice(0, 2).map((entry) => entry.section).join("\n\n---\n\n");
}

function renderModels(models: RawModel[], detailed: boolean): string {
  if (!models.length) return "No models were returned.";
  if (!detailed) {
    const byType = new Map<string, string[]>();
    for (const model of models) {
      const list = byType.get(model.type) ?? [];
      list.push(model.id);
      byType.set(model.type, list);
    }
    return [...byType.entries()]
      .map(([type, ids]) => `${type} (${ids.length}): ${ids.join(", ")}`)
      .join("\n");
  }
  const rendered = models.slice(0, 60).map((model) => {
    const spec = model.model_spec ?? {};
    const detail = truncateDeep({
      capabilities: spec.capabilities,
      constraints: spec.constraints,
      pricing: spec.pricing,
      traits: spec.traits,
      voices: spec.voices,
      default_voice: spec.default_voice,
    });
    return `- ${model.id} (${model.type})${spec.name ? ` — ${spec.name}` : ""}\n  ${JSON.stringify(detail)}`;
  }).join("\n");
  const extra = models.length > 60 ? `\n…(+${models.length - 60} more; filter by type for the rest)` : "";
  return capText(rendered + extra);
}

export interface VeniceReferenceInput {
  models?: boolean;
  type?: string;
  topic?: string;
}

export async function veniceReference(input: VeniceReferenceInput, signal?: AbortSignal): Promise<string> {
  const parts: string[] = [];

  if (input.models || input.type) {
    try {
      const type = input.type?.trim() || "all";
      const response = await veniceFetch(`/models?type=${encodeURIComponent(type)}`, {}, { retries: 1, signal, trace: false });
      const catalog = await parseVeniceJson<{ data?: RawModel[] }>(response);
      parts.push(`Venice models${input.type ? ` (type=${input.type})` : ""}:\n${renderModels(catalog.data ?? [], Boolean(input.type))}`);
    } catch (error) {
      const pub = toPublicError(error);
      parts.push(`Could not load the model catalog (${pub.status}): ${pub.message}`);
    }
  }

  if (input.topic) {
    try {
      const docs = await loadVeniceDocs(signal);
      const section = extractDocSection(docs, input.topic);
      parts.push(section
        ? capText(section, MAX_DOC_CHARS)
        : `No documentation section matched "${input.topic}". Available endpoints: ${listEndpointSlugs(docs).join(", ")}`);
    } catch (error) {
      parts.push(`${VENICE_API_OVERVIEW}\n\n(Live docs were unavailable: ${error instanceof Error ? error.message : "fetch error"}.)`);
    }
  }

  if (!parts.length) {
    try {
      const docs = await loadVeniceDocs(signal);
      parts.push(`${VENICE_API_OVERVIEW}\n\nAll documented endpoints: ${listEndpointSlugs(docs).join(", ")}`);
    } catch {
      parts.push(VENICE_API_OVERVIEW);
    }
  }

  return parts.join("\n\n");
}
