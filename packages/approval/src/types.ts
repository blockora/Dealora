import type { Result } from "@dealora/core";
import type {
  ApprovalActionKind,
  ApprovalDecision,
  ApprovalEventKind,
  ApprovalRequest,
  ApprovalRequestEvent,
  ApprovalRiskLevel,
  ApprovalStatus,
  EntityId,
  PersonalizedDraft,
} from "@dealora/db";

/**
 * @dealora/approval — Approval Engine (DEALORA_BLUEPRINT.md §17, ROADMAP.md §17).
 *
 * Creates human control before a consequential action. The product loop in
 * `ROADMAP.md` §4 runs PERSONALIZATION → HUMAN APPROVAL → APPROVED ACTION, and
 * this package is the second step: a **persisted** human decision about one
 * exact, immutable draft version.
 *
 * What this package is not, stated once so every consumer inherits it:
 *
 *   - it is **not** a policy engine and has no auto-approval. There is no
 *     score, threshold, timer, model or rule that can move a request to
 *     `approved`. Only {@link ApprovalRequestEvent} rows written by explicit
 *     human decisions through the service reach that state, and every one of
 *     them names the reviewer and the instant;
 *   - it **never trusts a client about the decision**. The requester comes from
 *     the session at creation and the reviewer from the session at decision
 *     time. A body carrying `decidedBy`, `decidedAt`, `status`, `decision` or
 *     `approved` is not read — the storage layer also refuses to create a
 *     request that already carries a decision;
 *   - it **cannot be self-issued by a model**. There is no service call that
 *     approves anything without an authenticated human identity behind it;
 *   - it **does not execute anything**. An approval authorizes a send; the
 *     send itself is Phase 11 and re-verifies this record independently before
 *     it calls a provider. Nothing here contacts a provider, a CRM or a
 *     calendar;
 *   - it **binds to exactly one immutable draft version**. `draftId` +
 *     `draftVersion` + `previewDigest` are recorded, and the digest is verified
 *     again at decision time, so an approval can never end up standing for text
 *     the reviewer never read.
 */

/** Domain error vocabulary, closed and safe to render. */
export type ApprovalErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFLICT"
  /** The request is no longer `pending`, so no decision may be recorded. */
  | "INVALID_TRANSITION"
  /** The request passed its own expiry before a decision was recorded. */
  | "EXPIRED"
  /** The previewed content no longer matches the draft it was bound to. */
  | "PREVIEW_MISMATCH"
  | "UNAVAILABLE";

export interface ApprovalError {
  code: ApprovalErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export function approvalError(
  code: ApprovalErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): ApprovalError {
  return details ? { code, message, details } : { code, message };
}

export type {
  ApprovalActionKind,
  ApprovalDecision,
  ApprovalEventKind,
  ApprovalRequest,
  ApprovalRequestEvent,
  ApprovalRiskLevel,
  ApprovalStatus,
  EntityId,
  PersonalizedDraft,
};

/**
 * The exact draft version a decision is about, narrowed to what the engine
 * verifies.
 *
 * A reference, never a copy: the approval records *which* version, and the
 * draft keeps the text. Re-deriving the preview therefore re-reads the one
 * immutable document rather than trusting a stored blob that could drift.
 */
export interface ApprovalDraftSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  version: number;
  subject: string;
  body: string;
  /** What the renderer recorded that it would not state as fact. */
  warnings: string[];
  /** Digest of the exact content a reviewer is shown. Re-verified on decision. */
  contextDigest: string;
}

/**
 * Reads drafts through the caller's own authorization.
 *
 * `byId` resolves one named draft and `byVersion` resolves one exact version of
 * it. Both return `null` rather than an error for a record that does not exist
 * or belongs to another workspace, so a foreign draft is never revealed to
 * exist.
 */
export interface ApprovalDraftReader {
  byId: (draftId: EntityId, userId: EntityId) => ApprovalDraftSnapshot | null;
  /**
   * The newest version of a draft lineage, or `null` when the lineage is empty.
   *
   * The default a request binds to when the caller names no version: reviewing
   * the newest text is the only choice that cannot approve something stale.
   */
  latestVersion: (draftId: EntityId, userId: EntityId) => ApprovalDraftSnapshot | null;
}

/**
 * Storage the Approval domain depends on.
 *
 * Declared as an interface so the domain never touches the JSON store directly
 * and a different driver can replace it without editing a line of approval
 * logic. Every read and write is the workspace's own.
 */
export interface ApprovalRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;

  createApprovalRequest(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    approval: Omit<
      ApprovalRequest,
      | "id"
      | "workspaceId"
      | "createdBy"
      | "status"
      | "decision"
      | "decidedBy"
      | "decidedAt"
      | "decisionReason"
      | "createdAt"
      | "updatedAt"
    >;
  }): Result<ApprovalRequest, { code: string }>;

  createApprovalRequestEvent(input: {
    workspaceId: EntityId;
    actorUserId: EntityId;
    event: Omit<ApprovalRequestEvent, "id" | "workspaceId" | "actorUserId" | "createdAt">;
  }): Result<ApprovalRequestEvent, { code: string }>;

  decideApproval(input: {
    id: EntityId;
    userId: EntityId;
    decision: ApprovalDecision;
    reason: string | null;
    decidedAt: string;
  }): Result<ApprovalRequest, { code: string }>;

  closeApproval(input: {
    id: EntityId;
    userId: EntityId;
    status: Extract<ApprovalStatus, "cancelled" | "expired">;
    reason: string | null;
    decidedAt: string;
  }): Result<ApprovalRequest, { code: string }>;

  getApprovalRequest(id: EntityId, userId: EntityId): Result<ApprovalRequest, { code: string }>;

  listApprovalRequests(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { draftId?: EntityId; status?: ApprovalStatus; decidedBy?: EntityId },
  ): Result<ApprovalRequest[], { code: string }>;

  listApprovalRequestEvents(
    approvalId: EntityId,
    userId: EntityId,
  ): Result<ApprovalRequestEvent[], { code: string }>;
}

/**
 * Injected clock.
 *
 * Used to stamp `decidedAt`, to evaluate an expiry, and to precompute a request
 * expiry. Nothing else reads a clock: which request is pending, who may decide
 * it and what it authorizes are all decided from stored state.
 */
export type Clock = () => Date;
