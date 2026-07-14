export type ApiCapability =
  | "chat"
  | "vision"
  | "transcription"
  | "speech"
  | "web"
  | "image"
  | "video"
  | "music"
  | "models"
  | "embeddings";

export type ApiTraceStatus = "running" | "success" | "error" | "aborted";

export interface ApiTraceRequest {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiTraceUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd?: number;
  requestUnits?: number;
  requestUnit?: "characters" | "bytes";
}

export interface ApiTraceError {
  name?: string;
  message: string;
  details?: string;
}

export interface ApiTraceEvent {
  id: string;
  capability: ApiCapability;
  label: string;
  method: string;
  endpoint: string;
  model?: string;
  request?: ApiTraceRequest;
  usage?: ApiTraceUsage;
  responseId?: string;
  status: ApiTraceStatus;
  startedAt: number;
  finishedAt?: number;
  latencyMs?: number;
  statusCode?: number;
  error?: ApiTraceError;
}

interface ApiTraceState {
  schemaVersion: number;
  events: ApiTraceEvent[];
}

const TRACE_SCHEMA_VERSION = 4;
const MAX_TRACE_EVENTS = 500;
const MAX_BODY_CHARS = 48_000;
const MAX_ERROR_CHARS = 12_000;
const traceGlobal = globalThis as typeof globalThis & { __veniceApiTraceState?: ApiTraceState };
// Hot reload keeps globals alive. Drop rows captured by the old schema instead
// of presenting incomplete payloads as if they were exact requests.
const traceState = traceGlobal.__veniceApiTraceState?.schemaVersion === TRACE_SCHEMA_VERSION
  ? traceGlobal.__veniceApiTraceState
  : { schemaVersion: TRACE_SCHEMA_VERSION, events: [] };
traceGlobal.__veniceApiTraceState = traceState;

function safeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim().slice(0, 100);
  return model || undefined;
}

function mediaPlaceholder(value: string): string | undefined {
  const match = value.match(/^data:([^;,]+)[;,]/i);
  if (!match || !/^(?:image|video|audio)\//i.test(match[1])) return undefined;
  const approximateBytes = Math.round(value.length * 0.75);
  return `[${match[1]} payload omitted · ${Math.max(1, Math.round(approximateBytes / 1_024))} KB]`;
}

function sanitizeRequestValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const media = mediaPlaceholder(value);
    if (media) return media;
    return value.length > 16_000 ? `${value.slice(0, 16_000)}\n… [${value.length - 16_000} characters omitted]` : value;
  }
  if (value === undefined) return undefined;
  if (depth >= 9) return "[nested value omitted]";
  if (typeof File !== "undefined" && value instanceof File) {
    return `[file ${value.name || "upload"} · ${value.type || "unknown type"} · ${Math.max(1, Math.round(value.size / 1_024))} KB]`;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return `[blob ${value.type || "unknown type"} · ${Math.max(1, Math.round(value.size / 1_024))} KB]`;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => sanitizeRequestValue(item, depth + 1));
    if (value.length > 100) items.push(`[${value.length - 100} items omitted]`);
    return items;
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries.slice(0, 100)) {
      if (/^(?:authorization|api[_-]?key|access[_-]?token|secret)$/i.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = sanitizeRequestValue(entry, depth + 1);
      }
    }
    if (entries.length > 100) output.__omitted = `${entries.length - 100} fields`;
    return output;
  }
  return String(value);
}

function stringifyRequestBody(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(sanitizeRequestValue(value), null, 2);
  } catch {
    text = String(value);
  }
  return text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}\n… [request preview truncated]`
    : text;
}

function errorDetails(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let text: string;
  try {
    text = typeof value === "string"
      ? value
      : JSON.stringify(sanitizeRequestValue(value), null, 2);
  } catch {
    text = String(value);
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ERROR_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_CHARS)}\n… [error details truncated]`
    : trimmed;
}

