import { abortAgentTurn, enqueueAgentTurn } from "@/lib/pi-agent";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { toPublicError } from "@/lib/venice";
import type { AgentSettings } from "@/lib/app-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface AgentRequest {
  sessionId?: string;
  agentId?: string;
  message?: string;
  messageId?: string;
  frameDataUrl?: string;
  attachmentImageUrls?: string[];
  hidden?: boolean;
  voiceMode?: boolean;
  settings?: Partial<AgentSettings>;
}

const MAX_MESSAGE_CHARS = 8_000;
const MAX_FRAME_CHARS = 2_500_000; // ~1.8MB of base64 image data
const MAX_ATTACHMENT_IMAGES = 4;

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  let body: AgentRequest;
  try {
    body = (await request.json()) as AgentRequest;
  } catch {
    return Response.json({ error: "The request body must be valid JSON" }, { status: 400 });
  }
  const message = body.message?.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!body.sessionId || typeof body.sessionId !== "string" || !message) {
    return Response.json({ error: "sessionId and message are required" }, { status: 400 });
  }
  const frameDataUrl = typeof body.frameDataUrl === "string"
    && body.frameDataUrl.startsWith("data:image/")
    && body.frameDataUrl.length <= MAX_FRAME_CHARS
    ? body.frameDataUrl
    : undefined;
  const attachmentImageUrls = Array.isArray(body.attachmentImageUrls)
    ? body.attachmentImageUrls
      .filter((url): url is string => typeof url === "string" && url.startsWith("data:image/") && url.length <= MAX_FRAME_CHARS)
      .slice(0, MAX_ATTACHMENT_IMAGES)
    : undefined;

  const encoder = new TextEncoder();
  const sessionId = body.sessionId;
  const turnController = new AbortController();
  let closed = false;
  const abortTurn = () => {
    if (!turnController.signal.aborted) turnController.abort();
    closed = true;
    abortAgentTurn(sessionId);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const emit = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          abortTurn();
        }
      };
      // Stop the in-flight Venice work when the browser abandons the request.
      request.signal.addEventListener("abort", abortTurn, { once: true });
      if (request.signal.aborted) abortTurn();

      void (async () => {
        try {
          emit({ type: "agent_start" });
          heartbeat = setInterval(() => emit({ type: "heartbeat", at: Date.now(), status: "Still working" }), 7_500);
          // Route interactive turns through the shared run queue. `interrupt`
          // gives the live user barge-in over any in-flight turn for this
          // session (e.g. an ambient or scheduled turn) while still serializing.
          await enqueueAgentTurn({
            sessionId,
            agentId: body.agentId,
            message,
            messageId: typeof body.messageId === "string" ? body.messageId : undefined,
            frameDataUrl,
            attachmentImageUrls,
            hidden: body.hidden,
            voiceMode: body.voiceMode,
            settings: body.settings,
            emit,
            source: "interactive",
            interrupt: true,
            signal: turnController.signal,
          });
          emit({ type: "done" });
        } catch (error) {
          const publicError = toPublicError(error);
          emit({ type: "error", ...publicError });
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          request.signal.removeEventListener("abort", abortTurn);
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      abortTurn();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
