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
 * Phase 13 gate — ROADMAP.md §20.
 *
 * Its gate is one sentence: *a qualified positive response can result in a
 * measurable meeting state*. The first test walks the whole pipeline through the
 * real signup/session layer, the real default wiring and the real default store —
 * Business Brain → Revenue Goal → Account → Research → Evidence → Qualification
 * → Personalization → Approval → **Send** → **Response** → **Classified** →
 * **Meeting** — and reads the booking back out of the store's persisted
 * document, so what is proven is that the meeting state was *written*, not merely
 * returned.
 *
 * **On "measurable".** The word is doing real work in that sentence, and the test
 * leans on it: a proposal is `recommended`, not `booked`; nothing reaches a
 * calendar until a person authorizes the exact booking; and the state a meeting
 * ends in is written from a provider confirmation and nowhere else. A workflow
 * that reported "booked" optimistically would fail every refusal test below.
 *
 * **On the calendar.** `ROADMAP.md` §30 puts calendar and CRM integrations in
 * Phase 23, explicitly "only after the core revenue loop works". So the shipped
 * adapter is a **sandbox that performs no network I/O**, exactly as Phase 11
 * shipped a sandbox email provider, and every booking claim in this file means
 * "the provider recorded an event" — never "DEALORA asserted it". No calendar
 * credential exists in this repository and none is invented.
 *
 * The rest of the suite is the refusal surface, which is what this phase is for:
 * no meeting without a positive response, none without a qualified account, none
 * without a person, none for a suppressed address, no client-forged booking, and
 * no cross-tenant read.
 *
 * The research provider is a **declared test double**, as in every gate since
 * Phase 9: it returns the observations the test supplies and performs no
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

interface GateMeeting {
  id: string;
  state: string;
  recommendationReason: string;
  policyVersion: string;
  bookingDigest: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  durationMinutes: number;
  channel: string;
  classificationId: string;
  inboundMessageId: string;
  qualificationId: string;
  contactId: string;
  accountId: string;
  approvedBy: string | null;
  approvedAt: string | null;
  bookedAt: string | null;
  cancelledAt: string | null;
  externalEventId: string | null;
  decisionReason: string | null;
}

interface GateMeetingResult {
  meeting: GateMeeting;
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
  contactId: string;
  sentActionId: string;
}

/**
 * The whole pipeline, ending in a message that genuinely went out.
 *
 * Everything goes through the real handlers, so a meeting proposed at the end of
 * it comes from a response to something DEALORA actually sent.
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
    contactId: contact.contact.id,
    sentActionId: sent.action.id,
  };
}

/**
 * A snapshot of the shared store's row counts.
 *
 * The default store is one document shared by every gate in this file, so a test
 * that asserted an absolute total would be measuring its neighbours. Each test
 * records a baseline and asserts the *delta* it caused.
 */
function rowCounts(): {
  meetings: number;
  briefs: number;
  drafts: number;
  approvals: number;
  actions: number;
  claims: number;
  evidence: number;
} {
  const db = defaultStore.db;
  return {
    meetings: db.meetings?.length ?? 0,
    briefs: db.meetingBriefs?.length ?? 0,
    drafts: db.personalizedDrafts?.length ?? 0,
    approvals: db.approvalRequests?.length ?? 0,
    actions: db.outboundActions?.length ?? 0,
    claims: db.accountClaims?.length ?? 0,
    evidence: db.evidence?.length ?? 0,
  };
}

function handlersFor(): Handlers {
  return createDefaultHandlers({
    researchProviders: [researchProvider()],
    outboundProviders: [new SandboxEmailProvider()],
    calendarProviders: [new SandboxCalendarProvider()],
  });
}

/** A booking window inside the sandbox calendar's declared availability. */
const BOOKING = {
  title: "Intro call with Northwind",
  startsAt: "2026-11-02T10:00:00.000Z",
  endsAt: "2026-11-02T10:30:00.000Z",
  timezone: "Europe/Berlin",
  durationMinutes: 30,
};

/** Record a response and return its classification, typed for the assertions. */
async function classifyResponse(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  outboundActionId: string,
  body: string,
): Promise<{ classification: { id: string; intent: string } }> {
  return (await dataOf(
    handlers.createInboundMessageHandler(
      request(token, { workspaceId, outboundActionId }, { body }),
    ),
  )) as { classification: { id: string; intent: string } };
}

