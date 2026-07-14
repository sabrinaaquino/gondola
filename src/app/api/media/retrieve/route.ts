import { parseVeniceJson, toPublicError, veniceFetch } from "@/lib/venice";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RetrieveBody {
  kind?: "video" | "music";
  model?: string;
  queueId?: string;
  downloadUrl?: string;
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    let body: RetrieveBody;
    try {
      body = (await request.json()) as RetrieveBody;
    } catch {
      return Response.json({ error: "The request body must be valid JSON" }, { status: 400 });
    }
    if (!body.kind || !body.model || !body.queueId) {
      return Response.json({ error: "kind, model, and queueId are required" }, { status: 400 });
    }
    if (body.kind !== "video" && body.kind !== "music") {
      return Response.json({ error: "kind must be video or music" }, { status: 400 });
    }
    const mediaPath = body.kind === "video" ? "/video/retrieve" : "/audio/retrieve";
    const response = await veniceFetch(
      mediaPath,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: body.model,
          queue_id: body.queueId,
          delete_media_on_completion: true,
        }),
      },
      { retries: 0 },
    );
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
      return new Response(response.body, {
        headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    }

    const status = await parseVeniceJson<Record<string, unknown>>(response);
    if (status.status === "COMPLETED" && body.downloadUrl && body.kind === "video") {
      let url: URL;
      try {
        url = new URL(body.downloadUrl);
      } catch {
        throw new Error("Venice returned an invalid media URL");
      }
      // VPS-backed video models return this one-time URL from Venice at queue
      // time. Never let a caller turn this proxy into an arbitrary URL fetch.
      if (
        url.protocol !== "https:"
        || url.hostname !== "private-share.venice.ai"
        || (url.port && url.port !== "443")
        || !url.pathname.startsWith("/v1/share/read/")
        || url.username
        || url.password
      ) {
        throw new Error("Venice returned an invalid media URL");
      }
      const downloaded = await fetch(url, { cache: "no-store" });
      if (!downloaded.ok) throw new Error("The completed Venice video could not be downloaded");
      void veniceFetch("/video/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: body.model, queue_id: body.queueId }),
      }).then((completion) => completion.arrayBuffer()).catch(() => undefined);
      return new Response(downloaded.body, {
        headers: { "Content-Type": downloaded.headers.get("content-type") ?? "video/mp4", "Cache-Control": "no-store" },
      });
    }
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const publicError = toPublicError(error);
    return Response.json(publicError, { status: publicError.status });
  }
}
