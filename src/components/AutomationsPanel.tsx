import { useCallback, useEffect, useState } from "react";
import type { AgentProfile } from "@/lib/app-types";

interface ScheduledTask {
  id: string;
  title: string;
  agentId: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  deliver: "conversation" | "telegram";
  goal?: string;
  maxIterations?: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastResult?: string;
  lastError?: string;
  lastVerified?: boolean;
  lastIterations?: number;
}

function whenLabel(value: number): string {
  if (!value) return "Not scheduled";
  const delta = value - Date.now();
  const minutes = Math.round(Math.abs(delta) / 60_000);
  const rel = minutes < 1 ? "under a minute" : minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
  return delta >= 0 ? `in ${rel}` : `${rel} ago`;
}

const AUTOMATIONS_CSS = `
.automation-list { display: grid; gap: 10px; }
.automation-goal { margin-top: 4px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.06); display: grid; gap: 8px; }
.automation-goal-title { color: #8fa3bb; font-size: 10px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.automation-goal-title em { margin-left: 6px; color: #5f6a77; font-style: normal; font-weight: 500; letter-spacing: 0; text-transform: none; }
.automation-goal-hint { margin: 0; color: #646e7a; font-size: 11px; line-height: 1.5; }
`;

export function AutomationsPanel({ agents, defaultAgentId }: { agents: AgentProfile[]; defaultAgentId: string }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [interval, setIntervalMinutes] = useState(60);
  const [deliver, setDeliver] = useState<"conversation" | "telegram">("conversation");
  const [goal, setGoal] = useState("");
  const [maxIterations, setMaxIterations] = useState(3);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/schedules", { cache: "no-store" });
      const data = await response.json() as { tasks?: ScheduledTask[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not load automations.");
      if (data.tasks) setTasks(data.tasks);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load automations.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const postSchedule = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The automation could not be saved");
      await load();
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The automation could not be saved");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createSchedule = async () => {
    const created = await postSchedule({
      action: "create",
      title,
      prompt,
      agentId,
      intervalMinutes: interval,
      deliver,
      startDelayMinutes: interval,
      ...(goal.trim() ? { goal: goal.trim(), maxIterations } : {}),
    });
    if (created) {
      setShowForm(false);
      setTitle("");
      setPrompt("");
      setGoal("");
    }
  };

  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? "Agent";

  return (
    <>
      <style>{AUTOMATIONS_CSS}</style>
      <div className="panel-toolbar">
        <p>Tasks run on their own cadence, even with no tab open, and can post to Telegram (set up in Connections).</p>
        <button className="workspace-primary" onClick={() => setShowForm((value) => !value)}>{showForm ? "Cancel" : "+ New task"}</button>
      </div>

      {error && <p className="form-error">{error}</p>}

      {showForm && (
        <section className="workspace-form" style={{ marginBottom: 20 }}>
          <label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Morning briefing" /></label>
          <label><span>Agent</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <label><span>Instruction</span><textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Summarize anything I asked you to track and suggest one thing to focus on today." /></label>
          <label><span>Run every (minutes) · 0 runs once</span><input type="number" min={0} value={interval} onChange={(event) => setIntervalMinutes(Number(event.target.value))} /></label>
          <label><span>Deliver result to</span><select value={deliver} onChange={(event) => setDeliver(event.target.value as "conversation" | "telegram")}><option value="conversation">Conversation only</option><option value="telegram">Conversation + Telegram</option></select></label>
          <div className="automation-goal">
            <span className="automation-goal-title">Finish line <em>optional</em></span>
            <p className="automation-goal-hint">Make it a verified loop. A separate judge model retries until the output satisfies this, or attempts run out. Leave blank for a plain heartbeat.</p>
            <label><span>Goal the output must satisfy</span><textarea rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="A dated digest with 5–8 items, each with a working source URL, a one-line claim, and why it matters. Nothing older than 24h." /></label>
            {goal.trim() && <label><span>Max attempts</span><input type="number" min={1} max={6} value={maxIterations} onChange={(event) => setMaxIterations(Number(event.target.value))} /></label>}
          </div>
          <button className="workspace-primary form-submit" disabled={busy || !title.trim() || !prompt.trim()} onClick={() => void createSchedule()}>{busy ? "Saving…" : "Create automation"}</button>
        </section>
      )}

      <section className="connections-group">
        {tasks.length > 0 && (
          <header className="connections-group-header">
            <div><span className="workspace-kicker">Scheduled</span><h4>{tasks.length} automation{tasks.length === 1 ? "" : "s"}</h4></div>
          </header>
        )}
        {!tasks.length && !showForm && (
          <div className="resource-empty"><span>◷</span><strong>No automations yet</strong><small>Create a scheduled task to let the agent act on its own.</small></div>
        )}
        <div className="automation-list">
          {tasks.map((task) => {
            const cadence = task.intervalMinutes > 0 ? `Every ${task.intervalMinutes} min` : "Runs once";
            const loopStatus = task.goal
              ? ` · verified loop${task.lastVerified === undefined ? "" : task.lastVerified ? ` (passed in ${task.lastIterations})` : ` (unverified after ${task.lastIterations})`}`
              : "";
            return (
              <article className={`connection-card ${task.enabled ? "is-live" : ""}`} key={task.id}>
                <div className="connection-card-top">
                  <span className="connection-glyph">{task.goal ? "↻" : "◷"}</span>
                  <div className="connection-card-copy">
                    <strong>{task.title}</strong>
                    <small>{cadence} · {agentName(task.agentId)} · next {whenLabel(task.nextRunAt)}</small>
                  </div>
                  <span className={`connection-status ${task.enabled ? "is-live" : "is-on"}`}>{task.enabled ? "Active" : "Paused"}</span>
                </div>
                <div className="connection-form">
                  <p className="connection-hint">{task.deliver === "telegram" ? "Delivers to conversation + Telegram" : "Delivers to conversation"}{loopStatus}</p>
                  {(task.lastError || task.lastResult) && (
                    <p className="connection-note" style={task.lastError ? { color: "#d79386" } : undefined}>
                      {task.lastError ? `Last error: ${task.lastError.slice(0, 90)}` : `Last: ${task.lastResult!.slice(0, 90)}`}
                    </p>
                  )}
                  <div className="connection-actions">
                    <button className="workspace-primary" disabled={busy} onClick={() => void postSchedule({ action: "run", id: task.id })}>Run now</button>
                    <button disabled={busy} onClick={() => void postSchedule({ action: "update", id: task.id, enabled: !task.enabled })}>{task.enabled ? "Pause" : "Resume"}</button>
                    <button disabled={busy} onClick={() => void postSchedule({ action: "delete", id: task.id })}>Delete</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
