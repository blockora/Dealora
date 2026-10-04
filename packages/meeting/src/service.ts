import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type { EntityId, Meeting, MeetingBrief, MeetingEvent } from "@dealora/db";

import { renderMeetingBrief } from "./brief.js";
import type { MeetingBriefInput } from "./brief.js";
import {
  LIMITS,
  MEETING_BRIEF_RENDERER_VERSION,
  MEETING_POLICY_VERSION,
  MEETING_TRANSITIONS,
  MIN_DURATION_MINUTES,
  RECOMMENDATION_BY_INTENT,
  TERMINAL_STATES,
  bookingDigest,
  canTransition,
  isMeetableIntent,
  isMeetingDecision,
  isMeetingState,
  meetingError,
} from "./rules.js";
import type { MeetingDecision } from "./rules.js";
import {
  MeetingIssues,
  describeMeetingPolicy,
  durationMinutes as parseDuration,
  instant,
  optionalText,
  text,
  timezone as parseTimezone,
} from "./validation.js";
import type {
  Clock,
  MeetingCalendarProvider,
  MeetingClassificationReader,
  MeetingContactReader,
  MeetingError,
  MeetingPolicyView,
  MeetingQualificationReader,
  MeetingRepository,
  MeetingResult,
  MeetingSuppressionReader,
  RecommendMeetingInput,
} from "./types.js";

export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";
export { renderMeetingBrief } from "./brief.js";
export type { MeetingBriefDraft } from "./brief.js";
export {
  SandboxCalendarProvider,
  FailingCalendarProvider,
  ThrowingCalendarProvider,
} from "./providers.js";
export type { SandboxCalendarEvent } from "./providers.js";

/**
 * Map a storage code onto a domain code.
 *
 * `INVALID` becomes `PREREQUISITE_NOT_MET` rather than `VALIDATION_ERROR`,
 * because storage only ever refuses a write here when a prerequisite does not
 * hold — and a caller who cannot influence that needs to be told it is a
 * prerequisite, not a bad field.
 */
function fromStorage(code: string, fallback: string): MeetingError {
  switch (code) {
    case "NOT_FOUND":
      return meetingError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return meetingError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return meetingError("CONFLICT", fallback);
    case "INVALID":
      return meetingError("PREREQUISITE_NOT_MET", fallback);
    default:
      // Never surface an internal storage message.
      return meetingError("UNAVAILABLE", "storage unavailable");
  }
}

/**
 * The Meeting application service — ROADMAP.md §20.
 *
 * It converts a positive response into a booking record with a measurable state,
 * and it produces the preparation brief BLUEPRINT.md §22 describes. The chain
 * runs in this order, every time:
 *
 *   authenticate → authorize → classification → qualification → suppress check
 *   → persist as `recommended` → audit
 *
 * and, separately, for the two consequential steps:
 *
 *   authenticate → authorize → legal transition → re-derive approval
 *   → re-check suppression → persist → audit
 *
 * The negative space is the point of this file.
 *
 * - **Nothing is booked without a person.** §17 classifies scheduling as a
 *   Level 2 external action. There is no code path from a fresh classification to
 *   a booked meeting: `recommend` writes `recommended`, a separate authenticated
 *   decision writes `approved`, and only then can `book` reach a provider.
 * - **The approval is re-derived, not remembered.** At decision time the service
 *   recomputes the digest from the stored row and refuses if it no longer matches
 *   what the reviewer was shown, so a meeting cannot be re-titled after a person
 *   said yes.
 * - **Suppression is re-checked twice**, at approval and again at booking, against
 *   the Phase 11 list. Someone who opts out after a meeting was proposed must not
 *   end up with it on a calendar.
 * - **It cannot send.** There is no mailer, no queue and no reminder. Booking a
 *   meeting does not email anyone; Phase 10 and Phase 11 still govern every
 *   message that ever leaves the system.
 * - **It cannot invent anything.** The brief quotes stored records and names its
 *   own gaps; nothing here writes evidence or an account claim.
 */
