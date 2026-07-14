import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// Persistent OAuth client provider for remote MCP servers.
//
// This is what makes "click Connect and log in with your browser" work instead
// of pasting bearer tokens. The MCP SDK drives the OAuth 2.1 + PKCE flow (with
// dynamic client registration) and calls into this provider to persist the
// client registration, PKCE verifier, and tokens, and to hand us the
// authorization URL the user must visit. Everything is stored locally under
// .gondola/mcp-oauth/<serverId>.json and refreshed automatically by the SDK.

const OAUTH_DIR = path.join(process.cwd(), ".gondola", "mcp-oauth");

interface OAuthRecord {
  serverId: string;
  redirectBase: string;
  state?: string;
  authorizationUrl?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function recordPath(serverId: string): string {
  return path.join(OAUTH_DIR, `${safeId(serverId)}.json`);
}

// Serialize writes per server so concurrent provider callbacks don't clobber
// the record mid-flow.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(serverId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  locks.set(serverId, result.then(() => undefined, () => undefined));
  return result;
}

async function readRecord(serverId: string): Promise<OAuthRecord | undefined> {
  try {
    return JSON.parse(await readFile(recordPath(serverId), "utf8")) as OAuthRecord;
  } catch {
    return undefined;
  }
}

async function writeRecord(serverId: string, patch: Partial<OAuthRecord>): Promise<OAuthRecord> {
  return withLock(serverId, async () => {
    await mkdir(OAUTH_DIR, { recursive: true });
    const current = (await readRecord(serverId)) ?? { serverId, redirectBase: patch.redirectBase ?? "" };
    const next: OAuthRecord = { ...current, ...patch, serverId };
    const target = recordPath(serverId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    return next;
  });
}

export async function hasOAuthTokens(serverId: string): Promise<boolean> {
  return Boolean((await readRecord(serverId))?.tokens?.access_token);
}

export async function clearOAuth(serverId: string): Promise<void> {
  await unlink(recordPath(serverId)).catch(() => undefined);
}

// Resolve which server an OAuth callback belongs to using the `state` param.
export async function findServerIdByState(state: string): Promise<string | undefined> {
  const files = await readdir(OAUTH_DIR).catch(() => [] as string[]);
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const record = JSON.parse(await readFile(path.join(OAUTH_DIR, file), "utf8")) as OAuthRecord;
      if (record.state && record.state === state) return record.serverId;
    } catch {
      // Ignore an unreadable record.
    }
  }
  return undefined;
}

export class FileOAuthProvider implements OAuthClientProvider {
  private captured?: string;

  constructor(private readonly serverId: string, private readonly redirectBase: string) {}

  get redirectUrl(): string {
    return `${this.redirectBase.replace(/\/$/, "")}/api/mcp/oauth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Venice Agent",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** The authorization URL captured during the most recent connect attempt. */
  capturedAuthorizationUrl(): string | undefined {
    return this.captured;
  }

  async state(): Promise<string> {
    const value = crypto.randomUUID();
    await writeRecord(this.serverId, { redirectBase: this.redirectBase, state: value });
    return value;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await readRecord(this.serverId))?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await writeRecord(this.serverId, { redirectBase: this.redirectBase, clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await readRecord(this.serverId))?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await writeRecord(this.serverId, { redirectBase: this.redirectBase, tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.captured = authorizationUrl.toString();
    await writeRecord(this.serverId, { redirectBase: this.redirectBase, authorizationUrl: this.captured });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await writeRecord(this.serverId, { redirectBase: this.redirectBase, codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await readRecord(this.serverId))?.codeVerifier;
    if (!verifier) throw new Error("Missing PKCE code verifier for this MCP server. Start the connection again.");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") { await clearOAuth(this.serverId); return; }
    const patch: Partial<OAuthRecord> = { redirectBase: this.redirectBase };
    if (scope === "tokens") patch.tokens = undefined;
    if (scope === "verifier") patch.codeVerifier = undefined;
    if (scope === "client") patch.clientInformation = undefined;
    await writeRecord(this.serverId, patch);
  }
}
