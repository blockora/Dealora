import { describe, expect, it } from "vitest";

import {
  countOpportunities,
  countPositiveConversations,
  deriveActivity,
  deriveApprovals,
  deriveDashboard,
  deriveGoal,
  deriveMeetings,
  deriveWorkflowFailures,
  splitQualifications,
} from "./engine.js";
import type { DashboardDerivationInput } from "./engine.js";
import {
  DASHBOARD_CARRIED_ITEMS,
  DASHBOARD_ITEM_KEYS,
  DASHBOARD_REFUSALS,
  DASHBOARD_ROADMAP_ITEMS,
  MEETING_STATE_ORDER,
  OPPORTUNITY_MEETING_STATES,
  POSITIVE_CONVERSATION_INTENTS,
  describeDashboardPolicy,
} from "./rules.js";
import type {
  ApprovalRow,
  ClassificationRow,
  DraftRow,
  MeetingEventRow,
  MeetingRow,
  OutboundActionRow,
  ResearchRequestRow,
  RevenueGoalRow,
  WorkspaceCostMetrics,
} from "./types.js";

const activeGoal: RevenueGoalRow = {
  id: "g-active",
  status: "active",
  targetMetric: "pipeline",
  targetValue: 1000,
  currency: "USD",
  timeWindow: { start: "2026-09-01", end: "2026-12-31" },
  createdAt: "2026-08-01T00:00:00.000Z",
};

const draftGoal: RevenueGoalRow = { ...activeGoal, id: "g-draft", status: "draft" };
const pausedGoal: RevenueGoalRow = { ...activeGoal, id: "g-paused", status: "paused" };
const archivedGoal: RevenueGoalRow = { ...activeGoal, id: "g-archived", status: "archived" };
const completedGoal: RevenueGoalRow = { ...activeGoal, id: "g-completed", status: "completed" };
const olderActiveGoal: RevenueGoalRow = {
  ...activeGoal,
  id: "g-older",
  createdAt: "2026-05-01T00:00:00.000Z",
};
const newerActiveGoal: RevenueGoalRow = {
  ...activeGoal,
  id: "g-newer",
  createdAt: "2026-09-01T00:00:00.000Z",
};

/** A cost picture with no recorded execution — Phase 16's own empty answer. */
const emptyCost: WorkspaceCostMetrics = {
  ruleVersion: "cost-1.0.0",
  totals: {
    currency: null,
    eventCount: 0,
    totalMinor: 0,
    estimatedMinor: 0,
    measuredMinor: 0,
    supersededEstimateMinor: 0,
    byCategory: [],
  },
  denominators: { prospects: 0, qualifiedOpportunities: 0, meetings: 0 },
  metrics: [],
  refused: [],
};

/** Derivation input for an empty workspace: every row type present but empty. */
function emptyInput(): DashboardDerivationInput {
  return {
    goals: [],
    qualifications: [],
    classifications: [],
    meetings: [],
    meetingEvents: new Map(),
    research: [],
    drafts: [],
    approvals: [],
    outbound: [],
    cost: emptyCost,
    board: { ruleVersion: "next-action-1.0.0", recommendations: [] },
  };
}

