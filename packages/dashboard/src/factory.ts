/**
 * Store integration for the Revenue Dashboard: the structural lookup the
 * service reads through, and the two cross-phase readers that arrive from
 * their own services' boundaries.
 *
 * The tenant boundary lives in storage, not here: every lookup method is
 * workspace-scoped inside the repository with the caller's own identity, so
 * this factory only wires — it never widens a scope, never caches a row and
 * never computes a number of its own.
 *
 * The two readers are deliberately separate from the row lookup:
 *
 * - `costMetrics` is Phase 16's `CostService.metrics` — the cost tile embeds
 *   its answer whole, so there is exactly one definition of every cost number
 *   in the product.
 * - `nextActionBoard` is Phase 14's `NextActionService.recommendForWorkspace`
 *   — the next-step tile and the hot-conversation count read the
 *   recommendation engine's own output, so this phase adds no advice of its
 *   own and cannot disagree with the board it reports.
 *
 * The lookup declares only the fields the derivations read, so the concrete
 * store's richer rows are structurally assignable and the engine never sees a
 * whole workspace, user or session object.
 */

import type { NextActionBoard } from "@dealora/nextaction";

import { DashboardService } from "./service.js";
import type {
  ApprovalRow,
  ClassificationRow,
  DashboardRepository,
  DraftRow,
  MeetingEventRow,
  MeetingRow,
  OutboundActionRow,
  QualificationRow,
  ResearchRequestRow,
  RevenueGoalRow,
  StorageResult,
  WorkspaceCostMetrics,
} from "./types.js";

/** The minimum the dashboard needs from storage. Every call is scoped. */
export interface DashboardLookup {
  authorize(workspaceId: string, userId: string): StorageResult<unknown>;

  listRevenueGoals(workspaceId: string, userId: string): StorageResult<readonly RevenueGoalRow[]>;
  listQualifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly QualificationRow[]>;
  listConversationClassifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly ClassificationRow[]>;
  listMeetings(workspaceId: string, userId: string): StorageResult<readonly MeetingRow[]>;
  listMeetingEvents(meetingId: string, userId: string): StorageResult<readonly MeetingEventRow[]>;
  listResearchRequests(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly ResearchRequestRow[]>;
  listDrafts(workspaceId: string, userId: string): StorageResult<readonly DraftRow[]>;
  listApprovalRequests(workspaceId: string, userId: string): StorageResult<readonly ApprovalRow[]>;
  listOutboundActions(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly OutboundActionRow[]>;
}

/** The two reads that come from the phases that own those answers. */
export interface DashboardReaders {
  costMetrics(workspaceId: string, userId: string): StorageResult<WorkspaceCostMetrics>;
  nextActionBoard(workspaceId: string, userId: string): StorageResult<NextActionBoard>;
}

/**
 * Wire the dashboard to storage and to the two owning boundaries.
 *
 * Everything is passed through unchanged: the derivations live in
 * `engine.ts`, and this function's whole job is to prove — by its types —
 * that the service can reach nothing except workspace-scoped rows, Phase
 * 16's cost picture and Phase 14's board.
 */
export function createDashboardService(
  lookup: DashboardLookup,
  readers: DashboardReaders,
): DashboardService {
  const repo: DashboardRepository = { ...lookup, ...readers };
  return new DashboardService(repo);
}
