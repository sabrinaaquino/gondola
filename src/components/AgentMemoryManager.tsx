import { useCallback, useEffect, useState } from "react";
import type { MemoryKind, MemorySnapshot, PersonalMemoryEntry } from "@/lib/app-types";

const MEMORY_KINDS: Array<{ value: MemoryKind; label: string }> = [
  { value: "bio", label: "Bio" },
  { value: "preference", label: "Preference" },
  { value: "important", label: "Important note" },
  { value: "project", label: "Project" },
  { value: "relationship", label: "Person or relationship" },
  { value: "environment", label: "Environment" },
  { value: "other", label: "Other" },
];

export function AgentMemoryManager({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [entries, setEntries] = useState<PersonalMemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<MemoryKind>("important");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/memory?agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" });
      const data = await response.json() as MemorySnapshot & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Memory could not be loaded");
      setEntries((data.entries ?? []).filter((entry) => entry.status === "active"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Memory could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", agentId, kind, title, content }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The memory could not be saved");
      setTitle("");
      setContent("");
      setAdding(false);
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The memory could not be saved");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The memory could not be removed");
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The memory could not be removed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-memory">
      <div className="agent-memory-head">
        <div>
          <strong>{agentName}’s memory</strong>
          <small>Private to this agent. It also learns on its own as you chat.</small>
        </div>
        <button type="button" onClick={() => setAdding((value) => !value)}>{adding ? "Cancel" : "+ Add"}</button>
      </div>

      {error && <p className="form-error">{error}</p>}

      {adding && (
        <div className="agent-memory-form">
          <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Short label" />
          <textarea rows={2} value={content} onChange={(event) => setContent(event.target.value)} placeholder="What should this agent always remember?" />
          <button type="button" className="workspace-primary" disabled={busy || !title.trim() || !content.trim()} onClick={() => void add()}>{busy ? "Saving…" : "Save memory"}</button>
        </div>
      )}

      <div className="agent-memory-list">
        {loading && !entries.length && <p className="agent-memory-empty">Loading…</p>}
        {!loading && !entries.length && <p className="agent-memory-empty">No private memories yet. Add one, or let this agent learn as you talk.</p>}
        {entries.map((entry) => (
          <div className="agent-memory-item" key={entry.id}>
            <div><strong>{entry.title}</strong><small>{entry.content}</small></div>
            <button type="button" disabled={busy} onClick={() => void remove(entry.id)} aria-label={`Remove ${entry.title}`}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}
