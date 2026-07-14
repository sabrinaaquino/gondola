import { VeniceError, parseVeniceJson, toPublicError, veniceFetch } from "@/lib/venice";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 25_000_000; // Whisper-class services cap uploads near 25MB.

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "multipart");
  if (rejected) return rejected;
  try {
    const incoming = await request.formData();
    const file = incoming.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: "An audio recording is required" }, { status: 400 });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "The recording is too long to transcribe. Try a shorter take." }, { status: 413 });
    }

    const requestedModel = String(incoming.get("model") || "stt-xai-v1");
    const language = incoming.get("language");
    const candidates = [...new Set([requestedModel, "openai/whisper-large-v3"])];
    let lastError: unknown;

    for (const model of candidates) {
      try {
        const form = new FormData();
        form.set("file", file, file.name || "recording.webm");
        form.set("model", model);
        form.set("response_format", "json");
        form.set("timestamps", "false");
        if (language) form.set("language", String(language));

        const timeout = AbortSignal.timeout(model.includes("parakeet") ? 12_000 : 24_000);
        const signal = AbortSignal.any([request.signal, timeout]);
        const response = await veniceFetch(
          "/audio/transcriptions",
          { method: "POST", body: form },
          { retries: 0, signal },
        );
        const result = await parseVeniceJson<{ text?: string }>(response);
        return Response.json(
          { text: result.text ?? "", model },
          { headers: { "Cache-Control": "no-store", "X-Nova-STT-Model": model } },
        );
      } catch (error) {
        lastError = error;
        if (error instanceof VeniceError && [401, 402, 403].includes(error.status)) throw error;
        if (request.signal.aborted) throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Venice transcription is temporarily unavailable");
  } catch (error) {
    const publicError = toPublicError(error);
    return Response.json(publicError, { status: publicError.status });
  }
}
