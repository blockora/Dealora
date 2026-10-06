/**
 * The Phase 22 experiment rule set, declared once as data.
 *
 * Everything the engine publishes — the metric, the decision rule, the
 * thresholds, the population and conversion definitions — is defined here and
 * nowhere else, so the policy route, the derivation and the tests all read the
 * same tables and a threshold cannot be advertised without being enforced.
 *
 * The two thresholds are **product judgements**, said plainly rather than
 * presented as roadmap constants (the same way Phase 19 published its latency
 * ceiling): §29 gives no numbers, and pretending it did would be worse than
 * choosing them openly. They exist to make §29's critical rule — *do not
 * claim a winning experiment when evidence is insufficient* — decidable
 * rather than a mood.
 */

import type { ExperimentError, ExperimentErrorCode, ExperimentPolicyView } from "./types.js";

/** The rule set version. Bumped whenever a rule's semantics change. */
export const EXPERIMENT_RULE_VERSION = "experiment-1.0.0";

/**
 * §29's metric, and the one thing this phase derives. The positive reply rate
 * reads conversions from Phase 12's own classifications — a contact counts as
 * converted when any in-window reply of theirs classified as `positive_intent`
 * or `interested`, which is **Phase 13's** meetable-intent set read, not
 * re-declared, so "positive" means the same thing in an experiment as it does
 * in a meeting recommendation.
 */
export const EXPERIMENT_METRIC = {
  name: "positive_reply_rate",
  status: "derived" as const,
  definition:
    "positive replies divided by exposed contacts per arm: a contact is exposed by an in-window sent message of the arm, and converted when any in-window reply of theirs was classified by Phase 12 as positive_intent or interested — the meeting engine's own MEETABLE_INTENTS.",
};

/**
 * The metrics §29 does not name that a caller might ask for, refused with the
 * phase that owns the rows they would need. Refusing is the honest form of
 * "not yet": a fabricated revenue number would be a financial claim nobody
 * recorded, exactly as the cost engine argued for its refused metrics.
 */
export const EXPERIMENT_REFUSED_METRICS: readonly {
  readonly name: string;
  readonly reason: string;
  readonly owningPhase: string | null;
}[] = [
  {
    name: "revenue_per_arm",
    reason:
      "no phase through 22 records realized revenue: Phase 16 refused revenue metrics for the same reason, and ROADMAP.md §30 puts CRM and revenue sync in Phase 23. Revenue impact is reported as meetings on a calendar instead.",
    owningPhase: "Phase 23",
  },
  {
    name: "meeting_hold_rate",
    reason:
      "derivable in principle from Phase 13's rows, but the roadmap names exactly one experiment metric, and publishing a second without deciding its rules would be a product change this phase was not asked to make. The comparison stays positive_reply_rate.",
    owningPhase: null,
  },
];

/**
 * The minimum evidence before any comparison is read at all: each compared
 * arm needs this many distinct exposed contacts. Below it the decision is
 * `insufficient_evidence` — never a winner, never a loser, because a rate
 * over a handful of people is noise wearing a number.
 */
export const EXPERIMENT_MIN_SAMPLE_PER_ARM = 30;

/**
 * The minimum absolute lift between the two arms' conversion rates, in basis
 * points, before the leader is called a winner: 200 bp = 2 percentage points.
 * A one-reply difference over a thousand sends is real data but not a
 * decision, and §29 forbids claiming one.
 */
export const EXPERIMENT_MIN_LIFT_BASIS_POINTS = 200;

/**
 * Where the confidence band steps up: both arms at the minimum is `low`,
 * at `mediumSampleMultiplier × minimum` is `medium`, and at
 * `highSampleMultiplier × minimum` is `high`. The band describes how much
 * data the comparison rests on — it is not a probability, and no p-value is
 * computed anywhere in this package.
 */
export const EXPERIMENT_MEDIUM_SAMPLE_MULTIPLIER = 3;
export const EXPERIMENT_HIGH_SAMPLE_MULTIPLIER = 10;

/**
 * The population §29's example calls "Qualified SaaS founders": the accounts
 * whose **newest** qualification — highest version, versions never reused —
 * is `qualified`, which is exactly Phase 15's opportunity rule and Phase 16's
 * denominator rule, so "qualified" means one thing across every phase.
 */
export const EXPERIMENT_POPULATION_DEFINITION =
  "accounts whose newest qualification (highest version, versions never reused) is qualified — the same rule Phase 15's opportunity node and Phase 16's qualified-opportunity denominator use, so the population never disagrees with the rest of the loop.";

