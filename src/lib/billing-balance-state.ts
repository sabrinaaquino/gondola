export type ConsumptionCurrency = "USD" | "VCU" | "DIEM" | "BUNDLED_CREDITS";

export interface BillingBalance {
  canConsume: boolean | null;
  consumptionCurrency: ConsumptionCurrency | null;
  balances: {
    diem: number;
    usd: number;
  };
  diemEpochAllocation: number;
  source: "endpoint" | "rate-limits" | "response-headers";
}

interface ObservedBalance {
  data?: BillingBalance;
  fetchedAt?: number;
}

const observedGlobal = globalThis as typeof globalThis & {
  __veniceObservedBillingBalance?: ObservedBalance;
};
const observedBalance = observedGlobal.__veniceObservedBillingBalance ?? {};
observedGlobal.__veniceObservedBillingBalance = observedBalance;

function headerValue(headers: Headers | Record<string, string | undefined>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1] ?? null;
}

function finiteHeaderNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function observeBillingBalance(headers: Headers | Record<string, string | undefined>): void {
  const diem = finiteHeaderNumber(headerValue(headers, "x-venice-balance-diem"));
  const usd = finiteHeaderNumber(headerValue(headers, "x-venice-balance-usd"));
  if (diem === undefined && usd === undefined) return;

  const previous = observedBalance.data;
  observedBalance.data = {
    canConsume: null,
    consumptionCurrency: previous?.consumptionCurrency ?? (usd && usd > 0 ? "USD" : "DIEM"),
    balances: {
      diem: diem ?? previous?.balances.diem ?? 0,
      usd: usd ?? previous?.balances.usd ?? 0,
    },
    diemEpochAllocation: previous?.diemEpochAllocation ?? 0,
    source: "response-headers",
  };
  observedBalance.fetchedAt = Date.now();
}

export function storeBillingBalance(data: BillingBalance, fetchedAt = Date.now()): void {
  observedBalance.data = data;
  observedBalance.fetchedAt = fetchedAt;
}

export function getObservedBillingBalance(): { data: BillingBalance; fetchedAt: number } | null {
  return observedBalance.data && observedBalance.fetchedAt
    ? { data: observedBalance.data, fetchedAt: observedBalance.fetchedAt }
    : null;
}
