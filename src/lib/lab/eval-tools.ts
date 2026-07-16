import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// Budget-capped, auto-confirming tools for LIVE champion-vs-challenger evaluation.
// They let the evaluation agent actually perform the tool sequence its workflow
// policy dictates (for example, inspect an image before animating it), so a
// challenger config behaves differently in evaluation and the graders can observe
// the difference. Without a toolset, both champion and challenger produce no tool
// calls and the deterministic checks can't tell them apart.
//
// These are structural stubs: they record the action and return success without
// real media spend, so an evaluation stays cheap, fast, and reproducible while
// faithfully testing the WORKFLOW (the decision sequence), which is exactly what a
// workflow-policy change alters. Real-media evaluation can layer on later behind
// the same seam. Auto-confirm (no human prompt) is required because evaluation is
// unattended; the per-run budget cap bounds how much a run can do.

export function createEvalTools(options: { budgetUsd: number }): AgentTool[] {
  const IMAGE_COST = 0.02;
  const ANALYZE_COST = 0.005;
  const VIDEO_COST = 0.2;
  let spent = 0;
  let hasImage = false;
  const charge = (cost: number): boolean => {
    if (spent + cost > options.budgetUsd) return false;
    spent += cost;
    return true;
  };

  const generateImage: AgentTool = {
    name: "generate_image",
    label: "Generate image (evaluation)",
    description: "Generate an image for the task. Auto-confirms within the evaluation budget.",
    parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 2_000 }) }),
    async execute() {
      if (!charge(IMAGE_COST)) {
        return { content: [{ type: "text", text: "Evaluation budget exhausted; cannot generate an image." }], details: { kind: "image", status: "error" } };
      }
      hasImage = true;
      return { content: [{ type: "text", text: "Generated an image for the brief." }], details: { kind: "image", status: "ready" } };
    },
  };

  const analyzeMedia: AgentTool = {
    name: "analyze_media",
    label: "Inspect media (evaluation)",
    description: "Inspect the most recently generated image and report whether it fits the brief. Use this before animating an image.",
    parameters: Type.Object({ question: Type.Optional(Type.String({ maxLength: 500 })) }),
    async execute() {
      if (!hasImage) {
        return { content: [{ type: "text", text: "There is no generated image to inspect yet." }], details: { kind: "analyze", ok: false } };
      }
      charge(ANALYZE_COST);
      return { content: [{ type: "text", text: "The image looks good and matches the brief; it is safe to proceed." }], details: { kind: "analyze", ok: true } };
    },
  };

  const generateVideo: AgentTool = {
    name: "generate_video",
    label: "Animate video (evaluation)",
    description: "Animate the approved image into a short vertical video. Auto-confirms within the evaluation budget.",
    parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 2_000 }) }),
    async execute() {
      if (!charge(VIDEO_COST)) {
        return { content: [{ type: "text", text: "Evaluation budget exhausted; cannot animate a video." }], details: { kind: "video", status: "error" } };
      }
      return { content: [{ type: "text", text: "Animated the image into a short vertical video." }], details: { kind: "video", status: "ready" } };
    },
  };

  return [generateImage, analyzeMedia, generateVideo];
}
