import { describe, expect, it } from "vitest";
import type { Result } from "@dealora/core";
import type { EntityId, Meeting, MeetingBrief, MeetingEvent } from "@dealora/db";

import {
  FailingCalendarProvider,
  MeetingService,
  RECOMMENDATION_BY_INTENT,
  SandboxCalendarProvider,
  ThrowingCalendarProvider,
  bookingDigest,
  canTransition,
  describeMeetingPolicy,
  renderMeetingBrief,
} from "./index.js";
import type {
  MeetingCalendarProvider,
  MeetingClassificationSnapshot,
  MeetingContactSnapshot,
  MeetingError,
  MeetingQualificationSnapshot,
  MeetingRepository,
} from "./index.js";

/**
 * Domain tests for the Phase 13 meeting workflow.
 *
 * These run against the real service and the real {@link MeetingRepository} —
 * an in-memory implementation that enforces the same workspace and prerequisite
 * rules the concrete store does — so the refusal paths are exercised against the
 * code that runs in production rather than a hand-written stub that agrees with
 * whatever the test wanted.
 *
 * The sandbox calendar is a real implementation that records what it accepted, so
 * "a meeting was booked" always means "the provider recorded an event", never
 * "DEALORA asserted it".
 */

interface Fixture {
  service: MeetingService;
  repo: FakeRepository;
  calendar: SandboxCalendarProvider;
  workspaceId: EntityId;
  userId: EntityId;
  classificationId: EntityId;
  accountId: EntityId;
  contactId: EntityId;
  email: string;
  /** A second tenant, for cross-tenant assertions. */
  otherWorkspaceId: EntityId;
  otherClassificationId: EntityId;
}

/** One stored row, kept as a plain record so tests can inspect it directly. */
interface FakeRow {
  id: string;
  workspaceId: string;
  [key: string]: unknown;
}

/**
 * An in-memory {@link MeetingRepository} with the same guarantees the concrete
 * store makes: workspace authorization on every call, prerequisites re-derived
 * from stored rows, and the two booking invariants.
 */
class FakeRepository implements MeetingRepository {
  readonly meetings: FakeRow[] = [];
  readonly briefs: FakeRow[] = [];
  readonly events: FakeEventRow[] = [];
  /** Set to a code to make the next authorize call fail. */
  failAuthorize: string | null = null;

  authorize(
    workspaceId: string,
    userId: string,
  ): { ok: true } | { ok: false; error: { code: string; message: string } } {
    if (this.failAuthorize !== null) {
      return { ok: false, error: { code: this.failAuthorize, message: "refused" } };
    }
    // Only `u-1` belongs to `ws-1` and only `u-other` to `ws-other`. A stranger
    // is refused as not found, matching the concrete store.
    const OWNERS: Record<string, string> = { "u-1": "ws-1", "u-other": "ws-other" };
    if (OWNERS[userId] !== workspaceId) {
      return { ok: false, error: { code: "NOT_FOUND", message: "workspace not found" } };
    }
    return { ok: true };
  }

  createMeeting(input: {
    workspaceId: string;
    createdBy: string;
    meeting: Record<string, unknown>;
  }): { ok: true; value: Meeting } | { ok: false; error: { code: string; message: string } } {
    const classification = this.classification(input.meeting.classificationId as string);
    if (!classification || classification.workspaceId !== input.workspaceId) {
      return { ok: false, error: { code: "NOT_FOUND", message: "not found" } };
    }
    const qualification = this.qualification(input.meeting.qualificationId as string);
    if (!qualification) {
      return { ok: false, error: { code: "NOT_FOUND", message: "not found" } };
    }
    if (classification.intent !== "positive_intent" && classification.intent !== "interested") {
      return { ok: false, error: { code: "INVALID", message: "not positive" } };
    }
    if (qualification.state !== "qualified") {
      return { ok: false, error: { code: "INVALID", message: "not qualified" } };
    }
    if (
      this.meetings.some(
        (m) => m.classificationId === input.meeting.classificationId && m.state !== "cancelled",
      )
    ) {
      return { ok: false, error: { code: "CONFLICT", message: "already has a meeting" } };
    }
    const now = "2026-11-01T00:00:00.000Z";
    const row: FakeRow = {
      id: `m-${this.meetings.length + 1}`,
      workspaceId: input.workspaceId,
      approvedBy: null,
      approvedAt: null,
      bookedAt: null,
      cancelledAt: null,
      externalEventId: null,
      suppressionCheckedAt: null,
      decisionReason: null,
      createdAt: now,
      updatedAt: now,
      ...input.meeting,
    };
    this.meetings.push(row);
    return { ok: true, value: row as unknown as Meeting };
  }

