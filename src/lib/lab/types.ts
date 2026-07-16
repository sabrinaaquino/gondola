// Gondola Lab types. The Lab is an external control plane: it observes immutable
// traces, proposes bounded configuration changes, evaluates a challenger against
// the champion in isolation, and waits for human approval before promotion. The
// acting runtime never grades or promotes itself.

export const RUNTIME_VERSION = "gondola-0.1.0";

// ── Immutable run traces (Milestone 1) ───────────────────────────────────────

export interface ModelCallRecord {
  model: string;
  purpose: string;
  costUsd: number;
  latencyMs: number;
}

export interface ToolCallRecord {
  tool: string;
  ok: boolean;
  error?: string;
}

export interface TraceArtifact {
  id: string;
  kind: "image" | "video" | "audio";
  approved: boolean;
}

export interface DeterministicCheck {
  name: string;
  critical: boolean;
  passed: boolean;
  detail?: string;
}

export interface DeterministicEvaluation {
  checks: DeterministicCheck[];
  passed: boolean;
}

export interface SemanticEvaluation {
  judgeConfigVersion: string;
  score: number;
  rationale: string;
}

// What the explainable router recommended for a turn versus what actually ran.
// Recorded so the outer loop can critique routing (was the pick honored? was it
// cheaper/better?) without the acting runtime grading itself.
export interface TraceRouting {
  /** The model that actually ran (the primary candidate). */
  selected: string;
  /** The model the router would have chosen, if the registry was available. */
  recommended?: string;
  /** Whether the run used the router's recommendation. */
  matched: boolean;
  /** The routing preference used (e.g. balanced, cheapest). */
  prefer: string;
  /** What drove selection: a promoted champion config, or automatic/user default. */
  source?: "champion" | "auto";
  /** Human-readable rationale from the router. */
  explanation: string;
}

export interface RunTrace {
  runId: string;
  runtimeVersion: string;
  configVersionId: string;
  goal: string;
  constraints: string[];
  modelsSelected: string[];
  modelCalls: ModelCallRecord[];
  toolCalls: ToolCallRecord[];
  toolErrors: string[];
  artifacts: TraceArtifact[];
  humanInterventions: number;
  costUsd: number;
  latencyMs: number;
  completed: boolean;
  finalOutput: string;
  /** Explainable routing recommendation vs. what ran (observe-mode). */
  routing?: TraceRouting;
  /**
   * When the inner loop failed, the supervisor's diagnosis category (timeout,
   * rate_limit, ...). This is the signal the reviewer aggregates to propose
   * reliability fixes. Absent on successful turns.
   */
  failureCategory?: string;
  /** True when the supervisor recovered a best-effort answer after the failure. */
  recoveredBySupervisor?: boolean;
  deterministic?: DeterministicEvaluation;
  semantic?: SemanticEvaluation;
  finalized: boolean;
  createdAt: string;
  finalizedAt?: string;
}

// ── Versioned configuration (Milestone 2) ────────────────────────────────────

export interface WorkflowPolicy {
  /** How many low-cost concepts to generate before choosing. */
  conceptCount: number;
  /** Use a distinct critic role to review candidates. */
  useSeparateCritic: boolean;
  /** Require analyze_media on an image before animating it. */
  requireAnalyzeBeforeAnimate: boolean;
  /** Revise while quality is below this threshold (null disables revision). */
  reviseBelowQuality: number | null;
  /** Maximum revision iterations. */
  maxRevisions: number;
  /** Hard spend cap for the workflow. */
  budgetUsd: number;
  /**
   * Reliability lever the outer loop can tune. "fast" tells the acting agent to
   * favor speed (tight answers, minimal deliberation) after repeated timeouts;
   * "balanced" is the default. Optional so older configs remain valid.
   */
  latencyMode?: "fast" | "balanced";
}

export interface RoutingRule {
  role: string;
  model: string;
}

export interface RoutingConfig {
  defaultModel: string;
  rules: RoutingRule[];
}

export interface AgentRole {
  name: string;
  instructions: string;
}

export interface LabConfig {
  workflowPolicy: WorkflowPolicy;
  routing: RoutingConfig;
  roles: AgentRole[];
  toolDescriptions: Record<string, string>;
}

