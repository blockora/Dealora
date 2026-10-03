import type {
  AccountClaim,
  EntityId,
  Evidence,
  QualificationCriterionResult,
  QualificationDimensionResult,
  QualificationState,
  ResearchConfidence,
} from "@dealora/db";

import type { CriterionRule } from "./rules.js";
import {
  LIMITS,
  QUALIFICATION_CRITERIA,
  QUALIFICATION_DIMENSIONS,
  bounded,
  icpTerms,
  matchesTerm,
  renderExpectation,
} from "./rules.js";
import type { QualificationGoalSnapshot, QualificationIcpSnapshot } from "./types.js";

/**
 * The evaluator.
 *
 * A pure function of its input. No clock, no randomness, no network, no model,
 * no storage: given the same claims, the same evidence, the same ICP, the same
 * goal window and the same rule version, it returns the same criterion results
 * byte for byte. That is what makes a score reproducible and therefore
 * auditable, and it is why a stored result can be re-derived later to prove it
 * was never quietly changed.
 *
 * Three rules run through every criterion, and they are why this engine cannot
 * flatter an account:
 *
 *  1. **A criterion needs evidence.** An `asserted` claim counts only when at
 *     least one `recorded` evidence record supports it. A claim whose evidence
 *     was rejected or superseded supports nothing, and that absence is not a
 *     contradiction, so it never becomes `fail`.
 *  2. **Silence is not failure, and absence is not fit.** A criterion with
 *     nothing to read is `unknown`: no score, no verdict, no drift toward
 *     either direction.
 *  3. **Disagreement is not resolution.** A `contested` claim, or one with
 *     `contradicted` evidence on record, leaves every criterion that reads it
 *     `unknown` with a reason naming the conflict. The newest source does not
 *     win. The most confident source does not win. Nothing picks a winner.
 */

/** What a criterion found when it looked at one claim. */
type Observation =
  | { kind: "supported"; claim: AccountClaim; evidence: Evidence[] }
  | { kind: "contested"; claim: AccountClaim; evidence: Evidence[] }
  | { kind: "absent" };

/** One eligible claim plus the evidence that speaks for it. */
interface ClaimReading {
  claim: AccountClaim;
  support: Evidence[];
  conflict: Evidence[];
}

/** Everything the evaluator reads, already resolved and authorized. */
export interface QualificationEvaluationInput {
  accountId: EntityId;
  icp: QualificationIcpSnapshot;
  goal: QualificationGoalSnapshot | null;
  claims: AccountClaim[];
  evidence: Evidence[];
}

export interface QualificationEvaluation {
  dimensions: QualificationDimensionResult[];
  /** The Dealora Score, or `null` when any dimension is unresolved. */
  score: number | null;
  confidence: ResearchConfidence | null;
  reason: string;
  claimIds: EntityId[];
  evidenceIds: EntityId[];
  conflictedClaimIds: EntityId[];
  state: QualificationState;
}

const CONFIDENCE_ORDER: Record<ResearchConfidence, number> = { low: 1, medium: 2, high: 3 };

/**
 * The weakest supporting band, because a chain is only as strong as its weakest
 * link.
 *
 * Not a new scale and not a weighted average: it is the minimum of the
 * confidence bands already stored on the evidence, chosen so that adding a weak
 * source beside a strong one can never make a criterion look better supported
 * than its worst citation.
 */
function weakestConfidence(evidence: readonly Evidence[]): ResearchConfidence | null {
  return weakestBand(evidence.map((record) => record.confidence));
}

/** The minimum of a set of bands, or `null` when the set is empty. */
function weakestBand(bands: readonly (ResearchConfidence | null)[]): ResearchConfidence | null {
  let weakest: ResearchConfidence | null = null;
  for (const band of bands) {
    if (band === null) continue;
    if (weakest === null || CONFIDENCE_ORDER[band] < CONFIDENCE_ORDER[weakest]) weakest = band;
  }
  return weakest;
}