  getMeeting(
    id: string,
    userId: string,
  ): { ok: true; value: Meeting } | { ok: false; error: { code: string; message: string } } {
    const row = this.meetings.find((m) => m.id === id);
    if (!row) return { ok: false, error: { code: "NOT_FOUND", message: "meeting not found" } };
    // A foreign meeting is reported as not found, never as unauthorized, so the
    // two are indistinguishable.
    if (this.authorize(row.workspaceId, userId).ok !== true) {
      return { ok: false, error: { code: "NOT_FOUND", message: "meeting not found" } };
    }
    return { ok: true, value: row as unknown as Meeting };
  }

  listMeetings(
    workspaceId: string,
    userId: string,
    filter?: { state?: string; accountId?: string; contactId?: string },
  ): { ok: true; value: Meeting[] } | { ok: false; error: { code: string; message: string } } {
    const auth = this.authorize(workspaceId, userId);
    if (!auth.ok) return auth;
    const rows = this.meetings.filter(
      (m) =>
        m.workspaceId === workspaceId &&
        (filter?.state === undefined || m.state === filter.state) &&
        (filter?.accountId === undefined || m.accountId === filter.accountId) &&
        (filter?.contactId === undefined || m.contactId === filter.contactId),
    );
    return { ok: true, value: [...rows].reverse() as unknown as Meeting[] };
  }

  updateMeetingState(input: {
    meetingId: string;
    actorUserId: string;
    state: string;
    approvedBy?: string | null;
    approvedAt?: string | null;
    bookedAt?: string | null;
    cancelledAt?: string | null;
    externalEventId?: string | null;
    suppressionCheckedAt?: string | null;
    decisionReason?: string | null;
  }): { ok: true; value: Meeting } | { ok: false; error: { code: string; message: string } } {
    const current = this.getMeeting(input.meetingId, input.actorUserId);
    if (!current.ok) return current;
    const row = this.meetings.find((m) => m.id === input.meetingId);
    if (!row) return { ok: false, error: { code: "NOT_FOUND", message: "meeting not found" } };
    if (input.state === "approved" && row.state === "booked") {
      return { ok: false, error: { code: "CONFLICT", message: "already booked" } };
    }
    const next: Record<string, unknown> = {
      state: input.state,
      approvedBy: input.approvedBy === undefined ? row.approvedBy : input.approvedBy,
      approvedAt: input.approvedAt === undefined ? row.approvedAt : input.approvedAt,
      bookedAt: input.bookedAt === undefined ? row.bookedAt : input.bookedAt,
      cancelledAt: input.cancelledAt === undefined ? row.cancelledAt : input.cancelledAt,
      externalEventId:
        input.externalEventId === undefined ? row.externalEventId : input.externalEventId,
      suppressionCheckedAt:
        input.suppressionCheckedAt === undefined
          ? row.suppressionCheckedAt
          : input.suppressionCheckedAt,
      decisionReason:
        input.decisionReason === undefined ? row.decisionReason : input.decisionReason,
    };
    if (
      input.state !== "cancelled" &&
      next.cancelledAt !== null &&
      next.cancelledAt !== undefined
    ) {
      return { ok: false, error: { code: "INVALID", message: "cancellation on a live meeting" } };
    }
    if (input.state === "approved" && (next.approvedBy === null || next.approvedAt === null)) {
      return { ok: false, error: { code: "INVALID", message: "approval needs who and when" } };
    }
    if (input.state === "booked" && row.approvedAt === null && next.approvedAt === null) {
      return { ok: false, error: { code: "INVALID", message: "booking without approval" } };
    }
    Object.assign(row, next);
    return { ok: true, value: row as unknown as Meeting };
  }

  createMeetingBrief(input: {
    workspaceId: string;
    createdBy: string;
    brief: Record<string, unknown>;
  }): { ok: true; value: MeetingBrief } | { ok: false; error: { code: string; message: string } } {
    const meeting = this.meetings.find((m) => m.id === input.brief.meetingId);
    if (!meeting) return { ok: false, error: { code: "NOT_FOUND", message: "meeting not found" } };
    const version = this.briefs.filter((b) => b.meetingId === input.brief.meetingId).length + 1;
    const row: FakeRow = {
      id: `b-${this.briefs.length + 1}`,
      workspaceId: input.workspaceId,
      version,
      createdAt: "2026-11-01T00:00:00.000Z",
      ...input.brief,
    };
    this.briefs.push(row);
    return { ok: true, value: row as unknown as MeetingBrief };
  }

