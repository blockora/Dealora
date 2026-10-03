import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { Store, store as defaultStore } from "@dealora/db";
import type { Account, RevenueGoal } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { StaticResearchProvider } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import {
  createQualificationService,
  toGoalSnapshot,
  toIcpSnapshot,
  toPlanReader,
} from "@dealora/qualification";
import type { QualificationRepository } from "@dealora/qualification";

/**
 * Phase 8 gate — ROADMAP.md §15.
 *
 * Its gate is one sentence: *a user can inspect why an account received a
 * score*. The first test walks the whole pipeline through the real
 * signup/session layer, the real default wiring and the real default store —
 * Business Brain ICP → Revenue Goal → Revenue Plan → Account → Research →
 * Evidence → Qualification — then re-reads the evaluation from a service built
 * over a reloaded copy of the persisted document, so what is proven is that it
 * was written, not merely held in memory.
 *
 * The research providers here are **declared test doubles**. They return
 * observations the test supplies and perform no retrieval of any kind, because
 * no external source is configured in this environment and DEALORA does not
 * pretend otherwise. What the gate proves is the qualification layer itself:
 * the criteria, the score, the explanation, the isolation and the refusals.
 *
 * A qualification is decision support. It is not outreach, not personalization,
 * not an approval and not a priority, and the last test proves that nothing of
 * the kind exists.
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

interface QualificationRow {
  id: string;
  workspaceId: string;
  accountId: string;
  createdBy: string;
  version: number;
  ruleVersion: string;
  revenuePlanId: string | null;
  revenueGoalId: string | null;
  icpId: string | null;
  contextDigest: string;
  state: string;
  score: number | null;
  confidence: string | null;
  reason: string;
  evidenceIds: string[];
  claimIds: string[];
  conflictedClaimIds: string[];
  evaluatedAt: string;
  dimensions: {
    dimension: string;
    score: number | null;
    result: string;
    reason: string;
    confidence: string | null;
    resolvedCriteria: number;
    criteria: {
      criterion: string;
      expectation: string;
      observed: string | null;
      result: string;
      reason: string;
      confidence: string | null;
      evidenceIds: string[];
      claimIds: string[];
    }[];
  }[];
}

interface ImportOutcome {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

interface EvidenceRow {
  id: string;
  accountClaimId: string;
  source: string;
  sourceName: string;
  sourceUrl: string | null;
  status: string;
  confidence: string;
  observedAt: string | null;
}

interface ClaimRow {
  id: string;
  field: string;
  value: string;
  status: string;
}

/**
 * A permitted source, declared by the test.
 *
 * No network call, no crawler, no credential, and no claim that any real page
 * was read. The readings are the whole world this provider knows about, and
 * every one of them carries an observation date inside the goal's window so the
 * timing criterion has something real to place.
 */
function declaredSignalSource(
  id: string,
  readings: { category: string; field: string; value: string }[],
  observedAt: string,
): ResearchProvider {
  return new StaticResearchProvider(
    id,
    "approved_api",
    readings.map((reading) => ({
      category: reading.category as never,
      field: reading.field,
      value: reading.value,
      claimKind: "fact" as const,
      sourceUrl: null,
      sourceTitle: "Permitted partner registry",
      observedAt,
      confidence: "high" as const,
      relevance: "high" as const,
      note: null,
    })),
  );
}

const OBSERVED_IN_WINDOW = "2026-09-15T00:00:00.000Z";

const SIGNALS = declaredSignalSource(
  "partner_registry",
  [
    { category: "business_model", field: "model", value: "Subscription" },
    { category: "hiring", field: "open_roles", value: "Hiring a support operations lead." },
    { category: "technology_signals", field: "stack_change", value: "Moved its helpdesk vendor." },
    { category: "leadership_changes", field: "new_leader", value: "Appointed a VP of Revenue." },
    { category: "expansion", field: "new_region", value: "Opened a new region in September." },
    {
      category: "recent_announcements",
      field: "announcement",
      value: "Announced a partner programme.",
    },
  ],
  OBSERVED_IN_WINDOW,
);

