/**
 * The Revenue Dashboard's published rule set — ROADMAP.md §24,
 * DEALORA_BLUEPRINT.md §34/§35.
 *
 * Everything a caller can see about how the dashboard decides what a tile
 * counts lives here, declared once as data: the fourteen tile keys (the
 * roadmap's twelve plus the two legs the Blueprint's four questions need),
 * the derivation of each, the three tiles no Phase 0–17 row can feed with
 * their owning phase, the four questions and the tiles that answer them, and
 * the positive-intent pair this phase **reads from Phase 13 rather than
 * re-declares**, because "what counts as a positive conversation" must have
 * one answer across the meeting engine, the recommendation engine and the
 * dashboard that reports on both.
 */

import { MEETABLE_INTENTS } from "@dealora/meeting";
import type { ConversationIntent, MeetingBookingState } from "@dealora/db";

import type {
  ActivityCounterDefinition,
  DashboardError,
  DashboardErrorCode,
  DashboardItemAvailability,
  DashboardItemKey,
  DashboardPolicyView,
  DashboardQuestion,
  WorkflowFailureDefinition,
} from "./types.js";

/** The rule set this dashboard answers under. Bumped only with the phase. */
export const DASHBOARD_RULE_VERSION = "dashboard-1.0.0";

/**
 * ROADMAP.md §24's twelve dashboard items, verbatim and in the roadmap's own
 * order. The tests assert this list against the roadmap text, so a tile
 * cannot be quietly added, dropped or renamed.
 */
export const DASHBOARD_ROADMAP_ITEMS: readonly DashboardItemKey[] = [
  "revenue_goal",
  "direct_revenue",
  "pipeline_created",
  "qualified_prospects",
  "positive_conversations",
  "meetings",
  "opportunities",
  "customers",
  "agent_activity",
  "approvals_required",
  "workflow_failures",
  "cost",
];

/**
 * The two extra legs DEALORA_BLUEPRINT.md §35 requires of the same home
 * screen: "hot conversations" under *what needs attention*, and the next
 * best action under *what should happen next* — the latter read from Phase
 * 14's own board, never re-derived here.
 */
export const DASHBOARD_CARRIED_ITEMS: readonly DashboardItemKey[] = [
  "hot_conversations",
  "next_best_actions",
];

/** All fourteen keys, roadmap order first. Derived from the two lists above. */
export const DASHBOARD_ITEM_KEYS: readonly DashboardItemKey[] = [
  ...DASHBOARD_ROADMAP_ITEMS,
  ...DASHBOARD_CARRIED_ITEMS,
];

/** Public labels, derived from the one declaration of each key. */
export const DASHBOARD_ITEM_LABELS: Readonly<Record<DashboardItemKey, string>> = {
  revenue_goal: "Revenue Goal",
  direct_revenue: "Direct Revenue",
  pipeline_created: "Pipeline Created",
  qualified_prospects: "Qualified Prospects",
  positive_conversations: "Positive Conversations",
  meetings: "Meetings",
  opportunities: "Opportunities",
  customers: "Customers",
  agent_activity: "Agent Activity",
  approvals_required: "Approvals Required",
  workflow_failures: "Workflow Failures",
  cost: "Cost",
  hot_conversations: "Hot Conversations",
  next_best_actions: "Next Best Actions",
};

/**
 * The three tiles no Phase 0–17 row can feed. Stated as refusals rather than
 * zeros: a dashboard that reported "$0 pipeline" would be claiming the
 * workspace has none, when the truth is that nothing records one yet.
 */
export const DASHBOARD_REFUSALS: readonly {
  readonly name: DashboardItemKey;
  readonly reason: string;
  readonly owningPhase: string | null;
}[] = [
  {
    name: "direct_revenue",
    reason:
      "no phase through 17 records a realized-revenue row: ROADMAP.md §24 reports Direct Revenue as an outcome, Phase 16 measures cost, and nothing yet books revenue — estimating it from the goal's own assumptions would invent a financial fact. BLUEPRINT.md §60's CRM integrations (Phase 23) would sync it.",
    owningPhase: "Phase 23",
  },
  {
    name: "pipeline_created",
    reason:
      "no phase through 17 stores an opportunity's value: qualifications and meetings carry no money, so pricing the pipeline from the goal's average deal value would be a financial assumption this phase does not make. BLUEPRINT.md §60's CRM integrations (Phase 23) would carry pipeline value.",
    owningPhase: "Phase 23",
  },
  {
    name: "customers",
    reason:
      "no phase through 17 records a customer: ROADMAP.md §24 reports Customers as a dashboard outcome and §30's CRM integrations (Phase 23) would sync them.",
    owningPhase: "Phase 23",
  },
];

