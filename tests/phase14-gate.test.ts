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
 * Phase 14 gate — ROADMAP.md §21.
 *
 * Its gate is one sentence: *users can see the next recommended action for
 * meaningful revenue states*. The first test therefore does not merely ask once —
 * it walks one account through the whole revenue loop and reads the
 * recommendation **at every stage**, so what is proven is that the answer tracks
 * what actually happened: research → evidence → qualification → draft → approval
 * → send → response → meeting. A recommendation that stayed the same through all
 * of that would be a slogan, not an engine.
 *
 * **`ROADMAP.md` §21's seven required fields** — action, reason, supporting state,
 * evidence, confidence, expected outcome and approval requirement — are asserted on
 * *every* stage, not once at the end, because a field that appears only when it
 * is convenient is not a contract.
 *
 * **On "93%".** `DEALORA_BLUEPRINT.md` §25's example prints a confidence
 * percentage. This repository already decided in ADR 0009 that confidence is the
 * weakest **band** among the records that produced it, because there is no
 * calibration data here from which a number could mean anything. The gate
 * asserts the band, and asserts that no percentage is ever emitted — a fabricated
 * number would look more precise and mean less.
 *
 * **On acting.** Nothing in this phase acts. The gate proves it by snapshotting
 * every row count before and after recording a "send this now" recommendation:
 * a recommendation naming a Level 2 external action adds exactly one advice row
 * and touches no draft, approval, outbound action, meeting or evidence record.
 *
 * The rest of the suite is the refusal surface: no recommendation for a
 * suppressed address, no client-dictated action or approval flag, no cross-tenant
 * read, no autonomous surface, and a published policy that states the whole rule
 * set before any account exists.
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

interface GateRecommendation {
  accountId: string;
  accountName: string;
  action: string;
  supportingState: string;
  reason: string;
  confidenceReasons: string[];
  confidence: string;
  riskLevel: string;
  approvalRequired: boolean;
  expectedOutcome: string;
  evidenceIds: string[];
  claimIds: string[];
  ruleVersion: string;
}

