import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type { ApprovalRequest, ApprovalRequestEvent, EntityId } from "@dealora/db";

import {
  APPROVAL_ACTION_KIND,
  LIMITS,
  SEND_MESSAGE_RISK_LEVEL,
  STATUS_DECISION,
  bounded,
  previewDigest,
} from "./rules.js";
import {
  ApprovalIssues,
  authorizesAction,
  decisionRequiresReason,
  describeApprovalPolicy,
  isApprovalDecision,
  isApprovalStatus,
  isDecidable,
  isExpired,
  text,
} from "./validation.js";
import type { ApprovalPolicyView, ApprovalPreview } from "./validation.js";
import type {
  ApprovalDraftReader,
  ApprovalDraftSnapshot,
  ApprovalError,
  ApprovalRepository,
  Clock,
} from "./types.js";
import { approvalError } from "./types.js";

export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";

function fromStorage(code: string, fallback: string): ApprovalError {
  switch (code) {
    case "NOT_FOUND":
      return approvalError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return approvalError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return approvalError("CONFLICT", fallback);
    case "INVALID":
      return approvalError("VALIDATION_ERROR", fallback);
    default:
      // Never surface an internal storage message.
      return approvalError("UNAVAILABLE", "storage unavailable");
  }
}

/** What the caller may influence: never the decision, only which draft to review. */
export interface RequestApprovalOptions {
  /**
   * The exact draft version to put up for review.
   *
   * When omitted, the newest version of the lineage is used. Naming a version
   * explicitly is how a reviewer asks about a specific text; either way the
   * version is bound to the request and never re-bound later.
   */
  draftVersion?: unknown;
  /** How long the request stays decidable, in whole days (1-30). */
  expiresInDays?: unknown;
}

/** A decision together with the immutable record it produced. */
export interface ApprovalDecisionResult {
  request: ApprovalRequest;
  event: ApprovalRequestEvent;
}

/**
 * The Approval Engine application service.
 *
 * Responsibilities:
 * - Authorize every call against the server-side identity.
 * - Bind a request to exactly one immutable draft version, and record a digest
 *   of the exact content the reviewer is shown.
 * - Record explicit human decisions with the reviewer identity and the instant,
 *   both taken from the session, never from a body.
 * - Verify again, at decision time, that the content still matches what was
 *   previewed — so an approval always means "I read *this* text".
 * - Refuse a decision on an already-decided or expired request, and record a
 *   `cancelled`/`expired` closure instead.
 * - Leave an append-only audit trail behind for every state a request passes
 *   through.
 *
 * It executes nothing. An approval authorizes a send; the send is Phase 11 and
 * re-verifies this record independently before calling a provider.
 */
