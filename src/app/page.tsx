"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgentPresence } from "@/components/AgentPresence";
import { ApiXray } from "@/components/ApiXray";
import {
  CameraIcon,
  ChatIcon,
  ChevronDownIcon,
  ClockIcon,
  TrashIcon,
  CloseIcon,
  ImageIcon,
  MemoryIcon,
  MicIcon,
  PanelLeftIcon,
  FileTextIcon,
  PaperclipIcon,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  PulseIcon,
  SendIcon,
  SettingsIcon,
  SparkleIcon,
  StopIcon,
  VolumeIcon,
} from "@/components/Icons";
import { ModelPicker } from "@/components/ModelPicker";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { WorkspaceDrawer, type WorkspaceTab } from "@/components/WorkspaceDrawer";
import { ConversationSearch } from "@/components/ConversationSearch";
import { Onboarding, type SetupStatusView } from "@/components/Onboarding";
import {
  DEFAULT_SETTINGS,
  DEFAULT_PRESENCE,
  REALTIME_MULTIMODAL_MODEL,
  type AgentPhase,
  type AgentSettings,
  type AvatarAction,
  type CatalogModel,
  type MediaArtifact,
  type MouthViseme,
  type PresenceDirective,
  type ReasoningEffort,
  type VisualState,
  type WorkspaceMessage,
  type WorkspaceSnapshot,
} from "@/lib/app-types";
import { needsLiveWebResearch } from "@/lib/conversation";
import { FEATURES } from "@/lib/features";
import { supportedReasoningEfforts } from "@/lib/model-capabilities";
import { removeEmDashes } from "@/lib/text-style";
import { takeEarlySpeechSegment } from "@/lib/voice-latency";

interface MessageAttachment {
  name: string;
  kind: "image" | "text";
  dataUrl?: string;
  size?: number;
}

interface ChatAttachment extends MessageAttachment {
  id: string;
  mime: string;
  size: number;
  text?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  queued?: boolean;
  streaming?: boolean;
  statusText?: string;
  attachments?: MessageAttachment[];
  mediaIds?: string[];
  createdAt: number;
  /** Streamed model reasoning (typed chats only). */
  thinking?: string;
  /** True while the reasoning trace is still streaming in. */
  thinkingStreaming?: boolean;
  /** Wall-clock start of the reasoning, used to compute the final duration. */
  thinkingStartedAt?: number;
  /** How long the model spent reasoning, in ms (set once thinking finishes). */
  thinkingMs?: number;
  /** Live delegated-worker (sub-agent) runs spawned during this turn. */
  subagents?: SubAgentRun[];
}

interface QueuedMessage {
  id: string;
  conversationId: string;
  message: string;
  attachments: ChatAttachment[];
  createdAt: number;
}

interface SendMessageOptions {
  hidden?: boolean;
  silent?: boolean;
  voiceTurn?: boolean;
  skipCameraPrompt?: boolean;
  attachments?: ChatAttachment[];
  fromQueue?: boolean;
  existingUserMessageId?: string;
}

function queuedChatMessage(item: QueuedMessage): ChatMessage {
  return {
    id: item.id,
    role: "user",
    text: item.message,
    queued: true,
    attachments: item.attachments.map((attachment) => ({
      name: attachment.name,
      kind: attachment.kind,
      dataUrl: attachment.dataUrl,
      size: attachment.size,
    })),
    createdAt: item.createdAt,
  };
}

interface SubAgentStep {
  tool: string;
}

interface SubAgentRun {
  id: string;
  task: string;
  steps: SubAgentStep[];
  turns: number;
  toolCalls: number;
  running: boolean;
  hitBudget?: boolean;
  ok?: boolean;
}

const TEXT_FILE_PATTERN = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|bash|zsh|sql|env|toml|ini|conf|gitignore|dockerfile)$/i;
const MAX_ATTACHMENT_TEXT_CHARS = 20_000;
const MAX_ATTACHMENT_IMAGE_BYTES = 6_000_000;
const MAX_ATTACHMENTS = 6;

function isTextFile(file: File): boolean {
  return file.type.startsWith("text/")
    || /(json|csv|xml|yaml|javascript|typescript|markdown)/.test(file.type)
    || TEXT_FILE_PATTERN.test(file.name);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsText(file);
  });
}

async function responseBlobWithTimeout(
  response: Response,
  controller: AbortController,
  timeoutMs = 15_000,
): Promise<Blob> {
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await response.blob();
  } finally {
    window.clearTimeout(timeout);
  }
}

interface AgentStreamEvent {
  type: string;
  delta?: string;
  name?: string;
  message?: string;
  details?: Record<string, unknown>;
  isError?: boolean;
  resultText?: string;
  // Sub-agent (delegated worker) progress events.
  id?: string;
  task?: string;
  phase?: "tool" | "turn";
  tool?: string;
  turn?: number;
  turns?: number;
  toolCalls?: number;
  hitBudget?: boolean;
  ok?: boolean;
}

interface SpeechFrame {
  level: number;
  viseme: MouthViseme;
}

interface PreparedSpeech {
  controller: AbortController;
  promise: Promise<Blob>;
}

interface SpeechQueueItem {
  text: string;
  deliveryHint?: VisualState["reaction_delivery"];
  fast?: boolean;
  prepared?: PreparedSpeech;
}

interface ConversationPayload {
  conversation: WorkspaceSnapshot["conversations"][number];
  messages: WorkspaceMessage[];
}

type RecordingPurpose = "conversation" | "dictation";

function welcomeMessage(agentName: string): ChatMessage {
  const introduction = agentName === "Entity"
    ? "Hi, I’m your Entity. I don’t have a name yet. What would you like to call me?"
    : `Hi, I’m ${agentName}.`;
  return {
    id: `welcome-${agentName}`,
    role: "assistant",
    text: `${introduction} Turn on the camera and I can look at you, or simply start a conversation. I can react, use assigned skills and tools, and create media with Venice.`,
    createdAt: Date.now(),
  };
}

function conversationMessages(messages: WorkspaceMessage[], agentName: string): ChatMessage[] {
  if (!messages.length) return [welcomeMessage(agentName)];
  return messages.filter((message) => !isInternalMediaConfirmation(message.text)).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
  }));
}

function isInternalMediaConfirmation(text: string): boolean {
  const value = text.trim();
  return /^I confirm the quoted \$\d+(?:\.\d+)? (?:video|music)\./i.test(value)
    && /Set confirmed=true\.?$/i.test(value);
}

const homeSuggestions = [
  { Icon: SparkleIcon, label: "Introduce yourself", prompt: "Introduce yourself naturally and tell me what you can help with." },
  { Icon: CameraIcon, label: "Look at me", prompt: "Look at me. What visible expression or gesture am I making right now?" },
  { Icon: ImageIcon, label: "Create an image", prompt: "Generate a cinematic portrait of a friendly bioluminescent alien." },
  { Icon: FileTextIcon, label: "Plan my day", prompt: "Help me plan my day. Ask me what matters most, then draft a simple plan." },
];

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function actionFromVisual(visual: VisualState): AvatarAction {
  if (visual.expression.smile > 0.58) return "smile";
  if (visual.expression.mouth_open > 0.72 || visual.expression.brows_raised > 0.75) return "surprised";
  if (visual.head.direction === "left") return "look_left";
  if (visual.head.direction === "right") return "look_right";
  if (visual.head.tilt !== "center") return "tilt";
  return "neutral";
}

function stripForSpeech(text: string): string {
  return text
    .replace(/\n\s*Sources:\s*[\s\S]*$/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_#>`]/g, "")
    .replace(/\^\d+(?:,\d+)*\^/g, "")
    .replace(/[\u2013\u2014]+/g, ", ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\.{3,}/g, ",")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function speechDirection(text: string, hint?: VisualState["reaction_delivery"]): string {
  const lower = text.toLowerCase();
  if (hint === "playful") return "Playful and amused, with a light smile in the voice. Keep it natural, not theatrical.";
  if (hint === "surprised") return "Genuinely and pleasantly surprised, with lively emphasis and a natural conversational rhythm.";
  if (hint === "curious") return "Warmly curious and attentive, with gentle upward inflection and natural pacing.";
  if (hint === "gentle") return "Gentle, reassuring, and emotionally present. Speak a little more slowly with soft emphasis.";
  if (hint === "warm") return "Warm, friendly, and present, with subtle emotion and natural conversational emphasis.";
  if (/\b(sorry|unfortunately|difficult|worry|afraid|can(?:not|'t))\b/.test(lower)) {
    return "Gentle, empathetic, and reassuring. Use a soft tone and unhurried pauses without sounding gloomy.";
  }
  if (/!|\b(amazing|great|love|wonderful|fantastic|perfect|yes)\b/.test(lower)) {
    return "Happy and genuinely excited, with a smiling tone, energetic emphasis, and natural variation.";
  }
  if (/\?|\b(wonder|curious|maybe|perhaps)\b/.test(lower)) {
    return "Warmly curious and engaged, with gentle upward inflection and a thoughtful conversational cadence.";
  }
  return "Warm, expressive, and conversational. Use subtle emotion, varied emphasis, and human-like pauses; never sound like an announcer.";
}

function visualSignature(visual: VisualState): string {
  const smileBand = visual.expression.smile > 0.68 ? "smile" : visual.expression.smile < 0.2 ? "neutral" : "soft-smile";
  const objects = [...(visual.visible_objects ?? [])].sort();
  return [smileBand, visual.hand_gesture, visual.activity, ...objects].map((value) => value.trim().toLowerCase()).filter(Boolean).join("|");
}

function isDynamicVisualEvent(visual: VisualState): boolean {
  const event = `${visual.activity ?? ""} ${visual.salient_event ?? ""}`.toLowerCase();
  return /\b(drink|drinking|sip|sipping|raise|raising|lift|lifting|wave|waving|nod|nodding|shake|shaking|put|putting|pick|picking|hold|holding|remove|removing|wear|wearing|change|changing|swap|swapping|stand|standing|sit|sitting|lean|leaning|turn|turning|walk|walking|enter|entering|leave|leaving|smile|smiling|laugh|laughing)\b/.test(event);
}

const OBJECT_NOISE_WORDS = new Set([
  "a", "an", "the", "black", "white", "blue", "red", "green", "brown", "grey", "gray", "silver", "golden",
  "small", "large", "big", "cool", "electric", "acoustic", "wooden", "wall", "background", "foreground", "behind",
  "front", "left", "right", "hanging", "leaning", "standing", "visible", "person", "user", "with", "near", "on", "in",
]);

function canonicalObjectConcept(object: string): string {
  const tokens = object.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((token) => token.length > 2 && !OBJECT_NOISE_WORDS.has(token));
  return tokens.at(-1) ?? "";
}

function persistentObservationKeys(visual: VisualState): string[] {
  const context = `${visual.salient_event ?? ""} ${visual.reaction ?? ""}`.toLowerCase();
  return [...new Set((visual.visible_objects ?? [])
    .filter((object) => object.toLowerCase().split(/\s+/).some((token) => token.length > 3 && context.includes(token)))
    .map(canonicalObjectConcept)
    .filter(Boolean)
    .map((concept) => `object:${concept}`))];
}

function analyseSpeech(buffer: AudioBuffer): SpeechFrame[] {
    const channel = buffer.getChannelData(0);
    const frameDuration = 0.055;
    const frameSize = Math.max(1, Math.floor(buffer.sampleRate * frameDuration));
    const measurements: Array<{ rms: number; brightness: number }> = [];

    for (let start = 0; start < channel.length; start += frameSize) {
      const end = Math.min(channel.length, start + frameSize);
      const stride = Math.max(1, Math.floor((end - start) / 720));
      let squareTotal = 0;
      let differenceTotal = 0;
      let samples = 0;
      let previous = channel[start] ?? 0;

      for (let index = start; index < end; index += stride) {
        const value = channel[index] ?? 0;
        const difference = value - previous;
        squareTotal += value * value;
        differenceTotal += difference * difference;
        previous = value;
        samples += 1;
      }

      const rms = Math.sqrt(squareTotal / Math.max(1, samples));
      const brightness = squareTotal > 0 ? Math.sqrt(differenceTotal / squareTotal) : 0;
      measurements.push({ rms, brightness });
    }

    const voicedLevels = measurements.map((frame) => frame.rms).filter((level) => level > 0.001).sort((a, b) => a - b);
    const reference = Math.max(0.018, voicedLevels[Math.floor(voicedLevels.length * 0.82)] ?? 0.08);
    const silenceFloor = Math.max(0.0025, reference * 0.09);

    return measurements.map(({ rms, brightness }) => {
      const level = Math.min(1, rms / reference);
      let viseme: MouthViseme = "rest";
      if (rms > silenceFloor) {
        if (level > 0.72) viseme = "open";
        else if (brightness > 0.72) viseme = "wide";
        else if (brightness < 0.3 && level > 0.2) viseme = "round";
        else viseme = "small";
      }
      return { level, viseme };
    });
}

function toolStatus(name: string | undefined, agentName: string): string {
  switch (name) {
    case "search_web": return "Searching the live web";
    case "inspect_camera": return "Looking through your camera";
    case "animate_avatar": return `Moving ${agentName}`;
    case "shape_presence": return "Shaping the visual presence";
    case "use_skill": return "Loading an assigned skill";
    case "memory": return "Updating local memory";
    case "rewrite_self": return "Saving the entity’s identity";
    case "session_search": return "Searching past conversations";
    case "generate_image": return "Painting with Venice";
    case "generate_video": return "Starting a Venice video";
    case "generate_music": return "Composing with Venice";
    default: return name?.startsWith("mcp_") ? "Using an assigned MCP tool" : "Using a Venice capability";
  }
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Camera access is blocked. Allow camera access for this site, then try again.";
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return "No available camera was found on this Mac.";
    }
    if (error.name === "NotReadableError" || error.name === "AbortError") {
      return "The camera is busy in another app. Close that app and try again.";
    }
  }
  return error instanceof Error ? error.message : "The camera could not start.";
}

function friendlyVisionError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "";
  const message = error instanceof Error ? error.message : "Venice could not read the camera";
  if (/validation errors?|json|expected|schema|unreadable response/i.test(message)) {
    return "Vision is retrying with another Venice model.";
  }
  return message.length > 140 ? "Vision had trouble with that frame and will retry." : message;
}

function friendlyAgentError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "";
  return "I couldn’t complete that turn just now. Your conversation is safe. Please try once more.";
}

// Whether a message is genuinely asking the agent to look at the user through
// the camera. Deliberately narrow: bare verbs like "see"/"look"/"watch" are far
// too common in non-visual requests ("can you see the API stats", "look at this
// file"), so we only trigger on explicit camera intent or the user's own
// appearance, never on a lone "see".
function messageNeedsVision(message: string): boolean {
  const text = message.toLowerCase();
  if (/\b(camera|webcam)\b/.test(text)) return true;
  // "look at me", "can you see me", "watch me", "take a look at me"…
  if (/\b(see|look(?:ing)?(?: at)?|watch|check out)\b[^.?!]{0,16}\bme\b/.test(text)) return true;
  // Direct references to the user's own body / appearance.
  if (/\bmy (face|expression|smile|eyes|hair|outfit|clothes|clothing|shirt|hat|hands?|gesture|beard|glasses|makeup|nails)\b/.test(text)) return true;
  if (/\b(how do i look|what am i (wearing|holding|doing)|do i look ok|in front of me|behind me)\b/.test(text)) return true;
  return false;
}

function taskAcknowledgement(message: string): string | undefined {
  if (needsLiveWebResearch(message)) {
    return "I’m checking the live web for that now.";
  }
  if (messageNeedsVision(message)) {
    return "Let me take a closer look.";
  }
  if (/\b(generate|create|make)\b.*\b(image|video|song|music|soundscape)\b/i.test(message)) {
    return "Let me set that up with you.";
  }
  return undefined;
}

// Short spoken line for when the agent actually starts a specific tool, so voice
// mode narrates what it is doing instead of going silent mid-turn.
function toolNarration(name: string | undefined): string | undefined {
  switch (name) {
    case "search_web": return "Let me look that up on the web for you.";
    case "inspect_camera": return "Let me take a closer look at that.";
    case "generate_image": return "Let me start creating that image.";
    case "generate_video": return "Let me get that video going with Venice.";
    case "generate_music": return "Let me compose that for you.";
    case "session_search": return "Let me check our earlier conversations.";
    case "search_memory": return "Let me check what I remember.";
    case "delegate_task": return "Let me work through that and come right back.";
    default: return undefined;
  }
}

function speechCacheKey(settings: AgentSettings, text: string): string {
  return [settings.ttsModel, settings.voice, settings.speed, settings.language, text].join("|");
}

const ATTACHMENT_TYPE_LABELS: Record<string, string> = {
  md: "Markdown", markdown: "Markdown", txt: "Text", text: "Text", rtf: "Rich text",
  json: "JSON", csv: "CSV", tsv: "TSV", pdf: "PDF", doc: "Document", docx: "Document",
  js: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript", py: "Python",
  html: "HTML", css: "CSS", yml: "YAML", yaml: "YAML", xml: "XML", log: "Log", sh: "Shell",
};

function attachmentTypeLabel(name: string, kind: "image" | "text"): string {
  if (kind === "image") return "Image";
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
  return ATTACHMENT_TYPE_LABELS[extension] ?? (extension ? `${extension.toUpperCase()} file` : "Document");
}

// Attached text files are inlined into the message the model receives (so it can
// read them and remember the content), but the raw dump should never show in the
// transcript. The file already appears as its own card. Strip those blocks from
// the displayed text so the bubble stays clean, for both live and reloaded turns.
function stripInlinedAttachments(text: string): string {
  return text
    .replace(/\n*\[Attached file:[^\]]*\]\s*```[\s\S]*?```/g, "")
    .replace(/^\s*Please take a look at the attached file\(s\)\.\s*$/i, "")
    .trim();
}

function attachmentSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

function appProse(text: string): string {
  return removeEmDashes(text)
    .replace(/&amp;/gi, "and")
    .replace(/\s*&\s*/g, " and ");
}

function InlineMessageText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+|\*\*[^*]+\*\*|`[^`]+`)/g);
  return <>{parts.map((part, index): ReactNode => {
    if (/^https?:\/\//.test(part)) return <a href={part} target="_blank" rel="noreferrer" key={`${part}-${index}`}>{part}</a>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${part}-${index}`}>{appProse(part.slice(2, -2))}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
    return appProse(part);
  })}</>;
}

