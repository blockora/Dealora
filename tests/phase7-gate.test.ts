import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { Store, store as defaultStore } from "@dealora/db";
import type { Account, Evidence as EvidenceRecord, RevenueGoal, RevenuePlan } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import {
  AccountRecordProvider,
  StaticResearchProvider,
  createResearchService,
} from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import { createEvidenceService } from "@dealora/evidence";
import type { EvidenceRepository } from "@dealora/evidence";

/**
 * Phase 7 gate — ROADMAP.md §14.
 *
 * Its gate is one sentence: *generated claims can be traced back to evidence*.
 * The first test walks the whole path through the real signup/session layer,
 * the real default wiring and the real default store, then re-reads the
 * evidence from a service built over the persisted document, to prove it was
 * written rather than merely held in memory.
 *
 * The providers used here are **declared test doubles**. They return
 * observations the test supplies and perform no retrieval of any kind, because
 * no external source is configured in this environment and DEALORA does not
 * pretend otherwise. What the gate proves is the evidence layer itself: the
 * conversion, the provenance, the contradiction record, the history, the
 * isolation and the refusals.
 *
 * Evidence is not qualification, not a score and not outreach, and the last
 * test proves no such behaviour exists.
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

interface EvidenceRow {
  id: string;
  workspaceId: string;
  accountId: string;
  accountClaimId: string;
  researchFindingId: string | null;
  provenance: string;
  source: string;
  sourceName: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  observedAt: string | null;
  retrievedAt: string;
  confidence: string;
  freshness: string;
  relevance: string;
  status: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ClaimRow {
  id: string;
  workspaceId: string;
  accountId: string;
  category: string;
  field: string;
  value: string;
  claimKind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface Outcome {
  evidence: EvidenceRow;
  claim: ClaimRow;
  contradicted: EvidenceRow[];
}

interface ImportOutcome {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

/** A research service over a reloaded copy of the persisted document. */
function reloadedResearchService(store: Store) {
  return createResearchService(
    store as unknown as Parameters<typeof createResearchService>[0],
    [new AccountRecordProvider()],
    () => new Date("2026-10-03T12:00:00.000Z"),
  );
}

/** An evidence service over a reloaded copy of the persisted document. */
function reloadedEvidenceService(store: Store) {
  return createEvidenceService(
    store as unknown as EvidenceRepository,
    () => new Date("2026-10-03T12:00:00.000Z"),
  );
}

/**
 * A permitted registry source, declared by the test.
 *
 * No network call, no crawler, no credential, and no claim that any real page
 * was read. `readings` is the whole world this provider knows about.
 */
function declaredRegistry(
  id: string,
  readings: { value: string; url: string }[],
): ResearchProvider {
  return new StaticResearchProvider(
    id,
    "public_web",
    readings.map((reading) => ({
      category: "company_overview",
      field: "company_overview.employee_count",
      value: reading.value,
      claimKind: "fact",
      sourceUrl: reading.url,
      sourceTitle: "Company registry entry",
      observedAt: "2026-09-01T00:00:00.000Z",
      confidence: "medium",
      relevance: "high",
      note: null,
    })),
  );
}

const REGISTRY = declaredRegistry("company_registry", [
  { value: "50", url: "https://registry-a.example/northwind" },
]);
const UPDATED_REGISTRY = declaredRegistry("updated_registry", [
  { value: "120", url: "https://registry-b.example/northwind" },
]);

