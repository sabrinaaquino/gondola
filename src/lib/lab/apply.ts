import { getChampion } from "./store";
import type { LabConfig } from "./types";

// Applying a promoted (champion) Lab config to the live runtime. This is the
// RETURN path of the outer loop: a config the owner promoted actually changes
// what the acting runtime does, and a rollback reverts it.
//
// Everything here is a no-op when there is no champion, so the runtime behaves
// exactly as before until the owner deliberately promotes a config. That keeps
// self-improvement opt-in: the loop is closed, but nothing changes without an
// explicit, human-approved promotion.

/**
 * Resolve the model a champion config routes a given role to. Precedence is a
 * matching per-role rule, then the config's default model. Returns undefined
 * when there is no config, no matching rule, and no default, so callers keep
 * their existing selection.
 */
export function resolveRoutedModel(config: LabConfig | undefined, role: string): string | undefined {
  if (!config) return undefined;
  const rule = config.routing?.rules?.find((candidate) => candidate.role === role);
  const model = (rule?.model ?? config.routing?.defaultModel ?? "").trim();
  return model || undefined;
}

/** The current champion config (version id + config), or undefined when none is promoted. */
export async function getChampionConfig(): Promise<{ versionId: string; config: LabConfig } | undefined> {
  const champion = await getChampion().catch(() => undefined);
  return champion ? { versionId: champion.versionId, config: champion.config } : undefined;
}
