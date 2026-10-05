/**
 * @dealora/cost — types for the Phase 16 Cost Engine (ROADMAP.md §23,
 * DEALORA_BLUEPRINT.md §33).
 *
 * The model splits cleanly in two, and every type below belongs to one side:
 *
 * - **Recorded cost facts** (`CostEventRow` / `CostEventView`): immutable,
 *   append-only rows with a whole-number `amountMinor` in one workspace
 *   currency, attributed server-side to the session and to a real execution of
 *   the same workspace. Facts are never edited, revalued or deleted.
 *
 * - **Derived cost aggregates** (`CostBreakdown`, `DerivedCostMetric`,
 *   `WorkspaceCostMetrics`, `ExecutionCostSummary`): computed on read from the
 *   facts alone. There is no stored total anywhere, so a stale aggregate is
 *   structurally impossible and a fact is never rewritten to simplify a sum.
 *
 * Negative space, stated once and enforced everywhere:
 * - no floating-point arithmetic touches a monetary value (see `money.ts`),
 * - no client-provided total, attribution or timestamp is ever trusted,
 * - no currency mixing: totals are computed within one workspace currency,
 * - no refunds or reversals: this phase's vocabulary cannot represent a
 *   negative amount, so a negative cost is refused rather than encoded,
 * - no network, no scheduler, no provider: recording a fact is a local
 *   append against storage the service already holds.
 */

import type { CostBasis, CostCategory, CostExecutionKind, CostEvent } from "@dealora/db";

export type { CostBasis, CostCategory, CostExecutionKind };

/** The closed error vocabulary this domain reports to the transport layer. */
export type CostErrorCode =
  "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_ERROR" | "CONFLICT" | "UNAVAILABLE";

