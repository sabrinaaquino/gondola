import type { ChannelsSnapshot } from "@/lib/app-types";
import {
  readChannelsStore,
  resolveTelegramToken,
  summarizeTelegram,
  updateTelegramConfig,
} from "@/lib/channels-store";
import { isTelegramRunning, startChannels, stopChannels } from "@/lib/gateway";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { verifyTelegramToken } from "@/lib/channels/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshot(): Promise<ChannelsSnapshot> {
  const store = await readChannelsStore();
  const summary = summarizeTelegram(store.telegram);
  return { telegram: { ...summary, running: isTelegramRunning() } };
}

// Re-attach the long-poll loop after a server (or dev) restart if the user had
// Telegram enabled. Safe to call repeatedly because startChannels() replaces any
// existing poller.
async function bootstrap(): Promise<void> {
  const store = await readChannelsStore();
  if (store.telegram.enabled && resolveTelegramToken(store.telegram) && !isTelegramRunning()) {
    await startChannels().catch(() => undefined);
  }
}

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  try {
    await bootstrap();
    return Response.json(await snapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Channels request failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: "The request body must be valid JSON" }, { status: 400 });
    }
    const action = String(body.action ?? "");

    if (action === "verify") {
      const store = await readChannelsStore();
      const provided = typeof body.botToken === "string" ? body.botToken.trim() : "";
      const token = provided || resolveTelegramToken(store.telegram);
      if (!token) return Response.json({ ok: false, error: "Add your bot token first." }, { status: 400 });
      const result = await verifyTelegramToken(token);
      if (result.ok && provided) {
        await updateTelegramConfig({ botToken: provided, ...(result.username ? { botUsername: result.username } : {}) });
      } else if (result.ok && result.username) {
        await updateTelegramConfig({ botUsername: result.username });
      }
      return Response.json({ ok: result.ok, username: result.username, error: result.error });
    }

    if (action === "update" || action === "configure") {
      const currentStore = await readChannelsStore();
      const patch: Parameters<typeof updateTelegramConfig>[0] = {};
      if (typeof body.botToken === "string") patch.botToken = body.botToken.trim();
      if (typeof body.agentId === "string") patch.agentId = body.agentId;
      if (Array.isArray(body.allowedChatIds)) patch.allowedChatIds = body.allowedChatIds.map(String);
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

      // When a new token arrives, verify it so we can store the @username and
      // fail fast on a bad token before enabling the channel.
      if (typeof patch.botToken === "string" && patch.botToken) {
        const check = await verifyTelegramToken(patch.botToken);
        if (!check.ok) return Response.json({ error: check.error ?? "Telegram rejected that bot token." }, { status: 422 });
        patch.botUsername = check.username ?? "";
      }

      const nextConfig = { ...currentStore.telegram, ...patch };
      const nextToken = resolveTelegramToken(nextConfig);
      if (nextConfig.enabled && !nextToken) {
        return Response.json({ error: "Add a valid Telegram bot token before enabling the channel." }, { status: 400 });
      }
      if (nextConfig.enabled && !nextConfig.agentId) {
        return Response.json({ error: "Choose which agent should answer on Telegram." }, { status: 400 });
      }

      await updateTelegramConfig(patch);
      const store = await readChannelsStore();
      const token = resolveTelegramToken(store.telegram);

      if (store.telegram.enabled && token) {
        await startChannels();
      } else {
        stopChannels();
      }
      return Response.json(await snapshot());
    }

    if (action === "disconnect") {
      await updateTelegramConfig({ enabled: false, botToken: "", botUsername: "", allowedChatIds: [] });
      stopChannels();
      return Response.json(await snapshot());
    }

    return Response.json({ error: "Unknown channels action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Channels update failed" }, { status: 400 });
  }
}
