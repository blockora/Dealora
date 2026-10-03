import { describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";
import type {
  Account,
  AccountClaim,
  Evidence as EvidenceRecord,
  Icp,
  RevenueGoal,
  RevenuePlan,
  User,
} from "@dealora/db";

import { QualificationService } from "./service.js";
import { evaluateQualification } from "./evaluator.js";
import { toGoalSnapshot, toIcpSnapshot } from "./factory.js";
import type {
  QualificationGoalSnapshot,
  QualificationIcpSnapshot,
  QualificationPlanReader,
  QualificationPlanSnapshot,
  QualificationRepository,
} from "./types.js";
import {
  QUALIFICATION_CRITERIA,
  QUALIFICATION_DIMENSIONS,
  QUALIFICATION_RULE_VERSION,
  contextDigest,
  matchesTerm,
} from "./rules.js";

const NOW = () => new Date("2026-10-03T12:00:00.000Z");

function seed(): Store {
  return new Store(emptyState());
}

function makeOwner(store: Store, email = "owner@example.com"): User {
  const created = store.createUser({
    email,
    password: "correct-horse-battery",
    displayName: "Owner",
  });
  if (!isOk(created)) throw new Error("seed user creation failed");
  return created.value;
}

function makeWorkspace(store: Store, ownerId: string, name: string): string {
  const created = store.createWorkspace({ ownerId, name });
  if (!isOk(created)) throw new Error("seed workspace creation failed");
  return created.value.id;
}

const DEFAULT_ICP = {
  industries: ["saas"],
  companySizes: ["120 employees"],
  geographies: ["united kingdom"],
  businessModels: ["subscription"],
  disqualifiers: ["agency"],
};

function makeIcp(
  store: Store,
  workspaceId: string,
  userId: string,
  overrides: Partial<typeof DEFAULT_ICP> = {},
): Icp {
  const created = store.upsertIcp(workspaceId, userId, { ...DEFAULT_ICP, ...overrides });
  if (!isOk(created)) throw new Error("seed icp creation failed");
  return created.value;
}

function makeAccount(
  store: Store,
  workspaceId: string,
  userId: string,
  name: string,
  revenuePlanId: string | null = null,
): Account {
  const created = store.createAccount({
    workspaceId,
    createdBy: userId,
    account: {
      name,
      website: "https://northwind.example",
      domain: "northwind.example",
      industry: null,
      companySize: null,
      geography: null,
      description: null,
      source: "manual",
      sourceReference: null,
      revenuePlanId,
      status: "active",
    },
  });
  if (!isOk(created)) throw new Error("seed account creation failed");
  return created.value;
}

function makeGoal(
  store: Store,
  workspaceId: string,
  userId: string,
  window: { start: string; end: string },
): RevenueGoal {
  const created = store.createRevenueGoal({
    workspaceId,
    createdBy: userId,
    goal: {
      objective: "Grow pipeline",
      targetMetric: "pipeline",
      targetValue: 80000,
      currency: "USD",
      timeWindow: window,
      market: "SaaS",
      icpId: null,
      buyerPersonaIds: [],
      offerId: null,
      economics: {
        averageDealValue: null,
        minimumContractValue: null,
        targetCustomers: null,
        currency: null,
      },
      constraints: {
        geographies: [],
        industries: [],
        companySizes: [],
        channels: [],
        budget: null,
        maxOutreachPerDay: null,
        notes: null,
      },
      approvalPolicy: {
        maxRiskLevel: "level_2_external_action",
        externalActionsRequireApproval: true,
        approverUserId: null,
      },
      successMetrics: [],
      status: "active",
      completeness: "incomplete",
      unknowns: [],
      assumptions: [],
    },
  });
  if (!isOk(created)) throw new Error("seed goal creation failed");
  return created.value;
}

/** A plan reference, without seeding a full plan row. */
function planFor(planId: string, workspaceId: string, revenueGoalId: string | null) {
  return (id: string, _userId: string) => {
    if (id !== planId) return { ok: false, error: { code: "NOT_FOUND" } } as const;
    const snapshot: QualificationPlanSnapshot = { id: planId, workspaceId, revenueGoalId };
    return { ok: true, value: snapshot } as const;
  };
}

/**
 * A real plan row, so the repository's own tenant checks apply to the
 * references a qualification records. Nothing about the plan's strategies is
 * read by the engine; only its provenance is.
 */
function makePlan(
  store: Store,
  workspaceId: string,
  userId: string,
  revenueGoalId: string,
): RevenuePlan {
  const strategies = {
    icp: { statement: "", focusedSegments: [], excludedSegments: [], evidence: [], statements: [] },
    buyer: { personas: [], statements: [] },
    sourcing: { channels: [], statements: [] },
    signal: { signals: [], excludedSources: [], statements: [] },
    qualification: { criteria: [], statements: [] },
    outreach: {
      channels: [],
      messagingAngles: [],
      valueProposition: null,
      personalizationPrinciple: null,
      frequencyCap: null,
      stopPrinciples: [],
      approvalRequired: true,
      statements: [],
    },
    followUp: {
      principles: [],
      responseStates: [],
      stopConditions: [],
      escalationConditions: [],
      statements: [],
    },
    meeting: { objective: null, qualificationPurpose: "", preparation: [], statements: [] },
    crm: { recordFields: [], prohibitedWrites: [], statements: [] },
    measurement: { kpis: [], reviewCadence: null, statements: [] },
    optimization: { levers: [], guardrails: [], statements: [] },
  } as unknown as RevenuePlan["strategies"];
  const created = store.createRevenuePlan({
    workspaceId,
    createdBy: userId,
    plan: {
      revenueGoalId,
      compilerVersion: "deterministic-1.0.0",
      brainSnapshotDigest: "fnv1a-00000000",
      references: { offerId: null, icpId: null, personaIds: [] },
      strategies,
      facts: [],
      inferences: [],
      assumptions: [],
      recommendations: [],
      unknowns: [],
      approval: { approvesExternalActions: false, requiredFor: [], statements: [] },
      status: "proposed",
      rationale: "compiled from the goal",
    },
  });
  if (!isOk(created)) throw new Error("seed plan creation failed");
  return created.value;
}

/**
 * A source-backed claim: what research plus the evidence layer would produce.
 *
 * Written through the store rather than mocked, so the evaluator reads the same
 * shapes it will read in production — including the statuses a contradiction
 * leaves behind.
 */
function seedClaim(
  store: Store,
  workspaceId: string,
  userId: string,
  accountId: string,
  input: {
    category: AccountClaim["category"];
    field: string;
    value: string;
    status?: "asserted" | "contested" | "retracted";
    evidence?: {
      status?: "recorded" | "contradicted" | "superseded" | "rejected";
      confidence?: EvidenceRecord["confidence"];
      observedAt?: string | null;
      sourceName?: string;
    }[];
  },
): { claimId: string; evidenceIds: string[] } {
  const claim = store.createAccountClaim({
    workspaceId,
    createdBy: userId,
    accountId,
    category: input.category,
    field: input.field,
    value: input.value,
    claimKind: "fact",
  });
  if (!isOk(claim)) throw new Error("seed claim creation failed");
  if (input.status !== undefined && input.status !== "asserted") {
    const updated = store.updateAccountClaim(claim.value.id, { userId, status: input.status });
    if (!isOk(updated)) throw new Error("seed claim status failed");
  }
  const evidenceIds: string[] = [];
  for (const record of input.evidence ?? []) {
    const created = store.createEvidence({
      workspaceId,
      accountClaimId: claim.value.id,
      evidence: {
        researchFindingId: null,
        provenance: "user_supplied",
        source: "account_record",
        sourceName: record.sourceName ?? "company_registry",
        sourceUrl: null,
        sourceTitle: null,
        observedAt:
          record.observedAt === undefined ? "2026-09-01T00:00:00.000Z" : record.observedAt,
        retrievedAt: "2026-10-01T00:00:00.000Z",
        confidence: record.confidence ?? "medium",
        freshness: "fresh",
        relevance: "high",
        note: null,
        status: record.status ?? "recorded",
      },
    });
    if (!isOk(created)) throw new Error("seed evidence creation failed");
    evidenceIds.push(created.value.id);
    if (record.status !== undefined && record.status !== "recorded") {
      const updated = store.updateEvidence(created.value.id, {
        userId,
        status: record.status,
      });
      if (!isOk(updated)) throw new Error("seed evidence status failed");
    }
  }
  return { claimId: claim.value.id, evidenceIds };
}

function service(
  store: Store,
  icp: QualificationIcpSnapshot | null,
  goal: QualificationGoalSnapshot | null,
  plans: QualificationPlanReader = () => ({ ok: false, error: { code: "NOT_FOUND" } }),
): QualificationService {
  return new QualificationService(
    store as unknown as QualificationRepository,
    () => icp,
    (goalId, userId) => {
      const stored = store.getRevenueGoal(goalId, userId);
      return isOk(stored)
        ? { ok: true, value: toGoalSnapshot(stored.value) }
        : { ok: false, error: stored.error };
    },
    plans,
    NOW,
  );
}

/** A workspace whose ICP, goal and plan line up, ready to be evaluated. */
function scenario(
  store: Store,
  options: {
    email?: string;
    workspaceName?: string;
    accountName?: string;
    icp?: Partial<typeof DEFAULT_ICP> | null;
    planGoal?: boolean;
    window?: { start: string; end: string };
  } = {},
): {
  owner: User;
  workspaceId: string;
  account: Account;
  icp: QualificationIcpSnapshot | null;
  goal: QualificationGoalSnapshot | null;
  planId: string | null;
} {
  const owner = makeOwner(store, options.email ?? "owner@example.com");
  const workspaceId = makeWorkspace(store, owner.id, options.workspaceName ?? "Qualification Co");
  const icp =
    options.icp === null
      ? null
      : toIcpSnapshot(makeIcp(store, workspaceId, owner.id, options.icp ?? {}));
  const goal =
    options.planGoal === false
      ? null
      : toGoalSnapshot(
          makeGoal(
            store,
            workspaceId,
            owner.id,
            options.window ?? { start: "2026-07-01", end: "2026-12-31" },
          ),
        );
  const planId = goal === null ? null : makePlan(store, workspaceId, owner.id, goal.id).id;
  const account = makeAccount(
    store,
    workspaceId,
    owner.id,
    options.accountName ?? "Northwind Trading",
    planId,
  );
  return { owner, workspaceId, account, icp, goal, planId };
}

/** Evidence covering every criterion, so the account can actually resolve. */
function seedCompleteEvidence(
  store: Store,
  workspaceId: string,
  userId: string,
  accountId: string,
  overrides: {
    industry?: string;
    geography?: string;
    companySize?: string;
    businessModel?: string;
    observedAt?: string;
    confidence?: EvidenceRecord["confidence"];
  } = {},
): void {
  const observedAt = overrides.observedAt ?? "2026-09-15T00:00:00.000Z";
  seedClaim(store, workspaceId, userId, accountId, {
    category: "industry",
    field: "industry",
    value: overrides.industry ?? "B2B SaaS",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
  seedClaim(store, workspaceId, userId, accountId, {
    category: "company_overview",
    field: "geography",
    value: overrides.geography ?? "United Kingdom",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
  seedClaim(store, workspaceId, userId, accountId, {
    category: "company_overview",
    field: "company_size",
    value: overrides.companySize ?? "120 employees",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
  seedClaim(store, workspaceId, userId, accountId, {
    category: "business_model",
    field: "model",
    value: overrides.businessModel ?? "Subscription",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
  seedClaim(store, workspaceId, userId, accountId, {
    category: "hiring",
    field: "open_roles",
    value: "Hiring a support operations lead.",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
  seedClaim(store, workspaceId, userId, accountId, {
    category: "technology_signals",
    field: "stack_change",
    value: "Moved its helpdesk to a new vendor.",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
  seedClaim(store, workspaceId, userId, accountId, {
    category: "leadership_changes",
    field: "new_leader",
    value: "Appointed a VP of Revenue in September.",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
  seedClaim(store, workspaceId, userId, accountId, {
    category: "expansion",
    field: "new_region",
    value: "Opened a new region in October.",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
  seedClaim(store, workspaceId, userId, accountId, {
    category: "recent_announcements",
    field: "announcement",
    value: "Announced a partner programme in September.",
    evidence: [{ observedAt, confidence: overrides.confidence ?? "high" }],
  });
}

describe("qualification rules", () => {
  it("covers exactly the five dimensions ROADMAP.md §15 names", () => {
    expect([...QUALIFICATION_DIMENSIONS]).toEqual([
      "icp_fit",
      "need_fit",
      "buying_signal",
      "timing",
      "company_fit",
    ]);
    for (const dimension of QUALIFICATION_DIMENSIONS) {
      expect(QUALIFICATION_CRITERIA.some((rule) => rule.dimension === dimension)).toBe(true);
    }
    // Every criterion belongs to a declared dimension, exactly once.
    expect(new Set(QUALIFICATION_CRITERIA.map((rule) => rule.criterion)).size).toBe(
      QUALIFICATION_CRITERIA.length,
    );
  });

  it("matches a term on a word boundary, not a substring", () => {
    expect(matchesTerm("saas", "B2B SaaS")).toBe(true);
    expect(matchesTerm("saas", "b2b, saas.")).toBe(true);
    expect(matchesTerm("saas", "saasware")).toBe(false);
    expect(matchesTerm("", "anything")).toBe(false);
    expect(matchesTerm("saas", "")).toBe(false);
  });

  it("digests the context it was given, and nothing else", () => {
    const icp = toIcpSnapshot({
      id: "icp-1",
      ...DEFAULT_ICP,
      characteristics: [],
      notes: null,
      workspaceId: "w",
      createdAt: "",
      updatedAt: "",
    });
    const goal: QualificationGoalSnapshot = {
      id: "goal-1",
      workspaceId: "w",
      timeWindow: { start: "2026-07-01", end: "2026-12-31" },
    };
    const same = contextDigest(QUALIFICATION_RULE_VERSION, icp, goal);
    expect(contextDigest(QUALIFICATION_RULE_VERSION, icp, goal)).toBe(same);
    // Key order in the source object cannot change the digest.
    expect(
      contextDigest(
        QUALIFICATION_RULE_VERSION,
        { ...icp, disqualifiers: [...icp.disqualifiers] },
        goal,
      ),
    ).toBe(same);
    // A different ICP, a different goal or a different rule version must.
    expect(
      contextDigest(QUALIFICATION_RULE_VERSION, { ...icp, industries: ["fintech"] }, goal),
    ).not.toBe(same);
    expect(contextDigest(QUALIFICATION_RULE_VERSION, icp, null)).not.toBe(same);
    expect(contextDigest("deterministic-9.9.9", icp, goal)).not.toBe(same);
  });
});

describe("qualification criteria", () => {
  it("passes every criterion and issues a score when the evidence is complete", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store);
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error(`expected success, got ${result.error.code}`);
    const qualification = result.value;

    expect(qualification.state).toBe("qualified");
    expect(qualification.score).toBe(100);
    expect(qualification.confidence).toBe("high");
    expect(qualification.ruleVersion).toBe(QUALIFICATION_RULE_VERSION);
    expect(qualification.version).toBe(1);
    expect(qualification.evaluatedAt).toBe("2026-10-03T12:00:00.000Z");
    expect(qualification.icpId).toBe(icp?.id);
    expect(qualification.revenueGoalId).toBe(goal?.id);
    expect(qualification.revenuePlanId).toBe(planId);
    expect(qualification.conflictedClaimIds).toEqual([]);
    expect(qualification.dimensions).toHaveLength(5);

    // Every score carries a reason, its evidence and a confidence.
    const industry = qualification.dimensions
      .find((dimension) => dimension.dimension === "icp_fit")
      ?.criteria.find((criterion) => criterion.criterion === "industry_match");
    expect(industry?.result).toBe("pass");
    expect(industry?.reason).toContain("B2B SaaS");
    expect(industry?.confidence).toBe("high");
    expect(industry?.evidenceIds.length).toBeGreaterThan(0);
    expect(industry?.expectation).toContain("saas");
  });

  it("fails a criterion only on evidence that contradicts it", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store);
    seedCompleteEvidence(store, workspaceId, owner.id, account.id, {
      industry: "Wholesale distribution",
    });

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    const qualification = result.value;

    expect(qualification.state).toBe("unqualified");
    // One failed criterion out of ten costs exactly its dimension's share:
    // icp_fit scores 67, the other four score 100, and the mean is 93.
    expect(qualification.score).toBe(93);
    const icpFit = qualification.dimensions.find((dimension) => dimension.dimension === "icp_fit");
    expect(icpFit?.result).toBe("fail");
    expect(icpFit?.score).toBe(67);
    const industry = icpFit?.criteria.find((criterion) => criterion.criterion === "industry_match");
    expect(industry?.result).toBe("fail");
    expect(industry?.reason).toContain("matches none of the ICP terms");
    // The other two icp_fit criteria still passed on their own evidence.
    expect(icpFit?.criteria.filter((criterion) => criterion.result === "pass")).toHaveLength(2);
  });

  it("never turns a missing fact into a pass or a failure", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      planGoal: false,
    });

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    const qualification = result.value;

    // Nothing was researched: this is an explicit outcome, not an error.
    expect(qualification.state).toBe("insufficient_data");
    expect(qualification.score).toBeNull();
    expect(qualification.confidence).toBeNull();
    expect(qualification.reason).toContain("cannot be judged yet");
    for (const dimension of qualification.dimensions) {
      expect(dimension.result).toBe("unknown");
      // A null score is not a zero.
      expect(dimension.score).toBeNull();
      expect(dimension.resolvedCriteria).toBe(0);
      for (const criterion of dimension.criteria) {
        expect(criterion.result).toBe("unknown");
        expect(criterion.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("leaves timing unresolved when no revenue goal is linked, and infers none", () => {
    const store = seed();
    const { owner, workspaceId, account, icp } = scenario(store, { planGoal: false });
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);

    const result = service(store, icp, null, planFor("", workspaceId, null)).evaluateAccount(
      workspaceId,
      owner.id,
      account.id,
    );
    if (!isOk(result)) throw new Error("expected success");
    const qualification = result.value;

    expect(qualification.revenueGoalId).toBeNull();
    expect(qualification.state).toBe("insufficient_data");
    expect(qualification.score).toBeNull();
    const timing = qualification.dimensions.find((dimension) => dimension.dimension === "timing");
    expect(timing?.result).toBe("unknown");
    expect(timing?.criteria[0]?.reason).toContain("No revenue goal is linked");
    // Every other dimension resolved from the same evidence.
    const resolved = qualification.dimensions.filter((dimension) => dimension.result !== "unknown");
    expect(resolved).toHaveLength(4);
  });

  it("resolves timing against the goal window and fails observations outside it", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      window: { start: "2026-07-01", end: "2026-08-31" },
    });
    // Every observation sits after the window closed.
    seedCompleteEvidence(store, workspaceId, owner.id, account.id, {
      observedAt: "2026-09-15T00:00:00.000Z",
    });

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    const qualification = result.value;

    const timing = qualification.dimensions.find((dimension) => dimension.dimension === "timing");
    expect(timing?.criteria[0]?.result).toBe("fail");
    expect(timing?.criteria[0]?.reason).toContain(
      "none was observed inside the revenue goal window",
    );
    expect(qualification.state).toBe("unqualified");
    expect(qualification.score).toBe(80);
  });

  it("leaves timing unresolved when the observation carries no date", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store);
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);
    const claims = store.listAccountClaims(workspaceId, owner.id, { accountId: account.id });
    if (!isOk(claims)) throw new Error("claim read failed");
    const timingCategories = [
      "recent_announcements",
      "public_business_changes",
      "hiring",
      "expansion",
    ];
    for (const claim of claims.value.filter((entry) => timingCategories.includes(entry.category))) {
      for (const record of store.db.evidence.filter((row) => row.accountClaimId === claim.id)) {
        record.observedAt = null;
      }
    }

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    const timing = result.value.dimensions.find((dimension) => dimension.dimension === "timing");
    // No date is not an answer in either direction.
    expect(timing?.criteria[0]?.result).toBe("unknown");
    expect(timing?.result).toBe("unknown");
    expect(result.value.score).toBeNull();
  });

  it("refuses to resolve a contested claim, and says which one", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store);
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);

    // A second source disagrees about the company size, exactly as Phase 7
    // records it: both sides preserved, the claim flagged contested.
    const claims = store.listAccountClaims(workspaceId, owner.id, { accountId: account.id });
    if (!isOk(claims)) throw new Error("claim read failed");
    const sizeClaim = claims.value.find((claim) => claim.field === "company_size");
    if (!sizeClaim) throw new Error("fixture claim missing");
    const second = store.createEvidence({
      workspaceId,
      accountClaimId: sizeClaim.id,
      evidence: {
        researchFindingId: null,
        provenance: "user_supplied",
        source: "account_record",
        sourceName: "updated_registry",
        sourceUrl: null,
        sourceTitle: null,
        observedAt: "2026-09-15T00:00:00.000Z",
        retrievedAt: "2026-10-01T00:00:00.000Z",
        confidence: "high",
        freshness: "fresh",
        relevance: "high",
        note: null,
        status: "recorded",
      },
    });
    if (!isOk(second)) throw new Error("fixture evidence failed");
    const flagged = store.updateAccountClaim(sizeClaim.id, {
      userId: owner.id,
      status: "contested",
    });
    if (!isOk(flagged)) throw new Error("fixture claim status failed");
    const contradicted = store.updateEvidence(second.value.id, {
      userId: owner.id,
      status: "contradicted",
    });
    if (!isOk(contradicted)) throw new Error("fixture evidence status failed");

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    const qualification = result.value;

    // A conflict outranks mere absence, and no score is issued.
    expect(qualification.state).toBe("contested");
    expect(qualification.score).toBeNull();
    expect(qualification.conflictedClaimIds).toEqual([sizeClaim.id]);
    expect(qualification.reason).toContain("The sources disagree");

    // Neither side wins: the criterion is unresolved, and its reason names the
    // disagreement rather than picking a value.
    const companyFit = qualification.dimensions.find(
      (dimension) => dimension.dimension === "company_fit",
    );
    const size = companyFit?.criteria.find((criterion) => criterion.criterion === "company_size");
    expect(size?.result).toBe("unknown");
    expect(size?.observed).toBeNull();
    expect(size?.reason).toContain("does not choose between them");
    expect(size?.confidence).toBeNull();
    // Both records stay referenced, so the conflict is inspectable.
    expect(size?.evidenceIds).toHaveLength(2);
  });

  it("ignores a retracted claim rather than reading it as evidence", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store);
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);
    seedClaim(store, workspaceId, owner.id, account.id, {
      category: "company_overview",
      field: "geography",
      value: "Antarctica",
      status: "retracted",
      evidence: [{ confidence: "high" }],
    });

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    // The retracted claim is invisible, so the account qualifies exactly as it
    // would have without it.
    expect(result.value.state).toBe("qualified");
    expect(result.value.score).toBe(100);
  });

  it("reads only evidence that is still recorded", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store);
    seedClaim(store, workspaceId, owner.id, account.id, {
      category: "industry",
      field: "industry",
      value: "B2B SaaS",
      evidence: [{ confidence: "high", status: "rejected" }],
    });

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    const industry = result.value.dimensions
      .find((dimension) => dimension.dimension === "icp_fit")
      ?.criteria.find((criterion) => criterion.criterion === "industry_match");
    // Rejected evidence supports nothing, and its absence is not a mismatch.
    expect(industry?.result).toBe("unknown");
    expect(industry?.evidenceIds).toEqual([]);
  });

  it("fails an account whose own evidence states an ICP exclusion", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store);
    seedCompleteEvidence(store, workspaceId, owner.id, account.id, { businessModel: "Agency" });

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    const excluded = result.value.dimensions
      .find((dimension) => dimension.dimension === "icp_fit")
      ?.criteria.find((criterion) => criterion.criterion === "no_disqualifier");
    expect(excluded?.result).toBe("fail");
    expect(excluded?.observed).toBe("Agency");
    expect(excluded?.reason).toContain("the ICP excludes");
    expect(result.value.state).toBe("unqualified");
  });

  it("matches company size as the term the workspace wrote", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      icp: { companySizes: ["50 to 200"] },
    });
    seedCompleteEvidence(store, workspaceId, owner.id, account.id, { companySize: "200" });

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    const size = result.value.dimensions
      .find((dimension) => dimension.dimension === "company_fit")
      ?.criteria.find((criterion) => criterion.criterion === "company_size");
    // "200" alone is not the workspace's phrase, and DEALORA does not parse a
    // range to make it match.
    expect(size?.result).toBe("fail");
  });

  it("takes the confidence of the weakest supporting record", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store);
    seedCompleteEvidence(store, workspaceId, owner.id, account.id, { confidence: "low" });

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    expect(result.value.state).toBe("qualified");
    // A strong score on weak citations must not read as strong support.
    expect(result.value.score).toBe(100);
    expect(result.value.confidence).toBe("low");
  });

  it("stays unresolved when the ICP states no terms to match", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      icp: { industries: [], geographies: [], companySizes: [], businessModels: [] },
    });
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);

    const result = service(
      store,
      icp,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(result)) throw new Error("expected success");
    expect(result.value.score).toBeNull();
    expect(result.value.state).toBe("insufficient_data");
    const industry = result.value.dimensions
      .find((dimension) => dimension.dimension === "icp_fit")
      ?.criteria.find((criterion) => criterion.criterion === "industry_match");
    expect(industry?.reason).toContain("states none of them");
  });
});

