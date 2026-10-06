/**
 * The published policy for CRM Integrations (ROADMAP.md §30,
 * DEALORA_BLUEPRINT.md §23/§42/§44) — declared once as data and read by the
 * service, the storage layer's independent checks and the gate alike, so
 * there is exactly one list of what a scope means, which operation needs it,
 * and which systems the architecture already accommodates.
 *
 * The two §30 requirements live here as data:
 *
 * - **clear permission scopes** — a closed catalog, a per-operation required
 *   scope, and an explicit refusal list;
 * - **standardized adapter interfaces / no vendor hard-coding** — the six
 *   potential systems are published whether or not this deployment has an
 *   adapter for one, because an architecture that only knows today's vendors
 * *is* the hard-coding §30 forbids.
 */

import type {
  CrmChangeSet,
  CrmLifecycleStage,
  CrmOperationKind,
  CrmOpportunityStatus,
  CrmSyncStatus,
  IntegrationPermissionScope,
  IntegrationSystem,
} from "@dealora/db";

import type { IntegrationError, IntegrationErrorCode } from "./types.js";

/** The rule set every derived change-set and decision states. */
export const INTEGRATION_RULE_VERSION = "integration-1.0.0";

/** Build a domain error. `details` is omitted entirely when there is nothing to say. */
export function integrationError(
  code: IntegrationErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): IntegrationError {
  return details && details.length > 0 ? { code, message, details } : { code, message };
}

/**
 * The six systems `ROADMAP.md` §30 names as potential integrations, in the
 * roadmap's own order. All six are published; a deployment registers an
 * adapter for the ones it has, and a system without one answers "not
 * configured" rather than silently defaulting to anything.
 */
export const INTEGRATION_SYSTEMS: readonly {
  readonly system: IntegrationSystem;
  readonly summary: string;
}[] = [
  { system: "crm", summary: "customer records, activities, lifecycle and opportunities" },
  { system: "calendar", summary: "events and availability" },
  { system: "email", summary: "outbound and inbound mail" },
  { system: "slack", summary: "team notifications" },
  { system: "github", summary: "issues and development activity" },
  { system: "data_provider", summary: "approved research and enrichment providers" },
];

/**
 * The permission-scope catalog (`DEALORA_BLUEPRINT.md` §44: "Every external
 * tool should have explicit permission scopes"). Closed: a name outside this
 * list cannot be requested, granted or checked anywhere in the system.
 */
export const INTEGRATION_SCOPE_CATALOG: readonly {
  readonly scope: IntegrationPermissionScope;
  readonly description: string;
}[] = [
  { scope: "contacts:read", description: "read contacts from the connected system" },
  { scope: "contacts:write", description: "create or update contacts" },
  { scope: "activities:write", description: "record activities against a record" },
  { scope: "lifecycle:write", description: "update a record's lifecycle stage" },
  { scope: "opportunities:write", description: "update an opportunity's status" },
  { scope: "notes:write", description: "attach notes to a record" },
  { scope: "conversations:write", description: "synchronize classified conversations" },
];

/**
 * The scope each CRM operation requires, declared once. Every operation in a
 * change-set maps to exactly one scope, so the set a sync needs is computable
 * and a connection that grants fewer scopes is refused before anything
 * reaches an adapter — and again at execution, because scopes can be revoked
 * between approval and execution.
 */
export const CRM_OPERATION_SCOPE: Readonly<Record<CrmOperationKind, IntegrationPermissionScope>> = {
  upsert_contact: "contacts:write",
  create_activity: "activities:write",
  update_lifecycle_stage: "lifecycle:write",
  update_opportunity_status: "opportunities:write",
  attach_note: "notes:write",
  sync_conversation: "conversations:write",
};

/** The declared limits. Storage re-checks the same numbers independently. */
export const INTEGRATION_LIMITS = {
  adapterIdMin: 1,
  adapterIdMax: 64,
  decisionReasonMax: 280,
  cancelReasonMax: 280,
  operationsMax: 500,
  /** Published derivation caps: the most recent N are synchronized. */
  activitiesPerSyncMax: 50,
  conversationsPerSyncMax: 50,
  noteLengthMax: 1000,
  activityDetailMax: 280,
  stageReasonMax: 280,
  evidenceCitedMax: 10,
} as const;

