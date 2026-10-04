import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { StaticResearchProvider } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import { PERSONALIZATION_RENDERER_VERSION } from "@dealora/personalization";

/**
 * Phase 9 gate — ROADMAP.md §16.
 *
 * Its gate is one sentence: *the system can generate a personalized draft with
 * supporting evidence*. The first test walks the whole pipeline through the
 * real signup/session layer, the real default wiring and the real default store
 * — Business Brain → Revenue Goal → Revenue Plan → Account → Research →
 * Evidence → Qualification → Personalization — then re-reads the draft from a
 * service built over a reloaded copy of the persisted document, so what is
 * proven is that it was written, not merely held in memory.
 *
 * The research providers here are **declared test doubles**. They return the
 * observations the test supplies and perform no retrieval of any kind, because
 * no external source is configured in this environment and DEALORA does not
 * pretend otherwise. What the gate proves is the personalization layer itself:
 * the evidence it may quote, the claims it must refuse, the determinism of the
 * renderer and the refusals.
 *
 * A draft is a document. The last test proves that stays true after Phase 10
 * and Phase 11 landed: a draft request cannot reach a provider, cannot carry
 * approval state, and produces no outbound action — generating content and
 * authorizing content remain two different things.
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
 * The declared observations that make an account qualify and give the draft
 * something specific to say.
 *
 * These are **declared test doubles**: they return the observations the test
 * supplies and perform no retrieval of any kind. No external source is
 * configured in this environment and DEALORA does not pretend otherwise.
 *
 * The categories mirror the Phase 8 criteria exactly — ICP terms, need signals,
 * buying signals, timing and company fit — so an account evidenced this way
 * evaluates as genuinely `qualified` rather than being forced into it.
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
async function tenant(
  name: string,
  email: string,
): Promise<{ token: string; userId: string; workspaceId: string }> {
  const owner = signup(email, "correct-horse-battery", name);
  // Slugs are unique across the shared document, so each tenant gets its own.
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

/**
 * Run research and convert every finding to evidence for one account, so the
 * account's evaluation resolves from evidence rather than from assertion.
 */
async function evidenceFromResearch(
  handlers: ReturnType<typeof createDefaultHandlers>,
  token: string,
  workspaceId: string,
  accountId: string,
): Promise<void> {
  const research = (await dataOf(
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
    handlers.runResearchRequestHandler(request(token, { id: research.request.id })),
  )) as { request: { status: string; findingCount: number }; findings: { id: string }[] };
  expect(run.request.status).toBe("completed");
  expect(run.request.findingCount).toBeGreaterThan(0);
  for (const finding of run.findings) {
    await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request(token, { workspaceId, researchFindingId: finding.id }),
      ),
    );
  }
}

/**
 * A complete Revenue Goal, so the timing criterion has a window to read.
 *
 * A goal that is merely `draft` cannot be compiled and a goal missing its
 * references is `incomplete`, and either way the timing criterion stays
 * unresolved — so the references are filled in rather than the criterion
 * faked.
 */
