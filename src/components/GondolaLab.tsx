import { useCallback, useEffect, useState } from "react";
import { CloseIcon } from "./Icons";
import type {
  ConfigFieldDiff,
  ConfigVersion,
  EvaluationRecord,
  ImprovementProposal,
  PromotionRecord,
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
}

// Styled to match the app's control-center chrome (see .settings-modal in
// globals.css): the same scrim, panel surface, radius, header, buttons, and
// desaturated token palette, so the Lab reads as part of the app, not a bolt-on.
const CSS = `
.gl-scrim { position: fixed; z-index: 88; inset: 0; visibility: hidden; border: 0; background: rgba(1,5,4,0); -webkit-backdrop-filter: blur(0); backdrop-filter: blur(0); cursor: default; transition: 280ms ease; }
.gl-scrim.is-open { visibility: visible; background: rgba(1,5,4,.54); -webkit-backdrop-filter: blur(7px); backdrop-filter: blur(7px); }
.gl-modal { position: fixed; z-index: 89; top: 50%; left: 50%; width: min(1080px, calc(100vw - 40px)); height: min(680px, calc(100vh - 64px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-bright); border-radius: 20px; background: var(--panel-strong); -webkit-backdrop-filter: blur(22px); backdrop-filter: blur(22px); box-shadow: var(--shadow); opacity: 0; visibility: hidden; pointer-events: none; transform: translate(-50%, -47%) scale(.985); transition: opacity 200ms ease, transform 240ms cubic-bezier(.2,.8,.2,1), visibility 200ms ease; }
.gl-modal.is-open { opacity: 1; visibility: visible; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
.gl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 18px 16px 24px; border-bottom: 1px solid var(--line); }
.gl-head h2 { margin: 0; font-size: 18px; font-weight: 640; letter-spacing: -.01em; color: var(--ink); }
.gl-head p { margin: 3px 0 0; max-width: 560px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.gl-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 24px; border-bottom: 1px solid var(--line); }
.gl-btn { height: 34px; padding: 0 14px; display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 11px; color: var(--ink); background: rgba(255,255,255,.035); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color 180ms ease, background 180ms ease, color 180ms ease; }
.gl-btn:hover:not(:disabled) { border-color: var(--line-bright); background: rgba(255,255,255,.065); }
.gl-btn:disabled { opacity: .4; cursor: default; }
.gl-btn.primary { color: #11151b; background: linear-gradient(145deg, #f7f6f2, #b7c9dd); border: 0; font-weight: 650; }
.gl-btn.primary:hover:not(:disabled) { background: linear-gradient(145deg, #ffffff, #c4d2e2); }
.gl-btn.danger { color: var(--coral); border-color: rgba(255,142,122,.28); background: rgba(255,142,122,.06); }
.gl-btn.danger:hover:not(:disabled) { border-color: rgba(255,142,122,.5); background: rgba(255,142,122,.1); }
.gl-champ { margin-left: auto; display: flex; align-items: center; gap: 7px; color: var(--faint); font-size: 11px; }
.gl-champ b { color: var(--mint); font-weight: 640; font-variant-numeric: tabular-nums; }
.gl-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 248px minmax(0,1fr); }
.gl-rail { border-right: 1px solid var(--line); overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 4px; }
.gl-rail h3 { margin: 14px 8px 5px; color: #6b727f; font-size: 8.5px; font-weight: 680; letter-spacing: .12em; text-transform: uppercase; }
.gl-rail h3:first-child { margin-top: 2px; }
.gl-prop { text-align: left; border: 1px solid transparent; border-radius: 11px; background: transparent; color: var(--ink); padding: 9px 11px; cursor: pointer; transition: background .12s ease, color .12s ease, border-color .12s ease; }
.gl-prop:hover { background: rgba(255,255,255,.03); }
.gl-prop.is-active { background: rgba(205,208,214,.09); border-color: var(--line-bright); }
.gl-prop small, .gl-card small { display: block; color: var(--faint); font-size: 10.5px; margin-top: 3px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gl-card { border: 1px solid var(--line); border-radius: 11px; background: rgba(255,255,255,.015); padding: 9px 11px; }
.gl-card strong { display: block; color: var(--ink); font-size: 12px; font-weight: 600; }
.gl-status { display: inline-block; padding: 1.5px 8px; border-radius: 999px; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.gl-status.ready_for_review, .gl-status.promoted, .gl-status.approved { color: #93c9a8; background: rgba(147,201,168,.12); }
.gl-status.failed, .gl-status.rejected, .gl-status.rolled_back { color: var(--coral); background: rgba(255,142,122,.12); }
.gl-status.draft, .gl-status.evaluating, .gl-status.pending { color: var(--amber); background: rgba(255,202,112,.12); }
.gl-detail { overflow-y: auto; padding: 20px 24px 26px; color: var(--muted); font-size: 13px; }
.gl-detail h4 { margin: 18px 0 8px; color: var(--ink); font-size: 13px; font-weight: 640; letter-spacing: -.005em; }
.gl-detail h4:first-child { margin-top: 0; }
.gl-detail p { margin: 0 0 7px; line-height: 1.6; color: #c3c8d0; }
.gl-detail .muted { color: var(--faint); font-size: 12px; }
.gl-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
.gl-table th, .gl-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.gl-table th { color: #6b727f; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; }
.gl-table td { color: #c3c8d0; }
.gl-up { color: #93c9a8; } .gl-down { color: var(--coral); }
.gl-gate { display: flex; align-items: center; gap: 9px; padding: 5px 0; font-size: 12px; color: #c3c8d0; }
.gl-gate i { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.gl-gate.pass i { background: #93c9a8; box-shadow: 0 0 8px rgba(147,201,168,.5); }
.gl-gate.fail i { background: var(--coral); box-shadow: 0 0 8px rgba(255,142,122,.5); }
.gl-gate small { color: var(--faint); }
.gl-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
.gl-approver { height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 11px; background: rgba(255,255,255,.035); color: var(--ink); font: inherit; font-size: 12px; outline: none; transition: border-color 180ms ease; }
.gl-approver:focus { border-color: var(--line-bright); }
.gl-approver::placeholder { color: var(--faint); }
.gl-empty { display: grid; place-items: center; height: 100%; color: var(--faint); font-size: 13px; text-align: center; padding: 24px; line-height: 1.6; }
.gl-err { color: var(--coral); font-size: 12px; margin: 10px 24px 0; }
.gl-live-toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 11.5px; cursor: pointer; }
.gl-live-toggle input { width: 14px; height: 14px; accent-color: var(--mint); cursor: pointer; }
.gl-mini { display: flex; gap: 6px; margin-top: 8px; }
.gl-mini .gl-btn { height: 28px; padding: 0 11px; font-size: 11px; }
.gl-flow { display: flex; align-items: center; gap: 0; padding: 11px 24px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.gl-step { display: flex; align-items: center; gap: 7px; padding: 0 12px; white-space: nowrap; }
.gl-step:not(:first-child)::before { content: ""; width: 16px; height: 1px; background: var(--line-bright); margin-right: 4px; }
.gl-step-dot { width: 8px; height: 8px; border-radius: 50%; background: #3a3f48; flex: 0 0 auto; }
.gl-step-label { font-size: 11px; font-weight: 600; color: var(--faint); }
.gl-step.done .gl-step-dot { background: #93c9a8; }
.gl-step.done .gl-step-label { color: var(--muted); }
.gl-step.current .gl-step-dot { background: var(--mint); box-shadow: 0 0 9px rgba(201,204,210,.6); }
.gl-step.current .gl-step-label { color: var(--ink); }
.gl-step.fail .gl-step-dot { background: var(--coral); box-shadow: 0 0 9px rgba(255,142,122,.5); }
.gl-step.fail .gl-step-label { color: var(--coral); }
.gl-intro { max-width: 520px; }
.gl-intro h3 { margin: 0 0 8px; color: var(--ink); font-size: 15px; font-weight: 640; }
.gl-intro > p { margin: 0 0 14px; color: #c3c8d0; font-size: 13px; line-height: 1.6; }
.gl-note { padding: 11px 13px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.015); color: var(--muted); font-size: 12px; line-height: 1.55; }
.gl-note b { color: var(--ink); }
@media (max-width: 720px) {
  .gl-modal { width: calc(100vw - 24px); height: min(90vh, calc(100vh - 28px)); }
  .gl-body { grid-template-columns: 1fr; }
  .gl-rail { border-right: 0; border-bottom: 1px solid var(--line); max-height: 200px; }
}
`;

