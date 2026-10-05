import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { StaticResearchProvider } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import { SandboxEmailProvider } from "@dealora/outbound";
import { SandboxCalendarProvider } from "@dealora/meeting";

/**
 * Phase 15 gate — ROADMAP.md §22.
 *
 * Its gate is one sentence: *the system can trace the lifecycle of an
 * opportunity*. The first test therefore walks one account through the whole
 * revenue loop and traces the graph **at every stage**, so what is proven is
 * that the trace tracks what actually happened: company → person → signal →
 * evidence → opportunity → conversation → meeting. A trace that could not
 * name the stage the account has reached would be a picture, not a lifecycle.
 *
 * The relationship vocabulary is asserted as a **partition**: the seven
 * published node kinds plus the five refusals equal `ROADMAP.md` §22's twelve
 * core relationship names, disjointly. Five of the twelve (campaign, customer,
 * revenue, agent, workflow) belong to phases that do not exist yet, and
 * advertising them here would expose vocabulary nothing can produce.
 *
 * **The graph is derived, never stored.** Every edge carries `derivedFrom`
 * naming the exact rows the rule read, and the gate audits those ids against
 * the database — so any relationship can be checked against storage without
 * trusting the graph itself. No table, no schema version and no migration is
 * added by this phase: a persisted graph would duplicate the facts it
 * represents, and a downgraded evaluation would leave a stale opportunity
 * behind. The recomputation test proves the opposite: the opportunity node
 * appears the moment the newest qualification is `qualified` and disappears
 * the moment a newer one says otherwise.
 *
 * **On input.** The caller sends an account id and nothing else. The forgery
 * test posts nodes, edges, an opportunity, a frontier and a rule version and
 * asserts the answer is byte-for-byte what the rows produce.
 *
 * **On writes.** Row counts are snapshotted before and after every graph
 * read: the graph adds no row to any table, ever. The repository surface is
 * `authorize` alone.
 *
 * The research provider is a **declared test double**, as in every gate since
 * Phase 9: it returns the observations the test supplies and performs no
 * retrieval. The email and calendar providers are sandboxes.
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

/**
 * The declared observations that make an account qualify.
 *
 * **Declared test double**: no retrieval of any kind. The categories mirror the
 * Phase 8 criteria exactly, so the account evaluates as genuinely `qualified`.
 */
function researchProvider(): ResearchProvider {
  return new StaticResearchProvider(
    "press_release",
    "public_web",
    [
      {
        category: "industry",
        field: "industry",
        value: "SaaS",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/about",
        sourceTitle: "About",
        observedAt: "2026-06-02T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "company_overview",
        field: "geography",
        value: "Germany",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/about",
        sourceTitle: "About",
        observedAt: "2026-06-02T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "company_overview",
        field: "company_size",
        value: "50-200",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/about",
        sourceTitle: "About",
        observedAt: "2026-06-02T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "business_model",
        field: "model",
        value: "Subscription",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/about",
        sourceTitle: "About",
        observedAt: "2026-06-02T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "expansion",
        field: "new_region",
        value: "announced expansion into Germany in September",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/news/germany",
        sourceTitle: "Newsroom",
        observedAt: "2026-09-14T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "hiring",
        field: "support_hiring",
        value: "hiring a support team for the new region",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/careers",
        sourceTitle: "Careers",
        observedAt: "2026-09-20T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "hiring",
        field: "open_roles",
        value: "posted 12 roles in customer success",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/careers",
        sourceTitle: "Careers",
        observedAt: "2026-08-20T00:00:00.000Z",
        confidence: "medium",
        relevance: "medium",
        note: null,
      },
      {
        category: "technology_signals",
        field: "stack_change",
        value: "migrated its helpdesk to a new vendor",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/blog",
        sourceTitle: "Blog",
        observedAt: "2026-10-01T00:00:00.000Z",
        confidence: "medium",
        relevance: "medium",
        note: null,
      },
      {
        category: "leadership_changes",
        field: "new_leader",
        value: "appointed a VP of Support",
        claimKind: "fact",
        sourceUrl: "https://northwind.example/news/leadership",
        sourceTitle: "Newsroom",
        observedAt: "2026-10-05T00:00:00.000Z",
        confidence: "medium",
        relevance: "medium",
        note: null,
      },
    ],
    // Every declared observation is returned regardless of the categories the
    // request asked for, so the account is evaluated against the full picture
    // rather than a partial one the test happened to request.
    { filterToScope: false },
  );
}