interface GateStoredRecommendation extends GateRecommendation {
  id: string;
  workspaceId: string;
  createdBy: string;
  createdAt: string;
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

function handlersFor(): ReturnType<typeof createDefaultHandlers> {
  return createDefaultHandlers({
    researchProviders: [researchProvider()],
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
}

/**
 * Create an account with its Business Brain and goal, and nothing else.
 *
 * This is the very start of the revenue loop, and it is the state the gate walks
 * *up* from: at this point the account has no research, no evidence, no
 * evaluation, no draft, no approval and no message.
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
        { firstName: "Ada", lastName: "Lovelace", jobTitle: "VP Support", email: recipientEmail },
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
async function research(handlers: Handlers, token: string, workspaceId: string, accountId: string) {
  const created = (await dataOf(
    handlers.createResearchRequestHandler(
      request(
        token,
        { workspaceId, accountId },
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
    handlers.runResearchRequestHandler(request(token, { id: created.request.id })),
  )) as { request: { status: string }; findings: { id: string }[] };
  expect(run.request.status).toBe("completed");
  return run.findings;
}

/** A snapshot of the shared store's row counts. */
function rowCounts(): {
  recommendations: number;
  meetings: number;
  drafts: number;
  approvals: number;
  actions: number;
  claims: number;
  evidence: number;
  classifications: number;
} {
  const db = defaultStore.db;
  return {
    recommendations: db.nextBestActions?.length ?? 0,
    meetings: db.meetings?.length ?? 0,
    drafts: db.personalizedDrafts?.length ?? 0,
    approvals: db.approvalRequests?.length ?? 0,
    actions: db.outboundActions?.length ?? 0,
    claims: db.accountClaims?.length ?? 0,
    evidence: db.evidence?.length ?? 0,
    classifications: db.conversationClassifications?.length ?? 0,
  };
}

/** Ask what should happen next for one account, typed for the assertions. */
async function nextFor(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  accountId: string,
): Promise<GateRecommendation> {
  return (await dataOf(
    handlers.recommendNextActionHandler(request(token, { workspaceId }, { accountId })),
  )) as GateRecommendation;
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 14 gate — next best action", () => {
  it("shows the next recommended action at every stage of the revenue loop", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Next Action Gate", unique("p14") + "@example.com");
    const recipient = unique("p14gate") + "@northwind.example";
    const world = await bareAccount(handlers, token, workspaceId, "Northwind", recipient);

    /**
     * Every recommendation carries all seven of §21's required fields.
     *
     * Asserted on every stage rather than once at the end, because a field that
     * turns up only when it is convenient is not a contract.
     */
    const expectComplete = (recommendation: GateRecommendation): void => {
      expect(recommendation.action.length).toBeGreaterThan(0);
      expect(recommendation.reason.length).toBeGreaterThan(0);
      expect(recommendation.supportingState.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(recommendation.confidence);
      expect(recommendation.expectedOutcome.length).toBeGreaterThan(0);
      expect(typeof recommendation.approvalRequired).toBe("boolean");
      expect(Array.isArray(recommendation.evidenceIds)).toBe(true);
      expect(Array.isArray(recommendation.claimIds)).toBe(true);
      expect(recommendation.ruleVersion).toBe("next-action-1.0.0");
      expect(recommendation.accountId).toBe(world.accountId);
      // The blueprint prints 93%; this engine emits a band and never a number.
      expect(recommendation.confidence).toMatch(/^(low|medium|high)$/);
    };

    // --- Nothing has happened yet: research is the honest first step ---------
    let recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("no_research");
    expect(recommendation.action).toBe("research_account");
    expect(recommendation.approvalRequired).toBe(false);
    expect(recommendation.evidenceIds).toEqual([]);
    expect(recommendation.reason).toContain("research request");

    // --- Findings exist; Phase 7 conversion is what makes them usable --------
    const findings = await research(handlers, token, workspaceId, world.accountId);
    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("researched_without_evidence");
    expect(recommendation.action).toBe("convert_findings_to_evidence");
    // A conversion produces a claim, not an outbound message: still no approval.
    expect(recommendation.riskLevel).toBe("level_1_draft");
    expect(recommendation.approvalRequired).toBe(false);

    // --- Evidence exists; the account has never been evaluated --------------
    for (const finding of findings) {
      await dataOf(
        handlers.createEvidenceFromFindingHandler(
          request(token, { workspaceId, researchFindingId: finding.id }),
        ),
      );
    }
    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("evidenced_without_qualification");
    expect(recommendation.action).toBe("qualify_account");
    // Qualifying is a read. It reaches nobody.
    expect(recommendation.riskLevel).toBe("level_0_read");
    expect(recommendation.approvalRequired).toBe(false);
    // It now cites the live evidence rather than a copy of it.
    expect(recommendation.evidenceIds.length).toBeGreaterThan(0);
    expect(recommendation.claimIds.length).toBeGreaterThan(0);

    // --- A qualified account wants outreach ---------------------------------
    const qualification = (await dataOf(
      handlers.createQualificationHandler(
        request(
          token,
          { workspaceId, accountId: world.accountId },
          { revenueGoalId: world.goalId },
        ),
      ),
    )) as {
      qualification: { id: string; state: string; score: number | null };
    };
    expect(qualification.qualification.state).toBe("qualified");

    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("qualified_without_draft");
    expect(recommendation.action).toBe("personalize_outreach");
    // §17 calls a draft message a Level 1 action, which runs automatically.
    expect(recommendation.riskLevel).toBe("level_1_draft");
    expect(recommendation.reason).toContain("qualified");

    // --- A draft exists; a person has to look at it before anything sends ---
    const generated = (await dataOf(
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
    )) as { draft: { id: string; version: number } };

    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("drafted_without_approval");
    expect(recommendation.action).toBe("request_approval");

    // --- An approval is pending: DEALORA does not answer it for them --------
    const requested = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: generated.draft.id }, {}),
      ),
    )) as { approval: { id: string } };

    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("approval_pending");
    expect(recommendation.action).toBe("hold");
    expect(recommendation.approvalRequired).toBe(false);
    expect(recommendation.reason).toContain("reviewer");