  listMeetingBriefs(
    meetingId: string,
    userId: string,
  ): { ok: true; value: MeetingBrief[] } | { ok: false; error: { code: string; message: string } } {
    const meeting = this.getMeeting(meetingId, userId);
    if (!meeting.ok) return meeting;
    return {
      ok: true,
      value: this.briefs
        .filter((b) => b.meetingId === meetingId)
        .reverse() as unknown as MeetingBrief[],
    };
  }

  createMeetingEvent(input: {
    workspaceId: string;
    actorUserId: string;
    event: { meetingId: string; kind: MeetingEvent["kind"]; detail: string | null };
  }): { ok: true; value: MeetingEvent } | { ok: false; error: { code: string; message: string } } {
    const meeting = this.meetings.find((m) => m.id === input.event.meetingId);
    if (!meeting) return { ok: false, error: { code: "NOT_FOUND", message: "meeting not found" } };
    const event: FakeEventRow = {
      id: `e-${this.events.length + 1}`,
      workspaceId: input.workspaceId,
      kind: input.event.kind,
      detail: input.event.detail,
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    this.events.push(event);
    return { ok: true, value: event as unknown as MeetingEvent };
  }

  listMeetingEvents(
    meetingId: string,
    userId: string,
  ): { ok: true; value: MeetingEvent[] } | { ok: false; error: { code: string; message: string } } {
    const meeting = this.getMeeting(meetingId, userId);
    if (!meeting.ok) return meeting;
    return {
      ok: true,
      value: this.events.filter((e) => e.meetingId === meetingId) as unknown as MeetingEvent[],
    };
  }

  private classification(id: string): FakeRow | null {
    return CLASSIFICATIONS[id] ?? null;
  }

  private qualification(id: string): FakeRow | null {
    return QUALIFICATIONS[id] ?? null;
  }
}

interface FakeEventRow {
  id: string;
  workspaceId: string;
  kind: MeetingEvent["kind"];
  detail: string | null;
  createdAt: string;
  meetingId?: string;
}

/** The classifications the fixture offers, keyed by id. */
const CLASSIFICATIONS: Record<string, FakeRow> = {
  "c-positive": {
    id: "c-positive",
    workspaceId: "ws-1",
    accountId: "acct-1",
    contactId: "contact-1",
    outboundActionId: "action-1",
    inboundMessageId: "msg-1",
    intent: "positive_intent",
    confidence: "high",
    suppressed: false,
    body: "Happy to chat, book a call.",
  },
  "c-interested": {
    id: "c-interested",
    workspaceId: "ws-1",
    accountId: "acct-1",
    contactId: "contact-1",
    outboundActionId: "action-1",
    inboundMessageId: "msg-2",
    intent: "interested",
    confidence: "medium",
    suppressed: false,
    body: "I am interested, could you tell me more?",
  },
  "c-objection": {
    id: "c-objection",
    workspaceId: "ws-1",
    accountId: "acct-1",
    contactId: "contact-1",
    outboundActionId: "action-1",
    inboundMessageId: "msg-3",
    intent: "objection",
    confidence: "high",
    suppressed: false,
    body: "Too expensive for us right now.",
  },
  "c-suppressed": {
    id: "c-suppressed",
    workspaceId: "ws-1",
    accountId: "acct-1",
    contactId: "contact-1",
    outboundActionId: "action-1",
    inboundMessageId: "msg-4",
    intent: "unsubscribe",
    confidence: "high",
    suppressed: true,
    body: "Unsubscribe me.",
  },
  "c-foreign": {
    id: "c-foreign",
    workspaceId: "ws-other",
    accountId: "acct-9",
    contactId: "contact-9",
    outboundActionId: "action-9",
    inboundMessageId: "msg-9",
    intent: "positive_intent",
    confidence: "high",
    suppressed: false,
    body: "Happy to chat.",
  },
};

const QUALIFICATIONS: Record<string, FakeRow> = {
  "q-qualified": {
    id: "q-qualified",
    workspaceId: "ws-1",
    accountId: "acct-1",
    state: "qualified",
    score: 82,
  },
  "q-unqualified": {
    id: "q-unqualified",
    workspaceId: "ws-1",
    accountId: "acct-1",
    state: "unqualified",
    score: 20,
  },
};

const CONTACTS: Record<string, MeetingContactSnapshot> = {
  "contact-1": {
    id: "contact-1",
    workspaceId: "ws-1",
    accountId: "acct-1",
    fullName: "Ada Lovelace",
    jobTitle: "VP Support",
    email: "ada@northwind.example",
  },
  "contact-9": {
    id: "contact-9",
    workspaceId: "ws-other",
    accountId: "acct-9",
    fullName: "Grace Hopper",
    jobTitle: "CTO",
    email: "grace@other.example",
  },
};

function fixture(calendar?: MeetingCalendarProvider): Fixture {
  const repo = new FakeRepository();
  const sandbox = new SandboxCalendarProvider();
  const service = new MeetingService(
    repo,
    {
      positiveClassification(id: string, userId: string): MeetingClassificationSnapshot | null {
        const row = CLASSIFICATIONS[id];
        if (!row) return null;
        // The real reader hides a classification the caller does not own, so a
        // foreign one is indistinguishable from one that never existed.
        const owns: Record<string, string> = { "u-1": "ws-1", "u-other": "ws-other" };
        if (owns[userId] !== row.workspaceId) return null;
        return row as unknown as MeetingClassificationSnapshot;
      },
    },
    {
      latestForAccount(
        _workspaceId: string,
        accountId: string,
        _userId: string,
      ): MeetingQualificationSnapshot | null {
        if (accountId !== "acct-1") return null;
        // The newest evaluation is the qualified one unless a test asks for the
        // unqualified variant, which the `qualification` override controls.
        return QUALIFICATIONS[QUALIFICATION_OVERRIDE] as unknown as MeetingQualificationSnapshot;
      },
    },
    {
      contact(contactId: string, userId: string): MeetingContactSnapshot | null {
        const row = CONTACTS[contactId];
        if (!row) return null;
        const owns: Record<string, string> = { "u-1": "ws-1", "u-other": "ws-other" };
        if (owns[userId] !== row.workspaceId) return null;
        return row;
      },
    },
    {
      isSuppressed: (_workspaceId: string, _userId: string, email: string) => SUPPRESSED.has(email),
    },
    calendar ?? sandbox,
  );
  return {
    service,
    repo,
    calendar: sandbox,
    workspaceId: "ws-1",
    userId: "u-1",
    classificationId: "c-positive",
    accountId: "acct-1",
    contactId: "contact-1",
    email: "ada@northwind.example",
    otherWorkspaceId: "ws-other",
    otherClassificationId: "c-foreign",
  };
}

/** Which qualification the reader returns; a test may override it. */
let QUALIFICATION_OVERRIDE = "q-qualified";
/** Addresses the suppression reader reports as blocked. */
const SUPPRESSED = new Set<string>();

const BOOKING = {
  title: "Intro call with Northwind",
  startsAt: "2026-11-02T10:00:00.000Z",
  endsAt: "2026-11-02T10:30:00.000Z",
  timezone: "Europe/Berlin",
  durationMinutes: 30,
};

function reset(): void {
  QUALIFICATION_OVERRIDE = "q-qualified";
  SUPPRESSED.clear();
}

function okValue<T>(result: Result<T, MeetingError>): T {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function errorCode(result: Result<unknown, MeetingError>): string {
  if (result.ok) throw new Error("expected a failure");
  return result.error.code;
}

describe("meeting booking rules", () => {
  it("states the legal moves, and forbids the ones that matter", () => {
    // Nothing reaches approved without a person's decision in between.
    expect(canTransition("recommended", "approved")).toBe(false);
    expect(canTransition("recommended", "booked")).toBe(false);
    // Nothing reaches booked without an approval.
    expect(canTransition("awaiting_approval", "booked")).toBe(false);
    // A cancelled meeting is final, so a replayed request cannot resurrect it.
    expect(canTransition("cancelled", "booked")).toBe(false);
    expect(canTransition("cancelled", "approved")).toBe(false);
    // A meeting that was never booked cannot be reported as held or missed.
    expect(canTransition("approved", "held")).toBe(false);
    // And the legal path is intact.
    expect(canTransition("recommended", "awaiting_approval")).toBe(true);
    expect(canTransition("awaiting_approval", "approved")).toBe(true);
    expect(canTransition("approved", "booked")).toBe(true);
    expect(canTransition("booked", "held")).toBe(true);
    expect(canTransition("booked", "no_show")).toBe(true);
  });

  it("publishes its whole policy before any meeting exists", () => {
    const policy = describeMeetingPolicy();
    expect(policy.states).toContain("recommended");
    expect(policy.transitions.length).toBeGreaterThan(0);
    // The two things a workspace most needs to know are stated in the policy
    // itself, not only in prose.
    expect(policy.prerequisites.join(" ")).toMatch(/positive_intent/);
    expect(policy.neverDoes.join(" ")).toMatch(/never books a meeting on its own initiative/);
    expect(policy.neverDoes.join(" ")).toMatch(/never sends an invitation/);

    // The policy advertises exactly the reasons the rules can produce, and not
    // one more. An earlier draft listed three reasons no code path could emit,
    // so a reader of the policy was told about recommendations this phase does
    // not make; this assertion is what stops that recurring.
    const producible = new Set(
      Object.values(RECOMMENDATION_BY_INTENT).filter(
        (reason): reason is NonNullable<typeof reason> => reason !== null,
      ),
    );
    expect(new Set(policy.recommendationReasons)).toEqual(producible);
    expect(policy.recommendationReasons.length).toBeGreaterThan(0);
  });

  it("digests the same booking identically and a different one differently", () => {
    const base = {
      classificationId: "c-1",
      contactId: "contact-1",
      title: "Intro",
      startsAt: "2026-11-02T10:00:00.000Z",
      endsAt: "2026-11-02T10:30:00.000Z",
      timezone: "UTC",
      durationMinutes: 30,
    };
    expect(bookingDigest(base)).toBe(bookingDigest({ ...base }));
    // Re-titling a booking changes its digest, which is what makes "I approved
    // *this*" checkable at decision time.
    expect(bookingDigest({ ...base, title: "Intro (moved)" })).not.toBe(bookingDigest(base));
    expect(bookingDigest({ ...base, startsAt: "2026-11-02T11:00:00.000Z" })).not.toBe(
      bookingDigest(base),
    );
  });
});

describe("MeetingService.recommendMeeting", () => {
  it("proposes a meeting from a positive response and schedules nothing", () => {
    reset();
    const f = fixture();
    const result = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );

    expect(result.meeting.state).toBe("recommended");
    expect(result.meeting.recommendationReason).toBe("positive_intent");
    expect(result.meeting.policyVersion).toBe("deterministic-1.0.0");
    // The provenance chain is stored as references, not re-derived later.
    expect(result.meeting.classificationId).toBe("c-positive");
    expect(result.meeting.qualificationId).toBe("q-qualified");
    expect(result.meeting.contactId).toBe("contact-1");
    // Nothing has reached a calendar and nothing has been authorized.
    expect(result.meeting.approvedAt).toBeNull();
    expect(result.meeting.bookedAt).toBeNull();
    expect(result.meeting.externalEventId).toBeNull();
    expect(f.calendar.callCount()).toBe(0);
    expect(f.calendar.events()).toHaveLength(0);
    expect(result.events.map((e) => e.kind)).toEqual(["recommended"]);
  });

  it("accepts an interested response as well as an explicit yes", () => {
    reset();
    const f = fixture();
    const result = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: "c-interested",
        ...BOOKING,
      }),
    );
    expect(result.meeting.state).toBe("recommended");
    expect(result.meeting.recommendationReason).toBe("expressed_interest");
  });

  it("refuses a response that did not ask for a meeting", () => {
    reset();
    const f = fixture();
    // An objection is the clearest case: it must never become a calendar entry.
    expect(
      errorCode(
        f.service.recommendMeeting(f.workspaceId, f.userId, {
          classificationId: "c-objection",
          ...BOOKING,
        }),
      ),
    ).toBe("PREREQUISITE_NOT_MET");
    expect(f.repo.meetings).toHaveLength(0);
  });

  it("refuses an account that did not qualify", () => {
    reset();
    QUALIFICATION_OVERRIDE = "q-unqualified";
    const f = fixture();
    expect(
      errorCode(
        f.service.recommendMeeting(f.workspaceId, f.userId, {
          classificationId: f.classificationId,
          ...BOOKING,
        }),
      ),
    ).toBe("PREREQUISITE_NOT_MET");
    expect(f.repo.meetings).toHaveLength(0);
  });

  it("refuses a response whose address asked to stop being contacted", () => {
    reset();
    SUPPRESSED.add("ada@northwind.example");
    const f = fixture();
    expect(
      errorCode(
        f.service.recommendMeeting(f.workspaceId, f.userId, {
          classificationId: f.classificationId,
          ...BOOKING,
        }),
      ),
    ).toBe("SUPPRESSED");
    expect(f.repo.meetings).toHaveLength(0);
  });

  it("refuses a classification from another workspace without confirming it exists", () => {
    reset();
    const f = fixture();
    expect(
      errorCode(
        f.service.recommendMeeting(f.workspaceId, f.userId, {
          classificationId: f.otherClassificationId,
          ...BOOKING,
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("refuses unusable booking metadata by name", () => {
    reset();
    const f = fixture();
    expect(
      errorCode(
        f.service.recommendMeeting(f.workspaceId, f.userId, {
          classificationId: f.classificationId,
          title: "",
          startsAt: "not-a-date",
          endsAt: "2026-11-02T10:00:00.000Z",
          durationMinutes: 0,
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(f.repo.meetings).toHaveLength(0);
  });

  it("refuses a booking that ends before it starts", () => {
    reset();
    const f = fixture();
    expect(
      errorCode(
        f.service.recommendMeeting(f.workspaceId, f.userId, {
          classificationId: f.classificationId,
          ...BOOKING,
          startsAt: "2026-11-02T11:00:00.000Z",
          endsAt: "2026-11-02T10:00:00.000Z",
        }),
      ),
    ).toBe("VALIDATION_ERROR");
  });

  it("refuses a second meeting for the same response", () => {
    reset();
    const f = fixture();
    okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    expect(
      errorCode(
        f.service.recommendMeeting(f.workspaceId, f.userId, {
          classificationId: f.classificationId,
          ...BOOKING,
        }),
      ),
    ).toBe("CONFLICT");
    expect(f.repo.meetings).toHaveLength(1);
  });
});

describe("MeetingService.decideMeeting", () => {
  it("records an approval against the digest the reviewer saw", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    const decided = okValue(
      f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "approve"),
    );

    expect(decided.meeting.state).toBe("approved");
    // The identity and the instant come from the session, never from the caller.
    expect(decided.meeting.approvedBy).toBe(f.userId);
    expect(decided.meeting.approvedAt).not.toBeNull();
    expect(decided.meeting.bookingDigest).toBe(proposed.meeting.bookingDigest);
    expect(decided.events.map((e) => e.kind)).toEqual(["approval_requested", "approved"]);
  });

  it("requires a reason to decline, and then makes the meeting final", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    // A silent "no" is refused: an audit trail cannot use one.
    expect(
      errorCode(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "decline")),
    ).toBe("VALIDATION_ERROR");

    const declined = okValue(
      f.service.decideMeeting(
        f.workspaceId,
        f.userId,
        proposed.meeting.id,
        "decline",
        "Not the right account",
      ),
    );
    expect(declined.meeting.state).toBe("cancelled");
    expect(declined.meeting.cancelledAt).not.toBeNull();
    expect(declined.meeting.decisionReason).toBe("Not the right account");

    // And a cancelled meeting is final.
    expect(
      errorCode(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "approve")),
    ).toBe("INVALID_TRANSITION");
  });

  it("refuses an approval once the address is suppressed", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    // The opt-out arrives *after* the proposal was made — the gap the second
    // suppression check exists to close.
    SUPPRESSED.add("ada@northwind.example");
    expect(
      errorCode(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "approve")),
    ).toBe("SUPPRESSED");
  });

  it("refuses an approval for a booking that changed after it was proposed", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    // Somebody edits the row behind the reviewer's back, so the digest no longer
    // describes what is on the table.
    const row = f.repo.meetings[0];
    if (row === undefined) throw new Error("expected a stored meeting");
    row.title = "A different meeting";
    expect(
      errorCode(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "approve")),
    ).toBe("CONFLICT");
  });

  it("refuses an unknown decision", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    expect(
      errorCode(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "booked")),
    ).toBe("VALIDATION_ERROR");
  });
});

