/**
 * The fixed rules of this phase: what may be sent, what must never be, and the
 * vocabulary both the service and the tests speak.
 *
 * These constants are deliberately not configurable. Phase 11 integrates one
 * channel and enforces one boundary; anything a deployment could tune here
 * would be something it could also tune into unsending an approval.
 */

import type { OutboundActionStatus, OutboundFailureCode } from "@dealora/db";

import type { OutboundError, OutboundErrorCode } from "./types.js";

/** Hard caps, enforced before anything is written. */
export const LIMITS = {
  /** Longest accepted recipient address, including the domain. */
  recipient: 254,
  /** Longest accepted suppression reason. */
  suppressionReason: 500,
  /** How many provider calls one action may make in total. */
  maxAttempts: 5,
} as const;

/**
 * The idempotency key a provider sees.
 *
 * Derived from the action id, so it is stable across retries of the *same* send
 * and different for every distinct action. A provider that de-duplicates on this
 * key therefore cannot receive the same logical send twice, even if this process
 * crashes between the provider's confirmation and the local write.
 */
export function idempotencyKey(actionId: string): string {
  return `dealora-${actionId}`;
}

/**
 * A syntactically valid destination address.
 *
 * Deliberately conservative: one `@`, a non-empty local part with no whitespace,
 * and a dotted domain. This is a guard against a malformed record, not an RFC
 * 5322 parser — a provider is still the authority on whether an address is
 * deliverable, and its refusal is recorded as `invalid_recipient` rather than
 * argued with here.
 */
export function isDeliverableAddress(value: string): boolean {
  if (value.length === 0 || value.length > LIMITS.recipient) return false;
  if (/\s/.test(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const local = parts[0];
  const domain = parts[1];
  if (!local || !domain) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.startsWith("-")) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

/** Every failure code a provider may report, in one place. */
export const OUTBOUND_FAILURE_CODES: readonly OutboundFailureCode[] = [
  "invalid_recipient",
  "provider_rejected",
  "rate_limited",
  "suppressed",
  "provider_unavailable",
] as const;

export function isOutboundFailureCode(value: unknown): value is OutboundFailureCode {
  return typeof value === "string" && (OUTBOUND_FAILURE_CODES as readonly string[]).includes(value);
}

export function isOutboundStatus(value: unknown): value is OutboundActionStatus {
  return (
    value === "ready" ||
    value === "sending" ||
    value === "sent" ||
    value === "failed" ||
    value === "cancelled"
  );
}

/**
 * Can this action be handed to a provider?
 *
 * `ready` and `failed` can; `sending`, `sent` and `cancelled` cannot. `failed`
 * is included deliberately: ROADMAP.md §18 asks for failure states and retry
 * policies, and an explicit retry of a failed send is legitimate. A retry is
 * never automatic, so it can never become a retry loop.
 */
export function isSendableStatus(status: string): boolean {
  return status === "ready" || status === "failed";
}

/** Has this action reached a state no further provider call may change? */
export function isTerminalStatus(status: string): boolean {
  return status === "sent" || status === "cancelled";
}

/** Build a domain error with optional field details. */
export function outboundError(
  code: OutboundErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): OutboundError {
  return details === undefined ? { code, message } : { code, message, details };
}
