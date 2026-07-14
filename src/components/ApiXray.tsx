"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CloseIcon, PlusIcon, XrayIcon } from "@/components/Icons";
import type { ApiCapability, ApiTraceEvent } from "@/lib/api-trace";
import type { CatalogModel } from "@/lib/app-types";
import type { BillingBalance } from "@/lib/billing-balance";
import type { UsageAnalytics, UsageAnalyticsModel, UsageLookback } from "@/lib/usage-analytics";

interface ApiXrayProps {
  open: boolean;
  onClose: () => void;
  models?: CatalogModel[];
}

interface ApiXrayResponse {
  events: ApiTraceEvent[];
  summary: {
    total: number;
    active: number;
    capabilities: number;
    models: number;
    averageLatencyMs: number;
    sessionTokens: number;
  };
  analytics: UsageAnalytics | null;
  analyticsFetchedAt: number | null;
  analyticsError: string | null;
  balance: BillingBalance | null;
  balanceFetchedAt: number | null;
  balanceError: string | null;
}

const EMPTY_SUMMARY: ApiXrayResponse["summary"] = {
  total: 0,
  active: 0,
  capabilities: 0,
  models: 0,
  averageLatencyMs: 0,
  sessionTokens: 0,
};

const capabilities: Array<{ capability: ApiCapability; title: string; glyph: string }> = [
  { capability: "chat", title: "Text", glyph: "T" },
  { capability: "vision", title: "Vision", glyph: "V" },
  { capability: "transcription", title: "Hear", glyph: "H" },
  { capability: "speech", title: "Speak", glyph: "S" },
  { capability: "web", title: "Web", glyph: "W" },
  { capability: "image", title: "Image", glyph: "I" },
  { capability: "video", title: "Video", glyph: "▶" },
  { capability: "music", title: "Music", glyph: "♪" },
  { capability: "embeddings", title: "Vectors", glyph: "E" },
];

function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return "Live";
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return Math.round(value).toLocaleString();
}

function formatBalanceAmount(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatChartValue(value: number, useUsd: boolean): string {
  if (!Number.isFinite(value) || value === 0) return useUsd ? "$0" : "0";
  const formatted = value < 1 ? value.toFixed(2) : value.toFixed(value < 10 ? 1 : 0);
  return useUsd ? `$${formatted}` : formatted;
}

function formatChartDate(value: string): string {
  const dateOnly = value.slice(0, 10);
  const date = new Date(`${dateOnly}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function modelUnits(model: UsageAnalyticsModel): string {
  const type = model.unitType?.toLowerCase() || "units";
  // Billing token SKUs are metered in million-token units in the live response.
  const units = formatNumber(type === "tokens" ? model.totalUnits * 1_000_000 : model.totalUnits);
  return `${units} ${type}`;
}

function requestText(event: ApiTraceEvent): string {
  if (!event.request) return `${event.method} https://api.venice.ai/api/v1${event.endpoint}`;
  const headers = Object.entries(event.request.headers).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `${event.method} ${event.request.url}\n${headers}${event.request.body ? `\n\n${event.request.body}` : ""}`;
}

function normalizedModelName(value: string): string {
  const aliases: Record<string, string> = {
    "tts-xai-v1": "xAI TTS v1",
    "stt-xai-v1": "xAI Speech to Text v1",
    "tts-kokoro": "Kokoro Text to Speech",
    "openai/whisper-large-v3": "Whisper Large V3",
  };
  return (aliases[value] ?? value).toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^(?:zaiorg|openai|google|meta)/, "");
}

function requestUsage(event: ApiTraceEvent): { primary: string; secondary: string } {
  if (event.usage?.totalTokens) {
    return {
      primary: formatNumber(event.usage.totalTokens),
      secondary: `${formatNumber(event.usage.inputTokens)} in · ${formatNumber(event.usage.outputTokens)} out`,
    };
  }
  if (event.usage?.requestUnits && event.usage.requestUnit === "characters") {
    return { primary: formatNumber(event.usage.requestUnits), secondary: "characters sent" };
  }
  if (event.usage?.requestUnits && event.usage.requestUnit === "bytes") {
    return { primary: formatNumber(event.usage.requestUnits), secondary: "audio bytes sent" };
  }
  if (event.status === "running") return { primary: "…", secondary: "awaiting response" };
  if (event.capability === "models") return { primary: "None", secondary: "not metered" };
  return { primary: "N/A", secondary: "not returned" };
}

interface RequestCost {
  usd: number;
  diem: number;
  confidence: "reported" | "fixed" | "list" | "billed" | "minimum";
  note: string;
}

// Per-million-token rate for one model, read from the Venice model catalog.
// USD and DIEM are tracked separately: they're equal in Venice's current
// pricing, but keeping both keeps the figures correct if that ever diverges.
interface RatePair {
  usd: number;
  diem: number;
}

interface ModelRate {
  input: RatePair;
  output: RatePair;
  cacheRead: RatePair;
}

// A Venice price component is { usd, diem } per million tokens (either figure may
// be omitted, in which case it mirrors the other).
function priceComponent(value: unknown): RatePair {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const usd = typeof record.usd === "number" ? record.usd : undefined;
    const diem = typeof record.diem === "number" ? record.diem : undefined;
    return { usd: usd ?? diem ?? 0, diem: diem ?? usd ?? 0 };
  }
  const flat = typeof value === "number" ? value : 0;
  return { usd: flat, diem: flat };
}

