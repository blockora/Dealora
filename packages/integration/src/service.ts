/**
 * The CRM Integrations service — every Phase 23 route's behavior
 * (ROADMAP.md §30).
 *
 * The service validates, authorizes and answers. Identity fields
 * (`workspaceId`, `userId`, every decision instant, every execution instant,
 * every status) come from the caller's server-resolved session and storage's
 * own transitions, so a request body that carries a `status`, a `decision`, a
 * `decidedBy`, an `executedBy` or a scope list of its choosing is ignored in
 * those places rather than believed — the same contract Phases 10–22
 * published.
 *
 * The Level 2 boundary (`DEALORA_BLUEPRINT.md` §17, "update CRM") is
 * structural rather than procedural:
 *
 * - a change-set is derived from this workspace's rows, frozen, and
 *   digested — never supplied by a caller;
 * - a decision re-derives the digest from the stored document and refuses a
 *   mismatch, so an approval can only mean "I approved *this* payload";
 * - execution re-checks the digest, the connection's revocation and the
 *   granted scopes **again** before reaching the adapter, because any of the
 *   three can change between approval and execution;
 * - only the adapter's own confirmation can produce `executed`, and a
 *   refusal is recorded as `failed` with a closed code rather than invented;
 * - the registry resolves the adapter by id — an unknown or non-CRM adapter
 *   answers nothing and the sync fails closed instead of defaulting.
 *
 * Fail-closed everywhere else too: an unknown scope name is refused, an
 * archived account is not synchronized, a foreign id is a NOT_FOUND, and an
 * unauthorized caller sees UNAUTHORIZED before anything else happens.
 */

import type { Result } from "@dealora/core";
import { ok, err } from "@dealora/core";
import type {
  CrmChangeSet,
  CrmSyncDecision,
  CrmSyncFailureCode,
  CrmSyncStatus,
  IntegrationPermissionScope,
} from "@dealora/db";

import { deriveCrmChangeSet } from "./engine.js";
import {
  changeSetDigest,
  CRM_OPERATION_SCOPE,
  describeIntegrationPolicy,
  INTEGRATION_LIMITS,
  INTEGRATION_SCOPE_CATALOG,
  integrationError,
} from "./rules.js";
import type {
  CrmSyncEventView,
  CrmSyncView,
  IntegrationAdapterView,
  IntegrationConnectionView,
  IntegrationError,
  IntegrationLookup,
  IntegrationRegistry,
} from "./types.js";

/** The write commands a caller may send. No status, decision or identity field exists. */
export interface ConnectIntegrationInput {
  readonly adapterId: unknown;
  readonly scopes: unknown;
}

export interface PrepareCrmSyncInput {
  readonly connectionId: unknown;
  readonly accountId: unknown;
}

export interface DecideCrmSyncInput {
  readonly decision: unknown;
  readonly reason: unknown;
}

export interface CancelCrmSyncInput {
  readonly reason: unknown;
}

export class IntegrationService {
  constructor(
    private readonly lookup: IntegrationLookup,
    private readonly registry: IntegrationRegistry,
  ) {}

  /** Authorize the caller against the workspace using server-side identity. */
  private guard(workspaceId: string, userId: string): Result<true, IntegrationError> {
    if (typeof workspaceId !== "string" || workspaceId === "") {
      return err(integrationError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (typeof userId !== "string" || userId === "") {
      return err(integrationError("VALIDATION_ERROR", "user id is required"));
    }
    const auth = this.lookup.authorize(workspaceId, userId);
    if (!auth.ok) {
      return err(integrationError("UNAUTHORIZED", "not a member of this workspace"));
    }
    return ok(true);
  }

  /** Map a storage refusal onto the domain vocabulary without leaking details. */
  private fromStorage(
    error: { readonly code: string; readonly message?: string },
    fallback: string,
  ): IntegrationError {
    switch (error.code) {
      case "NOT_FOUND":
        return integrationError("NOT_FOUND", fallback);
      case "CONFLICT":
        return integrationError("CONFLICT", error.message ?? fallback);
      case "INVALID":
      case "VALIDATION_ERROR":
        return integrationError("VALIDATION_ERROR", error.message ?? fallback);
      case "UNAUTHORIZED":
        return integrationError("UNAUTHORIZED", "not a member of this workspace");
      default:
        return integrationError("UNAVAILABLE", "integration storage is unavailable");
    }
  }

  /** The published rule set: systems, scopes, per-operation scopes, refusals. */
  policy(
    workspaceId: string,
    userId: string,
  ): Result<ReturnType<typeof describeIntegrationPolicy>, IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeIntegrationPolicy());
  }

