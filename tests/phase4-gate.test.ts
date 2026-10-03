import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { Store, store as defaultStore } from "@dealora/db";
import type { RevenueGoal, RevenuePlan } from "@dealora/db";
import { RevenuePlanService, deterministicPlanCompiler } from "@dealora/plan";
import type { PlanBrainSnapshot, PlanRepository } from "@dealora/plan";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";

/**
 * Phase 4 gate — ROADMAP.md §11.
 *
 * A revenue goal must be compilable into an inspectable revenue plan.
 *
 * The first test walks the whole path through the real signup/session layer,
 * the real default wiring and the real default store, then re-reads the plan
 * from a service built over the persisted document to prove it was written,
 * not merely held in memory.
 */

function request(token: string, params: Record<string, string>, body?: unknown): RequestBody {
  return { body, query: { sessionToken: token }, params };
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

/** Read the canonical Business Brain slice the compiler consumes. */
function readPlanBrain(store: Store, workspaceId: string, userId: string): PlanBrainSnapshot {
  const auth = store.authorize(workspaceId, userId);
  if (!auth.ok) throw new Error("business brain unavailable");
  const offers = store.listOffers(workspaceId, userId);
  const icp = store.getIcp(workspaceId, userId);
  const personas = store.listPersonas(workspaceId, userId);
  const positioning = store.getPositioning(workspaceId, userId);
  const brandVoice = store.getBrandVoice(workspaceId, userId);
  const claims = store.listClaims(workspaceId, userId);
  const profile = store.getBusinessProfileFor(workspaceId, userId);
  if (
    !offers.ok ||
    !icp.ok ||
    !personas.ok ||
    !positioning.ok ||
    !brandVoice.ok ||
    !claims.ok ||
    !profile.ok
  ) {
    throw new Error("business brain unavailable");
  }
  return {
    workspaceId,
    company: profile.value
      ? {
          name: profile.value.name,
          market: profile.value.market,
          industry: profile.value.industry,
          size: profile.value.size,
        }
      : null,
    offers: offers.value.map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description,
      outcome: o.outcome,
    })),
    icp: icp.value
      ? {
          id: icp.value.id,
          industries: icp.value.industries,
          companySizes: icp.value.companySizes,
          geographies: icp.value.geographies,
          characteristics: icp.value.characteristics,
          disqualifiers: icp.value.disqualifiers,
        }
      : null,
    personas: personas.value.map((p) => ({
      id: p.id,
      title: p.title,
      painPoints: p.painPoints,
      goals: p.goals,
      buyingContext: p.buyingContext,
    })),
    positioning: positioning.value
      ? {
          statement: positioning.value.statement,
          differentiators: positioning.value.differentiators,
          approvedValuePropositions: positioning.value.approvedValuePropositions,
        }
      : null,
    brandVoice: brandVoice.value
      ? { tone: brandVoice.value.tone, constraints: brandVoice.value.constraints }
      : null,
    approvedClaims: claims.value
      .filter((c) => c.status === "approved")
      .map((c) => ({ id: c.id, text: c.text })),
    withheldClaims: {
      unverified: claims.value.filter((c) => c.status === "unverified").length,
      restricted: claims.value.filter((c) => c.status === "restricted").length,
    },
  };
}

