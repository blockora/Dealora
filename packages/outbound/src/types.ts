/**
 * @dealora/outbound — the types Phase 11's single outbound channel needs.
 *
 * The shape of this file is the design: a provider is a *narrow* interface that
 * accepts one prepared message and answers with either a provider reference or a
 * refusal code. It has no access to the store, no knowledge of approvals, and
 * no ability to decide anything. Everything DEALORA guarantees — that a message
 * was approved, that it went to the right person once, that it was not sent to
 * someone who opted out — is verified by the service *before* this interface is
 * called, never by the provider.
 */

import type {
  ApprovalRequest,
  DateTime,
  EntityId,
  OutboundAction,
  OutboundActionStatus,
  OutboundChannel,
  OutboundEvent,
  OutboundEventKind,
  OutboundFailureCode,
  OutboundSuppression,
} from "@dealora/db";

export type {
  ApprovalRequest,
  OutboundAction,
  OutboundActionStatus,
  OutboundChannel,
  OutboundEvent,
  OutboundEventKind,
  OutboundFailureCode,
  OutboundSuppression,
};

/** The only channel this phase integrates. Choosing exactly one is the requirement. */
export const OUTBOUND_CHANNEL: OutboundChannel = "email";

/**
 * Error codes this domain raises.
 *
 * Every code is closed and mapped explicitly onto the API's vocabulary, so a new
 * failure cannot silently become an untyped error at the transport boundary.
 */
export type OutboundErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "UNAPPROVED"
  | "SUPPRESSED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_FAILED"
  | "UNAVAILABLE";

export interface OutboundError {
  readonly code: OutboundErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** An injectable clock, so every timestamp the service writes is reproducible. */
export type Clock = () => Date;

/**
 * What a provider is asked to deliver.
 *
 * This is the complete input. It carries no approval record, no workspace id and
 * no action id as anything a provider could act on beyond an idempotency key —
 * a provider that could see an approval could be talked into skipping one.
 */
export interface OutboundMessage {
  /** Stable across retries, so a provider can de-duplicate its own attempts. */
  idempotencyKey: string;
  to: string;
  subject: string;
  body: string;
}

/**
 * What a provider answers.
 *
 * Exactly one of `accepted` or `refusal` is true. A provider that returns
 * neither has not confirmed anything, and the service treats that as a failure
 * rather than as a send: **only an explicit confirmation can produce `sent`.**
 */
export interface OutboundProviderResult {
  accepted: boolean;
  /** The provider's own reference for the accepted message. */
  providerReference: string | null;
  /** The provider's own words. Kept verbatim alongside the closed code. */
  message: string;
  /** Required when `accepted` is false. */
  failureCode: OutboundFailureCode | null;
}

/**
 * The provider interface.
 *
 * Implementations must:
 * - be synchronous or resolve; there is no background queue behind this call;
 * - report `accepted: true` **only** when the provider confirmed submission;
 * - return a closed {@link OutboundFailureCode} for every refusal.
 *
 * An implementation must not: retry on its own, hold the message for later, or
 * invent a provider reference it was not given.
 */
export interface OutboundProvider {
  /** Stable provider identity, stored on every action this provider touches. */
  readonly name: string;
  send(message: OutboundMessage): Promise<OutboundProviderResult>;
}

/** What a provider registry must offer the service. */
export interface OutboundProviderResolver {
  /** `null` when no provider is configured for the channel. */
  providerFor(channel: OutboundChannel): OutboundProvider | null;
  /** Names of every provider this deployment has configured. */
  configuredProviders(): string[];
}

/**
 * The narrow view of an approval the send path re-verifies for itself.
 *
 * The service deliberately does **not** take an `ApprovalService`: a send must
 * re-derive the authorization question independently of the code that issued the
 * approval, or "approved" would only ever mean "the phase that wrote the row
 * still agrees with itself".
 */
export interface OutboundApprovalVerifier {
  /**
   * Re-read one approval by id, authorized against the caller's own workspace.
   *
   * Returns `null` for an approval that does not exist *or* that the caller is
   * not a member of: the send path must not be able to tell the difference, and
   * must not be able to read a foreign approval at all.
   */
  verify(approvalId: EntityId, userId: EntityId): ApprovalRequest | null;
  /**
   * The approved request covering one exact draft version in one workspace.
   *
   * Scoped to the caller's own workspace before anything is searched, so an
   * approval belonging to another tenant is out of scope by construction rather
   * than filtered out afterwards. Returns `null` when no `approved` request
   * covers that version — which is what "pending", "rejected",
   * "changes_requested", "cancelled" and "expired" all look like here.
   */
  findApprovedForDraftVersion(
    workspaceId: EntityId,
    userId: EntityId,
    draftId: EntityId,
    draftVersion: number,
  ): ApprovalRequest | null;
}

/** The narrow view of a draft version the send path re-verifies for itself. */
export interface OutboundDraftReader {
  byId(draftId: EntityId, userId: EntityId): OutboundDraftSnapshot | null;
}

/**
 * What the send path needs from a draft.
 *
 * Only the identity, the version, the addresses, and the digest. The subject and
 * body are read so the message actually sent is the text the reviewer approved
 * — read from the immutable record, never from a caller.
 */
export interface OutboundDraftSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  version: number;
  subject: string;
  body: string;
  contactId: EntityId | null;
  contextDigest: string;
}

