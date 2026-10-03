import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";
import type { RevenueGoal } from "@dealora/db";

import { RevenuePlanService } from "./service.js";
import type { GoalReader, PlanBrainReader, PlanRepository } from "./service.js";
import { DeterministicPlanCompiler, brainSnapshotDigest } from "./compiler.js";
import { PLAN_TRANSITIONS, assertGoalCompilable, validatePlanDraft } from "./validation.js";
import type { PlanBrainSnapshot } from "./types.js";

/**
 * Revenue Plan Compiler — domain coverage.
 *
 * The store is the real persistence layer, so these tests exercise
 * authorization, versioning and persistence exactly as production does.
 */

function fixture(): {
  service: RevenuePlanService;
  compiler: DeterministicPlanCompiler;
  store: Store;
  userA: string;
  workspaceA: string;
  goalId: string;
  brain: PlanBrainSnapshot;
  userB: string;
  workspaceB: string;
  goalIdB: string;
} {
  const store = new Store(emptyState());

  const userA = store.createUser({
    email: "a@example.com",
    password: "correct-horse-battery",
    displayName: "Owner A",
  });
  const userB = store.createUser({
    email: "b@example.com",
    password: "correct-horse-battery",
    displayName: "Owner B",
  });
  if (!isOk(userA) || !isOk(userB)) throw new Error("fixture users failed");

  const wsA = store.createWorkspace({ ownerId: userA.value.id, name: "Acme" });
  const wsB = store.createWorkspace({ ownerId: userB.value.id, name: "Globex" });
  if (!isOk(wsA) || !isOk(wsB)) throw new Error("fixture workspaces failed");

  // Canonical Business Brain for tenant A.
  store.createBusinessProfile({
    workspaceId: wsA.value.id,
    ownerId: userA.value.id,
    name: "Acme Corp",
    description: "Automation agency",
    market: "B2B SaaS",
    industry: "Software",
  });
  const offer = store.createOffer({
    workspaceId: wsA.value.id,
    userId: userA.value.id,
    name: "AI automation",
    description: "Automates the inbound revenue motion",
  });
  const icp = store.upsertIcp(wsA.value.id, userA.value.id, {
    industries: ["SaaS"],
    companySizes: ["50-500"],
    geographies: ["US"],
    characteristics: ["Hiring support engineers"],
    disqualifiers: ["Pre-revenue"],
  });
  const persona = store.createPersona(wsA.value.id, userA.value.id, {
    title: "Head of Revenue",
    painPoints: ["Pipeline is hard to forecast"],
    goals: ["More qualified meetings"],
    buyingContext: "Quarterly planning",
  });
  const positioning = store.upsertPositioning(wsA.value.id, userA.value.id, {
    statement: "We automate the revenue motion for B2B SaaS",
    differentiators: ["Domain-specific playbooks"],
    approvedValuePropositions: ["Cut time to first response"],
  });
  store.upsertBrandVoice(wsA.value.id, userA.value.id, { tone: ["direct"] });
  const approved = store.createClaim({
    workspaceId: wsA.value.id,
    userId: userA.value.id,
    text: "SOC 2 Type II certified",
    category: "certification",
  });
  if (!isOk(approved)) throw new Error("fixture claim failed");
  if (!isOk(store.approveClaim(approved.value.id, userA.value.id))) {
    throw new Error("fixture claim approval failed");
  }
  if (
    !isOk(
      store.createClaim({
        workspaceId: wsA.value.id,
        userId: userA.value.id,
        text: "Doubled revenue for 40 clients",
        category: "result",
      }),
    )
  ) {
    throw new Error("fixture unverified claim failed");
  }

  if (!isOk(offer) || !isOk(icp) || !isOk(persona) || !isOk(positioning)) {
    throw new Error("fixture brain failed");
  }

  const brain: PlanBrainSnapshot = {
    workspaceId: wsA.value.id,
    company: { name: "Acme Corp", market: "B2B SaaS", industry: "Software", size: null },
    offers: [
      {
        id: offer.value.id,
        name: offer.value.name,
        description: offer.value.description,
        outcome: null,
      },
    ],
    icp: {
      id: icp.value.id,
      industries: icp.value.industries,
      companySizes: icp.value.companySizes,
      geographies: icp.value.geographies,
      characteristics: icp.value.characteristics,
      disqualifiers: icp.value.disqualifiers,
    },
    personas: [
      {
        id: persona.value.id,
        title: persona.value.title,
        painPoints: persona.value.painPoints,
        goals: persona.value.goals,
        buyingContext: persona.value.buyingContext,
      },
    ],
    positioning: {
      statement: positioning.value.statement,
      differentiators: positioning.value.differentiators,
      approvedValuePropositions: positioning.value.approvedValuePropositions,
    },
    brandVoice: { tone: ["direct"], constraints: [] },
    approvedClaims: [{ id: approved.value.id, text: approved.value.text }],
    withheldClaims: { unverified: 1, restricted: 0 },
  };

  const goals = new Map<string, RevenueGoal>();
  // A const arrow (not a hoisted declaration) so the narrowing from the
  // Brain fixture guard above holds inside the closure.
  const seedGoal = (
    workspaceId: string,
    createdBy: string,
    overrides: Partial<RevenueGoal> = {},
  ): string => {
    const created = store.createRevenueGoal({
      workspaceId,
      createdBy,
      goal: {
        objective: "Generate $100,000 of qualified pipeline from mid-market SaaS companies",
        targetMetric: "pipeline",
        targetValue: 100000,
        currency: "USD",
        timeWindow: { start: "2026-03-01", end: "2026-06-01" },
        market: "B2B SaaS",
        icpId: icp.value.id,
        buyerPersonaIds: [persona.value.id],
        offerId: offer.value.id,
        economics: {
          averageDealValue: null,
          minimumContractValue: 2000,
          targetCustomers: null,
          currency: "USD",
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
        successMetrics: [
          { kind: "pipeline", target: 100000, unit: "USD" },
          { kind: "meeting", target: 12, unit: "count" },
        ],
        status: "draft",
        completeness: "complete",
        unknowns: [],
        assumptions: [],
        ...overrides,
      },
    });
    if (!isOk(created)) throw new Error("fixture goal failed");
    goals.set(created.value.id, created.value);
    return created.value.id;
  };

  const goalId = seedGoal(wsA.value.id, userA.value.id);
  const goalIdB = seedGoal(wsB.value.id, userB.value.id, { market: "Healthcare" });

  // The reader delegates to the store, which authorizes the caller itself, so
  // the service is tested against real ownership checks rather than a stub.
  const goalReader: GoalReader = (id, userId) =>
    store.getRevenueGoal(id, userId) as ReturnType<GoalReader>;

  const brainReader: PlanBrainReader = (workspaceId) => {
    if (workspaceId !== wsA.value.id) {
      throw new Error(`no business brain for ${workspaceId}`);
    }
    return brain;
  };

  const service = new RevenuePlanService(
    store as unknown as PlanRepository,
    new DeterministicPlanCompiler(),
    goalReader,
    brainReader,
  );

  return {
    service,
    compiler: new DeterministicPlanCompiler(),
    store,
    userA: userA.value.id,
    workspaceA: wsA.value.id,
    goalId,
    brain,
    userB: userB.value.id,
    workspaceB: wsB.value.id,
    goalIdB,
  };
}

describe("Revenue Plan — compilation", () => {
  it("compiles a complete goal into a structured plan", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const plan = result.value;

    expect(plan.revenueGoalId).toBe(goalId);
    expect(plan.workspaceId).toBe(workspaceA);
    expect(plan.createdBy).toBe(userA);
    expect(plan.version).toBe(1);
    expect(plan.status).toBe("proposed");
    expect(plan.compilerVersion).toBe("deterministic-1.0.0");
    expect(plan.rationale.length).toBeGreaterThan(0);
    expect(plan.brainSnapshotDigest).toMatch(/^fnv1a-[0-9a-f]{8}$/);
  });

  it("exposes every roadmap strategy section", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const s = result.value.strategies;

    expect(s.icp.targetMarket).toBe("B2B SaaS");
    expect(s.icp.industries).toEqual(["SaaS"]);
    expect(s.icp.disqualifiers).toEqual(["Pre-revenue"]);
    expect(s.buyer.personas).toHaveLength(1);
    expect(s.buyer.personas[0]?.title).toBe("Head of Revenue");
    expect(s.sourcing.approach.length).toBeGreaterThan(0);
    expect(s.sourcing.accountProfile.length).toBeGreaterThan(0);
    expect(s.signal.signals.map((x) => x.kind)).toContain("hiring");
    expect(s.qualification.criteria.map((c) => c.name)).toEqual([
      "icp_fit",
      "need_fit",
      "buying_signal",
      "timing",
      "company_fit",
    ]);
    expect(s.outreach.channels).toEqual(["email"]);
    expect(s.outreach.approvalRequired).toBe(true);
    expect(s.followUp.responseStates).toContain("interested");
    expect(s.meeting.objective?.length).toBeGreaterThan(0);
    expect(s.crm.recordFields.length).toBeGreaterThan(0);
    expect(s.measurement.kpis).toHaveLength(2);
    expect(s.optimization.levers.map((l) => l.name)).toContain("audience");
  });

  it("references canonical Brain records instead of copying the Brain", () => {
    const { service, workspaceA, userA, goalId, brain } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.references.icpId).toBe(brain.icp?.id);
    expect(result.value.references.personaIds).toEqual([brain.personas[0]?.id]);
    expect(result.value.brainSnapshotDigest).toBe(brainSnapshotDigest(brain));
    // An unapproved claim never reaches the plan.
    expect(JSON.stringify(result.value)).not.toContain("Doubled revenue for 40 clients");
  });

  it("never claims the plan approves external actions", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.approval.approvesExternalActions).toBe(false);
    expect(result.value.approval.requiredFor).toEqual(["level_2_external_action"]);
    expect(
      result.value.approval.statements.some((s) => s.text.includes("does not authorize")),
    ).toBe(true);
  });

  it("states that nothing was executed", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const serialized = JSON.stringify(result.value);
    expect(serialized).toContain("Nothing has been sent");
    expect(serialized).toContain("No accounts have been sourced");
    expect(serialized).toContain("Phase 4 writes no CRM record");
    // No execution artifact is ever created.
    for (const artifact of [
      "sentAt",
      "deliveredAt",
      "messageId",
      "crmRecordId",
      "calendarEventId",
    ]) {
      expect(serialized).not.toContain(artifact);
    }
  });
});

