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
import { declarationFor } from "@dealora/agent";

/**
 * Phases 9–19 integration — one document, one decision, one effect, one response,
 * one booking, one recommendation, one graph, one cost, one dashboard, one
 * agent registry, one evaluation.
 *
 * Phase 12 added the ability to *read* what came back, Phase 13 the ability to
 * *book* what was read, Phase 14 the ability to *advise* what happens next,
 * Phase 15 the ability to *trace* everything that happened as one graph, Phase 16
 * the ability to *price* everything that happened, and Phase 17 the ability to
 * *report* everything that happened as business outcomes — without any of
 * them changing what the phases before them guarantee, and that is exactly what
 * this file proves: the same journey is walked end to end, and then the seams are
 * probed with each newer surface in play.
 *
 * What is asserted here, in order:
 *
 *  1. The whole loop still runs, and a response arrives at the far end of a
 *     message that genuinely went out.
 *  2. Reading a response creates nothing: no draft, no approval, no send.
 *  3. A positive intent is a *recommendation to prepare a reply*, never a reply,
 *     and never a shortcut past approval.
 *  4. An opt-out stops the next send through the existing Phase 11 mechanism.
 *  5. A new draft version still does not inherit an old approval, and a response
 *     cannot make it.
 *  6. A provider failure still cannot be read as a response to a delivery.
 *  7. A booking is a *fourth* decision, with its own approval: the Phase 10
 *     approval that let the message go out does not also let the meeting be
 *     booked, and booking does not re-use it.
 *  8. Booking a meeting creates nothing else — no invitation, no draft, no
 *     approval, no evidence.
 *  9. An opt-out stops a booking as well as a send, through the same Phase 11
 *     list, and the whole booking surface stays per tenant.
 * 10. A next-step recommendation reads the whole loop without writing to it,
 *     and the advice stays per tenant (Phase 14).
 * 11. The whole loop reads back as one derived graph per tenant: every stage of
 *     the revenue loop, all twelve relationships, and not one stored row
 *     (Phase 15).
 * 12. Every execution the journey performed can show a cost — estimated or
 *     measured — and the three per-outcome metrics derive from this journey's
 *     own facts, while the metrics needing customers, revenue or campaigns
 *     stay refused with their owning phase (Phase 16).
 * 13. The whole journey reads back as one dashboard of business outcomes per
 *     tenant — qualified prospects, positive conversations, meetings and
 *     opportunities derived from the rows above, the unrecorded financial
 *     outcomes still refused, and reading it writes nothing (Phase 17).
 * 14. The whole journey reads back as one agent registry per tenant: the twelve
 *     declared agents, the lifecycle decisions this workspace has made about
 *     them, and — the point of the phase — nothing executed, nothing sent and
 *     no production promotion available until Phase 19 measures (Phase 18).
 * 15. The agents this journey actually exercised are then **evaluated**: real
 *     judgements recorded against the journey's own executions, real metrics
 *     derived from them, and `ROADMAP.md` §26's gate refusing a promotion until
 *     every declared metric is met — and granting a governance state and no
 *     capability when it finally is (Phase 19).
 *
 * The research provider is a **declared test double**, the email provider is the
 * **sandbox**, and the calendar is a **sandbox** too: nothing here retrieves,
 * and nothing here fabricates a live delivery or a live event.
 */

let seq = 0;
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

/** Declared observations only: no retrieval of any kind. */
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
    { filterToScope: false },
  );
}

type Handlers = ReturnType<typeof createDefaultHandlers>;

function tenant(name: string): { token: string; workspaceId: string } {
  const owner = signup(unique("p912") + "@example.com", "correct-horse-battery", name);
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, workspaceId: workspace.value.id };
}

interface Journey {
  accountId: string;
  qualificationId: string;
  contactId: string;
  recipientEmail: string;
  draftId: string;
  draftVersion: number;
  approvalId: string;
  sentActionId: string;
}

interface Prepared {
  accountId: string;
  qualificationId: string;
  contactId: string;
  recipientEmail: string;
  draftId: string;
  draftVersion: number;
  approvalId: string;
  stagedActionId: string;
  researchRequestId: string;
}

/** The derived cost answer Phase 16's metrics route returns. */
interface IntegrationCostMetrics {
  ruleVersion: string;
  totals: { totalMinor: number; eventCount: number };
  denominators: { prospects: number; qualifiedOpportunities: number; meetings: number };
  metrics: {
    name: string;
    status: string;
    denominator: number;
    averageMinor: number | null;
  }[];
  refused: { name: string; owningPhase: string | null }[];
}

/** The dashboard Phase 17 derives, as the transport layer returns it. */
interface IntegrationDashboard {
  ruleVersion: string;
  goal: { status: string; goal: { id: string } | null; reason: string | null };
  directRevenue: { status: string; amountMinor: number | null; owningPhase: string | null };
  pipelineCreated: { status: string; amountMinor: number | null; owningPhase: string | null };
  qualifiedProspects: { status: string; value: number | null };
  positiveConversations: { status: string; value: number | null };
  meetings: { status: string; total: number; byState: { state: string; count: number }[] };
  opportunities: { status: string; value: number | null };
  customers: { status: string; value: number | null; owningPhase: string | null };
  agentActivity: { key: string; count: number }[];
  approvalsRequired: { status: string; required: number; approvalIds: string[] };
  workflowFailures: {
    status: string;
    total: number;
    bySource: { source: string; count: number }[];
  };
  hotConversations: { status: string; value: number | null };
  cost: { ruleVersion: string; totals: { totalMinor: number; eventCount: number } };
  nextBestActions: { ruleVersion: string; recommendations: unknown[] };
}

/**
 * Brain → Goal → Account → Contact → Research → Evidence → Qualification →
 * Personalization → Approval → Staged, all through the real handlers.
 *
 * It stops one step short of the send on purpose: a test that needs the provider
 * to behave a particular way should drive the send itself, against the same
 * prepared chain every other test uses.
 */
async function prepare(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  recipientEmail: string,
): Promise<Prepared> {
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
        { name: "Northwind", industry: "SaaS", companySize: "50-200", geography: "Germany" },
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

  const research = (await dataOf(
    handlers.createResearchRequestHandler(
      request(
        token,
        { workspaceId, accountId: account.account.id },
        {
          provider: "press_release",
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
    handlers.runResearchRequestHandler(request(token, { id: research.request.id })),
  )) as { request: { status: string }; findings: { id: string }[] };
  expect(run.request.status).toBe("completed");
  for (const finding of run.findings) {
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
        { workspaceId, accountId: account.account.id },
        { revenueGoalId: goal.goal.id },
      ),
    ),
  )) as { qualification: { id: string; state: string } };
  expect(qualification.qualification.state).toBe("qualified");

  const draft = (await dataOf(
    handlers.createPersonalizedDraftHandler(
      request(
        token,
        { workspaceId, accountId: account.account.id },
        {
          qualificationId: qualification.qualification.id,
          offerId: offer.offer.id,
          contactId: contact.contact.id,
        },
      ),
    ),
  )) as { draft: { id: string; version: number } };

  const requested = (await dataOf(
    handlers.createApprovalRequestHandler(
      request(token, { workspaceId, draftId: draft.draft.id }, {}),
    ),
  )) as { approval: { id: string } };
  const decided = (await dataOf(
    handlers.decideApprovalRequestHandler(
      request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
    ),
  )) as { approval: { id: string; status: string } };
  expect(decided.approval.status).toBe("approved");

  const staged = (await dataOf(
    handlers.createOutboundActionHandler(
      request(token, { workspaceId, draftId: draft.draft.id }, {}),
    ),
  )) as { action: { id: string } };

  return {
    accountId: account.account.id,
    qualificationId: qualification.qualification.id,
    contactId: contact.contact.id,
    recipientEmail,
    draftId: draft.draft.id,
    draftVersion: draft.draft.version,
    approvalId: decided.approval.id,
    stagedActionId: staged.action.id,
    researchRequestId: research.request.id,
  };
}

interface Journey extends Prepared {
  sentActionId: string;
}

