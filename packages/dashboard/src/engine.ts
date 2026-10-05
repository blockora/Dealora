/**
 * The dashboard derivation engine — pure functions over row slices.
 *
 * Every tile ROADMAP.md §24 lists is computed here from stored rows and
 * nothing else: no clock, no randomness, no client input, no network. The
 * same rows always print the same snapshot, which is what makes the gate's
 * "derived, never stored" claim checkable rather than aspirational.
 *
 * The three shapes a number can take, and when each is used:
 *
 * - **derived** — a row type exists, so zero is a fact (qualified prospects,
 *   meetings, approvals, failures, activity, cost).
 * - **conditional** — a row type exists but may be empty in a way that makes
 *   the tile's premise false (the Revenue Goal needs an *active* goal; an
 *   empty list answers `no_data`, not "goal: none").
 * - **no_data with an owning phase** — no Phase 0–17 row type can feed the
 *   tile at all (Direct Revenue, Pipeline Created, Customers). Reporting
 *   `$0` there would be a financial claim nobody recorded.
 *
 * Double counting is impossible by construction: counts are over distinct
 * accounts or over rows, never over row pairs, and an account appears at
 * most once in every account-based count.
 */

import type { NextActionBoard } from "@dealora/nextaction";

import {
  ACTIVITY_COUNTERS,
  DASHBOARD_REFUSALS,
  DASHBOARD_RULE_VERSION,
  MEETING_STATE_ORDER,
  OPPORTUNITY_MEETING_STATES,
  POSITIVE_CONVERSATION_INTENTS,
  TILE_DERIVATIONS,
  WORKFLOW_FAILURE_SOURCES,
} from "./rules.js";
import type {
  ActivityCounterKey,
  ApprovalRow,
  ClassificationRow,
  DashboardActivityCounter,
  DashboardApprovalsTile,
  DashboardCountTile,
  DashboardFailureSourceCount,
  DashboardGoal,
  DashboardGoalTile,
  DashboardItemKey,
  DashboardMeetingsTile,
  DashboardMoneyTile,
  DashboardWorkflowFailuresTile,
  DraftRow,
  MeetingEventRow,
  MeetingRow,
  OutboundActionRow,
  QualificationRow,
  ResearchRequestRow,
  RevenueDashboard,
  RevenueGoalRow,
  WorkflowFailureSource,
  WorkspaceCostMetrics,
} from "./types.js";

/** Everything the engine reads, gathered workspace-scoped by the service. */
export interface DashboardDerivationInput {
  readonly goals: readonly RevenueGoalRow[];
  readonly qualifications: readonly QualificationRow[];
  readonly classifications: readonly ClassificationRow[];
  readonly meetings: readonly MeetingRow[];
  /** Meeting id → its event trail; only the `booking_failed` kind is read. */
  readonly meetingEvents: ReadonlyMap<string, readonly MeetingEventRow[]>;
  readonly research: readonly ResearchRequestRow[];
  readonly drafts: readonly DraftRow[];
  readonly approvals: readonly ApprovalRow[];
  readonly outbound: readonly OutboundActionRow[];
  readonly cost: WorkspaceCostMetrics;
  readonly board: NextActionBoard;
}

/** A derived count tile: a row type exists, so zero is a fact. */
function derivedCount(key: DashboardItemKey, value: number): DashboardCountTile {
  return {
    status: "derived",
    value,
    reason: null,
    owningPhase: null,
    derivation: TILE_DERIVATIONS[key],
  };
}

/** A refusal tile: no Phase 0–17 row feeds this key, named with its owner. */
function unfedCount(key: DashboardItemKey): DashboardCountTile {
  const refusal = DASHBOARD_REFUSALS.find((entry) => entry.name === key);
  if (refusal === undefined) throw new Error(`tile is not a declared refusal: ${key}`);
  return {
    status: "no_data",
    value: null,
    reason: refusal.reason,
    owningPhase: refusal.owningPhase,
    derivation: TILE_DERIVATIONS[key],
  };
}

