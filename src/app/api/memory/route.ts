import type { MemoryKind } from "@/lib/app-types";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import {
  approveMemory,
  createMemory,
  deleteMemory,
  getMemorySnapshot,
  rejectMemory,
  searchMemories,
  updateMemory,
  updateMemorySettings,
} from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set<MemoryKind>(["bio", "preference", "important", "project", "relationship", "environment", "agent", "other"]);

function kind(value: unknown): MemoryKind | undefined {
  return KINDS.has(value as MemoryKind) ? value as MemoryKind : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 12) : undefined;
}

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  try {
    const params = new URL(request.url).searchParams;
    const query = params.get("q")?.trim();
    const agentId = params.get("agentId")?.trim() || undefined;
    if (query) return Response.json({ matches: await searchMemories(query, 20, { agentId }) }, { headers: { "Cache-Control": "no-store" } });
    return Response.json(await getMemorySnapshot(agentId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Memory request failed" }, { status: 500 });
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

    if (action === "create") {
      const content = typeof body.content === "string" ? body.content : "";
      const result = await createMemory({
        agentId: typeof body.agentId === "string" && body.agentId ? body.agentId : undefined,
        kind: kind(body.kind),
        title: typeof body.title === "string" ? body.title : undefined,
        content,
        importance: typeof body.importance === "number" ? body.importance : undefined,
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
        tags: stringArray(body.tags),
        source: { type: "manual" },
      });
      return Response.json(result, { status: result.created ? 201 : 200 });
    }
    if (action === "update") {
      return Response.json(await updateMemory(String(body.id ?? ""), {
        kind: kind(body.kind),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(typeof body.importance === "number" ? { importance: body.importance } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(body.status === "active" || body.status === "pending" || body.status === "archived" ? { status: body.status } : {}),
        ...(Array.isArray(body.tags) ? { tags: stringArray(body.tags) ?? [] } : {}),
      }));
    }
    if (action === "delete") return Response.json(await deleteMemory(String(body.id ?? "")));
    if (action === "approve") return Response.json(await approveMemory(String(body.id ?? "")));
    if (action === "reject") return Response.json(await rejectMemory(String(body.id ?? "")));
    if (action === "settings") {
      return Response.json(await updateMemorySettings({
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.autoCapture === "boolean" ? { autoCapture: body.autoCapture } : {}),
        ...(typeof body.requireApproval === "boolean" ? { requireApproval: body.requireApproval } : {}),
      }));
    }

    return Response.json({ error: "Unknown memory action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Memory update failed" }, { status: 400 });
  }
}
