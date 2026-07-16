import { useCallback, useEffect, useState } from "react";
import { CloseIcon } from "./Icons";
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
}

// Plain-language surface. Everything a newcomer reads is in human words; the
// internal vocabulary (proposal / champion / challenger / gates / promote) stays
// in the code and API, never on screen.
const STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: "Ready to test", cls: "s-todo" },
  evaluating: { text: "Testing\u2026", cls: "s-testing" },
  ready_for_review: { text: "Ready to review", cls: "s-ready" },
  failed: { text: "Didn't pass", cls: "s-fail" },
  promoted: { text: "Applied", cls: "s-applied" },
  rejected: { text: "Dismissed", cls: "s-muted" },
  rolled_back: { text: "Undone", cls: "s-muted" },
};

const GATE_LABELS: Record<string, string> = {
  target_metric_improved: "Quality improved",
  no_critical_regression: "Didn't break anything it used to do",
  no_replay_regression: "Older tasks still work",
  cost_within_tolerance: "Cost stayed within limit",
};

const GATE_FAILS: Record<string, string> = {
  target_metric_improved: "quality didn't improve enough",
  no_critical_regression: "it broke something it used to do",
  no_replay_regression: "some older tasks stopped working",
  cost_within_tolerance: "it costs too much more",
};

function titleForPatch(patch: Partial<WorkflowPolicy>): string {
  if (patch.requireAnalyzeBeforeAnimate) return "Review images before making videos";
  if (patch.useSeparateCritic) return "Add a review step to catch weak results";
  if (typeof patch.conceptCount === "number" && patch.conceptCount > 1) return "Try a few concepts before choosing";
  if (patch.reviseBelowQuality != null || (typeof patch.maxRevisions === "number" && patch.maxRevisions > 0)) return "Revise weak results automatically";
  return "Suggested improvement";
}

function humanizeChange(field: string, from: unknown, to: unknown): { now: string; suggested: string } {
  const key = field.replace(/^workflowPolicy\./, "");
  switch (key) {
    case "requireAnalyzeBeforeAnimate":
      return { now: "Animates images right away.", suggested: "Reviews each image before animating it." };
    case "useSeparateCritic":
      return { now: "No separate review step.", suggested: "Adds a step to catch weak results before finishing." };
    case "conceptCount":
      return { now: `Tries ${from} concept${Number(from) === 1 ? "" : "s"}.`, suggested: `Tries ${to} concepts, then picks the strongest.` };
    case "reviseBelowQuality":
      return { now: "Doesn't revise automatically.", suggested: `Revises when quality is below ${to}/10.` };
    case "maxRevisions":
      return { now: `Up to ${from} revision${Number(from) === 1 ? "" : "s"}.`, suggested: `Up to ${to} revisions.` };
    case "budgetUsd":
      return { now: `Spend limit $${from}.`, suggested: `Spend limit $${to}.` };
    default:
      return { now: String(from), suggested: String(to) };
  }
}

