/**
 * @dealora/evaluation — pure derivations for Phase 19.
 *
 * Every function here is a function of its arguments and the constant table in
 * `rules.ts`. There is no clock, no randomness, no store, no network and no
 * model: the same judgements always produce the same numbers, the same status,
 * the same reason and the same JSON, on any machine, at any time.
 *
 * Three decisions carry the rest:
 *
 * 1. **Rates are exact integers.** A rate is computed as
 *    `floor(met × 10000 / sampleSize)` and compared by **cross-multiplication**,
 *    never by dividing a float and rounding. `4/5` is therefore exactly 8000
 *    basis points, it meets an 8000 threshold, and `3/5` is 6000 and does not —
 *    decided the same way every run, with no epsilon.
 * 2. **`unobserved` stays in the denominator.** It is never counted as a good
 *    judgement, for any direction. Declining to evaluate a subject can only
 *    lower a metric, never raise it.
 * 3. **Absence produces no number.** Below `minimumSample` a metric is
 *    `insufficient_evidence` with `measured: null`, and `null` is not zero: the
 *    gate reads the status, never the value, so a metric nobody could measure
 *    cannot quietly pass.
 */

import type { AgentCostLimit, AgentDeclaration, AgentId } from "@dealora/agent";

import {
  BASIS_POINT_SCALE,
  EVALUATION_METRICS,
  EVALUATION_RULE_VERSION,
  metricOrder,
  metricRule,
} from "./rules.js";
import type {
  EvaluationGateDecision,
  EvaluationMetricResult,
  EvaluationMetricRule,
  EvaluationObservationView,
  EvaluationReport,
  EvaluationRunRow,
  EvaluationRunSummary,
  EvaluationRunView,
  EvaluationStatus,
  EvaluationVerdictCounts,
} from "./types.js";

/**
 * Add without ever leaving the exact integer range.
 *
 * Amounts are whole minor units and are validated as safe integers on the way
 * in, so a sum can only overflow with an absurd number of recorded runs. It is
 * saturated rather than wrapped so that an overflowing total reads as
 * unimaginably large — which it is — instead of silently wrapping into a small
 * number and passing a budget check.
 */