export function describeApiTraceError(error: unknown): ApiTraceError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : typeof record?.error === "string"
        ? record.error
        : typeof error === "string"
          ? error
          : "The Venice request failed.";
  const cause = record?.cause && typeof record.cause === "object"
    ? record.cause as Record<string, unknown>
    : undefined;
  const causeFields = cause ? {
    message: cause.message,
    code: cause.code,
    errno: cause.errno,
    syscall: cause.syscall,
    hostname: cause.hostname,
  } : undefined;
  const causeDetails = causeFields && Object.values(causeFields).some((value) => value !== undefined)
    ? causeFields
    : undefined;
  const abortContext = error instanceof Error && error.name === "AbortError"
    ? "This request was cancelled locally. Common causes are interrupting the agent, sending a newer message, changing chats, closing voice mode, or the browser disconnecting. Venice does not return an API error body for a locally cancelled request."
    : undefined;
  const details = errorDetails(record?.body ?? causeDetails ?? abortContext);
  return {
    ...(error instanceof Error && error.name ? { name: error.name } : {}),
    message: message.trim().slice(0, 2_000) || "The Venice request failed.",
    ...(details && details !== message.trim() ? { details } : {}),
  };
}

function formDataSnapshot(form: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    const next = sanitizeRequestValue(value);
    const existing = result[key];
    result[key] = existing === undefined ? next : Array.isArray(existing) ? [...existing, next] : [existing, next];
  }
  return result;
}

export function traceRequestFromPayload(path: string, payload: unknown, method = "POST"): ApiTraceRequest {
  return {
    url: `https://api.venice.ai/api/v1${path}`,
    headers: {
      Authorization: "Bearer ••••••••••••",
      "Content-Type": "application/json",
    },
    body: stringifyRequestBody(payload),
  };
}

function traceRequestFromInit(path: string, init: RequestInit): ApiTraceRequest {
  const headers = new Headers(init.headers);
  const contentType = headers.get("content-type");
  let body: unknown;
  if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  } else if (typeof FormData !== "undefined" && init.body instanceof FormData) {
    body = formDataSnapshot(init.body);
  }
  return {
    url: `https://api.venice.ai/api/v1${path}`,
    headers: {
      Authorization: "Bearer ••••••••••••",
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body: stringifyRequestBody(body),
  };
}

function requestBodyMetadata(init: RequestInit): {
  model?: string;
  jsonText?: string;
  webSearch?: boolean;
  requestUnits?: number;
  requestUnit?: "characters" | "bytes";
} {
  if (typeof init.body === "string") {
    try {
      const parsed = JSON.parse(init.body) as {
        model?: unknown;
        input?: unknown;
        venice_parameters?: { enable_web_search?: unknown };
      };
      return {
        model: safeModel(parsed.model),
        jsonText: init.body,
        webSearch: parsed.venice_parameters?.enable_web_search === "on",
        ...(typeof parsed.input === "string" ? { requestUnits: parsed.input.length, requestUnit: "characters" as const } : {}),
      };
    } catch {
      return {};
    }
  }
  if (typeof FormData !== "undefined" && init.body instanceof FormData) {
    const file = init.body.get("file");
    return {
      model: safeModel(init.body.get("model")),
      ...(typeof Blob !== "undefined" && file instanceof Blob ? { requestUnits: file.size, requestUnit: "bytes" as const } : {}),
    };
  }
  return {};
}