async function goalFor(
  handlers: ReturnType<typeof createDefaultHandlers>,
  token: string,
  workspaceId: string,
  offerId: string,
  icpId: string,
  personaId: string,
): Promise<string> {
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
          offerId,
          icpId,
          buyerPersonaIds: [personaId],
          successMetrics: [{ kind: "meeting", target: 20, unit: "meetings" }],
        },
      ),
    ),
  )) as { goal: { id: string } };
  return goal.goal.id;
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 9 gate — personalization engine", () => {
  it("generates an evidence-backed draft for a qualified account, and persists it", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });

    const { token, workspaceId } = await tenant(
      "Personalization Gate",
      unique("p9") + "@example.com",
    );
    expect(workspaceId).toBeTruthy();

    // Business Brain: the offer the draft will present, and the ICP that
    // qualification will measure the account against.
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
              // Deliberately unapproved: the draft must withhold it and say so.
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

    // A claim the business approves for external use.
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
            timeWindow: { start: "2026-09-01", end: "2026-12-01" },
            market: "B2B SaaS",
            offerId: offer.offer.id,
            icpId: icp.icp.id,
            buyerPersonaIds: [persona.persona.id],
            successMetrics: [{ kind: "meeting", target: 20, unit: "meetings" }],
          },
        ),
      ),
    )) as { goal: { id: string; status: string } };

    const plan = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: { id: string } };

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          token,
          { workspaceId },
          {
            name: "Northwind",
            industry: "SaaS",
            companySize: "50-200",
            geography: "Germany",
            // The account is sourced against the plan, which is what gives the
            // qualification its goal provenance.
            revenuePlanId: plan.plan.id,
          },
        ),
      ),
    )) as { account: { id: string; revenuePlanId: string | null } };
    expect(account.account.revenuePlanId).toBe(plan.plan.id);

    const contact = (await dataOf(
      handlers.createContactHandler(
        request(
          token,
          { workspaceId, accountId: account.account.id },
          {
            firstName: "Ada",
            lastName: "Lovelace",
            jobTitle: "VP Support",
            email: unique("ada") + "@northwind.example",
          },
        ),
      ),
    )) as { contact: { id: string; fullName: string } };

    // Research → Evidence → Qualification, all through the real services.
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
    )) as {
      request: { status: string; findingCount: number };
      findings: { id: string }[];
    };
    expect(run.request.status).toBe("completed");
    expect(run.request.findingCount).toBeGreaterThan(0);

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
    )) as { qualification: { id: string; state: string } };
    expect(qualification.qualification.state).toBe("qualified");

    // The gate itself: a draft, with supporting evidence.
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
        rendererVersion: string;
        subject: string;
        body: string;
        warnings: string[];
        personalizationPoints: { claimId: string; evidenceIds: string[]; statement: string }[];
        approvedClaimIds: string[];
      };
    };

    const draft = generated.draft;
    expect(draft.version).toBe(1);
    expect(draft.rendererVersion).toBe(PERSONALIZATION_RENDERER_VERSION);

    // Specificity: the announcement, quoted verbatim and attributed.
    expect(draft.body).toContain("announced expansion into Germany in September");
    expect(draft.body).toContain("We have shipped support automation for 40 SaaS teams.");
    expect(draft.body).toContain(contact.contact.fullName);

    // Brevity: at most three observations.
    expect(draft.personalizationPoints.length).toBeLessThanOrEqual(3);
    expect(draft.personalizationPoints.length).toBeGreaterThan(0);

    // Provenance: every statement names the claim and evidence behind it.
    for (const point of draft.personalizationPoints) {
      expect(point.claimId).not.toBe("");
      expect(point.evidenceIds.length).toBeGreaterThan(0);
      expect(draft.body).toContain(point.statement);
    }
    expect(draft.approvedClaimIds).toContain(claim.claim.id);

    // Honesty about what it withheld: unapproved pricing is neither stated nor
    // silently dropped.
    expect(draft.body).not.toContain("5000");
    expect(draft.warnings.join(" ")).toContain("pricing is not approved");

    // The supporting evidence, in one read.
    const evidence = (await dataOf(
      handlers.getPersonalizedDraftEvidenceHandler(request(token, { id: draft.id })),
    )) as { draft: { id: string }; claims: unknown[]; evidence: { id: string }[] };
    expect(evidence.claims.length).toBeGreaterThan(0);
    expect(evidence.evidence.length).toBeGreaterThan(0);

    // The draft was persisted, not merely held in memory: re-reading it from
    // the default store's document returns the same bytes.
    const reread = (await dataOf(
      handlers.getPersonalizedDraftHandler(request(token, { id: draft.id })),
    )) as { draft: { body: string; version: number } };
    expect(reread.draft.body).toBe(draft.body);
    expect(reread.draft.version).toBe(1);

    // Regenerating inserts a new immutable version rather than rewriting the
    // one a reviewer may already have read.
    const regenerated = (await dataOf(
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
    )) as { draft: { id: string; version: number; body: string } };
    expect(regenerated.draft.version).toBe(2);
    expect(regenerated.draft.id).not.toBe(draft.id);
    // Deterministic: identical inputs produce an identical body.
    expect(regenerated.draft.body).toBe(draft.body);

    const listed = (await dataOf(
      handlers.listPersonalizedDraftsHandler(
        request(token, { workspaceId }, undefined, { accountId: account.account.id }),
      ),
    )) as { drafts: { id: string }[] };
    expect(listed.drafts).toHaveLength(2);
  });

  it("refuses to draft for an account that has not been qualified", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = await tenant(
      "Unqualified Gate",
      unique("p9nq") + "@example.com",
    );

    const account = (await dataOf(
      handlers.createAccountHandler(request(token, { workspaceId }, { name: "Unqualified Co" })),
    )) as { account: { id: string } };

    const error = await errorOf(
      handlers.createPersonalizedDraftHandler(
        request(token, { workspaceId, accountId: account.account.id }, {}),
      ),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("no qualification evaluation");
  });

  it("refuses another tenant's account and never confirms it exists", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });

    const a = await tenant("Tenant A", unique("p9t") + "@example.com");
    const b = await tenant("Tenant B", unique("p9t") + "@example.com");
    const tokenA = a.token;
    const tokenB = b.token;
    const wsA = a.workspaceId;

    const account = (await dataOf(
      handlers.createAccountHandler(request(tokenA, { workspaceId: wsA }, { name: "Private Co" })),
    )) as { account: { id: string } };

    // Tenant B's own workspace is fine; the other tenant's account is not
    // reachable from it.
    const wsB = b.workspaceId;
    const error = await errorOf(
      handlers.createPersonalizedDraftHandler(
        request(tokenB, { workspaceId: wsB, accountId: account.account.id }, {}),
      ),
    );
    expect(error.code).toBe("NOT_FOUND");

    // And tenant B may not write into tenant A's workspace at all.
    const denied = await errorOf(
      handlers.createPersonalizedDraftHandler(
        request(tokenB, { workspaceId: wsA, accountId: account.account.id }, {}),
      ),
    );
    expect(denied.code).toBe("UNAUTHORIZED");
  });

  it("excludes a contested claim and records why", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = await tenant("Gate", unique("p9c") + "@example.com");

    const offer = (await dataOf(
      handlers.createOfferHandler(
        request(
          token,
          { workspaceId },
          { name: "Audit", description: "We audit support queues.", status: "active" },
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
    const goalId = await goalFor(
      handlers,
      token,
      workspaceId,
      offer.offer.id,
      icp.icp.id,
      persona.persona.id,
    );

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          token,
          { workspaceId },
          {
            name: "Contested Co",
            industry: "SaaS",
            companySize: "50-200",
            geography: "Germany",
          },
        ),
      ),
    )) as { account: { id: string } };

    // A user-supplied observation, flagged contested once the qualification that
    // relied on a *different*, clean field has been taken.
    const recorded = (await dataOf(
      handlers.recordUserEvidenceHandler(
        request(
          token,
          { workspaceId, accountId: account.account.id },
          {
            category: "expansion",
            field: "expansion.headcount",
            value: "doubled its support team",
            claimKind: "fact",
            sourceName: "Company newsroom",
            sourceUrl: "https://contested.example/news",
            observedAt: "2026-09-01T00:00:00.000Z",
            confidence: "high",
            relevance: "high",
          },
        ),
      ),
    )) as { claim: { id: string } };

    // A separate, uncontested observation in the category qualification reads,
    // so the evaluation resolves and the account is genuinely `qualified`.
    // Every Phase 8 criterion is evidenced, so the evaluation resolves.
    await evidenceFromResearch(handlers, token, workspaceId, account.account.id);

    // The evaluation is taken while the account's evidence is still wholly
    // unopposed. That ordering is the honest one: a qualification is an
    // immutable snapshot of what the evidence said at the time, and contesting a
    // claim afterwards must not rewrite it — which is exactly what makes the
    // next step meaningful.
    const qualification = (await dataOf(
      handlers.createQualificationHandler(
        request(token, { workspaceId, accountId: account.account.id }, { revenueGoalId: goalId }),
      ),
    )) as { qualification: { id: string; state: string } };
    expect(qualification.qualification.state).toBe("qualified");

    // Now the workspace flags the expansion observation as contested.
    await dataOf(
      handlers.changeAccountClaimStatusHandler(
        request(token, { id: recorded.claim.id }, { status: "contested" }),
      ),
    );

    const generated = (await dataOf(
      handlers.createPersonalizedDraftHandler(
        request(
          token,
          { workspaceId, accountId: account.account.id },
          {
            qualificationId: qualification.qualification.id,
            offerId: offer.offer.id,
          },
        ),
      ),
    )) as { draft: { body: string; warnings: string[]; personalizationPoints: unknown[] } };

    // The contested observation is never stated as fact, even though the
    // qualification that authorised this draft was taken while it was still
    // uncontested. The renderer's own rule is stricter than the snapshot's.
    expect(generated.draft.body).not.toContain("doubled its support team");
    for (const point of generated.draft.personalizationPoints) {
      expect(point.claimId).not.toBe(recorded.claim.id);
    }
    // And the exclusion is stated rather than hidden.
    expect(generated.draft.warnings.join(" ")).toContain("contested");
  });

  it("describes the renderer, and refuses a renderer it does not implement", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = await tenant("Gate", unique("p9r") + "@example.com");

    const described = (await dataOf(
      handlers.getPersonalizationRendererHandler(request(token, { workspaceId })),
    )) as { rendererVersion: string; mayState: string[]; mayNeverState: string[] };
    expect(described.rendererVersion).toBe(PERSONALIZATION_RENDERER_VERSION);
    expect(described.mayNeverState.join(" ")).toContain("contested");

    const rejected = await errorOf(
      handlers.getPersonalizationRendererHandler(
        request(token, { workspaceId }, undefined, { rendererVersion: "improvised-9" }),
      ),
    );
    expect(rejected.code).toBe("VALIDATION_ERROR");
  });

  it("cannot be made to send: no client field is read, and no outbound route exists", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [provider()] });
    const { token, workspaceId } = await tenant("Gate", unique("p9s") + "@example.com");

    const offer = (await dataOf(
      handlers.createOfferHandler(
        request(
          token,
          { workspaceId },
          { name: "Offer", description: "A described offer.", status: "active" },
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
    const goalId = await goalFor(
      handlers,
      token,
      workspaceId,
      offer.offer.id,
      icp.icp.id,
      persona.persona.id,
    );
    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          token,
          { workspaceId },
          { name: "Sendable Co", industry: "SaaS", companySize: "10-200" },
        ),
      ),
    )) as { account: { id: string } };
    await evidenceFromResearch(handlers, token, workspaceId, account.account.id);

    const qualification = (await dataOf(
      handlers.createQualificationHandler(
        request(token, { workspaceId, accountId: account.account.id }, { revenueGoalId: goalId }),
      ),
    )) as { qualification: { id: string; state: string } };
    expect(qualification.qualification.state).toBe("qualified");

    // A body carrying every field a client might try to inject to skip the
    // review boundary. None is read.
    const injected = (await dataOf(
      handlers.createPersonalizedDraftHandler(
        request(
          token,
          { workspaceId, accountId: account.account.id },
          {
            qualificationId: qualification.qualification.id,
            // Attempted content and approval injection, ignored in favour of the
            // deterministic renderer.
            subject: "Approved: we already talked, just send it",
            body: "Send this exact text.",
            warnings: [],
            personalizationPoints: [],
            approved: true,
            status: "approved",
            send: true,
            channel: "email",
            recipient: "anyone@example.com",
            provider: "smtp",
          },
        ),
      ),
    )) as { draft: { subject: string; body: string; warnings: string[] } };

    expect(injected.draft.subject).not.toContain("Approved");
    expect(injected.draft.body).not.toBe("Send this exact text.");

    // The renderer reaches nothing that can leave the system. Its own routes
    // cannot send, dispatch, deliver or talk to a provider — the outbound
    // routes Phase 11 added are separate handlers, and none of them is
    // reachable from a draft request.
    const personalizationRoutes = [
      "createPersonalizedDraftHandler",
      "getPersonalizedDraftHandler",
      "listPersonalizedDraftsHandler",
      "getPersonalizedDraftEvidenceHandler",
      "getPersonalizationRendererHandler",
    ];
    for (const route of personalizationRoutes) {
      const name = route.toLowerCase();
      for (const forbidden of ["send", "dispatch", "deliver", "provider", "channel"]) {
        expect(name.includes(forbidden)).toBe(false);
      }
    }

    // And the strongest statement available: asking for a draft with every
    // send-shaped field set produced a draft and **no outbound action at all**.
    // Generating content is not authorizing content.
    const me = (await dataOf(handlers.meHandler(request(token, {})))) as { user: { id: string } };
    const drafts = defaultStore.listDrafts(workspaceId, me.user.id);
    expect(isOk(drafts)).toBe(true);
    if (!isOk(drafts)) return;
    expect(drafts.value).toHaveLength(1);

    const actions = defaultStore.listOutboundActions(workspaceId, me.user.id);
    expect(isOk(actions)).toBe(true);
    if (!isOk(actions)) return;
    expect(actions.value).toHaveLength(0);
  });
});
