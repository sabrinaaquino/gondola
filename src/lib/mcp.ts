import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { McpToolSummary } from "./app-types";
import type { McpServerConfig } from "./workspace";
import { FileOAuthProvider } from "./mcp-oauth";
import { redactToolArgs } from "./tool-activity";

const HTTP_RECONNECT = {
  initialReconnectionDelay: 500,
  maxReconnectionDelay: 4_000,
  reconnectionDelayGrowFactor: 1.7,
  maxRetries: 1,
};

function oauthBaseFallback(): string {
  return (process.env.NOVA_PUBLIC_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
}

function httpTransport(server: McpServerConfig, redirectBase: string): StreamableHTTPClientTransport {
  // Attach an OAuth provider to every remote server so saved tokens are used
  // and refreshed automatically. Manually pasted headers still apply for
  // servers that authenticate with a static token instead of OAuth.
  return new StreamableHTTPClientTransport(new URL(server.url as string), {
    requestInit: { headers: server.headers },
    authProvider: new FileOAuthProvider(server.id, redirectBase),
    reconnectionOptions: HTTP_RECONNECT,
  });
}

interface McpConnection {
  client: Client;
  fingerprint: string;
  connectedAt: number;
  lastUsedAt: number;
}

interface PendingMcpApproval {
  token: string;
  expiresAt: number;
}

export interface McpExecutionContext {
  sessionId: string;
  currentUserMessage(): string;
  requestApproval?: (input: { tool: string; summary: string }) => Promise<{ approved: boolean; denied?: boolean; approvalId?: string; risk?: string }>;
}

const globalCache = globalThis as typeof globalThis & {
  __novaMcpConnections?: Map<string, McpConnection>;
  __novaMcpApprovals?: Map<string, PendingMcpApproval>;
};

const connections = globalCache.__novaMcpConnections ?? new Map<string, McpConnection>();
globalCache.__novaMcpConnections = connections;
const pendingApprovals = globalCache.__novaMcpApprovals ?? new Map<string, PendingMcpApproval>();
globalCache.__novaMcpApprovals = pendingApprovals;

const MCP_CONNECTION_LIMIT = 12;
const MCP_IDLE_MS = 30 * 60_000;
const MCP_APPROVAL_MS = 5 * 60_000;

function configFingerprint(server: McpServerConfig): string {
  return JSON.stringify({
    transport: server.transport,
    url: server.url,
    command: server.command,
    args: server.args,
    headers: server.headers,
    env: server.env,
  });
}

async function connect(server: McpServerConfig): Promise<Client> {
  const now = Date.now();
  for (const [id, connection] of connections) {
    if (id === server.id || now - connection.lastUsedAt <= MCP_IDLE_MS) continue;
    connections.delete(id);
    await connection.client.close().catch(() => undefined);
  }
  const fingerprint = configFingerprint(server);
  const cached = connections.get(server.id);
  if (cached?.fingerprint === fingerprint) {
    cached.lastUsedAt = now;
    return cached.client;
  }
  if (cached) {
    connections.delete(server.id);
    await cached.client.close().catch(() => undefined);
  }

  const client = new Client({ name: "venice-agent", version: "0.1.0" });
  const transport = server.transport === "http"
    ? httpTransport(server, oauthBaseFallback())
    : new StdioClientTransport({
      command: server.command as string,
      args: server.args ?? [],
      env: { ...getDefaultEnvironment(), ...server.env },
      stderr: "pipe",
    });
  await client.connect(transport, { timeout: 8_000 });
  connections.set(server.id, { client, fingerprint, connectedAt: now, lastUsedAt: now });
  if (connections.size > MCP_CONNECTION_LIMIT) {
    const oldest = [...connections.entries()]
      .filter(([id]) => id !== server.id)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (oldest) {
      connections.delete(oldest[0]);
      await oldest[1].client.close().catch(() => undefined);
    }
  }
  return client;
}

/**
 * Start (or resume) a browser OAuth login for a remote MCP server. Returns
 * `{ authorized: true }` when saved tokens already work, otherwise the
 * authorization URL the user should open in their browser.
 */
export async function beginMcpOAuth(
  server: McpServerConfig,
  redirectBase: string,
): Promise<{ authorized: boolean; authorizationUrl?: string }> {
  if (server.transport !== "http" || !server.url) {
    throw new Error("Browser login is only available for remote (URL) MCP servers.");
  }
  const cached = connections.get(server.id);
  if (cached) {
    connections.delete(server.id);
    await cached.client.close().catch(() => undefined);
  }
  const provider = new FileOAuthProvider(server.id, redirectBase.replace(/\/$/, ""));
  const client = new Client({ name: "venice-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
    authProvider: provider,
    reconnectionOptions: HTTP_RECONNECT,
  });
  try {
    await client.connect(transport, { timeout: 12_000 });
    const connectedAt = Date.now();
    connections.set(server.id, { client, fingerprint: configFingerprint(server), connectedAt, lastUsedAt: connectedAt });
    return { authorized: true };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      const authorizationUrl = provider.capturedAuthorizationUrl();
      await transport.close().catch(() => undefined);
      if (authorizationUrl) return { authorized: false, authorizationUrl };
      throw new Error("This server requires login but did not provide an authorization URL.");
    }
    await transport.close().catch(() => undefined);
    throw error instanceof Error ? error : new Error("Could not start the login flow for this MCP server.");
  }
}