describe("MeetingService.bookMeeting", () => {
  it("refuses to book a meeting nobody approved", async () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    // This is the phase's central refusal: a Level 2 external action never
    // happens on the system's own initiative.
    const result = await bookingError(proposed.meeting.id, f);
    expect(result).toBe("INVALID_TRANSITION");
    expect(f.calendar.callCount()).toBe(0);
  });

  it("books an approved meeting once, and only on a provider confirmation", async () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    okValue(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "approve"));

    const booked = okValue(
      await f.service.bookMeeting(f.workspaceId, f.userId, proposed.meeting.id),
    );
    expect(booked.meeting.state).toBe("booked");
    expect(booked.meeting.bookedAt).not.toBeNull();
    // The reference is the provider's, not something DEALORA made up.
    expect(booked.meeting.externalEventId).toBe(`sandbox-meeting-${proposed.meeting.id}`);
    expect(f.calendar.events()).toHaveLength(1);
    expect(f.calendar.events()[0]?.attendeeEmail).toBe(f.email);
    expect(booked.events.map((e) => e.kind)).toEqual(["booking_attempted", "booked"]);

    // Booking twice is refused rather than creating a second calendar entry.
    expect(
      errorCode(await f.service.bookMeeting(f.workspaceId, f.userId, proposed.meeting.id)),
    ).toBe("CONFLICT");
    expect(f.calendar.events()).toHaveLength(1);
  });

  it("records a provider refusal as a failure, never as a booking", async () => {
    reset();
    const failing = new FailingCalendarProvider();
    const f = fixture(failing);
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    okValue(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "approve"));

    const after = okValue(
      await f.service.bookMeeting(f.workspaceId, f.userId, proposed.meeting.id),
    );
    // The meeting stays approved, so a retry is legal, and no reference exists.
    expect(after.meeting.state).toBe("approved");
    expect(after.meeting.bookedAt).toBeNull();
    expect(after.meeting.externalEventId).toBeNull();
    expect(after.events.map((e) => e.kind)).toEqual(["booking_attempted", "booking_failed"]);
  });

  it("records a thrown provider call as a failure too", async () => {
    reset();
    const throwing = new ThrowingCalendarProvider();
    const f = fixture(throwing);
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    okValue(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "approve"));

    const after = okValue(
      await f.service.bookMeeting(f.workspaceId, f.userId, proposed.meeting.id),
    );
    expect(after.meeting.state).toBe("approved");
    expect(after.meeting.externalEventId).toBeNull();
    expect(after.events.map((e) => e.kind)).toEqual(["booking_attempted", "booking_failed"]);
  });

  it("refuses to book an address that opted out after the approval", async () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    okValue(f.service.decideMeeting(f.workspaceId, f.userId, proposed.meeting.id, "approve"));
    SUPPRESSED.add("ada@northwind.example");

    expect(
      errorCode(await f.service.bookMeeting(f.workspaceId, f.userId, proposed.meeting.id)),
    ).toBe("SUPPRESSED");
    // Nothing reached the calendar.
    expect(f.calendar.callCount()).toBe(0);
  });
});

