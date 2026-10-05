/**
 * Store integration for the Cost Engine: the structural lookup the service
 * reads through, the execution existence re-check, the metric denominators,
 * and the service factory.
 *
 * The tenant boundary lives here for the two reads that could cross it:
 *
 * - `executionExists` resolves the referenced run through storage with the
 *   caller's own identity and requires its workspace to be the requesting
 *   one — a foreign or unknown execution id is NOT_FOUND either way, so
 *   another tenant's run ids are never discoverable through the gate route.
 * - `denominators` counts only rows the store already scopes to the caller's
 *   workspace; every count comes from a workspace-authorized list.
 *
 * The lookup declares only the fields the derivations read, so the concrete
 * store's richer rows are structurally assignable and the service never sees
 * a whole workspace, user or session object.
 */

import type { CostBasis, CostCategory, CostExecutionKind } from "@dealora/db";

import { CostService } from "./service.js";
import type { CostDenominators, CostEventRow, CostRepository, StorageResult } from "./types.js";

/** The minimum the Cost Engine needs from storage. Every call is scoped. */
export interface CostLookup {
  authorize(workspaceId: string, userId: string): StorageResult<unknown>;

  createCostEvent(input: {
    readonly workspaceId: string;
    readonly createdBy: string;
    readonly event: {
      readonly executionKind: CostExecutionKind;
      readonly executionId: string;
      readonly category: CostCategory;
      readonly basis: CostBasis;
      readonly amountMinor: number;
      readonly currency: string;
      readonly source: string | null;
      readonly occurredAt: string;
      readonly idempotencyKey: string;
    };
  }): StorageResult<CostEventRow>;

  getCostEvent(id: string, userId: string): StorageResult<CostEventRow>;

  listCostEvents(
    workspaceId: string,
    userId: string,
    filter?: {
      readonly executionKind?: CostExecutionKind | undefined;
      readonly executionId?: string | undefined;
      readonly category?: CostCategory | undefined;
      readonly basis?: CostBasis | undefined;
    },
  ): StorageResult<readonly CostEventRow[]>;

  getResearchRequest(id: string, userId: string): StorageResult<{ workspaceId: string }>;
  getOutboundAction(id: string, userId: string): StorageResult<{ workspaceId: string }>;
  getMeeting(id: string, userId: string): StorageResult<{ workspaceId: string }>;
  /** Phase 20's execution kind: a traced production agent run. */
  getAgentTraceRun(input: {
    workspaceId: string;
    userId: string;
    runId: string;
  }): StorageResult<{ workspaceId: string } | null>;

  listAccounts(workspaceId: string, userId: string): StorageResult<readonly { id: string }[]>;

  listQualifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly { accountId: string; version: number; state: string }[]>;

  listMeetings(workspaceId: string, userId: string): StorageResult<readonly { id: string }[]>;
}

/**
 * Wire the Cost Engine to storage.
 *
 * Everything the lookup can answer is passed through unchanged; the two
 * derivations that cross a boundary — execution existence and the metric
 * denominators — are computed here, in one place, from workspace-scoped reads.
 */
export function createCostService(lookup: CostLookup): CostService {
  const repo: CostRepository = {
    authorize: (workspaceId, userId) => lookup.authorize(workspaceId, userId),
    createCostEvent: (input) => lookup.createCostEvent(input),
    getCostEvent: (id, userId) => lookup.getCostEvent(id, userId),
    listCostEvents: (workspaceId, userId, filter) =>
      lookup.listCostEvents(workspaceId, userId, filter),

    executionExists(workspaceId, userId, kind, executionId) {
      // The kind was already checked against the published partition by the
      // service; this switch is exhaustive over it, and the default makes an
      // unreachable kind a refusal rather than a silent `meetings` fallback.
      const found = ((): StorageResult<{ workspaceId: string }> => {
        switch (kind) {
          case "research_run":
            return lookup.getResearchRequest(executionId, userId);
          case "outbound_send":
            return lookup.getOutboundAction(executionId, userId);
          case "meeting_booking":
            return lookup.getMeeting(executionId, userId);
          case "agent_run": {
            // Phase 20's traced run. A run that does not exist is refused here
            // with the same NOT_FOUND every other kind returns, so this branch
            // cannot be used to discover another tenant's run ids.
            const traced = lookup.getAgentTraceRun({
              workspaceId,
              userId,
              runId: executionId,
            });
            if (!traced.ok)
              return { ok: false, error: { code: "NOT_FOUND", message: "execution not found" } };
            if (traced.value === null) {
              return { ok: false, error: { code: "NOT_FOUND", message: "execution not found" } };
            }
            return { ok: true, value: traced.value };
          }
          default:
            return { ok: false, error: { code: "NOT_FOUND", message: "execution not found" } };
        }
      })();
      // Any refusal — unknown id, or a run the caller may not read — is
      // NOT_FOUND here, so a foreign execution id is indistinguishable from
      // one that was never issued and the route cannot be used to probe
      // another tenant's ids.
      if (!found.ok) {
        return { ok: false, error: { code: "NOT_FOUND", message: "execution not found" } };
      }
      if (found.value.workspaceId !== workspaceId) {
        return { ok: false, error: { code: "NOT_FOUND", message: "execution not found" } };
      }
      return { ok: true, value: true };
    },

    denominators(workspaceId, userId): StorageResult<CostDenominators> {
      const accounts = lookup.listAccounts(workspaceId, userId);
      if (!accounts.ok) return accounts;
      const qualifications = lookup.listQualifications(workspaceId, userId);
      if (!qualifications.ok) return qualifications;
      const meetings = lookup.listMeetings(workspaceId, userId);
      if (!meetings.ok) return meetings;

      // An account holds an opportunity when its **newest** qualification —
      // highest version, versions never reused — is `qualified`. This is the
      // same rule Phase 15's opportunity node states, so "qualified
      // opportunity" means one thing across both phases.
      const newest = new Map<string, { version: number; state: string }>();
      for (const row of qualifications.value) {
        const current = newest.get(row.accountId);
        if (current === undefined || row.version > current.version) {
          newest.set(row.accountId, { version: row.version, state: row.state });
        }
      }
      let qualifiedOpportunities = 0;
      for (const entry of newest.values()) {
        if (entry.state === "qualified") qualifiedOpportunities += 1;
      }

      return {
        ok: true,
        value: {
          prospects: accounts.value.length,
          qualifiedOpportunities,
          meetings: meetings.value.length,
        },
      };
    },
  };

  return new CostService(repo);
}
