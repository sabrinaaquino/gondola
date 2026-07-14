import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillSummary } from "./app-types";
import { SMART_FAST_CHAT_MODEL } from "./app-types";
import { dot, embedTexts } from "./embeddings";
import { appendExperience, readExperience, type ExperienceRecord } from "./experience";
import { installSkill, loadWorkspaceSkills } from "./workspace";
import { veniceJson } from "./venice";

// Self-improvement: distill recurring, tool-using request patterns into
// reusable skills. This is the Hermes idea of turning experience into durable
// procedural artifacts, but human-gated: we only *suggest* a SKILL.md, and the
// user installs it. Recurrence is detected by embedding past requests and
// clustering by cosine similarity; a strong cluster that shares a tool workflow
// becomes a suggestion synthesized by a small Venice model.

const ROOT = path.join(process.cwd(), ".gondola");
const SUGGESTIONS_FILE = path.join(ROOT, "skill-suggestions.json");

const MIN_CLUSTER = 3;
const SIM_THRESHOLD = 0.82;
const MAX_CANDIDATES = 200;
const DISTILL_EVERY = 6; // trigger after this many meaningful turns

const MEANINGFUL_TOOLS = new Set([
  "search_web", "generate_image", "generate_video", "generate_music",
  "inspect_camera", "delegate_task", "session_search", "search_memory",
]);

function isMeaningfulTool(tool: string): boolean {
  return MEANINGFUL_TOOLS.has(tool) || tool.startsWith("mcp_");
}

export interface SkillSuggestion {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  rationale: { exampleCount: number; exampleQueries: string[]; tools: string[] };
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
}

