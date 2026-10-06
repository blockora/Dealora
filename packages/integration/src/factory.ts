/**
 * Store integration for the CRM Integrations boundary: the structural lookup
 * the service reads through, adapted from the concrete repository, plus the
 * service factory that hands it a registry.
 *
 * The tenant boundary lives inside the store for every method — each one
 * re-runs its own workspace check with the caller's identity — so this wiring
 * cannot widen a scope; it only names which methods exist. The one mapping
 * that happens here is the account read: storage reports a missing *or
 * foreign* account as an error, and both become "not found", because a
 * caller must not be able to tell another tenant's account id apart from one
 * that was never issued — the same stance `requireMeeting` takes.
 *
 * The registry is passed in, never constructed here: which adapters a
 * deployment registers is a deployment decision (§30: no hard-coded vendor),
 * and the default wiring ships the sandbox.
 */

import type {
  CrmChangeSet,
  CrmSyncEvent,
  CrmSyncRequest,
  CrmSyncStatus,
  IntegrationConnection,
  IntegrationPermissionScope,
} from "@dealora/db";

import { IntegrationService } from "./service.js";
import type { IntegrationLookup, IntegrationRegistry, StorageResult } from "./types.js";

/** The minimum the CRM boundary needs from storage. Every call is scoped. */
export interface IntegrationStoreAdapter {
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

  /** Storage resolves by id and authorizes; missing and foreign are errors. */
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
  }>;

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

/** Wire the CRM boundary to storage and a registered adapter set. */
export function createIntegrationService(
  store: IntegrationStoreAdapter,
  registry: IntegrationRegistry,
): IntegrationService {
  const lookup: IntegrationLookup = {
    authorize: (workspaceId, userId) => store.authorize(workspaceId, userId),
    connectIntegration: (input) => store.connectIntegration(input),
    getIntegrationConnection: (input) => store.getIntegrationConnection(input),
    listIntegrationConnections: (workspaceId, userId) =>
      store.listIntegrationConnections(workspaceId, userId),
    revokeIntegrationConnection: (input) => store.revokeIntegrationConnection(input),
    prepareCrmSync: (input) => store.prepareCrmSync(input),
    getCrmSync: (input) => store.getCrmSync(input),
    listCrmSyncs: (workspaceId, userId, filter) => store.listCrmSyncs(workspaceId, userId, filter),
    decideCrmSync: (input) => store.decideCrmSync(input),
    recordCrmSyncOutcome: (input) => store.recordCrmSyncOutcome(input),
    cancelCrmSync: (input) => store.cancelCrmSync(input),
    listCrmSyncEvents: (workspaceId, userId, syncId) =>
      store.listCrmSyncEvents(workspaceId, userId, syncId),

    getAccount: (id, userId) => {
      const found = store.getAccount(id, userId);
      if (found.ok) return found;
      // Missing and foreign are the same answer on purpose: an id from
      // another tenant must not be discoverable through this route.
      if (found.error.code === "NOT_FOUND" || found.error.code === "UNAUTHORIZED") {
        return { ok: true, value: null };
      }
      return { ok: false, error: found.error };
    },
    listContacts: (workspaceId, userId) => store.listContacts(workspaceId, userId),
    listQualifications: (workspaceId, userId) => store.listQualifications(workspaceId, userId),
    listOutboundActions: (workspaceId, userId) => store.listOutboundActions(workspaceId, userId),
    listConversationClassifications: (workspaceId, userId) =>
      store.listConversationClassifications(workspaceId, userId),
    listMeetings: (workspaceId, userId) => store.listMeetings(workspaceId, userId),
  };

  return new IntegrationService(lookup, registry);
}

/** Re-exported so callers can type a scope list without importing storage. */
export type { IntegrationPermissionScope };