/** A stable order for reference lists, so two runs serialize identically. */
function sortedIds(ids: Iterable<EntityId>): EntityId[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Claim identity for matching a rule's declared field against stored claims. */
function fieldKey(category: string, field: string): string {
  return `${category}.${field}`;
}

/** The evidence attached to one claim, split into support and contradiction. */
function readingFor(claim: AccountClaim, evidence: readonly Evidence[]): ClaimReading {
  const support: Evidence[] = [];
  const conflict: Evidence[] = [];
  for (const record of evidence) {
    if (record.accountClaimId !== claim.id) continue;
    if (record.status === "recorded") support.push(record);
    else if (record.status === "contradicted") conflict.push(record);
  }
  return { claim, support, conflict };
}

/** A claim that is still eligible to be read at all. */
function isReadable(reading: ClaimReading): boolean {
  return reading.claim.status !== "retracted";
}

/**
 * What is known about one claim, without judging it.
 *
 * `retracted` is treated as absent: the workspace withdrew the assertion, so it
 * is not read as evidence of anything, in either direction.
 */
function observe(reading: ClaimReading | null): Observation {
  if (!reading || !isReadable(reading)) return { kind: "absent" };
  if (reading.claim.status === "contested" || reading.conflict.length > 0) {
    return {
      kind: "contested",
      claim: reading.claim,
      evidence: [...reading.support, ...reading.conflict],
    };
  }
  if (reading.support.length === 0) return { kind: "absent" };
  return { kind: "supported", claim: reading.claim, evidence: reading.support };
}

/**
 * A reason for an unresolved criterion that always names what is missing or
 * what disagrees.
 *
 * Written once so an `unknown` can never be a bare shrug: a user reading an
 * unresolved criterion must be able to see which research would settle it, which
 * is the difference between "we do not know" and "we did not look".
 */
function unknownReason(
  expectation: string,
  subject: string,
  conflicted: readonly EntityId[],
): string {
  if (conflicted.length > 0) {
    return bounded(
      `${expectation}. The sources disagree about ${subject}, and this evaluation does not choose between them. Resolve the claim in the evidence system first.`,
      LIMITS.reason,
    );
  }
  return bounded(
    `${expectation}. No eligible source-backed evidence states ${subject} for this account yet, so the criterion is unresolved rather than failed.`,
    LIMITS.reason,
  );
}

/** The subject a criterion is about, as it appears in a reason. */
function subjectOf(rule: CriterionRule): string {
  switch (rule.kind) {
    case "observed_in_window":
      return "an observation inside the revenue goal window";
    case "category_present":
      return `an observation in ${rule.categories.join(" or ")}`;
    default:
      return rule.criterion.replace(/_/g, " ");
  }
}

/** The pieces every criterion result is assembled from. */
interface CriterionDraft {
  result: QualificationCriterionResult;
  /** The records behind the result, for the dimension's confidence roll-up. */
  evidence: Evidence[];
  contested: EntityId[];
}

function draft(
  rule: CriterionRule,
  expectation: string,
  outcome: QualificationCriterionResult["result"],
  observed: string | null,
  reason: string,
  confidence: ResearchConfidence | null,
  evidenceIds: EntityId[],
  claimIds: EntityId[],
): CriterionDraft {
  return {
    result: {
      dimension: rule.dimension,
      criterion: rule.criterion,
      expectation: bounded(expectation, LIMITS.expectation),
      observed: observed === null ? null : bounded(observed, LIMITS.observed),
      result: outcome,
      reason: bounded(reason, LIMITS.reason),
      confidence,
      evidenceIds: sortedIds(evidenceIds),
      claimIds: sortedIds(claimIds),
    },
    evidence: [],
    contested: [],
  };
}

/** Does a criterion need the Revenue Goal's window to be answerable at all? */
function requiresGoal(rule: CriterionRule): boolean {
  return rule.kind === "observed_in_window";
}

/**
 * The two term criteria, which read named claim fields against the ICP.
 *
 * `term_match` passes when the account's evidence states one of the ICP's
 * terms and fails when it states none. `term_absent` is its mirror: it passes
 * when the account has readable claims and none of them states an exclusion —
 * and stays `unknown` when there is nothing to compare, because absence of
 * evidence is never evidence of absence and DEALORA does not certify an account
 * as unqualified merely for not having been researched.
 */
function evaluateTerms(
  rule: CriterionRule,
  expectation: string,
  icp: QualificationIcpSnapshot,
  readings: readonly ClaimReading[],
): CriterionDraft {
  const terms = icpTerms(icp, rule.icpList ?? "industries");

  if (rule.kind === "term_absent") {
    const readable = readings.filter(
      (reading) =>
        isReadable(reading) && (reading.support.length > 0 || reading.conflict.length > 0),
    );
    if (readable.length === 0) {
      return draft(
        rule,
        expectation,
        "unknown",
        null,
        unknownReason(expectation, subjectOf(rule), []),
        null,
        [],
        [],
      );
    }
    if (terms.length === 0) {
      // The workspace stated no exclusions, so there is nothing to violate.
      // Reporting that is an inspection of a rule that exists, not a guess
      // about the account.
      return draft(
        rule,
        expectation,
        "pass",
        null,
        "the workspace ICP states no disqualifiers, so none applies.",
        null,
        [],
        [],
      );
    }
    const allEvidence = readable.flatMap((reading) => [...reading.support, ...reading.conflict]);
    const allClaims = readable.map((reading) => reading.claim.id);
    const contested = readable
      .filter((reading) => reading.claim.status === "contested" || reading.conflict.length > 0)
      .map((reading) => reading.claim.id);
    if (contested.length > 0) {
      return {
        ...draft(
          rule,
          expectation,
          "unknown",
          null,
          unknownReason(expectation, subjectOf(rule), contested),
          null,
          allEvidence.map((record) => record.id),
          allClaims,
        ),
        evidence: allEvidence,
        contested,
      };
    }
    const matched = readable.filter((reading) =>
      terms.some((term) => matchesTerm(term, reading.claim.value)),
    );
    if (matched.length > 0) {
      return {
        ...draft(
          rule,
          expectation,
          "fail",
          matched[0]?.claim.value ?? null,
          `the ICP excludes ${matched
            .map((reading) => `"${reading.claim.value}"`)
            .join(", ")}, which the account's own evidence states.`,
          weakestConfidence(matched.flatMap((reading) => reading.support)),
          allEvidence.map((record) => record.id),
          allClaims,
        ),
        evidence: matched.flatMap((reading) => reading.support),
        contested: [],
      };
    }
    return {
      ...draft(
        rule,
        expectation,
        "pass",
        null,
        `none of the account's ${readable.length} readable claims states an ICP disqualifier (${terms.join(
          ", ",
        )}).`,
        weakestConfidence(allEvidence),
        allEvidence.map((record) => record.id),
        allClaims,
      ),
      evidence: allEvidence,
      contested: [],
    };
  }

  // `term_match`: the first declared field that carries something readable wins.
  // A *contested* field stops the search rather than falling through to the next
  // one, because switching fields to escape a disagreement would resolve it by
  // fiat.
  let found: Observation = { kind: "absent" };
  for (const key of rule.claimFields) {
    for (const candidate of readings) {
      if (fieldKey(candidate.claim.category, candidate.claim.field) !== key) continue;
      const observation = observe(candidate);
      if (observation.kind === "absent") continue;
      found = observation;
      break;
    }
    if (found.kind !== "absent") break;
  }

  if (found.kind === "absent") {
    return draft(
      rule,
      expectation,
      "unknown",
      null,
      unknownReason(expectation, subjectOf(rule), []),
      null,
      [],
      [],
    );
  }
  const evidenceIds = found.evidence.map((record) => record.id);
  const claimIds = [found.claim.id];
  if (found.kind === "contested") {
    return {
      ...draft(
        rule,
        expectation,
        "unknown",
        // No agreed value: reporting the claim's stored side as "observed"
        // would read as if DEALORA had picked a winner.
        null,
        unknownReason(expectation, subjectOf(rule), claimIds),
        null,
        evidenceIds,
        claimIds,
      ),
      evidence: found.evidence,
      contested: claimIds,
    };
  }
  if (terms.length === 0) {
    // An incomplete ICP cannot match anything, so it cannot pass either.
    return {
      ...draft(
        rule,
        expectation,
        "unknown",
        found.claim.value,
        `${expectation}, but the workspace ICP states none of them, so nothing can be matched.`,
        null,
        evidenceIds,
        claimIds,
      ),
      evidence: found.evidence,
      contested: [],
    };
  }
  const value = found.claim.value;
  const matched = terms.filter((term) => matchesTerm(term, value));
  return {
    ...draft(
      rule,
      expectation,
      matched.length > 0 ? "pass" : "fail",
      value,
      matched.length > 0
        ? `"${value}" matches the ICP term ${matched.map((term) => `"${term}"`).join(", ")}.`
        : `"${value}" matches none of the ICP terms: ${terms.join(", ")}.`,
      weakestConfidence(found.evidence),
      evidenceIds,
      claimIds,
    ),
    evidence: found.evidence,
    contested: [],
  };
}

/**
 * The category criteria, which ask whether any evidence-backed observation
 * exists — and, for timing, whether it landed inside the Revenue Goal's window.
 */
function evaluateCategories(
  rule: CriterionRule,
  expectation: string,
  goal: QualificationGoalSnapshot | null,
  readings: readonly ClaimReading[],
): CriterionDraft {
  const relevant = readings.filter(
    (reading) =>
      isReadable(reading) &&
      rule.categories.includes(reading.claim.category) &&
      (reading.support.length > 0 || reading.conflict.length > 0),
  );
  const allEvidence = relevant.flatMap((reading) => [...reading.support, ...reading.conflict]);
  const allIds = allEvidence.map((record) => record.id);
  const allClaims = relevant.map((reading) => reading.claim.id);
  const supported = relevant.filter((reading) => reading.support.length > 0);
  const contested = relevant
    .filter((reading) => reading.claim.status === "contested" || reading.conflict.length > 0)
    .map((reading) => reading.claim.id);

  if (supported.length === 0) {
    return {
      ...draft(
        rule,
        expectation,
        "unknown",
        null,
        unknownReason(expectation, subjectOf(rule), contested),
        null,
        allIds,
        allClaims,
      ),
      evidence: allEvidence,
      contested,
    };
  }

  if (rule.kind === "category_present") {
    const observed = supported[0];
    return {
      ...draft(
        rule,
        expectation,
        "pass",
        observed?.claim.value ?? null,
        `${supported.length} source-backed ${rule.categories.join("/")} observation${
          supported.length === 1 ? "" : "s"
        } exist, the first stating "${observed?.claim.value ?? ""}".`,
        weakestConfidence(supported.flatMap((reading) => reading.support)),
        allIds,
        allClaims,
      ),
      evidence: supported.flatMap((reading) => reading.support),
      contested,
    };
  }

  // `observed_in_window`: the observation must land inside the window the
  // business committed to. Both dates come from stored records, so no clock is
  // consulted and the comparison is reproducible.
  const start = Date.parse(`${goal?.timeWindow.start ?? ""}T00:00:00.000Z`);
  const end = Date.parse(`${goal?.timeWindow.end ?? ""}T23:59:59.999Z`);
  const inWindow = supported.filter((reading) =>
    reading.support.some((record) => {
      if (record.observedAt === null) return false;
      const observedAt = Date.parse(record.observedAt);
      return !Number.isNaN(observedAt) && observedAt >= start && observedAt <= end;
    }),
  );
  if (inWindow.length > 0) {
    return {
      ...draft(
        rule,
        expectation,
        "pass",
        inWindow[0]?.claim.value ?? null,
        `${inWindow.length} source-backed observation${
          inWindow.length === 1 ? "" : "s"
        } in ${rule.categories.join("/")} fell inside the revenue goal window.`,
        weakestConfidence(inWindow.flatMap((reading) => reading.support)),
        allIds,
        allClaims,
      ),
      evidence: inWindow.flatMap((reading) => reading.support),
      contested,
    };
  }

  const dated = supported.filter((reading) =>
    reading.support.some((record) => record.observedAt !== null),
  );
  return {
    ...draft(
      rule,
      expectation,
      // Observations exist but sit outside the window: a real answer, so a fail.
      // No observation date at all is not an answer, so it stays unknown.
      dated.length > 0 ? "fail" : "unknown",
      dated[0]?.claim.value ?? null,
      dated.length > 0
        ? `${dated.length} source-backed observation${
            dated.length === 1 ? "" : "s"
          } exist, but none was observed inside the revenue goal window.`
        : `${expectation}. The account's observations carry no observation date, so none can be placed in the window.`,
      dated.length > 0 ? weakestConfidence(dated.flatMap((reading) => reading.support)) : null,
      allIds,
      allClaims,
    ),
    evidence: dated.length > 0 ? dated.flatMap((reading) => reading.support) : allEvidence,
    contested,
  };
}

/**
 * Run every criterion, roll them up, and decide the score.
 *
 * The aggregation order is fixed, and each step is stated in the reason the
 * record stores, because an aggregation nobody can restate is an aggregation
 * nobody can audit:
 *
 * - **criterion** — `pass`/`fail` when evidence answers the question,
 *   `unknown` when nothing does.
 * - **dimension** — `fail` if any criterion failed, because a proven mismatch
 *   is a proven mismatch even beside an unresolved sibling; `pass` only if every
 *   criterion passed; `unknown` otherwise. A dimension score is `null` unless
 *   the dimension resolved, and a `null` score is not a zero.
 * - **score** — the arithmetic mean of the five dimension scores, and `null`
 *   unless all five resolved. Deliberately all-or-nothing: an average over a
 *   partly-researched account is exactly how a missing fact reads as a fit.
 * - **state** — `contested` if anything was blocked by a disagreement, otherwise
 *   `insufficient_data` if anything is unresolved, otherwise `unqualified` if
 *   anything failed, otherwise `qualified`.
 */
export function evaluateQualification(
  input: QualificationEvaluationInput,
): QualificationEvaluation {
  const dimensions: QualificationDimensionResult[] = [];
  const claimIds: EntityId[] = [];
  const evidenceIds: EntityId[] = [];
  const conflictedClaimIds: EntityId[] = [];

  for (const dimension of QUALIFICATION_DIMENSIONS) {
    const rules = QUALIFICATION_CRITERIA.filter((rule) => rule.dimension === dimension);
    const criteria: QualificationCriterionResult[] = [];
    const dimensionEvidence: Evidence[] = [];

    for (const rule of rules) {
      const expectation = renderExpectation(rule, input.icp, input.goal);
      let built: CriterionDraft;

      if (requiresGoal(rule) && input.goal === null) {
        // The window is required context and is never inferred: the criterion
        // stays unresolved rather than being scored against a guessed period.
        built = {
          result: {
            dimension: rule.dimension,
            criterion: rule.criterion,
            expectation: bounded(expectation, LIMITS.expectation),
            observed: null,
            result: "unknown",
            reason: bounded(
              `${expectation}. No revenue goal is linked to this account, so the window is unknown and none is inferred.`,
              LIMITS.reason,
            ),
            confidence: null,
            evidenceIds: [],
            claimIds: [],
          },
          evidence: [],
          contested: [],
        };
      } else {
        const readings = input.claims.map((claim) => readingFor(claim, input.evidence));
        built =
          rule.kind === "category_present" || rule.kind === "observed_in_window"
            ? evaluateCategories(rule, expectation, input.goal, readings)
            : evaluateTerms(rule, expectation, input.icp, readings);
      }

      criteria.push(built.result);
      dimensionEvidence.push(...built.evidence);
      claimIds.push(...built.result.claimIds);
      evidenceIds.push(...built.result.evidenceIds);
      for (const id of built.contested) {
        if (!conflictedClaimIds.includes(id)) conflictedClaimIds.push(id);
      }
    }

    const failed = criteria.filter((criterion) => criterion.result === "fail");
    const passed = criteria.filter((criterion) => criterion.result === "pass");
    const unresolved = criteria.filter((criterion) => criterion.result === "unknown");
    const resolved = passed.length + failed.length;
    const outcome: QualificationDimensionResult["result"] =
      failed.length > 0 ? "fail" : unresolved.length > 0 ? "unknown" : "pass";

    dimensions.push({
      dimension,
      // A null score is not a zero: an unresolved dimension has no honest number.
      score:
        outcome === "unknown" || resolved === 0
          ? null
          : Math.round((100 * passed.length) / resolved),
      result: outcome,
      reason: bounded(
        outcome === "pass"
          ? `all ${criteria.length} ${dimension} criteria resolved and passed against the workspace criteria.`
          : outcome === "fail"
            ? `${failed.map((criterion) => criterion.criterion).join(", ")} failed against the workspace criteria.`
            : `unresolved: ${unresolved
                .map((criterion) => criterion.criterion)
                .join(", ")}. No score is issued for this dimension until each is evidenced.`,
        LIMITS.reason,
      ),
      // An unresolved dimension has no agreed value to be confident about.
      confidence: outcome === "unknown" ? null : weakestConfidence(dimensionEvidence),
      resolvedCriteria: resolved,
      criteria,
    });
  }

  const scores = dimensions.map((dimension) => dimension.score);
  const complete = scores.every((value): value is number => value !== null);
  const score = complete
    ? Math.round(scores.reduce((total, value) => total + value, 0) / scores.length)
    : null;

  const unresolvedDimensions = dimensions.filter((dimension) => dimension.result === "unknown");
  const failedDimensions = dimensions.filter((dimension) => dimension.result === "fail");
  const conflicted = sortedIds(conflictedClaimIds);
  const state: QualificationState =
    conflicted.length > 0
      ? "contested"
      : unresolvedDimensions.length > 0
        ? "insufficient_data"
        : failedDimensions.length > 0
          ? "unqualified"
          : "qualified";

  return {
    dimensions,
    score,
    // All-or-nothing: a partial average would read as a verdict the evidence
    // does not support.
    confidence:
      score === null ? null : weakestBand(dimensions.map((dimension) => dimension.confidence)),
    reason: buildReason({ state, unresolvedDimensions, failedDimensions, conflicted }),
    claimIds: sortedIds(claimIds),
    evidenceIds: sortedIds(evidenceIds),
    conflictedClaimIds: conflicted,
    state,
  };
}

/**
 * Why the score is what it is, in one sentence a user can act on.
 *
 * Composed rather than accepted from the caller, so the same inputs always
 * produce the same explanation: an audit trail that can disagree with itself is
 * not one.
 */
function buildReason(input: {
  state: QualificationState;
  unresolvedDimensions: QualificationDimensionResult[];
  failedDimensions: QualificationDimensionResult[];
  conflicted: EntityId[];
}): string {
  const names = (list: QualificationDimensionResult[]): string =>
    list.map((dimension) => dimension.dimension).join(", ");
  switch (input.state) {
    case "qualified":
      return `All ${QUALIFICATION_DIMENSIONS.length} dimensions resolved and passed; the score is the mean of the dimension scores.`;
    case "unqualified":
      return `${input.failedDimensions.length} of ${QUALIFICATION_DIMENSIONS.length} dimensions failed against the criteria the workspace defined (${names(
        input.failedDimensions,
      )}); the score is the mean of the dimension scores.`;
    case "insufficient_data":
      return `The account cannot be judged yet: ${names(input.unresolvedDimensions)} ${
        input.unresolvedDimensions.length === 1 ? "is" : "are"
      } unresolved. No score is issued, and an unresolved dimension is never counted as a pass or a failure.`;
    default:
      return `The sources disagree on ${input.conflicted.length} claim${
        input.conflicted.length === 1 ? "" : "s"
      } (${input.conflicted.join(", ")}), so no score is issued and the conflict is left for the workspace to resolve.`;
  }
}