export function describeVeniceRequest(path: string, init: RequestInit = {}): Omit<ApiTraceEvent, "id" | "status" | "startedAt"> {
  const endpoint = path.split("?")[0] || path;
  const metadata = requestBodyMetadata(init);
  const method = (init.method ?? "GET").toUpperCase();
  const request = traceRequestFromInit(path, init);
  const requestUsage: ApiTraceUsage | undefined = metadata.requestUnits && metadata.requestUnit
    ? {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        requestUnits: metadata.requestUnits,
        requestUnit: metadata.requestUnit,
      }
    : undefined;

  if (endpoint === "/audio/transcriptions") {
    return { capability: "transcription", label: "Hear speech", method, endpoint, model: metadata.model, request, usage: requestUsage };
  }
  if (endpoint === "/audio/speech") {
    return { capability: "speech", label: "Speak naturally", method, endpoint, model: metadata.model, request, usage: requestUsage };
  }
  if (endpoint.startsWith("/image")) {
    return { capability: "image", label: "Create image", method, endpoint, model: metadata.model, request };
  }
  if (endpoint.startsWith("/video")) {
    return { capability: "video", label: "Create video", method, endpoint, model: metadata.model, request };
  }
  if (endpoint.startsWith("/audio/")) {
    return { capability: "music", label: "Create music", method, endpoint, model: metadata.model, request };
  }
  if (endpoint === "/models") {
    return { capability: "models", label: "Discover models", method, endpoint, request };
  }
  if (endpoint === "/embeddings") {
    return { capability: "embeddings", label: "Create embeddings", method, endpoint, model: metadata.model, request };
  }
  if (endpoint === "/augment/search") {
    return { capability: "web", label: "Research the web", method, endpoint, request };
  }
  if (endpoint === "/chat/completions") {
    if (metadata.webSearch) {
      return { capability: "web", label: "Research the web", method, endpoint, model: metadata.model, request };
    }
    const hasVisualInput = metadata.jsonText?.includes('"image_url"') || metadata.jsonText?.includes('"video_url"');
    return {
      capability: hasVisualInput ? "vision" : "chat",
      label: hasVisualInput ? "Understand vision" : "Reason with a model",
      method,
      endpoint,
      model: metadata.model,
      request,
    };
  }
  return { capability: "chat", label: "Venice request", method, endpoint, model: metadata.model, request };
}

export function startApiTrace(input: Omit<ApiTraceEvent, "id" | "status" | "startedAt">): string {
  const id = crypto.randomUUID();
  traceState.events.unshift({ ...input, id, status: "running", startedAt: Date.now() });
  if (traceState.events.length > MAX_TRACE_EVENTS) traceState.events.length = MAX_TRACE_EVENTS;
  return id;
}

export function updateApiTrace(id: string, patch: Partial<Omit<ApiTraceEvent, "id" | "startedAt">>): void {
  const index = traceState.events.findIndex((event) => event.id === id);
  if (index < 0) return;
  traceState.events[index] = { ...traceState.events[index], ...patch };
}

export function completeApiTrace(
  id: string,
  status: Exclude<ApiTraceStatus, "running">,
  statusCode?: number,
  details: Pick<ApiTraceEvent, "usage" | "responseId" | "error"> = {},
): void {
  const index = traceState.events.findIndex((event) => event.id === id);
  if (index < 0) return;
  const currentStatus = traceState.events[index].status;
  // Body parsing happens after the response stream closes. Permit a parser to
  // correct an optimistic stream success when the payload itself is invalid.
  if (currentStatus !== "running" && !(currentStatus === "success" && status === "error")) return;
  const finishedAt = Date.now();
  const finalDetails = status === "aborted" && !details.error
    ? {
        ...details,
        error: {
          name: "AbortError",
          message: "Request was cancelled before completion.",
          details: "This was cancelled locally, not rejected by Venice. Common causes are interrupting the agent, sending a newer message, changing chats, closing voice mode, or the browser disconnecting. No Venice error body exists for a locally cancelled request.",
        },
      }
    : details;
  traceState.events[index] = {
    ...traceState.events[index],
    ...finalDetails,
    status,
    statusCode: statusCode ?? traceState.events[index].statusCode,
    finishedAt,
    latencyMs: Math.max(0, finishedAt - traceState.events[index].startedAt),
  };
}

export function listApiTraces(): ApiTraceEvent[] {
  const now = Date.now();
  for (const event of traceState.events) {
    if (event.status !== "running" || now - event.startedAt < 90_000) continue;
    event.status = "aborted";
    event.finishedAt = event.startedAt + 90_000;
    event.latencyMs = 90_000;
    event.error = {
      name: "TimeoutError",
      message: "Trace stopped without a final response after 90 seconds.",
      details: "The request did not report completion, so API X-ray marked it as aborted locally.",
    };
  }
  for (const event of traceState.events) {
    if (event.status !== "aborted" || event.error) continue;
    event.error = {
      name: "AbortError",
      message: "Request was cancelled before completion.",
      details: "This was cancelled locally, so Venice did not return an API error body.",
    };
  }
  return traceState.events.map((event) => ({ ...event, request: event.request ? { ...event.request, headers: { ...event.request.headers } } : undefined }));
}

export function clearApiTraces(): void {
  traceState.events.length = 0;
}
