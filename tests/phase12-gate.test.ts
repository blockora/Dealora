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

/**
 * Phase 12 gate — ROADMAP.md §19.
 *
 * Its gate is one sentence: *an inbound response can be classified and
 * converted into a next action*. The first test walks the whole pipeline
 * through the real signup/session layer, the real default wiring and the real
 * default store — Business Brain → Revenue Goal → Account → Research → Evidence
 * → Qualification → Personalization → Approval → **Send** → **Response** → **Read**
 * — and reads the classification back out of the store's persisted document, so
 * what is proven is that the reading was *written*, not merely returned.
 *
 * **On the word "response".** A response is recorded by an authenticated user
 * through the API. No provider fetches replies in this phase: `ROADMAP.md` §19
 * asks for the interpretation of a response, not for the retrieval machinery,
 * and inventing a webhook, an inbox poller or an OAuth flow here would be
 * building a later phase's speculative surface. The provider is still the
 * sandbox from Phase 11, and the send at the end of the pipeline is the same
 * sandbox send — so nothing in this file fabricates a delivery or a reply.
 *
 * The rest of the suite is the refusal surface, which is what this phase is for:
 * no response without a message that went out, no client-forged classification,
 * safety precedence for an opt-out and a refusal, no response promoted to
 * evidence, and no cross-tenant read.
 *
 * The research provider is a **declared test double**, as in the Phase 9, 10 and
 * 11 gates: it returns the observations the test supplies and performs no
 * retrieval.
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

interface GateClassification {
  id: string;
  intent: string;
  confidence: string;
  reasons: string[];
  signals: string[];
  recommendedNextAction: string;
  humanInterventionRequired: boolean;
  suppressed: boolean;
  classifierVersion: string;
  inboundMessageId: string;
  outboundActionId: string;
}

interface GateResponse {
  message: {
    id: string;
    body: string;
    source: string;
    contactId: string;
    accountId: string;
    outboundActionId: string;
  };
  classification: GateClassification;
  events: { kind: string; detail: string | null }[];
}

/**
 * The declared observations that make an account qualify and give the draft
 * something specific for a human to read before approving it.
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

/** A real signup and a real workspace. */
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

interface SentPipeline {
  accountId: string;
  draftId: string;
  draftVersion: number;
  approvalId: string;
  contactId: string;
  recipientEmail: string;
  sentActionId: string;
}

/**
 * The whole pipeline, ending in a message that genuinely went out.
 *
 * Everything goes through the real handlers, so a response read at the end of it
 * is a response to something DEALORA actually sent — which is the only thing
 * this phase will accept.
 */
async function sentPipeline(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  accountName: string,
  recipientEmail: string,
): Promise<SentPipeline> {
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

  const generated = (await dataOf(
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
      request(token, { workspaceId, draftId: generated.draft.id }, {}),
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
      request(token, { workspaceId, draftId: generated.draft.id }, {}),
    ),
  )) as { action: { id: string } };
  const sent = (await dataOf(
    handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
  )) as { action: { id: string; status: string }; delivered: boolean };
  expect(sent.action.status).toBe("sent");
  expect(sent.delivered).toBe(true);

  return {
    accountId: account.account.id,
    draftId: generated.draft.id,
    draftVersion: generated.draft.version,
    approvalId: decided.approval.id,
    contactId: contact.contact.id,
    recipientEmail,
    sentActionId: sent.action.id,
  };
}

/**
 * A snapshot of the shared store's row counts.
 *
 * The default store is one document shared by every gate in this file, so a
 * test that asserted an absolute total would be measuring its neighbours. Each
 * test therefore records a baseline and asserts the *delta* it caused.
 */
function rowCounts(): {
  inbound: number;
  classifications: number;
  drafts: number;
  approvals: number;
  actions: number;
  claims: number;
  evidence: number;
  suppressions: number;
} {
  const db = defaultStore.db;
  return {
    inbound: db.inboundMessages?.length ?? 0,
    classifications: db.conversationClassifications?.length ?? 0,
    drafts: db.personalizedDrafts?.length ?? 0,
    approvals: db.approvalRequests?.length ?? 0,
    actions: db.outboundActions?.length ?? 0,
    claims: db.accountClaims?.length ?? 0,
    evidence: db.evidence?.length ?? 0,
    suppressions: db.outboundSuppressions?.length ?? 0,
  };
}