/** The full journey, ending in a message that genuinely went out. */
async function journey(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  recipientEmail: string,
): Promise<Journey> {
  const prepared = await prepare(handlers, token, workspaceId, recipientEmail);
  const sent = (await dataOf(
    handlers.sendOutboundActionHandler(
      request(token, { workspaceId, id: prepared.stagedActionId }),
    ),
  )) as { action: { id: string; status: string; sentAt: string | null } };
  expect(sent.action.status).toBe("sent");
  expect(sent.action.sentAt).not.toBeNull();
  return { ...prepared, sentActionId: sent.action.id };
}

function rowCounts(): {
  drafts: number;
  approvals: number;
  actions: number;
  claims: number;
  evidence: number;
  costs: number;
  registry: number;
  registryEvents: number;
  evaluationRuns: number;
  evaluationObservations: number;
} {
  const db = defaultStore.db;
  return {
    drafts: db.personalizedDrafts?.length ?? 0,
    approvals: db.approvalRequests?.length ?? 0,
    actions: db.outboundActions?.length ?? 0,
    claims: db.accountClaims?.length ?? 0,
    evidence: db.evidence?.length ?? 0,
    costs: db.costEvents?.length ?? 0,
    registry: db.agentRegistry?.length ?? 0,
    registryEvents: db.agentRegistryEvents?.length ?? 0,
    evaluationRuns: db.agentEvaluationRuns?.length ?? 0,
    evaluationObservations: db.agentEvaluationObservations?.length ?? 0,
  };
}

/** The seven node kinds a completed loop publishes, sorted. */
const GRAPH_NODES = [
  "company",
  "conversation",
  "evidence",
  "meeting",
  "opportunity",
  "person",
  "signal",
];