/** How each tile is available through Phase 17, declared once. */
const AVAILABILITY: Readonly<Record<DashboardItemKey, DashboardItemAvailability>> = {
  revenue_goal: "conditional",
  direct_revenue: "unfed",
  pipeline_created: "unfed",
  qualified_prospects: "derived",
  positive_conversations: "derived",
  meetings: "derived",
  opportunities: "derived",
  customers: "unfed",
  agent_activity: "derived",
  approvals_required: "derived",
  workflow_failures: "derived",
  cost: "derived",
  hot_conversations: "derived",
  next_best_actions: "derived",
};

/**
 * How each tile is computed, stated once and printed by the policy route.
 * The engine stamps each built tile with its own entry, so a tile can never
 * narrate a derivation other than the published one.
 */
export const TILE_DERIVATIONS: Readonly<Record<DashboardItemKey, string>> = {
  revenue_goal:
    "the newest goal whose status is active — createdAt descending, id as the stable tiebreaker; no_data when the workspace has no active goal",
  direct_revenue: "a sum of realized-revenue rows; no phase through 17 records one",
  pipeline_created: "a sum of stored opportunity values; no phase through 17 stores one",
  qualified_prospects:
    "distinct accounts whose newest qualification (highest version, versions never reused) is `qualified` — the same rule Phase 15's opportunity node and Phase 16's denominator use",
  positive_conversations:
    "conversation classifications whose intent is one of the positive intents Phase 13 and Phase 14 already call positive, and that are not suppressed",
  meetings:
    "every stored meeting row, with a per-state breakdown in the closed meeting-state order — Phase 16 counts meetings the same way, so the word means one thing in both places",
  opportunities:
    "accounts that hold a qualified opportunity (newest qualification `qualified`) and whose loop has reached the calendar: at least one meeting in a calendar-reached state",
  customers: "distinct accounts with a recorded customer fact; no phase through 17 records one",
  agent_activity:
    "four counters over stored rows: accounts with a completed research run, accounts ever qualified, drafts rendered, replies classified",
  approvals_required: "approval requests with status `pending`, newest first, with their ids",
  workflow_failures:
    "failed rows per execution source: failed research runs, failed outbound actions, and booking_failed meeting events",
  cost: "Phase 16's WorkspaceCostMetrics, read through the cost engine's own boundary and never re-derived here",
  hot_conversations:
    "Phase 14 board recommendations whose supporting state is `response_needing_reply` — a reply a person must approve",
  next_best_actions:
    "Phase 14's workspace board, read through the recommendation engine's boundary",
};

/**
 * The goal selection rule, stated once. A draft, paused, completed or
 * archived goal is deliberately not promoted onto the home screen: the
 * dashboard reports the goal the workspace is working toward, and says
 * `no_data` rather than guessing which stored goal that is.
 */
export const GOAL_SELECTION_RULE =
  "the workspace's current goal is the newest goal with status `active` — createdAt descending, id as the stable tiebreaker; a workspace with no active goal answers no_data rather than promoting a draft, a paused, a completed or an archived goal";

/**
 * The positive-intent pair, **read from Phase 13** rather than re-declared:
 * `MEETABLE_INTENTS` is the meeting engine's own closed set, and Phase 14's
 * `positiveClassification` already reads the same pair for the same reason.
 * The dashboard joins them so all three surfaces agree on what "positive"
 * means; a new member would have to be added where the meeting engine decides
 * it, and every surface would move together.
 */
export const POSITIVE_CONVERSATION_INTENTS: readonly ConversationIntent[] = MEETABLE_INTENTS;

/**
 * The opportunity rule, stated once. BLUEPRINT.md §11's loop places
 * Opportunity after Meeting, and Phase 15 puts the opportunity behind a
 * `qualified` newest qualification; the dashboard counts an account only
 * when both hold — a recommendation that never reached a calendar is
 * activity, not an outcome.
 */
export const OPPORTUNITY_RULE =
  "an account counts as an opportunity when its newest qualification is `qualified` (Phase 15's opportunity node, Phase 16's denominator) and at least one of its meetings reached the calendar — BLUEPRINT.md §11's loop places Opportunity after Meeting, and a meeting that never reached a calendar is a recommendation, not an outcome";

/**
 * The meeting states that count as "reached the calendar". A booking
 * confirmed by the provider, a meeting that passed without cancellation, and
 * a no-show — all three were on a calendar. `cancelled`, `approved`,
 * `awaiting_approval` and `recommended` were not.
 */
export const OPPORTUNITY_MEETING_STATES: readonly MeetingBookingState[] = [
  "booked",
  "held",
  "no_show",
];

/**
 * Every meeting state, in Phase 13's own declaration order. The `byState`
 * breakdown walks this list, so the breakdown's shape never depends on which
 * rows happen to exist.
 */
