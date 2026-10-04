/**
 * Calendar adapters.
 *
 * **Why a sandbox and not a real calendar.** `ROADMAP.md` §30 puts "CRM,
 * calendar, email, Slack" integrations in Phase 23, explicitly "only after the
 * core revenue loop works", and no calendar credential exists in this repository.
 * Building a live adapter here would mean inventing an OAuth flow, inventing
 * scopes we have no permission to grant, and — worst of all — making a booking
 * claim in a test that would mean "DEALORA asserted it" rather than "a provider
 * recorded it".
 *
 * So the interface is real and the shipped implementation is a sandbox, exactly
 * as Phase 11 shipped a sandbox email provider. That keeps every statement in the
 * tests honest: a `booked` meeting means *this adapter recorded an event*, and
 * nothing else. Registering a real calendar is an explicit deployment decision
 * whose keys must be documented in the same commit that introduces them.
 *
 * The sandbox is not a mock. It holds the events it accepted, honours the
 * idempotency key, refuses what it is told to refuse, and reports its own call
 * count — so the properties the service depends on are genuinely exercised rather
 * than stubbed out.
 */

import type {
  MeetingAvailabilityWindow,
  MeetingBookingChannel,
  MeetingBookingFailure,
  MeetingCalendarProvider,
  MeetingCalendarRequest,
  MeetingCalendarResponse,
} from "./types.js";

export interface SandboxCalendarEvent {
  idempotencyKey: string;
  title: string;
  attendeeEmail: string;
  providerReference: string;
  startsAt: string;
  endsAt: string;
}

/**
 * A calendar that performs no network I/O and records what it accepted.
 *
 * Every delivery claim in the test suite means "the sandbox recorded it", never
 * "DEALORA asserted it" — the same rule Phase 11 established for email.
 */
export class SandboxCalendarProvider implements MeetingCalendarProvider {
  readonly channel: MeetingBookingChannel = "sandbox";

  private readonly accepted = new Map<string, SandboxCalendarEvent>();
  private readonly unavailableSlots = new Set<string>();
  private readonly invalidAttendees = new Set<string>();
  private readonly windows: MeetingAvailabilityWindow[];
  private calls = 0;

  constructor(windows?: MeetingAvailabilityWindow[]) {
    this.windows = windows ??
      // A declared, finite availability set. The workflow never guesses a slot:
      // a caller supplies the times it wants, and this provider only ever accepts
      // instants it was configured with.
      [
        { startsAt: "2026-11-02T09:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z" },
        { startsAt: "2026-11-03T09:00:00.000Z", endsAt: "2026-11-03T17:00:00.000Z" },
        { startsAt: "2026-11-04T13:00:00.000Z", endsAt: "2026-11-04T17:00:00.000Z" },
      ];
  }

  /** Refuse any booking that starts within this instant's day. */
  rejectSlot(startsAt: string): void {
    this.unavailableSlots.add(startsAt);
  }

  /** Refuse an address as malformed. */
  rejectAttendee(email: string): void {
    this.invalidAttendees.add(email.toLowerCase());
  }

  /** Every event this provider confirmed, in acceptance order. */
  events(): SandboxCalendarEvent[] {
    return [...this.accepted.values()];
  }

  /** How many times a booking actually reached this provider. */
  callCount(): number {
    return this.calls;
  }

  availability(): MeetingAvailabilityWindow[] {
    return [...this.windows];
  }

  async createEvent(request: MeetingCalendarRequest): Promise<MeetingCalendarResponse> {
    this.calls += 1;
    const existing = this.accepted.get(request.idempotencyKey);
    if (existing !== undefined) {
      // The same logical booking, already accepted: report the original
      // reference rather than pretending a second event went onto a calendar.
      return {
        ok: true,
        externalEventId: existing.providerReference,
        failureCode: null,
        message: "already accepted",
      };
    }
    if (this.invalidAttendees.has(request.attendeeEmail.toLowerCase())) {
      return {
        ok: false,
        externalEventId: null,
        failureCode: "invalid_attendee",
        message: `the sandbox provider treats ${request.attendeeEmail} as malformed`,
      };
    }
    if (this.unavailableSlots.has(request.startsAt)) {
      return {
        ok: false,
        externalEventId: null,
        failureCode: "slot_unavailable",
        message: "the sandbox provider treats that slot as unavailable",
      };
    }
    const providerReference = `sandbox-${request.idempotencyKey}`;
    this.accepted.set(request.idempotencyKey, {
      idempotencyKey: request.idempotencyKey,
      title: request.title,
      attendeeEmail: request.attendeeEmail,
      providerReference,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
    });
    return {
      ok: true,
      externalEventId: providerReference,
      failureCode: null,
      message: "accepted by the sandbox calendar provider",
    };
  }
}

/**
 * A provider that refuses everything with a chosen code.
 *
 * Exists so the failure paths are tested against a real
 * {@link MeetingCalendarProvider}, not against a hand-written result object: this
 * is the only way to prove that a refusal is recorded as a booking failure and
 * can never be reported as a booking.
 */
export class FailingCalendarProvider implements MeetingCalendarProvider {
  readonly channel: MeetingBookingChannel = "provider";

  private calls = 0;

  constructor(
    private readonly code: MeetingBookingFailure = "provider_unavailable",
    private readonly message = "the calendar provider is unavailable",
  ) {}

  attempts(): number {
    return this.calls;
  }

  availability(): MeetingAvailabilityWindow[] {
    return [];
  }

  async createEvent(): Promise<MeetingCalendarResponse> {
    this.calls += 1;
    return { ok: false, externalEventId: null, failureCode: this.code, message: this.message };
  }
}

/**
 * A provider that throws instead of answering.
 *
 * The third failure shape, and the one most likely to be forgotten: a calendar
 * adapter that rejects is not the same as one that refuses, and a thrown call must
 * not leave a booking in a state that looks confirmed.
 */
export class ThrowingCalendarProvider implements MeetingCalendarProvider {
  readonly channel: MeetingBookingChannel = "provider";

  private calls = 0;

  constructor(private readonly message = "the calendar provider threw") {}

  attempts(): number {
    return this.calls;
  }

  availability(): MeetingAvailabilityWindow[] {
    return [];
  }

  async createEvent(): Promise<MeetingCalendarResponse> {
    this.calls += 1;
    throw new Error(this.message);
  }
}
