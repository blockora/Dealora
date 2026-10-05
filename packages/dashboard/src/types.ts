/**
 * @dealora/dashboard — types for the Phase 17 Revenue Dashboard
 * (ROADMAP.md §24, DEALORA_BLUEPRINT.md §34/§35, with §24's attribution
 * vocabulary).
 *
 * The dashboard is **derived, never stored**: every tile is computed on read
 * from rows other phases already wrote, so this phase adds no table, no schema
 * version and no migration — a persisted dashboard would go stale and would
 * duplicate the facts it summarizes. The split the types below keep honest:
 *
 * - **Tiles** answer with a number only when a stored row can produce it. A
 *   tile whose fact no phase records yet reports `no_data` with a reason and
 *   the owning phase — never a fabricated zero, because "we have not booked
 *   this" and "this is worth nothing" are different claims.
 * - **The cost tile** is Phase 16's own `WorkspaceCostMetrics`, embedded
 *   whole rather than re-derived here, so the cost engine keeps exactly one
 *   definition of every cost number.
 * - **The next-step tile** is Phase 14's own board, read through its
 *   boundary, so the dashboard reports advice rather than inventing it.
 *
 * Negative space, stated once and enforced everywhere:
 * - never writes (the repository surface is `authorize` and workspace-scoped
 *   reads alone),
 * - never acts (no sender, approver, scheduler, provider, agent, clock or
 *   network — ROADMAP.md §25 puts the agent system in Phase 18),
 * - never fabricates: no revenue, pipeline or customer number is estimated
 *   from an assumption; a tile without a backing row says `no_data`,
 * - never trusts a client total: every number is recomputed from the
 *   workspace's own rows on each request,
 * - never does float money arithmetic: money tiles carry whole minor units
 *   in the workspace's one currency, exactly as Phase 16 recorded them,
 * - never crosses a workspace: every read is workspace-scoped with the
 *   caller's own identity, and a foreign workspace reads as denied.
 *
 * Determinism: the snapshot has no clock and no randomness. Given the same
 * rows, two reads print byte-identical JSON; ordering inside a tile is either
 * a declared closed order or the store's own deterministic order.
 */

import type {
  ConversationIntent,
  GoalMetricKind,
  IsoDate,
  MeetingBookingState,
  RevenueGoal,
} from "@dealora/db";
import type { WorkspaceCostMetrics } from "@dealora/cost";
import type { NextActionBoard } from "@dealora/nextaction";

export type { WorkspaceCostMetrics };

/** The closed error vocabulary this domain reports to the transport layer. */
export type DashboardErrorCode = "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_ERROR" | "UNAVAILABLE";