describe("Phase 4 gate", () => {
  // The auth layer and the default wiring are bound to the default store
  // singleton, so the end-to-end path must use it too.
  afterAll(() => {
    defaultStore.destroy();
  });

  it("authenticated user → workspace → Brain → complete goal → compiled plan → persisted → versioned → workspace isolated", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const handlers = createDefaultHandlers();

    // 1. Authenticate for real.
    const owner = signup("gate-plan@example.com", "correct-horse-battery", "Owner A");
    const token = owner.token;
    expect(token).toBeTruthy();

    // 2. Workspace as the tenant boundary.
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Gate Plan Co" });
    expect(isOk(workspace)).toBe(true);
    if (!isOk(workspace)) return;
    const workspaceId = workspace.value.id;

    // 3. Canonical Business Brain.
    await dataOf(
      handlers.upsertCompanyHandler(
        request(
          token,
          { workspaceId },
          {
            name: "Gate Plan Corp",
            description: "Revenue operations agency",
            market: "B2B SaaS",
            industry: "Software",
          },
        ),
      ),
    );
    const offer = (await dataOf(
      handlers.createOfferHandler(
        request(
          token,
          { workspaceId },
          {
            name: "AI automation",
            description: "Automates the inbound revenue motion",
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
            industries: ["SaaS"],
            companySizes: ["50-500"],
            geographies: ["US"],
            characteristics: ["Hiring support engineers"],
            disqualifiers: ["Pre-revenue"],
          },
        ),
      ),
    )) as { icp: { id: string } };
    const persona = (await dataOf(
      handlers.createPersonaHandler(
        request(
          token,
          { workspaceId },
          {
            title: "Head of Revenue",
            painPoints: ["Pipeline is hard to forecast"],
            goals: ["More qualified meetings"],
          },
        ),
      ),
    )) as { persona: { id: string } };
    await dataOf(
      handlers.upsertPositioningHandler(
        request(
          token,
          { workspaceId },
          {
            statement: "We automate the revenue motion for B2B SaaS",
            differentiators: ["Domain-specific playbooks"],
            approvedValuePropositions: ["Cut time to first response"],
          },
        ),
      ),
    );
    await dataOf(
      handlers.upsertBrandVoiceHandler(request(token, { workspaceId }, { tone: ["direct"] })),
    );
    const claim = (await dataOf(
      handlers.createClaimHandler(
        request(
          token,
          { workspaceId },
          { text: "SOC 2 Type II certified", category: "certification" },
        ),
      ),
    )) as { claim: { id: string } };
    await dataOf(handlers.approveClaimHandler(request(token, { id: claim.claim.id })));
    // Unapproved: must never reach the plan as usable messaging.
    await dataOf(
      handlers.createClaimHandler(
        request(
          token,
          { workspaceId },
          { text: "Doubled revenue for 40 clients", category: "result" },
        ),
      ),
    );

    // 4. A complete RevenueGoal.
    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective:
              "Generate $100,000 of qualified pipeline from mid-market SaaS companies in the next 90 days",
            targetMetric: "pipeline",
            targetValue: 100000,
            currency: "USD",
            timeWindow: { start: "2026-03-01", end: "2026-06-01" },
            market: "B2B SaaS",
            offerId: offer.offer.id,
            icpId: icp.icp.id,
            buyerPersonaIds: [persona.persona.id],
            economics: { minimumContractValue: 2000, currency: "USD" },
            successMetrics: [
              { kind: "pipeline", target: 100000, unit: "USD" },
              { kind: "meeting", target: 12, unit: "count" },
            ],
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    expect(goal.goal.completeness).toBe("complete");

    // 5. Compile the goal into a RevenuePlan.
    const compiled = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: RevenuePlan };

    const plan = compiled.plan;
    expect(plan.revenueGoalId).toBe(goal.goal.id);
    expect(plan.workspaceId).toBe(workspaceId);
    expect(plan.createdBy).toBe(owner.user.id);
    expect(plan.version).toBe(1);
    expect(plan.status).toBe("proposed");
    expect(plan.compilerVersion).toBe("deterministic-1.0.0");
    expect(plan.brainSnapshotDigest).toMatch(/^fnv1a-[0-9a-f]{8}$/);
    expect(plan.rationale.length).toBeGreaterThan(0);

    // 6. Every strategy the roadmap requires is present and populated.
    const s = plan.strategies;
    expect(s.icp.targetMarket).toBe("B2B SaaS");
    expect(s.icp.industries).toEqual(["SaaS"]);
    expect(s.icp.disqualifiers).toEqual(["Pre-revenue"]);
    expect(s.buyer.personas.map((p) => p.title)).toEqual(["Head of Revenue"]);
    expect(s.sourcing.approach.length).toBeGreaterThan(0);
    expect(s.signal.signals.length).toBeGreaterThan(0);
    expect(s.qualification.criteria.map((c) => c.name)).toContain("icp_fit");
    expect(s.outreach.channels.length).toBeGreaterThan(0);
    expect(s.followUp.stopConditions.length).toBeGreaterThan(0);
    expect(s.meeting.qualificationPurpose.length).toBeGreaterThan(0);
    expect(s.crm.recordFields.length).toBeGreaterThan(0);
    expect(s.measurement.kpis).toHaveLength(2);
    expect(s.optimization.levers.length).toBeGreaterThan(0);

    // 7. Facts and recommendations are separated, never conflated.
    expect(plan.facts.length).toBeGreaterThan(0);
    expect(plan.recommendations.length).toBeGreaterThan(0);
    expect(plan.unknowns.length).toBeGreaterThan(0);
    expect(plan.facts.every((st) => st.kind === "fact")).toBe(true);
    expect(plan.recommendations.every((st) => st.kind === "recommendation")).toBe(true);
    expect(plan.unknowns.every((st) => st.basis === "none")).toBe(true);
    // A Brain-sourced fact carries the canonical record it came from.
    expect(plan.facts.some((st) => st.references?.includes(icp.icp.id))).toBe(true);
    // The unapproved claim is never usable messaging.
    expect(JSON.stringify(plan)).not.toContain("Doubled revenue for 40 clients");

    // 8. Plan approval is separate from action approval.
    expect(plan.approval.approvesExternalActions).toBe(false);
    expect(plan.approval.requiredFor).toEqual(["level_2_external_action"]);
    const approved = (await dataOf(
      handlers.changeRevenuePlanStatusHandler(
        request(token, { id: plan.id }, { status: "approved" }),
      ),
    )) as { plan: RevenuePlan };
    expect(approved.plan.status).toBe("approved");
    expect(approved.plan.approval.approvesExternalActions).toBe(false);

    // 9. Persistence: a service over the reloaded document sees the plan.
    const reloadedStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const reloaded = new RevenuePlanService(
      reloadedStore as unknown as PlanRepository,
      deterministicPlanCompiler,
      ((id, user) => reloadedStore.getRevenueGoal(id, user)) as never,
      (ws, user) => readPlanBrain(reloadedStore, ws, user),
    );
    const afterReload = reloaded.getRevenuePlan(plan.id, owner.user.id);
    expect(isOk(afterReload)).toBe(true);
    if (!isOk(afterReload)) return;
    expect(afterReload.value.version).toBe(1);
    expect(JSON.stringify(afterReload.value.strategies)).toBe(JSON.stringify(plan.strategies));
    expect(afterReload.value.facts.length).toBe(plan.facts.length);
    expect(afterReload.value.approval.approvesExternalActions).toBe(false);

    // 10. Versioning: recompiling preserves the previous version.
    const second = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: RevenuePlan };
    expect(second.plan.version).toBe(2);
    expect(second.plan.id).not.toBe(plan.id);

    const history = (await dataOf(
      handlers.getRevenuePlanHistoryHandler(request(token, { id: second.plan.id })),
    )) as { history: RevenuePlan[] };
    expect(history.history.map((p) => p.version)).toEqual([1, 2]);
    // The first version is still readable, not destroyed.
    const stillThere = await dataOf(
      handlers.getRevenuePlanHandler(request(token, { id: plan.id })),
    );
    expect(JSON.stringify(stillThere)).toContain(String(goal.goal.id));

    // 11. Retrieval through the API.
    const listed = (await dataOf(
      handlers.listRevenuePlansHandler(request(token, { workspaceId })),
    )) as { plans: RevenuePlan[] };
    expect(listed.plans).toHaveLength(2);
  });

  it("refuses to compile an incomplete or archived goal", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers();
    const owner = signup("gate-plan-pre@example.com", "correct-horse-battery", "Owner");
    const token = owner.token;
    const workspace = defaultStore.createWorkspace({ ownerId: owner.user.id, name: "Pre Co" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;

    // Incomplete: no offer, so the goal records the gap instead of inventing one.
    const incomplete = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Generate pipeline",
            targetMetric: "pipeline",
            targetValue: 1000,
            currency: "USD",
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    expect(incomplete.goal.completeness).toBe("incomplete");

    const refused = await errorOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: incomplete.goal.id }),
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("incomplete");
    expect(refused.details?.some((d) => d.field === "offerId")).toBe(true);

    // Archived: refused even when complete.
    const offer = (await dataOf(
      handlers.createOfferHandler(
        request(
          token,
          { workspaceId },
          { name: "AI automation", description: "Automates revenue" },
        ),
      ),
    )) as { offer: { id: string } };
    const complete = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Book revenue",
            targetMetric: "revenue",
            targetValue: 5000,
            currency: "USD",
            timeWindow: { start: "2026-03-01", end: "2026-06-01" },
            market: "B2B SaaS",
            offerId: offer.offer.id,
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    expect(complete.goal.completeness).toBe("complete");

    await dataOf(
      handlers.changeRevenueGoalStatusHandler(
        request(token, { id: complete.goal.id }, { status: "active" }),
      ),
    );
    await dataOf(
      handlers.changeRevenueGoalStatusHandler(
        request(token, { id: complete.goal.id }, { status: "completed" }),
      ),
    );
    await dataOf(
      handlers.changeRevenueGoalStatusHandler(
        request(token, { id: complete.goal.id }, { status: "archived" }),
      ),
    );

    const archivedError = await errorOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: complete.goal.id }),
      ),
    );
    expect(archivedError.code).toBe("CONFLICT");
  });

  it("denies a second tenant access to the first tenant's plans", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers();

    const ownerA = signup("gate-plan-a@example.com", "correct-horse-battery", "Owner A");
    const ownerB = signup("gate-plan-b@example.com", "correct-horse-battery", "Owner B");
    // Names are Phase 4-specific: the default store is a single shared
    // document, so workspace slugs must not collide with other gate suites.
    const wsA = defaultStore.createWorkspace({ ownerId: ownerA.user.id, name: "Plan Acme" });
    const wsB = defaultStore.createWorkspace({ ownerId: ownerB.user.id, name: "Plan Globex" });
    if (!isOk(wsA) || !isOk(wsB)) throw new Error("fixture workspaces failed");

    const offerA = (await dataOf(
      handlers.createOfferHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id },
          {
            name: "Acme offer",
            description: "Acme only",
          },
        ),
      ),
    )) as { offer: { id: string } };

    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id },
          {
            objective: "Acme private target",
            targetMetric: "revenue",
            targetValue: 5000,
            currency: "USD",
            timeWindow: { start: "2026-03-01", end: "2026-06-01" },
            market: "B2B SaaS",
            offerId: offerA.offer.id,
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    const plan = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(ownerA.token, { workspaceId: wsA.value.id }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: RevenuePlan };

    // User A + Workspace A + Goal A + Plan A = allowed.
    const own = await dataOf(
      handlers.getRevenuePlanHandler(request(ownerA.token, { id: plan.plan.id })),
    );
    expect(JSON.stringify(own)).toContain("deterministic-1.0.0");

    // User B + Workspace A + Plan A = denied, on every entry point.
    const denials = await Promise.all([
      errorOf(handlers.getRevenuePlanHandler(request(ownerB.token, { id: plan.plan.id }))),
      errorOf(handlers.getRevenuePlanHistoryHandler(request(ownerB.token, { id: plan.plan.id }))),
      errorOf(
        handlers.listRevenuePlansHandler(request(ownerB.token, { workspaceId: wsA.value.id })),
      ),
      errorOf(
        handlers.changeRevenuePlanStatusHandler(
          request(ownerB.token, { id: plan.plan.id }, { status: "approved" }),
        ),
      ),
      errorOf(handlers.archiveRevenuePlanHandler(request(ownerB.token, { id: plan.plan.id }))),
      errorOf(
        handlers.compileRevenuePlanHandler(
          request(ownerB.token, { workspaceId: wsA.value.id }, { revenueGoalId: goal.goal.id }),
        ),
      ),
    ]);
    for (const denial of denials) {
      expect(denial.code).toBe("UNAUTHORIZED");
      expect(JSON.stringify(denial)).not.toContain("Acme private target");
    }

    // Tenant B's own workspace has no plans.
    const ownWorkspace = await dataOf(
      handlers.listRevenuePlansHandler(request(ownerB.token, { workspaceId: wsB.value.id })),
    );
    expect(JSON.stringify(ownWorkspace)).not.toContain("deterministic-1.0.0");
  });

  it("compiles deterministically and produces planning state only", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const handlers = createDefaultHandlers();
    const owner = signup("gate-plan-det@example.com", "correct-horse-battery", "Owner");
    const token = owner.token;
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Det Co" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;

    await dataOf(
      handlers.upsertIcpHandler(
        request(token, { workspaceId }, { industries: ["SaaS"], disqualifiers: ["Pre-revenue"] }),
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
    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Generate $100,000 of qualified pipeline",
            targetMetric: "pipeline",
            targetValue: 100000,
            currency: "USD",
            timeWindow: { start: "2026-03-01", end: "2026-06-01" },
            market: "B2B SaaS",
            offerId: offer.offer.id,
          },
        ),
      ),
    )) as { goal: RevenueGoal };

    const first = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: RevenuePlan };
    const second = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: RevenuePlan };

    // Same input, same compiler version → identical strategic content. Only
    // identity, version and timestamps differ.
    expect(JSON.stringify(second.plan.strategies)).toBe(JSON.stringify(first.plan.strategies));
    expect(second.plan.facts).toEqual(first.plan.facts);
    expect(second.plan.recommendations).toEqual(first.plan.recommendations);
    expect(second.plan.unknowns).toEqual(first.plan.unknowns);
    expect(second.plan.rationale).toBe(first.plan.rationale);
    expect(second.plan.brainSnapshotDigest).toBe(first.plan.brainSnapshotDigest);
    expect(second.plan.id).not.toBe(first.plan.id);

    // Phase 4 is a planning phase: no execution artifact exists anywhere in
    // the workspace's persisted state.
    const scoped = JSON.stringify(store.db).slice(JSON.stringify(store.db).indexOf(workspaceId));
    for (const artifact of [
      "sentAt",
      "deliveredAt",
      "messageId",
      "emailBody",
      "crmRecordId",
      "calendarEventId",
      "meetingScheduledAt",
      "webhookUrl",
    ]) {
      expect(scoped).not.toContain(artifact);
    }
    // And the plan says so itself.
    expect(JSON.stringify(first.plan)).toContain("Nothing has been sent");
    expect(JSON.stringify(first.plan)).toContain("No accounts have been sourced");
  });
});