/** The twelve edge kinds one completed loop must produce, sorted. */
const GRAPH_EDGES = [
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

describe("phases 9-19 integration — document, decision, effect, response, booking, next step, graph, cost, dashboard, agents, evaluation", () => {
  it("carries one evidence-backed document through one decision to one delivery and one response", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const { token, workspaceId } = tenant("Nine To Twelve");
    const recipient = unique("p912ada") + "@northwind.example";

    const sent = await journey(handlers, token, workspaceId, recipient);

    // The response is recorded against the message that genuinely went out.
    const recorded = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          { body: "Happy to chat. When works for a call next week?" },
        ),
      ),
    )) as {
      message: { id: string; contactId: string; accountId: string };
      classification: { intent: string; recommendedNextAction: string; suppressed: boolean };
      events: { kind: string }[];
    };

    expect(recorded.message.contactId).toBe(sent.contactId);
    expect(recorded.message.accountId).toBe(sent.accountId);
    expect(recorded.classification.intent).toBe("positive_intent");
    expect(recorded.classification.recommendedNextAction).toBe("prepare_reply_for_approval");
    expect(recorded.classification.suppressed).toBe(false);
    expect(recorded.events.map((event) => event.kind)).toEqual(["classified", "escalated"]);

    // Read back from storage, not from the response envelope.
    const reread = (await dataOf(
      handlers.getInboundMessageHandler(request(token, { id: recorded.message.id })),
    )) as { classification: { intent: string } };
    expect(reread.classification.intent).toBe("positive_intent");
  });

  it("reading a response creates no draft, no approval and no send", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const { token, workspaceId } = tenant("Read Only");
    const recipient = unique("p912ro") + "@northwind.example";

    const sent = await journey(handlers, token, workspaceId, recipient);
    const before = rowCounts();

    for (const body of [
      "Happy to chat, book a call.",
      "What does it cost?",
      "Not interested.",
      "Please unsubscribe me.",
    ]) {
      await dataOf(
        handlers.createInboundMessageHandler(
          request(token, { workspaceId, outboundActionId: sent.sentActionId }, { body }),
        ),
      );
    }

    // Four responses read. Not one draft, approval or outbound action appeared.
    expect(rowCounts().drafts).toBe(before.drafts);
    expect(rowCounts().approvals).toBe(before.approvals);
    expect(rowCounts().actions).toBe(before.actions);
    // And no reply became a fact about the account.
    expect(rowCounts().claims).toBe(before.claims);
    expect(rowCounts().evidence).toBe(before.evidence);
    // The single action is still the one that was sent, attempted once.
    expect(defaultStore.db.outboundActions[0]?.attemptCount).toBe(1);
    expect(defaultStore.db.outboundActions[0]?.status).toBe("sent");
  });

  it("a positive response recommends a reply for approval, and approval still decides", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const { token, workspaceId } = tenant("Still Human");
    const recipient = unique("p912sh") + "@northwind.example";

    const sent = await journey(handlers, token, workspaceId, recipient);
    const before = rowCounts();

    await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          { body: "Yes! Book a call, I am interested." },
        ),
      ),
    );

    // "prepare_reply_for_approval" is the whole point: nothing was prepared and
    // nothing was approved. The recommendation is a note to a person.
    expect(rowCounts().drafts).toBe(before.drafts);
    expect(rowCounts().approvals).toBe(before.approvals);
    expect(rowCounts().actions).toBe(before.actions);

    // And the Phase 10 boundary still holds over that recommendation: a new
    // draft version needs its own approval before it can be staged at all.
    const regenerated = (await dataOf(
      handlers.createPersonalizedDraftHandler(
        request(
          token,
          { workspaceId, accountId: sent.accountId },
          { qualificationId: sent.qualificationId, contactId: sent.contactId },
        ),
      ),
    )) as { draft: { id: string; version: number } };
    expect(regenerated.draft.version).toBeGreaterThan(sent.draftVersion);

    const denied = await errorOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: regenerated.draft.id }, {}),
      ),
    );
    // The new version inherited nothing from the approval that covered the old
    // one, however positive the response was.
    expect(denied.code).toBe("CONFLICT");
    expect(denied.message).toContain("no approval covers this draft version");
    expect(JSON.stringify(denied)).toContain("request an approval for draft version");
  });

  it("an opt-out stops the next send, through the Phase 11 list that already existed", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const { token, workspaceId } = tenant("Opt Out Cascade");
    const recipient = unique("p912oo") + "@northwind.example";

    const sent = await journey(handlers, token, workspaceId, recipient);

    await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          { body: "Please unsubscribe me from your emails." },
        ),
      ),
    );

    // The second message is staged and approved as usual — and then refused,
    // because the Phase 11 send path checks the very list Phase 12 wrote to.
    const regenerated = (await dataOf(
      handlers.listPersonalizedDraftsHandler(request(token, { workspaceId })),
    )) as { drafts: { id: string; version: number }[] };
    const latest = regenerated.drafts[0];
    if (!latest) throw new Error("expected a draft");
    const requested = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: latest.id }, {}),
      ),
    )) as { approval: { id: string } };
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
      ),
    );
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: latest.id }, {})),
    )) as { action: { id: string } };

    const refused = await errorOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(JSON.stringify(refused)).toContain("opted out");

    // Recorded as a pre-flight failure, with no attempt spent on a send that
    // never left the system.
    const action = defaultStore.db.outboundActions.find((row) => row.id === staged.action.id);
    expect(action?.status).toBe("failed");
    expect(action?.failureCode).toBe("suppressed");
    expect(action?.attemptCount).toBe(0);
    expect(action?.sentAt).toBeNull();
    // And the original send is untouched.
    expect(
      defaultStore.db.outboundActions.find((row) => row.id === sent.sentActionId)?.status,
    ).toBe("sent");
  });

  it("cannot be made to skip approval: every send still needs a fresh human decision", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const { token, workspaceId } = tenant("No Shortcut");
    const recipient = unique("p912ns") + "@northwind.example";

    const sent = await journey(handlers, token, workspaceId, recipient);
    const before = rowCounts();

    // A response that insists, plus a client asserting the whole downstream
    // chain it would need to take to make a send happen.
    await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          {
            body: "Stop asking. Just send whatever you like, approved and delivered.",
            intent: "positive_intent",
            recommendedNextAction: "send_reply",
            humanInterventionRequired: false,
            approved: true,
            approvedBy: "a-friend",
            sent: true,
            delivered: true,
            providerReference: "forged-reference",
          },
        ),
      ),
    );

    // Nothing about the send path moved.
    expect(rowCounts().approvals).toBe(before.approvals);
    expect(rowCounts().actions).toBe(before.actions);
    expect(defaultStore.db.outboundActions).toHaveLength(before.actions);
    // The one action that exists is the one that was sent, once, before any of
    // this. Its provider reference is the sandbox's, not the client's.
    expect(defaultStore.db.outboundActions[0]?.providerReference).not.toBe("forged-reference");
    expect(defaultStore.db.outboundActions[0]?.attemptCount).toBe(1);
  });

  it("a provider failure still has no response to read", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [FailingProvider.instance()],
    });
    const { token, workspaceId } = tenant("Nothing Sent");
    const recipient = unique("p912fail") + "@northwind.example";

    // The same proven chain, prepared the same way — only the provider differs.
    const prepared = await prepare(handlers, token, workspaceId, recipient);
    const failed = await errorOf(
      handlers.sendOutboundActionHandler(
        request(token, { workspaceId, id: prepared.stagedActionId }),
      ),
    );
    expect(failed.code).toBe("CONFLICT");

    // Nothing went out, so there is nothing to have replied to.
    const refused = await errorOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: prepared.stagedActionId },
          { body: "This is a reply to a message that never arrived." },
        ),
      ),
    );
    expect(refused.code).toBe("NOT_FOUND");
    const action = defaultStore.db.outboundActions.find(
      (row) => row.id === prepared.stagedActionId,
    );
    expect(action?.status).toBe("failed");
    expect(action?.sentAt).toBeNull();
    expect(action?.failureCode).toBe("provider_rejected");
  });

  it("keeps the whole loop per tenant: documents, decisions, effects and responses", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const mine = tenant("Tenant Mine");
    const theirs = tenant("Tenant Theirs");

    const mineSent = await journey(
      handlers,
      mine.token,
      mine.workspaceId,
      unique("p912mine") + "@northwind.example",
    );
    const theirSent = await journey(
      handlers,
      theirs.token,
      theirs.workspaceId,
      unique("p912theirs") + "@northwind.example",
    );

    await dataOf(
      handlers.createInboundMessageHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId, outboundActionId: mineSent.sentActionId },
          { body: "Please unsubscribe me." },
        ),
      ),
    );

    // My opt-out is mine: it silences my address and nobody else's.
    const mySuppressions = (await dataOf(
      handlers.listOutboundSuppressionsHandler(
        request(mine.token, { workspaceId: mine.workspaceId }),
      ),
    )) as { suppressions: { email: string }[] };
    expect(mySuppressions.suppressions).toHaveLength(1);
    const theirSuppressions = (await dataOf(
      handlers.listOutboundSuppressionsHandler(
        request(theirs.token, { workspaceId: theirs.workspaceId }),
      ),
    )) as { suppressions: { email: string }[] };
    expect(theirSuppressions.suppressions).toEqual([]);

    // I cannot read their response, answer their action, or list their words.
    const theirMessages = (await dataOf(
      handlers.listInboundMessagesHandler(request(mine.token, { workspaceId: mine.workspaceId })),
    )) as { messages: unknown[] };
    expect(theirMessages.messages).toHaveLength(1);
    const crossed = await errorOf(
      handlers.createInboundMessageHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId, outboundActionId: theirSent.sentActionId },
          { body: "Sounds good!" },
        ),
      ),
    );
    expect(crossed.code).toBe("NOT_FOUND");
    expect(JSON.stringify(crossed)).not.toContain("Failure");
  });

  // -------------------------------------------------------------------------
  // Phase 13 — the booking seam
  // -------------------------------------------------------------------------

  it("books a meeting as a separate decision from the one that sent the message", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
      calendarProviders: [new SandboxCalendarProvider()],
    });
    const { token, workspaceId } = tenant("Nine To Thirteen");

    const ran = await journey(
      handlers,
      token,
      workspaceId,
      unique("p913book") + "@northwind.example",
    );

    const classified = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: ran.sentActionId },
          { body: "Happy to chat, book a call." },
        ),
      ),
    )) as { classification: { id: string; intent: string } };
    expect(classified.classification.intent).toBe("positive_intent");

    const proposed = (await dataOf(
      handlers.recommendMeetingHandler(
        request(
          token,
          { workspaceId },
          {
            classificationId: classified.classification.id,
            title: "Intro call",
            startsAt: "2026-11-02T10:00:00.000Z",
            endsAt: "2026-11-02T10:30:00.000Z",
            timezone: "Europe/Berlin",
            durationMinutes: 30,
          },
        ),
      ),
    )) as { meeting: { id: string; state: string; approvalId?: string } };

    // The Phase 10 approval that let the *message* go out does not also let the
    // *meeting* be booked. Scheduling is its own Level 2 external action.
    expect(proposed.meeting.state).toBe("recommended");
    const premature = await errorOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    );
    expect(premature.code).toBe("CONFLICT");

    // A fresh, separate human decision is what moves it forward.
    await dataOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "approve" }),
      ),
    );
    const booked = (await dataOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    )) as { meeting: { state: string; externalEventId: string | null } };
    expect(booked.meeting.state).toBe("booked");
    expect(booked.meeting.externalEventId).toContain("sandbox-meeting-");
  });

  it("books nothing else: no invitation, no draft, no approval, no evidence", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
      calendarProviders: [new SandboxCalendarProvider()],
    });
    const { token, workspaceId } = tenant("Nine To Thirteen Quiet");

    const ran = await journey(
      handlers,
      token,
      workspaceId,
      unique("p913quiet") + "@northwind.example",
    );
    const classified = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: ran.sentActionId },
          { body: "Happy to chat, book a call." },
        ),
      ),
    )) as { classification: { id: string } };
    const proposed = (await dataOf(
      handlers.recommendMeetingHandler(
        request(
          token,
          { workspaceId },
          {
            classificationId: classified.classification.id,
            title: "Intro call",
            startsAt: "2026-11-02T10:00:00.000Z",
            endsAt: "2026-11-02T10:30:00.000Z",
            durationMinutes: 30,
          },
        ),
      ),
    )) as { meeting: { id: string } };

    const before = rowCounts();
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

    // Booking a meeting is not sending anything, and a meeting is not a fact.
    const after = rowCounts();
    expect(after.drafts).toBe(before.drafts);
    expect(after.approvals).toBe(before.approvals);
    expect(after.actions).toBe(before.actions);
    expect(after.claims).toBe(before.claims);
    expect(after.evidence).toBe(before.evidence);
  });

  it("stops a booking through the Phase 11 opt-out list, and keeps it per tenant", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
      calendarProviders: [new SandboxCalendarProvider()],
    });
    const mine = tenant("Nine To Thirteen Mine");
    const theirs = tenant("Nine To Thirteen Theirs");

    const myRan = await journey(
      handlers,
      mine.token,
      mine.workspaceId,
      unique("p913mine") + "@northwind.example",
    );
    const theirRan = await journey(
      handlers,
      theirs.token,
      theirs.workspaceId,
      unique("p913theirs") + "@northwind.example",
    );

    // My contact opts out. That response cannot become a meeting at all.
    await dataOf(
      handlers.createInboundMessageHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId, outboundActionId: myRan.sentActionId },
          { body: "Please unsubscribe me." },
        ),
      ),
    );
    // Then, even a positive-looking response on that same silenced address is
    // refused — the Phase 11 list the send path already checks is the one that
    // stops the booking too.
    const silenced = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId, outboundActionId: myRan.sentActionId },
          { body: "Happy to chat, book a call." },
        ),
      ),
    )) as { classification: { id: string; intent: string } };
    expect(silenced.classification.intent).toBe("positive_intent");
    expect(
      (
        await errorOf(
          handlers.recommendMeetingHandler(
            request(
              mine.token,
              { workspaceId: mine.workspaceId },
              {
                classificationId: silenced.classification.id,
                title: "Intro call",
                startsAt: "2026-11-02T10:00:00.000Z",
                endsAt: "2026-11-02T10:30:00.000Z",
                durationMinutes: 30,
              },
            ),
          ),
        )
      ).code,
    ).toBe("CONFLICT");

    // Their tenant's identical reply is entirely unaffected.
    const theirPositive = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          theirs.token,
          { workspaceId: theirs.workspaceId, outboundActionId: theirRan.sentActionId },
          { body: "Happy to chat, book a call." },
        ),
      ),
    )) as { classification: { id: string } };
    const theirMeeting = (await dataOf(
      handlers.recommendMeetingHandler(
        request(
          theirs.token,
          { workspaceId: theirs.workspaceId },
          {
            classificationId: theirPositive.classification.id,
            title: "Intro call",
            startsAt: "2026-11-02T10:00:00.000Z",
            endsAt: "2026-11-02T10:30:00.000Z",
            durationMinutes: 30,
          },
        ),
      ),
    )) as { meeting: { id: string; state: string } };
    expect(theirMeeting.meeting.state).toBe("recommended");

    // And I cannot see their meeting, answer it, or list it.
    expect(
      (
        await errorOf(
          handlers.getMeetingHandler(request(mine.token, { id: theirMeeting.meeting.id })),
        )
      ).code,
    ).toBe("NOT_FOUND");
    const theirList = (await dataOf(
      handlers.listMeetingsHandler(request(mine.token, { workspaceId: mine.workspaceId })),
    )) as { meetings: { id: string }[] };
    expect(theirList.meetings).toEqual([]);
  });

  it("reads the whole loop back as one next step, per tenant", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const mine = tenant("Next Step Mine");
    const theirs = tenant("Next Step Theirs");

    // The loop runs to a genuine delivery and a genuine positive response.
    const sent = await journey(
      handlers,
      mine.token,
      mine.workspaceId,
      unique("p912next") + "@northwind.example",
    );
    const positive = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId, outboundActionId: sent.sentActionId },
          { body: "Happy to chat, book a call." },
        ),
      ),
    )) as { classification: { id: string; intent: string } };
    expect(positive.classification.intent).toBe("positive_intent");

    // Everything that actually happened is now one recommendation away.
    const recommendation = (await dataOf(
      handlers.recommendNextActionHandler(
        request(mine.token, { workspaceId: mine.workspaceId }, { accountId: sent.accountId }),
      ),
    )) as {
      action: string;
      supportingState: string;
      reason: string;
      confidenceReasons: string[];
      confidence: string;
      expectedOutcome: string;
      approvalRequired: boolean;
      riskLevel: string;
      evidenceIds: string[];
      ruleVersion: string;
    };

    // §21's seven required fields, all present on the live answer.
    expect(recommendation.action).toBe("propose_meeting");
    expect(recommendation.supportingState).toBe("positive_response_without_meeting");
    expect(recommendation.reason).toContain("positive_intent");
    expect(recommendation.confidenceReasons.length).toBeGreaterThan(0);
    expect(["low", "medium", "high"]).toContain(recommendation.confidence);
    expect(recommendation.expectedOutcome).toBe("meeting_proposed");
    expect(recommendation.approvalRequired).toBe(false);
    expect(recommendation.riskLevel).toBe("level_1_draft");
    expect(recommendation.ruleVersion).toBe("next-action-1.0.0");
    // It cites **no** evidence, and that is deliberate: this recommendation rests
    // on a conversation DEALORA took part in, not on the account's fit profile.
    // Claiming the evidence graph supports a statement about a reply would imply
    // the records back something they never saw — the failure Phase 7 exists to
    // prevent. A recommendation with nothing to cite cites nothing.
    expect(recommendation.evidenceIds).toEqual([]);

    // It agrees with what every earlier phase actually did: no more sends, no new
    // draft, no new approval.
    const before = rowCounts();
    await dataOf(
      handlers.recordNextActionHandler(
        request(mine.token, { workspaceId: mine.workspaceId }, { accountId: sent.accountId }),
      ),
    );
    expect(rowCounts()).toEqual(before);

    // And it is per tenant: their board never mentions my account.
    const theirBoard = (await dataOf(
      handlers.recommendWorkspaceActionsHandler(
        request(theirs.token, { workspaceId: theirs.workspaceId }),
      ),
    )) as { recommendations: { accountId: string }[] };
    expect(theirBoard.recommendations).toEqual([]);

    // Calling into a workspace I do not belong to is refused at the workspace
    // guard, before the account is ever looked up.
    const crossed = await errorOf(
      handlers.recommendNextActionHandler(
        request(mine.token, { workspaceId: theirs.workspaceId }, { accountId: sent.accountId }),
      ),
    );
    expect(crossed.code).toBe("UNAUTHORIZED");

    // And an account that is not mine, named inside my own workspace, is reported
    // as absent rather than forbidden — so a foreign id cannot be discovered by
    // watching which error comes back.
    const foreign = await errorOf(
      handlers.recommendNextActionHandler(
        request(mine.token, { workspaceId: mine.workspaceId }, { accountId: "acct-not-mine" }),
      ),
    );
    expect(foreign.code).toBe("NOT_FOUND");
  });

  it("reads the whole loop back as one graph, per tenant", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
      calendarProviders: [new SandboxCalendarProvider()],
    });
    const mine = tenant("Graph Mine");
    const theirs = tenant("Graph Theirs");

    // My loop runs all the way to a booked meeting — the full revenue loop.
    const sent = await journey(
      handlers,
      mine.token,
      mine.workspaceId,
      unique("p15mine") + "@northwind.example",
    );
    const positive = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId, outboundActionId: sent.sentActionId },
          { body: "Happy to chat, book a call." },
        ),
      ),
    )) as { classification: { id: string; intent: string } };
    expect(positive.classification.intent).toBe("positive_intent");
    const proposed = (await dataOf(
      handlers.recommendMeetingHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId },
          {
            classificationId: positive.classification.id,
            title: "Intro call",
            startsAt: "2026-11-02T10:00:00.000Z",
            endsAt: "2026-11-02T10:30:00.000Z",
            durationMinutes: 30,
          },
        ),
      ),
    )) as { meeting: { id: string } };
    await dataOf(
      handlers.decideMeetingHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId, id: proposed.meeting.id },
          { decision: "approve" },
        ),
      ),
    );
    await dataOf(
      handlers.bookMeetingHandler(
        request(mine.token, { workspaceId: mine.workspaceId, id: proposed.meeting.id }),
      ),
    );

    // Their loop stops at a message that genuinely went out.
    await journey(
      handlers,
      theirs.token,
      theirs.workspaceId,
      unique("p15theirs") + "@northwind.example",
    );

    // Reading the graph writes nothing at all.
    const before = rowCounts();
    const graph = (await dataOf(
      handlers.getRevenueGraphHandler(request(mine.token, { workspaceId: mine.workspaceId })),
    )) as {
      ruleVersion: string;
      accountCount: number;
      nodes: { id: string; kind: string }[];
      edges: { kind: string; from: string; to: string }[];
    };
    expect(rowCounts()).toEqual(before);

    // One graph, every stage of the loop, all twelve relationships — derived
    // from the exact rows the phases above actually wrote, never stored.
    expect(graph.ruleVersion).toBe("revenue-graph-1.0.0");
    expect(graph.accountCount).toBe(1);
    expect([...new Set(graph.nodes.map((node) => node.kind))].sort()).toEqual(GRAPH_NODES);
    expect([...new Set(graph.edges.map((edge) => edge.kind))].sort()).toEqual(GRAPH_EDGES);

    // The trace of one opportunity is the same rows, walked from the account
    // that holds them: the frontier is the furthest stage the loop reached.
    const trace = (await dataOf(
      handlers.traceOpportunityHandler(
        request(mine.token, { workspaceId: mine.workspaceId }, { accountId: sent.accountId }),
      ),
    )) as {
      lifecycle: { frontier: string; opportunity: string | null };
      edges: { kind: string }[];
    };
    expect(trace.lifecycle.frontier).toBe("meeting");
    expect(trace.lifecycle.opportunity).toBe(sent.qualificationId);
    expect([...new Set(trace.edges.map((edge) => edge.kind))].sort()).toEqual(GRAPH_EDGES);

    // Per tenant: their graph is their own loop, and never mentions my account.
    const theirGraph = (await dataOf(
      handlers.getRevenueGraphHandler(request(theirs.token, { workspaceId: theirs.workspaceId })),
    )) as { accountCount: number; nodes: { id: string }[] };
    expect(theirGraph.accountCount).toBe(1);
    expect(theirGraph.nodes.some((node) => node.id === sent.accountId)).toBe(false);

    // Crossing workspaces is refused at the workspace guard, before the graph
    // is ever derived, and a foreign account id inside my own workspace reads
    // as absent rather than forbidden.
    const crossed = await errorOf(
      handlers.traceOpportunityHandler(
        request(mine.token, { workspaceId: theirs.workspaceId }, { accountId: sent.accountId }),
      ),
    );
    expect(crossed.code).toBe("UNAUTHORIZED");
    const foreign = await errorOf(
      handlers.traceOpportunityHandler(
        request(mine.token, { workspaceId: mine.workspaceId }, { accountId: "acct-not-mine" }),
      ),
    );
    expect(foreign.code).toBe("NOT_FOUND");
  });

  it("prices the whole loop: every execution shows a cost and the metrics derive from this journey's rows", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
      calendarProviders: [new SandboxCalendarProvider()],
    });
    const { token, workspaceId } = tenant("Sixteen");

    // The full journey: a research run, a message that genuinely went out —
    // then a positive reply and a meeting that genuinely got booked, so all
    // three executable run kinds exist as real rows.
    const sent = await journey(
      handlers,
      token,
      workspaceId,
      unique("p16ada") + "@northwind.example",
    );
    const positive = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          { body: "Happy to chat. When works for a call next week?" },
        ),
      ),
    )) as { classification: { id: string; intent: string } };
    expect(positive.classification.intent).toBe("positive_intent");
    const proposed = (await dataOf(
      handlers.recommendMeetingHandler(
        request(
          token,
          { workspaceId },
          {
            classificationId: positive.classification.id,
            title: "Intro call",
            startsAt: "2026-11-02T10:00:00.000Z",
            endsAt: "2026-11-02T10:30:00.000Z",
            timezone: "Europe/Berlin",
            durationMinutes: 30,
          },
        ),
      ),
    )) as { meeting: { id: string; state: string } };
    await dataOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "approve" }),
      ),
    );
    const booked = (await dataOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    )) as { meeting: { id: string; state: string } };
    expect(booked.meeting.state).toBe("booked");

    // One fact per execution kind — the runs this repository can perform.
    const facts = [
      {
        executionKind: "research_run",
        executionId: sent.researchRequestId,
        category: "llm",
        basis: "estimated",
        amountMinor: 800,
      },
      {
        executionKind: "outbound_send",
        executionId: sent.sentActionId,
        category: "tool",
        basis: "measured",
        amountMinor: 250,
      },
      {
        executionKind: "meeting_booking",
        executionId: booked.meeting.id,
        category: "infrastructure",
        basis: "measured",
        amountMinor: 400,
      },
    ];
    const before = rowCounts();
    for (const fact of facts) {
      await dataOf(
        handlers.recordCostHandler(
          request(
            token,
            { workspaceId },
            {
              ...fact,
              currency: "USD",
              source: "provider usage export",
              occurredAt: "2026-10-02T00:00:00.000Z",
              idempotencyKey: unique("p16cost"),
            },
          ),
        ),
      );
    }
    // Recording cost touched exactly one table: cost_events only.
    const after = rowCounts();
    expect(after.costs).toBe(before.costs + 3);
    for (const table of Object.keys(before) as (keyof typeof before)[]) {
      if (table === "costs") continue;
      expect(after[table]).toBe(before[table]);
    }

    // Every execution of the journey shows its own cost — the gate, across
    // all three run kinds, each with its own basis.
    for (const fact of facts) {
      const summary = (await dataOf(
        handlers.getExecutionCostHandler(
          request(token, { workspaceId }, undefined, {
            executionKind: fact.executionKind,
            executionId: fact.executionId,
          }),
        ),
      )) as {
        totals: {
          eventCount: number;
          totalMinor: number;
          estimatedMinor: number;
          measuredMinor: number;
          currency: string | null;
        };
      };
      expect(summary.totals.eventCount).toBe(1);
      expect(summary.totals.totalMinor).toBe(fact.amountMinor);
      expect(summary.totals.currency).toBe("USD");
      if (fact.basis === "estimated") {
        expect(summary.totals.estimatedMinor).toBe(fact.amountMinor);
        expect(summary.totals.measuredMinor).toBe(0);
      } else {
        expect(summary.totals.measuredMinor).toBe(fact.amountMinor);
        expect(summary.totals.estimatedMinor).toBe(0);
      }
    }

    // All three per-outcome metrics derive from this one journey: one stored
    // account, one qualified opportunity, one booked meeting. The three
    // metrics that need customers, revenue or campaigns stay refused.
    const metricsOf = async (): Promise<IntegrationCostMetrics> =>
      (await dataOf(
        handlers.getCostMetricsHandler(request(token, { workspaceId })),
      )) as IntegrationCostMetrics;
    const metrics = await metricsOf();
    expect(metrics.totals.totalMinor).toBe(800 + 250 + 400);
    expect(metrics.totals.eventCount).toBe(3);
    expect(metrics.denominators).toEqual({
      prospects: 1,
      qualifiedOpportunities: 1,
      meetings: 1,
    });
    expect(metrics.metrics.every((metric) => metric.status === "derived")).toBe(true);
    const perProspect = metrics.metrics.find((metric) => metric.name === "cost_per_prospect");
    expect(perProspect?.denominator).toBe(1);
    expect(perProspect?.averageMinor).toBe(1450);
    const perMeeting = metrics.metrics.find((metric) => metric.name === "cost_per_meeting");
    expect(perMeeting?.denominator).toBe(1);
    expect(metrics.refused.map((entry) => entry.name)).toEqual([
      "cost_per_customer",
      "revenue_per_ai_cost",
      "revenue_per_campaign",
    ]);
    expect(metrics.refused[0]?.owningPhase).toBe("Phase 17 / 23");

    // Deriving twice from the same rows answers the same thing: no stored
    // aggregate, no accumulation, no clock.
    expect(await metricsOf()).toEqual(metrics);

    // And none of these reads wrote a single row of any kind.
    expect(rowCounts()).toEqual(after);
  });

  it("reports the whole loop as business outcomes on one dashboard, per tenant", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
      calendarProviders: [new SandboxCalendarProvider()],
    });
    const { token, workspaceId } = tenant("Seventeen");
    const other = tenant("Seventeen Other");

    // The same journey the phases before it walked: a real account, real
    // research, a real qualification, a real message that genuinely went out,
    // a real positive reply, and a real meeting that genuinely got booked.
    const sent = await journey(
      handlers,
      token,
      workspaceId,
      unique("p17ada") + "@northwind.example",
    );
    const positive = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          { body: "Happy to chat. When works for a call next week?" },
        ),
      ),
    )) as { classification: { id: string; intent: string } };
    expect(positive.classification.intent).toBe("positive_intent");
    const proposed = (await dataOf(
      handlers.recommendMeetingHandler(
        request(
          token,
          { workspaceId },
          {
            classificationId: positive.classification.id,
            title: "Intro call",
            startsAt: "2026-11-02T10:00:00.000Z",
            endsAt: "2026-11-02T10:30:00.000Z",
            timezone: "Europe/Berlin",
            durationMinutes: 30,
          },
        ),
      ),
    )) as { meeting: { id: string; state: string } };
    await dataOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "approve" }),
      ),
    );
    const booked = (await dataOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    )) as { meeting: { id: string; state: string } };
    expect(booked.meeting.state).toBe("booked");

    const before = rowCounts();
    const dashboardOf = async (t: string, w: string): Promise<IntegrationDashboard> =>
      (await dataOf(
        handlers.getDashboardHandler(request(t, { workspaceId: w })),
      )) as IntegrationDashboard;
    const snapshot = await dashboardOf(token, workspaceId);

    // Reading the dashboard wrote nothing at all.
    expect(rowCounts()).toEqual(before);

    // **What is working?** One account qualified, one positive conversation, one
    // booked meeting, and — because the qualified account's loop actually
    // reached a calendar — one opportunity. These are outcomes read out of the
    // rows every earlier phase wrote, not numbers anyone supplied.
    expect(snapshot.qualifiedProspects.value).toBe(1);
    expect(snapshot.positiveConversations.value).toBe(1);
    expect(snapshot.meetings.total).toBe(1);
    expect(snapshot.meetings.byState.find((entry) => entry.state === "booked")?.count).toBe(1);
    expect(snapshot.opportunities.value).toBe(1);

    // **What needs attention?** The journey owes no decision and has failed
    // nothing; the approval was decided and the send genuinely went out.
    expect(snapshot.workflowFailures.total).toBe(0);
    expect(snapshot.workflowFailures.bySource).toEqual([
      { source: "research_run", count: 0 },
      { source: "outbound_send", count: 0 },
      { source: "meeting_booking", count: 0 },
    ]);

    // **Agent Activity is the work, not the outcome** — and it disagrees with
    // the outcome tiles exactly where it should. The meeting exists, so
    // activity counts one meeting, but no draft-rendered counter is invented
    // for phases that stored nothing here beyond the one the journey made.
    const activity = new Map(snapshot.agentActivity.map((entry) => [entry.key, entry.count]));
    expect(activity.get("accounts_researched")).toBe(1);
    expect(activity.get("prospects_qualified")).toBe(1);
    expect(activity.get("replies_classified")).toBe(1);

    // **Where are we?** A journey with no revenue goal still gets no invented
    // target: the tile refuses and says why.
    expect(snapshot.goal.status).toBe("no_data");
    expect(snapshot.goal.goal).toBeNull();

    // The three financial outcomes no phase through 17 records stay refused,
    // with the phase that owns them, no matter how far the loop got.
    for (const tile of [snapshot.directRevenue, snapshot.pipelineCreated]) {
      expect(tile.status).toBe("no_data");
      expect(tile.amountMinor).toBeNull();
      expect(tile.owningPhase).toBe("Phase 23");
    }
    expect(snapshot.customers.status).toBe("no_data");
    expect(snapshot.customers.value).toBeNull();

    // **What should happen next?** Phase 14's board, embedded whole, so this
    // phase can never advise differently from the engine that owns advice.
    const board = (await dataOf(
      handlers.recommendWorkspaceActionsHandler(request(token, { workspaceId })),
    )) as { ruleVersion: string; recommendations: unknown[] };
    expect(snapshot.nextBestActions.ruleVersion).toBe(board.ruleVersion);
    expect(snapshot.nextBestActions.recommendations).toEqual(board.recommendations);

    // Deriving twice answers identically: no stored aggregate, no clock.
    expect(await dashboardOf(token, workspaceId)).toEqual(snapshot);

    // **Per tenant.** Another workspace's dashboard is its own, and reading the
    // first workspace with the second tenant's token is refused outright.
    const theirs = await dashboardOf(other.token, other.workspaceId);
    expect(theirs.qualifiedProspects.value).toBe(0);
    expect(theirs.meetings.total).toBe(0);
    expect(theirs.opportunities.value).toBe(0);
    expect(theirs.nextBestActions.recommendations).toEqual([]);
    const crossTenant = await errorOf(
      handlers.getDashboardHandler(request(other.token, { workspaceId })),
    );
    expect(crossTenant.code).toBe("UNAUTHORIZED");
  });

  it("adds nothing of its own to storage: the dashboard is derived on read", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
      calendarProviders: [new SandboxCalendarProvider()],
    });
    const { token, workspaceId } = tenant("Seventeen Read Only");

    const before = rowCounts();
    // A full journey, so every tile has something real to derive from.
    const sent = await journey(
      handlers,
      token,
      workspaceId,
      unique("p17ro") + "@northwind.example",
    );
    const positive = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          { body: "Sounds good, send it over." },
        ),
      ),
    )) as { classification: { id: string } };

    const afterJourney = rowCounts();
    expect(afterJourney.drafts).toBe(before.drafts + 1);
    expect(afterJourney.approvals).toBe(before.approvals + 1);
    expect(afterJourney.actions).toBe(before.actions + 1);
    // The journey's findings become one claim each, so only the direction is
    // fixed here; the exact count belongs to Phase 7's own gate.
    expect(afterJourney.claims).toBeGreaterThan(before.claims);
    expect(afterJourney.evidence).toBeGreaterThan(before.evidence);

    // Reading both dashboard routes, twice each, in any order, writes nothing:
    // not a draft, not an approval, not an outbound action, not a cost event,
    // and not an evidence or claim record.
    await dataOf(handlers.getDashboardHandler(request(token, { workspaceId })));
    await dataOf(handlers.getDashboardPolicyHandler(request(token, { workspaceId })));
    await dataOf(handlers.getDashboardHandler(request(token, { workspaceId })));
    await dataOf(handlers.getDashboardPolicyHandler(request(token, { workspaceId })));

    expect(rowCounts()).toEqual(afterJourney);

    // The response was classified, which is a Phase 12 fact the dashboard
    // reads — it did not create the classification, and reading it again did
    // not create another one.
    expect(positive.classification.id).toEqual(expect.any(String));
    const stored = defaultStore.db.conversationClassifications ?? [];
    const matching = stored.filter((row) => row.workspaceId === workspaceId);
    expect(matching).toHaveLength(1);
  });
});

