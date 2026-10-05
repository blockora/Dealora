/**
 * @dealora/trace — pure derivations for Phase 20.
 *
 * Every function here is a function of its arguments and the constant tables in
 * `rules.ts`. There is no clock, no randomness, no store, no network and no
 * model: the same recorded steps always produce the same status, the same
 * counts, the same totals and the same JSON, on any machine, at any time.
 *
 * ## The derivation that carries the phase
 *
 * `deriveTraceStatus` is `ROADMAP.md` §27's critical rule as code. Storage
 * applies the identical rule when it closes a run — it has to, because storage
 * is what writes the row — and this copy is the readable specification of it,
 * independently tested, and the cross-check every read performs. The two are
 * stated twice **on purpose**: a reader can hold the rule in one place and the
 * storage that must not be lied to in the other, and if they ever disagree the
 * read refuses rather than silently preferring whichever ran last.
 *
 * ## What is deliberately absent
 *
 * - **No clock.** `slowestStepMs` is a maximum over reported durations, not a
 *   measured wall-clock span, because the trace has no start and stop it can
 *   trust — those are the recorder's facts, and a gap between two of them
 *   includes whatever else the process was doing.
 * - **No sums across overlapping steps.** Steps in one run may overlap, so
 *   adding their durations would report a time the run never took.
 * - **No money arithmetic.** The cost total is Phase 16's `deriveBreakdown`,
 *   called, not reimplemented.
 */

import { deriveBreakdown } from "@dealora/cost";
import type { CostEventRow } from "@dealora/cost";

import {
  TRACE_OUTCOMES,
  TRACE_RUN_STATUSES,
  TRACE_STAGES,
  TRACE_TOOLS,
  stageOrder,
} from "./rules.js";
import type {
  TraceCostSummary,
  TraceEventView,
  TraceOutcome,
  TraceRunRow,
  TraceRunStatus,
  TraceRunStatusDefinition,
  TraceStageCounts,
  TraceUsageSummary,
} from "./types.js";

/**
 * Add without ever leaving the exact integer range.
 *
 * Token counts are whole numbers validated on the way in, so a sum can only
 * overflow with an absurd number of recorded steps. It saturates rather than
 * wraps, so an overflowing total reads as unimaginably large — which it is —
 * instead of turning into a small number that looks like a cheap run.
 */