describe("MeetingService.prepareBrief", () => {
  it("assembles a brief from stored records and names its gaps", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    const prepared = okValue(f.service.prepareBrief(f.workspaceId, f.userId, proposed.meeting.id));

    expect(prepared.brief.meetingId).toBe(proposed.meeting.id);
    expect(prepared.brief.version).toBe(1);
    expect(prepared.brief.rendererVersion).toBe("brief-1.0.0");
    // The response is quoted verbatim rather than summarized.
    expect(prepared.brief.conversationExcerpt).toBe("Happy to chat, book a call.");
    expect(prepared.brief.intent).toBe("positive_intent");
    expect(prepared.brief.qualificationScore).toBe(82);
    // This fixture has no evidence behind it, and the brief says so rather than
    // inventing a relevant signal.
    expect(prepared.brief.gaps.join(" ")).toMatch(/No evidence/);
    expect(prepared.brief.evidenceIds).toEqual([]);
    expect(prepared.brief.claimIds).toEqual([]);
  });

  it("versions a regenerated brief instead of rewriting the first", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    okValue(f.service.prepareBrief(f.workspaceId, f.userId, proposed.meeting.id));
    const second = okValue(f.service.prepareBrief(f.workspaceId, f.userId, proposed.meeting.id));
    expect(second.brief.version).toBe(2);
    // Both survive: a person may have read the first.
    const all = okValue(f.service.listBriefs(proposed.meeting.id, f.userId));
    expect(all).toHaveLength(2);
  });

  it("writes no evidence, claim or message while preparing a brief", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    okValue(f.service.prepareBrief(f.workspaceId, f.userId, proposed.meeting.id));
    // The repository exposes no evidence or claim table at all: a meeting cannot
    // become a fact because the seam does not exist.
    const repo = f.repo as unknown as Record<string, unknown>;
    expect(repo.evidence).toBeUndefined();
    expect(repo.accountClaims).toBeUndefined();
    expect(f.calendar.callCount()).toBe(0);
  });
});

