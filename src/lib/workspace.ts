import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSkills, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type {
  AgentProfile,
  ConversationSummary,
  McpServerSummary,
  McpToolSummary,
  SkillSummary,
  WorkspaceMessage,
  WorkspaceSnapshot,
} from "./app-types";
import { removeSessionFromIndex, searchIndex } from "./search-index";
import { removeEmDashes } from "./text-style";
import { deleteTranscript } from "./transcript";
import { removeConversationVectors } from "./vector-store";

const ROOT = path.join(process.cwd(), ".gondola");
const WORKSPACE_FILE = path.join(ROOT, "workspace.json");
const CHAT_DIR = path.join(ROOT, "chats");
const LEGACY_SESSION_DIR = path.join(ROOT, "sessions");
export const SKILL_DIR = path.join(ROOT, "skills");
export const DEFAULT_AGENT_ID = "nova-default";

export interface McpServerConfig extends Omit<McpServerSummary, "headerKeys" | "envKeys"> {
  headers: Record<string, string>;
  env: Record<string, string>;
}

interface WorkspaceStore {
  version: 1;
  agents: AgentProfile[];
  conversations: ConversationSummary[];
  mcpServers: McpServerConfig[];
  activeConversationId: string;
  migratedLegacySessions: boolean;
  migratedUnnamedEntity: boolean;
}

interface ConversationFile {
  version: 1;
  messages: WorkspaceMessage[];
}

