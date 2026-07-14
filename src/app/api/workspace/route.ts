import {
  appendConversationMessage,
  createAgent,
  createConversation,
  createSkill,
  deleteConversation,
  getConversation,
  getMcpServerConfig,
  getWorkspaceSnapshot,
  installSkill,
  installSkillFromHub,
  installSkillFromUrl,
  rewindConversation,
  saveMcpServer,
  setActiveConversation,
  updateAgent,
} from "@/lib/workspace";
import { beginMcpOAuth, closeMcpConnection, discoverMcpServer } from "@/lib/mcp";
import { deleteTranscript } from "@/lib/transcript";
import { resetAgentSession } from "@/lib/pi-agent";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import type { WorkspaceMessage } from "@/lib/app-types";
import { removeEmDashes } from "@/lib/text-style";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .slice(0, 40));
}

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  try {
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (conversationId) return Response.json(await getConversation(conversationId), { headers: { "Cache-Control": "no-store" } });
    return Response.json(await getWorkspaceSnapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Workspace request failed" }, { status: 404 });
  }
}

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: "The request body must be valid JSON" }, { status: 400 });
    }
    const action = String(body.action ?? "");

    if (action === "create_conversation") {
      return Response.json(await createConversation(String(body.agentId ?? "")));
    }
    if (action === "activate_conversation") {
      await setActiveConversation(String(body.conversationId ?? ""));
      return Response.json({ ok: true });
    }
    if (action === "delete_conversation") {
      return Response.json(await deleteConversation(String(body.conversationId ?? "")));
    }
    if (action === "append_message") {
      const role = body.role === "assistant" ? "assistant" : body.role === "user" ? "user" : undefined;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!role || !text) return Response.json({ error: "A role and message are required" }, { status: 400 });
      const message: WorkspaceMessage = {
        id: typeof body.id === "string" ? body.id : crypto.randomUUID(),
        role,
        text: (role === "assistant" ? removeEmDashes(text) : text).slice(0, 100_000),
        createdAt: typeof body.createdAt === "number" ? body.createdAt : Date.now(),
      };
      const conversation = await appendConversationMessage(String(body.conversationId ?? ""), message);
      return Response.json({ message, conversation });
    }
    if (action === "rewind_conversation") {
      const conversationId = String(body.conversationId ?? "");
      const messageId = String(body.messageId ?? "");
      if (!conversationId || !messageId) return Response.json({ error: "conversationId and messageId are required" }, { status: 400 });
      const result = await rewindConversation(conversationId, messageId);
      // Drop the durable transcript and the in-memory session so the next turn
      // rebuilds its context from the truncated history and continues from here.
      await deleteTranscript(conversationId).catch(() => undefined);
      resetAgentSession(conversationId);
      return Response.json({ ok: true, ...result });
    }
    if (action === "create_agent") {
      const agent = await createAgent({
        name: String(body.name ?? ""),
        description: typeof body.description === "string" ? body.description : undefined,
        instructions: typeof body.instructions === "string" ? body.instructions : undefined,
        skillIds: Array.isArray(body.skillIds) ? body.skillIds.map(String) : [],
        mcpServerIds: Array.isArray(body.mcpServerIds) ? body.mcpServerIds.map(String) : [],
        memoryIsolated: typeof body.memoryIsolated === "boolean" ? body.memoryIsolated : undefined,
      });
      return Response.json({ agent }, { status: 201 });
    }
    if (action === "update_agent") {
      const agent = await updateAgent({
        id: String(body.id ?? ""),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
        ...(Array.isArray(body.skillIds) ? { skillIds: body.skillIds.map(String) } : {}),
        ...(Array.isArray(body.mcpServerIds) ? { mcpServerIds: body.mcpServerIds.map(String) } : {}),
        ...(typeof body.memoryIsolated === "boolean" ? { memoryIsolated: body.memoryIsolated } : {}),
      });
      return Response.json({ agent });
    }
    if (action === "create_skill") {
      const skill = await createSkill({
        name: String(body.name ?? ""),
        description: String(body.description ?? ""),
        instructions: String(body.instructions ?? ""),
      });
      return Response.json({ skill }, { status: 201 });
    }
    if (action === "install_skill") {
      const skill = await installSkill({
        markdown: typeof body.markdown === "string" ? body.markdown : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        instructions: typeof body.instructions === "string" ? body.instructions : undefined,
        source: body.source === "catalog" ? { type: "catalog", origin: typeof body.origin === "string" ? body.origin : undefined } : undefined,
      });
      return Response.json({ skill }, { status: 201 });
    }
    if (action === "install_skill_url") {
      const skills = await installSkillFromUrl(String(body.url ?? ""));
      return Response.json({ skills, skill: skills[0] }, { status: 201 });
    }
    if (action === "hub_search") {
      const { searchClawHub } = await import("@/lib/clawhub");
      const results = await searchClawHub(String(body.query ?? ""), 20);
      return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "install_skill_hub") {
      const skill = await installSkillFromHub(String(body.slug ?? ""), typeof body.owner === "string" ? body.owner : undefined);
      return Response.json({ skill }, { status: 201 });
    }
    if (action === "search_conversations") {
      const { searchConversations } = await import("@/lib/conversation-search");
      const result = await searchConversations(String(body.query ?? ""), typeof body.limit === "number" ? body.limit : 8);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "list_skill_suggestions") {
      const { listSuggestions } = await import("@/lib/skill-distiller");
      return Response.json({ suggestions: await listSuggestions() }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "distill_skills") {
      const { distillSkills } = await import("@/lib/skill-distiller");
      return Response.json({ suggestions: await distillSkills() });
    }
    if (action === "install_skill_suggestion") {
      const { installSuggestion } = await import("@/lib/skill-distiller");
      const skill = await installSuggestion(String(body.id ?? ""));
      return Response.json({ skill }, { status: 201 });
    }
    if (action === "dismiss_skill_suggestion") {
      const { dismissSuggestion } = await import("@/lib/skill-distiller");
      await dismissSuggestion(String(body.id ?? ""));
      return Response.json({ ok: true });
    }
    if (action === "create_mcp") {
      const transport = body.transport === "stdio" ? "stdio" : "http";
      const id = crypto.randomUUID();
      let server = await saveMcpServer({
        id,
        name: String(body.name ?? ""),
        transport,
        url: typeof body.url === "string" ? body.url : undefined,
        command: typeof body.command === "string" ? body.command : undefined,
        args: Array.isArray(body.args) ? body.args.map(String).slice(0, 50) : [],
        headers: stringRecord(body.headers),
        env: stringRecord(body.env),
        status: "untested",
      });
      try {
        const config = await getMcpServerConfig(id);
        const discovery = await discoverMcpServer(config);
        server = await saveMcpServer({
          id,
          name: server.name,
          transport,
          tools: discovery.tools,
          instructions: discovery.instructions,
          status: "connected",
        });
        return Response.json({ server }, { status: 201 });
      } catch (error) {
        await closeMcpConnection(id);
        // A remote server may just need a browser login. Try to start OAuth and
        // hand the authorization URL back so the user can click to authenticate
        // instead of pasting a token.
        if (transport === "http") {
          try {
            const config = await getMcpServerConfig(id);
            const auth = await beginMcpOAuth(config, new URL(request.url).origin);
            if (auth.authorized) {
              const discovery = await discoverMcpServer(config);
              server = await saveMcpServer({ id, name: server.name, transport, tools: discovery.tools, instructions: discovery.instructions, status: "connected" });
              return Response.json({ server }, { status: 201 });
            }
            if (auth.authorizationUrl) {
              server = await saveMcpServer({ id, name: server.name, transport, status: "needs_auth", lastError: undefined });
              return Response.json({ server, authorizationUrl: auth.authorizationUrl }, { status: 202 });
            }
          } catch {
            // Not an OAuth server, or OAuth is unavailable. Fall through to error.
          }
        }
        server = await saveMcpServer({
          id,
          name: server.name,
          transport,
          status: "error",
          lastError: error instanceof Error ? error.message.slice(0, 240) : "Connection failed",
        });
        return Response.json({ server, error: "The MCP server was saved, but its tools could not be discovered." }, { status: 422 });
      }
    }
    if (action === "mcp_oauth_start") {
      const id = String(body.id ?? "");
      await closeMcpConnection(id);
      const config = await getMcpServerConfig(id);
      const auth = await beginMcpOAuth(config, new URL(request.url).origin);
      if (auth.authorized) {
        const discovery = await discoverMcpServer(config);
        const server = await saveMcpServer({ id, name: config.name, transport: config.transport, tools: discovery.tools, instructions: discovery.instructions, status: "connected" });
        return Response.json({ server, authorized: true });
      }
      const server = await saveMcpServer({ id, name: config.name, transport: config.transport, status: "needs_auth" });
      return Response.json({ server, authorizationUrl: auth.authorizationUrl });
    }
    if (action === "refresh_mcp") {
      const id = String(body.id ?? "");
      await closeMcpConnection(id);
      const config = await getMcpServerConfig(id);
      try {
        const discovery = await discoverMcpServer(config);
        const server = await saveMcpServer({
          id,
          name: config.name,
          transport: config.transport,
          tools: discovery.tools,
          instructions: discovery.instructions,
          status: "connected",
        });
        return Response.json({ server });
      } catch (error) {
        const server = await saveMcpServer({
          id,
          name: config.name,
          transport: config.transport,
          status: "error",
          lastError: error instanceof Error ? error.message.slice(0, 240) : "Connection failed",
        });
        return Response.json({ server, error: "MCP connection failed" }, { status: 422 });
      }
    }

    return Response.json({ error: "Unknown workspace action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Workspace update failed" }, { status: 400 });
  }
}