/** Complete the OAuth flow with the authorization code from the callback. */
export async function completeMcpOAuth(
  server: McpServerConfig,
  code: string,
  redirectBase: string,
): Promise<void> {
  if (server.transport !== "http" || !server.url) {
    throw new Error("Browser login is only available for remote (URL) MCP servers.");
  }
  const provider = new FileOAuthProvider(server.id, redirectBase.replace(/\/$/, ""));
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
    authProvider: provider,
    reconnectionOptions: HTTP_RECONNECT,
  });
  try {
    await transport.finishAuth(code);
  } finally {
    await transport.close().catch(() => undefined);
  }
}

export async function discoverMcpServer(server: McpServerConfig): Promise<{
  tools: McpToolSummary[];
  instructions?: string;
}> {
  const client = await connect(server);
  const result = await client.listTools(undefined, { timeout: 8_000 });
  return {
    instructions: client.getInstructions(),
    tools: result.tools.map((tool): McpToolSummary => ({
      name: tool.name,
      description: tool.description ?? tool.title ?? "MCP tool",
      inputSchema: tool.inputSchema as Record<string, unknown>,
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
    })),
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28);
}

function stringifyResource(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const resource = value as { uri?: unknown; text?: unknown; blob?: unknown };
  if (typeof resource.text === "string") return resource.text;
  if (typeof resource.uri === "string") return `Resource: ${resource.uri}`;
  if (typeof resource.blob === "string") return "The MCP server returned a binary resource.";
  return JSON.stringify(value) ?? "null";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function approvalKey(
  context: McpExecutionContext,
  server: McpServerConfig,
  toolName: string,
  params: unknown,
): string {
  return `${context.sessionId}:${server.id}:${toolName}:${stableJson(params)}`;
}

function requireMcpApproval(
  context: McpExecutionContext,
  server: McpServerConfig,
  toolName: string,
  params: unknown,
): { approved: true } | { approved: false; token: string } {
  const key = approvalKey(context, server, toolName, params);
  const now = Date.now();
  for (const [pendingKey, approval] of pendingApprovals) {
    if (approval.expiresAt <= now) pendingApprovals.delete(pendingKey);
  }
  const pending = pendingApprovals.get(key);
  if (pending && context.currentUserMessage().toUpperCase().includes(pending.token)) {
    pendingApprovals.delete(key);
    return { approved: true };
  }
  const token = pending?.token ?? `MCP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  pendingApprovals.set(key, { token, expiresAt: now + MCP_APPROVAL_MS });
  return { approved: false, token };
}

export function createMcpAgentTools(
  servers: McpServerConfig[],
  context: McpExecutionContext,
): AgentTool[] {
  return servers.flatMap((server) => server.tools.map((tool): AgentTool => {
    const name = `mcp_${slug(server.name)}_${slug(tool.name)}`.slice(0, 63);
    const needsApproval = tool.destructive || !tool.readOnly;
    const caution = needsApproval
      ? " This may change or delete external data; only call it after the user has explicitly asked for that exact action."
      : "";
    return {
      name,
      label: `${server.name}: ${tool.name}`,
      description: `${tool.description}${caution}`,
      parameters: tool.inputSchema as AgentTool["parameters"],
      executionMode: needsApproval ? "sequential" : "parallel",
      async execute(_toolCallId, params, signal) {
        if (needsApproval) {
          if (context.requestApproval) {
            const safeArgs = JSON.stringify(redactToolArgs(params));
            const summary = `call ${server.name}: ${tool.name}${safeArgs && safeArgs !== "{}" ? ` with ${safeArgs.slice(0, 180)}` : ""}`;
            const approval = await context.requestApproval({ tool: name, summary });
            if (!approval.approved) {
              const denied = approval.denied === true;
              return {
                content: [{ type: "text", text: denied ? `This external action is blocked by your Never allow policy: ${summary}.` : `${summary} needs your approval in the action card.` }],
                details: {
                  kind: "mcp_confirmation",
                  serverId: server.id,
                  serverName: server.name,
                  toolName: tool.name,
                  blocked: denied ? "approval_policy" : "approval_required",
                  needsConfirmation: !denied,
                  approvalId: approval.approvalId,
                  approvalTool: name,
                  approvalSummary: summary,
                  approvalRisk: approval.risk ?? "medium",
                },
              };
            }
          } else {
            const approval = requireMcpApproval(context, server, tool.name, params);
            if (!approval.approved) {
              return {
                content: [{
                  type: "text",
                  text: `No external action was taken. Ask the user to reply with \"Confirm MCP action ${approval.token}\" to approve this exact ${server.name}: ${tool.name} request. The confirmation expires in five minutes.`,
                }],
                details: {
                  kind: "mcp_confirmation",
                  serverId: server.id,
                  serverName: server.name,
                  toolName: tool.name,
                  token: approval.token,
                },
              };
            }
          }
        }
        const client = await connect(server);
        const result = await client.callTool(
          { name: tool.name, arguments: params as Record<string, unknown> },
          undefined,
          { signal, timeout: 45_000 },
        );
        if (!("content" in result)) {
          return {
            content: [{ type: "text", text: JSON.stringify(result.toolResult ?? result) }],
            details: { kind: "mcp", serverId: server.id, serverName: server.name, toolName: tool.name },
          };
        }
        const toolResult = result as {
          content: Array<
            | { type: "text"; text: string }
            | { type: "image"; data: string; mimeType: string }
            | { type: "audio"; data: string; mimeType: string }
            | { type: "resource"; resource: unknown }
            | { type: "resource_link"; name: string; uri: string }
          >;
          structuredContent?: Record<string, unknown>;
          isError?: boolean;
        };
        const content: Array<TextContent | ImageContent> = [];
        for (const part of toolResult.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text });
          else if (part.type === "image") content.push({ type: "image", data: part.data, mimeType: part.mimeType });
          else if (part.type === "resource") content.push({ type: "text", text: stringifyResource(part.resource) });
          else if (part.type === "resource_link") content.push({ type: "text", text: `Resource: ${part.name} (${part.uri})` });
          else if (part.type === "audio") content.push({ type: "text", text: `The MCP server returned audio (${part.mimeType}).` });
        }
        if (!content.length && toolResult.structuredContent) {
          content.push({ type: "text", text: JSON.stringify(toolResult.structuredContent) });
        }
        if (toolResult.isError) {
          throw new Error(content.map((part) => part.type === "text" ? part.text : "MCP tool failed").join("\n"));
        }
        return {
          content: content.length ? content : [{ type: "text", text: "The MCP tool completed successfully." }],
          details: { kind: "mcp", serverId: server.id, serverName: server.name, toolName: tool.name },
        };
      },
    };
  }));
}

export async function closeMcpConnection(serverId: string): Promise<void> {
  const cached = connections.get(serverId);
  connections.delete(serverId);
  await cached?.client.close().catch(() => undefined);
}
