import { parseVeniceJson, veniceFetch } from "./venice";

// Capability registry + explainable routing.
//
// The registry is derived live from Venice's /models catalog (never hardcoded)
// and lightly enriched. routeModel is a deterministic, explainable filter-then-
// rank over that data: it narrows to compatible models, applies privacy/cost/
// context constraints, ranks the survivors, and returns the choice plus the
// reasons. The agent is never asked to pick blindly from hundreds of models.

const REGISTRY_TTL_MS = 5 * 60 * 1000;

export type Modality = "text" | "image" | "video" | "audio" | "embedding";

export interface ModelCapability {
  id: string;
  provider: "venice";
  type: string;
  modalities: { input: Modality[]; output: Modality[] };
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  contextTokens?: number;
  strengths: string[];
  typicalTasks: string[];
  pricing?: { inputPerMillion?: number; outputPerMillion?: number; fixedRequestUsd?: number };
  private: boolean;
}

interface RawModel {
  id: string;
  type: string;
  model_spec?: {
    capabilities?: Record<string, unknown>;
    constraints?: Record<string, unknown>;
    pricing?: Record<string, unknown>;
    traits?: string[];
    privacy?: string;
  };
}

function flag(caps: Record<string, unknown> | undefined, ...keys: string[]): boolean {
  if (!caps) return false;
  return keys.some((key) => caps[key] === true || caps[key] === "true");
}