/** A refusal money tile, for the two money outcomes no phase records. */
function unfedMoney(key: DashboardItemKey): DashboardMoneyTile {
  const refusal = DASHBOARD_REFUSALS.find((entry) => entry.name === key);
  if (refusal === undefined) throw new Error(`tile is not a declared refusal: ${key}`);
  return {
    status: "no_data",
    amountMinor: null,
    currency: null,
    reason: refusal.reason,
    owningPhase: refusal.owningPhase,
    derivation: TILE_DERIVATIONS[key],
  };
}

/**
 * The workspace's current goal: the newest `active` one, by createdAt
 * descending with id as the stable tiebreaker. An empty or merely
 * draft/paused/completed/archived list answers `no_data` — the rule is
 * published, so the absence is explainable rather than a guess.
 */
export function deriveGoal(goals: readonly RevenueGoalRow[]): DashboardGoalTile {
  const active = goals
    .filter((goal) => goal.status === "active")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const newest = active[0];
  if (newest === undefined) {
    return {
      status: "no_data",
      goal: null,
      reason: "this workspace has no active revenue goal",
      owningPhase: null,
      derivation: TILE_DERIVATIONS.revenue_goal,
    };
  }
  const goal: DashboardGoal = {
    id: newest.id,
    targetMetric: newest.targetMetric,
    targetValue: newest.targetValue,
    currency: newest.currency,
    timeWindow: { start: newest.timeWindow.start, end: newest.timeWindow.end },
    status: newest.status,
  };
  return {
    status: "derived",
    goal,
    reason: null,
    owningPhase: null,
    derivation: TILE_DERIVATIONS.revenue_goal,
  };
}

/**
 * The qualification split every account-based count reads from one pass:
 *
 * - `currentlyQualified` — accounts whose **newest** qualification (highest
 *   version, versions never reused) is `qualified`. The same rule Phase 15's
 *   opportunity node and Phase 16's denominator state, so "qualified" means
 *   one thing across all three phases.
 * - `everQualified` — accounts that reached `qualified` on any version, the
 *   activity counter's own definition: work done, counted once per account.
 */
export function splitQualifications(qualifications: readonly QualificationRow[]): {
  readonly currentlyQualified: ReadonlySet<string>;
  readonly everQualified: ReadonlySet<string>;
} {
  const newest = new Map<string, { version: number; state: string }>();
  const everQualified = new Set<string>();
  for (const row of qualifications) {
    if (row.state === "qualified") everQualified.add(row.accountId);
    const current = newest.get(row.accountId);
    if (current === undefined || row.version > current.version) {
      newest.set(row.accountId, { version: row.version, state: row.state });
    }
  }
  const currentlyQualified = new Set<string>();
  for (const [accountId, entry] of newest) {
    if (entry.state === "qualified") currentlyQualified.add(accountId);
  }
  return { currentlyQualified, everQualified };
}

/** Classifications that read as a positive response and are not suppressed. */
export function countPositiveConversations(classifications: readonly ClassificationRow[]): number {
  let count = 0;
  for (const row of classifications) {
    if (row.suppressed) continue;
    if (POSITIVE_CONVERSATION_INTENTS.includes(row.intent)) count += 1;
  }
  return count;
}

/** The Meetings tile: every row, plus the closed per-state breakdown. */
export function deriveMeetings(meetings: readonly MeetingRow[]): DashboardMeetingsTile {
  const byState = MEETING_STATE_ORDER.map((state) => ({
    state,
    count: meetings.filter((meeting) => meeting.state === state).length,
  }));
  return {
    status: "derived",
    total: meetings.length,
    byState,
    derivation: TILE_DERIVATIONS.meetings,
  };
}

/**
 * Opportunities: qualified accounts whose loop reached the calendar.
 * Each account is counted at most once — set membership, not row pairs.
 */
export function countOpportunities(
  currentlyQualified: ReadonlySet<string>,
  meetings: readonly MeetingRow[],
): number {
  const reachedCalendar = new Set<string>();
  for (const meeting of meetings) {
    if (OPPORTUNITY_MEETING_STATES.includes(meeting.state)) {
      reachedCalendar.add(meeting.accountId);
    }
  }
  let count = 0;
  for (const accountId of currentlyQualified) {
    if (reachedCalendar.has(accountId)) count += 1;
  }
  return count;
}

