import { clearApiTraces, listApiTraces } from "@/lib/api-trace";
import { getBillingBalance } from "@/lib/billing-balance";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { getUsageAnalytics, type UsageLookback } from "@/lib/usage-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOKBACKS = new Set<UsageLookback>(["7d", "30d", "90d"]);

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  const events = listApiTraces();
  const finished = events.filter((event) => typeof event.latencyMs === "number");
  const averageLatencyMs = finished.length
    ? Math.round(finished.reduce((total, event) => total + (event.latencyMs ?? 0), 0) / finished.length)
    : 0;

  const requestedLookback = new URL(request.url).searchParams.get("lookback") as UsageLookback | null;
  const lookback = requestedLookback && LOOKBACKS.has(requestedLookback) ? requestedLookback : "7d";
  let analytics = null;
  let analyticsFetchedAt: number | null = null;
  let analyticsError: string | null = null;
  let balance = null;
  let balanceFetchedAt: number | null = null;
  let balanceError: string | null = null;
  const [analyticsResult, balanceResult] = await Promise.allSettled([
    getUsageAnalytics(lookback),
    getBillingBalance(),
  ]);
  if (analyticsResult.status === "fulfilled") {
    analytics = analyticsResult.value.data;
    analyticsFetchedAt = analyticsResult.value.fetchedAt;
  } else {
    analyticsError = analyticsResult.reason instanceof Error
      ? analyticsResult.reason.message
      : "Venice billing analytics are unavailable";
  }
  if (balanceResult.status === "fulfilled") {
    balance = balanceResult.value.data;
    balanceFetchedAt = balanceResult.value.fetchedAt;
  } else {
    balanceError = balanceResult.reason instanceof Error
      ? balanceResult.reason.message
      : "Venice balance is unavailable";
  }

  return Response.json({
    events,
    summary: {
      total: events.length,
      active: events.filter((event) => event.status === "running").length,
      capabilities: new Set(events.map((event) => event.capability)).size,
      models: new Set(events.map((event) => event.model).filter(Boolean)).size,
      averageLatencyMs,
      sessionTokens: events.reduce((total, event) => total + (event.usage?.totalTokens ?? 0), 0),
    },
    analytics,
    analyticsFetchedAt,
    analyticsError,
    balance,
    balanceFetchedAt,
    balanceError,
  }, { headers: { "Cache-Control": "no-store" } });
}

export function DELETE(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  clearApiTraces();
  return Response.json({ ok: true });
}
