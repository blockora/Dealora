/**
 * The pure derivations of the Cost Engine — ROADMAP.md §23's derived metrics
 * and `DEALORA_BLUEPRINT.md` §33's per-run totals, computed from recorded
 * facts alone.
 *
 * The engine is a function of its input and nothing else: no clock, no
 * randomness, no storage, no session. The same facts always produce the same
 * breakdown, which is what makes every aggregate in this phase checkable —
 * a reader can re-derive any total from the rows and get the same number.
 *
 * Two failure modes return `null` rather than a number, because a wrong total
 * is worse than no total:
 *
 * - a mixed-currency input (storage prevents it; the engine refuses it again),
 * - a sum that would leave the safe-integer range.
 */

import type { CostBasis, CostCategory, CostExecutionKind } from "@dealora/db";
import { COST_CATEGORY_VALUES } from "./rules.js";
import { isMinorAmount, divideMinor, sumMinor } from "./money.js";
import type {
  CostBreakdown,
  CostDenominators,
  DerivedCostMetric,
  DerivedCostMetricName,
  RefusedCostMetric,
} from "./types.js";
import { REFUSED_METRICS } from "./rules.js";

/** The minimum a derivation reads from a recorded fact. */
export interface CostFactLike {
  readonly id: string;
  readonly executionKind: CostExecutionKind;
  readonly executionId: string;
  readonly category: CostCategory;
  readonly basis: CostBasis;
  readonly amountMinor: number;
  readonly currency: string;
}

/**
 * A pair of (execution, category): the unit at which a measurement supersedes
 * an estimate. Keyed `executionId|category` — execution ids are globally
 * unique, so the kind is implied by the execution itself.
 */
function pairKey(fact: CostFactLike): string {
  return `${fact.executionId}|${fact.category}`;
}

/**
 * Derive every total from a set of recorded facts.
 *
 * Raw estimated and measured sums are always reported in full. The combined
 * `totalMinor` applies the supersession rule: within one (execution,
 * category) pair, measured facts win, and estimated facts in that pair are
 * disclosed in `supersededEstimateMinor` instead of being added on top of
 * their own measurement. Facts whose amount is not a whole non-negative
 * integer are refused outright — the whole derivation returns `null` rather
 * than quietly skipping a row, because a total that silently omitted a fact
 * would be a fabrication.
 */
export function deriveBreakdown(facts: readonly CostFactLike[]): CostBreakdown | null {
  if (facts.length === 0) {
    return {
      currency: null,
      eventCount: 0,
      totalMinor: 0,
      estimatedMinor: 0,
      measuredMinor: 0,
      supersededEstimateMinor: 0,
      byCategory: COST_CATEGORY_VALUES.map((category) => ({ category, amountMinor: 0 })),
    };
  }

  const currency = facts[0]?.currency;
  if (currency === undefined || currency === "") return null;

  let supersededEstimateMinor = 0;
  const estimatedByPair = new Map<string, { category: CostCategory; amountMinor: number }>();
  const measuredByPair = new Map<string, { category: CostCategory; amountMinor: number }>();

  for (const fact of facts) {
    if (fact.currency !== currency) return null;
    if (!isMinorAmount(fact.amountMinor)) return null;
    const target = fact.basis === "measured" ? measuredByPair : estimatedByPair;
    if (fact.basis !== "measured" && fact.basis !== "estimated") return null;
    const key = pairKey(fact);
    const existing = target.get(key);
    if (existing === undefined) {
      target.set(key, { category: fact.category, amountMinor: fact.amountMinor });
    } else {
      const next = existing.amountMinor + fact.amountMinor;
      if (!Number.isSafeInteger(next)) return null;
      existing.amountMinor = next;
    }
  }

  const estimatedSum = sumMinor([...estimatedByPair.values()].map((entry) => entry.amountMinor));
  const measuredSum = sumMinor([...measuredByPair.values()].map((entry) => entry.amountMinor));
  if (estimatedSum === null || measuredSum === null) return null;
  const estimatedMinor = estimatedSum;
  const measuredMinor = measuredSum;

  // The effective amount per pair: measured when a measurement exists,
  // estimated only where nothing was measured yet.
  const effectiveByPair = new Map<string, { category: CostCategory; amountMinor: number }>();
  for (const [key, entry] of estimatedByPair) {
    const measured = measuredByPair.get(key);
    if (measured !== undefined) {
      supersededEstimateMinor += entry.amountMinor;
    } else {
      effectiveByPair.set(key, { ...entry });
    }
  }
  for (const [key, entry] of measuredByPair) {
    const existing = effectiveByPair.get(key);
    if (existing === undefined) {
      effectiveByPair.set(key, { ...entry });
    } else {
      const next = existing.amountMinor + entry.amountMinor;
      if (!Number.isSafeInteger(next)) return null;
      existing.amountMinor = next;
    }
  }

  const total = sumMinor([...effectiveByPair.values()].map((entry) => entry.amountMinor));
  if (total === null) return null;

  const byCategory = COST_CATEGORY_VALUES.map((category) => {
    let amount = 0;
    for (const entry of effectiveByPair.values()) {
      if (entry.category === category) amount += entry.amountMinor;
    }
    return { category, amountMinor: amount };
  });

  return {
    currency,
    eventCount: facts.length,
    totalMinor: total,
    estimatedMinor,
    measuredMinor,
    supersededEstimateMinor,
    byCategory,
  };
}

