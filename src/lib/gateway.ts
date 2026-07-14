import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTextSink } from "./emit-sink";
import { enqueueAgentTurn } from "./pi-agent";
import {
  readChannelsStore,
  resolveTelegramToken,
  type TelegramConfig,
} from "./channels-store";
import {
  sendTelegramMessage,
  sendTypingAction,
  startTelegramPolling,
  type TelegramInbound,
  type TelegramPoller,
} from "./channels/telegram";
import { createConversation, getConversation, getWorkspaceSnapshot } from "./workspace";

// The gateway is the hub in OpenClaw's hub-and-spoke design: it owns channel
// lifecycles, normalises inbound messages onto agent sessions, runs turns
// through the shared run queue (so a chat's turns never overlap), and routes
// replies back out. The browser UI and messaging channels are just spokes that
// share one persistent agent runtime and conversation store.

const ROOT = path.join(process.cwd(), ".gondola");
const MAP_FILE = path.join(ROOT, "channel-map.json");

interface ChannelMap {
  version: 1;
  // Maps a channel address (e.g. "telegram:12345") to a conversation id.
  sessions: Record<string, string>;
}

const globalCache = globalThis as typeof globalThis & {
  __novaTelegramPoller?: TelegramPoller | null;
};

let mapQueue: Promise<unknown> = Promise.resolve();

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = mapQueue.then(operation, operation);
  mapQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readMap(): Promise<ChannelMap> {
  try {
    const parsed = JSON.parse(await readFile(MAP_FILE, "utf8")) as Partial<ChannelMap>;
    return { version: 1, sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {} };
  } catch (error) {
    if (isNotFound(error)) return { version: 1, sessions: {} };
    throw error;
  }
}

async function writeMap(value: ChannelMap): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const temporary = `${MAP_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, MAP_FILE);
}

async function resolveConversationForAddress(address: string, agentId: string): Promise<string> {
  return serial(async () => {
    const map = await readMap();
    const existing = map.sessions[address];
    if (existing) {
      // Make sure the mapped conversation still exists.
      const ok = await getConversation(existing).then(() => true, () => false);
      if (ok) return existing;
    }
    const resolvedAgentId = agentId || (await getWorkspaceSnapshot()).defaultAgentId;
    const { conversation } = await createConversation(resolvedAgentId);
    map.sessions[address] = conversation.id;
    await writeMap(map);
    return conversation.id;
  });
}

async function runChannelTurn(input: {
  sessionId: string;
  agentId: string;
  message: string;
}): Promise<{ text: string; error?: string }> {
  const sink = createTextSink();
  try {
    await enqueueAgentTurn({
      sessionId: input.sessionId,
      agentId: input.agentId,
      message: input.message,
      emit: sink.emit,
      source: "channel",
    });
  } catch (error) {
    return { text: sink.getText(), error: error instanceof Error ? error.message : "The agent turn failed" };
  }
  return { text: sink.getText(), error: sink.getError() };
}

async function handleTelegramInbound(config: TelegramConfig, token: string, inbound: TelegramInbound): Promise<void> {
  // Authorization: only allowlisted chats may drive the agent. An empty
  // allowlist is treated as "nobody" to avoid an open relay by default.
  if (!config.allowedChatIds.includes(inbound.chatId)) {
    await sendTelegramMessage(token, inbound.chatId, `This assistant is private. Ask the owner to allow chat id ${inbound.chatId}.`);
    return;
  }
  const address = `telegram:${inbound.chatId}`;
  const sessionId = await resolveConversationForAddress(address, config.agentId);
  await sendTypingAction(token, inbound.chatId);
  const { text, error } = await runChannelTurn({ sessionId, agentId: config.agentId, message: inbound.text });
  const reply = text || (error ? `I hit an error: ${error}` : "I couldn't produce a reply just now.");
  await sendTelegramMessage(token, inbound.chatId, reply);
}

export async function startChannels(): Promise<{ telegram: boolean }> {
  const store = await readChannelsStore();
  const token = resolveTelegramToken(store.telegram);
  const shouldRunTelegram = store.telegram.enabled && token.length > 0;

  if (globalCache.__novaTelegramPoller) {
    globalCache.__novaTelegramPoller.stop();
    globalCache.__novaTelegramPoller = null;
  }

  if (shouldRunTelegram) {
    globalCache.__novaTelegramPoller = startTelegramPolling(token, (inbound) => {
      void handleTelegramInbound(store.telegram, token, inbound).catch(async () => {
        await sendTelegramMessage(token, inbound.chatId, "I couldn't process that message just now. Please try again.").catch(() => undefined);
      });
    });
  }
  return { telegram: shouldRunTelegram };
}

export function stopChannels(): void {
  if (globalCache.__novaTelegramPoller) {
    globalCache.__novaTelegramPoller.stop();
    globalCache.__novaTelegramPoller = null;
  }
}

export function isTelegramRunning(): boolean {
  return Boolean(globalCache.__novaTelegramPoller);
}

/** Deliver an out-of-band message (e.g. a scheduled result) to Telegram chats. */
export async function deliverToTelegram(text: string, chatIds?: string[]): Promise<void> {
  const store = await readChannelsStore();
  const token = resolveTelegramToken(store.telegram);
  if (!token) return;
  const targets = chatIds?.length ? chatIds : store.telegram.allowedChatIds;
  for (const chatId of targets) await sendTelegramMessage(token, chatId, text);
}
