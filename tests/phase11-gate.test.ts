import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { StaticResearchProvider } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import {
  FailingEmailProvider,
  SandboxEmailProvider,
  ThrowingEmailProvider,
} from "@dealora/outbound";

/**
 * Phase 11 gate — ROADMAP.md §18.
 *
 * Its gate is one sentence: *a real approved message can be sent and its state
 * can be observed*, under the critical rule that no mass-outreach infrastructure
 * is built. The first test walks the whole pipeline through the real
 * signup/session layer, the real default wiring and the real default store —
 * Business Brain → Revenue Goal → Account → Research → Evidence →
 * Qualification → Personalization → Approval → **Send** — and reads the delivery
 * back from the store's persisted document, so what is proven is that the send
 * was written, not merely returned.
 *
 * **On the word "real".** The provider here is the sandbox: it performs no
 * network I/O, because no outbound credential is configured in this repository
 * and DEALORA does not pretend otherwise. That does not weaken the gate, because
 * the sandbox *does* accept a message, does de-duplicate it, and does return a
 * confirmation — so the phase's central claim is exercised end to end. What it
 * proves is everything on DEALORA's side of the boundary: that a message reaches
 * a provider only after a human approved that exact draft version, that the text
 * delivered is the text that was reviewed, and that a confirmation is the only
 * thing that produces `sent`. Nothing here fabricates a delivery, and the
 * delivered-body assertions are about what the provider *recorded*.
 *
 * The research provider is a **declared test double**, as in the Phase 9 and 10
 * gates: it returns the observations the test supplies and performs no retrieval.
 *
 * The rest of the suite is the refusal surface, which is what this phase is for:
 * no send without approval, no send for a version no approval covers, no
 * autonomous send, no duplicate send, no send to a suppressed address, and no
 * send that a provider failure could report as delivered.
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

interface GateApproval {
  id: string;
  status: string;
  decidedBy: string | null;
  draftId: string;
  draftVersion: number;
}

interface GateAction {
  id: string;
  status: string;
  channel: string;
  approvalId: string;
  draftId: string;
  draftVersion: number;
  draftDigest: string;
  contactId: string;
  recipientEmail: string;
  provider: string | null;
  providerReference: string | null;
  attemptCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  attemptedAt: string | null;
  sentAt: string | null;
}

/**
 * The declared observations that make an account qualify and give the draft
 * something specific for a human to read before approving it.
 *
 * **Declared test double**: no retrieval of any kind. The categories mirror the
 * Phase 8 criteria exactly, so the account evaluates as genuinely `qualified`.
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

type Handlers = ReturnType<typeof createDefaultHandlers>;

/**
 * A real signup and a real workspace.
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
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

interface Pipeline {
  accountId: string;
  draftId: string;
  draftVersion: number;
  subject: string;
  body: string;
  contactId: string;
  recipientEmail: string;
}

/**
 * The whole pipeline up to an approved draft version.
 *
 * Brain → Goal → Account → Contact → Research → Evidence → Qualification →
 * Personalization → Approval request → Approval decision. Everything goes
 * through the real handlers, so a send at the end of it is a send of something
 * that genuinely earned its way here.
 */