function addExact(total: number, next: number): number {
  const sum = total + next;
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

/**
 * What a run's recorded outcomes actually prove.
 *
 * The whole rule, in order, and every branch is a refusal to overstate:
 *
 * 1. **any `failed` → `failed`.** One failure is enough, and it outranks every
 *    success, so a run that mostly worked and then broke never reads as
 *    succeeded.
 * 2. **any `unknown` → `unknown`.** Something was left open. Reporting a run as
 *    succeeded here is the exact dishonesty §27 forbids.
 * 3. **any `succeeded` → `succeeded`.** Only now is success a supported claim,
 *    and only because nothing contradicted it.
 * 4. **otherwise → `unverified`.** A closed run with no outcome at all claims
 *    nothing. This is the branch that makes "close it and call it done" unable
 *    to produce a success.
 */
export function deriveTraceStatus(outcomes: readonly TraceOutcome[]): TraceRunStatus {
  if (outcomes.length === 0) return "unverified";
  let hasUnknown = false;
  let hasSucceeded = false;
  for (const outcome of outcomes) {
    if (outcome === "failed") return "failed";
    if (outcome === "unknown") hasUnknown = true;
    else if (outcome === "succeeded") hasSucceeded = true;
  }
  if (hasUnknown) return "unknown";
  if (hasSucceeded) return "succeeded";
  return "unverified";
}

/** Whether two statuses may be compared without ambiguity, for the cross-check. */
export function statusDerivationRule(): string {
  const failed = TRACE_RUN_STATUSES.find((entry) => entry.status === "failed");
  const unknown = TRACE_RUN_STATUSES.find((entry) => entry.status === "unknown");
  const succeeded = TRACE_RUN_STATUSES.find((entry) => entry.status === "succeeded");
  const unverified = TRACE_RUN_STATUSES.find((entry) => entry.status === "unverified");
  const clause = (entry: TraceRunStatusDefinition | undefined): string =>
    entry === undefined ? "unreachable" : `\`${entry.status}\` — ${entry.meaning}`;
  return [
    `any failed step makes the run ${clause(failed)}`,
    `otherwise any unknown step makes it ${clause(unknown)}`,
    `otherwise any succeeded step makes it ${clause(succeeded)}`,
    `otherwise ${clause(unverified)}`,
  ].join("; ");
}

/**
 * One stage's tally across a run.
 *
 * Every one of the seven stages appears, including the ones with no steps:
 * a reader must be able to tell "no approval was ever requested" from "this
 * trace cannot say", and an absent stage would collapse the two.
 */
export function deriveStageCounts(events: readonly TraceEventView[]): readonly TraceStageCounts[] {
  return TRACE_STAGES.map((definition) => {
    let count = 0;
    let succeeded = 0;
    let failed = 0;
    let unknown = 0;
    let retried = 0;
    for (const event of events) {
      if (event.stage !== definition.stage) continue;
      count += 1;
      if (event.outcome === "succeeded") succeeded += 1;
      else if (event.outcome === "failed") failed += 1;
      else unknown += 1;
      if (event.attempt > 1) retried += 1;
    }
    return { stage: definition.stage, count, succeeded, failed, unknown, retried };
  });
}

/**
 * Everything `ROADMAP.md` §27 asks a trace to track, as one derived summary.
 *
 * Three choices are worth reading twice:
 *
 * - **`slowestStepMs` is a maximum, never a sum or an average.** Steps in one
 *   run may overlap, so a sum would report a span the run never took, and an
 *   average would let one slow step hide inside fast ones. A maximum is correct
 *   under overlap, and it is the same shape Phase 19's `latency` metric uses.
 * - **Tokens are summed, never estimated.** A step that reported no token count
 *   contributes nothing, and the total is not inflated by treating "not
 *   reported" as zero tokens consumed — the count is a floor, stated as one.
 * - **External actions are counted separately from successes.** An action the
 *   recorder could not confirm appears in `externalActions` and not in
 *   `externalActionsSucceeded`, which is what makes the gap between those two
 *   numbers the size of the unverified part of the run.
 */
export function deriveUsageSummary(events: readonly TraceEventView[]): TraceUsageSummary {
  let slowestStepMs: number | null = null;
  let slowestStepId: string | null = null;
  let slowestSequence = Number.MAX_SAFE_INTEGER;
  let modelInvocations = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let retryCount = 0;
  let errorCount = 0;
  let approvalsRequested = 0;
  let approvalsGranted = 0;
  let externalActions = 0;
  let externalActionsSucceeded = 0;

  const modelKeys = new Set<string>();
  const models = new Map<string, { provider: string | null; model: string }>();
  const tools = new Set<string>();

  for (const event of events) {
    if (event.durationMs !== null) {
      // A tie is broken on `sequence`, the server-derived key, and **not** on
      // input order: two steps can legitimately report the same duration, and
      // picking whichever happened to be passed first would make the summary
      // depend on the order the store happened to return.
      if (
        slowestStepMs === null ||
        event.durationMs > slowestStepMs ||
        (event.durationMs === slowestStepMs && event.sequence < slowestSequence)
      ) {
        slowestStepMs = event.durationMs;
        slowestStepId = event.stepId;
        slowestSequence = event.sequence;
      }
    }
    if (event.attempt > 1) retryCount += 1;
    if (event.outcome === "failed") errorCount += 1;
    if (event.modelName !== null) {
      modelInvocations += 1;
      inputTokens = addExact(inputTokens, event.inputTokens ?? 0);
      outputTokens = addExact(outputTokens, event.outputTokens ?? 0);
      // Keyed on provider and model together so two providers offering a model
      // of the same name stay two entries rather than merging into one. The key
      // is JSON-encoded rather than concatenated, so it cannot collide at all
      // and the source holds no invisible separator byte.
      const key = JSON.stringify([event.modelProvider, event.modelName]);
      if (!modelKeys.has(key)) {
        modelKeys.add(key);
        models.set(key, { provider: event.modelProvider, model: event.modelName });
      }
    }
    if (event.tool !== null) tools.add(event.tool);
    if (event.stage === "approval") {
      approvalsRequested += 1;
      if (event.outcome === "succeeded") approvalsGranted += 1;
    }
    if (event.stage === "external_action") {
      externalActions += 1;
      if (event.outcome === "succeeded") externalActionsSucceeded += 1;
    }
  }

  return {
    slowestStepMs,
    slowestStepId,
    modelInvocations,
    inputTokens,
    outputTokens,
    // Sorted by name so the same recorded steps print the same list, whatever
    // order the steps were stored in.
    models: [...models.values()].sort((a, b) =>
      `${a.provider ?? ""}/${a.model}`.localeCompare(`${b.provider ?? ""}/${b.model}`),
    ),
    // Printed in the published tool order, so the list is a subsequence of a
    // constant table rather than an alphabetical accident.
    toolsInvoked: TRACE_TOOLS.filter((tool) => tools.has(tool)),
    retryCount,
    errorCount,
    approvalsRequested,
    approvalsGranted,
    externalActions,
    externalActionsSucceeded,
  };
}

/**
 * What a traced run cost, using Phase 16's own facts and derivation.
 *
 * `null` when no cost fact has been recorded for this run, never a zero: "we
 * have not measured what this cost" and "this cost nothing" are different
 * claims, and Phase 16's `CostBreakdown` already distinguishes them by
 * `currency: null`. The arithmetic is `deriveBreakdown`'s, called — this package
 * adds nothing that touches a monetary value.
 */
export function deriveTraceCost(facts: readonly CostEventRow[]): TraceCostSummary | null {
  if (facts.length === 0) return null;
  return deriveBreakdown(facts);
}

/**
 * The step trail, in the one order a trace may be read in.
 *
 * Sorted by `sequence` alone. `sequence` is allocated in storage as a strictly
 * increasing counter inside the run and is UNIQUE there, so this is a **total**
 * order with no tie — and it does not use `recordedAt`, which is why two steps
 * recorded inside the same millisecond still have one defined order.
 *
 * There is deliberately no id tiebreak. A random id would make the order of two
 * equal-keyed rows depend on randomness, which is the defect Phase 18 had to
 * remove from its governance trail; here the key cannot tie at all, so the
 * question never arises.
 */
export function sortTraceEvents(events: readonly TraceEventView[]): readonly TraceEventView[] {
  return [...events].sort((a, b) => a.sequence - b.sequence);
}

/**
 * The run listing, in one order.
 *
 * Sorted by `(agentId, id)`. A run has no run number — two runs for the same
 * agent are two invocations, not a sequence — so the only stable keys are the
 * agent it belongs to and its own id. Both are stable fields, and the sort is
 * therefore deterministic; the listing is not chronological, which is stated
 * here rather than left to be discovered, and `TraceRunView` carries the
 * timestamps a reader actually orders by.
 */
export function sortTraceRuns(runs: readonly TraceRunRow[]): readonly TraceRunRow[] {
  return [...runs].sort((a, b) => {
    const byAgent = a.agentId.localeCompare(b.agentId);
    if (byAgent !== 0) return byAgent;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Does a stored status agree with what its own recorded outcomes prove?
 *
 * The cross-check every read performs. A disagreement is not resolved by
 * preferring either value: storage owns the stored row and the engine owns the
 * derivation, so a mismatch means something wrote outside both of them, and the
 * honest answer to that is to refuse the read rather than print a verdict
 * neither source stands behind.
 */
export function statusesAgree(stored: string, derived: TraceRunStatus): boolean {
  return stored === derived;
}

/** The recorded outcomes a run's steps carry, in step order. */
export function outcomesOf(events: readonly TraceEventView[]): readonly TraceOutcome[] {
  return sortTraceEvents(events).map((event) => event.outcome);
}

/** The published outcome vocabulary, re-exported so a caller need not import twice. */
export function publishedOutcomes(): readonly TraceOutcome[] {
  return TRACE_OUTCOMES;
}

/** A stage's position in the published chain, exposed for the trail's ordering. */
export function publishedStageOrder(stage: string): number {
  return stageOrder(stage);
}
