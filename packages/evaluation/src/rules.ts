/**
 * @dealora/evaluation — the closed rule table for Phase 19.
 *
 * Every number the gate uses is published here, in one file, so a reader can
 * check the whole bar without reading a derivation. Three properties hold:
 *
 * 1. **Nothing is invented to make an agent pass.** The bar is a constant. No
 *    default can loosen it, no configuration can override it, and no metric
 *    with too little evidence is ever scored rather than refused.
 * 2. **Where the number comes from is stated per metric.** `cost` has no
 *    Phase 19 number at all: its ceiling is the `@dealora/agent` declaration's
 *    own `costLimits`, read from the declaration table, so the bar belongs to
 *    the agent that must live inside it. The eleven rate metrics and `latency`
 *    carry Phase 19's published thresholds, because §26 names the metrics and
 *    sets no numbers — Phase 19 owns them and therefore has to say so.
 * 3. **Exact arithmetic.** Rates are integers in basis points and are compared
 *    by cross-multiplication, so "exactly at the threshold" is a decidable
 *    fact and "just above" is a different fact, on every run.
 */

import type { AgentEvaluationMetric } from "@dealora/agent";

import type {
  EvaluationError,
  EvaluationErrorCode,
  EvaluationMetricRule,
  EvaluationVerdict,
} from "./types.js";

/** Bumped with the thresholds below; every report states the version it used. */
export const EVALUATION_RULE_VERSION = "evaluation-1.0.0";

/** One basis point is one good judgement per ten thousand. */
export const BASIS_POINT_SCALE = 10_000;

/**
 * How many judgements a **rate** metric needs before it is judged at all.
 *
 * A rate is a proportion, and a proportion over one or two observations is not
 * a measurement — it is an anecdote with a decimal point on it. Five is the
 * smallest number that can distinguish "consistently" from "by chance" for the
 * thresholds published below, and it is a floor, never a target: recording more
 * is always allowed.
 */
export const RATE_MINIMUM_SAMPLE = 5;

/**
 * Phase 19's published ceiling for a single recorded run, in milliseconds.
 *
 * `ROADMAP.md` §26 names `latency` as a metric to measure and states no
 * number, so this phase has to publish one — and this is a product judgement,
 * not a roadmap constant, said plainly rather than presented as a requirement.
 * Five seconds is the outer edge of a reply a person is still waiting on, which
 * is the only latency this product makes a promise about. One observation is
 * enough to exceed it, because the metric is the **slowest** run and not an
 * average: an average would let a single bad run hide inside a good one.
 */
export const LATENCY_CEILING_MS = 5_000;

/** The three judgements, in the order every report prints them. */
export const EVALUATION_VERDICTS: readonly EvaluationVerdict[] = ["met", "unmet", "unobserved"];

/** The metrics whose observation carries a measured quantity, not a verdict. */
export const EVALUATION_MEASURED_METRICS: readonly {
  readonly metric: AgentEvaluationMetric;
  readonly unit: "minor_units" | "milliseconds";
}[] = [
  { metric: "cost", unit: "minor_units" },
  { metric: "latency", unit: "milliseconds" },
];

/**
 * The thirteen metrics `ROADMAP.md` §26 names, in roadmap order.
 *
 * This array is the report's **total order**: every listing, the policy route
 * and the gate print in exactly this sequence, so "sorted by metric" never has
 * to mean anything. Each entry is one of the thirteen — no more, no fewer —
 * and the package test checks the membership against `ROADMAP.md` §26 and
 * against `@dealora/agent`'s declared list.
 */