export interface DashboardError {
  readonly code: DashboardErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/**
 * Every store method's result shape, stated structurally so the service can
 * be wired to the concrete repository without importing its internals.
 */
export type StorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

/**
 * A tile's answer state.
 *
 * `derived` means a stored row produced the number — including an honest zero
 * for "no rows yet". `no_data` means no row type through Phase 17 can produce
 * it, and `reason` says why while `owningPhase` names who records the fact
 * later (`null` when the absence is workspace state, not a missing phase —
 * an empty goal list, for example).
 */
export type DashboardTileStatus = "derived" | "no_data";

/** A counted tile: derived from rows, or honestly absent. */
export interface DashboardCountTile {
  readonly status: DashboardTileStatus;
  readonly value: number | null;
  readonly reason: string | null;
  readonly owningPhase: string | null;
  readonly derivation: string;
}

/** A money tile: whole minor units in one currency, or honestly absent. */
export interface DashboardMoneyTile {
  readonly status: DashboardTileStatus;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly reason: string | null;
  readonly owningPhase: string | null;
  readonly derivation: string;
}

/** The workspace's current revenue goal, as the dashboard reports it. */
export interface DashboardGoal {
  readonly id: string;
  readonly targetMetric: GoalMetricKind;
  readonly targetValue: number;
  readonly currency: string | null;
  readonly timeWindow: { readonly start: IsoDate; readonly end: IsoDate };
  readonly status: RevenueGoal["status"];
}

/** The Revenue Goal tile: the newest active goal, or no data. */
export interface DashboardGoalTile {
  readonly status: DashboardTileStatus;
  readonly goal: DashboardGoal | null;
  readonly reason: string | null;
  readonly owningPhase: string | null;
  readonly derivation: string;
}

/** One meeting state's count, in the closed state order. */
export interface DashboardMeetingStateCount {
  readonly state: MeetingBookingState;
  readonly count: number;
}

/**
 * The Meetings tile. Always derived — the meetings table exists, so zero is a
 * fact. The headline `total` is every stored meeting row (Phase 16's own
 * denominator rule, so one word means one thing across both phases), and
 * `byState` discloses how far each one actually got.
 */
export interface DashboardMeetingsTile {
  readonly status: "derived";
  readonly total: number;
  readonly byState: readonly DashboardMeetingStateCount[];
  readonly derivation: string;
}

/** The Approvals Required tile: pending Phase 10 decisions, newest first. */
export interface DashboardApprovalsTile {
  readonly status: "derived";
  readonly required: number;
  readonly approvalIds: readonly string[];
  readonly derivation: string;
}

/** One workflow-failure source's count, in the closed source order. */
export interface DashboardFailureSourceCount {
  readonly source: WorkflowFailureSource;
  readonly count: number;
}

/** The Workflow Failures tile: failed runs across the three execution kinds. */
export interface DashboardWorkflowFailuresTile {
  readonly status: "derived";
  readonly total: number;
  readonly bySource: readonly DashboardFailureSourceCount[];
  readonly derivation: string;
}

/** One Agent Activity counter, in the declared activity order. */
export interface DashboardActivityCounter {
  readonly key: ActivityCounterKey;
  readonly label: string;
  readonly count: number;
  readonly derivation: string;
}

/** The closed failure sources Phase 17 counts, named as Phase 16 names runs. */
export type WorkflowFailureSource = "research_run" | "outbound_send" | "meeting_booking";

/** The closed Agent Activity counters the dashboard publishes. */
export type ActivityCounterKey =
  "accounts_researched" | "prospects_qualified" | "drafts_rendered" | "replies_classified";

/** The fourteen tile keys: ROADMAP.md §24's twelve plus BLUEPRINT §35's two. */
export type DashboardItemKey =
  | "revenue_goal"
  | "direct_revenue"
  | "pipeline_created"
  | "qualified_prospects"
  | "positive_conversations"
  | "meetings"
  | "opportunities"
  | "customers"
  | "agent_activity"
  | "approvals_required"
  | "workflow_failures"
  | "cost"
  | "hot_conversations"
  | "next_best_actions";

/**
 * The whole dashboard, assembled on read.
 *
 * Field order is the declaration order and the response order: the roadmap's
 * list top to bottom, then the two legs BLUEPRINT §35 adds for "what needs
 * attention" and "what should happen next".
 */
export interface RevenueDashboard {
  readonly ruleVersion: string;
  readonly goal: DashboardGoalTile;
  readonly directRevenue: DashboardMoneyTile;
  readonly pipelineCreated: DashboardMoneyTile;
  readonly qualifiedProspects: DashboardCountTile;
  readonly positiveConversations: DashboardCountTile;
  readonly meetings: DashboardMeetingsTile;
  readonly opportunities: DashboardCountTile;
  readonly customers: DashboardCountTile;
  readonly agentActivity: readonly DashboardActivityCounter[];
  readonly approvalsRequired: DashboardApprovalsTile;
  readonly workflowFailures: DashboardWorkflowFailuresTile;
  readonly hotConversations: DashboardCountTile;
  readonly cost: WorkspaceCostMetrics;
  readonly nextBestActions: NextActionBoard;
}

/** How available a tile is through Phase 17, declared as data. */
export type DashboardItemAvailability = "derived" | "conditional" | "unfed";

/** One published tile: what it counts, and how. */
export interface DashboardItemDefinition {
  readonly key: DashboardItemKey;
  readonly label: string;
  readonly availability: DashboardItemAvailability;
  readonly derivation: string;
}

/** A named refusal: a tile no Phase 0–17 row can feed, and who owns it. */
export interface DashboardRefusal {
  readonly name: DashboardItemKey;
  readonly reason: string;
  readonly owningPhase: string | null;
}

/** One of BLUEPRINT §35's four questions and the tiles that answer it. */
export interface DashboardQuestion {
  readonly question: string;
  readonly answeredBy: readonly DashboardItemKey[];
}

/** How one failure source is counted, stated as data. */
export interface WorkflowFailureDefinition {
  readonly source: WorkflowFailureSource;
  readonly derivation: string;
}

/** How one activity counter is counted, stated as data. */
export interface ActivityCounterDefinition {
  readonly key: ActivityCounterKey;
  readonly label: string;
  readonly derivation: string;
}

/** Everything this deployment's dashboard vocabulary allows, and refuses. */
export interface DashboardPolicyView {
  readonly ruleVersion: string;
  readonly items: readonly DashboardItemDefinition[];
  readonly refusals: readonly DashboardRefusal[];
  readonly questions: readonly DashboardQuestion[];
  readonly goalSelectionRule: string;
  readonly positiveConversationIntents: readonly ConversationIntent[];
  readonly opportunityRule: string;
  readonly opportunityMeetingStates: readonly MeetingBookingState[];
  readonly meetingStates: readonly MeetingBookingState[];
  readonly activityCounters: readonly ActivityCounterDefinition[];
  readonly workflowFailureSources: readonly WorkflowFailureDefinition[];
  readonly neverDoes: readonly string[];
}

/**
 * The storage surface the dashboard reads through. Every method is
 * workspace-scoped inside the repository itself: the service passes the
 * caller's identity and never a role or a claim a client sent.
 */
export interface DashboardRepository {
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

  /** Phase 16's cost picture, read through the cost service's own boundary. */
  costMetrics(workspaceId: string, userId: string): StorageResult<WorkspaceCostMetrics>;
  /** Phase 14's board, read through the recommendation engine's boundary. */
  nextActionBoard(workspaceId: string, userId: string): StorageResult<NextActionBoard>;
}

/**
 * The row slices the derivations read — the stored fields and nothing else.
 * Each is a structural subset of the concrete row, so the repository's richer
 * records are assignable without a cast and the engine never sees a whole
 * workspace, user or session object.
 */
export type RevenueGoalRow = Pick<
  RevenueGoal,
  "id" | "status" | "targetMetric" | "targetValue" | "currency" | "timeWindow" | "createdAt"
>;

export interface QualificationRow {
  readonly accountId: string;
  readonly version: number;
  readonly state: string;
}

export interface ClassificationRow {
  readonly intent: ConversationIntent;
  readonly suppressed: boolean;
}

export interface MeetingRow {
  readonly id: string;
  readonly accountId: string;
  readonly state: MeetingBookingState;
}

export interface MeetingEventRow {
  readonly kind: string;
}

export interface ResearchRequestRow {
  readonly accountId: string;
  readonly status: string;
}

export interface DraftRow {
  readonly id: string;
}

export interface ApprovalRow {
  readonly id: string;
  readonly status: string;
}

export interface OutboundActionRow {
  readonly status: string;
}
