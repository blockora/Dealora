import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { StaticResearchProvider } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import { createApprovalService, toApprovalDraftSnapshot } from "@dealora/approval";
import { APPROVAL_ACTION_KIND, SEND_MESSAGE_RISK_LEVEL } from "@dealora/approval";
import type { ApprovalRepository, Clock } from "@dealora/approval";

/**
 * Phase 10 gate — ROADMAP.md §17.
 *
 * Its gate is one sentence: *no Level 2 or Level 3 production action may execute
 * without an appropriate policy or explicit approval*. The first test walks the
 * whole pipeline through the real signup/session layer, the real default wiring
 * and the real default store — Business Brain → Revenue Goal → Account →
 * Research → Evidence → Qualification → Personalization → **Approval** — and
 * reads the decision back from the store's persisted document, so what is proven
 * is that the approval was written, not merely held in memory.
 *
 * The research provider here is a **declared test double**, exactly as in the
 * Phase 9 gate: it returns the observations the test supplies and performs no
 * retrieval, because no external source is configured here and DEALORA does not
 * pretend otherwise.
 *
 * The rest of the suite is the refusal surface, which is what the phase is for:
 *  - nothing approves itself, on a timer or on a score;
 *  - a client cannot name its own approver or backdate a decision;
 *  - a decision cannot be taken twice, and a rejection must say why;
 *  - cancelling and expiring are not approvals;
 *  - content that moves under a pending request cannot be approved;
 *  - another tenant's approval is unreachable and never confirmed to exist.
 *
 * The last test proves there is still no outbound surface: no send route, no
 * channel and no provider, because sending is Phase 11 and an engine that could
 * reach one would skip this phase entirely.
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

/** The shape this gate reads back out of a decision. */
interface GateApproval {
  id: string;
  status: string;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  draftId: string;
  draftVersion: number;
  actionKind: string;
  riskLevel: string;
  previewDigest: string;
  createdBy: string;
  expiresAt: string | null;
}

/**
 * The declared observations that make an account qualify and give the draft
 * something specific for a human to read before approving it.
 *
 * **Declared test double**: no retrieval of any kind. The categories mirror the
 * Phase 8 criteria exactly, so the account evaluates as genuinely `qualified`
 * rather than being forced into it.
 */