/**
 * The decision rule, stated as one sentence and enforced line-for-line in the
 * engine: with both arms at or above the minimum sample, compare rates by
 * cross-multiplication in exact integers; a leader ahead by at least the
 * minimum lift wins, a smaller gap is `no_material_difference`, and anything
 * short of the minimum sample is `insufficient_evidence`.
 */
export const EXPERIMENT_DECISION_RULE =
  "a winner requires every arm to hold at least the minimum sample of distinct exposed contacts and the leading arm to lead the runner-up by at least the minimum lift in exact integer basis points; equal rates are no_material_difference and any arm below the minimum sample is insufficient_evidence — a cancelled experiment can never produce a winner at all";

/** The declared limits the store enforces, published so a caller can self-check. */
export const EXPERIMENT_ARM_LIMITS = { min: 2, max: 4 } as const;
export const EXPERIMENT_DURATION_LIMITS = { minDays: 1, maxDays: 90 } as const;
export const EXPERIMENT_LABEL_LIMIT = 80;
export const EXPERIMENT_NAME_LIMIT = 120;

/**
 * What the Experiment Engine never does. The negative space is the design:
 * the items below are refusals, not TODOs.
 */
export const EXPERIMENT_NEVER_DO: readonly string[] = [
  "never sends a message, books a meeting, approves a draft or writes a cost row — the loop runs through Phases 10–16 exactly as before, and the experiment only measures it",
  "never assigns a prospect to an arm automatically — exposure comes from a sent, human-approved message, so every subject chose (or was chosen by) the workspace",
  "never stores a sample size, a rate, a confidence, a total or a winner — every comparison number is derived on read from stored rows, so nothing can go stale",
  "never claims a winner on insufficient evidence — below the minimum sample, inside the minimum lift, or after a cancellation, the answer is no winner, by construction",
  "never derives a monetary revenue figure — no row in the repository records realized revenue, so revenue impact is reported as meetings on a calendar with the refusal named",
  "never consults the current time inside a derivation — the window is the declared start plus the declared duration, capped by a close",
  "never lets a client choose an arm, a status, a timestamp or a metric reading — the declaration is the only thing a caller contributes",
  "never treats an unqualified account's traffic as experiment data — the population is the workspace's own qualified accounts, re-derived on every read",
  "never counts a contact in two arms — cross-arm exposure is excluded and disclosed rather than averaged",
];

/** Build a domain error. */
export function experimentError(
  code: ExperimentErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): ExperimentError {
  if (details === undefined) return { code, message };
  return { code, message, details };
}

/** The full rule set as the policy route publishes it. */
export function describeExperimentPolicy(): ExperimentPolicyView {
  return {
    ruleVersion: EXPERIMENT_RULE_VERSION,
    metric: { ...EXPERIMENT_METRIC },
    refusedMetrics: EXPERIMENT_REFUSED_METRICS.map((entry) => ({ ...entry })),
    decisionRule: EXPERIMENT_DECISION_RULE,
    thresholds: {
      minSamplePerArm: EXPERIMENT_MIN_SAMPLE_PER_ARM,
      minLiftBasisPoints: EXPERIMENT_MIN_LIFT_BASIS_POINTS,
      mediumSampleMultiplier: EXPERIMENT_MEDIUM_SAMPLE_MULTIPLIER,
      highSampleMultiplier: EXPERIMENT_HIGH_SAMPLE_MULTIPLIER,
    },
    populationDefinition: EXPERIMENT_POPULATION_DEFINITION,
    conversionDefinition: EXPERIMENT_METRIC.definition,
    costDefinition:
      "Phase 16's own recorded facts for this arm's sent actions, totaled by the Cost Engine's own derivation — estimated and measured sums reported raw, with the double-count-safe total applied, never a second arithmetic.",
    revenueImpactDefinition:
      "meetings this arm's sends advanced onto a calendar (booked or held) inside the window — the revenue-adjacent outcome this system records; the monetary figure is refused with Phase 23 as its owner because no stored row records realized revenue.",
    armLimits: { ...EXPERIMENT_ARM_LIMITS },
    durationLimits: { ...EXPERIMENT_DURATION_LIMITS },
    labelLimit: EXPERIMENT_LABEL_LIMIT,
    nameLimit: EXPERIMENT_NAME_LIMIT,
    neverDoes: [...EXPERIMENT_NEVER_DO],
  };
}
