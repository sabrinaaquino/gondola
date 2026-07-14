import { greetFromFrame, toPublicError } from "@/lib/venice";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FRAME_CHARS = 2_500_000;

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    let body: { frameDataUrl?: string; model?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "The request body must be valid JSON" }, { status: 400 });
    }
    if (!body.frameDataUrl?.startsWith("data:image/") || body.frameDataUrl.length > MAX_FRAME_CHARS) {
      return Response.json({ error: "A camera frame is required" }, { status: 400 });
    }
    const greeting = await greetFromFrame(body.frameDataUrl, body.model, request.signal);
    return Response.json(greeting, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const publicError = toPublicError(error);
    return Response.json(publicError, { status: publicError.status });
  }
}