describe("deriveGoal", () => {
  it("reports the newest active goal", () => {
    const tile = deriveGoal([olderActiveGoal, newerActiveGoal, activeGoal]);
    expect(tile.status).toBe("derived");
    expect(tile.goal?.id).toBe(newerActiveGoal.id);
    expect(tile.goal).toEqual({
      id: newerActiveGoal.id,
      targetMetric: newerActiveGoal.targetMetric,
      targetValue: newerActiveGoal.targetValue,
      currency: newerActiveGoal.currency,
      timeWindow: { start: "2026-09-01", end: "2026-12-31" },
      status: "active",
    });
    expect(tile.reason).toBeNull();
    expect(tile.owningPhase).toBeNull();
    expect(tile.derivation).toContain("newest goal whose status is active");
  });

  it("breaks a createdAt tie on the higher id, whichever order the rows arrive in", () => {
    const lower: RevenueGoalRow = { ...activeGoal, id: "g-aaa" };
    const higher: RevenueGoalRow = { ...activeGoal, id: "g-zzz" };
    expect(deriveGoal([lower, higher]).goal?.id).toBe("g-zzz");
    expect(deriveGoal([higher, lower]).goal?.id).toBe("g-zzz");
  });

  it("never promotes a goal that is not active", () => {
    for (const nonActive of [draftGoal, pausedGoal, completedGoal, archivedGoal]) {
      const tile = deriveGoal([nonActive]);
      expect(tile.status).toBe("no_data");
      expect(tile.goal).toBeNull();
      expect(tile.reason).toBe("this workspace has no active revenue goal");
      // No phase is missing here: the absence is workspace state, so no
      // owning phase is invented.
      expect(tile.owningPhase).toBeNull();
    }
  });

  it("answers no_data for a workspace with no goals at all", () => {
    expect(deriveGoal([]).status).toBe("no_data");
  });

  it("does not mutate the rows it was given", () => {
    const goals: readonly RevenueGoalRow[] = Object.freeze([olderActiveGoal, newerActiveGoal]);
    const before = goals.map((goal) => goal.id);
    deriveGoal(goals);
    expect(goals.map((goal) => goal.id)).toEqual(before);
  });
});

describe("splitQualifications", () => {
  it("separates accounts whose newest version is qualified from accounts that ever were", () => {
    const { currentlyQualified, everQualified } = splitQualifications([
      { accountId: "a", version: 1, state: "qualified" },
      { accountId: "a", version: 2, state: "unqualified" },
      { accountId: "b", version: 1, state: "qualified" },
      { accountId: "b", version: 2, state: "qualified" },
      { accountId: "c", version: 1, state: "insufficient_data" },
    ]);
    // `a` qualified once and then regressed: activity, not a current outcome.
    expect([...currentlyQualified]).toEqual(["b"]);
    expect([...everQualified].sort()).toEqual(["a", "b"]);
  });

  it("counts an account once however many versions reached qualified", () => {
    const { everQualified } = splitQualifications([
      { accountId: "a", version: 1, state: "qualified" },
      { accountId: "a", version: 2, state: "unqualified" },
      { accountId: "a", version: 3, state: "qualified" },
    ]);
    expect(everQualified.size).toBe(1);
  });

  it("treats every non-qualified state as not qualified", () => {
    const { currentlyQualified, everQualified } = splitQualifications([
      { accountId: "a", version: 1, state: "insufficient_data" },
      { accountId: "b", version: 1, state: "contested" },
      { accountId: "c", version: 1, state: "unqualified" },
    ]);
    expect(currentlyQualified.size).toBe(0);
    expect(everQualified.size).toBe(0);
  });

  it("handles an empty qualification table", () => {
    const { currentlyQualified, everQualified } = splitQualifications([]);
    expect(currentlyQualified.size).toBe(0);
    expect(everQualified.size).toBe(0);
  });
});

describe("countPositiveConversations", () => {
  it("counts non-suppressed classifications whose intent Phase 13 calls positive", () => {
    const classifications: readonly ClassificationRow[] = [
      { intent: "positive_intent", suppressed: false },
      { intent: "interested", suppressed: false },
      { intent: "positive_intent", suppressed: true },
      { intent: "pricing", suppressed: false },
      { intent: "question", suppressed: false },
      { intent: "negative_intent", suppressed: false },
      { intent: "unsubscribe", suppressed: false },
      { intent: "interested", suppressed: true },
    ];
    expect(countPositiveConversations(classifications)).toBe(2);
  });

  it("counts every conversation kind exactly once when all of them are positive", () => {
    const classifications = POSITIVE_CONVERSATION_INTENTS.map((intent): ClassificationRow => ({
      intent,
      suppressed: false,
    }));
    expect(countPositiveConversations(classifications)).toBe(POSITIVE_CONVERSATION_INTENTS.length);
  });

  it("answers zero for an empty classification table", () => {
    expect(countPositiveConversations([])).toBe(0);
  });

  it("counts nothing when every positive classification is suppressed", () => {
    const classifications = POSITIVE_CONVERSATION_INTENTS.map((intent): ClassificationRow => ({
      intent,
      suppressed: true,
    }));
    expect(countPositiveConversations(classifications)).toBe(0);
  });
});