describe("Revenue Plan — facts versus recommendations", () => {
  it("classifies every statement and rolls them up by kind", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const plan = result.value;

    expect(plan.facts.length).toBeGreaterThan(0);
    expect(plan.recommendations.length).toBeGreaterThan(0);
    expect(plan.unknowns.length).toBeGreaterThan(0);
    expect(plan.facts.every((s) => s.kind === "fact")).toBe(true);
    expect(plan.recommendations.every((s) => s.kind === "recommendation")).toBe(true);
    expect(plan.unknowns.every((s) => s.kind === "unknown" && s.basis === "none")).toBe(true);
  });

  it("derives facts from the Business Brain with a reference", () => {
    const { service, workspaceA, userA, goalId, brain } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const icpFacts = result.value.facts.filter((s) => s.basis === "brain:icp");
    expect(icpFacts.length).toBeGreaterThan(0);
    expect(icpFacts.some((s) => s.references?.includes(brain.icp?.id ?? ""))).toBe(true);
  });

  it("records unverified claims as withheld rather than usable messaging", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const outreach = result.value.strategies.outreach;
    const claimStatement = result.value.facts.find((s) => s.text.includes("unverified"));
    expect(claimStatement).toBeTruthy();
    // The withheld claim text never becomes a messaging angle.
    expect(outreach.messagingAngles.join(" ")).not.toContain("Doubled revenue");
  });

  it("rejects a draft with an unclassified statement", () => {
    const { compiler, brain, store, userA, goalId } = fixture();
    const goal = store.getRevenueGoal(goalId, userA);
    if (!isOk(goal)) throw new Error("goal missing");
    const draft = compiler.compile({ goal: goal.value, brain });
    const broken = {
      ...draft,
      strategies: {
        ...draft.strategies,
        icp: { ...draft.strategies.icp, statements: [{ text: "no kind" } as never] },
      },
    };
    const invalid = validatePlanDraft(broken);
    expect(invalid).not.toBeNull();
    if (!invalid) return;
    expect(invalid.details?.some((d) => d.field.includes("kind"))).toBe(true);
  });

  it("rejects a draft that claims it approves external actions", () => {
    const { compiler, brain, store, userA, goalId } = fixture();
    const goal = store.getRevenueGoal(goalId, userA);
    if (!isOk(goal)) throw new Error("goal missing");
    const draft = compiler.compile({ goal: goal.value, brain });
    const invalid = validatePlanDraft({
      ...draft,
      approval: { ...draft.approval, approvesExternalActions: true as never },
    });
    expect(invalid).not.toBeNull();
    if (!invalid) return;
    expect(invalid.details?.some((d) => d.field === "approval.approvesExternalActions")).toBe(true);
  });
});

