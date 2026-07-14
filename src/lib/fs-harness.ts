import { access, copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Sandboxed filesystem + shell harness. Every operation is confined to a single
// root (the home folder by default, overridable with VENICE_AGENT_ROOT). The
// design mirrors a coding agent's tools, but with hard guardrails so an autonomous
// model can't wander outside the root, touch secrets, or destroy data:
//   - path confinement: `..` escapes and paths resolving outside the root are rejected;
//   - a denylist for credentials/keys (.ssh, keychains, .env, *.pem, …);
//   - size caps and binary-file guards on text reads/writes;
//   - atomic writes (temp + rename);
//   - a recoverable safety net: overwrites/edits keep a timestamped backup, and
//     deletes move to a local .venice-trash instead of vanishing.
// Confirmation for destructive/shell actions is enforced one layer up (the agent
// tools), so this module stays a clean, testable primitive.

const MAX_READ_BYTES = 256 * 1_024;
const MAX_WRITE_BYTES = 1_024 * 1_024;
const MAX_LIST_ENTRIES = 500;
const MAX_COMMAND_OUTPUT = 100 * 1_024;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_TIMEOUT_MS = 300_000;

const TRASH_DIR = ".venice-trash";
const BACKUP_DIR = ".venice-backups";

// Directory names anywhere in the path that are always off-limits.
const DENY_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".gsutil", ".azure", ".password-store"]);
// Exact filenames that are always off-limits.
const DENY_NAMES = new Set([".netrc", ".git-credentials", ".npmrc", ".pypirc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials"]);
// Extensions that look like keys/certificates.
const DENY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keychain", ".keychain-db", ".asc", ".gpg"]);
// Shell patterns that are catastrophic regardless of confirmation.
const COMMAND_DENYLIST: RegExp[] = [
  /\bsudo\b/,
  /(^|\s)su\s/,
  /rm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|$|\*)/,
  /:\s*\(\s*\)\s*\{/,
  /\bmkfs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  />\s*\/dev\/(?:sd|disk|nvme|hd)/,
  /\bchmod\b\s+-R\s+0*777\s+\//,
];

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "other";
  size?: number;
}

export function harnessRoot(): string {
  const override = process.env.VENICE_AGENT_ROOT?.trim();
  return override ? path.resolve(override) : os.homedir();
}

function expandHome(input: string): string {
  const value = String(input ?? "").trim();
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Resolve a user/model-supplied path to an absolute path inside the root, or throw. */
export function resolveInRoot(input: string): string {
  const root = harnessRoot();
  const absolute = path.resolve(root, expandHome(input));
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`"${input}" is outside the allowed root (${root}).`);
  }
  assertNotProtected(absolute, root);
  return absolute;
}

function assertNotProtected(absolute: string, root: string): void {
  const name = path.basename(absolute);
  const extension = path.extname(name).toLowerCase();
  const segments = path.relative(root, absolute).split(path.sep);
  if (segments.some((segment) => DENY_DIRS.has(segment))) {
    throw new Error("That location is protected (it holds credentials or keys).");
  }
  if (segments.includes(TRASH_DIR) || segments.includes(BACKUP_DIR)) {
    throw new Error("The harness backup/trash folders are managed automatically and can't be edited directly.");
  }
  if (name.startsWith(".env")) throw new Error("Environment files are protected.");
  if (DENY_NAMES.has(name)) throw new Error("That file is protected (it looks like a secret).");
  if (DENY_EXTENSIONS.has(extension)) throw new Error("That file type is protected (key or certificate).");
  if (/(^|\/)Library\/Keychains(\/|$)/.test(absolute)) throw new Error("Keychains are protected.");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_000).includes(0);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function atomicWrite(absolute: string, text: string): Promise<void> {
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, absolute);
}

// Copy a file into the timestamped backups folder before it's overwritten/edited.
async function backupFile(absolute: string): Promise<string> {
  const root = harnessRoot();
  const destination = path.join(root, BACKUP_DIR, timestamp(), path.relative(root, absolute));
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(absolute, destination);
  return destination;
}

// Move a path (file or directory) into the timestamped trash instead of deleting.
async function moveToTrash(absolute: string): Promise<string> {
  const root = harnessRoot();
  const destination = path.join(root, TRASH_DIR, timestamp(), path.relative(root, absolute));
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(absolute, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      await cp(absolute, destination, { recursive: true });
      await rm(absolute, { recursive: true, force: true });
    } else {
      throw error;
    }
  }
  return destination;
}

export async function readTextFile(input: string): Promise<{ path: string; content: string; bytes: number; truncated: boolean }> {
  const absolute = resolveInRoot(input);
  const info = await stat(absolute);
  if (info.isDirectory()) throw new Error("That path is a directory. Use list_directory instead.");
  const buffer = await readFile(absolute);
  if (isBinary(buffer)) throw new Error("That file looks binary, so it can't be shown as text.");
  const truncated = buffer.length > MAX_READ_BYTES;
  return {
    path: absolute,
    content: buffer.subarray(0, MAX_READ_BYTES).toString("utf8"),
    bytes: buffer.length,
    truncated,
  };
}