interface IntegrationAgent {
  declaration: {
    agentId: string;
    version: string;
    owner: string;
    purpose: string;
    tools: string[];
    permissions: string[];
    memoryAccess: string[];
    approvalRequired: boolean;
    costLimits: { maxSpendMinor: number; maxPerExecutionMinor: number; currency: string };
    evaluationMetrics: string[];
    model: { provider: string | null; model: string | null; temperature: number | null };
    initialState: string;
  };
  status: string;
  usable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface IntegrationRegistry {
  ruleVersion: string;
  agents: IntegrationAgent[];
}

interface IntegrationAgentEvents {
  events: {
    id: string;
    workspaceId: string;
    agentId: string;
    actorUserId: string;
    kind: string;
    fromStatus: string | null;
    toStatus: string;
    createdAt: string;
  }[];
}

interface IntegrationAgentPolicy {
  agents: { agentId: string; owner: string }[];
  states: string[];
  usableStates: string[];
  promotionRule: string;
  tools: { tool: string; executedBy: string; approvalImplied: boolean }[];
  evaluationMetrics: { metric: string; owningPhase: string }[];
  neverDoes: string[];
}

describe("phases 9-19 integration — the agent registry over a real journey", () => {
  it("declares the twelve agents and their lifecycle over the state the journey produced, without touching it", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
      calendarProviders: [new SandboxCalendarProvider()],
    });
    const { token, workspaceId } = tenant("Eighteen Registry");
    const recipient = unique("p18registry") + "@northwind.example";

    // The whole Phases 9–13 loop first: a document, a decision, a send, a
    // response. The registry reads state that genuinely exists, not a fixture
    // invented for it.
    const walked = await journey(handlers, token, workspaceId, recipient);

    const before = rowCounts();

    const registry = (await dataOf(
      handlers.getAgentRegistryHandler(request(token, { workspaceId })),
    )) as IntegrationRegistry;
    expect(registry.agents).toHaveLength(12);
    expect(registry.agents.map((entry) => entry.declaration.agentId)).toEqual([
      "strategy",
      "market_intelligence",
      "account_research",
      "prospect_discovery",
      "qualification",
      "personalization",
      "conversation",
      "follow_up",
      "meeting",
      "crm",
      "analytics",
      "optimization",
    ]);
    // Untouched by the journey: nothing in Phases 9–17 registered an agent, and
    // every agent therefore reads as its declaration default.
    expect(registry.agents.every((entry) => entry.status === "draft")).toBe(true);
    expect(registry.agents.every((entry) => entry.updatedBy === null)).toBe(true);

    // The agents that name this journey's own phases declare the tools those
    // phases already own — the registry references them rather than
    // reimplementing or bypassing them.
    const byId = new Map(registry.agents.map((entry) => [entry.declaration.agentId, entry]));
    expect(byId.get("personalization")?.declaration.owner).toMatch(/^Phase 9/);
    expect(byId.get("personalization")?.declaration.tools).toContain("render_draft");
    expect(byId.get("conversation")?.declaration.owner).toMatch(/^Phase 12/);
    expect(byId.get("conversation")?.declaration.tools).toContain("classify_reply");
    expect(byId.get("follow_up")?.declaration.tools).toContain("request_approval");
    expect(byId.get("meeting")?.declaration.tools).toContain("book_meeting");
    // Phase 19 will measure what these agents declare; Phase 18 measures none.
    expect(byId.get("conversation")?.declaration.evaluationMetrics).toContain(
      "response_classification_accuracy",
    );
    expect(byId.get("conversation")?.declaration.model).toEqual({
      provider: null,
      model: null,
      temperature: null,
    });

    // Reading the registry wrote nothing: the journey's drafts, approvals,
    // sends, claims, evidence and costs are exactly as it left them.
    expect(rowCounts()).toEqual(before);
    expect(walked.sentActionId).toBeTruthy();
  });

  it("records lifecycle decisions for the phases this journey used, and refuses promotion", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const { token, workspaceId } = tenant("Eighteen Lifecycle");
    const recipient = unique("p18lifecycle") + "@northwind.example";
    await journey(handlers, token, workspaceId, recipient);

    // The registry is where a workspace records what it has decided about the
    // agents that own its loop.
    for (const agentId of ["personalization", "conversation"]) {
      for (const status of ["testing", "approved"]) {
        await dataOf(
          handlers.changeAgentStatusHandler(request(token, { workspaceId, agentId }, { status })),
        );
      }
    }

    const events = (await dataOf(
      handlers.listAgentEventsHandler(request(token, { workspaceId })),
    )) as IntegrationAgentEvents;
    expect(events.events).toHaveLength(4);
    expect(events.events.every((event) => event.workspaceId === workspaceId)).toBe(true);
    // Decisions newest first by timestamp, ties in the order they were made,
    // and the trail records decisions only — never a run.
    for (let i = 1; i < events.events.length; i += 1) {
      expect(
        (events.events[i - 1]?.createdAt ?? "") >= (events.events[i]?.createdAt ?? ""),
        "the trail is not ordered newest first",
      ).toBe(true);
    }
    expect(events.events.filter((event) => event.kind === "registered")).toHaveLength(2);
    expect(
      events.events
        .filter((event) => event.kind === "state_changed")
        .map((event) => `${event.agentId}:${event.fromStatus}->${event.toStatus}`)
        .sort(),
    ).toEqual(["conversation:testing->approved", "personalization:testing->approved"]);
    expect(JSON.stringify(events.events).toLowerCase()).not.toContain("trace");

    // The road ends where ROADMAP.md §26 says it ends: Phase 18 declares the
    // metrics, Phase 19 measures them, and no agent reaches production here.
    const before = rowCounts();
    const refused = await errorOf(
      handlers.changeAgentStatusHandler(
        request(token, { workspaceId, agentId: "conversation" }, { status: "production" }),
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("evaluation evidence");
    expect(refused.details?.[0]?.message).toContain("Phase 19");
    expect(rowCounts()).toEqual(before);

    // And nothing became usable, so the loop's send and booking paths are
    // exactly as strict as they were before any agent existed.
    const registry = (await dataOf(
      handlers.getAgentRegistryHandler(request(token, { workspaceId })),
    )) as IntegrationRegistry;
    expect(registry.agents.every((entry) => entry.usable === false)).toBe(true);
  });

  it("keeps the registry per tenant and names each tool's owning phase", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const mine = tenant("Eighteen Mine");
    const theirs = tenant("Eighteen Theirs");

    await dataOf(
      handlers.changeAgentStatusHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId, agentId: "crm" },
          { status: "testing" },
        ),
      ),
    );

    const crossing = await errorOf(
      handlers.getAgentRegistryHandler(request(mine.token, { workspaceId: theirs.workspaceId })),
    );
    expect(crossing.code).toBe("UNAUTHORIZED");

    const theirRegistry = (await dataOf(
      handlers.getAgentRegistryHandler(request(theirs.token, { workspaceId: theirs.workspaceId })),
    )) as IntegrationRegistry;
    expect(theirRegistry.agents.every((entry) => entry.status === "draft")).toBe(true);

    // Every tool names an existing phase, so the registry cannot become a
    // second source of truth about what a capability is.
    const policy = (await dataOf(
      handlers.getAgentPolicyHandler(request(mine.token, { workspaceId: mine.workspaceId })),
    )) as IntegrationAgentPolicy;
    for (const tool of policy.tools) {
      expect(tool.executedBy, tool.tool).toMatch(/^Phase \d+/);
    }
    expect(policy.evaluationMetrics.every((metric) => metric.owningPhase === "Phase 19")).toBe(
      true,
    );
    expect(policy.usableStates).toEqual([]);
    expect(policy.neverDoes.join(" ")).toContain("Never executes");
  });
});