describe("Revenue Plan — determinism", () => {
  it("compiles identical content from identical input", () => {
    const { compiler, brain, store, userA, goalId } = fixture();
    const goal = store.getRevenueGoal(goalId, userA);
    if (!isOk(goal)) throw new Error("goal missing");

    const first = compiler.compile({ goal: goal.value, brain });
    const second = compiler.compile({ goal: goal.value, brain });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    // 25 repeats: no clock, no randomness, no ordering drift.
    for (let i = 0; i < 25; i++) {
      expect(JSON.stringify(compiler.compile({ goal: goal.value, brain }))).toBe(
        JSON.stringify(first),
      );
    }
  });

  it("produces a different digest when the Business Brain changes", () => {
    const { brain } = fixture();
    const other: PlanBrainSnapshot = {
      ...brain,
      company: brain.company === null ? null : { ...brain.company, market: "Healthcare" },
    };
    expect(brainSnapshotDigest(brain)).not.toBe(brainSnapshotDigest(other));
  });

  it("ignores key order when digesting the Brain", () => {
    const { brain } = fixture();
    const reordered = JSON.parse(
      JSON.stringify({
        personas: brain.personas,
        icp: brain.icp,
        offers: brain.offers,
        company: brain.company,
        workspaceId: brain.workspaceId,
        positioning: brain.positioning,
        brandVoice: brain.brandVoice,
        approvedClaims: brain.approvedClaims,
        withheldClaims: brain.withheldClaims,
      }),
    ) as PlanBrainSnapshot;
    expect(brainSnapshotDigest(reordered)).toBe(brainSnapshotDigest(brain));
  });

  it("changes the plan when the goal changes", () => {
    const { service, workspaceA, userA, goalId, store } = fixture();
    const first = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const updated = store.updateRevenueGoal(goalId, {
      userId: userA,
      patch: { targetValue: 250000 },
    });
    expect(isOk(updated)).toBe(true);

    const second = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(JSON.stringify(second.value.strategies)).not.toBe(
      JSON.stringify(first.value.strategies),
    );
  });
});