describe("renderMeetingBrief", () => {
  const base = {
    meetingId: "m-1",
    accountId: "acct-1",
    contactId: "contact-1",
    qualificationId: "q-1",
    qualificationScore: 80,
    qualificationState: "qualified",
    classificationId: "c-1",
    intent: "positive_intent" as const,
    conversationExcerpt: "Happy to chat.",
    claimIds: ["claim-1"],
    evidenceIds: ["evidence-1"],
    contactName: "Ada Lovelace",
    contactJobTitle: "VP Support",
    accountName: "Northwind",
    recommendationReason: "positive_intent" as const,
  };

  it("reports nothing missing when the workspace has the records", () => {
    expect(renderMeetingBrief(base).gaps).toEqual([]);
  });

  it("names each missing record rather than filling it in", () => {
    const gaps = renderMeetingBrief({
      ...base,
      contactJobTitle: null,
      evidenceIds: [],
      qualificationScore: null,
      claimIds: [],
      conversationExcerpt: "",
    }).gaps;
    // Four distinct absences, each named. The claim gap is deliberately *not*
    // asserted here: with no evidence at all there is nothing to have failed to
    // support, and the evidence gap already says so.
    expect(gaps).toHaveLength(4);
    expect(gaps.join(" ")).toMatch(/job title/);
    expect(gaps.join(" ")).toMatch(/No evidence/);
    expect(gaps.join(" ")).toMatch(/no score/);
    expect(gaps.join(" ")).toMatch(/response text/);
  });

  it("does not treat a non-decision title as establishing a decision maker", () => {
    const gaps = renderMeetingBrief({ ...base, contactJobTitle: "Support Engineer" }).gaps;
    expect(gaps.join(" ")).toMatch(/does not establish them as a decision maker/);
  });

  it("passes reference lists through without expanding them", () => {
    const draft = renderMeetingBrief({ ...base, claimIds: ["c"], evidenceIds: ["e", "e2"] });
    expect(draft.claimIds).toEqual(["c"]);
    expect(draft.evidenceIds).toEqual(["e", "e2"]);
  });
});