export class MeetingService {
  constructor(
    private readonly repo: MeetingRepository,
    private readonly classifications: MeetingClassificationReader,
    private readonly qualifications: MeetingQualificationReader,
    private readonly contacts: MeetingContactReader,
    private readonly suppressions: MeetingSuppressionReader,
    private readonly calendar: MeetingCalendarProvider,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, MeetingError> {
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(meetingError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (typeof userId !== "string" || userId === "") {
      return err(meetingError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * Propose one meeting from a positive response.
   *
   * Reads `classificationId` and the booking's own metadata from the caller, and
   * **nothing else**: the account, the contact, the qualification and the
   * recommendation reason are all derived here from stored rows. A caller cannot
   * name an account a response does not belong to, cannot attach a meeting to a
   * different contact, and cannot assert that an account qualified.
   *
   * The result is always `recommended`. This is a proposal: nothing is scheduled,
   * nothing is sent, and no calendar has been contacted.
   */
  recommendMeeting(
    workspaceId: EntityId,
    userId: EntityId,
    input: RecommendMeetingInput,
  ): Result<MeetingResult, MeetingError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    if (typeof input.classificationId !== "string" || input.classificationId.trim() === "") {
      return err(
        meetingError("VALIDATION_ERROR", "classificationId is required", [
          { field: "classificationId", message: "classificationId must be a string" },
        ]),
      );
    }

    const classification = this.classifications.positiveClassification(
      input.classificationId,
      userId,
    );
    if (classification === null) {
      return err(
        meetingError("NOT_FOUND", "conversation classification not found", [
          {
            field: "classificationId",
            message: "a meeting must come from a response recorded in this workspace",
          },
        ]),
      );
    }
    if (classification.workspaceId !== workspaceId) {
      return err(meetingError("UNAUTHORIZED", "workspace access denied"));
    }
    if (!isMeetableIntent(classification.intent)) {
      return err(
        meetingError("PREREQUISITE_NOT_MET", "this response does not ask for a meeting", [
          {
            field: "classificationId",
            message: "only a response read as positive_intent or interested can become a meeting",
          },
        ]),
      );
    }
    if (classification.suppressed) {
      return err(
        meetingError("SUPPRESSED", "this address asked to stop being contacted", [
          { field: "classificationId", message: "an opt-out cannot become a meeting" },
        ]),
      );
    }

    const qualification = this.qualifications.latestForAccount(
      workspaceId,
      classification.accountId,
      userId,
    );
    if (qualification === null) {
      return err(
        meetingError("PREREQUISITE_NOT_MET", "this account has no qualification", [
          { field: "accountId", message: "a meeting requires a Phase 8 qualification" },
        ]),
      );
    }
    if (qualification.state !== "qualified") {
      return err(
        meetingError("PREREQUISITE_NOT_MET", "this account did not qualify", [
          {
            field: "accountId",
            message: `the account's qualification is ${qualification.state}, not qualified`,
          },
        ]),
      );
    }

    const contact = this.contacts.contact(classification.contactId, userId);
    if (contact === null) {
      return err(meetingError("NOT_FOUND", "contact not found"));
    }
    if (contact.email === null) {
      return err(
        meetingError("PREREQUISITE_NOT_MET", "this contact has no address", [
          { field: "contactId", message: "a meeting needs an address to invite" },
        ]),
      );
    }
    // The opt-out list is consulted before a proposal exists, so a suppressed
    // address is never even proposed — and it is consulted again at approval and
    // at booking, because a suppression can arrive in between.
    if (this.suppressions.isSuppressed(workspaceId, userId, contact.email)) {
      return err(
        meetingError("SUPPRESSED", "this address asked to stop being contacted", [
          { field: "contactId", message: "this address is on the suppression list" },
        ]),
      );
    }

    const issues = new MeetingIssues();

    const title = optionalText(input.title, LIMITS.title);
    if (title === null) {
      issues.add("title", `title must be a non-empty string of at most ${LIMITS.title} characters`);
    }

    const zone = optionalText(input.timezone, LIMITS.timezone);
    if (zone === null) {
      issues.add("timezone", "timezone must be a string when supplied");
    } else if (zone !== undefined && parseTimezone(zone) === null) {
      issues.add("timezone", "timezone must be an IANA timezone name, or UTC");
    }

    const startsAt = optionalText(input.startsAt, 64);
    if (startsAt === null || startsAt === undefined || instant(startsAt) === null) {
      issues.add("startsAt", "startsAt must be an ISO-8601 instant");
    }

    const endsAt = optionalText(input.endsAt, 64);
    if (endsAt === null || endsAt === undefined || instant(endsAt) === null) {
      issues.add("endsAt", "endsAt must be an ISO-8601 instant");
    }

    const duration = parseDuration(input.durationMinutes);
    if (duration === null) {
      issues.add(
        "durationMinutes",
        `durationMinutes must be a whole number of minutes between ${MIN_DURATION_MINUTES} and ${LIMITS.durationMinutes}`,
      );
    }

    // The end must be after the start. Checked here rather than left to the
    // schema so the caller learns why at the boundary.
    if (startsAt !== undefined && endsAt !== undefined && issues.length === 0) {
      const start = instant(startsAt);
      const end = instant(endsAt);
      if (start !== null && end !== null && end <= start) {
        issues.add("endsAt", "endsAt must be after startsAt");
      }
    }

    if (issues.length > 0) {
      return err(
        meetingError("VALIDATION_ERROR", "the meeting could not be proposed", issues.all()),
      );
    }

    const normalizedStart = instant(startsAt ?? "") as string;
    const normalizedEnd = instant(endsAt ?? "") as string;
    const resolvedTimezone = zone === undefined ? "UTC" : (parseTimezone(zone) ?? "UTC");
    const resolvedTitle = title ?? `Meeting with ${contact.fullName}`;

    const reason = RECOMMENDATION_BY_INTENT[classification.intent];
    if (reason === null || reason === undefined) {
      return err(
        meetingError("PREREQUISITE_NOT_MET", "this response does not ask for a meeting", [
          { field: "classificationId", message: "no recommendation applies to this intent" },
        ]),
      );
    }

    const digest = bookingDigest({
      classificationId: classification.id,
      contactId: contact.id,
      title: resolvedTitle,
      startsAt: normalizedStart,
      endsAt: normalizedEnd,
      timezone: resolvedTimezone,
      durationMinutes: duration ?? 0,
    });

    const created = this.repo.createMeeting({
      workspaceId,
      createdBy: userId,
      meeting: {
        accountId: classification.accountId,
        contactId: contact.id,
        classificationId: classification.id,
        inboundMessageId: classification.inboundMessageId,
        outboundActionId: classification.outboundActionId,
        qualificationId: qualification.id,
        // Always `recommended`. There is no input that can propose a meeting as
        // anything else.
        state: "recommended",
        recommendationReason: reason,
        policyVersion: MEETING_POLICY_VERSION,
        bookingDigest: digest,
        title: resolvedTitle,
        startsAt: normalizedStart,
        endsAt: normalizedEnd,
        timezone: resolvedTimezone,
        durationMinutes: duration ?? 0,
        channel: this.calendar.channel,
        suppressionCheckedAt: this.clock().toISOString(),
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "the meeting could not be saved"));

    const events = this.record(workspaceId, userId, created.value, [
      {
        kind: "recommended",
        detail: `${reason} from a ${classification.intent} response; nothing is scheduled yet`,
      },
    ]);

    return ok({ meeting: created.value, events });
  }

  /**
   * Record a person's decision about a proposed booking.
   *
   * This is the Level 2 authorization §17 requires. The identity and the instant
   * both come from the server-side session, never from the request body, and the
   * decision is checked against the *current* state before it is written — so a
   * stale tab cannot approve a meeting that has since been cancelled.
   *
   * A decline and a cancellation both require a reason. Neither is a silent
   * outcome: "no, and here is why" is the only thing an audit trail can use.
   */
  decideMeeting(
    workspaceId: EntityId,
    userId: EntityId,
    meetingId: unknown,
    decision: unknown,
    reason?: unknown,
  ): Result<MeetingResult, MeetingError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const meeting = this.resolve(meetingId, userId);
    if (!meeting.ok) return meeting;
    const current = meeting.value;

    if (!isMeetingDecision(decision)) {
      return err(
        meetingError("VALIDATION_ERROR", "invalid meeting decision", [
          { field: "decision", message: "decision must be one of: approve, decline, cancel" },
        ]),
      );
    }

    const explained = text(reason, LIMITS.reason);

    // An approval must be reachable and must move the meeting forward. A decline
    // withdraws a proposal that nobody took up; a cancellation withdraws one that
    // was on its way to a calendar.
    const target: Record<MeetingDecision, Meeting["state"]> = {
      approve: "approved",
      decline: "cancelled",
      cancel: "cancelled",
    };
    const next = target[decision];

    // An approval from a fresh proposal walks `awaiting_approval` on the way, so
    // the audit trail shows the request and the answer rather than jumping
    // straight to a yes. The state machine forbids `recommended → approved` as a
    // bare move; this is a person's decision passing through it, recorded as both
    // steps, in one authenticated call.
    const needsAuthorizationStep = decision === "approve" && current.state === "recommended";
    const requestedEvents: MeetingEvent[] = [];
    if (needsAuthorizationStep) {
      const requested = this.repo.updateMeetingState({
        meetingId: current.id,
        actorUserId: userId,
        state: "awaiting_approval",
      });
      if (!requested.ok) {
        return err(fromStorage(requested.error.code, "the decision could not be recorded"));
      }
      requestedEvents.push(
        ...this.record(workspaceId, userId, requested.value, [
          { kind: "approval_requested", detail: `presented to ${userId} for authorization` },
        ]),
      );
    }

    if (!canTransition(needsAuthorizationStep ? "awaiting_approval" : current.state, next)) {
      if (TERMINAL_STATES.includes(current.state)) {
        return err(
          meetingError("INVALID_TRANSITION", `a ${current.state} meeting is final`, [
            { field: "state", message: "this meeting can no longer be changed" },
          ]),
        );
      }
      return err(
        meetingError("INVALID_TRANSITION", `a ${current.state} meeting cannot become ${next}`, [
          {
            field: "state",
            message: `legal moves: ${MEETING_TRANSITIONS.get(current.state)?.join(", ") ?? "none"}`,
          },
        ]),
      );
    }

    if ((decision === "decline" || decision === "cancel") && explained === null) {
      return err(
        meetingError("VALIDATION_ERROR", "a decision must say why", [
          { field: "reason", message: "reason is required to decline or cancel a meeting" },
        ]),
      );
    }

    // Only an approval touches the external world, so only an approval needs the
    // suppression list re-checked — and it needs it re-checked *here*, at the
    // moment of consent, because an opt-out may have arrived since the proposal.
    if (decision === "approve") {
      const contact = this.contacts.contact(current.contactId, userId);
      if (contact === null) return err(meetingError("NOT_FOUND", "contact not found"));
      if (contact.email === null) {
        return err(meetingError("PREREQUISITE_NOT_MET", "this contact has no address"));
      }
      if (this.suppressions.isSuppressed(workspaceId, userId, contact.email)) {
        return err(
          meetingError("SUPPRESSED", "this address asked to stop being contacted", [
            { field: "contactId", message: "an opt-out cannot be booked into a meeting" },
          ]),
        );
      }
      // The digest is re-derived from the row as it stands now. If anything about
      // the booking changed since the reviewer saw it, the approval no longer
      // refers to what is on the table and is refused rather than reinterpreted.
      const currentDigest = bookingDigest({
        classificationId: current.classificationId,
        contactId: current.contactId,
        title: current.title,
        startsAt: current.startsAt,
        endsAt: current.endsAt,
        timezone: current.timezone,
        durationMinutes: current.durationMinutes,
      });
      if (currentDigest !== current.bookingDigest) {
        return err(
          meetingError("CONFLICT", "this booking changed after it was proposed", [
            { field: "bookingDigest", message: "review the current booking before approving it" },
          ]),
        );
      }
    }

    const now = this.clock().toISOString();
    const updated = this.repo.updateMeetingState({
      meetingId: current.id,
      actorUserId: userId,
      state: next,
      approvedBy: decision === "approve" ? userId : (current.approvedBy ?? null),
      approvedAt: decision === "approve" ? now : (current.approvedAt ?? null),
      cancelledAt: next === "cancelled" ? now : null,
      suppressionCheckedAt: decision === "approve" ? now : (current.suppressionCheckedAt ?? null),
      decisionReason: explained ?? current.decisionReason ?? null,
    });
    if (!updated.ok)
      return err(fromStorage(updated.error.code, "the decision could not be recorded"));

    const events = [
      ...requestedEvents,
      ...this.record(workspaceId, userId, updated.value, [
        decision === "approve"
          ? {
              kind: "approved",
              detail: `approved by ${userId} against digest ${current.bookingDigest}`,
            }
          : { kind: "declined", detail: explained },
      ]),
    ];

    return ok({ meeting: updated.value, events });
  }

  /**
   * Book an approved meeting through the calendar adapter.
   *
   * Only an `approved` meeting may be booked, and the approval is re-checked
   * against stored rows here — the same re-derivation Phase 11 performs before
   * every send, rather than trusting the state this service last wrote.
   *
   * `booked` is written from exactly one place: on a provider confirmation. A
   * refusal, a thrown call or a malformed answer is recorded as a booking failure
   * and leaves the meeting where a retry is legal.
   */
  async bookMeeting(
    workspaceId: EntityId,
    userId: EntityId,
    meetingId: unknown,
  ): Promise<Result<MeetingResult, MeetingError>> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const meeting = this.resolve(meetingId, userId);
    if (!meeting.ok) return meeting;
    const current = meeting.value;

    if (current.state === "booked") {
      return err(
        meetingError("CONFLICT", "this meeting is already booked", [
          { field: "state", message: "a booked meeting is not booked twice" },
        ]),
      );
    }
    if (!canTransition(current.state, "booked")) {
      return err(
        meetingError("INVALID_TRANSITION", `a ${current.state} meeting cannot be booked`, [
          {
            field: "state",
            message: "a meeting must be approved by a person before it reaches a calendar",
          },
        ]),
      );
    }

    // Re-derive the approval from the stored row, not from the state this service
    // last wrote: a meeting with no approval instant has nothing behind it.
    if (current.approvedAt === null || current.approvedBy === null) {
      return err(
        meetingError("PREREQUISITE_NOT_MET", "this meeting has no approval", [
          { field: "approvedAt", message: "an approval is required before booking" },
        ]),
      );
    }

    const contact = this.contacts.contact(current.contactId, userId);
    if (contact === null) return err(meetingError("NOT_FOUND", "contact not found"));
    if (contact.email === null) {
      return err(meetingError("PREREQUISITE_NOT_MET", "this contact has no address"));
    }
    // Re-checked at booking, not only at approval: an opt-out that arrived in the
    // gap between the two must still stop the event from being created.
    if (this.suppressions.isSuppressed(workspaceId, userId, contact.email)) {
      return err(
        meetingError("SUPPRESSED", "this address asked to stop being contacted", [
          { field: "contactId", message: "an opt-out cannot be booked into a meeting" },
        ]),
      );
    }

    // One approval yields at most one event. The key is derived server-side from
    // the meeting itself, so a retry of the same booking is recognisably the same
    // booking and the provider can answer from its own record.
    const idempotencyKey = `meeting-${current.id}`;

    let response;
    try {
      response = await this.calendar.createEvent({
        idempotencyKey,
        title: current.title,
        startsAt: current.startsAt,
        endsAt: current.endsAt,
        timezone: current.timezone,
        attendeeEmail: contact.email,
        attendeeName: contact.fullName,
        description: `Proposed because of a positive response. ${current.recommendationReason.replace(/_/g, " ")}.`,
      });
    } catch {
      // A thrown call is a failure, never a booking. Recording it as anything
      // else would let a bug in an adapter report a meeting that does not exist.
      const failed = this.repo.updateMeetingState({
        meetingId: current.id,
        actorUserId: userId,
        state: "approved",
        suppressionCheckedAt: this.clock().toISOString(),
        decisionReason: current.decisionReason ?? null,
      });
      if (!failed.ok)
        return err(fromStorage(failed.error.code, "the booking could not be recorded"));
      const events = this.record(workspaceId, userId, failed.value, [
        { kind: "booking_attempted", detail: "the calendar provider threw" },
        { kind: "booking_failed", detail: "the calendar provider threw" },
      ]);
      return ok({ meeting: failed.value, events });
    }

    if (!response.ok || response.externalEventId === null) {
      const failed = this.repo.updateMeetingState({
        meetingId: current.id,
        actorUserId: userId,
        state: "approved",
        suppressionCheckedAt: this.clock().toISOString(),
        decisionReason: current.decisionReason ?? null,
      });
      if (!failed.ok)
        return err(fromStorage(failed.error.code, "the booking could not be recorded"));
      const events = this.record(workspaceId, userId, failed.value, [
        { kind: "booking_attempted", detail: response.failureCode ?? "refused" },
        { kind: "booking_failed", detail: response.message ?? "the provider refused the booking" },
      ]);
      return ok({ meeting: failed.value, events });
    }

    const now = this.clock().toISOString();
    const booked = this.repo.updateMeetingState({
      meetingId: current.id,
      actorUserId: userId,
      state: "booked",
      bookedAt: now,
      externalEventId: response.externalEventId,
      suppressionCheckedAt: now,
      decisionReason: current.decisionReason ?? null,
    });
    if (!booked.ok) return err(fromStorage(booked.error.code, "the booking could not be recorded"));

    const events = this.record(workspaceId, userId, booked.value, [
      { kind: "booking_attempted", detail: idempotencyKey },
      {
        kind: "booked",
        detail: `the ${this.calendar.channel} provider recorded ${response.externalEventId}`,
      },
    ]);

    return ok({ meeting: booked.value, events });
  }

  /**
   * Produce the preparation brief for a meeting.
   *
   * Versioned rather than replaced: a person may have read a brief before the
   * meeting, and rewriting it in place would leave them acting on text that no
   * longer exists. Regenerating inserts the next version.
   *
   * The brief quotes the response verbatim and references the claims and evidence
   * it rests on, but it **adds no new claim about the account**. Anything §22
   * lists that the workspace has no record of is written into `gaps` instead.
   */
  prepareBrief(
    workspaceId: EntityId,
    userId: EntityId,
    meetingId: unknown,
  ): Result<{ meeting: Meeting; brief: MeetingBrief }, MeetingError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const meeting = this.resolve(meetingId, userId);
    if (!meeting.ok) return meeting;
    const current = meeting.value;

    const classification = this.classifications.positiveClassification(
      current.classificationId,
      userId,
    );
    if (classification === null) {
      return err(meetingError("NOT_FOUND", "conversation classification not found"));
    }
    const qualification = this.qualifications.latestForAccount(
      workspaceId,
      current.accountId,
      userId,
    );
    if (qualification === null) {
      return err(meetingError("NOT_FOUND", "qualification not found"));
    }
    const contact = this.contacts.contact(current.contactId, userId);
    if (contact === null) return err(meetingError("NOT_FOUND", "contact not found"));

    const input: MeetingBriefInput = {
      meetingId: current.id,
      accountId: current.accountId,
      contactId: current.contactId,
      qualificationId: qualification.id,
      qualificationScore: qualification.score,
      qualificationState: qualification.state,
      classificationId: classification.id,
      intent: classification.intent,
      conversationExcerpt: classification.body,
      claimIds: [],
      evidenceIds: [],
      contactName: contact.fullName,
      contactJobTitle: contact.jobTitle,
      accountName: "",
      recommendationReason: current.recommendationReason,
    };

    const draft = renderMeetingBrief(input);

    const written = this.repo.createMeetingBrief({
      workspaceId,
      createdBy: userId,
      brief: {
        meetingId: current.id,
        rendererVersion: draft.rendererVersion,
        accountId: draft.accountId,
        contactId: draft.contactId,
        qualificationId: draft.qualificationId,
        qualificationScore: draft.qualificationScore,
        classificationId: draft.classificationId,
        intent: draft.intent,
        claimIds: draft.claimIds,
        evidenceIds: draft.evidenceIds,
        conversationExcerpt: draft.conversationExcerpt,
        gaps: draft.gaps,
      },
    });
    if (!written.ok) return err(fromStorage(written.error.code, "the brief could not be saved"));

    this.record(workspaceId, userId, current, [
      {
        kind: "brief_generated",
        detail: `${draft.rendererVersion} version ${written.value.version}`,
      },
    ]);

    return ok({ meeting: current, brief: written.value });
  }

  /** One meeting, authorized against the caller's own workspace. */
  getMeeting(id: EntityId, userId: EntityId): Result<Meeting, MeetingError> {
    if (typeof id !== "string" || id.trim() === "") {
      return err(meetingError("VALIDATION_ERROR", "meeting id is required"));
    }
    const found = this.repo.getMeeting(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "meeting not found"));
    return ok(found.value);
  }

  /** A workspace's meetings, newest first, optionally narrowed. */
  listMeetings(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { state?: unknown; accountId?: unknown; contactId?: unknown },
  ): Result<Meeting[], MeetingError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.state !== undefined && filter.state !== null && filter.state !== "") {
      if (!isMeetingState(filter.state)) {
        return err(
          meetingError("VALIDATION_ERROR", "invalid state filter", [
            { field: "state", message: "state must be one of the closed booking vocabulary" },
          ]),
        );
      }
    }
    const narrowed: {
      state?: Meeting["state"];
      accountId?: EntityId;
      contactId?: EntityId;
    } = {};
    const requestedState = filter === undefined ? undefined : filter.state;
    if (isMeetingState(requestedState)) narrowed.state = requestedState;
    const accountId = filter === undefined ? undefined : filter.accountId;
    if (typeof accountId === "string" && accountId !== "") narrowed.accountId = accountId;
    const contactId = filter === undefined ? undefined : filter.contactId;
    if (typeof contactId === "string" && contactId !== "") narrowed.contactId = contactId;
    const listed = this.repo.listMeetings(
      workspaceId,
      userId,
      Object.keys(narrowed).length > 0 ? narrowed : undefined,
    );
    if (!listed.ok) return err(fromStorage(listed.error.code, "meetings unavailable"));
    return ok(listed.value);
  }

  /** One meeting's audit trail, oldest first. */
  meetingHistory(id: EntityId, userId: EntityId): Result<MeetingEvent[], MeetingError> {
    const meeting = this.getMeeting(id, userId);
    if (!meeting.ok) return meeting;
    const events = this.repo.listMeetingEvents(id, userId);
    if (!events.ok) return err(fromStorage(events.error.code, "meeting events unavailable"));
    return ok(events.value);
  }

  /** One meeting's briefs, newest first. */
  listBriefs(id: EntityId, userId: EntityId): Result<MeetingBrief[], MeetingError> {
    const meeting = this.getMeeting(id, userId);
    if (!meeting.ok) return meeting;
    const briefs = this.repo.listMeetingBriefs(id, userId);
    if (!briefs.ok) return err(fromStorage(briefs.error.code, "meeting briefs unavailable"));
    return ok(briefs.value);
  }

  /** Every rule version this deployment books under. */
  static policyVersion(): string {
    return MEETING_POLICY_VERSION;
  }

  static briefRendererVersion(): string {
    return MEETING_BRIEF_RENDERER_VERSION;
  }

  /** The policy this deployment enforces, before any meeting exists. */
  policy(workspaceId: EntityId, userId: EntityId): Result<MeetingPolicyView, MeetingError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeMeetingPolicy());
  }

  /**
   * Resolve a meeting id for reading.
   *
   * A foreign meeting is reported as not found, not as unauthorized, so an id
   * from another workspace is indistinguishable from one that never existed.
   */
  private resolve(id: unknown, userId: EntityId): Result<Meeting, MeetingError> {
    if (typeof id !== "string" || id.trim() === "") {
      return err(meetingError("VALIDATION_ERROR", "meeting id is required"));
    }
    const found = this.repo.getMeeting(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "meeting not found"));
    return ok(found.value);
  }

  /**
   * Write the audit rows for one step.
   *
   * A booking that reached someone's calendar has to be explainable: which
   * response proposed it, who authorized it, and whether a provider confirmed it.
   * A failed audit write is deliberately swallowed here — the state change has
   * already happened and is the fact; losing an audit row must not make a real
   * booking look like it failed.
   */
  private record(
    workspaceId: EntityId,
    actorUserId: EntityId,
    meeting: Meeting,
    events: { kind: MeetingEvent["kind"]; detail: string | null }[],
  ): MeetingEvent[] {
    const written: MeetingEvent[] = [];
    for (const event of events) {
      const result = this.repo.createMeetingEvent({
        workspaceId,
        actorUserId,
        event: { meetingId: meeting.id, kind: event.kind, detail: event.detail },
      });
      if (result.ok) written.push(result.value);
    }
    return written;
  }
}
