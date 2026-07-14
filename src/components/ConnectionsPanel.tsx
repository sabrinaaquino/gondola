import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentProfile, IntegrationTemplate, McpServerSummary, TelegramChannelSummary, WorkspaceSnapshot } from "@/lib/app-types";

interface ConnectionsPanelProps {
  snapshot?: WorkspaceSnapshot;
  onRefresh: () => Promise<WorkspaceSnapshot | undefined>;
}

// Curated MCP integrations. These give the user a proper one-click starting
// point; the connect form stays fully editable so credentials and commands can
// be corrected before connecting. Every one connects a real MCP server.
const INTEGRATIONS: IntegrationTemplate[] = [
  {
    id: "gmail", name: "Gmail", category: "communication", glyph: "✉",
    blurb: "Read, search, and send email. Authorizes in your browser on first run.",
    transport: "stdio", command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
    docsUrl: "https://github.com/gongrzhe/server-gmail-autoauth-mcp",
  },
  {
    id: "gcal", name: "Google Calendar", category: "productivity", glyph: "◷",
    blurb: "Check availability and manage events across your calendars.",
    transport: "stdio", command: "npx", args: ["-y", "@cocal/google-calendar-mcp"],
    docsUrl: "https://github.com/nspady/google-calendar-mcp",
  },
  {
    id: "slack", name: "Slack", category: "communication", glyph: "#",
    blurb: "Post messages and read channels in your workspace.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"],
    secretHints: [
      { key: "SLACK_BOT_TOKEN", label: "Bot token", placeholder: "xoxb-…" },
      { key: "SLACK_TEAM_ID", label: "Team ID", placeholder: "T01234567" },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
  },
  {
    id: "notion", name: "Notion", category: "knowledge", glyph: "N",
    blurb: "Search pages and databases and create new notes.",
    transport: "stdio", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"],
    secretHints: [{ key: "NOTION_TOKEN", label: "Internal integration token", placeholder: "ntn_…" }],
    docsUrl: "https://github.com/makenotion/notion-mcp-server",
  },
  {
    id: "github", name: "GitHub", category: "developer", glyph: "⌥",
    blurb: "Issues, pull requests, and repository context. Official remote server.",
    transport: "http", url: "https://api.githubcopilot.com/mcp/",
    secretHints: [{ key: "Authorization", label: "Authorization header", placeholder: "Bearer ghp_…" }],
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "linear", name: "Linear", category: "productivity", glyph: "◭",
    blurb: "Track issues and projects. Hosted remote MCP with OAuth.",
    transport: "http", url: "https://mcp.linear.app/mcp",
    secretHints: [{ key: "Authorization", label: "Authorization header", placeholder: "Bearer …" }],
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "filesystem", name: "Files", category: "developer", glyph: "⌘",
    blurb: "Give an agent scoped read/write access to a local folder.",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "custom", name: "Custom MCP", category: "custom", glyph: "+",
    blurb: "Connect any other MCP server by URL or local command.",
    transport: "http",
  },
];