/**
 * A second, disagreeing source about the same field.
 *
 * **Declared test double**: no retrieval of any kind. It exists so a later
 * evaluation can become `contested` through the real Phase 7 contradiction
 * path, which is how the gate proves the opportunity node disappears when the
 * newest qualification is no longer `qualified`.
 */
function conflictingProvider(): ResearchProvider {
  return new StaticResearchProvider(
    "rival_registry",
    "public_web",
    [
      {
        category: "business_model",
        field: "model",
        value: "Agency",
        claimKind: "fact",
        sourceUrl: "https://rival.example/profile",
        sourceTitle: "Rival registry",
        observedAt: "2026-09-15T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
    ],
    { filterToScope: false },
  );
}

function handlersFor(): ReturnType<typeof createDefaultHandlers> {
  return createDefaultHandlers({
    researchProviders: [researchProvider(), conflictingProvider()],
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

/** A booking window inside the sandbox calendar's declared availability. */
const BOOKING = {
  title: "Intro call with Northwind",
  startsAt: "2026-11-02T10:00:00.000Z",
  endsAt: "2026-11-02T10:30:00.000Z",
  timezone: "Europe/Berlin",
  durationMinutes: 30,
};

type Handlers = ReturnType<typeof createDefaultHandlers>;

interface World {
  accountId: string;
  contactId: string;
  offerId: string;
  goalId: string;
  qualificationId: string;
  draftId: string;
  approvalId: string;
  outboundActionId: string;
  classificationId: string;
  meetingId: string;
}

/**
 * Create an account with its Business Brain and goal, a contact, and nothing
 * else — the very start of the revenue loop, which the gate walks *up* from.
 */
async function bareAccount(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  accountName: string,
  recipientEmail: string,
): Promise<Pick<World, "accountId" | "contactId" | "offerId" | "goalId">> {
  const offer = (await dataOf(
    handlers.createOfferHandler(
      request(
        token,
        { workspaceId },
        {
          name: "Support Automation",
          description: "We build support automation for B2B SaaS teams.",
          outcome: "faster first response times",
          status: "active",
        },
      ),
    ),
  )) as { offer: { id: string } };

  const icp = (await dataOf(
    handlers.upsertIcpHandler(
      request(
        token,
        { workspaceId },
        {
          industries: ["saas"],
          companySizes: ["50-200"],
          geographies: ["germany"],
          businessModels: ["subscription"],
        },
      ),
    ),
  )) as { icp: { id: string } };

  const persona = (await dataOf(
    handlers.createPersonaHandler(request(token, { workspaceId }, { title: "Head of Support" })),
  )) as { persona: { id: string } };

  const goal = (await dataOf(
    handlers.createRevenueGoalHandler(
      request(
        token,
        { workspaceId },
        {
          objective: "Book 20 qualified meetings from B2B SaaS companies in Germany",
          targetMetric: "meeting",
          targetValue: 20,
          currency: "USD",
          timeWindow: { start: "2026-09-01", end: "2026-12-31" },
          market: "B2B SaaS",
          offerId: offer.offer.id,
          icpId: icp.icp.id,
          buyerPersonaIds: [persona.persona.id],
          successMetrics: [{ kind: "meeting", target: 20, unit: "meetings" }],
        },
      ),
    ),
  )) as { goal: { id: string } };

  const account = (await dataOf(
    handlers.createAccountHandler(
      request(
        token,
        { workspaceId },
        { name: accountName, industry: "SaaS", companySize: "50-200", geography: "Germany" },
      ),
    ),
  )) as { account: { id: string } };

  const contact = (await dataOf(
    handlers.createContactHandler(
      request(
        token,
        { workspaceId, accountId: account.account.id },
        {
          firstName: "Ada",
          lastName: "Lovelace",
          jobTitle: "VP Support",
          email: recipientEmail,
        },
      ),
    ),
  )) as { contact: { id: string } };

  return {
    accountId: account.account.id,
    contactId: contact.contact.id,
    offerId: offer.offer.id,
    goalId: goal.goal.id,
  };
}

/** Run the Phase 6 research request and return its finding ids. */
async function research(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  accountId: string,
  provider = "press_release",
): Promise<{ id: string }[]> {
  const created = (await dataOf(
    handlers.createResearchRequestHandler(
      request(
        token,
        { workspaceId, accountId },
        {
          provider,
          categories: [
            "company_overview",
            "industry",
            "business_model",
            "expansion",
            "hiring",
            "technology_signals",
            "leadership_changes",
          ],
        },
      ),
    ),
  )) as { request: { id: string } };
  const run = (await dataOf(
    handlers.runResearchRequestHandler(request(token, { id: created.request.id })),
  )) as { request: { status: string }; findings: { id: string }[] };
  expect(run.request.status).toBe("completed");
  return run.findings;
}

/** Trace one account's opportunity through the real route. */
async function traceFor(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  accountId: string,
): Promise<GateTrace> {
  return (await dataOf(
    handlers.traceOpportunityHandler(request(token, { workspaceId }, { accountId })),
  )) as GateTrace;
}

interface GateNode {
  id: string;
  kind: string;
  occurredAt: string;
  label: string | null;
  state: string | null;
}

interface GateEdge {
  kind: string;
  from: string;
  to: string;
  occurredAt: string;
  derivedFrom: { kind: string; id: string }[];
}

interface GateTrace {
  ruleVersion: string;
  accountId: string;
  accountName: string;
  nodes: GateNode[];
  edges: GateEdge[];
  lifecycle: {
    stages: { stage: string; nodeIds: string[] }[];
    frontier: string;
    opportunity: string | null;
  };
}

interface GateWorkspaceGraph {
  ruleVersion: string;
  accountCount: number;
  nodes: GateNode[];
  edges: GateEdge[];
}

/** Every row id in the shared store, so derivedFrom can be audited against it. */
function allRowIds(): Set<string> {
  const db = defaultStore.db;
  const ids = new Set<string>();
  const tables = [
    db.accounts,
    db.contacts,
    db.researchRequests,
    db.researchFindings,
    db.accountClaims,
    db.evidence,
    db.qualifications,
    db.personalizedDrafts,
    db.approvalRequests,
    db.outboundActions,
    db.inboundMessages,
    db.conversationClassifications,
    db.meetings,
    db.meetingBriefs,
  ];
  for (const rows of tables) {
    for (const row of rows ?? []) ids.add(row.id);
  }
  return ids;
}

/** A snapshot of every table a graph read could conceivably touch. */
function rowCounts(): {
  accounts: number;
  contacts: number;
  findings: number;
  claims: number;
  evidence: number;
  qualifications: number;
  drafts: number;
  approvals: number;
  actions: number;
  inbound: number;
  classifications: number;
  meetings: number;
  briefs: number;
  recommendations: number;
} {
  const db = defaultStore.db;
  return {
    accounts: db.accounts?.length ?? 0,
    contacts: db.contacts?.length ?? 0,
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
  };
}

/** The loop order ROADMAP.md §22's example implies, asserted as stage order. */
const LOOP_STAGES = [
  "company",
  "person",
  "signal",
  "evidence",
  "opportunity",
  "conversation",
  "meeting",
];

/** The twelve core relationship names ROADMAP.md §22 asks to be created. */
const ROADMAP_TWELVE = [
  "agent",
  "campaign",
  "company",
  "conversation",
  "customer",
  "evidence",
  "meeting",
  "opportunity",
  "person",
  "revenue",
  "signal",
  "workflow",
];

/** The seven node kinds Phases 0–15 can actually produce. */
const PUBLISHED_SEVEN = [
  "company",
  "conversation",
  "evidence",
  "meeting",
  "opportunity",
  "person",
  "signal",
];

/** The twelve edge kinds one completed loop must produce, sorted. */
const TWELVE_EDGES = [
  "company_has_conversation",
  "company_has_evidence",
  "company_has_meeting",
  "company_has_opportunity",
  "company_has_person",
  "company_has_signal",
  "conversation_led_to_meeting",
  "evidence_supports_opportunity",
  "opportunity_led_to_conversation",
  "person_had_conversation",
  "person_joined_meeting",
  "signal_became_evidence",
];

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 15 gate — revenue graph", () => {
  it("traces one opportunity's lifecycle through every stage of the revenue loop", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Trace Gate", unique("p15") + "@example.com");
    const recipient = unique("p15gate") + "@northwind.example";

    // --- A company holds a person: the first two stages ---------------------
    const world = await bareAccount(handlers, token, workspaceId, "Northwind", recipient);
    let trace = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(trace.ruleVersion).toBe("revenue-graph-1.0.0");
    expect(trace.accountName).toBe("Northwind");
    expect(trace.lifecycle.stages.map((stage) => stage.stage)).toEqual(["company", "person"]);
    expect(trace.lifecycle.frontier).toBe("person");
    expect(trace.lifecycle.opportunity).toBeNull();
    expect(trace.nodes.map((node) => node.kind).sort()).toEqual(["company", "person"]);
    expect(trace.edges.map((edge) => edge.kind)).toEqual(["company_has_person"]);

    // --- Research records a signal about the company ------------------------
    const findings = await research(handlers, token, workspaceId, world.accountId);
    trace = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(trace.lifecycle.stages.map((stage) => stage.stage)).toEqual([
      "company",
      "person",
      "signal",
    ]);
    expect(trace.lifecycle.frontier).toBe("signal");
    // Research attached every finding to the company: one anchor edge per
    // signal node, plus the contact — and no other relationship yet.
    expect(findings.length).toBeGreaterThan(0);
    expect([...new Set(trace.edges.map((edge) => edge.kind))].sort()).toEqual([
      "company_has_person",
      "company_has_signal",
    ]);
    expect(trace.edges.filter((edge) => edge.kind === "company_has_person")).toHaveLength(1);
    expect(trace.edges.filter((edge) => edge.kind === "company_has_signal")).toHaveLength(
      trace.nodes.filter((node) => node.kind === "signal").length,
    );

    // --- Evidence is built from that signal ---------------------------------
    for (const finding of findings) {
      await dataOf(
        handlers.createEvidenceFromFindingHandler(
          request(token, { workspaceId, researchFindingId: finding.id }),
        ),
      );
    }
    trace = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(trace.lifecycle.stages.map((stage) => stage.stage)).toEqual([
      "company",
      "person",
      "signal",
      "evidence",
    ]);
    expect(trace.lifecycle.frontier).toBe("evidence");
    expect(trace.edges.some((edge) => edge.kind === "signal_became_evidence")).toBe(true);

    // --- The newest qualification is qualified: the opportunity exists -------
    const qualification = (await dataOf(
      handlers.createQualificationHandler(
        request(
          token,
          { workspaceId, accountId: world.accountId },
          { revenueGoalId: world.goalId },
        ),
      ),
    )) as { qualification: { id: string; state: string } };
    expect(qualification.qualification.state).toBe("qualified");

    trace = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(trace.lifecycle.stages.map((stage) => stage.stage)).toEqual(LOOP_STAGES.slice(0, 5));
    expect(trace.lifecycle.frontier).toBe("opportunity");
    // The opportunity node IS the qualification row: an id, never a new record.
    expect(trace.lifecycle.opportunity).toBe(qualification.qualification.id);
    const opportunityNode = trace.nodes.find((node) => node.kind === "opportunity");
    expect(opportunityNode).toMatchObject({
      id: qualification.qualification.id,
      state: "qualified",
      label: null,
    });
    expect(trace.edges.some((edge) => edge.kind === "company_has_opportunity")).toBe(true);
    expect(trace.edges.some((edge) => edge.kind === "evidence_supports_opportunity")).toBe(true);

    // --- Draft → approval → send: still no conversation yet ------------------
    const draft = (await dataOf(
      handlers.createPersonalizedDraftHandler(
        request(
          token,
          { workspaceId, accountId: world.accountId },
          {
            qualificationId: qualification.qualification.id,
            offerId: world.offerId,
            contactId: world.contactId,
          },
        ),
      ),
    )) as { draft: { id: string } };
    const approval = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draft.id }, {}),
      ),
    )) as { approval: { id: string } };
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: approval.approval.id }, { decision: "approved" }),
      ),
    );
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: draft.draft.id }, {}),
      ),
    )) as { action: { id: string } };
    const sent = (await dataOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    )) as { action: { status: string } };
    expect(sent.action.status).toBe("sent");

    trace = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(trace.lifecycle.frontier).toBe("opportunity");
    expect(trace.nodes.some((node) => node.kind === "conversation")).toBe(false);

    // --- A positive reply is a classified conversation ----------------------
    const classified = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: staged.action.id },
          { body: "Happy to chat, book a call." },
        ),
      ),
    )) as { classification: { id: string; intent: string } };
    expect(classified.classification.intent).toBe("positive_intent");

    trace = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(trace.lifecycle.stages.map((stage) => stage.stage)).toEqual(
      LOOP_STAGES.filter((stage) => stage !== "meeting"),
    );
    expect(trace.lifecycle.frontier).toBe("conversation");
    const opportunityEdge = trace.edges.find(
      (edge) => edge.kind === "opportunity_led_to_conversation",
    );
    expect(opportunityEdge).toBeDefined();
    // The human decision behind the send stays checkable on the edge.
    expect(opportunityEdge?.derivedFrom).toContainEqual({
      kind: "approval_requests",
      id: approval.approval.id,
    });
    expect(trace.edges.some((edge) => edge.kind === "person_had_conversation")).toBe(true);

    // --- A booked meeting is the furthest stage the loop reaches -------------
    const proposed = (await dataOf(
      handlers.recommendMeetingHandler(
        request(
          token,
          { workspaceId },
          { classificationId: classified.classification.id, ...BOOKING },
        ),
      ),
    )) as { meeting: { id: string; state: string } };
    await dataOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "approve" }),
      ),
    );
    await dataOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    );
    await dataOf(
      handlers.prepareMeetingBriefHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    );

    trace = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(trace.lifecycle.stages.map((stage) => stage.stage)).toEqual(LOOP_STAGES);
    expect(trace.lifecycle.frontier).toBe("meeting");
    expect(trace.lifecycle.opportunity).toBe(qualification.qualification.id);

    // All twelve core relationships the loop can produce, and nothing else.
    expect([...new Set(trace.nodes.map((node) => node.kind))].sort()).toEqual(PUBLISHED_SEVEN);
    expect([...new Set(trace.edges.map((edge) => edge.kind))].sort()).toEqual(TWELVE_EDGES);

    // Every edge names the exact rows the rule read; the target row is last,
    // and every cited id exists in the database — auditable without trusting
    // the graph.
    const rowIds = allRowIds();
    const nodeIds = new Set(trace.nodes.map((node) => node.id));
    for (const edge of trace.edges) {
      expect(edge.derivedFrom.length).toBeGreaterThanOrEqual(2);
      expect(edge.derivedFrom.at(-1)?.id).toBe(edge.to);
      for (const provenance of edge.derivedFrom) {
        expect(rowIds.has(provenance.id), `${edge.kind} cites ${provenance.id}`).toBe(true);
      }
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }

    // Deterministic: the same rows print the identical graph on a second read.
    const again = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(again).toEqual(trace);
  });

  it("recomputes the graph: a newer evaluation removes the opportunity at once", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Recompute Gate", unique("p15re") + "@example.com");
    const world = await bareAccount(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p15re") + "@northwind.example",
    );

    // Walk the loop to a qualified opportunity with a real reply and meeting.
    const findings = await research(handlers, token, workspaceId, world.accountId);
    for (const finding of findings) {
      await dataOf(
        handlers.createEvidenceFromFindingHandler(
          request(token, { workspaceId, researchFindingId: finding.id }),
        ),
      );
    }
    const qualification = (await dataOf(
      handlers.createQualificationHandler(
        request(
          token,
          { workspaceId, accountId: world.accountId },
          { revenueGoalId: world.goalId },
        ),
      ),
    )) as { qualification: { id: string; state: string } };
    expect(qualification.qualification.state).toBe("qualified");
    const draft = (await dataOf(
      handlers.createPersonalizedDraftHandler(
        request(
          token,
          { workspaceId, accountId: world.accountId },
          {
            qualificationId: qualification.qualification.id,
            offerId: world.offerId,
            contactId: world.contactId,
          },
        ),
      ),
    )) as { draft: { id: string } };
    const approval = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draft.id }, {}),
      ),
    )) as { approval: { id: string } };
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: approval.approval.id }, { decision: "approved" }),
      ),
    );
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: draft.draft.id }, {}),
      ),
    )) as { action: { id: string } };
    await dataOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: staged.action.id },
          { body: "Happy to chat, book a call." },
        ),
      ),
    );

    const before = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(before.lifecycle.opportunity).toBe(qualification.qualification.id);
    expect(before.nodes.some((node) => node.kind === "opportunity")).toBe(true);

    // A second source contradicts the first on the same field, through the
    // real Phase 7 contradiction path — no direct row editing.
    const rival = await research(handlers, token, workspaceId, world.accountId, "rival_registry");
    expect(rival.length).toBeGreaterThan(0);
    for (const finding of rival) {
      const converted = (await dataOf(
        handlers.createEvidenceFromFindingHandler(
          request(token, { workspaceId, researchFindingId: finding.id }),
        ),
      )) as { evidence: { status: string }; contradicted: { status: string }[] };
      expect(converted.evidence.status).toBe("contradicted");
      expect(converted.contradicted.length).toBeGreaterThan(0);
    }

    // The newest evaluation is contested — a newer version, never a reused one.
    const contested = (await dataOf(
      handlers.createQualificationHandler(
        request(
          token,
          { workspaceId, accountId: world.accountId },
          { revenueGoalId: world.goalId },
        ),
      ),
    )) as { qualification: { id: string; state: string; version: number } };
    expect(contested.qualification.state).toBe("contested");
    expect(contested.qualification.id).not.toBe(qualification.qualification.id);

    // The graph is recomputed, never replayed: the opportunity is gone, and
    // every edge that depended on it with it.
    const after = await traceFor(handlers, token, workspaceId, world.accountId);
    expect(after.lifecycle.opportunity).toBeNull();
    expect(after.nodes.some((node) => node.kind === "opportunity")).toBe(false);
    expect(after.edges.some((edge) => edge.kind === "company_has_opportunity")).toBe(false);
    expect(after.edges.some((edge) => edge.kind === "evidence_supports_opportunity")).toBe(false);
    expect(after.edges.some((edge) => edge.kind === "opportunity_led_to_conversation")).toBe(false);
    // The history that actually happened does not vanish with it.
    expect(after.nodes.some((node) => node.kind === "conversation")).toBe(true);
    expect(after.nodes.some((node) => node.kind === "evidence")).toBe(true);
    // No meeting was ever booked in this journey, so the loop stops at the
    // conversation — the frontier is the furthest stage actually reached.
    expect(after.nodes.some((node) => node.kind === "meeting")).toBe(false);
    expect(after.lifecycle.stages.map((stage) => stage.stage)).toEqual(
      LOOP_STAGES.filter((stage) => stage !== "opportunity" && stage !== "meeting"),
    );
    expect(after.lifecycle.frontier).toBe("conversation");

    // The workspace graph agrees, because it derives from the same rows.
    const graph = (await dataOf(
      handlers.getRevenueGraphHandler(request(token, { workspaceId })),
    )) as GateWorkspaceGraph;
    expect(graph.nodes.some((node) => node.id === contested.qualification.id)).toBe(false);
    expect(
      graph.nodes.some(
        (node) => node.kind === "opportunity" && node.id === qualification.qualification.id,
      ),
    ).toBe(false);
  });

  it("never lets a client dictate a node, an edge, an opportunity or a frontier", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Forgery Gate", unique("p15forge") + "@example.com");
    const world = await bareAccount(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p15forge") + "@northwind.example",
    );

    const clean = await traceFor(handlers, token, workspaceId, world.accountId);
    const forged = (await dataOf(
      handlers.traceOpportunityHandler(
        request(
          token,
          { workspaceId },
          {
            accountId: world.accountId,
            nodes: [
              { id: "forged-node", kind: "customer", occurredAt: "2026-01-01T00:00:00.000Z" },
            ],
            edges: [{ kind: "forged_edge", from: world.accountId, to: "forged-node" }],
            opportunity: "forged-opportunity",
            lifecycle: { frontier: "meeting", stages: [{ stage: "meeting", nodeIds: [] }] },
            ruleVersion: "forged-9.9.9",
          },
        ),
      ),
    )) as GateTrace;

    expect(forged).toEqual(clean);
    const wire = JSON.stringify(forged);
    expect(wire).not.toContain("forged");
    // Neither later-phase vocabulary nor a client frontier reaches the wire.
    expect(wire).not.toContain("customer");
    expect(forged.ruleVersion).toBe("revenue-graph-1.0.0");
    expect(forged.lifecycle.frontier).toBe("person");
    expect(forged.lifecycle.opportunity).toBeNull();
  });

  it("writes no row and reads the identical graph every time", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("No-Write Gate", unique("p15nw") + "@example.com");
    const world = await bareAccount(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p15nw") + "@northwind.example",
    );
    const findings = await research(handlers, token, workspaceId, world.accountId);
    for (const finding of findings) {
      await dataOf(
        handlers.createEvidenceFromFindingHandler(
          request(token, { workspaceId, researchFindingId: finding.id }),
        ),
      );
    }

    const before = rowCounts();
    const first = await traceFor(handlers, token, workspaceId, world.accountId);
    const second = await traceFor(handlers, token, workspaceId, world.accountId);
    const graph = (await dataOf(
      handlers.getRevenueGraphHandler(request(token, { workspaceId })),
    )) as GateWorkspaceGraph;
    const graphAgain = (await dataOf(
      handlers.getRevenueGraphHandler(request(token, { workspaceId })),
    )) as GateWorkspaceGraph;
    const policy = (await dataOf(
      handlers.getRevenueGraphPolicyHandler(request(token, { workspaceId })),
    )) as { ruleVersion: string };
    const after = rowCounts();

    // Determinism: the same rows, the identical answer, every read.
    expect(second).toEqual(first);
    expect(graphAgain).toEqual(graph);
    expect(policy.ruleVersion).toBe("revenue-graph-1.0.0");

    // Not one row written to any table — the graph is a view, not a record.
    expect(after).toEqual(before);
    expect(graph.accountCount).toBe(1);
    expect(first.nodes.some((node) => node.kind === "opportunity")).toBe(false);
  });

  it("refuses a workspace above the account cap instead of truncating it", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Cap Gate", unique("p15cap") + "@example.com");

    let firstAccountId = "";
    for (let index = 0; index < 100; index += 1) {
      const created = (await dataOf(
        handlers.createAccountHandler(
          request(
            token,
            { workspaceId },
            {
              name: `Capstone ${index}`,
              industry: "SaaS",
              companySize: "50-200",
              geography: "Germany",
            },
          ),
        ),
      )) as { account: { id: string } };
      if (index === 0) firstAccountId = created.account.id;
      expect(created.account.id.length).toBeGreaterThan(0);
    }

    // Exactly at the cap: the whole graph is answered.
    const atCap = (await dataOf(
      handlers.getRevenueGraphHandler(request(token, { workspaceId })),
    )) as GateWorkspaceGraph;
    expect(atCap.accountCount).toBe(100);
    expect(atCap.nodes.filter((node) => node.kind === "company")).toHaveLength(100);

    // One account more: refused, with the number, rather than a graph that
    // silently stopped and would be read as complete.
    await dataOf(
      handlers.createAccountHandler(
        request(
          token,
          { workspaceId },
          {
            name: "Capstone overflow",
            industry: "SaaS",
            companySize: "50-200",
            geography: "Germany",
          },
        ),
      ),
    );
    const overflow = await errorOf(
      handlers.getRevenueGraphHandler(request(token, { workspaceId })),
    );
    expect(overflow.code).toBe("VALIDATION_ERROR");
    expect(overflow.message).toContain("too many accounts");
    expect(JSON.stringify(overflow.details ?? [])).toContain("101 accounts");
    expect(JSON.stringify(overflow.details ?? [])).toContain("at most 100");

    // The cap is a property of the workspace view only: one account is still
    // traceable on its own.
    const trace = await traceFor(handlers, token, workspaceId, firstAccountId);
    expect(trace.lifecycle.frontier).toBe("company");
  });

  it("shares nothing across tenants", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const mine = tenant("Mine", unique("p15mine") + "@example.com");
    const theirs = tenant("Theirs", unique("p15theirs") + "@example.com");

    const myAccount = await bareAccount(
      handlers,
      mine.token,
      mine.workspaceId,
      "Northwind",
      unique("p15mine") + "@northwind.example",
    );
    const theirAccount = await bareAccount(
      handlers,
      theirs.token,
      theirs.workspaceId,
      "Contoso",
      unique("p15theirs") + "@contoso.example",
    );

    // My graph holds my account and only my account.
    const myGraph = (await dataOf(
      handlers.getRevenueGraphHandler(request(mine.token, { workspaceId: mine.workspaceId })),
    )) as GateWorkspaceGraph;
    expect(myGraph.accountCount).toBe(1);
    expect(myGraph.nodes.map((node) => node.id)).toContain(myAccount.accountId);
    expect(myGraph.nodes.map((node) => node.id)).not.toContain(theirAccount.accountId);

    // Naming their account from my workspace reads as absent, not forbidden —
    // so a foreign id is never discoverable from which error comes back.
    const crossed = await errorOf(
      handlers.traceOpportunityHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId },
          { accountId: theirAccount.accountId },
        ),
      ),
    );
    expect(crossed.code).toBe("NOT_FOUND");

    // Their graph never contains my account either.
    const theirGraph = (await dataOf(
      handlers.getRevenueGraphHandler(request(theirs.token, { workspaceId: theirs.workspaceId })),
    )) as GateWorkspaceGraph;
    expect(theirGraph.accountCount).toBe(1);
    expect(theirGraph.nodes.map((node) => node.id)).not.toContain(myAccount.accountId);

    // Calling into a workspace I do not hold is refused at the guard, before
    // any account is looked up.
    const foreignWorkspace = await errorOf(
      handlers.getRevenueGraphHandler(request(mine.token, { workspaceId: theirs.workspaceId })),
    );
    expect(foreignWorkspace.code).toBe("UNAUTHORIZED");

    // And an anonymous caller learns nothing at all.
    const anonymous = await errorOf(
      handlers.traceOpportunityHandler({
        body: { accountId: myAccount.accountId },
        query: {},
        params: { workspaceId: mine.workspaceId },
      }),
    );
    expect(anonymous.code).toBe("UNAUTHENTICATED");
  });

  it("requires an account id and refuses one that does not exist", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Validation Gate", unique("p15val") + "@example.com");

    for (const accountId of [undefined, null, "", "   ", 7, {}]) {
      const invalid = await errorOf(
        handlers.traceOpportunityHandler(request(token, { workspaceId }, { accountId })),
      );
      expect(invalid.code).toBe("VALIDATION_ERROR");
    }

    const missing = await errorOf(
      handlers.traceOpportunityHandler(request(token, { workspaceId }, { accountId: "acct-nope" })),
    );
    expect(missing.code).toBe("NOT_FOUND");
  });

  it("publishes the whole vocabulary, its refusals, and no autonomous surface", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Policy Gate", unique("p15pol") + "@example.com");

    const policy = (await dataOf(
      handlers.getRevenueGraphPolicyHandler(request(token, { workspaceId })),
    )) as {
      ruleVersion: string;
      nodeKinds: string[];
      edgeKinds: string[];
      stages: string[];
      nodes: { kind: string; source: string; semantics: string }[];
      edges: { kind: string; from: string; to: string; semantics: string; derivation: string }[];
      refused: { name: string; reason: string; owningPhase: string | null }[];
      neverDoes: string[];
    };

    // Readable before the workspace has a single account.
    expect(policy.ruleVersion).toBe("revenue-graph-1.0.0");
    expect(policy.nodeKinds).toHaveLength(7);
    expect(policy.edgeKinds).toHaveLength(12);
    expect(policy.stages).toEqual(LOOP_STAGES);
    expect(policy.nodes).toHaveLength(7);
    expect(policy.edges).toHaveLength(12);

    // The partition: seven published + five refused = the roadmap's twelve,
    // disjointly. Nothing later-phase is exposed, nothing roadmap-named is
    // silently dropped.
    const refusedNames = policy.refused.map((entry) => entry.name).sort();
    expect(refusedNames).toEqual(["agent", "campaign", "customer", "revenue", "workflow"]);
    expect([...policy.nodeKinds, ...refusedNames].sort()).toEqual(ROADMAP_TWELVE);

    // Every refusal states its reason and the phase that will own it — except
    // the campaign, which no roadmap phase has claimed yet.
    for (const entry of policy.refused) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(policy.refused.find((entry) => entry.name === "campaign")?.owningPhase).toBeNull();
    expect(policy.refused.find((entry) => entry.name === "customer")?.owningPhase).toContain(
      "Phase",
    );
    expect(policy.refused.find((entry) => entry.name === "workflow")?.owningPhase).toBe("Phase 24");

    // Every published kind carries source and semantics; every edge carries
    // its endpoints, semantics and stored-field derivation — and its endpoints
    // are published kinds.
    for (const node of policy.nodes) {
      expect(node.source.length).toBeGreaterThan(0);
      expect(node.semantics.length).toBeGreaterThan(0);
    }
    for (const edge of policy.edges) {
      expect(policy.nodeKinds).toContain(edge.from);
      expect(policy.nodeKinds).toContain(edge.to);
      expect(edge.semantics.length).toBeGreaterThan(0);
      expect(edge.derivation.length).toBeGreaterThan(0);
    }

    // The negative space is printed with the policy.
    expect(policy.neverDoes.join(" ")).toContain("never write");
    expect(policy.neverDoes.join(" ")).toContain("never act");
    expect(policy.neverDoes.join(" ")).toContain("never recommend");
    expect(policy.neverDoes.join(" ")).toContain("never cross a workspace");

    // None of this phase's routes sends, approves, books, schedules or
    // recommends: the graph reports, it does not act.
    const phase15Routes = [
      "getRevenueGraphHandler",
      "traceOpportunityHandler",
      "getRevenueGraphPolicyHandler",
    ];
    for (const route of phase15Routes) {
      expect(Object.keys(handlers)).toContain(route);
      expect(route).not.toMatch(/send|book|approve|schedule|decide|execute|recommend/i);
    }
  });
});
