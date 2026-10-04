import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type { EntityId, OutboundAction, OutboundEvent, OutboundSuppression } from "@dealora/db";

import {
  LIMITS,
  idempotencyKey,
  isDeliverableAddress,
  isOutboundStatus,
  outboundError,
} from "./rules.js";
import { OutboundIssues, authorizesSend, describeOutboundPolicy, text } from "./validation.js";
import { OUTBOUND_CHANNEL } from "./types.js";
import type { OutboundPolicyView } from "./types.js";
import type {
  Clock,
  OutboundApprovalVerifier,
  OutboundContactReader,
  OutboundDraftReader,
  OutboundDraftSnapshot,
  OutboundError,
  OutboundProvider,
  OutboundProviderResolver,
  OutboundRepository,
  OutboundSendResult,
  StageOutboundOptions,
} from "./types.js";

export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";

function fromStorage(code: string, fallback: string): OutboundError {
  switch (code) {
    case "NOT_FOUND":
      return outboundError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return outboundError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return outboundError("CONFLICT", fallback);
    case "INVALID":
      return outboundError("VALIDATION_ERROR", fallback);
    default:
      // Never surface an internal storage message.
      return outboundError("UNAVAILABLE", "storage unavailable");
  }
}

/**
 * The Outbound application service — ROADMAP.md §18.
 *
 * It stages and sends exactly one channel, and it is deliberately the *only*
 * place in the codebase that can call a provider. Everything it guarantees is
 * verified here, in this order, on every single send:
 *
 *   authenticate → authorize → ownership (workspace, draft, contact)
 *   → exact draft version → persisted approval for that exact version
 *   → approval still valid (attributed, in date, not withdrawn)
 *   → deliverable destination → opt-out suppression
 *   → configured provider → not already sent → attempt budget
 *   → provider call → confirm or fail
 *
 * Two properties are worth naming explicitly, because they are the ones this
 * phase exists to establish:
 *
 * - **No autonomous sending.** There is no scheduler, no queue, no timer and no
 *   worker. `send` is only ever called by an authenticated request, and it
 *   refuses unless a human approved this exact draft version first.
 * - **A failure is never a send.** The `sent` state is written from exactly one
 *   place, on a provider confirmation. Every other outcome — a refusal, a thrown
 *   error, a malformed provider answer — records a `failed` action with a
 *   closed failure code and leaves `sentAt` unset, so "it says sent" and "it went
 *   out" can never disagree.
 */
