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
 * Phases 9–13 integration — one document, one decision, one effect, one response,
 * one booking.
 *
 * Phase 12 added the ability to *read* what came back, and Phase 13 adds the
 * ability to *book* what was read. Neither may change what the phases before them
 * guarantee, and that is exactly what this file proves: the same journey is
 * walked end to end, and then the seams are probed with the Phase 13 surface in
 * play.
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
} {
  const db = defaultStore.db;
  return {
    drafts: db.personalizedDrafts?.length ?? 0,
    approvals: db.approvalRequests?.length ?? 0,
    actions: db.outboundActions?.length ?? 0,
    claims: db.accountClaims?.length ?? 0,
    evidence: db.evidence?.length ?? 0,
  };
}

afterAll(() => {
  defaultStore.destroy();
});

describe("phases 9-14 integration — document, decision, effect, response, booking, next step", () => {
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
