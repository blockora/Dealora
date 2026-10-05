/**
 * The Revenue Dashboard application service — ROADMAP.md §24,
 * `DEALORA_BLUEPRINT.md` §34/§35.
 *
 * The chain runs, every time:
 *
 *   authenticate → authorize (server-side) → read the workspace's own rows
 *   through workspace-scoped lookups → derive every tile → answer
 *
 * This service **writes nothing**. It has no command methods, no clock and
 * no provider: the strongest thing it can do is count rows the other phases
 * already stored and print them in the order the roadmap asks for. The two
 * reads that reach outside this package — Phase 16's cost picture and Phase
 * 14's board — arrive through their own services' boundaries, so this phase
 * cannot disagree with either about what a cost or a next step means.
 *
 * Failures keep the established Dealora shape: an unknown workspace is
 * NOT_FOUND, a non-member is UNAUTHORIZED, and an internal condition
 * (an aggregate that could not be derived, a board that refused) is mapped
 * onto the domain vocabulary without surfacing storage internals.
 */

import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";

import { deriveDashboard } from "./engine.js";
import { describeDashboardPolicy, dashboardError } from "./rules.js";
import type {
  DashboardError,
  DashboardPolicyView,
  DashboardRepository,
  MeetingEventRow,
  RevenueDashboard,
  StorageResult,
} from "./types.js";

/** Map a storage refusal onto the domain vocabulary, hiding internals. */
function fromStorage(
  error: { code: string; message?: string },
  notFoundMessage: string,
): DashboardError {
  switch (error.code) {
    case "NOT_FOUND":
      return dashboardError("NOT_FOUND", notFoundMessage);
    case "UNAUTHORIZED":
      return dashboardError("UNAUTHORIZED", "workspace access denied");
    case "VALIDATION_ERROR":
    case "INVALID":
      // The board's own refusal ("too many accounts for one board") is a
      // rule the caller can act on, so it travels with its field details.
      return dashboardError("VALIDATION_ERROR", error.message ?? "invalid value");
    default:
      // An internal condition (an aggregate that could not be derived) is
      // never surfaced verbatim.
      return dashboardError("UNAVAILABLE", "dashboard storage unavailable");
  }
}

/** Collapse a storage result onto the domain error vocabulary. */
function resultOr<T>(result: StorageResult<T>, notFoundMessage: string): Result<T, DashboardError> {
  if (result.ok) return ok(result.value);
  return err(fromStorage(result.error, notFoundMessage));
}

/** Narrow an unknown to a non-empty trimmed string, or `null` (refuse). */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export class DashboardService {
  constructor(private readonly repo: DashboardRepository) {}

  /** Authorize the caller against the workspace using server-side identity. */
  private guard(workspaceId: string, userId: string): Result<true, DashboardError> {
    if (text(workspaceId) === null) {
      return err(dashboardError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (text(userId) === null) {
      return err(dashboardError("UNAUTHORIZED", "authentication required"));
    }
    const authorized = resultOr(this.repo.authorize(workspaceId, userId), "workspace not found");
    if (!authorized.ok) return authorized;
    return ok(true);
  }

  /**
   * The whole dashboard, derived from this workspace's rows on this request.
   *
   * Every list is workspace-scoped inside the repository with the caller's
   * own identity, so a foreign workspace id reads as denied before a single
   * row is seen, and no client-supplied number participates anywhere in the
   * answer.
   */
  snapshot(workspaceId: string, userId: string): Result<RevenueDashboard, DashboardError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const goals = resultOr(
      this.repo.listRevenueGoals(workspaceId, userId),
      "revenue goals not found",
    );
    if (!goals.ok) return goals;
    const qualifications = resultOr(
      this.repo.listQualifications(workspaceId, userId),
      "qualifications not found",
    );
    if (!qualifications.ok) return qualifications;
    const classifications = resultOr(
      this.repo.listConversationClassifications(workspaceId, userId),
      "conversation classifications not found",
    );
    if (!classifications.ok) return classifications;
    const meetings = resultOr(this.repo.listMeetings(workspaceId, userId), "meetings not found");
    if (!meetings.ok) return meetings;
    const research = resultOr(
      this.repo.listResearchRequests(workspaceId, userId),
      "research requests not found",
    );
    if (!research.ok) return research;
    const drafts = resultOr(this.repo.listDrafts(workspaceId, userId), "drafts not found");
    if (!drafts.ok) return drafts;
    const approvals = resultOr(
      this.repo.listApprovalRequests(workspaceId, userId),
      "approval requests not found",
    );
    if (!approvals.ok) return approvals;
    const outbound = resultOr(
      this.repo.listOutboundActions(workspaceId, userId),
      "outbound actions not found",
    );
    if (!outbound.ok) return outbound;

    // The failure tiles read each meeting's own event trail; each read is
    // workspace-scoped like every other, so a meeting id from another
    // tenant could not be probed through this loop even in principle.
    const meetingEvents = new Map<string, readonly MeetingEventRow[]>();
    for (const meeting of meetings.value) {
      const events = resultOr(
        this.repo.listMeetingEvents(meeting.id, userId),
        "meeting events not found",
      );
      if (!events.ok) return events;
      meetingEvents.set(meeting.id, events.value);
    }

    const cost = resultOr(this.repo.costMetrics(workspaceId, userId), "cost metrics not found");
    if (!cost.ok) return cost;
    const board = resultOr(
      this.repo.nextActionBoard(workspaceId, userId),
      "next best actions not found",
    );
    if (!board.ok) return board;

    return ok(
      deriveDashboard({
        goals: goals.value,
        qualifications: qualifications.value,
        classifications: classifications.value,
        meetings: meetings.value,
        meetingEvents,
        research: research.value,
        drafts: drafts.value,
        approvals: approvals.value,
        outbound: outbound.value,
        cost: cost.value,
        board: board.value,
      }),
    );
  }

  /**
   * The vocabulary this deployment enforces — every tile and its derivation,
   * the three refusals with their owning phase, the four questions and the
   * tiles that answer them — plus everything the phase will never do.
   * Authorized like every other route, and readable before a single row
   * exists so a workspace can inspect the whole rule set first.
   */
  policy(workspaceId: string, userId: string): Result<DashboardPolicyView, DashboardError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeDashboardPolicy());
  }
}
