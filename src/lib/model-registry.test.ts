import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatModelRequest, routeModel, routeModelLive, toModelCapability, usableChatModels, type ModelCapability } from "./model-registry";

const textFast: ModelCapability = {
  id: "fast-text", provider: "venice", type: "text",
  modalities: { input: ["text"], output: ["text"] },
  supportsTools: true, supportsReasoning: false, supportsStructuredOutput: true,
  contextTokens: 32_000, strengths: ["fast", "chat"], typicalTasks: ["chat"],
  pricing: { inputPerMillion: 0.5 }, private: true,
};
const textReasoner: ModelCapability = {
  id: "smart-text", provider: "venice", type: "text",
  modalities: { input: ["text", "image"], output: ["text"] },
  supportsTools: true, supportsReasoning: true, supportsStructuredOutput: true,
  contextTokens: 200_000, strengths: ["reasoning", "research"], typicalTasks: ["research", "analysis"],
  pricing: { inputPerMillion: 6 }, private: false,
};
const imageModel: ModelCapability = {
  id: "image-1", provider: "venice", type: "image",
  modalities: { input: ["text", "image"], output: ["image"] },
  supportsTools: false, supportsReasoning: false, supportsStructuredOutput: false,
  strengths: ["photorealistic"], typicalTasks: ["image"], private: true,
};
const registry = [textFast, textReasoner, imageModel];

test("routeModel filters by output modality", () => {
  const result = routeModel({ outputModalities: ["image"] }, registry);
  assert.equal(result.model, "image-1");
});

test("routeModel requires reasoning and vision when asked", () => {
  const result = routeModel({ inputModalities: ["text", "image"], outputModalities: ["text"], needsReasoning: true }, registry);
  assert.equal(result.model, "smart-text");
  assert.ok(result.explanation.includes("smart-text"));
});

test("routeModel honors a max input cost constraint", () => {
  const result = routeModel({ outputModalities: ["text"], maxInputCostPerMillionUsd: 1 }, registry);
  assert.equal(result.model, "fast-text");
});

test("routeModel prefers the cheapest when asked and explains why", () => {
  const result = routeModel({ outputModalities: ["text"], prefer: "cheapest" }, registry);
  assert.equal(result.model, "fast-text");
  assert.ok(result.candidates.length >= 2);
  assert.ok(result.candidates[0].reasons.length > 0);
});

test("routeModel returns no model with a clear explanation when nothing fits", () => {
  const result = routeModel({ needsReasoning: true, outputModalities: ["image"] }, registry);
  assert.equal(result.model, undefined);
  assert.ok(/No model satisfies/.test(result.explanation));
});

test("routeModelLive uses the cached registry and returns an explainable pick", async () => {
  // Seed the process-global registry cache so no network call is made.
  (globalThis as typeof globalThis & { __veniceModelRegistry?: { models: ModelCapability[]; expiresAt: number } })
    .__veniceModelRegistry = { models: registry, expiresAt: Date.now() + 60_000 };
  const result = await routeModelLive({ outputModalities: ["text"], prefer: "cheapest" });
  assert.ok(result, "a routing result should be returned from the cached registry");
  assert.equal(result.model, "fast-text");
  assert.ok(result.explanation.includes("fast-text"));
});

test("usableChatModels keeps only tool-capable text models", () => {
  assert.deepEqual(usableChatModels(registry).map((model) => model.id).sort(), ["fast-text", "smart-text"]);
});

test("resolveChatModelRequest reports a foreign provider and offers real alternatives", () => {
  const result = resolveChatModelRequest("change to claude 4.8", registry);
  assert.equal(result.model, undefined);
  assert.equal(result.foreign, "claude");
  assert.ok(result.alternatives.length > 0);
  assert.ok(result.alternatives.every((model) => model.type === "text"));
});

test("resolveChatModelRequest matches a Venice id by normalized substring", () => {
  const glm: ModelCapability = {
    id: "zai-org-glm-5-2", provider: "venice", type: "text",
    modalities: { input: ["text"], output: ["text"] },
    supportsTools: true, supportsReasoning: false, supportsStructuredOutput: true,
    contextTokens: 64_000, strengths: [], typicalTasks: [], private: true,
  };
  assert.equal(resolveChatModelRequest("glm 5.2", [glm, ...registry]).model?.id, "zai-org-glm-5-2");
});

test("resolveChatModelRequest routes a descriptor to a concrete model", () => {
  assert.equal(resolveChatModelRequest("switch to the fastest model", registry).model?.id, "fast-text");
  assert.equal(resolveChatModelRequest("use your best reasoning model", registry).model?.id, "smart-text");
});

test("toModelCapability derives modalities and flags from the catalog shape", () => {
  const capability = toModelCapability({
    id: "m1",
    type: "text",
    model_spec: {
      capabilities: { supportsVision: true, supportsReasoning: true, supportsFunctionCalling: true },
      constraints: { contextTokens: 128_000 },
      traits: ["reasoning"],
      privacy: "private",
    },
  });
  assert.deepEqual(capability.modalities.input, ["text", "image"]);
  assert.deepEqual(capability.modalities.output, ["text"]);
  assert.equal(capability.supportsReasoning, true);
  assert.equal(capability.supportsTools, true);
  assert.equal(capability.contextTokens, 128_000);
  assert.equal(capability.private, true);
});
