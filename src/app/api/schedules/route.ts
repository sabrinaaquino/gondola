import {
  createSchedule,
  deleteSchedule,
  ensureSchedulerStarted,
  listSchedules,
  runScheduleNow,
  tickSchedules,
  updateSchedule,
  type ScheduleDelivery,
} from "@/lib/scheduler";
import { getWorkspaceSnapshot } from "@/lib/workspace";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  try {
    ensureSchedulerStarted();
    return Response.json({ tasks: await listSchedules() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load schedules" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    ensureSchedulerStarted();
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");

    if (action === "create") {
      const agentId = String(body.agentId ?? "") || (await getWorkspaceSnapshot()).defaultAgentId;
      const task = await createSchedule({
        title: String(body.title ?? "Scheduled task"),
        agentId,
        prompt: String(body.prompt ?? ""),
        intervalMinutes: Number(body.intervalMinutes ?? 0),
        deliver: (body.deliver === "telegram" ? "telegram" : "conversation") as ScheduleDelivery,
        conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
        startDelayMinutes: typeof body.startDelayMinutes === "number" ? body.startDelayMinutes : undefined,
        goal: typeof body.goal === "string" ? body.goal : undefined,
        maxIterations: typeof body.maxIterations === "number" ? body.maxIterations : undefined,
      });
      return Response.json({ task }, { status: 201 });
    }
    if (action === "update") {
      const task = await updateSchedule(String(body.id ?? ""), {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.intervalMinutes === "number" ? { intervalMinutes: body.intervalMinutes } : {}),
        ...(body.deliver === "telegram" || body.deliver === "conversation" ? { deliver: body.deliver } : {}),
        ...(typeof body.goal === "string" ? { goal: body.goal } : {}),
        ...(typeof body.maxIterations === "number" ? { maxIterations: body.maxIterations } : {}),
      });
      return Response.json({ task });
    }
    if (action === "delete") {
      await deleteSchedule(String(body.id ?? ""));
      return Response.json({ ok: true });
    }
    if (action === "run") {
      const task = await runScheduleNow(String(body.id ?? ""));
      return Response.json({ task });
    }
    if (action === "tick") {
      const ran = await tickSchedules();
      return Response.json({ ran });
    }
    return Response.json({ error: "Unknown schedule action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Schedule update failed" }, { status: 400 });
  }
}
