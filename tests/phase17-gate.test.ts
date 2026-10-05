import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { SandboxEmailProvider } from "@dealora/outbound";
import { SandboxCalendarProvider } from "@dealora/meeting";
import { previewDigest } from "@dealora/approval";

/**
 * Phase 17 gate — ROADMAP.md §24.
 *
 * Its gate is one sentence: *a user can see the revenue workflow as business
 * outcomes, not just technical activity.* This file therefore drives real
 * accounts through real phases — a research run that completed, an account that
 * qualified, a draft that was rendered, an approval a person still owes a
 * decision on — and then reads the dashboard back and checks that what it
 * reports is the outcome of that work rather than the work itself.
 *
 * The properties under test are the phase's integrity story:
 *
 * - **Outcomes, not activity.** `qualified_prospects` counts accounts that are
 *   qualified *now*; `opportunities` counts only those whose loop actually
 *   reached a calendar. An account that regressed out of `qualified` is
 *   counted as activity and not as an outcome, and the two tiles never agree
 *   by accident.
 * - **Derived, never stored.** Every tile is recomputed from the rows the other
 *   phases wrote. The gate proves it by snapshotting every table before the
 *   reads and re-checking after, so "reading a dashboard" is provably a read.
 * - **No fabricated financial fact.** Direct Revenue, Pipeline Created and
 *   Customers report `no_data` with the phase that owns them, never a zero:
 *   "nothing records this yet" and "this is worth nothing" are different
 *   claims.
 * - **The four questions.** `DEALORA_BLUEPRINT.md` §35's questions are answered
 *   by a partition of the published tiles, so no tile is orphaned and none is
 *   claimed twice.
 * - **One answer per word.** The dashboard reports Phase 16's cost picture and
 *   Phase 14's board **whole**, and reads the same "positive" and "qualified"
 *   vocabularies those phases decide, so the three surfaces cannot disagree.
 * - **Deterministic and tenant-scoped.** The same rows print byte-identical
 *   JSON on every read, and one tenant's rows can never appear in another's
 *   dashboard.
 *
 * The email and calendar providers are sandboxes and the research provider is
 * the built-in account-record provider: no network I/O exists in this phase.
 */

