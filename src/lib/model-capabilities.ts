import type { CatalogModel, ReasoningEffort } from "./app-types";

const KNOWN_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function explicitEfforts(model: CatalogModel): ReasoningEffort[] {
  const constraints = model.constraints;
  if (!constraints) return [];
  const raw = constraints.reasoning_effort ?? constraints.reasoningEffort ?? constraints.reasoning;
  const candidates = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ["enum", "options", "values"].flatMap((key) => {
        const value = (raw as Record<string, unknown>)[key];
        return Array.isArray(value) ? value : [];
      })
      : [];
  return [...new Set(candidates.filter((value): value is ReasoningEffort => (
    typeof value === "string" && KNOWN_EFFORTS.includes(value as ReasoningEffort)
  )))];
}

export function supportedReasoningEfforts(model?: CatalogModel): ReasoningEffort[] {
  if (model?.capabilities?.supportsReasoningEffort !== true) return [];
  const explicit = explicitEfforts(model);
  if (explicit.length) return explicit;
  const family = `${model.name} ${model.id}`.toLowerCase();
  if (/gemini.*3(?:\.0)?\s*pro/.test(family) && !/3[.-]?1/.test(family)) return ["low", "high"];
  if (/gemini.*flash/.test(family)) return ["minimal", "low", "medium", "high"];
  if (/claude.*opus/.test(family)) return ["low", "medium", "high", "max"];
  if (/claude/.test(family)) return ["low", "medium", "high"];
  if (/gpt|openai/.test(family)) return ["low", "medium", "high", "xhigh"];
  return ["low", "medium", "high"];
}

function hasFastToken(model: CatalogModel): boolean {
  return /(?:^|[-_\s])fast(?:$|[-_\s])/.test(`${model.id} ${model.name}`.toLowerCase());
}

function fastFamilyKey(model: CatalogModel): string {
  return model.id.toLowerCase()
    .replace(/(?:^|[-_])fast(?=$|[-_])/g, "-")
    .replace(/[-_]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function findFastModelPair(models: CatalogModel[], current?: CatalogModel): { base: CatalogModel; fast: CatalogModel } | undefined {
  if (!current) return undefined;
  const family = fastFamilyKey(current);
  const siblings = models.filter((model) => model.type === "text" && fastFamilyKey(model) === family);
  const base = siblings.find((model) => !hasFastToken(model));
  const fast = siblings.find(hasFastToken);
  return base && fast ? { base, fast } : undefined;
}

export function isFastModel(model?: CatalogModel): boolean {
  return Boolean(model && hasFastToken(model));
}