export class OutboundService {
  constructor(
    private readonly repo: OutboundRepository,
    private readonly approvals: OutboundApprovalVerifier,
    private readonly drafts: OutboundDraftReader,
    private readonly contacts: OutboundContactReader,
    private readonly providers: OutboundProviderResolver,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, OutboundError> {
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(outboundError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (typeof userId !== "string" || userId === "") {
      return err(outboundError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * Stage one approved draft version for sending.
   *
   * Staging is not sending: it creates the `ready` record and the `created` audit
   * event, and it verifies the approval *already* covers the exact version being
   * staged — so an action for an unapproved draft cannot be created at all, not
   * merely refused later. Nothing here is provider-owned: there is no input for a
   * status, a provider, a provider reference or a timestamp.
   */
  stageOutbound(
    workspaceId: EntityId,
    userId: EntityId,
    draftId: unknown,
    options?: StageOutboundOptions,
  ): Result<OutboundAction, OutboundError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (typeof draftId !== "string" || draftId.trim() === "") {
      return err(
        outboundError("VALIDATION_ERROR", "draftId is required", [
          { field: "draftId", message: "draftId must be a non-empty string" },
        ]),
      );
    }
    if (options?.draftVersion !== undefined && options.draftVersion !== null) {
      if (typeof options.draftVersion !== "number" || !Number.isInteger(options.draftVersion)) {
        return err(
          outboundError("VALIDATION_ERROR", "draftVersion must be an integer", [
            { field: "draftVersion", message: "draftVersion must be an integer" },
          ]),
        );
      }
    }

    const draft = this.requireDraft(workspaceId, userId, draftId);
    if (!draft.ok) return draft;
    const version =
      typeof options?.draftVersion === "number" && Number.isInteger(options.draftVersion)
        ? options.draftVersion
        : draft.value.version;
    if (version !== draft.value.version) {
      return err(
        outboundError("NOT_FOUND", "that draft version does not exist", [
          {
            field: "draftVersion",
            message: `this draft lineage's newest version is ${draft.value.version}; ${String(version)} does not exist`,
          },
        ]),
      );
    }

    // The approval is located through the workspace's own listing, so an approval
    // from another tenant is simply not in scope.
    const approval = this.requireApprovedDraftVersion(workspaceId, userId, draft.value, version);
    if (!approval.ok) return approval;

    const contactId = draft.value.contactId;
    if (contactId === null) {
      return err(
        outboundError("VALIDATION_ERROR", "this draft names no recipient", [
          { field: "contactId", message: "a send needs a contact to address" },
        ]),
      );
    }
    const contact = this.requireContact(workspaceId, userId, contactId);
    if (!contact.ok) return contact;
    if (contact.value.status !== "active") {
      return err(
        outboundError("CONFLICT", `this contact is ${contact.value.status}`, [
          { field: "contactId", message: "an archived contact is not contacted" },
        ]),
      );
    }
    if (contact.value.email === null || !isDeliverableAddress(contact.value.email)) {
      return err(
        outboundError("VALIDATION_ERROR", "the contact record holds no deliverable address", [
          { field: "email", message: "a send needs a valid recipient address" },
        ]),
      );
    }

    // One approval, one action. A second staging of the same approval returns the
    // existing action rather than creating a duplicate that could be sent twice.
    const existing = this.repo.findOutboundActionByApproval(approval.value.id, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "outbound action unavailable"));
    if (existing.value !== null) return ok(existing.value);

    const created = this.repo.createOutboundAction({
      workspaceId,
      createdBy: userId,
      action: {
        channel: OUTBOUND_CHANNEL,
        draftId: draft.value.id,
        draftVersion: version,
        // The digest of the exact content this action refers to, so the text
        // that was approved and the text that was sent can be compared later.
        draftDigest: digestOfDraft(draft.value),
        approvalId: approval.value.id,
        contactId: contact.value.id,
        // Resolved from the contact record, never from a caller.
        recipientEmail: contact.value.email,
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "outbound action failed"));

    this.repo.createOutboundEvent({
      workspaceId,
      actorUserId: userId,
      event: {
        actionId: created.value.id,
        kind: "created",
        detail: `draft ${created.value.draftId} version ${created.value.draftVersion}, approved by ${approval.value.decidedBy ?? "nobody"}`,
      },
    });
    return ok(created.value);
  }

  /**
   * Send one staged action through the configured provider.
   *
   * This is the only method in the repository that calls a provider, and every
   * precondition below is re-verified here rather than trusted from staging: an
   * approval can be withdrawn, an address can be suppressed and a draft can be
   * regenerated between the two calls, and each of those must stop this send.
   */
  async sendOutbound(
    workspaceId: EntityId,
    userId: EntityId,
    actionId: unknown,
  ): Promise<Result<OutboundSendResult, OutboundError>> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (typeof actionId !== "string" || actionId.trim() === "") {
      return err(
        outboundError("VALIDATION_ERROR", "action id is required", [
          { field: "actionId", message: "action id must be a non-empty string" },
        ]),
      );
    }

    const found = this.repo.getOutboundAction(actionId, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "outbound action not found"));
    const action = found.value;
    if (action.workspaceId !== workspaceId) {
      return err(outboundError("NOT_FOUND", "outbound action not found"));
    }

    // --- the authorization chain, in full, on every send -------------------
    const draft = this.requireDraft(workspaceId, userId, action.draftId);
    if (!draft.ok) return draft;
    if (draft.value.version !== action.draftVersion) {
      return err(
        outboundError("CONFLICT", "the draft has moved past the version this action names", [
          { field: "draftVersion", message: "the approved version is no longer the current one" },
        ]),
      );
    }
    // The message body is read from the immutable draft, never from the action
    // and never from a caller, so what goes out is the text that was reviewed.
    if (digestOfDraft(draft.value) !== action.draftDigest) {
      return err(
        outboundError("CONFLICT", "the draft content no longer matches what was approved", [
          { field: "draftDigest", message: "the approved text cannot be changed before sending" },
        ]),
      );
    }

    const approval = this.approvals.verify(action.approvalId, userId);
    if (approval === null) {
      return err(outboundError("NOT_FOUND", "the approval for this action no longer exists"));
    }
    if (approval.workspaceId !== workspaceId) {
      return err(outboundError("NOT_FOUND", "the approval for this action no longer exists"));
    }

    const existing = this.repo.findOutboundActionByApproval(action.approvalId, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "outbound action unavailable"));
    // The action this send is about, and the action the approval already points
    // at, must be the same record. Storage enforces one action per approval, so
    // they always are — and stating the invariant here means a by-approval lookup
    // can never quietly stand in for the action that was fetched and authorized.
    if (existing.value !== null && existing.value.id !== action.id) {
      return err(
        outboundError("CONFLICT", "this approval is already bound to a different outbound action", [
          { field: "approvalId", message: "one approval authorizes exactly one action" },
        ]),
      );
    }

    const now = this.clock();
    const authorized = authorizesSend({
      approval,
      draftId: action.draftId,
      draftVersion: action.draftVersion,
      draft: {
        id: draft.value.id,
        workspaceId: draft.value.workspaceId,
        version: draft.value.version,
      },
      existing: action,
      now,
    });
    if (!authorized.ok) {
      return err(
        outboundError(authorized.code, authorized.message, [
          { field: "approvalId", message: authorized.detail },
        ]),
      );
    }

    // Ownership of the recipient, re-checked: the contact must still be this
    // workspace's, still active, and still holding the address the action names.
    if (draft.value.contactId === null) {
      return err(outboundError("VALIDATION_ERROR", "this draft names no recipient"));
    }
    const contact = this.requireContact(workspaceId, userId, draft.value.contactId);
    if (!contact.ok) return contact;
    if (contact.value.id !== action.contactId) {
      return err(
        outboundError("CONFLICT", "the recipient changed since this action was staged", [
          { field: "contactId", message: "the staged recipient is no longer the draft's" },
        ]),
      );
    }
    if (contact.value.status !== "active") {
      return err(
        outboundError("CONFLICT", `this contact is ${contact.value.status}`, [
          { field: "contactId", message: "an archived contact is not contacted" },
        ]),
      );
    }
    if (contact.value.email !== action.recipientEmail) {
      return err(
        outboundError("CONFLICT", "the recipient's address changed since this action was staged", [
          {
            field: "recipientEmail",
            message: "stage a new action rather than send a stale address",
          },
        ]),
      );
    }
    if (!isDeliverableAddress(action.recipientEmail)) {
      return err(
        outboundError("VALIDATION_ERROR", "the recipient address is not deliverable", [
          { field: "recipientEmail", message: "a send needs a valid recipient address" },
        ]),
      );
    }

    // Opt-out protection, checked before the provider is resolved and therefore
    // long before it is called.
    const suppressed = this.repo.isSuppressed(workspaceId, userId, action.recipientEmail);
    if (!suppressed.ok)
      return err(fromStorage(suppressed.error.code, "suppression list unavailable"));
    if (suppressed.value) {
      const recorded = this.repo.recordOutboundFailure({
        id: action.id,
        userId,
        provider: "none",
        failureCode: "suppressed",
        failureMessage: "the recipient has opted out of being contacted",
        failedAt: now.toISOString(),
      });
      if (recorded.ok) {
        this.recordEvent(workspaceId, userId, action.id, "failed", "suppressed before send");
      }
      return err(
        outboundError("SUPPRESSED", "the recipient has opted out of being contacted", [
          { field: "recipientEmail", message: "this address is on the workspace's opt-out list" },
        ]),
      );
    }

    // A configured provider, or nothing happens.
    const provider = this.providers.providerFor(action.channel);
    if (provider === null) {
      return err(
        outboundError("PROVIDER_UNAVAILABLE", `no provider is configured for ${action.channel}`, [
          { field: "provider", message: "configure a provider before sending" },
        ]),
      );
    }

    // Mark the attempt *before* calling out, so a process that dies mid-call
    // leaves `sending` behind rather than a `ready` action that looks unsent.
    const attempted = this.repo.recordOutboundAttempt({
      id: action.id,
      userId,
      provider: provider.name,
      attemptedAt: now.toISOString(),
    });
    if (!attempted.ok)
      return err(fromStorage(attempted.error.code, "the send could not be started"));
    this.recordEvent(workspaceId, userId, action.id, "send_attempted", `provider ${provider.name}`);

    // --- the provider call, inside a guard that cannot mark anything sent ----
    let outcome: ProviderOutcome;
    try {
      outcome = await this.callProvider(provider, {
        idempotencyKey: idempotencyKey(action.id),
        to: action.recipientEmail,
        subject: draft.value.subject,
        body: draft.value.body,
      });
    } catch (cause) {
      outcome = {
        accepted: false,
        providerReference: null,
        message: cause instanceof Error ? cause.message : "the provider call failed",
        failureCode: "provider_unavailable",
      };
    }

    if (outcome.accepted) {
      const sent = this.repo.confirmOutboundSent({
        id: action.id,
        userId,
        provider: provider.name,
        // The provider's own reference, or `null`. A provider that confirmed
        // without naming a reference still counts as sent — the confirmation is
        // the fact, the reference is an extra.
        providerReference: outcome.providerReference,
        sentAt: this.clock().toISOString(),
      });
      if (!sent.ok) return err(fromStorage(sent.error.code, "the send could not be recorded"));
      this.recordEvent(
        workspaceId,
        userId,
        action.id,
        "sent",
        outcome.providerReference === null
          ? "confirmed by provider"
          : `provider reference ${outcome.providerReference}`,
      );
      return ok({
        action: sent.value,
        provider: provider.name,
        delivered: true,
        events: this.history(action.id, userId),
      });
    }

    // Anything that is not a confirmation is a failure, and a failure never
    // carries a `sentAt`: the schema constrains that column to `sent` actions.
    const code = outcome.failureCode ?? "provider_rejected";
    const failed = this.repo.recordOutboundFailure({
      id: action.id,
      userId,
      provider: provider.name,
      failureCode: code,
      failureMessage: outcome.message,
      failedAt: this.clock().toISOString(),
    });
    if (!failed.ok) return err(fromStorage(failed.error.code, "the failure could not be recorded"));
    this.recordEvent(workspaceId, userId, action.id, "failed", `${code}: ${outcome.message}`);
    return err(
      outboundError("PROVIDER_FAILED", "the provider did not accept the message", [
        { field: "status", message: `${code}: ${outcome.message}` },
      ]),
    );
  }

  /**
   * Call a provider and validate what it says.
   *
   * The validation is the point: a provider that returns neither a confirmation
   * nor a known refusal code has not confirmed anything, and the only safe
   * reading of that is a failure.
   */
  private async callProvider(
    provider: OutboundProvider,
    message: { idempotencyKey: string; to: string; subject: string; body: string },
  ): Promise<ProviderOutcome> {
    const result = await provider.send(message);
    if (result === null || typeof result !== "object") {
      return {
        accepted: false,
        providerReference: null,
        message: "the provider returned no result",
        failureCode: "provider_unavailable",
      };
    }
    if (result.accepted === true) {
      return {
        accepted: true,
        providerReference:
          typeof result.providerReference === "string" ? result.providerReference : null,
        message: typeof result.message === "string" ? result.message : "",
        failureCode: null,
      };
    }
    // A refusal must name a code the system actually has. An unrecognised one is
    // reported as a generic provider refusal rather than invented into the
    // vocabulary.
    const code =
      result.failureCode === "invalid_recipient" ||
      result.failureCode === "provider_rejected" ||
      result.failureCode === "rate_limited" ||
      result.failureCode === "suppressed" ||
      result.failureCode === "provider_unavailable"
        ? result.failureCode
        : "provider_rejected";
    return {
      accepted: false,
      providerReference: null,
      message:
        typeof result.message === "string" ? result.message : "the provider refused the message",
      failureCode: code,
    };
  }

  /** Withdraw a staged action before any provider call. Terminal. */
  cancelOutbound(
    workspaceId: EntityId,
    userId: EntityId,
    actionId: unknown,
    reason: unknown,
  ): Result<OutboundAction, OutboundError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (typeof actionId !== "string" || actionId.trim() === "") {
      return err(
        outboundError("VALIDATION_ERROR", "action id is required", [
          { field: "actionId", message: "action id must be a non-empty string" },
        ]),
      );
    }
    const issues = new OutboundIssues();
    const stated = text(reason, LIMITS.suppressionReason);
    if (reason !== undefined && reason !== null && stated === null) {
      issues.add("reason", "reason must be a non-empty string when given");
    }
    if (issues.length > 0) {
      return err(outboundError("VALIDATION_ERROR", "the cancellation is not valid", issues.all()));
    }

    const found = this.repo.getOutboundAction(actionId, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "outbound action not found"));
    if (found.value.workspaceId !== workspaceId) {
      return err(outboundError("NOT_FOUND", "outbound action not found"));
    }

