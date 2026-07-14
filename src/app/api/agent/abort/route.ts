import { abortAgentTurn } from "@/lib/pi-agent";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
  if (!body.sessionId || typeof body.sessionId !== "string") {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  return Response.json({ aborted: abortAgentTurn(body.sessionId) });
}