/** A later source that disagrees about the same field, for the conflict path. */
const UPDATED_SIGNALS = declaredSignalSource(
  "updated_partner_registry",
  [{ category: "business_model", field: "model", value: "Agency" }],
  "2026-09-20T00:00:00.000Z",
);

/** A qualification service over a reloaded copy of the persisted document. */
function reloadedQualificationService(store: Store) {
  return createQualificationService(
    store as unknown as QualificationRepository,
    (workspaceId, userId) => {
      const auth = store.authorize(workspaceId, userId);
      if (!auth.ok) throw new Error("business brain unavailable");
      const icp = store.getIcp(workspaceId, userId);
      if (!icp.ok) throw new Error("icp unavailable");
      return icp.value === null ? null : toIcpSnapshot(icp.value);
    },
    (goalId, userId) => {
      const goal = store.getRevenueGoal(goalId, userId);
      return goal.ok ? { ok: true, value: toGoalSnapshot(goal.value) } : goal;
    },
    toPlanReader((planId, userId) => {
      const plan = store.getRevenuePlan(planId, userId);
      return plan.ok ? plan.value : null;
    }),
    () => new Date("2026-10-03T12:00:00.000Z"),
  );
}

describe("Phase 8 gate", () => {
  // The auth layer and the default wiring are bound to the default store
  // singleton, so the end-to-end path must use it too.
  afterAll(() => {
    defaultStore.destroy();
  });

  it("authenticated user → workspace → icp → goal → plan → account → research → evidence → qualification → persist → reload → still explainable", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const handlers = createDefaultHandlers({ researchProviders: [SIGNALS, UPDATED_SIGNALS] });

    // 1. Authenticate for real.
    const owner = signup("gate-qualification@example.com", "correct-horse-battery", "Owner Q");
    const token = owner.token;
    expect(token).toBeTruthy();

    // 2. Workspace as the tenant boundary. A phase-unique name: the default
    //    store is one shared document across every gate suite.
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Qualification Acme" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;

    // 3. Business Brain: the ICP is the canonical target qualification reads.
    await dataOf(
      handlers.upsertCompanyHandler(
        request(
          token,
          { workspaceId },
          { name: "Qualification Gate Corp", description: "Revenue operations", market: "SaaS" },
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
      handlers.upsertIcpHandler(
        request(
          token,
          { workspaceId },
          {
            industries: ["saas"],
            companySizes: ["120 employees"],
            geographies: ["united kingdom"],
            businessModels: ["subscription"],
            disqualifiers: ["agency"],
          },
        ),
      ),
    )) as { icp: { id: string } };
    const persona = (await dataOf(
      handlers.createPersonaHandler(request(token, { workspaceId }, { title: "Head of Revenue" })),
    )) as { persona: { id: string } };

    // 4. Revenue Goal, then the Revenue Plan that targets the ICP.
    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Generate $80,000 of pipeline from US SaaS companies",
            targetMetric: "pipeline",
            targetValue: 80000,
            currency: "USD",
            timeWindow: { start: "2026-07-01", end: "2026-12-31" },
            market: "B2B SaaS",
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
    )) as { plan: { id: string } };

    // 5. The criteria are inspectable before any account is scored: the gate's
    //    "no hidden criteria" requirement, satisfied through the real route.
    const criteria = (await dataOf(
      handlers.getQualificationCriteriaHandler(request(token, { workspaceId })),
    )) as {
      ruleVersion: string;
      dimensions: { label: string; criteria: { criterion: string; expectation: string }[] }[];
    };
    expect(criteria.ruleVersion).toBe("deterministic-1.0.0");
    expect(criteria.dimensions.map((dimension) => dimension.label)).toEqual([
      "ICP Fit",
      "Need Fit",
      "Buying Signal",
      "Timing",
      "Company Fit",
    ]);
    expect(
      criteria.dimensions
        .flatMap((dimension) => dimension.criteria)
        .find((criterion) => criterion.criterion === "industry_match")?.expectation,
    ).toContain("saas");

    // 6. A Phase 5 account, imported and sourced against that plan.
    const imported = (await dataOf(
      handlers.importAccountsHandler(
        request(
          token,
          { workspaceId },
          {
            csv: [
              "name,website,industry,company_size,geography,source_reference",
              "Northwind Trading,https://northwind.example,B2B SaaS,120 employees,United Kingdom,q1-target-list.csv",
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

    // 7. Phase 6 research, then Phase 7 evidence for every finding.
    const researchAndEvidence = async (provider: string): Promise<EvidenceRow[]> => {
      const created = (await dataOf(
        handlers.createResearchRequestHandler(
          request(token, { workspaceId, accountId: northwind?.id ?? "" }, { provider }),
        ),
      )) as { request: { id: string } };
      const run = (await dataOf(
        handlers.runResearchRequestHandler(request(token, { id: created.request.id })),
      )) as { findings: { id: string }[] };
      const recorded: EvidenceRow[] = [];
      for (const finding of run.findings) {
        const outcome = (await dataOf(
          handlers.createEvidenceFromFindingHandler(
            request(token, { workspaceId, researchFindingId: finding.id }),
          ),
        )) as { evidence: EvidenceRow };
        recorded.push(outcome.evidence);
      }
      return recorded;
    };
    const fromAccountRecord = await researchAndEvidence("account_record");
    const fromPartner = await researchAndEvidence("partner_registry");
    expect(fromAccountRecord.length).toBeGreaterThan(0);
    expect(fromPartner.length).toBeGreaterThan(0);

    // 8. Qualification: the server decides, from the ICP, the goal window and
    //    the evidence above.
    const evaluated = (await dataOf(
      handlers.createQualificationHandler(
        request(token, { workspaceId, accountId: northwind?.id ?? "" }, {}),
      ),
    )) as { qualification: QualificationRow };
    const qualification = evaluated.qualification;

    // 9. Every question ROADMAP.md §15 asks can be answered from the result.
    expect(qualification.state).toBe("qualified");
    expect(qualification.score).toBe(100);
    // The weakest citation decides: the account-record source is medium, the
    // partner registry is high, and the score is only as strong as its worst.
    expect(qualification.confidence).toBe("medium");
    expect(qualification.ruleVersion).toBe("deterministic-1.0.0");
    expect(qualification.version).toBe(1);
    expect(qualification.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The provenance of the decision: which icp, goal and plan it rests on.
    expect(qualification.icpId).toBe(icp.icp.id);
    expect(qualification.revenueGoalId).toBe(goal.goal.id);
    expect(qualification.revenuePlanId).toBe(plan.plan.id);
    expect(qualification.contextDigest).toMatch(/^fnv1a-/);
    // The five dimensions, each with score, reason, evidence and confidence.
    expect(qualification.dimensions.map((dimension) => dimension.dimension)).toEqual([
      "icp_fit",
      "need_fit",
      "buying_signal",
      "timing",
      "company_fit",
    ]);
    for (const dimension of qualification.dimensions) {
      expect(dimension.score).not.toBeNull();
      expect(dimension.reason.length).toBeGreaterThan(0);
      expect(dimension.confidence).toBeTruthy();
      expect(dimension.criteria.length).toBeGreaterThan(0);
      for (const criterion of dimension.criteria) {
        expect(criterion.result).toBe("pass");
        expect(criterion.reason.length).toBeGreaterThan(0);
        expect(criterion.confidence).toBeTruthy();
        expect(criterion.evidenceIds.length).toBeGreaterThan(0);
      }
    }
    // And the specific criteria the pipeline above was built to satisfy.
    const industry = qualification.dimensions
      .flatMap((dimension) => dimension.criteria)
      .find((criterion) => criterion.criterion === "industry_match");
    expect(industry?.observed).toBe("B2B SaaS");
    expect(industry?.expectation).toContain("saas");
    const timing = qualification.dimensions
      .flatMap((dimension) => dimension.criteria)
      .find((criterion) => criterion.criterion === "activity_in_window");
    expect(timing?.reason).toContain("revenue goal window");

    // 10. The gate sentence itself: the user can inspect why, in one read,
    //     with the source records joined back to the criterion that read them.
    const explained = (await dataOf(
      handlers.getQualificationExplanationHandler(request(token, { id: qualification.id })),
    )) as { qualification: QualificationRow; claims: ClaimRow[]; evidence: EvidenceRow[] };
    expect(explained.qualification.id).toBe(qualification.id);
    expect(explained.claims).toHaveLength(qualification.claimIds.length);
    expect(explained.evidence).toHaveLength(qualification.evidenceIds.length);
    expect(explained.claims.some((claim) => claim.field === "industry")).toBe(true);
    expect(explained.claims.every((claim) => claim.status === "asserted")).toBe(true);
    expect(explained.evidence.some((record) => record.sourceName === "partner_registry")).toBe(
      true,
    );
    // The evidence references are the Phase 7 records themselves, not copies.
    for (const record of explained.evidence) {
      const stored = (await dataOf(
        handlers.getEvidenceHandler(request(token, { id: record.id })),
      )) as { evidence: EvidenceRow };
      expect(stored.evidence.sourceName).toBe(record.sourceName);
      expect(stored.evidence.sourceUrl).toBe(record.sourceUrl);
    }

    // 11. Persistence: a service over the reloaded document sees everything.
    const reloadedStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const reloaded = reloadedQualificationService(reloadedStore);
    const reread = reloaded.getQualification(qualification.id, owner.user.id);
    if (!isOk(reread)) throw new Error("reload read failed");
    const row = reread.value;
    expect(row.state).toBe("qualified");
    expect(row.score).toBe(100);
    expect(row.confidence).toBe("medium");
    expect(row.ruleVersion).toBe("deterministic-1.0.0");
    expect(row.contextDigest).toBe(qualification.contextDigest);
    expect(row.icpId).toBe(icp.icp.id);
    expect(row.revenueGoalId).toBe(goal.goal.id);
    // The per-criterion explanation survives the round trip field for field.
    expect(row.dimensions).toEqual(qualification.dimensions);
    expect(row.evidenceIds).toEqual(qualification.evidenceIds);
    expect(row.claimIds).toEqual(qualification.claimIds);
    expect(row.evaluatedAt).toBe(qualification.evaluatedAt);

    // 12. The evidence behind it is still there, in the same document, and a
    //     second evaluation from the reloaded store reproduces the score
    //     exactly — the determinism the score depends on.
    const reloadedEvidence = reloadedStore.listEvidence(workspaceId, owner.user.id, {
      accountId: northwind?.id ?? "",
    });
    if (!isOk(reloadedEvidence)) throw new Error("reload evidence read failed");
    for (const id of row.evidenceIds) {
      expect(reloadedEvidence.value.some((record) => record.id === id)).toBe(true);
    }
    const again = reloaded.evaluateAccount(workspaceId, owner.user.id, northwind?.id ?? "");
    if (!isOk(again)) throw new Error("re-evaluation failed");
    expect(again.value.version).toBe(2);
    expect(again.value.score).toBe(row.score);
    expect(again.value.state).toBe(row.state);
    expect(again.value.reason).toBe(row.reason);
    expect(again.value.dimensions).toEqual(row.dimensions);
    // And the first record is untouched by the second.
    expect(reloaded.getQualification(qualification.id, owner.user.id).ok).toBe(true);
    const listed = reloaded.listQualifications(workspaceId, owner.user.id, {
      accountId: northwind?.id ?? "",
    });
    if (!isOk(listed)) throw new Error("reload listing failed");
    // Both versions are listed, newest evaluation first. The first was taken by
    // the application clock and the second by the reloaded service's, so the
    // order is decided by `evaluatedAt`, not by insertion.
    expect(listed.value).toHaveLength(2);
    expect([...listed.value.map((entry) => entry.version)].sort()).toEqual([1, 2]);
    expect(listed.value[0]?.evaluatedAt >= (listed.value[1]?.evaluatedAt ?? "")).toBe(true);
    expect(listed.value.map((entry) => entry.id)).toContain(qualification.id);
  });

  it("enforces workspace authorization and refuses a client-supplied result", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers({ researchProviders: [SIGNALS, UPDATED_SIGNALS] });

    const ownerA = signup("gate-qualification-a@example.com", "correct-horse-battery", "Owner A");
    const ownerB = signup("gate-qualification-b@example.com", "correct-horse-battery", "Owner B");
    const wsA = defaultStore.createWorkspace({
      ownerId: ownerA.user.id,
      name: "Qualification Globex",
    });
    const wsB = defaultStore.createWorkspace({
      ownerId: ownerB.user.id,
      name: "Qualification Initech",
    });
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
    await dataOf(
      handlers.upsertIcpHandler(
        request(ownerA.token, { workspaceId: wsA.value.id }, { industries: ["saas"] }),
      ),
    );

    // A caller cannot hand the engine its own answer.
    const injected = (await dataOf(
      handlers.createQualificationHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id, accountId: account.account.id },
          {
            score: 100,
            state: "qualified",
            confidence: "high",
            priority: 1,
            ruleVersion: "deterministic-1.0.0",
            workspaceId: wsB.value.id,
            userId: ownerB.user.id,
            accountId: account.account.id,
          },
        ),
      ),
    )) as { qualification: QualificationRow };

    // The asserted values are ignored; the honest result is the one returned.
    expect(injected.qualification.state).toBe("insufficient_data");
    expect(injected.qualification.score).toBeNull();
    expect(injected.qualification.workspaceId).toBe(wsA.value.id);
    expect(injected.qualification.createdBy).toBe(ownerA.user.id);
    expect(injected.qualification.accountId).toBe(account.account.id);

    // Tenant B cannot evaluate, read, explain or list anything of tenant A's.
    const denials = await Promise.all([
      errorOf(
        handlers.createQualificationHandler(
          request(ownerB.token, { workspaceId: wsB.value.id, accountId: account.account.id }, {}),
        ),
      ),
      errorOf(
        handlers.getQualificationHandler(request(ownerB.token, { id: injected.qualification.id })),
      ),
      errorOf(
        handlers.getQualificationExplanationHandler(
          request(ownerB.token, { id: injected.qualification.id }),
        ),
      ),
      errorOf(
        handlers.listQualificationsHandler(request(ownerB.token, { workspaceId: wsA.value.id })),
      ),
      errorOf(
        handlers.getQualificationCriteriaHandler(
          request(ownerB.token, { workspaceId: wsA.value.id }),
        ),
      ),
      errorOf(
        handlers.createQualificationHandler(
          request(
            ownerB.token,
            { workspaceId: wsA.value.id, accountId: account.account.id },
            { ruleVersion: "llm-ranked-1" },
          ),
        ),
      ),
      errorOf(
        handlers.createQualificationHandler(
          request(
            ownerB.token,
            { workspaceId: wsB.value.id, accountId: account.account.id },
            { ruleVersion: "llm-ranked-1" },
          ),
        ),
      ),
    ]);
    for (const denial of denials) {
      // A foreign account is not even revealed to exist, and no other tenant's
      // business data leaks through an error.
      expect(["UNAUTHORIZED", "NOT_FOUND", "VALIDATION_ERROR"]).toContain(denial.code);
      expect(JSON.stringify(denial)).not.toContain("Confidential");
      expect(JSON.stringify(denial)).not.toContain("confidential.example");
    }

    // And tenant B sees an empty world.
    const listed = (await dataOf(
      handlers.listQualificationsHandler(request(ownerB.token, { workspaceId: wsB.value.id })),
    )) as { qualifications: QualificationRow[] };
    expect(listed.qualifications).toEqual([]);

    // An unauthenticated caller is refused before anything else happens.
    const anonymous = await errorOf(
      handlers.createQualificationHandler(
        request("", { workspaceId: wsA.value.id, accountId: account.account.id }, {}),
      ),
    );
    expect(anonymous.code).toBe("UNAUTHENTICATED");
  });

  it("makes missing data and conflicting evidence first-class outcomes", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const owner = signup(
      "gate-qualification-outcomes@example.com",
      "correct-horse-battery",
      "Owner O",
    );
    const workspace = store.createWorkspace({
      ownerId: owner.user.id,
      name: "Qualification Outcomes",
    });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;
    const handlers = createDefaultHandlers({ researchProviders: [SIGNALS, UPDATED_SIGNALS] });

    const offer = (await dataOf(
      handlers.createOfferHandler(
        request(
          owner.token,
          { workspaceId },
          { name: "AI automation", description: "Automates revenue" },
        ),
      ),
    )) as { offer: { id: string } };
    const icp = (await dataOf(
      handlers.upsertIcpHandler(
        request(
          owner.token,
          { workspaceId },
          {
            industries: ["saas"],
            companySizes: ["120 employees"],
            geographies: ["united kingdom"],
            businessModels: ["subscription"],
            disqualifiers: ["subscription"],
          },
        ),
      ),
    )) as { icp: { id: string } };
    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          owner.token,
          { workspaceId },
          {
            objective: "Generate $80,000 of pipeline",
            targetMetric: "pipeline",
            targetValue: 80000,
            currency: "USD",
            timeWindow: { start: "2026-07-01", end: "2026-12-31" },
            market: "B2B SaaS",
            offerId: offer.offer.id,
            icpId: icp.icp.id,
            successMetrics: [{ kind: "pipeline", target: 80000, unit: "USD" }],
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    const plan = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(owner.token, { workspaceId }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: { id: string } };
    const account = (await dataOf(
      handlers.importAccountsHandler(
        request(
          owner.token,
          { workspaceId },
          {
            csv: [
              "name,website,industry,company_size,geography,source_reference",
              "Outcomes Trading,https://outcomes.example,B2B SaaS,120 employees,United Kingdom,q1-target-list.csv",
            ].join("\n"),
            revenuePlanId: plan.plan.id,
          },
        ),
      ),
    )) as ImportOutcome;
    expect(account.created).toBe(1);
    const accounts = (await dataOf(
      handlers.listAccountsHandler(request(owner.token, { workspaceId })),
    )) as { accounts: Account[] };
    const outcomesAccount = accounts.accounts[0] as Account;

    // 1. Missing evidence is an explicit outcome, never a fake pass.
    const unresearched = (await dataOf(
      handlers.createQualificationHandler(
        request(owner.token, { workspaceId, accountId: outcomesAccount.id }, {}),
      ),
    )) as { qualification: QualificationRow };
    expect(unresearched.qualification.state).toBe("insufficient_data");
    expect(unresearched.qualification.score).toBeNull();
    expect(unresearched.qualification.confidence).toBeNull();
    expect(unresearched.qualification.reason).toContain("cannot be judged yet");
    expect(unresearched.qualification.conflictedClaimIds).toEqual([]);
    expect(unresearched.qualification.evidenceIds).toEqual([]);
    for (const dimension of unresearched.qualification.dimensions) {
      expect(dimension.result).toBe("unknown");
      expect(dimension.score).toBeNull();
      for (const criterion of dimension.criteria) {
        expect(criterion.result).toBe("unknown");
        expect(criterion.observed).toBeNull();
        expect(criterion.reason).toContain("unresolved");
      }
    }

    // 2. Evidence, from research, for every criterion.
    const runSource = async (provider: string): Promise<void> => {
      const created = (await dataOf(
        handlers.createResearchRequestHandler(
          request(owner.token, { workspaceId, accountId: outcomesAccount.id }, { provider }),
        ),
      )) as { request: { id: string } };
      const run = (await dataOf(
        handlers.runResearchRequestHandler(request(owner.token, { id: created.request.id })),
      )) as { findings: { id: string }[] };
      for (const finding of run.findings) {
        await dataOf(
          handlers.createEvidenceFromFindingHandler(
            request(owner.token, { workspaceId, researchFindingId: finding.id }),
          ),
        );
      }
    };
    await runSource("account_record");
    await runSource("partner_registry");

    const scored = (await dataOf(
      handlers.createQualificationHandler(
        request(owner.token, { workspaceId, accountId: outcomesAccount.id }, {}),
      ),
    )) as { qualification: QualificationRow };
    // Every dimension resolved, and the account's own evidence states an ICP
    // exclusion — so the result is a verdict, and it is a negative one.
    expect(scored.qualification.state).toBe("unqualified");
    expect(scored.qualification.score).toBe(93);
    const excluded = scored.qualification.dimensions
      .flatMap((dimension) => dimension.criteria)
      .find((criterion) => criterion.criterion === "no_disqualifier");
    expect(excluded?.result).toBe("fail");
    expect(excluded?.observed).toBe("Subscription");
    expect(excluded?.reason).toContain("the ICP excludes");
    // The failure is local to its dimension; the rest still pass on their own.
    expect(
      scored.qualification.dimensions
        .filter((dimension) => dimension.result === "pass")
        .map((dimension) => dimension.dimension),
    ).toEqual(["need_fit", "buying_signal", "timing", "company_fit"]);

    // 3. Conflicting evidence is not resolved silently. A second source now
    //    states a different business model for the same account.
    const second = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          owner.token,
          { workspaceId, accountId: outcomesAccount.id },
          { provider: "updated_partner_registry" },
        ),
      ),
    )) as { request: { id: string } };
    const secondRun = (await dataOf(
      handlers.runResearchRequestHandler(request(owner.token, { id: second.request.id })),
    )) as { findings: { id: string }[] };
    const conflict = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request(owner.token, { workspaceId, researchFindingId: secondRun.findings[0]?.id ?? "" }),
      ),
    )) as { evidence: EvidenceRow; claim: ClaimRow; contradicted: EvidenceRow[] };

    // Phase 7 preserved both sides and marked them.
    expect(conflict.contradicted).toHaveLength(1);
    expect(conflict.evidence.status).toBe("contradicted");
    expect(conflict.claim.status).toBe("contested");

    const contested = (await dataOf(
      handlers.createQualificationHandler(
        request(owner.token, { workspaceId, accountId: outcomesAccount.id }, {}),
      ),
    )) as { qualification: QualificationRow };
    // The qualification refuses to pick a winner: the criterion is unresolved,
    // the evaluation is contested, and no score is issued at all.
    expect(contested.qualification.state).toBe("contested");
    expect(contested.qualification.score).toBeNull();
    expect(contested.qualification.conflictedClaimIds).toEqual([conflict.claim.id]);
    expect(contested.qualification.reason).toContain("The sources disagree");
    const businessModel = contested.qualification.dimensions
      .flatMap((dimension) => dimension.criteria)
      .find((criterion) => criterion.criterion === "business_model");
    expect(businessModel?.result).toBe("unknown");
    expect(businessModel?.observed).toBeNull();
    expect(businessModel?.reason).toContain("does not choose between them");
    // Both records stay referenced, so the conflict is inspectable.
    expect(businessModel?.evidenceIds).toHaveLength(2);
    // And the criterion that had already failed now refuses to decide: the
    // exclusion check depended on the same claim, so it is unresolved too.
    const exclusion = contested.qualification.dimensions
      .flatMap((dimension) => dimension.criteria)
      .find((criterion) => criterion.criterion === "no_disqualifier");
    expect(exclusion?.result).toBe("unknown");
    expect(exclusion?.reason).toContain("does not choose between them");
  });

  it("stores a decision support record and nothing else", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const owner = signup(
      "gate-qualification-decision@example.com",
      "correct-horse-battery",
      "Owner D",
    );
    const workspace = store.createWorkspace({
      ownerId: owner.user.id,
      name: "Qualification Decision",
    });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;
    const handlers = createDefaultHandlers({ researchProviders: [SIGNALS, UPDATED_SIGNALS] });

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          owner.token,
          { workspaceId },
          { name: "Decision Industries", website: "https://decision.example" },
        ),
      ),
    )) as { account: Account };
    await dataOf(
      handlers.upsertIcpHandler(request(owner.token, { workspaceId }, { industries: ["saas"] })),
    );

    const before = {
      accounts: store.db.accounts.length,
      contacts: store.db.contacts.length,
      claims: store.db.accountClaims.length,
      evidence: store.db.evidence.length,
      findings: store.db.researchFindings.length,
      plans: store.db.revenuePlans.length,
      goals: store.db.revenueGoals.length,
    };
    const evaluated = (await dataOf(
      handlers.createQualificationHandler(
        request(owner.token, { workspaceId, accountId: account.account.id }, {}),
      ),
    )) as { qualification: QualificationRow };
    expect(evaluated.qualification.state).toBe("insufficient_data");

    // 1. The evaluation wrote a decision and touched nothing else: no account
    //    edited, no evidence or claim rewritten, no contact, goal or plan made.
    expect(store.db.accounts.length).toBe(before.accounts);
    expect(store.db.contacts.length).toBe(before.contacts);
    expect(store.db.accountClaims.length).toBe(before.claims);
    expect(store.db.evidence.length).toBe(before.evidence);
    expect(store.db.researchFindings.length).toBe(before.findings);
    expect(store.db.revenuePlans.length).toBe(before.plans);
    expect(store.db.revenueGoals.length).toBe(before.goals);
    // Scoped to this test's own account: the default store is one shared
    // document across every gate suite.
    expect(
      store.db.qualifications.filter((entry) => entry.accountId === account.account.id),
    ).toHaveLength(1);

    // 2. The persisted record carries a decision, not an action, a message or a
    //    priority. None of these concepts exists in the model, so none can be
    //    reported from it.
    const document = JSON.stringify(
      store.db.qualifications.filter((entry) => entry.accountId === account.account.id),
    );
    for (const forbidden of [
      "messageBody",
      "emailSubject",
      "linkedin",
      "callScript",
      "personalized",
      "outreach",
      "crmSync",
      "opportunityId",
      "meetingId",
      "approvedBy",
      "approvedAt",
      "priority",
      "rank",
      "dealProbability",
      "lastContacted",
      "sentAt",
      "nextBestAction",
    ]) {
      expect(document).not.toContain(forbidden);
    }

    // 3. The record holds exactly the decision fields and nothing hidden.
    const record = store.db.qualifications.filter(
      (entry) => entry.accountId === account.account.id,
    )[0];
    expect(Object.keys(record ?? {}).sort()).toEqual([
      "accountId",
      "claimIds",
      "confidence",
      "conflictedClaimIds",
      "contextDigest",
      "createdAt",
      "createdBy",
      "dimensions",
      "evaluatedAt",
      "evidenceIds",
      "icpId",
      "id",
      "reason",
      "revenueGoalId",
      "revenuePlanId",
      "ruleVersion",
      "score",
      "state",
      "updatedAt",
      "version",
      "workspaceId",
    ]);

    // 4. The criteria are the roadmap's five dimensions and nothing else: no
    //    hidden criterion crept in, and none depends on a person, a price or a
    //    conversation.
    const criteria = (await dataOf(
      handlers.getQualificationCriteriaHandler(request(owner.token, { workspaceId })),
    )) as { dimensions: { dimension: string; criteria: { criterion: string }[] }[] };
    const names = criteria.dimensions.flatMap((dimension) =>
      dimension.criteria.map((criterion) => criterion.criterion),
    );
    expect(names).toEqual([
      "industry_match",
      "geography_match",
      "no_disqualifier",
      "hiring_signal",
      "technology_signal",
      "leadership_change",
      "expansion_signal",
      "activity_in_window",
      "company_size",
      "business_model",
    ]);
    for (const name of names) {
      expect(name).not.toMatch(/persona|contact|email|price|revenue_per|intent_score/);
    }

    // 5. It creates no account of its own: qualification only describes an
    //    account the workspace already supplied.
    const accounts = (await dataOf(
      handlers.listAccountsHandler(request(owner.token, { workspaceId })),
    )) as { accounts: Account[] };
    expect(accounts.accounts).toHaveLength(1);
    expect(accounts.accounts[0]?.id).toBe(account.account.id);
  });
});
