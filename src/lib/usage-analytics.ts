import { parseVeniceJson, veniceFetch } from "./venice";

export type UsageLookback = "7d" | "30d" | "90d";

export interface UsageAnalyticsModelBreakdown {
  type: string;
  usd: number;
  diem: number;
  units: number;
}

export interface UsageAnalyticsModel {
  modelName: string;
  unitType: string;
  modelType: string | null;
  totalUsd: number;
  totalDiem: number;
  totalUnits: number;
  breakdown?: UsageAnalyticsModelBreakdown[];
}

export interface UsageAnalyticsDay {
  date: string;
  USD: number;
  DIEM: number;
}

export interface UsageAnalytics {
  lookback: string;
  byDate: UsageAnalyticsDay[];
  byModel: UsageAnalyticsModel[];
  byModelDaily: Array<Record<string, number>>;
  topModels: string[];
  byKey: Array<{
    apiKeyId: string | null;
    description: string;
    totalUsd: number;
    totalDiem: number;
    totalUnits: number;
  }>;
  byKeyDaily: Array<Record<string, number>>;
  topKeyNames: string[];
}

interface CachedAnalytics {
  data?: UsageAnalytics;
  fetchedAt?: number;
  error?: string;
  errorAt?: number;
  promise?: Promise<UsageAnalytics>;
}

const analyticsGlobal = globalThis as typeof globalThis & {
  __veniceUsageAnalyticsCache?: Map<UsageLookback, CachedAnalytics>;
};
const analyticsCache = analyticsGlobal.__veniceUsageAnalyticsCache ?? new Map<UsageLookback, CachedAnalytics>();
analyticsGlobal.__veniceUsageAnalyticsCache = analyticsCache;

function normalizeAnalytics(value: unknown): UsageAnalytics {
  const record = value && typeof value === "object" ? value as Partial<UsageAnalytics> : {};
  return {
    lookback: typeof record.lookback === "string" ? record.lookback : "7d",
    byDate: Array.isArray(record.byDate) ? record.byDate : [],
    byModel: Array.isArray(record.byModel) ? record.byModel : [],
    byModelDaily: Array.isArray(record.byModelDaily) ? record.byModelDaily : [],
    topModels: Array.isArray(record.topModels) ? record.topModels : [],
    byKey: Array.isArray(record.byKey) ? record.byKey : [],
    byKeyDaily: Array.isArray(record.byKeyDaily) ? record.byKeyDaily : [],
    topKeyNames: Array.isArray(record.topKeyNames) ? record.topKeyNames : [],
  };
}

export async function getUsageAnalytics(lookback: UsageLookback): Promise<{ data: UsageAnalytics; fetchedAt: number }> {
  const now = Date.now();
  const cached = analyticsCache.get(lookback) ?? {};
  if (cached.data && cached.fetchedAt && now - cached.fetchedAt < 60_000) {
    return { data: cached.data, fetchedAt: cached.fetchedAt };
  }
  if (cached.error && cached.errorAt && now - cached.errorAt < 12_000) throw new Error(cached.error);
  if (!cached.promise) {
    cached.promise = (async () => {
      const response = await veniceFetch(
        `/billing/usage-analytics?lookback=${lookback}`,
        { method: "GET" },
        { retries: 1, signal: AbortSignal.timeout(15_000), trace: false, admin: true },
      );
      return normalizeAnalytics(await parseVeniceJson(response));
    })();
    analyticsCache.set(lookback, cached);
  }
  try {
    const data = await cached.promise;
    cached.data = data;
    cached.fetchedAt = Date.now();
    cached.error = undefined;
    cached.errorAt = undefined;
    return { data, fetchedAt: cached.fetchedAt };
  } catch (error) {
    cached.error = error instanceof Error ? error.message : "Venice billing analytics are unavailable";
    cached.errorAt = Date.now();
    throw error;
  } finally {
    cached.promise = undefined;
  }
}