export function ConnectionsPanel({ snapshot, onRefresh }: ConnectionsPanelProps) {
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot?.agents]);
  const defaultAgentId = snapshot?.defaultAgentId ?? agents[0]?.id ?? "";
  const mcpServers = useMemo(() => snapshot?.mcpServers ?? [], [snapshot?.mcpServers]);

  const [telegram, setTelegram] = useState<TelegramChannelSummary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Telegram form
  const [tgToken, setTgToken] = useState("");
  const [tgChatIds, setTgChatIds] = useState("");
  const [tgAgent, setTgAgent] = useState(defaultAgentId);
  const [tgEnabled, setTgEnabled] = useState(false);
  const [tgNote, setTgNote] = useState("");

  // Integration connect form
  const [activeTemplate, setActiveTemplate] = useState<IntegrationTemplate>();
  const [intName, setIntName] = useState("");
  const [intTransport, setIntTransport] = useState<"http" | "stdio">("http");
  const [intUrl, setIntUrl] = useState("");
  const [intCommand, setIntCommand] = useState("");
  const [intArgs, setIntArgs] = useState("");
  const [intSecrets, setIntSecrets] = useState<Record<string, string>>({});
  const [intNote, setIntNote] = useState("");

  const loadChannels = useCallback(async () => {
    try {
      const response = await fetch("/api/channels", { cache: "no-store" });
      const data = await response.json() as { telegram?: TelegramChannelSummary; error?: string };
      if (data.telegram) {
        setTelegram(data.telegram);
        setTgEnabled(data.telegram.enabled);
        setTgChatIds(data.telegram.allowedChatIds.join(", "));
        setTgAgent(data.telegram.agentId || defaultAgentId);
      }
    } catch {
      // A channels load failure is non-fatal; the section shows the offline state.
    }
  }, [defaultAgentId]);

  useEffect(() => { void loadChannels(); }, [loadChannels]);

  // The OAuth popup posts back here when the browser login finishes.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; ok?: boolean } | null;
      if (!data || data.type !== "mcp-oauth") return;
      setBusy(false);
      if (data.ok) { setIntNote("Connected."); void onRefresh(); }
      else setError("The login did not complete. Try connecting again.");
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onRefresh]);

  const openOAuthPopup = (url: string) => {
    const popup = window.open(url, "mcp-oauth-login", "width=520,height=720");
    if (!popup) throw new Error("The login popup was blocked. Allow popups for this app and try again.");
    setIntNote("Opening browser login. Approve access in the popup, then you're connected.");
  };

  // Kick off (or resume) a browser login for an already-saved remote server.
  const startOAuth = async (serverId: string) => {
    setBusy(true);
    setError("");
    setIntNote("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mcp_oauth_start", id: serverId }),
      });
      const result = await response.json() as { authorizationUrl?: string; authorized?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not start the login");
      if (result.authorizationUrl) openOAuthPopup(result.authorizationUrl);
      else if (result.authorized) { setIntNote("Connected."); await onRefresh(); }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not start the login");
    } finally {
      setBusy(false);
    }
  };

  const postChannel = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { telegram?: TelegramChannelSummary; ok?: boolean; username?: string; error?: string };
    if (!response.ok) throw new Error(result.error ?? "The channel could not be updated");
    return result;
  };

  const saveTelegram = async () => {
    setBusy(true);
    setError("");
    setTgNote("");
    try {
      const result = await postChannel({
        action: "configure",
        enabled: tgEnabled,
        ...(tgToken.trim() ? { botToken: tgToken.trim() } : {}),
        allowedChatIds: tgChatIds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
        agentId: tgAgent,
      });
      if (result.telegram) setTelegram(result.telegram);
      setTgToken("");
      setTgNote(result.telegram?.running
        ? `Connected and listening${result.telegram.botUsername ? ` as @${result.telegram.botUsername}` : ""}.`
        : "Saved. Enable it with a valid token to start listening.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Telegram could not be configured");
    } finally {
      setBusy(false);
    }
  };

  const verifyTelegram = async () => {
    setBusy(true);
    setTgNote("");
    setError("");
    try {
      const result = await postChannel({ action: "verify", ...(tgToken.trim() ? { botToken: tgToken.trim() } : {}) });
      setTgNote(result.ok ? `Token valid: @${result.username}` : `Token check failed: ${result.error ?? "unknown error"}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not check the token");
    } finally {
      setBusy(false);
    }
  };

  const disconnectTelegram = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await postChannel({ action: "disconnect" });
      if (result.telegram) setTelegram(result.telegram);
      setTgEnabled(false);
      setTgChatIds("");
      setTgNote("Disconnected.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  };

  const beginIntegration = (template: IntegrationTemplate) => {
    setActiveTemplate(template);
    setIntName(template.id === "custom" ? "" : template.name);
    setIntTransport(template.transport);
    setIntUrl(template.url ?? "");
    setIntCommand(template.command ?? "");
    setIntArgs((template.args ?? []).join("\n"));
    setIntSecrets(Object.fromEntries((template.secretHints ?? []).map((hint) => [hint.key, ""])));
    setError("");
  };

  const connectIntegration = async () => {
    setBusy(true);
    setError("");
    try {
      const secrets = Object.fromEntries(Object.entries(intSecrets).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_mcp",
          name: intName,
          transport: intTransport,
          url: intUrl,
          command: intCommand,
          args: intArgs.split("\n").map((value) => value.trim()).filter(Boolean),
          ...(intTransport === "http" ? { headers: secrets } : { env: secrets }),
        }),
      });
      const result = await response.json() as { error?: string; authorizationUrl?: string };
      if (!response.ok && !result.authorizationUrl) throw new Error(result.error ?? "The integration could not be connected");
      // Remote server that needs a browser login: open the popup instead of
      // demanding a token. The popup posts back when it's done.
      if (result.authorizationUrl) openOAuthPopup(result.authorizationUrl);
      await onRefresh();
      setActiveTemplate(undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The integration could not be connected");
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const telegramStatus = telegram?.running ? "Listening" : telegram?.enabled ? "Enabled" : "Not connected";
  const connectedIntegrations = mcpServers;

  return (
    <>
      {error && <p className="form-error">{error}</p>}

      {/* ── Channels ─────────────────────────────────────────── */}
      <section className="connections-group">
        <header className="connections-group-header">
          <div><span className="workspace-kicker">Channels</span><h4>Where people reach your agent</h4></div>
        </header>

        <article className={`connection-card ${telegram?.running ? "is-live" : ""}`}>
          <div className="connection-card-top">
            <span className="connection-glyph telegram">✈</span>
            <div className="connection-card-copy">
              <strong>Telegram{telegram?.botUsername ? ` · @${telegram.botUsername}` : ""}</strong>
              <small>Message your agent from Telegram. Turns run through the same queue and memory as the browser.</small>
            </div>
            <span className={`connection-status ${telegram?.running ? "is-live" : telegram?.enabled ? "is-on" : ""}`}>{telegramStatus}</span>
          </div>

          <div className="connection-form">
            <label className="access-check">
              <input type="checkbox" checked={tgEnabled} onChange={(event) => setTgEnabled(event.target.checked)} />
              <span><strong>Enable Telegram</strong><small>Start long-polling for messages when a valid token is set.</small></span>
            </label>
            <label><span>Bot token {telegram?.hasToken ? "(saved, leave blank to keep)" : "(from @BotFather)"}</span>
              <input type="password" value={tgToken} onChange={(event) => setTgToken(event.target.value)} placeholder="123456:ABC-DEF…" />
            </label>
            <label><span>Allowed chat IDs (comma or space separated)</span>
              <input value={tgChatIds} onChange={(event) => setTgChatIds(event.target.value)} placeholder="12345678, 98765432" />
            </label>
            <label><span>Answer as</span>
              <select value={tgAgent} onChange={(event) => setTgAgent(event.target.value)}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            {tgNote && <p className="connection-note">{tgNote}</p>}
            <div className="connection-actions">
              <button className="workspace-primary" disabled={busy} onClick={() => void saveTelegram()}>{busy ? "Saving…" : "Save and connect"}</button>
              <button disabled={busy} onClick={() => void verifyTelegram()}>Check token</button>
              {telegram?.hasToken && <button className="connection-danger" disabled={busy} onClick={() => void disconnectTelegram()}>Disconnect</button>}
            </div>
            <p className="connection-hint">New here? Create a bot with @BotFather, paste its token, message the bot, then add your chat ID from @userinfobot.</p>
          </div>
        </article>
      </section>

      {/* ── Integrations ────────────────────────────────────── */}
      <section className="connections-group">
        <header className="connections-group-header">
          <div><span className="workspace-kicker">Integrations</span><h4>Services your agents can use</h4></div>
        </header>
        {intNote && <p className="connection-note">{intNote}</p>}

        {connectedIntegrations.length > 0 && (
          <div className="resource-list connected-integrations">
            {connectedIntegrations.map((server: McpServerSummary) => (
              <div className="resource-row" key={server.id}>
                <span className={server.status === "connected" ? "is-connected" : ""}>{server.name.charAt(0).toUpperCase()}</span>
                <div><strong>{server.name}</strong><small>{server.status === "connected" ? `${server.tools.length} tools · ${server.transport === "http" ? "Remote" : "Local"}` : server.status === "needs_auth" ? "Needs a quick browser login" : server.lastError ?? server.status}</small></div>
                {server.status === "connected"
                  ? <em className="is-connected">Connected</em>
                  : server.transport === "http"
                    ? <button className="workspace-primary" disabled={busy} onClick={() => void startOAuth(server.id)}>{server.status === "needs_auth" ? "Log in" : "Reconnect"}</button>
                    : <em>{server.status}</em>}
              </div>
            ))}
          </div>
        )}

        {!activeTemplate ? (
          <div className="integration-grid">
            {INTEGRATIONS.map((template) => (
              <button className="integration-card" key={template.id} onClick={() => beginIntegration(template)}>
                <span className="integration-glyph">{template.glyph}</span>
                <strong>{template.name}</strong>
                <small>{template.blurb}</small>
                <em>{template.id === "custom" ? "Set up →" : "Connect →"}</em>
              </button>
            ))}
          </div>
        ) : (
          <section className="workspace-form integration-form">
            <button className="back-button" onClick={() => setActiveTemplate(undefined)}>← All integrations</button>
            <h3>Connect {activeTemplate.name}</h3>
            <p className="form-intro">
              For hosted services you can just click Connect and log in through your browser. The credentials below are optional and only needed for servers that use a token.
              {activeTemplate.docsUrl && <> <a href={activeTemplate.docsUrl} target="_blank" rel="noreferrer">Setup guide ↗</a></>}
            </p>
            <div className="transport-tabs">
              <button className={intTransport === "http" ? "is-active" : ""} onClick={() => setIntTransport("http")}>Remote URL</button>
              <button className={intTransport === "stdio" ? "is-active" : ""} onClick={() => setIntTransport("stdio")}>Local command</button>
            </div>
            <label><span>Name</span><input value={intName} onChange={(event) => setIntName(event.target.value)} placeholder="Gmail" /></label>
            {intTransport === "http" ? (
              <label><span>MCP endpoint</span><input value={intUrl} onChange={(event) => setIntUrl(event.target.value)} placeholder="https://example.com/mcp" /></label>
            ) : (
              <>
                <label><span>Command</span><input value={intCommand} onChange={(event) => setIntCommand(event.target.value)} placeholder="npx" /></label>
                <label><span>Arguments (one per line)</span><textarea rows={3} value={intArgs} onChange={(event) => setIntArgs(event.target.value)} placeholder={"-y\n@my/mcp-server"} /></label>
              </>
            )}
            {(activeTemplate.secretHints ?? []).map((hint) => (
              <label key={hint.key}>
                <span>{hint.label}</span>
                <input
                  type="password"
                  value={intSecrets[hint.key] ?? ""}
                  onChange={(event) => setIntSecrets((prev) => ({ ...prev, [hint.key]: event.target.value }))}
                  placeholder={hint.placeholder ?? ""}
                />
              </label>
            ))}
            <button className="workspace-primary form-submit" disabled={busy || !intName.trim()} onClick={() => void connectIntegration()}>
              {busy ? "Connecting…" : `Connect ${activeTemplate.name}`}
            </button>
          </section>
        )}
      </section>
    </>
  );
}
