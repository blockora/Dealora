/**
 * @dealora/meeting — the types Phase 13's meeting workflow needs.
 *
 * The shape of this file is the design. `ROADMAP.md` §20 asks for a meeting
 * workflow whose gate is "*a qualified positive response can result in a
 * measurable meeting state*", and the two words that matter are **qualified** and
 * **measurable**.
 *
 * `qualified` means the phase refuses to propose a meeting for a response that was
 * not read as positive, or for an account that did not qualify. Both prerequisites
 * are re-derived server-side from stored Phase 12 and Phase 8 rows; neither is
 * something a caller may assert.
 *
 * `measurable` means a meeting is a **record with a state**, not an intention. A
 * proposal that nobody approved is `recommended` and says so. A meeting that was
 * never booked never reports `booked`. There is deliberately no state that a
 * single call can reach on its own.
 *
 * The negative space is the important half. This package has **no email sender,
 * no approval engine of its own, no CRM and no live calendar**. It can read a
 * Phase 12 classification, propose a booking, record a person's decision about
 * it, hand it to a calendar adapter, and produce a preparation brief from records
 * that already exist. It cannot send anything, cannot approve itself, and cannot
 * invent a fact about an account.
 */

import type {
  ConversationClassification,
  ConversationIntent,
  DateTime,
  EntityId,
  Meeting,
  MeetingBookingChannel,
  MeetingBookingState,
  MeetingBrief,
  MeetingEvent,
  MeetingEventKind,
  MeetingRecommendationReason,
  Qualification,
} from "@dealora/db";

export type {
  ConversationClassification,
  ConversationIntent,
  DateTime,
  EntityId,
  Meeting,
  MeetingBookingChannel,
  MeetingBookingState,
  MeetingBrief,
  MeetingEvent,
  MeetingEventKind,
  MeetingRecommendationReason,
  Qualification,
};

/**
 * Error codes this domain raises.
 *
 * Closed and mapped case by case at the transport boundary, like every other
 * DEALORA domain, so a new failure cannot appear over the wire as a code the API
 * contract does not define.
 */
export type MeetingErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "PREREQUISITE_NOT_MET"
  | "INVALID_TRANSITION"
  | "SUPPRESSED"
  | "UNAVAILABLE";

export interface MeetingError {
  readonly code: MeetingErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** An injectable clock, so every timestamp the service writes is reproducible. */
export type Clock = () => Date;

/**
 * The narrow view of the Phase 12 classification a meeting must come from.
 *
 * Deliberately narrower than the classification itself. The meeting engine needs
 * to know that a response was read as positive, that it was not suppressed, and
 * which account and contact it belongs to — and nothing else. It never sees the
 * message body through this reader, so "classify a response" can never become
 * "act on a response" by accident.
 */
export interface MeetingClassificationReader {
  /**
   * One classification the caller owns, together with the response it came from.
   *
   * Returns `null` for a classification that does not exist *or* that belongs to
   * another workspace. The engine must not be able to tell those apart.
   */
  positiveClassification(
    classificationId: EntityId,
    userId: EntityId,
  ): MeetingClassificationSnapshot | null;
}

export interface MeetingClassificationSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  contactId: EntityId;
  outboundActionId: EntityId;
  inboundMessageId: EntityId;
  intent: ConversationIntent;
  confidence: string;
  /** The response text, so the brief can quote it verbatim. */
  body: string;
  /** True when the classification put the address on the Phase 11 opt-out list. */
  suppressed: boolean;
}

/**
 * The narrow view of a Phase 8 qualification a meeting must be grounded in.
 *
 * A meeting needs the account to have *qualified*, not merely to exist, so the
 * engine reads the qualification's state and score through this reader rather
 * than trusting that a caller has one.
 */
export interface MeetingQualificationReader {
  /**
   * The newest qualification for an account the caller owns, or `null`.
   *
   * Takes the workspace explicitly rather than deriving it, because the store's
   * qualification query is workspace-scoped: reading by account alone would
   * either bypass that boundary or need the workspace recovered from a row the
   * caller has not been authorized for yet.
   */
  latestForAccount(
    workspaceId: EntityId,
    accountId: EntityId,
    userId: EntityId,
  ): MeetingQualificationSnapshot | null;
}