function addExact(total: number, next: number): number {
  const sum = total + next;
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

/** Split a metric's observations into the three verdict counts. */
function countVerdicts(
  observations: readonly EvaluationObservationView[],
): EvaluationVerdictCounts {
  let met = 0;
  let unmet = 0;
  let unobserved = 0;
  for (const observation of observations) {
    if (observation.verdict === "met") met += 1;
    else if (observation.verdict === "unobserved") unobserved += 1;
    else unmet += 1;
  }
  return { met, unmet, unobserved };
}

/** `floor(value / total)` in basis points, computed with integers only. */
function toBasisPoints(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((value * BASIS_POINT_SCALE) / total);
}

/**
 * Does a rate of `met` out of `total` satisfy a published threshold?
 *
 * `at_least` is `met × 10000 ≥ threshold × total`. `at_most` states a ceiling on
 * the failures, so it is the same comparison against the complementary floor
 * `10000 − threshold` — which is why `hallucination_rate ≤ 500` and
 * `task_success ≥ 8000` are the same arithmetic read two ways.
 *
 * Both products stay far inside the safe integer range: a sample large enough
 * to overflow `10000 × total` would need hundreds of billions of stored rows.
 */
function rateSatisfies(
  direction: "at_least" | "at_most",
  thresholdBasisPoints: number,
  met: number,
  total: number,
): boolean {
  const required =
    direction === "at_least" ? thresholdBasisPoints : BASIS_POINT_SCALE - thresholdBasisPoints;
  return met * BASIS_POINT_SCALE >= required * total;
}

/**
 * One rate metric: the share of judgements that were `met`.
 *
 * The whole sample is the denominator, `unobserved` included. With fewer
 * observations than `minimumSample` the metric reports `insufficient_evidence`
 * and **no** `measured` value at all.
 */
export function measureRate(
  metric: string,
  observations: readonly EvaluationObservationView[],
): EvaluationMetricResult {
  const published = metricRule(metric);
  if (published === null) {
    // Unreachable while the caller draws metrics from `AGENT_EVALUATION_METRICS`;
    // refused rather than asserted away, so a widened vocabulary fails loudly.
    throw new Error(`no published evaluation rule for ${metric}`);
  }
  const counts = countVerdicts(observations);
  const sampleSize = counts.met + counts.unmet + counts.unobserved;
  const base = {
    metric: published.metric,
    kind: published.kind,
    direction: published.direction,
    unit: "basis_points",
    threshold: published.threshold,
    minimumSample: published.minimumSample,
    sampleSize,
    counts,
    cost: null,
    latency: null,
  } as const;

  if (sampleSize < published.minimumSample) {
    return {
      ...base,
      measured: null,
      status: "insufficient_evidence",
      reason: `only ${sampleSize} of the ${published.minimumSample} judgements this metric needs have been recorded, so it has not been measured.`,
    };
  }
  const satisfied = rateSatisfies(published.direction, published.threshold, counts.met, sampleSize);
  const bound = published.direction === "at_least" ? "at least" : "at most";
  return {
    ...base,
    measured: toBasisPoints(counts.met, sampleSize),
    status: satisfied ? "met" : "unmet",
    reason: `${counts.met} of ${sampleSize} judgements were met (${counts.unobserved} unobserved), against a requirement of ${bound} ${published.threshold} of ${BASIS_POINT_SCALE} basis points.`,
  };
}

/**
 * The `cost` metric: the sum of recorded spend against the agent's **own**
 * declared ceiling, and the largest single run against its per-execution
 * ceiling.
 *
 * The thresholds come from `@dealora/agent`'s declaration table, not from
 * `rules.ts`, because §25 already requires every agent to declare them and one
 * number should have one owner. Both are checked: an agent can spend under its
 * total ceiling and still blow through a single execution, and that is a
 * failure.
 */
export function measureCost(
  observations: readonly EvaluationObservationView[],
  limits: AgentCostLimit,
): EvaluationMetricResult {
  let totalMinor = 0;
  let worstMinor = 0;
  for (const observation of observations) {
    const amount = observation.amountMinor ?? 0;
    totalMinor = addExact(totalMinor, amount);
    if (amount > worstMinor) worstMinor = amount;
  }
  const sampleSize = observations.length;
  const overSpend = totalMinor > limits.maxSpendMinor;
  const overPerExecution = worstMinor > limits.maxPerExecutionMinor;
  const satisfied = !overSpend && !overPerExecution;
  const reason = `recorded spend is ${totalMinor} ${limits.currency} minor units across ${sampleSize} observation(s); the declared ceiling is ${limits.maxSpendMinor} per run and ${limits.maxPerExecutionMinor} per execution, and the largest single observation was ${worstMinor}.`;
  return {
    metric: "cost",
    kind: "spend_minor",
    direction: "at_most",
    unit: "minor_units",
    threshold: limits.maxSpendMinor,
    minimumSample: 1,
    sampleSize,
    measured: sampleSize === 0 ? null : totalMinor,
    status: sampleSize === 0 ? "insufficient_evidence" : satisfied ? "met" : "unmet",
    counts: null,
    cost: {
      currency: limits.currency,
      totalMinor,
      worstMinor,
      maxSpendMinor: limits.maxSpendMinor,
      maxPerExecutionMinor: limits.maxPerExecutionMinor,
      overSpend,
      overPerExecution,
    },
    latency: null,
    reason:
      sampleSize === 0
        ? "no spend has been recorded for this agent version yet, so it has not been measured."
        : reason,
  };
}

/**
 * The `latency` metric: the **slowest** recorded run against Phase 19's
 * published ceiling.
 *
 * A maximum and not an average, because the run a person waited on is the one
 * they remember and an average would let it disappear into the rest.
 */
export function measureLatency(
  observations: readonly EvaluationObservationView[],
): EvaluationMetricResult {
  const published = metricRule("latency");
  if (published === null) {
    throw new Error("no published evaluation rule for latency");
  }
  let worstMs = 0;
  for (const observation of observations) {
    const duration = observation.durationMs ?? 0;
    if (duration > worstMs) worstMs = duration;
  }
  const sampleSize = observations.length;
  const satisfied = worstMs <= published.threshold;
  return {
    metric: "latency",
    kind: "duration_ms",
    direction: "at_most",
    unit: "milliseconds",
    threshold: published.threshold,
    minimumSample: published.minimumSample,
    sampleSize,
    measured: sampleSize === 0 ? null : worstMs,
    status: sampleSize === 0 ? "insufficient_evidence" : satisfied ? "met" : "unmet",
    counts: null,
    cost: null,
    latency: { worstMs, ceilingMs: published.threshold },
    reason:
      sampleSize === 0
        ? "no run duration has been recorded for this agent version yet, so it has not been measured."
        : `the slowest recorded run took ${worstMs} ms against a published ceiling of ${published.threshold} ms.`,
  };
}

/** One metric's result, whichever of the three shapes it takes. */
export function measureMetric(
  metric: string,
  observations: readonly EvaluationObservationView[],
  limits: AgentCostLimit,
): EvaluationMetricResult | null {
  if (metricRule(metric) === null) return null;
  if (metric === "cost") return measureCost(observations, limits);
  if (metric === "latency") return measureLatency(observations);
  return measureRate(metric, observations);
}

/**
 * The whole report for one agent version, derived on read.
 *
 * `metrics` is exactly the declaration's `evaluationMetrics`, in declaration
 * order — a literal constant in `@dealora/agent`, so the list and its order are
 * as deterministic as the arithmetic. Every declared metric appears even when
 * nothing has been measured, because a metric that is silently missing and a
 * metric that is honestly unmeasured are different claims.
 */
export function deriveEvaluationReport(input: {
  readonly agentId: AgentId;
  readonly declaration: AgentDeclaration;
  readonly run: EvaluationRunView | null;
  readonly observations: readonly EvaluationObservationView[];
}): EvaluationReport {
  const results: EvaluationMetricResult[] = [];
  // A round is only read when it belongs to **this** declaration version. The
  // service already filters, and this repeats the check so the engine is safe
  // on its own: evidence recorded against 1.0.0 can never be reported as
  // evidence about 1.1.0, and its judgements are discarded with the round rather
  // than measured against a declaration they were never made about.
  const runMatches = input.run !== null && input.run.agentVersion === input.declaration.version;
  const currentRun = runMatches ? input.run : null;
  const observations = currentRun === null ? [] : input.observations;
  for (const metric of input.declaration.evaluationMetrics) {
    const measured = measureMetric(
      metric,
      observations.filter((observation) => observation.metric === metric),
      input.declaration.costLimits,
    );
    if (measured !== null) results.push(measured);
  }
  const gate = deriveGateDecision(results);
  const run: EvaluationRunSummary | null =
    currentRun === null
      ? null
      : {
          id: currentRun.id,
          runNumber: currentRun.runNumber,
          openedBy: currentRun.openedBy,
          openedAt: currentRun.openedAt,
          observationCount: observations.length,
        };
  return {
    ruleVersion: EVALUATION_RULE_VERSION,
    agentId: input.agentId,
    agentVersion: input.declaration.version,
    run,
    metrics: results,
    status: deriveReportStatus(results),
    gate,
  };
}

/**
 * The worst status across every metric.
 *
 * `insufficient_evidence` outranks `unmet`: an agent nobody could measure is
 * in a more dangerous position than one that was measured and failed, because
 * nothing is known about it at all.
 */
export function deriveReportStatus(results: readonly EvaluationMetricResult[]): EvaluationStatus {
  if (results.some((result) => result.status === "insufficient_evidence")) {
    return "insufficient_evidence";
  }
  if (results.some((result) => result.status === "unmet")) return "unmet";
  return "met";
}

/**
 * Whether this evidence permits promotion, and why.
 *
 * Satisfied only when every metric is `met`. The reason enumerates **every**
 * metric that is not, so a refusal names what is missing and what failed rather
 * than just denying — the same standard Phase 18's refusal held itself to when
 * it handed this gate to Phase 19.
 */
export function deriveGateDecision(
  results: readonly EvaluationMetricResult[],
): EvaluationGateDecision {
  const blocking = results.filter((result) => result.status !== "met");
  if (blocking.length === 0) {
    return {
      satisfied: true,
      reason: `every one of the ${results.length} metrics this agent declares is met at rule version ${EVALUATION_RULE_VERSION}.`,
    };
  }
  return {
    satisfied: false,
    reason: `${blocking.length} of ${results.length} declared metrics are not met: ${blocking
      .map((result) => `${result.metric} ${result.status}`)
      .join("; ")}.`,
  };
}

/**
 * The live evaluation round: the highest `runNumber` for this agent version.
 *
 * A total order over stored integers, so no clock decides which evidence is
 * current and the same rows always name the same round. Runs belonging to
 * another agent **version** are excluded by the caller, because evidence
 * recorded against version 1.0.0 is not evidence about version 1.1.0.
 */
export function latestRun(
  runs: readonly EvaluationRunRow[],
  version: string,
): EvaluationRunRow | null {
  const forVersion = runs.filter((run) => run.version === version);
  return forVersion.reduce<EvaluationRunRow | null>(
    (latest, run) => (latest === null || run.runNumber > latest.runNumber ? run : latest),
    null,
  );
}

/**
 * The observation trail, newest-judged-last, as a **total** order.
 *
 * Sorted by `(metric, subjectId)`: the metric's position in the published
 * thirteen-metric table first, then the subject id the evaluator named. Both
 * are meaningful domain fields, and together they are unique within a round —
 * so there is never a tie, and no generated id is ever used as a tiebreak.
 * (Phase 18's trail sorted by timestamp with a stable sort for the opposite
 * reason: its events can share a millisecond, while these cannot tie.)
 */
export function sortObservations(
  observations: readonly EvaluationObservationView[],
): readonly EvaluationObservationView[] {
  return [...observations].sort((a, b) => {
    const byMetric = metricOrder(a.metric) - metricOrder(b.metric);
    if (byMetric !== 0) return byMetric;
    return a.subjectId.localeCompare(b.subjectId);
  });
}

/**
 * Every round for one agent, highest `runNumber` first, so the live round
 * prints first and superseded ones read as history behind it.
 */
export function sortRuns(runs: readonly EvaluationRunView[]): readonly EvaluationRunView[] {
  return [...runs].sort((a, b) => b.runNumber - a.runNumber);
}

/** The published rule set, readable before a workspace has measured anything. */
export function derivePolicyView(): {
  readonly ruleVersion: string;
  readonly metrics: readonly EvaluationMetricRule[];
} {
  return {
    ruleVersion: EVALUATION_RULE_VERSION,
    metrics: EVALUATION_METRICS,
  };
}
