export type AgentPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "tool"
  | "speaking"
  | "error";

export type MouthViseme = "rest" | "small" | "open" | "round" | "wide";

export type AvatarAction =
  | "neutral"
  | "smile"
  | "laugh"
  | "surprised"
  | "frown"
  | "wink"
  | "nod"
  | "shake"
  | "look_left"
  | "look_right"
  | "tilt"
  | "bounce";

export interface PresenceDirective {
  form: "tall" | "orb" | "wide" | "ribbon" | "crystal";
  motion: "breathe" | "drift" | "pulse" | "ripple" | "orbit" | "sway" | "still";
  palette: "porcelain" | "ice" | "violet" | "amber" | "rose" | "aqua";
  direction: "center" | "left" | "right";
  intensity: number;
}

export const DEFAULT_PRESENCE: PresenceDirective = {
  form: "tall",
  motion: "breathe",
  palette: "porcelain",
  direction: "center",
  intensity: 0.45,
};

export interface AgentSettings {
  cameraAwareness: boolean;
  talkativeMode: boolean;
  chatModel: string;
  visionModel: string;
  ttsModel: string;
  voice: string;
  sttModel: string;
  imageModel: string;
  videoModel: string;
  musicModel: string;
  language: string;
  speed: number;
  emotionalDelivery: boolean;
  maxMediaUsd: number;
  webSearch: boolean;
  fileAccess: boolean;
  shellAccess: boolean;
  reasoningEffort: ReasoningEffort;
  chatModelSupportsReasoning: boolean;
  chatModelSupportsReasoningEffort: boolean;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Speed is the hard constraint for live voice and camera turns. Normal text
// turns can afford the still-fast frontier model, while realtime work stays on
// the quickest high-quality multimodal model measured against Venice.
export const SMART_FAST_CHAT_MODEL = "zai-org-glm-5-2";
export const REALTIME_MULTIMODAL_MODEL = "qwen3-6-27b";
export const REALTIME_MULTIMODAL_FALLBACK = "qwen3-5-35b-a3b";

export const DEFAULT_SETTINGS: AgentSettings = {
  cameraAwareness: true,
  talkativeMode: false,
  chatModel: SMART_FAST_CHAT_MODEL,
  visionModel: REALTIME_MULTIMODAL_MODEL,
  ttsModel: "tts-xai-v1",
  voice: "rex",
  sttModel: "stt-xai-v1",
  imageModel: "z-image-turbo",
  videoModel: "wan-2-7-text-to-video",
  musicModel: "ace-step-15",
  language: "en",
  speed: 1.05,
  emotionalDelivery: true,
  maxMediaUsd: 0.5,
  webSearch: true,
  fileAccess: true,
  shellAccess: true,
  reasoningEffort: "medium",
  chatModelSupportsReasoning: false,
  chatModelSupportsReasoningEffort: false,
};

export interface VisualState {
  face_present: boolean;
  expression: {
    smile: number;
    mouth_open: number;
    eyes_closed: number;
    brows_raised: number;
  };
  head: {
    direction: "left" | "center" | "right";
    tilt: "left" | "center" | "right";
  };
  hand_gesture: string;
  visible_objects: string[];
  activity: string;
  salient_event: string;
  reaction: string;
  reaction_delivery: "warm" | "playful" | "surprised" | "curious" | "gentle";
  confidence: number;
  description: string;
}

export type MediaKind = "image" | "video" | "music";

export interface MediaArtifact {
  id: string;
  kind: MediaKind;
  title: string;
  prompt: string;
  status: "ready" | "quoted" | "queued" | "processing" | "error";
  url?: string;
  model?: string;
  queueId?: string;
  downloadUrl?: string;
  quote?: number;
  progress?: number;
  message?: string;
  duration?: string;
  resolution?: string;
  soundtrack?: "none" | "natural" | "music";
  audioDirection?: string;
  taskId?: string;
  assetId?: string;
}

export interface CatalogModel {
  id: string;
  type: string;
  name: string;
  beta?: boolean;
  privacy?: string;
  voices?: string[];
  defaultVoice?: string;
  capabilities?: Record<string, boolean | number | string | string[]>;
  constraints?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  traits?: string[];
}

export interface WorkspaceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  skillIds: string[];
  mcpServerIds: string[];
  /**
   * When true, this agent only sees its own private memory and ignores the
   * shared personal memory that regular chats use. Defaults to false so an
   * agent still knows who you are unless you deliberately isolate it.
   */
  memoryIsolated?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  agentId: string;
  title: string;
  lastMessage: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  filePath: string;
}

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}

export interface McpServerSummary {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headerKeys: string[];
  envKeys: string[];
  tools: McpToolSummary[];
  instructions?: string;
  status: "connected" | "error" | "untested" | "needs_auth";
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  agents: AgentProfile[];
  conversations: ConversationSummary[];
  skills: SkillSummary[];
  mcpServers: McpServerSummary[];
  defaultAgentId: string;
  activeConversationId: string;
}

export type MemoryKind = "bio" | "preference" | "important" | "project" | "relationship" | "environment" | "agent" | "other";
export type MemoryStatus = "active" | "pending" | "archived";
export type MemorySourceType = "manual" | "explicit" | "automatic" | "agent" | "migration";

export interface PersonalMemoryEntry {
  id: string;
  /**
   * Memory scope. When absent, the entry is shared "personal memory" used by
   * regular chats and (by default) by every agent. When set to an agent id,
   * the entry is private to that agent, which is the core of an isolated agent.
   */
  agentId?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  pinned: boolean;
  status: MemoryStatus;
  tags: string[];
  source: {
    type: MemorySourceType;
    conversationId?: string;
    excerpt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MemorySettings {
  enabled: boolean;
  autoCapture: boolean;
  requireApproval: boolean;
}

export interface MemorySnapshot {
  entries: PersonalMemoryEntry[];
  settings: MemorySettings;
  stats: {
    active: number;
    pending: number;
    pinned: number;
    archived: number;
    bio: number;
    important: number;
  };
}

// ── Connections (channels + integrations) ────────────────────────────────────
// A connection lets an agent reach the outside world the way the Pi Agent does:
// messaging channels (Telegram) it can be reached on, and service integrations
// (Gmail, Calendar, Slack…) it can act through. Service integrations are backed
// by MCP servers so they are real, not mocked.

export interface TelegramChannelSummary {
  enabled: boolean;
  running: boolean;
  hasToken: boolean;
  botUsername?: string;
  allowedChatIds: string[];
  agentId: string;
}

export interface ChannelsSnapshot {
  telegram: TelegramChannelSummary;
}

/** A curated one-click MCP integration the user can connect from the UI. */
export interface IntegrationTemplate {
  id: string;
  name: string;
  category: "productivity" | "communication" | "developer" | "knowledge" | "custom";
  blurb: string;
  /** Emoji/text glyph shown on the card. */
  glyph: string;
  transport: "http" | "stdio";
  /** Prefilled command for stdio integrations (e.g. an npx MCP server). */
  command?: string;
  args?: string[];
  /** Prefilled endpoint for remote (http) integrations. */
  url?: string;
  /** Human hints for the secrets the user must supply, keyed by env/header name. */
  secretHints?: Array<{ key: string; label: string; placeholder?: string }>;
  /** Where to get credentials / read setup docs. */
  docsUrl?: string;
}