export interface CostError {
  readonly code: CostErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/**
 * Every store method's result shape, stated structurally so the service can
 * be wired to the concrete repository without importing its internals.
 */
export type StorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

/** One persisted cost fact — exactly the rows the derivations read. */
export type CostEventRow = CostEvent;

/**
 * One recorded cost fact as callers see it: the stored fields and nothing
 * else. `createdBy` / `createdAt` are echoed so a caller can verify who the
 * server attributed the fact to; there is no field a client could have
 * written to influence them.
 */
export interface CostEventView {
  readonly id: string;
  readonly executionKind: CostExecutionKind;
  readonly executionId: string;
  readonly category: CostCategory;
  readonly basis: CostBasis;
  readonly amountMinor: number;
  readonly currency: string;
  readonly source: string | null;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** One category's share of a breakdown. */
export interface CostCategoryAmount {
  readonly category: CostCategory;
  readonly amountMinor: number;
}

/**
 * The derived totals over a set of cost facts.
 *
 * `estimatedMinor` and `measuredMinor` are the **raw** sums of each basis —
 * they disclose exactly what was recorded. `totalMinor` is the
 * **double-count-safe** total: within one (execution, category) pair, a
 * measured fact supersedes an estimated one, so an estimate that was later
 * measured is reported in `supersededEstimateMinor` and excluded from the
 * total instead of being added twice. The invariant
 * `totalMinor === measuredMinor + (estimatedMinor - supersededEstimateMinor)`
 * is tested directly.
 */
export interface CostBreakdown {
  /** The workspace's single currency; `null` when no fact exists yet. */
  readonly currency: string | null;
  readonly eventCount: number;
  readonly totalMinor: number;
  readonly estimatedMinor: number;
  readonly measuredMinor: number;
  readonly supersededEstimateMinor: number;
  readonly byCategory: readonly CostCategoryAmount[];
}

/** The three per-outcome metrics Phase 16 can derive from rows that exist. */
export type DerivedCostMetricName =
  "cost_per_prospect" | "cost_per_qualified_opportunity" | "cost_per_meeting";

/**
 * A derived per-outcome metric.
 *
 * `averageMinor` is an **integer** number of minor units (floored), and the
 * un-divided remainder is reported as `remainderMinor` rather than silently
 * discarded — the exact quotient is `(numeratorMinor / denominator)`, always
 * reconstructable from the three integers. `status` is `no_data` — never a
 * fabricated zero — when nothing was recorded or the denominator is empty, so
 * "we have not measured this" is never presented as "this costs nothing".
 */
export interface DerivedCostMetric {
  readonly name: DerivedCostMetricName;
  readonly status: "derived" | "no_data";
  readonly numeratorMinor: number;
  readonly denominator: number;
  readonly averageMinor: number | null;
  readonly remainderMinor: number;
  readonly currency: string | null;
  readonly reason: string | null;
}

/** The three metrics ROADMAP.md §23 lists that no Phase 0–16 row can feed. */
export type RefusedCostMetricName =
  "cost_per_customer" | "revenue_per_ai_cost" | "revenue_per_campaign";

/** A named refusal: why the metric cannot be computed, and who owns it later. */
export interface RefusedCostMetric {
  readonly name: RefusedCostMetricName;
  readonly reason: string;
  readonly owningPhase: string | null;
}

/** The denominators the derived metrics divide by, each defined in policy. */
export interface CostDenominators {
  readonly prospects: number;
  readonly qualifiedOpportunities: number;
  readonly meetings: number;
}

/** The workspace's whole cost picture, all of it derived on read. */
export interface WorkspaceCostMetrics {
  readonly ruleVersion: string;
  readonly totals: CostBreakdown;
  readonly denominators: CostDenominators;
  readonly metrics: readonly DerivedCostMetric[];
  readonly refused: readonly RefusedCostMetric[];
}

/**
 * The gate answer: what one execution cost, split by basis. `totals` carries
 * the estimated and measured sums and the double-count-safe total, so a
 * workflow execution can show estimated **or** measured cost.
 */
export interface ExecutionCostSummary {
  readonly ruleVersion: string;
  readonly executionKind: CostExecutionKind;
  readonly executionId: string;
  readonly totals: CostBreakdown;
}

/** The published category vocabulary, with what each bucket means. */
export interface CostCategoryDefinition {
  readonly category: CostCategory;
  readonly semantics: string;
}

export interface CostBasisDefinition {
  readonly basis: CostBasis;
  readonly semantics: string;
}

/** One execution kind the engine refuses, and the phase that owns it. */
export interface RefusedExecutionKind {
  readonly name: string;
  readonly reason: string;
  readonly owningPhase: string | null;
}

/** How a metric's denominator is counted, stated as data. */
export interface DenominatorDefinition {
  readonly metric: DerivedCostMetricName;
  readonly definition: string;
}

/** One entry in the published metric partition: derivable or refused. */
export interface MetricPolicyEntry {
  readonly name: DerivedCostMetricName | RefusedCostMetricName;
  readonly status: "derived" | "refused";
  readonly reason: string;
  readonly owningPhase: string | null;
}

/** The limits this domain enforces, published so a caller can self-check. */
export interface CostLimits {
  readonly amountMinorMin: number;
  readonly amountMinorMax: number;
  readonly idempotencyKeyMin: number;
  readonly idempotencyKeyMax: number;
  readonly sourceMin: number;
  readonly sourceMax: number;
}

/** Everything this deployment's cost vocabulary allows, and everything it refuses. */
export interface CostPolicyView {
  readonly ruleVersion: string;
  readonly categories: readonly CostCategoryDefinition[];
  readonly bases: readonly CostBasisDefinition[];
  readonly executionKinds: readonly CostExecutionKind[];
  readonly refusedExecutionKinds: readonly RefusedExecutionKind[];
  readonly currencies: readonly string[];
  readonly oneCurrencyPerWorkspace: boolean;
  readonly limits: CostLimits;
  readonly aggregationRule: string;
  readonly denominators: readonly DenominatorDefinition[];
  readonly metrics: readonly MetricPolicyEntry[];
  readonly neverDoes: readonly string[];
}

/** What a caller may send to the record route: the fact's fields, and no identity. */
export interface RecordCostInput {
  readonly executionKind: unknown;
  readonly executionId: unknown;
  readonly category: unknown;
  readonly basis: unknown;
  readonly amountMinor: unknown;
  readonly currency: unknown;
  readonly source: unknown;
  readonly occurredAt: unknown;
  readonly idempotencyKey: unknown;
}

/**
 * The validated command the service hands to storage. `createdBy` is always
 * the session's user — this type has no field a request body can populate,
 * because the record method never reads identity from the body.
 */
export interface RecordCostCommand {
  readonly executionKind: CostExecutionKind;
  readonly executionId: string;
  readonly category: CostCategory;
  readonly basis: CostBasis;
  readonly amountMinor: number;
  readonly currency: string;
  readonly source: string | null;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

/** Optional narrowing for the list route; every value is vocabulary-checked. */
export interface CostEventFilter {
  readonly executionKind: unknown;
  readonly executionId: unknown;
  readonly category: unknown;
  readonly basis: unknown;
}

/** The execution selector for the gate route. */
export interface ExecutionCostQuery {
  readonly executionKind: unknown;
  readonly executionId: unknown;
}

/**
 * The storage surface the Cost Engine reads and writes through. Every method
 * is workspace-scoped inside the repository itself: the service passes the
 * caller's identity, never a role or a claim the client sent.
 */
export interface CostRepository {
  authorize(workspaceId: string, userId: string): StorageResult<unknown>;
  createCostEvent(input: {
    readonly workspaceId: string;
    readonly createdBy: string;
    readonly event: RecordCostCommand;
  }): StorageResult<CostEventRow>;
  getCostEvent(id: string, userId: string): StorageResult<CostEventRow>;
  listCostEvents(
    workspaceId: string,
    userId: string,
    filter?: {
      readonly executionKind?: CostExecutionKind | undefined;
      readonly executionId?: string | undefined;
      readonly category?: CostCategory | undefined;
      readonly basis?: CostBasis | undefined;
    },
  ): StorageResult<readonly CostEventRow[]>;
  /**
   * The gate's precondition: the execution is a real run of this workspace.
   * A foreign or unknown id is NOT_FOUND either way, so another tenant's
   * execution ids are never discoverable through this route.
   */
  executionExists(
    workspaceId: string,
    userId: string,
    kind: CostExecutionKind,
    executionId: string,
  ): StorageResult<true>;
  /** The metric denominators, counted from stored rows inside this workspace. */
  denominators(workspaceId: string, userId: string): StorageResult<CostDenominators>;
}
