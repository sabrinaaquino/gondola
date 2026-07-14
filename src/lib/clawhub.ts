// ClawHub registry client, the public skills hub for OpenClaw-style SKILL.md
// bundles. We use the documented public read API to let users search the hub
// and one-click install a skill, the same way `openclaw skills install
// @owner/slug` works, but from the UI.
//
// Read-only, best-effort: honors rate limits and fails gracefully so the rest
// of the skill installer keeps working if the hub is unreachable.

const CLAWHUB_API = (process.env.CLAWHUB_API ?? "https://clawhub.ai/api/v1").replace(/\/$/, "");
const CLAWHUB_SITE = (process.env.CLAWHUB_SITE ?? "https://clawhub.ai").replace(/\/$/, "");

export interface ClawHubResult {
  slug: string;
  owner: string;
  name: string;
  summary: string;
  downloads: number;
  ref: string;
  url: string;
}

interface RawSearchResponse {
  results?: Array<{
    slug?: unknown;
    displayName?: unknown;
    summary?: unknown;
    downloads?: unknown;
    ownerHandle?: unknown;
    owner?: { handle?: unknown };
  }>;
}

export async function searchClawHub(query: string, limit = 20): Promise<ClawHubResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const url = `${CLAWHUB_API}/search?q=${encodeURIComponent(trimmed)}&limit=${Math.max(1, Math.min(40, limit))}&nonSuspiciousOnly=true`;
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 429) throw new Error("ClawHub is busy (rate limited). Try again in a moment.");
  if (!response.ok) throw new Error(`ClawHub search failed (${response.status}).`);
  const data = (await response.json()) as RawSearchResponse;
  return (data.results ?? [])
    .map((item): ClawHubResult | undefined => {
      const slug = typeof item.slug === "string" ? item.slug : "";
      const owner = typeof item.ownerHandle === "string"
        ? item.ownerHandle
        : typeof item.owner?.handle === "string" ? item.owner.handle : "";
      if (!slug) return undefined;
      const ref = owner ? `@${owner}/${slug}` : slug;
      return {
        slug,
        owner,
        name: typeof item.displayName === "string" && item.displayName ? item.displayName : slug,
        summary: typeof item.summary === "string" ? item.summary : "",
        downloads: typeof item.downloads === "number" ? item.downloads : 0,
        ref,
        url: owner ? `${CLAWHUB_SITE}/${owner}/skills/${slug}` : `${CLAWHUB_SITE}/skills/${slug}`,
      };
    })
    .filter((item): item is ClawHubResult => Boolean(item));
}

// Fetch a skill's full SKILL.md text. ClawHub returns it in `skill.description`;
// the `owner` query param disambiguates slugs shared by multiple publishers.
export async function fetchClawHubSkillMarkdown(slug: string, owner?: string): Promise<{ markdown: string; ref: string }> {
  const cleanSlug = slug.trim();
  if (!cleanSlug) throw new Error("A ClawHub skill slug is required.");
  const query = owner?.trim() ? `?owner=${encodeURIComponent(owner.trim())}` : "";
  const url = `${CLAWHUB_API}/skills/${encodeURIComponent(cleanSlug)}${query}`;
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (response.status === 429) throw new Error("ClawHub is busy (rate limited). Try again in a moment.");
  if (!response.ok) throw new Error(`Could not load ${owner ? `@${owner}/` : ""}${cleanSlug} from ClawHub (${response.status}).`);
  const data = (await response.json()) as { skill?: { description?: unknown } };
  const markdown = typeof data.skill?.description === "string" ? data.skill.description.trim() : "";
  if (!markdown) throw new Error("This ClawHub skill did not include an installable SKILL.md.");
  return { markdown, ref: `${owner ? `@${owner}/` : ""}${cleanSlug}` };
}
