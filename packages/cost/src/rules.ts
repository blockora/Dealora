/**
 * The Phase 16 cost rule set, declared once as data.
 *
 * Everything the Cost Engine publishes — categories, bases, execution kinds,
 * currencies, limits, metrics — is defined here and nowhere else, so the
 * policy route, the validator and the tests all read the same tables and a
 * vocabulary value cannot be advertised without being enforceable.
 *
 * The metric list is a **partition**: the three metrics Phases 0–16 can
 * actually derive and the three ROADMAP.md §23 lists that no stored row can
 * yet feed. Every refusal carries its reason and the phase that owns it, so
 * "we cannot compute this yet" is a first-class answer rather than a missing
 * row or a fabricated zero.
 */

import type { CostBasis, CostCategory, CostExecutionKind } from "@dealora/db";
import type {
  CostBasisDefinition,
  CostCategoryDefinition,
  CostError,
  CostErrorCode,
  CostPolicyView,
  DenominatorDefinition,
  DerivedCostMetricName,
  MetricPolicyEntry,
  RefusedCostMetric,
  RefusedCostMetricName,
} from "./types.js";

/** The rule set version. Bumped whenever a rule's semantics change. */
export const COST_RULE_VERSION = "cost-1.0.0";

/**
 * The six cost categories `ROADMAP.md` §23 and `DEALORA_BLUEPRINT.md` §33
 * name. Published with the semantics of each bucket so a recorded fact's
 * meaning does not depend on the reader's guess.
 */
export const COST_CATEGORIES: readonly CostCategoryDefinition[] = [
  {
    category: "llm",
    semantics: "model inference — tokens and calls to language models.",
  },
  {
    category: "search",
    semantics: "lookups against search or enrichment endpoints during a run.",
  },
  {
    category: "data",
    semantics: "purchased or licensed data consumed while researching an account.",
  },
  {
    category: "tool",
    semantics: "third-party tool calls made on behalf of the run.",
  },
  {
    category: "infrastructure",
    semantics: "compute, storage and platform cost attributable to the run.",
  },
  {
    category: "execution",
    semantics: "orchestration and platform overhead of running the workflow itself.",
  },
];

/**
 * The two bases ROADMAP.md §23's gate turns on: an **estimate** made before
 * the fact and a **measurement** taken from usage or billing records. A run
 * can show either or both; which one is recorded travels with every fact.
 */
export const COST_BASES: readonly CostBasisDefinition[] = [
  {
    basis: "estimated",
    semantics:
      "a predicted amount recorded before the usage was billed — a forecast, not an invoice.",
  },
  {
    basis: "measured",
    semantics: "an amount taken from an actual usage or billing record after the fact.",
  },
];

/**
 * The execution kinds this repository can actually perform today.
 *
 * Phase 16 published the first three. Phase 20 adds exactly one — `agent_run` —
 * because `ROADMAP.md` §27 requires a traced production agent run to report its
 * cost, and Phase 16's own rule is that cost belongs on its facts rather than in
 * a second table. The kind is published here rather than in Phase 20 so there is
 * still one list of what a cost may be attributed to, and so the storage
 * existence gate resolves it through the same route as the other three.
 */
export const COST_EXECUTION_KINDS: readonly CostExecutionKind[] = [
  "research_run",
  "outbound_send",
  "meeting_booking",
  "agent_run",
  "crm_sync",
];

/**
 * Execution kinds named by the roadmap that Phase 16 refuses rather than
 * publishes: advertising an unreachable kind would make a caller believe a
 * workflow run had been costed when no workflow engine exists to run one.
 */
export const REFUSED_EXECUTION_KINDS: readonly {
  readonly name: string;
  readonly reason: string;
  readonly owningPhase: string | null;
}[] = [
  {
    name: "workflow",
    reason:
      "no phase through 16 runs workflows: ROADMAP.md §32 assigns the Workflow Engine to Phase 24, so no workflow execution exists here to attribute a cost to.",
    owningPhase: "Phase 24",
  },
];

/**
 * The closed currency list. These are exactly the currencies the goal parser
 * already understands, so a workspace's costs and its revenue goal speak the
 * same money. One currency per workspace is enforced in storage, so no total
 * can ever add across currencies.
 */
export const COST_CURRENCIES: readonly string[] = ["USD", "EUR", "GBP", "JPY"];

/**
 * The published limits. `amountMinor` is bounded by JavaScript's safe integer
 * range on purpose: an amount that cannot be represented exactly is refused
 * at the boundary rather than rounded at read time.
 */
export const COST_LIMITS = {
  amountMinorMin: 0,
  amountMinorMax: Number.MAX_SAFE_INTEGER,
  idempotencyKeyMin: 1,
  idempotencyKeyMax: 128,
  sourceMin: 1,
  sourceMax: 128,
} as const;

/**
 * How aggregates avoid double counting, stated as one sentence and enforced
 * line-for-line in `engine.ts`: within one (execution, category) pair a
 * measured fact supersedes an estimated one, so an estimate that was later
 * measured is excluded from the total — disclosed, not deleted.
 */
export const AGGREGATION_RULE =
  "raw estimated and measured sums are always reported; the combined total counts measured facts where a measurement exists for the same execution and category, and estimated facts only where nothing was measured yet, so an estimate superseded by its measurement is never added twice";

