import { useEffect, useState } from "react";

interface SkillInstallerProps {
  installedSlugs: string[];
  onBack: () => void;
  onInstalled: () => Promise<void> | void;
}

interface CatalogSkill {
  id: string;
  name: string;
  category: string;
  glyph: string;
  blurb: string;
  markdown: string;
}

// Curated, one-click-installable skills shipped with the app, the equivalent
// of a starter registry (Cursor plugins / OpenClaw ClawHub). Each is a complete
// SKILL.md so installing just copies it into the workspace skills directory.
const CATALOG: CatalogSkill[] = [
  {
    id: "research-digest", name: "Research digest", category: "Research", glyph: "❖",
    blurb: "A dated, deduplicated digest of the latest sources on a topic, with links and why each matters.",
    markdown: `---
name: research-digest
description: Compile a dated, deduplicated digest of the latest sources on a topic, with links and why each matters.
---

When the user asks for a digest, briefing, or "what's new" on a topic:

1. Use live web research to gather sources from the last 24 hours. Rank by signal, not recency; drop press releases, reposts, and items duplicated across sources.
2. Keep the 5–8 strongest items. For each, verify the link resolves and capture a one-line factual claim, the source name, and one line on why it matters.
3. Lead with a dated heading, then the items as a tight list. Never invent URLs or dates. If sources conflict, say so rather than guessing.
4. End with a single "watch next" line: the one thing most worth following up.

Keep it skimmable: no preamble and no filler.
`,
  },
  {
    id: "creative-director", name: "Creative director", category: "Creative", glyph: "✦",
    blurb: "Turn a vague idea into a precise, production-ready prompt for image, video, or music.",
    markdown: `---
name: creative-director
description: Turn a vague idea into a precise, production-ready prompt for image, video, or music generation.
---

Before generating media, shape a strong brief:
- Subject and action: what is happening and who or what is in frame.
- Style and medium: photographic, illustration, 3D, or film still; use artist or era references only if the user wants them.
- Composition: shot type, angle, focal-length feel, framing.
- Light and mood: time of day, key light, color palette, atmosphere.
- For video: motion, pacing, shot length, and whether audio is none, natural, or scored (with the music mood).

Confirm length, quality, and audio before spending on video or music. Offer one or two concrete variations instead of asking many questions. Keep the final prompt vivid but concrete, never a wall of adjectives.
`,
  },
  {
    id: "meeting-notes", name: "Meeting notes", category: "Productivity", glyph: "≣",
    blurb: "Turn a conversation into a clean summary with decisions and owner-tagged action items.",
    markdown: `---
name: meeting-notes
description: Turn a conversation or transcript into a clean summary with decisions and owner-tagged action items.
---

Produce, in this order:
1. TL;DR: one or two sentences.
2. Decisions: a bullet list of what was decided.
3. Action items: "[owner]: task, due [date]" on one line each; use "unassigned" when no owner was named.
4. Open questions: anything left unresolved.

Attribute only what was actually said. Do not invent owners, dates, or decisions. Keep it terse and scannable.
`,
  },
  {
    id: "fact-check", name: "Fact-checker", category: "Research", glyph: "✓",
    blurb: "Verify a claim against live sources and report a calibrated verdict with citations.",
    markdown: `---
name: fact-check
description: Verify a claim against live sources and report a calibrated verdict with citations.
---

When asked to check or verify a claim:
1. Restate the exact claim.
2. Use live web research to find primary or reputable sources; prefer originals over aggregators.
3. Give a verdict of Supported, Mixed, Unsupported, or Unverifiable, with a one-line rationale.
4. Cite 2–4 sources as name + URL, and note the date of each key source.

Never assert certainty you cannot source. If evidence conflicts or is thin, say Mixed or Unverifiable and explain why.
`,
  },
  {
    id: "language-tutor", name: "Language tutor", category: "Learning", glyph: "語",
    blurb: "Practice a target language conversationally, with gentle corrections and level-appropriate replies.",
    markdown: `---
name: language-tutor
description: Practice a target language conversationally, with gentle corrections at the right level.
---

Act as a patient language partner:
- Ask the user's target language and level once, then adapt.
- Converse mostly in the target language at their level; keep replies short in voice mode.
- After the user speaks, if they made a mistake, give a brief correction: the fixed version plus a one-line reason. Praise good usage sparingly and specifically.
- Introduce a little new vocabulary in context and reuse it. Never overwhelm; focus on one correction at a time.
`,
  },
  {
    id: "bedtime-story", name: "Bedtime story", category: "Home", glyph: "☾",
    blurb: "Tell a calm, original, age-appropriate story that winds down toward sleep.",
    markdown: `---
name: bedtime-story
description: Tell a calm, original, age-appropriate bedtime story that winds down toward sleep.
---

When asked for a bedtime story:
- Unless already known, ask once for the listener's age and any favorite character or theme.
- Keep it gentle: no scary peril, soft stakes, a warm resolution. Slow the pace toward the end.
- Aim for two to four minutes spoken, in soothing, rhythmic language suited to reading aloud.
- End on a quiet, sleepy note, and offer to continue tomorrow rather than starting something exciting.
`,
  },
];