/** The four Agent Activity counters, in the declared order. */
export function deriveActivity(
  research: readonly ResearchRequestRow[],
  everQualified: ReadonlySet<string>,
  drafts: readonly DraftRow[],
  classifications: readonly ClassificationRow[],
): readonly DashboardActivityCounter[] {
  const researched = new Set<string>();
  for (const row of research) {
    if (row.status === "completed") researched.add(row.accountId);
  }
  const counts: Readonly<Record<ActivityCounterKey, number>> = {
    accounts_researched: researched.size,
    prospects_qualified: everQualified.size,
    drafts_rendered: drafts.length,
    replies_classified: classifications.length,
  };
  return ACTIVITY_COUNTERS.map((counter) => ({
    key: counter.key,
    label: counter.label,
    count: counts[counter.key],
    derivation: counter.derivation,
  }));
}

/** Pending approval requests, newest first as the store returns them. */
export function deriveApprovals(approvals: readonly ApprovalRow[]): DashboardApprovalsTile {
  const pending = approvals.filter((approval) => approval.status === "pending");
  return {
    status: "derived",
    required: pending.length,
    approvalIds: pending.map((approval) => approval.id),
    derivation: TILE_DERIVATIONS.approvals_required,
  };
}

/**
 * Failed runs per execution source, in the closed source order. The three
 * names are Phase 16's own execution kinds, so a failure and the cost of the
 * run that produced it name the same execution.
 */
export function deriveWorkflowFailures(
  research: readonly ResearchRequestRow[],
  outbound: readonly OutboundActionRow[],
  meetings: readonly MeetingRow[],
  meetingEvents: ReadonlyMap<string, readonly MeetingEventRow[]>,
): DashboardWorkflowFailuresTile {
  const counts: Readonly<Record<WorkflowFailureSource, number>> = {
    research_run: research.filter((row) => row.status === "failed").length,
    outbound_send: outbound.filter((row) => row.status === "failed").length,
    meeting_booking: meetings.reduce((sum, meeting) => {
      const events = meetingEvents.get(meeting.id) ?? [];
      return sum + events.filter((event) => event.kind === "booking_failed").length;
    }, 0),
  };
  const bySource: readonly DashboardFailureSourceCount[] = WORKFLOW_FAILURE_SOURCES.map(
    (entry) => ({ source: entry.source, count: counts[entry.source] }),
  );
  return {
    status: "derived",
    total: bySource.reduce((sum, entry) => sum + entry.count, 0),
    bySource,
    derivation: TILE_DERIVATIONS.workflow_failures,
  };
}

/** Assemble the whole snapshot. Pure: same rows in, same JSON out. */
export function deriveDashboard(input: DashboardDerivationInput): RevenueDashboard {
  const { currentlyQualified, everQualified } = splitQualifications(input.qualifications);
  const meetings = deriveMeetings(input.meetings);

  return {
    ruleVersion: DASHBOARD_RULE_VERSION,
    goal: deriveGoal(input.goals),
    directRevenue: unfedMoney("direct_revenue"),
    pipelineCreated: unfedMoney("pipeline_created"),
    qualifiedProspects: derivedCount("qualified_prospects", currentlyQualified.size),
    positiveConversations: derivedCount(
      "positive_conversations",
      countPositiveConversations(input.classifications),
    ),
    meetings,
    opportunities: derivedCount(
      "opportunities",
      countOpportunities(currentlyQualified, input.meetings),
    ),
    customers: unfedCount("customers"),
    agentActivity: deriveActivity(
      input.research,
      everQualified,
      input.drafts,
      input.classifications,
    ),
    approvalsRequired: deriveApprovals(input.approvals),
    workflowFailures: deriveWorkflowFailures(
      input.research,
      input.outbound,
      input.meetings,
      input.meetingEvents,
    ),
    hotConversations: derivedCount(
      "hot_conversations",
      input.board.recommendations.filter(
        (recommendation) => recommendation.supportingState === "response_needing_reply",
      ).length,
    ),
    cost: input.cost,
    nextBestActions: input.board,
  };
}