function MessageText({ text }: { text: string }) {
  const cleaned = text
    .replace(/\^\d+(?:,\d+)*\^/g, "")
    .replace(/^heading\s*\n/i, "")
    .trim();
  const blocks = cleaned.split(/(```[\s\S]*?```)/g).filter(Boolean);

  return <div className="message-content">{blocks.map((block, blockIndex) => {
    if (block.startsWith("```") && block.endsWith("```")) {
      const code = block.slice(3, -3).replace(/^\w+\n/, "").trimEnd();
      return <pre key={`code-${blockIndex}`}><code>{code}</code></pre>;
    }
    return block.split("\n").map((line, lineIndex) => {
      const key = `line-${blockIndex}-${lineIndex}`;
      if (!line.trim()) return <span className="message-break" key={key} />;
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) return <strong className={`message-heading heading-${heading[1].length}`} key={key}><InlineMessageText text={heading[2]} /></strong>;
      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) return <span className="message-list-item" key={key}><i /> <InlineMessageText text={bullet[1]} /></span>;
      const ordered = line.match(/^\d+[.)]\s+(.+)$/);
      if (ordered) return <span className="message-list-item is-ordered" key={key}><b>{line.match(/^\d+/)?.[0]}.</b> <InlineMessageText text={ordered[1]} /></span>;
      return <span className="message-line" key={key}><InlineMessageText text={line} /></span>;
    });
  })}</div>;
}