  /**
   * Every adapter this deployment registered, as catalog rows. Scoped to a
   * workspace read like every other route, but it answers only identities —
   * no connection, no scope grant, nothing another tenant could learn.
   */
  listAdapters(
    workspaceId: string,
    userId: string,
  ): Result<readonly IntegrationAdapterView[], IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(
      this.registry.list().map((adapter) => ({
        id: adapter.id,
        system: adapter.system,
        displayName: adapter.displayName,
        sandbox: adapter.sandbox,
        scopes: [...adapter.scopes],
      })),
    );
  }

  /**
   * Connect one registered adapter with an explicit scope grant.
   *
   * The adapter must exist in this deployment's registry — a connection to
   * an unknown id is refused rather than stored as a promise — and every
   * requested scope must be both in the published catalog and declared by
   * that adapter. Nothing is granted implicitly: the stored grant is exactly
   * what the caller asked for, and `status`, `createdBy` and `createdAt` are
   * storage's to write.
   */
  connect(
    workspaceId: string,
    userId: string,
    input: ConnectIntegrationInput,
  ): Result<IntegrationConnectionView, IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const adapterId = typeof input.adapterId === "string" ? input.adapterId.trim() : "";
    if (adapterId === "" || adapterId.length > INTEGRATION_LIMITS.adapterIdMax) {
      return err(
        integrationError(
          "VALIDATION_ERROR",
          `adapterId must be ${INTEGRATION_LIMITS.adapterIdMin} to ${INTEGRATION_LIMITS.adapterIdMax} characters`,
        ),
      );
    }
    const adapter = this.registry.get(adapterId);
    if (adapter === null) {
      return err(
        integrationError("NOT_FOUND", "no adapter with that id is configured in this deployment"),
      );
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      return err(integrationError("VALIDATION_ERROR", "at least one permission scope is required"));
    }
    const granted: IntegrationPermissionScope[] = [];
    for (const entry of input.scopes) {
      if (typeof entry !== "string") {
        return err(integrationError("VALIDATION_ERROR", "permission scopes must be strings"));
      }
      const known = INTEGRATION_SCOPE_CATALOG.find((row) => row.scope === entry);
      if (known === undefined) {
        return err(
          integrationError("VALIDATION_ERROR", `unknown permission scope: ${entry}`, [
            { field: "scopes", message: `unknown permission scope: ${entry}` },
          ]),
        );
      }
      if (!(adapter.scopes as readonly string[]).includes(entry)) {
        return err(
          integrationError(
            "VALIDATION_ERROR",
            `adapter ${adapter.id} does not declare the scope ${entry}`,
            [{ field: "scopes", message: `${entry} is not offered by this adapter` }],
          ),
        );
      }
      if (granted.includes(known.scope)) {
        return err(integrationError("VALIDATION_ERROR", `duplicate permission scope: ${entry}`));
      }
      granted.push(known.scope);
    }

    const created = this.lookup.connectIntegration({
      workspaceId,
      userId,
      adapterId,
      system: adapter.system,
      grantedScopes: granted,
    });
    if (!created.ok) {
      return err(this.fromStorage(created.error, "connection could not be created"));
    }
    return ok(toConnectionView(created.value));
  }

  /** Every connection in this workspace, connected-at then id. */
  listConnections(
    workspaceId: string,
    userId: string,
  ): Result<readonly IntegrationConnectionView[], IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const listed = this.lookup.listIntegrationConnections(workspaceId, userId);
    if (!listed.ok) {
      return err(this.fromStorage(listed.error, "connections could not be listed"));
    }
    return ok(listed.value.map(toConnectionView));
  }

  /**
   * Revoke a connection. Terminal: an approved-but-unexecuted sync can
   * never ride a revoked connection back into scope, because execution
   * re-checks this exact status.
   */
  disconnect(
    workspaceId: string,
    userId: string,
    connectionId: string,
  ): Result<IntegrationConnectionView, IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (typeof connectionId !== "string" || connectionId === "") {
      return err(integrationError("VALIDATION_ERROR", "connectionId is required"));
    }
    const revoked = this.lookup.revokeIntegrationConnection({ workspaceId, userId, connectionId });
    if (!revoked.ok) {
      return err(this.fromStorage(revoked.error, "connection could not be revoked"));
    }
    return ok(toConnectionView(revoked.value));
  }

  /**
   * Freeze the derived change-set for one account as a prepared Level 2
   * action.
   *
   * Nothing in the payload comes from the caller: the account, its contacts,
   * its qualifications, its sends, its replies and its meetings are read
   * through workspace-scoped lookups and derived by the engine. The service
   * refuses *before* preparing when the connection is revoked, the account
   * is archived, the rows disagree with their own vocabulary, the change-set
   * would be empty, or the change-set needs a scope this connection does not
   * grant — a missing scope is a refusal with its name, never a silent
   * partial sync.
   */
  prepare(
    workspaceId: string,
    userId: string,
    input: PrepareCrmSyncInput,
  ): Result<CrmSyncView, IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
    const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
    if (connectionId === "") {
      return err(integrationError("VALIDATION_ERROR", "connectionId is required"));
    }
    if (accountId === "") {
      return err(integrationError("VALIDATION_ERROR", "accountId is required"));
    }

    const connection = this.lookup.getIntegrationConnection({
      workspaceId,
      userId,
      connectionId,
    });
    if (!connection.ok) {
      return err(this.fromStorage(connection.error, "connection not found"));
    }
    if (connection.value === null) {
      return err(integrationError("NOT_FOUND", "connection not found"));
    }
    if (connection.value.status !== "active") {
      return err(integrationError("CONFLICT", "this connection is revoked"));
    }
    const adapter = this.registry.crm(connection.value.adapterId);
    if (adapter === null) {
      return err(
        integrationError(
          "CONFLICT",
          "no adapter is configured for this connection in this deployment",
        ),
      );
    }

    const account = this.lookup.getAccount(accountId, userId);
    if (!account.ok) {
      return err(this.fromStorage(account.error, "account not found"));
    }
    if (account.value === null) {
      return err(integrationError("NOT_FOUND", "account not found"));
    }
    if (account.value.status !== "active") {
      return err(
        integrationError("VALIDATION_ERROR", "archived accounts are not synchronized to a CRM"),
      );
    }

    const contacts = this.lookup.listContacts(workspaceId, userId);
    if (!contacts.ok) {
      return err(this.fromStorage(contacts.error, "workspace contacts could not be listed"));
    }
    const qualifications = this.lookup.listQualifications(workspaceId, userId);
    if (!qualifications.ok) {
      return err(
        this.fromStorage(qualifications.error, "workspace qualifications could not be listed"),
      );
    }
    const actions = this.lookup.listOutboundActions(workspaceId, userId);
    if (!actions.ok) {
      return err(this.fromStorage(actions.error, "workspace actions could not be listed"));
    }
    const classifications = this.lookup.listConversationClassifications(workspaceId, userId);
    if (!classifications.ok) {
      return err(
        this.fromStorage(classifications.error, "workspace classifications could not be listed"),
      );
    }
    const meetings = this.lookup.listMeetings(workspaceId, userId);
    if (!meetings.ok) {
      return err(this.fromStorage(meetings.error, "workspace meetings could not be listed"));
    }

    const changeSet = deriveCrmChangeSet({
      account: account.value,
      contacts: contacts.value,
      qualifications: qualifications.value,
      actions: actions.value,
      classifications: classifications.value,
      meetings: meetings.value,
    });
    if (changeSet === null) {
      return err(
        integrationError(
          "UNAVAILABLE",
          "the stored rows for this account are outside the CRM vocabulary; nothing was prepared",
        ),
      );
    }
    if (changeSet.operations.length > INTEGRATION_LIMITS.operationsMax) {
      return err(
        integrationError(
          "VALIDATION_ERROR",
          `a change-set may carry at most ${INTEGRATION_LIMITS.operationsMax} operations`,
        ),
      );
    }

    // Fail-closed scope check: the union of what this change-set needs must
    // be granted by this connection, named one by one on refusal.
    const missing = missingScopes(changeSet, connection.value.grantedScopes);
    if (missing.length > 0) {
      return err(
        integrationError(
          "CONFLICT",
          `this connection does not grant: ${missing.join(", ")}`,
          missing.map((scope) => ({ field: "scopes", message: `missing scope: ${scope}` })),
        ),
      );
    }

    const digest = changeSetDigest({ changeSet, connectionId: connection.value.id });
    const prepared = this.lookup.prepareCrmSync({
      workspaceId,
      userId,
      connectionId: connection.value.id,
      accountId,
      changeSet,
      previewDigest: digest,
    });
    if (!prepared.ok) {
      return err(this.fromStorage(prepared.error, "sync could not be prepared"));
    }
    return ok(toSyncView(prepared.value));
  }

  /** One sync read back complete, with the exact change-set and digest. */
  get(workspaceId: string, userId: string, syncId: string): Result<CrmSyncView, IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const found = this.lookup.getCrmSync({ workspaceId, userId, syncId });
    if (!found.ok) {
      return err(this.fromStorage(found.error, "sync not found"));
    }
    if (found.value === null) {
      return err(integrationError("NOT_FOUND", "sync not found"));
    }
    return ok(toSyncView(found.value));
  }

  /** Every sync in this workspace, optionally narrowed by status or account. */
  list(
    workspaceId: string,
    userId: string,
    status: unknown,
    accountId: unknown,
  ): Result<readonly CrmSyncView[], IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    let filter: { readonly status?: CrmSyncStatus; readonly accountId?: string } = {};
    if (status !== undefined && status !== null) {
      const narrowed = syncStatusVocabulary(status);
      if (narrowed === null) {
        return err(
          integrationError(
            "VALIDATION_ERROR",
            `status must be one of: ${["prepared", "approved", "rejected", "cancelled", "executed", "failed"].join(", ")}`,
          ),
        );
      }
      filter = { ...filter, status: narrowed };
    }
    if (accountId !== undefined && accountId !== null) {
      if (typeof accountId !== "string" || accountId === "") {
        return err(integrationError("VALIDATION_ERROR", "accountId must be a non-empty string"));
      }
      filter = { ...filter, accountId };
    }
    const listed = this.lookup.listCrmSyncs(workspaceId, userId, filter);
    if (!listed.ok) {
      return err(this.fromStorage(listed.error, "syncs could not be listed"));
    }
    return ok(listed.value.map(toSyncView));
  }

  /**
   * Record a human decision on a prepared sync.
   *
   * The digest is re-derived from the stored change-set **here**, before
   * storage compares it again: if the prepared document no longer matches
   * what was previewed, the decision is refused rather than recorded against
   * a payload the reviewer never saw. `reject` must say why. The reviewer's
   * identity and instant are the session's and the server's — a body
   * carrying `decidedBy` never reaches this method's write.
   */
  decide(
    workspaceId: string,
    userId: string,
    syncId: string,
    input: DecideCrmSyncInput,
  ): Result<CrmSyncView, IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    if (input.decision !== "approve" && input.decision !== "reject") {
      return err(integrationError("VALIDATION_ERROR", "decision must be approve or reject"));
    }
    let reason: string | null = null;
    if (input.reason !== undefined && input.reason !== null) {
      if (typeof input.reason !== "string") {
        return err(integrationError("VALIDATION_ERROR", "reason must be null or a string"));
      }
      const trimmed = input.reason.trim();
      if (trimmed.length > INTEGRATION_LIMITS.decisionReasonMax) {
        return err(
          integrationError(
            "VALIDATION_ERROR",
            `reason must be at most ${INTEGRATION_LIMITS.decisionReasonMax} characters`,
          ),
        );
      }
      reason = trimmed === "" ? null : trimmed;
    }
    if (input.decision === "reject" && reason === null) {
      return err(integrationError("VALIDATION_ERROR", "a rejection must say why"));
    }

    const found = this.lookup.getCrmSync({ workspaceId, userId, syncId });
    if (!found.ok) {
      return err(this.fromStorage(found.error, "sync not found"));
    }
    if (found.value === null) {
      return err(integrationError("NOT_FOUND", "sync not found"));
    }
    const recomputed = changeSetDigest({
      changeSet: found.value.changeSet,
      connectionId: found.value.connectionId,
    });
    if (recomputed !== found.value.previewDigest) {
      return err(
        integrationError("CONFLICT", "the change-set no longer matches what was previewed"),
      );
    }

    const decided = this.lookup.decideCrmSync({
      workspaceId,
      userId,
      syncId,
      decision: input.decision === "approve" ? "approved" : "rejected",
      reason,
      previewDigest: recomputed,
    });
    if (!decided.ok) {
      return err(this.fromStorage(decided.error, "decision could not be recorded"));
    }
    return ok(toSyncView(decided.value));
  }

  /**
   * Execute an approved sync through its adapter.
   *
   * Every precondition is re-derived here rather than trusted from the row's
   * status alone: the digest still matches the preview, the connection is
   * still active, the adapter is still registered and still CRM-capable, and
   * the connection still grants every scope the change-set needs. Only then
   * is the adapter called, with the sync's own id as the idempotency key.
   *
   * An adapter confirmation (with its own reference) is the only thing that
   * produces `executed`; a refusal is recorded as `failed` with a closed
   * code, answered to the caller as a *successful read of that state* so the
   * failure is observable rather than exceptional. A retry from `failed`
   * repeats the same checks and the same idempotency key, so one approval
   * can never apply twice.
   */
  async execute(
    workspaceId: string,
    userId: string,
    syncId: string,
  ): Promise<Result<CrmSyncView, IntegrationError>> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const found = this.lookup.getCrmSync({ workspaceId, userId, syncId });
    if (!found.ok) {
      return err(this.fromStorage(found.error, "sync not found"));
    }
    if (found.value === null) {
      return err(integrationError("NOT_FOUND", "sync not found"));
    }
    const row = found.value;
    if (row.status !== "approved" && row.status !== "failed") {
      if (row.status === "prepared") {
        return err(
          integrationError(
            "CONFLICT",
            "this sync must be approved by a person before it reaches a CRM",
          ),
        );
      }
      return err(integrationError("CONFLICT", `a ${row.status} sync cannot be executed`));
    }
    if (row.decidedBy === null || row.decidedAt === null) {
      return err(
        integrationError("UNAVAILABLE", "this sync has no recorded decision; nothing was sent"),
      );
    }

    const recomputed = changeSetDigest({
      changeSet: row.changeSet,
      connectionId: row.connectionId,
    });
    if (recomputed !== row.previewDigest) {
      return err(
        integrationError("CONFLICT", "the change-set no longer matches what was previewed"),
      );
    }

    const connection = this.lookup.getIntegrationConnection({
      workspaceId,
      userId,
      connectionId: row.connectionId,
    });
    if (!connection.ok) {
      return err(this.fromStorage(connection.error, "connection not found"));
    }
    if (connection.value === null) {
      return err(integrationError("NOT_FOUND", "connection not found"));
    }
    if (connection.value.status !== "active") {
      return err(
        integrationError("CONFLICT", "the connection for this sync was revoked after approval"),
      );
    }
    const adapter = this.registry.crm(connection.value.adapterId);
    if (adapter === null) {
      return err(
        integrationError(
          "CONFLICT",
          "no adapter is configured for this connection in this deployment",
        ),
      );
    }
    const missing = missingScopes(row.changeSet, connection.value.grantedScopes);
    if (missing.length > 0) {
      return err(
        integrationError(
          "CONFLICT",
          `this connection no longer grants: ${missing.join(", ")}`,
          missing.map((scope) => ({ field: "scopes", message: `missing scope: ${scope}` })),
        ),
      );
    }

    const outcome = await adapter.applyChangeSet({
      idempotencyKey: row.id,
      adapterId: adapter.id,
      accountId: row.accountId,
      approvedBy: row.decidedBy,
      approvedAt: row.decidedAt,
      changeSet: row.changeSet,
    });

    if (outcome.accepted) {
      const reference = outcome.providerReference;
      if (reference === null || reference === "") {
        // An adapter that accepts without a reference has not confirmed
        // anything traceable: record a failure rather than trust it.
        const recorded = this.lookup.recordCrmSyncOutcome({
          workspaceId,
          userId,
          syncId,
          outcome: "failed",
          providerReference: null,
          failureCode: "adapter_unavailable",
          failureMessage: "the adapter accepted without a reference",
        });
        if (!recorded.ok) {
          return err(this.fromStorage(recorded.error, "outcome could not be recorded"));
        }
        return ok(toSyncView(recorded.value));
      }
      const recorded = this.lookup.recordCrmSyncOutcome({
        workspaceId,
        userId,
        syncId,
        outcome: "executed",
        providerReference: reference,
        failureCode: null,
        failureMessage: null,
      });
      if (!recorded.ok) {
        return err(this.fromStorage(recorded.error, "outcome could not be recorded"));
      }
      return ok(toSyncView(recorded.value));
    }

    const failureCode: CrmSyncFailureCode = outcome.failureCode ?? "adapter_unavailable";
    const recorded = this.lookup.recordCrmSyncOutcome({
      workspaceId,
      userId,
      syncId,
      outcome: "failed",
      providerReference: null,
      failureCode,
      failureMessage: outcome.message,
    });
    if (!recorded.ok) {
      return err(this.fromStorage(recorded.error, "outcome could not be recorded"));
    }
    return ok(toSyncView(recorded.value));
  }

  /** Withdraw a sync before execution. Terminal afterwards. */
  cancel(
    workspaceId: string,
    userId: string,
    syncId: string,
    input: CancelCrmSyncInput,
  ): Result<CrmSyncView, IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    let reason: string | null = null;
    if (input.reason !== undefined && input.reason !== null) {
      if (typeof input.reason !== "string") {
        return err(integrationError("VALIDATION_ERROR", "reason must be null or a string"));
      }
      const trimmed = input.reason.trim();
      if (trimmed.length > INTEGRATION_LIMITS.cancelReasonMax) {
        return err(
          integrationError(
            "VALIDATION_ERROR",
            `reason must be at most ${INTEGRATION_LIMITS.cancelReasonMax} characters`,
          ),
        );
      }
      reason = trimmed === "" ? null : trimmed;
    }

    const cancelled = this.lookup.cancelCrmSync({ workspaceId, userId, syncId, reason });
    if (!cancelled.ok) {
      return err(this.fromStorage(cancelled.error, "sync could not be cancelled"));
    }
    return ok(toSyncView(cancelled.value));
  }

  /** One sync's append-only lifecycle trail, oldest first. */
  history(
    workspaceId: string,
    userId: string,
    syncId: string,
  ): Result<readonly CrmSyncEventView[], IntegrationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const listed = this.lookup.listCrmSyncEvents(workspaceId, userId, syncId);
    if (!listed.ok) {
      return err(this.fromStorage(listed.error, "sync events could not be listed"));
    }
    return ok(listed.value.map(toEventView));
  }
}

