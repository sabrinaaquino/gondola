import { completeMcpOAuth, discoverMcpServer } from "@/lib/mcp";
import { findServerIdByState } from "@/lib/mcp-oauth";
import { getMcpServerConfig, saveMcpServer } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Landing page for the OAuth redirect. Finishes the token exchange, discovers
// the server's tools, marks it connected, then notifies the opener window and
// closes itself. Returns HTML so it renders nicely in the popup.
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function page(origin: string, title: string, message: string, payload: Record<string, unknown>): Response {
  const safePayload = JSON.stringify({ type: "mcp-oauth", ...payload }).replace(/</g, "\\u003c");
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;background:#0b0d10;color:#e7edf5;display:grid;place-items:center;height:100vh;margin:0}main{max-width:420px;text-align:center;padding:24px}h1{font-size:17px;margin:0 0 8px}p{color:#9aa4b2;line-height:1.5}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>
<script>try{window.opener&&window.opener.postMessage(${safePayload},${JSON.stringify(origin)})}catch(e){}setTimeout(function(){window.close()},1200)</script>
</body></html>`;
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return page(url.origin, "Login cancelled", `The provider returned: ${errorParam}. You can close this window and try again.`, { ok: false });
  }
  if (!code || !state) {
    return page(url.origin, "Login failed", "The callback was missing its authorization code. Close this window and try again.", { ok: false });
  }

  try {
    const serverId = await findServerIdByState(state);
    if (!serverId) throw new Error("This login session has expired. Start the connection again.");
    const config = await getMcpServerConfig(serverId);
    await completeMcpOAuth(config, code, url.origin);
    // Tokens are stored; connect once more to enumerate tools and mark it live.
    const discovery = await discoverMcpServer(config);
    await saveMcpServer({
      id: serverId,
      name: config.name,
      transport: config.transport,
      tools: discovery.tools,
      instructions: discovery.instructions,
      status: "connected",
    });
    return page(url.origin, "Connected", `${config.name} is connected. You can close this window.`, { ok: true, serverId });
  } catch (error) {
    return page(url.origin, "Login failed", error instanceof Error ? error.message : "Could not complete the login.", { ok: false });
  }
}