function pct(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

// The self-improvement loop, in plain language, so the panel explains itself.
const STAGES = [
  { key: "traces", label: "Traces", hint: "Every run the agent does is recorded as evidence the Lab learns from." },
  { key: "proposal", label: "Proposal", hint: "The Lab drafts one small, bounded change tied to a recurring problem." },
  { key: "evaluation", label: "Evaluation", hint: "Run the proposed change against the current setup on the same test tasks." },
  { key: "gates", label: "Gates", hint: "Automatic safety checks: better quality, no regressions, within budget." },
  { key: "approval", label: "Approval", hint: "You review and approve. Nothing is promoted on its own." },
  { key: "live", label: "Live", hint: "Approved changes drive the live agent, and can be rolled back." },
];

// Where a proposal sits in the loop, so the stepper can highlight it.
function stageForStatus(status?: string): { index: number; failed: boolean } {
  switch (status) {
    case "draft":
    case "evaluating": return { index: 2, failed: false };
    case "failed": return { index: 3, failed: true };
    case "ready_for_review": return { index: 4, failed: false };
    case "approved":
    case "promoted": return { index: 5, failed: false };
    case "rejected": return { index: 4, failed: true };
    case "rolled_back": return { index: 5, failed: true };
    default: return { index: -1, failed: false };
  }
}

export function GondolaLab({ open, onClose, agentId = "nova-default" }: GondolaLabProps) {
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [approver, setApprover] = useState("");
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
      await loadAbilities();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy("");
    }
  }, [agentId, approver, loadAbilities]);

  useEffect(() => {
    if (open) { void loadSnapshot(); void loadAbilities(); }
  }, [open, loadSnapshot, loadAbilities]);

  useEffect(() => {
    if (open && selected) void loadDetail(selected);
  }, [open, selected, loadDetail]);

  const act = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setError("");
    try {
      const response = await fetch("/api/lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; proposal?: ImprovementProposal | null };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
      if (action === "generate_proposal" && payload.proposal) setSelected(payload.proposal.proposalId);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const champion = snapshot?.champion;
  const policy = champion?.config.workflowPolicy;
  const proposal = detail?.proposal;
  const report = detail?.evaluation?.report;
  const pendingAbilities = abilities.filter((ability) => ability.status === "pending");
  const flow = proposal ? stageForStatus(proposal.status) : { index: -1, failed: false };

  return (
    <>
      <style>{CSS}</style>
      <button className={`gl-scrim ${open ? "is-open" : ""}`} onClick={onClose} aria-label="Dismiss Gondola Lab" tabIndex={open ? 0 : -1} />
      <section className={`gl-modal ${open ? "is-open" : ""}`} role="dialog" aria-modal="true" aria-label="Gondola Lab" aria-hidden={!open}>
        <header className="gl-head">
          <div>
            <h2>Gondola Lab</h2>
            <p>Proposes safe changes to the agent, and promotes them only after you approve.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close Gondola Lab"><CloseIcon size={20} /></button>
        </header>

        <div className="gl-toolbar">
          <button className="gl-btn" disabled={Boolean(busy)} title="Create example runs so you can see the Lab work without waiting for real usage." onClick={() => void act("seed_demo")}>Seed demo run</button>
          <button className="gl-btn primary" disabled={Boolean(busy)} title="Analyze recent traces and draft one safe, bounded change to test." onClick={() => void act("generate_proposal")}>Generate proposal</button>
          <button className="gl-btn" disabled={Boolean(busy) || !snapshot?.history.some((record) => record.action === "promote")} title="Return the live agent to its previous configuration." onClick={() => void act("rollback", { approvedBy: approver || "user" })}>Rollback champion</button>
          <span className="gl-champ" title="The configuration the live agent is using right now.">
            Champion <b>{champion ? champion.versionId.slice(0, 8) : "none"}</b>
            {policy ? ` · ${policy.conceptCount} concept(s), critic ${policy.useSeparateCritic ? "on" : "off"}, gate ${policy.requireAnalyzeBeforeAnimate ? "on" : "off"}` : ""}
          </span>
        </div>

        <div className="gl-flow">
          {STAGES.map((stage, index) => {
            const cls = flow.index < 0 ? "" : index < flow.index ? "done" : index === flow.index ? (flow.failed ? "fail" : "current") : "";
            return (
              <div key={stage.key} className={`gl-step ${cls}`} title={stage.hint}>
                <span className="gl-step-dot" /><span className="gl-step-label">{stage.label}</span>
              </div>
            );
          })}
        </div>

        {error ? <div className="gl-err">{error}</div> : null}

        <div className="gl-body">
          <div className="gl-rail">
            <h3>Proposals</h3>
            {snapshot?.proposals.length
              ? snapshot.proposals.map((item) => (
                <button key={item.proposalId} className={`gl-prop${selected === item.proposalId ? " is-active" : ""}`} onClick={() => setSelected(item.proposalId)}>
                  <span className={`gl-status ${item.status}`}>{item.status.replace(/_/g, " ")}</span>
                  <small>{item.observedProblem}</small>
                </button>
              ))
              : <p className="muted" style={{ margin: "4px 8px" }}>No proposals yet. Seed a run, then generate one.</p>}

            <h3>Pending abilities</h3>
            {pendingAbilities.length
              ? pendingAbilities.map((ability) => (
                <div key={ability.id} className="gl-card">
                  <strong>{ability.name}</strong>
                  <small>{ability.description}</small>
                  <div className="gl-mini">
                    <button className="gl-btn" disabled={Boolean(busy)} onClick={() => void actAbility("approve_ability", ability.id)}>Approve</button>
                    <button className="gl-btn danger" disabled={Boolean(busy)} onClick={() => void actAbility("delete_ability", ability.id)}>Reject</button>
                  </div>
                </div>
              ))
              : <p className="muted" style={{ margin: "4px 8px" }}>No abilities awaiting approval.</p>}

            <h3>Recent traces</h3>
            {snapshot?.traces.slice(0, 6).map((trace) => (
              <div key={trace.runId} className="gl-card">
                <strong style={{ fontWeight: 500, fontSize: "11px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{trace.goal.slice(0, 60)}</strong>
                <small>q {trace.quality.toFixed(1)} · ${trace.costUsd.toFixed(2)} · {trace.humanInterventions} interventions · {trace.deterministicPassed ? "checks pass" : "checks fail"}</small>
              </div>
            ))}
          </div>

          <div className="gl-detail">
            {!proposal ? (
              snapshot?.proposals.length ? (
                <div className="gl-empty">Select a proposal to see its evaluation.</div>
              ) : (
                <div className="gl-intro">
                  <h3>Improve the agent, safely</h3>
                  <p>The steps above are the loop: Gondola studies real runs, proposes one small change, tests it against the current setup, and promotes it only after you approve.</p>
                  <div className="gl-note">Start with <b>Seed demo run</b>, then <b>Generate proposal</b>.</div>
                </div>
              )
            ) : (
              <>
                <h4>Observed problem</h4>
                <p>{proposal.observedProblem}</p>
                <h4>Hypothesis</h4>
                <p className="muted">{proposal.hypothesis}</p>
                <p className="muted">Evidence: {proposal.traceEvidence.length} trace(s) · target {proposal.targetMetric} · risk {proposal.riskLevel}</p>

                <h4>Configuration diff</h4>
                {detail?.diff.length ? (
                  <table className="gl-table">
                    <thead><tr><th>Field</th><th>Champion</th><th>Challenger</th></tr></thead>
                    <tbody>
                      {detail.diff.map((change) => (
                        <tr key={change.field}><td>{change.field}</td><td>{String(change.from)}</td><td>{String(change.to)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="muted">No field changes.</p>}

                {proposal.status === "draft" && (
                  <div className="gl-actions">
                    <button className="gl-btn primary" disabled={Boolean(busy)} onClick={() => void act("evaluate_proposal", { proposalId: proposal.proposalId, live })}>{live ? "Run live evaluation" : "Run evaluation"}</button>
                    <label className="gl-live-toggle"><input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} /> Run live (real inference, spends budget)</label>
                  </div>
                )}

                {report ? (
                  <>
                    <h4>Champion vs challenger</h4>
                    <table className="gl-table">
                      <thead><tr><th>Metric</th><th>Champion</th><th>Challenger</th><th>Δ</th></tr></thead>
                      <tbody>
                        <tr><td>Quality</td><td>{report.championQuality.toFixed(1)}</td><td>{report.challengerQuality.toFixed(1)}</td><td className={report.qualityDeltaPct >= 0 ? "gl-up" : "gl-down"}>{pct(report.qualityDeltaPct)}</td></tr>
                        <tr><td>Cost (total)</td><td>${report.championCost.toFixed(2)}</td><td>${report.challengerCost.toFixed(2)}</td><td className={report.costDeltaPct <= 0 ? "gl-up" : "gl-down"}>{pct(report.costDeltaPct)}</td></tr>
                        <tr><td>Latency (avg ms)</td><td>{report.championLatencyMs}</td><td>{report.challengerLatencyMs}</td><td /></tr>
                        <tr><td>Human interventions</td><td>{report.championInterventions}</td><td>{report.challengerInterventions}</td><td /></tr>
                      </tbody>
                    </table>

                    <h4>Gates</h4>
                    {report.gates.map((gate) => (
                      <div key={gate.name} className={`gl-gate ${gate.passed ? "pass" : "fail"}`}><i />{gate.name.replace(/_/g, " ")} <small>{gate.detail}</small></div>
                    ))}

                    <h4>Per-case results</h4>
                    <table className="gl-table">
                      <thead><tr><th>Case</th><th>Kind</th><th>Champ q</th><th>Chall q</th><th>Champ checks</th><th>Chall checks</th></tr></thead>
                      <tbody>
                        {detail?.evaluation?.cases.map((comparison) => (
                          <tr key={comparison.caseId}>
                            <td>{comparison.caseId}</td>
                            <td>{comparison.kind}</td>
                            <td>{comparison.champion.semanticScore.toFixed(1)}</td>
                            <td>{comparison.challenger.semanticScore.toFixed(1)}</td>
                            <td className={comparison.champion.deterministic.passed ? "gl-up" : "gl-down"}>{comparison.champion.deterministic.passed ? "pass" : "fail"}</td>
                            <td className={comparison.challenger.deterministic.passed ? "gl-up" : "gl-down"}>{comparison.challenger.deterministic.passed ? "pass" : "fail"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {report.replayRegressions.length ? <p className="gl-down">Replay regressions: {report.replayRegressions.join(", ")}</p> : null}

                    <div className="gl-actions">
                      <input className="gl-approver" placeholder="Your name (approver)" value={approver} onChange={(event) => setApprover(event.target.value)} />
                      <button className="gl-btn primary" disabled={Boolean(busy) || proposal.status !== "ready_for_review" || !approver.trim()} onClick={() => void act("promote", { proposalId: proposal.proposalId, approvedBy: approver })}>
                        {proposal.status === "promoted" ? "Promoted" : "Approve & promote"}
                      </button>
                      <button className="gl-btn danger" disabled={Boolean(busy) || ["promoted", "rejected", "rolled_back"].includes(proposal.status)} onClick={() => void act("reject", { proposalId: proposal.proposalId })}>Reject</button>
                      {proposal.status !== "ready_for_review" && proposal.status !== "promoted" ? <span className="muted">Only a proposal that passes all gates can be promoted.</span> : null}
                    </div>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