/** The unique scopes a change-set needs, minus what the connection grants. */
function missingScopes(
  changeSet: CrmChangeSet,
  granted: readonly IntegrationPermissionScope[],
): IntegrationPermissionScope[] {
  const needed = new Set<IntegrationPermissionScope>();
  for (const operation of changeSet.operations) {
    needed.add(CRM_OPERATION_SCOPE[operation.kind]);
  }
  return [...needed].filter((scope) => !granted.includes(scope)).sort();
}

/** The store may report a status string; this narrows or refuses. */
function syncStatusVocabulary(value: unknown): CrmSyncStatus | null {
  const allowed = ["prepared", "approved", "rejected", "cancelled", "executed", "failed"];
  return typeof value === "string" && allowed.includes(value) ? (value as CrmSyncStatus) : null;
}

function toConnectionView(row: {
  id: string;
  adapterId: string;
  system: string;
  grantedScopes: readonly string[];
  status: string;
  createdBy: string;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}): IntegrationConnectionView {
  return {
    id: row.id,
    adapterId: row.adapterId,
    system: row.system as IntegrationConnectionView["system"],
    grantedScopes: [...row.grantedScopes] as IntegrationPermissionScope[],
    status: row.status as IntegrationConnectionView["status"],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revokedBy: row.revokedBy,
    revokedAt: row.revokedAt,
  };
}

function toSyncView(row: {
  id: string;
  connectionId: string;
  accountId: string;
  changeSet: CrmChangeSet;
  previewDigest: string;
  status: string;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  executedBy: string | null;
  executedAt: string | null;
  providerReference: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}): CrmSyncView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    accountId: row.accountId,
    changeSet: { ...row.changeSet, operations: [...row.changeSet.operations] },
    previewDigest: row.previewDigest,
    status: row.status as CrmSyncStatus,
    decision: row.decision as CrmSyncDecision | null,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    executedBy: row.executedBy,
    executedAt: row.executedAt,
    providerReference: row.providerReference,
    failureCode: row.failureCode as CrmSyncFailureCode | null,
    failureMessage: row.failureMessage,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEventView(row: {
  id: string;
  kind: string;
  actorUserId: string;
  detail: string | null;
  createdAt: string;
}): CrmSyncEventView {
  return {
    id: row.id,
    kind: row.kind,
    actorUserId: row.actorUserId,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}
