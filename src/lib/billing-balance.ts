import { parseVeniceJson, veniceFetch } from "./venice";
import {
  getObservedBillingBalance,
  storeBillingBalance,
  type BillingBalance,
  type ConsumptionCurrency,
} from "./billing-balance-state";

export type { BillingBalance, ConsumptionCurrency } from "./billing-balance-state";

interface CachedBalance {
  data?: BillingBalance;
  fetchedAt?: number;
  error?: string;
  errorAt?: number;
  promise?: Promise<BillingBalance>;
}

const balanceGlobal = globalThis as typeof globalThis & {
  __veniceBillingBalanceCache?: CachedBalance;
};
const balanceCache = balanceGlobal.__veniceBillingBalanceCache ?? {};
balanceGlobal.__veniceBillingBalanceCache = balanceCache;

function finiteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeBalance(value: unknown): BillingBalance {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawBalances = record.balances && typeof record.balances === "object"
    ? record.balances as Record<string, unknown>
    : {};
  const currencies = new Set<ConsumptionCurrency>(["USD", "VCU", "DIEM", "BUNDLED_CREDITS"]);
  const rawCurrency = typeof record.consumptionCurrency === "string" ? record.consumptionCurrency : null;

  return {
    canConsume: record.canConsume === true,
    consumptionCurrency: rawCurrency && currencies.has(rawCurrency as ConsumptionCurrency)
      ? rawCurrency as ConsumptionCurrency
      : null,
    balances: {
      diem: finiteNumber(rawBalances.diem),
      usd: finiteNumber(rawBalances.usd),
    },
    diemEpochAllocation: finiteNumber(record.diemEpochAllocation),
    source: "endpoint",
  };
}

function normalizeRateLimitBalance(value: unknown): BillingBalance {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawData = record.data && typeof record.data === "object"
    ? record.data as Record<string, unknown>
    : {};
  const rawBalances = rawData.balances && typeof rawData.balances === "object"
    ? rawData.balances as Record<string, unknown>
    : {};

  return {
    canConsume: rawData.accessPermitted === true,
    consumptionCurrency: null,
    balances: {
      diem: finiteNumber(rawBalances.DIEM ?? rawBalances.diem),
      usd: finiteNumber(rawBalances.USD ?? rawBalances.usd),
    },
    diemEpochAllocation: 0,
    source: "rate-limits",
  };
}

export async function getBillingBalance(): Promise<{ data: BillingBalance; fetchedAt: number }> {
  const now = Date.now();
  if (balanceCache.data && balanceCache.fetchedAt && now - balanceCache.fetchedAt < 15_000) {
    return { data: balanceCache.data, fetchedAt: balanceCache.fetchedAt };
  }
  if (balanceCache.error && balanceCache.errorAt && now - balanceCache.errorAt < 12_000) {
    const observed = getObservedBillingBalance();
    if (observed) return observed;
    throw new Error(balanceCache.error);
  }
  if (!balanceCache.promise) {
    balanceCache.promise = (async () => {
      try {
        const response = await veniceFetch(
          "/billing/balance",
          { method: "GET" },
          { retries: 1, signal: AbortSignal.timeout(15_000), trace: false, admin: true },
        );
        return normalizeBalance(await parseVeniceJson(response));
      } catch {
        const response = await veniceFetch(
          "/api_keys/rate_limits",
          { method: "GET" },
          { retries: 1, signal: AbortSignal.timeout(15_000), trace: false, admin: true },
        );
        return normalizeRateLimitBalance(await parseVeniceJson(response));
      }
    })();
  }

  try {
    const data = await balanceCache.promise;
    balanceCache.data = data;
    balanceCache.fetchedAt = Date.now();
    balanceCache.error = undefined;
    balanceCache.errorAt = undefined;
    storeBillingBalance(data, balanceCache.fetchedAt);
    return { data, fetchedAt: balanceCache.fetchedAt };
  } catch (error) {
    balanceCache.error = error instanceof Error ? error.message : "Venice balance is unavailable";
    balanceCache.errorAt = Date.now();
    const observed = getObservedBillingBalance();
    if (observed) return observed;
    throw error;
  } finally {
    balanceCache.promise = undefined;
  }
}
