import { NextResponse } from "next/server";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { parseVeniceJson, toPublicError, veniceFetch } from "@/lib/venice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawModel {
  id: string;
  type: string;
  model_spec?: {
    name?: string;
    description?: string;
    privacy?: string;
    offline?: boolean;
    beta?: boolean;
    capabilities?: Record<string, boolean | number | string | string[]>;
    constraints?: Record<string, unknown>;
    pricing?: Record<string, unknown>;
    traits?: string[];
    voices?: string[];
    default_voice?: string;
  };
}

interface PublicModel {
  id: string;
  type: string;
  name: string;
  beta?: boolean;
  privacy?: string;
  capabilities?: Record<string, boolean | number | string | string[]>;
  constraints?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  traits?: string[];
  voices?: string[];
  defaultVoice?: string;
}

const catalogCache = globalThis as typeof globalThis & {
  __veniceModelCatalog?: { models: PublicModel[]; checkedAt: string; expiresAt: number };
};

// Venice exposes some models only to staff/internal accounts (e.g. the BytePlus
// "staff variant" builds). They aren't meant for general selection, so keep them
// out of every model dropdown. The only reliable signal is the description text,
// which calls them a "staff variant" / "staff-only variant".
function isStaffOnlyModel(model: RawModel): boolean {
  return /\bstaff\b/i.test(model.model_spec?.description ?? "");
}

function isFastTextVariant(model: RawModel): boolean {
  if (model.type !== "text") return false;
  const label = `${model.id} ${model.model_spec?.name ?? ""}`;
  return /(?:^|[-_\s])fast(?:$|[-_\s])/i.test(label);
}

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  const cached = catalogCache.__veniceModelCatalog;
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(
      { connected: true, models: cached.models, checkedAt: cached.checkedAt, cached: true },
      { headers: { "Cache-Control": "private, max-age=120" } },
    );
  }
  try {
    const response = await veniceFetch("/models?type=all", {}, { retries: 1 });
    const catalog = await parseVeniceJson<{ data?: RawModel[] }>(response);
    const models = (catalog.data ?? [])
      .filter((model) => (
        !model.model_spec?.offline
        && (!model.model_spec?.beta || isFastTextVariant(model))
        && !isStaffOnlyModel(model)
      ))
      .map((model): PublicModel => ({
        id: model.id,
        type: model.type,
        name: model.model_spec?.name ?? model.id,
        beta: model.model_spec?.beta,
        privacy: model.model_spec?.privacy,
        capabilities: model.model_spec?.capabilities,
        constraints: model.model_spec?.constraints,
        pricing: model.model_spec?.pricing,
        traits: model.model_spec?.traits,
        voices: model.model_spec?.voices,
        defaultVoice: model.model_spec?.default_voice,
      }));

    const checkedAt = new Date().toISOString();
    catalogCache.__veniceModelCatalog = { models, checkedAt, expiresAt: Date.now() + 5 * 60_000 };
    return NextResponse.json(
      { connected: true, models, checkedAt },
      { headers: { "Cache-Control": "private, max-age=120" } },
    );
  } catch (error) {
    if (cached) {
      return NextResponse.json(
        { connected: true, models: cached.models, checkedAt: cached.checkedAt, cached: true, stale: true },
        { headers: { "Cache-Control": "private, max-age=30" } },
      );
    }
    const publicError = toPublicError(error);
    return NextResponse.json(
      { connected: false, error: publicError.message, requestId: publicError.requestId },
      { status: publicError.status },
    );
  }
}
