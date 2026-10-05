/**
 * @dealora/evaluation — types for Phase 19 Agent Evaluation (`ROADMAP.md` §26,
 * `DEALORA_BLUEPRINT.md` §31 agent evaluation, §30 registry, §29 governance,
 * §84 principle 16).
 *
 * ## What this phase is
 *
 * `ROADMAP.md` §26 is four sentences long, and this package implements exactly
 * them: **prevent fluent but unreliable agents from entering production**, by
 * **measuring** thirteen named metrics, behind the gate **"production agents
 * require evaluation evidence."** Nothing else.
 *
 * The distinction the whole design rests on is between three states that are
 * easy to collapse and are not the same thing:
 *
 * - a **declared** agent exists because `ROADMAP.md` §25 named it and
 *   `@dealora/agent` declares its fields. That happened in Phase 18.
 * - an **evaluated** agent has a recorded round of judgements against **this
 *   exact agent version** that meets **every threshold this agent declares**.
 *   That is what this package produces, and it is a property of evidence, not a
 *   flag anybody may set.
 * - a **production-eligible** agent has been moved to `production` by a person,
 *   which this phase permits **only** when the second holds. It is a governance
 *   state, and `MEETABLE_AGENT_STATES` is still empty — so an eligible agent
 *   still executes nothing, because nothing in this repository runs an agent.
 *
 * ## The negative space, stated once
 *
 * - **never executes**: no runner, dispatcher, loop, scheduler or tool
 *   invoker. A judgement describes work someone already did elsewhere;
 * - **never calls a model or a network**: the numbers come from stored rows;
 * - **never fabricates**: an agent with no evidence reports
 *   `insufficient_evidence` with **no value at all** — absence is never zero,
 *   and zero would read as a perfect score for `hallucination_rate` and a total
 *   failure for `task_success`;
 * - **never accepts a client's verdict on the outcome**: a request may name a
 *   metric, a subject and either a judgement or a measured quantity, and
 *   nothing else. Rates, totals, thresholds, the gate and the agent version are
 *   all derived here, server-side;
 * - **never reads another workspace**: every read and write is workspace-scoped
 *   with the caller's own identity, re-checked inside storage;
 * - **never ages evidence by the clock**: a fresh round supersedes an older one,
 *   so the same stored rows always produce the same report.
 *
 * ## Determinism
 *
 * There is no clock, no randomness, no model and no network in any derivation
 * below. Rates are integer cross-multiplications rather than floating-point
 * division, so a threshold boundary is decided exactly and identically on every
 * run. Ordering is a total order over the published metric table, and the
 * observation trail sorts by `(metric, subjectId)` — never by the generated id,
 * which is why two runs over the same rows print byte-identical JSON.
 */

import type { AgentEvaluationMetric, AgentId } from "@dealora/agent";
import type { DateTime, EntityId } from "@dealora/db";

/** The closed error vocabulary this domain reports to the transport layer. */
export type EvaluationErrorCode =
  "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_ERROR" | "CONFLICT" | "UNAVAILABLE";

