import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { Store, store as defaultStore } from "@dealora/db";
import type { Account, ResearchFinding, RevenueGoal, RevenuePlan } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import {
  AccountRecordProvider,
  StaticResearchProvider,
  createResearchService,
} from "@dealora/research";
import type { ResearchProvider, ResearchRepository } from "@dealora/research";

/**
 * Phase 6 gate — ROADMAP.md §13.
 *
 * A target account must be able to receive an account brief in which every
 * statement is traceable back to the permitted source that made it.
 *
 * The first test walks the whole path through the real signup/session layer,
 * the real default wiring and the real default store, then re-reads the
 * findings from a service built over the persisted document to prove they were
 * written, not merely held in memory.
 *
 * The provider used here is a **declared test double**. It returns observations
 * the test supplies and performs no retrieval of any kind, because no external
 * research source is configured in this environment and DEALORA does not
 * pretend otherwise. What the gate proves is the engine: the request, the
 * lifecycle, the provenance, the isolation and the refusals.
 *
 * Research is not evidence, not a score and not outreach, and the last two
 * tests prove no such behaviour exists.
 */

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
  if (resolved.ok) throw new Error("expected the handler to fail");
  return resolved.error;
}

interface ResearchRow {
  id: string;
  workspaceId: string;
  accountId: string;
  requestedBy: string;
  provider: string;
  status: string;
  categories: string[];
  findingCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface ImportOutcome {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  results: { row: number; status: string; id?: string; reason?: string; field?: string }[];
}

/** A service over a reloaded copy of the persisted document. */
function reloadedResearchService(store: Store) {
  return createResearchService(
    store as unknown as ResearchRepository,
    [new AccountRecordProvider()],
    () => new Date("2026-10-03T12:00:00.000Z"),
  );
}

/**
 * The permitted public source this gate runs against.
 *
 * A declared provider over fixture observations: no network call, no crawler,
 * no credential, and no claim that any real page was read.
 */
function declaredPublicProvider(): ResearchProvider {
  return new StaticResearchProvider("permitted_public_site", "public_web", [
    {
      category: "company_overview",
      field: "company_overview.summary",
      value: "The site describes a wholesale trading business serving UK retailers.",
      claimKind: "fact",
      sourceUrl: "https://northwind.example/about",
      sourceTitle: "About page",
      observedAt: "2026-09-01T00:00:00.000Z",
      confidence: "medium",
      relevance: "high",
      note: null,
    },
    {
      category: "products_services",
      field: "products_services.offerings",
      value: "Three service tiers are listed on the services page.",
      claimKind: "inference",
      sourceUrl: "https://northwind.example/services",
      sourceTitle: "Services page",
      observedAt: "2026-01-15T00:00:00.000Z",
      confidence: "low",
      relevance: "medium",
      note: "Stated by the source; not checked against a contract.",
    },
    {
      category: "hiring",
      field: "hiring.open_roles",
      // No citation: the source did not supply one, and DEALORA does not
      // invent one to fill the gap.
      value: "Two roles are advertised on the careers page.",
      claimKind: "fact",
      observedAt: null,
      confidence: "low",
      relevance: "low",
      note: null,
    },
  ]);
}

describe("Phase 6 gate", () => {
  // The auth layer and the default wiring are bound to the default store
  // singleton, so the end-to-end path must use it too.
  afterAll(() => {
    defaultStore.destroy();
  });

  it("authenticated user → workspace → revenue plan → account → research request → permitted provider → findings → reload → attribution and timestamps preserved", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const handlers = createDefaultHandlers({
      researchProviders: [declaredPublicProvider()],
    });

    // 1. Authenticate for real.
    const owner = signup("gate-research@example.com", "correct-horse-battery", "Owner R");
    const token = owner.token;
    expect(token).toBeTruthy();

    // 2. Workspace as the tenant boundary.
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Research Acme" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;

    // 3. A RevenuePlan, so the account has a plan behind it.
    await dataOf(
      handlers.upsertCompanyHandler(
        request(
          token,
          { workspaceId },
          { name: "Research Gate Corp", description: "Revenue operations", market: "Wholesale" },
        ),
      ),
    );
    const offer = (await dataOf(
      handlers.createOfferHandler(
        request(
          token,
          { workspaceId },
          { name: "AI automation", description: "Automates revenue" },
        ),
      ),
    )) as { offer: { id: string } };
    const icp = (await dataOf(
      handlers.upsertIcpHandler(request(token, { workspaceId }, { industries: ["Wholesale"] })),
    )) as { icp: { id: string } };
    const persona = (await dataOf(
      handlers.createPersonaHandler(request(token, { workspaceId }, { title: "Head of Revenue" })),
    )) as { persona: { id: string } };
    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Generate $80,000 of pipeline from UK wholesale accounts",
            targetMetric: "pipeline",
            targetValue: 80000,
            currency: "USD",
            timeWindow: { start: "2026-03-01", end: "2026-06-01" },
            market: "Wholesale",
            offerId: offer.offer.id,
            icpId: icp.icp.id,
            buyerPersonaIds: [persona.persona.id],
            successMetrics: [{ kind: "pipeline", target: 80000, unit: "USD" }],
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    const plan = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: RevenuePlan };

    // 4. An existing Phase 5 account, imported and linked to that plan.
    const imported = (await dataOf(
      handlers.importAccountsHandler(
        request(
          token,
          { workspaceId },
          {
            csv: [
              "name,website,industry,company_size,geography,source_reference",
              "Northwind Trading,https://northwind.example,Wholesale,120,UK,q1-target-list.csv",
            ].join("\n"),
            revenuePlanId: plan.plan.id,
          },
        ),
      ),
    )) as ImportOutcome;
    expect(imported.created).toBe(1);
    const account = (await dataOf(
      handlers.listAccountsHandler(request(token, { workspaceId })),
    )) as { accounts: Account[] };
    const northwind = account.accounts[0];
    expect(northwind?.revenuePlanId).toBe(plan.plan.id);

    // 5. Ask for research. The account already exists; research never creates
    //    one as a side effect.
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          token,
          { workspaceId, accountId: northwind?.id ?? "" },
          { provider: "permitted_public_site" },
        ),
      ),
    )) as { request: ResearchRow };
    expect(created.request.status).toBe("pending");
    expect(created.request.workspaceId).toBe(workspaceId);
    expect(created.request.accountId).toBe(northwind?.id);
    expect(created.request.requestedBy).toBe(owner.user.id);
    expect(created.request.findingCount).toBe(0);

    // 6. Run it against the permitted provider.
    const run = (await dataOf(
      handlers.runResearchRequestHandler(request(token, { id: created.request.id })),
    )) as { request: ResearchRow; findings: ResearchFinding[] };
    expect(run.request.status).toBe("completed");
    expect(run.request.failureCode).toBeNull();
    expect(run.findings).toHaveLength(3);

    // 7. Every question the phase must answer can be answered.
    //    Which source said it, and where?
    const sources = new Set(run.findings.map((f) => f.sourceName));
    expect(sources).toEqual(new Set(["permitted_public_site"]));
    expect(run.findings.every((f) => f.source === "public_web")).toBe(true);
    const cited = run.findings.find((f) => f.field === "company_overview.summary");
    expect(cited?.sourceUrl).toBe("https://northwind.example/about");
    expect(cited?.sourceTitle).toBe("About page");
    //     When was it observed, and when did DEALORA retrieve it?
    expect(cited?.observedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(cited?.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    //     A dated observation always carries a real freshness band.
    expect(cited?.freshness).not.toBe("unknown");
    //     What kind of statement is it? Inference is never filed as fact.
    const inferred = run.findings.find((f) => f.field === "products_services.offerings");
    expect(inferred?.claimKind).toBe("inference");
    //     The older an observation, the less fresh it is. The exact bands are
    //     asserted against a fixed clock in the domain tests; here the
    //     ordering is what the brief must preserve.
    const freshnessRank: Record<string, number> = {
      fresh: 0,
      recent: 1,
      stale: 2,
      unknown: 3,
    };
    expect(freshnessRank[inferred?.freshness ?? ""]).toBeGreaterThan(
      freshnessRank[cited?.freshness ?? ""],
    );
    //     A source that supplied no citation gets none invented.
    const uncited = run.findings.find((f) => f.field === "hiring.open_roles");
    expect(uncited?.sourceUrl).toBeNull();
    expect(uncited?.source).toBe("public_web");
    expect(uncited?.sourceName).toBe("permitted_public_site");
    //     When the source gave no observation date, no currency is claimed.
    expect(uncited?.freshness).toBe("unknown");
    //     Every finding belongs to the account and workspace researched.
    expect(run.findings.every((f) => f.accountId === northwind?.id)).toBe(true);
    expect(run.findings.every((f) => f.workspaceId === workspaceId)).toBe(true);
    //     And the request records how the run went.
    expect(run.request.findingCount).toBe(3);
    expect(run.request.startedAt).toBeTruthy();
    expect(run.request.completedAt).toBeTruthy();

    // 8. Persistence: a service over the reloaded document sees everything.
    const reloadedStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const reloaded = reloadedResearchService(reloadedStore);
    const persisted = reloaded.listFindingsForRequest(created.request.id, owner.user.id);
    if (!isOk(persisted)) throw new Error("reload read failed");
    expect(persisted.value).toHaveLength(3);
    // Attribution and timestamps survive the round trip byte for byte.
    for (const finding of run.findings) {
      const stored = persisted.value.find((f) => f.field === finding.field);
      expect(stored?.source).toBe(finding.source);
      expect(stored?.sourceName).toBe(finding.sourceName);
      expect(stored?.sourceUrl).toBe(finding.sourceUrl);
      expect(stored?.observedAt).toBe(finding.observedAt);
      expect(stored?.retrievedAt).toBe(finding.retrievedAt);
      expect(stored?.claimKind).toBe(finding.claimKind);
      expect(stored?.confidence).toBe(finding.confidence);
      expect(stored?.freshness).toBe(finding.freshness);
      expect(stored?.relevance).toBe(finding.relevance);
    }
    const reloadedRequest = reloaded.getResearchRequest(created.request.id, owner.user.id);
    if (!isOk(reloadedRequest)) throw new Error("reload read failed");
    expect(reloadedRequest.value.status).toBe("completed");
    expect(reloadedRequest.value.findingCount).toBe(3);

    // The brief is readable through the API too, still attributed.
    const findings = (await dataOf(
      handlers.getResearchFindingsHandler(request(token, { id: created.request.id })),
    )) as { findings: ResearchFinding[] };
    expect(findings.findings).toHaveLength(3);
    expect(findings.findings.every((f) => f.sourceName === "permitted_public_site")).toBe(true);
  });

  it("enforces workspace authorization and ignores client-supplied identity", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [declaredPublicProvider()],
    });

    const ownerA = signup("gate-research-a@example.com", "correct-horse-battery", "Owner A");
    const ownerB = signup("gate-research-b@example.com", "correct-horse-battery", "Owner B");
    // The default store is one shared document: workspace slugs must not
    // collide with any other gate suite.
    const wsA = defaultStore.createWorkspace({ ownerId: ownerA.user.id, name: "Research Globex" });
    const wsB = defaultStore.createWorkspace({ ownerId: ownerB.user.id, name: "Research Initech" });
    if (!isOk(wsA) || !isOk(wsB)) throw new Error("fixture workspaces failed");

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id },
          { name: "Confidential Trading", website: "https://confidential.example" },
        ),
      ),
    )) as { account: Account };
    const requestRow = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id, accountId: account.account.id },
          { provider: "permitted_public_site" },
        ),
      ),
    )) as { request: ResearchRow };
    await dataOf(
      handlers.runResearchRequestHandler(request(ownerA.token, { id: requestRow.request.id })),
    );

    // User B cannot reach the research, its findings or its account.
    const denials = await Promise.all([
      errorOf(
        handlers.getResearchRequestHandler(request(ownerB.token, { id: requestRow.request.id })),
      ),
      errorOf(
        handlers.runResearchRequestHandler(request(ownerB.token, { id: requestRow.request.id })),
      ),
      errorOf(
        handlers.cancelResearchRequestHandler(request(ownerB.token, { id: requestRow.request.id })),
      ),
      errorOf(
        handlers.getResearchFindingsHandler(request(ownerB.token, { id: requestRow.request.id })),
      ),
      errorOf(
        handlers.listResearchRequestsHandler(request(ownerB.token, { workspaceId: wsA.value.id })),
      ),
      errorOf(
        handlers.createResearchRequestHandler(
          request(
            ownerB.token,
            { workspaceId: wsB.value.id, accountId: account.account.id },
            { provider: "permitted_public_site" },
          ),
        ),
      ),
    ]);
    for (const denial of denials) {
      // A foreign account is not even revealed to exist.
      expect(["UNAUTHORIZED", "NOT_FOUND"]).toContain(denial.code);
      expect(JSON.stringify(denial)).not.toContain("confidential.example");
    }

    // A workspace or user named in the body is ignored: the route's workspace
    // and the token's user win.
    const ignored = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id, accountId: account.account.id },
          {
            provider: "account_record",
            workspaceId: wsB.value.id,
            userId: ownerB.user.id,
          },
        ),
      ),
    )) as { request: ResearchRow };
    expect(ignored.request.workspaceId).toBe(wsA.value.id);
    expect(ignored.request.requestedBy).toBe(ownerA.user.id);
    const bView = (await dataOf(
      handlers.listResearchRequestsHandler(request(ownerB.token, { workspaceId: wsB.value.id })),
    )) as { requests: ResearchRow[] };
    expect(bView.requests).toEqual([]);
  });

  it("refuses unpermitted sources, malformed output and duplicate active work", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const owner = signup("gate-research-refusals@example.com", "correct-horse-battery", "Owner R");
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Research Refusals" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;
    const handlers = createDefaultHandlers({
      researchProviders: [declaredPublicProvider()],
    });

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          owner.token,
          { workspaceId },
          { name: "Refusal Industries", website: "https://refusal.example" },
        ),
      ),
    )) as { account: Account };

    // A source DEALORA does not have is refused, never simulated.
    const unpermitted = await errorOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "linkedin_scrape" },
        ),
      ),
    );
    expect(unpermitted.code).toBe("VALIDATION_ERROR");

    // A malformed observation fails the run and is recorded as such.
    const malformed = new StaticResearchProvider("broken_source", "public_web", [
      { category: "company_overview", field: "summary", value: 42 },
    ] as never);
    const brokenHandlers = createDefaultHandlers({ researchProviders: [malformed] });
    const broken = (await dataOf(
      brokenHandlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "broken_source" },
        ),
      ),
    )) as { request: ResearchRow };
    const brokenRun = (await dataOf(
      brokenHandlers.runResearchRequestHandler(request(owner.token, { id: broken.request.id })),
    )) as { request: ResearchRow; findings: ResearchFinding[] };
    expect(brokenRun.request.status).toBe("failed");
    expect(brokenRun.request.failureCode).toBe("invalid_provider_output");
    expect(brokenRun.findings).toEqual([]);
    // Nothing partial was persisted.
    expect(
      store.db.researchFindings.filter((f) => f.researchRequestId === broken.request.id),
    ).toEqual([]);

    // A second active request for the same account and provider is refused.
    const first = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "account_record" },
        ),
      ),
    )) as { request: ResearchRow };
    const duplicate = await errorOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "account_record" },
        ),
      ),
    );
    expect(duplicate.code).toBe("CONFLICT");
    // Replaying the same idempotency key returns the original request rather
    // than starting a second one.
    const replay = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "permitted_public_site", idempotencyKey: "q1-refresh" },
        ),
      ),
    )) as { request: ResearchRow };
    const replayed = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "permitted_public_site", idempotencyKey: "q1-refresh" },
        ),
      ),
    )) as { request: ResearchRow };
    expect(replayed.request.id).toBe(replay.request.id);

    // A pending request can be cancelled, and a cancelled one cannot be run.
    const cancelled = (await dataOf(
      handlers.cancelResearchRequestHandler(request(owner.token, { id: first.request.id })),
    )) as { request: ResearchRow };
    expect(cancelled.request.status).toBe("cancelled");
    const runCancelled = await errorOf(
      handlers.runResearchRequestHandler(request(owner.token, { id: first.request.id })),
    );
    expect(runCancelled.code).toBe("CONFLICT");
    // Cancelling frees the account's research slot for a later refresh.
    const refresh = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "account_record" },
        ),
      ),
    )) as { request: ResearchRow };
    expect(refresh.request.status).toBe("pending");
  });

  it("stores attributed observations only: no score, evidence, outreach or discovery", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const owner = signup("gate-research-claims@example.com", "correct-horse-battery", "Owner R");
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Research Claims" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;
    const handlers = createDefaultHandlers({
      researchProviders: [declaredPublicProvider()],
    });

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          owner.token,
          { workspaceId },
          { name: "Claims Research Co", website: "https://claims-research.example" },
        ),
      ),
    )) as { account: Account };
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "permitted_public_site" },
        ),
      ),
    )) as { request: ResearchRow };
    await dataOf(
      handlers.runResearchRequestHandler(request(owner.token, { id: created.request.id })),
    );

    // The persisted Phase 6 state holds observations with provenance. None of
    // these concepts exists in the research model, so none can be reported
    // from it.
    const document = JSON.stringify({
      researchRequests: store.db.researchRequests,
      researchFindings: store.db.researchFindings,
    });
    for (const forbidden of [
      "score",
      "qualified",
      "qualification",
      "icpFit",
      "buyingIntent",
      "priority",
      "rank",
      "outreach",
      "personalized",
      "messageBody",
      "crmSync",
      "sentAt",
      "lastContacted",
      "verified",
      "approved",
      "authoritative",
      "evidenceId",
      "discoveredProspects",
    ]) {
      expect(document).not.toContain(forbidden);
    }

    // A finding carries exactly what ROADMAP.md §13 asks a research result to
    // support — claim, source, retrieved at, confidence, freshness, relevance,
    // reference — and nothing that claims verification.
    const findings = (await dataOf(
      handlers.getResearchFindingsHandler(request(owner.token, { id: created.request.id })),
    )) as { findings: ResearchFinding[] };
    expect(Object.keys(findings.findings[0] ?? {}).sort()).toEqual([
      "accountId",
      "category",
      "claimKind",
      "confidence",
      "createdAt",
      "field",
      "freshness",
      "id",
      "note",
      "observedAt",
      "relevance",
      "researchRequestId",
      "retrievedAt",
      "source",
      "sourceName",
      "sourceTitle",
      "sourceUrl",
      "status",
      "updatedAt",
      "value",
      "workspaceId",
    ]);
    expect(new Set(findings.findings.map((f) => f.claimKind))).toEqual(
      new Set(["fact", "inference"]),
    );
    expect(findings.findings.every((f) => f.status === "recorded")).toBe(true);

    // The only categories are the ones ROADMAP.md §13 lists for this phase.
    const categories = new Set(findings.findings.map((f) => f.category));
    expect([...categories].sort()).toEqual(["company_overview", "hiring", "products_services"]);

    // Research is scoped to an account the workspace already supplied: the
    // run created no account and discovered no prospect.
    const accounts = (await dataOf(
      handlers.listAccountsHandler(request(owner.token, { workspaceId })),
    )) as { accounts: Account[] };
    expect(accounts.accounts).toHaveLength(1);
    expect(accounts.accounts[0]?.id).toBe(account.account.id);
  });
});