describe("qualification determinism and auditability", () => {
  it("produces identical results for identical inputs", () => {
    const build = () => {
      const store = seed();
      const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
        email: "determinism@example.com",
        workspaceName: "Determinism Co",
      });
      seedCompleteEvidence(store, workspaceId, owner.id, account.id);
      const claims = store.listAccountClaims(workspaceId, owner.id, { accountId: account.id });
      const evidence = store.listEvidence(workspaceId, owner.id, { accountId: account.id });
      if (!isOk(claims) || !isOk(evidence)) throw new Error("fixture read failed");
      return {
        owner,
        workspaceId,
        account,
        icp,
        goal,
        planId,
        claims: claims.value,
        evidence: evidence.value,
      };
    };

    const first = build();
    const second = build();
    const one = evaluateQualification({
      accountId: first.account.id,
      icp: first.icp as QualificationIcpSnapshot,
      goal: first.goal,
      claims: first.claims,
      evidence: first.evidence,
    });
    const two = evaluateQualification({
      accountId: second.account.id,
      icp: second.icp as QualificationIcpSnapshot,
      goal: second.goal,
      claims: second.claims,
      evidence: second.evidence,
    });

    // The account ids differ between the two worlds; everything the engine
    // reasons from must serialize identically regardless.
    const strip = (evaluation: typeof one) =>
      JSON.stringify({
        ...evaluation,
        claimIds: evaluation.claimIds.length,
        evidenceIds: evaluation.evidenceIds.length,
        dimensions: evaluation.dimensions.map((dimension) => ({
          ...dimension,
          criteria: dimension.criteria.map((criterion) => ({
            ...criterion,
            evidenceIds: criterion.evidenceIds.length,
            claimIds: criterion.claimIds.length,
          })),
        })),
      });
    expect(strip(one)).toBe(strip(two));
    expect(one.score).toBe(100);
  });

  it("orders its references identically every run", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      email: "ordering@example.com",
      workspaceName: "Ordering Co",
    });
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);
    const engine = service(store, icp, goal, planFor(planId ?? "", workspaceId, goal?.id ?? null));
    const first = engine.evaluateAccount(workspaceId, owner.id, account.id);
    const second = engine.evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(first) || !isOk(second)) throw new Error("expected success");
    expect(second.value.evidenceIds).toEqual(first.value.evidenceIds);
    expect(second.value.claimIds).toEqual(first.value.claimIds);
    expect([...second.value.evidenceIds]).toEqual([...second.value.evidenceIds].sort());
  });

  it("version history: re-evaluating adds a record rather than rewriting one", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      email: "history@example.com",
      workspaceName: "History Co",
    });
    const engine = service(store, icp, goal, planFor(planId ?? "", workspaceId, goal?.id ?? null));

    const first = engine.evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(first)) throw new Error("expected success");
    expect(first.value.state).toBe("insufficient_data");

    seedCompleteEvidence(store, workspaceId, owner.id, account.id);
    const second = engine.evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(second)) throw new Error("expected success");
    expect(second.value.version).toBe(2);

    // The earlier record is untouched and still says what it said.
    const reread = engine.getQualification(first.value.id, owner.id);
    if (!isOk(reread)) throw new Error("expected success");
    expect(reread.value.version).toBe(1);
    expect(reread.value.state).toBe("insufficient_data");
    expect(reread.value.score).toBeNull();

    const listed = engine.listQualifications(workspaceId, owner.id, { accountId: account.id });
    if (!isOk(listed)) throw new Error("expected success");
    expect(listed.value.map((entry) => entry.version)).toEqual([2, 1]);
  });

  it("keeps a historical record explainable after the icp changes", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      email: "drift@example.com",
      workspaceName: "Drift Co",
    });
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);
    const engine = service(store, icp, goal, planFor(planId ?? "", workspaceId, goal?.id ?? null));
    const before = engine.evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(before)) throw new Error("expected success");
    expect(before.value.state).toBe("qualified");

    // The workspace redefines its target.
    const moved = toIcpSnapshot(
      makeIcp(store, workspaceId, owner.id, { industries: ["fintech"], disqualifiers: [] }),
    );
    const after = service(
      store,
      moved,
      goal,
      planFor(planId ?? "", workspaceId, goal?.id ?? null),
    ).evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(after)) throw new Error("expected success");
    expect(after.value.state).toBe("unqualified");
    expect(after.value.contextDigest).not.toBe(before.value.contextDigest);

    // The old record still explains itself, against the icp it actually used.
    const reread = engine.getQualification(before.value.id, owner.id);
    if (!isOk(reread)) throw new Error("expected success");
    expect(reread.value.state).toBe("qualified");
    expect(reread.value.contextDigest).toBe(before.value.contextDigest);
    const industry = reread.value.dimensions
      .find((dimension) => dimension.dimension === "icp_fit")
      ?.criteria.find((criterion) => criterion.criterion === "industry_match");
    expect(industry?.expectation).toContain("saas");
  });

  it("explains a score with the claim and evidence records it read", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      email: "inspect@example.com",
      workspaceName: "Inspect Co",
    });
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);
    const engine = service(store, icp, goal, planFor(planId ?? "", workspaceId, goal?.id ?? null));
    const evaluated = engine.evaluateAccount(workspaceId, owner.id, account.id);
    if (!isOk(evaluated)) throw new Error("expected success");

    const inspected = engine.inspectQualification(evaluated.value.id, owner.id);
    if (!isOk(inspected)) throw new Error("expected success");
    expect(inspected.value.qualification.id).toBe(evaluated.value.id);
    // Only what the decision actually read is joined back.
    expect(inspected.value.claims.length).toBe(evaluated.value.claimIds.length);
    expect(inspected.value.evidence.length).toBe(evaluated.value.evidenceIds.length);
    for (const record of inspected.value.evidence) {
      expect(record.source).toBeTruthy();
      expect(record.sourceName).toBeTruthy();
    }
  });

  it("exposes the criteria before an account is ever evaluated", () => {
    const store = seed();
    const { owner, workspaceId, icp } = scenario(store, {
      email: "criteria@example.com",
      workspaceName: "Criteria Co",
    });
    const view = service(store, icp, null).describeQualificationCriteria(workspaceId, owner.id);
    if (!isOk(view)) throw new Error("expected success");

    expect(view.value.ruleVersion).toBe(QUALIFICATION_RULE_VERSION);
    expect(view.value.supportedRuleVersions).toContain(QUALIFICATION_RULE_VERSION);
    expect(view.value.dimensions).toHaveLength(5);
    const icpFit = view.value.dimensions.find((dimension) => dimension.dimension === "icp_fit");
    expect(icpFit?.label).toBe("ICP Fit");
    expect(icpFit?.criteria).toHaveLength(3);
    // The rendered rule names this workspace's own ICP terms.
    expect(
      icpFit?.criteria.find((criterion) => criterion.criterion === "industry_match")?.expectation,
    ).toContain("saas");
    // And the timing rule is stated as a requirement, with no window invented.
    expect(
      view.value.dimensions.find((dimension) => dimension.dimension === "timing")?.criteria[0]
        ?.expectation,
    ).toContain("no revenue goal is selected");
  });
});