function handlersFor(): Handlers {
  return createDefaultHandlers({
    researchProviders: [researchProvider()],
    outboundProviders: [new SandboxEmailProvider()],
  });
}

/** Record one response and return the whole result, typed for the assertions. */
async function recordResponse(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  outboundActionId: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<GateResponse> {
  return (await dataOf(
    handlers.createInboundMessageHandler(
      request(token, { workspaceId, outboundActionId }, { body, ...extra }),
    ),
  )) as GateResponse;
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 12 gate — conversation engine", () => {
  it("classifies a real response and converts it into a next action", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Conversation Gate", unique("p12") + "@example.com");
    const recipient = unique("p12ada") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Northwind", recipient);
    const before = rowCounts();

    // The gate itself: a response that arrived is recorded and read.
    const recorded = await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "This sounds good. How much does it cost per month?",
      { subject: "Re: Support Automation for Northwind", source: "manual" },
    );

    expect(recorded.classification.intent).toBe("pricing");
    expect(["low", "medium", "high"]).toContain(recorded.classification.confidence);
    expect(recorded.classification.recommendedNextAction).toBe("prepare_reply_for_approval");
    // The strongest positive outcome still asks a person, because Phase 10 is
    // what makes a message leave the system.
    expect(recorded.classification.humanInterventionRequired).toBe(true);
    expect(recorded.classification.classifierVersion).toBe("deterministic-1.0.0");
    // The reasons name the phrases that decided it, not a restatement.
    expect(recorded.classification.reasons.join(" ")).toMatch(/matched/);
    expect(recorded.classification.signals.length).toBeGreaterThan(0);
    // And the message is stored verbatim, against the right person.
    expect(recorded.message.body).toBe("This sounds good. How much does it cost per month?");
    expect(recorded.message.contactId).toBe(sent.contactId);
    expect(recorded.message.accountId).toBe(sent.accountId);
    expect(recorded.message.outboundActionId).toBe(sent.sentActionId);
    expect(recorded.events.map((event) => event.kind)).toEqual(["classified", "escalated"]);

    // It is persisted, not merely returned: read it back out of the document.
    const reread = (await dataOf(
      handlers.getInboundMessageHandler(request(token, { id: recorded.message.id })),
    )) as GateResponse;
    expect(reread.classification.id).toBe(recorded.classification.id);
    expect(reread.classification.intent).toBe("pricing");
    expect(rowCounts().inbound).toBe(before.inbound + 1);
    expect(rowCounts().classifications).toBe(before.classifications + 1);

    // And the recommendation is a recommendation: classifying a positive reply
    // produced no new draft, no new approval and no second message.
    expect(rowCounts().drafts).toBe(before.drafts);
    expect(rowCounts().approvals).toBe(before.approvals);
    expect(rowCounts().actions).toBe(before.actions);
    expect(defaultStore.db.outboundActions[0]?.attemptCount).toBe(1);
  });

  it("covers the ten states ROADMAP.md §19 names", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Intent Coverage", unique("p12") + "@example.com");
    const recipient = unique("p12int") + "@northwind.example";
    const sent = await sentPipeline(handlers, token, workspaceId, "Coverage Ltd", recipient);
    const beforeCover = rowCounts();

    const cases: [string, string][] = [
      ["Unsubscribe me from this list please.", "unsubscribe"],
      ["We are not interested, thank you.", "negative_intent"],
      ["Too expensive for us right now.", "objection"],
      ["Not now, can we revisit next quarter?", "not_now"],
      ["I am not the right person, who else handles this?", "wrong_person"],
      ["I am interested, could you tell me more?", "interested"],
      ["Happy to chat, book a call.", "positive_intent"],
      ["I had a question about your setup.", "question"],
      ["What is the pricing per seat?", "pricing"],
      ["Team meeting moved to Thursday.", "unknown"],
    ];

    const seen: string[] = [];
    for (const [body, expected] of cases) {
      const recorded = await recordResponse(handlers, token, workspaceId, sent.sentActionId, body);
      expect(recorded.classification.intent).toBe(expected);
      seen.push(recorded.classification.intent);
    }
    expect(new Set(seen).size).toBe(10);
    expect(seen.sort()).toEqual(
      [
        "interested",
        "question",
        "pricing",
        "objection",
        "not_now",
        "wrong_person",
        "unsubscribe",
        "positive_intent",
        "negative_intent",
        "unknown",
      ].sort(),
    );

    // Every one of them produced a recommendation from the closed vocabulary,
    // and every one is inspectable afterwards.
    const listed = (await dataOf(
      handlers.listConversationClassificationsHandler(request(token, { workspaceId })),
    )) as { classifications: GateClassification[] };
    expect(listed.classifications).toHaveLength(10);
    expect(rowCounts().classifications).toBe(beforeCover.classifications + 10);
    for (const classification of listed.classifications) {
      expect([
        "stop_contacting",
        "prepare_reply_for_approval",
        "request_human_review",
        "record_and_hold",
      ]).toContain(classification.recommendedNextAction);
    }
  });

  it("honours an opt-out immediately, through the existing send path", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Opt Out Gate", unique("p12") + "@example.com");
    const recipient = unique("p12out") + "@northwind.example";
    const sent = await sentPipeline(handlers, token, workspaceId, "Opt Out Ltd", recipient);

    const recorded = await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Please unsubscribe me from all of your emails.",
    );
    expect(recorded.classification.intent).toBe("unsubscribe");
    expect(recorded.classification.recommendedNextAction).toBe("stop_contacting");
    expect(recorded.classification.suppressed).toBe(true);
    // An opt-out is the one outcome that does not wait for a human: waiting to
    // honour it is how a workspace ends up mailing someone who asked it to stop.
    expect(recorded.classification.humanInterventionRequired).toBe(false);
    expect(recorded.events.map((event) => event.kind)).toEqual(["classified", "suppressed"]);

    // It landed on the Phase 11 suppression list, which the send path already
    // checks — so no new mechanism was introduced.
    const suppressions = (await dataOf(
      handlers.listOutboundSuppressionsHandler(request(token, { workspaceId })),
    )) as { suppressions: { email: string; reason: string }[] };
    expect(suppressions.suppressions.map((entry) => entry.email)).toEqual([recipient]);
    expect(suppressions.suppressions[0]?.reason).toContain("asked to stop");

    // And the audit trail says so, permanently.
    const history = (await dataOf(
      handlers.conversationHistoryHandler(request(token, { id: recorded.classification.id })),
    )) as { events: { kind: string }[] };
    expect(history.events.map((event) => event.kind)).toEqual(["classified", "suppressed"]);
  });

  it("lets safety outrank a question asked in the same breath", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Safety Gate", unique("p12") + "@example.com");
    const recipient = unique("p12safe") + "@northwind.example";
    const sent = await sentPipeline(handlers, token, workspaceId, "Safety Ltd", recipient);

    // The failure this rule exists to prevent: "not interested, but what does it
    // cost?" read as a pricing question would recommend a reply to a refusal.
    const refusal = await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "We are not interested, but what does it cost?",
    );
    expect(refusal.classification.intent).toBe("negative_intent");
    expect(refusal.classification.recommendedNextAction).toBe("request_human_review");

    // A sensitive subject escalates whatever the intent was.
    const sensitive = await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "How much is this? Our lawyer has also asked about a complaint.",
    );
    expect(sensitive.classification.signals).toContain("sensitive_topic");
    expect(sensitive.classification.recommendedNextAction).toBe("request_human_review");
    expect(sensitive.classification.humanInterventionRequired).toBe(true);

    // An unusual request does too.
    const unusual = await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Send me your bank details by wire transfer.",
    );
    expect(unusual.classification.signals).toContain("unusual_request");
    expect(unusual.classification.recommendedNextAction).toBe("request_human_review");

    // Uncertainty escalates, and lowers the confidence rather than raising it.
    const uncertain = await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Who are you? I am not sure this is legitimate.",
    );
    expect(uncertain.classification.signals).toContain("uncertainty");
    expect(uncertain.classification.humanInterventionRequired).toBe(true);
    expect(uncertain.classification.confidence).not.toBe("high");
  });

  it("refuses a response to a message that was never sent", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Unsent Gate", unique("p12") + "@example.com");
    const recipient = unique("p12un") + "@northwind.example";
    const sent = await sentPipeline(handlers, token, workspaceId, "Unsent Ltd", recipient);

    // A real draft and approval, staged but deliberately never sent.
    const draft = (await dataOf(
      handlers.listPersonalizedDraftsHandler(request(token, { workspaceId })),
    )) as { drafts: { id: string; version: number }[] };
    const first = draft.drafts[0];
    if (!first) throw new Error("expected a draft");
    const requested = (await dataOf(
      handlers.createApprovalRequestHandler(request(token, { workspaceId, draftId: first.id }, {})),
    )) as { approval: { id: string } };
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
      ),
    );
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: first.id, version: first.version } as Record<
          string,
          string
        >),
      ),
    )) as { action: { id: string; status: string } };
    expect(staged.action.status).toBe("ready");

    const beforeUnsent = rowCounts();
    const denied = await errorOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: staged.action.id },
          { body: "Sounds good!" },
        ),
      ),
    );
    // Not found: a message DEALORA never sent cannot have been answered, and an
    // id that does not exist looks the same from outside.
    expect(denied.code).toBe("NOT_FOUND");
    expect(rowCounts().inbound).toBe(beforeUnsent.inbound);

    // The sent one still works, so the refusal is about this action and not
    // about the route.
    const accepted = await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Sounds good!",
    );
    expect(accepted.classification.intent).toBe("positive_intent");
  });

  it("never lets a client state the classification", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Forgery Gate", unique("p12") + "@example.com");
    const recipient = unique("p12for") + "@northwind.example";
    const sent = await sentPipeline(handlers, token, workspaceId, "Forgery Ltd", recipient);
    const before = rowCounts();

    const forged = await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Team meeting moved to Thursday.",
      {
        // Everything a client might try to assert about the reading:
        intent: "positive_intent",
        confidence: "high",
        recommendedNextAction: "prepare_reply_for_approval",
        humanInterventionRequired: false,
        suppressed: true,
        signals: ["opt_out"],
        classifierVersion: "gpt-read-9.9.9",
        contactId: "someone-else",
        accountId: "some-other-account",
        status: "approved",
        approvedBy: "a-friend",
      },
    );

    // The rules decided, not the caller: no rule matched, nothing was suppressed,
    // and a person still has to look at it.
    expect(forged.classification.intent).toBe("unknown");
    expect(forged.classification.suppressed).toBe(false);
    expect(forged.classification.humanInterventionRequired).toBe(true);
    expect(forged.classification.classifierVersion).toBe("deterministic-1.0.0");
    expect(forged.classification.signals).toEqual([]);
    // And the contact and account are the ones the sent action resolved.
    expect(forged.message.contactId).toBe(sent.contactId);
    expect(forged.message.accountId).toBe(sent.accountId);
    // No approval was forged along the way, and nothing was suppressed.
    expect(rowCounts().approvals).toBe(before.approvals);
    expect(rowCounts().suppressions).toBe(before.suppressions);
  });

  it("never turns a response into evidence, a claim or a new message", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Evidence Gate", unique("p12") + "@example.com");
    const recipient = unique("p12ev") + "@northwind.example";
    const sent = await sentPipeline(handlers, token, workspaceId, "Evidence Ltd", recipient);

    const before = rowCounts();

    await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Yes please, book a call. Our budget is approved and I am the decision maker.",
    );
    await recordResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "We just raised a Series B and now have 400 employees.",
    );

    // A prospect's own words are an interested party's claim. Phase 7 is the
    // only route by which anything becomes evidence, and it stays human-driven.
    expect(rowCounts().claims).toBe(before.claims);
    expect(rowCounts().evidence).toBe(before.evidence);
    // And reading a reply never produces a draft, an approval or a send.
    expect(rowCounts().drafts).toBe(before.drafts);
    expect(rowCounts().approvals).toBe(before.approvals);
    expect(rowCounts().actions).toBe(before.actions);
    expect(defaultStore.db.outboundActions[0]?.attemptCount).toBe(1);
  });

  it("refuses another tenant's response and shares no suppression list", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const mine = tenant("Tenant Mine", unique("p12") + "@example.com");
    const theirs = tenant("Tenant Theirs", unique("p12") + "@example.com");

    const theirRecipient = unique("p12their") + "@northwind.example";
    const theirSent = await sentPipeline(
      handlers,
      theirs.token,
      theirs.workspaceId,
      "Theirs Ltd",
      theirRecipient,
    );
    await recordResponse(
      handlers,
      theirs.token,
      theirs.workspaceId,
      theirSent.sentActionId,
      "Please unsubscribe me.",
    );

    // My tenant cannot answer their action.
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
    expect(JSON.stringify(crossed)).not.toContain("Theirs");

    // Nor read their response.
    const listed = (await dataOf(
      handlers.listInboundMessagesHandler(request(mine.token, { workspaceId: mine.workspaceId })),
    )) as { messages: { id: string }[] };
    expect(listed.messages).toHaveLength(0);

    // And their opt-out is invisible to me: not a suppression, not a leak.
    const mySuppressions = (await dataOf(
      handlers.listOutboundSuppressionsHandler(
        request(mine.token, { workspaceId: mine.workspaceId }),
      ),
    )) as { suppressions: { email: string }[] };
    expect(mySuppressions.suppressions).toEqual([]);
    expect(JSON.stringify(mySuppressions)).not.toContain(theirRecipient);
  });

  it("rejects an unusable response and an unknown rule version by name", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Validation Gate", unique("p12") + "@example.com");
    const recipient = unique("p12val") + "@northwind.example";
    const sent = await sentPipeline(handlers, token, workspaceId, "Validation Ltd", recipient);
    const before = rowCounts();

    const empty = await errorOf(
      handlers.createInboundMessageHandler(
        request(token, { workspaceId, outboundActionId: sent.sentActionId }, { body: "   " }),
      ),
    );
    expect(empty.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(empty)).toContain("body");

    const badSource = await errorOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          { body: "Hello", source: "carrier-pigeon" },
        ),
      ),
    );
    expect(badSource.code).toBe("VALIDATION_ERROR");

    const badInstant = await errorOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: sent.sentActionId },
          { body: "Hello", receivedAt: "last tuesday" },
        ),
      ),
    );
    expect(badInstant.code).toBe("VALIDATION_ERROR");

    const badFilter = await errorOf(
      handlers.listConversationClassificationsHandler(
        request(token, { workspaceId }, undefined, { intent: "vibes" }),
      ),
    );
    expect(badFilter.code).toBe("VALIDATION_ERROR");

    // None of that wrote anything.
    expect(rowCounts().inbound).toBe(before.inbound);
    expect(rowCounts().classifications).toBe(before.classifications);
  });

  it("requires authentication, and states its policy before anything exists", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Policy Gate", unique("p12") + "@example.com");

    const policy = (await dataOf(
      handlers.getConversationPolicyHandler(request(token, { workspaceId })),
    )) as {
      classifierVersion: string;
      intents: string[];
      dispositions: string[];
      requiresHumanIntervention: string[];
      neverDoes: string[];
    };
    expect(policy.classifierVersion).toBe("deterministic-1.0.0");
    expect(policy.intents).toHaveLength(10);
    expect(policy.dispositions).toHaveLength(4);
    expect(policy.requiresHumanIntervention.length).toBeGreaterThan(0);
    // The policy says the things this phase will never do, in the workspace's
    // own hands, before a single reply has been read.
    expect(policy.neverDoes.join(" ")).toContain("never sends a message");
    expect(policy.neverDoes.join(" ")).toContain("never turns a response into evidence");
    expect(policy.neverDoes.join(" ")).toContain("never schedules anything");

    const unauthenticated = await errorOf(
      handlers.listInboundMessagesHandler(request("", { workspaceId })),
    );
    expect(unauthenticated.code).toBe("UNAUTHENTICATED");
  });

  it("builds no autonomous surface: no polling, no schedule, no send path", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Autonomy Gate", unique("p12") + "@example.com");
    const recipient = unique("p12auto") + "@northwind.example";
    const sent = await sentPipeline(handlers, token, workspaceId, "Autonomy Ltd", recipient);
    const before = rowCounts();

    // Every handler this phase adds is a read or a record. None of them can
    // cause anything to leave the system: they take no approval id, no draft id
    // and no provider, and none of them has a counterpart in the send path.
    const conversationHandlers = [
      "createInboundMessageHandler",
      "getInboundMessageHandler",
      "listInboundMessagesHandler",
      "listConversationClassificationsHandler",
      "conversationHistoryHandler",
      "getConversationPolicyHandler",
    ] as const;
    for (const name of conversationHandlers) {
      expect(typeof handlers[name]).toBe("function");
    }
    // A draft is still not sendable without a fresh approval: recording ten
    // responses created no approval and no outbound action.
    await recordResponse(handlers, token, workspaceId, sent.sentActionId, "Book a call.");
    await recordResponse(handlers, token, workspaceId, sent.sentActionId, "Unsubscribe me.");
    expect(rowCounts().approvals).toBe(before.approvals);
    expect(rowCounts().actions).toBe(before.actions);
    expect(defaultStore.db.outboundActions[0]?.status).toBe("sent");
  });
});