function provider(): ResearchProvider {
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

/**
 * A real signup and a real workspace, as the earlier gates do it.
 *
 * Signup creates the user; the workspace is created explicitly, because the
 * tenant boundary is an explicit act and the default store is one shared
 * document across every gate suite.
 */
function tenant(
  name: string,
  email: string,
): { token: string; userId: string; workspaceId: string } {
  const owner = signup(email, "correct-horse-battery", name);
  // Slugs are unique across the shared document, so each tenant gets its own.
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

type Handlers = ReturnType<typeof createDefaultHandlers>;

/** A workspace with an active offer, an ICP, a persona and a compilable goal. */
async function brain(
  handlers: Handlers,
  token: string,
  workspaceId: string,
): Promise<{ offerId: string; goalId: string }> {
  const offer = (await dataOf(
    handlers.createOfferHandler(
      request(
        token,
        { workspaceId },
        {
          name: "Support Automation",
          description: "We build support automation for B2B SaaS teams.",
          outcome: "faster first response times",
          pricing: {
            model: "one_time",
            amountMin: 5000,
            amountMax: null,
            currency: "USD",
            notes: null,
            // Deliberately unapproved: the draft withholds it and says so, and
            // the reviewer sees that warning as part of what they approve.
            approved: false,
          },
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

  return { offerId: offer.offer.id, goalId: goal.goal.id };
}

/** An account researched, evidenced and genuinely qualified. */
async function qualifiedAccount(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  offerId: string,
  goalId: string,
  name: string,
): Promise<{ accountId: string; contactId: string; qualificationId: string }> {
  const account = (await dataOf(
    handlers.createAccountHandler(
      request(
        token,
        { workspaceId },
        { name, industry: "SaaS", companySize: "50-200", geography: "Germany" },
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
          email: unique("p10") + "@northwind.example",
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
      request(token, { workspaceId, accountId: account.account.id }, { revenueGoalId: goalId }),
    ),
  )) as { qualification: { id: string; state: string } };
  expect(qualification.qualification.state).toBe("qualified");

  return {
    accountId: account.account.id,
    contactId: contact.contact.id,
    qualificationId: qualification.qualification.id,
  };
}

/** A qualified account and its personalized draft, version 1. */
async function qualifiedDraft(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  name: string,
): Promise<{
  offerId: string;
  draftId: string;
  draftVersion: number;
  subject: string;
  body: string;
}> {
  const { offerId, goalId } = await brain(handlers, token, workspaceId);
  const target = await qualifiedAccount(handlers, token, workspaceId, offerId, goalId, name);
  const generated = (await dataOf(
    handlers.createPersonalizedDraftHandler(
      request(
        token,
        { workspaceId, accountId: target.accountId },
        {
          qualificationId: target.qualificationId,
          offerId,
          contactId: target.contactId,
        },
      ),
    ),
  )) as {
    draft: { id: string; version: number; subject: string; body: string };
  };
  return {
    offerId,
    draftId: generated.draft.id,
    draftVersion: generated.draft.version,
    subject: generated.draft.subject,
    body: generated.draft.body,
  };
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 10 gate — approval engine", () => {
  it("records an explicit human decision on one exact draft version, and persists it", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, userId, workspaceId } = tenant("Approval Gate", unique("p10") + "@example.com");

    const draft = await qualifiedDraft(handlers, token, workspaceId, "Northwind");

    // The request binds to the exact version, not merely to the draft.
    const created = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, {}),
      ),
    )) as { approval: GateApproval };
    const approval = created.approval;

    expect(approval.status).toBe("pending");
    expect(approval.decision).toBeNull();
    expect(approval.decidedBy).toBeNull();
    expect(approval.decidedAt).toBeNull();
    expect(approval.draftId).toBe(draft.draftId);
    expect(approval.draftVersion).toBe(draft.draftVersion);
    expect(approval.actionKind).toBe(APPROVAL_ACTION_KIND);
    expect(approval.riskLevel).toBe(SEND_MESSAGE_RISK_LEVEL);
    expect(approval.previewDigest).not.toBe("");
    expect(approval.createdBy).toBe(userId);

    // Nothing approved itself. The draft is fully written and the reviewer is a
    // real user, and the request is still `pending` with no decision on it.
    expect(approval.status).toBe("pending");

    // What the reviewer is shown: the exact content the decision will mean, plus
    // everything the renderer declined to state.
    const preview = (await dataOf(
      handlers.previewApprovalRequestHandler(request(token, { id: approval.id })),
    )) as { subject: string; body: string; warnings: string[] };
    expect(preview.subject).toBe(draft.subject);
    expect(preview.body).toBe(draft.body);
    expect(preview.warnings.join(" ")).toContain("pricing is not approved");

    // A client cannot inject the decision, the approver or the instant. Every
    // one of these fields is ignored in favour of the session.
    const injected = (await dataOf(
      handlers.decideApprovalRequestHandler(
        request(
          token,
          { workspaceId, id: approval.id },
          {
            decision: "approved",
            approved: true,
            status: "approved",
            decidedBy: "somebody-else",
            decidedAt: "1999-01-01T00:00:00.000Z",
            riskLevel: "level_0_read",
            actionKind: "read_something",
          },
        ),
      ),
    )) as { approval: GateApproval; event: { kind: string; actorUserId: string } };

    expect(injected.approval.status).toBe("approved");
    expect(injected.approval.decision).toBe("approved");
    // The reviewer is the authenticated user, never a named one.
    expect(injected.approval.decidedBy).toBe(userId);
    expect(injected.approval.decidedBy).not.toBe("somebody-else");
    // The instant is the server's, never a backdated one.
    expect(injected.approval.decidedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(injected.approval.decidedAt).not.toBeNull();
    // The risk level and action kind are properties of the action, not of a body.
    expect(injected.approval.riskLevel).toBe(SEND_MESSAGE_RISK_LEVEL);
    expect(injected.approval.actionKind).toBe(APPROVAL_ACTION_KIND);
    expect(injected.event.actorUserId).toBe(userId);

    // The audit trail: who asked, who decided, what, when. Persisted, so it is
    // readable from the store's document rather than only from this response.
    const history = (await dataOf(
      handlers.approvalHistoryHandler(request(token, { id: approval.id })),
    )) as { history: { kind: string; actorUserId: string; createdAt: string }[] };
    expect(history.history.map((event) => event.kind)).toEqual(["requested", "approved"]);
    for (const event of history.history) {
      expect(event.actorUserId).toBe(userId);
      expect(event.createdAt).not.toBe("");
    }

    // Reload the decision straight from the persisted document: an approval that
    // only ever lived in memory would not be here.
    const stored = defaultStore.getApprovalRequest(approval.id, userId);
    expect(isOk(stored)).toBe(true);
    if (!isOk(stored)) return;
    expect(stored.value.status).toBe("approved");
    expect(stored.value.decidedBy).toBe(userId);
    expect(stored.value.decidedAt).not.toBeNull();
    expect(stored.value.draftVersion).toBe(draft.draftVersion);
    expect(stored.value.previewDigest).toBe(approval.previewDigest);

    const storedEvents = defaultStore.listApprovalRequestEvents(approval.id, userId);
    expect(isOk(storedEvents)).toBe(true);
    if (!isOk(storedEvents)) return;
    expect(storedEvents.value.map((event) => event.kind)).toEqual(["requested", "approved"]);

    const reread = (await dataOf(
      handlers.getApprovalRequestHandler(request(token, { id: approval.id })),
    )) as { approval: GateApproval };
    expect(reread.approval.status).toBe("approved");
    expect(reread.approval.decidedBy).toBe(userId);
  });

  it("refuses a second decision, and refuses a rejection that does not say why", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = tenant("Second Decision", unique("p10d") + "@example.com");
    const draft = await qualifiedDraft(handlers, token, workspaceId, "Northwind");

    // A rejection must explain itself, so the record can be read later.
    const pending = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, {}),
      ),
    )) as { approval: GateApproval };

    const unreasoned = await errorOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: pending.approval.id }, { decision: "rejected" }),
      ),
    );
    expect(unreasoned.code).toBe("VALIDATION_ERROR");
    expect(unreasoned.message).toContain("not valid");

    const rejected = (await dataOf(
      handlers.decideApprovalRequestHandler(
        request(
          token,
          { workspaceId, id: pending.approval.id },
          {
            decision: "rejected",
            reason: "the pricing is not approved for external use",
          },
        ),
      ),
    )) as { approval: GateApproval };
    expect(rejected.approval.status).toBe("rejected");
    expect(rejected.approval.decisionReason).toBe("the pricing is not approved for external use");

    // A decided request is not re-decidable: the first decision is the decision.
    const again = await errorOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: pending.approval.id }, { decision: "approved" }),
      ),
    );
    expect(again.code).toBe("CONFLICT");

    // And the rejection stands: asking again did not turn it into an approval.
    const settled = (await dataOf(
      handlers.getApprovalRequestHandler(request(token, { id: pending.approval.id })),
    )) as { approval: GateApproval };
    expect(settled.approval.status).toBe("rejected");
    expect(settled.approval.decision).toBe("rejected");

    // A change request is a decision too, and it says what should change.
    const other = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, {}),
      ),
    )) as { approval: GateApproval };
    const changes = (await dataOf(
      handlers.decideApprovalRequestHandler(
        request(
          token,
          { workspaceId, id: other.approval.id },
          {
            decision: "changes_requested",
            reason: "drop the expansion line, it is two quarters old",
          },
        ),
      ),
    )) as { approval: GateApproval };
    expect(changes.approval.status).toBe("changes_requested");

    // A change request must also say what should change: whitespace is not a
    // reason, and the refusal names the field rather than failing silently.
    const silence = await errorOf(
      handlers.decideApprovalRequestHandler(
        request(
          token,
          { workspaceId, id: other.approval.id },
          {
            decision: "changes_requested",
            reason: "   ",
          },
        ),
      ),
    );
    expect(silence.code).toBe("VALIDATION_ERROR");
    expect(silence.details?.map((detail) => detail.field)).toContain("reason");

    // And a decision nobody made is not a decision: an unrecognised value is
    // refused rather than defaulted to anything.
    const invented = await errorOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: other.approval.id }, { decision: "sort_of" }),
      ),
    );
    expect(invented.code).toBe("VALIDATION_ERROR");
  });

  it("names the cause of a refusal, so 'not decidable' is distinguishable", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = tenant("Causes", unique("p10n") + "@example.com");
    const draft = await qualifiedDraft(handlers, token, workspaceId, "Northwind");

    const created = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, {}),
      ),
    )) as { approval: GateApproval };

    // Every lifecycle refusal is a `CONFLICT`, and the message says which one it
    // is. A caller has to be able to tell "someone already decided this" from
    // "the text moved" from "the deadline passed", because the fix differs.
    const alreadyDecided = (await dataOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: created.approval.id }, { decision: "approved" }),
      ),
    )) as { approval: GateApproval };
    expect(alreadyDecided.approval.status).toBe("approved");

    const second = await errorOf(
      handlers.decideApprovalRequestHandler(
        request(
          token,
          { workspaceId, id: created.approval.id },
          { decision: "rejected", reason: "no" },
        ),
      ),
    );
    expect(second.code).toBe("CONFLICT");
    expect(second.message).toContain("already approved");

    // The transport contract is closed: no refusal can emit a code the API has
    // not defined, because every domain code is mapped explicitly.
    const codes = [
      second.code,
      (
        await errorOf(
          handlers.createApprovalRequestHandler(
            request(token, { workspaceId, draftId: "nope" }, {}),
          ),
        )
      ).code,
      (
        await errorOf(
          handlers.createApprovalRequestHandler(
            request(token, { workspaceId, draftId: draft.draftId }, { expiresInDays: 0 }),
          ),
        )
      ).code,
      (
        await errorOf(
          handlers.decideApprovalRequestHandler(
            request(token, { workspaceId, id: created.approval.id }, { decision: "maybe" }),
          ),
        )
      ).code,
      (
        await errorOf(
          handlers.listApprovalRequestsHandler(
            request(token, { workspaceId }, undefined, { status: "invented" }),
          ),
        )
      ).code,
      (await errorOf(handlers.listApprovalRequestsHandler(request(token, {}, undefined, {})))).code,
    ];
    for (const code of codes) {
      expect([
        "UNAUTHENTICATED",
        "UNAUTHORIZED",
        "NOT_FOUND",
        "VALIDATION_ERROR",
        "CONFLICT",
        "SERVER_ERROR",
      ]).toContain(code);
    }
  });

  it("treats a cancellation as a closure, not as an approval", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = tenant("Cancelled", unique("p10c") + "@example.com");
    const draft = await qualifiedDraft(handlers, token, workspaceId, "Northwind");

    const created = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, {}),
      ),
    )) as { approval: GateApproval };

    const cancelled = (await dataOf(
      handlers.cancelApprovalRequestHandler(
        request(token, { workspaceId, id: created.approval.id }, { reason: "wrong recipient" }),
      ),
    )) as { approval: GateApproval };
    expect(cancelled.approval.status).toBe("cancelled");
    // A cancellation is a closure: it carries no decision and no reviewer.
    expect(cancelled.approval.decision).toBeNull();
    expect(cancelled.approval.decidedBy).toBeNull();

    // It cannot be decided afterwards, and asking twice does not revive it.
    const late = await errorOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: created.approval.id }, { decision: "approved" }),
      ),
    );
    expect(late.code).toBe("CONFLICT");

    const cancelledAgain = await errorOf(
      handlers.cancelApprovalRequestHandler(
        request(token, { workspaceId, id: created.approval.id }),
      ),
    );
    expect(cancelledAgain.code).toBe("CONFLICT");

    const history = (await dataOf(
      handlers.approvalHistoryHandler(request(token, { id: created.approval.id })),
    )) as { history: { kind: string }[] };
    expect(history.history.map((event) => event.kind)).toEqual(["requested", "cancelled"]);
  });

  it("closes an expired request as expired, and a timeout approves nothing", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, userId, workspaceId } = tenant("Expiring", unique("p10e") + "@example.com");
    const draft = await qualifiedDraft(handlers, token, workspaceId, "Northwind");

    // A request with a deadline, so expiry is reachable through the real clock
    // by moving time rather than by rewriting the record.
    const created = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, { expiresInDays: 1 }),
      ),
    )) as { approval: GateApproval };
    expect(created.approval.expiresAt).not.toBeNull();
    expect(created.approval.status).toBe("pending");

    // Build the same real service over the real store with a clock past the
    // deadline. Nothing else is doubled: the storage, the authorization, the
    // digest re-derivation and the audit trail are all the production ones.
    const past = new Date(new Date(created.approval.expiresAt as string).getTime() + 1000);
    const clock: Clock = () => past;
    const repo = defaultStore as unknown as ApprovalRepository;
    const service = createApprovalService(
      repo,
      {
        byId: (draftId, userId) => {
          const found = defaultStore.getDraft(draftId, userId);
          return found.ok ? toApprovalDraftSnapshot(found.value) : null;
        },
        latestVersion: (draftId, userId) => {
          const found = defaultStore.getDraft(draftId, userId);
          return found.ok ? toApprovalDraftSnapshot(found.value) : null;
        },
      },
      clock,
    );

    // Too late: the deadline closed the door.
    const late = service.recordDecision(workspaceId, userId, created.approval.id, "approved", null);
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error.code).toBe("EXPIRED");

    // The timeout closed the request; it did not open one.
    const stored = defaultStore.getApprovalRequest(created.approval.id, userId);
    expect(isOk(stored)).toBe(true);
    if (!isOk(stored)) return;
    expect(stored.value.status).toBe("expired");
    expect(stored.value.decision).toBeNull();
    expect(stored.value.decidedBy).toBeNull();

    // And an expired request authorizes nothing at all.
    const verified = service.verifyApproval(created.approval.id, userId);
    expect(verified.ok).toBe(false);

    const history = service.approvalHistory(created.approval.id, userId);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.map((event) => event.kind)).toEqual(["requested", "expired"]);
  });

  it("refuses to decide when the content under review has moved", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, userId, workspaceId } = tenant("Moved", unique("p10m") + "@example.com");
    const draft = await qualifiedDraft(handlers, token, workspaceId, "Northwind");

    const created = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, {}),
      ),
    )) as { approval: GateApproval };

    // The reader boundary is where content drift would be observed. Drafts are
    // immutable, so this doubles only the *read* of the version, returning the
    // real record with different text; the service, the digest derivation, the
    // storage and the audit trail are all the production ones.
    const drifted = createApprovalService(defaultStore as unknown as ApprovalRepository, {
      byId: (draftId, userId) => {
        const found = defaultStore.getDraft(draftId, userId);
        if (!found.ok) return null;
        const snapshot = toApprovalDraftSnapshot(found.value);
        return { ...snapshot, body: `${snapshot.body}\n\nP.S. Sign here first.` };
      },
      latestVersion: (draftId, userId) => {
        const found = defaultStore.getDraft(draftId, userId);
        return found.ok ? toApprovalDraftSnapshot(found.value) : null;
      },
    });

    const refused = drifted.recordDecision(
      workspaceId,
      userId,
      created.approval.id,
      "approved",
      null,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("PREVIEW_MISMATCH");

    // Nothing was decided, and the request is still the one human is holding.
    const stored = defaultStore.getApprovalRequest(created.approval.id, userId);
    expect(isOk(stored)).toBe(true);
    if (!isOk(stored)) return;
    expect(stored.value.status).toBe("pending");
    expect(stored.value.decidedBy).toBeNull();
  });

  it("refuses another tenant's request and never confirms it exists", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });

    const a = tenant("Tenant A", unique("p10t") + "@example.com");
    const b = tenant("Tenant B", unique("p10t") + "@example.com");
    const draft = await qualifiedDraft(handlers, a.token, a.workspaceId, "Northwind");

    const created = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(a.token, { workspaceId: a.workspaceId, draftId: draft.draftId }, {}),
      ),
    )) as { approval: GateApproval };

    // Tenant B may not read, decide or preview it. Every route refuses, and the
    // refusals do not disclose which of them would have worked.
    for (const attempt of [
      handlers.getApprovalRequestHandler(request(b.token, { id: created.approval.id })),
      handlers.previewApprovalRequestHandler(request(b.token, { id: created.approval.id })),
      handlers.approvalHistoryHandler(request(b.token, { id: created.approval.id })),
    ]) {
      const refused = await errorOf(attempt);
      expect(refused.code).toBe("UNAUTHORIZED");
    }

    // Tenant B may not write into tenant A's workspace either.
    const denied = await errorOf(
      handlers.decideApprovalRequestHandler(
        request(
          b.token,
          { workspaceId: a.workspaceId, id: created.approval.id },
          {
            decision: "approved",
          },
        ),
      ),
    );
    expect(denied.code).toBe("UNAUTHORIZED");

    // Inside their own workspace tenant B is a legitimate member, and the
    // request still belongs to another tenant: the store authorizes every read
    // against the record's owning workspace, so this is refused at the same
    // boundary as a foreign draft would be.
    const hidden = await errorOf(
      handlers.decideApprovalRequestHandler(
        request(
          b.token,
          { workspaceId: b.workspaceId, id: created.approval.id },
          {
            decision: "approved",
          },
        ),
      ),
    );
    expect(hidden.code).toBe("UNAUTHORIZED");

    // Tenant B's own workspace has no requests, and none of tenant A's leaked
    // into it: the listing is scoped server-side, not by what the caller asked
    // for.
    const ownList = (await dataOf(
      handlers.listApprovalRequestsHandler(request(b.token, { workspaceId: b.workspaceId })),
    )) as { approvals: unknown[] };
    expect(ownList.approvals).toHaveLength(0);

    // Tenant A's request is untouched by any of it: no decision, no reviewer,
    // and the text they approved is still the text that is stored.
    const settled = (await dataOf(
      handlers.getApprovalRequestHandler(request(a.token, { id: created.approval.id })),
    )) as { approval: GateApproval };
    expect(settled.approval.status).toBe("pending");
    expect(settled.approval.decidedBy).toBeNull();
    expect(settled.approval.previewDigest).toBe(created.approval.previewDigest);
  });

  it("refuses a request for a version that was never rendered", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = tenant("No Version", unique("p10v") + "@example.com");
    const draft = await qualifiedDraft(handlers, token, workspaceId, "Northwind");

    // A draft version nobody rendered is not something a human can approve.
    const imaginary = await errorOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, { draftVersion: 99 }),
      ),
    );
    expect(imaginary.code).toBe("NOT_FOUND");

    // Neither is a draft that does not exist, in this workspace or any other.
    const absent = await errorOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: "draft-does-not-exist" }, {}),
      ),
    );
    expect(absent.code).toBe("NOT_FOUND");

    // And the real version is still decidable after both refusals.
    const real = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(
          token,
          { workspaceId, draftId: draft.draftId },
          { draftVersion: draft.draftVersion },
        ),
      ),
    )) as { approval: GateApproval };
    expect(real.approval.draftVersion).toBe(draft.draftVersion);
  });

  it("states the policy it enforces, before any request exists", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = tenant("Policy", unique("p10p") + "@example.com");

    const policy = (await dataOf(
      handlers.getApprovalPolicyHandler(request(token, { workspaceId })),
    )) as { riskLevel: string; neverDoes: string[]; reviewerSees: string[] };
    expect(policy.riskLevel).toBe(SEND_MESSAGE_RISK_LEVEL);
    expect(policy.neverDoes.join(" ")).toContain("approve anything without an authenticated human");
    expect(policy.neverDoes.join(" ")).toContain("score, a threshold, a timer");
    expect(policy.reviewerSees.join(" ")).toContain("warnings");

    // An empty workspace is where a score would have been, and there is nothing
    // to approve at all.
    const empty = (await dataOf(
      handlers.listApprovalRequestsHandler(request(token, { workspaceId })),
    )) as { approvals: unknown[] };
    expect(empty.approvals).toHaveLength(0);
  });

  it("cannot be made to send: no outbound route, no provider, no channel", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, userId, workspaceId } = tenant("No Send", unique("p10s") + "@example.com");
    const draft = await qualifiedDraft(handlers, token, workspaceId, "Northwind");

    const created = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(token, { workspaceId, draftId: draft.draftId }, {}),
      ),
    )) as { approval: GateApproval };
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: created.approval.id }, { decision: "approved" }),
      ),
    );

    // An approval is stored and recorded, and there is still no way to act on
    // it. Phase 11 is where a provider is introduced, behind its own interface
    // and its own independent verification of these records.
    const names = Object.keys(handlers).map((name) => name.toLowerCase());
    for (const forbidden of ["send", "dispatch", "deliver", "provider", "channel"]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }

    // Nothing was sent, because there is no route that could send.
    const listed = defaultStore.listApprovalRequests(workspaceId, userId);
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.status).toBe("approved");
  });
});
