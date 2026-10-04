/**
 * The rules Phase 13 enforces, stated as data.
 *
 * The booking state machine lives here rather than being spread through the
 * service, so "what can happen to a meeting next?" has exactly one answer in the
 * codebase and can be read back through the API before a workspace has any
 * meeting at all.
 */

import type {
  ConversationIntent,
  MeetingBookingState,
  MeetingError,
  MeetingErrorCode,
  MeetingRecommendationReason,
} from "./types.js";

/** The version stamped on every booking this deployment proposes. */
export const MEETING_POLICY_VERSION = "deterministic-1.0.0";

/** The version stamped on every brief this deployment renders. */
export const MEETING_BRIEF_RENDERER_VERSION = "brief-1.0.0";

export const MEETING_STATES: readonly MeetingBookingState[] = [
  "recommended",
  "awaiting_approval",
  "approved",
  "booked",
  "held",
  "no_show",
  "cancelled",
];

/**
 * Every reason a meeting can be recommended for.
 *
 * Closed and, deliberately, **exactly the reasons the rules can produce**. An
 * earlier draft of this file also listed `question_answered_live`,
 * `pricing_answered_live` and `requested_by_user` as forward-looking members; no
 * code path could ever emit any of them, so the policy route was advertising
 * recommendations this phase does not make. A vocabulary a reader cannot trust
 * is worse than a short one, and ROADMAP.md §20 asks for a recommendation from a
 * positive response — not a taxonomy of intentions for later.
 */
export const MEETING_RECOMMENDATION_REASONS: readonly MeetingRecommendationReason[] = [
  "positive_intent",
  "expressed_interest",
];

/**
 * The intents that may become a meeting.
 *
 * Closed and short. `interested` is included because a reply that says "tell me
 * more" is the most common form of positive intent and refusing it would be a
 * false negative; everything else — an objection, a deferral, a refusal, an
 * opt-out, `unknown` — is not something to put a calendar invite behind.
 *
 * `question` and `pricing` are deliberately absent: §21's flow starts from
 * positive intent, and a prospect asking a price is not yet asking for a
 * meeting. The map below is where a later phase would widen that.
 */
export const MEETABLE_INTENTS: readonly ConversationIntent[] = ["positive_intent", "interested"];

/**
 * Which reason a given intent produces — the single place "why this meeting?"
 * is answered.
 */
export const RECOMMENDATION_BY_INTENT: Record<string, MeetingRecommendationReason | null> = {
  positive_intent: "positive_intent",
  interested: "expressed_interest",
  question: null,
  pricing: null,
  objection: null,
  not_now: null,
  wrong_person: null,
  unsubscribe: null,
  negative_intent: null,
  unknown: null,
};

/**
 * The legal booking transitions.
 *
 * This table is the phase's core safety property, stated once:
 *
 * - Nothing reaches `approved` without passing through `awaiting_approval`.
 *   There is no edge from `recommended` straight to `approved`, so a single call
 *   cannot authorize a booking on a person's behalf.
 * - Nothing reaches `booked` without an approval. There is no edge into
 *   `booked` from `recommended` or `awaiting_approval`.
 * - `cancelled` is terminal. Once a meeting is cancelled it stays cancelled; it
 *   cannot be re-booked, which is what stops a replayed request from resurrecting
 *   a meeting a person deliberately withdrew.
 * - `held` and `no_show` are only reachable from `booked`: a meeting that was
 *   never booked cannot be reported as having been held or missed.
 */
export const MEETING_TRANSITIONS: ReadonlyMap<MeetingBookingState, readonly MeetingBookingState[]> =
  new Map<MeetingBookingState, readonly MeetingBookingState[]>([
    ["recommended", ["awaiting_approval", "cancelled"]],
    ["awaiting_approval", ["approved", "cancelled"]],
    ["approved", ["booked", "cancelled"]],
    // A failed booking attempt stays where a retry is legal: the approval was
    // real, only the provider refused. `awaiting_approval` is reachable again so
    // a person may re-authorize rather than a retry silently reusing an old yes.
    ["booked", ["held", "no_show", "cancelled"]],
    ["held", []],
    ["no_show", []],
    ["cancelled", []],
  ]);

/** True when `next` is reachable from `current`. */
export function canTransition(current: MeetingBookingState, next: MeetingBookingState): boolean {
  return (MEETING_TRANSITIONS.get(current) ?? []).includes(next);
}

/** The states that may not be moved out of. */
export const TERMINAL_STATES: readonly MeetingBookingState[] = ["held", "no_show", "cancelled"];

export function isMeetingState(value: unknown): value is MeetingBookingState {
  return typeof value === "string" && (MEETING_STATES as readonly string[]).includes(value);
}

export function isRecommendationReason(value: unknown): value is MeetingRecommendationReason {
  return (
    typeof value === "string" &&
    (MEETING_RECOMMENDATION_REASONS as readonly string[]).includes(value)
  );
}

export function isMeetableIntent(value: unknown): value is ConversationIntent {
  return typeof value === "string" && (MEETABLE_INTENTS as readonly string[]).includes(value);
}

/** What a person may say about a proposed booking. */
export type MeetingDecision = "approve" | "decline" | "cancel";

export const MEETING_DECISIONS: readonly MeetingDecision[] = ["approve", "decline", "cancel"];

export function isMeetingDecision(value: unknown): value is MeetingDecision {
  return typeof value === "string" && (MEETING_DECISIONS as readonly string[]).includes(value);
}

/**
 * Bounds on the booking metadata a caller may supply.
 *
 * Deliberately tight. A meeting's title and times are the whole content of what a
 * person approves, so they are capped rather than truncated, and an oversized
 * value is a refusal instead of a silently shortened booking that the approver
 * never saw.
 */
export const LIMITS = {
  title: 200,
  timezone: 64,
  excerpt: 2000,
  reason: 500,
  durationMinutes: 8 * 60,
  idempotencyKey: 120,
} as const;

/**
 * The minimum a booking may last, in minutes.
 *
 * A zero-length meeting is not a meeting, and the schema already refuses it;
 * this is the same rule at the boundary so the caller is told why.
 */
export const MIN_DURATION_MINUTES = 5;

export function meetingError(
  code: MeetingErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): MeetingError {
  // `details` is omitted entirely when there is nothing to say, because an empty
  // array reads as "no problems" on a refusal that is about to be shown to a user
  // as a reason.
  return details && details.length > 0 ? { code, message, details } : { code, message };
}

/**
 * A stable digest of the exact booking a reviewer is shown.
 *
 * Deliberately not a cryptographic hash and deliberately not security-critical:
 * its only job is to make "I authorized *this* booking" checkable at decision
 * time, the same way Phase 10 re-derives a draft digest. It is computed from the
 * fields a person actually saw, in a fixed order, so the same booking always
 * produces the same string on any machine.
 */
export function bookingDigest(input: {
  classificationId: string;
  contactId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  durationMinutes: number;
}): string {
  const canonical = [
    input.classificationId,
    input.contactId,
    input.title,
    input.startsAt,
    input.endsAt,
    input.timezone,
    String(input.durationMinutes),
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `bk_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