const CSS = `
.gl-scrim { position: fixed; z-index: 88; inset: 0; visibility: hidden; border: 0; background: rgba(1,5,4,0); -webkit-backdrop-filter: blur(0); backdrop-filter: blur(0); cursor: default; transition: 280ms ease; }
.gl-scrim.is-open { visibility: visible; background: rgba(1,5,4,.54); -webkit-backdrop-filter: blur(7px); backdrop-filter: blur(7px); }
.gl-modal { position: fixed; z-index: 89; top: 50%; left: 50%; width: min(960px, calc(100vw - 40px)); height: min(660px, calc(100vh - 56px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-bright); border-radius: 20px; background: var(--panel-strong); -webkit-backdrop-filter: blur(22px); backdrop-filter: blur(22px); box-shadow: var(--shadow); opacity: 0; visibility: hidden; pointer-events: none; transform: translate(-50%, -47%) scale(.985); transition: opacity 200ms ease, transform 240ms cubic-bezier(.2,.8,.2,1), visibility 200ms ease; }
.gl-modal.is-open { opacity: 1; visibility: visible; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
.gl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 18px 16px 24px; border-bottom: 1px solid var(--line); }
.gl-head h2 { margin: 0; font-size: 19px; font-weight: 640; letter-spacing: -.01em; color: var(--ink); }
.gl-head p { margin: 4px 0 0; color: var(--muted); font-size: 12.5px; }
.gl-ctx { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 24px; border-bottom: 1px solid var(--line); color: var(--faint); font-size: 11.5px; }
.gl-ctx b { color: var(--muted); font-weight: 600; }
.gl-ctx-actions { display: flex; align-items: center; gap: 8px; }
.gl-err { color: var(--coral); font-size: 12px; margin: 10px 24px 0; }
.gl-btn { height: 34px; padding: 0 14px; display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 11px; color: var(--ink); background: rgba(255,255,255,.035); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color 180ms ease, background 180ms ease; }
.gl-btn:hover:not(:disabled) { border-color: var(--line-bright); background: rgba(255,255,255,.065); }
.gl-btn:disabled { opacity: .45; cursor: default; }
.gl-btn.primary { color: #11151b; background: linear-gradient(145deg, #f7f6f2, #b7c9dd); border: 0; font-weight: 650; }
.gl-btn.primary:hover:not(:disabled) { background: linear-gradient(145deg, #ffffff, #c4d2e2); }
.gl-btn.ghost { color: var(--muted); }
.gl-btn.sm { height: 28px; padding: 0 11px; font-size: 11.5px; }
.gl-link { border: 0; background: transparent; color: var(--faint); font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.gl-link:hover { color: var(--muted); }
.gl-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 274px minmax(0,1fr); }
.gl-rail { border-right: 1px solid var(--line); overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 8px; }
.gl-rail-head { display: flex; align-items: center; justify-content: space-between; margin: 2px 6px 2px; }
.gl-rail-head h3 { color: #6b727f; font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.gl-sugg { text-align: left; border: 1px solid var(--line); border-radius: 12px; background: transparent; color: var(--ink); padding: 11px 12px; cursor: pointer; transition: border-color 140ms ease, background 140ms ease; }
.gl-sugg:hover { border-color: var(--line-bright); }
.gl-sugg.on { border-color: var(--line-bright); background: rgba(205,208,214,.07); }
.gl-sugg strong { display: block; font-size: 12.5px; font-weight: 600; line-height: 1.35; }
.gl-pill { display: inline-block; margin-top: 8px; padding: 2px 8px; border-radius: 999px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
.gl-pill.s-ready, .gl-pill.s-applied { color: #93c9a8; background: rgba(147,201,168,.13); }
.gl-pill.s-testing, .gl-pill.s-todo { color: var(--amber); background: rgba(255,202,112,.13); }
.gl-pill.s-fail { color: var(--coral); background: rgba(255,142,122,.13); }
.gl-pill.s-muted { color: var(--faint); background: rgba(255,255,255,.05); }
.gl-tools { margin-top: 6px; padding: 12px; border: 1px dashed var(--line-bright); border-radius: 12px; }
.gl-tools h3 { color: #6b727f; font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 8px; }
.gl-tool { display: flex; flex-direction: column; gap: 7px; }
.gl-tool .name { color: var(--ink); font-size: 12px; font-weight: 600; }
.gl-tool .desc { color: var(--faint); font-size: 10.5px; line-height: 1.4; margin-top: 2px; }
.gl-tool .row { display: flex; gap: 6px; }
.gl-detail { overflow-y: auto; padding: 20px 24px 24px; color: #c3c8d0; font-size: 13px; }
.gl-detail h4 { color: var(--ink); font-size: 12px; font-weight: 640; margin: 0 0 6px; }
.gl-detail h4.mt { margin-top: 20px; }
.gl-detail p { margin: 0; line-height: 1.6; }
.gl-change { display: flex; align-items: center; gap: 12px; margin-top: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.015); }
.gl-change + .gl-change { margin-top: 8px; }
.gl-change .col { flex: 1; min-width: 0; }
.gl-change .lbl { color: var(--faint); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
.gl-change .val { color: var(--ink); font-size: 12.5px; margin-top: 3px; line-height: 1.4; }
.gl-change .arrow { color: var(--faint); font-size: 16px; flex: 0 0 auto; }
.gl-verdict { margin-top: 16px; padding: 12px 14px; border-radius: 12px; font-size: 12.5px; font-weight: 600; }
.gl-verdict.ok { border: 1px solid rgba(147,201,168,.3); background: rgba(147,201,168,.07); color: #93c9a8; }
.gl-verdict.no { border: 1px solid rgba(255,142,122,.3); background: rgba(255,142,122,.07); color: var(--coral); }
.gl-cmp { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
.gl-cmp th, .gl-cmp td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); }
.gl-cmp th { color: #6b727f; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; }
.gl-cmp td:first-child { color: var(--muted); }
.gl-cmp td { color: var(--ink); font-variant-numeric: tabular-nums; }
.gl-up { color: #93c9a8; }
.gl-checks { margin-top: 8px; display: flex; flex-direction: column; gap: 7px; }
.gl-check { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: #c3c8d0; }
.gl-check i { width: 15px; height: 15px; border-radius: 50%; display: grid; place-items: center; font-size: 9px; flex: 0 0 auto; font-style: normal; }
.gl-check.pass i { background: rgba(147,201,168,.15); color: #93c9a8; }
.gl-check.fail i { background: rgba(255,142,122,.15); color: var(--coral); }
.gl-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); }
.gl-hint { display: grid; place-items: center; height: 100%; color: var(--faint); font-size: 13px; text-align: center; padding: 24px; }
.gl-empty { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px; text-align: center; }
.gl-empty h3 { color: var(--ink); font-size: 16px; font-weight: 640; }
.gl-empty p { max-width: 420px; color: var(--muted); font-size: 13px; line-height: 1.6; }
.gl-empty .gl-btn { margin-top: 4px; }
.gl-empty-tools { margin-top: 20px; width: min(420px, 100%); }
@media (max-width: 720px) {
  .gl-modal { width: calc(100vw - 24px); height: min(92vh, calc(100vh - 24px)); }
  .gl-body { grid-template-columns: 1fr; }
  .gl-rail { border-right: 0; border-bottom: 1px solid var(--line); max-height: 220px; }
}
`;