export interface EvaluationError {
  readonly code: EvaluationErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** Every store method's result shape, stated structurally. */
export type EvaluationStorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

/**
 * The three judgements a person may record against one measured subject.
 *
 * A deliberately small vocabulary, because the judgement itself is a human
 * conclusion about a specific thing and the arithmetic belongs to the engine.
 *
 * `unobserved` is the important one: it is the honest "this could not be
 * judged", and it stays **in the denominator**. An unjudgeable run therefore
 * counts against an agent rather than for it, which is the only direction that
 * is safe — otherwise an evaluator could raise any rate simply by declining to
 * look.
 */
export type EvaluationVerdict = "met" | "unmet" | "unobserved";

/** How one metric is measured, and therefore what a number about it means. */
export type EvaluationMetricKind =
  /** A share of judgements, in basis points, compared with a threshold. */
  | "rate"
  /** A sum of whole minor units, compared with the declared cost ceiling. */
  | "spend_minor"
  /** The slowest recorded run, in whole milliseconds, against a published ceiling. */
  | "duration_ms";

/**
 * What one metric's evidence currently says.
 *
 * Three values and no more. There is no `pass`, no `unknown` and no `n/a`: an
 * agent's declaration names the metrics that apply to it, so a metric that is
 * declared is applicable, and a metric with too little evidence is
 * `insufficient_evidence` rather than quietly omitted.
 */
export type EvaluationStatus = "met" | "unmet" | "insufficient_evidence";

/** One published rule for one of `ROADMAP.md` §26's thirteen metrics. */
export interface EvaluationMetricRule {
  readonly metric: AgentEvaluationMetric;
  readonly description: string;
  readonly kind: EvaluationMetricKind;
  /** `at_most` metrics publish the failure ceiling; `at_least` the success floor. */
  readonly direction: "at_least" | "at_most";
  /**
   * The bar, in the metric's own unit.
   *
   * For a `rate` this is **basis points** — good outcomes per 10,000 — so every
   * comparison is an exact integer cross-multiplication and no boundary is
   * decided by floating-point rounding.
   */
  readonly threshold: number;
  /** How many observations a metric needs before it is judged at all. */
  readonly minimumSample: number;
  /** Why this bar exists, in one sentence. */
  readonly rationale: string;
}

/** How many judgements of each kind a metric has. */
export interface EvaluationVerdictCounts {
  readonly met: number;
  readonly unmet: number;
  readonly unobserved: number;
}

/** What a `cost` metric was measured against. */
export interface EvaluationCostBreakdown {
  readonly currency: string;
  readonly totalMinor: number;
  readonly worstMinor: number;
  /** `AgentDeclaration.costLimits.maxSpendMinor`, read from the declaration. */
  readonly maxSpendMinor: number;
  /** `AgentDeclaration.costLimits.maxPerExecutionMinor`, read from the declaration. */
  readonly maxPerExecutionMinor: number;
  readonly overSpend: boolean;
  readonly overPerExecution: boolean;
}

/** What a `latency` metric was measured against. */
export interface EvaluationLatencyBreakdown {
  readonly worstMs: number;
  /** Phase 19's own published ceiling; §26 names the metric but sets no number. */
  readonly ceilingMs: number;
}

/** One metric's measured result, with the arithmetic that produced it. */
export interface EvaluationMetricResult {
  readonly metric: AgentEvaluationMetric;
  readonly kind: EvaluationMetricKind;
  readonly direction: "at_least" | "at_most";
  readonly unit: "basis_points" | "minor_units" | "milliseconds";
  readonly threshold: number;
  readonly minimumSample: number;
  /** Observations considered. `unobserved` included, always. */
  readonly sampleSize: number;
  /**
   * The measured value, or `null` when the sample is too small.
   *
   * `null` means *not measured*, which is different from every number a
   * measurement could take, and is why a metric that cannot yet be judged never
   * contributes a value to a decision.
   */
  readonly measured: number | null;
  readonly status: EvaluationStatus;
  /** Rate metrics only: how the sample divides. `null` for the other kinds. */
  readonly counts: EvaluationVerdictCounts | null;
  /** `cost` only. */
  readonly cost: EvaluationCostBreakdown | null;
  /** `latency` only. */
  readonly latency: EvaluationLatencyBreakdown | null;
  /** Why this status, in one sentence, naming the numbers involved. */
  readonly reason: string;
}

/** The live evaluation round, as a report reader sees it. */
export interface EvaluationRunSummary {
  readonly id: EntityId;
  readonly runNumber: number;
  readonly openedBy: EntityId;
  readonly openedAt: DateTime;
  readonly observationCount: number;
}

/**
 * One agent version's evaluation, derived on read.
 *
 * `run` is `null` when no round has ever been opened for this version, and
 * every metric then reads `insufficient_evidence` with no value — the report is
 * still complete and honest, rather than absent or empty.
 */
export interface EvaluationReport {
  readonly ruleVersion: string;
  readonly agentId: AgentId;
  /** The declaration version this evidence is about, never a client value. */
  readonly agentVersion: string;
  readonly run: EvaluationRunSummary | null;
  /** Exactly the metrics this agent's declaration names, in declaration order. */
  readonly metrics: readonly EvaluationMetricResult[];
  readonly status: EvaluationStatus;
  /** Whether this evidence would let the lifecycle promote, and why. */
  readonly gate: EvaluationGateDecision;
}

/**
 * The promotion gate's answer, in the shape `@dealora/agent` consumes.
 *
 * It is derived here and nowhere else, from stored judgements — never from a
 * request. `satisfied` is false whenever anything is short of evidence or below
 * a threshold; there is no way to reach it with a flag.
 */
export interface EvaluationGateDecision {
  readonly satisfied: boolean;
  readonly reason: string;
}

/** One stored round, exactly as storage holds it. */
export interface EvaluationRunRow {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  /** One of the twelve agents; storage has checked it against its vocabulary. */
  readonly agentId: string;
  /** The declaration version this round is about. */
  readonly version: string;
  readonly runNumber: number;
  readonly createdBy: EntityId;
  readonly createdAt: DateTime;
}

/** One stored judgement, exactly as storage holds it. */
export interface EvaluationObservationRow {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly runId: EntityId;
  /** One of the thirteen metrics; storage has checked it against its vocabulary. */
  readonly metric: string;
  readonly subjectId: string;
  /** `null` for `cost` and `latency`, which carry a measurement instead. */
  readonly verdict: string | null;
  readonly amountMinor: number | null;
  readonly durationMs: number | null;
  readonly note: string | null;
  readonly createdBy: EntityId;
  readonly createdAt: DateTime;
}

/** One stored round, as the trail reports it. */
export interface EvaluationRunView {
  readonly id: EntityId;
  readonly agentId: AgentId;
  readonly agentVersion: string;
  readonly runNumber: number;
  readonly openedBy: EntityId;
  readonly openedAt: DateTime;
  /** Judgements in this round; a later round supersedes it entirely. */
  readonly observationCount: number;
  /** Whether this round is the one the report reads. */
  readonly live: boolean;
}

/** One stored judgement, exactly as a person recorded it. */
export interface EvaluationObservationView {
  readonly id: EntityId;
  readonly runId: EntityId;
  readonly metric: AgentEvaluationMetric;
  readonly subjectId: string;
  /** `null` for `cost` and `latency`, which carry a measurement instead. */
  readonly verdict: EvaluationVerdict | null;
  readonly amountMinor: number | null;
  readonly durationMs: number | null;
  readonly note: string | null;
  readonly recordedBy: EntityId;
  readonly recordedAt: DateTime;
}

/** The whole published rule set, readable before anything is measured. */
export interface EvaluationPolicyView {
  readonly ruleVersion: string;
  /** All thirteen of ROADMAP.md §26's metrics, in a fixed total order. */
  readonly metrics: readonly EvaluationMetricRule[];
  /** The three judgements a person may record, in a fixed order. */
  readonly verdicts: readonly EvaluationVerdict[];
  /** What each metric's observation must carry instead of a judgement. */
  readonly measuredMetrics: readonly {
    readonly metric: AgentEvaluationMetric;
    readonly unit: "minor_units" | "milliseconds";
  }[];
  readonly gateRule: string;
  readonly neverDoes: readonly string[];
}

/**
 * The storage surface this domain reads and writes through.
 *
 * Every method is workspace-scoped inside the repository with the caller's own
 * identity, and none of them takes an actor, a timestamp or a workspace from
 * the caller as something it may set — they take them as *who is asking*.
 */
export interface EvaluationRepository {
  authorize(workspaceId: string, userId: string): EvaluationStorageResult<unknown>;
  createAgentEvaluationRun(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): EvaluationStorageResult<EvaluationRunRow>;
  getCurrentAgentEvaluationRun(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): EvaluationStorageResult<EvaluationRunRow | null>;
  listAgentEvaluationRuns(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): EvaluationStorageResult<readonly EvaluationRunRow[]>;
  createAgentEvaluationObservation(input: {
    workspaceId: string;
    userId: string;
    runId: string;
    metric: string;
    subjectId: string;
    verdict: string | null;
    amountMinor: number | null;
    durationMs: number | null;
    note: string | null;
  }): EvaluationStorageResult<EvaluationObservationRow>;
  listAgentEvaluationObservations(
    workspaceId: string,
    userId: string,
    runId: string,
  ): EvaluationStorageResult<readonly EvaluationObservationRow[]>;
}