describe("qualification authorization and refusals", () => {
  it("refuses to evaluate an account from another workspace", () => {
    const store = seed();
    const ownerA = makeOwner(store, "a@example.com");
    const ownerB = makeOwner(store, "b@example.com");
    const wsA = makeWorkspace(store, ownerA.id, "Globex");
    const wsB = makeWorkspace(store, ownerB.id, "Initech");
    const icpA = toIcpSnapshot(makeIcp(store, wsA, ownerA.id, {}));
    const accountA = makeAccount(store, wsA, ownerA.id, "Confidential Trading");
    seedCompleteEvidence(store, wsA, ownerA.id, accountA.id);
    const engine = service(store, icpA, null);

    const denied = engine.evaluateAccount(wsB, ownerB.id, accountA.id);
    if (isOk(denied)) throw new Error("a foreign account was qualified");
    // Another tenant's account is not even revealed to exist.
    expect(denied.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(denied.error)).not.toContain("Confidential");
  });

  it("refuses a workspace the caller does not belong to", () => {
    const store = seed();
    const ownerA = makeOwner(store, "c@example.com");
    const ownerB = makeOwner(store, "d@example.com");
    const wsA = makeWorkspace(store, ownerA.id, "Acme A");
    const icpA = toIcpSnapshot(makeIcp(store, wsA, ownerA.id, {}));
    const engine = service(store, icpA, null);
    const denied = engine.evaluateAccount(wsA, ownerB.id, "some-account");
    if (isOk(denied)) throw new Error("an unauthorized workspace was evaluated");
    expect(denied.error.code).toBe("UNAUTHORIZED");
  });

  it("refuses to evaluate without an icp rather than guessing a target", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store, { icp: null });
    const denied = service(store, null, null).evaluateAccount(workspaceId, owner.id, account.id);
    if (isOk(denied)) throw new Error("an account was qualified with no icp");
    expect(denied.error.code).toBe("NOT_FOUND");
    expect(denied.error.message).toContain("no icp");
  });

  it("refuses a revenue goal that belongs to another workspace", () => {
    const store = seed();
    const ownerA = makeOwner(store, "e@example.com");
    const ownerB = makeOwner(store, "f@example.com");
    const wsA = makeWorkspace(store, ownerA.id, "Goal A");
    const wsB = makeWorkspace(store, ownerB.id, "Goal B");
    const icpA = toIcpSnapshot(makeIcp(store, wsA, ownerA.id, {}));
    const goalB = makeGoal(store, wsB, ownerB.id, { start: "2026-07-01", end: "2026-12-31" });
    const accountA = makeAccount(store, wsA, ownerA.id, "Goal Trading");
    const engine = service(store, icpA, null);

    // A goal from another tenant is not found, not borrowed.
    const denied = engine.evaluateAccount(wsA, ownerA.id, accountA.id, { revenueGoalId: goalB.id });
    if (isOk(denied)) throw new Error("a foreign goal was used");
    expect(denied.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(denied.error)).not.toContain("Goal B");
  });

  it("refuses an unsupported rule version", () => {
    const store = seed();
    const { owner, workspaceId, account, icp } = scenario(store, {
      email: "rules@example.com",
      workspaceName: "Rules Co",
    });
    const denied = service(store, icp, null).evaluateAccount(workspaceId, owner.id, account.id, {
      ruleVersion: "gpt-ranked-1.0.0",
    });
    if (isOk(denied)) throw new Error("an unsupported rule version was accepted");
    expect(denied.error.code).toBe("UNSUPPORTED_RULE_VERSION");
    // The supported set is the only one it will ever accept.
    expect(QualificationService.supportedRuleVersions()).toEqual([QUALIFICATION_RULE_VERSION]);
  });

  it("accepts only criteria vocabulary it defines", () => {
    const store = seed();
    const { owner, workspaceId } = scenario(store, {
      email: "vocab@example.com",
      workspaceName: "Vocab Co",
    });
    const engine = service(store, null, null);
    const bad = engine.listQualifications(workspaceId, owner.id, { state: "hot" });
    if (isOk(bad)) throw new Error("an unknown state filter was accepted");
    expect(bad.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses an archived account", () => {
    const store = seed();
    const { owner, workspaceId, account, icp } = scenario(store, {
      email: "archived@example.com",
      workspaceName: "Archived Co",
    });
    const archived = store.archiveAccount(account.id, owner.id);
    if (!isOk(archived)) throw new Error("account archiving failed");
    const denied = service(store, icp, null).evaluateAccount(workspaceId, owner.id, account.id);
    if (isOk(denied)) throw new Error("an archived account was qualified");
    expect(denied.error.code).toBe("CONFLICT");
  });

  it("never lets a caller supply the result", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      email: "inject@example.com",
      workspaceName: "Inject Co",
    });
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);
    const engine = service(store, icp, goal, planFor(planId ?? "", workspaceId, goal?.id ?? null));

    // Everything a caller might try to assert is simply not an input. Typed as a
    // loose record so the call compiles the way a real request body would
    // arrive — the service accepts an untrusted shape, not a typed one.
    const asserted: Record<string, unknown> = {
      score: 100,
      state: "qualified",
      confidence: "high",
      priority: 1,
      dimensions: [{ dimension: "icp_fit", score: 100, result: "pass" }],
    };
    const result = engine.evaluateAccount(workspaceId, owner.id, account.id, asserted);
    if (!isOk(result)) throw new Error("expected success");
    // The score came from the evidence, so the asserted values changed nothing.
    expect(result.value.score).toBe(100);
    expect(result.value.state).toBe("qualified");
    expect(result.value.confidence).toBe("high");
    expect(result.value.ruleVersion).toBe(QUALIFICATION_RULE_VERSION);
    // And the criteria were computed, not copied from the request.
    expect(result.value.dimensions[0]?.criteria).toHaveLength(3);
    expect(
      result.value.dimensions[0]?.criteria.every((criterion) => criterion.result === "pass"),
    ).toBe(true);
  });
});