    const now = this.clock().toISOString();
    const cancelled = this.repo.cancelOutboundAction(actionId, userId, stated, now);
    if (!cancelled.ok)
      return err(fromStorage(cancelled.error.code, "the action could not be cancelled"));
    this.recordEvent(
      workspaceId,
      userId,
      actionId,
      "cancelled",
      stated ?? "withdrawn before any send",
    );
    return ok(cancelled.value);
  }

  getOutbound(id: EntityId, userId: EntityId): Result<OutboundAction, OutboundError> {
    if (typeof id !== "string" || id === "") {
      return err(outboundError("VALIDATION_ERROR", "action id is required"));
    }
    const found = this.repo.getOutboundAction(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "outbound action not found"));
    return ok(found.value);
  }

  /** A workspace's actions, newest first, optionally narrowed by status. */
  listOutbound(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: unknown; draftId?: unknown; approvalId?: unknown },
  ): Result<OutboundAction[], OutboundError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const rawStatus = filter?.status;
    if (rawStatus !== undefined && rawStatus !== null && rawStatus !== "") {
      if (!isOutboundStatus(rawStatus)) {
        return err(
          outboundError("VALIDATION_ERROR", "invalid status filter", [
            {
              field: "status",
              message: "status must be one of: ready, sending, sent, failed, cancelled",
            },
          ]),
        );
      }
    }
    const rawDraft = filter?.draftId;
    const rawApproval = filter?.approvalId;
    if (
      rawDraft !== undefined &&
      rawDraft !== null &&
      rawDraft !== "" &&
      typeof rawDraft !== "string"
    ) {
      return err(
        outboundError("VALIDATION_ERROR", "draftId must be a string", [
          { field: "draftId", message: "draftId must be a string" },
        ]),
      );
    }
    if (
      rawApproval !== undefined &&
      rawApproval !== null &&
      rawApproval !== "" &&
      typeof rawApproval !== "string"
    ) {
      return err(
        outboundError("VALIDATION_ERROR", "approvalId must be a string", [
          { field: "approvalId", message: "approvalId must be a string" },
        ]),
      );
    }
    // `noUncheckedIndexedAccess` plus three independent validators: each selector
    // is narrowed to its concrete type before it is used.
    const narrowed: {
      status?: OutboundAction["status"];
      draftId?: EntityId;
      approvalId?: EntityId;
    } = {};
    if (isOutboundStatus(rawStatus)) {
      narrowed.status = rawStatus;
    }
    if (typeof rawDraft === "string" && rawDraft !== "") narrowed.draftId = rawDraft;
    if (typeof rawApproval === "string" && rawApproval !== "") narrowed.approvalId = rawApproval;

    const listed = this.repo.listOutboundActions(
      workspaceId,
      userId,
      Object.keys(narrowed).length > 0 ? narrowed : undefined,
    );
    if (!listed.ok) return err(fromStorage(listed.error.code, "outbound actions unavailable"));
    return ok(listed.value);
  }

  /** One action's audit trail, oldest first. */
  actionHistory(id: EntityId, userId: EntityId): Result<OutboundEvent[], OutboundError> {
    const found = this.getOutbound(id, userId);
    if (!found.ok) return found;
    const events = this.repo.listOutboundEvents(found.value.id, userId);
    if (!events.ok) return err(fromStorage(events.error.code, "outbound history unavailable"));
    return ok(events.value);
  }

  /**
   * Add an address to the workspace's opt-out list.
   *
   * Permanent and idempotent: the same address twice returns the one record, so
   * the list a workspace is asked to honour stays auditable.
   */
  suppress(
    workspaceId: EntityId,
    userId: EntityId,
    email: unknown,
    reason: unknown,
  ): Result<OutboundSuppression, OutboundError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const issues = new OutboundIssues();
    if (typeof email !== "string" || email.trim() === "") {
      issues.add("email", "email must be a non-empty string");
    } else if (!isDeliverableAddress(email.trim())) {
      issues.add("email", "email must be a valid address");
    }
    const stated = text(reason, LIMITS.suppressionReason);
    if (stated === null) {
      issues.add("reason", "a suppression must say why");
    }
    if (issues.length > 0) {
      return err(outboundError("VALIDATION_ERROR", "the suppression is not valid", issues.all()));
    }

    const created = this.repo.createOutboundSuppression({
      workspaceId,
      createdBy: userId,
      suppression: { email: (email as string).trim().toLowerCase(), reason: stated as string },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "suppression failed"));
    return ok(created.value);
  }

  listSuppressions(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<OutboundSuppression[], OutboundError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const listed = this.repo.listOutboundSuppressions(workspaceId, userId);
    if (!listed.ok) return err(fromStorage(listed.error.code, "suppression list unavailable"));
    return ok(listed.value);
  }

  /** Is this address currently suppressed in this workspace? */
  isSuppressed(
    workspaceId: EntityId,
    userId: EntityId,
    email: unknown,
  ): Result<boolean, OutboundError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (typeof email !== "string" || email.trim() === "") {
      return err(
        outboundError("VALIDATION_ERROR", "email must be a non-empty string", [
          { field: "email", message: "email must be a non-empty string" },
        ]),
      );
    }
    const checked = this.repo.isSuppressed(workspaceId, userId, email.trim());
    if (!checked.ok) return err(fromStorage(checked.error.code, "suppression list unavailable"));
    return ok(checked.value);
  }

  /** What this deployment enforces, readable before anything has been sent. */
  policy(workspaceId: EntityId, userId: EntityId): Result<OutboundPolicyView, OutboundError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeOutboundPolicy(OUTBOUND_CHANNEL));
  }

  /** Which providers this deployment has configured. Never a credential. */
  configuredProviders(): string[] {
    return this.providers.configuredProviders();
  }

  /**
   * The approval covering an exact draft version, in this workspace.
   *
   * Found through the workspace's own approvals rather than by guessing an id,
   * so another tenant's approval is out of scope by construction.
   */
  private requireApprovedDraftVersion(
    workspaceId: EntityId,
    userId: EntityId,
    draft: OutboundDraftSnapshot,
    version: number,
  ): Result<{ id: string; decidedBy: string | null }, OutboundError> {
    const approval = this.approvals.findApprovedForDraftVersion(
      workspaceId,
      userId,
      draft.id,
      version,
    );
    if (approval === null) {
      return err(
        outboundError("UNAPPROVED", "no approval covers this draft version", [
          {
            field: "draftId",
            message: `request an approval for draft version ${version} before staging it for sending`,
          },
        ]),
      );
    }
    if (approval.status !== "approved") {
      return err(
        outboundError(
          "UNAPPROVED",
          `this approval is ${approval.status} and does not authorize a send`,
          [
            {
              field: "draftId",
              message:
                approval.status === "pending"
                  ? "no human decision has been recorded yet"
                  : `only an approved request authorizes a send; this one is ${approval.status}`,
            },
          ],
        ),
      );
    }
    return ok({ id: approval.id, decidedBy: approval.decidedBy });
  }

  private requireDraft(
    workspaceId: EntityId,
    userId: EntityId,
    draftId: string,
  ): Result<OutboundDraftSnapshot, OutboundError> {
    const draft = this.drafts.byId(draftId, userId);
    if (draft === null) {
      return err(
        outboundError("NOT_FOUND", "draft not found", [
          { field: "draftId", message: "no such draft in this workspace" },
        ]),
      );
    }
    if (draft.workspaceId !== workspaceId) {
      // Never confirm that another workspace's draft exists.
      return err(outboundError("NOT_FOUND", "draft not found"));
    }
    return ok(draft);
  }

  private requireContact(
    workspaceId: EntityId,
    userId: EntityId,
    contactId: EntityId,
  ): Result<
    {
      id: EntityId;
      workspaceId: EntityId;
      accountId: EntityId;
      email: string | null;
      status: string;
    },
    OutboundError
  > {
    const contact = this.contacts.byId(contactId, userId);
    if (contact === null) {
      return err(
        outboundError("NOT_FOUND", "contact not found", [
          { field: "contactId", message: "no such contact in this workspace" },
        ]),
      );
    }
    if (contact.workspaceId !== workspaceId) {
      return err(outboundError("NOT_FOUND", "contact not found"));
    }
    return ok(contact);
  }

  /** One action's events, oldest first; empty when storage cannot answer. */
  private history(actionId: EntityId, userId: EntityId): OutboundEvent[] {
    const events = this.repo.listOutboundEvents(actionId, userId);
    return events.ok ? events.value : [];
  }

  /**
   * Write one audit event, best-effort.
   *
   * The trail is important but it is not the send: refusing to report a delivery
   * because the trail write failed would be the wrong trade, and the action row
   * already carries the outcome.
   */
  private recordEvent(
    workspaceId: EntityId,
    userId: EntityId,
    actionId: EntityId,
    kind: OutboundEvent["kind"],
    detail: string,
  ): void {
    this.repo.createOutboundEvent({
      workspaceId,
      actorUserId: userId,
      event: { actionId, kind, detail },
    });
  }
}

/** What a provider call resolved to, after validation. */
interface ProviderOutcome {
  accepted: boolean;
  providerReference: string | null;
  message: string;
  failureCode: OutboundAction["failureCode"];
}

/**
 * Digest of the exact content an action refers to.
 *
 * FNV-1a over a key-sorted canonical JSON of the identity, version, subject and
 * body — the same construction the approval boundary uses for its preview digest,
 * so "the text that was approved" and "the text that was sent" are comparable by
 * a value rather than by an assumption.
 */
function digestOfDraft(draft: OutboundDraftSnapshot): string {
  const canonical = JSON.stringify({
    body: draft.body,
    draftId: draft.id,
    draftVersion: draft.version,
    subject: draft.subject,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}