/** Why a metric could not be derived, phrased for a reader. */
function noDataReason(name: DerivedCostMetricName, breakdown: CostBreakdown): string {
  if (breakdown.eventCount === 0) {
    return "no cost fact has been recorded yet, so there is nothing to divide — an empty numerator is reported as no data, never as zero cost";
  }
  switch (name) {
    case "cost_per_prospect":
      return "this workspace has no stored target accounts to divide by";
    case "cost_per_qualified_opportunity":
      return "no account currently holds a qualified opportunity";
    case "cost_per_meeting":
      return "this workspace has no stored meetings to divide by";
  }
}

/**
 * Derive one per-outcome metric: the effective total over a denominator.
 *
 * `no_data` — never a fabricated zero — whenever nothing was recorded or the
 * denominator is empty. The exact quotient survives as
 * `numerator = average * denominator + remainder`, all integers.
 */
export function deriveMetric(
  name: DerivedCostMetricName,
  breakdown: CostBreakdown,
  denominator: number,
): DerivedCostMetric {
  const numeratorMinor = breakdown.totalMinor;
  const currency = breakdown.currency;
  const divide = divideMinor(numeratorMinor, denominator);
  if (breakdown.eventCount === 0 || divide === null) {
    return {
      name,
      status: "no_data",
      numeratorMinor,
      denominator,
      averageMinor: null,
      remainderMinor: numeratorMinor,
      currency,
      reason: noDataReason(name, breakdown),
    };
  }
  return {
    name,
    status: "derived",
    numeratorMinor,
    denominator,
    averageMinor: divide.averageMinor,
    remainderMinor: divide.remainderMinor,
    currency,
    reason: null,
  };
}

/**
 * The three derived metrics, in the order the policy publishes them, plus
 * the three refusals with their owning phases. Deterministic and total: the
 * six names ROADMAP.md §23 lists appear exactly once between the two lists.
 */
export function deriveMetrics(
  breakdown: CostBreakdown,
  denominators: CostDenominators,
): { metrics: readonly DerivedCostMetric[]; refused: readonly RefusedCostMetric[] } {
  const metrics: readonly DerivedCostMetric[] = [
    deriveMetric("cost_per_prospect", breakdown, denominators.prospects),
    deriveMetric("cost_per_qualified_opportunity", breakdown, denominators.qualifiedOpportunities),
    deriveMetric("cost_per_meeting", breakdown, denominators.meetings),
  ];
  return { metrics, refused: REFUSED_METRICS };
}