describe("deriveMeetings", () => {
  it("counts every row and breaks them down in the closed state order", () => {
    const meetings: readonly MeetingRow[] = [
      { id: "m1", accountId: "a1", state: "booked" },
      { id: "m2", accountId: "a2", state: "no_show" },
      { id: "m3", accountId: "a3", state: "recommended" },
      { id: "m4", accountId: "a4", state: "booked" },
    ];
    const tile = deriveMeetings(meetings);
    expect(tile.status).toBe("derived");
    expect(tile.total).toBe(4);
    expect(tile.byState.map((entry) => entry.state)).toEqual(MEETING_STATE_ORDER);
    expect(tile.byState).toEqual([
      { state: "recommended", count: 1 },
      { state: "awaiting_approval", count: 0 },
      { state: "approved", count: 0 },
      { state: "booked", count: 2 },
      { state: "held", count: 0 },
      { state: "no_show", count: 1 },
      { state: "cancelled", count: 0 },
    ]);
  });

  it("keeps the per-state counts equal to the total for every state", () => {
    const meetings: readonly MeetingRow[] = MEETING_STATE_ORDER.map((state, index) => ({
      id: `m${index}`,
      accountId: `a${index}`,
      state,
    }));
    const tile = deriveMeetings(meetings);
    expect(tile.total).toBe(MEETING_STATE_ORDER.length);
    expect(tile.byState.every((entry) => entry.count === 1)).toBe(true);
  });

  it("answers zero across every state for an empty meeting table", () => {
    const tile = deriveMeetings([]);
    expect(tile.total).toBe(0);
    expect(tile.byState).toHaveLength(MEETING_STATE_ORDER.length);
    expect(tile.byState.every((entry) => entry.count === 0)).toBe(true);
  });
});

describe("countOpportunities", () => {
  it("counts a qualified account once when any of its meetings reached a calendar", () => {
    const currentlyQualified = new Set(["q1", "q2", "q3"]);
    const meetings: readonly MeetingRow[] = [
      { id: "m1", accountId: "q1", state: "held" },
      { id: "m2", accountId: "q1", state: "cancelled" },
      { id: "m3", accountId: "q1", state: "booked" },
      { id: "m4", accountId: "q2", state: "recommended" },
      { id: "m5", accountId: "q3", state: "no_show" },
    ];
    // q1 is counted once despite three meetings; q2 never reached a calendar.
    expect(countOpportunities(currentlyQualified, meetings)).toBe(2);
  });

  it("counts every calendar-reached state and no other", () => {
    const meetings = OPPORTUNITY_MEETING_STATES.map((state, index): MeetingRow => ({
      id: `m${index}`,
      accountId: "q1",
      state,
    }));
    expect(countOpportunities(new Set(["q1"]), meetings)).toBe(1);
    const neverReached = MEETING_STATE_ORDER.filter(
      (state) => !OPPORTUNITY_MEETING_STATES.includes(state),
    ).map((state, index): MeetingRow => ({ id: `n${index}`, accountId: "q1", state }));
    expect(countOpportunities(new Set(["q1"]), neverReached)).toBe(0);
  });

  it("ignores a calendar-reached meeting for an account that is not qualified", () => {
    const meetings: readonly MeetingRow[] = [{ id: "m1", accountId: "other", state: "booked" }];
    expect(countOpportunities(new Set(["q1"]), meetings)).toBe(0);
  });

  it("answers zero for a workspace with no qualified accounts", () => {
    expect(countOpportunities(new Set(), [])).toBe(0);
  });
});

