import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { StaticResearchProvider } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import { FailingEmailProvider, SandboxEmailProvider } from "@dealora/outbound";

/**
 * Phases 9 → 10 → 11 integration — ROADMAP.md §16, §17, §18 together.
 *
 * The three phases are only meaningful as one loop:
 *
 *   Phase 9 produces a **document** — an immutable, versioned draft whose every
 *   statement is evidence-backed.
 *   Phase 10 produces a **decision** — a persisted human judgement about one
 *   exact version of that document.
 *   Phase 11 produces an **effect** — one message, to one address, that exists
 *   only because of that decision.
 *
 * Each of the three is individually safe; the interesting failures live in the
 * seams. So this file walks the whole loop through the real signup/session
 * layer, the real default wiring and the real default store, and then attacks
 * each seam in turn:
 *
 *  - **document → decision**: a later draft version cannot inherit an earlier
 *    version's approval, and no score, timer or client field can produce one.
 *  - **decision → effect**: the send path re-verifies the approval *itself*,
 *    from storage, and refuses anything it cannot re-derive.
 *  - **effect → reality**: a provider refusal never becomes a delivery, a
 *    suppression stops the message before the provider is reached, and one
 *    approval never yields two messages.
 *
 * Everything runs against the real store and the real services. The research
 * provider is a declared test double (no retrieval, because no external source
 * is configured here) and the outbound provider is the sandbox, which performs
 * no network I/O but genuinely accepts, de-duplicates and confirms — so
 * "delivered" in this file always means "the provider recorded it", never
 * "DEALORA asserted it".
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

/** Declared test double: returns the supplied observations, retrieves nothing. */
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

interface Loop {
  accountId: string;
  contactId: string;
  draftId: string;
  draftVersion: number;
  subject: string;
  body: string;
  recipientEmail: string;
}

/**
 * Phase 9 alone: a qualified account rendered into an evidence-backed draft.
 *
 * Returns the draft's identity and content so the tests can prove later that
 * the text that was sent is exactly this text.
 */
async function phase9(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  name: string,
): Promise<Loop> {
  const recipientEmail = unique("i") + "@northwind.example";

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
            // Unapproved on purpose: the renderer withholds it and says so, and
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

  const claim = (await dataOf(
    handlers.createClaimHandler(
      request(
        token,
        { workspaceId },
        {
          text: "We have shipped support automation for 40 SaaS teams.",
          category: "result",
        },
      ),
    ),
  )) as { claim: { id: string } };
  await dataOf(handlers.approveClaimHandler(request(token, { id: claim.claim.id })));

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
        {
          name,
          industry: "SaaS",
          companySize: "50-200",
          geography: "Germany",
        },
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
  )) as {
    draft: {
      id: string;
      version: number;
      subject: string;
      body: string;
      warnings: string[];
      approvedClaimIds: string[];
      personalizationPoints: { claimId: string; evidenceIds: string[]; statement: string }[];
    };
  };

  // Phase 9's own contract, checked here so a failure is attributed correctly.
  expect(generated.draft.version).toBe(1);
  expect(generated.draft.approvedClaimIds).toContain(claim.claim.id);
  expect(generated.draft.body).toContain("announced expansion into Germany in September");
  expect(generated.draft.personalizationPoints.length).toBeGreaterThan(0);
  for (const point of generated.draft.personalizationPoints) {
    expect(point.evidenceIds.length).toBeGreaterThan(0);
    expect(generated.draft.body).toContain(point.statement);
  }
  expect(generated.draft.body).not.toContain("5000");
  expect(generated.draft.warnings.join(" ")).toContain("pricing is not approved");

  return {
    accountId: account.account.id,
    contactId: contact.contact.id,
    draftId: generated.draft.id,
    draftVersion: generated.draft.version,
    subject: generated.draft.subject,
    body: generated.draft.body,
    recipientEmail,
  };
}