export async function listDirectory(input: string): Promise<{ path: string; entries: DirEntry[]; truncated: boolean }> {
  const absolute = resolveInRoot(input || ".");
  const dirents = await readdir(absolute, { withFileTypes: true });
  const visible = dirents.filter((dirent) => dirent.name !== TRASH_DIR && dirent.name !== BACKUP_DIR);
  const truncated = visible.length > MAX_LIST_ENTRIES;
  const entries = await Promise.all(visible.slice(0, MAX_LIST_ENTRIES).map(async (dirent): Promise<DirEntry> => {
    const type = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
    let size: number | undefined;
    if (type === "file") {
      try {
        size = (await stat(path.join(absolute, dirent.name))).size;
      } catch {
        size = undefined;
      }
    }
    return { name: dirent.name, type, size };
  }));
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: absolute, entries, truncated };
}

export async function makeDirectory(input: string): Promise<{ path: string }> {
  const absolute = resolveInRoot(input);
  await mkdir(absolute, { recursive: true });
  return { path: absolute };
}

export async function writeTextFile(input: string, content: string, overwrite = false): Promise<{ path: string; bytes: number; existed: boolean; backup?: string }> {
  const absolute = resolveInRoot(input);
  const text = content ?? "";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`Content is too large to write (${Math.round(bytes / 1_024)} KB; the limit is ${MAX_WRITE_BYTES / 1_024} KB).`);
  }
  const existed = await exists(absolute);
  let backup: string | undefined;
  if (existed) {
    const info = await stat(absolute);
    if (info.isDirectory()) throw new Error("That path is a directory, not a file.");
    if (!overwrite) throw new Error(`"${path.relative(harnessRoot(), absolute)}" already exists. Set overwrite:true to replace it (a backup is kept).`);
    backup = await backupFile(absolute);
  }
  await atomicWrite(absolute, text);
  return { path: absolute, bytes, existed, backup };
}

export async function editTextFile(
  input: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<{ path: string; replacements: number; backup: string }> {
  const absolute = resolveInRoot(input);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("That path is not a file.");
  const buffer = await readFile(absolute);
  if (isBinary(buffer)) throw new Error("That file looks binary, so it can't be edited as text.");
  const original = buffer.toString("utf8");
  if (oldString === newString) throw new Error("old_string and new_string are identical.");
  const occurrences = oldString ? original.split(oldString).length - 1 : 0;
  if (occurrences === 0) throw new Error("old_string was not found in the file.");
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`old_string matches ${occurrences} places. Add surrounding context to make it unique, or set replace_all:true.`);
  }
  const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
  const backup = await backupFile(absolute);
  await atomicWrite(absolute, updated);
  return { path: absolute, replacements: replaceAll ? occurrences : 1, backup };
}

export async function movePath(from: string, to: string, overwrite = false): Promise<{ from: string; to: string; backup?: string }> {
  const source = resolveInRoot(from);
  const destination = resolveInRoot(to);
  if (!(await exists(source))) throw new Error("The source path does not exist.");
  let backup: string | undefined;
  if (await exists(destination)) {
    if (!overwrite) throw new Error(`"${path.relative(harnessRoot(), destination)}" already exists. Set overwrite:true to replace it (a backup is kept).`);
    backup = await moveToTrash(destination);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      await cp(source, destination, { recursive: true });
      await rm(source, { recursive: true, force: true });
    } else {
      throw error;
    }
  }
  return { from: source, to: destination, backup };
}

export async function trashPath(input: string): Promise<{ path: string; trashed: string }> {
  const absolute = resolveInRoot(input);
  if (!(await exists(absolute))) throw new Error("That path does not exist.");
  const trashed = await moveToTrash(absolute);
  return { path: absolute, trashed };
}

export async function pathInfo(input: string): Promise<{ path: string; exists: boolean; type?: "file" | "dir" | "other"; size?: number }> {
  const absolute = resolveInRoot(input);
  try {
    const info = await stat(absolute);
    return { path: absolute, exists: true, type: info.isDirectory() ? "dir" : info.isFile() ? "file" : "other", size: info.isFile() ? info.size : undefined };
  } catch {
    return { path: absolute, exists: false };
  }
}

function assertCommandAllowed(command: string): void {
  for (const pattern of COMMAND_DENYLIST) {
    if (pattern.test(command)) throw new Error("That command is blocked for safety (privilege escalation or destructive disk operation).");
  }
}

export async function runCommand(
  command: string,
  cwdInput?: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<{ command: string; cwd: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) throw new Error("The command is empty.");
  assertCommandAllowed(trimmed);
  const cwd = cwdInput ? resolveInRoot(cwdInput) : harnessRoot();
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error("The working directory does not exist.");
  const limit = Math.min(Math.max(1_000, timeoutMs), MAX_COMMAND_TIMEOUT_MS);

  return new Promise((resolve) => {
    const child = spawn(trimmed, { cwd, shell: true, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_COMMAND_OUTPUT ? current : (current + chunk.toString("utf8")).slice(0, MAX_COMMAND_OUTPUT);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, limit);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command: trimmed, cwd, exitCode: null, stdout, stderr: stderr || String(error), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command: trimmed, cwd, exitCode: code, stdout, stderr, timedOut });
    });
  });
}