export class ApprovalService {
  constructor(
    private readonly repo: ApprovalRepository,
    private readonly drafts: ApprovalDraftReader,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, ApprovalError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(approvalError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(approvalError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * Load the exact draft version this decision is about.
   *
   * The read is authorized by the reader, so another tenant's draft is simply
   * not found; the equality check is the belt to those braces. The workspace
   * match is checked separately because a reader that returned a foreign record
   * would otherwise let one workspace's approval authorize another's draft.
   */
  private requireDraftVersion(
    workspaceId: EntityId,
    userId: EntityId,
    draftId: unknown,
    requestedVersion: unknown,
  ): Result<ApprovalDraftSnapshot, ApprovalError> {
    if (typeof draftId !== "string" || draftId.trim() === "") {
      return err(
        approvalError("VALIDATION_ERROR", "draftId is required", [
          { field: "draftId", message: "draftId must be a non-empty string" },
        ]),
      );
    }

    let snapshot: ApprovalDraftSnapshot | null;
    if (requestedVersion !== undefined && requestedVersion !== null && requestedVersion !== "") {
      if (typeof requestedVersion !== "number" || !Number.isInteger(requestedVersion)) {
        return err(
          approvalError("VALIDATION_ERROR", "draftVersion must be an integer", [
            { field: "draftVersion", message: "draftVersion must be an integer" },
          ]),
        );
      }
      // The reader resolves one named version; a version the lineage never had
      // resolves to `null` rather than to a nearby one.
      const byId = this.drafts.byId(draftId, userId);
      if (byId === null) {
        return err(
          approvalError("NOT_FOUND", "draft not found", [
            { field: "draftId", message: "no such draft in this workspace" },
          ]),
        );
      }
      if (byId.version !== requestedVersion) {
        return err(
          approvalError("NOT_FOUND", "that draft version does not exist", [
            {
              field: "draftVersion",
              message: `this draft lineage's newest version is ${byId.version}; ${String(requestedVersion)} does not exist`,
            },
          ]),
        );
      }
      snapshot = byId;
    } else {
      snapshot = this.drafts.latestVersion(draftId, userId);
    }

    if (snapshot === null) {
      return err(
        approvalError("NOT_FOUND", "draft not found", [
          { field: "draftId", message: "no such draft in this workspace" },
        ]),
      );
    }
    if (snapshot.workspaceId !== workspaceId) {
      // Never confirm that another workspace's draft exists.
      return err(approvalError("NOT_FOUND", "draft not found"));
    }
    return ok(snapshot);
  }

  /**
   * Put one exact draft version up for a human decision.
   *
   * The full precondition chain runs before anything is written:
   * authenticate → authorize → draft version → expiry → create → audit.
   *
   * Nothing about the decision is accepted from the caller. There is no
   * `approved`, `decidedBy`, `decidedAt`, `status` or `decision` option here,
   * and the storage layer refuses to create a request that already carries one,
   * so the only state a request is ever created in is `pending`.
   */
  requestApproval(
    workspaceId: EntityId,
    userId: EntityId,
    draftId: unknown,
    options?: RequestApprovalOptions,
  ): Result<ApprovalRequest, ApprovalError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const draft = this.requireDraftVersion(workspaceId, userId, draftId, options?.draftVersion);
    if (!draft.ok) return draft;

    // An expiry is an upper bound the caller may request; it can never be
    // negative, and it is `null` when none was asked for.
    let expiresAt: string | null = null;
    if (options?.expiresInDays !== undefined && options.expiresInDays !== null) {
      const days = options.expiresInDays;
      if (
        typeof days !== "number" ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > LIMITS.maxExpiryDays
      ) {
        return err(
          approvalError("VALIDATION_ERROR", "expiresInDays is out of range", [
            {
              field: "expiresInDays",
              message: `expiresInDays must be a whole number of days between 1 and ${LIMITS.maxExpiryDays}`,
            },
          ]),
        );
      }
      expiresAt = new Date(this.clock().getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    const created = this.repo.createApprovalRequest({
      workspaceId,
      createdBy: userId,
      approval: {
        actionKind: APPROVAL_ACTION_KIND,
        riskLevel: SEND_MESSAGE_RISK_LEVEL,
        draftId: draft.value.id,
        draftVersion: draft.value.version,
        previewSubject: bounded(draft.value.subject, LIMITS.previewSubject),
        // The digest of exactly what the reviewer is about to be shown, so the
        // decision can be verified against the content later.
        previewDigest: previewDigest({
          draftId: draft.value.id,
          draftVersion: draft.value.version,
          subject: draft.value.subject,
          body: draft.value.body,
        }),
        expiresAt,
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "approval request failed"));

    // The audit trail is written for the request state too, so "who asked, and
    // when" is as durable as "who decided, and when".
    const event = this.repo.createApprovalRequestEvent({
      workspaceId,
      actorUserId: userId,
      event: {
        approvalId: created.value.id,
        kind: "requested",
        detail: `draft ${created.value.draftId} version ${created.value.draftVersion}`,
      },
    });
    if (!event.ok) return err(fromStorage(event.error.code, "approval request failed"));

    return ok(created.value);
  }

  /**
   * Record one explicit human decision.
   *
   * `decision` and `reason` are the only inputs. The reviewer is the
   * authenticated identity and the instant is the injected clock — neither is
   * ever read from a request body, which is what makes "who approved this?"
   * answerable from the stored record.
   *
   * Before the decision is stored, the preview is re-derived from the bound
   * draft version and compared with the digest recorded at request time. A
   * mismatch is refused: an approval must mean "I read this text", and text
   * that moved underneath the request cannot carry that meaning.
   */
  recordDecision(
    workspaceId: EntityId,
    userId: EntityId,
    approvalId: unknown,
    decision: unknown,
    reason: unknown,
  ): Result<ApprovalDecisionResult, ApprovalError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (typeof approvalId !== "string" || approvalId.trim() === "") {
      return err(
        approvalError("VALIDATION_ERROR", "approvalId is required", [
          { field: "approvalId", message: "approvalId must be a non-empty string" },
        ]),
      );
    }
    if (!isApprovalDecision(decision)) {
      return err(
        approvalError("VALIDATION_ERROR", "decision is invalid", [
          {
            field: "decision",
            message: "decision must be one of: approved, rejected, changes_requested",
          },
        ]),
      );
    }
    const issues = new ApprovalIssues();
    const stated = text(reason);
    if (decisionRequiresReason(decision) && stated === null) {
      issues.add(
        "reason",
        decision === "rejected"
          ? "a rejection must say why"
          : "a change request must say what should change",
      );
    }
    if (stated !== null && stated.length > LIMITS.reason) {
      issues.add("reason", `reason must be at most ${LIMITS.reason} characters`);
    }
    if (issues.length > 0) {
      return err(approvalError("VALIDATION_ERROR", "the decision is not valid", issues.all()));
    }

    const found = this.repo.getApprovalRequest(approvalId, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "approval request not found"));
    const request = found.value;
    if (request.workspaceId !== workspaceId) {
      return err(approvalError("NOT_FOUND", "approval request not found"));
    }

    const now = this.clock();
    const decidable = isDecidable(request, now);
    if (!decidable.ok) {
      if (decidable.reason === "expired") {
        // The deadline closed the door before a human got to it. Record the
        // closure so the trail says why, rather than leaving it pending forever.
        this.closeExpired(workspaceId, userId, request, now);
        return err(
          approvalError("EXPIRED", "this approval request has expired", [
            {
              field: "status",
              message:
                "an expired request cannot be decided; request approval again if it is still wanted",
            },
          ]),
        );
      }
      return err(
        approvalError("INVALID_TRANSITION", `this request is already ${request.status}`, [
          { field: "status", message: `a ${request.status} request cannot be decided again` },
        ]),
      );
    }

    // Re-derive the preview and compare it with what was recorded at request
    // time. The request names one immutable version, so a mismatch means the
    // content moved and the decision cannot honestly be attributed to it.
    const underReview = this.drafts.byId(request.draftId, userId);
    if (underReview === null || underReview.workspaceId !== workspaceId) {
      return err(
        approvalError("CONFLICT", "the draft under review is no longer available", [
          {
            field: "draftId",
            message: "the draft version this request names could not be re-read",
          },
        ]),
      );
    }
    const recomputed = previewDigest({
      draftId: request.draftId,
      draftVersion: request.draftVersion,
      subject: underReview.subject,
      body: underReview.body,
    });
    if (recomputed !== request.previewDigest) {
      return err(
        approvalError("PREVIEW_MISMATCH", "the draft content changed after this request was made", [
          {
            field: "previewDigest",
            message:
              "the version under review no longer matches what was previewed; request approval again",
          },
        ]),
      );
    }

    const decidedAt = now.toISOString();
    const decided = this.repo.decideApproval({
      id: request.id,
      userId,
      decision,
      reason: stated === null ? null : bounded(stated, LIMITS.reason),
      decidedAt,
    });
    if (!decided.ok)
      return err(fromStorage(decided.error.code, "the decision could not be recorded"));

    const event = this.repo.createApprovalRequestEvent({
      workspaceId,
      actorUserId: userId,
      event: { approvalId: request.id, kind: decision, detail: stated },
    });
    if (!event.ok) return err(fromStorage(event.error.code, "the decision could not be recorded"));

    return ok({ request: decided.value, event: event.value });
  }

  /** Close a pending request as `expired`, best-effort: the trail is the point. */
  private closeExpired(
    workspaceId: EntityId,
    userId: EntityId,
    request: ApprovalRequest,
    now: Date,
  ): void {
    const closed = this.repo.closeApproval({
      id: request.id,
      userId,
      status: "expired",
      reason: "the request passed its expiry before a decision was recorded",
      decidedAt: now.toISOString(),
    });
    if (!closed.ok) return;
    this.repo.createApprovalRequestEvent({
      workspaceId,
      actorUserId: userId,
      event: {
        approvalId: request.id,
        kind: "expired",
        detail: "the request passed its expiry before a decision was recorded",
      },
    });
  }

  /**
   * Withdraw a pending request.
   *
   * Terminal for this request, and deliberately not a decision: a cancelled
   * request authorizes nothing, and the change the requester wants requires a
   * new draft version and therefore a new request.
   */
  cancelApproval(
    workspaceId: EntityId,
    userId: EntityId,
    approvalId: unknown,
    reason: unknown,
  ): Result<ApprovalRequest, ApprovalError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (typeof approvalId !== "string" || approvalId.trim() === "") {
      return err(
        approvalError("VALIDATION_ERROR", "approvalId is required", [
          { field: "approvalId", message: "approvalId must be a non-empty string" },
        ]),
      );
    }
    const found = this.repo.getApprovalRequest(approvalId, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "approval request not found"));
    const request = found.value;
    if (request.workspaceId !== workspaceId) {
      return err(approvalError("NOT_FOUND", "approval request not found"));
    }
    if (request.status !== "pending") {
      return err(
        approvalError("INVALID_TRANSITION", `this request is already ${request.status}`, [
          { field: "status", message: `only a pending request can be cancelled` },
        ]),
      );
    }

    const now = this.clock();
    const stated = text(reason);
    const closed = this.repo.closeApproval({
      id: request.id,
      userId,
      status: "cancelled",
      reason: stated,
      decidedAt: now.toISOString(),
    });
    if (!closed.ok)
      return err(fromStorage(closed.error.code, "the request could not be cancelled"));

    this.repo.createApprovalRequestEvent({
      workspaceId,
      actorUserId: userId,
      event: { approvalId: request.id, kind: "cancelled", detail: stated },
    });
    return ok(closed.value);
  }

  getApprovalRequest(id: EntityId, userId: EntityId): Result<ApprovalRequest, ApprovalError> {
    if (!id || typeof id !== "string") {
      return err(approvalError("VALIDATION_ERROR", "approval id is required"));
    }
    const found = this.repo.getApprovalRequest(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "approval request not found"));
    return ok(found.value);
  }

