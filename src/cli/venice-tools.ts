import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { DEFAULT_SETTINGS } from "../lib/app-types";
import {
  analyzeFramesFast,
  generateImage,
  quoteAndQueueMusic,
  quoteAndQueueVideo,
  searchWeb,
  veniceFetch,
} from "../lib/venice";
import { mutateMemory, searchMemories } from "../lib/memory";
import { DEFAULT_AGENT_ID } from "../lib/workspace";

const MEDIA_DIR = path.join(process.cwd(), ".gondola", "media");

const IMAGE_MIME_EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
};

function extForPath(filePath: string): string {
  return path.extname(filePath).replace(".", "").toLowerCase() || "png";
}

async function writeDataUrl(dataUrl: string, baseName: string): Promise<string> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Venice returned an unexpected media payload.");
  const ext = IMAGE_MIME_EXT[match[1]] ?? "bin";
  await mkdir(MEDIA_DIR, { recursive: true });
  const filePath = path.join(MEDIA_DIR, `${baseName}-${Date.now()}.${ext}`);
  await writeFile(filePath, Buffer.from(match[2], "base64"));
  return filePath;
}

/**
 * The Venice-backed capabilities the harness keeps from the companion: live web
 * research, image generation, seeing an image file, queueing video/music, TTS
 * playback, and durable memory. Everything routes through the Venice API.
 */
