import { Component, useCallback, useEffect, useState, type ReactNode } from "react";
import { CloseIcon, TrashIcon } from "./Icons";
import type {
  ConfigFieldDiff,
  ConfigVersion,
  EvaluationRecord,
  ImprovementProposal,
  PromotionRecord,
  WorkflowPolicy,
} from "@/lib/lab/types";

interface TraceSummary {
  runId: string;
  goal: string;
  completed: boolean;
  humanInterventions: number;
  costUsd: number;
  quality: number;
  deterministicPassed: boolean;
}

interface LabSnapshot {
  champion: ConfigVersion | null;
  history: PromotionRecord[];
  traces: TraceSummary[];
  proposals: ImprovementProposal[];
}

interface ProposalDetail {
  proposal: ImprovementProposal;
  championVersionId: string | null;
  diff: ConfigFieldDiff[];
  evaluation: EvaluationRecord | null;
}

interface Ability {
  id: string;
  name: string;
  description: string;
  status: "pending" | "approved";
}

interface GondolaLabProps {
  open: boolean;
  onClose: () => void;
  agentId?: string;
  /** The agent's chosen name (falls back to a neutral label if unset). */
  entityName?: string;
}

type Tab = "overview" | "experiments" | "runs" | "setup" | "abilities";

const CSS = `
.gl-scrim { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 24px; background: rgba(4,5,9,.62); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); animation: gl-fade .16s ease; }
@keyframes gl-fade { from { opacity: 0; } to { opacity: 1; } }
.gl-panel { display: flex; flex-direction: column; width: 100%; max-width: 1180px; height: min(90vh, 880px); border: 1px solid var(--line); border-radius: 22px; background: linear-gradient(160deg, rgba(20,22,28,.98), rgba(8,9,13,.99)); box-shadow: var(--shadow), 0 40px 100px -34px rgba(0,0,0,.85); overflow: hidden; }
.gl-head { display: flex; align-items: flex-start; gap: 14px; padding: 18px 20px 14px; }
.gl-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.gl-kicker { color: var(--mint); font-size: 8px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
.gl-head h2 { margin: 0; color: var(--ink); font-size: 17px; font-weight: 640; letter-spacing: -.02em; }
.gl-head p { margin: 0; color: var(--faint); font-size: 11.5px; max-width: 62ch; line-height: 1.5; }
.gl-close { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); background: transparent; cursor: pointer; }
.gl-close:hover { color: var(--ink); border-color: var(--line-bright); background: rgba(255,255,255,.05); }
.gl-nav { display: flex; align-items: center; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--line); }
.gl-tab { position: relative; height: 38px; padding: 0 12px; border: 0; background: transparent; color: var(--faint); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; border-bottom: 2px solid transparent; transition: color .14s; }
.gl-tab:hover { color: var(--muted); }
.gl-tab.is-active { color: var(--ink); border-bottom-color: var(--mint); }
.gl-badge { display: inline-grid; place-items: center; min-width: 16px; height: 16px; margin-left: 5px; padding: 0 4px; border-radius: 999px; background: rgba(159,183,210,.16); color: var(--aqua); font-size: 9px; font-weight: 800; vertical-align: middle; }
.gl-content { flex: 1; min-height: 0; overflow-y: auto; }
.gl-split { display: grid; grid-template-columns: 300px minmax(0,1fr); height: 100%; }
.gl-list { border-right: 1px solid var(--line); overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.gl-list h3 { margin: 8px 6px 2px; color: var(--faint); font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.gl-detail { overflow-y: auto; padding: 18px 22px; color: #ccd2da; font-size: 13px; }
.gl-detail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.gl-detail-head h3 { margin: 0; color: var(--ink); font-size: 15px; font-weight: 640; letter-spacing: -.01em; }
.gl-detail h4 { margin: 18px 0 7px; color: var(--ink); font-size: 12px; font-weight: 660; letter-spacing: .01em; }
.gl-detail p { margin: 0 0 6px; line-height: 1.6; }
.gl-detail .muted { color: var(--faint); font-size: 12px; }
.gl-row { text-align: left; border: 1px solid var(--line); border-radius: 11px; background: transparent; color: var(--ink); padding: 9px 11px; cursor: pointer; transition: border-color .14s, background .14s; display: flex; align-items: center; gap: 8px; }
.gl-row:hover { border-color: var(--line-bright); background: rgba(255,255,255,.02); }
.gl-row.is-active { border-color: rgba(184,207,232,.42); background: rgba(184,207,232,.06); }
.gl-row-main { all: unset; flex: 1; min-width: 0; cursor: pointer; display: block; }
.gl-row-title { display: block; color: var(--ink); font-size: 12px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gl-row small { display: block; color: var(--faint); font-size: 10.5px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gl-icon-btn { flex: 0 0 auto; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px; color: var(--faint); background: transparent; cursor: pointer; opacity: .45; transition: color .14s, background .14s, opacity .14s; }
.gl-row:hover .gl-icon-btn { opacity: .7; }
.gl-icon-btn:hover:not(:disabled) { color: var(--coral); background: rgba(255,142,122,.12); opacity: 1; }
.gl-icon-btn:disabled { opacity: .2; cursor: default; }
.gl-status { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.gl-status.ready_for_review, .gl-status.promoted { color: #8bbf9d; background: rgba(139,191,157,.12); }
.gl-status.failed, .gl-status.rejected, .gl-status.rolled_back { color: var(--coral); background: rgba(255,142,122,.12); }
.gl-status.draft, .gl-status.evaluating { color: var(--aqua); background: rgba(159,183,210,.12); }
.gl-page { padding: 18px 22px; display: flex; flex-direction: column; gap: 18px; }
.gl-tiles { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
.gl-tile { text-align: left; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.02); padding: 13px 14px; cursor: pointer; transition: border-color .14s, background .14s; }
.gl-tile:hover { border-color: var(--line-bright); background: rgba(255,255,255,.04); }
.gl-tile b { display: block; color: var(--ink); font-size: 22px; font-weight: 660; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.gl-tile b.good { color: #8bbf9d; }
.gl-tile span { display: block; color: var(--faint); font-size: 11px; margin-top: 2px; }
.gl-card { border: 1px solid var(--line); border-radius: 16px; background: rgba(255,255,255,.02); padding: 16px 18px; }
.gl-card h3 { margin: 0 0 4px; color: var(--ink); font-size: 13px; font-weight: 640; }
.gl-card p.sub { margin: 0 0 10px; color: var(--faint); font-size: 11.5px; }
.gl-facts { display: flex; flex-direction: column; gap: 5px; }
.gl-fact { display: flex; align-items: baseline; gap: 8px; color: #c4cbd4; font-size: 12.5px; }
.gl-fact i { width: 5px; height: 5px; border-radius: 50%; background: var(--mint); flex: 0 0 auto; transform: translateY(-2px); }
.gl-cta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.gl-cta .hint { color: var(--faint); font-size: 11.5px; }
.gl-timeline { display: flex; flex-direction: column; gap: 0; }
.gl-event { display: flex; gap: 11px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.gl-event:last-child { border-bottom: 0; }
.gl-event i { width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex: 0 0 auto; }
.gl-event.promote i { background: #8bbf9d; } .gl-event.rollback i { background: var(--coral); }
.gl-event b { color: var(--ink); font-size: 12.5px; font-weight: 560; }
.gl-event span { color: var(--faint); font-size: 11px; }
.gl-btn { height: 32px; padding: 0 14px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: rgba(255,255,255,.03); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color .14s, background .14s; }
.gl-btn:hover:not(:disabled) { border-color: var(--line-bright); background: rgba(255,255,255,.06); }
.gl-btn:disabled { opacity: .4; cursor: default; }
.gl-btn.primary { color: #11151b; background: linear-gradient(145deg, #f7f6f2, #b7c9dd); border: 0; }
.gl-btn.small { height: 27px; padding: 0 10px; font-size: 11px; }
.gl-btn.danger { color: var(--coral); border-color: rgba(255,142,122,.3); }
.gl-btn.ghost { background: transparent; color: var(--faint); }
.gl-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
.gl-table th, .gl-table td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; line-height: 1.45; }
.gl-table th { color: var(--faint); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.gl-up { color: #8bbf9d; } .gl-down { color: var(--coral); }
.gl-gate { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
.gl-gate i { width: 7px; height: 7px; border-radius: 50%; }
.gl-gate.pass i { background: #8bbf9d; } .gl-gate.fail i { background: var(--coral); }
.gl-gate small { color: var(--faint); }
.gl-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
.gl-approver { height: 32px; padding: 0 11px; border: 1px solid var(--line); border-radius: 9px; background: rgba(255,255,255,.03); color: var(--ink); font: inherit; font-size: 12px; outline: none; }
.gl-approver:focus { border-color: rgba(184,207,232,.45); }
.gl-empty { display: grid; place-items: center; height: 100%; min-height: 220px; color: var(--faint); font-size: 13px; text-align: center; padding: 24px; }
.gl-empty .gl-empty-inner { max-width: 42ch; display: flex; flex-direction: column; gap: 12px; align-items: center; }
.gl-err { color: var(--coral); font-size: 12px; margin: 8px 20px 0; }
.gl-notice { margin: 8px 20px 0; padding: 9px 12px; border: 1px solid rgba(159,183,210,.24); border-radius: 10px; color: #c4cbd4; font-size: 12px; background: rgba(159,183,210,.06); }
.gl-live-toggle { display: flex; align-items: center; gap: 6px; color: var(--faint); font-size: 11.5px; cursor: pointer; }
.gl-live-toggle input { accent-color: var(--mint); }
.gl-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--faint); background: rgba(255,255,255,.04); border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; cursor: pointer; transition: color .14s, border-color .14s; }
.gl-id:hover { color: var(--ink); border-color: var(--line-bright); }
.gl-tile.attn { border-color: rgba(139,191,157,.4); background: rgba(139,191,157,.05); }
.gl-loading { display: grid; place-items: center; height: 100%; min-height: 240px; color: var(--faint); font-size: 13px; }
.gl-skel { border-radius: 14px; background: linear-gradient(90deg, rgba(255,255,255,.03), rgba(255,255,255,.07), rgba(255,255,255,.03)); background-size: 200% 100%; animation: gl-shimmer 1.3s ease-in-out infinite; }
@keyframes gl-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.gl-skel-tile { height: 74px; }
.gl-skel-card { height: 150px; border-radius: 16px; }
.gl-tab:focus-visible, .gl-btn:focus-visible, .gl-row-main:focus-visible, .gl-tile:focus-visible, .gl-id:focus-visible, .gl-close:focus-visible, .gl-approver:focus-visible, .gl-icon-btn:focus-visible { outline: 2px solid var(--aqua); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .gl-scrim, .gl-skel { animation: none; } }
`;