describe("deriveActivity", () => {
  const research: readonly ResearchRequestRow[] = [
    { accountId: "a1", status: "completed" },
    { accountId: "a1", status: "failed" },
    { accountId: "a2", status: "completed" },
    { accountId: "a3", status: "running" },
  ];
  const classifications: readonly ClassificationRow[] = [
    { intent: "positive_intent", suppressed: false },
    { intent: "question", suppressed: false },
    { intent: "interested", suppressed: true },
  ];
  const drafts: readonly DraftRow[] = [{ id: "d1" }, { id: "d2" }, { id: "d3" }];

  it("reports the four counters in the published order", () => {
    const counters = deriveActivity(research, new Set(["a1", "a2"]), drafts, classifications);
    expect(counters.map((counter) => counter.key)).toEqual([
      "accounts_researched",
      "prospects_qualified",
      "drafts_rendered",
      "replies_classified",
    ]);
    const byKey = new Map(counters.map((counter) => [counter.key, counter.count]));
    // a1 is researched and also failed; it is one researched account.
    expect(byKey.get("accounts_researched")).toBe(2);
    expect(byKey.get("prospects_qualified")).toBe(2);
    expect(byKey.get("drafts_rendered")).toBe(3);
    // Every classification counts, including suppressed ones: replies were
    // read whether or not they were acted on.
    expect(byKey.get("replies_classified")).toBe(3);
  });

  it("stamps each counter with its published label and derivation", () => {
    const counters = deriveActivity([], new Set(), [], []);
    expect(counters.map((counter) => counter.label)).toEqual([
      "accounts researched",
      "prospects qualified",
      "drafts rendered",
      "replies classified",
    ]);
    expect(counters.every((counter) => counter.derivation.length > 0)).toBe(true);
  });

  it("does not count a research run that never completed", () => {
    const counters = deriveActivity(
      [
        { accountId: "a1", status: "failed" },
        { accountId: "a2", status: "cancelled" },
        { accountId: "a3", status: "pending" },
      ],
      new Set(),
      [],
      [],
    );
    expect(counters[0]?.count).toBe(0);
  });

  it("answers zero for every counter when nothing is stored", () => {
    const counters = deriveActivity([], new Set(), [], []);
    expect(counters.every((counter) => counter.count === 0)).toBe(true);
  });
});

describe("deriveApprovals", () => {
  it("reports pending requests in the store's own order with their ids", () => {
    const approvals: readonly ApprovalRow[] = [
      { id: "ap-3", status: "pending" },
      { id: "ap-1", status: "approved" },
      { id: "ap-2", status: "pending" },
      { id: "ap-4", status: "rejected" },
      { id: "ap-5", status: "changes_requested" },
      { id: "ap-6", status: "expired" },
      { id: "ap-7", status: "cancelled" },
    ];
    const tile = deriveApprovals(approvals);
    expect(tile.status).toBe("derived");
    expect(tile.required).toBe(2);
    expect(tile.approvalIds).toEqual(["ap-3", "ap-2"]);
  });

  it("answers zero for an empty approval table", () => {
    const tile = deriveApprovals([]);
    expect(tile.required).toBe(0);
    expect(tile.approvalIds).toEqual([]);
  });
});

