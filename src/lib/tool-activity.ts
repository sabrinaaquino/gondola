import type { ToolRisk } from "./approval-store";

export type ToolActivityCategory = "files" | "system" | "research" | "memory" | "media" | "planning" | "lab" | "coordination" | "runtime" | "other";

export interface ToolActivityDescription {
  label: string;
  detail: string;
  category: ToolActivityCategory;
  risk?: ToolRisk;
  mutates: boolean;
}

const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization|cookie)/i;

function clean(value: unknown, fallback = "the requested item"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 160);
}

/** Safe args for user-visible activity. Secret-looking fields are never echoed. */
export function redactToolArgs(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => redactToolArgs(entry, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 240) : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => (
    [key, SECRET_KEY.test(key) ? "[redacted]" : redactToolArgs(entry, depth + 1)]
  )));
}

export function describeToolActivity(name: string, rawArgs?: unknown): ToolActivityDescription {
  const args = redactToolArgs(rawArgs) as Record<string, unknown> | undefined;
  const path = clean(args?.path, "the selected path");
  const command = clean(args?.command, "the requested command");
  switch (name) {
    case "read_file": return { label: "Reading a file", detail: path, category: "files", mutates: false };
    case "list_directory": return { label: "Inspecting a folder", detail: path, category: "files", mutates: false };
    case "create_directory": return { label: "Creating a folder", detail: path, category: "files", risk: "low", mutates: true };
    case "write_file": return { label: args?.overwrite ? "Replacing a file" : "Writing a file", detail: path, category: "files", risk: "medium", mutates: true };
    case "edit_file": return { label: "Editing a file", detail: path, category: "files", risk: "medium", mutates: true };
    case "move_path": return { label: "Moving or renaming", detail: `${clean(args?.from, "source")} to ${clean(args?.to, "destination")}`, category: "files", risk: "medium", mutates: true };
    case "delete_path": return { label: "Moving to trash", detail: path, category: "files", risk: "high", mutates: true };
    case "run_command": return { label: "Running a command", detail: command, category: "system", risk: "high", mutates: true };
    case "search_web": return { label: "Searching the live web", detail: clean(args?.query, "Finding current sources"), category: "research", mutates: false };
    case "inspect_camera": return { label: "Inspecting the camera frame", detail: "Looking at the latest shared frame", category: "research", mutates: false };
    case "memory": return { label: "Updating memory", detail: "Saving user-authorized context", category: "memory", mutates: true };
    case "search_memory": return { label: "Searching memory", detail: clean(args?.query, "Looking for relevant context"), category: "memory", mutates: false };
    case "session_search": return { label: "Searching past conversations", detail: clean(args?.query, "Looking for earlier context"), category: "memory", mutates: false };
    case "generate_image": return { label: "Generating an image", detail: clean(args?.prompt, "Creating with Venice"), category: "media", mutates: false };
    case "generate_video": return { label: "Generating a video", detail: clean(args?.prompt, "Creating with Venice"), category: "media", mutates: false };
    case "generate_music": return { label: "Generating music", detail: clean(args?.prompt, "Composing with Venice"), category: "media", mutates: false };
    case "media_task_list": return { label: "Checking media jobs", detail: "Reading queued and completed work", category: "media", mutates: false };
    case "media_task_await": return { label: "Waiting for media", detail: "Tracking the queued Venice job", category: "media", mutates: false };
    case "set_plan": return { label: "Planning the task", detail: clean(args?.goal, "Breaking the work into steps"), category: "planning", mutates: false };
    case "update_step": return { label: "Updating task progress", detail: clean(args?.title ?? args?.step_id, "Recording the current step"), category: "planning", mutates: false };
    case "checkpoint": return { label: "Saving a checkpoint", detail: clean(args?.label, "Preserving completed progress"), category: "planning", mutates: false };
    case "propose_harness_change": return { label: "Consulting Gondola Lab", detail: clean(args?.reason, "Reviewing a recurring operating pattern"), category: "lab", mutates: false };
    case "delegate_task": return { label: "Delegating focused work", detail: clean(args?.task, "Running a scoped worker"), category: "coordination", mutates: false };
    case "runtime_status": return { label: "Reading runtime state", detail: clean(args?.section, "Checking current capabilities and work"), category: "runtime", mutates: false };
    case "runtime_explain": return { label: "Explaining runtime state", detail: "Building an authoritative status summary", category: "runtime", mutates: false };
    case "venice_reference": return { label: "Checking Venice documentation", detail: clean(args?.topic, "Looking up supported parameters"), category: "research", mutates: false };
    case "venice_api": {
      const method = clean(args?.method, "GET").toUpperCase();
      const endpoint = clean(args?.path, "API endpoint");
      const guarded = method === "DELETE" || (method !== "GET" && method !== "HEAD" && /^\/?(?:api_keys|x402)\b/.test(endpoint));
      return { label: "Calling Venice", detail: `${method} ${endpoint}`, category: "system", risk: guarded ? "high" : undefined, mutates: method !== "GET" && method !== "HEAD" };
    }
    default: return {
      label: name.startsWith("mcp_") ? name.slice(4).split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") : name.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
      detail: name.startsWith("mcp_") ? `Calling connected tool ${name}` : "Working with the requested capability",
      category: name.startsWith("mcp_") ? "coordination" : "other",
      mutates: false,
    };
  }
}