function ThinkingBlock({ text, streaming, durationMs }: { text: string; streaming: boolean; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Auto-expand while the model is thinking, then fall back to the user's manual
  // choice (collapsed by default) once it settles, matching Cursor/OpenAI's rhythm.
  const expanded = streaming || open;

  useEffect(() => {
    if (streaming && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, streaming]);

  const seconds = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : 0;
  const label = streaming
    ? "Thinking"
    : seconds
      ? `Thought for ${seconds}s`
      : "Thought process";

  return (
    <div className={`thinking-block${expanded ? " is-open" : ""}${streaming ? " is-streaming" : ""}`}>
      <button type="button" className="thinking-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={expanded}>
        <span className="thinking-label">{label}</span>
        <span className="thinking-caret" aria-hidden><ChevronDownIcon size={13} /></span>
      </button>
      {expanded && text.trim() ? (
        <div className="thinking-body" ref={bodyRef}>
          <MessageText text={text} />
        </div>
      ) : null}
    </div>
  );
}

const SUBAGENT_TOOL_LABELS: Record<string, string> = {
  read_file: "Read file",
  list_directory: "List folder",
  create_directory: "Create folder",
  write_file: "Write file",
  edit_file: "Edit file",
  move_path: "Move or rename",
  search_web: "Search the web",
  session_search: "Search past chats",
  inspect_camera: "Look at camera",
};

function subAgentToolLabel(tool: string): string {
  return SUBAGENT_TOOL_LABELS[tool] ?? tool.replace(/_/g, " ");
}

// Live "a worker is running" card for a delegated sub-agent: shows its task, the
// tools it uses as they happen, and a final summary. Auto-expands while running
// (like the thinking block), then collapses to a one-line summary when done.
function SubAgentCard({ run }: { run: SubAgentRun }) {
  const [open, setOpen] = useState(false);
  const expanded = run.running || open;
  const lastTool = run.steps.length ? run.steps[run.steps.length - 1].tool : undefined;
  const status = run.running
    ? (lastTool ? `${subAgentToolLabel(lastTool)}…` : "Starting…")
    : run.ok === false
      ? "Stopped"
      : run.hitBudget
        ? "Budget reached"
        : "Done";
  return (
    <div className={`subagent-card${run.running ? " is-running" : ""}${run.ok === false ? " is-error" : ""}`}>
      <button type="button" className="subagent-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={expanded}>
        <span className="subagent-spark" aria-hidden>{run.running ? <i className="subagent-pulse" /> : null}</span>
        <span className="subagent-headline">
          <strong>Worker sub-agent</strong>
          <small>{run.task}</small>
        </span>
        <span className="subagent-status">{status}</span>
        <span className="subagent-caret" aria-hidden><ChevronDownIcon size={12} /></span>
      </button>
      {expanded ? (
        <div className="subagent-body">
          {run.steps.length ? (
            <ol className="subagent-steps">
              {run.steps.map((step, index) => (
                <li key={index} className={run.running && index === run.steps.length - 1 ? "is-active" : "is-done"}>
                  <i /> {subAgentToolLabel(step.tool)}
                </li>
              ))}
            </ol>
          ) : <p className="subagent-empty">{run.running ? "Spinning up the worker…" : "No tools were needed."}</p>}
          {(run.turns > 0 || run.toolCalls > 0) ? (
            <div className="subagent-metrics">{run.turns} step{run.turns === 1 ? "" : "s"} · {run.toolCalls} tool call{run.toolCalls === 1 ? "" : "s"}{run.hitBudget ? " · reached budget" : ""}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Workspace() {
  const [sessionId, setSessionId] = useState("");
  const [phase, setPhase] = useState<AgentPhase>("idle");
  const [action, setAction] = useState<AvatarAction>("neutral");
  const [presenceDirective, setPresenceDirective] = useState<PresenceDirective>(DEFAULT_PRESENCE);
  const [visual, setVisual] = useState<VisualState>();
  const [audioLevel, setAudioLevel] = useState(0.06);
  const [viseme, setViseme] = useState<MouthViseme>("rest");
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage("Entity")]);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const [artifacts, setArtifacts] = useState<MediaArtifact[]>([]);
  const [input, setInput] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [editDraft, setEditDraft] = useState("");
  const [toolLabel, setToolLabel] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraPulse, setCameraPulse] = useState(false);
  const [cameraPrompt, setCameraPrompt] = useState<{ message: string; voiceTurn?: boolean } | null>(null);
  const [recording, setRecording] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [handsFreeActive, setHandsFreeActive] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [voiceLoopRevision, setVoiceLoopRevision] = useState(0);
  const [spokenText, setSpokenText] = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [confirmDeleteChatId, setConfirmDeleteChatId] = useState("");
  const [chatSearchActive, setChatSearchActive] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; kind: "image" | "video" } | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentDropActive, setAttachmentDropActive] = useState(false);
  const attachmentDragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(FEATURES.agentsTab ? "agents" : "chats");
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<WorkspaceSnapshot>();
  const [activeAgentId, setActiveAgentId] = useState("");
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const [xrayOpen, setXrayOpen] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const voiceVideoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const recordingStreamRef = useRef<MediaStream | undefined>(undefined);
  const handsFreeMicStreamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const recordingPurposeRef = useRef<RecordingPurpose>("conversation");
  const discardRecordingRef = useRef(false);
  const handsFreeActiveRef = useRef(false);
  const vadAnimationRef = useRef<number | undefined>(undefined);
  const vadContextRef = useRef<AudioContext | undefined>(undefined);
  const bargeInAnimationRef = useRef<number | undefined>(undefined);
  const bargeInCtxRef = useRef<AudioContext | undefined>(undefined);
  const bargeInCapturePendingRef = useRef(false);
  const liveTranscriptTimerRef = useRef<number | undefined>(undefined);
  const interimReadyAtRef = useRef(0);
  const liveTranscriptLatestRef = useRef("");
  const lastInterimAtRef = useRef(0);
  const lastInterimChunkCountRef = useRef(0);
  const interimTranscriptAbortRef = useRef<AbortController | undefined>(undefined);
  const sendAfterDictationRef = useRef(false);
  const userSpeakingRef = useRef(false);
  const phaseRef = useRef<AgentPhase>("idle");
  const lastVisualSignatureRef = useRef("");
  const lastReactionAtRef = useRef(0);
  const lastActivityAtRef = useRef(Date.now());
  const reactionHistoryRef = useRef(new Map<string, number>());
  const visualObservationHistoryRef = useRef(new Set<string>());
  const requestAbortRef = useRef<AbortController | undefined>(undefined);
  // Turns still generating, keyed by conversation id. A turn keeps running when
  // you switch away, so its chat shows a spinner in the sidebar until it finishes.
  const runningTurnsRef = useRef(new Map<string, AbortController>());
  const [runningConversations, setRunningConversations] = useState<string[]>([]);
  const sessionIdRef = useRef("");
  const markConversationRunning = useCallback((conversationId: string, controller: AbortController) => {
    runningTurnsRef.current.set(conversationId, controller);
    setRunningConversations((previous) => (previous.includes(conversationId) ? previous : [...previous, conversationId]));
  }, []);
  const clearConversationRunning = useCallback((conversationId: string) => {
    runningTurnsRef.current.delete(conversationId);
    setRunningConversations((previous) => previous.filter((value) => value !== conversationId));
  }, []);
  const speechRequestRef = useRef<AbortController | undefined>(undefined);
  const speechAudioContextRef = useRef<AudioContext | undefined>(undefined);
  const speechSourceRef = useRef<AudioBufferSourceNode | undefined>(undefined);
  const speechMediaRef = useRef<HTMLAudioElement | undefined>(undefined);
  const speechMediaNodeRef = useRef<MediaElementAudioSourceNode | undefined>(undefined);
  const speechMediaUrlRef = useRef<string | undefined>(undefined);
  const speechStreamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | undefined>(undefined);
  const speechPlaybackResolveRef = useRef<(() => void) | undefined>(undefined);
  const speechQueueRef = useRef<SpeechQueueItem[]>([]);
  const speechWarmCacheRef = useRef(new Map<string, Blob>());
  const speechQueueRunningRef = useRef(false);
  const waitingCtxRef = useRef<AudioContext | undefined>(undefined);
  const waitingStopRef = useRef<(() => void) | undefined>(undefined);
  const audioAnimationRef = useRef<number | undefined>(undefined);
  const visemeRef = useRef<MouthViseme>("rest");
  const smoothedAudioRef = useRef(0);
  const mirrorBusyRef = useRef(false);
  const mirrorRequestAbortRef = useRef<AbortController | undefined>(undefined);
  const latestMotionClipRef = useRef<{ dataUrl: string; capturedAt: number } | undefined>(undefined);
  const lastAmbientFrameRef = useRef<string | undefined>(undefined);
  const captureCanvasRef = useRef<HTMLCanvasElement | undefined>(undefined);
  const mediaObjectUrlsRef = useRef<Set<string>>(new Set());
  const cameraGreetingInFlightRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingMediaConfirmationRef = useRef(new Map<MediaArtifact["kind"], string>());
  const messageQueueRef = useRef<QueuedMessage[]>([]);

  const updateMessageQueue = useCallback((update: (current: QueuedMessage[]) => QueuedMessage[]) => {
    setMessageQueue((current) => {
      const next = update(current);
      messageQueueRef.current = next;
      return next;
    });
  }, []);

  const isBusy = !["idle", "error"].includes(phase);
  const generating = ["thinking", "tool", "speaking"].includes(phase);
  const activeAgent = useMemo(() => workspaceSnapshot?.agents.find((agent) => agent.id === activeAgentId)
    ?? workspaceSnapshot?.agents[0], [activeAgentId, workspaceSnapshot?.agents]);
  const agentName = activeAgent?.name ?? "Entity";
  const agentInitial = agentName.charAt(0).toUpperCase();
  // Fresh conversation (only the derived welcome message, no user turns yet):
  // show the centered home hero instead of a running transcript.
  const isHome = messages.length === 1 && (messages[0]?.id?.startsWith("welcome-") ?? false) && !cameraPrompt;
  const homeTitle = agentName && agentName !== "Entity" ? `What should we explore, ${agentName}?` : "What should we explore?";
  const motionVisionModel = useMemo(() => {
    const supportsVideo = (model: CatalogModel) => model.capabilities?.supportsVideoInput === true || model.capabilities?.supportsVideo === true;
    const selected = models.find((model) => model.id === settings.visionModel);
    if (selected && supportsVideo(selected)) return selected.id;
    return models.find((model) => model.id === REALTIME_MULTIMODAL_MODEL && supportsVideo(model))?.id
      ?? models.find((model) => model.type === "text" && supportsVideo(model))?.id
      ?? REALTIME_MULTIMODAL_MODEL;
  }, [models, settings.visionModel]);
  const selectedChatModel = useMemo(
    () => models.find((model) => model.id === settings.chatModel),
    [models, settings.chatModel],
  );
  const changeChatModel = useCallback((id: string) => {
    const model = models.find((candidate) => candidate.id === id);
    const efforts = supportedReasoningEfforts(model);
    setSettings((current) => ({
      ...current,
      chatModel: id,
      chatModelSupportsReasoning: model?.capabilities?.supportsReasoning === true,
      chatModelSupportsReasoningEffort: model?.capabilities?.supportsReasoningEffort === true,
      reasoningEffort: efforts.includes(current.reasoningEffort)
        ? current.reasoningEffort
        : efforts.includes("medium") ? "medium" : efforts[0] ?? current.reasoningEffort,
    }));
  }, [models]);
  const changeReasoningEffort = useCallback((reasoningEffort: ReasoningEffort) => {
    setSettings((current) => ({ ...current, reasoningEffort }));
  }, []);

  useEffect(() => {
    if (!selectedChatModel) return;
    const supportsReasoning = selectedChatModel.capabilities?.supportsReasoning === true;
    const supportsReasoningEffort = selectedChatModel.capabilities?.supportsReasoningEffort === true;
    const efforts = supportedReasoningEfforts(selectedChatModel);
    setSettings((current) => {
      const reasoningEffort = efforts.includes(current.reasoningEffort)
        ? current.reasoningEffort
        : efforts.includes("medium") ? "medium" : efforts[0] ?? current.reasoningEffort;
      if (current.chatModelSupportsReasoning === supportsReasoning
        && current.chatModelSupportsReasoningEffort === supportsReasoningEffort
        && current.reasoningEffort === reasoningEffort) return current;
      return {
        ...current,
        reasoningEffort,
        chatModelSupportsReasoning: supportsReasoning,
        chatModelSupportsReasoningEffort: supportsReasoningEffort,
      };
    });
  }, [selectedChatModel]);

  const refreshWorkspace = useCallback(async (): Promise<WorkspaceSnapshot | undefined> => {
    try {
      const response = await fetch("/api/workspace", { cache: "no-store" });
      const snapshot = await response.json() as WorkspaceSnapshot & { error?: string };
      if (!response.ok) throw new Error(snapshot.error ?? "The workspace could not be loaded");
      setWorkspaceSnapshot(snapshot);
      setActiveAgentId((current) => current || snapshot.agents.find((agent) => (
        snapshot.conversations.find((conversation) => conversation.id === snapshot.activeConversationId)?.agentId === agent.id
      ))?.id || snapshot.defaultAgentId);
      return snapshot;
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "The workspace could not be loaded");
      return undefined;
    }
  }, []);

  const revokeMediaUrls = useCallback(() => {
    for (const url of mediaObjectUrlsRef.current) URL.revokeObjectURL(url);
    mediaObjectUrlsRef.current.clear();
  }, []);

  const applyConversation = useCallback((payload: ConversationPayload, snapshot?: WorkspaceSnapshot) => {
    const nextAgent = snapshot?.agents.find((agent) => agent.id === payload.conversation.agentId);
    const nextName = nextAgent?.name ?? "Entity";
    revokeMediaUrls();
    setSessionId(payload.conversation.id);
    sessionIdRef.current = payload.conversation.id;
    setActiveAgentId(payload.conversation.agentId);
    setMessages([
      ...conversationMessages(payload.messages, nextName),
      ...messageQueueRef.current
        .filter((item) => item.conversationId === payload.conversation.id)
        .map(queuedChatMessage),
    ]);
    setArtifacts([]);
    setAction("neutral");
    setPresenceDirective(DEFAULT_PRESENCE);
    setVisual(undefined);
  }, [revokeMediaUrls]);

  const persistAssistantMessage = useCallback(async (id: string, text: string, createdAt: number) => {
    if (!sessionId || !text.trim()) return;
    await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "append_message", conversationId: sessionId, id, role: "assistant", text, createdAt }),
    }).catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    if (workspaceOpen) void refreshWorkspace();
  }, [refreshWorkspace, workspaceOpen]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const unlockSpeechAudio = () => {
      const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextConstructor) return;
      if (!speechAudioContextRef.current || speechAudioContextRef.current.state === "closed") {
        speechAudioContextRef.current = new AudioContextConstructor();
      }
      if (speechAudioContextRef.current.state === "suspended") void speechAudioContextRef.current.resume();
    };
    window.addEventListener("pointerdown", unlockSpeechAudio);
    window.addEventListener("keydown", unlockSpeechAudio);
    const saved = localStorage.getItem("nova-settings");
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Partial<AgentSettings>;
        const migrated = { ...DEFAULT_SETTINGS, ...parsed };
        if (!localStorage.getItem("nova-fast-voice-v1")) {
          migrated.ttsModel = "tts-xai-v1";
          migrated.voice = "rex";
          localStorage.setItem("nova-fast-voice-v1", "1");
        }
        if (!localStorage.getItem("nova-fluent-voice-v1")) {
          migrated.speed = Math.max(1.05, migrated.speed ?? 1);
          localStorage.setItem("nova-fluent-voice-v1", "1");
        }
        if (!localStorage.getItem("nova-smart-fast-models-v2")) {
          migrated.chatModel = DEFAULT_SETTINGS.chatModel;
          migrated.visionModel = DEFAULT_SETTINGS.visionModel;
          localStorage.setItem("nova-smart-fast-models-v2", "1");
        }
        setSettings(migrated);
      } catch {
        localStorage.removeItem("nova-settings");
      }
    }

    void fetch("/api/models")
      .then(async (response) => {
        const body = (await response.json()) as { connected?: boolean; models?: CatalogModel[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not connect to Venice");
        setModels(body.models ?? []);
        setConnected(Boolean(body.connected));
      })
      .catch((error: unknown) => {
        setConnectionError(error instanceof Error ? error.message : "Could not connect to Venice");
      });

    void (async () => {
      const snapshot = await refreshWorkspace();
      if (!snapshot?.activeConversationId) return;
      try {
        const response = await fetch(`/api/workspace?conversationId=${encodeURIComponent(snapshot.activeConversationId)}`, { cache: "no-store" });
        const payload = await response.json() as ConversationPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "The conversation could not be loaded");
        applyConversation(payload, snapshot);
      } catch (error) {
        setConnectionError(error instanceof Error ? error.message : "The conversation could not be loaded");
      }
    })();

    return () => {
      requestAbortRef.current?.abort();
      requestAbortRef.current = undefined;
      for (const controller of runningTurnsRef.current.values()) controller.abort();
      runningTurnsRef.current.clear();
      mirrorRequestAbortRef.current?.abort();
      mirrorRequestAbortRef.current = undefined;
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      handsFreeMicStreamRef.current?.getTracks().forEach((track) => track.stop());
      handsFreeMicStreamRef.current = undefined;
      if (vadAnimationRef.current) cancelAnimationFrame(vadAnimationRef.current);
      if (liveTranscriptTimerRef.current) clearInterval(liveTranscriptTimerRef.current);
      interimTranscriptAbortRef.current?.abort();
      const vadContext = vadContextRef.current;
      vadContextRef.current = undefined;
      if (vadContext && vadContext.state !== "closed") void vadContext.close().catch(() => undefined);
      try { speechSourceRef.current?.stop(); } catch { /* The source may already have finished. */ }
      speechRequestRef.current?.abort();
      speechRequestRef.current = undefined;
      void speechStreamReaderRef.current?.cancel().catch(() => undefined);
      speechStreamReaderRef.current = undefined;
      speechMediaRef.current?.pause();
      speechMediaRef.current = undefined;
      if (speechMediaUrlRef.current) URL.revokeObjectURL(speechMediaUrlRef.current);
      speechMediaUrlRef.current = undefined;
      speechPlaybackResolveRef.current?.();
      speechPlaybackResolveRef.current = undefined;
      const speechContext = speechAudioContextRef.current;
      speechAudioContextRef.current = undefined;
      if (speechContext && speechContext.state !== "closed") void speechContext.close().catch(() => undefined);
      waitingStopRef.current?.();
      waitingStopRef.current = undefined;
      const waitingContext = waitingCtxRef.current;
      waitingCtxRef.current = undefined;
      if (waitingContext && waitingContext.state !== "closed") void waitingContext.close().catch(() => undefined);
      if (bargeInAnimationRef.current) cancelAnimationFrame(bargeInAnimationRef.current);
      const bargeInContext = bargeInCtxRef.current;
      bargeInCtxRef.current = undefined;
      if (bargeInContext && bargeInContext.state !== "closed") void bargeInContext.close().catch(() => undefined);
      if (audioAnimationRef.current) cancelAnimationFrame(audioAnimationRef.current);
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
      window.removeEventListener("pointerdown", unlockSpeechAudio);
      window.removeEventListener("keydown", unlockSpeechAudio);
      for (const url of mediaObjectUrlsRef.current) URL.revokeObjectURL(url);
      mediaObjectUrlsRef.current.clear();
    };
  }, [applyConversation, refreshWorkspace]);

  useEffect(() => {
    localStorage.setItem("nova-settings", JSON.stringify(settings));
  }, [settings]);

  // After onboarding, pre-fill the composer with the suggested first message so
  // the user can meet Gondola with a single send.
  useEffect(() => {
    try {
      const intro = localStorage.getItem("nova-onboarding-intro");
      if (intro) {
        setInput(intro);
        localStorage.removeItem("nova-onboarding-intro");
      }
    } catch {
      // localStorage may be unavailable; not critical.
    }
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("nova-visual-observations") ?? "[]") as string[];
      visualObservationHistoryRef.current = new Set(saved.filter((entry) => typeof entry === "string"));
    } catch {
      visualObservationHistoryRef.current = new Set();
    }
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Safety net against a stuck "thinking"/"tool"/"speaking" phase. The voice
  // flow hands off across many async paths (agent stream, TTS fetch,
  // progressive/buffered playback, camera greeting, hands-free capture); if any
  // of them ever fails to settle the phase, the UI would sit on "Thinking"
  // forever. This watchdog forces a return to idle the moment nothing is
  // actually in flight, so the hands-free loop always recovers on its own.
  useEffect(() => {
    if (phase !== "thinking" && phase !== "tool" && phase !== "speaking") return;
    const check = window.setInterval(() => {
      const inFlight = Boolean(requestAbortRef.current)
        || speechQueueRunningRef.current
        || Boolean(speechRequestRef.current)
        || Boolean(speechSourceRef.current)
        || Boolean(speechMediaRef.current)
        || cameraGreetingInFlightRef.current
        || recorderRef.current?.state === "recording";
      if (!inFlight) setPhase("idle");
    }, 2_500);
    return () => window.clearInterval(check);
  }, [phase]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }, [messages, toolLabel]);

  const captureFrame = useCallback((): string | undefined => {
    const video = videoRef.current;
    if (!video || !cameraStreamRef.current?.active || !video.videoWidth) return undefined;
    const canvas = captureCanvasRef.current ?? document.createElement("canvas");
    captureCanvasRef.current = canvas;
    const width = Math.min(640, video.videoWidth);
    canvas.width = width;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * width);
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    setCameraPulse(true);
    window.setTimeout(() => setCameraPulse(false), 450);
    return canvas.toDataURL("image/jpeg", 0.72);
  }, []);

  const captureMotionClip = useCallback((signal?: AbortSignal, durationMs = 1_800): Promise<string | undefined> => {
    const source = cameraStreamRef.current;
    const tracks = source?.getVideoTracks().filter((track) => track.readyState === "live" && track.enabled) ?? [];
    if (!tracks.length || typeof MediaRecorder === "undefined") return Promise.resolve(undefined);

    return new Promise((resolve) => {
      const stream = new MediaStream(tracks);
      const mimeType = ["video/webm;codecs=vp8", "video/webm", "video/mp4"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          ...(mimeType ? { mimeType } : {}),
          videoBitsPerSecond: 320_000,
        });
      } catch {
        try {
          recorder = new MediaRecorder(stream);
        } catch {
          resolve(undefined);
          return;
        }
      }

      const chunks: Blob[] = [];
      let aborted = false;
      let settled = false;
      let stopTimer: number | undefined;

      const finish = (value?: string) => {
        if (settled) return;
        settled = true;
        if (stopTimer) window.clearTimeout(stopTimer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => {
        aborted = true;
        if (recorder.state === "recording") recorder.stop();
        else finish();
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => finish();
      recorder.onstop = () => {
        if (aborted || !chunks.length) {
          finish();
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
        if (!blob.size || blob.size > 1_500_000) {
          finish();
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => finish();
        reader.onload = () => finish(typeof reader.result === "string" ? reader.result : undefined);
        reader.readAsDataURL(blob);
      };

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        recorder.start(250);
        stopTimer = window.setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, durationMs);
      } catch {
        finish();
      }
    });
  }, []);

  // Motion clips are now captured on demand inside the ambient loop (talkative
  // mode only), instead of continuously re-recording the webcam. This removes
  // constant MediaRecorder/GC pressure and unnecessary Venice video calls.
  useEffect(() => {
    if (!cameraOn || !settings.cameraAwareness) latestMotionClipRef.current = undefined;
  }, [cameraOn, settings.cameraAwareness]);

  const triggerAction = useCallback((nextAction: AvatarAction, duration = 2600) => {
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    setAction(nextAction);
    actionTimerRef.current = setTimeout(() => setAction("neutral"), duration);
  }, []);

  const stopAudio = useCallback(() => {
    speechRequestRef.current?.abort();
    speechRequestRef.current = undefined;
    const source = speechSourceRef.current;
    speechSourceRef.current = undefined;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* Source may already be stopped. */ }
      source.disconnect();
    }
    const media = speechMediaRef.current;
    speechMediaRef.current = undefined;
    if (media) {
      media.onended = null;
      media.onerror = null;
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
    speechMediaNodeRef.current?.disconnect();
    speechMediaNodeRef.current = undefined;
    void speechStreamReaderRef.current?.cancel().catch(() => undefined);
    speechStreamReaderRef.current = undefined;
    if (speechMediaUrlRef.current) URL.revokeObjectURL(speechMediaUrlRef.current);
    speechMediaUrlRef.current = undefined;
    speechPlaybackResolveRef.current?.();
    speechPlaybackResolveRef.current = undefined;
    if (audioAnimationRef.current) cancelAnimationFrame(audioAnimationRef.current);
    audioAnimationRef.current = undefined;
    visemeRef.current = "rest";
    smoothedAudioRef.current = 0;
    setViseme("rest");
    setAudioLevel(0.06);
    setSpokenText("");
  }, []);

  // A speech segment just finished. Only fall back to "idle" (which is what lets
  // the hands-free loop capture the next turn) when nothing else is pending:
  // no more queued speech and no agent turn still streaming. This prevents the
  // phase from flickering to idle between the spoken first sentence and the
  // remainder, which previously reopened the microphone mid-reply and made the
  // agent transcribe its own voice on follow-up turns.
  const settleSpeechPhase = useCallback(() => {
    // Safe to call at any time: it only ever nudges a lingering "speaking" or
    // "thinking" phase back to idle, and never while speech is still queued or
    // actively draining (drainSpeechQueue re-runs it once playback fully ends).
    if (speechQueueRef.current.length || speechQueueRunningRef.current) return;
    setPhase((current) => {
      if (current !== "speaking" && current !== "thinking") return current;
      return requestAbortRef.current ? "thinking" : "idle";
    });
  }, []);

  // A soft, breathing ambient pad played while the agent is working during a
  // voice session, so a wait (web search, generation, slow model) never feels
  // like dead air. Synthesized with the Web Audio API, with no asset files, and
  // kept intentionally quiet so speech always sits on top of it.
  const stopWaitingTone = useCallback(() => {
    const stop = waitingStopRef.current;
    waitingStopRef.current = undefined;
    stop?.();
  }, []);

  const startWaitingTone = useCallback(() => {
    if (waitingStopRef.current) return;
    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextConstructor) return;
    let context = waitingCtxRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContextConstructor();
      waitingCtxRef.current = context;
    }
    if (context.state === "suspended") void context.resume();

    const now = context.currentTime;

    const master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 720;
    filter.Q.value = 0.6;
    filter.connect(master);

    const blend = context.createGain();
    blend.gain.value = 0.5;
    blend.connect(filter);

    // Warm soft chord (F3 + a C4 fifth + a quiet F4 shimmer), rounder and more
    // "alive" than a flat two-note drone.
    const root = context.createOscillator();
    root.type = "sine";
    root.frequency.value = 174.6;
    const fifth = context.createOscillator();
    fifth.type = "sine";
    fifth.frequency.value = 261.6;
    fifth.detune.value = 2;
    const shimmer = context.createOscillator();
    shimmer.type = "sine";
    shimmer.frequency.value = 349.2;
    const shimmerGain = context.createGain();
    shimmerGain.gain.value = 0.3;
    root.connect(blend);
    fifth.connect(blend);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(blend);

    // Gentle rhythmic pulse (~0.85 Hz) so it reads as active "thinking", a calm
    // heartbeat rather than a static hum.
    const pulse = context.createOscillator();
    pulse.type = "sine";
    pulse.frequency.value = 0.85;
    const pulseDepth = context.createGain();
    pulseDepth.gain.value = 0.011;
    pulse.connect(pulseDepth);
    pulseDepth.connect(master.gain);

    // Very slow filter drift for a little shimmer/movement over time.
    const drift = context.createOscillator();
    drift.type = "sine";
    drift.frequency.value = 0.06;
    const driftDepth = context.createGain();
    driftDepth.gain.value = 190;
    drift.connect(driftDepth);
    driftDepth.connect(filter.frequency);

    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(0.017, now + 0.7);
    const oscillators = [root, fifth, shimmer, pulse, drift];
    for (const oscillator of oscillators) oscillator.start();

    const nodes = [root, fifth, shimmer, shimmerGain, pulse, pulseDepth, drift, driftDepth, blend, filter, master];
    waitingStopRef.current = () => {
      const at = context!.currentTime;
      try {
        master.gain.cancelScheduledValues(at);
        master.gain.setValueAtTime(master.gain.value, at);
        master.gain.linearRampToValueAtTime(0, at + 0.35);
      } catch { /* context may be closing */ }
      window.setTimeout(() => {
        for (const node of oscillators) {
          try { node.stop(); } catch { /* already stopped */ }
        }
        for (const node of nodes) {
          try { node.disconnect(); } catch { /* already disconnected */ }
        }
      }, 420);
    };
  }, []);

  // "Thinking" sound while a voice turn works. A short delay keeps ultra-quick
  // replies silent, but it's brief enough to clearly announce that the agent
  // started thinking; it stops the moment we go back to listening or speaking.
  useEffect(() => {
    const shouldWait = voiceModeOpen && voiceOn && (phase === "thinking" || phase === "tool");
    if (!shouldWait) {
      stopWaitingTone();
      return;
    }
    const timer = window.setTimeout(() => startWaitingTone(), 320);
    return () => {
      window.clearTimeout(timer);
      stopWaitingTone();
    };
  }, [phase, voiceModeOpen, voiceOn, startWaitingTone, stopWaitingTone]);

  const playProgressiveSpeech = useCallback(async (
    stream: ReadableStream<Uint8Array>,
    contentType: string,
    controller: AbortController,
  ): Promise<void> => {
    if (typeof MediaSource === "undefined") throw new Error("Progressive audio is unavailable");
    const mime = [contentType.split(";")[0], "audio/mpeg"]
      .find((candidate) => candidate && MediaSource.isTypeSupported(candidate));
    if (!mime) throw new Error("This audio format cannot play progressively");

    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("This browser does not support voice playback.");
    let context = speechAudioContextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContextConstructor();
      speechAudioContextRef.current = context;
    }
    if (context.state === "suspended") await context.resume();

    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = objectUrl;
    speechMediaRef.current = audio;
    speechMediaUrlRef.current = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Progressive audio did not initialize")), 1_800);
      const opened = () => {
        window.clearTimeout(timeout);
        mediaSource.removeEventListener("sourceopen", opened);
        resolve();
      };
      mediaSource.addEventListener("sourceopen", opened, { once: true });
      audio.load();
    });
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");

    const sourceBuffer = mediaSource.addSourceBuffer(mime);
    const append = (chunk: Uint8Array) => new Promise<void>((resolve, reject) => {
      const updated = () => {
        sourceBuffer.removeEventListener("updateend", updated);
        sourceBuffer.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => {
        sourceBuffer.removeEventListener("updateend", updated);
        sourceBuffer.removeEventListener("error", failed);
        reject(new Error("Progressive audio chunk failed"));
      };
      sourceBuffer.addEventListener("updateend", updated, { once: true });
      sourceBuffer.addEventListener("error", failed, { once: true });
      sourceBuffer.appendBuffer(chunk.slice().buffer);
    });

    const mediaNode = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.48;
    mediaNode.connect(analyser);
    analyser.connect(context.destination);
    speechMediaNodeRef.current = mediaNode;
    const waveform = new Uint8Array(analyser.fftSize);
    const animate = () => {
      if (speechMediaRef.current !== audio || audio.paused || audio.ended) return;
      analyser.getByteTimeDomainData(waveform);
      let squareTotal = 0;
      for (const value of waveform) {
        const centered = (value - 128) / 128;
        squareTotal += centered * centered;
      }
      const level = Math.min(1, Math.sqrt(squareTotal / waveform.length) * 7.5);
      const smoothed = smoothedAudioRef.current * 0.44 + level * 0.56;
      smoothedAudioRef.current = smoothed;
      setAudioLevel(Math.max(0.045, smoothed));
      const nextViseme: MouthViseme = smoothed < 0.08
        ? "rest"
        : smoothed > 0.7
          ? "open"
          : Math.floor(audio.currentTime * 7) % 3 === 0
            ? "round"
            : "small";
      if (nextViseme !== visemeRef.current) {
        visemeRef.current = nextViseme;
        setViseme(nextViseme);
      }
      audioAnimationRef.current = requestAnimationFrame(animate);
    };

    const reader = stream.getReader();
    speechStreamReaderRef.current = reader;
    let started = false;
    // Inactivity watchdog: once Venice returns headers, the /api/speech fetch
    // timeout no longer applies, so a stalled MP3 body would block this read
    // forever (and leave the UI stuck). Abort if no audio bytes arrive for a
    // while. Reset on every chunk.
    let audioIdleTimer: number | undefined;
    const clearAudioIdle = () => { if (audioIdleTimer) { window.clearTimeout(audioIdleTimer); audioIdleTimer = undefined; } };
    const armAudioIdle = () => { clearAudioIdle(); audioIdleTimer = window.setTimeout(() => controller.abort(), 8_000); };
    try {
      armAudioIdle();
      while (true) {
        const { done, value } = await reader.read();
        armAudioIdle();
        if (done) break;
        if (!value?.byteLength) continue;
        await append(value);
        if (!started) {
          await audio.play();
          started = true;
          setPhase("speaking");
          animate();
        }
      }
    } finally {
      clearAudioIdle();
    }
    speechStreamReaderRef.current = undefined;
    if (!started) throw new Error("Venice returned no playable speech");
    if (sourceBuffer.updating) {
      await new Promise<void>((resolve) => sourceBuffer.addEventListener("updateend", () => resolve(), { once: true }));
    }
    if (mediaSource.readyState === "open") mediaSource.endOfStream();

    await new Promise<void>((resolve, reject) => {
      speechPlaybackResolveRef.current = resolve;
      // Guard against a playback that never fires "ended" (e.g. the element
      // silently stalls after buffering). If currentTime stops advancing while
      // not ended, treat the segment as finished so the turn can settle.
      let lastTime = audio.currentTime;
      let stalledTicks = 0;
      const stallTimer = window.setInterval(() => {
        if (audio.ended) return;
        if (audio.currentTime > lastTime + 0.01) {
          lastTime = audio.currentTime;
          stalledTicks = 0;
          return;
        }
        stalledTicks += 1;
        if (stalledTicks >= 4) {
          window.clearInterval(stallTimer);
          speechPlaybackResolveRef.current = undefined;
          resolve();
        }
      }, 1_500);
      const finish = () => {
        window.clearInterval(stallTimer);
        speechPlaybackResolveRef.current = undefined;
      };
      audio.onended = () => { finish(); resolve(); };
      audio.onerror = () => { finish(); reject(new Error("Progressive speech playback failed")); };
      controller.signal.addEventListener("abort", () => { finish(); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
  }, []);

  const stopVoiceActivityDetection = useCallback(() => {
    if (vadAnimationRef.current) cancelAnimationFrame(vadAnimationRef.current);
    vadAnimationRef.current = undefined;
    if (liveTranscriptTimerRef.current) clearInterval(liveTranscriptTimerRef.current);
    liveTranscriptTimerRef.current = undefined;
    interimTranscriptAbortRef.current?.abort();
    interimTranscriptAbortRef.current = undefined;
    const context = vadContextRef.current;
    vadContextRef.current = undefined;
    userSpeakingRef.current = false;
    if (context && context.state !== "closed") void context.close();
  }, []);

  const prepareCompleteSpeech = useCallback((text: string, deliveryHint?: VisualState["reaction_delivery"]): PreparedSpeech => {
    const spoken = stripForSpeech(text);
    const controller = new AbortController();
    const key = speechCacheKey(settings, spoken);
    const cached = speechWarmCacheRef.current.get(key);
    const promise = cached ? Promise.resolve(cached) : fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        input: spoken,
        model: settings.ttsModel,
        voice: settings.voice,
        speed: settings.speed,
        language: settings.language,
        prompt: settings.emotionalDelivery ? speechDirection(spoken, deliveryHint) : undefined,
        temperature: settings.emotionalDelivery ? 0.78 : undefined,
        realtime: false,
      }),
    }).then(async (response) => {
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(error.message ?? error.error ?? "Voice generation failed");
      }
      const blob = await responseBlobWithTimeout(response, controller);
      const cache = speechWarmCacheRef.current;
      cache.set(key, blob);
      while (cache.size > 24) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return blob;
    });
    // A prepared segment can sit behind another sentence in the playback queue.
    // Attach a rejection observer immediately so a fast network failure does not
    // become an unhandled promise rejection before playSpeech awaits it.
    void promise.catch(() => undefined);
    return { controller, promise };
  }, [settings]);

  const playSpeech = useCallback(async (text: string, deliveryHint?: VisualState["reaction_delivery"], fast = false, prepared?: PreparedSpeech) => {
    const spoken = stripForSpeech(text);
    stopAudio();
    if (!voiceOn || !spoken) {
      setPhase("idle");
      return;
    }
    setSpokenText(spoken);
    // Only claim "Speaking" once audio actually starts (set at playback below).
    // During Venice voice generation keep the working state, and preserve an
    // existing "speaking" state so multi-clip replies don't flicker.
    if (phaseRef.current !== "speaking") setPhase("thinking");
    const controller = prepared?.controller ?? new AbortController();
    speechRequestRef.current = controller;
    try {
      let blob = prepared ? await prepared.promise : speechWarmCacheRef.current.get(speechCacheKey(settings, spoken));
      if (!blob) {
        const response = await fetch("/api/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            input: spoken,
            model: settings.ttsModel,
            voice: settings.voice,
            speed: settings.speed,
            language: settings.language,
            prompt: settings.emotionalDelivery ? speechDirection(spoken, deliveryHint) : undefined,
            temperature: settings.emotionalDelivery ? 0.78 : undefined,
            realtime: fast,
          }),
        });
        if (!response.ok) {
          const error = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new Error(error.message ?? error.error ?? "Voice generation failed");
        }
        const contentType = response.headers.get("content-type") ?? "audio/mpeg";
        const canPlayProgressively = fast
          && response.body
          && typeof MediaSource !== "undefined"
          && [contentType.split(";")[0], "audio/mpeg"].some((candidate) => candidate && MediaSource.isTypeSupported(candidate));
        if (canPlayProgressively && response.body) {
          const bufferedFallback = response.clone();
          try {
            await playProgressiveSpeech(response.body, contentType, controller);
            void bufferedFallback.body?.cancel().catch(() => undefined);
            if (speechRequestRef.current === controller) speechRequestRef.current = undefined;
            stopAudio();
            settleSpeechPhase();
            return;
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            if (speechRequestRef.current === controller) speechRequestRef.current = undefined;
            stopAudio();
            speechRequestRef.current = controller;
            setSpokenText(spoken);
            blob = await responseBlobWithTimeout(bufferedFallback, controller);
          }
        } else {
          blob = await responseBlobWithTimeout(response, controller);
        }
      }
      if (!blob) throw new Error("Venice returned no playable speech");
      if (speechRequestRef.current !== controller) return;
      const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextConstructor) throw new Error("This browser does not support voice playback.");
      let context = speechAudioContextRef.current;
      if (!context || context.state === "closed") {
        context = new AudioContextConstructor();
        speechAudioContextRef.current = context;
      }
      if (context.state === "suspended") await context.resume();
      const speechBuffer = await context.decodeAudioData(await blob.arrayBuffer());
      if (speechRequestRef.current !== controller) return;
      speechRequestRef.current = undefined;
      const speechFrames = analyseSpeech(speechBuffer);
      const source = context.createBufferSource();
      source.buffer = speechBuffer;
      source.connect(context.destination);
      speechSourceRef.current = source;
      const startedAt = context.currentTime;

      const animate = () => {
        const currentTime = context.currentTime - startedAt;
        const frameIndex = Math.min(speechFrames.length - 1, Math.floor(currentTime / 0.055));
        const frame = speechFrames[frameIndex];
        const rawLevel = frame?.level ?? 0.1;
        const smoothed = smoothedAudioRef.current * 0.48 + rawLevel * 0.52;
        smoothedAudioRef.current = smoothed;
        setAudioLevel(Math.max(0.045, smoothed));

        const nextViseme = frame?.viseme ?? "small";
        if (nextViseme !== visemeRef.current) {
          visemeRef.current = nextViseme;
          setViseme(nextViseme);
        }
        audioAnimationRef.current = requestAnimationFrame(animate);
      };
      await new Promise<void>((resolve) => {
        speechPlaybackResolveRef.current = resolve;
        source.onended = () => {
          speechPlaybackResolveRef.current = undefined;
          stopAudio();
          settleSpeechPhase();
          resolve();
        };
        setPhase("speaking");
        source.start();
        animate();
      });
    } catch (error) {
      if (speechRequestRef.current === controller) speechRequestRef.current = undefined;
      stopAudio();
      if (error instanceof Error && error.name === "AbortError") {
        settleSpeechPhase();
        return;
      }
      setConnectionError(error instanceof Error ? error.message : "Voice playback failed");
      setPhase("idle");
    }
  }, [playProgressiveSpeech, settings, settleSpeechPhase, stopAudio, voiceOn]);

  const clearSpeechQueue = useCallback(() => {
    for (const queued of speechQueueRef.current) {
      queued.prepared?.controller.abort();
      void queued.prepared?.promise.catch(() => undefined);
    }
    speechQueueRef.current = [];
    stopAudio();
  }, [stopAudio]);

  const stopBargeInDetection = useCallback(() => {
    if (bargeInAnimationRef.current) cancelAnimationFrame(bargeInAnimationRef.current);
    bargeInAnimationRef.current = undefined;
    const context = bargeInCtxRef.current;
    bargeInCtxRef.current = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }, []);

  // Barge-in: while the agent is working/speaking in a hands-free voice session,
  // keep an ear on the (already warm, echo-cancelled) microphone. If the user
  // starts talking over it, stop the agent immediately and hand control back so
  // the hands-free loop captures the new utterance. Detection is deliberately
  // conservative. An adaptive floor plus a short grace period keeps the agent's
  // own voice (residual echo) from interrupting itself.
  const startBargeInDetection = useCallback(() => {
    if (bargeInCtxRef.current) return;
    const stream = handsFreeMicStreamRef.current;
    if (!stream?.active) return;
    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    bargeInCtxRef.current = context;
    if (context.state === "suspended") void context.resume();

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    const waveform = new Uint8Array(analyser.fftSize);
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    // Use a slowly rising floor so the agent's own residual speaker echo cannot
    // teach the detector to ignore a real interruption. Speech must also persist
    // and concentrate most of its energy in the human voice band.
    let floor = 0.014;
    let candidateStartedAt = 0;
    let lastSpeechLikeAt = 0;
    let speechEvidenceMs = 0;
    let candidatePeak = 0;
    let previousFrameAt = performance.now();
    const armedAt = previousFrameAt + 320;

    const monitor = () => {
      if (bargeInCtxRef.current !== context) return;
      analyser.getByteTimeDomainData(waveform);
      analyser.getFloatFrequencyData(spectrum);
      let squareTotal = 0;
      let peak = 0;
      let zeroCrossings = 0;
      let previousSample = 0;
      for (const value of waveform) {
        const centered = (value - 128) / 128;
        squareTotal += centered * centered;
        peak = Math.max(peak, Math.abs(centered));
        if ((centered >= 0) !== (previousSample >= 0)) zeroCrossings += 1;
        previousSample = centered;
      }
      const rms = Math.sqrt(squareTotal / waveform.length);
      const now = performance.now();
      const frameMs = Math.min(34, Math.max(8, now - previousFrameAt));
      previousFrameAt = now;
      const speakingPhase = phaseRef.current === "speaking";
      const threshold = Math.max(speakingPhase ? 0.034 : 0.028, floor * 2.35);
      const zeroCrossingRate = zeroCrossings / Math.max(1, waveform.length - 1);
      const crestFactor = peak / Math.max(rms, 0.0001);
      let totalEnergy = 0;
      let speechBandEnergy = 0;
      const binWidth = context.sampleRate / analyser.fftSize;
      for (let index = 1; index < spectrum.length; index += 1) {
        const energy = 10 ** (spectrum[index] / 10);
        totalEnergy += energy;
        const frequency = index * binWidth;
        if (frequency >= 110 && frequency <= 4_200) speechBandEnergy += energy;
      }
      const speechBandRatio = speechBandEnergy / Math.max(totalEnergy, Number.EPSILON);
      const aboveThreshold = now >= armedAt && rms > threshold;
      const speechLike = aboveThreshold
        && speechBandRatio >= 0.48
        && zeroCrossingRate >= 0.0015
        && zeroCrossingRate <= 0.38
        && crestFactor <= 10;

      if (speechLike) {
        if (!candidateStartedAt) candidateStartedAt = now;
        lastSpeechLikeAt = now;
        speechEvidenceMs += frameMs;
        candidatePeak = Math.max(candidatePeak, rms);
        const candidateAge = now - candidateStartedAt;
        const strongDirectVoice = candidatePeak >= threshold * 1.9;
        const requiredAge = speakingPhase ? (strongDirectVoice ? 150 : 235) : 300;
        const requiredEvidence = speakingPhase ? (strongDirectVoice ? 105 : 165) : 205;
        if (candidateAge >= requiredAge && speechEvidenceMs >= requiredEvidence) {
          // Confirmed sustained speech over the agent. Stop and reopen the warm
          // microphone quickly enough to capture the rest of the utterance.
          bargeInCapturePendingRef.current = true;
          stopBargeInDetection();
          clearSpeechQueue();
          requestAbortRef.current?.abort();
          setToolLabel("");
          setMessages((current) => current.map((item) => item.streaming
            ? { ...item, text: item.text.trim() || "…", streaming: false, statusText: undefined }
            : item));
          setPhase("idle");
          return;
        }
      } else {
        if (!lastSpeechLikeAt || now - lastSpeechLikeAt > 105) {
          candidateStartedAt = 0;
          lastSpeechLikeAt = 0;
          speechEvidenceMs = 0;
          candidatePeak = 0;
        } else {
          speechEvidenceMs = Math.max(0, speechEvidenceMs - frameMs * 0.35);
        }
      }
      if (!aboveThreshold) {
        const cappedSample = Math.min(rms, floor * 1.2);
        const adaptation = cappedSample < floor ? 0.075 : speakingPhase ? 0.0015 : 0.006;
        floor = Math.max(0.006, Math.min(0.06, floor * (1 - adaptation) + cappedSample * adaptation));
      }
      bargeInAnimationRef.current = requestAnimationFrame(monitor);
    };
    bargeInAnimationRef.current = requestAnimationFrame(monitor);
  }, [clearSpeechQueue, stopBargeInDetection]);

  // Listen for the user talking over the agent while it's busy in a hands-free
  // voice session, so they can interrupt at any point. Start is idempotent, so
  // the monitor persists smoothly across thinking → tool → speaking.
  useEffect(() => {
    const armed = handsFreeActive && voiceOn && (phase === "thinking" || phase === "tool" || phase === "speaking");
    if (armed) startBargeInDetection();
    else stopBargeInDetection();
  }, [handsFreeActive, voiceOn, phase, startBargeInDetection, stopBargeInDetection]);

  const drainSpeechQueue = useCallback(async () => {
    if (speechQueueRunningRef.current) return;
    speechQueueRunningRef.current = true;
    try {
      while (speechQueueRef.current.length) {
        const next = speechQueueRef.current.shift();
        if (next) await playSpeech(next.text, next.deliveryHint, next.fast, next.prepared);
      }
    } finally {
      speechQueueRunningRef.current = false;
      settleSpeechPhase();
      if (bargeInCapturePendingRef.current) setVoiceLoopRevision((value) => value + 1);
    }
  }, [playSpeech, settleSpeechPhase]);

  const queueSpeech = useCallback((text: string, deliveryHint?: VisualState["reaction_delivery"], fast = false) => {
    const spoken = stripForSpeech(text);
    if (!spoken) return;
    speechQueueRef.current.push({
      text: spoken,
      deliveryHint,
      fast,
      ...(!fast ? { prepared: prepareCompleteSpeech(spoken, deliveryHint) } : {}),
    });
    void drainSpeechQueue();
  }, [drainSpeechQueue, prepareCompleteSpeech]);

  const greetCamera = useCallback(async () => {
    const assistantId = createId("first-look");
    setConnectionError("");
    setPhase("thinking");
    setMessages((current) => [...current, {
      id: assistantId,
      role: "assistant",
      text: "",
      streaming: true,
      createdAt: Date.now(),
    }]);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7_000);
    let greeting = "Hi, I can see you now. I’ll notice when you show me something or make a gesture.";
    try {
      const frameDataUrl = captureFrame();
      if (!frameDataUrl) throw new Error("The camera frame is not ready");
      const response = await fetch("/api/vision/greet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ frameDataUrl, model: settings.visionModel }),
      });
      if (!response.ok) throw new Error("First-look vision is warming up");
      const body = (await response.json()) as { text?: string; visibleObjects?: string[] };
      if (body.text?.trim()) {
        const greetingText = body.text.trim();
        const concepts = (body.visibleObjects ?? [])
          .map(canonicalObjectConcept)
          .filter((concept) => Boolean(concept) && greetingText.toLowerCase().includes(concept))
          .map((concept) => `object:${concept}`);
        const repeatsKnownObject = concepts.some((concept) => visualObservationHistoryRef.current.has(concept));
        greeting = repeatsKnownObject ? "Welcome back. I’m here with you." : greetingText;
        if (!repeatsKnownObject) {
          for (const concept of concepts) visualObservationHistoryRef.current.add(concept);
          localStorage.setItem("nova-visual-observations", JSON.stringify([...visualObservationHistoryRef.current]));
        }
        setConnectionError("");
      }
    } catch {
      // A prompt, useful greeting is better than exposing a transient model error.
    } finally {
      window.clearTimeout(timeout);
      cameraGreetingInFlightRef.current = false;
    }

    const now = Date.now();
    lastReactionAtRef.current = now;
    reactionHistoryRef.current.set(greeting.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), now);
    lastActivityAtRef.current = now;
    setMessages((current) => current.map((message) => message.id === assistantId
      ? { ...message, text: greeting, streaming: false }
      : message));
    void persistAssistantMessage(assistantId, greeting, now);
    // Only greet out loud inside an active voice session. In text mode the
    // greeting stays on screen as text, so turning on the camera never starts
    // the agent talking on its own.
    if (handsFreeActiveRef.current) {
      queueSpeech(greeting, "curious", true);
    } else {
      setPhase("idle");
    }
  }, [captureFrame, persistAssistantMessage, queueSpeech, settings.visionModel]);

  const pollArtifact = useCallback(async (artifact: MediaArtifact) => {
    if (!artifact.queueId || !artifact.model || (artifact.kind !== "video" && artifact.kind !== "music")) return;
    let attempts = 0;
    let consecutiveErrors = 0;
    const startedAt = Date.now();
    const maxPollingTime = 30 * 60 * 1000;
    const scheduleNextPoll = (poll: () => void, delay = 5000) => {
      if (Date.now() - startedAt < maxPollingTime) {
        window.setTimeout(poll, delay);
        return;
      }
      setArtifacts((current) => current.map((item) => item.id === artifact.id ? {
        ...item,
        status: "error",
        message: "This generation is taking longer than expected. The Venice job may still finish.",
      } : item));
    };
    const poll = async () => {
      attempts += 1;
      try {
        const response = await fetch("/api/media/retrieve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: artifact.kind,
            model: artifact.model,
            queueId: artifact.queueId,
            downloadUrl: artifact.downloadUrl,
          }),
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
          const url = URL.createObjectURL(await response.blob());
          mediaObjectUrlsRef.current.add(url);
          setArtifacts((current) => current.map((item) => item.id === artifact.id ? { ...item, status: "ready", url, progress: 100 } : item));
          return;
        }
        const status = (await response.json().catch(() => ({}))) as {
          status?: string;
          average_execution_time?: number;
          execution_duration?: number;
          message?: string;
          error?: string;
        };
        const normalizedStatus = status.status?.toUpperCase() ?? "";
        const responseMessage = status.message ?? status.error ?? `Media job ${normalizedStatus || "could not be checked"}`;
        const retryableResponse = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        if (!response.ok) {
          const error = new Error(responseMessage) as Error & { terminal?: boolean };
          error.terminal = !retryableResponse;
          throw error;
        }
        if (["FAILED", "ERROR", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"].includes(normalizedStatus)) {
          const error = new Error(responseMessage) as Error & { terminal?: boolean };
          error.terminal = true;
          throw error;
        }
        consecutiveErrors = 0;
        const progress = status.average_execution_time
          ? Math.min(92, Math.round(((status.execution_duration ?? 0) / status.average_execution_time) * 100))
          : Math.min(90, attempts * 4);
        setArtifacts((current) => current.map((item) => item.id === artifact.id ? {
          ...item,
          status: "processing",
          progress,
          message: undefined,
        } : item));
        scheduleNextPoll(poll);
      } catch (error) {
        const terminal = error instanceof Error && Boolean((error as Error & { terminal?: boolean }).terminal);
        consecutiveErrors += 1;
        if (!terminal && consecutiveErrors <= 8) {
          setArtifacts((current) => current.map((item) => item.id === artifact.id ? {
            ...item,
            status: "processing",
            message: "Still creating. Reconnecting to Venice.",
          } : item));
          scheduleNextPoll(poll, Math.min(12_000, 3000 + consecutiveErrors * 1500));
          return;
        }
        setArtifacts((current) => current.map((item) => item.id === artifact.id ? {
          ...item,
          status: "error",
          message: error instanceof Error ? error.message : "Media generation failed",
        } : item));
      }
    };
    window.setTimeout(poll, 2500);
  }, []);

  const handleToolResult = useCallback((event: AgentStreamEvent): string | undefined => {
    const details = event.details;
    if (!details || event.isError) return undefined;
    if (details.kind === "identity" && details.agent && typeof details.agent === "object") {
      const updatedAgent = details.agent as unknown as WorkspaceSnapshot["agents"][number];
      setWorkspaceSnapshot((current) => current ? {
        ...current,
        agents: current.agents.map((agent) => agent.id === updatedAgent.id ? updatedAgent : agent),
      } : current);
    } else if (details.kind === "avatar" && typeof details.action === "string") {
      triggerAction(details.action as AvatarAction);
    } else if (details.kind === "presence" && details.directive) {
      setPresenceDirective(details.directive as unknown as PresenceDirective);
    } else if (details.kind === "vision" && details.visual) {
      const nextVisual = details.visual as VisualState;
      setVisual(nextVisual);
      triggerAction(actionFromVisual(nextVisual));
    } else if (["image", "video", "music"].includes(String(details.kind))) {
      if (details.status === "error" && !details.queueId && !details.url) return undefined;
      const artifact: MediaArtifact = {
        id: String(details.id ?? crypto.randomUUID()),
        kind: details.kind as MediaArtifact["kind"],
        title: String(details.title ?? "Venice creation"),
        prompt: String(details.prompt ?? ""),
        status: details.status as MediaArtifact["status"],
        url: details.url ? String(details.url) : undefined,
        model: details.model ? String(details.model) : undefined,
        queueId: details.queueId ? String(details.queueId) : undefined,
        downloadUrl: details.downloadUrl ? String(details.downloadUrl) : undefined,
        quote: typeof details.quote === "number" ? details.quote : undefined,
        duration: details.duration ? String(details.duration) : undefined,
        resolution: details.resolution ? String(details.resolution) : undefined,
        soundtrack: ["none", "natural", "music"].includes(String(details.soundtrack)) ? details.soundtrack as MediaArtifact["soundtrack"] : undefined,
        audioDirection: details.audioDirection ? String(details.audioDirection) : undefined,
      };
      const confirmedArtifactId = artifact.status === "queued"
        ? pendingMediaConfirmationRef.current.get(artifact.kind)
        : undefined;
      const nextArtifact = confirmedArtifactId ? { ...artifact, id: confirmedArtifactId } : artifact;
      if (confirmedArtifactId) pendingMediaConfirmationRef.current.delete(artifact.kind);
      setArtifacts((current) => {
        const next = [nextArtifact, ...current.filter((item) => (
          item.id !== nextArtifact.id
          && !(nextArtifact.status === "queued" && item.kind === nextArtifact.kind && !item.url
            && ["quoted", "queued", "processing", "error"].includes(item.status))
        ))];
        return next;
      });
      if (nextArtifact.status === "queued") void pollArtifact(nextArtifact);
      return nextArtifact.id;
    }
    return undefined;
  }, [pollArtifact, triggerAction]);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) return;
    setConnectionError("");
    let slots = MAX_ATTACHMENTS - attachments.length;
    for (const file of files) {
      if (slots <= 0) { setConnectionError(`You can attach up to ${MAX_ATTACHMENTS} files at a time.`); break; }
      try {
        if (file.type.startsWith("image/")) {
          if (file.size > MAX_ATTACHMENT_IMAGE_BYTES) { setConnectionError(`${file.name} is too large (max 6 MB).`); continue; }
          const dataUrl = await readFileAsDataUrl(file);
          setAttachments((current) => [...current, { id: createId("att"), name: file.name, mime: file.type, size: file.size, kind: "image", dataUrl }]);
          slots -= 1;
        } else if (isTextFile(file)) {
          const text = await readFileAsText(file);
          setAttachments((current) => [...current, { id: createId("att"), name: file.name, mime: file.type || "text/plain", size: file.size, kind: "text", text: text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) }]);
          slots -= 1;
        } else {
          setConnectionError(`${file.name}: that file type isn't supported yet. Attach an image or a text-based document.`);
        }
      } catch {
        setConnectionError(`Could not read ${file.name}.`);
      }
    }
  }, [attachments.length]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const sendMessage = useCallback(async (rawMessage: string, options: SendMessageOptions = {}) => {
    const message = rawMessage.trim();
    const outgoingAttachments = options.attachments ?? [];
    if ((!message && !outgoingAttachments.length) || !sessionId || (isBusy && options.hidden)) {
      if (!sessionId && (message || outgoingAttachments.length)) setConnectionError("Your conversation is still loading. Try again in a moment.");
      if (options.hidden) cameraGreetingInFlightRef.current = false;
      return;
    }
    // When a typed request asks to be seen but the camera is off, request
    // permission inline (Allow button) instead of letting the agent reply that
    // it can't see. Voice turns and turns that already carry an attached image
    // skip this so we never prompt for the camera unnecessarily.
    if (!options.hidden && !options.voiceTurn && !options.skipCameraPrompt
      && !outgoingAttachments.some((attachment) => attachment.kind === "image")
      && settings.cameraAwareness && !cameraOn && messageNeedsVision(message)) {
      setInput("");
      setCameraPrompt({ message, voiceTurn: options.voiceTurn });
      return;
    }
    setCameraPrompt(null);

    const shouldQueue = !options.hidden
      && !options.fromQueue
      && (isBusy || runningTurnsRef.current.has(sessionId));
    if (shouldQueue) {
      const queuedMessage: QueuedMessage = {
        id: createId("user"),
        conversationId: sessionId,
        message,
        attachments: outgoingAttachments,
        createdAt: Date.now(),
      };
      updateMessageQueue((current) => [...current, queuedMessage]);
      setMessages((current) => [...current, queuedChatMessage(queuedMessage)]);
      setConnectionError("");
      setInput("");
      if (outgoingAttachments.length) setAttachments([]);
      return;
    }

    // Images ride along as vision input; text files are inlined so the model
    // sees their content. The transcript bubble shows clean text + chips.
    const imageAttachmentUrls = outgoingAttachments
      .filter((attachment) => attachment.kind === "image" && attachment.dataUrl)
      .map((attachment) => attachment.dataUrl as string);
    const inlinedFiles = outgoingAttachments
      .filter((attachment) => attachment.kind === "text" && attachment.text)
      .map((attachment) => `\n\n[Attached file: ${attachment.name}]\n\`\`\`\n${attachment.text}\n\`\`\``)
      .join("");
    const sentMessage = `${message || "Please take a look at the attached file(s)."}${inlinedFiles}`;
    if (outgoingAttachments.length) setAttachments([]);
    if (isBusy) {
      requestAbortRef.current?.abort();
      clearSpeechQueue();
      setToolLabel("");
      setMessages((current) => current.map((item) => item.streaming
        ? { ...item, text: item.text.trim() || "Interrupted.", streaming: false, statusText: undefined }
        : item));
    }
    mirrorRequestAbortRef.current?.abort();
    mirrorRequestAbortRef.current = undefined;
    mirrorBusyRef.current = false;
    lastActivityAtRef.current = Date.now();
    clearSpeechQueue();
    setConnectionError("");
    setInput("");
    setPhase("thinking");
    setToolLabel("");
    const userMessage: ChatMessage = {
      id: options.existingUserMessageId ?? createId("user"),
      role: "user",
      text: message,
      ...(outgoingAttachments.length ? { attachments: outgoingAttachments.map((attachment) => ({
        name: attachment.name,
        kind: attachment.kind,
        dataUrl: attachment.dataUrl,
        size: attachment.size,
      })) } : {}),
      createdAt: Date.now(),
    };
    const assistantId = createId("assistant");
    const acknowledgement = taskAcknowledgement(message);
    setMessages((current) => {
      const existingQueuedMessage = options.existingUserMessageId
        ? current.find((item) => item.id === options.existingUserMessageId)
        : undefined;
      const waitingMessages = options.existingUserMessageId
        ? current.filter((item) => item.queued && item.id !== options.existingUserMessageId)
        : [];
      const prepared = options.existingUserMessageId
        ? [
            ...current.filter((item) => !item.queued && item.id !== options.existingUserMessageId),
            ...(existingQueuedMessage ? [{ ...existingQueuedMessage, queued: false }] : []),
          ]
        : current;
      return [
        ...prepared,
        ...(options.hidden || options.existingUserMessageId ? [] : [userMessage]),
        ...(options.silent ? [] : [{
          id: assistantId,
          role: "assistant" as const,
          text: "",
          statusText: acknowledgement ?? "Thinking about that…",
          streaming: true,
          createdAt: Date.now(),
        }]),
        ...waitingMessages,
      ];
    });

    const controller = new AbortController();
    requestAbortRef.current = controller;
    const turnConversationId = sessionId;
    markConversationRunning(turnConversationId, controller);
    // A turn keeps streaming even after you open another chat. UI mutations are
    // applied only while its conversation is the one on screen; otherwise the turn
    // runs in the background (server persists it) and shows a sidebar spinner.
    const isActiveTurn = () => sessionIdRef.current === turnConversationId;
    let wasBackgrounded = false;
    const ui = (mutate: () => void) => {
      if (isActiveTurn()) mutate();
      else {
        wasBackgrounded = true;
      }
    };
    let finalText = "";
    let pendingSpeech = "";
    let queuedEarlySpeech = false;
    let lastToolResult = "";
    let toolFailed = false;
    let firstDeltaReceived = false;
    // At most one spoken "here's what I'm doing" line per turn (either the
    // pre-emptive acknowledgement or a live tool narration), so voice mode keeps
    // the user informed without stacking filler phrases.
    let spokenWaitPhrase = false;
    let acknowledgementTimer: number | undefined;
    // Browser-side watchdog: if the agent NDJSON stream goes completely silent
    // for this long (a hung server/tool that never closes), abort so the UI can
    // recover instead of showing "Thinking" forever. Reset on any activity, and
    // sized generously so slow-but-real tool calls are never cut off.
    let streamIdleTimer: number | undefined;
    let watchdogTripped = false;
    const AGENT_STREAM_IDLE_MS = 90_000;
    const armStreamWatchdog = () => {
      if (streamIdleTimer) window.clearTimeout(streamIdleTimer);
      streamIdleTimer = window.setTimeout(() => {
        watchdogTripped = true;
        controller.abort();
      }, AGENT_STREAM_IDLE_MS);
    };
    if (options.voiceTurn && voiceOn && acknowledgement) {
      acknowledgementTimer = window.setTimeout(() => {
        if (firstDeltaReceived || spokenWaitPhrase) return;
        spokenWaitPhrase = true;
        queueSpeech(acknowledgement, "warm", true);
      }, 450);
    }
    // Start the opening sentence while the answer is still streaming. The
    // remainder is prepared in one natural take, which keeps speech fluid while
    // removing the full model-completion wait from time to first audio.
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          agentId: activeAgentId,
          message: sentMessage,
          messageId: userMessage.id,
          frameDataUrl: settings.cameraAwareness && (options.hidden || messageNeedsVision(message)) ? captureFrame() : undefined,
          attachmentImageUrls: imageAttachmentUrls.length ? imageAttachmentUrls : undefined,
          hidden: options.hidden,
          voiceMode: options.voiceTurn,
          settings,
        }),
      });
      if (!response.ok || !response.body) {
        const error = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(error.error ?? "The agent could not start");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      armStreamWatchdog();
      while (true) {
        const { done, value } = await reader.read();
        armStreamWatchdog();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: AgentStreamEvent;
          try {
            event = JSON.parse(line) as AgentStreamEvent;
          } catch {
            // A single malformed NDJSON line should not abort the whole turn.
            continue;
          }
          if (event.type === "text_delta" && event.delta) {
            if (!firstDeltaReceived) {
              firstDeltaReceived = true;
              if (acknowledgementTimer) window.clearTimeout(acknowledgementTimer);
            }
            ui(() => setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, statusText: undefined } : item)));
            finalText += event.delta;
            pendingSpeech += event.delta;
            if (isActiveTurn() && options.voiceTurn && voiceOn && !queuedEarlySpeech) {
              const opening = takeEarlySpeechSegment(pendingSpeech);
              if (opening) {
                queuedEarlySpeech = true;
                pendingSpeech = opening.rest;
                queueSpeech(opening.segment, undefined, true);
              }
            }
            if (isActiveTurn() && !speechQueueRunningRef.current && !speechSourceRef.current && !speechRequestRef.current) setPhase("thinking");
            ui(() => setMessages((current) => current.map((item) => {
              if (item.id !== assistantId) return item;
              const next = { ...item, text: item.text + event.delta };
              // The answer has begun, so seal any reasoning trace that streamed
              // first (some models omit an explicit thinking_end).
              if (next.thinkingStreaming) {
                next.thinkingStreaming = false;
                if (next.thinkingMs === undefined && next.thinkingStartedAt) {
                  next.thinkingMs = Date.now() - next.thinkingStartedAt;
                }
              }
              return next;
            })));
          } else if (event.type === "thinking_start") {
            ui(() => {
              setPhase("thinking");
              setMessages((current) => current.map((item) => item.id === assistantId
                ? { ...item, thinkingStreaming: true, thinkingStartedAt: item.thinkingStartedAt ?? Date.now() }
                : item));
            });
          } else if (event.type === "thinking_delta" && event.delta) {
            const delta = event.delta;
            ui(() => {
              setPhase("thinking");
              setMessages((current) => current.map((item) => item.id === assistantId
                ? {
                  ...item,
                  statusText: undefined,
                  thinking: (item.thinking ?? "") + delta,
                  thinkingStreaming: true,
                  thinkingStartedAt: item.thinkingStartedAt ?? Date.now(),
                }
                : item));
            });
          } else if (event.type === "thinking_end") {
            ui(() => setMessages((current) => current.map((item) => item.id === assistantId
              ? {
                ...item,
                thinkingStreaming: false,
                thinkingMs: item.thinkingMs ?? (item.thinkingStartedAt ? Date.now() - item.thinkingStartedAt : undefined),
              }
              : item)));
          } else if (event.type === "tool_start") {
            const label = toolStatus(event.name, agentName);
            ui(() => { setPhase("tool"); setToolLabel(label); });
            // Narrate the action aloud so a voice turn doesn't go silent while a
            // tool (web search, camera, media, etc.) runs. Only once per turn and
            // only before the spoken answer has begun, so it never interrupts.
            if (isActiveTurn() && options.voiceTurn && voiceOn && !spokenWaitPhrase && !queuedEarlySpeech) {
              const narration = toolNarration(event.name);
              if (narration) {
                spokenWaitPhrase = true;
                if (acknowledgementTimer) { window.clearTimeout(acknowledgementTimer); acknowledgementTimer = undefined; }
                queueSpeech(narration, "warm", true);
              }
            }
            ui(() => setMessages((current) => current.map((item) => item.id === assistantId && !item.text
              ? { ...item, statusText: event.name === "search_web" ? "I’m checking the live web for that now." : `${label}…` }
              : item)));
          } else if (event.type === "tool_end") {
            ui(() => {
              const mediaId = handleToolResult(event);
              if (mediaId) {
                setMessages((current) => current.map((item) => item.id === assistantId
                  ? { ...item, mediaIds: [...new Set([...(item.mediaIds ?? []), mediaId])] }
                  : item));
              }
            });
            if (event.resultText?.trim()) lastToolResult = event.resultText.trim();
            if (event.isError) toolFailed = true;
          } else if (event.type === "subagent_start") {
            const runId = String(event.id ?? "");
            const task = String(event.task ?? "");
            ui(() => {
              setPhase("tool");
              setMessages((current) => current.map((item) => item.id === assistantId
                ? { ...item, subagents: [...(item.subagents ?? []), { id: runId, task, steps: [], turns: 0, toolCalls: 0, running: true }] }
                : item));
            });
          } else if (event.type === "subagent_step") {
            const runId = String(event.id ?? "");
            const phase = event.phase;
            const tool = event.tool;
            const turn = event.turn;
            ui(() => setMessages((current) => current.map((item) => {
              if (item.id !== assistantId || !item.subagents) return item;
              return { ...item, subagents: item.subagents.map((run) => run.id === runId
                ? {
                  ...run,
                  steps: phase === "tool" && tool ? [...run.steps, { tool }] : run.steps,
                  toolCalls: phase === "tool" ? run.toolCalls + 1 : run.toolCalls,
                  turns: phase === "turn" && typeof turn === "number" ? turn : run.turns,
                }
                : run) };
            })));
          } else if (event.type === "subagent_end") {
            const runId = String(event.id ?? "");
            ui(() => setMessages((current) => current.map((item) => {
              if (item.id !== assistantId || !item.subagents) return item;
              return { ...item, subagents: item.subagents.map((run) => run.id === runId
                ? { ...run, running: false, turns: typeof event.turns === "number" ? event.turns : run.turns, toolCalls: typeof event.toolCalls === "number" ? event.toolCalls : run.toolCalls, hitBudget: Boolean(event.hitBudget), ok: event.ok !== false }
                : run) };
            })));
          } else if (event.type === "error") {
            throw new Error(event.message ?? "The Venice agent returned an error");
          }
        }
        if (done) break;
      }

      const completedText = finalText.trim() || lastToolResult || (toolFailed
        ? "I couldn’t finish that action just now. Please try it once more."
        : "I didn’t receive a complete answer. Please try that again.");
      ui(() => {
        setMessages((current) => current.map((item) => item.id === assistantId ? {
          ...item,
          text: item.text || completedText,
          streaming: false,
          statusText: undefined,
          thinkingStreaming: false,
          thinkingMs: item.thinkingMs ?? (item.thinkingStartedAt ? Date.now() - item.thinkingStartedAt : undefined),
        } : item));
        setToolLabel("");
      });
      const finalSpokenText = finalText || completedText;
      if (!finalText) pendingSpeech = finalSpokenText;
      // If no opening sentence was available during the model stream, use
      // Venice streaming speech for the whole reply. If the opening is already
      // playing, prepare the remainder concurrently for a smooth handoff.
      const shouldSpeak = isActiveTurn() && Boolean(options.voiceTurn) && voiceOn;
      if (shouldSpeak && pendingSpeech.trim()) queueSpeech(pendingSpeech.trim(), undefined, !queuedEarlySpeech);
      if (isActiveTurn() && !shouldSpeak) setPhase("idle");
      if (options.hidden) lastReactionAtRef.current = Date.now();
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      // A normal abort (user interrupted, or a new turn took over) is handled by
      // the incoming turn. Bail without touching its state. A watchdog-driven
      // abort, however, must be finalized here so the UI doesn't hang.
      if (aborted && !watchdogTripped) return;
      const messageText = watchdogTripped
        ? "That reply stalled, so I stopped waiting. Please try again."
        : friendlyAgentError(error);
      if (isActiveTurn() && !watchdogTripped) setConnectionError(messageText);
      ui(() => {
        setToolLabel("");
        setMessages((current) => current.map((item) => item.id === assistantId ? {
          ...item,
          // Preserve whatever streamed in before a stall; replace only on a hard error.
          text: watchdogTripped ? (item.text.trim() || messageText) : messageText,
          streaming: false,
          statusText: undefined,
          thinkingStreaming: false,
        } : item));
      });
      // Don't cut off a first sentence that may still be playing; otherwise drop
      // out of "thinking"/"tool" so the UI and hands-free loop can recover.
      if (isActiveTurn() && !speechQueueRunningRef.current) setPhase("idle");
    } finally {
      if (acknowledgementTimer) window.clearTimeout(acknowledgementTimer);
      if (streamIdleTimer) window.clearTimeout(streamIdleTimer);
      clearConversationRunning(turnConversationId);
      if (requestAbortRef.current === controller) requestAbortRef.current = undefined;
      if (bargeInCapturePendingRef.current) setVoiceLoopRevision((value) => value + 1);
      if (options.hidden) cameraGreetingInFlightRef.current = false;
      // The agent stream has closed. Re-settle the voice phase in case a short
      // reply finished speaking while the stream was still technically open.
      // otherwise the UI could stay stuck on "Thinking".
      if (isActiveTurn()) settleSpeechPhase();
      // Keep the sidebar's chat titles and ordering current after a real turn.
      if (!options.hidden) void refreshWorkspace();
      // If this turn ran in the background and its chat is now on screen, pull the
      // finished reply from the server (the live stream wasn't applied while away).
      if (wasBackgrounded && isActiveTurn()) {
        try {
          const refreshed = await fetch(`/api/workspace?conversationId=${encodeURIComponent(turnConversationId)}`, { cache: "no-store" });
          const refreshedPayload = await refreshed.json() as ConversationPayload & { error?: string };
          if (refreshed.ok && isActiveTurn()) {
            setMessages([
              ...conversationMessages(refreshedPayload.messages, agentName),
              ...messageQueueRef.current
                .filter((item) => item.conversationId === turnConversationId)
                .map(queuedChatMessage),
            ]);
            setToolLabel("");
            setPhase("idle");
          }
        } catch {
          // Non-fatal: the sidebar refresh above still reflects the update.
        }
      }
    }
  }, [activeAgentId, agentName, cameraOn, captureFrame, clearConversationRunning, clearSpeechQueue, handleToolResult, isBusy, markConversationRunning, queueSpeech, refreshWorkspace, sessionId, settings, settleSpeechPhase, updateMessageQueue, voiceOn]);

  useEffect(() => {
    if (!sessionId || isBusy || runningConversations.includes(sessionId)) return;
    const next = messageQueue.find((item) => item.conversationId === sessionId);
    if (!next) return;
    updateMessageQueue((current) => current.filter((item) => item.id !== next.id));
    void sendMessage(next.message, {
      attachments: next.attachments,
      fromQueue: true,
      existingUserMessageId: next.id,
    });
  }, [isBusy, messageQueue, runningConversations, sendMessage, sessionId, updateMessageQueue]);

  const removeQueuedMessage = useCallback((id: string) => {
    updateMessageQueue((current) => current.filter((item) => item.id !== id));
    setMessages((current) => current.filter((item) => item.id !== id));
  }, [updateMessageQueue]);

  const beginEditMessage = useCallback((id: string, text: string) => {
    if (isBusy) return;
    setEditingMessageId(id);
    setEditDraft(text);
  }, [isBusy]);

  const cancelEditMessage = useCallback(() => {
    setEditingMessageId(undefined);
    setEditDraft("");
  }, []);

  // Edit a past user message and continue the conversation from that point:
  // truncate the stored history (and agent session) to just before it, drop the
  // now-stale messages from the view, then resend the edited text as a fresh turn.
  const submitEditMessage = useCallback(async (messageId: string) => {
    const nextText = editDraft.trim();
    setEditingMessageId(undefined);
    setEditDraft("");
    if (!nextText) return;
    if (!messages.some((message) => message.id === messageId)) return;
    await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rewind_conversation", conversationId: sessionId, messageId }),
    }).catch(() => undefined);
    setMessages((current) => {
      const cut = current.findIndex((message) => message.id === messageId);
      return cut < 0 ? current : current.slice(0, cut);
    });
    await sendMessage(nextText);
  }, [editDraft, messages, sendMessage, sessionId]);

  const toggleCamera = useCallback(async (): Promise<boolean> => {
    if (cameraOn) {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = undefined;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraOn(false);
      setCameraStarting(false);
      lastVisualSignatureRef.current = "";
      latestMotionClipRef.current = undefined;
      lastAmbientFrameRef.current = undefined;
      mirrorRequestAbortRef.current?.abort();
      mirrorRequestAbortRef.current = undefined;
      cameraGreetingInFlightRef.current = false;
      setVisual(undefined);
      return false;
    }
    setCameraStarting(true);
    setConnectionError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not expose camera access. Open the Entity app in a current browser on localhost.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const [track] = stream.getVideoTracks();
      track?.addEventListener("ended", () => {
        cameraStreamRef.current = undefined;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraOn(false);
        lastVisualSignatureRef.current = "";
        latestMotionClipRef.current = undefined;
        lastAmbientFrameRef.current = undefined;
        mirrorRequestAbortRef.current?.abort();
        mirrorRequestAbortRef.current = undefined;
        cameraGreetingInFlightRef.current = false;
        setVisual(undefined);
        setConnectionError("The camera stopped. Turn it on again when you are ready.");
      }, { once: true });
      setCameraOn(true);
      return true;
    } catch (error) {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = undefined;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraOn(false);
      latestMotionClipRef.current = undefined;
      lastAmbientFrameRef.current = undefined;
      setConnectionError(cameraErrorMessage(error));
      return false;
    } finally {
      setCameraStarting(false);
    }
  }, [cameraOn]);

  useEffect(() => {
    if (!settings.cameraAwareness || !cameraOn) return;
    const inspect = async () => {
      if (
        mirrorBusyRef.current
        || phaseRef.current !== "idle"
        || userSpeakingRef.current
        || Date.now() - lastActivityAtRef.current < 4_000
      ) return;
      const controller = new AbortController();
      mirrorRequestAbortRef.current = controller;
      mirrorBusyRef.current = true;
      try {
        const frameDataUrl = captureFrame();
        if (!frameDataUrl) return;
        const previousFrameDataUrl = lastAmbientFrameRef.current;
        lastAmbientFrameRef.current = frameDataUrl;
        // Proactive commentary and motion clips are only worthwhile in talkative
        // mode while NOT in a hands-free voice conversation. During voice mode we
        // keep silent, still-frame awareness (so the presence still mirrors the
        // user) but never capture clips or inject spontaneous speech that would
        // race with the live turn-taking loop and stall follow-ups.
        const proactiveVision = settings.talkativeMode && !handsFreeActiveRef.current;
        const videoDataUrl = proactiveVision
          ? await captureMotionClip(controller.signal, 1_500)
          : undefined;
        if (controller.signal.aborted || phaseRef.current !== "idle" || userSpeakingRef.current) return;
        const question = proactiveVision
          ? "TALKATIVE_AMBIENT_CHECK: Watch for a concrete change across this short clip, including a drink, a wave, a smile or laugh, picking something up, changing glasses or clothing, or entering/leaving. If something genuinely changed, reply with one brief, friendly, non-repetitive observation or an inviting question. Do not restate background objects already discussed. If there is no clear change, use SKIP."
          : "AWARENESS_CHECK: Update the companion's visual state from this short clip. Describe concrete movement or expression changes, but set reaction to SKIP because spontaneous speech is off.";
        const response = await fetch("/api/vision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            frameDataUrl,
            frameDataUrls: [previousFrameDataUrl, frameDataUrl].filter((value): value is string => Boolean(value)),
            videoDataUrl,
            model: motionVisionModel,
            question,
            fast: true,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new Error(error.message ?? error.error ?? "Venice vision could not read this frame");
        }
        const body = (await response.json()) as { visual: VisualState };
        if (controller.signal.aborted || phaseRef.current !== "idle" || userSpeakingRef.current) return;
        const nextVisual = body.visual;
        setConnectionError((current) => current.startsWith("Vision ") ? "" : current);
        setVisual(nextVisual);
        setAction(actionFromVisual(nextVisual));

        const signature = visualSignature(nextVisual);
        const previousSignature = lastVisualSignatureRef.current;
        lastVisualSignatureRef.current = signature;
        const reaction = nextVisual.reaction?.trim() ?? "";
        const reactionKey = reaction.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const observationKeys = persistentObservationKeys(nextVisual);
        const now = Date.now();
        const recentlySaidAt = reactionHistoryRef.current.get(reactionKey) ?? 0;
        const changed = Boolean(signature && signature !== previousSignature);
        const salient = Boolean(nextVisual.salient_event?.trim());
        const dynamicEvent = isDynamicVisualEvent(nextVisual);
        const alreadyMentioned = !dynamicEvent && observationKeys.some((key) => visualObservationHistoryRef.current.has(key));

        if (
          proactiveVision
          &&
          reaction
          && salient
          && changed
          && !alreadyMentioned
          && nextVisual.confidence >= 0.58
          && phaseRef.current === "idle"
          && now - lastReactionAtRef.current > 10_000
          && now - recentlySaidAt > 45000
        ) {
          lastReactionAtRef.current = now;
          reactionHistoryRef.current.set(reactionKey, now);
          if (!dynamicEvent && observationKeys.length) {
            for (const observationKey of observationKeys) visualObservationHistoryRef.current.add(observationKey);
            localStorage.setItem("nova-visual-observations", JSON.stringify([...visualObservationHistoryRef.current]));
          }
          const reactionId = createId("reaction");
          setMessages((current) => [...current, {
            id: reactionId,
            role: "assistant",
            text: reaction,
            createdAt: now,
          }]);
          void persistAssistantMessage(reactionId, reaction, now);
          triggerAction(actionFromVisual(nextVisual), 2800);
          // Speak spontaneous observations only during a live voice session; in
          // text mode they land as a written note instead of talking at you.
          if (handsFreeActiveRef.current) queueSpeech(reaction, nextVisual.reaction_delivery ?? "warm", true);
        }
      } catch (error) {
        const message = friendlyVisionError(error);
        if (message) setConnectionError(message);
      } finally {
        if (mirrorRequestAbortRef.current === controller) mirrorRequestAbortRef.current = undefined;
        mirrorBusyRef.current = false;
      }
    };
    const timer = window.setInterval(inspect, settings.talkativeMode ? 4_500 : 8_000);
    return () => {
      window.clearInterval(timer);
      mirrorRequestAbortRef.current?.abort();
      mirrorRequestAbortRef.current = undefined;
      mirrorBusyRef.current = false;
    };
  }, [cameraOn, captureFrame, captureMotionClip, motionVisionModel, persistAssistantMessage, queueSpeech, settings.cameraAwareness, settings.talkativeMode, triggerAction]);

  const transcribeRecording = useCallback(async (blob: Blob, purpose: RecordingPurpose, cachedTranscript = "") => {
    setPhase("transcribing");
    try {
      if (purpose === "conversation" && cachedTranscript.trim()) {
        setLiveTranscript("");
        liveTranscriptLatestRef.current = "";
        lastInterimAtRef.current = 0;
        lastInterimChunkCountRef.current = 0;
        setPhase("idle");
        await sendMessage(cachedTranscript.trim(), { voiceTurn: true });
        return;
      }
      const form = new FormData();
      const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      form.set("file", blob, `nova-recording.${extension}`);
      form.set("model", settings.sttModel);
      form.set("language", settings.language);
      const response = await fetch("/api/transcribe", { method: "POST", body: form });
      const result = (await response.json()) as { text?: string; message?: string; error?: string };
      if (!response.ok) throw new Error(result.message ?? result.error ?? "Transcription failed");
      if (!result.text?.trim()) {
        setLiveTranscript("");
        liveTranscriptLatestRef.current = "";
        if (purpose === "dictation") sendAfterDictationRef.current = false;
        setPhase("idle");
        return;
      }
      setLiveTranscript("");
      liveTranscriptLatestRef.current = "";
      lastInterimAtRef.current = 0;
      lastInterimChunkCountRef.current = 0;
      setPhase("idle");
      if (purpose === "dictation") {
        const transcript = result.text.trim();
        setInput(transcript);
        if (sendAfterDictationRef.current) {
          sendAfterDictationRef.current = false;
          await sendMessage(transcript);
        }
        return;
      }
      await sendMessage(result.text, { voiceTurn: true });
    } catch (error) {
      setLiveTranscript("");
      liveTranscriptLatestRef.current = "";
      const aborted = error instanceof Error && error.name === "AbortError";
      if (!aborted) setConnectionError(error instanceof Error ? error.message : "Transcription failed");
      // Recover to idle rather than freezing on "error" so the hands-free loop
      // keeps listening after a transient transcription hiccup or abort.
      setPhase("idle");
    }
  }, [sendMessage, settings.language, settings.sttModel]);

  const transcribeInterim = useCallback(async (blob: Blob, chunkCount: number) => {
    if (interimTranscriptAbortRef.current || blob.size < 1200) return;
    const controller = new AbortController();
    interimTranscriptAbortRef.current = controller;
    try {
      const form = new FormData();
      const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      form.set("file", blob, `nova-live.${extension}`);
      form.set("model", settings.sttModel);
      form.set("language", settings.language);
      const response = await fetch("/api/transcribe", { method: "POST", body: form, signal: controller.signal });
      const result = (await response.json()) as { text?: string };
      if (response.ok && result.text?.trim() && interimTranscriptAbortRef.current === controller) {
        const transcript = result.text.trim();
        setLiveTranscript(transcript);
        liveTranscriptLatestRef.current = transcript;
        lastInterimAtRef.current = Date.now();
        lastInterimChunkCountRef.current = chunkCount;
        if (recordingPurposeRef.current === "dictation") setInput(transcript);
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        // Interim transcription is best-effort; the final turn still uses the full recording.
      }
    } finally {
      if (interimTranscriptAbortRef.current === controller) interimTranscriptAbortRef.current = undefined;
    }
  }, [settings.language, settings.sttModel]);

  const startRecording = useCallback(async (automatic = false, purpose: RecordingPurpose = "conversation") => {
    if (recorderRef.current?.state === "recording" || isBusy) return;
    try {
      const resumedAfterBargeIn = automatic
        && purpose === "conversation"
        && bargeInCapturePendingRef.current;
      if (resumedAfterBargeIn) bargeInCapturePendingRef.current = false;
      mirrorRequestAbortRef.current?.abort();
      mirrorRequestAbortRef.current = undefined;
      mirrorBusyRef.current = false;
      lastActivityAtRef.current = Date.now();
      setConnectionError("");
      // In a hands-free voice conversation keep one warm microphone stream for
      // the whole session instead of re-acquiring it every turn. This removes
      // the per-turn getUserMedia latency that clipped the first word of
      // follow-ups and lets the browser's echo canceller stay adapted.
      const reuseMic = automatic && purpose === "conversation" && handsFreeActiveRef.current;
      const warmMic = handsFreeMicStreamRef.current;
      let stream: MediaStream;
      if (reuseMic && warmMic?.active) {
        stream = warmMic;
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            autoGainControl: { ideal: true },
            channelCount: { ideal: 1 },
          },
        });
        if (reuseMic) handsFreeMicStreamRef.current = stream;
      }
      recordingStreamRef.current = stream;
      const preferred = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recorderRef.current = recorder;
      recordingPurposeRef.current = purpose;
      chunksRef.current = [];
      setLiveTranscript("");
      liveTranscriptLatestRef.current = "";
      lastInterimAtRef.current = 0;
      lastInterimChunkCountRef.current = 0;
      interimReadyAtRef.current = Date.now() + 650;
      discardRecordingRef.current = false;
      userSpeakingRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        recorderRef.current = undefined;
        stopVoiceActivityDetection();
        const finalChunkCount = chunksRef.current.length;
        const interimAge = Date.now() - lastInterimAtRef.current;
        // The final chunks are normally the silence used to detect end of turn,
        // not additional speech. Reuse the fresh live transcript instead of
        // uploading the same recording for a second transcription pass.
        const reusableInterim = purpose === "conversation"
          && interimAge >= 0
          && interimAge < 1_650
          && finalChunkCount - lastInterimChunkCountRef.current <= 7
          && liveTranscriptLatestRef.current.trim().split(/\s+/).length >= 2
          ? liveTranscriptLatestRef.current.trim()
          : "";
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        // Keep the warm hands-free stream alive between turns; only fully stop a
        // one-off stream (dictation, or a capture that was not reused).
        if (stream !== handsFreeMicStreamRef.current) stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = undefined;
        setRecording(false);
        setDictating(false);
        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          setPhase("idle");
          return;
        }
        void transcribeRecording(blob, purpose, reusableInterim);
      };
      recorder.start(250);
      setRecording(true);
      setDictating(purpose === "dictation");
      setPhase("listening");

      if (automatic || purpose === "dictation") {
        liveTranscriptTimerRef.current = window.setInterval(() => {
          if (Date.now() < interimReadyAtRef.current) return;
          if ((purpose !== "dictation" && !userSpeakingRef.current) || !chunksRef.current.length) return;
          const partial = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          void transcribeInterim(partial, chunksRef.current.length);
        }, 250);
      }

      if (automatic && purpose === "conversation") {
        const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
        if (AudioContextConstructor) {
          const context = new AudioContextConstructor();
          vadContextRef.current = context;
          if (context.state === "suspended") await context.resume();
          const source = context.createMediaStreamSource(stream);
          const analyser = context.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.35;
          source.connect(analyser);
          const waveform = new Uint8Array(analyser.fftSize);
          let noiseFloor = 0.012;
          let speechFrames = 0;
          let speechDetected = false;
          let speechStartedAt = 0;
          let silenceStartedAt = 0;
          const recordingStartedAt = performance.now();

          const monitorVoice = () => {
            if (recorder.state !== "recording") return;
            analyser.getByteTimeDomainData(waveform);
            let squareTotal = 0;
            for (const value of waveform) {
              const centered = (value - 128) / 128;
              squareTotal += centered * centered;
            }
            const rms = Math.sqrt(squareTotal / waveform.length);
            const speechThreshold = Math.max(0.025, noiseFloor * 2.6);
            const silenceThreshold = Math.max(0.018, noiseFloor * 1.65);
            const now = performance.now();

            if (!speechDetected) {
              noiseFloor = Math.min(0.055, noiseFloor * 0.965 + rms * 0.035);
              speechFrames = rms > speechThreshold ? speechFrames + 1 : 0;
              if (speechFrames >= 3) {
                speechDetected = true;
                userSpeakingRef.current = true;
                speechStartedAt = now;
              } else if (resumedAfterBargeIn && now - recordingStartedAt > 1_800) {
                // A confirmed interruption should continue into the fresh
                // capture. If it does not, recover instead of listening for a
                // full minute after a rare false positive.
                discardRecordingRef.current = true;
                recorder.stop();
                return;
              }
            } else if (rms < silenceThreshold) {
              if (!silenceStartedAt) silenceStartedAt = now;
              const utteranceLength = now - speechStartedAt;
              const partial = liveTranscriptLatestRef.current.trim().toLowerCase();
              const trailingConnector = /\b(and|but|so|because|although|though|if|when|while|that|which|or|then|like|with|to|for)$/.test(partial);
              const soundsComplete = partial.split(/\s+/).length >= 4 && /[.!?]$/.test(partial) && !trailingConnector;
              // End-of-turn detection tuned for snappier voice replies. A
              // trailing connector still waits longer (the user is mid-thought);
              // a complete-sounding sentence cuts over fast.
              const pauseWindow = trailingConnector
                ? 1_500
                : soundsComplete && utteranceLength > 1_800
                  ? 520
                  : utteranceLength > 9_000
                    ? 900
                    : 740;
              if (now - silenceStartedAt > pauseWindow) {
                recorder.stop();
                return;
              }
            } else {
              silenceStartedAt = 0;
            }

            if (now - recordingStartedAt > 60000) {
              recorder.stop();
              return;
            }
            vadAnimationRef.current = requestAnimationFrame(monitorVoice);
          };
          monitorVoice();
        }
      }
    } catch (error) {
      stopVoiceActivityDetection();
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = undefined;
      handsFreeMicStreamRef.current?.getTracks().forEach((track) => track.stop());
      handsFreeMicStreamRef.current = undefined;
      recorderRef.current = undefined;
      setRecording(false);
      setDictating(false);
      handsFreeActiveRef.current = false;
      setHandsFreeActive(false);
      setConnectionError(error instanceof Error ? error.message : "Microphone permission was denied");
      setPhase("idle");
    }
  }, [isBusy, stopVoiceActivityDetection, transcribeInterim, transcribeRecording]);

  useEffect(() => {
    handsFreeActiveRef.current = handsFreeActive;
    if (
      !handsFreeActive
      || recording
      || phase !== "idle"
      || recorderRef.current?.state === "recording"
      || speechQueueRunningRef.current
      || Boolean(requestAbortRef.current)
    ) return;
    // Speech has fully drained and the agent turn is complete, so it is safe to
    // reopen the mic. A short settle delay avoids capturing any speaker echo
    // tail before the browser's echo canceller catches up.
    const resumeDelay = bargeInCapturePendingRef.current ? 60 : 320;
    const timer = window.setTimeout(() => void startRecording(true, "conversation"), resumeDelay);
    return () => window.clearTimeout(timer);
  }, [handsFreeActive, phase, recording, startRecording, voiceLoopRevision]);

  const toggleDictation = useCallback(() => {
    if (dictating && recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      return;
    }
    if (isBusy || handsFreeActive) return;
    void startRecording(true, "dictation");
  }, [dictating, handsFreeActive, isBusy, startRecording]);

  const abortCurrent = useCallback(async () => {
    bargeInCapturePendingRef.current = false;
    requestAbortRef.current?.abort();
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    stopVoiceActivityDetection();
    clearSpeechQueue();
    setRecording(false);
    setDictating(false);
    setLiveTranscript("");
    liveTranscriptLatestRef.current = "";
    setToolLabel("");
    setPhase("idle");
    if (!sessionId) return;
    await fetch("/api/agent/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => undefined);
  }, [clearSpeechQueue, sessionId, stopVoiceActivityDetection]);

  // Explicit "stop generating" (like ChatGPT/Cursor): abort the in-flight turn,
  // silence speech, finalize the partial reply, and tell the server to stop.
  const stopGeneration = useCallback(() => {
    bargeInCapturePendingRef.current = false;
    requestAbortRef.current?.abort();
    requestAbortRef.current = undefined;
    clearSpeechQueue();
    setToolLabel("");
    setMessages((current) => current.map((item) => item.streaming
      ? { ...item, text: item.text.trim() || "Stopped.", streaming: false, statusText: undefined }
      : item));
    setPhase("idle");
    if (sessionId) {
      void fetch("/api/agent/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => undefined);
    }
  }, [clearSpeechQueue, sessionId]);

  // Switching or starting a chat stops mic/dictation/speech for the view change
  // WITHOUT cancelling the in-flight agent turn, so it can finish in the background.
  const stopVoiceForSwitch = useCallback(() => {
    bargeInCapturePendingRef.current = false;
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    stopVoiceActivityDetection();
    clearSpeechQueue();
    setRecording(false);
    setDictating(false);
    setLiveTranscript("");
    liveTranscriptLatestRef.current = "";
    setToolLabel("");
  }, [clearSpeechQueue, stopVoiceActivityDetection]);

  const openConversation = useCallback(async (conversationId: string) => {
    // Switching chats no longer cancels the current turn; it keeps running in the
    // background (with a sidebar spinner) so you can start or read another chat.
    stopVoiceForSwitch();
    if (sessionId && !runningTurnsRef.current.has(sessionId)) {
      await fetch("/api/agent/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => undefined);
    }
    const response = await fetch(`/api/workspace?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
    const payload = await response.json() as ConversationPayload & { error?: string };
    if (!response.ok) {
      setConnectionError(payload.error ?? "The conversation could not be opened");
      return;
    }
    const activationResponse = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate_conversation", conversationId }),
    });
    if (!activationResponse.ok) {
      const error = (await activationResponse.json().catch(() => ({}))) as { error?: string };
      setConnectionError(error.error ?? "The conversation could not be activated");
      return;
    }
    applyConversation(payload, workspaceSnapshot);
    // Reflect whether the chat we just opened still has a turn running in the background.
    const backgroundController = runningTurnsRef.current.get(conversationId);
    requestAbortRef.current = backgroundController;
    setPhase(backgroundController ? "thinking" : "idle");
    setWorkspaceOpen(false);
    await refreshWorkspace();
  }, [applyConversation, refreshWorkspace, sessionId, stopVoiceForSwitch, workspaceSnapshot]);

  const startNewConversation = useCallback(async (agentId = activeAgentId) => {
    stopVoiceForSwitch();
    if (sessionId && !runningTurnsRef.current.has(sessionId)) {
      await fetch("/api/agent/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => undefined);
    }
    const targetAgentId = agentId || workspaceSnapshot?.defaultAgentId;
    if (!targetAgentId) return;
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_conversation", agentId: targetAgentId }),
    });
    const payload = await response.json() as ConversationPayload & { error?: string };
    if (!response.ok) {
      setConnectionError(payload.error ?? "A new conversation could not be created");
      return;
    }
    const snapshot = await refreshWorkspace();
    applyConversation(payload, snapshot ?? workspaceSnapshot);
    requestAbortRef.current = undefined;
    setPhase("idle");
    setWorkspaceOpen(false);
  }, [activeAgentId, applyConversation, refreshWorkspace, sessionId, stopVoiceForSwitch, workspaceSnapshot]);

  const deletePastConversation = useCallback(async (conversationId: string) => {
    runningTurnsRef.current.get(conversationId)?.abort();
    clearConversationRunning(conversationId);
    updateMessageQueue((current) => current.filter((item) => item.conversationId !== conversationId));
    if (conversationId === sessionId) await abortCurrent();
    await fetch("/api/agent/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: conversationId }),
    }).catch(() => undefined);
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_conversation", conversationId }),
    });
    const result = await response.json() as { activeConversationId?: string; deletedWasActive?: boolean; error?: string };
    if (!response.ok || !result.activeConversationId) throw new Error(result.error ?? "The conversation could not be deleted");
    const snapshot = await refreshWorkspace();
    if (conversationId !== sessionId) return;
    const nextResponse = await fetch(`/api/workspace?conversationId=${encodeURIComponent(result.activeConversationId)}`, { cache: "no-store" });
    const payload = await nextResponse.json() as ConversationPayload & { error?: string };
    if (!nextResponse.ok) throw new Error(payload.error ?? "The next conversation could not be opened");
    applyConversation(payload, snapshot);
  }, [abortCurrent, applyConversation, clearConversationRunning, refreshWorkspace, sessionId, updateMessageQueue]);

  const toggleHandsFreeSession = useCallback(() => {
    if (handsFreeActive) {
      handsFreeActiveRef.current = false;
      bargeInCapturePendingRef.current = false;
      setHandsFreeActive(false);
      void abortCurrent();
      handsFreeMicStreamRef.current?.getTracks().forEach((track) => track.stop());
      handsFreeMicStreamRef.current = undefined;
      return;
    }
    setConnectionError("");
    setVoiceOn(true);
    clearSpeechQueue();
    handsFreeActiveRef.current = true;
    setHandsFreeActive(true);
    setPhase("idle");
  }, [abortCurrent, clearSpeechQueue, handsFreeActive]);

  const handleCameraControl = useCallback(() => {
    if (cameraOn) {
      void toggleCamera();
      return;
    }
    if (cameraGreetingInFlightRef.current) return;
    cameraGreetingInFlightRef.current = true;
    void toggleCamera().then((started) => {
      if (started) {
        lastVisualSignatureRef.current = "";
        lastActivityAtRef.current = Date.now();
        if (settings.cameraAwareness) void greetCamera();
      } else {
        cameraGreetingInFlightRef.current = false;
      }
    });
  }, [cameraOn, greetCamera, settings.cameraAwareness, toggleCamera]);

  const allowCameraForPendingMessage = useCallback(async () => {
    const pending = cameraPrompt;
    if (!pending) return;
    setCameraPrompt(null);
    const started = cameraOn || await toggleCamera();
    if (started) {
      lastVisualSignatureRef.current = "";
      lastActivityAtRef.current = Date.now();
      // Give the webcam a moment to produce a usable frame before the turn runs.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((videoRef.current?.videoWidth ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await sendMessage(pending.message, { voiceTurn: pending.voiceTurn, skipCameraPrompt: true });
  }, [cameraOn, cameraPrompt, sendMessage, toggleCamera]);

  const sendPendingWithoutCamera = useCallback(async () => {
    const pending = cameraPrompt;
    if (!pending) return;
    setCameraPrompt(null);
    await sendMessage(pending.message, { voiceTurn: pending.voiceTurn, skipCameraPrompt: true });
  }, [cameraPrompt, sendMessage]);

  const enterVoiceMode = useCallback(() => {
    // Start from a clean slate so a lingering reply from the text view cannot
    // bleed into the voice session or block the first listen.
    clearSpeechQueue();
    setVoiceModeOpen(true);
    if (!handsFreeActiveRef.current) toggleHandsFreeSession();
  }, [clearSpeechQueue, toggleHandsFreeSession]);

  const exitVoiceMode = useCallback(() => {
    setVoiceModeOpen(false);
    if (handsFreeActiveRef.current) toggleHandsFreeSession();
  }, [toggleHandsFreeSession]);

  // The camera keeps running in voice mode; mirror its live stream into the
  // voice-mode preview (the header preview is hidden behind the overlay).
  useEffect(() => {
    const video = voiceVideoRef.current;
    if (!video) return;
    if (voiceModeOpen && cameraOn && cameraStreamRef.current) {
      video.srcObject = cameraStreamRef.current;
      void video.play().catch(() => undefined);
    } else {
      video.srcObject = null;
    }
  }, [voiceModeOpen, cameraOn]);

  useEffect(() => {
    if (!voiceModeOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitVoiceMode();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [exitVoiceMode, voiceModeOpen]);

  const previewVoice = useCallback(() => {
    clearSpeechQueue();
    void playSpeech(`Hi, I’m ${agentName}. This is how I sound with the voice you selected.`);
  }, [agentName, clearSpeechQueue, playSpeech]);

  useEffect(() => {
    try {
      setSidebarCollapsed(window.localStorage.getItem("nova.sidebarCollapsed") === "1");
    } catch {
      // Ignore storage access issues (e.g. private browsing).
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem("nova.sidebarCollapsed", next ? "1" : "0");
      } catch {
        // Ignore storage write failures.
      }
      return next;
    });
  }, []);

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      {sidebarCollapsed && (
        <button className="sidebar-reveal" onClick={toggleSidebar} aria-label="Show sidebar" title="Show sidebar">
          <PanelLeftIcon size={17} />
        </button>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><i /><i /><i /></span>
          <div><strong>Gondola</strong></div>
          <button className="sidebar-collapse" onClick={toggleSidebar} aria-label="Hide sidebar" title="Hide sidebar"><PanelLeftIcon size={16} /></button>
        </div>
        <button
          className="sidebar-new-chat"
          onClick={() => void startNewConversation()}
          aria-label="Start a new chat"
          title="Start a new chat"
        >
          <PlusIcon size={15} /><span>New chat</span>
        </button>
        <nav className="topbar-actions" aria-label="Workspace navigation">
          <div className="sidebar-section sidebar-search-section">
            <ConversationSearch
              compact
              agentNames={new Map((workspaceSnapshot?.agents ?? []).map((agent) => [agent.id, agent.name]))}
              onOpen={openConversation}
              onActiveChange={setChatSearchActive}
            />
          </div>
          {FEATURES.agentsTab && (
          <div className="sidebar-section">
            <div className="sidebar-section-head">
              <span className="sidebar-section-label">Agents</span>
              <button className="sidebar-add" onClick={() => { setWorkspaceTab("agents"); setWorkspaceOpen(true); }} aria-label="Create or manage agents" title="Create or manage agents"><PlusIcon size={13} /></button>
            </div>
            <div className="sidebar-list">
              {workspaceSnapshot?.agents.length
                ? workspaceSnapshot.agents.map((agent) => (
                  <button
                    key={agent.id}
                    className={`sidebar-item sidebar-agent ${agent.id === activeAgentId ? "is-active" : ""}`}
                    onClick={() => void startNewConversation(agent.id)}
                    title={`Start a chat with ${agent.name}`}
                  >
                    <span className="sidebar-avatar">{agent.name.charAt(0).toUpperCase()}</span>
                    <span className="sidebar-item-label">{agent.name}</span>
                  </button>
                ))
                : <p className="sidebar-empty">Loading agents…</p>}
            </div>
          </div>
          )}

          <div className="sidebar-section">
            <span className="sidebar-section-label">Chats</span>
            {!chatSearchActive && (
            <div className="sidebar-list">
              {workspaceSnapshot?.conversations.length
                ? workspaceSnapshot.conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className={`sidebar-item sidebar-chat ${conversation.id === sessionId ? "is-active" : ""} ${confirmDeleteChatId === conversation.id ? "is-confirming" : ""}`}
                  >
                    {confirmDeleteChatId === conversation.id ? (
                      <div className="sidebar-chat-confirm" role="group" aria-label={`Delete ${conversation.title || "chat"}?`}>
                        <button
                          type="button"
                          className="sidebar-chat-confirm-delete"
                          onClick={() => { setConfirmDeleteChatId(""); void deletePastConversation(conversation.id); }}
                          autoFocus
                        >
                          <TrashIcon size={13} /> Delete chat
                        </button>
                        <button
                          type="button"
                          className="sidebar-chat-confirm-cancel"
                          onClick={() => setConfirmDeleteChatId("")}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          className="sidebar-chat-open"
                          onClick={() => { setConfirmDeleteChatId(""); void openConversation(conversation.id); }}
                          title={runningConversations.includes(conversation.id) ? `${conversation.title || "New chat"} — still working…` : (conversation.title || "New chat")}
                        >
                          {runningConversations.includes(conversation.id)
                            ? <span className="sidebar-chat-spinner" role="img" aria-label="Still working" />
                            : <ChatIcon size={15} />}
                          <span className="sidebar-item-label">{conversation.title || "New chat"}</span>
                        </button>
                        <button
                          type="button"
                          className="sidebar-chat-delete"
                          onClick={() => setConfirmDeleteChatId(conversation.id)}
                          aria-label={`Delete ${conversation.title || "chat"}`}
                          title="Delete chat"
                        >
                          <TrashIcon size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ))
                : <p className="sidebar-empty">No chats yet</p>}
            </div>
            )}
          </div>

          <div className="sidebar-section sidebar-more-section">
            <span className="sidebar-section-label sidebar-more-label">More</span>
            <div className="sidebar-more-list">
              <button className={`topbar-nav ${workspaceOpen && workspaceTab === "memory" ? "is-active" : ""}`} onClick={() => { setWorkspaceTab("memory"); setWorkspaceOpen(true); }}><MemoryIcon size={16} /><span>Personal memory</span></button>
              <button className={`topbar-nav ${workspaceOpen && workspaceTab === "connections" ? "is-active" : ""}`} onClick={() => { setWorkspaceTab("connections"); setWorkspaceOpen(true); }}><PlugIcon size={15} /><span>Connections</span></button>
              <button className={`topbar-nav ${workspaceOpen && workspaceTab === "automations" ? "is-active" : ""}`} onClick={() => { setWorkspaceTab("automations"); setWorkspaceOpen(true); }}><ClockIcon size={16} /><span>Automations</span></button>
            </div>
          </div>
        </nav>
        <div className="topbar-center">
          <button className="settings-button" onClick={() => setSettingsOpen(true)}><SettingsIcon size={17} /><span>Settings</span></button>
          <div className="sidebar-status">
            <span className="pi-pill">π <span>Pi orchestrated</span></span>
          </div>
        </div>
      </header>

      <div className="workspace chat-only">
        <section className="conversation-panel glass-panel">
          <header className="conversation-header">
            <div className="conversation-header-main">
              <div className="active-agent-heading">
                <span className="active-agent-avatar">{agentInitial}</span>
                <strong>{agentName}</strong>
              </div>
            </div>
            <div className="conversation-header-actions">
              <button className={`api-xray-launcher ${xrayOpen ? "is-active" : ""}`} onClick={() => { setWorkspaceOpen(false); setSettingsOpen(false); setXrayOpen(true); }} aria-label="Live Venice API activity (X-Ray)" title="Live Venice API activity: see every Venice call">
                <PulseIcon size={16} />
                <span className="xray-live" aria-hidden="true" />
              </button>
              <button
                className={`header-camera-button ${cameraOn ? "is-active" : ""}`}
                onClick={handleCameraControl}
                disabled={cameraStarting}
                aria-label={cameraOn ? "Turn off camera" : `Let ${agentName} see you`}
                title={cameraOn ? "Turn off camera" : `Let ${agentName} see you`}
              >
                <CameraIcon size={15} /><span>{cameraStarting ? "Starting…" : cameraOn ? "Camera on" : "Camera"}</span>
              </button>
              <div className={`camera-preview camera-dock ${cameraOn ? "is-visible" : ""} ${cameraPulse ? "is-sending" : ""}`} aria-hidden={!cameraOn}>
                <video ref={videoRef} autoPlay muted playsInline />
                <div className="camera-overlay"><span><i /> LIVE</span><small>{cameraPulse ? "Seeing now" : settings.talkativeMode ? "Talkative" : "Aware"}</small></div>
              </div>
            </div>
          </header>

          <div className={`transcript${isHome ? " is-home" : ""}`} aria-live="polite" ref={transcriptRef}>
            {isHome && (
              <div className="chat-home">
                <span className="chat-home-mark" aria-hidden="true"><i /><i /><i /></span>
                <h1 className="chat-home-title">{homeTitle}</h1>
                <div className="chat-home-grid">
                  {homeSuggestions.map(({ Icon, label, prompt }) => (
                    <button key={label} type="button" className="chat-home-card" onClick={() => void sendMessage(prompt)}>
                      <span className="chat-home-card-icon"><Icon size={16} /></span>
                      <span className="chat-home-card-label">{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!isHome && messages.filter((message) => !isInternalMediaConfirmation(message.text)).map((message) => (
              <article key={message.id} className={`message message-${message.role}${message.queued ? " message-queued" : ""}`}>
                <div className="message-meta">
                  <span className="message-avatar">{message.role === "assistant" ? agentInitial : "YOU"}</span>
                  <span>{message.role === "assistant" ? agentName : "You"}</span>
                  {message.streaming && <span className="typing-dots"><i /><i /><i /></span>}
                </div>
                <div className={!message.text && message.streaming ? "message-status" : undefined}>
                  {message.attachments?.length ? (
                    <div className="message-attachments">
                      {message.attachments.map((attachment, index) => (
                        attachment.kind === "image" && attachment.dataUrl
                          ? (
                            <button
                              type="button"
                              key={index}
                              className="message-attachment-image"
                              onClick={() => setLightbox({ url: attachment.dataUrl as string, kind: "image" })}
                              aria-label={`Preview ${attachment.name}`}
                            >
                              <img src={attachment.dataUrl} alt={attachment.name} />
                              <span>{attachment.name}</span>
                            </button>
                          )
                          : (
                            <span key={index} className="message-attachment-file">
                              <span className="message-attachment-file-icon"><FileTextIcon size={16} /></span>
                              <span className="message-attachment-file-copy">
                                <strong>{attachment.name}</strong>
                                <small>{[attachmentTypeLabel(attachment.name, attachment.kind), attachmentSizeLabel(attachment.size ?? 0)].filter(Boolean).join(" · ")}</small>
                              </span>
                            </span>
                          )
                      ))}
                    </div>
                  ) : null}
                  {message.role === "assistant" && (message.thinking || message.thinkingStreaming) ? (
                    <ThinkingBlock
                      text={message.thinking ?? ""}
                      streaming={Boolean(message.thinkingStreaming)}
                      durationMs={message.thinkingMs}
                    />
                  ) : null}
                  {message.role === "assistant" && message.subagents?.length ? (
                    <div className="subagent-list">
                      {message.subagents.map((run) => <SubAgentCard key={run.id} run={run} />)}
                    </div>
                  ) : null}
                  {message.role === "user" && editingMessageId === message.id ? (
                    <div className="message-edit">
                      <textarea
                        className="message-edit-input"
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitEditMessage(message.id); }
                          if (event.key === "Escape") { event.preventDefault(); cancelEditMessage(); }
                        }}
                        rows={Math.min(8, Math.max(2, editDraft.split("\n").length))}
                        autoFocus
                        aria-label="Edit your message"
                      />
                      <div className="message-edit-actions">
                        <button type="button" className="message-edit-cancel" onClick={cancelEditMessage}>Cancel</button>
                        <button type="button" className="message-edit-save" onClick={() => void submitEditMessage(message.id)} disabled={!editDraft.trim()}>Save and resend</button>
                      </div>
                    </div>
                  ) : (() => {
                    const displayText = stripInlinedAttachments(message.text);
                    if (!displayText && !(message.role === "assistant" && !message.thinkingStreaming)) return null;
                    return <MessageText text={displayText || message.statusText || `${agentName} is thinking…`} />;
                  })()}
                  {message.mediaIds?.length ? (
                    <div className="message-media">
                      {message.mediaIds.map((id) => {
                        const media = artifacts.find((item) => item.id === id);
                        if (!media) return null;
                        if (media.status === "error" && !media.queueId && !media.url) return null;
                        return (
                          <figure className={`chat-media chat-media-${media.kind}`} key={id}>
                            {media.kind === "image" && media.url && (
                              <button type="button" className="chat-media-open" onClick={() => setLightbox({ url: media.url as string, kind: "image" })} aria-label="Expand image">
                                <img src={media.url} alt={media.prompt} />
                              </button>
                            )}
                            {media.kind === "video" && media.url && <video src={media.url} controls playsInline />}
                            {media.kind === "music" && media.url && (
                              <div className="chat-media-audio"><span className="album-orb"><i /><PlayIcon size={18} /></span><audio src={media.url} controls /></div>
                            )}
                            {!media.url && (
                              <div className="chat-media-status">
                                <span className="progress-orb"><i /></span>
                                <strong>{media.status === "quoted"
                                  ? `Create for $${media.quote?.toFixed(2)}`
                                  : media.status === "error"
                                    ? `${media.kind === "video" ? "Video" : media.kind === "music" ? "Music" : "Image"} failed`
                                    : `Creating ${media.kind} · ${media.progress ?? 0}%`}</strong>
                                <small>{media.status === "quoted"
                                  ? "Ready when you are"
                                  : media.status === "error"
                                    ? (media.message ?? "Generation failed")
                                    : (media.message ?? "You can keep chatting while Venice creates it.")}</small>
                                {(media.duration || media.resolution || media.soundtrack) && (
                                  <span className="chat-media-options">
                                    {media.duration && <span>{media.duration}</span>}
                                    {media.resolution && <span>{media.resolution}</span>}
                                    {media.soundtrack && <span>{media.soundtrack === "none" ? "Silent" : media.soundtrack === "music" ? "Music" : "Natural sound"}</span>}
                                  </span>
                                )}
                                {media.status === "quoted" && (
                                  <button disabled={isBusy} onClick={() => {
                                    pendingMediaConfirmationRef.current.set(media.kind, media.id);
                                    setArtifacts((current) => current.map((item) => item.id === media.id ? { ...item, status: "processing", progress: 0, message: "Sending to Venice." } : item));
                                    void sendMessage(
                                      `I confirm the quoted $${media.quote?.toFixed(2)} ${media.kind}. Generate exactly this prompt: ${media.prompt}. `
                                      + `Use duration ${media.duration ?? "5s"}, quality ${media.resolution === "1080p" ? "high" : "standard"}, `
                                      + `and soundtrack ${media.soundtrack ?? "none"}${media.audioDirection ? ` with this audio direction: ${media.audioDirection}` : ""}. Set confirmed=true.`,
                                      { hidden: true, silent: true },
                                    );
                                  }}>Confirm and create</button>
                                )}
                              </div>
                            )}
                            {media.url && (
                              <figcaption>
                                <span>{media.title}</span>
                                <a className="chat-media-download" href={media.url} download={`venice-${media.kind}-${media.id}`} title="Download">↓</a>
                              </figcaption>
                            )}
                          </figure>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                {message.role === "user" && message.queued && (
                  <button
                    type="button"
                    className="queued-message-control"
                    onClick={() => removeQueuedMessage(message.id)}
                    title="Remove from queue"
                    aria-label="Remove queued message"
                  >
                    <span>Queued</span><CloseIcon size={10} />
                  </button>
                )}
                {message.role === "user" && !message.queued && editingMessageId !== message.id && (
                  <button
                    type="button"
                    className="message-edit-button"
                    onClick={() => beginEditMessage(message.id, message.text)}
                    disabled={isBusy}
                    title="Edit and resend"
                    aria-label="Edit message"
                  >
                    <PencilIcon size={12} /><span>Edit</span>
                  </button>
                )}
              </article>
            ))}
            {liveTranscript && ["listening", "transcribing"].includes(phase) && (
              <article className="message message-user message-live">
                <div className="message-meta">
                  <span className="message-avatar">YOU</span>
                  <span>Live transcript</span>
                  <span className="typing-dots"><i /><i /><i /></span>
                </div>
                <div className="message-content"><span className="message-line">{liveTranscript}</span></div>
              </article>
            )}
            {toolLabel && (
              <div className="tool-event"><span className="tool-spinner" /><div><small>PI TOOL CALL</small><strong>{toolLabel}</strong></div></div>
            )}
            <div ref={transcriptEndRef} />
          </div>

          {cameraPrompt && (
            <div className="camera-permission" role="dialog" aria-label="Camera permission request">
              <span className="camera-permission-icon"><CameraIcon size={18} /></span>
              <div className="camera-permission-copy">
                <strong>Let {agentName} see you?</strong>
                <small>To take a look, {agentName} needs to turn on your webcam. Frames are sent to Venice only while the camera is on, and nothing is recorded.</small>
              </div>
              <div className="camera-permission-actions">
                <button className="camera-permission-allow" onClick={() => void allowCameraForPendingMessage()} disabled={cameraStarting}>
                  <CameraIcon size={15} />{cameraStarting ? "Starting…" : "Allow camera"}
                </button>
                <button className="camera-permission-skip" onClick={() => void sendPendingWithoutCamera()}>Ask without camera</button>
              </div>
              <button className="camera-permission-dismiss" onClick={() => setCameraPrompt(null)} aria-label="Dismiss camera request">×</button>
            </div>
          )}

          <form
            className={`composer ${attachmentDropActive ? "is-dropping-files" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (dictating && recorderRef.current?.state === "recording") {
                sendAfterDictationRef.current = true;
                recorderRef.current.stop();
                return;
              }
              void sendMessage(input, { attachments });
            }}
            onDragEnter={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              attachmentDragDepthRef.current += 1;
              setAttachmentDropActive(true);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
              if (attachmentDragDepthRef.current === 0) setAttachmentDropActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              attachmentDragDepthRef.current = 0;
              setAttachmentDropActive(false);
              if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
            }}
          >
            {attachmentDropActive && (
              <div className="composer-drop-zone" aria-hidden="true">
                <span><PaperclipIcon size={18} /></span>
                <strong>Drop files to attach</strong>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="composer-attachments" aria-label={`${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`}>
                {attachments.map((attachment) => (
                  <div className={`composer-chip composer-chip-${attachment.kind}`} key={attachment.id}>
                    {attachment.kind === "image" && attachment.dataUrl
                      ? (
                        <button
                          type="button"
                          className="composer-chip-preview"
                          onClick={() => setLightbox({ url: attachment.dataUrl as string, kind: "image" })}
                          aria-label={`Preview ${attachment.name}`}
                          title={`${attachment.name}${attachmentSizeLabel(attachment.size) ? `, ${attachmentSizeLabel(attachment.size)}` : ""}`}
                        >
                          <img src={attachment.dataUrl} alt="" />
                        </button>
                      )
                      : (
                        <>
                          <span className="composer-chip-icon"><FileTextIcon size={17} /></span>
                          <span className="composer-chip-meta">
                            <span className="composer-chip-name">{attachment.name}</span>
                            <span className="composer-chip-kind">{[attachmentTypeLabel(attachment.name, attachment.kind), attachmentSizeLabel(attachment.size)].filter(Boolean).join(" · ")}</span>
                          </span>
                        </>
                      )}
                    <button type="button" className="composer-chip-remove" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}><CloseIcon size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (dictating && recorderRef.current?.state === "recording") {
                    sendAfterDictationRef.current = true;
                    recorderRef.current.stop();
                    return;
                  }
                  void sendMessage(input, { attachments });
                }
              }}
              placeholder={`Message ${agentName}…`}
              rows={1}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept="image/*,text/*,.md,.markdown,.json,.jsonl,.csv,.tsv,.log,.yml,.yaml,.xml,.html,.css,.scss,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.swift,.sh,.sql,.toml,.ini"
              onChange={(event) => {
                if (event.target.files?.length) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <button
                  type="button"
                  className="composer-attach-button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach images or files"
                  title="Attach images or files"
                >
                  <PaperclipIcon size={17} />
                </button>
                <button
                  type="button"
                  className={`dictation-button ${dictating ? "is-recording" : ""}`}
                  onClick={toggleDictation}
                  disabled={(isBusy && !dictating) || handsFreeActive}
                  aria-label={dictating ? "Stop dictation" : "Dictate a message"}
                  title={dictating ? "Stop dictation" : "Dictate with Venice"}
                >
                  {dictating ? <StopIcon size={15} /> : <MicIcon size={16} />}
                </button>
                <ModelPicker
                  models={models}
                  value={settings.chatModel}
                  onChange={changeChatModel}
                  variant="composer"
                  reasoningEffort={settings.reasoningEffort}
                  onReasoningEffortChange={changeReasoningEffort}
                  disabled={generating}
                />
              </div>
              <div className="composer-actions">
                <button type="button" className="composer-voice-button" onClick={enterVoiceMode} aria-label="Open full-screen hands-free voice mode" title="Start hands-free voice mode">
                  <span className="voice-wave-icon" aria-hidden="true"><i /><i /><i /><i /></span>
                </button>
                {generating ? (
                  <>
                    <button
                      type="submit"
                      className="composer-queue-button"
                      disabled={!input.trim() && attachments.length === 0}
                      aria-label="Queue message"
                      title="Queue message"
                    ><SendIcon size={16} /></button>
                    <button type="button" className="composer-stop-button" onClick={stopGeneration} aria-label="Stop generating" title="Stop generating">
                      <StopIcon size={15} />
                    </button>
                  </>
                ) : (
                  <button type="submit" disabled={dictating ? false : (!input.trim() && attachments.length === 0)} aria-label={dictating ? "Finish dictation and send" : "Send message"}><SendIcon size={17} /></button>
                )}
              </div>
            </div>
          </form>
          <a className="powered-venice" href="https://venice.ai" target="_blank" rel="noreferrer" title="Powered by Venice">
            <span>Powered by</span>
            <img src="/venice-wordmark.svg" alt="Venice" />
          </a>
        </section>

      </div>

      {voiceModeOpen && (
        <section className={`immersive-voice phase-${phase}`} role="dialog" aria-modal="true" aria-label={`${agentName} in Gondola Voice`}>
          <div className="stage-grid" />
          <button className="immersive-close" onClick={exitVoiceMode} aria-label="Close Gondola Voice and return to chat" title="Return to chat">
            <span aria-hidden="true">×</span>
          </button>
          <button
            className={`immersive-camera-toggle ${cameraOn ? "is-active" : ""}`}
            onClick={handleCameraControl}
            disabled={cameraStarting}
            aria-label={cameraOn ? "Turn off camera" : "Let the agent see you"}
            title={cameraOn ? "Turn off camera" : "Let the agent see you"}
          >
            <CameraIcon size={17} />
          </button>
          <div className="immersive-wordmark"><i />GONDOLA VOICE</div>

          {cameraOn && (
            <div className={`immersive-camera-preview ${cameraPulse ? "is-sending" : ""}`}>
              <video ref={voiceVideoRef} autoPlay muted playsInline />
              <span className="immersive-camera-tag"><i />{cameraPulse ? "Seeing" : "Live"}</span>
            </div>
          )}

          <div className="immersive-presence">
            <AgentPresence name={agentName} phase={phase} action={action} visual={visual} audioLevel={audioLevel} directive={presenceDirective} viseme={viseme} />
            <div className="immersive-status" aria-live="polite">
              {(() => {
                const status = recording
                  ? { title: "Listening", detail: liveTranscript ? `“${liveTranscript}”` : "Go ahead, I’m listening to you." }
                  : phase === "transcribing"
                    ? { title: "Got that", detail: "Making sense of what you said…" }
                    : phase === "tool"
                      ? { title: toolLabel || "Working on it", detail: "Hang tight, I’m pulling together what I need." }
                      : phase === "speaking"
                        ? { title: "Speaking", detail: spokenText ? `“${spokenText}”` : "Here’s what I found." }
                        : phase === "thinking"
                          ? { title: "Thinking", detail: "Putting your answer together…" }
                          : { title: "Listening", detail: "I’m all ears. Just start talking any time." };
                return (
                  <>
                    <span className={`immersive-live ${recording ? "is-listening" : ""}`}><i />{status.title}</span>
                    {status.detail && <p className="immersive-detail">{status.detail}</p>}
                  </>
                );
              })()}
            </div>
          </div>

          <div className="immersive-footer"><MicIcon size={15} /><span>Hands-free listening stays on until you close Gondola Voice</span></div>
        </section>
      )}

      <ApiXray open={xrayOpen} onClose={() => setXrayOpen(false)} models={models} />

      {lightbox && (
        <button className="media-lightbox" onClick={() => setLightbox(null)} aria-label="Close preview">
          {lightbox.kind === "image"
            ? <img src={lightbox.url} alt="Generated media" onClick={(event) => event.stopPropagation()} />
            : <video src={lightbox.url} controls autoPlay playsInline onClick={(event) => event.stopPropagation()} />}
          <span className="media-lightbox-close" aria-hidden="true">×</span>
        </button>
      )}

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
        models={models}
        connected={connected}
        onPreviewVoice={previewVoice}
      />
      <WorkspaceDrawer
        open={workspaceOpen}
        tab={workspaceTab}
        snapshot={workspaceSnapshot}
        activeAgentId={activeAgentId}
        activeConversationId={sessionId}
        onClose={() => setWorkspaceOpen(false)}
        onTabChange={setWorkspaceTab}
        onRefresh={refreshWorkspace}
        onStartChat={startNewConversation}
        onOpenConversation={openConversation}
        onDeleteConversation={deletePastConversation}
      />
    </main>
  );
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

// First-run gate. The workspace (and its heavy camera/audio/session hooks) only
// mounts once setup is verified "ready"; otherwise the onboarding wizard runs.
function OnboardingGate() {
  const [status, setStatus] = useState<SetupStatusView | undefined>(undefined);
  const [checked, setChecked] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/setup/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: SetupStatusView) => {
        if (cancelled) return;
        setStatus(body);
        setReady(body.state === "ready");
      })
      .catch(() => { if (!cancelled) setStatus(undefined); })
      .finally(() => { if (!cancelled) setChecked(true); });
    return () => { cancelled = true; };
  }, []);

  if (!checked) {
    return (
      <div className="onb-splash" aria-busy="true">
        <span className="onb-splash-mark">Gondola</span>
      </div>
    );
  }
  if (!ready) {
    return <Onboarding initialStatus={status} onReady={() => setReady(true)} />;
  }
  return <Workspace />;
}

export default function Home() {
  return <OnboardingGate />;
}
