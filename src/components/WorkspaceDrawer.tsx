import { useEffect, useMemo, useState } from "react";
import type { AgentProfile, MemoryKind, MemorySnapshot, PersonalMemoryEntry, WorkspaceSnapshot } from "@/lib/app-types";
import { CloseIcon } from "./Icons";
import { AutomationsPanel } from "./AutomationsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { SkillInstaller } from "./SkillInstaller";
import { ConversationSearch } from "./ConversationSearch";
import { AgentMemoryManager } from "./AgentMemoryManager";

export type WorkspaceTab = "agents" | "chats" | "memory" | "automations" | "connections";

interface WorkspaceDrawerProps {
  open: boolean;
  tab: WorkspaceTab;
  snapshot?: WorkspaceSnapshot;
  activeAgentId: string;
  activeConversationId: string;
  onClose: () => void;
  onTabChange: (tab: WorkspaceTab) => void;
  onRefresh: () => Promise<WorkspaceSnapshot | undefined>;
  onStartChat: (agentId: string) => Promise<void>;
  onOpenConversation: (conversationId: string) => Promise<void>;
  onDeleteConversation: (conversationId: string) => Promise<void>;
}

type Editor = "none" | "agent" | "skill" | "mcp" | "memory";

const MEMORY_KINDS: Array<{ value: MemoryKind; label: string }> = [
  { value: "bio", label: "Bio" },
  { value: "preference", label: "Preference" },
  { value: "important", label: "Important note" },
  { value: "project", label: "Project" },
  { value: "relationship", label: "Person or relationship" },
  { value: "environment", label: "Environment" },
  { value: "agent", label: "Entity profile" },
  { value: "other", label: "Other" },
];

function memoryKindLabel(kind: MemoryKind): string {
  return MEMORY_KINDS.find((option) => option.value === kind)?.label ?? "Memory";
}

function memorySourceLabel(source: PersonalMemoryEntry["source"]["type"]): string {
  if (source === "automatic") return "Learned from conversation";
  if (source === "explicit") return "You asked to remember this";
  if (source === "agent") return "Saved by the Entity";
  if (source === "migration") return "Imported from earlier memory";
  return "Added by you";
}

