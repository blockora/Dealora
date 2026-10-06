/**
 * Types for the CRM Integrations boundary (ROADMAP.md §30).
 *
 * Split so the vendor-neutral half stays vendor-neutral: adapter identity,
 * permission scopes, the standardized apply interface and the registry are
 * declared here and contain no storage shape; the connection, sync and event
 * rows are `@dealora/db`'s own types and are only ever read through the
 * structural lookup at the bottom.
 *
 * The one safety property encoded in the types themselves: an adapter
 * receives a change-set **plus the recorded approval reference** and answers
 * with exactly one of `accepted` or a closed `failureCode` — the same shape
 * Phase 11's provider result established, because only an explicit
 * confirmation may become `executed`.
 */

import type {
  CrmChangeSet,
  CrmSyncDecision,
  CrmSyncEvent,
  CrmSyncFailureCode,
  CrmSyncRequest,
  CrmSyncStatus,
  IntegrationConnection,
  IntegrationPermissionScope,
  IntegrationSystem,
} from "@dealora/db";

/** Domain error codes, mirroring the Experiment Engine's closed vocabulary. */
export type IntegrationErrorCode =
  "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "UNAUTHORIZED" | "UNAVAILABLE";

export interface IntegrationError {
  readonly code: IntegrationErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** The minimum the service reads back from storage. Every call is scoped. */
export type StorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

/**
 * One registered adapter — the standardized interface §30 requires.
 *
 * Product code depends only on this shape: it names an adapter by id through
 * a registry and never reaches for a vendor's own SDK, so swapping or adding
 * a vendor is a registration decision rather than a code change. `sandbox`
 * is part of the honest contract: while it is `true` the adapter performs no
 * network I/O and every "accepted" claim means *the adapter recorded it*.
 */
export interface IntegrationAdapter {
  /** Stable identity, stored on every connection and sync this adapter touches. */
  readonly id: string;
  readonly system: IntegrationSystem;
  readonly displayName: string;
  /**
   * The scopes this adapter can ever request — a closed subset of the
   * published catalog. A connection may grant fewer, never more.
   */
  readonly scopes: readonly IntegrationPermissionScope[];
  /** `true` while the adapter performs no network I/O. */
  readonly sandbox: boolean;
}

/**
 * What a CRM adapter is handed when an approved sync executes.
 *
 * Deliberately narrow: the change-set a person approved, the idempotency key
 * (the sync's own id, so one approval yields at most one applied record set),
 * and the approval reference — Phase 4's plan requires the approval for any
 * external action to travel with the record. No credentials, no workspace
 * configuration, no ability to read anything back.
 */
export interface CrmApplyRequest {
  /** Stable across retries: the sync row's id. */
  readonly idempotencyKey: string;
  readonly adapterId: string;
  readonly accountId: string;
  /** Who approved this sync, server-derived from the recorded decision. */
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly changeSet: CrmChangeSet;
}

/**
 * The adapter's answer. Exactly one of `accepted` or a `failureCode` is
 * present; an adapter that answers neither has not confirmed anything, and
 * the service records a failure rather than an execution.
 */
export interface CrmApplyResult {
  readonly accepted: boolean;
  /** The adapter's own reference. Present exactly when `accepted`. */
  readonly providerReference: string | null;
  /** Required when `accepted` is false. */
  readonly failureCode: CrmSyncFailureCode | null;
  readonly message: string;
}

/**
 * The CRM capability of the standardized interface: what Phase 23's registry
 * narrows to before a sync may execute. `system` is fixed to `"crm"` so a
 * non-CRM adapter can never be resolved through this path by accident.
 */
export interface CrmChangeSetAdapter extends IntegrationAdapter {
  readonly system: "crm";
  applyChangeSet(request: CrmApplyRequest): Promise<CrmApplyResult>;
}

/**
 * The adapter registry — §30's "do not hard-code the entire product around
 * one vendor" as an interface. Resolution is by id and system; an unknown id
 * or a system with no adapter answers `null`, and the service turns that
 * into a fail-closed refusal rather than a default.
 */
export interface IntegrationRegistry {
  /** Every registered adapter, in registration order. */
  list(): readonly IntegrationAdapter[];
  /** One adapter by id, or `null`. */
  get(adapterId: string): IntegrationAdapter | null;
  /** One CRM-capable adapter by id, or `null` when absent or not a CRM adapter. */
  crm(adapterId: string): CrmChangeSetAdapter | null;
}

/** The adapter catalog as a read returns it. */
export interface IntegrationAdapterView {
  id: string;
  system: IntegrationSystem;
  displayName: string;
  sandbox: boolean;
  scopes: readonly IntegrationPermissionScope[];
}

/** A workspace's connection to one adapter. Never carries a credential. */
export interface IntegrationConnectionView {
  id: string;
  adapterId: string;
  system: IntegrationSystem;
  grantedScopes: readonly IntegrationPermissionScope[];
  status: "active" | "revoked";
  createdBy: string;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}

/** One prepared sync, read back complete with the exact change-set. */
export interface CrmSyncView {
  id: string;
  connectionId: string;
  accountId: string;
  changeSet: CrmChangeSet;
  previewDigest: string;
  status: CrmSyncStatus;
  decision: CrmSyncDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  executedBy: string | null;
  executedAt: string | null;
  providerReference: string | null;
  failureCode: CrmSyncFailureCode | null;
  failureMessage: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmSyncEventView {
  id: string;
  kind: string;
  actorUserId: string;
  detail: string | null;
  createdAt: string;
}

/**
 * The structural lookup the service reads through.
 *
 * Narrowed to the fields the derivations and lifecycle writes actually use,
 * so the concrete store's richer rows are structurally assignable and the
 * service never sees a whole workspace, user or session object. Every method
 * is workspace-scoped inside the store; this interface cannot widen that.
 */
export interface IntegrationLookup {
  authorize(workspaceId: string, userId: string): StorageResult<unknown>;