function readModelRate(pricing: Record<string, unknown> | undefined): ModelRate | undefined {
  if (!pricing) return undefined;
  const input = priceComponent(pricing.input);
  const output = priceComponent(pricing.output);
  if (!input.usd && !input.diem && !output.usd && !output.diem) return undefined;
  return { input, output, cacheRead: priceComponent(pricing.cache_input) };
}

function usesPaidWebSearch(event: ApiTraceEvent): boolean {
  if (event.endpoint === "/augment/search") return true;
  if (event.endpoint !== "/chat/completions" || !event.request?.body) return false;
  try {
    const body = JSON.parse(event.request.body) as { venice_parameters?: { enable_web_search?: unknown } };
    const setting = body.venice_parameters?.enable_web_search;
    return setting === true || setting === "on" || setting === "auto";
  } catch {
    return false;
  }
}

function requestCostText(cost: RequestCost): string {
  const formatted = formatMoney(cost.usd);
  return cost.confidence === "minimum" ? `${formatted}+` : formatted;
}

function requestCostNote(cost: RequestCost): string {
  return cost.diem > 0 ? `${cost.diem.toFixed(4)} DIEM · ${cost.note}` : cost.note;
}

function requestCost(event: ApiTraceEvent, analytics: UsageAnalytics | null, rates: Map<string, ModelRate>): RequestCost | undefined {
  // 1. If Venice returned an exact cost with the response, use it verbatim.
  if (event.usage?.costUsd) {
    return { usd: event.usage.costUsd, diem: 0, confidence: "reported", note: "Returned by Venice for this request" };
  }
  const paidSearch = event.status === "success" && usesPaidWebSearch(event);
  const searchUsd = paidSearch ? 0.01 : 0;

  // 2. Derive the exact cost from the model's published per-token list price and
  // this request's token counts. This is deterministic, not an estimate.
  const rate = event.model ? rates.get(event.model) : undefined;
  const usage = event.usage;
  if (rate && usage && (usage.inputTokens || usage.outputTokens || usage.cachedTokens)) {
    // inputTokens holds only the fresh (non-cached) prompt tokens, and
    // cachedTokens is reported separately, so the two are disjoint — bill each at
    // its own rate rather than subtracting.
    const input = usage.inputTokens || 0;
    const cached = usage.cachedTokens || 0;
    const output = usage.outputTokens || 0;
    const usd = (input * rate.input.usd + cached * rate.cacheRead.usd + output * rate.output.usd) / 1_000_000;
    const diem = (input * rate.input.diem + cached * rate.cacheRead.diem + output * rate.output.diem) / 1_000_000;
    if (usd > 0 || diem > 0 || searchUsd) {
      return {
        usd: usd + searchUsd,
        diem,
        confidence: "list",
        note: searchUsd ? "Venice list price plus fixed search fee" : "Venice list price",
      };
    }
  }

  // 3. Search-only price when the model isn't itemizable.
  if (event.endpoint === "/augment/search" && searchUsd) {
    return { usd: searchUsd, diem: 0, confidence: "fixed", note: "Official fixed search price" };
  }

  // 4. Fall back to the account's actual billed rates from usage analytics.
  if (usage && event.model && analytics) {
    const eventModel = normalizedModelName(event.model);
    const model = analytics.byModel.find((candidate) => {
      if (candidate.unitType?.toLowerCase() !== "tokens") return false;
      const candidateModel = normalizedModelName(candidate.modelName);
      return candidateModel === eventModel || candidateModel.endsWith(eventModel) || eventModel.endsWith(candidateModel);
    });
    if (model?.breakdown?.length) {
      let usd = 0;
      let diem = 0;
      for (const part of model.breakdown) {
        const type = part.type.toLowerCase();
        const tokens = type.includes("output")
          ? usage.outputTokens
          : type.includes("cache read")
            ? usage.cachedTokens
            : type.includes("input")
              ? usage.inputTokens
              : 0;
        if (!tokens || !part.units) continue;
        const billedTokens = part.units * 1_000_000;
        usd += (part.usd / billedTokens) * tokens;
        diem += (part.diem / billedTokens) * tokens;
      }
      if (usd > 0 || diem > 0) {
        return {
          usd: usd + searchUsd,
          diem,
          confidence: "billed",
          note: searchUsd ? "Venice billing rate plus fixed search fee" : "Venice billing rate",
        };
      }
    }
  }
  return searchUsd
    ? { usd: searchUsd, diem: 0, confidence: "minimum", note: "Search fee only; model cost not itemized" }
    : undefined;
}