describe("Phase 7 gate", () => {
  // The auth layer and the default wiring are bound to the default store
  // singleton, so the end-to-end path must use it too.
  afterAll(() => {
    defaultStore.destroy();
  });

  it("authenticated user → workspace → revenue plan → account → research → finding → evidence → claim → persist → reload → provenance preserved", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const handlers = createDefaultHandlers({
      researchProviders: [REGISTRY, UPDATED_REGISTRY],
    });

    // 1. Authenticate for real.
    const owner = signup("gate-evidence@example.com", "correct-horse-battery", "Owner E");
    const token = owner.token;
    expect(token).toBeTruthy();

    // 2. Workspace as the tenant boundary. A phase-unique name: the default
    //    store is one shared document across every gate suite.
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Evidence Acme" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;

    // 3. A RevenuePlan, so the account has a plan behind it.
    await dataOf(
      handlers.upsertCompanyHandler(
        request(
          token,
          { workspaceId },
          { name: "Evidence Gate Corp", description: "Revenue operations", market: "Wholesale" },
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

    // 4. A Phase 5 account, imported and linked to that plan.
    const imported = (await dataOf(
      handlers.importAccountsHandler(
        request(
          token,
          { workspaceId },
          {
            csv: [
              "name,website,industry,company_size,geography,source_reference",
              "Northwind Trading,https://northwind.example,Wholesale,50,UK,q1-target-list.csv",
            ].join("\n"),
            revenuePlanId: plan.plan.id,
          },
        ),
      ),
    )) as ImportOutcome;
    expect(imported.created).toBe(1);
    const accounts = (await dataOf(
      handlers.listAccountsHandler(request(token, { workspaceId })),
    )) as { accounts: Account[] };
    const northwind = accounts.accounts[0];
    expect(northwind?.revenuePlanId).toBe(plan.plan.id);

    // 5. Research the account, then convert the finding into evidence.
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          token,
          { workspaceId, accountId: northwind?.id ?? "" },
          { provider: "company_registry" },
        ),
      ),
    )) as { request: { id: string } };
    const run = (await dataOf(
      handlers.runResearchRequestHandler(request(token, { id: created.request.id })),
    )) as { findings: { id: string }[] };
    expect(run.findings).toHaveLength(1);
    const findingId = run.findings[0]?.id ?? "";

    const outcome = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request(token, { workspaceId, researchFindingId: findingId }),
      ),
    )) as Outcome;

    // 6. Every question the phase must answer can be answered.
    //    What is being claimed?
    expect(outcome.claim.field).toBe("company_overview.employee_count");
    expect(outcome.claim.value).toBe("50");
    //     A `fact` means "this source states this", not that DEALORA verified it.
    expect(outcome.claim.claimKind).toBe("fact");
    expect(outcome.claim.status).toBe("asserted");
    //     What source supports it, and where did the source come from?
    expect(outcome.evidence.sourceName).toBe("company_registry");
    expect(outcome.evidence.source).toBe("public_web");
    expect(outcome.evidence.sourceUrl).toBe("https://registry-a.example/northwind");
    expect(outcome.evidence.sourceTitle).toBe("Company registry entry");
    //     When was it observed, and when did DEALORA retrieve it?
    expect(outcome.evidence.observedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(outcome.evidence.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    //     Confidence, freshness and relevance, preserved as bands.
    expect(outcome.evidence.confidence).toBe("medium");
    expect(["fresh", "recent", "stale"]).toContain(outcome.evidence.freshness);
    expect(outcome.evidence.relevance).toBe("high");
    //     What is the provenance, all the way back to the account?
    expect(outcome.evidence.provenance).toBe("research_finding");
    expect(outcome.evidence.researchFindingId).toBe(findingId);
    expect(outcome.evidence.accountClaimId).toBe(outcome.claim.id);
    expect(outcome.evidence.workspaceId).toBe(workspaceId);
    expect(outcome.evidence.accountId).toBe(northwind?.id);
    expect(outcome.evidence.status).toBe("recorded");

    // 7. The gate sentence itself: the claim traces back to its evidence.
    const support = (await dataOf(
      handlers.listClaimEvidenceHandler(request(token, { id: outcome.claim.id })),
    )) as { evidence: EvidenceRow[] };
    expect(support.evidence).toHaveLength(1);
    expect(support.evidence[0]?.researchFindingId).toBe(findingId);
    const one = (await dataOf(
      handlers.getEvidenceHandler(request(token, { id: outcome.evidence.id })),
    )) as { evidence: EvidenceRow };
    expect(one.evidence.accountClaimId).toBe(outcome.claim.id);

    // 8. Persistence: a service over the reloaded document sees everything.
    const reloadedStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const reloaded = reloadedEvidenceService(reloadedStore);
    const persisted = reloaded.getEvidence(outcome.evidence.id, owner.user.id);
    if (!isOk(persisted)) throw new Error("reload read failed");
    const row = persisted.value;
    // Provenance survives the round trip field for field.
    expect(row.source).toBe(outcome.evidence.source);
    expect(row.sourceName).toBe(outcome.evidence.sourceName);
    expect(row.sourceUrl).toBe(outcome.evidence.sourceUrl);
    expect(row.sourceTitle).toBe(outcome.evidence.sourceTitle);
    expect(row.observedAt).toBe(outcome.evidence.observedAt);
    expect(row.retrievedAt).toBe(outcome.evidence.retrievedAt);
    expect(row.confidence).toBe(outcome.evidence.confidence);
    expect(row.freshness).toBe(outcome.evidence.freshness);
    expect(row.relevance).toBe(outcome.evidence.relevance);
    expect(row.provenance).toBe(outcome.evidence.provenance);
    expect(row.researchFindingId).toBe(findingId);
    expect(row.status).toBe("recorded");
    // And the claim it supports, with the finding still readable behind it.
    const claim = reloaded.getAccountClaim(outcome.claim.id, owner.user.id);
    if (!isOk(claim)) throw new Error("reload read failed");
    expect(claim.value.value).toBe("50");
    expect(claim.value.accountId).toBe(northwind?.id);
    const finding = reloadedResearchService(reloadedStore).listFindingsForRequest(
      created.request.id,
      owner.user.id,
    );
    if (!isOk(finding)) throw new Error("reload read failed");
    expect(finding.value).toHaveLength(1);
    expect(finding.value[0]?.id).toBe(findingId);

    // 9. Contradictory evidence can coexist, and neither side wins silently.
    const second = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          token,
          { workspaceId, accountId: northwind?.id ?? "" },
          { provider: "updated_registry" },
        ),
      ),
    )) as { request: { id: string } };
    const secondRun = (await dataOf(
      handlers.runResearchRequestHandler(request(token, { id: second.request.id })),
    )) as { findings: { id: string }[] };
    const conflict = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request(token, { workspaceId, researchFindingId: secondRun.findings[0]?.id ?? "" }),
      ),
    )) as Outcome;

    // Both records are preserved with their own sources, and both are marked.
    expect(conflict.contradicted).toHaveLength(1);
    expect(conflict.contradicted[0]?.id).toBe(outcome.evidence.id);
    expect(conflict.contradicted[0]?.sourceName).toBe("company_registry");
    expect(conflict.contradicted[0]?.sourceUrl).toBe("https://registry-a.example/northwind");
    expect(conflict.evidence.sourceName).toBe("updated_registry");
    expect(conflict.evidence.sourceUrl).toBe("https://registry-b.example/northwind");
    expect(conflict.evidence.status).toBe("contradicted");
    expect(conflict.claim.status).toBe("contested");
    // The claim itself is unchanged: a contradiction is recorded, not resolved.
    expect(conflict.claim.value).toBe("50");
    expect(conflict.claim.id).toBe(outcome.claim.id);

    // 10. Historical evidence remains available after supersession, and only
    //     when the workspace names the replacement.
    const superseded = (await dataOf(
      handlers.supersedeEvidenceHandler(
        request(
          token,
          { id: outcome.evidence.id },
          {
            replacementEvidenceId: conflict.evidence.id,
          },
        ),
      ),
    )) as { superseded: EvidenceRow; replacement: EvidenceRow };
    expect(superseded.superseded.status).toBe("superseded");
    expect(superseded.superseded.sourceUrl).toBe("https://registry-a.example/northwind");
    expect(superseded.superseded.sourceName).toBe("company_registry");
    expect(superseded.superseded.observedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(superseded.superseded.retrievedAt).toBe(outcome.evidence.retrievedAt);
    // The replaced observation is history, not a deletion.
    expect(store.db.evidence).toHaveLength(2);
    const historical = (await dataOf(
      handlers.listEvidenceHandler(request(token, { workspaceId })),
    )) as { evidence: EvidenceRow[] };
    expect(historical.evidence).toHaveLength(2);
    const reread = (await dataOf(
      handlers.getEvidenceHandler(request(token, { id: outcome.evidence.id })),
    )) as { evidence: EvidenceRow };
    expect(reread.evidence.status).toBe("superseded");

    // 11. A source with no citation gets none invented.
    const uncited = (await dataOf(
      handlers.recordUserEvidenceHandler(
        request(
          token,
          { workspaceId, accountId: northwind?.id ?? "" },
          {
            category: "hiring",
            field: "hiring.open_roles",
            value: "Two roles are advertised on the careers page.",
            claimKind: "fact",
            sourceName: "workspace account record",
            confidence: "low",
            relevance: "low",
          },
        ),
      ),
    )) as Outcome;
    expect(uncited.evidence.sourceUrl).toBeNull();
    expect(uncited.evidence.observedAt).toBeNull();
    // No observation date means no claimed currency, whatever the confidence.
    expect(uncited.evidence.freshness).toBe("unknown");
    // And the provenance has no research request behind it, so none was invented.
    expect(uncited.evidence.provenance).toBe("user_supplied");
    expect(uncited.evidence.researchFindingId).toBeNull();
    expect(uncited.evidence.source).toBe("account_record");
  });

  it("enforces workspace authorization and ignores client-supplied identity", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({
      researchProviders: [REGISTRY, UPDATED_REGISTRY],
    });

    const ownerA = signup("gate-evidence-a@example.com", "correct-horse-battery", "Owner A");
    const ownerB = signup("gate-evidence-b@example.com", "correct-horse-battery", "Owner B");
    const wsA = defaultStore.createWorkspace({ ownerId: ownerA.user.id, name: "Evidence Globex" });
    const wsB = defaultStore.createWorkspace({ ownerId: ownerB.user.id, name: "Evidence Initech" });
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
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id, accountId: account.account.id },
          { provider: "company_registry" },
        ),
      ),
    )) as { request: { id: string } };
    const run = (await dataOf(
      handlers.runResearchRequestHandler(request(ownerA.token, { id: created.request.id })),
    )) as { findings: { id: string }[] };
    const findingId = run.findings[0]?.id ?? "";
    const outcome = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request(ownerA.token, { workspaceId: wsA.value.id, researchFindingId: findingId }),
      ),
    )) as Outcome;

    // Tenant B cannot reach the evidence, the claim, the finding, or write
    // evidence into tenant A's account.
    const denials = await Promise.all([
      errorOf(
        handlers.createEvidenceFromFindingHandler(
          request(ownerB.token, {
            workspaceId: wsB.value.id,
            researchFindingId: findingId,
          }),
        ),
      ),
      errorOf(handlers.getEvidenceHandler(request(ownerB.token, { id: outcome.evidence.id }))),
      errorOf(handlers.getAccountClaimHandler(request(ownerB.token, { id: outcome.claim.id }))),
      errorOf(handlers.listClaimEvidenceHandler(request(ownerB.token, { id: outcome.claim.id }))),
      errorOf(
        handlers.changeEvidenceStatusHandler(
          request(ownerB.token, { id: outcome.evidence.id }, { status: "rejected" }),
        ),
      ),
      errorOf(
        handlers.supersedeEvidenceHandler(
          request(
            ownerB.token,
            { id: outcome.evidence.id },
            {
              replacementEvidenceId: "some-other-evidence",
            },
          ),
        ),
      ),
      errorOf(
        handlers.changeAccountClaimStatusHandler(
          request(ownerB.token, { id: outcome.claim.id }, { status: "retracted" }),
        ),
      ),
      errorOf(
        handlers.recordUserEvidenceHandler(
          request(
            ownerB.token,
            { workspaceId: wsB.value.id, accountId: account.account.id },
            {
              category: "company_overview",
              field: "employee_count",
              value: "9999",
              claimKind: "fact",
              sourceName: "workspace account record",
              confidence: "high",
              relevance: "high",
            },
          ),
        ),
      ),
      errorOf(handlers.listEvidenceHandler(request(ownerB.token, { workspaceId: wsA.value.id }))),
      errorOf(
        handlers.listAccountClaimsHandler(request(ownerB.token, { workspaceId: wsA.value.id })),
      ),
    ]);
    for (const denial of denials) {
      // A foreign account or finding is not even revealed to exist.
      expect(["UNAUTHORIZED", "NOT_FOUND"]).toContain(denial.code);
      expect(JSON.stringify(denial)).not.toContain("confidential");
      expect(JSON.stringify(denial)).not.toContain("registry-a.example");
    }

    // A workspace or user named in the body is ignored: the route's workspace
    // and the token's user win.
    const ignored = (await dataOf(
      handlers.recordUserEvidenceHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id, accountId: account.account.id },
          {
            category: "company_overview",
            field: "geography",
            value: "United Kingdom",
            claimKind: "fact",
            sourceName: "workspace account record",
            confidence: "medium",
            relevance: "high",
            workspaceId: wsB.value.id,
            userId: ownerB.user.id,
            accountId: account.account.id,
            // Nor can a caller attribute its own record to an external source.
            source: "approved_api",
          },
        ),
      ),
    )) as Outcome;
    expect(ignored.evidence.workspaceId).toBe(wsA.value.id);
    expect(ignored.evidence.accountId).toBe(account.account.id);
    expect(ignored.evidence.source).toBe("account_record");

    // And tenant B sees an empty world.
    const bEvidence = (await dataOf(
      handlers.listEvidenceHandler(request(ownerB.token, { workspaceId: wsB.value.id })),
    )) as { evidence: EvidenceRow[] };
    expect(bEvidence.evidence).toEqual([]);
    const bClaims = (await dataOf(
      handlers.listAccountClaimsHandler(request(ownerB.token, { workspaceId: wsB.value.id })),
    )) as { claims: ClaimRow[] };
    expect(bClaims.claims).toEqual([]);
  });

  it("refuses to resolve, verify or rank anything on its own", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const owner = signup("gate-evidence-refusals@example.com", "correct-horse-battery", "Owner R");
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Evidence Refusals" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;
    const handlers = createDefaultHandlers({
      researchProviders: [REGISTRY, UPDATED_REGISTRY],
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
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "company_registry" },
        ),
      ),
    )) as { request: { id: string } };
    const run = (await dataOf(
      handlers.runResearchRequestHandler(request(owner.token, { id: created.request.id })),
    )) as { findings: { id: string }[] };
    const outcome = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request(owner.token, { workspaceId, researchFindingId: run.findings[0]?.id ?? "" }),
      ),
    )) as Outcome;

    // No status can declare a source-backed statement verified, scored or
    // qualified: the vocabulary simply does not contain them.
    for (const status of ["verified", "scored", "qualified", "ranked", "promoted"]) {
      const error = await errorOf(
        handlers.changeEvidenceStatusHandler(
          request(owner.token, { id: outcome.evidence.id }, { status }),
        ),
      );
      expect(error.code).toBe("VALIDATION_ERROR");
      const claimError = await errorOf(
        handlers.changeAccountClaimStatusHandler(
          request(owner.token, { id: outcome.claim.id }, { status }),
        ),
      );
      expect(claimError.code).toBe("VALIDATION_ERROR");
    }

    // A qualification-flavoured field is not a research category, so it cannot
    // become a claim at all.
    for (const category of ["buying_intent", "icp_fit", "opportunity_score"]) {
      const error = await errorOf(
        handlers.recordUserEvidenceHandler(
          request(
            owner.token,
            { workspaceId, accountId: account.account.id },
            {
              category,
              field: "intent",
              value: "hot",
              claimKind: "fact",
              sourceName: "workspace account record",
              confidence: "high",
              relevance: "high",
            },
          ),
        ),
      );
      expect(error.code).toBe("VALIDATION_ERROR");
    }

    // Neither can it claim something was verified as a claim kind.
    const badKind = await errorOf(
      handlers.recordUserEvidenceHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          {
            category: "company_overview",
            field: "employee_count",
            value: "50",
            claimKind: "verified",
            sourceName: "workspace account record",
            confidence: "high",
            relevance: "high",
          },
        ),
      ),
    );
    expect(badKind.code).toBe("VALIDATION_ERROR");

    // Superseding requires naming the replacement, so the system never picks
    // a winner on its own.
    const bare = await errorOf(
      handlers.changeEvidenceStatusHandler(
        request(owner.token, { id: outcome.evidence.id }, { status: "superseded" }),
      ),
    );
    expect(bare.code).toBe("VALIDATION_ERROR");
    const unknownReplacement = await errorOf(
      handlers.supersedeEvidenceHandler(
        request(owner.token, { id: outcome.evidence.id }, { replacementEvidenceId: "nope" }),
      ),
    );
    expect(unknownReplacement.code).toBe("NOT_FOUND");

    // Nothing partial was written by any of the refusals. Scoped to this
    // test's own account, because the default store is one shared document.
    expect(store.db.accountClaims.filter((c) => c.accountId === account.account.id)).toHaveLength(
      1,
    );
    expect(store.db.evidence.filter((e) => e.accountId === account.account.id)).toHaveLength(1);
  });

  it("stores traceable provenance only: no qualification, scoring or outreach", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const owner = signup("gate-evidence-claims@example.com", "correct-horse-battery", "Owner R");
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Evidence Claims" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;
    const handlers = createDefaultHandlers({
      researchProviders: [REGISTRY, UPDATED_REGISTRY],
    });

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          owner.token,
          { workspaceId },
          { name: "Claims Evidence Co", website: "https://claims-evidence.example" },
        ),
      ),
    )) as { account: Account };
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: account.account.id },
          { provider: "company_registry" },
        ),
      ),
    )) as { request: { id: string } };
    const run = (await dataOf(
      handlers.runResearchRequestHandler(request(owner.token, { id: created.request.id })),
    )) as { findings: { id: string }[] };
    await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request(owner.token, { workspaceId, researchFindingId: run.findings[0]?.id ?? "" }),
      ),
    );

    // The persisted Phase 7 state holds provenance and nothing else. None of
    // these concepts exists in the model, so none can be reported from it.
    const document = JSON.stringify({
      accountClaims: store.db.accountClaims,
      evidence: store.db.evidence,
    });
    for (const forbidden of [
      "score",
      "icpFit",
      "needFit",
      "buyingSignal",
      "buyingIntent",
      "qualified",
      "qualification",
      "priority",
      "rank",
      "dealProbability",
      "outreach",
      "personalized",
      "messageBody",
      "crmSync",
      "sentAt",
      "lastContacted",
      "approvedAction",
      "discoveredProspects",
    ]) {
      expect(document).not.toContain(forbidden);
    }

    // Evidence carries exactly what ROADMAP.md §14 asks for — id, source,
    // source_type, source_url, claim, claim_type, confidence, freshness,
    // retrieved_at, relevance, related_entity — plus its provenance.
    const listed = (await dataOf(
      handlers.listEvidenceHandler(request(owner.token, { workspaceId })),
    )) as { evidence: EvidenceRow[] };
    expect(Object.keys(listed.evidence[0] ?? {}).sort()).toEqual([
      "accountClaimId",
      "accountId",
      "confidence",
      "createdAt",
      "freshness",
      "id",
      "note",
      "observedAt",
      "provenance",
      "relevance",
      "researchFindingId",
      "retrievedAt",
      "source",
      "sourceName",
      "sourceTitle",
      "sourceUrl",
      "status",
      "updatedAt",
      "workspaceId",
    ]);

    // And the claim carries only what the source supports.
    const claims = (await dataOf(
      handlers.listAccountClaimsHandler(request(owner.token, { workspaceId })),
    )) as { claims: ClaimRow[] };
    expect(Object.keys(claims.claims[0] ?? {}).sort()).toEqual([
      "accountId",
      "category",
      "claimKind",
      "createdAt",
      "field",
      "id",
      "status",
      "updatedAt",
      "value",
      "workspaceId",
    ]);
    expect(claims.claims.every((c) => c.status === "asserted")).toBe(true);

    // The evidence system scored nothing and ranked nothing: it added no
    // notion of an account being better or worse than another.
    const evidenceRows = listed.evidence as unknown as EvidenceRecord[];
    expect(evidenceRows).toHaveLength(1);
    expect(new Set(evidenceRows.map((e) => e.status))).toEqual(new Set(["recorded"]));

    // And it created no account: research and evidence only ever describe an
    // account the workspace already supplied.
    const accounts = (await dataOf(
      handlers.listAccountsHandler(request(owner.token, { workspaceId })),
    )) as { accounts: Account[] };
    expect(accounts.accounts).toHaveLength(1);
    expect(accounts.accounts[0]?.id).toBe(account.account.id);
  });
});
