import { toPublicError, veniceFetch } from "@/lib/venice";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SpeechPayload {
  model: string;
  voice: string;
  input: string;
  response_format: "mp3";
  speed: number;
  language: string;
  streaming: boolean;
  prompt?: string;
  temperature?: number;
  top_p?: number;
}

async function requestSpeech(payload: SpeechPayload, timeoutMs: number, requestSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromRequest = () => controller.abort();
  requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
  if (requestSignal?.aborted) controller.abort();
  try {
    return await veniceFetch(
      "/audio/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      { retries: 0, signal: controller.signal },
    );
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortFromRequest);
  }
}

function safeToFallback(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  // A local timeout or network failure has an unknown outcome: Venice may have
  // accepted the speech job already, so another request could charge twice.
  return typeof status === "number" && [400, 404, 408, 409, 415, 422, 429].includes(status);
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    const body = (await request.json()) as {
      input?: string;
      model?: string;
      voice?: string;
      speed?: number;
      language?: string;
      prompt?: string;
      temperature?: number;
      realtime?: boolean;
    };
    const input = body.input?.trim().slice(0, 4096);
    if (!input) return Response.json({ error: "Speech text is required" }, { status: 400 });
    const model = body.model ?? "tts-xai-v1";
    const supportsExpressivePrompt = model.startsWith("tts-qwen3");
    const language = supportsExpressivePrompt && body.language === "en" ? "English" : body.language ?? "en";

    const payload: SpeechPayload = {
      model,
      voice: body.voice ?? (supportsExpressivePrompt ? "Dylan" : "rex"),
      input,
      response_format: "mp3",
      speed: body.speed ?? 1,
      language,
      streaming: body.realtime === true,
      ...(supportsExpressivePrompt && body.prompt ? {
        prompt: body.prompt.slice(0, 500),
        temperature: Math.min(1.2, Math.max(0, body.temperature ?? 0.78)),
        top_p: 0.95,
      } : {}),
    };

    // Keeping the SAME voice matters more than shaving a second off latency. A
    // silent switch to a different engine mid-conversation is jarring. So the
    // primary timeouts are generous, and the first fallback re-uses the exact
    // same model + voice (just non-streaming) before any engine change.
    const primaryTimeoutMs = body.realtime ? 8_000 : 14_000;
    const feminineVoice = ["eve", "ara", "serena", "vivian", "ono_anna", "sohee", "aurora", "sarah", "alice", "mia", "zoe"]
      .includes(payload.voice.toLowerCase());

    let speechResponse: Response;
    let fallback: "none" | "same-voice" | "kokoro" = "none";
    let streamed = payload.streaming;
    try {
      speechResponse = await requestSpeech(payload, primaryTimeoutMs, request.signal);
    } catch (error) {
      // A disconnected browser must not trigger a second, fallback TTS charge.
      if (request.signal.aborted) throw error;
      if (!safeToFallback(error)) throw error;
      try {
        // Same model + same voice, non-streaming, with more time. This keeps the
        // agent sounding like itself; streaming/transient timeouts recover here.
        fallback = "same-voice";
        streamed = false;
        speechResponse = await requestSpeech({ ...payload, streaming: false }, 16_000, request.signal);
      } catch (retryError) {
        if (request.signal.aborted) throw retryError;
        if (!safeToFallback(retryError)) throw retryError;
        // Last resort only: a different engine, when the requested model is
        // genuinely unavailable. The voice will differ, but this is now rare.
        fallback = "kokoro";
        speechResponse = await requestSpeech({
          ...payload,
          model: "tts-kokoro",
          voice: feminineVoice ? "af_nova" : "am_michael",
          language: body.language ?? "en",
          streaming: false,
          prompt: undefined,
          temperature: undefined,
          top_p: undefined,
        }, 16_000, request.signal);
      }
    }

    return new Response(speechResponse.body, {
      headers: {
        "Content-Type": speechResponse.headers.get("content-type") ?? "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Nova-Voice-Fallback": fallback,
        "X-Venice-Streaming": streamed ? "true" : "false",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const publicError = toPublicError(error);
    return Response.json(publicError, { status: publicError.status });
  }
}
