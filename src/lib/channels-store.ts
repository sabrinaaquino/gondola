import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Persistent configuration for messaging channels (the "spokes" in OpenClaw's
// hub-and-spoke model). Secrets (bot tokens) live here or in env; they are
// never returned to the browser. The API only exposes a redacted summary.

const ROOT = path.join(process.cwd(), ".gondola");
const CHANNELS_FILE = path.join(ROOT, "channels.json");

export interface TelegramConfig {
  enabled: boolean;
  /** Bot token. Falls back to TELEGRAM_BOT_TOKEN when empty. */
  botToken: string;
  /** Chat ids allowed to talk to the agent (authorization allowlist). */
  allowedChatIds: string[];
  /** Agent profile used to answer inbound messages. */
  agentId: string;
  /** Cached @username of the verified bot, shown in the UI. */
  botUsername?: string;
}

export interface ChannelsStore {
  version: 1;
  telegram: TelegramConfig;
}

export interface TelegramConfigSummary {
  enabled: boolean;
  hasToken: boolean;
  allowedChatIds: string[];
  agentId: string;
  botUsername?: string;
}

const DEFAULT_STORE: ChannelsStore = {
  version: 1,
  telegram: { enabled: false, botToken: "", allowedChatIds: [], agentId: "" },
};

let mutationQueue: Promise<unknown> = Promise.resolve();

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function atomicWrite(value: ChannelsStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const temporary = `${CHANNELS_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, CHANNELS_FILE);
}

export async function readChannelsStore(): Promise<ChannelsStore> {
  try {
    const parsed = JSON.parse(await readFile(CHANNELS_FILE, "utf8")) as Partial<ChannelsStore>;
    const telegram = (parsed.telegram ?? {}) as Partial<TelegramConfig>;
    return {
      version: 1,
      telegram: {
        enabled: telegram.enabled === true,
        botToken: typeof telegram.botToken === "string" ? telegram.botToken : "",
        allowedChatIds: Array.isArray(telegram.allowedChatIds) ? telegram.allowedChatIds.map(String) : [],
        agentId: typeof telegram.agentId === "string" ? telegram.agentId : "",
        ...(typeof telegram.botUsername === "string" && telegram.botUsername ? { botUsername: telegram.botUsername } : {}),
      },
    };
  } catch (error) {
    if (isNotFound(error)) return structuredClone(DEFAULT_STORE);
    throw error;
  }
}

export function resolveTelegramToken(config: TelegramConfig): string {
  return config.botToken.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

export async function updateTelegramConfig(patch: Partial<TelegramConfig>): Promise<ChannelsStore> {
  return serial(async () => {
    const store = await readChannelsStore();
    store.telegram = {
      ...store.telegram,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(typeof patch.botToken === "string" ? { botToken: patch.botToken.trim() } : {}),
      ...(Array.isArray(patch.allowedChatIds)
        ? { allowedChatIds: patch.allowedChatIds.map((id) => String(id).trim()).filter(Boolean) }
        : {}),
      ...(typeof patch.agentId === "string" ? { agentId: patch.agentId } : {}),
      ...(typeof patch.botUsername === "string" ? { botUsername: patch.botUsername.trim() } : {}),
    };
    await atomicWrite(store);
    return store;
  });
}

export function summarizeTelegram(config: TelegramConfig): TelegramConfigSummary {
  return {
    enabled: config.enabled,
    hasToken: resolveTelegramToken(config).length > 0,
    allowedChatIds: config.allowedChatIds,
    agentId: config.agentId,
    ...(config.botUsername ? { botUsername: config.botUsername } : {}),
  };
}
