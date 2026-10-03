import { describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";
import { BusinessBrainService } from "@dealora/brain";
import type { BrainRepository } from "@dealora/brain";
import { RevenueGoalService, deterministicGoalParser } from "@dealora/goal";
import type { GoalRepository } from "@dealora/goal";
import { RevenuePlanService, deterministicPlanCompiler } from "@dealora/plan";
import type { PlanBrainSnapshot, PlanRepository } from "@dealora/plan";
import { AccountService } from "@dealora/account";
import type { AccountRepository } from "@dealora/account";

import { createHandlers } from "./handlers.js";
import type { HandlerDeps } from "./handlers.js";
import type { RevenueGoal } from "@dealora/db";
import type { ApiError, ApiResponse, RequestBody } from "./types.js";

/**
 * Two tenants with real sessions. The session resolver maps tokens to a user
 * id exactly as the auth package does, so a handler only ever learns the
 * identity from the token.
 */
function fixture(): {
  handlers: ReturnType<typeof createHandlers>;
  tokenA: string;
  tokenB: string;
  workspaceA: string;
  workspaceB: string;
  userA: string;
  userB: string;
} {
  const store = new Store(emptyState());
  const sessions = new Map<string, string>();

  const userAResult = store.createUser({
    email: "a@example.com",
    password: "correct-horse-battery",
    displayName: "Owner A",
  });
  if (!isOk(userAResult)) throw new Error("fixture user A failed");
  const userBResult = store.createUser({
    email: "b@example.com",
    password: "correct-horse-battery",
    displayName: "Owner B",
  });
  if (!isOk(userBResult)) throw new Error("fixture user B failed");

  const wsAResult = store.createWorkspace({ ownerId: userAResult.value.id, name: "Acme" });
  if (!isOk(wsAResult)) throw new Error("fixture workspace A failed");
  const wsBResult = store.createWorkspace({ ownerId: userBResult.value.id, name: "Globex" });
  if (!isOk(wsBResult)) throw new Error("fixture workspace B failed");

  const tokenA = "token-alice";
  const tokenB = "token-bob";
  sessions.set(tokenA, userAResult.value.id);
  sessions.set(tokenB, userBResult.value.id);

  const deps: HandlerDeps = {
    identity: {
      signup: () => {
        throw new Error("not used");
      },
      authenticate: () => {
        throw new Error("not used");
      },
      listWorkspaces: (userId) => store.getWorkspaces(userId),
      getWorkspace: (id, userId) => store.authorize(id, userId),
      authorize: (workspaceId, userId) => store.authorize(workspaceId, userId),
      updateWorkspace: (id, userId, input) => {
        const auth = store.authorize(id, userId);
        if (!auth.ok) return auth;
        return store.updateWorkspace(id, input);
      },
      getUser: (id) => store.getUser(id),
    },
    brain: new BusinessBrainService(store as unknown as BrainRepository),
    goal: new RevenueGoalService(store as unknown as GoalRepository, deterministicGoalParser),
    brainContext: (workspaceId, userId) => {
      const auth = store.authorize(workspaceId, userId);
      if (!auth.ok) throw new Error("business context unavailable");
      const offers = store.listOffers(workspaceId, userId);
      const icp = store.getIcp(workspaceId, userId);
      const personas = store.listPersonas(workspaceId, userId);
      if (!offers.ok || !icp.ok || !personas.ok) throw new Error("business context unavailable");
      return {
        workspaceId,
        company: null,
        offers: offers.value.map((o) => ({ id: o.id, name: o.name })),
        icp: icp.value ? { id: icp.value.id } : null,
        personas: personas.value.map((p) => ({ id: p.id, title: p.title })),
      };
    },
    planContext: (workspaceId, userId) => {
      const auth = store.authorize(workspaceId, userId);
      if (!auth.ok) throw new Error("business brain unavailable");
      return readPlanBrain(store, workspaceId, userId);
    },
    plan: new RevenuePlanService(
      store as unknown as PlanRepository,
      deterministicPlanCompiler,
      (goalId, userId) => store.getRevenueGoal(goalId, userId) as never,
      (workspaceId, userId) => readPlanBrain(store, workspaceId, userId),
    ),
    account: new AccountService(
      store as unknown as AccountRepository,
      (revenuePlanId, userId) => store.getRevenuePlan(revenuePlanId, userId) as never,
    ),
    resolveSession: (token) => {
      const userId = sessions.get(token);
      return userId ? { userId } : null;
    },
  };

  return {
    handlers: createHandlers(deps),
    tokenA,
    tokenB,
    workspaceA: wsAResult.value.id,
    workspaceB: wsBResult.value.id,
    userA: userAResult.value.id,
    userB: userBResult.value.id,
  };
}

/**
 * Read the canonical Business Brain slice the plan compiler consumes.
 *
 * Mirrors the production wiring so route tests exercise the same reader the
 * real application uses.
 */
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

function request(
  opts: {
    token?: string;
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
  } = {},
): RequestBody {
  return {
    body: opts.body,
    query: { ...(opts.token ? { sessionToken: opts.token } : {}), ...(opts.query ?? {}) },
    params: opts.params ?? {},
  };
} /** Pull the error out of a handler result, failing the test if it succeeded. */
async function errorOf(result: Promise<Result<ApiResponse<unknown>, ApiError>>): Promise<ApiError> {
  const resolved = await result;
  if (resolved.ok) throw new Error("expected the handler to fail");
  return resolved.error;
}

/** Pull the success payload out of a handler result. */
async function dataOf(result: Promise<Result<ApiResponse<unknown>, ApiError>>): Promise<unknown> {
  const resolved = await result;
  if (!resolved.ok) throw new Error(`expected success, got ${resolved.error.code}`);
  if (resolved.value.status !== "ok") throw new Error("expected an ok response envelope");
  return resolved.value.data;
}

describe("API authentication", () => {
  it("rejects a request with no session token", async () => {
    const { handlers, workspaceA } = fixture();
    const error = await errorOf(
      handlers.getBusinessContextHandler(request({ params: { workspaceId: workspaceA } })),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an unknown session token", async () => {
    const { handlers, workspaceA } = fixture();
    const error = await errorOf(
      handlers.getBusinessContextHandler(
        request({ token: "forged", params: { workspaceId: workspaceA } }),
      ),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("resolves the identity from the token, never from the body", async () => {
    const { handlers, workspaceA, userB, tokenA } = fixture();
    // The body claims to be user B while the token belongs to user A.
    const data = await dataOf(
      handlers.upsertCompanyHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { name: "Acme", description: "Agency" },
        }),
      ),
    );
    expect(data).toMatchObject({ company: { name: "Acme" } });
    expect(JSON.stringify(data)).not.toContain(userB);
  });

  it("requires a workspace id", async () => {
    const { handlers, tokenA } = fixture();
    const error = await errorOf(
      handlers.getBusinessContextHandler(request({ token: tokenA, params: {} })),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid JSON body", async () => {
    const { handlers, workspaceA, tokenA } = fixture();
    const error = await errorOf(
      handlers.upsertCompanyHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA }, body: "{not json" }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("never returns a password hash", async () => {
    const { handlers, tokenA } = fixture();
    const data = await dataOf(handlers.meHandler(request({ token: tokenA })));
    expect(JSON.stringify(data)).not.toContain("passwordHash");
  });
});

describe("API workspace isolation", () => {
  it("allows the owner to read their own Business Brain context", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const data = await dataOf(
      handlers.getBusinessContextHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA } }),
      ),
    );
    expect(data).toMatchObject({ context: { workspaceId: workspaceA } });
  });

  it("denies reading another workspace's context", async () => {
    const { handlers, tokenA, workspaceB } = fixture();
    const error = await errorOf(
      handlers.getBusinessContextHandler(
        request({ token: tokenA, params: { workspaceId: workspaceB } }),
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
    // The message is generic and leaks nothing about the target workspace.
    expect(error.message).toBe("workspace access denied");
  });

  it("denies writing into another workspace", async () => {
    const { handlers, tokenA, workspaceB } = fixture();
    const error = await errorOf(
      handlers.upsertCompanyHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceB },
          body: { name: "Intruder", description: "x" },
        }),
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("does not leak the other tenant's business data", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    await handlers.upsertCompanyHandler(
      request({
        token: tokenA,
        params: { workspaceId: workspaceA },
        body: { name: "Acme Secret", description: "confidential" },
      }),
    );
    await handlers.upsertCompanyHandler(
      request({
        token: tokenB,
        params: { workspaceId: workspaceB },
        body: { name: "Globex", description: "other" },
      }),
    );

    const leaked = await errorOf(
      handlers.getBusinessContextHandler(
        request({ token: tokenB, params: { workspaceId: workspaceA } }),
      ),
    );
    expect(leaked.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(leaked)).not.toContain("Acme Secret");
  });

  it("denies claiming an entity from another workspace", async () => {
    const { handlers, tokenA, tokenB, workspaceA } = fixture();
    const claim = await dataOf(
      handlers.createClaimHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { text: "SOC 2 certified", category: "certification" },
        }),
      ),
    );
    const id = (claim as { claim: { id: string } }).claim.id;

    const error = await errorOf(
      handlers.approveClaimHandler(request({ token: tokenB, params: { id } })),
    );
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("denies updating a workspace from the identity layer", async () => {
    const { handlers, tokenA, workspaceB } = fixture();
    const error = await errorOf(
      handlers.updateWorkspaceHandler(
        request({ token: tokenA, params: { id: workspaceB }, body: { name: "Hijacked" } }),
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
  });
});

describe("API Revenue Goal routes", () => {
  it("creates a goal from natural language and reads it back", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const created = (await dataOf(
      handlers.createRevenueGoalFromTextHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            input:
              "Generate $100,000 of qualified pipeline from mid-market SaaS companies in the next 90 days",
          },
        }),
      ),
    )) as { goal: { id: string; status: string; targetValue: number; completeness: string } };

    expect(created.goal.targetValue).toBe(100000);
    expect(created.goal.status).toBe("draft");
    // No Business Brain offer exists in this fixture, so the goal records the
    // gap instead of inventing a reference.
    expect(created.goal.completeness).toBe("incomplete");

    const fetched = await dataOf(
      handlers.getRevenueGoalHandler(request({ token: tokenA, params: { id: created.goal.id } })),
    );
    expect(JSON.stringify(fetched)).toContain("qualified pipeline");
  });

  it("returns a parse draft without persisting a goal", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const parsed = (await dataOf(
      handlers.parseRevenueGoalInputHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { input: "$50,000 pipeline in the next 30 days" },
        }),
      ),
    )) as { draft: { fields: Record<string, { value: unknown; origin: string } | undefined> } };

    expect(parsed.draft.fields.targetValue?.value).toBe(50000);
    expect(parsed.draft.fields.currency?.origin).toBe("assumption");

    const listed = await dataOf(
      handlers.listRevenueGoalsHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA } }),
      ),
    );
    expect(JSON.stringify(listed)).not.toContain("pipeline");
  });

  it("rejects a goal request with no session token", async () => {
    const { handlers, workspaceA } = fixture();
    const error = await errorOf(
      handlers.createRevenueGoalHandler(request({ params: { workspaceId: workspaceA }, body: {} })),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("denies reading another tenant's goal", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    const created = (await dataOf(
      handlers.createRevenueGoalHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            objective: "Confidential target",
            targetMetric: "revenue",
            targetValue: 5000,
            currency: "USD",
          },
        }),
      ),
    )) as { goal: { id: string } };

    const error = await errorOf(
      handlers.getRevenueGoalHandler(request({ token: tokenB, params: { id: created.goal.id } })),
    );
    expect(error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(error)).not.toContain("Confidential target");

    const listError = await errorOf(
      handlers.listRevenueGoalsHandler(
        request({ token: tokenB, params: { workspaceId: workspaceA } }),
      ),
    );
    expect(listError.code).toBe("UNAUTHORIZED");
    // The other tenant's own workspace is untouched.
    const own = await dataOf(
      handlers.listRevenueGoalsHandler(
        request({ token: tokenB, params: { workspaceId: workspaceB } }),
      ),
    );
    expect(JSON.stringify(own)).not.toContain("Confidential target");
  });

  it("rejects an invalid status filter and an invalid transition", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const created = (await dataOf(
      handlers.createRevenueGoalHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            objective: "Book revenue",
            targetMetric: "revenue",
            targetValue: 1000,
            currency: "USD",
          },
        }),
      ),
    )) as { goal: { id: string } };

    const filterError = await errorOf(
      handlers.listRevenueGoalsHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          query: { status: "verified" },
        }),
      ),
    );
    expect(filterError.code).toBe("VALIDATION_ERROR");

    // draft → completed is not a legal transition.
    const transitionError = await errorOf(
      handlers.changeRevenueGoalStatusHandler(
        request({ token: tokenA, params: { id: created.goal.id }, body: { status: "completed" } }),
      ),
    );
    expect(transitionError.code).toBe("CONFLICT");

    const activated = (await dataOf(
      handlers.changeRevenueGoalStatusHandler(
        request({ token: tokenA, params: { id: created.goal.id }, body: { status: "active" } }),
      ),
    )) as { goal: { status: string } };
    expect(activated.goal.status).toBe("active");
  });

  it("maps a goal storage failure to SERVER_ERROR without leaking internals", async () => {
    const brokenRepo = {
      authorize: () => ({ ok: true as const, value: {} }),
      createRevenueGoal: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      listRevenueGoals: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      getRevenueGoal: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      updateRevenueGoal: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      setRevenueGoalStatus: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      listRevenueGoalEvents: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
    } as unknown as GoalRepository;

    const store = new Store(emptyState());
    const handlers = createHandlers({
      identity: {
        signup: () => {
          throw new Error("not used");
        },
        authenticate: () => {
          throw new Error("not used");
        },
        listWorkspaces: () => ({ ok: true as const, value: [] }),
        getWorkspace: () => ({ ok: true as const, value: {} as never }),
        authorize: () => ({ ok: true as const, value: {} as never }),
        updateWorkspace: () => ({ ok: true as const, value: {} as never }),
        getUser: () => ({ ok: true as const, value: {} as never }),
      },
      brain: new BusinessBrainService(store as unknown as BrainRepository),
      goal: new RevenueGoalService(brokenRepo, deterministicGoalParser),
      brainContext: () => ({
        workspaceId: "w1",
        company: null,
        offers: [],
        icp: null,
        personas: [],
      }),
      planContext: () => {
        throw new Error("business brain unavailable");
      },
      plan: new RevenuePlanService(
        {
          authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as unknown as PlanRepository,
        deterministicPlanCompiler,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        () => {
          throw new Error("business brain unavailable");
        },
      ),
      account: new AccountService(
        {
          authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as unknown as AccountRepository,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      ),
      resolveSession: () => ({ userId: "u1" }),
    });

    const error = await errorOf(
      handlers.createRevenueGoalHandler(
        request({
          token: "t",
          params: { workspaceId: "w1" },
          body: { objective: "Book revenue", targetMetric: "revenue", targetValue: 1000 },
        }),
      ),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("UNAVAILABLE");
  });
});

describe("API Revenue Plan routes", () => {
  /** Seed a complete goal through the real goal service, then return its id. */
  async function seedCompleteGoal(
    handlers: ReturnType<typeof createHandlers>,
    token: string,
    workspaceId: string,
  ): Promise<string> {
    // A goal can only be compiled when it is complete, which includes
    // referencing a canonical Business Brain offer.
    const offer = (await dataOf(
      handlers.createOfferHandler(
        request({
          token,
          params: { workspaceId },
          body: { name: "AI automation", description: "Automates the revenue motion" },
        }),
      ),
    )) as { offer: { id: string } };

    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request({
          token,
          params: { workspaceId },
          body: {
            objective: "Generate $100,000 of qualified pipeline from mid-market SaaS companies",
            targetMetric: "pipeline",
            targetValue: 100000,
            currency: "USD",
            timeWindow: { start: "2026-03-01", end: "2026-06-01" },
            market: "B2B SaaS",
            offerId: offer.offer.id,
            successMetrics: [{ kind: "pipeline", target: 100000, unit: "USD" }],
          },
        }),
      ),
    )) as { goal: { id: string; completeness: string } };
    expect(goal.goal.completeness).toBe("complete");
    return goal.goal.id;
  }

  it("compiles a goal into a plan and reads it back", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const goalId = await seedCompleteGoal(handlers, tokenA, workspaceA);

    const compiled = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { revenueGoalId: goalId },
        }),
      ),
    )) as { plan: { id: string; version: number; status: string } };

    expect(compiled.plan.version).toBe(1);
    expect(compiled.plan.status).toBe("proposed");

    const fetched = await dataOf(
      handlers.getRevenuePlanHandler(request({ token: tokenA, params: { id: compiled.plan.id } })),
    );
    const plan = fetched as { plan: Record<string, unknown> };
    expect(JSON.stringify(plan)).toContain("deterministic-1.0.0");
    // Every roadmap section travels with the plan, and the approval record
    // never claims execution rights.
    const strategies = plan.plan.strategies as Record<string, unknown>;
    for (const section of [
      "icp",
      "buyer",
      "sourcing",
      "signal",
      "qualification",
      "outreach",
      "followUp",
      "meeting",
      "crm",
      "measurement",
      "optimization",
    ]) {
      expect(strategies[section]).toBeTruthy();
    }
    expect(
      (plan.plan.approval as { approvesExternalActions: boolean }).approvesExternalActions,
    ).toBe(false);
  });

  it("refuses to compile an incomplete goal and reports what is missing", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            objective: "Generate pipeline",
            targetMetric: "pipeline",
            targetValue: 1000,
            currency: "USD",
          },
        }),
      ),
    )) as { goal: { id: string } };

    const error = await errorOf(
      handlers.compileRevenuePlanHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { revenueGoalId: goal.goal.id },
        }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(error.details)).toBe(true);
    expect(JSON.stringify(error)).toContain("incomplete");
  });

  it("refuses to compile without a goal id", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const error = await errorOf(
      handlers.compileRevenuePlanHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA }, body: {} }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a plan request with no session token", async () => {
    const { handlers, workspaceA } = fixture();
    const error = await errorOf(
      handlers.compileRevenuePlanHandler(
        request({ params: { workspaceId: workspaceA }, body: { revenueGoalId: "g1" } }),
      ),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("denies compiling another tenant's goal", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    const goalId = await seedCompleteGoal(handlers, tokenA, workspaceA);

    const error = await errorOf(
      handlers.compileRevenuePlanHandler(
        request({
          token: tokenB,
          params: { workspaceId: workspaceA },
          body: { revenueGoalId: goalId },
        }),
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(error)).not.toContain("100,000");

    const listError = await errorOf(
      handlers.listRevenuePlansHandler(
        request({ token: tokenB, params: { workspaceId: workspaceA } }),
      ),
    );
    expect(listError.code).toBe("UNAUTHORIZED");
    const own = await dataOf(
      handlers.listRevenuePlansHandler(
        request({ token: tokenB, params: { workspaceId: workspaceB } }),
      ),
    );
    expect(JSON.stringify(own)).not.toContain("100,000");
  });

  it("versions plans and exposes the history", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const goalId = await seedCompleteGoal(handlers, tokenA, workspaceA);

    const first = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { revenueGoalId: goalId },
        }),
      ),
    )) as { plan: { id: string; version: number } };
    const second = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { revenueGoalId: goalId },
        }),
      ),
    )) as { plan: { id: string; version: number } };

    expect(first.plan.version).toBe(1);
    expect(second.plan.version).toBe(2);

    const history = (await dataOf(
      handlers.getRevenuePlanHistoryHandler(
        request({ token: tokenA, params: { id: second.plan.id } }),
      ),
    )) as { history: { version: number }[] };
    expect(history.history.map((h) => h.version)).toEqual([1, 2]);
  });

  it("validates the plan lifecycle and rejects an illegal transition", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const goalId = await seedCompleteGoal(handlers, tokenA, workspaceA);
    const compiled = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { revenueGoalId: goalId },
        }),
      ),
    )) as { plan: { id: string } };

    // proposed → draft is legal; approved → proposed is not.
    const approved = (await dataOf(
      handlers.changeRevenuePlanStatusHandler(
        request({ token: tokenA, params: { id: compiled.plan.id }, body: { status: "approved" } }),
      ),
    )) as { plan: { status: string; approval: { approvesExternalActions: boolean } } };
    expect(approved.plan.status).toBe("approved");
    // Approving the plan still does not approve external actions.
    expect(approved.plan.approval.approvesExternalActions).toBe(false);

    const illegal = await errorOf(
      handlers.changeRevenuePlanStatusHandler(
        request({ token: tokenA, params: { id: compiled.plan.id }, body: { status: "proposed" } }),
      ),
    );
    expect(illegal.code).toBe("CONFLICT");

    const archived = (await dataOf(
      handlers.archiveRevenuePlanHandler(
        request({ token: tokenA, params: { id: compiled.plan.id } }),
      ),
    )) as { plan: { status: string } };
    expect(archived.plan.status).toBe("archived");
  });

  it("rejects an invalid plan status filter", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const error = await errorOf(
      handlers.listRevenuePlansHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          query: { status: "executing" },
        }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("maps a plan storage failure to SERVER_ERROR without leaking internals", async () => {
    const store = new Store(emptyState());
    const handlers = createHandlers({
      identity: {
        signup: () => {
          throw new Error("not used");
        },
        authenticate: () => {
          throw new Error("not used");
        },
        listWorkspaces: () => ({ ok: true as const, value: [] }),
        getWorkspace: () => ({ ok: true as const, value: {} as never }),
        authorize: () => ({ ok: true as const, value: {} as never }),
        updateWorkspace: () => ({ ok: true as const, value: {} as never }),
        getUser: () => ({ ok: true as const, value: {} as never }),
      },
      brain: new BusinessBrainService(store as unknown as BrainRepository),
      goal: new RevenueGoalService(store as unknown as GoalRepository, deterministicGoalParser),
      brainContext: () => ({
        workspaceId: "w1",
        company: null,
        offers: [],
        icp: null,
        personas: [],
      }),
      planContext: () => ({
        workspaceId: "w1",
        company: null,
        offers: [],
        icp: null,
        personas: [],
        positioning: null,
        brandVoice: null,
        approvedClaims: [],
        withheldClaims: { unverified: 0, restricted: 0 },
      }),
      plan: new RevenuePlanService(
        {
          authorize: () => ({ ok: true as const, value: {} }),
          createRevenuePlan: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
          listRevenuePlans: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
          getRevenuePlan: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
          listRevenuePlansForGoal: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
          updateRevenuePlan: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
          setRevenuePlanStatus: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
          nextRevenuePlanVersion: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as unknown as PlanRepository,
        deterministicPlanCompiler,
        () => ({ ok: true as const, value: completeGoalStub() }),
        () => {
          throw new Error("business brain unavailable");
        },
      ),
      account: new AccountService(
        { authorize: () => ({ ok: true as const, value: {} }) } as unknown as AccountRepository,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      ),
      resolveSession: () => ({ userId: "u1" }),
    });

    const error = await errorOf(
      handlers.compileRevenuePlanHandler(
        request({ token: "t", params: { workspaceId: "w1" }, body: { revenueGoalId: "g1" } }),
      ),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("UNAVAILABLE");
  });
});

/** A complete goal, for tests that only need the precondition to pass. */
function completeGoalStub(): RevenueGoal {
  return {
    id: "g1",
    workspaceId: "w1",
    createdBy: "u1",
    objective: "Generate pipeline",
    targetMetric: "pipeline",
    targetValue: 1000,
    currency: "USD",
    timeWindow: { start: "2026-03-01", end: "2026-06-01" },
    market: "B2B",
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
    completeness: "complete",
    unknowns: [],
    assumptions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("API Business Brain routes", () => {
  it("creates a company and reads it back", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await handlers.upsertCompanyHandler(
      request({
        token: tokenA,
        params: { workspaceId: workspaceA },
        body: { name: "Acme", description: "Agency", market: "B2B" },
      }),
    );
    const data = await dataOf(
      handlers.getCompanyHandler(request({ token: tokenA, params: { workspaceId: workspaceA } })),
    );
    expect(data).toMatchObject({ company: { name: "Acme", market: "B2B" } });
  });

  it("round-trips an offer", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await handlers.createOfferHandler(
      request({
        token: tokenA,
        params: { workspaceId: workspaceA },
        body: { name: "Automation", description: "Automates support" },
      }),
    );
    const data = await dataOf(
      handlers.listOffersHandler(request({ token: tokenA, params: { workspaceId: workspaceA } })),
    );
    expect(JSON.stringify(data)).toContain("Automation");
  });

  it("surfaces validation errors as structured details", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const error = await errorOf(
      handlers.createOfferHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA }, body: { name: "" } }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(error.details)).toBe(true);
  });

  it("approves a claim and records the approving identity", async () => {
    const { handlers, tokenA, workspaceA, userA } = fixture();
    const created = (await dataOf(
      handlers.createClaimHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { text: "SOC 2", category: "certification" },
        }),
      ),
    )) as { claim: { id: string; status: string; approvedBy: string | null } };

    expect(created.claim.status).toBe("unverified");
    expect(created.claim.approvedBy).toBeNull();

    const approved = (await dataOf(
      handlers.approveClaimHandler(request({ token: tokenA, params: { id: created.claim.id } })),
    )) as { claim: { status: string; approvedBy: string } };

    expect(approved.claim.status).toBe("approved");
    expect(approved.claim.approvedBy).toBe(userA);
  });

  it("filters claims by status", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await handlers.createClaimHandler(
      request({
        token: tokenA,
        params: { workspaceId: workspaceA },
        body: { text: "Restricted", category: "guarantee", status: "restricted" },
      }),
    );
    const data = await dataOf(
      handlers.listClaimsHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          query: { status: "restricted" },
        }),
      ),
    );
    expect(JSON.stringify(data)).toContain("Restricted");
  });

  it("rejects an invalid claim status filter", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const error = await errorOf(
      handlers.listClaimsHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          query: { status: "verified" },
        }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("maps a storage failure to SERVER_ERROR without leaking internals", async () => {
    const failing = {
      identity: {
        signup: () => ({ user: {} as never, token: "" }),
        authenticate: () => ({ user: {} as never, token: "" }),
        listWorkspaces: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        getWorkspace: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        updateWorkspace: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        getUser: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      },
      brain: new BusinessBrainService({
        authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      } as unknown as BrainRepository),
      goal: new RevenueGoalService(
        {
          authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as unknown as GoalRepository,
        deterministicGoalParser,
      ),
      brainContext: () => {
        throw new Error("business context unavailable");
      },
      planContext: () => {
        throw new Error("business brain unavailable");
      },
      plan: new RevenuePlanService(
        {
          authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as unknown as PlanRepository,
        deterministicPlanCompiler,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        () => {
          throw new Error("business brain unavailable");
        },
      ),
      account: new AccountService(
        {
          authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as unknown as AccountRepository,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      ),
      resolveSession: () => ({ userId: "u1" }),
    };

    const handlers = createHandlers(failing);
    const error = await errorOf(handlers.listWorkspacesHandler(request({ token: "t" })));
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
  });
});

describe("API Account & Contact routes", () => {
  type AccountRow = {
    id: string;
    name: string;
    domain: string | null;
    source: string;
    sourceReference: string | null;
    status: string;
    workspaceId: string;
    revenuePlanId: string | null;
  };
  type ContactRow = {
    id: string;
    accountId: string;
    fullName: string;
    email: string | null;
    status: string;
    workspaceId: string;
  };

  const accountFrom = (data: unknown): AccountRow => (data as { account: AccountRow }).account;
  const contactFrom = (data: unknown): ContactRow => (data as { contact: ContactRow }).contact;

  it("creates, reads, updates and archives an account", async () => {
    const { handlers, tokenA, workspaceA } = fixture();

    const created = accountFrom(
      await dataOf(
        handlers.createAccountHandler(
          request({
            token: tokenA,
            params: { workspaceId: workspaceA },
            body: { name: "Northwind Trading", website: "https://northwind.example" },
          }),
        ),
      ),
    );
    expect(created.domain).toBe("northwind.example");
    expect(created.source).toBe("manual");
    expect(created.workspaceId).toBe(workspaceA);

    const fetched = accountFrom(
      await dataOf(
        handlers.getAccountHandler(request({ token: tokenA, params: { id: created.id } })),
      ),
    );
    expect(fetched.name).toBe("Northwind Trading");

    const updated = accountFrom(
      await dataOf(
        handlers.updateAccountHandler(
          request({ token: tokenA, params: { id: created.id }, body: { geography: "UK" } }),
        ),
      ),
    );
    expect((updated as unknown as Record<string, unknown>).geography).toBe("UK");

    const archived = accountFrom(
      await dataOf(
        handlers.archiveAccountHandler(request({ token: tokenA, params: { id: created.id } })),
      ),
    );
    expect(archived.status).toBe("archived");

    const listed = (await dataOf(
      handlers.listAccountsHandler(request({ token: tokenA, params: { workspaceId: workspaceA } })),
    )) as { accounts: AccountRow[] };
    expect(listed.accounts.length).toBe(1);
  });

  it("never trusts a workspaceId or userId supplied in the body", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB, userB } = fixture();

    const created = accountFrom(
      await dataOf(
        handlers.createAccountHandler(
          request({
            token: tokenA,
            params: { workspaceId: workspaceA },
            body: {
              name: "Northwind",
              domain: "northwind.example",
              workspaceId: workspaceB,
              userId: userB,
              createdBy: userB,
            },
          }),
        ),
      ),
    );

    // The account landed in the route's workspace, owned by the token's user.
    expect(created.workspaceId).toBe(workspaceA);
    const fromB = (await dataOf(
      handlers.listAccountsHandler(request({ token: tokenB, params: { workspaceId: workspaceB } })),
    )) as { accounts: AccountRow[] };
    expect(fromB.accounts).toEqual([]);
  });

  it("denies another tenant's account and contact", async () => {
    const { handlers, tokenA, tokenB, workspaceA } = fixture();
    const account = accountFrom(
      await dataOf(
        handlers.createAccountHandler(
          request({
            token: tokenA,
            params: { workspaceId: workspaceA },
            body: { name: "Private Co", domain: "private.example" },
          }),
        ),
      ),
    );
    const contact = contactFrom(
      await dataOf(
        handlers.createContactHandler(
          request({
            token: tokenA,
            params: { workspaceId: workspaceA, accountId: account.id },
            body: { firstName: "Ada", email: "ada@private.example" },
          }),
        ),
      ),
    );

    const read = await errorOf(
      handlers.getAccountHandler(request({ token: tokenB, params: { id: account.id } })),
    );
    expect(read.code).toBe("UNAUTHORIZED");

    const readContact = await errorOf(
      handlers.getContactHandler(request({ token: tokenB, params: { id: contact.id } })),
    );
    expect(readContact.code).toBe("UNAUTHORIZED");

    const update = await errorOf(
      handlers.updateAccountHandler(
        request({ token: tokenB, params: { id: account.id }, body: { industry: "Retail" } }),
      ),
    );
    expect(update.code).toBe("UNAUTHORIZED");

    const list = await errorOf(
      handlers.listAccountsHandler(request({ token: tokenB, params: { workspaceId: workspaceA } })),
    );
    expect(list.code).toBe("UNAUTHORIZED");
  });

  it("refuses a contact on an account outside the caller's workspace", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    const account = accountFrom(
      await dataOf(
        handlers.createAccountHandler(
          request({
            token: tokenA,
            params: { workspaceId: workspaceA },
            body: { name: "Northwind", domain: "northwind.example" },
          }),
        ),
      ),
    );

    // B points its own workspace at A's account id.
    const error = await errorOf(
      handlers.createContactHandler(
        request({
          token: tokenB,
          params: { workspaceId: workspaceA },
          body: { accountId: account.id, firstName: "Mallory", email: "m@evil.example" },
        }),
      ),
    );
    // Denied before the account is even resolved, so nothing is disclosed.
    expect(error.code).toBe("UNAUTHORIZED");

    // In B's own workspace the same account id simply does not exist.
    const ownWorkspace = await errorOf(
      handlers.createContactHandler(
        request({
          token: tokenB,
          params: { workspaceId: workspaceB },
          body: { accountId: account.id, firstName: "Mallory", email: "m@evil.example" },
        }),
      ),
    );
    expect(ownWorkspace.code).toBe("NOT_FOUND");
  });

  it("imports accounts and contacts from CSV with a per-row result", async () => {
    const { handlers, tokenA, workspaceA } = fixture();

    const accounts = (await dataOf(
      handlers.importAccountsHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            csv: [
              "name,website,industry,source_reference",
              "Northwind,https://northwind.example,Wholesale,q1-list.csv",
              ",https://nameless.example,Wholesale,q1-list.csv",
            ].join("\n"),
            sourceReference: "q1-list.csv",
          },
        }),
      ),
    )) as {
      total: number;
      created: number;
      updated: number;
      skipped: number;
      failed: number;
      results: { row: number; status: string; reason?: string }[];
    };
    expect(accounts.total).toBe(2);
    expect(accounts.created).toBe(1);
    expect(accounts.failed).toBe(1);
    expect(accounts.results[1]?.reason).toBe("invalid");

    const listed = (await dataOf(
      handlers.listAccountsHandler(request({ token: tokenA, params: { workspaceId: workspaceA } })),
    )) as { accounts: AccountRow[] };
    expect(listed.accounts).toHaveLength(1);
    expect(listed.accounts[0]?.source).toBe("csv");
    expect(listed.accounts[0]?.sourceReference).toBe("q1-list.csv");

    const contacts = (await dataOf(
      handlers.importContactsHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            csv: [
              "account,first_name,last_name,email",
              `${listed.accounts[0]?.id ?? ""},Ada,Wong,ada@northwind.example`,
              ",Nobody,Here,nobody@nowhere.example",
            ].join("\n"),
          },
        }),
      ),
    )) as { created: number; failed: number; results: { reason?: string }[] };
    expect(contacts.created).toBe(1);
    expect(contacts.failed).toBe(1);
    expect(contacts.results[1]?.reason).toBe("missing_account_reference");

    const atAccount = (await dataOf(
      handlers.listAccountContactsHandler(
        request({ token: tokenA, params: { accountId: listed.accounts[0]?.id ?? "" } }),
      ),
    )) as { contacts: ContactRow[] };
    expect(atAccount.contacts.map((c) => c.fullName)).toEqual(["Ada Wong"]);

    const all = (await dataOf(
      handlers.listContactsHandler(request({ token: tokenA, params: { workspaceId: workspaceA } })),
    )) as { contacts: ContactRow[] };
    expect(all.contacts).toHaveLength(1);
  });

  it("rejects a non-CSV import body and a bad filter", async () => {
    const { handlers, tokenA, workspaceA } = fixture();

    const notCsv = await errorOf(
      handlers.importAccountsHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA }, body: { csv: 42 } }),
      ),
    );
    expect(notCsv.code).toBe("VALIDATION_ERROR");

    const badStatus = await errorOf(
      handlers.listAccountsHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA }, query: { status: "hot" } }),
      ),
    );
    expect(badStatus.code).toBe("VALIDATION_ERROR");
  });

  it("maps an account storage failure to SERVER_ERROR", async () => {
    const store = new Store(emptyState());
    const failing = {
      identity: {
        signup: () => ({ user: {} as never, token: "" }),
        authenticate: () => ({ user: {} as never, token: "" }),
        listWorkspaces: () => ({ ok: true as const, value: [] }),
        getWorkspace: () => ({ ok: true as const, value: {} as never }),
        authorize: () => ({ ok: true as const, value: {} as never }),
        updateWorkspace: () => ({ ok: true as const, value: {} as never }),
        getUser: () => ({ ok: true as const, value: {} as never }),
      },
      brain: new BusinessBrainService(store as unknown as BrainRepository),
      goal: new RevenueGoalService(store as unknown as GoalRepository, deterministicGoalParser),
      brainContext: () => ({
        workspaceId: "w1",
        company: null,
        offers: [],
        icp: null,
        personas: [],
      }),
      planContext: () => ({
        workspaceId: "w1",
        company: null,
        offers: [],
        icp: null,
        personas: [],
        positioning: null,
        brandVoice: null,
        approvedClaims: [],
        withheldClaims: { unverified: 0, restricted: 0 },
      }),
      plan: new RevenuePlanService(
        {
          authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as unknown as PlanRepository,
        deterministicPlanCompiler,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        () => {
          throw new Error("business brain unavailable");
        },
      ),
      account: new AccountService(
        {
          authorize: () => ({ ok: true as const, value: {} }),
          listAccounts: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as unknown as AccountRepository,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      ),
      resolveSession: () => ({ userId: "u1" }),
    };

    const handlers = createHandlers(failing);
    const error = await errorOf(
      handlers.listAccountsHandler(request({ token: "t", params: { workspaceId: "w1" } })),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("UNAVAILABLE");
  });
});