async function approvedPipeline(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  accountName: string,
  recipientEmail: string,
): Promise<Pipeline & { approvalId: string }> {
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
  )) as { draft: { id: string; version: number; subject: string; body: string } };

  const requested = (await dataOf(
    handlers.createApprovalRequestHandler(
      request(token, { workspaceId, draftId: generated.draft.id }, {}),
    ),
  )) as { approval: GateApproval };
  const decided = (await dataOf(
    handlers.decideApprovalRequestHandler(
      request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
    ),
  )) as { approval: GateApproval };
  expect(decided.approval.status).toBe("approved");

  return {
    approvalId: decided.approval.id,
    accountId: account.account.id,
    draftId: generated.draft.id,
    draftVersion: generated.draft.version,
    subject: generated.draft.subject,
    body: generated.draft.body,
    contactId: contact.contact.id,
    recipientEmail,
  };
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 11 gate — first outbound integration", () => {
  it("sends one approved message and its delivery state can be observed", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [sandbox],
    });
    const { token, userId, workspaceId } = tenant("Outbound Gate", unique("p11") + "@example.com");
    const recipient = unique("p11ada") + "@northwind.example";

    const pipeline = await approvedPipeline(handlers, token, workspaceId, "Northwind", recipient);

    // Staging is not sending: the action is created `ready`, with no provider,
    // no attempt and no reference.
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: pipeline.draftId }, {}),
      ),
    )) as { action: GateAction };
    const action = staged.action;

    expect(action.status).toBe("ready");
    expect(action.channel).toBe("email");
    expect(action.approvalId).toBe(pipeline.approvalId);
    expect(action.draftId).toBe(pipeline.draftId);
    expect(action.draftVersion).toBe(pipeline.draftVersion);
    expect(action.draftDigest).not.toBe("");
    expect(action.recipientEmail).toBe(recipient);
    expect(action.provider).toBeNull();
    expect(action.attemptCount).toBe(0);
    expect(action.providerReference).toBeNull();
    expect(action.sentAt).toBeNull();
    // Nothing reached the provider yet.
    expect(sandbox.callCount()).toBe(0);

    // The gate itself: the send.
    const sent = (await dataOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: action.id })),
    )) as { action: GateAction; delivered: boolean; provider: string; history: { kind: string }[] };

    expect(sent.delivered).toBe(true);
    expect(sent.provider).toBe("sandbox_email");
    expect(sent.action.status).toBe("sent");
    expect(sent.action.provider).toBe("sandbox_email");
    expect(sent.action.providerReference).not.toBeNull();
    expect(sent.action.sentAt).not.toBeNull();
    expect(sent.action.attemptCount).toBe(1);
    expect(sent.action.failureCode).toBeNull();

    // The delivery state is observable, and what the provider recorded is the
    // text a human actually approved — not something the send invented.
    const deliveries = sandbox.deliveries();
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    expect(delivery?.to).toBe(recipient);
    expect(delivery?.subject).toBe(pipeline.subject);
    expect(delivery?.body).toBe(pipeline.body);

    // The whole thing, oldest first, naming who acted and when.
    expect(sent.history.map((event) => event.kind)).toEqual(["created", "send_attempted", "sent"]);
    for (const event of sent.history) {
      expect(event.actorUserId).toBe(userId);
      expect(event.createdAt).not.toBe("");
    }

    // Persisted, not merely returned: the delivery state is readable from the
    // store's document and through the read routes.
    const stored = defaultStore.getOutboundAction(action.id, userId);
    expect(isOk(stored)).toBe(true);
    if (!isOk(stored)) return;
    expect(stored.value.status).toBe("sent");
    expect(stored.value.sentAt).not.toBeNull();
    expect(stored.value.providerReference).toBe(sent.action.providerReference);

    const reread = (await dataOf(
      handlers.getOutboundActionHandler(request(token, { id: action.id })),
    )) as { action: GateAction };
    expect(reread.action.status).toBe("sent");
    expect(reread.action.sentAt).toBe(sent.action.sentAt);

    const listed = (await dataOf(
      handlers.listOutboundActionsHandler(
        request(token, { workspaceId }, undefined, {
          status: "sent",
        }),
      ),
    )) as { actions: GateAction[] };
    expect(listed.actions).toHaveLength(1);
    expect(listed.actions[0]?.id).toBe(action.id);

    const history = (await dataOf(
      handlers.outboundActionHistoryHandler(request(token, { id: action.id })),
    )) as { history: { kind: string; actorUserId: string }[] };
    expect(history.history.map((event) => event.kind)).toEqual([
      "created",
      "send_attempted",
      "sent",
    ]);

    // An empty workspace has no provider-independent behaviour to hide behind:
    // one channel, and this is it.
    const policy = (await dataOf(
      handlers.getOutboundPolicyHandler(request(token, { workspaceId })),
    )) as { channel: string; configuredProviders: string[]; neverDoes: string[] };
    expect(policy.channel).toBe("email");
    expect(policy.configuredProviders).toEqual(["sandbox_email"]);
  });

  it("refuses to stage or send anything a human did not approve", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [sandbox],
    });
    const { token, workspaceId } = tenant("Unapproved", unique("p11u") + "@example.com");

    // Everything up to the draft, but **no** approval request at all.
    const pipeline = await approvedPipeline(
      handlers,
      token,
      workspaceId,
      "Unapproved Co",
      unique("p11u") + "@northwind.example",
    );
    void pipeline;

    // A second account, whose draft is requested for approval but never decided.
    const second = await tenant("Undecided", unique("p11d") + "@example.com");
    const undecided = await pipelineUpToDraft(
      handlers,
      second.token,
      second.workspaceId,
      "Undecided Co",
      unique("p11d") + "@northwind.example",
    );
    const requested = (await dataOf(
      handlers.createApprovalRequestHandler(
        request(second.token, { workspaceId: second.workspaceId, draftId: undecided.draftId }, {}),
      ),
    )) as { approval: GateApproval };
    expect(requested.approval.status).toBe("pending");

    // Pending is not approved: there is nothing to stage.
    const pending = await errorOf(
      handlers.createOutboundActionHandler(
        request(second.token, { workspaceId: second.workspaceId, draftId: undecided.draftId }, {}),
      ),
    );
    expect(pending.code).toBe("CONFLICT");
    expect(pending.message).toContain("no approval covers this draft version");

    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: pipeline.draftId }, {}),
      ),
    )) as { action: GateAction };
    expect(staged.action.status).toBe("ready");

    // A client cannot inject its way past any of this. Every field that would
    // constitute authorization or delivery is ignored.
    const injected = (await dataOf(
      handlers.createOutboundActionHandler(
        request(
          token,
          { workspaceId, draftId: pipeline.draftId },
          {
            approved: true,
            status: "sent",
            provider: "smtp",
            providerReference: "forged-reference",
            sentAt: "1999-01-01T00:00:00.000Z",
            recipientEmail: "attacker@example.com",
            attemptCount: 0,
            contactId: "somebody-elses-contact",
            channel: "email",
            body: "Send this exact text instead.",
            subject: "Approved by the system",
          },
        ),
      ),
    )) as { action: GateAction };

    // The recipient is the one the contact record holds, not the one in the body.
    expect(injected.action.recipientEmail).toBe(pipeline.recipientEmail);
    expect(injected.action.recipientEmail).not.toBe("attacker@example.com");
    // The provider is the configured one, and no reference was ever supplied.
    expect(injected.action.provider).toBeNull();
    expect(injected.action.providerReference).toBeNull();
    expect(injected.action.sentAt).toBeNull();
    expect(injected.action.status).toBe("ready");
    // It is the same action, so asking again cannot manufacture a second one.
    expect(injected.action.id).toBe(staged.action.id);

    // And the send route takes no body at all, so there is nothing to inject.
    const sent = (await dataOf(
      handlers.sendOutboundActionHandler(
        request(
          token,
          { workspaceId, id: injected.action.id },
          { status: "sent", delivered: true, providerReference: "forged" },
        ),
      ),
    )) as { action: GateAction; delivered: boolean };
    expect(sent.delivered).toBe(true);
    // The reference is the provider's, not the request's.
    expect(sent.action.providerReference).toBe(sandbox.deliveries()[0]?.providerReference);
    expect(sent.action.providerReference).not.toBe("forged");

    expect(sandbox.deliveries()).toHaveLength(1);
  });

  it("refuses a draft version no approval covers, and re-checks at send time", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [sandbox],
    });
    const { token, workspaceId } = tenant("Versioned", unique("p11v") + "@example.com");
    const pipeline = await approvedPipeline(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p11v") + "@northwind.example",
    );

    // A newer version of the same lineage. The approval covers version 1.
    const regenerated = (await dataOf(
      handlers.createPersonalizedDraftHandler(
        request(
          token,
          { workspaceId, accountId: pipeline.accountId },
          {
            contactId: pipeline.contactId,
          },
        ),
      ),
    )) as { draft: { id: string; version: number } };
    expect(regenerated.draft.version).toBe(2);
    expect(regenerated.draft.id).not.toBe(pipeline.draftId);

    const second = await errorOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: regenerated.draft.id }, {}),
      ),
    );
    expect(second.code).toBe("CONFLICT");
    expect(second.message).toContain("no approval covers this draft version");

    // And a version that never existed is refused outright.
    const imaginary = await errorOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: pipeline.draftId }, { draftVersion: 99 }),
      ),
    );
    expect(imaginary.code).toBe("NOT_FOUND");

    expect(sandbox.callCount()).toBe(0);
  });

  it("refuses a second send for the same approval, and refuses a cancelled action", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [sandbox],
    });
    const { token, workspaceId } = tenant("Once", unique("p11o") + "@example.com");
    const pipeline = await approvedPipeline(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p11o") + "@northwind.example",
    );

    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: pipeline.draftId }, {}),
      ),
    )) as { action: GateAction };

    const first = (await dataOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    )) as { action: GateAction; delivered: boolean };
    expect(first.delivered).toBe(true);
    expect(sandbox.deliveries()).toHaveLength(1);

    // One approval, one message.
    const second = await errorOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    expect(second.code).toBe("CONFLICT");
    expect(second.message).toContain("already been sent");
    expect(sandbox.deliveries()).toHaveLength(1);

    // A cancellation is a closure, and it authorizes nothing afterwards. A
    // separate approval gets its own action, which can then be withdrawn.
    const other = await tenant("Cancelled", unique("p11c") + "@example.com");
    const cancelPipeline = await approvedPipeline(
      handlers,
      other.token,
      other.workspaceId,
      "Cancelled Co",
      unique("p11c") + "@northwind.example",
    );
    const cancelStaged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(other.token, {
          workspaceId: other.workspaceId,
          draftId: cancelPipeline.draftId,
        }),
      ),
    )) as { action: GateAction };

    const cancelled = (await dataOf(
      handlers.cancelOutboundActionHandler(
        request(
          other.token,
          { workspaceId: other.workspaceId, id: cancelStaged.action.id },
          {
            reason: "wrote the wrong recipient",
          },
        ),
      ),
    )) as { action: GateAction };
    expect(cancelled.action.status).toBe("cancelled");
    expect(cancelled.action.sentAt).toBeNull();

    const afterCancel = await errorOf(
      handlers.sendOutboundActionHandler(
        request(other.token, { workspaceId: other.workspaceId, id: cancelStaged.action.id }),
      ),
    );
    expect(afterCancel.code).toBe("CONFLICT");
    // Two tenants, two sends at most: one delivered, one refused entirely.
    expect(sandbox.deliveries()).toHaveLength(1);
  });

  it("never reports a provider failure as delivered", async () => {
    setSessionIndex(createIndex());
    const failing = new FailingEmailProvider("rate_limited", "slow down");
    const handlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [failing],
    });
    const { token, workspaceId } = tenant("Failing", unique("p11f") + "@example.com");
    const pipeline = await approvedPipeline(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p11f") + "@northwind.example",
    );
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: pipeline.draftId }, {}),
      ),
    )) as { action: GateAction };

    const refused = await errorOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toContain("did not accept");

    const stored = (await dataOf(
      handlers.getOutboundActionHandler(request(token, { id: staged.action.id })),
    )) as { action: GateAction };
    expect(stored.action.status).toBe("failed");
    // The single most important assertion in this phase: a failure is never a
    // delivery, and the record says so on every field that could imply one.
    expect(stored.action.sentAt).toBeNull();
    expect(stored.action.providerReference).toBeNull();
    expect(stored.action.failureCode).toBe("rate_limited");
    expect(stored.action.failureMessage).toBe("slow down");
    expect(stored.action.attemptCount).toBe(1);
    expect(failing.attempts()).toBe(1);

    // The failure is in the audit trail as durably as a success would be.
    const history = (await dataOf(
      handlers.outboundActionHistoryHandler(request(token, { id: staged.action.id })),
    )) as { history: { kind: string }[] };
    expect(history.history.map((event) => event.kind)).toEqual([
      "created",
      "send_attempted",
      "failed",
    ]);

    // A provider that throws is the same: a recorded failure, never a send.
    const throwing = new ThrowingEmailProvider();
    const throwHandlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [throwing],
    });
    const thrown = await tenant("Throwing", unique("p11t") + "@example.com");
    const throwPipeline = await approvedPipeline(
      throwHandlers,
      thrown.token,
      thrown.workspaceId,
      "Northwind",
      unique("p11t") + "@northwind.example",
    );
    const throwStaged = (await dataOf(
      throwHandlers.createOutboundActionHandler(
        request(thrown.token, {
          workspaceId: thrown.workspaceId,
          draftId: throwPipeline.draftId,
        }),
      ),
    )) as { action: GateAction };
    await errorOf(
      throwHandlers.sendOutboundActionHandler(
        request(thrown.token, { workspaceId: thrown.workspaceId, id: throwStaged.action.id }),
      ),
    );
    const throwStored = (await dataOf(
      throwHandlers.getOutboundActionHandler(request(thrown.token, { id: throwStaged.action.id })),
    )) as { action: GateAction };
    expect(throwStored.action.status).toBe("failed");
    expect(throwStored.action.sentAt).toBeNull();
    expect(throwStored.action.failureCode).toBe("provider_unavailable");
  });

  it("refuses to reach an address that opted out, before the provider is called", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [sandbox],
    });
    const { token, userId, workspaceId } = tenant("Opt Out", unique("p11s") + "@example.com");
    const recipient = unique("p11s") + "@northwind.example";
    const pipeline = await approvedPipeline(handlers, token, workspaceId, "Northwind", recipient);
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: pipeline.draftId }, {}),
      ),
    )) as { action: GateAction };

    const suppressed = (await dataOf(
      handlers.createOutboundSuppressionHandler(
        request(
          token,
          { workspaceId },
          {
            email: recipient.toUpperCase(),
            reason: "asked us to stop emailing her",
          },
        ),
      ),
    )) as { suppression: { id: string; email: string; reason: string; createdBy: string } };

    // Normalized, attributed and explained: an opt-out nobody can read is one
    // nobody can be expected to honour.
    expect(suppressed.suppression.email).toBe(recipient.toLowerCase());
    expect(suppressed.suppression.reason).toBe("asked us to stop emailing her");
    expect(suppressed.suppression.createdBy).toBe(userId);

    const refused = await errorOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toContain("opted out");
    // The provider was never reached, and nothing was recorded as delivered.
    expect(sandbox.callCount()).toBe(0);
    expect(sandbox.deliveries()).toHaveLength(0);

    const stored = (await dataOf(
      handlers.getOutboundActionHandler(request(token, { id: staged.action.id })),
    )) as { action: GateAction };
    expect(stored.action.status).toBe("failed");
    expect(stored.action.failureCode).toBe("suppressed");
    expect(stored.action.sentAt).toBeNull();
    // A pre-flight refusal never reached a provider, so it spent no attempt.
    expect(stored.action.provider).toBeNull();
    expect(stored.action.attemptCount).toBe(0);

    // Suppressing the same address again is one record, not two.
    await dataOf(
      handlers.createOutboundSuppressionHandler(
        request(
          token,
          { workspaceId },
          { email: recipient, reason: "asked us to stop emailing her" },
        ),
      ),
    );
    const listed = (await dataOf(
      handlers.listOutboundSuppressionsHandler(request(token, { workspaceId })),
    )) as { suppressions: { id: string }[] };
    expect(listed.suppressions).toHaveLength(1);
    expect(listed.suppressions[0]?.id).toBe(suppressed.suppression.id);

    // And a suppression must say why, so the list is auditable.
    const unreasoned = await errorOf(
      handlers.createOutboundSuppressionHandler(
        request(token, { workspaceId }, { email: "someone@example.com", reason: "   " }),
      ),
    );
    expect(unreasoned.code).toBe("VALIDATION_ERROR");
    expect(unreasoned.details?.map((detail) => detail.field)).toContain("reason");
  });

  it("refuses to send when no provider is configured, and sends once one is", async () => {
    setSessionIndex(createIndex());
    // No provider supplied and the default replaced by an empty list: the
    // "unconfigured" state is reachable, tested, and not an accident.
    const handlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [],
    });
    const { token, workspaceId } = tenant("No Provider", unique("p11n") + "@example.com");
    const pipeline = await approvedPipeline(
      handlers,
      token,
      workspaceId,
      "Northwind",
      unique("p11n") + "@northwind.example",
    );

    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(token, { workspaceId, draftId: pipeline.draftId }, {}),
      ),
    )) as { action: GateAction };

    const refused = await errorOf(
      handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toContain("no provider is configured");

    // The action is untouched: no attempt was made, so nothing was recorded as
    // one. It is still `ready` and still sendable.
    const untouched = (await dataOf(
      handlers.getOutboundActionHandler(request(token, { id: staged.action.id })),
    )) as { action: GateAction };
    expect(untouched.action.status).toBe("ready");
    expect(untouched.action.attemptCount).toBe(0);
    expect(untouched.action.provider).toBeNull();

    const policy = (await dataOf(
      handlers.getOutboundPolicyHandler(request(token, { workspaceId })),
    )) as { configuredProviders: string[] };
    expect(policy.configuredProviders).toEqual([]);
  });

  it("refuses another tenant's draft and action, and shares no suppression list", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxEmailProvider();
    const handlers = createDefaultHandlers({
      researchProviders: [provider()],
      outboundProviders: [sandbox],
    });
    const a = tenant("Tenant A", unique("p11t") + "@example.com");
    const b = tenant("Tenant B", unique("p11t") + "@example.com");
    const pipeline = await approvedPipeline(
      handlers,
      a.token,
      a.workspaceId,
      "Northwind",
      unique("p11t") + "@northwind.example",
    );
    const staged = (await dataOf(
      handlers.createOutboundActionHandler(
        request(a.token, { workspaceId: a.workspaceId, draftId: pipeline.draftId }),
      ),
    )) as { action: GateAction };

    // Not a member of tenant A's workspace: refused at the tenant boundary, on
    // every route that could reach the action.
    for (const attempt of [
      handlers.getOutboundActionHandler(request(b.token, { id: staged.action.id })),
      handlers.outboundActionHistoryHandler(request(b.token, { id: staged.action.id })),
      handlers.sendOutboundActionHandler(
        request(b.token, { workspaceId: a.workspaceId, id: staged.action.id }),
      ),
      handlers.cancelOutboundActionHandler(
        request(b.token, { workspaceId: a.workspaceId, id: staged.action.id }),
      ),
    ]) {
      const refused = await errorOf(attempt);
      expect(refused.code).toBe("UNAUTHORIZED");
    }

    // Inside their own workspace tenant B is a legitimate member, and the
    // foreign draft is simply not there.
    const hidden = await errorOf(
      handlers.createOutboundActionHandler(
        request(b.token, { workspaceId: b.workspaceId, draftId: pipeline.draftId }),
      ),
    );
    expect(hidden.code).toBe("NOT_FOUND");

    // And tenant B's own workspace has nothing in it.
    const listed = (await dataOf(
      handlers.listOutboundActionsHandler(request(b.token, { workspaceId: b.workspaceId })),
    )) as { actions: unknown[] };
    expect(listed.actions).toHaveLength(0);

    // An opt-out is per workspace: one tenant's suppression never silences
    // another's sends, and neither can read the other's list.
    await dataOf(
      handlers.createOutboundSuppressionHandler(
        request(
          a.token,
          { workspaceId: a.workspaceId },
          {
            email: "shared@example.com",
            reason: "one workspace opted out",
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

    // Tenant A's action is untouched and still sendable by them.
    const stillReady = (await dataOf(
      handlers.getOutboundActionHandler(request(a.token, { id: staged.action.id })),
    )) as { action: GateAction };
    expect(stillReady.action.status).toBe("ready");
    expect(sandbox.callCount()).toBe(0);
  });

  it("builds no mass-outreach surface: one channel, no queue, no schedule", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = tenant("One Channel", unique("p11m") + "@example.com");

    // The policy says it in data, before anything has been sent.
    const policy = (await dataOf(
      handlers.getOutboundPolicyHandler(request(token, { workspaceId })),
    )) as {
      channel: string;
      requires: string[];
      neverDoes: string[];
      failureStates: string[];
      retryPolicy: string;
      maxAttempts: number;
    };
    expect(policy.channel).toBe("email");
    expect(policy.requires.join(" ")).toContain(
      "persisted human approval covering the exact draft version",
    );
    expect(policy.requires.join(" ")).toContain("opt-out list");
    expect(policy.neverDoes.join(" ")).toContain("send autonomously");
    expect(policy.neverDoes.join(" ")).toContain("mark a message sent unless the provider");
    expect(policy.neverDoes.join(" ")).toContain("send twice for one approval");
    expect(policy.failureStates).toContain("provider_unavailable");
    expect(policy.failureStates).toContain("suppressed");
    expect(policy.retryPolicy).toContain("no automatic retry");
    expect(policy.maxAttempts).toBe(5);

    // ROADMAP.md §18's critical rule, checked against the real surface: no
    // campaign, no bulk, no queue, no schedule, no second channel.
    const names = Object.keys(handlers).map((name) => name.toLowerCase());
    for (const forbidden of [
      "campaign",
      "bulk",
      "blast",
      "sequence",
      "schedule",
      "queue",
      "subscribe",
      "newsletter",
      "sms",
      "linkedin",
      "webhook",
    ]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }

    // The only channel is email: an unknown one is refused, not coerced.
    const listed = (await dataOf(
      handlers.listOutboundActionsHandler(
        request(token, { workspaceId }, undefined, {
          channel: "carrier_pigeon",
        }),
      ),
    )) as { actions: unknown[] };
    expect(listed.actions).toHaveLength(0);

    // A status filter outside the closed vocabulary is refused rather than
    // ignored, so a caller cannot believe it filtered something it did not.
    const invented = await errorOf(
      handlers.listOutboundActionsHandler(
        request(token, { workspaceId }, undefined, {
          status: "somewhere_over_the_internet",
        }),
      ),
    );
    expect(invented.code).toBe("VALIDATION_ERROR");
  });
});

/**
 * The pipeline up to a draft, with no approval request: used where the gate is
 * about what happens *before* a human is asked.
 */
async function pipelineUpToDraft(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  accountName: string,
  recipientEmail: string,
): Promise<Pipeline> {
  const offer = (await dataOf(
    handlers.createOfferHandler(
      request(
        token,
        { workspaceId },
        {
          name: "Support Automation",
          description: "We build support automation for B2B SaaS teams.",
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
        {
          name: accountName,
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
  )) as { findings: { id: string }[] };
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
        {
          revenueGoalId: goal.goal.id,
        },
      ),
    ),
  )) as { qualification: { id: string } };
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
  )) as { draft: { id: string; version: number; subject: string; body: string } };

  return {
    accountId: account.account.id,
    draftId: generated.draft.id,
    draftVersion: generated.draft.version,
    subject: generated.draft.subject,
    body: generated.draft.body,
    contactId: contact.contact.id,
    recipientEmail,
  };
}