/** The narrow view of a contact the send path needs. */
export interface OutboundContactReader {
  byId(contactId: EntityId, userId: EntityId): OutboundContactSnapshot | null;
}

/**
 * What the send path needs from a contact: who it is and where it reaches them.
 *
 * `email` stays nullable all the way through, exactly as Phase 5 stored it. A
 * contact with no address is a real record, not an error to paper over at read
 * time; the send path is where it becomes a refusal.
 */
export interface OutboundContactSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  email: string | null;
  status: string;
}

/**
 * The storage surface Phase 11 needs.
 *
 * Every method is workspace-scoped and takes the authenticated `userId`, so
 * authorization is not optional at any call site.
 */
export interface OutboundRepository {
  authorize(
    workspaceId: EntityId,
    userId: EntityId,
  ): { ok: true } | { ok: false; error: { code: string; message: string } };

  createOutboundAction(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    action: {
      channel: OutboundChannel;
      draftId: EntityId;
      draftVersion: number;
      draftDigest: string;
      approvalId: EntityId;
      contactId: EntityId;
      recipientEmail: string;
    };
  }): { ok: true; value: OutboundAction } | { ok: false; error: { code: string; message: string } };

  recordOutboundAttempt(input: {
    id: EntityId;
    userId: EntityId;
    provider: string;
    attemptedAt: DateTime;
  }): { ok: true; value: OutboundAction } | { ok: false; error: { code: string; message: string } };

  confirmOutboundSent(input: {
    id: EntityId;
    userId: EntityId;
    provider: string;
    providerReference: string | null;
    sentAt: DateTime;
  }): { ok: true; value: OutboundAction } | { ok: false; error: { code: string; message: string } };

  recordOutboundFailure(input: {
    id: EntityId;
    userId: EntityId;
    provider: string;
    failureCode: OutboundFailureCode;
    failureMessage: string;
    failedAt: DateTime;
  }): { ok: true; value: OutboundAction } | { ok: false; error: { code: string; message: string } };

  cancelOutboundAction(
    id: EntityId,
    userId: EntityId,
    reason: string | null,
    cancelledAt: DateTime,
  ): { ok: true; value: OutboundAction } | { ok: false; error: { code: string; message: string } };

  createOutboundEvent(input: {
    workspaceId: EntityId;
    actorUserId: EntityId;
    event: { actionId: EntityId; kind: OutboundEvent["kind"]; detail: string | null };
  }): { ok: true; value: OutboundEvent } | { ok: false; error: { code: string; message: string } };

  getOutboundAction(
    id: EntityId,
    userId: EntityId,
  ): { ok: true; value: OutboundAction } | { ok: false; error: { code: string; message: string } };

  listOutboundActions(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: OutboundActionStatus; draftId?: EntityId; approvalId?: EntityId },
  ):
    { ok: true; value: OutboundAction[] } | { ok: false; error: { code: string; message: string } };

  /** The idempotency check: the action already raised for this approval, if any. */
  findOutboundActionByApproval(
    approvalId: EntityId,
    userId: EntityId,
  ):
    | { ok: true; value: OutboundAction | null }
    | { ok: false; error: { code: string; message: string } };

  listOutboundEvents(
    actionId: EntityId,
    userId: EntityId,
  ): { ok: true; value: OutboundEvent[] } | { ok: false; error: { code: string; message: string } };

  createOutboundSuppression(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    suppression: { email: string; reason: string };
  }):
    | { ok: true; value: OutboundSuppression }
    | { ok: false; error: { code: string; message: string } };

  isSuppressed(
    workspaceId: EntityId,
    userId: EntityId,
    email: string,
  ): { ok: true; value: boolean } | { ok: false; error: { code: string; message: string } };

  listOutboundSuppressions(
    workspaceId: EntityId,
    userId: EntityId,
  ):
    | { ok: true; value: OutboundSuppression[] }
    | { ok: false; error: { code: string; message: string } };
}

export interface StageOutboundOptions {
  draftVersion?: unknown;
}

/**
 * The policy this deployment enforces, as data.
 *
 * A workspace should be able to read what the system requires of a send, and
 * what it will never do, before it has sent anything at all.
 */
export interface OutboundPolicyView {
  channel: OutboundChannel;
  /** Every precondition that must hold before a provider is called. */
  requires: string[];
  /** Every thing this phase refuses to do, stated plainly. */
  neverDoes: string[];
  /** The closed set of failures a send can end in. */
  failureStates: string[];
  /** How a failed send may be retried, and by whom. */
  retryPolicy: string;
  maxAttempts: number;
}

/** A send attempt's full, inspectable outcome. */
export interface OutboundSendResult {
  action: OutboundAction;
  /** The provider that was called, or `null` when none was configured. */
  provider: string | null;
  /** `true` only when the provider confirmed submission. */
  delivered: boolean;
  /** Every step this action has taken, oldest first. */
  events: OutboundEvent[];
}
