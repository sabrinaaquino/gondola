import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import {
  evaluateProposal,
  generateProposal,
  getLabSnapshot,
  getProposalDetail,
  promoteProposal,
  rejectProposal,
  rollback,
  seedDemo,
} from "@/lib/lab/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Gondola Lab request failed";
}

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  try {
    const proposalId = new URL(request.url).searchParams.get("proposalId");
    if (proposalId) {
      const detail = await getProposalDetail(proposalId);
      if (!detail) return Response.json({ error: "Proposal not found" }, { status: 404 });
      return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(await getLabSnapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "");

    if (action === "seed_demo") return Response.json(await seedDemo());
    if (action === "generate_proposal") {
      const proposal = await generateProposal();
      return Response.json({ proposal });
    }
    if (action === "evaluate_proposal") {
      const record = await evaluateProposal(String(body.proposalId ?? ""), { live: body.live === true });
      return Response.json({ evaluation: record });
    }
    if (action === "promote") {
      const version = await promoteProposal(String(body.proposalId ?? ""), String(body.approvedBy ?? "user"));
      return Response.json({ champion: version });
    }
    if (action === "reject") {
      return Response.json({ proposal: await rejectProposal(String(body.proposalId ?? "")) });
    }
    if (action === "rollback") {
      const version = await rollback(String(body.approvedBy ?? "user"));
      return Response.json({ champion: version ?? null });
    }
    return Response.json({ error: "Unknown Gondola Lab action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 400 });
  }
}