describe("Revenue Plan — preconditions", () => {
  it("refuses an incomplete goal and reports what is missing", () => {
    const { service, workspaceA, userA, store, goalId } = fixture();
    // The goal package records completeness; simulate an incomplete goal by
    // compiling a goal that never resolved its offer.
    const incomplete = store.createRevenueGoal({
      workspaceId: workspaceA,
      createdBy: userA,
      goal: {
        objective: "Generate pipeline",
        targetMetric: "pipeline",
        targetValue: 1000,
        currency: "USD",
        timeWindow: { start: "2026-03-01", end: "2026-06-01" },
        market: null,
        icpId: null,
        buyerPersonaIds: [],
        offerId: null,
        economics: {
          averageDealValue: null,
          minimumContractValue: null,
          targetCustomers: null,
          currency: "USD",
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
        successMetrics: [{ kind: "pipeline", target: 1000, unit: "USD" }],
        status: "draft",
        completeness: "incomplete",
        unknowns: [
          { field: "offerId", reason: "no Business Brain offer is referenced" },
          { field: "market", reason: "no target market was determined" },
        ],
        assumptions: [],
      },
    });
    if (!isOk(incomplete)) throw new Error("fixture goal failed");

    const result = service.compileRevenuePlan(workspaceA, userA, incomplete.value.id);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toContain("incomplete");
    expect(result.error.details?.map((d) => d.field).sort()).toEqual(["market", "offerId"]);
    // No plan was created for the incomplete goal.
    expect(store.db.revenuePlans ?? []).toHaveLength(0);
    expect(goalId).not.toBe("");
  });

  it("refuses an archived goal", () => {
    const { service, workspaceA, userA, store, goalId } = fixture();
    store.setRevenueGoalStatus(goalId, userA, "active");
    store.setRevenueGoalStatus(goalId, userA, "completed");
    store.setRevenueGoalStatus(goalId, userA, "archived");

    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CONFLICT");
    expect(result.error.message).toContain("archived");
  });

  it("reports a missing or malformed goal id", () => {
    const { service, workspaceA, userA } = fixture();
    expect(isErr(service.compileRevenuePlan(workspaceA, userA, ""))).toBe(true);
    expect(isErr(service.compileRevenuePlan(workspaceA, userA, null))).toBe(true);
    const missing = service.compileRevenuePlan(workspaceA, userA, "no-such-goal");
    expect(isErr(missing)).toBe(true);
    if (isErr(missing)) expect(missing.error.code).toBe("NOT_FOUND");
  });

  it("rejects an unauthenticated caller before compiling", () => {
    const { service, workspaceA, goalId } = fixture();
    const result = service.compileRevenuePlan(workspaceA, "", goalId);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a missing workspace id", () => {
    const { service, userA, goalId } = fixture();
    const result = service.compileRevenuePlan("", userA, goalId);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("validates goal preconditions directly", () => {
    expect(
      assertGoalCompilable({ status: "draft", completeness: "complete", unknowns: [] }),
    ).toBeNull();
    const archived = assertGoalCompilable({
      status: "archived",
      completeness: "complete",
      unknowns: [],
    });
    expect(archived?.code).toBe("CONFLICT");
    const incomplete = assertGoalCompilable({
      status: "active",
      completeness: "incomplete",
      unknowns: [{ field: "offerId", reason: "missing" }],
    });
    expect(incomplete?.details?.[0]?.field).toBe("offerId");
  });
});

describe("Revenue Plan — versioning", () => {
  it("creates a new version instead of overwriting", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const first = service.compileRevenuePlan(workspaceA, userA, goalId);
    const second = service.compileRevenuePlan(workspaceA, userA, goalId);
    const third = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(first) && isOk(second) && isOk(third)).toBe(true);
    if (!isOk(first) || !isOk(second) || !isOk(third)) return;

    expect(first.value.version).toBe(1);
    expect(second.value.version).toBe(2);
    expect(third.value.version).toBe(3);
    // Distinct rows, none destroyed.
    expect(new Set([first.value.id, second.value.id, third.value.id]).size).toBe(3);
  });

  it("versions per goal, not per workspace", () => {
    const { service, workspaceA, userA, goalId, brain, store } = fixture();
    const other = store.createRevenueGoal({
      workspaceId: workspaceA,
      createdBy: userA,
      goal: {
        objective: "Second goal",
        targetMetric: "revenue",
        targetValue: 5000,
        currency: "USD",
        timeWindow: { start: "2026-03-01", end: "2026-06-01" },
        market: "B2B SaaS",
        icpId: brain.icp?.id ?? null,
        buyerPersonaIds: [],
        offerId: null,
        economics: {
          averageDealValue: null,
          minimumContractValue: null,
          targetCustomers: null,
          currency: "USD",
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
        successMetrics: [{ kind: "revenue", target: 5000, unit: "USD" }],
        status: "draft",
        completeness: "complete",
        unknowns: [],
        assumptions: [],
      },
    });
    if (!isOk(other)) throw new Error("second goal failed");

    const first = service.compileRevenuePlan(workspaceA, userA, goalId);
    service.compileRevenuePlan(workspaceA, userA, goalId);
    const otherPlan = service.compileRevenuePlan(workspaceA, userA, other.value.id);
    expect(isOk(first) && isOk(otherPlan)).toBe(true);
    if (!isOk(first) || !isOk(otherPlan)) return;
    expect(first.value.version).toBe(1);
    expect(otherPlan.value.version).toBe(1);
  });

  it("keeps every historical version inspectable", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const first = service.compileRevenuePlan(workspaceA, userA, goalId);
    service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const history = service.planHistory(first.value.id, userA);
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    expect(history.value.map((p) => p.version)).toEqual([1, 2]);
    expect(history.value[0]?.id).toBe(first.value.id);
  });

  it("records the compiler version on every plan", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const result = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.compilerVersion).toBe("deterministic-1.0.0");
    expect(result.value.createdAt).toBeTruthy();
    expect(result.value.updatedAt).toBeTruthy();
  });
});