  connectIntegration(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly adapterId: string;
    readonly system: string;
    readonly grantedScopes: readonly string[];
  }): StorageResult<IntegrationConnection>;

  getIntegrationConnection(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly connectionId: string;
  }): StorageResult<IntegrationConnection | null>;

  listIntegrationConnections(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly IntegrationConnection[]>;

  revokeIntegrationConnection(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly connectionId: string;
  }): StorageResult<IntegrationConnection>;

  prepareCrmSync(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly accountId: string;
    readonly changeSet: CrmChangeSet;
    readonly previewDigest: string;
  }): StorageResult<CrmSyncRequest>;

  getCrmSync(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly syncId: string;
  }): StorageResult<CrmSyncRequest | null>;

  listCrmSyncs(
    workspaceId: string,
    userId: string,
    filter?: {
      readonly status?: CrmSyncStatus;
      readonly accountId?: string;
    },
  ): StorageResult<readonly CrmSyncRequest[]>;

  decideCrmSync(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly syncId: string;
    readonly decision: string;
    readonly reason: string | null;
    readonly previewDigest: string;
  }): StorageResult<CrmSyncRequest>;

  recordCrmSyncOutcome(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly syncId: string;
    readonly outcome: string;
    readonly providerReference: string | null;
    readonly failureCode: string | null;
    readonly failureMessage: string | null;
  }): StorageResult<CrmSyncRequest>;

  cancelCrmSync(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly syncId: string;
    readonly reason: string | null;
  }): StorageResult<CrmSyncRequest>;

  listCrmSyncEvents(
    workspaceId: string,
    userId: string,
    syncId: string,
  ): StorageResult<readonly CrmSyncEvent[]>;

  getAccount(
    id: string,
    userId: string,
  ): StorageResult<{
    id: string;
    workspaceId: string;
    name: string;
    status: string;
    source: string;
    sourceReference: string | null;
    revenuePlanId: string | null;
  } | null>;

  listContacts(
    workspaceId: string,
    userId: string,
  ): StorageResult<
    readonly {
      id: string;
      accountId: string;
      fullName: string;
      email: string | null;
      jobTitle: string | null;
      status: string;
      source: string;
      sourceReference: string | null;
    }[]
  >;

  listQualifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<
    readonly {
      id: string;
      accountId: string;
      version: number;
      state: string;
      score: number | null;
      reason: string;
      ruleVersion: string;
      evidenceIds: readonly string[];
      revenueGoalId: string | null;
      createdAt: string;
    }[]
  >;

  listOutboundActions(
    workspaceId: string,
    userId: string,
  ): StorageResult<
    readonly {
      id: string;
      contactId: string;
      status: string;
      channel: string;
      sentAt: string | null;
    }[]
  >;

  listConversationClassifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<
    readonly {
      id: string;
      outboundActionId: string;
      intent: string;
      confidence: string;
      recommendedNextAction: string;
      createdAt: string;
    }[]
  >;

  listMeetings(
    workspaceId: string,
    userId: string,
  ): StorageResult<
    readonly {
      id: string;
      contactId: string;
      state: string;
      title: string;
      startsAt: string;
      createdAt: string;
    }[]
  >;
}
