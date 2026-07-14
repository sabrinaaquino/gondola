import { analyzeFrame, analyzeFramesFast, analyzeVideoFast, toPublicError } from "@/lib/venice";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FRAME_CHARS = 2_500_000;
const MAX_VIDEO_CHARS = 2_200_000; // Matches the client's ~1.5MB clip cap once base64-encoded.

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    let body: {
      frameDataUrl?: string;
      frameDataUrls?: string[];
      videoDataUrl?: string;
      model?: string;
      question?: string;
      fast?: boolean;
    };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "The request body must be valid JSON" }, { status: 400 });
    }
    const frames = [...(body.frameDataUrls ?? []), body.frameDataUrl]
      .filter((frame): frame is string => typeof frame === "string" && frame.startsWith("data:image/") && frame.length <= MAX_FRAME_CHARS)
      .slice(-3);
    const videoDataUrl = typeof body.videoDataUrl === "string"
      && body.videoDataUrl.startsWith("data:video/")
      && body.videoDataUrl.length <= MAX_VIDEO_CHARS
      ? body.videoDataUrl
      : undefined;
    if (!frames.length && !videoDataUrl) {
      return Response.json({ error: "A camera frame or short video is required" }, { status: 400 });
    }
    const question = (typeof body.question === "string" ? body.question.slice(0, 1_200) : "")
      || "AMBIENT_CHECK: react only to a genuinely notable change or visible detail; otherwise use SKIP.";
    const visual = videoDataUrl
      ? await analyzeVideoFast(videoDataUrl, frames, question, body.model, request.signal)
      : body.fast
        ? await analyzeFramesFast(frames, question, body.model, request.signal)
        : await analyzeFrame(frames.at(-1) as string, question, body.model ?? "qwen3-6-27b", request.signal);
    return Response.json({ visual }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const publicError = toPublicError(error);
    return Response.json(publicError, { status: publicError.status });
  }
}
