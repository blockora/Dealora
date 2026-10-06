/** @dealora/optimization — the declared optimization facets and rule version.

 * `ROADMAP.md` §28 asks this phase to compare eight dimensions and answer five
 * questions, and to be *measurable, reversible and auditable*. This file
 * declares the eighteen facets this phase compares as it builds those answers,
 * and the rule version every analysis carries.
 *
 * The eighteen facets are grouped under the eight roadmap dimensions so that
 * the roadmap's "compare" list is the grouping and the facets are the
 * measurement surface. No facet mutates rows; every facet reads from the
 * repository surface and reports observations, learnings, candidate tests and
 * likely-impact hypotheses.
 */

/** `@dealora/optimization`'s current rule version. */
export const OPTIMIZATION_RULE_VERSION = "optimization-1.0.0";

export type OptimizationDimension =
  | "audiences"
  | "messages"
  | "signals"
  | "channels"
  | "timing"
  | "qualification_rules"
  | "follow_up_sequences"
  | "offers";

export type OptFacetId =
  | "OPT-01"
  | "OPT-02"
  | "OPT-03"
  | "OPT-04"
  | "OPT-05"
  | "OPT-06"
  | "OPT-07"
  | "OPT-08"
  | "OPT-09"
  | "OPT-10"
  | "OPT-11"
  | "OPT-12"
  | "OPT-13"
  | "OPT-14"
  | "OPT-15"
  | "OPT-16"
  | "OPT-17"
  | "OPT-18";

/** The eighteen optimization facets, grouped by the §28 dimension they serve. */
export const OPTIMIZATION_FACETS: readonly OptFacetId[] = [
  // audiences
  "OPT-01",
  // messages
  "OPT-02",
  // signals
  "OPT-03",
  "OPT-09",
  // channels
  "OPT-04",
  "OPT-11",
  // timing
  "OPT-05",
  "OPT-12",
  // qualification rules
  "OPT-06",
  "OPT-15",
  // follow-up sequences
  "OPT-07",
  "OPT-13",
  "OPT-14",
  // offers
  "OPT-08",
  "OPT-10",
  // cross-cutting
  "OPT-16",
  "OPT-17",
  "OPT-18",
];

export const OPTIMIZATION_ASPECTS: {
  readonly id: OptFacetId;
  readonly name: string;
  readonly dimension: OptimizationDimension;
  readonly purpose: string;
}[] = [
  {
    id: "OPT-01",
    name: "audience segments",
    dimension: "audiences",
    purpose:
      "Which audience segments turn into qualified accounts at the highest rate and with the richest evidence.",
  },
  {
    id: "OPT-02",
    name: "outreach drafts",
    dimension: "messages",
    purpose:
      "Which approved drafts produce positive replies, which produce objections, and which produce no response.",
  },
  {
    id: "OPT-03",
    name: "reply intent",
    dimension: "signals",
    purpose:
      "Which conversation intents lead to meetings, which lead to dead ends, and which signal problems to escalate.",
  },
  {
    id: "OPT-04",
    name: "push channels",
    dimension: "channels",
    purpose: "Which channels actually sent, which delivered, which failed, and which hit opt-outs.",
  },
  {
    id: "OPT-05",
    name: "contact cadence",
    dimension: "timing",
    purpose:
      "When outreach goes out relative to qualification and reply, and how that timing relates to send outcomes.",
  },
  {
    id: "OPT-06",
    name: "qualification rules",
    dimension: "qualification_rules",
    purpose:
      "Which qualification criteria and rule versions correlate with higher quality qualified accounts and downstream conversion.",
  },
  {
    id: "OPT-07",
    name: "follow-up sequences",
    dimension: "follow_up_sequences",
    purpose:
      "Which follow-up patterns produce replies and meetings, and which produce nothing or suppressions.",
  },
  {
    id: "OPT-08",
    name: "offers",
    dimension: "offers",
    purpose:
      "Which offers and pricing arrangements correlate with shortlists, meetings, booked conversations, and outcomes.",
  },
  {
    id: "OPT-09",
    name: "signal acquisition",
    dimension: "signals",
    purpose: "Which research findings and signal sources are turning into qualified accounts.",
  },
  {
    id: "OPT-10",
    name: "offer variants",
    dimension: "offers",
    purpose:
      "Which offer variants and pricing/personalization combinations show different conversion behavior.",
  },
  {
    id: "OPT-11",
    name: "delivery quality",
    dimension: "channels",
    purpose: "Send, delivery, and failure behavior across channels and send timing.",
  },
  {
    id: "OPT-12",
    name: "follow-up tempo",
    dimension: "timing",
    purpose:
      "How fast a follow-up sequence runs and how that tempo relates to reply and meeting outcomes.",
  },
  {
    id: "OPT-13",
    name: "route and touch cadence",
    dimension: "follow_up_sequences",
    purpose:
      "How many touches a workflow uses per account day, and how that relates to abandonment and conversion.",
  },
  {
    id: "OPT-14",
    name: "conversation velocity",
    dimension: "follow_up_sequences",
    purpose: "How quickly conversations move from reply to meeting booking, or stall.",
  },
  {
    id: "OPT-15",
    name: "funnel shape",
    dimension: "qualification_rules",
    purpose:
      "Where the funnel leaks most, by stage and by the qualification rule version that fed it.",
  },
  {
    id: "OPT-16",
    name: "evidence lifecycle",
    dimension: "signals",
    purpose:
      "How evidence moves from pending to verified and superseded, and what that says about evidence quality.",
  },
  {
    id: "OPT-17",
    name: "budget and limits",
    dimension: "timing",
    purpose: "Cost-per-touch, approval-cycle time, and suppression impact on send rate.",
  },
  {
    id: "OPT-18",
    name: "account well-being",
    dimension: "audiences",
    purpose:
      "Suppression trends, no-show rates, and long-lived pending approvals that measure whether the workspace is oversaturating contacts.",
  },
];

/** The eight optimization dimensions `ROADMAP.md` §28 actually names. */
export const OPTIMIZATION_DIMENSIONS: readonly OptimizationDimension[] = [
  "audiences",
  "messages",
  "signals",
  "channels",
  "timing",
  "qualification_rules",
  "follow_up_sequences",
  "offers",
];

/** The five optimization answers `ROADMAP.md` §28 asks for. */
export type OptAnswer = "worked" | "failed" | "dropping" | "test" | "impact";

export const OPTIMIZATION_ANSWERS: readonly OptAnswer[] = [
  "worked",
  "failed",
  "dropping",
  "test",
  "impact",
];