const STATUS_LABEL: Record<string, string> = {
  draft: "Not tested yet",
  evaluating: "Testing",
  ready_for_review: "Ready to review",
  promoted: "Adopted",
  rejected: "Rejected",
  failed: "Didn't pass",
  rolled_back: "Reverted",
};

const GATE_LABEL: Record<string, string> = {
  no_critical_regression: "No critical regressions",
  no_replay_regression: "No regressions on known-good tasks",
  target_metric_improved: "The target actually improved",
  cost_within_tolerance: "Cost stayed within tolerance",
  no_contamination: "Test tasks were kept unseen",
  heldout_deterministic_non_regression: "Held up on unseen tasks (automatic checks)",
  no_quality_regression: "Quality didn't drop",
};

// Tolerate older/partial records that predate newer report fields, so the UI
// never crashes on a missing number.
function num(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pct(value: number | undefined | null): string {
  const safe = num(value);
  return `${safe > 0 ? "+" : ""}${safe.toFixed(1)}%`;
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function gateLabel(name: string): string {
  return GATE_LABEL[name] ?? name.replace(/_/g, " ");
}

function prettyField(field: string): string {
  const bare = field.replace("workflowPolicy.", "").replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function describeSetup(policy?: WorkflowPolicy): string[] {
  if (!policy) return [];
  return [
    `Explores ${policy.conceptCount} idea${policy.conceptCount === 1 ? "" : "s"} before choosing`,
    policy.useSeparateCritic ? "Reviews its work with a separate critic" : "No separate critic",
    policy.requireAnalyzeBeforeAnimate ? "Inspects an image before animating it" : "May animate without inspecting first",
    policy.reviseBelowQuality !== null ? `Revises up to ${policy.maxRevisions}x when quality is below ${policy.reviseBelowQuality}` : "No automatic revision",
    `Spends at most $${policy.budgetUsd.toFixed(2)} per task`,
    policy.latencyMode === "fast" ? "Speed mode: terser, less deliberation" : "Balanced speed",
  ];
}

function copyText(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(value);
}

// Copyable identifier chip (DX): shows a short id, copies the full value on click.
function IdChip({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="gl-id"
      title={`Copy ${value}`}
      onClick={() => { copyText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}
    >
      {label ? `${label} ` : ""}{copied ? "copied" : value.slice(0, 8)}
    </button>
  );
}

// Resilience: a bad record in one view must never white-screen the whole Lab.
// Keyed by tab so switching tabs (or reopening) recovers.
class LabErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return (
        <div className="gl-empty"><div className="gl-empty-inner">
          <p>Something went wrong displaying this view.</p>
          <p className="muted">Your Lab data is safe. Switch tabs or reopen the Lab.</p>
        </div></div>
      );
    }
    return this.props.children;
  }
}

export function GondolaLab({ open, onClose, agentId = "nova-default", entityName = "the agent" }: GondolaLabProps) {
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState<string>("");
  const [selectedTrace, setSelectedTrace] = useState<string>("");
  const [selectedAbility, setSelectedAbility] = useState<string>("");
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [approver, setApprover] = useState<string>(() => (typeof window !== "undefined" ? window.localStorage.getItem("gl-approver") ?? "" : ""));
  const [live, setLive] = useState(false);
  const [abilities, setAbilities] = useState<Ability[]>([]);

  const loadSnapshot = useCallback(async () => {
    const response = await fetch("/api/lab", { cache: "no-store" });
    if (response.ok) setSnapshot(await response.json() as LabSnapshot);
  }, []);

  const loadDetail = useCallback(async (proposalId: string) => {
    if (!proposalId) { setDetail(null); return; }
    const response = await fetch(`/api/lab?proposalId=${encodeURIComponent(proposalId)}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json() as ProposalDetail);
  }, []);

  const loadAbilities = useCallback(async () => {
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list_abilities", agentId }),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => ({})) as { abilities?: Ability[] };
      setAbilities(payload.abilities ?? []);
    }
  }, [agentId]);

  const actAbility = useCallback(async (action: "approve_ability" | "delete_ability", id: string) => {
    setBusy(`${action}:${id}`);
    setError("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, agentId, id, approvedBy: approver || "owner" }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
      if (action === "delete_ability" && selectedAbility === id) setSelectedAbility("");
      await loadAbilities();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy("");
    }
  }, [agentId, approver, loadAbilities, selectedAbility]);

  useEffect(() => {
    if (open) { void loadSnapshot(); void loadAbilities(); }
  }, [open, loadSnapshot, loadAbilities]);

  useEffect(() => {
    if (open && selected) void loadDetail(selected);
  }, [open, selected, loadDetail]);

  const act = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; proposal?: ImprovementProposal | null };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
      await loadSnapshot();
      if (selected) await loadDetail(selected);
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
      return undefined;
    } finally {
      setBusy("");
    }
  }, [loadSnapshot, loadDetail, selected]);

  // Generate (if there's something new) and immediately run the checks, so one
  // click produces a visible result instead of a silently-drafted proposal.
  const runChecks = useCallback(async (proposalId: string) => {
    setTab("experiments");
    setSelected(proposalId);
    await act("evaluate_proposal", { proposalId, live });
  }, [act, live]);

  const lookForImprovements = useCallback(async () => {
    const payload = await act("generate_proposal");
    if (!payload) return;
    if (payload.proposal) {
      await runChecks(payload.proposal.proposalId);
      return;
    }
    // Nothing new to propose. Still make the click useful: if an experiment is
    // drafted but its checks never ran, run them; if one is ready, jump to it.
    const pending = snapshot?.proposals.find((item) => item.status === "draft" || item.status === "evaluating");
    if (pending) { await runChecks(pending.proposalId); return; }
    const ready = snapshot?.proposals.find((item) => item.status === "ready_for_review");
    if (ready) {
      setTab("experiments");
      setSelected(ready.proposalId);
      setNotice("No new patterns right now. Your existing experiment is ready for review below.");
      return;
    }
    setNotice(`No new patterns to test right now. ${entityName} needs to run more tasks (or flag a problem) before there is something to improve.`);
  }, [act, runChecks, snapshot, entityName]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Remember the approver name across sessions so it never has to be retyped.
  useEffect(() => {
    if (typeof window !== "undefined" && approver.trim()) window.localStorage.setItem("gl-approver", approver.trim());
  }, [approver]);

  // Open a tab straight into its first item so the detail pane is never empty.
  useEffect(() => {
    if (!snapshot) return;
    if (tab === "experiments" && !selected && snapshot.proposals[0]) setSelected(snapshot.proposals[0].proposalId);
    if (tab === "runs" && !selectedTrace && snapshot.traces[0]) setSelectedTrace(snapshot.traces[0].runId);
    if (tab === "abilities" && !selectedAbility && abilities[0]) setSelectedAbility(abilities[0].id);
  }, [tab, snapshot, abilities, selected, selectedTrace, selectedAbility]);

  if (!open) return null;

  const champion = snapshot?.champion;
  const policy = champion?.config.workflowPolicy;
  const proposals = snapshot?.proposals ?? [];
  const traces = snapshot?.traces ?? [];
  const history = snapshot?.history ?? [];
  const pendingAbilities = abilities.filter((ability) => ability.status === "pending");
  const approvedAbilities = abilities.filter((ability) => ability.status === "approved");
  const proposal = detail?.proposal;
  const report = detail?.evaluation?.report;

  const readyCount = proposals.filter((item) => item.status === "ready_for_review").length;
  const adoptedCount = proposals.filter((item) => item.status === "promoted").length;
  const progressCount = proposals.filter((item) => item.status === "draft" || item.status === "evaluating").length;
  const rejectedCount = proposals.filter((item) => item.status === "rejected" || item.status === "failed" || item.status === "rolled_back").length;
  const nothingYet = proposals.length === 0 && traces.length === 0;
  const canRevert = history.some((record) => record.action === "promote");
  const canUndoRevert = history[history.length - 1]?.action === "rollback";

  const versionName = (id: string | null | undefined) => (id ? id.slice(0, 8) : "none");

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "experiments", label: "Experiments", badge: readyCount || undefined },
    { id: "runs", label: "Runs" },
    { id: "setup", label: "Setup and history" },
    { id: "abilities", label: "Abilities", badge: pendingAbilities.length || undefined },
  ];

  const selectedAbilityData = abilities.find((ability) => ability.id === selectedAbility);
  const selectedTraceData = traces.find((trace) => trace.runId === selectedTrace);

  return (
    <div className="gl-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <style>{CSS}</style>
      <section className="gl-panel" role="dialog" aria-modal="true" aria-label="Gondola Lab">
        <header className="gl-head">
          <div className="gl-titles">
            <span className="gl-kicker">Gondola Lab</span>
            <h2>Research on {entityName}</h2>
            <p>A research lab with one subject: {entityName}. It finds what recurs, tests improvements against the current setup, and adopts only what proves out, with your approval.</p>
          </div>
          <button className="gl-close" onClick={onClose} aria-label="Close Gondola Lab"><CloseIcon size={16} /></button>
        </header>

        <nav className="gl-nav" role="tablist" aria-label="Gondola Lab sections">
          {tabs.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={`gl-tab${tab === entry.id ? " is-active" : ""}`} onClick={() => setTab(entry.id)}>
              {entry.label}{entry.badge ? <span className="gl-badge">{entry.badge}</span> : null}
            </button>
          ))}
        </nav>

        {error ? <div className="gl-err">{error}</div> : null}
        {notice ? <div className="gl-notice">{notice}</div> : null}

        <div className="gl-content">
          <LabErrorBoundary key={tab}>
          {!snapshot ? (
            <div className="gl-page" aria-busy="true">
              <div className="gl-tiles">
                {Array.from({ length: 6 }).map((_, index) => <div key={index} className="gl-skel gl-skel-tile" />)}
              </div>
              <div className="gl-skel gl-skel-card" />
            </div>
          ) : (
          <>
          {/* Overview */}
          {tab === "overview" && (
            nothingYet ? (
              <div className="gl-empty">
                <div className="gl-empty-inner">
                  <p>The Lab has not watched {entityName} work yet, so there is nothing to study.</p>
                  <p className="muted">Let {entityName} run some tasks, or load a few sample runs to explore how the Lab works.</p>
                  <button className="gl-btn primary" disabled={Boolean(busy)} onClick={() => { void act("seed_demo").then(() => setNotice("Loaded sample runs. Try \u201cLook for improvements\u201d to see the Lab propose a test.")); }}>Load sample data</button>
                </div>
              </div>
            ) : (
              <div className="gl-page">
                <div className="gl-tiles">
                  <button className={`gl-tile${readyCount ? " attn" : ""}`} onClick={() => setTab("experiments")}><b className={readyCount ? "good" : ""}>{readyCount}</b><span>Ready to review</span></button>
                  <button className="gl-tile" onClick={() => setTab("experiments")}><b>{progressCount}</b><span>In progress</span></button>
                  <button className="gl-tile" onClick={() => setTab("experiments")}><b>{adoptedCount}</b><span>Adopted changes</span></button>
                  <button className="gl-tile" onClick={() => setTab("experiments")}><b>{rejectedCount}</b><span>Ruled out</span></button>
                  <button className="gl-tile" onClick={() => setTab("runs")}><b>{traces.length}</b><span>Runs recorded</span></button>
                  <button className={`gl-tile${pendingAbilities.length ? " attn" : ""}`} onClick={() => setTab("abilities")}><b className={pendingAbilities.length ? "good" : ""}>{pendingAbilities.length}</b><span>Abilities awaiting you</span></button>
                </div>

                <div className="gl-card">
                  <h3>Look for improvements</h3>
                  <p className="sub">The Lab scans recent runs for recurring problems and, if it finds one worth testing, sets up an experiment against the current setup.</p>
                  <div className="gl-cta">
                    <button className="gl-btn primary" disabled={Boolean(busy)} onClick={() => void lookForImprovements()}>Look for improvements</button>
                    <span className="hint">Nothing is ever adopted without your approval.</span>
                  </div>
                </div>

                <div className="gl-card">
                  <h3>Current setup</h3>
                  <p className="sub">What {entityName} uses right now · version {versionName(champion?.versionId)}</p>
                  <div className="gl-facts">
                    {describeSetup(policy).map((fact) => (
                      <div key={fact} className="gl-fact"><i />{fact}</div>
                    ))}
                  </div>
                  <div className="gl-cta" style={{ marginTop: 12 }}>
                    <button className="gl-btn small ghost" onClick={() => setTab("setup")}>View setup and history</button>
                  </div>
                </div>
              </div>
            )
          )}

          {/* Experiments */}
          {tab === "experiments" && (
            <div className="gl-split">
              <div className="gl-list">
                <div className="gl-cta" style={{ marginBottom: 4 }}>
                  <button className="gl-btn primary small" disabled={Boolean(busy)} onClick={() => void lookForImprovements()}>Look for improvements</button>
                </div>
                {proposals.length ? proposals.map((item) => (
                  <div key={item.proposalId} className={`gl-row${selected === item.proposalId ? " is-active" : ""}`}>
                    <button type="button" className="gl-row-main" onClick={() => setSelected(item.proposalId)}>
                      <span className={`gl-status ${item.status}`}>{statusLabel(item.status)}</span>
                      <small style={{ marginTop: 5 }}>{item.observedProblem}</small>
                    </button>
                    <button type="button" className="gl-icon-btn" title="Delete experiment" aria-label="Delete experiment" disabled={Boolean(busy)} onClick={() => {
                      const id = item.proposalId;
                      void act("delete_proposal", { proposalId: id }).then(() => { if (selected === id) { setSelected(""); setDetail(null); } });
                    }}>
                      <TrashIcon size={14} />
                    </button>
                  </div>
                )) : <p className="muted" style={{ margin: "6px" }}>No experiments yet. Use the Look for improvements button to create one.</p>}
              </div>

              <div className="gl-detail">
                {!proposal ? (
                  <div className="gl-empty">Pick an experiment to see the idea, the test, and the result.</div>
                ) : (
                  <>
                    <div className="gl-detail-head">
                      <span className={`gl-status ${proposal.status}`}>{statusLabel(proposal.status)}</span>
                      <h3>{proposal.observedProblem}</h3>
                    </div>

                    <h4>The idea</h4>
                    <p className="muted">{proposal.hypothesis}</p>
                    <p className="muted">Based on {proposal.traceEvidence?.length ?? 0} run(s) · aims to improve {(proposal.targetMetric ?? "quality").replace(/_/g, " ")} · {proposal.riskLevel} risk</p>
                    <p className="muted">Created {new Date(proposal.createdAt).toLocaleString()}{detail?.evaluation ? <> · evaluation <IdChip value={detail.evaluation.evaluationId} /> · seed {detail.evaluation.seed}</> : null}</p>
                    {proposal.proposerFeedback ? <p className="muted">Prior context: {proposal.proposerFeedback}</p> : null}

                    <h4>What would change</h4>
                    {detail?.diff.length ? (
                      <table className="gl-table">
                        <thead><tr><th>Setting</th><th>Now</th><th>Variation</th></tr></thead>
                        <tbody>
                          {detail.diff.map((change) => (
                            <tr key={change.field}><td>{prettyField(change.field)}</td><td>{String(change.from)}</td><td>{String(change.to)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <p className="muted">No settings change.</p>}

                    {proposal.status === "draft" && (
                      <div className="gl-actions">
                        <button className="gl-btn primary" disabled={Boolean(busy)} onClick={() => void act("evaluate_proposal", { proposalId: proposal.proposalId, live })}>{live ? "Run real test" : "Run test"}</button>
                        <label className="gl-live-toggle"><input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} /> Real inference (spends budget)</label>
                      </div>
                    )}

                    {report ? (
                      <>
                        <h4>Result</h4>
                        <p className="muted">Judged on <strong>{(report.targetMetric ?? "quality").replace(/_/g, " ")}</strong>: {pct(report.targetImprovementPct)} {num(report.targetImprovementPct) >= 0 ? "better" : "worse"}.</p>
                        <table className="gl-table">
                          <thead><tr><th scope="col">Measure</th><th scope="col">Now</th><th scope="col">Variation</th><th scope="col">Δ</th></tr></thead>
                          <tbody>
                            <tr><td>Quality</td><td>{num(report.championQuality).toFixed(1)}</td><td>{num(report.challengerQuality).toFixed(1)}</td><td className={num(report.qualityDeltaPct) >= 0 ? "gl-up" : "gl-down"}>{pct(report.qualityDeltaPct)}</td></tr>
                            <tr><td>Completion</td><td>{num(report.championCompletionPct).toFixed(0)}%</td><td>{num(report.challengerCompletionPct).toFixed(0)}%</td><td className={num(report.challengerCompletionPct) >= num(report.championCompletionPct) ? "gl-up" : "gl-down"}>{(num(report.challengerCompletionPct) - num(report.championCompletionPct)).toFixed(0)} pts</td></tr>
                            <tr><td>Held-out (auto checks)</td><td>{num(report.championHeldOutPassRate).toFixed(0)}%</td><td>{num(report.challengerHeldOutPassRate).toFixed(0)}%</td><td className={num(report.challengerHeldOutPassRate) >= num(report.championHeldOutPassRate) ? "gl-up" : "gl-down"}>{(num(report.challengerHeldOutPassRate) - num(report.championHeldOutPassRate)).toFixed(0)} pts</td></tr>
                            <tr><td>Cost (total)</td><td>${num(report.championCost).toFixed(2)}</td><td>${num(report.challengerCost).toFixed(2)}</td><td className={num(report.costDeltaPct) <= 0 ? "gl-up" : "gl-down"}>{pct(report.costDeltaPct)}</td></tr>
                            <tr><td>Human interventions</td><td>{num(report.championInterventions)}</td><td>{num(report.challengerInterventions)}</td><td /></tr>
                          </tbody>
                        </table>

                        <h4>Checks</h4>
                        {report.gates.map((gate) => (
                          <div key={gate.name} className={`gl-gate ${gate.passed ? "pass" : "fail"}`}><i />{gateLabel(gate.name)} <small>{gate.detail}</small></div>
                        ))}
                        {report.replayRegressions.length ? <p className="gl-down" style={{ marginTop: 8 }}>Regressed on known-good tasks: {report.replayRegressions.join(", ")}</p> : null}

                        <div className="gl-actions">
                          <input className="gl-approver" placeholder="Your name (to approve)" value={approver} onChange={(event) => setApprover(event.target.value)} />
                          <button className="gl-btn primary" disabled={Boolean(busy) || proposal.status !== "ready_for_review" || !approver.trim()} onClick={() => void act("promote", { proposalId: proposal.proposalId, approvedBy: approver })}>
                            {proposal.status === "promoted" ? "Adopted" : "Adopt this change"}
                          </button>
                          <button className="gl-btn danger" disabled={Boolean(busy) || ["promoted", "rejected", "rolled_back"].includes(proposal.status)} onClick={() => void act("reject", { proposalId: proposal.proposalId })}>Reject</button>
                          {proposal.status !== "promoted" ? <button className="gl-btn" disabled={Boolean(busy)} onClick={() => void act("evaluate_proposal", { proposalId: proposal.proposalId, live })}>Run checks again</button> : null}
                          {proposal.status === "ready_for_review" && proposal.autonomyTier === "auto" ? <span className="muted">Safe enough to adopt on its own when autopilot is on (deterministic, held-out, low-risk).</span> : null}
                          {proposal.autonomyTier === "protected" ? <span className="muted">This kind of change always needs you.</span> : null}
                          {proposal.status !== "ready_for_review" && proposal.status !== "promoted" ? <span className="muted">Only an experiment that passes every check can be adopted.</span> : null}
                        </div>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Runs */}
          {tab === "runs" && (
            <div className="gl-split">
              <div className="gl-list">
                {traces.length ? traces.map((trace) => (
                  <div key={trace.runId} className={`gl-row${selectedTrace === trace.runId ? " is-active" : ""}`}>
                    <button type="button" className="gl-row-main" onClick={() => setSelectedTrace(trace.runId)}>
                      <span className="gl-row-title">{trace.goal.slice(0, 52) || "Untitled run"}</span>
                      <small>{trace.completed ? "completed" : "did not finish"} · ${trace.costUsd.toFixed(2)} · {trace.deterministicPassed ? "checks pass" : "checks fail"}</small>
                    </button>
                  </div>
                )) : <p className="muted" style={{ margin: "6px" }}>No runs recorded yet.</p>}
              </div>
              <div className="gl-detail">
                {!selectedTraceData ? (
                  <div className="gl-empty">Pick a run to inspect what happened.</div>
                ) : (
                  <>
                    <div className="gl-detail-head">
                      <span className={`gl-status ${selectedTraceData.completed ? "promoted" : "failed"}`}>{selectedTraceData.completed ? "Completed" : "Did not finish"}</span>
                      <h3>{selectedTraceData.goal || "Untitled run"}</h3>
                    </div>
                    <table className="gl-table">
                      <tbody>
                        <tr><td>Automatic checks</td><td className={selectedTraceData.deterministicPassed ? "gl-up" : "gl-down"}>{selectedTraceData.deterministicPassed ? "passed" : "failed"}</td></tr>
                        <tr><td>Quality (judge)</td><td>{selectedTraceData.quality.toFixed(1)} / 10</td></tr>
                        <tr><td>Cost</td><td>${selectedTraceData.costUsd.toFixed(2)}</td></tr>
                        <tr><td>Human interventions</td><td>{selectedTraceData.humanInterventions}</td></tr>
                        <tr><td>Run id</td><td><IdChip value={selectedTraceData.runId} /></td></tr>
                      </tbody>
                    </table>
                    <p className="muted" style={{ marginTop: 12 }}>These runs are the raw evidence the Lab studies. Recurring problems across runs become experiments.</p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Setup and history */}
          {tab === "setup" && (
            <div className="gl-page">
              <div className="gl-card">
                <h3>Current setup</h3>
                <p className="sub">What {entityName} uses right now{champion?.changeSummary ? ` · ${champion.changeSummary}` : ""}</p>
                {champion ? <div style={{ margin: "0 0 10px" }}><IdChip label="version" value={champion.versionId} /></div> : null}
                <div className="gl-facts">
                  {describeSetup(policy).map((fact) => (
                    <div key={fact} className="gl-fact"><i />{fact}</div>
                  ))}
                </div>
              </div>

              <div className="gl-card">
                <h3>History</h3>
                <p className="sub">Every change to the setup is recorded and reversible.</p>
                {history.length ? (
                  <div className="gl-timeline">
                    {[...history].reverse().map((record, index) => (
                      <div key={`${record.approvedAt}-${index}`} className={`gl-event ${record.action}`}>
                        <i />
                        <div>
                          <b>{record.action === "promote" ? `Adopted version ${versionName(record.toVersionId)}` : `Reverted to version ${versionName(record.toVersionId)}`}</b>
                          <div><span>by {record.approvedBy} · {new Date(record.approvedAt).toLocaleString()}</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <p className="muted">No changes yet. {entityName} is on the original setup.</p>}

                {(canRevert || canUndoRevert) && (
                  <div className="gl-actions">
                    <input className="gl-approver" placeholder="Your name" value={approver} onChange={(event) => setApprover(event.target.value)} />
                    {canRevert ? <button className="gl-btn small" disabled={Boolean(busy)} onClick={() => void act("rollback", { approvedBy: approver || "user" })}>Revert to previous setup</button> : null}
                    {canUndoRevert ? <button className="gl-btn small ghost" disabled={Boolean(busy)} onClick={() => void act("undo_rollback", { approvedBy: approver || "user" })}>Undo the revert</button> : null}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Abilities */}
          {tab === "abilities" && (
            <div className="gl-split">
              <div className="gl-list">
                <h3>Awaiting you</h3>
                {pendingAbilities.length ? pendingAbilities.map((ability) => (
                  <div key={ability.id} className={`gl-row${selectedAbility === ability.id ? " is-active" : ""}`}>
                    <button type="button" className="gl-row-main" onClick={() => setSelectedAbility(ability.id)}>
                      <span className="gl-row-title">{ability.name}</span>
                      <small>{ability.description}</small>
                    </button>
                  </div>
                )) : <p className="muted" style={{ margin: "6px" }}>Nothing awaiting approval.</p>}

                <h3>Approved</h3>
                {approvedAbilities.length ? approvedAbilities.map((ability) => (
                  <div key={ability.id} className={`gl-row${selectedAbility === ability.id ? " is-active" : ""}`}>
                    <button type="button" className="gl-row-main" onClick={() => setSelectedAbility(ability.id)}>
                      <span className="gl-row-title">{ability.name}</span>
                      <small>{ability.description}</small>
                    </button>
                    <button type="button" className="gl-icon-btn" title="Remove ability" aria-label="Remove ability" disabled={Boolean(busy)} onClick={() => void actAbility("delete_ability", ability.id)}>
                      <TrashIcon size={14} />
                    </button>
                  </div>
                )) : <p className="muted" style={{ margin: "6px" }}>No approved abilities yet.</p>}
              </div>

              <div className="gl-detail">
                {!selectedAbilityData ? (
                  <div className="gl-empty">Pick an ability to see what it does.</div>
                ) : (
                  <>
                    <div className="gl-detail-head">
                      <span className={`gl-status ${selectedAbilityData.status === "approved" ? "promoted" : "draft"}`}>{selectedAbilityData.status === "approved" ? "Approved" : "Awaiting you"}</span>
                      <h3>{selectedAbilityData.name}</h3>
                    </div>
                    <h4>What it does</h4>
                    <p className="muted">{selectedAbilityData.description}</p>
                    <div className="gl-actions">
                      {selectedAbilityData.status === "pending" ? (
                        <>
                          <input className="gl-approver" placeholder="Your name" value={approver} onChange={(event) => setApprover(event.target.value)} />
                          <button className="gl-btn primary" disabled={Boolean(busy)} onClick={() => void actAbility("approve_ability", selectedAbilityData.id)}>Approve</button>
                          <button className="gl-btn danger" disabled={Boolean(busy)} onClick={() => void actAbility("delete_ability", selectedAbilityData.id)}>Reject</button>
                        </>
                      ) : (
                        <button className="gl-btn danger" disabled={Boolean(busy)} onClick={() => void actAbility("delete_ability", selectedAbilityData.id)}>Remove ability</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          </>
          )}
          </LabErrorBoundary>
        </div>
      </section>
    </div>
  );
}