    // --- Approved but unsent: the recommendation names a Level 2 action ----
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
      ),
    );
    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("approved_without_send");
    expect(recommendation.action).toBe("send_approved_message");
    // §17: sending a message is a Level 2 external action, so the row says a
    // person is required — and DEALORA still does not send it itself.
    expect(recommendation.riskLevel).toBe("level_2_external_action");
    expect(recommendation.approvalRequired).toBe(true);
    expect(recommendation.expectedOutcome).toBe("message_delivered");

    // --- The message actually goes out, and DEALORA waits -------------------
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: generated.draft.id }, {}),
      ),
    )) as { action: { id: string } };
    const sent = (await dataOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    )) as { action: { status: string } };
    expect(sent.action.status).toBe("sent");

    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("awaiting_response");
    expect(recommendation.action).toBe("hold");

    // --- A positive reply is the strongest signal in the system -------------
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

    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("positive_response_without_meeting");
    expect(recommendation.action).toBe("propose_meeting");
    expect(recommendation.expectedOutcome).toBe("meeting_proposed");
    // Proposing touches no calendar, so it is a draft, not an external action.
    expect(recommendation.riskLevel).toBe("level_1_draft");
    expect(recommendation.approvalRequired).toBe(false);
    // The reason names the two stored facts that produced it.
    expect(recommendation.reason).toContain("positive_intent");
    expect(recommendation.confidenceReasons.join(" ")).toContain("confidence");

    // --- A person already proposed a meeting: DEALORA does not pile on -------
    const proposed = (await dataOf(
      handlers.recommendMeetingHandler(
        request(
          token,
          { workspaceId },
          { classificationId: classified.classification.id, ...BOOKING },
        ),
      ),
    )) as { meeting: { id: string; state: string } };
    expect(proposed.meeting.state).toBe("recommended");

    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("meeting_recommended");
    expect(recommendation.action).toBe("hold");

    // --- Once a person approves the booking, booking is the next step -------
    await dataOf(
      handlers.decideMeetingHandler(
        request(token, { workspaceId, id: proposed.meeting.id }, { decision: "approve" }),
      ),
    );
    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("meeting_approved");
    expect(recommendation.action).toBe("book_meeting");
    // Scheduling an event is §17's other Level 2 example.
    expect(recommendation.riskLevel).toBe("level_2_external_action");
    expect(recommendation.approvalRequired).toBe(true);
    expect(recommendation.expectedOutcome).toBe("meeting_booked");

    // --- Booked and still unbriefed: §22's brief is the remaining step ------
    await dataOf(
      handlers.bookMeetingHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    );
    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("meeting_booked_without_brief");
    expect(recommendation.action).toBe("prepare_meeting_brief");
    expect(recommendation.approvalRequired).toBe(false);

    // --- Briefed: every step DEALORA can take has been taken -----------------
    await dataOf(
      handlers.prepareMeetingBriefHandler(request(token, { workspaceId, id: proposed.meeting.id })),
    );
    recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expectComplete(recommendation);
    expect(recommendation.supportingState).toBe("meeting_booked");
    expect(recommendation.action).toBe("hold");
  });

  it("answers for a whole workspace at once, not one account at a time", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Board Gate", unique("p14board") + "@example.com");

    const bare = await bareAccount(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p14board") + "@northwind.example",
    );
    const researched = await bareAccount(
      handlers,
      token,
      workspaceId,
      "Contoso",
      unique("p14board") + "@contoso.example",
    );
    await research(handlers, token, workspaceId, researched.accountId);

    const board = (await dataOf(
      handlers.recommendWorkspaceActionsHandler(request(token, { workspaceId })),
    )) as { ruleVersion: string; recommendations: GateRecommendation[] };

    expect(board.ruleVersion).toBe("next-action-1.0.0");
    expect(board.recommendations).toHaveLength(2);
    const byAccount = new Map(board.recommendations.map((r) => [r.accountId, r]));
    expect(byAccount.get(bare.accountId)?.action).toBe("research_account");
    expect(byAccount.get(researched.accountId)?.action).toBe("convert_findings_to_evidence");
    for (const recommendation of board.recommendations) {
      expect(recommendation.reason.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(recommendation.confidence);
    }
  });

  it("recommends nothing but stopping for an address that asked to stop", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Opt-Out Gate", unique("p14stop") + "@example.com");
    const world = await bareAccount(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p14stop") + "@northwind.example",
    );
    const findings = await research(handlers, token, workspaceId, world.accountId);
    for (const finding of findings) {
      await dataOf(
        handlers.createEvidenceFromFindingHandler(
          request(token, { workspaceId, researchFindingId: finding.id }),
        ),
      );
    }

    // Drive it all the way to a message that genuinely went out.
    const qualification = (await dataOf(
      handlers.createQualificationHandler(
        request(
          token,
          { workspaceId, accountId: world.accountId },
          { revenueGoalId: world.goalId },
        ),
      ),
    )) as { qualification: { id: string } };
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

    // The prospect opts out. Safety outranks every other consideration about this
    // account, however attractive it looked a minute ago.
    const opted = (await dataOf(
      handlers.createInboundMessageHandler(
        request(
          token,
          { workspaceId, outboundActionId: staged.action.id },
          { body: "Please stop emailing me. Unsubscribe." },
        ),
      ),
    )) as { classification: { id: string; intent: string; suppressed: boolean } };
    expect(opted.classification.intent).toBe("unsubscribe");
    expect(opted.classification.suppressed).toBe(true);

    const recommendation = await nextFor(handlers, token, workspaceId, world.accountId);
    expect(recommendation.supportingState).toBe("suppressed");
    expect(recommendation.action).toBe("stop_contacting");
    expect(recommendation.reason).toContain("opt-out list");
    // Stopping is advice *not* to act, so it needs no approval of its own.
    expect(recommendation.riskLevel).toBe("level_0_read");
    expect(recommendation.approvalRequired).toBe(false);

    // And it stays that way through the whole board, not just this account.
    const board = (await dataOf(
      handlers.recommendWorkspaceActionsHandler(request(token, { workspaceId })),
    )) as { recommendations: GateRecommendation[] };
    expect(board.recommendations).toHaveLength(1);
    expect(board.recommendations[0]?.action).toBe("stop_contacting");
  });

  it("never lets a client state the recommendation, the risk or the approval", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Forgery Gate", unique("p14forge") + "@example.com");
    const world = await bareAccount(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p14forge") + "@northwind.example",
    );

    // A caller tries to name its own advice: "approve and send this now".
    const forged = await nextFor(handlers, token, workspaceId, world.accountId);
    expect(forged.action).toBe("research_account");
    expect(forged.riskLevel).toBe("level_0_read");
    expect(forged.approvalRequired).toBe(false);

    const viaBody = (await dataOf(
      handlers.recommendNextActionHandler(
        request(
          token,
          { workspaceId },
          {
            accountId: world.accountId,
            action: "send_approved_message",
            riskLevel: "level_0_read",
            approvalRequired: false,
            expectedOutcome: "message_delivered",
            confidence: "high",
            reason: "I am sure this is right",
            evidenceIds: ["ev-forged"],
            claimIds: ["cl-forged"],
          },
        ),
      ),
    )) as GateRecommendation;
    expect(viaBody).toEqual(forged);
    expect(viaBody.reason).not.toContain("I am sure this is right");
    expect(viaBody.evidenceIds).toEqual([]);

    // The same is true of the recording route: the row carries what the engine
    // derived, not what the body claimed.
    const recorded = (await dataOf(
      handlers.recordNextActionHandler(
        request(
          token,
          { workspaceId },
          {
            accountId: world.accountId,
            action: "send_approved_message",
            approvalRequired: false,
          },
        ),
      ),
    )) as GateStoredRecommendation;
    expect(recorded.action).toBe("research_account");
    expect(recorded.approvalRequired).toBe(false);
    expect(recorded.createdBy).not.toBe("");
  });

  it("writes one advice row and touches nothing else, even for a Level 2 action", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant(
      "No-Side-Effect Gate",
      unique("p14pure") + "@example.com",
    );
    const world = await bareAccount(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p14pure") + "@northwind.example",
    );
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

    // DEALORA is now recommending "send this approved message" — a Level 2
    // external action. Recording that recommendation must still send nothing.
    const before = rowCounts();
    const recommendation = (await dataOf(
      handlers.recordNextActionHandler(
        request(token, { workspaceId }, { accountId: world.accountId }),
      ),
    )) as GateStoredRecommendation;
    expect(recommendation.action).toBe("send_approved_message");
    expect(recommendation.approvalRequired).toBe(true);

    const after = rowCounts();
    // Exactly one new row, and it is the advice row.
    expect(after.recommendations).toBe(before.recommendations + 1);
    // No send, no new draft version, no new approval, no meeting, and — the
    // honesty check — no evidence or claim written by the recommendation engine.
    expect(after.actions).toBe(before.actions);
    expect(after.drafts).toBe(before.drafts);
    expect(after.approvals).toBe(before.approvals);
    expect(after.meetings).toBe(before.meetings);
    expect(after.claims).toBe(before.claims);
    expect(after.evidence).toBe(before.evidence);
    expect(after.classifications).toBe(before.classifications);

    // It is persisted, and readable back, with its reasons intact.
    const reread = (await dataOf(
      handlers.getNextActionHandler(request(token, { id: recommendation.id })),
    )) as GateStoredRecommendation;
    expect(reread.id).toBe(recommendation.id);
    expect(reread.reason).toBe(recommendation.reason);
    expect(reread.ruleVersion).toBe("next-action-1.0.0");
    expect(reread.createdBy).toBe(defaultStore.db.nextBestActions?.at(-1)?.createdBy);
  });

  it("refuses an account that does not exist, and requires a real accountId", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Validation Gate", unique("p14val") + "@example.com");

    const missing = await errorOf(
      handlers.recommendNextActionHandler(
        request(token, { workspaceId }, { accountId: "acct-nope" }),
      ),
    );
    expect(missing.code).toBe("NOT_FOUND");

    for (const accountId of [undefined, null, "", "   ", 7, {}]) {
      const invalid = await errorOf(
        handlers.recommendNextActionHandler(request(token, { workspaceId }, { accountId })),
      );
      expect(invalid.code).toBe("VALIDATION_ERROR");
    }

    const anonymous = await errorOf(
      handlers.recommendNextActionHandler({
        body: { accountId: "acct-1" },
        query: {},
        params: { workspaceId },
      }),
    );
    expect(anonymous.code).toBe("UNAUTHENTICATED");
  });

  it("shares nothing across tenants", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const mine = tenant("Mine", unique("p14mine") + "@example.com");
    const theirs = tenant("Theirs", unique("p14theirs") + "@example.com");

    const myAccount = await bareAccount(
      handlers,
      mine.token,
      mine.workspaceId,
      "Northwind",
      unique("p14mine") + "@northwind.example",
    );
    const theirAccount = await bareAccount(
      handlers,
      theirs.token,
      theirs.workspaceId,
      "Contoso",
      unique("p14theirs") + "@contoso.example",
    );

    const myRecommendation = (await dataOf(
      handlers.recordNextActionHandler(
        request(mine.token, { workspaceId: mine.workspaceId }, { accountId: myAccount.accountId }),
      ),
    )) as GateStoredRecommendation;

    // Naming another tenant's account is not a way to read it.
    const crossed = await errorOf(
      handlers.recommendNextActionHandler(
        request(
          mine.token,
          { workspaceId: mine.workspaceId },
          { accountId: theirAccount.accountId },
        ),
      ),
    );
    expect(crossed.code).toBe("NOT_FOUND");

    // Nor is naming their recommendation id.
    const theirRead = await errorOf(
      handlers.getNextActionHandler(request(theirs.token, { id: myRecommendation.id })),
    );
    expect(theirRead.code).toBe("NOT_FOUND");

    // Their board shows only their own account.
    const theirBoard = (await dataOf(
      handlers.recommendWorkspaceActionsHandler(
        request(theirs.token, { workspaceId: theirs.workspaceId }),
      ),
    )) as { recommendations: GateRecommendation[] };
    expect(theirBoard.recommendations.map((r) => r.accountId)).toEqual([theirAccount.accountId]);

    // And their history is empty.
    const theirList = (await dataOf(
      handlers.listNextActionsHandler(request(theirs.token, { workspaceId: theirs.workspaceId })),
    )) as { recommendations: GateStoredRecommendation[] };
    expect(theirList.recommendations).toEqual([]);
  });

  it("refuses a filter naming an action this engine cannot produce", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Filter Gate", unique("p14filter") + "@example.com");

    const unknown = await errorOf(
      handlers.listNextActionsHandler(
        request(token, { workspaceId }, undefined, { action: "escalate_to_manager" }),
      ),
    );
    expect(unknown.code).toBe("VALIDATION_ERROR");

    // A kind this engine does produce is accepted, even with nothing recorded.
    const known = (await dataOf(
      handlers.listNextActionsHandler(
        request(token, { workspaceId }, undefined, { action: "research_account" }),
      ),
    )) as { recommendations: GateStoredRecommendation[] };
    expect(known.recommendations).toEqual([]);
  });

  it("builds no autonomous surface and publishes its whole policy", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Policy Gate", unique("p14pol") + "@example.com");

    const policy = (await dataOf(
      handlers.getNextActionPolicyHandler(request(token, { workspaceId })),
    )) as {
      ruleVersion: string;
      states: string[];
      actions: string[];
      riskLevels: string[];
      confidenceBands: string[];
      rules: {
        supportingState: string;
        action: string;
        riskLevel: string;
        approvalRequired: boolean;
      }[];
      prerequisites: string[];
      neverDoes: string[];
    };

    // The whole rule set is readable before the workspace has a single account.
    expect(policy.ruleVersion).toBe("next-action-1.0.0");
    expect(policy.states.length).toBe(policy.rules.length);
    expect(policy.states.length).toBeGreaterThan(0);
    expect(policy.confidenceBands).toEqual(["low", "medium", "high"]);

    // Every published state produces a published action, and vice versa — no
    // vocabulary the engine cannot produce.
    for (const rule of policy.rules) {
      expect(policy.actions).toContain(rule.action);
      expect(policy.states).toContain(rule.supportingState);
    }
    for (const action of policy.actions) {
      expect(policy.rules.some((rule) => rule.action === action)).toBe(true);
    }

    // §17's Level 3 is absent: nothing here recommends a financial, contractual or
    // irreversible action, so advertising one would be a capability that does not
    // exist.
    expect(policy.riskLevels).toEqual(["level_0_read", "level_1_draft", "level_2_external_action"]);
    expect(policy.rules.some((rule) => rule.riskLevel === "level_3_high_impact")).toBe(false);

    // Approval is required for exactly the Level 2 external actions.
    for (const rule of policy.rules) {
      expect(rule.approvalRequired).toBe(rule.riskLevel === "level_2_external_action");
    }
    expect(
      policy.rules
        .filter((rule) => rule.approvalRequired)
        .map((rule) => rule.action)
        .sort(),
    ).toEqual(["book_meeting", "send_approved_message"]);

    // The refusals are stated, including the two that matter most.
    expect(policy.neverDoes.join(" ")).toContain("never acts on a recommendation");
    expect(policy.neverDoes.join(" ")).toContain("confidence percentage");
    expect(policy.prerequisites.length).toBeGreaterThan(0);

    // None of **this phase's** routes sends, approves, books or schedules. The
    // handlers that do belong to Phases 11 and 13 and are checked separately;
    // what matters here is that Phase 14 added no such route of its own.
    const phase14Routes = [
      "recommendNextActionHandler",
      "recommendWorkspaceActionsHandler",
      "recordNextActionHandler",
      "listNextActionsHandler",
      "getNextActionHandler",
      "getNextActionPolicyHandler",
    ];
    for (const route of phase14Routes) {
      expect(Object.keys(handlers)).toContain(route);
      expect(route).not.toMatch(/send|book|approve|schedule|decide|execute/i);
    }
  });
});