export function createVeniceTools(env: NodeExecutionEnv): AgentTool[] {
  const webSearch: AgentTool = {
    name: "search_web",
    label: "Search the live web",
    description: "Search current web information through Venice for news, docs, prices, or anything time-sensitive. Returns a grounded answer with source URLs.",
    parameters: Type.Object({ query: Type.String({ minLength: 3, maxLength: 1_500 }) }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = params as { query: string };
      return { content: [{ type: "text", text: await searchWeb(input.query, signal) }], details: { kind: "web_search" } };
    },
  };

  const image: AgentTool = {
    name: "generate_image",
    label: "Generate image",
    description: "Generate an image with Venice and save it to .gondola/media. Returns the saved file path.",
    parameters: Type.Object({ prompt: Type.String({ minLength: 3, maxLength: 1_500 }) }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = params as { prompt: string };
      const result = await generateImage(input.prompt, DEFAULT_SETTINGS.imageModel, signal);
      const filePath = await writeDataUrl(result.dataUrl, "image");
      return { content: [{ type: "text", text: `Image saved to ${filePath}` }], details: { kind: "image", path: filePath } };
    },
  };

  const analyzeImage: AgentTool = {
    name: "analyze_image",
    label: "See an image",
    description: "Look at an image file on disk and describe what is visibly present (faces, gestures, objects, scene). This is how the harness 'sees'.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      question: Type.Optional(Type.String({ maxLength: 400 })),
    }),
    async execute(_id, params, signal) {
      const input = params as { path: string; question?: string };
      const bytes = await readFile(input.path).catch(() => undefined);
      if (!bytes) throw new Error(`Cannot read image ${input.path}`);
      const ext = extForPath(input.path);
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
      const visual = await analyzeFramesFast(
        [dataUrl],
        input.question ?? "Describe what is visible in this image.",
        DEFAULT_SETTINGS.visionModel,
        signal,
      );
      const summary = [visual.description, visual.salient_event, visual.activity].filter(Boolean).join(" ");
      return { content: [{ type: "text", text: summary || "Nothing notable was visible." }], details: { kind: "vision", path: input.path } };
    },
  };

  const video: AgentTool = {
    name: "generate_video",
    label: "Generate video",
    description: "Quote and queue a Venice text-to-video job. Returns the quote and queue id; retrieval is asynchronous.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 3, maxLength: 2_000 }),
      duration: Type.Optional(Type.Union([Type.Literal("5s"), Type.Literal("10s"), Type.Literal("15s")])),
      quality: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("high")])),
      confirmed: Type.Optional(Type.Boolean()),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = params as { prompt: string; duration?: "5s" | "10s" | "15s"; quality?: "standard" | "high"; confirmed?: boolean };
      const details = await quoteAndQueueVideo(
        input.prompt,
        DEFAULT_SETTINGS,
        { duration: input.duration ?? "5s", quality: input.quality ?? "standard", soundtrack: "none" },
        input.confirmed === true,
        signal,
      );
      return { content: [{ type: "text", text: String(details.message ?? `Video job ${details.status}. Quote $${details.quote}.`) }], details };
    },
  };

  const music: AgentTool = {
    name: "generate_music",
    label: "Generate music",
    description: "Quote and queue a Venice music generation job. Returns the quote and queue id; retrieval is asynchronous.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 10, maxLength: 512 }),
      confirmed: Type.Optional(Type.Boolean()),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = params as { prompt: string; confirmed?: boolean };
      const details = await quoteAndQueueMusic(input.prompt, DEFAULT_SETTINGS, input.confirmed === true, signal);
      return { content: [{ type: "text", text: String(details.message ?? `Music job ${details.status}. Quote $${details.quote}.`) }], details };
    },
  };

  const speak: AgentTool = {
    name: "speak",
    label: "Speak aloud",
    description: "Speak a short line aloud through Venice text-to-speech (audio plays on the local machine). Use sparingly, only when talking would add value.",
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 600 }) }),
    async execute(_id, params, signal) {
      const input = params as { text: string };
      const response = await veniceFetch(
        "/audio/speech",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_SETTINGS.ttsModel,
            voice: DEFAULT_SETTINGS.voice,
            input: input.text,
            response_format: "mp3",
            speed: DEFAULT_SETTINGS.speed,
          }),
        },
        { retries: 0, signal },
      );
      await mkdir(MEDIA_DIR, { recursive: true });
      const filePath = path.join(MEDIA_DIR, `speech-${Date.now()}.mp3`);
      await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
      const played = await env.exec(`afplay ${JSON.stringify(filePath)}`, { timeout: 60, abortSignal: signal });
      const ok = played.ok && played.value.exitCode === 0;
      return {
        content: [{ type: "text", text: ok ? "Spoke the line aloud." : `Saved speech to ${filePath} (playback unavailable on this system).` }],
        details: { kind: "speech", path: filePath, played: ok },
      };
    },
  };

  const memory: AgentTool = {
    name: "memory",
    label: "Update memory",
    description: "Add, correct, or remove a durable, categorized personal memory stored locally.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
      content: Type.Optional(Type.String({ maxLength: 1_200 })),
      title: Type.Optional(Type.String({ maxLength: 80 })),
      old_text: Type.Optional(Type.String({ maxLength: 160 })),
    }),
    async execute(_id, params) {
      const input = params as { action: "add" | "replace" | "remove"; content?: string; title?: string; old_text?: string };
      const result = await mutateMemory({
        action: input.action,
        target: "memory",
        title: input.title,
        content: input.content,
        oldText: input.old_text,
        conversationId: "cli",
        agentId: DEFAULT_AGENT_ID,
        includePersonal: true,
      });
      return { content: [{ type: "text", text: result.message }], details: { kind: "memory", action: input.action } };
    },
  };

  const searchMemory: AgentTool = {
    name: "search_memory",
    label: "Search memory",
    description: "Search the local long-term memory archive for a personal fact.",
    parameters: Type.Object({ query: Type.String({ minLength: 2, maxLength: 240 }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })) }),
    async execute(_id, params) {
      const input = params as { query: string; limit?: number };
      const matches = await searchMemories(input.query, input.limit ?? 6);
      const text = matches.length
        ? matches.map((match) => `[${match.kind}] ${match.title}: ${match.content}`).join("\n")
        : "No matching long-term memory was found.";
      return { content: [{ type: "text", text }], details: { kind: "memory_search", count: matches.length } };
    },
  };

  return [webSearch, image, analyzeImage, video, music, speak, memory, searchMemory];
}