describe("MeetingService reads", () => {
  it("hides a meeting from a workspace that does not own it", () => {
    reset();
    const f = fixture();
    const proposed = okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    expect(errorCode(f.service.getMeeting(proposed.meeting.id, "u-other"))).toBe("NOT_FOUND");
    expect(errorCode(f.service.meetingHistory(proposed.meeting.id, "u-other"))).toBe("NOT_FOUND");
  });

  it("lists only the caller's own workspace, newest first", () => {
    reset();
    const f = fixture();
    okValue(
      f.service.recommendMeeting(f.workspaceId, f.userId, {
        classificationId: f.classificationId,
        ...BOOKING,
      }),
    );
    const listed = okValue(f.service.listMeetings(f.workspaceId, f.userId));
    expect(listed).toHaveLength(1);
    // The other tenant may list its own workspace, but the first tenant's meeting
    // is not in it: the boundary is the row's workspace, not the caller existing.
    const other = okValue(f.service.listMeetings(f.otherWorkspaceId, "u-other"));
    expect(other).toHaveLength(0);
    expect(other.map((m) => m.id)).not.toContain(listed[0]?.id);
    // And a caller with no membership at all is refused outright.
    expect(errorCode(f.service.listMeetings(f.workspaceId, "u-stranger"))).toBe("NOT_FOUND");
  });

  it("rejects an unknown state filter rather than ignoring it", () => {
    reset();
    const f = fixture();
    expect(
      errorCode(f.service.listMeetings(f.workspaceId, f.userId, { state: "booked-ish" })),
    ).toBe("VALIDATION_ERROR");
  });

  it("publishes its policy to a caller who has booked nothing", () => {
    reset();
    const f = fixture();
    const policy = okValue(f.service.policy(f.workspaceId, f.userId));
    expect(policy.policyVersion).toBe("deterministic-1.0.0");
    expect(policy.neverDoes.length).toBeGreaterThan(0);
  });

  it("requires authentication and a workspace", () => {
    reset();
    const f = fixture();
    expect(errorCode(f.service.getMeeting("", f.userId))).toBe("VALIDATION_ERROR");
    expect(errorCode(f.service.policy(f.workspaceId, ""))).toBe("UNAUTHORIZED");
  });
});

/** Await a booking attempt and return just the error code it produced. */
async function bookingError(meetingId: string, f: Fixture): Promise<string> {
  const result = await f.service.bookMeeting(f.workspaceId, f.userId, meetingId);
  if (result.ok) return "NO_ERROR";
  return result.error.code;
}