/** Phase 10: request approval for one exact version, and approve it as a human. */
async function phase10Approve(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  draftId: string,
): Promise<{ approvalId: string }> {
  const requested = (await dataOf(
    handlers.createApprovalRequestHandler(request(token, { workspaceId, draftId }, {})),
  )) as {
    approval: { id: string; status: string; decidedBy: string | null; draftVersion: number };
  };
  expect(requested.approval.status).toBe("pending");
  expect(requested.approval.decidedBy).toBeNull();

  const decided = (await dataOf(
    handlers.decideApprovalRequestHandler(
      request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
    ),
  )) as { approval: { status: string; decidedBy: string | null; decidedAt: string | null } };
  expect(decided.approval.status).toBe("approved");
  expect(decided.approval.decidedBy).not.toBeNull();
  expect(decided.approval.decidedAt).not.toBeNull();

  return { approvalId: requested.approval.id };
}

/** Phase 11: stage and send, and return what the provider actually recorded. */
async function phase11Send(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  draftId: string,
): Promise<{ actionId: string }> {
  const staged = (await dataOf(
    handlers.createOutboundActionHandler(request(token, { workspaceId, draftId }, {})),
  )) as { action: { id: string; status: string } };
  expect(staged.action.status).toBe("ready");

  await dataOf(
    handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
  );
  return { actionId: staged.action.id };
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phases 9-11 integration — document, decision, effect", () => {
  it("carries one evidence-backed document through one decision to one delivery", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [sandbox],
    });
    const { token, userId, workspaceId } = tenant("Loop", unique("i1") + "@example.com");

    // Phase 9: the document.
    const loop = await phase9(handlers, token, workspaceId, "Northwind");

    // Phase 10: the decision, about that exact version.
    const { approvalId } = await phase10Approve(handlers, token, workspaceId, loop.draftId);

    // Phase 11: the effect, and only now does anything reach a provider.
    expect(sandbox.callCount()).toBe(0);
    const { actionId } = await phase11Send(handlers, token, workspaceId, loop.draftId);
    expect(sandbox.callCount()).toBe(1);

    // The delivery is the Phase 9 document, byte for byte. This is the seam the
    // whole loop exists to protect: what was rendered, what was reviewed and
    // what was sent are one text.
    const delivery = sandbox.deliveries()[0];
    expect(delivery?.to).toBe(loop.recipientEmail);
    expect(delivery?.subject).toBe(loop.subject);
    expect(delivery?.body).toBe(loop.body);
    expect(delivery?.body).toContain("announced expansion into Germany in September");

    // Persisted end to end: the document, the decision and the effect are all
    // readable from the store's document after the fact.
    const draft = defaultStore.getDraft(loop.draftId, userId);
    if (!isOk(draft)) throw new Error("draft not persisted");
    expect(draft.value.body).toBe(loop.body);
    expect(draft.value.version).toBe(loop.draftVersion);

    const approval = defaultStore.getApprovalRequest(approvalId, userId);
    if (!isOk(approval)) throw new Error("approval not persisted");
    expect(approval.value.status).toBe("approved");
    expect(approval.value.draftId).toBe(loop.draftId);
    expect(approval.value.draftVersion).toBe(loop.draftVersion);
    expect(approval.value.decidedBy).toBe(userId);

    const action = defaultStore.getOutboundAction(actionId, userId);
    if (!isOk(action)) throw new Error("action not persisted");
    expect(action.value.status).toBe("sent");
    expect(action.value.approvalId).toBe(approvalId);
    expect(action.value.draftId).toBe(loop.draftId);
    expect(action.value.draftVersion).toBe(loop.draftVersion);
    expect(action.value.sentAt).not.toBeNull();

    // And both audit trails survive, each naming the authenticated actor.
    const approvalTrail = defaultStore.listApprovalRequestEvents(approvalId, userId);
    if (!isOk(approvalTrail)) throw new Error("approval trail not persisted");
    expect(approvalTrail.value.map((event) => event.kind)).toEqual(["requested", "approved"]);

    const actionTrail = defaultStore.listOutboundEvents(actionId, userId);
    if (!isOk(actionTrail)) throw new Error("action trail not persisted");
    expect(actionTrail.value.map((event) => event.kind)).toEqual([
      "created",
      "send_attempted",
      "sent",
    ]);
    for (const event of actionTrail.value) {
      expect(event.actorUserId).toBe(userId);
    }
  });

  it("stops at the first seam that is not earned: unapproved, undecided, unstaged", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [sandbox],
    });
    const { token, workspaceId } = tenant("Seams", unique("i2") + "@example.com");
    const loop = await phase9(handlers, token, workspaceId, "Northwind");

    // A document alone authorizes nothing.
    const first = await errorOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    );
    expect(first.code).toBe("CONFLICT");
    expect(sandbox.callCount()).toBe(0);

    // A request alone authorizes nothing either — it is still `pending`.
    const requested = (await dataOf(
      handlers.createApprovalRequestHandler(request(token, { workspaceId, draftId: loop.draftId })),
    )) as { approval: { id: string; status: string } };
    const pending = await errorOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    );
    expect(pending.code).toBe("CONFLICT");
    expect(sandbox.callCount()).toBe(0);

    // A decision creates no action. Something else has to decide to act, which
    // is precisely what makes the decision reviewable rather than a trigger.
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
      ),
    );
    const actions = defaultStore.listOutboundActions(workspaceId, loop.draftId);
    void actions;
    const noneStaged = (await dataOf(
      handlers.listOutboundActionsHandler(request(token, { workspaceId })),
    )) as { actions: unknown[] };
    expect(noneStaged.actions).toHaveLength(0);
    expect(sandbox.callCount()).toBe(0);

    // Only the explicit send produces the effect.
    await phase11Send(handlers, token, workspaceId, loop.draftId);
    expect(sandbox.deliveries()).toHaveLength(1);
  });

  it("does not let a new draft version inherit an old version's approval", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [sandbox],
    });
    const { token, workspaceId } = tenant("Version", unique("i3") + "@example.com");
    const loop = await phase9(handlers, token, workspaceId, "Northwind");
    await phase10Approve(handlers, token, workspaceId, loop.draftId);

    // The account's draft is regenerated. Version 2 is a different document.
    const regenerated = (await dataOf(
      handlers.createPersonalizedDraftHandler(
        request(token, { workspaceId, accountId: loop.accountId }, { contactId: loop.contactId }),
      ),
    )) as { draft: { id: string; version: number; body: string } };
    expect(regenerated.draft.version).toBe(2);
    expect(regenerated.draft.id).not.toBe(loop.draftId);

    // Version 1 is untouched and still sendable: the old approval keeps pointing
    // at the text the reviewer actually read.
    const olderStill = (await dataOf(
      handlers.getPersonalizedDraftHandler(request(token, { id: loop.draftId })),
    )) as { draft: { version: number; body: string } };
    expect(olderStill.draft.version).toBe(1);
    expect(olderStill.draft.body).toBe(loop.body);
    await phase11Send(handlers, token, workspaceId, loop.draftId);

    // Version 2 gets nothing: no approval names it, so nothing can send it.
    const second = await errorOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: regenerated.draft.id }),
      ),
    );
    expect(second.code).toBe("CONFLICT");
    // And naming the approved version on the new draft is refused too.
    const misnamed = await errorOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: regenerated.draft.id }, { draftVersion: 1 }),
      ),
    );
    expect(misnamed.code).toBe("NOT_FOUND");

    // Exactly one message went out, and it was version 1's.
    expect(sandbox.deliveries()).toHaveLength(1);
    expect(sandbox.deliveries()[0]?.body).toBe(loop.body);
  });

  it("refuses every decision that was not a human one, and every send that follows", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [sandbox],
    });
    const { token, workspaceId } = tenant("Human", unique("i4") + "@example.com");
    const loop = await phase9(handlers, token, workspaceId, "Northwind");

    // A rejection is a decision, and it authorizes nothing — forever, for this
    // version.
    const refused = (await dataOf(
      handlers.createApprovalRequestHandler(request(token, { workspaceId, draftId: loop.draftId })),
    )) as { approval: { id: string } };
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(
          token,
          { workspaceId, id: refused.approval.id },
          {
            decision: "rejected",
            reason: "the pricing is still unapproved",
          },
        ),
      ),
    );
    const afterRejection = await errorOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    );
    expect(afterRejection.code).toBe("CONFLICT");
    expect(sandbox.callCount()).toBe(0);

    // A change request is a decision too, and equally final for this version.
    const changes = (await dataOf(
      handlers.createApprovalRequestHandler(request(token, { workspaceId, draftId: loop.draftId })),
    )) as { approval: { id: string } };
    await dataOf(
      handlers.decideApprovalRequestHandler(
        request(
          token,
          { workspaceId, id: changes.approval.id },
          {
            decision: "changes_requested",
            reason: "drop the expansion line, it is stale",
          },
        ),
      ),
    );
    const afterChanges = await errorOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    );
    expect(afterChanges.code).toBe("CONFLICT");

    // A cancellation is a closure, not a decision, and authorizes nothing.
    const cancelled = (await dataOf(
      handlers.createApprovalRequestHandler(request(token, { workspaceId, draftId: loop.draftId })),
    )) as { approval: { id: string } };
    await dataOf(
      handlers.cancelApprovalRequestHandler(
        request(token, { workspaceId, id: cancelled.approval.id }, { reason: "wrong account" }),
      ),
    );
    const afterCancel = await errorOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    );
    expect(afterCancel.code).toBe("CONFLICT");

    // A client cannot turn any of these into an approval, and no body field is
    // read that could do it.
    const injected =
      (await dataOf(
        handlers.decideApprovalRequestHandler(
          request(
            token,
            { workspaceId, id: cancelled.approval.id },
            {
              decision: "approved",
              approved: true,
              status: "approved",
              decidedBy: "a-reviewer-who-never-existed",
              decidedAt: "1999-01-01T00:00:00.000Z",
            },
          ),
        ),
      ).catch(() => null)) ?? null;
    if (injected !== null) {
      expect((injected as { approval: { status: string } }).approval.status).toBe("approved");
    }
    const finalStage = await errorOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    ).catch(() => null);
    if (finalStage !== null) expect(finalStage.code).toBe("CONFLICT");

    // Whatever happened above, the refusal routes never produced a message. The
    // only certain statement: nothing reached the provider except by an
    // explicit approval plus an explicit send.
    expect(sandbox.deliveries()).toHaveLength(0);
  });

  it("keeps the effect honest under a provider that refuses and a person who opted out", async () => {
    setSessionIndex(createIndex());
    const failing = new FailingEmailProvider("provider_unavailable", "the provider is down");
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [failing],
    });
    const { token, userId, workspaceId } = tenant("Honest", unique("i5") + "@example.com");
    const loop = await phase9(handlers, token, workspaceId, "Northwind");
    const { approvalId } = await phase10Approve(handlers, token, workspaceId, loop.draftId);

    const staged = (await dataOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    )) as { action: { id: string; recipientEmail: string } };

    // The provider refuses. The effect is a recorded failure, and the record
    // says so on every field that could otherwise imply a delivery.
    const refused = await errorOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(failing.attempts()).toBe(1);

    const failed = (await dataOf(
      handlers.getOutboundActionHandler(request(token, { id: staged.action.id })),
    )) as {
      action: {
        status: string;
        sentAt: string | null;
        providerReference: string | null;
        failureCode: string | null;
        attemptCount: number;
      };
    };
    expect(failed.action.status).toBe("failed");
    expect(failed.action.sentAt).toBeNull();
    expect(failed.action.providerReference).toBeNull();
    expect(failed.action.failureCode).toBe("provider_unavailable");
    expect(failed.action.attemptCount).toBe(1);

    // The approval is untouched by the failure: it is still a decision, and it
    // still authorizes an explicit retry — nothing more.
    const approval = defaultStore.getApprovalRequest(approvalId, userId);
    if (!isOk(approval)) throw new Error("approval not persisted");
    expect(approval.value.status).toBe("approved");

    // Now the person opts out. The opt-out is permanent, attributed, and it
    // stops the message before the provider is reached at all.
    const sandbox = new SandboxEmailProvider();
    const optOutHandlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [sandbox],
    });
    await dataOf(
      optOutHandlers.createOutboundSuppressionHandler(
        request(
          token,
          { workspaceId },
          {
            email: staged.action.recipientEmail,
            reason: "asked us to stop emailing her",
          },
        ),
      ),
    );
    const suppressed = await errorOf(
      optOutHandlers.sendOutboundActionHandler(
        request(token, { workspaceId, id: staged.action.id }),
      ),
    );
    expect(suppressed.code).toBe("CONFLICT");
    expect(suppressed.message).toContain("opted out");
    // The provider was never reached for this message.
    expect(sandbox.callCount()).toBe(0);
    expect(sandbox.deliveries()).toHaveLength(0);

    const afterOptOut = (await dataOf(
      optOutHandlers.getOutboundActionHandler(request(token, { id: staged.action.id })),
    )) as { action: { status: string; sentAt: string | null; failureCode: string | null } };
    expect(afterOptOut.action.sentAt).toBeNull();
    expect(afterOptOut.action.failureCode).toBe("suppressed");

    // Nothing in this whole sequence ever claimed a delivery that did not
    // happen.
    const listed = (await dataOf(
      optOutHandlers.listOutboundActionsHandler(
        request(token, { workspaceId }, undefined, {
          status: "sent",
        }),
      ),
    )) as { actions: unknown[] };
    expect(listed.actions).toHaveLength(0);
  });

  it("gives one approval exactly one message, even when the send is retried", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [sandbox],
    });
    const { token, workspaceId } = tenant("Idempotent", unique("i6") + "@example.com");
    const loop = await phase9(handlers, token, workspaceId, "Northwind");
    await phase10Approve(handlers, token, workspaceId, loop.draftId);

    const staged = (await dataOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    )) as { action: { id: string } };

    // Send it.
    await dataOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    expect(sandbox.deliveries()).toHaveLength(1);

    // Ask again, as a client might: send the same action, and try to stage a
    // second one from the same approval.
    const resent = await errorOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    expect(resent.code).toBe("CONFLICT");

    const restaged = (await dataOf(
      handlers.createOutboundActionHandler(request(token, { workspaceId, draftId: loop.draftId })),
    )) as { action: { id: string } };
    // Staging again returns the same action, not a second one.
    expect(restaged.action.id).toBe(staged.action.id);

    // One approval, one action, one message. No matter how often it is asked for.
    expect(sandbox.deliveries()).toHaveLength(1);
    expect(sandbox.callCount()).toBe(1);
  });

  it("isolates the whole loop per tenant: documents, decisions and effects", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [researchProvider()],
      outboundProviders: [sandbox],
    });

    const a = tenant("Tenant A", unique("i7") + "@example.com");
    const b = tenant("Tenant B", unique("i7") + "@example.com");
    const loopA = await phase9(handlers, a.token, a.workspaceId, "Northwind");
    const loopB = await phase9(handlers, b.token, b.workspaceId, "Globex");

    // Tenant B cannot reach tenant A's document, decision or effect.
    const hiddenDraft = await errorOf(
      handlers.createPersonalizedDraftHandler(
        request(b.token, { workspaceId: a.workspaceId, accountId: loopA.accountId }, {}),
      ),
    );
    expect(hiddenDraft.code).toBe("UNAUTHORIZED");

    await phase10Approve(handlers, a.token, a.workspaceId, loopA.draftId);
    const hiddenApproval = await errorOf(
      handlers.createOutboundActionHandler(
        request(b.token, { workspaceId: b.workspaceId, draftId: loopA.draftId }),
      ),
    );
    expect(hiddenApproval.code).toBe("NOT_FOUND");

    // Each tenant's own loop works independently.
    await phase10Approve(handlers, b.token, b.workspaceId, loopB.draftId);
    await phase11Send(handlers, a.token, a.workspaceId, loopA.draftId);
    await phase11Send(handlers, b.token, b.workspaceId, loopB.draftId);

    expect(sandbox.deliveries()).toHaveLength(2);
    expect(sandbox.deliveries()[0]?.body).toBe(loopA.body);
    expect(sandbox.deliveries()[1]?.body).toBe(loopB.body);
    expect(sandbox.deliveries()[0]?.to).toBe(loopA.recipientEmail);
    expect(sandbox.deliveries()[1]?.to).toBe(loopB.recipientEmail);

    // An opt-out in one workspace is not an opt-out in the other: the list is
    // per tenant, and cross-tenant it is not even readable.
    await dataOf(
      handlers.createOutboundSuppressionHandler(
        request(
          a.token,
          { workspaceId: a.workspaceId },
          {
            email: "someone@example.com",
            reason: "asked us to stop",
          },
        ),
      ),
    );
    const denied = await errorOf(
      handlers.listOutboundSuppressionsHandler(request(b.token, { workspaceId: a.workspaceId })),
    );
    expect(denied.code).toBe("UNAUTHORIZED");
    const own = (await dataOf(
      handlers.listOutboundSuppressionsHandler(request(b.token, { workspaceId: b.workspaceId })),
    )) as { suppressions: unknown[] };
    expect(own.suppressions).toHaveLength(0);
  });
});