describe("Revenue Plan — lifecycle", () => {
  it("follows the valid transition path proposed → approved → archived", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const created = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const approved = service.changeRevenuePlanStatus(created.value.id, userA, "approved");
    expect(isOk(approved)).toBe(true);
    if (!isOk(approved)) return;
    expect(approved.value.status).toBe("approved");
    // Plan approval still does not authorize execution.
    expect(approved.value.approval.approvesExternalActions).toBe(false);

    const archived = service.archiveRevenuePlan(created.value.id, userA);
    expect(isOk(archived)).toBe(true);
    if (!isOk(archived)) return;
    expect(archived.value.status).toBe("archived");
  });

  it("treats archived as terminal", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const created = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    service.archiveRevenuePlan(created.value.id, userA);

    const reopen = service.changeRevenuePlanStatus(created.value.id, userA, "proposed");
    expect(isErr(reopen)).toBe(true);
    if (isErr(reopen)) expect(reopen.error.code).toBe("INVALID_TRANSITION");
  });

  it("rejects an unknown status from a client", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const created = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const result = service.changeRevenuePlanStatus(created.value.id, userA, "executing");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("declares exactly the allowed transitions", () => {
    expect(PLAN_TRANSITIONS.draft).toEqual(["proposed", "archived"]);
    expect(PLAN_TRANSITIONS.proposed).toEqual(["approved", "draft", "archived"]);
    expect(PLAN_TRANSITIONS.approved).toEqual(["archived"]);
    expect(PLAN_TRANSITIONS.archived).toEqual([]);
  });
});