describe("deriveWorkflowFailures", () => {
  it("counts failed runs per source in the closed source order", () => {
    const research: readonly ResearchRequestRow[] = [
      { accountId: "a1", status: "completed" },
      { accountId: "a2", status: "failed" },
      { accountId: "a3", status: "failed" },
    ];
    const outbound: readonly OutboundActionRow[] = [
      { status: "sent" },
      { status: "failed" },
      { status: "cancelled" },
    ];
    const meetings: readonly MeetingRow[] = [
      { id: "m1", accountId: "a1", state: "booked" },
      { id: "m2", accountId: "a2", state: "held" },
    ];
    const events = new Map<string, readonly MeetingEventRow[]>([
      [
        "m1",
        [{ kind: "booking_attempted" }, { kind: "booking_failed" }, { kind: "booking_failed" }],
      ],
      ["m2", [{ kind: "booking_attempted" }, { kind: "booking_attempted" }, { kind: "booked" }]],
    ]);
    const tile = deriveWorkflowFailures(research, outbound, meetings, events);
    expect(tile.bySource).toEqual([
      { source: "research_run", count: 2 },
      { source: "outbound_send", count: 1 },
      { source: "meeting_booking", count: 2 },
    ]);
    expect(tile.total).toBe(5);
  });

  it("treats a meeting with no recorded events as no failures, not as an error", () => {
    const meetings: readonly MeetingRow[] = [{ id: "m1", accountId: "a1", state: "booked" }];
    const tile = deriveWorkflowFailures([], [], meetings, new Map());
    expect(tile.bySource).toEqual([
      { source: "research_run", count: 0 },
      { source: "outbound_send", count: 0 },
      { source: "meeting_booking", count: 0 },
    ]);
    expect(tile.total).toBe(0);
  });

  it("ignores an event trail stored for a meeting that is not in this workspace", () => {
    const meetings: readonly MeetingRow[] = [{ id: "m1", accountId: "a1", state: "booked" }];
    const events = new Map<string, readonly MeetingEventRow[]>([
      ["m-foreign", [{ kind: "booking_failed" }, { kind: "booking_failed" }]],
    ]);
    const tile = deriveWorkflowFailures([], [], meetings, events);
    expect(tile.bySource[2]?.count).toBe(0);
    expect(tile.total).toBe(0);
  });

  it("answers zero across every source for empty inputs", () => {
    const tile = deriveWorkflowFailures([], [], [], new Map());
    expect(tile.total).toBe(0);
    expect(tile.bySource).toHaveLength(3);
    expect(tile.bySource.every((entry) => entry.count === 0)).toBe(true);
  });
});