function numeric(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function derivePricing(pricing: Record<string, unknown> | undefined): ModelCapability["pricing"] {
  if (!pricing) return undefined;
  const inputPerMillion = numeric(pricing.input ?? pricing.inputPerMillion ?? pricing.input_per_million ?? pricing.prompt);
  const outputPerMillion = numeric(pricing.output ?? pricing.outputPerMillion ?? pricing.output_per_million ?? pricing.completion);
  const fixedRequestUsd = numeric(pricing.usd ?? pricing.perRequest ?? pricing.fixed);
  if (inputPerMillion === undefined && outputPerMillion === undefined && fixedRequestUsd === undefined) return undefined;
  return { inputPerMillion, outputPerMillion, fixedRequestUsd };
}

export function toModelCapability(model: RawModel): ModelCapability {
  const spec = model.model_spec ?? {};
  const caps = spec.capabilities;
  const input: Modality[] = [];
  const output: Modality[] = [];
  switch (model.type) {
    case "text":
    case "code":
      input.push("text");
      if (flag(caps, "supportsVision", "optimizedForVision", "vision", "supportsImageInput")) input.push("image");
      output.push("text");
      break;
    case "image":
    case "inpaint":
    case "upscale":
      input.push("text", "image");
      output.push("image");
      break;
    case "tts":
      input.push("text");
      output.push("audio");
      break;
    case "asr":
      input.push("audio");
      output.push("text");
      break;
    case "embedding":
      input.push("text");
      output.push("embedding");
      break;
    case "video":
      input.push("text", "image");
      output.push("video");
      break;
    case "music":
      input.push("text");
      output.push("audio");
      break;
    default:
      input.push("text");
      output.push("text");
  }
  return {
    id: model.id,
    provider: "venice",
    type: model.type,
    modalities: { input: [...new Set(input)], output: [...new Set(output)] },
    supportsTools: flag(caps, "supportsFunctionCalling", "supportsTools", "supportsToolCalls"),
    supportsReasoning: flag(caps, "supportsReasoning", "reasoning"),
    supportsStructuredOutput: flag(caps, "supportsResponseSchema", "supportsStructuredOutputs", "supportsStructuredOutput"),
    contextTokens: numeric(spec.constraints?.contextTokens ?? caps?.availableContextTokens ?? caps?.contextTokens),
    strengths: Array.isArray(spec.traits) ? spec.traits : [],
    typicalTasks: Array.isArray(spec.traits) ? spec.traits : [],
    pricing: derivePricing(spec.pricing),
    private: spec.privacy === "private",
  };
}

const registryCache = globalThis as typeof globalThis & {
  __veniceModelRegistry?: { models: ModelCapability[]; expiresAt: number };
};

export async function loadModelRegistry(signal?: AbortSignal): Promise<ModelCapability[]> {
  const cached = registryCache.__veniceModelRegistry;
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const response = await veniceFetch("/models?type=all", {}, { retries: 1, signal, trace: false });
  const catalog = await parseVeniceJson<{ data?: RawModel[] }>(response);
  const models = (catalog.data ?? []).map(toModelCapability);
  registryCache.__veniceModelRegistry = { models, expiresAt: Date.now() + REGISTRY_TTL_MS };
  return models;
}

// ── Explainable routing ───────────────────────────────────────────────────────

export interface RoutingRequirements {
  inputModalities?: Modality[];
  outputModalities?: Modality[];
  needsTools?: boolean;
  needsReasoning?: boolean;
  needsStructuredOutput?: boolean;
  private?: boolean;
  minContextTokens?: number;
  maxInputCostPerMillionUsd?: number;
  taskHint?: string;
  prefer?: "cheapest" | "largest_context" | "balanced";
}

export interface RoutingCandidate {
  id: string;
  score: number;
  reasons: string[];
}

export interface RoutingResult {
  model?: string;
  explanation: string;
  candidates: RoutingCandidate[];
}

function superset(have: Modality[], need: Modality[] | undefined): boolean {
  if (!need?.length) return true;
  return need.every((modality) => have.includes(modality));
}

export function routeModel(requirements: RoutingRequirements, models: ModelCapability[]): RoutingResult {
  const rejected: string[] = [];
  const compatible = models.filter((model) => {
    if (!superset(model.modalities.input, requirements.inputModalities)) return false;
    if (!superset(model.modalities.output, requirements.outputModalities)) return false;
    if (requirements.needsTools && !model.supportsTools) return false;
    if (requirements.needsReasoning && !model.supportsReasoning) return false;
    if (requirements.needsStructuredOutput && !model.supportsStructuredOutput) return false;
    if (requirements.private && !model.private) return false;
    if (requirements.minContextTokens && (model.contextTokens ?? 0) < requirements.minContextTokens) return false;
    if (
      requirements.maxInputCostPerMillionUsd !== undefined
      && model.pricing?.inputPerMillion !== undefined
      && model.pricing.inputPerMillion > requirements.maxInputCostPerMillionUsd
    ) return false;
    return true;
  });

  if (!compatible.length) {
    const constraints = [
      requirements.inputModalities?.length ? `input ${requirements.inputModalities.join("+")}` : "",
      requirements.outputModalities?.length ? `output ${requirements.outputModalities.join("+")}` : "",
      requirements.needsTools ? "tools" : "",
      requirements.needsReasoning ? "reasoning" : "",
      requirements.needsStructuredOutput ? "structured output" : "",
      requirements.private ? "private" : "",
      requirements.minContextTokens ? `context >= ${requirements.minContextTokens}` : "",
      requirements.maxInputCostPerMillionUsd !== undefined ? `input cost <= ${requirements.maxInputCostPerMillionUsd}/M` : "",
    ].filter(Boolean).join(", ");
    return { model: undefined, explanation: `No model satisfies: ${constraints || "the request"}.`, candidates: [] };
  }

  const hintTerms = (requirements.taskHint ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  const prefer = requirements.prefer ?? "balanced";
  const candidates: RoutingCandidate[] = compatible.map((model) => {
    const reasons: string[] = [];
    let score = 0;
    const hintMatches = hintTerms.filter((term) => `${model.strengths.join(" ")} ${model.typicalTasks.join(" ")} ${model.id}`.toLowerCase().includes(term));
    if (hintMatches.length) {
      score += hintMatches.length * 10;
      reasons.push(`matches ${hintMatches.join(", ")}`);
    }
    if (requirements.needsReasoning && model.supportsReasoning) {
      score += 6;
      reasons.push("supports reasoning");
    }
    const cost = model.pricing?.inputPerMillion;
    if (prefer === "cheapest" && cost !== undefined) {
      score += Math.max(0, 20 - cost);
      reasons.push(`input cost ${cost}/M`);
    }
    if ((prefer === "largest_context" || prefer === "balanced") && model.contextTokens) {
      score += Math.min(10, model.contextTokens / 40_000);
      reasons.push(`${model.contextTokens} ctx`);
    }
    if (prefer === "balanced" && cost !== undefined) {
      score += Math.max(0, 8 - cost / 2);
    }
    if (!reasons.length) reasons.push("compatible");
    return { id: model.id, score: Math.round(score * 100) / 100, reasons };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  const chosen = candidates[0];
  const explanation = `Selected ${chosen.id} from ${compatible.length} compatible model${compatible.length === 1 ? "" : "s"} (preference: ${prefer}). Why: ${chosen.reasons.join("; ")}.`;
  return { model: chosen.id, explanation, candidates: candidates.slice(0, 6) };
}

/**
 * Load the live registry and route in one call. Best-effort: returns undefined
 * (never throws) when the registry is unavailable, so callers on the hot path
 * can fall back to their existing static selection without risk.
 */
export async function routeModelLive(
  requirements: RoutingRequirements,
  signal?: AbortSignal,
): Promise<RoutingResult | undefined> {
  try {
    const models = await loadModelRegistry(signal);
    if (!models.length) return undefined;
    return routeModel(requirements, models);
  } catch {
    return undefined;
  }
}

// ── Self-service model selection ───────────────────────────────────────────────
// Resolving a user's model request ("switch to a faster model", "use glm",
// "change to claude 4.8") to a concrete Venice model the agent can actually run
// on. Venice serves open-weight models only, so a request for Claude/GPT/Gemini
// resolves to nothing and the caller reports it plus real alternatives.

/** Proprietary providers Venice does not host, used only to explain a miss. */
const FOREIGN_PROVIDERS = [
  "claude", "anthropic", "sonnet", "opus", "haiku",
  "gpt", "openai", "chatgpt", "o1", "o3", "o4",
  "gemini", "google", "bard", "palm", "grok", "copilot",
];

/** Text models that can actually back the interactive agent (need tool calling). */
export function usableChatModels(models: ModelCapability[]): ModelCapability[] {
  return models.filter((model) =>
    (model.type === "text" || model.type === "code")
    && model.modalities.output.includes("text")
    && model.supportsTools);
}

export interface ChatModelResolution {
  /** The resolved model, when the request maps to a real Venice chat model. */
  model?: ModelCapability;
  why?: string;
  /** A recognized non-Venice provider named in the request, when nothing matched. */
  foreign?: string;
  /** A short, ranked list of switchable chat models to offer the user. */
  alternatives: ModelCapability[];
}

function normalizeModelToken(value: string): string {
  return value.toLowerCase().replace(/[\s._-]/g, "");
}

/**
 * Map a free-form model request to a concrete Venice chat model. Precedence:
 * exact id, then normalized substring/token match on the id, then a named but
 * unavailable proprietary provider (reported, never guessed), then a descriptor
 * ("fast"/"cheap"/"best reasoning") routed explainably. Always returns a handful
 * of real alternatives so the caller can offer options on a miss.
 */
export function resolveChatModelRequest(request: string, models: ModelCapability[]): ChatModelResolution {
  const usable = usableChatModels(models);
  const suggest = (excludeId?: string): ModelCapability[] => {
    if (!usable.length) return [];
    const ranked = routeModel({ needsTools: true, outputModalities: ["text"], prefer: "balanced" }, usable);
    const byId = new Map(usable.map((model) => [model.id, model]));
    return ranked.candidates
      .map((candidate) => byId.get(candidate.id))
      .filter((model): model is ModelCapability => Boolean(model) && model!.id !== excludeId)
      .slice(0, 5);
  };
  const raw = request.trim();
  const q = raw.toLowerCase();
  if (!q || !usable.length) return { alternatives: suggest() };

  // 1. Exact id, then normalized substring ("glm 5.2" -> zai-org-glm-5-2).
  const nq = normalizeModelToken(q);
  let hit = usable.find((model) => model.id.toLowerCase() === q)
    ?? (nq.length >= 3 ? usable.find((model) => normalizeModelToken(model.id).includes(nq)) : undefined);
  if (!hit) {
    const tokens = q.split(/[^a-z0-9.]+/i).map(normalizeModelToken).filter((token) => token.length >= 3);
    if (tokens.length) {
      hit = usable.find((model) => tokens.every((token) => normalizeModelToken(model.id).includes(token)))
        ?? usable.find((model) => tokens.some((token) => normalizeModelToken(model.id).includes(token)));
    }
  }
  if (hit) return { model: hit, why: `matched "${raw}"`, alternatives: suggest(hit.id) };

  // 2. A specific but unavailable provider (Claude/GPT/Gemini/...): report, don't guess.
  const foreign = FOREIGN_PROVIDERS.find((provider) => q.includes(provider));
  if (foreign) return { foreign, alternatives: suggest() };

  // 3. A descriptor ("fast", "cheap", "best reasoning"): route explainably.
  if (/(fast|quick|cheap|small|light|efficient|reason|think|smart|best|strong|capable|deep|large|big|context)/.test(q)) {
    const routed = routeModel({
      needsTools: true,
      outputModalities: ["text"],
      needsReasoning: /(reason|think|smart|best|strong|capable|deep)/.test(q) || undefined,
      taskHint: q,
      prefer: /(cheap|fast|quick|small|light|efficient)/.test(q)
        ? "cheapest"
        : /(large|big|context)/.test(q) ? "largest_context" : "balanced",
    }, usable);
    const model = routed.model ? usable.find((candidate) => candidate.id === routed.model) : undefined;
    if (model) return { model, why: routed.explanation, alternatives: suggest(model.id) };
  }

  // 4. Unrecognized: offer options.
  return { alternatives: suggest() };
}
