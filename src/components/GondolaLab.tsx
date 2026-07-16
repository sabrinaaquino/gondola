import { useCallback, useEffect, useState } from "react";
import { CloseIcon, TrashIcon } from "./Icons";
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

const CSS = `
.gl-scrim { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 24px; background: rgba(4,5,9,.62); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); animation: gl-fade .16s ease; }
@keyframes gl-fade { from { opacity: 0; } to { opacity: 1; } }
.gl-panel { display: flex; flex-direction: column; width: 100%; max-width: 1200px; height: min(90vh, 880px); border: 1px solid var(--line); border-radius: 22px; background: linear-gradient(160deg, rgba(20,22,28,.98), rgba(8,9,13,.99)); box-shadow: var(--shadow), 0 40px 100px -34px rgba(0,0,0,.85); overflow: hidden; }
.gl-head { display: flex; align-items: flex-start; gap: 14px; padding: 18px 20px 16px; border-bottom: 1px solid var(--line); }
.gl-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.gl-kicker { color: var(--mint); font-size: 8px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
.gl-head h2 { margin: 0; color: var(--ink); font-size: 17px; font-weight: 640; letter-spacing: -.02em; }
.gl-head p { margin: 0; color: var(--faint); font-size: 11.5px; }
.gl-close { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); background: transparent; cursor: pointer; }
.gl-close:hover { color: var(--ink); border-color: var(--line-bright); background: rgba(255,255,255,.05); }
.gl-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
.gl-btn { height: 32px; padding: 0 13px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: rgba(255,255,255,.03); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color .14s, background .14s; }
.gl-btn:hover:not(:disabled) { border-color: var(--line-bright); background: rgba(255,255,255,.06); }
.gl-btn:disabled { opacity: .4; cursor: default; }
.gl-btn.primary { color: #11151b; background: linear-gradient(145deg, #f7f6f2, #b7c9dd); border: 0; }
.gl-btn.danger { color: var(--coral); border-color: rgba(255,142,122,.3); }
.gl-champ { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--faint); font-size: 11px; }
.gl-champ b { color: var(--mint); font-variant-numeric: tabular-nums; }
.gl-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 260px minmax(0,1fr); }
.gl-rail { border-right: 1px solid var(--line); overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.gl-rail h3 { margin: 4px 6px; color: var(--faint); font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.gl-prop { text-align: left; border: 1px solid var(--line); border-radius: 11px; background: transparent; color: var(--ink); padding: 9px 11px; cursor: pointer; transition: border-color .14s, background .14s; }
.gl-prop:hover { border-color: var(--line-bright); }
.gl-prop.is-active { border-color: rgba(184,207,232,.42); background: rgba(184,207,232,.06); }
.gl-prop small { display: block; color: var(--faint); font-size: 10.5px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gl-prop-row { display: flex; align-items: center; gap: 8px; }
.gl-prop-select { all: unset; flex: 1; min-width: 0; cursor: pointer; }
.gl-prop-delete { flex: 0 0 auto; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px; color: var(--faint); background: transparent; cursor: pointer; opacity: .45; transition: color .14s, background .14s, opacity .14s; }
.gl-prop:hover .gl-prop-delete { opacity: .7; }
.gl-prop-delete:hover:not(:disabled) { color: var(--coral); background: rgba(255,142,122,.12); opacity: 1; }
.gl-prop-delete:disabled { opacity: .2; cursor: default; }
.gl-status { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.gl-status.ready_for_review, .gl-status.promoted { color: #8bbf9d; background: rgba(139,191,157,.12); }
.gl-status.failed, .gl-status.rejected, .gl-status.rolled_back { color: var(--coral); background: rgba(255,142,122,.12); }
.gl-status.draft, .gl-status.evaluating { color: var(--aqua); background: rgba(159,183,210,.12); }
.gl-detail { overflow-y: auto; padding: 16px 20px; color: #ccd2da; font-size: 13px; }
.gl-detail h4 { margin: 16px 0 7px; color: var(--ink); font-size: 12px; font-weight: 660; letter-spacing: .01em; }
.gl-detail p { margin: 0 0 6px; line-height: 1.6; }
.gl-detail .muted { color: var(--faint); font-size: 12px; }
.gl-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
.gl-table th, .gl-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.gl-table th { color: var(--faint); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.gl-up { color: #8bbf9d; } .gl-down { color: var(--coral); }
.gl-gate { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
.gl-gate i { width: 7px; height: 7px; border-radius: 50%; }
.gl-gate.pass i { background: #8bbf9d; } .gl-gate.fail i { background: var(--coral); }
.gl-gate small { color: var(--faint); }
.gl-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
.gl-approver { height: 32px; padding: 0 11px; border: 1px solid var(--line); border-radius: 9px; background: rgba(255,255,255,.03); color: var(--ink); font: inherit; font-size: 12px; outline: none; }
.gl-approver:focus { border-color: rgba(184,207,232,.45); }
.gl-empty { display: grid; place-items: center; height: 100%; color: var(--faint); font-size: 13px; text-align: center; padding: 24px; }
.gl-err { color: var(--coral); font-size: 12px; margin: 8px 20px; }
.gl-live-toggle { display: flex; align-items: center; gap: 6px; color: var(--faint); font-size: 11.5px; cursor: pointer; }
.gl-live-toggle input { accent-color: var(--mint); }
.gl-mini { display: flex; gap: 6px; margin-top: 7px; }
.gl-mini .gl-btn { height: 26px; padding: 0 10px; font-size: 11px; }
`;

