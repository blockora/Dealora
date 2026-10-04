/**
 * Validation for the meeting boundary.
 *
 * Written as a collector rather than a chain of early returns so a caller gets
 * every problem with their booking at once, the way the Conversation, Outbound
 * and Approval engines do it.
 */

import type {
  MeetingBookingState,
  MeetingPolicyView,
  MeetingRecommendationReason,
} from "./types.js";
import {
  LIMITS,
  MEETING_BRIEF_RENDERER_VERSION,
  MEETING_POLICY_VERSION,
  MEETING_RECOMMENDATION_REASONS,
  MEETING_STATES,
  MEETING_TRANSITIONS,
  MIN_DURATION_MINUTES,
} from "./rules.js";

export class MeetingIssues {
  private readonly issues: { field: string; message: string }[] = [];

  add(field: string, message: string): void {
    this.issues.push({ field, message });
  }

  get length(): number {
    return this.issues.length;
  }

  all(): { field: string; message: string }[] {
    return [...this.issues];
  }
}

/** A trimmed string within bounds, or `null` when it is not one. */
export function text(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length <= max ? trimmed : null;
}

/**
 * An optional string within bounds.
 *
 * Returns `undefined` for "not supplied" and `null` for "supplied but not a
 * usable string", which are different refusals: a caller who sent an empty title
 * made a mistake, while a caller who sent nothing did not.
 */
export function optionalText(value: unknown, max = 1000): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length <= max ? trimmed : null;
}

/** An ISO-8601 instant, normalized, or `null`. Never guessed from a locale. */
export function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * An IANA timezone name, or `null`.
 *
 * Validated through `Intl` rather than a regex, because the set of real zone
 * names is the platform's and a hand-written pattern would accept "Mars/Olympus".
 * "UTC" is accepted explicitly: it is the correct answer for a workspace that has
 * not configured one, and inventing a local zone from a server's locale would
 * silently move a meeting across a timezone boundary.
 */
export function timezone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > LIMITS.timezone) return null;
  if (trimmed === "UTC") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

/** A whole number of minutes within bounds, or `null`. */
export function durationMinutes(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isInteger(parsed)) return null;
  if (parsed < MIN_DURATION_MINUTES || parsed > LIMITS.durationMinutes) return null;
  return parsed;
}

/**
 * The policy this deployment enforces, as data.
 *
 * Readable before anything has been booked, so a workspace can see exactly which
 * state moves exist before it hands over a response — and can see, in the same
 * place, everything the workflow refuses to do.
 */
export function describeMeetingPolicy(): MeetingPolicyView {
  const transitions: [MeetingBookingState, MeetingBookingState][] = [];
  for (const [from, targets] of MEETING_TRANSITIONS) {
    for (const to of targets) transitions.push([from, to]);
  }
  return {
    policyVersion: MEETING_POLICY_VERSION,
    briefRendererVersion: MEETING_BRIEF_RENDERER_VERSION,
    states: MEETING_STATES,
    transitions,
    recommendationReasons: MEETING_RECOMMENDATION_REASONS as readonly MeetingRecommendationReason[],
    channels: ["sandbox", "provider"],
    prerequisites: [
      "A response the Phase 12 classifier read as positive_intent or interested.",
      "An account with a Phase 8 qualification in the state `qualified`.",
      "A contact DEALORA actually sent to, resolved server-side from the classification.",
      "An address that is not on the Phase 11 suppression list at decision time.",
      "A human approval of this exact booking, re-derived from the stored digest, before anything reaches a calendar.",
    ],
    neverDoes: [
      "It never books a meeting on its own initiative. Scheduling is a Level 2 external action and always waits for a person.",
      "It never sends an invitation. Phase 10's approval and Phase 11's send path still govern every message, and a booked meeting does not imply an email was sent.",
      "It never contacts a suppressed address. The Phase 11 opt-out list is re-checked at approval and at booking.",
      "It never turns a meeting, a brief or a response into evidence or a claim. Phase 7 remains the only route, and it stays human-driven.",
      "It never connects to a live calendar or a CRM. ROADMAP.md §30 puts those integrations in Phase 23; the shipped adapter is a sandbox that performs no network I/O.",
      "It never schedules, retries or reschedules anything by itself. There is no timer, no queue and no cron.",
      "It never invents a signal, a need or a decision maker. The brief reports what the workspace's own records say, and names what is missing.",
    ],
  };
}