export const EVALUATION_METRICS: readonly EvaluationMetricRule[] = [
  {
    metric: "task_success",
    description: "Did the agent accomplish the task it was given?",
    kind: "rate",
    direction: "at_least",
    threshold: 8_000,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "Four in five attempts is the floor for work somebody has to check by hand; below it the agent is costing more attention than it saves.",
  },
  {
    metric: "accuracy",
    description: "Were the agent's outputs factually correct?",
    kind: "rate",
    direction: "at_least",
    threshold: 9_500,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "An agent that is wrong five times in a hundred is already more reliable than the person checking it, but only just; a wrong output is the failure §84 principle 2 exists to prevent.",
  },
  {
    metric: "relevance",
    description: "Did the output serve the task that was asked?",
    kind: "rate",
    direction: "at_least",
    threshold: 9_000,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "A correct answer to the wrong question still has to be rewritten, so relevance is measured separately from accuracy rather than inferred from it.",
  },
  {
    metric: "hallucination_rate",
    description: "How often did the agent assert something unsupported?",
    kind: "rate",
    direction: "at_most",
    threshold: 500,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "`DEALORA_BLUEPRINT.md` §31: fluent text is not enough. Five unsupported assertions in a hundred is the point at which an operator stops reading the output.",
  },
  {
    metric: "tool_call_correctness",
    description: "Did the agent call the right tool with the right arguments?",
    kind: "rate",
    direction: "at_least",
    threshold: 9_500,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "A wrong tool call is not a wrong sentence, it is a wrong action, so it is held to a higher bar than prose quality.",
  },
  {
    metric: "qualification_accuracy",
    description: "Did qualification agree with the evidence?",
    kind: "rate",
    direction: "at_least",
    threshold: 9_000,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "Phase 8 already refuses to score an account with thin evidence, so an `insufficient_data` judgement is not a miss; what is measured here is the score that was produced against the evidence behind it.",
  },
  {
    metric: "personalization_quality",
    description: "Was the draft specific, sourced and non-generic?",
    kind: "rate",
    direction: "at_least",
    threshold: 8_500,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "Below Phase 9's bar a draft is a template with a name in it, which is the exact failure Phase 7's provenance requirement exists to stop.",
  },
  {
    metric: "response_classification_accuracy",
    description: "Was the reply intent read correctly?",
    kind: "rate",
    direction: "at_least",
    threshold: 9_000,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "Phase 12's classifier decides whether a person is asked to look, so a misread is measured as a cost to the reviewer rather than as a tidiness problem.",
  },
  {
    metric: "cost",
    description: "What did the recorded runs cost, against the declared limit?",
    kind: "spend_minor",
    direction: "at_most",
    // The published threshold is the Phase 18 ceiling of the most generous
    // agent; the engine replaces it with that agent's own `costLimits`, and
    // `threshold: 0` here exists only so the row is total. `cost` is never
    // judged against this value.
    threshold: 0,
    minimumSample: 1,
    rationale:
      "The bar is the agent's own declared ceiling from `ROADMAP.md` §25, read from the declaration rather than restated here — one owner per number. Both the total and the largest single run are checked.",
  },
  {
    metric: "latency",
    description: "How long did the slowest recorded run take?",
    kind: "duration_ms",
    direction: "at_most",
    threshold: LATENCY_CEILING_MS,
    minimumSample: 1,
    rationale:
      "The slowest run, not the average: a single run a person waited on for is the one they remember, and an average would let it hide.",
  },
  {
    metric: "failure_rate",
    description: "How often did the run fail outright?",
    kind: "rate",
    direction: "at_most",
    threshold: 1_000,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "A failure is not a wrong answer, it is no answer, so one in ten is the point at which the surrounding workflow starts stalling rather than degrading.",
  },
  {
    metric: "human_override_rate",
    description: "How often did a person override the agent's output?",
    kind: "rate",
    direction: "at_most",
    threshold: 2_500,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "An override is the strongest available signal that the output was not usable, and it is measured from a person acting rather than from anything the agent says about itself.",
  },
  {
    metric: "business_outcome",
    description: "Did the agent's work produce the outcome it claimed?",
    kind: "rate",
    direction: "at_least",
    threshold: 5_000,
    minimumSample: RATE_MINIMUM_SAMPLE,
    rationale:
      "Half is deliberately modest: a revenue outcome has many causes besides the agent, so this phase refuses to hold any agent to a number it could not possibly control.",
  },
];

const METRICS_BY_NAME = new Map<string, EvaluationMetricRule>();
for (const rule of EVALUATION_METRICS) {
  METRICS_BY_NAME.set(rule.metric, rule);
}

const VERDICT_SET: ReadonlySet<string> = new Set(EVALUATION_VERDICTS);

/** The published rule for one metric, or `null` when it is not one of the thirteen. */
export function metricRule(metric: string): EvaluationMetricRule | null {
  return METRICS_BY_NAME.get(metric) ?? null;
}

/** Whether a string names one of the thirteen published metrics. */
export function isEvaluationMetric(value: string): value is AgentEvaluationMetric {
  return METRICS_BY_NAME.has(value);
}

/** Whether a string names one of the three recorded judgements. */
export function isEvaluationVerdict(value: string): value is EvaluationVerdict {
  return VERDICT_SET.has(value);
}

/** Whether this metric's observation carries a measured quantity. */
export function isMeasuredMetric(metric: string): boolean {
  return EVALUATION_MEASURED_METRICS.some((entry) => entry.metric === metric);
}

/**
 * The position of a metric in the published order.
 *
 * The sort key for every observation listing, so the trail is a total order over
 * a constant table — never a `localeCompare` on free text as the primary key
 * and never a generated id.
 */
export function metricOrder(metric: string): number {
  let order = 0;
  for (const rule of EVALUATION_METRICS) {
    if (rule.metric === metric) return order;
    order += 1;
  }
  return -1;
}

/** `ROADMAP.md` §26's gate, stated in one sentence. */
export const EVALUATION_GATE_RULE =
  "ROADMAP.md §26: production agents require evaluation evidence. An agent may reach `production` only when the live Phase 19 evaluation round for its exact declared version has enough recorded evidence to judge every metric it declares, and every one of them meets its published threshold. Evidence from another agent version, another round or another workspace is never consulted. Satisfying this gate permits the lifecycle transition and nothing else: it does not make the agent usable, because no agent in this repository can be used in any state.";

/** What this phase refuses to do, in its own words. */
export const EVALUATION_NEVER_DOES: readonly string[] = [
  "Never executes an agent: there is no runner, dispatcher, loop, scheduler or tool invoker in this package.",
  "Never calls a model, a provider or a network: every number comes from stored rows.",
  "Never fabricates a measurement: every rate, total and comparison is derived from stored judgements by the arithmetic published here.",
  "Never scores a judgement a person did not make: a request supplies a subject and either a verdict or a measured quantity, and never a rate, a total, a threshold or a pass.",
  "Never converts absent evidence into a value: a metric with too few observations reports `insufficient_evidence` and contributes no number.",
  "Never treats an unjudged subject as a good one: `unobserved` stays in the denominator, so declining to look can never raise a metric.",
  "Never reads evidence recorded against another agent version, another round or another workspace.",
  "Never edits or deletes a judgement: a changed opinion opens a new round, which supersedes the old evidence without rewriting a row.",
  "Never uses the clock to decide anything: rounds are ordered by number, so identical rows always produce an identical report.",
  "Never traces a run: ROADMAP.md §27 (Phase 20) owns execution traces, token usage and tool-call trails, and this phase writes none.",
  "Never grants an agent a capability: passing the gate permits one governance transition and nothing more.",
];

/** Construct a domain error, keeping field details when there are any. */
export function evaluationError(
  code: EvaluationErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): EvaluationError {
  return details && details.length > 0 ? { code, message, details } : { code, message };
}
