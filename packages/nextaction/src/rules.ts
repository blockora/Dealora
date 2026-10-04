/**
 * The rules Phase 14 enforces, stated as data.
 *
 * Everything the engine decides lives in this file rather than being spread
 * through the service, so "what does DEALORA recommend when it sees *this*?"
 * has exactly one answer in the codebase and can be read back through the API
 * before a workspace has a single account.
 */

import type {
  NextActionError,
  NextActionErrorCode,
  NextBestActionKind,
  NextBestActionOutcome,
  NextBestActionRiskLevel,
  NextBestActionState,
  ResearchConfidence,
} from "./types.js";

/** The version stamped on every recommendation this deployment produces. */
export const NEXT_ACTION_RULE_VERSION = "next-action-1.0.0";

/**
 * The §17 level of each recommended action, stated once.
 *
 * Every entry is justified by `DEALORA_BLUEPRINT.md` §17's own examples rather
 * than by taste:
 *
 * - Level 1 is §17's "draft message", and both `personalize_outreach` and
 *   `prepare_reply_for_approval` are exactly that. `convert_findings_to_evidence`
 *   and `propose_meeting` are drafts too — they produce an internal document that
 *   no one outside the system sees until a person acts on it.
 * - Level 2 is §17's "send message" and "schedule event", and those are the only
 *   two things `send_approved_message` and `book_meeting` mean.
 * - Everything else is Level 0: reading, summarizing or recording. Nothing about
 *   them reaches a prospect.
 *
 * `stop_contacting` is Level 0 on purpose. It is advice *not* to act, and rating
 * it above a read would misrepresent it as something that needs permission.
 */
export const RISK_BY_ACTION: Readonly<Record<NextBestActionKind, NextBestActionRiskLevel>> = {
  stop_contacting: "level_0_read",
  research_account: "level_0_read",
  convert_findings_to_evidence: "level_1_draft",
  qualify_account: "level_0_read",
  personalize_outreach: "level_1_draft",
  request_approval: "level_0_read",
  send_approved_message: "level_2_external_action",
  propose_meeting: "level_1_draft",
  book_meeting: "level_2_external_action",
  prepare_meeting_brief: "level_0_read",
  prepare_reply_for_approval: "level_1_draft",
  hold: "level_0_read",
};

/** §17's ladder, weakest first. The order every published risk level is sorted in. */
const RISK_LADDER: readonly NextBestActionRiskLevel[] = [
  "level_0_read",
  "level_1_draft",
  "level_2_external_action",
];

/**
 * What acting on the recommendation is expected to produce.
 *
 * Closed, and derived from the action through this map alone, so "expected
 * outcome" can never disagree with the action it belongs to and can never be a
 * free-text promise the engine has no way to keep.
 */
export const OUTCOME_BY_ACTION: Readonly<Record<NextBestActionKind, NextBestActionOutcome>> = {
  stop_contacting: "contact_stopped",
  research_account: "research_findings_available",
  convert_findings_to_evidence: "evidence_available",
  qualify_account: "qualification_available",
  personalize_outreach: "draft_available",
  request_approval: "approval_decided",
  send_approved_message: "message_delivered",
  propose_meeting: "meeting_proposed",
  book_meeting: "meeting_booked",
  prepare_meeting_brief: "brief_available",
  prepare_reply_for_approval: "reply_prepared",
  hold: "no_action_available",
};

/** One decision branch: which state, what it produces, and at what risk. */
export interface NextActionRule {
  supportingState: NextBestActionState;
  action: NextBestActionKind;
  riskLevel: NextBestActionRiskLevel;
  expectedOutcome: NextBestActionOutcome;
  /** True exactly for a Level 2 external action. Never a separate decision. */
  approvalRequired: boolean;
}

/**
 * The whole rule set, in evaluation order. The first matching branch wins.
 *
 * **The order is the safety policy.** Suppression is first, because an opt-out
 * must beat every other consideration however attractive the account looks. The
 * live meeting states come next, because a meeting a person is already handling
 * outranks anything DEALORA could suggest about the same account. Only then does
 * the engine walk the sourcing loop.
 *
 * The table is `readonly`, so `RISK_BY_ACTION` and `OUTCOME_BY_ACTION` have to
 * cover every action in it before it will type-check.
 */
export const NEXT_ACTION_RULES: readonly NextActionRule[] = Object.freeze(
  (
    [
      // --- Safety first --------------------------------------------------
      ["suppressed", "stop_contacting"],
      // --- A meeting a person is already handling -------------------------
      ["meeting_approved", "book_meeting"],
      ["meeting_booked_without_brief", "prepare_meeting_brief"],
      ["meeting_recommended", "hold"],
      ["meeting_awaiting_approval", "hold"],
      ["meeting_booked", "hold"],
      // A cancelled, held or missed meeting is a decision a person already made.
      // The engine does not re-propose over the top of one.
      ["meeting_closed", "hold"],
      // --- A positive response is the strongest signal in the system -------
      ["positive_response_without_meeting", "propose_meeting"],
      // --- The sourcing loop, in the order it happens ----------------------
      ["no_research", "research_account"],
      ["researched_without_evidence", "convert_findings_to_evidence"],
      ["evidenced_without_qualification", "qualify_account"],
      ["not_qualified", "hold"],
      ["qualified_without_draft", "personalize_outreach"],
      ["drafted_without_approval", "request_approval"],
      ["approval_pending", "hold"],
      ["approved_without_send", "send_approved_message"],
      ["awaiting_response", "hold"],
      ["response_needing_reply", "prepare_reply_for_approval"],
    ] as const satisfies readonly (readonly [NextBestActionState, NextBestActionKind])[]
  ).map(([supportingState, action]) => {
    const riskLevel = RISK_BY_ACTION[action];
    return Object.freeze({
      supportingState,
      action,
      riskLevel,
      expectedOutcome: OUTCOME_BY_ACTION[action],
      approvalRequired: riskLevel === "level_2_external_action",
    });
  }),
);