/** Lifecycle vocabulary, published for readers and tests alike. */
export const CRM_LIFECYCLE_STAGES: readonly CrmLifecycleStage[] = [
  "new",
  "qualified",
  "contacted",
  "engaged",
  "meeting_booked",
];

export const CRM_OPPORTUNITY_STATUSES: readonly CrmOpportunityStatus[] = [
  "open",
  "closed",
  "contested",
];

/** The lifecycle states a sync may hold, in transition order. */
export const CRM_SYNC_STATUSES: readonly CrmSyncStatus[] = [
  "prepared",
  "approved",
  "rejected",
  "cancelled",
  "executed",
  "failed",
];

/**
 * The published refusals — the phase's negative space, stated as data so a
 * reader can check what this architecture will *not* do without reading the
 * implementation.
 */
export const INTEGRATION_REFUSALS: readonly {
  readonly name: string;
  readonly reason: string;
}[] = [
  {
    name: "credentials",
    reason:
      "no token, secret or OAuth artifact is stored anywhere: ROADMAP.md §18 leaves OAuth/credential handling open for the first real adapter (ADR 0011), and every adapter shipped here performs no network I/O.",
  },
  {
    name: "opportunity_value",
    reason:
      "no operation carries an amount or value field, because the Phase 4 plan's CRM policy prohibits writing an opportunity value without a human-confirmed figure — and no stored row records one.",
  },
  {
    name: "unapproved_sync",
    reason:
      "DEALORA_BLUEPRINT.md §17 classifies update CRM as a Level 2 external action: no change-set reaches an adapter without an explicit human decision bound to its digest, and no score, threshold or timer can approve one.",
  },
  {
    name: "archived_accounts",
    reason:
      "an archived account is soft-deleted user data and is never synchronized, per the privacy principle of data minimization.",
  },
  {
    name: "vendor_hard_coding",
    reason:
      "product code resolves adapters only by id through the registry; a system with no registered adapter fails closed with 'not configured' instead of falling back to a default vendor.",
  },
];

/**
 * Deterministic digest of the exact change-set a reviewer is shown.
 *
 * FNV-1a over a canonical (key-sorted) serialization of the change-set and
 * its connection — the same construction Phase 10's preview digest and Phase
 * 13's booking digest use, so "I approved *this* sync" is checkable by
 * recomputation at decision time and again before execution. A fingerprint
 * for comparison, not a security primitive; no randomness, no clock, stable
 * across processes.
 */
export function changeSetDigest(input: {
  readonly changeSet: CrmChangeSet;
  readonly connectionId: string;
}): string {
  const canonical = canonicalJson({
    changeSet: input.changeSet,
    connectionId: input.connectionId,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

/** Key-sorted canonical JSON so the same document hashes the same everywhere. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** The published policy view: everything §30 asks for, as one read. */
export interface IntegrationPolicyView {
  ruleVersion: string;
  systems: readonly { system: IntegrationSystem; summary: string }[];
  scopes: readonly { scope: IntegrationPermissionScope; description: string }[];
  operationScopes: readonly { operation: CrmOperationKind; scope: IntegrationPermissionScope }[];
  lifecycleStages: readonly CrmLifecycleStage[];
  opportunityStatuses: readonly CrmOpportunityStatus[];
  syncStatuses: readonly CrmSyncStatus[];
  refusals: readonly { name: string; reason: string }[];
}

export function describeIntegrationPolicy(): IntegrationPolicyView {
  return {
    ruleVersion: INTEGRATION_RULE_VERSION,
    systems: INTEGRATION_SYSTEMS.map((entry) => ({ ...entry })),
    scopes: INTEGRATION_SCOPE_CATALOG.map((entry) => ({ ...entry })),
    operationScopes: (Object.keys(CRM_OPERATION_SCOPE) as CrmOperationKind[]).map((operation) => ({
      operation,
      scope: CRM_OPERATION_SCOPE[operation],
    })),
    lifecycleStages: [...CRM_LIFECYCLE_STAGES],
    opportunityStatuses: [...CRM_OPPORTUNITY_STATUSES],
    syncStatuses: [...CRM_SYNC_STATUSES],
    refusals: INTEGRATION_REFUSALS.map((entry) => ({ ...entry })),
  };
}
