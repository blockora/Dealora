/**
 * Validation and the send-authorization predicate.
 *
 * `authorizesSend` is the heart of this phase and is written to be read on its
 * own: it takes the persisted approval, the immutable draft version, the action
 * already raised for that approval and the clock, and answers one question —
 * may this exact text go to this exact address right now?
 *
 * It is deliberately *not* given the action's current status. The action is the
 * thing being authorized; letting its own status vouch for itself would make
 * every check after the first a formality.
 */

import type { ApprovalRequest, OutboundAction, OutboundChannel } from "@dealora/db";

import { isSendableStatus, LIMITS } from "./rules.js";
import type { OutboundPolicyView } from "./types.js";

/** Accumulating field-level validation issues. */
export class OutboundIssues {
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

/**
 * Normalize a caller-supplied string.
 *
 * Returns `null` for anything that is not a usable non-empty string, so a caller
 * cannot pass whitespace and have it recorded as a stated reason.
 */
export function text(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Everything the send boundary checks, and what it refuses. */
export interface SendAuthorizationInput {
  approval: ApprovalRequest;
  /** The draft version the action names. */
  draftId: string;
  draftVersion: number;
  /** The immutable draft record itself, re-read from storage. */
  draft: { id: string; workspaceId: string; version: number } | null;
  /** The action already raised for this approval, if there is one. */
  existing: OutboundAction | null;
  now: Date;
}

export type SendAuthorization =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" | "UNAPPROVED"; message: string; detail: string };

/**
 * Does a persisted approval authorize sending this exact draft version, once,
 * to a real recipient?
 *
 * Each check exists because there is a specific way this boundary could be
 * crossed by accident:
 *
 * 1. `approved` — the only state that authorizes anything. `pending`,
 *    `rejected`, `changes_requested`, `cancelled` and `expired` all refuse.
 * 2. **The approval covers this exact version.** An approval for version 1
 *    authorizes version 1 and nothing else, so regenerating a draft cannot
 *    inherit an older human's yes.
 * 3. **The draft is still the version the action names.** Content that moved, or
 *    a version that was never rendered, refuses.
 * 4. **The draft is in the approval's workspace.** One workspace's approval can
 *    never authorize another workspace's draft, even with both ids correct.
 * 5. **Not already delivered.** `sent` and `cancelled` are terminal, so a second
 *    send of the same approval is refused by the same check.
 * 6. **Attempt budget.** A message that has failed too many times stops being
 *    retryable, so a permanently failing destination cannot be hammered.
 */
export function authorizesSend(input: SendAuthorizationInput): SendAuthorization {
  const { approval, draft, draftId, draftVersion, existing, now } = input;

  if (approval.status !== "approved") {
    return {
      ok: false,
      code: "UNAPPROVED",
      message: `this approval is ${approval.status} and does not authorize a send`,
      detail:
        approval.status === "pending"
          ? "no human decision has been recorded yet"
          : `only an approved request authorizes a send; this one is ${approval.status}`,
    };
  }
  if (approval.decidedBy === null || approval.decidedAt === null) {
    return {
      ok: false,
      code: "UNAPPROVED",
      message: "this approval carries no reviewer and no instant",
      detail: "an approval without an attributed human decision authorizes nothing",
    };
  }
  if (approval.draftId !== draftId || approval.draftVersion !== draftVersion) {
    return {
      ok: false,
      code: "UNAPPROVED",
      message: "this approval does not cover that draft version",
      detail: `the approval covers draft ${approval.draftId} version ${approval.draftVersion}`,
    };
  }
  if (draft === null || draft.id !== draftId || draft.version !== draftVersion) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "the draft version this approval names could not be re-read",
      detail: "a draft that is not there cannot be authorized for sending",
    };
  }
  if (draft.workspaceId !== approval.workspaceId) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "the draft is not in this workspace",
      detail: "an approval never authorizes another workspace's draft",
    };
  }
  if (approval.expiresAt !== null && new Date(approval.expiresAt) <= now) {
    return {
      ok: false,
      code: "CONFLICT",
      message: "this approval has expired",
      detail: "an expired approval authorizes nothing; ask for approval again",
    };
  }
  if (existing !== null) {
    if (existing.status === "sent") {
      return {
        ok: false,
        code: "CONFLICT",
        message: "this approval has already been sent",
        detail: "one approval authorizes one send; the message is already gone",
      };
    }
    if (existing.status === "cancelled") {
      return {
        ok: false,
        code: "CONFLICT",
        message: "this approval's action was cancelled",
        detail: "a cancelled action authorizes nothing; stage a new one",
      };
    }
    if (existing.status === "sending") {
      return {
        ok: false,
        code: "CONFLICT",
        message: "this action is already in flight",
        detail: "a send in progress cannot be started again",
      };
    }
    if (existing.attemptCount >= LIMITS.maxAttempts) {
      return {
        ok: false,
        code: "CONFLICT",
        message: "this action has used all of its attempts",
        detail: `an action may be attempted at most ${LIMITS.maxAttempts} times`,
      };
    }
    if (!isSendableStatus(existing.status)) {
      return {
        ok: false,
        code: "CONFLICT",
        message: `this action is ${existing.status} and cannot be sent`,
        detail: "only a ready or failed action may be sent",
      };
    }
  }
  return { ok: true };
}

/**
 * What this deployment enforces, readable before anything has been sent.
 *
 * The point of returning the refusals as data is that a workspace can be told
 * what the system will not do *before* it relies on it doing something else.
 */
export function describeOutboundPolicy(channel: OutboundChannel): OutboundPolicyView {
  return {
    channel,
    requires: [
      "a persisted human approval covering the exact draft version being sent",
      "a recipient resolved server-side from the contact record",
      "an address that is not on the workspace's opt-out list",
      "a configured provider for this channel",
      "an action that has not already been delivered",
    ],
    neverDoes: [
      "send anything without an explicit human approval of that exact draft version",
      "send autonomously, on a schedule, on a score, or on a retry loop",
      "reach a provider directly; it only ever sees a prepared message",
      "trust a client-supplied approval, status, provider, recipient or provider result",
      "mark a message sent unless the provider confirmed submission",
      "send twice for one approval, however many times a send is retried",
      "send to a suppressed address, or route around a suppression",
    ],
    failureStates: [
      "invalid_recipient",
      "provider_rejected",
      "rate_limited",
      "suppressed",
      "provider_unavailable",
    ],
    retryPolicy: `A failed action may be retried explicitly, by a human, up to ${LIMITS.maxAttempts} attempts in total. There is no automatic retry and no background retry loop.`,
    maxAttempts: LIMITS.maxAttempts,
  };
}
