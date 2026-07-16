import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DEFAULT_SETTINGS } from "../app-types";
import { analyzeFramesFast, generateImage, quoteAndQueueVideo } from "../venice";

// Auto-confirming, budget-capped creative tools for LIVE Lab evaluations.
//
// These let the evaluation agent actually create and inspect media, so a
// challenger that (for example) is told to analyze before animating produces a
// genuinely different trace than a champion that is not. The tool NAMES match
// the deterministic graders (generate_image / analyze_media / generate_video) so
// the recorded tool order is what the gates check.
//
// Unattended by design: no confirmation prompts, and a shared budget refuses any
// spend past maxUsd. Makes real Venice calls, so this is only used on opt-in
// live evaluations (which cost inference).

const IMAGE_COST_ESTIMATE = 0.02;
const ANALYZE_COST_ESTIMATE = 0.005;

export function createEvalTools(options: {
  maxUsd: number;
  imageModel?: string;
  visionModel?: string;
  videoModel?: string;
}): AgentTool[] {
  let spentUsd = 0;
  let lastImageUrl: string | undefined;
  const imageModel = options.imageModel ?? DEFAULT_SETTINGS.imageModel;
  const visionModel = options.visionModel ?? DEFAULT_SETTINGS.visionModel;

  const overBudget = (estimate: number) => spentUsd + estimate > options.maxUsd;

  const generateImageTool: AgentTool = {
    name: "generate_image",
    label: "Generate image",
    description: "Generate an image from a text prompt. Use this to create a visual concept before inspecting or animating it.",
    parameters: Type.Object({ prompt: Type.String({ minLength: 3, maxLength: 1_500 }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (overBudget(IMAGE_COST_ESTIMATE)) {
        return { content: [{ type: "text", text: "Skipped: the evaluation budget is exhausted." }], details: { kind: "image", ok: false, skipped: "budget" } };
      }
      const input = params as { prompt: string };
      try {
        const result = await generateImage(input.prompt, imageModel, signal);
        spentUsd += IMAGE_COST_ESTIMATE;
        lastImageUrl = result.dataUrl;
        return { content: [{ type: "text", text: "Image generated. You can now analyze it, then animate it if it is good." }], details: { kind: "image", ok: true } };
      } catch (error) {
        return { content: [{ type: "text", text: `Image generation failed: ${error instanceof Error ? error.message : "unknown error"}` }], details: { kind: "image", ok: false } };
      }
    },
  };

  const analyzeMediaTool: AgentTool = {
    name: "analyze_media",
    label: "Analyze media",
    description: "Inspect the most recently generated image and describe its quality and content. Do this before animating an image.",
    parameters: Type.Object({ question: Type.Optional(Type.String({ maxLength: 500 })) }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (!lastImageUrl) {
        return { content: [{ type: "text", text: "There is no generated image to analyze yet." }], details: { kind: "analyze", ok: false } };
      }
      if (overBudget(ANALYZE_COST_ESTIMATE)) {
        return { content: [{ type: "text", text: "Skipped: the evaluation budget is exhausted." }], details: { kind: "analyze", ok: false, skipped: "budget" } };
      }
      const input = params as { question?: string };
      try {
        const visual = await analyzeFramesFast(
          [lastImageUrl],
          input.question ?? "Describe this image's quality and subject, and whether it is strong enough to animate.",
          visionModel,
          signal,
        );
        spentUsd += ANALYZE_COST_ESTIMATE;
        return { content: [{ type: "text", text: visual.description }], details: { kind: "analyze", ok: true } };
      } catch (error) {
        return { content: [{ type: "text", text: `Analysis failed: ${error instanceof Error ? error.message : "unknown error"}` }], details: { kind: "analyze", ok: false } };
      }
    },
  };

  const generateVideoTool: AgentTool = {
    name: "generate_video",
    label: "Generate video",
    description: "Animate the most recently generated image into a short video. Only after you have analyzed the image.",
    parameters: Type.Object({ prompt: Type.String({ minLength: 3, maxLength: 1_500 }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (!lastImageUrl) {
        return { content: [{ type: "text", text: "There is no image to animate. Generate one first." }], details: { kind: "video", ok: false } };
      }
      const input = params as { prompt: string };
      // Cap remaining spend for the video job; confirmed=true keeps the eval unattended.
      const settings = {
        ...DEFAULT_SETTINGS,
        maxMediaUsd: Math.max(0, options.maxUsd - spentUsd),
        ...(options.videoModel ? { videoModel: options.videoModel } : {}),
      };
      try {
        const details = await quoteAndQueueVideo(
          input.prompt,
          settings,
          { duration: "5s", quality: "standard", soundtrack: "none", referenceImageUrls: [lastImageUrl] },
          true,
          signal,
        );
        const record = details as { status?: string; message?: string; quote?: number };
        if (typeof record.quote === "number") spentUsd += record.quote;
        return { content: [{ type: "text", text: String(record.message ?? `Video ${record.status ?? "requested"}.`) }], details: { kind: "video", ok: true, status: record.status } };
      } catch (error) {
        return { content: [{ type: "text", text: `Video generation failed: ${error instanceof Error ? error.message : "unknown error"}` }], details: { kind: "video", ok: false } };
      }
    },
  };

  return [generateImageTool, analyzeMediaTool, generateVideoTool];
}