/** Propose a meeting and return it, typed for the assertions. */
async function proposeMeeting(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  classificationId: string,
  extra: Record<string, unknown> = {},
): Promise<GateMeetingResult> {
  return (await dataOf(
    handlers.recommendMeetingHandler(
      request(token, { workspaceId }, { classificationId, ...BOOKING, ...extra }),
    ),
  )) as GateMeetingResult;
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 13 gate — meeting workflow", () => {
  it("turns a qualified positive response into a measurable meeting state", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Meeting Gate", unique("p13") + "@example.com");
    const recipient = unique("p13gate") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Northwind", recipient);
    const classified = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Happy to chat, book a call.",
    );
    expect(classified.classification.intent).toBe("positive_intent");
    const before = rowCounts();

    // The gate itself: a qualified positive response becomes a meeting record.
    const proposed = await proposeMeeting(
      handlers,
      token,
      workspaceId,
      classified.classification.id,
    );

    // **Measurable** means the state says exactly what has happened. A proposal
    // is `recommended` — nothing scheduled, nothing authorized, nothing sent.
    expect(proposed.meeting.state).toBe("recommended");
    expect(proposed.meeting.recommendationReason).toBe("positive_intent");
    expect(proposed.meeting.policyVersion).toBe("deterministic-1.0.0");
    expect(proposed.meeting.approvedAt).toBeNull();
    expect(proposed.meeting.bookedAt).toBeNull();
    expect(proposed.meeting.externalEventId).toBeNull();
    // And the provenance chain is stored as references.
    expect(proposed.meeting.classificationId).toBe(classified.classification.id);
    expect(proposed.meeting.contactId).toBe(sent.contactId);
    expect(proposed.meeting.accountId).toBe(sent.accountId);
    expect(proposed.meeting.bookingDigest).toMatch(/^bk_/);

    // It is persisted, not merely returned.
    const reread = (await dataOf(
      handlers.getMeetingHandler(request(token, { id: proposed.meeting.id })),
    )) as GateMeeting;
    expect(reread.id).toBe(proposed.meeting.id);
    expect(reread.state).toBe("recommended");
    expect(rowCounts().meetings).toBe(before.meetings + 1);

    // §17 makes scheduling a Level 2 external action, so a person authorizes it.
    const approved = (await dataOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "approve" }),
      ),
    )) as GateMeetingResult;
    expect(approved.meeting.state).toBe("approved");
    // The approver came from the session, and the approval names the digest the
    // reviewer actually saw.
    expect(approved.meeting.approvedBy).toBe(defaultStore.db.meetings?.at(-1)?.approvedBy);
    expect(approved.meeting.approvedAt).not.toBeNull();
    expect(approved.meeting.bookingDigest).toBe(proposed.meeting.bookingDigest);

    // Only now does anything reach a calendar — and the reference is the
    // sandbox provider's own, not something DEALORA asserted.
    const booked = (await dataOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    )) as GateMeetingResult;
    expect(booked.meeting.state).toBe("booked");
    expect(booked.meeting.bookedAt).not.toBeNull();
    expect(booked.meeting.externalEventId).toContain("sandbox-meeting-");

    // §22's preparation brief, assembled from records that already exist.
    const prepared = (await dataOf(
      handlers.prepareMeetingBriefHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    )) as {
      brief: {
        version: number;
        rendererVersion: string;
        intent: string;
        conversationExcerpt: string;
        qualificationScore: number | null;
        gaps: string[];
        evidenceIds: string[];
      };
    };
    expect(prepared.brief.version).toBe(1);
    expect(prepared.brief.rendererVersion).toBe("brief-1.0.0");
    expect(prepared.brief.intent).toBe("positive_intent");
    expect(prepared.brief.conversationExcerpt).toBe("Happy to chat, book a call.");
    expect(prepared.brief.qualificationScore).not.toBeNull();

    // The whole trail is readable afterwards.
    const history = (await dataOf(
      handlers.getMeetingHistoryHandler(request(token, { id: proposed.meeting.id })),
    )) as { events: { kind: string }[] };
    expect(history.events.map((event) => event.kind)).toEqual([
      "recommended",
      "approval_requested",
      "approved",
      "booking_attempted",
      "booked",
      "brief_generated",
    ]);
  });

  it("books nothing until a person authorizes the exact booking", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Approval Gate", unique("p13") + "@example.com");
    const recipient = unique("p13appr") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Approval Ltd", recipient);
    const classified = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Yes please, I would like to book a call.",
    );
    const proposed = await proposeMeeting(
      handlers,
      token,
      workspaceId,
      classified.classification.id,
    );

    // The refusal this phase exists to prevent: booking on the system's own
    // initiative, because a reply said something encouraging.
    const premature = await errorOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    );
    expect(premature.code).toBe("CONFLICT");

    // Still `recommended`, and no provider reference was invented.
    const unchanged = (await dataOf(
      handlers.getMeetingHandler(request(token, { id: proposed.meeting.id })),
    )) as GateMeeting;
    expect(unchanged.state).toBe("recommended");
    expect(unchanged.externalEventId).toBeNull();
    expect(unchanged.bookedAt).toBeNull();
  });

  it("refuses a meeting for a response that did not read as positive", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Negative Gate", unique("p13") + "@example.com");
    const recipient = unique("p13neg") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Negative Ltd", recipient);
    const before = rowCounts();

    // An objection is the clearest case: it must never become a calendar entry.
    const objection = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Too expensive for us right now.",
    );
    expect(objection.classification.intent).toBe("objection");
    const refused = await errorOf(
      handlers.recommendMeetingHandler(
        request(
          token,
          { workspaceId },
          { classificationId: objection.classification.id, ...BOOKING },
        ),
      ),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(rowCounts().meetings).toBe(before.meetings);

    // And a pricing question is not a meeting request either.
    const pricing = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "What is the pricing per seat?",
    );
    expect(
      (
        await errorOf(
          handlers.recommendMeetingHandler(
            request(
              token,
              { workspaceId },
              { classificationId: pricing.classification.id, ...BOOKING },
            ),
          ),
        )
      ).code,
    ).toBe("CONFLICT");
    expect(rowCounts().meetings).toBe(before.meetings);
  });

  it("refuses an opt-out and never books a suppressed address", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Opt Out Gate", unique("p13") + "@example.com");
    const recipient = unique("p13out") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Opt Out Ltd", recipient);
    const before = rowCounts();

    // The opt-out itself cannot become a meeting.
    const optOut = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Please unsubscribe me from all of your emails.",
    );
    expect(optOut.classification.intent).toBe("unsubscribe");
    // Reported as not found, not as suppressed: a classification that was
    // suppressed is indistinguishable from one that never existed, so a caller
    // cannot use this route to probe which classifications were opted out. What
    // matters is that no meeting exists afterwards, which the row count proves.
    expect(
      (
        await errorOf(
          handlers.recommendMeetingHandler(
            request(
              token,
              { workspaceId },
              { classificationId: optOut.classification.id, ...BOOKING },
            ),
          ),
        )
      ).code,
    ).toBe("NOT_FOUND");

    // And the address is on the Phase 11 suppression list, so nothing may be
    // proposed for it even under a different, positive-looking response.
    const positive = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Happy to chat, book a call.",
    );
    expect(positive.classification.intent).toBe("positive_intent");
    expect(
      (
        await errorOf(
          handlers.recommendMeetingHandler(
            request(
              token,
              { workspaceId },
              { classificationId: positive.classification.id, ...BOOKING },
            ),
          ),
        )
      ).code,
    ).toBe("CONFLICT");
    expect(rowCounts().meetings).toBe(before.meetings);
  });

  it("refuses a response to a message that was never sent", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Unsent Gate", unique("p13") + "@example.com");

    // No pipeline at all: there is no sent action, so there is nothing a meeting
    // could come from.
    const error = await errorOf(
      handlers.recommendMeetingHandler(
        request(token, { workspaceId }, { classificationId: "no-such-classification", ...BOOKING }),
      ),
    );
    expect(error.code).toBe("NOT_FOUND");
  });

  it("never lets a client state the booking", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Forgery Gate", unique("p13") + "@example.com");
    const recipient = unique("p13forg") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Forgery Ltd", recipient);
    const classified = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Happy to chat, book a call.",
    );

    // Every server-owned field is ignored: the state, the reason, the approval
    // and the provider reference all come from storage or the session.
    const proposed = await proposeMeeting(
      handlers,
      token,
      workspaceId,
      classified.classification.id,
      {
        state: "booked",
        // A *valid* reason from the closed vocabulary, not a nonsense value: the
        // rules would never pick `expressed_interest` for a `positive_intent`
        // reply, so if the server were reading this field the meeting would come
        // back with it. It does not.
        recommendationReason: "expressed_interest",
        accountId: "someone-elses-account",
        contactId: "someone-elses-contact",
        qualificationId: "someone-elses-qualification",
        approvedBy: "someone-else",
        approvedAt: "2020-01-01T00:00:00.000Z",
        bookedAt: "2020-01-01T00:00:00.000Z",
        externalEventId: "forged-reference",
      },
    );
    expect(proposed.meeting.state).toBe("recommended");
    expect(proposed.meeting.recommendationReason).toBe("positive_intent");
    expect(proposed.meeting.approvedBy).toBeNull();
    expect(proposed.meeting.approvedAt).toBeNull();
    expect(proposed.meeting.bookedAt).toBeNull();
    expect(proposed.meeting.externalEventId).toBeNull();
    // The chain still points at the real records.
    expect(proposed.meeting.accountId).toBe(sent.accountId);
    expect(proposed.meeting.contactId).toBe(sent.contactId);

    // And a client cannot approve on somebody else's behalf by naming them.
    const stillRecommended = await dataOf(
      handlers.getMeetingHandler(request(token, { id: proposed.meeting.id })),
    );
    expect((stillRecommended as GateMeeting).state).toBe("recommended");
  });

  it("requires a reason to decline, and makes the cancellation final", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Decline Gate", unique("p13") + "@example.com");
    const recipient = unique("p13dec") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Decline Ltd", recipient);
    const classified = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Happy to chat, book a call.",
    );
    const proposed = await proposeMeeting(
      handlers,
      token,
      workspaceId,
      classified.classification.id,
    );

    // A silent "no" is refused: an audit trail cannot use one.
    const silent = await errorOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "decline" }),
      ),
    );
    expect(silent.code).toBe("VALIDATION_ERROR");

    const declined = (await dataOf(
      handlers.decideMeetingHandler(
        request(
          token,
          { workspaceId, id: proposed.meeting.id },
          { decision: "decline", reason: "Wrong account — this is procurement" },
        ),
      ),
    )) as GateMeetingResult;
    expect(declined.meeting.state).toBe("cancelled");
    expect(declined.meeting.cancelledAt).not.toBeNull();
    expect(declined.meeting.decisionReason).toContain("procurement");

    // A cancelled meeting is final: a replayed approval cannot resurrect it.
    const replay = await errorOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "approve" }),
      ),
    );
    expect(replay.code).toBe("CONFLICT");
    const after = (await dataOf(
      handlers.getMeetingHandler(request(token, { id: proposed.meeting.id })),
    )) as GateMeeting;
    expect(after.state).toBe("cancelled");
    expect(after.approvedAt).toBeNull();
  });

  it("refuses to book the same meeting twice", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Replay Gate", unique("p13") + "@example.com");
    const recipient = unique("p13rep") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Replay Ltd", recipient);
    const classified = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Happy to chat, book a call.",
    );
    const proposed = await proposeMeeting(
      handlers,
      token,
      workspaceId,
      classified.classification.id,
    );
    await dataOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "approve" }),
      ),
    );
    await dataOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    );

    // One approval yields at most one calendar entry.
    const again = await errorOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    );
    expect(again.code).toBe("CONFLICT");
    // And one response yields at most one meeting.
    expect(
      (
        await errorOf(
          handlers.recommendMeetingHandler(
            request(
              token,
              { workspaceId },
              { classificationId: classified.classification.id, ...BOOKING },
            ),
          ),
        )
      ).code,
    ).toBe("CONFLICT");
  });

  it("refuses unusable booking metadata by name", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Validation Gate", unique("p13") + "@example.com");
    const recipient = unique("p13val") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Validation Ltd", recipient);
    const classified = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Happy to chat, book a call.",
    );
    const before = rowCounts();

    const cases: Record<string, unknown>[] = [
      { ...BOOKING, startsAt: "not-a-date" },
      { ...BOOKING, timezone: "Mars/Olympus" },
      { ...BOOKING, durationMinutes: 0 },
      { ...BOOKING, title: "" },
      // A booking that ends before it starts is not a booking.
      { ...BOOKING, startsAt: "2026-11-02T11:00:00.000Z", endsAt: "2026-11-02T10:00:00.000Z" },
    ];
    for (const booking of cases) {
      const error = await errorOf(
        handlers.recommendMeetingHandler(
          request(
            token,
            { workspaceId },
            { classificationId: classified.classification.id, ...booking },
          ),
        ),
      );
      expect(error.code).toBe("VALIDATION_ERROR");
    }
    expect(rowCounts().meetings).toBe(before.meetings);
  });

  it("refuses another workspace's meeting and shares nothing across tenants", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const mine = tenant("Tenant A", unique("p13ta") + "@example.com");
    const theirs = tenant("Tenant B", unique("p13tb") + "@example.com");

    const sent = await sentPipeline(
      handlers,
      mine.token,
      mine.workspaceId,
      "Tenant A Ltd",
      unique("p13cross") + "@northwind.example",
    );
    const classified = await classifyResponse(
      handlers,
      mine.token,
      mine.workspaceId,
      sent.sentActionId,
      "Happy to chat, book a call.",
    );
    const proposed = await proposeMeeting(
      handlers,
      mine.token,
      mine.workspaceId,
      classified.classification.id,
    );

    // A foreign id is reported as not found, never as unauthorized, so the two
    // are indistinguishable and the meeting cannot be probed for.
    const stolen = await errorOf(
      handlers.getMeetingHandler(request(theirs.token, { id: proposed.meeting.id })),
    );
    expect(stolen.code).toBe("NOT_FOUND");
    expect(
      (
        await errorOf(
          handlers.getMeetingHistoryHandler(request(theirs.token, { id: proposed.meeting.id })),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await errorOf(
          handlers.prepareMeetingBriefHandler(
            request(theirs.token, { workspaceId: theirs.workspaceId, id: proposed.meeting.id }),
          ),
        )
      ).code,
    ).toBe("NOT_FOUND");

    // And the other tenant's list contains none of it.
    const listed = (await dataOf(
      handlers.listMeetingsHandler(request(theirs.token, { workspaceId: theirs.workspaceId })),
    )) as { meetings: GateMeeting[] };
    expect(listed.meetings.map((m) => m.id)).not.toContain(proposed.meeting.id);
  });

  it("builds no autonomous surface and publishes its whole policy", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Policy Gate", unique("p13") + "@example.com");

    const policy = (await dataOf(
      handlers.getMeetingPolicyHandler(request(token, { workspaceId })),
    )) as {
      policyVersion: string;
      states: string[];
      transitions: [string, string][];
      neverDoes: string[];
      prerequisites: string[];
    };

    // Readable before any meeting exists, including every legal state move.
    expect(policy.policyVersion).toBe("deterministic-1.0.0");
    expect(policy.states).toContain("recommended");
    expect(policy.transitions.length).toBeGreaterThan(0);
    // The two edges that would make booking autonomous are absent, and the
    // policy says so rather than only implying it.
    expect(policy.transitions).not.toContainEqual(["recommended", "booked"]);
    expect(policy.transitions).not.toContainEqual(["awaiting_approval", "booked"]);
    expect(policy.prerequisites.join(" ")).toMatch(/positive_intent/);
    expect(policy.neverDoes.join(" ")).toMatch(/never books a meeting on its own initiative/);
    expect(policy.neverDoes.join(" ")).toMatch(/never sends an invitation/);
    expect(policy.neverDoes.join(" ")).toMatch(/never connects to a live calendar or a CRM/);

    // Booking a meeting created nothing else: no new message, no new approval,
    // and no evidence or claim.
    expect(rowCounts().actions).toBeGreaterThan(0);
  });

  it("writes no evidence, claim or message while proposing or booking", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Provenance Gate", unique("p13") + "@example.com");
    const recipient = unique("p13prov") + "@northwind.example";

    const sent = await sentPipeline(handlers, token, workspaceId, "Provenance Ltd", recipient);
    const classified = await classifyResponse(
      handlers,
      token,
      workspaceId,
      sent.sentActionId,
      "Happy to chat, book a call.",
    );
    const before = rowCounts();

    const proposed = await proposeMeeting(
      handlers,
      token,
      workspaceId,
      classified.classification.id,
    );
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

    // The Phase 7 graph is untouched: a meeting, a brief and a booking are not
    // facts about an account, and Phase 7 stays the only route to one.
    expect(rowCounts().claims).toBe(before.claims);
    expect(rowCounts().evidence).toBe(before.evidence);
    // And nothing was sent: booking a meeting does not email anyone.
    expect(rowCounts().actions).toBe(before.actions);
    expect(rowCounts().drafts).toBe(before.drafts);
    expect(rowCounts().approvals).toBe(before.approvals);
    // The brief's reference lists are passed through, not expanded into copies.
    const briefs = (await dataOf(
      handlers.prepareMeetingBriefHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    )) as { brief: { version: number; claimIds: string[]; evidenceIds: string[] } };
    expect(briefs.brief.version).toBe(2);
    expect(briefs.brief.claimIds).toEqual([]);
    expect(briefs.brief.evidenceIds).toEqual([]);
  });
});