/** How each derivable metric's denominator is counted. */
export const DENOMINATOR_DEFINITIONS: readonly DenominatorDefinition[] = [
  {
    metric: "cost_per_prospect",
    definition:
      "one per stored target account (Phase 5), regardless of status — an archived prospect still cost something to acquire.",
  },
  {
    metric: "cost_per_qualified_opportunity",
    definition:
      "one per account whose newest qualification (highest version, versions never reused) is `qualified`, matching the Phase 15 opportunity rule exactly.",
  },
  {
    metric: "cost_per_meeting",
    definition:
      "one per stored meeting row (Phase 13), regardless of booking state — a cancelled meeting still consumed the run that proposed it.",
  },
];

/** The three metrics Phase 16 derives, and the three it refuses. */
export const METRIC_PARTITION: readonly MetricPolicyEntry[] = [
  {
    name: "cost_per_prospect",
    status: "derived",
    reason: "recorded cost over the stored target accounts.",
    owningPhase: null,
  },
  {
    name: "cost_per_qualified_opportunity",
    status: "derived",
    reason: "recorded cost over the accounts currently holding a qualified opportunity.",
    owningPhase: null,
  },
  {
    name: "cost_per_meeting",
    status: "derived",
    reason: "recorded cost over the stored meetings.",
    owningPhase: null,
  },
  {
    name: "cost_per_customer",
    status: "refused",
    reason:
      "no phase through 16 records a customer; ROADMAP.md §24 reports Customers as a dashboard outcome and §30's CRM integrations would sync them.",
    owningPhase: "Phase 17 / 23",
  },
  {
    name: "revenue_per_ai_cost",
    status: "refused",
    reason:
      "no phase through 16 records realized revenue: Phase 16 measures cost, and ROADMAP.md §24 reports Direct Revenue as an outcome — a ratio needs both sides.",
    owningPhase: "Phase 17",
  },
  {
    name: "revenue_per_campaign",
    status: "refused",
    reason:
      "no phase through 16 records realized revenue, and no roadmap phase yet produces a campaign object — DEALORA_BLUEPRINT.md §16 defines it but assigns it no phase, so there is nothing to divide.",
    owningPhase: null,
  },
];

/** The derived-metric names, derived from the partition above. */
export const DERIVED_METRIC_NAMES: readonly DerivedCostMetricName[] = METRIC_PARTITION.filter(
  (entry) => entry.status === "derived",
).map((entry) => entry.name) as DerivedCostMetricName[];

/** The refused-metric names, derived from the same partition. */
export const REFUSED_METRIC_NAMES: readonly RefusedCostMetricName[] = METRIC_PARTITION.filter(
  (entry) => entry.status === "refused",
).map((entry) => entry.name) as RefusedCostMetricName[];

/**
 * The refusals as data, each carrying its owning phase. Built from the one
 * partition above so a refusal can never drift from its published policy.
 */
export const REFUSED_METRICS: readonly RefusedCostMetric[] = METRIC_PARTITION.filter(
  (entry) => entry.status === "refused",
).map((entry) => ({
  name: entry.name as RefusedCostMetricName,
  reason: entry.reason,
  owningPhase: entry.owningPhase,
}));

/**
 * What the Cost Engine never does. The negative space is the design: the
 * items below are refusals, not TODOs.
 */
export const NEVER_DO: readonly string[] = [
  "never stores a total, average or ratio — every aggregate is derived from the facts on read, so a stale number cannot exist",
  "never edits, revalues or deletes a recorded cost fact — history is append-only",
  "never trusts a client-supplied total, attribution, creator or recorded-at instant — identity and clocks are the server's",
  "never mixes currencies in one workspace total — the first fact fixes the currency and a second one is refused",
  "never performs floating-point arithmetic on money — amounts are whole minor units, and division is exact integer arithmetic",
  "never represents a negative amount, refund or reversal — this phase has no such vocabulary, so a negative cost cannot be recorded",
  "never reaches the network — recording a cost is a local append; no provider, billing API or credential exists here",
  "never schedules, queues or retries in the background — a fact is recorded when a caller asks for it, or not at all",
  "never derives a customer, revenue or campaign metric — Phase 17+ owns the rows those ratios need, and they are refused with their owning phase rather than approximated",
];

/** Build a domain error. */
export function costError(
  code: CostErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): CostError {
  if (details === undefined) return { code, message };
  return { code, message, details };
}

/**
 * Narrow an unknown to a member of a closed vocabulary, or `null`.
 * Used by the service so a value outside the list is refused, never coerced.
 */
export function inVocabulary<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** The category vocabulary values, for membership checks. */
export const COST_CATEGORY_VALUES: readonly CostCategory[] = COST_CATEGORIES.map(
  (entry) => entry.category,
);

/** The basis vocabulary values, for membership checks. */
export const COST_BASIS_VALUES: readonly CostBasis[] = COST_BASES.map((entry) => entry.basis);

/** The full rule set as the policy route publishes it. */
export function describeCostPolicy(): CostPolicyView {
  return {
    ruleVersion: COST_RULE_VERSION,
    categories: COST_CATEGORIES.map((entry) => ({ ...entry })),
    bases: COST_BASES.map((entry) => ({ ...entry })),
    executionKinds: [...COST_EXECUTION_KINDS],
    refusedExecutionKinds: REFUSED_EXECUTION_KINDS.map((entry) => ({ ...entry })),
    currencies: [...COST_CURRENCIES],
    oneCurrencyPerWorkspace: true,
    limits: { ...COST_LIMITS },
    aggregationRule: AGGREGATION_RULE,
    denominators: DENOMINATOR_DEFINITIONS.map((entry) => ({ ...entry })),
    metrics: METRIC_PARTITION.map((entry) => ({ ...entry })),
    neverDoes: [...NEVER_DO],
  };
}
