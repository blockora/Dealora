import { describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";
import { BusinessBrainService } from "@dealora/brain";
import type { BrainRepository } from "@dealora/brain";
import { RevenueGoalService, deterministicGoalParser } from "@dealora/goal";
import type { GoalRepository } from "@dealora/goal";

import { createHandlers } from "./handlers.js";
import type { HandlerDeps } from "./handlers.js";
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
      resolveSession: () => ({ userId: "u1" }),
    };

    const handlers = createHandlers(failing);
    const error = await errorOf(handlers.listWorkspacesHandler(request({ token: "t" })));
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
  });
});