export function ApiXray({ open, onClose, models }: ApiXrayProps) {
  const [lookback, setLookback] = useState<UsageLookback>("7d");
  const [data, setData] = useState<ApiXrayResponse>({
    events: [],
    summary: EMPTY_SUMMARY,
    analytics: null,
    analyticsFetchedAt: null,
    analyticsError: null,
    balance: null,
    balanceFetchedAt: null,
    balanceError: null,
  });
  const [loadError, setLoadError] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [rankingView, setRankingView] = useState<"models" | "keys">("models");
  const [spendUnit, setSpendUnit] = useState<"usd" | "diem" | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/xray?lookback=${lookback}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error("X-Ray unavailable");
      setData(await response.json() as ApiXrayResponse);
      setLoadError(false);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setLoadError(true);
    }
  }, [lookback]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let pollTimer: number | undefined;
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted) pollTimer = window.setTimeout(() => void poll(), 900);
    };
    void poll();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedEventId) setSelectedEventId(undefined);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      controller.abort();
      if (pollTimer) window.clearTimeout(pollTimer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open, refresh, selectedEventId]);

  const seenCapabilities = useMemo(() => new Map(data.events.map((event) => [event.capability, event])), [data.events]);
  const usedCapabilities = capabilities.filter((item) => seenCapabilities.has(item.capability));
  const selectedEvent = data.events.find((event) => event.id === selectedEventId);
  const analytics = data.analytics;
  const balance = data.balance;
  const rateByModel = useMemo(() => {
    const map = new Map<string, ModelRate>();
    for (const model of models ?? []) {
      const rate = readModelRate(model.pricing);
      if (rate) map.set(model.id, rate);
    }
    return map;
  }, [models]);
  const selectedCost = selectedEvent ? requestCost(selectedEvent, analytics, rateByModel) : undefined;
  const totalUsd = analytics?.byDate.reduce((total, day) => total + (Number(day.USD) || 0), 0) ?? 0;
  const totalDiem = analytics?.byDate.reduce((total, day) => total + (Number(day.DIEM) || 0), 0) ?? 0;
  const billingTokens = analytics?.byModel
    .filter((model) => model.unitType?.toLowerCase() === "tokens")
    .reduce((total, model) => total + (Number(model.totalUnits) || 0) * 1_000_000, 0) ?? 0;
  const topModels = analytics
    ? analytics.topModels.slice(0, 5).flatMap((name) => analytics.byModel.find((model) => model.modelName === name) ?? [])
    : [];
  const maxModelSpend = Math.max(0, ...topModels.map((model) => model.totalUsd + model.totalDiem || model.totalUnits));
  const topKeys = analytics
    ? analytics.topKeyNames.slice(0, 5).flatMap((name) => analytics.byKey.find((key) => key.description === name) ?? [])
    : [];
  const maxKeySpend = Math.max(0, ...topKeys.map((key) => key.totalUsd + key.totalDiem || key.totalUnits));
  const balanceStatus = balance?.canConsume === false ? "Credits required" : null;

  // Venice charges some requests in USD and others in DIEM, and an account
  // commonly accrues both. Keep the two series separate (mixing distinct units on
  // one axis is meaningless) and let the user toggle which to plot; the default
  // follows whichever unit is populated on more days.
  const spend = useMemo(() => {
    const days = [...(analytics?.byDate ?? [])].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const usd = days.map((day) => Number(day.USD) || 0);
    const diem = days.map((day) => Number(day.DIEM) || 0);
    const usdDays = usd.filter((value) => value > 0).length;
    const diemDays = diem.filter((value) => value > 0).length;
    return {
      days,
      usd,
      diem,
      usdTotal: usd.reduce((total, value) => total + value, 0),
      diemTotal: diem.reduce((total, value) => total + value, 0),
      hasUsd: usdDays > 0,
      hasDiem: diemDays > 0,
      autoUsd: usdDays > diemDays,
      middleDay: days[Math.floor((days.length - 1) / 2)],
    };
  }, [analytics]);

  const bothUnits = spend.hasUsd && spend.hasDiem;
  const useUsd = (spendUnit ?? (spend.autoUsd ? "usd" : "diem")) === "usd";
  const spendValues = useUsd ? spend.usd : spend.diem;
  const spendMax = Math.max(0.000001, ...spendValues);
  const spendGap = spendValues.length <= 7 ? 3 : spendValues.length <= 30 ? 1 : 0.35;
  const spendBarWidth = spendValues.length
    ? Math.max(0.55, (100 - spendGap * Math.max(0, spendValues.length - 1)) / spendValues.length)
    : 0;
  const spendHasSpend = spendValues.some((value) => value > 0);

  const clear = useCallback(async () => {
    try {
      const response = await fetch("/api/xray", { method: "DELETE" });
      if (!response.ok) throw new Error("X-Ray trace could not be cleared");
      setSelectedEventId(undefined);
      setData((current) => ({ ...current, events: [], summary: { ...current.summary, total: 0, active: 0, capabilities: 0, models: 0, averageLatencyMs: 0, sessionTokens: 0 } }));
    } catch {
      setLoadError(true);
    }
  }, []);

  const copyRequest = useCallback(async () => {
    if (!selectedEvent) return;
    await navigator.clipboard.writeText(requestText(selectedEvent));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  }, [selectedEvent]);

  if (!open) return null;

  return (
    <section className="api-xray xray-v2 xray-v3" role="dialog" aria-modal="true" aria-label="Venice API X-Ray">
      <div className="xray-noise" />
      <header className="xray-header">
        <div className="xray-wordmark">
          <span className="xray-mark"><XrayIcon size={18} /></span>
          <div><strong>API X-ray</strong><span>Requests and billing</span></div>
          <span className={`xray-live-pill ${data.summary.active ? "is-active" : ""}`}><i />{data.summary.active ? `${data.summary.active} live` : "Live"}</span>
        </div>
        <div className="xray-header-actions">
          <div className="xray-period-control">
            <span>Range</span>
            <div className="xray-lookback" aria-label="Billing period">
              {(["7d", "30d", "90d"] as UsageLookback[]).map((period) => (
                <button className={lookback === period ? "is-active" : ""} onClick={() => setLookback(period)} key={period}>{period.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <span className="xray-toolbar-divider" aria-hidden="true" />
          <a className="xray-add-credits" href="https://venice.ai/settings/api" target="_blank" rel="noreferrer"><PlusIcon size={13} /><span className="xray-add-credits-label">Add credits</span></a>
          {data.events.length > 0 && <button className="xray-clear-trace" onClick={() => void clear()}>Clear trace</button>}
          <button className="xray-close" onClick={onClose} aria-label="Close API X-Ray" title="Return to chat"><CloseIcon size={18} /></button>
        </div>
      </header>

      <div className="xray-metrics xray-metrics-v2" aria-label="API usage summary">
        <div className={`xray-balance-metric ${balance && !balance.canConsume ? "has-warning" : ""}`}>
          <small>Current balance</small>
          {balance ? (
            <div className="xray-currency-values">
              <div><strong>{formatMoney(balance.balances.usd)}</strong><em>USD</em></div>
              <i aria-hidden="true" />
              <div><strong>{formatBalanceAmount(balance.balances.diem)}</strong><em>DIEM</em></div>
            </div>
          ) : <strong>N/A</strong>}
          {balance
            ? balanceStatus && <span>{balanceStatus}</span>
            : <span>{data.balanceError ?? "Connecting to Venice billing"}</span>}
        </div>
        <div>
          <small>Spend · {lookback.toUpperCase()}</small>
          {analytics ? (
            <div className="xray-currency-values">
              <div><strong>{formatMoney(totalUsd)}</strong><em>USD</em></div>
              <i aria-hidden="true" />
              <div><strong>{formatNumber(totalDiem)}</strong><em>DIEM</em></div>
            </div>
          ) : <strong>N/A</strong>}
          <span>{analytics ? `${formatNumber(billingTokens)} tokens` : "Waiting for billing"}</span>
        </div>
        <div><small>Requests</small><strong>{data.summary.total.toLocaleString()}</strong><span>{data.summary.active ? `${data.summary.active} currently running` : `${analytics?.byKey.length ?? 0} API keys in billing`}</span></div>
        <div><small>Average latency</small><strong>{data.summary.averageLatencyMs ? formatLatency(data.summary.averageLatencyMs) : "N/A"}</strong><span>per completed request</span></div>
      </div>

      <div className="xray-dashboard-body">
        <section className="xray-requests-panel">
          <div className="xray-dashboard-heading">
            <div><small>Requests</small><h2>Live API activity</h2></div>
            <span>Open any request to inspect its complete payload</span>
          </div>
          <div className="xray-request-columns" aria-hidden="true"><span>Request</span><span>Model and usage</span><span>Cost</span><span>Latency</span><span>Status</span><span /></div>
          <div className="xray-request-list" aria-live="polite">
            {loadError ? (
              <div className="xray-empty"><XrayIcon size={26} /><strong>Trace disconnected</strong><span>Trying to reconnect…</span></div>
            ) : data.events.length === 0 ? (
              <div className="xray-empty"><XrayIcon size={26} /><strong>Waiting for a Venice request</strong><span>Ask the agent something, use voice, search, or generate media. The request will appear here live.</span></div>
            ) : data.events.map((event) => {
              const cost = requestCost(event, analytics, rateByModel);
              const usage = requestUsage(event);
              const costUnavailable = event.capability !== "models" && !cost;
              return <button className={`xray-request-row is-${event.status}`} onClick={() => setSelectedEventId(event.id)} key={event.id}>
                <span className="xray-request-name"><i /><span><strong>{event.label}</strong><small><b>{event.method}</b> {event.endpoint} · {formatTime(event.startedAt)}</small>{event.error?.message && <small className="xray-error-summary" title={event.error.message}>Error: {event.error.message}</small>}</span></span>
                <span className="xray-request-model"><strong>{event.model ?? "No model"}</strong><small>{usage.primary} · {usage.secondary}</small></span>
                <span className="xray-request-cost" title={costUnavailable ? "This request is included in aggregate account billing." : cost?.note}>{cost ? requestCostText(cost) : event.capability === "models" ? "No charge" : "Included"}<small>{cost ? requestCostNote(cost) : event.capability === "models" ? "not billed" : "account billing"}</small></span>
                <span className="xray-request-latency">{formatLatency(event.latencyMs)}</span>
                <span className={`xray-request-status is-${event.status}`}><i />{event.status === "running" ? "LIVE" : event.status.toUpperCase()}</span>
                <span className="xray-request-open">›</span>
              </button>;
            })}
          </div>
        </section>

        <aside className="xray-insights-column">
          <section className="xray-spend-card">
            <div className="xray-dashboard-heading compact">
              <div><small>Billing</small><h2>Spend over time</h2></div>
              {bothUnits ? (
                <div className="xray-ranking-tabs xray-unit-tabs" role="group" aria-label="Billing unit">
                  <button className={useUsd ? "is-active" : ""} onClick={() => setSpendUnit("usd")}>USD</button>
                  <button className={!useUsd ? "is-active" : ""} onClick={() => setSpendUnit("diem")}>DIEM</button>
                </div>
              ) : <span className="xray-official"><i />Official API</span>}
            </div>
            {analytics ? (
              <>
                <div className="xray-spend-total">
                  <strong>{useUsd ? formatMoney(spend.usdTotal) : formatNumber(spend.diemTotal)}</strong>
                  <span>{useUsd ? "USD charged" : "DIEM used"}</span>
                  {bothUnits && <em className="xray-spend-alt">+ {useUsd ? `${formatNumber(spend.diemTotal)} DIEM` : `${formatMoney(spend.usdTotal)} USD`}</em>}
                </div>
                <div className="xray-spend-plot">
                  <div className="xray-spend-y-axis" aria-hidden="true">
                    <span>{formatChartValue(spendMax, useUsd)}</span>
                    <span>{formatChartValue(spendMax / 2, useUsd)}</span>
                    <span>{formatChartValue(0, useUsd)}</span>
                  </div>
                  <div className="xray-spend-chart">
                    {spendHasSpend ? <svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label={`Daily ${useUsd ? "USD" : "DIEM"} spend for the last ${lookback.toUpperCase()}`}>
                      {[4, 30, 56].map((y) => <line key={y} x1="0" y1={y} x2="100" y2={y} />)}
                      {spendValues.map((value, index) => {
                        const height = value > 0 ? Math.max(1, (value / spendMax) * 52) : 0;
                        const x = index * (spendBarWidth + spendGap);
                        return <rect className="xray-spend-bar" key={`${spend.days[index]?.date}-${index}`} x={x} y={56 - height} width={spendBarWidth} height={height} rx={Math.min(1.5, spendBarWidth / 3)}>
                          <title>{formatChartDate(spend.days[index]?.date ?? "")}: {useUsd ? formatMoney(value) : `${formatBalanceAmount(value)} DIEM`}</title>
                        </rect>;
                      })}
                    </svg> : <span>No spend in this period</span>}
                  </div>
                </div>
                <div className="xray-chart-axis">
                  <span>{spend.days[0]?.date ? formatChartDate(spend.days[0].date) : ""}</span>
                  <span>{spend.middleDay?.date ? formatChartDate(spend.middleDay.date) : ""}</span>
                  <span>Today</span>
                </div>
              </>
            ) : <div className="xray-billing-empty"><strong>Billing unavailable</strong><span>{data.analyticsError ?? "Connecting to Venice usage analytics…"}</span></div>}
          </section>

          <section className="xray-models-card">
            <div className="xray-dashboard-heading compact">
              <div><small>Breakdown</small><h2>{rankingView === "models" ? "Top models" : "API keys"}</h2></div>
              <div className="xray-ranking-tabs">
                <button className={rankingView === "models" ? "is-active" : ""} onClick={() => setRankingView("models")}>Models</button>
                <button className={rankingView === "keys" ? "is-active" : ""} onClick={() => setRankingView("keys")}>Keys</button>
              </div>
            </div>
            <div className="xray-model-ranking">
              {rankingView === "models" && (topModels.length ? topModels.map((model, index) => {
                const score = model.totalUsd + model.totalDiem || model.totalUnits;
                return <div className="xray-model-rank" key={`${model.modelName}-${model.unitType}`}>
                  <span className="xray-rank-number">{String(index + 1).padStart(2, "0")}</span>
                  <div><strong>{model.modelName}</strong><small>{model.modelType ?? "MODEL"} · {modelUnits(model)}</small><i style={{ width: `${Math.max(4, (score / Math.max(maxModelSpend, 0.000001)) * 100)}%` }} /></div>
                  <span className="xray-model-cost">{formatMoney(model.totalUsd)}<small>{formatNumber(model.totalDiem)} DIEM</small></span>
                </div>;
              }) : <div className="xray-billing-empty small"><span>{data.analyticsError ? "Top-model billing data is unavailable." : "No model usage in this period."}</span></div>)}
              {rankingView === "keys" && (topKeys.length ? topKeys.map((key, index) => {
                const score = key.totalUsd + key.totalDiem || key.totalUnits;
                const keySuffix = key.apiKeyId ? `•••• ${key.apiKeyId.slice(-4)}` : "Account app";
                return <div className="xray-model-rank" key={key.apiKeyId ?? key.description}>
                  <span className="xray-rank-number">{String(index + 1).padStart(2, "0")}</span>
                  <div><strong>{key.description || "Unnamed key"}</strong><small>{keySuffix}</small><i style={{ width: `${Math.max(4, (score / Math.max(maxKeySpend, 0.000001)) * 100)}%` }} /></div>
                  <span className="xray-model-cost">{formatMoney(key.totalUsd)}<small>{formatNumber(key.totalDiem)} DIEM</small></span>
                </div>;
              }) : <div className="xray-billing-empty small"><span>{data.analyticsError ? "API-key billing data is unavailable." : "No API-key usage in this period."}</span></div>)}
            </div>
          </section>
        </aside>
      </div>

      <div className="xray-capability-bar" aria-label="Venice capabilities used">
        <span className="xray-capability-label">Used in this trace</span>
        {usedCapabilities.map((item) => {
          const event = seenCapabilities.get(item.capability);
          return <span className={`${event ? "is-seen" : ""} ${event?.status === "running" ? "is-running" : ""}`} key={item.capability}><i>{item.glyph}</i>{item.title}</span>;
        })}
        {!usedCapabilities.length && <span className="xray-capability-empty">Waiting for requests</span>}
      </div>

      <footer className="xray-footer xray-footer-v2">
        <span><i /> Local request trace</span>
        <p>Secrets are redacted and media payloads are summarized</p>
        <code>{data.analyticsFetchedAt ? `Billing synced ${formatTime(data.analyticsFetchedAt)}` : "Billing connecting"}</code>
      </footer>

      {selectedEvent && (
        <aside className="xray-request-inspector" role="dialog" aria-modal="true" aria-label="Request inspector">
          <div className="xray-inspector-backdrop" onClick={() => setSelectedEventId(undefined)} />
          <section>
            <header>
              <div><small>Request inspector</small><h2>{selectedEvent.label}</h2></div>
              <button onClick={() => setSelectedEventId(undefined)} aria-label="Close request inspector"><CloseIcon size={17} /></button>
            </header>
            <div className="xray-inspector-statusline">
              <span className={`is-${selectedEvent.status}`}><i />{selectedEvent.status.toUpperCase()}</span>
              <code>{formatTime(selectedEvent.startedAt)}</code>
            </div>
            <div className="xray-inspector-metrics">
              <div><small>Model</small><strong>{selectedEvent.model ?? "N/A"}</strong></div>
              <div><small>Usage</small><strong>{requestUsage(selectedEvent).primary}</strong><span>{requestUsage(selectedEvent).secondary}</span></div>
              <div><small>Request cost</small><strong>{selectedCost ? requestCostText(selectedCost) : selectedEvent.capability === "models" ? "None" : "Not itemized"}</strong><span>{selectedCost ? requestCostNote(selectedCost) : selectedEvent.capability === "models" ? "This endpoint is not billed" : "Only present in aggregate account billing"}</span></div>
              <div><small>Latency</small><strong>{formatLatency(selectedEvent.latencyMs)}</strong></div>
              <div><small>HTTP</small><strong>{selectedEvent.statusCode ?? (selectedEvent.status === "running" ? "…" : "N/A")}</strong></div>
            </div>
            {selectedEvent.error && <section className="xray-error-card">
              <div><small>Error response</small>{selectedEvent.error.name && <span>{selectedEvent.error.name}</span>}</div>
              <strong>{selectedEvent.error.message}</strong>
              {selectedEvent.error.details && <pre><code>{selectedEvent.error.details}</code></pre>}
            </section>}
            <div className="xray-request-url"><b>{selectedEvent.method}</b><code>{selectedEvent.request?.url ?? `https://api.venice.ai/api/v1${selectedEvent.endpoint}`}</code></div>
            <div className="xray-payload-heading"><div><small>Exact request</small><span>Sensitive authorization redacted</span></div><button onClick={() => void copyRequest()}>{copied ? "Copied" : "Copy request"}</button></div>
            <pre className="xray-request-code"><code>{requestText(selectedEvent)}</code></pre>
            {selectedEvent.responseId && <div className="xray-response-id"><small>Response ID</small><code>{selectedEvent.responseId}</code></div>}
          </section>
        </aside>
      )}
    </section>
  );
}