describe("deriveDashboard", () => {
  /** A workspace whose rows exercise every derived tile at once. */
  function populatedInput(): DashboardDerivationInput {
    return {
      goals: [activeGoal, draftGoal, archivedGoal],
      qualifications: [
        { accountId: "a1", version: 1, state: "qualified" },
        { accountId: "a2", version: 1, state: "unqualified" },
        { accountId: "a3", version: 1, state: "qualified" },
        { accountId: "a3", version: 2, state: "qualified" },
      ],
      classifications: [
        { intent: "positive_intent", suppressed: false },
        { intent: "interested", suppressed: false },
        { intent: "question", suppressed: false },
        { intent: "positive_intent", suppressed: true },
      ],
      meetings: [
        { id: "m1", accountId: "a1", state: "booked" },
        { id: "m2", accountId: "a3", state: "recommended" },
      ],
      meetingEvents: new Map([["m1", [{ kind: "booking_attempted" }, { kind: "booked" }]]]),
      research: [
        { accountId: "a1", status: "completed" },
        { accountId: "a4", status: "completed" },
        { accountId: "a5", status: "failed" },
      ],
      drafts: [{ id: "d1" }, { id: "d2" }],
      approvals: [
        { id: "ap-1", status: "pending" },
        { id: "ap-2", status: "approved" },
        { id: "ap-3", status: "pending" },
      ],
      outbound: [{ status: "failed" }, { status: "sent" }, { status: "ready" }],
      cost: emptyCost,
      board: {
        ruleVersion: "next-action-1.0.0",
        recommendations: [
          {
            accountId: "a1",
            accountName: "Account One",
            action: "prepare_reply_for_approval",
            supportingState: "response_needing_reply",
            reason: "a reply needs a person",
            confidenceReasons: ["a stored reply needs a reply"],
            confidence: "high",
            riskLevel: "level_1_draft",
            approvalRequired: false,
            expectedOutcome: "reply_prepared",
            evidenceIds: [],
            claimIds: [],
            ruleVersion: "next-action-1.0.0",
          },
          {
            accountId: "a2",
            accountName: "Account Two",
            action: "qualify_account",
            supportingState: "evidenced_without_qualification",
            reason: "evidence exists",
            confidenceReasons: ["evidence exists"],
            confidence: "medium",
            riskLevel: "level_1_draft",
            approvalRequired: false,
            expectedOutcome: "qualification_available",
            evidenceIds: [],
            claimIds: [],
            ruleVersion: "next-action-1.0.0",
          },
        ],
      },
    };
  }

  it("derives every tile from the stored rows", () => {
    const output = deriveDashboard(populatedInput());

    expect(output.ruleVersion).toBe("dashboard-1.0.0");
    expect(output.goal.status).toBe("derived");
    expect(output.goal.goal?.id).toBe(activeGoal.id);
    // a3 reached qualified on two versions and is still counted once.
    expect(output.qualifiedProspects.value).toBe(2);
    expect(output.positiveConversations.value).toBe(2);
    expect(output.meetings.total).toBe(2);
    // Only a1 is both qualified and on a calendar; a3 is qualified but its
    // meeting was only recommended.
    expect(output.opportunities.value).toBe(1);
    expect(output.approvalsRequired.required).toBe(2);
    expect(output.approvalsRequired.approvalIds).toEqual(["ap-1", "ap-3"]);
    expect(output.workflowFailures.total).toBe(2);
    expect(output.workflowFailures.bySource).toEqual([
      { source: "research_run", count: 1 },
      { source: "outbound_send", count: 1 },
      { source: "meeting_booking", count: 0 },
    ]);
    expect(output.hotConversations.value).toBe(1);

    const activity = new Map(output.agentActivity.map((entry) => [entry.key, entry.count]));
    expect(activity.get("accounts_researched")).toBe(2);
    expect(activity.get("prospects_qualified")).toBe(2);
    expect(activity.get("drafts_rendered")).toBe(2);
    expect(activity.get("replies_classified")).toBe(4);
  });

  it("embeds the cost picture and the board whole, without re-deriving either", () => {
    const input = populatedInput();
    const output = deriveDashboard(input);
    expect(output.cost).toEqual(input.cost);
    expect(output.nextBestActions).toEqual(input.board);
  });

  it("refuses the three tiles no Phase 0-17 row can feed, with the owning phase", () => {
    const output = deriveDashboard(populatedInput());
    for (const tile of [output.directRevenue, output.pipelineCreated]) {
      expect(tile.status).toBe("no_data");
      expect(tile.amountMinor).toBeNull();
      expect(tile.currency).toBeNull();
      expect(tile.reason).toContain("no phase through 17");
      expect(tile.owningPhase).toBe("Phase 23");
    }
    expect(output.customers).toEqual({
      status: "no_data",
      value: null,
      reason: expect.stringContaining("no phase through 17"),
      owningPhase: "Phase 23",
      derivation: expect.stringContaining("customer fact"),
    });
  });

  it("never turns a missing fact into a zero", () => {
    const output = deriveDashboard(emptyInput());
    // Rows exist for every table, so a count of zero is a real fact.
    expect(output.qualifiedProspects).toEqual({
      status: "derived",
      value: 0,
      reason: null,
      owningPhase: null,
      derivation: expect.stringContaining("newest qualification"),
    });
    expect(output.meetings.total).toBe(0);
    expect(output.approvalsRequired.required).toBe(0);
    expect(output.workflowFailures.total).toBe(0);
    expect(output.hotConversations.value).toBe(0);
    // The goal's premise is false rather than empty, so it refuses instead.
    expect(output.goal.status).toBe("no_data");
    expect(output.goal.goal).toBeNull();
  });

  it("is deterministic: the same rows print the same snapshot, byte for byte", () => {
    const input = populatedInput();
    const first = JSON.stringify(deriveDashboard(input));
    const second = JSON.stringify(deriveDashboard(input));
    expect(first).toBe(second);
  });

  it("does not mutate the input rows it was given", () => {
    const input = populatedInput();
    const snapshot = JSON.stringify({
      goals: input.goals,
      qualifications: input.qualifications,
      classifications: input.classifications,
      meetings: input.meetings,
      research: input.research,
      drafts: input.drafts,
      approvals: input.approvals,
      outbound: input.outbound,
    });
    deriveDashboard(input);
    expect(
      JSON.stringify({
        goals: input.goals,
        qualifications: input.qualifications,
        classifications: input.classifications,
        meetings: input.meetings,
        research: input.research,
        drafts: input.drafts,
        approvals: input.approvals,
        outbound: input.outbound,
      }),
    ).toBe(snapshot);
  });
});

