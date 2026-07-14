import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompatible } from "@earendil-works/pi-ai/api/openai-completions";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { completeApiTrace, describeApiTraceError, startApiTrace, traceRequestFromPayload, updateApiTrace, type ApiTraceUsage } from "./api-trace";
import { observeBillingBalance } from "./billing-balance-state";
import { getVeniceKey } from "./venice";

// Shared description of a Venice model over the OpenAI-completions API shape and
// the streaming function that talks to Venice. Used by both the primary agent
// and delegated sub-agents so there is a single source of truth.

export function makeModel(id: string, opts?: { reasoning?: boolean; supportsReasoningEffort?: boolean }): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "venice",
    baseUrl: "https://api.venice.ai/api/v1",
    // Reasoning is opt-in per turn: interactive typed chats surface a visible
    // thinking trace, while voice/vision/sub-agent/memory turns stay fast and
    // thinking-free. When true, pi-ai parses the model's reasoning deltas so we
    // can stream them to the UI.
    reasoning: opts?.reasoning === true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 198_000,
    maxTokens: 768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: true,
      supportsReasoningEffort: opts?.supportsReasoningEffort === true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "openai",
    },
  };
}

export function createVeniceStreamFn(timeoutMs = 12_000): StreamFn {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const hasVisualContext = context.messages.some((message) => (
      message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((part) => part.type === "image")
    ));
    const traceId = startApiTrace({
      capability: hasVisualContext ? "vision" : "chat",
      label: hasVisualContext ? "Understand vision" : "Reason with a model",
      method: "POST",
      endpoint: "/chat/completions",
      model: model.id,
      request: traceRequestFromPayload("/chat/completions", { model: model.id, stream: true }),
    });
    const callerOnPayload = options?.onPayload;
    const callerOnResponse = options?.onResponse;
    let statusCode: number | undefined;
    const stream = streamOpenAICompatible(model as Model<"openai-completions">, context, {
      ...options,
      apiKey: getVeniceKey(),
      maxRetries: 0,
      timeoutMs,
      onPayload: async (payload, responseModel) => {
        const transformed = await callerOnPayload?.(payload, responseModel);
        const callerPayload = transformed === undefined ? payload : transformed;
        const payloadRecord = callerPayload && typeof callerPayload === "object" ? callerPayload as Record<string, unknown> : undefined;
        const actualPayload = payloadRecord?.stream === true
          ? {
              ...payloadRecord,
              stream_options: {
                ...(payloadRecord.stream_options && typeof payloadRecord.stream_options === "object" ? payloadRecord.stream_options : {}),
                include_usage: true,
              },
            }
          : callerPayload;
        const payloadText = JSON.stringify(actualPayload);
        const hasVisualInput = payloadText.includes('"image_url"') || payloadText.includes('"video_url"');
        const usesWeb = /"enable_web_search":"(?:on|auto)"/.test(payloadText);
        updateApiTrace(traceId, {
          capability: usesWeb ? "web" : hasVisualInput ? "vision" : "chat",
          label: usesWeb ? "Research the web" : hasVisualInput ? "Understand vision" : "Reason with a model",
          model: responseModel.id,
          request: traceRequestFromPayload("/chat/completions", actualPayload),
        });
        return actualPayload;
      },
      onResponse: async (response, responseModel) => {
        statusCode = response.status;
        observeBillingBalance(response.headers);
        updateApiTrace(traceId, {
          statusCode: response.status,
          model: responseModel.id,
          responseId: response.headers["x-request-id"] ?? response.headers["cf-ray"],
        });
        await callerOnResponse?.(response, responseModel);
      },
    });
    void stream.result().then((message) => {
      const costUsd = message.usage.cost.total > 0 ? message.usage.cost.total : undefined;
      const usage: ApiTraceUsage | undefined = message.usage.totalTokens > 0 ? {
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cachedTokens: message.usage.cacheRead,
        totalTokens: message.usage.totalTokens,
        costUsd,
      } : undefined;
      completeApiTrace(
        traceId,
        message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "success",
        statusCode,
        {
          usage,
          responseId: message.responseId,
          ...(message.stopReason === "aborted" ? {
            error: describeApiTraceError(new DOMException(
              message.errorMessage ?? "Request was cancelled before completion.",
              "AbortError",
            )),
          } : message.stopReason === "error" ? {
            error: describeApiTraceError(message.errorMessage ?? "The Venice streaming request failed."),
          } : {}),
        },
      );
    }).catch((error) => {
      completeApiTrace(traceId, "error", statusCode, { error: describeApiTraceError(error) });
    });
    return stream;
  };
}