describe("Revenue Plan — retrieval and workspace isolation", () => {
  it("retrieves a compiled plan", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const created = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const fetched = service.getRevenuePlan(created.value.id, userA);
    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.value.id).toBe(created.value.id);
    expect(fetched.value.rationale).toBe(created.value.rationale);
  });

  it("lists plans scoped to the workspace", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    service.compileRevenuePlan(workspaceA, userA, goalId);
    const listed = service.listRevenuePlans(workspaceA, userA);
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(1);

    const filtered = service.listRevenuePlans(workspaceA, userA, { status: "proposed" });
    expect(isOk(filtered) && filtered.value).toHaveLength(1);
    const archived = service.listRevenuePlans(workspaceA, userA, { status: "archived" });
    expect(isOk(archived) && archived.value).toHaveLength(0);
  });

  it("rejects an invalid status filter", () => {
    const { service, workspaceA, userA } = fixture();
    const result = service.listRevenuePlans(workspaceA, userA, {
      status: "executing" as never,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("denies another tenant reading, listing or changing the plan", () => {
    const { service, workspaceA, userA, userB, goalId } = fixture();
    const created = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const read = service.getRevenuePlan(created.value.id, userB);
    expect(isErr(read)).toBe(true);
    if (isErr(read)) expect(read.error.code).toBe("UNAUTHORIZED");

    const list = service.listRevenuePlans(workspaceA, userB);
    expect(isErr(list)).toBe(true);

    const status = service.changeRevenuePlanStatus(created.value.id, userB, "approved");
    expect(isErr(status)).toBe(true);
    if (isErr(status)) expect(status.error.code).toBe("UNAUTHORIZED");

    const history = service.planHistory(created.value.id, userB);
    expect(isErr(history)).toBe(true);

    // No tenant data leaks into the denial.
    expect(JSON.stringify(read)).not.toContain("qualified pipeline");
  });

  it("denies compiling another tenant's goal into this workspace", () => {
    const { service, workspaceA, userA, goalIdB } = fixture();
    // The caller owns workspace A but the goal lives in workspace B.
    const result = service.compileRevenuePlan(workspaceA, userA, goalIdB);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("UNAUTHORIZED");
      expect(JSON.stringify(result.error)).not.toContain("Healthcare");
    }
  });

  it("keeps each tenant's plans separate", () => {
    const { service, workspaceA, workspaceB, userA, userB, goalId } = fixture();
    service.compileRevenuePlan(workspaceA, userA, goalId);

    const other = service.listRevenuePlans(workspaceB, userB);
    expect(isOk(other)).toBe(true);
    if (!isOk(other)) return;
    expect(other.value).toHaveLength(0);
  });

  it("denies an unauthenticated retrieval", () => {
    const { service, workspaceA, userA, goalId } = fixture();
    const created = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(isErr(service.getRevenuePlan(created.value.id, ""))).toBe(true);
  });

  it("reports a missing plan", () => {
    const { service, userA } = fixture();
    const result = service.getRevenuePlan("no-such-plan", userA);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("NOT_FOUND");
    expect(isErr(service.getRevenuePlan("", userA))).toBe(true);
  });
});

describe("Revenue Plan — persistence", () => {
  it("survives a reload from the persisted document", () => {
    const { service, store, workspaceA, userA, goalId } = fixture();
    const created = service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const reloaded = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const service2 = new RevenuePlanService(
      reloaded as unknown as PlanRepository,
      new DeterministicPlanCompiler(),
      ((id, user) => reloaded.getRevenueGoal(id, user)) as GoalReader,
      () => {
        throw new Error("no brain reader");
      },
    );
    const fetched = service2.getRevenuePlan(created.value.id, userA);
    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.value.version).toBe(1);
    expect(fetched.value.compilerVersion).toBe("deterministic-1.0.0");
    expect(JSON.stringify(fetched.value.strategies)).toBe(JSON.stringify(created.value.strategies));
    expect(fetched.value.approval.approvesExternalActions).toBe(false);
  });

  it("keeps versions after a reload", () => {
    const { service, store, workspaceA, userA, goalId } = fixture();
    const first = service.compileRevenuePlan(workspaceA, userA, goalId);
    service.compileRevenuePlan(workspaceA, userA, goalId);
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const reloaded = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const service2 = new RevenuePlanService(
      reloaded as unknown as PlanRepository,
      new DeterministicPlanCompiler(),
      ((id, user) => reloaded.getRevenueGoal(id, user)) as GoalReader,
      () => {
        throw new Error("no brain reader");
      },
    );
    const history = service2.planHistory(first.value.id, userA);
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    expect(history.value.map((p) => p.version)).toEqual([1, 2]);
  });
});