  /**
   * A workspace's approval requests, newest first.
   *
   * Nothing is filtered out by default: a rejected, cancelled or expired request
   * stays listable because it is the record of a human saying no, and that is
   * exactly what a later reader needs to see.
   */
  listApprovals(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { draftId?: unknown; status?: unknown; decidedBy?: unknown },
  ): Result<ApprovalRequest[], ApprovalError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.status !== undefined && filter.status !== null && filter.status !== "") {
      if (!isApprovalStatus(filter.status)) {
        return err(
          approvalError("VALIDATION_ERROR", "invalid approval status filter", [
            {
              field: "status",
              message:
                "status must be one of: pending, approved, rejected, changes_requested, cancelled, expired",
            },
          ]),
        );
      }
    }
    if (filter?.decidedBy !== undefined && filter.decidedBy !== null && filter.decidedBy !== "") {
      if (typeof filter.decidedBy !== "string") {
        return err(
          approvalError("VALIDATION_ERROR", "decidedBy must be a string", [
            { field: "decidedBy", message: "decidedBy must be a string" },
          ]),
        );
      }
    }
    if (filter?.draftId !== undefined && filter.draftId !== null && filter.draftId !== "") {
      if (typeof filter.draftId !== "string") {
        return err(
          approvalError("VALIDATION_ERROR", "draftId must be a string", [
            { field: "draftId", message: "draftId must be a string" },
          ]),
        );
      }
    }

    // The validated selectors, and only those. `noUncheckedIndexedAccess` plus
    // three independent validators means each is narrowed before it is used.
    const narrowed: {
      draftId?: EntityId;
      status?: ApprovalRequest["status"];
      decidedBy?: EntityId;
    } = {};
    const requestedDraftId = filter?.draftId;
    const requestedStatus = filter?.status;
    const requestedDecidedBy = filter?.decidedBy;
    if (typeof requestedDraftId === "string" && requestedDraftId !== "") {
      narrowed.draftId = requestedDraftId;
    }
    if (isApprovalStatus(requestedStatus)) narrowed.status = requestedStatus;
    if (typeof requestedDecidedBy === "string" && requestedDecidedBy !== "") {
      narrowed.decidedBy = requestedDecidedBy;
    }

    const listed = this.repo.listApprovalRequests(
      workspaceId,
      userId,
      Object.keys(narrowed).length > 0 ? narrowed : undefined,
    );
    if (!listed.ok) return err(fromStorage(listed.error.code, "approval requests unavailable"));
    return ok(listed.value);
  }

  /**
   * What a reviewer sees: the request plus the exact content of the draft
   * version it is bound to.
   *
   * This is the phase's audit surface. The reviewer is handed the subject, the
   * body, the renderer's warnings and the personalization points' evidence, so
   * "what exactly am I approving?" has an answer that is a stored record rather
   * than a reconstruction.
   */
  previewApproval(id: EntityId, userId: EntityId): Result<ApprovalPreview, ApprovalError> {
    const found = this.getApprovalRequest(id, userId);
    if (!found.ok) return found;
    const request = found.value;
    const draft = this.drafts.byId(request.draftId, userId);
    if (draft === null || draft.workspaceId !== request.workspaceId) {
      return err(
        approvalError("NOT_FOUND", "draft not found", [
          { field: "draftId", message: "no such draft in this workspace" },
        ]),
      );
    }
    return ok({
      request,
      subject: draft.subject,
      body: draft.body,
      warnings: draft.warnings,
    });
  }

  /** The whole audit trail for one request, oldest first. */
  approvalHistory(id: EntityId, userId: EntityId): Result<ApprovalRequestEvent[], ApprovalError> {
    const found = this.getApprovalRequest(id, userId);
    if (!found.ok) return found;
    const events = this.repo.listApprovalRequestEvents(found.value.id, userId);
    if (!events.ok) return err(fromStorage(events.error.code, "approval history unavailable"));
    return ok(events.value);
  }

  /**
   * Does this request currently authorize its action?
   *
   * The single question Phase 11 asks before it calls a provider. `false` for
   * every state that is not an explicit, human, in-date `approved` decision —
   * and `false` is always the safe answer to act on.
   */
  verifyApproval(approvalId: EntityId, userId: EntityId): Result<ApprovalRequest, ApprovalError> {
    const found = this.getApprovalRequest(approvalId, userId);
    if (!found.ok) return found;
    if (!authorizesAction(found.value, this.clock())) {
      const decision = STATUS_DECISION[found.value.status];
      return err(
        approvalError(
          decision === undefined ? "INVALID_TRANSITION" : "CONFLICT",
          `this request is ${found.value.status} and does not authorize the action`,
          [
            {
              field: "status",
              message:
                found.value.status === "pending"
                  ? "no human decision has been recorded yet"
                  : `only an approved request authorizes the action; this one is ${found.value.status}`,
            },
          ],
        ),
      );
    }
    return ok(found.value);
  }

  /** Is this request past its own deadline? `null` when it never expires. */
  isRequestExpired(request: ApprovalRequest): boolean {
    return isExpired(request, this.clock());
  }

  /** The policy this deployment enforces, before any request exists. */
  describeApprovalPolicy(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<ApprovalPolicyView, ApprovalError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeApprovalPolicy());
  }
}