export interface MeetingQualificationSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  state: Qualification["state"];
  score: number | null;
}

/**
 * The narrow reader for the Phase 11 opt-out list.
 *
 * Reused rather than reimplemented: the send path already checks this exact list,
 * so a meeting for a suppressed address has to check it too. A workspace that
 * asked to stop being contacted must not be able to end up with a booked meeting
 * just because the booking path forgot to ask.
 */
export interface MeetingSuppressionReader {
  /**
   * True when this address is on the workspace's suppression list.
   *
   * Takes the caller's identity because the store's check is workspace-scoped
   * *and* authorized: reading the list is itself a tenant operation, so a
   * suppression list is never consulted across a boundary.
   */
  isSuppressed(workspaceId: EntityId, userId: EntityId, email: string): boolean;
}

/** The contact's own details, for the brief and the invitation. */
export interface MeetingContactReader {
  /** The contact behind a classification, resolved server-side. */
  contact(contactId: EntityId, userId: EntityId): MeetingContactSnapshot | null;
}

export interface MeetingContactSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
}

/** The storage surface Phase 13 needs. Every call is workspace-scoped. */
export interface MeetingRepository {
  authorize(
    workspaceId: EntityId,
    userId: EntityId,
  ): { ok: true } | { ok: false; error: { code: string; message: string } };

  createMeeting(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    meeting: {
      accountId: EntityId;
      contactId: EntityId;
      classificationId: EntityId;
      inboundMessageId: EntityId;
      outboundActionId: EntityId;
      qualificationId: EntityId;
      state: MeetingBookingState;
      recommendationReason: MeetingRecommendationReason;
      policyVersion: string;
      bookingDigest: string;
      title: string;
      startsAt: DateTime;
      endsAt: DateTime;
      timezone: string;
      durationMinutes: number;
      channel: MeetingBookingChannel;
      suppressionCheckedAt?: DateTime | null;
    };
  }): { ok: true; value: Meeting } | { ok: false; error: { code: string; message: string } };

  getMeeting(
    id: EntityId,
    userId: EntityId,
  ): { ok: true; value: Meeting } | { ok: false; error: { code: string; message: string } };

  listMeetings(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { state?: MeetingBookingState; accountId?: EntityId; contactId?: EntityId },
  ): { ok: true; value: Meeting[] } | { ok: false; error: { code: string; message: string } };

  updateMeetingState(input: {
    meetingId: EntityId;
    actorUserId: EntityId;
    state: MeetingBookingState;
    approvedBy?: EntityId | null;
    approvedAt?: DateTime | null;
    bookedAt?: DateTime | null;
    cancelledAt?: DateTime | null;
    externalEventId?: string | null;
    suppressionCheckedAt?: DateTime | null;
    decisionReason?: string | null;
  }): { ok: true; value: Meeting } | { ok: false; error: { code: string; message: string } };

  createMeetingBrief(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    brief: {
      meetingId: EntityId;
      rendererVersion: string;
      accountId: EntityId;
      contactId: EntityId;
      qualificationId: EntityId;
      qualificationScore: number | null;
      classificationId: EntityId;
      intent: MeetingBrief["intent"];
      claimIds: EntityId[];
      evidenceIds: EntityId[];
      conversationExcerpt: string;
      gaps: string[];
    };
  }): { ok: true; value: MeetingBrief } | { ok: false; error: { code: string; message: string } };

  listMeetingBriefs(
    meetingId: EntityId,
    userId: EntityId,
  ): { ok: true; value: MeetingBrief[] } | { ok: false; error: { code: string; message: string } };

  createMeetingEvent(input: {
    workspaceId: EntityId;
    actorUserId: EntityId;
    event: { meetingId: EntityId; kind: MeetingEventKind; detail: string | null };
  }): { ok: true; value: MeetingEvent } | { ok: false; error: { code: string; message: string } };

  listMeetingEvents(
    meetingId: EntityId,
    userId: EntityId,
  ): { ok: true; value: MeetingEvent[] } | { ok: false; error: { code: string; message: string } };
}