function timeAgo(value: string): string {
  const seconds = Math.max(1, Math.floor((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function WorkspaceDrawer({
  open,
  tab,
  snapshot,
  activeAgentId,
  activeConversationId,
  onClose,
  onTabChange,
  onRefresh,
  onStartChat,
  onOpenConversation,
  onDeleteConversation,
}: WorkspaceDrawerProps) {
  const [editor, setEditor] = useState<Editor>("none");
  const [editingAgent, setEditingAgent] = useState<AgentProfile>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedMcps, setSelectedMcps] = useState<string[]>([]);
  const [memoryIsolated, setMemoryIsolated] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  const [confirmDeleteMemoryId, setConfirmDeleteMemoryId] = useState("");
  const [memorySnapshot, setMemorySnapshot] = useState<MemorySnapshot>();
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [editingMemory, setEditingMemory] = useState<PersonalMemoryEntry>();
  const [memoryKind, setMemoryKind] = useState<MemoryKind>("bio");
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryImportance, setMemoryImportance] = useState(3);
  const [memoryPinned, setMemoryPinned] = useState(false);

  const agentNames = useMemo(() => new Map(snapshot?.agents.map((agent) => [agent.id, agent.name]) ?? []), [snapshot?.agents]);
  const visibleMemories = useMemo(() => {
    const query = memoryQuery.trim().toLowerCase();
    return (memorySnapshot?.entries ?? []).filter((entry) => entry.status === "active" && (!query
      || `${entry.title} ${entry.content} ${entry.kind} ${entry.tags.join(" ")}`.toLowerCase().includes(query)));
  }, [memoryQuery, memorySnapshot?.entries]);
  const pendingMemories = useMemo(() => (memorySnapshot?.entries ?? []).filter((entry) => entry.status === "pending"), [memorySnapshot?.entries]);

  useEffect(() => {
    if (!open) {
      setEditor("none");
      setError("");
      setConfirmDeleteId("");
      setConfirmDeleteMemoryId("");
    }
  }, [open]);

  const beginAgent = (agent?: AgentProfile) => {
    setEditingAgent(agent);
    setName(agent?.name ?? "");
    setDescription(agent?.description ?? "");
    setInstructions(agent?.instructions ?? "");
    setSelectedSkills(agent?.skillIds ?? []);
    setSelectedMcps(agent?.mcpServerIds ?? []);
    setMemoryIsolated(agent?.memoryIsolated ?? false);
    setError("");
    setEditor("agent");
  };

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "The workspace could not be updated");
    return result;
  };

  const refreshMemory = async () => {
    setMemoryLoading(true);
    try {
      const response = await fetch("/api/memory", { cache: "no-store" });
      const result = await response.json() as MemorySnapshot & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Memory could not be loaded");
      setMemorySnapshot(result);
      return result;
    } finally {
      setMemoryLoading(false);
    }
  };

  const postMemory = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Memory could not be updated");
    await refreshMemory();
    return result;
  };

  useEffect(() => {
    if (!open || tab !== "memory") return;
    void refreshMemory().catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Memory could not be loaded"));
  }, [open, tab]);

  const beginMemory = (memory?: PersonalMemoryEntry) => {
    setEditingMemory(memory);
    setMemoryKind(memory?.kind ?? "bio");
    setMemoryTitle(memory?.title ?? "");
    setMemoryContent(memory?.content ?? "");
    setMemoryImportance(memory?.importance ?? 3);
    setMemoryPinned(memory?.pinned ?? false);
    setError("");
    setEditor("memory");
  };

  const saveMemory = async () => {
    setSaving(true);
    setError("");
    try {
      await postMemory({
        action: editingMemory ? "update" : "create",
        ...(editingMemory ? { id: editingMemory.id } : {}),
        kind: memoryKind,
        title: memoryTitle,
        content: memoryContent,
        importance: memoryImportance,
        pinned: memoryPinned,
      });
      setEditor("none");
      setEditingMemory(undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not save the memory");
    } finally {
      setSaving(false);
    }
  };

  const updateMemorySetting = async (key: "enabled" | "autoCapture" | "requireApproval", value: boolean) => {
    setSaving(true);
    setError("");
    try {
      await postMemory({ action: "settings", [key]: value });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not update memory settings");
    } finally {
      setSaving(false);
    }
  };

  const saveAgent = async () => {
    setSaving(true);
    setError("");
    try {
      await post({
        action: editingAgent ? "update_agent" : "create_agent",
        ...(editingAgent ? { id: editingAgent.id } : {}),
        name,
        description,
        instructions,
        skillIds: selectedSkills,
        mcpServerIds: selectedMcps,
        memoryIsolated,
      });
      await onRefresh();
      setEditor("none");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not save the agent");
    } finally {
      setSaving(false);
    }
  };

  const saveSkill = async () => {
    setSaving(true);
    setError("");
    try {
      await post({ action: "create_skill", name: skillName, description: skillDescription, instructions: skillInstructions });
      await onRefresh();
      setSkillName("");
      setSkillDescription("");
      setSkillInstructions("");
      setEditor("none");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not add the skill");
    } finally {
      setSaving(false);
    }
  };

  const toggle = (values: string[], value: string, setter: (values: string[]) => void) => {
    setter(values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value]);
  };

  const sectionMeta: Record<WorkspaceTab, { title: string; subtitle: string }> = {
    chats: { title: "Chats", subtitle: "Regular conversations that use your personal memory." },
    agents: { title: "Agents", subtitle: "Isolated agents with their own memory, skills, and tools." },
    memory: { title: "Personal memory", subtitle: "Kept across your chats." },
    connections: { title: "Connections", subtitle: "Channels and services your agents can reach." },
    automations: { title: "Automations", subtitle: "Tasks that run on a schedule, on their own." },
  };
  const editorTitle = editor === "agent" ? (editingAgent ? `Edit ${editingAgent.name}` : "New agent")
    : editor === "skill" ? "New skill"
    : editor === "mcp" ? "Connect a tool"
    : editor === "memory" ? (editingMemory ? "Edit memory" : "Add memory")
    : "";
  const headerTitle = editor === "none" ? sectionMeta[tab].title : editorTitle;
  const headerSubtitle = editor === "none" ? sectionMeta[tab].subtitle : "";
  const headerAction = editor !== "none" ? undefined
    : tab === "chats" ? { label: "New chat", onClick: () => { void onStartChat(snapshot?.defaultAgentId ?? activeAgentId); } }
    : tab === "agents" ? { label: "New agent", onClick: () => beginAgent() }
    : tab === "memory" ? { label: "Add memory", onClick: () => beginMemory() }
    : undefined;

  return (
    <>
      <button className={`workspace-scrim ${open ? "is-open" : ""}`} onClick={onClose} aria-label="Close workspace" tabIndex={open ? 0 : -1} />
      <aside className={`workspace-drawer ${open ? "is-open" : ""}`} aria-hidden={!open}>
        <header className="workspace-header">
          <div className="workspace-title">
            <h2>{headerTitle}</h2>
            {headerSubtitle && <p>{headerSubtitle}</p>}
          </div>
          <div className="workspace-header-actions">
            {headerAction && <button className="workspace-primary" onClick={headerAction.onClick}>+ {headerAction.label}</button>}
            <button className="icon-button" onClick={onClose} aria-label="Close workspace"><CloseIcon size={20} /></button>
          </div>
        </header>

        <div className="workspace-scroll">
          {tab === "agents" && editor === "none" && (
            <>
              <section className="agent-list">
                {snapshot?.agents.map((agent) => (
                  <article className={`agent-card ${agent.id === activeAgentId ? "is-active" : ""}`} key={agent.id}>
                    <div className="agent-card-top">
                      <span className="agent-initial">{agent.name.charAt(0).toUpperCase()}</span>
                      <div><h3>{agent.name}</h3><p>{agent.description}</p></div>
                      {agent.id === activeAgentId && <small>Current</small>}
                    </div>
                    <div className="agent-card-actions">
                      <button className="agent-open-chat" onClick={() => void onStartChat(agent.id)}>Start chat</button>
                      <button onClick={() => beginAgent(agent)}>Manage</button>
                    </div>
                  </article>
                ))}
              </section>

              <section className="resource-library">
                <header className="resource-library-header">
                  <div><h3>Skills</h3></div>
                  <div><button onClick={() => { setError(""); setEditor("skill"); }}>+ Skill</button></div>
                </header>
                {error && <p className="resource-error">{error}</p>}
                {snapshot?.skills.length ? (
                  <div className="skill-chips">
                    {snapshot.skills.map((skill) => <span className="skill-chip" key={skill.id} title={skill.description}>{skill.name}</span>)}
                  </div>
                ) : (
                  <p className="resource-hint">No skills yet. Add reusable instructions your agents can load on demand.</p>
                )}
              </section>
            </>
          )}

          {tab === "chats" && editor === "none" && (
            <>
              <ConversationSearch agentNames={agentNames} onOpen={onOpenConversation} />
              <section className="conversation-list">
                {error && <p className="resource-error">{error}</p>}
                {!snapshot?.conversations.length && <div className="conversation-empty"><strong>No conversations yet</strong><small>Use “+ New chat” to start a regular conversation.</small></div>}
                {snapshot?.conversations.map((conversation) => (
                  <div className={`conversation-item ${conversation.id === activeConversationId ? "is-active" : ""}`} key={conversation.id}>
                    <button className="conversation-open" onClick={() => void onOpenConversation(conversation.id)}>
                      <span className="conversation-agent">{agentNames.get(conversation.agentId)?.charAt(0) ?? "A"}</span>
                      <span className="conversation-copy"><strong>{conversation.title}</strong><small>{conversation.lastMessage || agentNames.get(conversation.agentId) || "New chat"}</small></span>
                      <span className="conversation-meta"><small>{agentNames.get(conversation.agentId)}</small><i>{timeAgo(conversation.updatedAt)}</i></span>
                    </button>
                    <div className={`conversation-delete ${confirmDeleteId === conversation.id ? "is-confirming" : ""}`}>
                      {confirmDeleteId === conversation.id ? (
                        <>
                          <button onClick={() => setConfirmDeleteId("")}>Cancel</button>
                          <button className="confirm-delete" disabled={saving} onClick={() => {
                            setSaving(true);
                            setError("");
                            void onDeleteConversation(conversation.id)
                              .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Could not delete the conversation"))
                              .finally(() => {
                                setSaving(false);
                                setConfirmDeleteId("");
                              });
                          }}>Delete chat</button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(conversation.id)} aria-label={`Delete ${conversation.title}`}>Delete</button>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            </>
          )}

          {tab === "memory" && editor === "none" && (
            <>
              <section className="memory-controls" aria-label="Memory controls">
                <label className="memory-toggle">
                  <span><strong>Use memory</strong></span>
                  <input type="checkbox" disabled={saving || memoryLoading} checked={memorySnapshot?.settings.enabled ?? true} onChange={(event) => void updateMemorySetting("enabled", event.target.checked)} />
                </label>
                <label className="memory-toggle">
                  <span><strong>Learn automatically</strong></span>
                  <input type="checkbox" disabled={saving || memoryLoading || memorySnapshot?.settings.enabled === false} checked={memorySnapshot?.settings.autoCapture ?? true} onChange={(event) => void updateMemorySetting("autoCapture", event.target.checked)} />
                </label>
                <label className="memory-toggle">
                  <span><strong>Review before saving</strong></span>
                  <input type="checkbox" disabled={saving || memoryLoading || memorySnapshot?.settings.enabled === false || memorySnapshot?.settings.autoCapture === false} checked={memorySnapshot?.settings.requireApproval ?? false} onChange={(event) => void updateMemorySetting("requireApproval", event.target.checked)} />
                </label>
              </section>

              {error && <p className="resource-error">{error}</p>}

              {pendingMemories.length > 0 && (
                <section className="pending-memory-section">
                  <header><div><span className="workspace-kicker">Needs review</span><h3>New things I noticed</h3></div><small>{pendingMemories.length}</small></header>
                  <div className="memory-list">
                    {pendingMemories.map((memory) => (
                      <article className="memory-card is-pending" key={memory.id}>
                        <div className="memory-card-heading"><span>{memoryKindLabel(memory.kind)}</span><small>{timeAgo(memory.updatedAt)}</small></div>
                        <h4>{memory.title}</h4>
                        <p>{memory.content}</p>
                        <div className="memory-card-actions">
                          <button disabled={saving} onClick={() => void postMemory({ action: "reject", id: memory.id }).catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Could not discard the memory"))}>Discard</button>
                          <button className="memory-approve" disabled={saving} onClick={() => void postMemory({ action: "approve", id: memory.id }).catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Could not approve the memory"))}>Keep memory</button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              <section className="saved-memory-section">
                <header className="memory-section-header">
                  <div><h3>{memorySnapshot?.stats.active ?? 0} saved</h3></div>
                  <label className="memory-search"><span aria-hidden="true">⌕</span><input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="Search" aria-label="Search memories" /></label>
                </header>
                {memoryLoading && !memorySnapshot && <div className="memory-empty"><strong>Loading memory…</strong></div>}
                {!memoryLoading && !visibleMemories.length && (
                  <div className="memory-empty">
                    <span>◇</span>
                    <strong>{memoryQuery ? "No matching memories" : "Nothing saved yet"}</strong>
                    <small>{memoryQuery ? "Try a different search." : "Ask the Entity to remember something, or add a detail yourself."}</small>
                  </div>
                )}
                <div className="memory-list">
                  {visibleMemories.map((memory) => (
                    <article className={`memory-card ${memory.pinned ? "is-pinned" : ""}`} key={memory.id}>
                      <div className="memory-card-heading">
                        <span>{memoryKindLabel(memory.kind)}</span>
                        <small>{memory.pinned ? "Pinned · " : ""}{timeAgo(memory.updatedAt)}</small>
                      </div>
                      <h4>{memory.title}</h4>
                      <p>{memory.content}</p>
                      <div className="memory-card-actions">
                        {confirmDeleteMemoryId === memory.id ? (
                          <>
                            <button onClick={() => setConfirmDeleteMemoryId("")}>Cancel</button>
                            <button className="memory-delete-confirm" disabled={saving} onClick={() => {
                              setSaving(true);
                              void postMemory({ action: "delete", id: memory.id })
                                .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Could not remove the memory"))
                                .finally(() => { setSaving(false); setConfirmDeleteMemoryId(""); });
                            }}>Remove</button>
                          </>
                        ) : (
                          <>
                            <button disabled={saving} onClick={() => void postMemory({ action: "update", id: memory.id, pinned: !memory.pinned }).catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Could not update the memory"))}>{memory.pinned ? "Unpin" : "Pin"}</button>
                            <button onClick={() => beginMemory(memory)}>Edit</button>
                            <button onClick={() => setConfirmDeleteMemoryId(memory.id)}>Remove</button>
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}

          {tab === "connections" && editor === "none" && (
            <ConnectionsPanel snapshot={snapshot} onRefresh={onRefresh} />
          )}

          {tab === "automations" && editor === "none" && (
            <AutomationsPanel agents={snapshot?.agents ?? []} defaultAgentId={snapshot?.defaultAgentId ?? activeAgentId} />
          )}

          {editor === "agent" && (
            <section className="workspace-form">
              <button className="back-button" onClick={() => setEditor("none")}>← Agents</button>
              <p className="form-intro">Define who this agent is, then choose only the capabilities it should be able to use.</p>
              <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Atlas" /></label>
              <label><span>Purpose</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="A thoughtful research companion" /></label>
              <label><span>Personality and instructions</span><textarea rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="How this agent should think, speak, and help..." /></label>
              <fieldset className="agent-memory-fieldset">
                <legend>Memory</legend>
                <label className="access-check">
                  <input type="checkbox" checked={memoryIsolated} onChange={(event) => setMemoryIsolated(event.target.checked)} />
                  <span><strong>Isolated memory</strong><small>Only use this agent’s private memory. When off, it also sees your personal memory so it still knows who you are.</small></span>
                </label>
                {editingAgent
                  ? <AgentMemoryManager agentId={editingAgent.id} agentName={editingAgent.name} />
                  : <p className="form-hint">Create the agent first. Then you can give it private memories here.</p>}
              </fieldset>
              <fieldset><legend>Skills</legend>{snapshot?.skills.length ? snapshot.skills.map((skill) => <label className="access-check" key={skill.id}><input type="checkbox" checked={selectedSkills.includes(skill.id)} onChange={() => toggle(selectedSkills, skill.id, setSelectedSkills)} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>) : <p>No skills yet. Add one from the Agents tab.</p>}</fieldset>
              <fieldset><legend>Connected tools</legend>{snapshot?.mcpServers.length ? snapshot.mcpServers.map((server) => <label className="access-check" key={server.id}><input type="checkbox" disabled={server.status !== "connected"} checked={selectedMcps.includes(server.id)} onChange={() => toggle(selectedMcps, server.id, setSelectedMcps)} /><span><strong>{server.name}</strong><small>{server.tools.length} tools · {server.status}</small></span></label>) : <p>No tools yet. Connect Gmail, Slack, and more from the Connections tab.</p>}</fieldset>
              {error && <p className="form-error">{error}</p>}
              <button className="workspace-primary form-submit" disabled={saving || !name.trim()} onClick={() => void saveAgent()}>{saving ? "Saving…" : editingAgent ? "Save agent" : "Create agent"}</button>
            </section>
          )}

          {editor === "skill" && (
            <SkillInstaller
              installedSlugs={snapshot?.skills.map((skill) => skill.id) ?? []}
              onBack={() => setEditor("none")}
              onInstalled={async () => { await onRefresh(); }}
            />
          )}

          {editor === "memory" && (
            <section className="workspace-form memory-form">
              <button className="back-button" onClick={() => { setEditor("none"); setEditingMemory(undefined); }}>← Personal memory</button>
              <p className="form-intro">Save a concise detail that will make future conversations more personal and useful.</p>
              <label><span>Type</span><select value={memoryKind} onChange={(event) => setMemoryKind(event.target.value as MemoryKind)}>{MEMORY_KINDS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
              <label><span>Short label</span><input value={memoryTitle} onChange={(event) => setMemoryTitle(event.target.value)} placeholder="Location, work, favorite music…" /></label>
              <label><span>What should the Entity remember?</span><textarea rows={5} value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} placeholder="I live in Fortaleza and prefer times shown in my local timezone." /></label>
              <label className="memory-importance-field"><span>Importance <small>{memoryImportance}/5</small></span><input type="range" min="1" max="5" step="1" value={memoryImportance} onChange={(event) => setMemoryImportance(Number(event.target.value))} /></label>
              <label className="memory-form-pin"><input type="checkbox" checked={memoryPinned} onChange={(event) => setMemoryPinned(event.target.checked)} /><span><strong>Keep in immediate recall</strong><small>Pinned memories are always included when the Entity responds.</small></span></label>
              {error && <p className="form-error">{error}</p>}
              <button className="workspace-primary form-submit" disabled={saving || !memoryTitle.trim() || !memoryContent.trim()} onClick={() => void saveMemory()}>{saving ? "Saving…" : editingMemory ? "Save changes" : "Add memory"}</button>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