interface SuggestionStore {
  version: 1;
  suggestions: SkillSuggestion[];
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function readStore(): Promise<SuggestionStore> {
  try {
    const parsed = JSON.parse(await readFile(SUGGESTIONS_FILE, "utf8")) as Partial<SuggestionStore>;
    return { version: 1, suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [] };
  } catch {
    return { version: 1, suggestions: [] };
  }
}

async function writeStore(store: SuggestionStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const temporary = `${SUGGESTIONS_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, SUGGESTIONS_FILE);
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

// Greedy cosine clustering over normalized embedding vectors.
function cluster(vectors: number[][]): number[][] {
  const used = new Array(vectors.length).fill(false);
  const clusters: number[][] = [];
  for (let i = 0; i < vectors.length; i += 1) {
    if (used[i]) continue;
    const members = [i];
    used[i] = true;
    for (let j = i + 1; j < vectors.length; j += 1) {
      if (used[j]) continue;
      if (dot(vectors[i], vectors[j]) >= SIM_THRESHOLD) { members.push(j); used[j] = true; }
    }
    if (members.length >= MIN_CLUSTER) clusters.push(members);
  }
  return clusters;
}

// The meaningful tool shared by at least half a cluster, if any.
function dominantTool(records: ExperienceRecord[]): string | undefined {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const tool of new Set(record.tools.filter(isMeaningfulTool))) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= Math.ceil(records.length / 2) ? best[0] : undefined;
}

interface Synthesized { name: string; description: string; instructions: string; }

async function synthesizeSkill(examples: string[], tools: string[], signal?: AbortSignal): Promise<Synthesized | undefined> {
  const system = `You turn a recurring user request pattern into a reusable SKILL.md for a private voice+vision AI companion. You are given several example user requests that were handled using these tools: ${tools.join(", ") || "none"}.

Write a general, reusable skill (not tied to the specific examples' details):
- name: short kebab-case identifier (e.g. "morning-news-digest").
- description: one sentence on WHEN the agent should use this skill.
- instructions: concise step-by-step guidance capturing the workflow, including which tools to use and how, and what a good result looks like.

Respond with ONLY a JSON object: {"name": string, "description": string, "instructions": string}. If the examples are too varied to form one coherent skill, respond {"name":""}.`;
  const user = `Example requests:\n${examples.map((example) => `- ${example}`).join("\n")}`;
  for (const model of [...new Set([SMART_FAST_CHAT_MODEL, "qwen3-5-9b"])]) {
    try {
      const response = await veniceJson<{ choices?: Array<{ message?: { content?: string } }> }>(
        "/chat/completions",
        {
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_completion_tokens: 500,
          temperature: 0.2,
          response_format: { type: "json_object" },
          venice_parameters: { enable_web_search: "off", disable_thinking: true, strip_thinking_response: true },
        },
        signal,
      );
      const raw = response.choices?.[0]?.message?.content?.trim() ?? "";
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")) as Partial<Synthesized>;
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
      const instructions = typeof parsed.instructions === "string" ? parsed.instructions.trim() : "";
      if (name && description && instructions) return { name, description, instructions };
      if (parsed.name === "") return undefined;
    } catch {
      // Try the fallback model.
    }
  }
  return undefined;
}

/** Analyze recent experience and propose new skills. Returns pending suggestions. */
export async function distillSkills(agentId?: string): Promise<SkillSuggestion[]> {
  const records = (await readExperience(agentId))
    .filter((record) => record.message.length >= 12 && record.tools.some(isMeaningfulTool))
    .slice(-MAX_CANDIDATES);
  if (records.length < MIN_CLUSTER) return listSuggestions();

  let vectors: number[][];
  try {
    vectors = await embedTexts(records.map((record) => record.message));
  } catch {
    return listSuggestions();
  }

  const [installed, store] = await Promise.all([
    loadWorkspaceSkills().catch(() => []),
    readStore(),
  ]);
  const takenSlugs = new Set<string>([
    ...installed.map((skill) => skill.name),
    ...store.suggestions.map((suggestion) => suggestion.slug),
  ]);

  const created: SkillSuggestion[] = [];
  for (const members of cluster(vectors)) {
    const clusterRecords = members.map((index) => records[index]);
    const tool = dominantTool(clusterRecords);
    if (!tool) continue; // not a coherent tool workflow
    const examples = [...new Set(clusterRecords.map((record) => record.message))].slice(0, 5);
    const tools = [...new Set(clusterRecords.flatMap((record) => record.tools.filter(isMeaningfulTool)))];
    const synthesized = await synthesizeSkill(examples, tools);
    if (!synthesized) continue;
    const slug = slugify(synthesized.name);
    if (!slug || takenSlugs.has(slug)) continue;
    takenSlugs.add(slug);
    const suggestion: SkillSuggestion = {
      id: crypto.randomUUID(),
      slug,
      name: synthesized.name,
      description: synthesized.description,
      instructions: synthesized.instructions,
      rationale: { exampleCount: clusterRecords.length, exampleQueries: examples.slice(0, 3), tools },
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    created.push(suggestion);
  }

  if (created.length) {
    await serial(async () => {
      const current = await readStore();
      current.suggestions.push(...created);
      await writeStore(current);
    });
  }
  return listSuggestions();
}

export async function listSuggestions(): Promise<SkillSuggestion[]> {
  const store = await readStore();
  return store.suggestions
    .filter((suggestion) => suggestion.status === "pending")
    .sort((a, b) => b.rationale.exampleCount - a.rationale.exampleCount || b.createdAt.localeCompare(a.createdAt));
}

export async function installSuggestion(id: string): Promise<SkillSummary> {
  const store = await readStore();
  const suggestion = store.suggestions.find((candidate) => candidate.id === id);
  if (!suggestion) throw new Error("That skill suggestion no longer exists.");
  const skill = await installSkill({
    name: suggestion.name,
    description: suggestion.description,
    instructions: suggestion.instructions,
    source: { type: "catalog", origin: "distilled" },
  });
  await serial(async () => {
    const current = await readStore();
    const target = current.suggestions.find((candidate) => candidate.id === id);
    if (target) target.status = "accepted";
    await writeStore(current);
  });
  return skill;
}

export async function dismissSuggestion(id: string): Promise<void> {
  await serial(async () => {
    const store = await readStore();
    const target = store.suggestions.find((candidate) => candidate.id === id);
    if (target) target.status = "dismissed";
    await writeStore(store);
  });
}

// Called after each successful tool-using turn: log it, and every few
// meaningful turns kick off distillation in the background (non-blocking).
const globalCache = globalThis as typeof globalThis & {
  __novaDistillCounter?: number;
  __novaDistillRunning?: boolean;
};

export async function recordExperience(input: {
  agentId: string;
  conversationId: string;
  message: string;
  tools: string[];
}): Promise<void> {
  await appendExperience(input).catch(() => undefined);
  if (!input.tools.some(isMeaningfulTool)) return;
  globalCache.__novaDistillCounter = (globalCache.__novaDistillCounter ?? 0) + 1;
  if (globalCache.__novaDistillCounter < DISTILL_EVERY || globalCache.__novaDistillRunning) return;
  globalCache.__novaDistillCounter = 0;
  globalCache.__novaDistillRunning = true;
  void distillSkills(input.agentId).catch(() => undefined).finally(() => { globalCache.__novaDistillRunning = false; });
}