describe("qualification makes no downstream action", () => {
  it("stores a decision and nothing else", () => {
    const store = seed();
    const { owner, workspaceId, account, icp, goal, planId } = scenario(store, {
      email: "sideeffects@example.com",
      workspaceName: "Side Effects Co",
    });
    seedCompleteEvidence(store, workspaceId, owner.id, account.id);
    const before = JSON.stringify(store.db);

    service(store, icp, goal, planFor(planId ?? "", workspaceId, goal?.id ?? null)).evaluateAccount(
      workspaceId,
      owner.id,
      account.id,
    );

    // Only the qualification table changed. Nothing was sent, scheduled, or
    // written to an account, a claim or a piece of evidence.
    const added = (store.db.qualifications ?? []).length;
    expect(added).toBe(1);
    const withoutEvaluations = { ...store.db, qualifications: [] };
    const previous = JSON.parse(before) as Record<string, unknown>;
    const now = JSON.parse(JSON.stringify(withoutEvaluations)) as Record<string, unknown>;
    expect(JSON.stringify(now)).toBe(JSON.stringify(previous));

    // And the persisted record holds a decision, not an action or a message.
    const document = JSON.stringify(store.db.qualifications);
    for (const forbidden of [
      "messageBody",
      "emailSubject",
      "linkedin",
      "crmSync",
      "opportunityId",
      "meetingId",
      "approvedBy",
      "outreachSent",
      "contactedAt",
      "personalized",
    ]) {
      expect(document).not.toContain(forbidden);
    }
    const record = store.db.qualifications[0];
    expect(record?.state).toBe("qualified");
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
  });
});