let mutationQueue: Promise<unknown> = Promise.resolve();
let cachedStore: WorkspaceStore | undefined;
let storeLoadPromise: Promise<WorkspaceStore> | undefined;
let cachedSkills: Skill[] | undefined;

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function now(): string {
  return new Date().toISOString();
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function defaultAgent(): AgentProfile {
  const timestamp = now();
  return {
    id: DEFAULT_AGENT_ID,
    name: "Entity",
    description: "An unnamed, perceptive voice and vision companion.",
    instructions: "Be warm, observant, concise, and natural in spoken conversation. You do not have a chosen name yet; invite the user to name you at a natural moment, then use rewrite_self to persist the name they choose.",
    skillIds: [],
    mcpServerIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function newConversationSummary(agentId: string): ConversationSummary {
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    agentId,
    title: "New conversation",
    lastMessage: "",
    messageCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function ensureDirectories(): Promise<void> {
  await Promise.all([
    mkdir(ROOT, { recursive: true }),
    mkdir(CHAT_DIR, { recursive: true }),
    mkdir(LEGACY_SESSION_DIR, { recursive: true }),
    mkdir(SKILL_DIR, { recursive: true }),
  ]);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function chatPath(conversationId: string): string {
  return path.join(CHAT_DIR, `${safeId(conversationId)}.json`);
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function readConversationFile(conversationId: string): Promise<ConversationFile> {
  await ensureDirectories();
  try {
    const parsed = JSON.parse(await readFile(chatPath(conversationId), "utf8")) as Partial<ConversationFile>;
    const originalMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    let changed = false;
    const messages = originalMessages.map((message) => {
      if (message.role !== "assistant") return message;
      const text = removeEmDashes(message.text);
      if (text === message.text) return message;
      changed = true;
      return { ...message, text };
    });
    const file = { version: 1 as const, messages };
    if (changed) await atomicWrite(chatPath(conversationId), file);
    return file;
  } catch (error) {
    if (isNotFound(error)) return { version: 1, messages: [] };
    throw new Error(`Conversation ${conversationId} could not be read safely.`, { cause: error });
  }
}

function conversationTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New conversation";
  const words = clean.split(" ").slice(0, 8).join(" ");
  return words.length > 56 ? `${words.slice(0, 53).trim()}…` : words;
}

async function migrateLegacySessions(store: WorkspaceStore): Promise<boolean> {
  if (store.migratedLegacySessions) return false;
  const known = new Set(store.conversations.map((conversation) => conversation.id));
  const files = await readdir(LEGACY_SESSION_DIR).catch(() => []);
  for (const file of files.filter((entry) => entry.endsWith(".jsonl")).slice(-200)) {
    const sessionId = file.slice(0, -6);
    if (known.has(sessionId)) continue;
    const lines = (await readFile(path.join(LEGACY_SESSION_DIR, file), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    const messages: WorkspaceMessage[] = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { role?: unknown; text?: unknown; createdAt?: unknown };
        if ((record.role !== "user" && record.role !== "assistant") || typeof record.text !== "string") continue;
        messages.push({
          id: crypto.randomUUID(),
          role: record.role,
          text: record.text,
          createdAt: typeof record.createdAt === "string" ? Date.parse(record.createdAt) : Date.now(),
        });
      } catch {
        // Ignore a partial legacy line.
      }
    }
    if (!messages.length) continue;
    const createdAt = new Date(messages[0].createdAt).toISOString();
    const updatedAt = new Date(messages.at(-1)?.createdAt ?? messages[0].createdAt).toISOString();
    const firstUser = messages.find((message) => message.role === "user")?.text ?? "Previous conversation";
    store.conversations.push({
      id: sessionId,
      agentId: DEFAULT_AGENT_ID,
      title: conversationTitle(firstUser),
      lastMessage: messages.at(-1)?.text.slice(0, 180) ?? "",
      messageCount: messages.length,
      createdAt,
      updatedAt,
    });
    await atomicWrite(chatPath(sessionId), { version: 1, messages } satisfies ConversationFile);
  }
  store.migratedLegacySessions = true;
  return true;
}

function migrateUnnamedEntity(store: WorkspaceStore): boolean {
  if (store.migratedUnnamedEntity) return false;
  const index = store.agents.findIndex((agent) => agent.id === DEFAULT_AGENT_ID);
  if (index >= 0 && store.agents[index].name.trim().toLowerCase() === "nova") {
    const current = store.agents[index];
    store.agents[index] = {
      ...current,
      name: "Entity",
      description: "An unnamed, perceptive voice and vision companion.",
      instructions: "Be warm, observant, concise, and natural in spoken conversation. You do not have a chosen name yet; invite the user to name you at a natural moment, then use rewrite_self to persist the name they choose.",
      updatedAt: now(),
    };
  }
  store.migratedUnnamedEntity = true;
  return true;
}

async function loadStoreFromDisk(): Promise<WorkspaceStore> {
  if (cachedStore) return structuredClone(cachedStore);
  await ensureDirectories();
  let store: WorkspaceStore;
  try {
    const parsed = JSON.parse(await readFile(WORKSPACE_FILE, "utf8")) as Partial<WorkspaceStore>;
    const agents = Array.isArray(parsed.agents) && parsed.agents.length ? parsed.agents : [defaultAgent()];
    const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
    store = {
      version: 1,
      agents,
      conversations,
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
      activeConversationId: typeof parsed.activeConversationId === "string" ? parsed.activeConversationId : "",
      migratedLegacySessions: parsed.migratedLegacySessions === true,
      migratedUnnamedEntity: parsed.migratedUnnamedEntity === true,
    };
  } catch (error) {
    if (!isNotFound(error)) {
      throw new Error("The local workspace file could not be read safely.", { cause: error });
    }
    store = {
      version: 1,
      agents: [defaultAgent()],
      conversations: [],
      mcpServers: [],
      activeConversationId: "",
      migratedLegacySessions: false,
      migratedUnnamedEntity: false,
    };
  }

  let changed = migrateUnnamedEntity(store);
  store.conversations = store.conversations.map((conversation) => {
    const lastMessage = removeEmDashes(conversation.lastMessage);
    if (lastMessage === conversation.lastMessage) return conversation;
    changed = true;
    return { ...conversation, lastMessage };
  });
  changed = await migrateLegacySessions(store) || changed;
  if (!store.conversations.length) {
    const conversation = newConversationSummary(store.agents[0].id);
    store.conversations.push(conversation);
    store.activeConversationId = conversation.id;
    await atomicWrite(chatPath(conversation.id), { version: 1, messages: [] } satisfies ConversationFile);
    changed = true;
  }
  if (!store.conversations.some((conversation) => conversation.id === store.activeConversationId)) {
    store.activeConversationId = [...store.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
    changed = true;
  }
  if (changed) await atomicWrite(WORKSPACE_FILE, store);
  cachedStore = structuredClone(store);
  return structuredClone(store);
}

async function readStore(): Promise<WorkspaceStore> {
  if (cachedStore) return structuredClone(cachedStore);
  const pending = storeLoadPromise ?? loadStoreFromDisk();
  storeLoadPromise = pending;
  try {
    return structuredClone(await pending);
  } finally {
    if (storeLoadPromise === pending) storeLoadPromise = undefined;
  }
}

async function writeStore(store: WorkspaceStore): Promise<void> {
  await ensureDirectories();
  await atomicWrite(WORKSPACE_FILE, store);
  cachedStore = structuredClone(store);
}

export async function loadWorkspaceSkills(force = false): Promise<Skill[]> {
  if (cachedSkills && !force) return cachedSkills;
  await ensureDirectories();
  const environment = new NodeExecutionEnv({ cwd: process.cwd() });
  const result = await loadSkills(environment, SKILL_DIR);
  cachedSkills = result.skills;
  return cachedSkills;
}

function publicMcp(server: McpServerConfig): McpServerSummary {
  const { headers, env, ...safe } = server;
  return {
    ...safe,
    headerKeys: Object.keys(headers),
    envKeys: Object.keys(env),
  };
}

export async function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const [store, skills] = await Promise.all([readStore(), loadWorkspaceSkills()]);
  return {
    agents: [...store.agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    conversations: [...store.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    skills: skills.map((skill): SkillSummary => ({ id: skill.name, name: skill.name, description: skill.description, filePath: skill.filePath })),
    mcpServers: store.mcpServers.map(publicMcp),
    defaultAgentId: store.agents[0]?.id ?? DEFAULT_AGENT_ID,
    activeConversationId: store.activeConversationId,
  };
}

export async function getConversation(conversationId: string): Promise<{ conversation: ConversationSummary; messages: WorkspaceMessage[] }> {
  const store = await readStore();
  const conversation = store.conversations.find((candidate) => candidate.id === conversationId);
  if (!conversation) throw new Error("Conversation not found");
  const file = await readConversationFile(conversationId);
  return { conversation, messages: file.messages };
}

export async function createConversation(agentId: string): Promise<{ conversation: ConversationSummary; messages: WorkspaceMessage[] }> {
  return serial(async () => {
    const store = await readStore();
    if (!store.agents.some((agent) => agent.id === agentId)) throw new Error("Agent not found");
    const conversation = newConversationSummary(agentId);
    store.conversations.push(conversation);
    store.activeConversationId = conversation.id;
    await Promise.all([
      writeStore(store),
      atomicWrite(chatPath(conversation.id), { version: 1, messages: [] } satisfies ConversationFile),
    ]);
    return { conversation, messages: [] };
  });
}

export async function setActiveConversation(conversationId: string): Promise<void> {
  return serial(async () => {
    const store = await readStore();
    if (!store.conversations.some((conversation) => conversation.id === conversationId)) throw new Error("Conversation not found");
    store.activeConversationId = conversationId;
    await writeStore(store);
  });
}

export async function deleteConversation(conversationId: string): Promise<{ activeConversationId: string; deletedWasActive: boolean }> {
  return serial(async () => {
    const store = await readStore();
    const index = store.conversations.findIndex((conversation) => conversation.id === conversationId);
    if (index === -1) throw new Error("Conversation not found");
    const [deleted] = store.conversations.splice(index, 1);
    const deletedWasActive = store.activeConversationId === conversationId;

    let replacement: ConversationSummary | undefined;
    if (!store.conversations.length) {
      replacement = newConversationSummary(deleted.agentId || store.agents[0]?.id || DEFAULT_AGENT_ID);
      store.conversations.push(replacement);
    }
    if (deletedWasActive || !store.conversations.some((conversation) => conversation.id === store.activeConversationId)) {
      store.activeConversationId = [...store.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
    }

    await writeStore(store);
    await Promise.all([
      unlink(chatPath(conversationId)).catch(() => undefined),
      unlink(path.join(LEGACY_SESSION_DIR, `${safeId(conversationId)}.jsonl`)).catch(() => undefined),
      deleteTranscript(conversationId).catch(() => undefined),
      removeSessionFromIndex(conversationId).catch(() => undefined),
      removeConversationVectors(conversationId).catch(() => undefined),
      replacement
        ? atomicWrite(chatPath(replacement.id), { version: 1, messages: [] } satisfies ConversationFile)
        : Promise.resolve(),
    ]);
    return { activeConversationId: store.activeConversationId, deletedWasActive };
  });
}

export async function appendConversationMessage(
  conversationId: string,
  message: WorkspaceMessage,
): Promise<ConversationSummary> {
  return serial(async () => {
    const store = await readStore();
    const index = store.conversations.findIndex((conversation) => conversation.id === conversationId);
    if (index === -1) throw new Error("Conversation not found");
    const file = await readConversationFile(conversationId);
    const storedMessage = message.role === "assistant"
      ? { ...message, text: removeEmDashes(message.text) }
      : message;
    if (!file.messages.some((candidate) => candidate.id === storedMessage.id)) file.messages.push(storedMessage);
    const summary = { ...store.conversations[index] };
    const firstUser = file.messages.find((candidate) => candidate.role === "user");
    summary.title = firstUser ? conversationTitle(firstUser.text) : summary.title;
    summary.lastMessage = storedMessage.text.replace(/\s+/g, " ").trim().slice(0, 180);
    summary.messageCount = file.messages.length;
    summary.updatedAt = new Date(storedMessage.createdAt).toISOString();
    store.conversations[index] = summary;
    store.activeConversationId = conversationId;
    await Promise.all([atomicWrite(chatPath(conversationId), file), writeStore(store)]);
    return summary;
  });
}

/**
 * Rewind a conversation to just before the message with `messageId`: that
 * message and everything after it is dropped. Used by "edit and resend", where
 * the edited message is re-sent as a fresh turn so the conversation continues
 * from that point. Returns how many messages remain and were removed.
 */
export async function rewindConversation(
  conversationId: string,
  messageId: string,
): Promise<{ kept: number; removed: number; found: boolean }> {
  return serial(async () => {
    const store = await readStore();
    const index = store.conversations.findIndex((conversation) => conversation.id === conversationId);
    if (index === -1) throw new Error("Conversation not found");
    const file = await readConversationFile(conversationId);
    const cut = file.messages.findIndex((candidate) => candidate.id === messageId);
    if (cut === -1) return { kept: file.messages.length, removed: 0, found: false };
    const removed = file.messages.length - cut;
    file.messages = file.messages.slice(0, cut);
    const summary = { ...store.conversations[index] };
    const firstUser = file.messages.find((candidate) => candidate.role === "user");
    summary.title = firstUser ? conversationTitle(firstUser.text) : "New chat";
    const last = file.messages[file.messages.length - 1];
    summary.lastMessage = last ? last.text.replace(/\s+/g, " ").trim().slice(0, 180) : "";
    summary.messageCount = file.messages.length;
    summary.updatedAt = new Date().toISOString();
    store.conversations[index] = summary;
    await Promise.all([atomicWrite(chatPath(conversationId), file), writeStore(store)]);
    return { kept: file.messages.length, removed, found: true };
  });
}

export async function createAgent(input: {
  name: string;
  description?: string;
  instructions?: string;
  skillIds?: string[];
  mcpServerIds?: string[];
  memoryIsolated?: boolean;
}): Promise<AgentProfile> {
  return serial(async () => {
    const store = await readStore();
    const name = input.name.replace(/\s+/g, " ").trim().slice(0, 48);
    if (!name) throw new Error("Agent name is required");
    const timestamp = now();
    const agent: AgentProfile = {
      id: crypto.randomUUID(),
      name,
      description: input.description?.trim().slice(0, 180) || "A custom Venice agent",
      instructions: input.instructions?.trim().slice(0, 4_000) || "Be helpful, natural, and concise.",
      skillIds: [...new Set(input.skillIds ?? [])],
      mcpServerIds: [...new Set(input.mcpServerIds ?? [])],
      memoryIsolated: input.memoryIsolated ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.agents.push(agent);
    await writeStore(store);
    return agent;
  });
}

export async function updateAgent(input: Partial<AgentProfile> & { id: string }): Promise<AgentProfile> {
  return serial(async () => {
    const store = await readStore();
    const index = store.agents.findIndex((agent) => agent.id === input.id);
    if (index === -1) throw new Error("Agent not found");
    const current = store.agents[index];
    const next: AgentProfile = {
      ...current,
      ...(typeof input.name === "string" ? { name: input.name.replace(/\s+/g, " ").trim().slice(0, 48) || current.name } : {}),
      ...(typeof input.description === "string" ? { description: input.description.trim().slice(0, 180) } : {}),
      ...(typeof input.instructions === "string" ? { instructions: input.instructions.trim().slice(0, 4_000) } : {}),
      ...(Array.isArray(input.skillIds) ? { skillIds: [...new Set(input.skillIds)] } : {}),
      ...(Array.isArray(input.mcpServerIds) ? { mcpServerIds: [...new Set(input.mcpServerIds)] } : {}),
      ...(typeof input.memoryIsolated === "boolean" ? { memoryIsolated: input.memoryIsolated } : {}),
      updatedAt: now(),
    };
    store.agents[index] = next;
    await writeStore(store);
    return next;
  });
}

function slugifySkillName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export interface SkillSource {
  type: "manual" | "catalog" | "paste" | "url";
  origin?: string;
}

// Parse a SKILL.md's YAML frontmatter (name/description) and body. Skills are
// distributed as this single markdown file (Cursor / OpenClaw / Pi format), so
// installing from a catalog entry, a pasted file, or a URL all funnel through
// here rather than three separate form fields.
export function parseSkillMarkdown(markdown: string): { name?: string; description?: string; body: string } {
  const match = markdown.match(/^\uFEFF?\s*---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { body: markdown.trim() };
  const [, frontmatter, body] = match;
  const field = (key: string): string | undefined => {
    const line = frontmatter.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m"))?.[1];
    return line ? line.replace(/^["']|["']$/g, "").trim() : undefined;
  };
  return { name: field("name"), description: field("description"), body: body.trim() };
}

// Non-serialized core: callers must hold the mutation queue (serial()).
async function performSkillInstall(input: {
  name?: string;
  description?: string;
  body?: string;
  source: SkillSource;
}): Promise<SkillSummary> {
  const slug = slugifySkillName(input.name ?? "");
  const description = (input.description ?? "").replace(/\s+/g, " ").trim().slice(0, 1_024);
  const body = (input.body ?? "").trim().slice(0, 20_000);
  if (!slug) throw new Error("A skill name is required. Add a `name:` line to the SKILL.md.");
  if (!description) throw new Error("A skill description is required. Add a `description:` line to the SKILL.md.");
  if (!body) throw new Error("The skill has no instructions in its body.");
  const existing = await loadWorkspaceSkills(true);
  if (existing.some((skill) => skill.name === slug)) throw new Error(`A skill named "${slug}" is already installed.`);
  const directory = path.join(SKILL_DIR, slug);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`,
    "utf8",
  );
  // Record where the skill came from so it can be re-synced/updated later.
  await writeFile(
    path.join(directory, "source.json"),
    `${JSON.stringify({ ...input.source, installedAt: now() }, null, 2)}\n`,
    "utf8",
  ).catch(() => undefined);
  cachedSkills = undefined;
  const skills = await loadWorkspaceSkills(true);
  const skill = skills.find((candidate) => candidate.name === slug);
  if (!skill) throw new Error("The skill could not be validated by the Pi harness");
  return { id: skill.name, name: skill.name, description: skill.description, filePath: skill.filePath };
}

export async function createSkill(input: { name: string; description: string; instructions: string }): Promise<SkillSummary> {
  return serial(() => performSkillInstall({
    name: input.name,
    description: input.description,
    body: input.instructions,
    source: { type: "manual" },
  }));
}

// Install a skill from a full SKILL.md (a catalog entry or pasted file), with
// optional field overrides (e.g. a chosen install name to avoid slug clashes).
export async function installSkill(input: {
  markdown?: string;
  name?: string;
  description?: string;
  instructions?: string;
  source?: SkillSource;
}): Promise<SkillSummary> {
  return serial(() => {
    const parsed = input.markdown ? parseSkillMarkdown(input.markdown) : { name: undefined, description: undefined, body: undefined };
    return performSkillInstall({
      name: input.name ?? parsed.name,
      description: input.description ?? parsed.description,
      body: input.instructions ?? parsed.body,
      source: input.source ?? { type: input.markdown ? "paste" : "manual" },
    });
  });
}

// Resolve a user-supplied source into candidate raw SKILL.md URLs, supporting
// github.com blob/tree links, `owner/repo` and `git:owner/repo` shorthands, and
// direct raw/gist URLs.
function toRawSkillCandidates(source: string): string[] {
  const value = source.trim().replace(/^git(?:hub)?:/i, "");
  // A GitHub blob/tree link to a specific file or folder.
  const blob = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/i);
  if (blob) {
    const [, owner, repo, ref, rest] = blob;
    const cleaned = repo.replace(/\.git$/, "");
    const filePath = /\.md$/i.test(rest) ? rest : `${rest.replace(/\/$/, "")}/SKILL.md`;
    return [`https://raw.githubusercontent.com/${owner}/${cleaned}/${ref}/${filePath}`];
  }
  // A repo root as owner/repo, github.com/owner/repo, or https://github.com/owner/repo.
  const host = value.replace(/^https?:\/\//i, "");
  const repo = host.match(/^(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const looksLikeGithubRepo = /^github\.com\//i.test(host) || (!/^https?:\/\//i.test(value) && Boolean(repo));
  if (repo && looksLikeGithubRepo) {
    const [, owner, name] = repo;
    return ["HEAD", "main", "master"].map((ref) => `https://raw.githubusercontent.com/${owner}/${name}/${ref}/SKILL.md`);
  }
  // Any other explicit URL (raw file, gist, self-hosted) is used directly.
  if (/^https?:\/\//i.test(value)) return [value];
  throw new Error("Enter a GitHub repo (owner/repo), a link to a SKILL.md, or a raw URL.");
}

// A bare `owner/repo` or a github.com repo root (not a /blob/ or /tree/ link to
// a specific file/folder). Used to fall back to whole-repo discovery.
function parseGithubRepoRoot(source: string): { owner: string; name: string } | undefined {
  const value = source.trim().replace(/^git(?:hub)?:/i, "");
  if (/\/(?:blob|tree)\//i.test(value)) return undefined;
  const host = value.replace(/^https?:\/\//i, "");
  const match = host.match(/^(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const looksLikeGithub = /^github\.com\//i.test(host) || !/^https?:\/\//i.test(value);
  if (match && looksLikeGithub) return { owner: match[1], name: match[2].replace(/\.git$/, "") };
  return undefined;
}

// Find every SKILL.md in a repo via the GitHub tree API. Some repos (e.g.
// veniceai/skills) are a collection with each skill under skills/<name>/SKILL.md
// and no root SKILL.md, so a single root fetch always 404s.
async function findRepoSkillPaths(owner: string, name: string): Promise<{ ref: string; paths: string[] }> {
  for (const ref of ["main", "master"]) {
    try {
      const response = await fetch(`https://api.github.com/repos/${owner}/${name}/git/trees/${ref}?recursive=1`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "nova-skill-installer" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) continue;
      const data = await response.json() as { tree?: Array<{ path?: string; type?: string }> };
      const paths = (data.tree ?? [])
        .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && /(^|\/)SKILL\.md$/i.test(entry.path))
        .map((entry) => entry.path as string)
        .sort();
      if (paths.length) return { ref, paths };
    } catch {
      // Try the next ref.
    }
  }
  return { ref: "main", paths: [] };
}

async function installSkillsFromRepo(owner: string, name: string, origin: string): Promise<SkillSummary[]> {
  const { ref, paths } = await findRepoSkillPaths(owner, name);
  if (!paths.length) return [];
  const installed: SkillSummary[] = [];
  let duplicates = 0;
  let lastError = "";
  for (const filePath of paths) {
    try {
      const raw = `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${filePath}`;
      const response = await fetch(raw, { redirect: "follow", signal: AbortSignal.timeout(12_000) });
      if (!response.ok) continue;
      const text = (await response.text()).slice(0, 200_000);
      if (!text.trim()) continue;
      installed.push(await installSkill({ markdown: text, source: { type: "url", origin: `${origin} · ${filePath}` } }));
    } catch (error) {
      if (error instanceof Error && /already installed/i.test(error.message)) duplicates += 1;
      else lastError = error instanceof Error ? error.message : lastError;
    }
  }
  if (!installed.length) {
    if (duplicates) throw new Error(`All ${duplicates} skill${duplicates === 1 ? "" : "s"} in ${owner}/${name} are already installed.`);
    if (lastError) throw new Error(lastError);
  }
  return installed;
}

// Install a skill straight from the ClawHub registry (@owner/slug). ClawHub
// returns the full SKILL.md in the skill record, so this is a single fetch.
export async function installSkillFromHub(slug: string, owner?: string): Promise<SkillSummary> {
  const { fetchClawHubSkillMarkdown } = await import("./clawhub");
  const { markdown, ref } = await fetchClawHubSkillMarkdown(slug, owner);
  return installSkill({ markdown, source: { type: "url", origin: `clawhub:${ref}` } });
}

export async function installSkillFromUrl(source: string): Promise<SkillSummary[]> {
  const candidates = toRawSkillCandidates(source);
  let lastError = "Could not fetch a SKILL.md from that source.";
  // 1) A direct file, a blob/tree link, or a repo whose root holds a SKILL.md.
  for (const url of candidates) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(12_000) });
      if (!response.ok) { lastError = `Fetch failed (${response.status}) for ${url}`; continue; }
      const text = (await response.text()).slice(0, 200_000);
      if (!text.trim()) { lastError = "The fetched SKILL.md was empty."; continue; }
      return [await installSkill({ markdown: text, source: { type: "url", origin: source } })];
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
  }
  // 2) A repo with no root SKILL.md but many skills in subfolders: install them all.
  const repo = parseGithubRepoRoot(source);
  if (repo) {
    const installed = await installSkillsFromRepo(repo.owner, repo.name, source);
    if (installed.length) return installed;
  }
  throw new Error(lastError);
}

export async function saveMcpServer(input: {
  id?: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  tools?: McpToolSummary[];
  instructions?: string;
  status?: McpServerSummary["status"];
  lastError?: string;
}): Promise<McpServerSummary> {
  return serial(async () => {
    const store = await readStore();
    const existingIndex = input.id ? store.mcpServers.findIndex((server) => server.id === input.id) : -1;
    const timestamp = now();
    const current = existingIndex >= 0 ? store.mcpServers[existingIndex] : undefined;
    const server: McpServerConfig = {
      id: current?.id ?? crypto.randomUUID(),
      name: input.name.replace(/\s+/g, " ").trim().slice(0, 64) || current?.name || "MCP server",
      transport: input.transport,
      ...(input.transport === "http"
        ? { url: input.url?.trim() ?? current?.url }
        : { command: input.command?.trim() ?? current?.command, args: input.args ?? current?.args ?? [] }),
      headers: input.headers ?? current?.headers ?? {},
      env: input.env ?? current?.env ?? {},
      tools: input.tools ?? current?.tools ?? [],
      instructions: input.instructions ?? current?.instructions,
      status: input.status ?? current?.status ?? "untested",
      lastError: input.lastError,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (server.transport === "http" && !server.url) throw new Error("MCP URL is required");
    if (server.transport === "stdio" && !server.command) throw new Error("MCP command is required");
    if (existingIndex >= 0) store.mcpServers[existingIndex] = server;
    else store.mcpServers.push(server);
    await writeStore(store);
    return publicMcp(server);
  });
}

export async function getAgentRuntime(agentId: string): Promise<{ agent: AgentProfile; skills: Skill[]; mcpServers: McpServerConfig[]; fingerprint: string }> {
  const [store, allSkills] = await Promise.all([readStore(), loadWorkspaceSkills()]);
  const agent = store.agents.find((candidate) => candidate.id === agentId) ?? store.agents[0];
  const skills = allSkills.filter((skill) => agent.skillIds.includes(skill.name));
  const mcpServers = store.mcpServers.filter((server) => agent.mcpServerIds.includes(server.id) && server.status === "connected");
  const fingerprint = JSON.stringify({
    agent: { id: agent.id, name: agent.name, instructions: agent.instructions, updatedAt: agent.updatedAt },
    skills: skills.map((skill) => [skill.name, skill.description]),
    mcps: mcpServers.map((server) => [server.id, server.updatedAt, server.tools.map((tool) => tool.name)]),
  });
  return { agent, skills, mcpServers, fingerprint };
}

export async function getMcpServerConfig(serverId: string): Promise<McpServerConfig> {
  const store = await readStore();
  const server = store.mcpServers.find((candidate) => candidate.id === serverId);
  if (!server) throw new Error("MCP server not found");
  return server;
}

export async function searchConversationHistory(query: string, limit = 5, agentId?: string): Promise<Array<WorkspaceMessage & { conversationId: string }>> {
  // Prefer the SQLite + FTS5 index (relevance-ranked). Fall back to the legacy
  // term-overlap scan when the index is unavailable or has no hits (e.g. for
  // conversations recorded before the index existed).
  const indexed = await searchIndex(query, limit, agentId).catch(() => undefined);
  if (indexed && indexed.length) {
    return indexed.map((match) => ({
      id: match.id,
      role: match.role,
      text: match.text,
      createdAt: match.createdAt,
      conversationId: match.sessionId,
    }));
  }

  const store = await readStore();
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  if (!terms.length) return [];
  const conversations = store.conversations
    .filter((conversation) => !agentId || conversation.agentId === agentId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100);
  const matches: Array<WorkspaceMessage & { conversationId: string; score: number }> = [];
  for (const conversation of conversations) {
    const file = await readConversationFile(conversation.id);
    for (const message of file.messages) {
      const lower = message.text.toLowerCase();
      const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
      if (score) matches.push({ ...message, conversationId: conversation.id, score });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
    .slice(0, Math.max(1, Math.min(limit, 10)))
    .map(({ score: _score, ...match }) => match);
}
