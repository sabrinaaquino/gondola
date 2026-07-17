import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { getAsset } from "@/lib/assets";
import { isPathWithinMediaDir } from "@/lib/media-tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

function contentTypeFor(filePath: string, metadataContentType: unknown): string {
  if (typeof metadataContentType === "string" && metadataContentType.includes("/")) return metadataContentType;
  const ext = path.extname(filePath).replace(".", "").toLowerCase();
  return EXTENSION_CONTENT_TYPE[ext] ?? "application/octet-stream";
}

// Render or download a registered asset. Assets resolve only through the
// manifest, and their path must stay inside the managed media folder, so the
// browser can never request an arbitrary file or traverse the filesystem.
export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "An asset id is required" }, { status: 400 });

  const asset = await getAsset(id);
  if (!asset?.path) return Response.json({ error: "Asset not found" }, { status: 404 });
  if (!isPathWithinMediaDir(asset.path)) return Response.json({ error: "Asset is not accessible" }, { status: 403 });

  try {
    const info = await stat(asset.path);
    if (!info.isFile()) return Response.json({ error: "Asset is not a file" }, { status: 404 });
  } catch {
    return Response.json({ error: "Asset file is missing" }, { status: 404 });
  }

  const bytes = await readFile(asset.path);
  const contentType = contentTypeFor(asset.path, asset.metadata?.contentType);
  const baseHeaders = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
  };

  // Safari and other WebKit-based players require HTTP Range support to play
  // video/audio: they probe with "Range: bytes=0-1" and silently refuse to
  // render media when the server answers 200 with the full body instead of
  // 206. Serve partial content when a Range header is present.
  const range = request.headers.get("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] !== "" || match[2] !== "")) {
    const size = bytes.byteLength;
    let start: number;
    let end: number;
    if (match[1] === "") {
      // Suffix range: last N bytes.
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      });
    }
    const chunk = bytes.subarray(start, end + 1);
    return new Response(chunk, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(chunk.byteLength),
      },
    });
  }

  return new Response(bytes, {
    headers: { ...baseHeaders, "Content-Length": String(bytes.byteLength) },
  });
}