export function GondolaLab({ open, onClose, agentId = "nova-default" }: GondolaLabProps) {
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
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
        body: JSON.stringify({ action, agentId, id, approvedBy: "owner" }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
      await loadAbilities();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setBusy("");
    }
  }, [agentId, loadAbilities]);

  useEffect(() => {
    if (open) { void loadSnapshot(); void loadAbilities(); }
  }, [open, loadSnapshot, loadAbilities]);

  useEffect(() => {
    if (open && selected) void loadDetail(selected);
  }, [open, selected, loadDetail]);

  // Open straight into the first suggestion so the detail is never blank.
  useEffect(() => {
    if (open && !selected && snapshot?.proposals.length) setSelected(snapshot.proposals[0].proposalId);
  }, [open, selected, snapshot]);

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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
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

  const proposals = snapshot?.proposals ?? [];
  const pending = abilities.filter((ability) => ability.status === "pending");
  const canUndo = Boolean(snapshot?.history.some((record) => record.action === "promote"));
  const proposal = detail?.proposal;
  const report = detail?.evaluation?.report;
  const anythingToShow = proposals.length > 0;

  const abilityCards = (
    <div className="gl-tools">
      <h3>New tools the agent wants to add</h3>
      {pending.length ? pending.map((ability) => (
        <div key={ability.id} className="gl-tool">
          <div>
            <div className="name">{ability.name.replace(/_/g, " ")}</div>
            <div className="desc">{ability.description}</div>
          </div>
          <div className="row">
            <button className="gl-btn sm" disabled={Boolean(busy)} onClick={() => void actAbility("approve_ability", ability.id)}>Approve</button>
            <button className="gl-btn sm ghost" disabled={Boolean(busy)} onClick={() => void actAbility("delete_ability", ability.id)}>Remove</button>
          </div>
        </div>
      )) : <div className="desc" style={{ color: "var(--faint)", fontSize: "11.5px" }}>None right now.</div>}
    </div>
  );

  const failingGate = report?.gates.find((gate) => !gate.passed && gate.name !== "no_contamination");

  return (
    <>
      <style>{CSS}</style>
      <button className={`gl-scrim ${open ? "is-open" : ""}`} onClick={onClose} aria-label="Dismiss Gondola Lab" tabIndex={open ? 0 : -1} />
      <section className={`gl-modal ${open ? "is-open" : ""}`} role="dialog" aria-modal="true" aria-label="Gondola Lab" aria-hidden={!open}>
        <header className="gl-head">
          <div>
            <h2>Gondola Lab</h2>
            <p>Small improvements to your agent. You decide what goes live.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close Gondola Lab"><CloseIcon size={20} /></button>
        </header>

        {anythingToShow && (
          <div className="gl-ctx">
            <span>Currently live: <b>your standard setup</b></span>
            <div className="gl-ctx-actions">
              <button className="gl-btn sm" disabled={Boolean(busy)} onClick={() => void act("generate_proposal")}>Check for improvements</button>
              {canUndo && <button className="gl-btn sm ghost" disabled={Boolean(busy)} onClick={() => void act("rollback", { approvedBy: "owner" })}>Undo last change</button>}
            </div>
          </div>
        )}

        {error ? <div className="gl-err">{error}</div> : null}

        {!anythingToShow ? (
          <div className="gl-empty">
            <h3>Nothing to review yet</h3>
            <p>As Gondola works, it looks for small ways to improve, like fixing a step it keeps getting wrong. When it finds one, it shows up here for you to approve. Nothing changes on its own.</p>
            <button className="gl-btn primary" disabled={Boolean(busy)} onClick={() => void act("generate_proposal")}>Check for improvements</button>
            <button className="gl-link" disabled={Boolean(busy)} onClick={() => void act("seed_demo")}>Just exploring? Try it with a demo</button>
            {pending.length ? <div className="gl-empty-tools">{abilityCards}</div> : null}
          </div>
        ) : (
          <div className="gl-body">
            <div className="gl-rail">
              <div className="gl-rail-head"><h3>Suggested improvements</h3></div>
              {proposals.map((item) => {
                const status = STATUS[item.status] ?? { text: item.status, cls: "s-muted" };
                return (
                  <button key={item.proposalId} className={`gl-sugg${selected === item.proposalId ? " on" : ""}`} onClick={() => setSelected(item.proposalId)}>
                    <strong>{titleForPatch(item.configPatch)}</strong>
                    <span className={`gl-pill ${status.cls}`}>{status.text}</span>
                  </button>
                );
              })}
              {abilityCards}
            </div>

            <div className="gl-detail">
              {!proposal ? (
                <div className="gl-hint">Pick a suggestion on the left to see what it does.</div>
              ) : (
                <>
                  <h4>What Gondola noticed</h4>
                  <p>{proposal.observedProblem}</p>

                  <h4 className="mt">What it would change</h4>
                  {detail?.diff.length ? detail.diff.map((change) => {
                    const human = humanizeChange(change.field, change.from, change.to);
                    return (
                      <div key={change.field} className="gl-change">
                        <div className="col"><div className="lbl">Now</div><div className="val">{human.now}</div></div>
                        <div className="arrow">&rarr;</div>
                        <div className="col"><div className="lbl">Suggested</div><div className="val">{human.suggested}</div></div>
                      </div>
                    );
                  }) : <p className="gl-hint" style={{ display: "block", textAlign: "left", padding: 0 }}>No visible change.</p>}

                  {proposal.status === "draft" && (
                    <div className="gl-actions">
                      <button className="gl-btn primary" disabled={Boolean(busy)} onClick={() => void act("evaluate_proposal", { proposalId: proposal.proposalId })}>Test this improvement</button>
                    </div>
                  )}

                  {report ? (
                    <>
                      <div className={`gl-verdict ${report.readyForReview ? "ok" : "no"}`}>
                        {report.readyForReview
                          ? "\u2713 Tested and passed every safety check. Ready to apply."
                          : `Tested \u2014 didn't pass: ${failingGate ? (GATE_FAILS[failingGate.name] ?? "a safety check failed") : "a safety check failed"}.`}
                      </div>

                      <h4 className="mt">How the suggested version did</h4>
                      <table className="gl-cmp">
                        <thead><tr><th>&nbsp;</th><th>Now</th><th>Suggested</th></tr></thead>
                        <tbody>
                          <tr><td>Quality</td><td>{report.championQuality.toFixed(1)}</td><td className={report.challengerQuality > report.championQuality ? "gl-up" : ""}>{report.challengerQuality.toFixed(1)}</td></tr>
                          <tr><td>Cost per run</td><td>${report.championCost.toFixed(2)}</td><td className={report.challengerCost <= report.championCost ? "gl-up" : ""}>${report.challengerCost.toFixed(2)}</td></tr>
                          <tr><td>Times it needed your help</td><td>{report.championInterventions}</td><td className={report.challengerInterventions < report.championInterventions ? "gl-up" : ""}>{report.challengerInterventions}</td></tr>
                        </tbody>
                      </table>

                      <h4 className="mt">Safety checks</h4>
                      <div className="gl-checks">
                        {report.gates.filter((gate) => gate.name !== "no_contamination").map((gate) => (
                          <div key={gate.name} className={`gl-check ${gate.passed ? "pass" : "fail"}`}>
                            <i>{gate.passed ? "\u2713" : "\u2715"}</i>{GATE_LABELS[gate.name] ?? gate.name.replace(/_/g, " ")}
                          </div>
                        ))}
                      </div>

                      <div className="gl-actions">
                        <button className="gl-btn primary" disabled={Boolean(busy) || proposal.status !== "ready_for_review"} onClick={() => void act("promote", { proposalId: proposal.proposalId, approvedBy: "owner" })}>
                          {proposal.status === "promoted" ? "Applied" : "Apply this change"}
                        </button>
                        <button className="gl-btn ghost" disabled={Boolean(busy) || ["promoted", "rejected", "rolled_back"].includes(proposal.status)} onClick={() => void act("reject", { proposalId: proposal.proposalId })}>Dismiss</button>
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