let seq = 0;
/** Unique per test run, so parallel and repeated runs never collide. */
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Date.now()}`;
}

function request(
  token: string,
  params: Record<string, string>,
  body?: unknown,
  query?: Record<string, unknown>,
): RequestBody {
  return { body, query: { sessionToken: token, ...(query ?? {}) }, params };
}

async function dataOf(result: Promise<Result<ApiResponse<unknown>, ApiError>>): Promise<unknown> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(`expected success, got ${resolved.error.code}: ${resolved.error.message}`);
  }
  if (resolved.value.status !== "ok") throw new Error("expected an ok response envelope");
  return resolved.value.data;
}

async function errorOf(result: Promise<Result<ApiResponse<unknown>, ApiError>>): Promise<ApiError> {
  const resolved = await result;
  if (resolved.ok) throw new Error("expected a failure");
  return resolved.error;
}

function handlersFor(): ReturnType<typeof createDefaultHandlers> {
  return createDefaultHandlers({
    outboundProviders: [new SandboxEmailProvider()],
    calendarProviders: [new SandboxCalendarProvider()],
  });
}

function tenant(
  name: string,
  email: string,
): { token: string; userId: string; workspaceId: string } {
  const owner = signup(email, "correct-horse-battery", name);
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

type Handlers = ReturnType<typeof createDefaultHandlers>;

interface GateCountTile {
  status: string;
  value: number | null;
  reason: string | null;
  owningPhase: string | null;
  derivation: string;
}

interface GateMoneyTile {
  status: string;
  amountMinor: number | null;
  currency: string | null;
  reason: string | null;
  owningPhase: string | null;
}

interface GateGoalTile {
  status: string;
  goal: { id: string; targetMetric: string; targetValue: number; currency: string | null } | null;
  reason: string | null;
  owningPhase: string | null;
}

interface GateDashboard {
  ruleVersion: string;
  goal: GateGoalTile;
  directRevenue: GateMoneyTile;
  pipelineCreated: GateMoneyTile;
  qualifiedProspects: GateCountTile;
  positiveConversations: GateCountTile;
  meetings: { status: string; total: number; byState: { state: string; count: number }[] };
  opportunities: GateCountTile;
  customers: GateCountTile;
  agentActivity: { key: string; label: string; count: number; derivation: string }[];
  approvalsRequired: { status: string; required: number; approvalIds: string[] };
  workflowFailures: {
    status: string;
    total: number;
    bySource: { source: string; count: number }[];
  };
  hotConversations: GateCountTile;
  cost: { ruleVersion: string; totals: { totalMinor: number; eventCount: number } };
  nextBestActions: { ruleVersion: string; recommendations: unknown[] };
}

interface GatePolicy {
  ruleVersion: string;
  items: { key: string; label: string; availability: string; derivation: string }[];
  refusals: { name: string; reason: string; owningPhase: string | null }[];
  questions: { question: string; answeredBy: string[] }[];
  goalSelectionRule: string;
  opportunityRule: string;
  positiveConversationIntents: string[];
  meetingStates: string[];
  activityCounters: { key: string; label: string }[];
  workflowFailureSources: { source: string; derivation: string }[];
  neverDoes: string[];
}

/** A snapshot of every table the dashboard could conceivably read or write. */
function rowCounts(): Record<string, number> {
  const db = defaultStore.db;
  return {
    accounts: db.accounts?.length ?? 0,
    contacts: db.contacts?.length ?? 0,
    requests: db.researchRequests?.length ?? 0,
    findings: db.researchFindings?.length ?? 0,
    claims: db.accountClaims?.length ?? 0,
    evidence: db.evidence?.length ?? 0,
    qualifications: db.qualifications?.length ?? 0,
    drafts: db.personalizedDrafts?.length ?? 0,
    approvals: db.approvalRequests?.length ?? 0,
    actions: db.outboundActions?.length ?? 0,
    inbound: db.inboundMessages?.length ?? 0,
    classifications: db.conversationClassifications?.length ?? 0,
    meetings: db.meetings?.length ?? 0,
    briefs: db.meetingBriefs?.length ?? 0,
    recommendations: db.nextBestActions?.length ?? 0,
    costs: db.costEvents?.length ?? 0,
    goals: db.revenueGoals?.length ?? 0,
  };
}

/**
 * Create a real account and run real research against it through the routes,
 * returning the ids the dashboard will later derive from.
 */
async function researchedAccount(
  h: Handlers,
  t: { token: string; workspaceId: string },
  name: string,
): Promise<{ accountId: string; requestId: string }> {
  const account = (await dataOf(
    h.createAccountHandler(
      request(
        t.token,
        { workspaceId: t.workspaceId },
        {
          name,
          industry: "SaaS",
          companySize: "50-200",
          geography: "Germany",
        },
      ),
    ),
  )) as { account: { id: string } };
  const created = (await dataOf(
    h.createResearchRequestHandler(
      request(
        t.token,
        { workspaceId: t.workspaceId, accountId: account.account.id },
        { provider: "account_record", categories: ["company_overview"] },
      ),
    ),
  )) as { request: { id: string } };
  const run = (await dataOf(
    h.runResearchRequestHandler(request(t.token, { id: created.request.id })),
  )) as { request: { status: string } };
  expect(run.request.status).toBe("completed");
  return { accountId: account.account.id, requestId: created.request.id };
}

/**
 * Store a qualification through the real repository, in the exact shape Phase 8
 * persists.
 *
 * The Phase 8 engine itself needs a goal, an ICP and a plan behind it, which
 * this gate deliberately does not rebuild — that is Phase 8's own gate. What
 * Phase 17 must prove is that it reads whatever qualification rows exist, so
 * the row is written by the same store method the engine calls and the
 * dashboard is then asked to derive from it.
 */
function storeQualification(
  t: { userId: string; workspaceId: string },
  accountId: string,
  state: "qualified" | "contested",
): string {
  const stored = defaultStore.createQualification({
    workspaceId: t.workspaceId,
    createdBy: t.userId,
    accountId,
    qualification: {
      ruleVersion: "qualification-1.0.0",
      revenuePlanId: null,
      revenueGoalId: null,
      icpId: null,
      contextDigest: `digest-17-${state}`,
      state,
      score: state === "qualified" ? 80 : null,
      confidence: state === "qualified" ? "high" : null,
      reason:
        state === "qualified"
          ? "every criterion was met by the recorded evidence"
          : "two sources disagree about the company size",
      evidenceIds: [],
      claimIds: [],
      conflictedClaimIds: [],
      dimensions: [],
      evaluatedAt: "2026-06-02T00:00:00.000Z",
    },
  });
  if (!isOk(stored)) throw new Error(`fixture ${state} qualification failed`);
  return stored.value.id;
}

/**
 * Phase 10's own fingerprint of a draft, over the four fields it binds.
 *
 * The draft row names its version `version`; the fingerprint names the same
 * fact `draftVersion`, so the mapping is stated here rather than implied.
 */
function previewDigestOf(draft: {
  id: string;
  version: number;
  subject: string;
  body: string;
}): string {
  return previewDigest({
    draftId: draft.id,
    draftVersion: draft.version,
    subject: draft.subject,
    body: draft.body,
  });
}

/**
 * Render a draft and raise a real approval for it, both through Phase 9 and
 * Phase 10's own store methods — the rows the Approvals Required tile reads.
 */
function pendingApproval(
  t: { userId: string; workspaceId: string },
  accountId: string,
  qualificationId: string,
): string {
  const draft = defaultStore.createDraft({
    workspaceId: t.workspaceId,
    createdBy: t.userId,
    accountId,
    draft: {
      contactId: null,
      rendererVersion: "personalization-1.0.0",
      contextDigest: "digest-17-draft",
      qualificationId,
      offerId: null,
      subject: "A short note for Northwind",
      body: "A short note.",
      personalizationPoints: [],
      approvedClaimIds: [],
      warnings: [],
    },
  });
  if (!isOk(draft)) throw new Error("fixture draft failed");
  const approval = defaultStore.createApprovalRequest({
    workspaceId: t.workspaceId,
    createdBy: t.userId,
    approval: {
      actionKind: "send_message",
      riskLevel: "level_2_external_action",
      draftId: draft.value.id,
      draftVersion: draft.value.version,
      previewSubject: draft.value.subject,
      // The real fingerprint of the exact content, so Phase 10's decision
      // route re-derives the same value from the stored draft.
      previewDigest: previewDigestOf(draft.value),
      expiresAt: null,
    },
  });
  if (!isOk(approval)) throw new Error("fixture approval failed");
  return approval.value.id;
}

async function dashboard(
  h: Handlers,
  t: { token: string; workspaceId: string },
): Promise<GateDashboard> {
  return (await dataOf(
    h.getDashboardHandler(request(t.token, { workspaceId: t.workspaceId })),
  )) as GateDashboard;
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 17 gate — revenue dashboard", () => {
  it("shows the revenue workflow as business outcomes, not technical activity", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");

    // Phase 5/6: two real accounts, both researched to completion.
    const northwind = await researchedAccount(h, t, "Northwind");
    const globex = await researchedAccount(h, t, "Globex");

    // Phase 8: both accounts qualify — the loop's own outcome, not its steps.
    for (const accountId of [northwind.accountId, globex.accountId]) {
      storeQualification(t, accountId, "qualified");
    }

    const empty = await dashboard(h, t);

    // **Where are we?** A workspace with no goal yet is told so, not given a
    // fabricated target.
    expect(empty.goal.status).toBe("no_data");
    expect(empty.goal.goal).toBeNull();

    // **What is working?** Two accounts qualified — an outcome.
    expect(empty.qualifiedProspects.status).toBe("derived");
    expect(empty.qualifiedProspects.value).toBe(2);
    expect(empty.qualifiedProspects.reason).toBeNull();

    // ...while "Agent Activity" reports the *work*, which is a different
    // claim: two accounts researched, two prospects qualified, and nothing
    // rendered or classified yet.
    const activity = new Map(empty.agentActivity.map((entry) => [entry.key, entry.count]));
    expect(activity.get("accounts_researched")).toBe(2);
    expect(activity.get("prospects_qualified")).toBe(2);
    expect(activity.get("drafts_rendered")).toBe(0);
    expect(activity.get("replies_classified")).toBe(0);

    // **Opportunities are not qualified prospects.** Nothing reached a calendar
    // yet, so the outcome count is zero while the activity count is two. That
    // gap is the whole distinction ROADMAP.md §24 is about.
    expect(empty.opportunities.value).toBe(0);
    expect(empty.meetings.total).toBe(0);

    // **No fabricated financial fact.** Three tiles have no backing row through
    // Phase 17 and say so, naming the phase that owns them.
    for (const tile of [empty.directRevenue, empty.pipelineCreated]) {
      expect(tile.status).toBe("no_data");
      expect(tile.amountMinor).toBeNull();
      expect(tile.currency).toBeNull();
      expect(tile.owningPhase).toBe("Phase 23");
    }
    expect(empty.customers.status).toBe("no_data");
    expect(empty.customers.value).toBeNull();
    expect(empty.customers.owningPhase).toBe("Phase 23");

    // **What needs attention?** Nothing is owed a decision yet.
    expect(empty.approvalsRequired.required).toBe(0);
    expect(empty.workflowFailures.total).toBe(0);
    expect(empty.hotConversations.value).toBe(0);

    // **What should happen next?** Phase 14's board, read whole rather than
    // re-derived, so the dashboard cannot give advice of its own.
    expect(empty.nextBestActions.ruleVersion).toBe("next-action-1.0.0");
    expect(empty.nextBestActions.recommendations.length).toBeGreaterThan(0);
  });

  it("reports an approved approval as no longer required", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");
    const northwind = await researchedAccount(h, t, "Northwind");

    const before = await dashboard(h, t);
    expect(before.approvalsRequired.required).toBe(0);

    // A pending approval is a real obligation and is reported as one, by id.
    const qualificationId = storeQualification(t, northwind.accountId, "qualified");
    const approvalId = pendingApproval(t, northwind.accountId, qualificationId);

    const pending = await dashboard(h, t);
    expect(pending.approvalsRequired.required).toBe(1);
    expect(pending.approvalsRequired.approvalIds).toEqual([approvalId]);

    // A person decides it through Phase 10's own route, which re-derives the
    // approval from stored rows rather than trusting this test.
    await dataOf(
      h.decideApprovalRequestHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, id: approvalId },
          {
            decision: "approved",
          },
        ),
      ),
    );

    // The tile follows the stored row: a decided request is no longer owed.
    const decided = await dashboard(h, t);
    expect(decided.approvalsRequired.required).toBe(0);
    expect(decided.approvalsRequired.approvalIds).toEqual([]);
  });

  it("counts an account that regressed out of qualified as activity, not an outcome", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");
    const northwind = await researchedAccount(h, t, "Northwind");

    storeQualification(t, northwind.accountId, "qualified");
    const qualified = await dashboard(h, t);
    expect(qualified.qualifiedProspects.value).toBe(1);
    expect(
      new Map(qualified.agentActivity.map((entry) => [entry.key, entry.count])).get(
        "prospects_qualified",
      ),
    ).toBe(1);

    // A later evaluation moves the account to `contested`. The newest version
    // is the account's current state, so the outcome tile must follow it.
    storeQualification(t, northwind.accountId, "contested");

    const after = await dashboard(h, t);
    // The work still happened, so the activity counter keeps it...
    expect(
      new Map(after.agentActivity.map((entry) => [entry.key, entry.count])).get(
        "prospects_qualified",
      ),
    ).toBe(1);
    // ...but the account is no longer a qualified outcome, and a stale
    // "qualified" claim would be exactly the bug this phase must not have.
    expect(after.qualifiedProspects.value).toBe(0);
  });

  it("is derived on read: reading the dashboard writes nothing", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");
    await researchedAccount(h, t, "Northwind");

    const before = rowCounts();
    const first = await dashboard(h, t);
    const policy = (await dataOf(
      h.getDashboardPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as GatePolicy;
    const second = await dashboard(h, t);
    const after = rowCounts();

    // Not one row anywhere changed, in any table, in either direction.
    expect(after).toEqual(before);
    // And the same rows print the same dashboard, byte for byte.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // The policy route is readable before and independently of any snapshot.
    expect(policy.ruleVersion).toBe("dashboard-1.0.0");
  });

  it("embeds Phase 16's cost picture and Phase 14's board whole", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");
    const northwind = await researchedAccount(h, t, "Northwind");

    await dataOf(
      h.recordCostHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            executionKind: "research_run",
            executionId: northwind.requestId,
            category: "llm",
            basis: "measured",
            amountMinor: 2500,
            currency: "USD",
            source: "provider invoice",
            occurredAt: "2026-06-02T00:00:00.000Z",
            idempotencyKey: unique("cost-17"),
          },
        ),
      ),
    );

    const snapshot = await dashboard(h, t);
    // The dashboard's cost tile is Phase 16's own answer, not a second
    // definition of the same number.
    const metrics = (await dataOf(
      h.getCostMetricsHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as { totals: { totalMinor: number; eventCount: number } };
    expect(snapshot.cost.ruleVersion).toBe("cost-1.0.0");
    expect(snapshot.cost.totals.totalMinor).toBe(metrics.totals.totalMinor);
    expect(snapshot.cost.totals.eventCount).toBe(metrics.totals.eventCount);
    expect(snapshot.cost.totals.totalMinor).toBe(2500);

    const board = (await dataOf(
      h.recommendWorkspaceActionsHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as { ruleVersion: string; recommendations: unknown[] };
    expect(snapshot.nextBestActions.ruleVersion).toBe(board.ruleVersion);
    expect(snapshot.nextBestActions.recommendations).toEqual(board.recommendations);
  });

  it("counts failures under the same three names Phase 16 prices", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");
    const northwind = await researchedAccount(h, t, "Northwind");

    // A research run that failed is a real, stored failure — not an absence.
    const failed = defaultStore.createResearchRequest({
      workspaceId: t.workspaceId,
      requestedBy: t.userId,
      accountId: northwind.accountId,
      provider: "account_record",
      categories: ["industry"],
    });
    if (!isOk(failed)) throw new Error("fixture research request failed");
    const marked = defaultStore.updateResearchRequest(failed.value.id, {
      userId: t.userId,
      status: "failed",
      failureCode: "provider_unavailable",
      failureMessage: "the provider did not answer",
    });
    if (!isOk(marked)) throw new Error("fixture failure marking failed");

    const snapshot = await dashboard(h, t);
    expect(snapshot.workflowFailures.total).toBe(1);
    expect(snapshot.workflowFailures.bySource).toEqual([
      { source: "research_run", count: 1 },
      { source: "outbound_send", count: 0 },
      { source: "meeting_booking", count: 0 },
    ]);
  });

  it("ignores anything a client asserts about the numbers", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");
    await researchedAccount(h, t, "Northwind");

    const honest = await dashboard(h, t);
    const forged = (await dataOf(
      h.getDashboardHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            qualifiedProspects: { value: 9999 },
            meetings: { total: 9999 },
            opportunities: { value: 9999 },
            directRevenue: { amountMinor: 5_000_00, currency: "USD" },
            cost: { totals: { totalMinor: 0 } },
            nextBestActions: { recommendations: [] },
            userId: "someone-else",
            createdBy: "someone-else",
          },
        ),
      ),
    )) as GateDashboard;

    // Nothing a client sends reaches a tile: every number is recomputed from
    // this workspace's own rows.
    expect(JSON.stringify(forged)).toBe(JSON.stringify(honest));
  });

  it("never crosses a workspace", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const mine = tenant("Owner", unique("owner17") + "@example.com");
    const theirs = tenant("Owner", unique("owner17") + "@example.com");

    await researchedAccount(h, mine, "Northwind");
    await researchedAccount(h, theirs, "Initech");

    const mySnapshot = await dashboard(h, mine);
    const theirSnapshot = await dashboard(h, theirs);
    expect(mySnapshot.qualifiedProspects.value).toBe(0);
    expect(theirSnapshot.qualifiedProspects.value).toBe(0);

    // Reading someone else's workspace is refused, not merely empty.
    const crossTenant = await errorOf(
      h.getDashboardHandler(request(theirs.token, { workspaceId: mine.workspaceId })),
    );
    expect(crossTenant.code).toBe("UNAUTHORIZED");

    const forgedWorkspace = await errorOf(
      h.getDashboardHandler(request(mine.token, { workspaceId: "ws-not-real" })),
    );
    expect(forgedWorkspace.code).toBe("NOT_FOUND");

    const anonymous = await errorOf(
      h.getDashboardHandler(request("", { workspaceId: mine.workspaceId })),
    );
    expect(anonymous.code).toBe("UNAUTHENTICATED");
  });

  it("answers an empty workspace honestly", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");

    const snapshot = await dashboard(h, t);
    // A zero is a fact here: the tables exist and are empty.
    expect(snapshot.qualifiedProspects.value).toBe(0);
    expect(snapshot.positiveConversations.value).toBe(0);
    expect(snapshot.meetings.total).toBe(0);
    expect(snapshot.meetings.byState.every((entry) => entry.count === 0)).toBe(true);
    expect(snapshot.opportunities.value).toBe(0);
    expect(snapshot.approvalsRequired.required).toBe(0);
    expect(snapshot.workflowFailures.total).toBe(0);
    expect(snapshot.hotConversations.value).toBe(0);
    expect(snapshot.agentActivity.every((entry) => entry.count === 0)).toBe(true);
    expect(snapshot.nextBestActions.recommendations).toEqual([]);
    // And a missing fact is still never a fabricated zero.
    expect(snapshot.goal.status).toBe("no_data");
    expect(snapshot.goal.goal).toBeNull();
    expect(snapshot.directRevenue.amountMinor).toBeNull();
    expect(snapshot.customers.value).toBeNull();
  });

  it("publishes fourteen tiles, three refusals and the Blueprint's four questions", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Owner", unique("owner17") + "@example.com");

    const policy = (await dataOf(
      h.getDashboardPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as GatePolicy;

    expect(policy.ruleVersion).toBe("dashboard-1.0.0");
    // ROADMAP.md §24's twelve, plus the two legs §35's questions need.
    expect(policy.items).toHaveLength(14);
    expect(policy.items.map((item) => item.key)).toEqual([
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
      "hot_conversations",
      "next_best_actions",
    ]);
    for (const item of policy.items) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.derivation.length).toBeGreaterThan(0);
    }

    // DEALORA_BLUEPRINT.md §35's four questions, answered by a partition.
    expect(policy.questions.map((entry) => entry.question)).toEqual([
      "Where are we?",
      "What is working?",
      "What needs attention?",
      "What should happen next?",
    ]);
    const answered = policy.questions.flatMap((entry) => entry.answeredBy);
    expect([...answered].sort()).toEqual(policy.items.map((item) => item.key).sort());
    expect(new Set(answered).size).toBe(answered.length);

    // The three refusals name the phase that will own them.
    expect(policy.refusals.map((entry) => entry.name)).toEqual([
      "direct_revenue",
      "pipeline_created",
      "customers",
    ]);
    for (const refusal of policy.refusals) {
      expect(refusal.owningPhase).toBe("Phase 23");
      expect(refusal.reason.length).toBeGreaterThan(0);
    }

    // One vocabulary with the phases that own it, not a private copy.
    expect(policy.positiveConversationIntents).toEqual(["positive_intent", "interested"]);
    expect(policy.meetingStates).toEqual([
      "recommended",
      "awaiting_approval",
      "approved",
      "booked",
      "held",
      "no_show",
      "cancelled",
    ]);
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
    expect(policy.goalSelectionRule).toContain("newest goal with status `active`");
    expect(policy.opportunityRule).toContain("newest qualification is `qualified`");

    // The negative space, stated as data rather than left implicit.
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