/** A provider that refuses every message, so a failed send can be observed. */
class FailingProvider {
  static instance(): import("@dealora/outbound").OutboundProvider {
    return new FailingProvider();
  }
  readonly name = "failing-email";
  send(): Promise<import("@dealora/outbound").OutboundProviderResult> {
    return Promise.resolve({
      accepted: false,
      providerReference: null,
      message: "the provider refused this message",
      failureCode: "provider_rejected",
    });
  }
}

describe("phases 9-19 integration — agent evaluation over a real journey", () => {
  /** The evaluation surface, typed the way the routes return it. */
  interface IntegrationMetric {
    metric: string;
    kind: string;
    threshold: number;
    minimumSample: number;
    sampleSize: number;
    measured: number | null;
    status: string;
    counts: { met: number; unmet: number; unobserved: number } | null;
    cost: { totalMinor: number; worstMinor: number; maxSpendMinor: number } | null;
    latency: { worstMs: number; ceilingMs: number } | null;
  }

  interface IntegrationReport {
    ruleVersion: string;
    agentId: string;
    agentVersion: string;
    run: { runNumber: number; observationCount: number } | null;
    metrics: IntegrationMetric[];
    status: string;
    gate: { satisfied: boolean; reason: string };
  }

  interface IntegrationEvaluationTrail {
    runs: {
      agentVersion: string;
      runNumber: number;
      observationCount: number;
      live: boolean;
    }[];
    observations: { metric: string; subjectId: string; recordedAt: string }[];
  }

  /**
   * Judge the executions this journey performed for `agentId`.
   *
   * Every subject id names an id the journey actually produced — the sent
   * action, the draft, the account — so the evidence is about real work rather
   * than about the words "task 1" and "task 2".
   */
  async function judgeJourney(
    handlers: Handlers,
    token: string,
    workspaceId: string,
    agentId: string,
    trip: Journey,
    verdicts: Readonly<Record<string, readonly ("met" | "unmet")[]>>,
  ): Promise<void> {
    await dataOf(handlers.openAgentEvaluationRunHandler(request(token, { workspaceId, agentId })));
    for (const [metric, judgements] of Object.entries(verdicts)) {
      for (const [index, verdict] of judgements.entries()) {
        await dataOf(
          handlers.recordAgentEvaluationHandler(
            request(
              token,
              { workspaceId, agentId },
              { metric, subjectId: `${metric}:${trip.sentActionId}:${index}`, verdict },
            ),
          ),
        );
      }
    }
    await dataOf(
      handlers.recordAgentEvaluationHandler(
        request(
          token,
          { workspaceId, agentId },
          { metric: "cost", subjectId: `send:${trip.sentActionId}`, amountMinor: 250 },
        ),
      ),
    );
  }

  /** Walk an agent to `approved` through the real route. */
  async function approveAgent(
    handlers: Handlers,
    token: string,
    workspaceId: string,
    agentId: string,
  ): Promise<void> {
    for (const status of ["testing", "approved"]) {
      await dataOf(
        handlers.changeAgentStatusHandler(request(token, { workspaceId, agentId }, { status })),
      );
    }
  }

  it("measures the journey's own executions and refuses promotion until it does", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const { token, workspaceId } = tenant("Nineteen Evaluation");
    const recipient = unique("p19evaluation") + "@northwind.example";
    const trip = await journey(handlers, token, workspaceId, recipient);

    // The journey classified a reply, so the conversation agent is the one
    // being evaluated; and it is walked to `approved` first.
    await approveAgent(handlers, token, workspaceId, "conversation");

    // Before anything is measured, §26's gate refuses and writes nothing.
    const beforeEvaluation = rowCounts();
    const refused = await errorOf(
      handlers.changeAgentStatusHandler(
        request(token, { workspaceId, agentId: "conversation" }, { status: "production" }),
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("evaluation evidence");
    expect(rowCounts()).toEqual(beforeEvaluation);

    // One of five classifications was misread: 4/5 is exactly 8000 basis
    // points, and `response_classification_accuracy` demands 9000.
    await judgeJourney(handlers, token, workspaceId, "conversation", trip, {
      response_classification_accuracy: ["met", "met", "met", "met", "unmet"],
      accuracy: ["met", "met", "met", "met", "met"],
      relevance: ["met", "met", "met", "met", "met"],
      tool_call_correctness: ["met", "met", "met", "met", "met"],
    });

    const report = (await dataOf(
      handlers.getAgentEvaluationHandler(request(token, { workspaceId, agentId: "conversation" })),
    )) as IntegrationReport;
    expect(report.agentVersion).toBe("1.0.0");
    expect(report.ruleVersion).toBe("evaluation-1.0.0");
    // Exactly the metrics this agent's declaration names, in declaration order.
    expect(report.metrics.map((metric) => metric.metric)).toEqual(
      declarationFor("conversation")?.evaluationMetrics,
    );
    const byMetric = new Map(report.metrics.map((metric) => [metric.metric, metric]));
    expect(byMetric.get("response_classification_accuracy")?.measured).toBe(8_000);
    expect(byMetric.get("response_classification_accuracy")?.status).toBe("unmet");
    expect(byMetric.get("accuracy")?.measured).toBe(10_000);
    expect(byMetric.get("cost")?.cost?.totalMinor).toBe(250);
    expect(byMetric.get("cost")?.status).toBe("met");

    // §26's gate still refuses, naming the metric rather than just denying.
    const stillRefused = await errorOf(
      handlers.changeAgentStatusHandler(
        request(token, { workspaceId, agentId: "conversation" }, { status: "production" }),
      ),
    );
    expect(stillRefused.code).toBe("VALIDATION_ERROR");
    expect(stillRefused.message).toContain("response_classification_accuracy unmet");
    const events = defaultStore.db.agentRegistryEvents?.filter(
      (event) => event.workspaceId === workspaceId,
    );
    expect(events).toHaveLength(2);

    // A fresh round with every classification read correctly closes the gap.
    const perfect = ["met", "met", "met", "met", "met"] as const;
    await judgeJourney(handlers, token, workspaceId, "conversation", trip, {
      response_classification_accuracy: perfect,
      accuracy: perfect,
      relevance: perfect,
      tool_call_correctness: perfect,
    });

    const passing = (await dataOf(
      handlers.getAgentEvaluationHandler(request(token, { workspaceId, agentId: "conversation" })),
    )) as IntegrationReport;
    expect(passing.run?.runNumber).toBe(2);
    expect(passing.status).toBe("met");
    expect(passing.gate.satisfied).toBe(true);

    // The transition is now permitted — and grants a governance state and no
    // capability. Nothing became usable, so the send and booking paths above
    // are exactly as strict as they were before any agent existed.
    const promoted = (await dataOf(
      handlers.changeAgentStatusHandler(
        request(token, { workspaceId, agentId: "conversation" }, { status: "production" }),
      ),
    )) as { agent: IntegrationAgent };
    expect(promoted.agent.status).toBe("production");
    expect(promoted.agent.usable).toBe(false);
    const registry = (await dataOf(
      handlers.getAgentRegistryHandler(request(token, { workspaceId })),
    )) as IntegrationRegistry;
    expect(registry.agents.every((entry) => entry.usable === false)).toBe(true);

    // The journey itself is untouched by the evaluation: one outbound action,
    // still `sent`, never re-sent and never re-rendered.
    const actions = defaultStore.db.outboundActions?.filter(
      (action) => action.workspaceId === workspaceId,
    );
    expect(actions).toHaveLength(1);
    expect(actions?.[0]?.status).toBe("sent");
    const drafts = defaultStore.db.personalizedDrafts?.filter(
      (draft) => draft.workspaceId === workspaceId,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts?.[0]?.version).toBe(trip.draftVersion);

    // Another agent the journey exercised is measured independently: evidence
    // is per (workspace, agent, version), never shared.
    const other = (await dataOf(
      handlers.getAgentEvaluationHandler(
        request(token, { workspaceId, agentId: "account_research" }),
      ),
    )) as IntegrationReport;
    expect(other.run).toBeNull();
    expect(other.status).toBe("insufficient_evidence");
    expect(other.gate.satisfied).toBe(false);
  });

  it("keeps the evaluation per tenant and the provenance per round, per tenant", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [new SandboxEmailProvider()],
    });
    const a = tenant("Nineteen Tenant A");
    const b = tenant("Nineteen Tenant B");
    const trip = await journey(
      handlers,
      a.token,
      a.workspaceId,
      unique("p19a") + "@northwind.example",
    );
    const perfect = ["met", "met", "met", "met", "met"] as const;

    await judgeJourney(handlers, a.token, a.workspaceId, "conversation", trip, {
      response_classification_accuracy: perfect,
      accuracy: perfect,
      relevance: perfect,
      tool_call_correctness: perfect,
    });

    const trail = (await dataOf(
      handlers.listAgentEvaluationTrailHandler(
        request(a.token, { workspaceId: a.workspaceId, agentId: "conversation" }),
      ),
    )) as IntegrationEvaluationTrail;
    expect(trail.runs).toHaveLength(1);
    expect(trail.runs[0]?.live).toBe(true);
    expect(trail.runs[0]?.agentVersion).toBe("1.0.0");
    expect(trail.runs[0]?.observationCount).toBe(trail.observations.length);
    expect(trail.observations.length).toBe(21);
    // Judgements, never a run trace: §27 (Phase 20) still owns those.
    expect(JSON.stringify(trail).toLowerCase()).not.toContain("trace");

    // B sees a complete, empty evaluation and cannot read A's.
    const theirs = (await dataOf(
      handlers.getAgentEvaluationHandler(
        request(b.token, { workspaceId: b.workspaceId, agentId: "conversation" }),
      ),
    )) as IntegrationReport;
    expect(theirs.run).toBeNull();
    expect(theirs.status).toBe("insufficient_evidence");
    expect(
      (
        await errorOf(
          handlers.listAgentEvaluationTrailHandler(
            request(b.token, { workspaceId: a.workspaceId, agentId: "conversation" }),
          ),
        )
      ).code,
    ).toBe("UNAUTHORIZED");

    // A second round supersedes rather than edits: the first round's
    // judgements survive untouched and simply stop being current.
    const rowsBefore = defaultStore.db.agentEvaluationObservations?.filter(
      (row) => row.workspaceId === a.workspaceId,
    ).length;
    await dataOf(
      handlers.openAgentEvaluationRunHandler(
        request(a.token, { workspaceId: a.workspaceId, agentId: "conversation" }),
      ),
    );
    const superseded = (await dataOf(
      handlers.listAgentEvaluationTrailHandler(
        request(a.token, { workspaceId: a.workspaceId, agentId: "conversation" }),
      ),
    )) as IntegrationEvaluationTrail;
    expect(superseded.runs.map((run) => run.runNumber)).toEqual([2, 1]);
    expect(superseded.runs.map((run) => run.live)).toEqual([true, false]);
    expect(superseded.runs[1]?.observationCount).toBe(21);
    expect(superseded.observations).toEqual([]);
    expect(
      defaultStore.db.agentEvaluationObservations?.filter(
        (row) => row.workspaceId === a.workspaceId,
      ).length,
    ).toBe(rowsBefore);
    const afterRounds = (await dataOf(
      handlers.getAgentEvaluationHandler(
        request(a.token, { workspaceId: a.workspaceId, agentId: "conversation" }),
      ),
    )) as IntegrationReport;
    expect(afterRounds.run?.runNumber).toBe(2);
    expect(afterRounds.status).toBe("insufficient_evidence");
    expect(afterRounds.gate.satisfied).toBe(false);
  });
});