function pct(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function GondolaLab({ open, onClose, agentId = "nova-default" }: GondolaLabProps) {
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
    setNotice("");
    try {
      const response = await fetch("/api/lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; proposal?: ImprovementProposal | null };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
      if (action === "generate_proposal") {
        if (payload.proposal) setSelected(payload.proposal.proposalId);
        else setNotice("No new suggestions right now.");
      }
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

  if (!open) return null;

  const champion = snapshot?.champion;
  const policy = champion?.config.workflowPolicy;
  const proposal = detail?.proposal;
  const report = detail?.evaluation?.report;

  return (
    <div className="gl-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <style>{CSS}</style>
      <section className="gl-panel" role="dialog" aria-modal="true" aria-label="Gondola Lab">
        <header className="gl-head">
          <div className="gl-titles">
            <span className="gl-kicker">Gondola Lab</span>
            <h2>Champion vs challenger</h2>
            <p>An external control plane proposes and validates config changes. Nothing promotes without your approval.</p>
          </div>
          <button className="gl-close" onClick={onClose} aria-label="Close Gondola Lab"><CloseIcon size={16} /></button>
        </header>

        <div className="gl-toolbar">
          <button className="gl-btn" disabled={Boolean(busy)} onClick={() => void act("seed_demo")}>Seed demo run</button>
          <button className="gl-btn primary" disabled={Boolean(busy)} onClick={() => void act("generate_proposal")}>Generate proposal</button>
          <button className="gl-btn" disabled={Boolean(busy) || !snapshot?.history.some((record) => record.action === "promote")} onClick={() => void act("rollback", { approvedBy: approver || "user" })}>Rollback champion</button>
          <button className="gl-btn" disabled={Boolean(busy) || !snapshot || snapshot.history[snapshot.history.length - 1]?.action !== "rollback"} onClick={() => void act("undo_rollback", { approvedBy: approver || "user" })}>Undo rollback</button>
          <span className="gl-champ">
            Champion <b>{champion ? champion.versionId.slice(0, 8) : "none"}</b>
            {policy ? ` · ${policy.conceptCount} concept(s), critic ${policy.useSeparateCritic ? "on" : "off"}, gate ${policy.requireAnalyzeBeforeAnimate ? "on" : "off"}` : ""}
          </span>
        </div>

        {error ? <div className="gl-err">{error}</div> : null}
        {notice ? <div style={{ padding: "4px 14px 8px", fontSize: "12px", opacity: 0.7 }}>{notice}</div> : null}

        <div className="gl-body">
          <div className="gl-rail">
            <h3>Proposals</h3>
            {snapshot?.proposals.length
              ? snapshot.proposals.map((item) => (
                <div key={item.proposalId} className={`gl-prop gl-prop-row${selected === item.proposalId ? " is-active" : ""}`}>
                  <button type="button" className="gl-prop-select" onClick={() => setSelected(item.proposalId)}>
                    <span className={`gl-status ${item.status}`}>{item.status.replace(/_/g, " ")}</span>
                    <small>{item.observedProblem}</small>
                  </button>
                  <button type="button" className="gl-prop-delete" title="Delete proposal" aria-label="Delete proposal" disabled={Boolean(busy)} onClick={() => {
                    const id = item.proposalId;
                    void act("delete_proposal", { proposalId: id }).then(() => {
                      if (selected === id) { setSelected(""); setDetail(null); }
                    });
                  }}>
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))
              : <p className="muted" style={{ margin: "6px" }}>No proposals yet. Seed a run, then generate one.</p>}
            <h3>Pending abilities</h3>
            {abilities.filter((ability) => ability.status === "pending").length
              ? abilities.filter((ability) => ability.status === "pending").map((ability) => (
                <div key={ability.id} className="gl-prop" style={{ cursor: "default" }}>
                  <small style={{ marginTop: 0, color: "var(--ink)" }}>{ability.name}</small>
                  <small>{ability.description}</small>
                  <div className="gl-mini">
                    <button className="gl-btn" disabled={Boolean(busy)} onClick={() => void actAbility("approve_ability", ability.id)}>Approve</button>
                    <button className="gl-btn danger" disabled={Boolean(busy)} onClick={() => void actAbility("delete_ability", ability.id)}>Reject</button>
                  </div>
                </div>
              ))
              : <p className="muted" style={{ margin: "6px" }}>No abilities awaiting approval.</p>}

            <h3>Approved abilities</h3>
            {abilities.filter((ability) => ability.status === "approved").length
              ? abilities.filter((ability) => ability.status === "approved").map((ability) => (
                <div key={ability.id} className="gl-prop gl-prop-row" style={{ cursor: "default" }}>
                  <div className="gl-prop-select" style={{ cursor: "default" }}>
                    <small style={{ marginTop: 0, color: "var(--ink)" }}>{ability.name}</small>
                    <small>{ability.description}</small>
                  </div>
                  <button type="button" className="gl-prop-delete" title="Remove ability" aria-label="Remove ability" disabled={Boolean(busy)} onClick={() => void actAbility("delete_ability", ability.id)}>
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))
              : <p className="muted" style={{ margin: "6px" }}>No approved abilities yet.</p>}

            <h3>Recent traces</h3>
            {snapshot?.traces.slice(0, 6).map((trace) => (
              <div key={trace.runId} className="gl-prop" style={{ cursor: "default" }}>
                <small style={{ marginTop: 0 }}>{trace.goal.slice(0, 60)}</small>
                <small>q {trace.quality.toFixed(1)} · ${trace.costUsd.toFixed(2)} · {trace.humanInterventions} interventions · {trace.deterministicPassed ? "checks pass" : "checks fail"}</small>
              </div>
            ))}
          </div>

          <div className="gl-detail">
            {!proposal ? (
              <div className="gl-empty">Select a proposal to see its evidence, configuration diff, and champion vs challenger evaluation.</div>
            ) : (
              <>
                <h4>Observed problem</h4>
                <p>{proposal.observedProblem}</p>
                <h4>Hypothesis</h4>
                <p className="muted">{proposal.hypothesis}</p>
                <p className="muted">Evidence: {proposal.traceEvidence.length} trace(s) · target {proposal.targetMetric} · risk {proposal.riskLevel}</p>
                {proposal.proposerFeedback ? <p className="muted">Proposer context: {proposal.proposerFeedback}</p> : null}

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
                    <p className="muted">Judged on <strong>{report.targetMetric.replace(/_/g, " ")}</strong>: {pct(report.targetImprovementPct)} {report.targetImprovementPct >= 0 ? "better" : "worse"}.</p>
                    <table className="gl-table">
                      <thead><tr><th>Metric</th><th>Champion</th><th>Challenger</th><th>Δ</th></tr></thead>
                      <tbody>
                        <tr><td>Quality</td><td>{report.championQuality.toFixed(1)}</td><td>{report.challengerQuality.toFixed(1)}</td><td className={report.qualityDeltaPct >= 0 ? "gl-up" : "gl-down"}>{pct(report.qualityDeltaPct)}</td></tr>
                        <tr><td>Completion</td><td>{report.championCompletionPct.toFixed(0)}%</td><td>{report.challengerCompletionPct.toFixed(0)}%</td><td className={report.challengerCompletionPct >= report.championCompletionPct ? "gl-up" : "gl-down"}>{(report.challengerCompletionPct - report.championCompletionPct).toFixed(0)} pts</td></tr>
                        <tr><td>Held-out deterministic</td><td>{report.championHeldOutPassRate.toFixed(0)}%</td><td>{report.challengerHeldOutPassRate.toFixed(0)}%</td><td className={report.challengerHeldOutPassRate >= report.championHeldOutPassRate ? "gl-up" : "gl-down"}>{(report.challengerHeldOutPassRate - report.championHeldOutPassRate).toFixed(0)} pts</td></tr>
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
                      {proposal.status === "ready_for_review" && proposal.autonomyTier === "auto" ? <span className="muted">Eligible for autonomous promotion (deterministic, held-out, low-risk) when autopilot is on.</span> : null}
                      {proposal.autonomyTier === "protected" ? <span className="muted">Protected surface — this always requires your approval.</span> : null}
                    </div>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