describe("Revenue Plan — failure handling", () => {
  it("maps an unavailable store to a safe error", () => {
    const broken = {
      authorize: () => ({ ok: true as const, value: {} }),
      nextRevenuePlanVersion: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      createRevenuePlan: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      listRevenuePlans: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      getRevenuePlan: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      listRevenuePlansForGoal: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      updateRevenuePlan: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      setRevenuePlanStatus: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
    } as unknown as PlanRepository;

    const service = new RevenuePlanService(
      broken,
      new DeterministicPlanCompiler(),
      () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      () => {
        throw new Error("unreachable");
      },
    );
    const result = service.compileRevenuePlan("w1", "u1", "g1");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("UNAVAILABLE");
      expect(result.error.message).toBe("storage unavailable");
    }
  });

  it("does not leak internals when the compiler or the reader throws", () => {
    const { store, brain } = fixture();
    const repo = {
      authorize: () => ({ ok: true as const, value: {} }),
      createRevenuePlan: () => ({ ok: true as const, value: {} }),
    } as unknown as PlanRepository;

    const explodingCompiler = {
      compilerVersion: "boom-1",
      compile: () => {
        throw new Error("secret internal detail");
      },
    };
    const withCompiler = new RevenuePlanService(
      repo,
      explodingCompiler,
      () => ({
        ok: true as const,
        value: {
          id: "g1",
          workspaceId: "w1",
          status: "draft",
          completeness: "complete",
          unknowns: [],
        } as never,
      }),
      () => brain,
    );
    const failed = withCompiler.compileRevenuePlan("w1", "u1", "g1");
    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) {
      expect(failed.error.code).toBe("UNAVAILABLE");
      expect(JSON.stringify(failed.error)).not.toContain("secret internal detail");
    }
    void store;
  });

  it("surfaces a Brain reader failure without leaking its message", () => {
    const repo = {
      authorize: () => ({ ok: true as const, value: {} }),
    } as unknown as PlanRepository;
    const service = new RevenuePlanService(
      repo,
      new DeterministicPlanCompiler(),
      () => ({
        ok: true as const,
        value: {
          id: "g1",
          workspaceId: "w1",
          status: "draft",
          completeness: "complete",
          unknowns: [],
        } as never,
      }),
      () => {
        throw new Error("connection string postgres://secret");
      },
    );
    const result = service.compileRevenuePlan("w1", "u1", "g1");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(JSON.stringify(result.error)).not.toContain("secret");
    }
  });
});