/**
 * Every revenue state the engine can observe.
 *
 * Derived from {@link NEXT_ACTION_RULES}, so it is closed *and* exactly the states
 * the engine can produce. A member here that no branch emits would be dead
 * vocabulary, and a branch whose state is missing would be advice the policy
 * route cannot explain — the schema's CHECK constraint lists the same eighteen
 * strings for the same reason.
 */
export const NEXT_ACTION_STATES: readonly NextBestActionState[] = Object.freeze(
  NEXT_ACTION_RULES.map((rule) => rule.supportingState),
);

/**
 * Every recommended action.
 *
 * Closed, and **entirely producible**: every member is emitted by a branch of the
 * engine that reads stored rows. This vocabulary was deliberately not widened with
 * plausible-sounding members such as `escalate_to_manager` or `schedule_follow_up`
 * that no branch could ever emit — a vocabulary a reader cannot trust to be
 * reachable is worse than a short one, and Phase 13 was corrected for exactly
 * this mistake.
 *
 * None of these is an action DEALORA takes. They are the next *step a person or a
 * later phase could take*, and the two consequential ones still name the phase
 * that owns doing it.
 */
export const NEXT_BEST_ACTION_KINDS: readonly NextBestActionKind[] = Object.freeze([
  ...new Set(NEXT_ACTION_RULES.map((rule) => rule.action)),
]);

/**
 * The §17 levels a recommendation may carry.
 *
 * `level_3_high_impact` is deliberately absent. §17 reserves it for a financial
 * commitment, a contract action or an irreversible change, and **no branch in
 * this phase recommends one** — listing it would advertise a capability the
 * engine does not have.
 *
 * Phase 10's `ApprovalRiskLevel` is the wider ladder that does include level 3,
 * because a draft's approval request has to be able to name it. A recommendation
 * is a narrower thing: it can only ever point at a step in the revenue loop.
 */
export const NEXT_ACTION_RISK_LEVELS: readonly NextBestActionRiskLevel[] = Object.freeze(
  [...new Set(NEXT_ACTION_RULES.map((rule) => rule.riskLevel))].sort(
    (a, b) => RISK_LADDER.indexOf(a) - RISK_LADDER.indexOf(b),
  ),
);

/** The branch for one state. Present for every member of the vocabulary. */
export const RULE_BY_STATE: Readonly<Record<NextBestActionState, NextActionRule>> = Object.freeze(
  Object.fromEntries(NEXT_ACTION_RULES.map((rule) => [rule.supportingState, rule])) as Record<
    NextBestActionState,
    NextActionRule
  >,
);

/**
 * The confidence bands, weakest first.
 *
 * The ordering is the rule ADR 0009 already set for Phase 7 and Phase 8: a
 * recommendation is only as strong as the **weakest** record that produced it,
 * because a strong classification resting on one `low` source is still resting on
 * that one `low` source. Bands are never summed, averaged or re-scaled — there is
 * no calibration data here from which a percentage could mean anything, so the
 * `93%` printed in `DEALORA_BLUEPRINT.md` §25's illustration is not something this
 * engine can honestly produce.
 */
export const CONFIDENCE_ORDER: readonly ResearchConfidence[] = ["low", "medium", "high"];

/** True when `value` is one of the three bands. */
export function isConfidence(value: unknown): value is ResearchConfidence {
  return typeof value === "string" && (CONFIDENCE_ORDER as readonly string[]).includes(value);
}

/**
 * The weakest of the supplied bands, or `null` when there are none.
 *
 * The honest answer to "how strong is this?" when nothing supporting carries a
 * band. Callers do not silently substitute `low` or `high` in that case: a branch
 * with no confidence-bearing source names the stored fact it relied on instead,
 * and a fact about the workspace's own records is not an inference about the
 * world, so it is not weak in the way an unsourced guess would be.
 */
export function weakestConfidence(
  bands: readonly (ResearchConfidence | null)[],
): ResearchConfidence | null {
  let weakest: ResearchConfidence | null = null;
  for (const band of bands) {
    if (band === null) continue;
    if (weakest === null || CONFIDENCE_ORDER.indexOf(band) < CONFIDENCE_ORDER.indexOf(weakest)) {
      weakest = band;
    }
  }
  return weakest;
}

export function isNextActionState(value: unknown): value is NextBestActionState {
  return typeof value === "string" && (NEXT_ACTION_STATES as readonly string[]).includes(value);
}

export function isNextActionKind(value: unknown): value is NextBestActionKind {
  return typeof value === "string" && (NEXT_BEST_ACTION_KINDS as readonly string[]).includes(value);
}

/** The meeting states that mean a person has already finished with this meeting. */
export const TERMINAL_MEETING_STATES: readonly string[] = ["held", "no_show", "cancelled"];

/**
 * A cap on the workspace-wide answer.
 *
 * A workspace could hold thousands of accounts, and the board is meant to be
 * glanceable. The cap is a **refusal** rather than a silent truncation, so a
 * caller is never shown a board that quietly stopped at an arbitrary number and
 * was told it was complete.
 */
export const BOARD_LIMIT = 100;

export function nextActionError(
  code: NextActionErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): NextActionError {
  // `details` is omitted entirely when there is nothing to say, because an empty
  // array reads as "no problems" on a refusal a user is about to be shown.
  return details && details.length > 0 ? { code, message, details } : { code, message };
}