describe("dashboard policy", () => {
  const policy = describeDashboardPolicy();

  it("publishes the roadmap's twelve items and the two the Blueprint adds", () => {
    expect(DASHBOARD_ROADMAP_ITEMS).toHaveLength(12);
    expect(DASHBOARD_CARRIED_ITEMS).toEqual(["hot_conversations", "next_best_actions"]);
    expect(DASHBOARD_ITEM_KEYS).toHaveLength(14);
    expect(policy.items.map((item) => item.key)).toEqual(DASHBOARD_ITEM_KEYS);
  });

  it("gives every item a label, an availability and a derivation", () => {
    expect(policy.items.map((item) => item.label)).toEqual([
      "Revenue Goal",
      "Direct Revenue",
      "Pipeline Created",
      "Qualified Prospects",
      "Positive Conversations",
      "Meetings",
      "Opportunities",
      "Customers",
      "Agent Activity",
      "Approvals Required",
      "Workflow Failures",
      "Cost",
      "Hot Conversations",
      "Next Best Actions",
    ]);
    expect(policy.items.map((item) => item.availability)).toEqual([
      "conditional",
      "unfed",
      "unfed",
      "derived",
      "derived",
      "derived",
      "derived",
      "unfed",
      "derived",
      "derived",
      "derived",
      "derived",
      "derived",
      "derived",
    ]);
    expect(policy.items.every((item) => item.derivation.length > 0)).toBe(true);
  });

  it("answers the Blueprint's four questions with a partition of every item", () => {
    expect(policy.questions.map((entry) => entry.question)).toEqual([
      "Where are we?",
      "What is working?",
      "What needs attention?",
      "What should happen next?",
    ]);
    const answered = policy.questions.flatMap((entry) => entry.answeredBy);
    // Every item answers exactly one question: no tile is orphaned and none
    // is counted twice.
    expect([...answered].sort()).toEqual([...DASHBOARD_ITEM_KEYS].sort());
    expect(new Set(answered).size).toBe(answered.length);
  });

  it("names the owning phase for each refused tile", () => {
    expect(DASHBOARD_REFUSALS.map((entry) => entry.name)).toEqual([
      "direct_revenue",
      "pipeline_created",
      "customers",
    ]);
    expect(policy.refusals.every((entry) => entry.owningPhase === "Phase 23")).toBe(true);
    expect(policy.refusals.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("reuses Phase 13's positive intents and Phase 13's meeting states", () => {
    expect(POSITIVE_CONVERSATION_INTENTS).toEqual(["positive_intent", "interested"]);
    expect(policy.positiveConversationIntents).toEqual(POSITIVE_CONVERSATION_INTENTS);
    expect(policy.meetingStates).toEqual(MEETING_STATE_ORDER);
    expect(policy.opportunityMeetingStates).toEqual(OPPORTUNITY_MEETING_STATES);
    expect(OPPORTUNITY_MEETING_STATES.every((state) => MEETING_STATE_ORDER.includes(state))).toBe(
      true,
    );
  });

  it("states the goal selection and opportunity rules once, in words", () => {
    expect(policy.goalSelectionRule).toContain("newest goal with status `active`");
    expect(policy.opportunityRule).toContain("newest qualification is `qualified`");
  });

  it("publishes the four activity counters and the three failure sources", () => {
    expect(policy.activityCounters.map((entry) => entry.key)).toEqual([
      "accounts_researched",
      "prospects_qualified",
      "drafts_rendered",
      "replies_classified",
    ]);
    expect(policy.workflowFailureSources.map((entry) => entry.source)).toEqual([
      "research_run",
      "outbound_send",
      "meeting_booking",
    ]);
  });

  it("states the phase's negative space", () => {
    const negative = policy.neverDoes.join(" ");
    expect(negative).toContain("never write");
    expect(negative).toContain("never act");
    expect(negative).toContain("never recommend");
    expect(negative).toContain("never fabricate");
    expect(negative).toContain("never trust a client total");
    expect(negative).toContain("never do float money arithmetic");
    expect(negative).toContain("never cross a workspace");
  });
});