export interface ConfigVersion {
  versionId: string;
  parentVersionId: string | null;
  sourceProposalId: string | null;
  createdAt: string;
  contentHash: string;
  changeSummary: string;
  config: LabConfig;
}

export interface PromotionRecord {
  action: "promote" | "rollback";
  fromVersionId: string | null;
  toVersionId: string;
  proposalId: string | null;
  evaluationId: string | null;
  approvedBy: string;
  approvedAt: string;
}

export interface ConfigState {
  championVersionId: string | null;
  versions: ConfigVersion[];
  history: PromotionRecord[];
}

// ── Improvement proposals (Milestone 3) ──────────────────────────────────────

// Only these categories may be proposed in the first milestone.
export const ALLOWED_PROPOSAL_CATEGORIES = ["workflow_policy", "model_routing", "agent_role", "tool_description"] as const;
export type ProposalCategory = (typeof ALLOWED_PROPOSAL_CATEGORIES)[number];

// Categories the Lab must never touch.
export const DISALLOWED_PROPOSAL_CATEGORIES = [
  "permissions",
  "credentials",
  "budget_enforcement",
  "grader_prompts",
  "promotion_thresholds",
  "control_plane_code",
  "trace_history",
] as const;

export type ProposalStatus =
  | "draft"
  | "evaluating"
  | "failed"
  | "ready_for_review"
  | "approved"
  | "rejected"
  | "promoted"
  | "rolled_back";

export type RiskLevel = "low" | "medium" | "high";

export interface ImprovementProposal {
  proposalId: string;
  sourceRunIds: string[];
  observedProblem: string;
  traceEvidence: string[];
  hypothesis: string;
  category: ProposalCategory;
  /** For the workflow-policy slice this is a partial WorkflowPolicy. */
  configPatch: Partial<WorkflowPolicy>;
  targetMetric: string;
  expectedTradeoffs: string;
  riskLevel: RiskLevel;
  evaluationPlan: string;
  status: ProposalStatus;
  challengerVersionId?: string;
  evaluationId?: string;
  createdAt: string;
}

// ── Evaluation (Milestones 5 & 6) ────────────────────────────────────────────

export type EvaluationCaseKind = "trigger" | "validation" | "held_out" | "replay";

export interface EvaluationCase {
  id: string;
  kind: EvaluationCaseKind;
  task: string;
  difficulty: number;
  /** For replay cases: whether the champion previously passed. */
  championBaselinePass?: boolean;
}

export interface RunGrade {
  completed: boolean;
  deterministic: DeterministicEvaluation;
  semanticScore: number;
  toolFailures: number;
  modelFailures: number;
  humanInterventions: number;
  costUsd: number;
  latencyMs: number;
  modelCalls: number;
  toolCalls: number;
}

export interface CaseComparison {
  caseId: string;
  kind: EvaluationCaseKind;
  championTraceId: string;
  challengerTraceId: string;
  champion: RunGrade;
  challenger: RunGrade;
}

export interface GateResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ComparisonReport {
  targetMetric: string;
  championQuality: number;
  challengerQuality: number;
  qualityDeltaPct: number;
  championCompletionPct: number;
  challengerCompletionPct: number;
  championCost: number;
  challengerCost: number;
  costDeltaPct: number;
  championLatencyMs: number;
  challengerLatencyMs: number;
  championInterventions: number;
  challengerInterventions: number;
  /** Improvement (positive = better) for the declared target metric. */
  targetImprovementPct: number;
  replayRegressions: string[];
  criticalRegressions: string[];
  gates: GateResult[];
  readyForReview: boolean;
}

export interface EvaluationRecord {
  evaluationId: string;
  proposalId: string;
  championVersionId: string;
  challengerVersionId: string;
  judgeConfigVersion: string;
  seed: number;
  caseIds: string[];
  cases: CaseComparison[];
  report: ComparisonReport;
  contaminationFree: boolean;
  /**
   * True when the evaluation ran the real agent (live inference), false/absent
   * for the offline simulation. The autopilot only auto-promotes on live
   * evidence, so a simulated pass can never promote itself unattended.
   */
  live?: boolean;
  createdAt: string;
}

export interface JudgeConfig {
  version: string;
  model: string;
  prompt: string;
}

export interface PromotionThresholds {
  minQualityImprovementPct: number;
  maxCostIncreasePct: number;
}

export interface ConfigFieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}
