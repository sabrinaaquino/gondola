// Telegram channel adapter.
//
// Implements the minimal Telegram Bot API surface needed to act as an OpenClaw
// style "channel": long-poll getUpdates for inbound messages and sendMessage
// for replies. The adapter is transport-only and normalises inbound messages
// and hands them to an injected callback, and knows nothing about the agent.

const TELEGRAM_MAX_MESSAGE = 4_000;

export interface TelegramInbound {
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  messageId: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number };
    text?: string;
  };
}

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  // Telegram rejects messages over ~4096 chars; split on paragraph boundaries.
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > TELEGRAM_MAX_MESSAGE) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE);
    if (cut < TELEGRAM_MAX_MESSAGE * 0.5) cut = TELEGRAM_MAX_MESSAGE;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  chunks.push(remaining);

  for (const chunk of chunks) {
    const response = await fetch(apiUrl(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { description?: string };
      throw new Error(payload.description ?? `Telegram could not deliver the message (${response.status})`);
    }
  }
}

export async function sendTypingAction(token: string, chatId: string): Promise<void> {
  await fetch(apiUrl(token, "sendChatAction"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => undefined);
}

export interface TelegramPoller {
  stop: () => void;
  done: Promise<void>;
}

/**
 * Start the long-poll loop. Returns a handle whose `stop()` ends the loop and
 * whose `done` resolves once the loop has fully exited.
 */
export function startTelegramPolling(
  token: string,
  onInbound: (message: TelegramInbound) => void,
): TelegramPoller {
  const controller = new AbortController();
  let offset = 0;

  const loop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(
          `${apiUrl(token, "getUpdates")}?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          await delay(3_000, controller.signal);
          continue;
        }
        const payload = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] };
        for (const update of payload.result ?? []) {
          offset = Math.max(offset, update.update_id + 1);
          const message = update.message;
          if (!message?.text || !message.from) continue;
          onInbound({
            chatId: String(message.chat.id),
            userId: String(message.from.id),
            userName: message.from.username || message.from.first_name || "user",
            text: message.text,
            messageId: message.message_id,
          });
        }
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) break;
        await delay(3_000, controller.signal);
      }
    }
  };

  const done = loop();
  return { stop: () => controller.abort(), done };
}

export async function verifyTelegramToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const response = await fetch(apiUrl(token, "getMe"), { signal: AbortSignal.timeout(15_000) });
    const payload = (await response.json()) as { ok: boolean; result?: { username?: string }; description?: string };
    if (!response.ok || !payload.ok) return { ok: false, error: payload.description ?? "Telegram rejected the token" };
    return { ok: true, username: payload.result?.username };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Telegram request failed" };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