type Mode = "browse" | "url" | "paste" | "manual" | "hub";

interface HubResult {
  slug: string;
  owner: string;
  name: string;
  summary: string;
  downloads: number;
  ref: string;
  url: string;
}

interface SkillSuggestion {
  id: string;
  name: string;
  description: string;
  rationale: { exampleCount: number; exampleQueries: string[]; tools: string[] };
}

export function SkillInstaller({ installedSlugs, onBack, onInstalled }: SkillInstallerProps) {
  const [mode, setMode] = useState<Mode>("browse");
  const [active, setActive] = useState<CatalogSkill>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [installed, setInstalled] = useState<Set<string>>(new Set(installedSlugs));

  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  const [hubQuery, setHubQuery] = useState("");
  const [hubResults, setHubResults] = useState<HubResult[]>([]);
  const [hubSearching, setHubSearching] = useState(false);
  const [hubSearched, setHubSearched] = useState(false);

  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const [scanning, setScanning] = useState(false);

  const isInstalled = (slug: string) => installed.has(slug) || installedSlugs.includes(slug);

  const post = async (body: Record<string, unknown>): Promise<{ skill?: { id: string; name: string }; skills?: Array<{ id: string; name: string }> }> => {
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { skill?: { id: string; name: string }; skills?: Array<{ id: string; name: string }>; error?: string };
    if (!response.ok) throw new Error(result.error ?? "The skill could not be installed");
    return result;
  };

  const run = async (label: string, body: Record<string, unknown>, after?: (id: string) => void) => {
    setBusy(label);
    setError("");
    setNote("");
    try {
      const result = await post(body);
      const skills = result.skills?.length ? result.skills : result.skill ? [result.skill] : [];
      if (skills.length) setInstalled((prev) => { const next = new Set(prev); for (const skill of skills) next.add(skill.id); return next; });
      setNote(skills.length > 1 ? `Installed ${skills.length} skills.` : `Installed “${skills[0]?.name ?? ""}”.`);
      after?.(skills[0]?.id ?? "");
      await onInstalled();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The skill could not be installed");
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "list_skill_suggestions" }),
        });
        const result = await response.json() as { suggestions?: SkillSuggestion[] };
        setSuggestions(result.suggestions ?? []);
      } catch {
        // Suggestions are optional; ignore load failures.
      }
    })();
  }, []);

  const scanForSkills = async () => {
    setScanning(true);
    setError("");
    setNote("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "distill_skills" }),
      });
      const result = await response.json() as { suggestions?: SkillSuggestion[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not scan your chats");
      setSuggestions(result.suggestions ?? []);
      setNote((result.suggestions?.length ?? 0) > 0
        ? `Found ${result.suggestions!.length} skill${result.suggestions!.length === 1 ? "" : "s"} worth considering.`
        : "No new patterns yet. Keep using the agent and check back.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not scan your chats");
    } finally {
      setScanning(false);
    }
  };

  const installSuggestion = async (suggestion: SkillSuggestion) => {
    setBusy(`suggestion:${suggestion.id}`);
    setError("");
    setNote("");
    try {
      const result = await post({ action: "install_skill_suggestion", id: suggestion.id });
      if (result.skill?.id) setInstalled((prev) => new Set(prev).add(result.skill!.id));
      setNote(`Installed “${result.skill?.name ?? suggestion.name}”.`);
      setSuggestions((prev) => prev.filter((item) => item.id !== suggestion.id));
      await onInstalled();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not install the suggested skill");
    } finally {
      setBusy("");
    }
  };

  const dismissSuggestion = async (id: string) => {
    setSuggestions((prev) => prev.filter((item) => item.id !== id));
    await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss_skill_suggestion", id }),
    }).catch(() => undefined);
  };

  const searchHub = async () => {
    if (!hubQuery.trim()) return;
    setHubSearching(true);
    setError("");
    setNote("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "hub_search", query: hubQuery.trim() }),
      });
      const result = await response.json() as { results?: HubResult[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "ClawHub search failed");
      setHubResults(result.results ?? []);
      setHubSearched(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "ClawHub search failed");
    } finally {
      setHubSearching(false);
    }
  };

  if (mode === "hub") {
    return (
      <section className="workspace-form">
        <button className="back-button" onClick={() => { setMode("browse"); setError(""); }}>← All skills</button>
        <h3>Browse ClawHub</h3>
        <p className="form-intro">Search the public <a href="https://clawhub.ai" target="_blank" rel="noreferrer">ClawHub</a> registry and install any skill in one click.</p>
        <label><span>Search skills</span>
          <input
            value={hubQuery}
            onChange={(event) => setHubQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void searchHub(); }}
            placeholder="calendar, github, research…"
          />
        </label>
        <button className="workspace-primary form-submit" disabled={hubSearching || !hubQuery.trim()} onClick={() => void searchHub()}>{hubSearching ? "Searching…" : "Search ClawHub"}</button>
        {error && <p className="form-error">{error}</p>}
        {note && <p className="connection-note">{note}</p>}
        <div className="resource-list">
          {hubSearched && !hubResults.length && !hubSearching && (
            <div className="resource-empty"><strong>No skills found</strong><small>Try a different search term.</small></div>
          )}
          {hubResults.map((result) => {
            const done = isInstalled(result.slug);
            return (
              <div className="resource-row" key={result.ref}>
                <span className={done ? "is-connected" : ""}>{result.name.charAt(0).toUpperCase()}</span>
                <div>
                  <strong>{result.name} <a href={result.url} target="_blank" rel="noreferrer" style={{ color: "#7d8794", fontWeight: 400 }}>@{result.owner}</a></strong>
                  <small>{result.summary || result.ref}{result.downloads ? ` · ${result.downloads.toLocaleString()} installs` : ""}</small>
                </div>
                <button
                  className="workspace-primary"
                  disabled={!!busy || done}
                  onClick={() => void run(`hub:${result.ref}`, { action: "install_skill_hub", slug: result.slug, owner: result.owner })}
                >{done ? "Installed" : busy === `hub:${result.ref}` ? "Installing…" : "Install"}</button>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  if (mode === "url") {
    return (
      <section className="workspace-form">
        <button className="back-button" onClick={() => { setMode("browse"); setError(""); }}>← All skills</button>
        <h3>Install from GitHub or URL</h3>
        <p className="form-intro">Point to a repo (<code>owner/repo</code>) to install every <code>SKILL.md</code> it contains, a link to one skill folder or <code>SKILL.md</code>, or a raw URL.</p>
        <label><span>Source</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="owner/repo · https://github.com/owner/repo/blob/main/SKILL.md" /></label>
        {error && <p className="form-error">{error}</p>}
        {note && <p className="connection-note">{note}</p>}
        <button className="workspace-primary form-submit" disabled={!!busy || !url.trim()} onClick={() => void run("url", { action: "install_skill_url", url: url.trim() }, () => setUrl(""))}>{busy ? "Installing…" : "Install skill"}</button>
      </section>
    );
  }

  if (mode === "paste") {
    return (
      <section className="workspace-form">
        <button className="back-button" onClick={() => { setMode("browse"); setError(""); }}>← All skills</button>
        <h3>Paste a SKILL.md</h3>
        <p className="form-intro">Paste a full skill file, including its <code>---</code> frontmatter with <code>name</code> and <code>description</code>.</p>
        <label><span>SKILL.md</span><textarea rows={12} value={paste} onChange={(event) => setPaste(event.target.value)} placeholder={"---\nname: my-skill\ndescription: When and how the agent should use this.\n---\n\nStep-by-step instructions…"} /></label>
        {error && <p className="form-error">{error}</p>}
        {note && <p className="connection-note">{note}</p>}
        <button className="workspace-primary form-submit" disabled={!!busy || !paste.trim()} onClick={() => void run("paste", { action: "install_skill", markdown: paste }, () => setPaste(""))}>{busy ? "Installing…" : "Install skill"}</button>
      </section>
    );
  }

  if (mode === "manual") {
    return (
      <section className="workspace-form">
        <button className="back-button" onClick={() => { setMode("browse"); setError(""); }}>← All skills</button>
        <h3>Write your own</h3>
        <p className="form-intro">Author a skill inline. It is saved as a <code>SKILL.md</code> the agent loads on demand.</p>
        <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="creative-director" /></label>
        <label><span>When should it be used?</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Plan and refine cinematic media prompts" /></label>
        <label><span>Instructions</span><textarea rows={9} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Detailed guidance for the agent…" /></label>
        {error && <p className="form-error">{error}</p>}
        {note && <p className="connection-note">{note}</p>}
        <button className="workspace-primary form-submit" disabled={!!busy || !name.trim() || !description.trim() || !instructions.trim()} onClick={() => void run("manual", { action: "create_skill", name, description, instructions }, () => { setName(""); setDescription(""); setInstructions(""); })}>{busy ? "Saving…" : "Create skill"}</button>
      </section>
    );
  }

  if (active) {
    const done = isInstalled(active.id);
    return (
      <section className="workspace-form">
        <button className="back-button" onClick={() => { setActive(undefined); setError(""); }}>← All skills</button>
        <div className="connection-card-top">
          <span className="integration-glyph">{active.glyph}</span>
          <div className="connection-card-copy"><strong>{active.name}</strong><small>{active.category}</small></div>
        </div>
        <p className="form-intro">{active.blurb}</p>
        <label><span>SKILL.md preview</span><textarea rows={12} readOnly value={active.markdown} /></label>
        {error && <p className="form-error">{error}</p>}
        {note && <p className="connection-note">{note}</p>}
        <button className="workspace-primary form-submit" disabled={!!busy || done} onClick={() => void run("catalog", { action: "install_skill", markdown: active.markdown, source: "catalog", origin: active.id })}>{done ? "Installed" : busy ? "Installing…" : `Install ${active.name}`}</button>
      </section>
    );
  }

  return (
    <>
      <section className="connections-group">
        <header className="connections-group-header">
          <div><span className="workspace-kicker">Skills</span><h4>Install a skill</h4></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="back-button" disabled={scanning} onClick={() => void scanForSkills()}>{scanning ? "Scanning…" : "↻ Scan chats"}</button>
            <button className="back-button" onClick={onBack}>← Done</button>
          </div>
        </header>
        <p className="form-intro">Skills are reusable <code>SKILL.md</code> playbooks the agent loads only when relevant. Install one below, from a link, or write your own.</p>
        {error && <p className="form-error">{error}</p>}
        {note && <p className="connection-note">{note}</p>}

        {suggestions.length > 0 && (
          <section className="connections-group">
            <header className="connections-group-header">
              <div><span className="workspace-kicker">Suggested from your chats</span><h4>Learned from recurring requests</h4></div>
            </header>
            <div style={{ display: "grid", gap: 10 }}>
              {suggestions.map((suggestion) => (
                <article className="connection-card" key={suggestion.id}>
                  <div className="connection-card-top">
                    <span className="connection-glyph">✧</span>
                    <div className="connection-card-copy">
                      <strong>{suggestion.name}</strong>
                      <small>{suggestion.description}</small>
                    </div>
                    <span className="connection-status is-on">Seen {suggestion.rationale.exampleCount}×</span>
                  </div>
                  <div className="connection-form">
                    {suggestion.rationale.tools.length > 0 && <p className="connection-hint">Tools: {suggestion.rationale.tools.slice(0, 4).join(", ")}</p>}
                    <div className="connection-actions">
                      <button className="workspace-primary" disabled={!!busy} onClick={() => void installSuggestion(suggestion)}>{busy === `suggestion:${suggestion.id}` ? "Installing…" : "Install skill"}</button>
                      <button disabled={!!busy} onClick={() => void dismissSuggestion(suggestion.id)}>Dismiss</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <div className="integration-grid">
          {CATALOG.map((skill) => {
            const done = isInstalled(skill.id);
            return (
              <button className="integration-card" key={skill.id} disabled={done} onClick={() => { setActive(skill); setError(""); setNote(""); }}>
                <span className="integration-glyph">{skill.glyph}</span>
                <strong>{skill.name}</strong>
                <small>{skill.blurb}</small>
                <em>{done ? "Installed" : "Install →"}</em>
              </button>
            );
          })}
          <button className="integration-card" onClick={() => { setMode("hub"); setError(""); setNote(""); }}>
            <span className="integration-glyph">◎</span>
            <strong>Browse ClawHub</strong>
            <small>Search the public skills registry and install in one click.</small>
            <em>Search →</em>
          </button>
          <button className="integration-card" onClick={() => { setMode("url"); setError(""); setNote(""); }}>
            <span className="integration-glyph">⤓</span>
            <strong>From GitHub / URL</strong>
            <small>Install any published SKILL.md by link.</small>
            <em>Import →</em>
          </button>
          <button className="integration-card" onClick={() => { setMode("paste"); setError(""); setNote(""); }}>
            <span className="integration-glyph">⧉</span>
            <strong>Paste SKILL.md</strong>
            <small>Drop in a full skill file with frontmatter.</small>
            <em>Paste →</em>
          </button>
          <button className="integration-card" onClick={() => { setMode("manual"); setError(""); setNote(""); }}>
            <span className="integration-glyph">+</span>
            <strong>Write your own</strong>
            <small>Author a skill inline from scratch.</small>
            <em>Create →</em>
          </button>
        </div>
      </section>
    </>
  );
}