export const MEETING_STATE_ORDER: readonly MeetingBookingState[] = [
  "recommended",
  "awaiting_approval",
  "approved",
  "booked",
  "held",
  "no_show",
  "cancelled",
];

/** The four Agent Activity counters, in the Blueprint's own reporting order. */
export const ACTIVITY_COUNTERS: readonly ActivityCounterDefinition[] = [
  {
    key: "accounts_researched",
    label: "accounts researched",
    derivation: "distinct accounts with at least one research request whose status is `completed`",
  },
  {
    key: "prospects_qualified",
    label: "prospects qualified",
    derivation:
      "distinct accounts with at least one qualification ever recorded as `qualified`, counting each account once however many versions it reached that state",
  },
  {
    key: "drafts_rendered",
    label: "drafts rendered",
    derivation: "every stored personalized draft row",
  },
  {
    key: "replies_classified",
    label: "replies classified",
    derivation: "every stored conversation classification row",
  },
];

/**
 * The three workflow-failure sources, named exactly as Phase 16 names the
 * executions it prices — the two vocabularies stay one vocabulary, so a
 * failure and its cost point at the same run.
 */
export const WORKFLOW_FAILURE_SOURCES: readonly WorkflowFailureDefinition[] = [
  {
    source: "research_run",
    derivation: "research requests whose status is `failed`",
  },
  {
    source: "outbound_send",
    derivation: "outbound actions whose status is `failed`",
  },
  {
    source: "meeting_booking",
    derivation: "`booking_failed` events across the workspace's meeting event trails",
  },
];

/**
 * BLUEPRINT.md §35's four questions, with the tiles that answer each. The
 * partition is exact: every key appears once and only once, and the tests
 * assert it, so no tile is orphaned and no question is left unanswered.
 */
export const DASHBOARD_QUESTIONS: readonly DashboardQuestion[] = [
  {
    question: "Where are we?",
    answeredBy: ["revenue_goal", "direct_revenue", "pipeline_created", "customers", "cost"],
  },
  {
    question: "What is working?",
    answeredBy: [
      "qualified_prospects",
      "positive_conversations",
      "meetings",
      "opportunities",
      "agent_activity",
    ],
  },
  {
    question: "What needs attention?",
    answeredBy: ["approvals_required", "workflow_failures", "hot_conversations"],
  },
  {
    question: "What should happen next?",
    answeredBy: ["next_best_actions"],
  },
];

/** The negative space, stated plainly and printed by the policy route. */
export const NEVER_DO: readonly string[] = [
  "never write: no table, no migration, no schema version — every tile is derived on read from rows another phase stored",
  "never act: no sender, approver, scheduler, provider, agent or workflow anywhere in this package — ROADMAP.md §25 puts the agent system in Phase 18",
  "never recommend: Phase 14 owns advice; the next-step tile reads its board, this phase adds none of its own",
  "never fabricate: a tile with no backing row reports no_data with its owning phase — never a zero, an estimate or a forecast",
  "never trust a client total: every number is recomputed from the workspace's own rows on each request",
  "never do float money arithmetic: money tiles carry whole minor units and the cost tile is Phase 16's engine, read whole",
  "never cross a workspace: every read is workspace-scoped with the caller's own identity, and a foreign workspace reads as denied",
];

/** Build a dashboard refusal that names the offending field. */
export function dashboardError(
  code: DashboardErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): DashboardError {
  return details && details.length > 0 ? { code, message, details } : { code, message };
}

/** The tile definitions, derived from the three declarations above. */
export function dashboardItems(): readonly {
  key: DashboardItemKey;
  label: string;
  availability: DashboardItemAvailability;
  derivation: string;
}[] {
  return DASHBOARD_ITEM_KEYS.map((key) => ({
    key,
    label: DASHBOARD_ITEM_LABELS[key],
    availability: AVAILABILITY[key],
    derivation: TILE_DERIVATIONS[key],
  }));
}

/** The whole rule set, as data — readable before a single row exists. */
export function describeDashboardPolicy(): DashboardPolicyView {
  return {
    ruleVersion: DASHBOARD_RULE_VERSION,
    items: dashboardItems(),
    refusals: DASHBOARD_REFUSALS,
    questions: DASHBOARD_QUESTIONS,
    goalSelectionRule: GOAL_SELECTION_RULE,
    positiveConversationIntents: POSITIVE_CONVERSATION_INTENTS,
    opportunityRule: OPPORTUNITY_RULE,
    opportunityMeetingStates: OPPORTUNITY_MEETING_STATES,
    meetingStates: MEETING_STATE_ORDER,
    activityCounters: ACTIVITY_COUNTERS,
    workflowFailureSources: WORKFLOW_FAILURE_SOURCES,
    neverDoes: NEVER_DO,
  };
}