/**
 * What a calendar adapter is asked to do.
 *
 * **This is the boundary, not a live integration.** `ROADMAP.md` §30 puts "CRM,
 * calendar, email" integrations in Phase 23, explicitly "only after the core
 * revenue loop works". So Phase 13 defines the interface a real adapter will
 * implement and ships a sandbox that performs no network I/O, which means every
 * booking claim in this repository means "the provider recorded it" — never
 * "DEALORA asserted it".
 *
 * The adapter is deliberately given the whole booking and nothing else: no
 * credentials, no workspace configuration, no ability to read other meetings.
 */
export interface MeetingCalendarProvider {
  /** A stable name for this adapter, stored on the booking it produced. */
  readonly channel: MeetingBookingChannel;

  /** Bookable windows this provider will accept. Read-only, no side effects. */
  availability(): MeetingAvailabilityWindow[];

  /**
   * Create an event.
   *
   * Returns the provider's own reference on success. A refusal, a thrown call or
   * a malformed answer must be turned into a booking failure by the service —
   * `booked` is written from exactly one place, on a provider confirmation, and
   * can never be reached any other way.
   */
  createEvent(input: MeetingCalendarRequest): Promise<MeetingCalendarResponse>;
}

export interface MeetingCalendarRequest {
  /** Stable across retries, so one approval yields at most one event. */
  idempotencyKey: string;
  title: string;
  startsAt: DateTime;
  endsAt: DateTime;
  timezone: string;
  /** The attendee, resolved server-side from the contact record. */
  attendeeEmail: string;
  attendeeName: string;
  /** Free-text context the provider may show. Never a claim about the account. */
  description: string;
}

export interface MeetingCalendarResponse {
  ok: boolean;
  /** The provider's reference for the created event. */
  externalEventId: string | null;
  /** Why the provider refused. Present exactly when `ok` is false. */
  failureCode: MeetingBookingFailure | null;
  message: string | null;
}

export type MeetingBookingFailure =
  "provider_unavailable" | "provider_rejected" | "slot_unavailable" | "invalid_attendee";

export interface MeetingAvailabilityWindow {
  /** ISO-8601 instant this window starts. */
  startsAt: DateTime;
  /** ISO-8601 instant this window ends. */
  endsAt: DateTime;
}

/**
 * What a decision about a meeting produced.
 *
 * A booking decision is a *person's* decision, exactly as a Phase 10 approval is.
 * The reviewer identity and the instant are taken from the session in the service
 * and re-checked in storage, so a client cannot name its own approver or backdate
 * a booking.
 */
export interface MeetingDecisionInput {
  decision: unknown;
  /** Required for a decline, and for a cancellation. Never optional. */
  reason?: unknown;
}

export interface RecommendMeetingInput {
  /** The Phase 12 classification that produced the positive response. */
  classificationId: unknown;
  title?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  timezone?: unknown;
  durationMinutes?: unknown;
}

export interface BookMeetingInput {
  /** Stable across retries; derived server-side from the meeting. */
  idempotencyKey?: unknown;
}

export interface MeetingResult {
  meeting: Meeting;
  /** Every step this booking took, oldest first. */
  events: MeetingEvent[];
}

export interface MeetingBriefResult {
  meeting: Meeting;
  brief: MeetingBrief;
}

/**
 * The policy this deployment enforces, as data.
 *
 * Readable before any meeting exists, so a workspace can see what the workflow
 * will and will not do before it hands over a response.
 */
export interface MeetingPolicyView {
  policyVersion: string;
  briefRendererVersion: string;
  states: readonly MeetingBookingState[];
  /** Every state-to-state move the workflow permits. */
  transitions: readonly (readonly [MeetingBookingState, MeetingBookingState])[];
  recommendationReasons: readonly MeetingRecommendationReason[];
  channels: readonly MeetingBookingChannel[];
  /** Everything that stops a meeting before it is proposed. */
  prerequisites: string[];
  /** Every thing this phase will never do, stated plainly. */
  neverDoes: string[];
}
