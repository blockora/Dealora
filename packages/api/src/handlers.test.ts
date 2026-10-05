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
import {
  AccountRecordProvider,
  StaticResearchProvider,
  createResearchService,
} from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import { createEvidenceService } from "@dealora/evidence";
import {
  createQualificationService,
  toGoalSnapshot,
  toIcpSnapshot,
  toPlanReader,
} from "@dealora/qualification";
import {
  createPersonalizationService,
  toOfferSnapshot,
  toQualificationSnapshot,
} from "@dealora/personalization";
import { createApprovalService, toApprovalDraftSnapshot } from "@dealora/approval";
import {
  ProviderRegistry,
  SandboxEmailProvider,
  createApprovalVerifier,
  createContactReader,
  createDraftReader,
  createOutboundService,
} from "@dealora/outbound";
import {
  createConversationService,
  createOutboundReader,
  createSuppressionWriter,
} from "@dealora/conversation";

import {
  SandboxCalendarProvider,
  createClassificationReader,
  createMeetingService,
  createQualificationReader,
  createSuppressionReader,
} from "@dealora/meeting";
import { createContactReader as createMeetingContactReader } from "@dealora/meeting";
import {
  createAccountIndexReader,
  createAccountStateReader,
  createNextActionService,
} from "@dealora/nextaction";
import {
  createRevenueGraphIndexReader,
  createRevenueGraphReader,
  createRevenueGraphService,
} from "@dealora/revenuegraph";
import { createHandlers } from "./handlers.js";
import type { HandlerDeps } from "./handlers.js";
import type { RevenueGoal } from "@dealora/db";
import type { ApiError, ApiResponse, RequestBody } from "./types.js";

/**
 * Wire the Qualification service the way the production wiring does.
 *
 * The readers are the same narrow ones `createDefaultHandlers` builds: the ICP's
 * target terms, a goal's time window, and a plan's provenance. Route tests then
 * exercise the real service rather than a stand-in.
 */
function qualificationService(store: Store, clock?: () => Date) {
  return createQualificationService(
    store as never,
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
    clock,
  );
}

/**
 * Wire the Approval service the way the production wiring does.
 *
 * The reader is the same narrow one `createDefaultHandlers` builds: a draft's
 * subject, body, warnings and version. Route tests then exercise the real
 * service rather than a stand-in.
 */
function approvalService(store: Store, clock?: () => Date) {
  return createApprovalService(
    store as never,
    {
      byId: (draftId, userId) => {
        const found = store.getDraft(draftId, userId);
        return found.ok ? toApprovalDraftSnapshot(found.value) : null;
      },
      latestVersion: (draftId, userId) => {
        const found = store.getDraft(draftId, userId);
        return found.ok ? toApprovalDraftSnapshot(found.value) : null;
      },
    },
    clock,
  );
}

/**
 * Wire the Outbound service the way the production wiring does.
 *
 * The readers are the same narrow ones `createDefaultHandlers` builds — a draft,
 * a contact, and an approval verifier that reads the persisted rows — and the
 * provider is the sandbox, which performs no network I/O and records what it
 * accepted. Route tests then exercise the real send boundary rather than a
 * stand-in.
 */
function outboundService(store: Store, clock?: () => Date) {
  return createOutboundService(
    store as never,
    createApprovalVerifier(store as never),
    createDraftReader(store as never),
    createContactReader(store as never),
    registryWithSandbox(),
    clock,
  );
}

/** A registry holding only the sandbox email provider. */
function registryWithSandbox(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("email", new SandboxEmailProvider());
  return registry;
}

/**
 * Wire the Conversation service the way the production wiring does.
 *
 * The same narrow readers and the same Phase 11 suppression list, so a route
 * test that records a response exercises the real engine and the real opt-out
 * mechanism rather than a stand-in.
 */
function conversationService(store: Store, clock?: () => Date) {
  return createConversationService(
    store as never,
    createOutboundReader(store as never),
    createSuppressionWriter(store as never),
    clock,
  );
}

/**
 * Wire the Meeting service the way the production wiring does.
 *
 * The same narrow readers, the same Phase 11 suppression list and the same
 * sandbox calendar, so a route test that proposes or books a meeting exercises
 * the real engine rather than a stand-in.
 */
function meetingService(store: Store, clock?: () => Date) {
  return createMeetingService(
    store as never,
    createClassificationReader(store as never),
    createQualificationReader(store as never),
    createMeetingContactReader(store as never),
    createSuppressionReader(store as never),
    new SandboxCalendarProvider(),
    clock,
  );
}

/**
 * Wire the Next Best Action service the way the production wiring does.
 *
 * The same narrow account-state reader and account index, so a route test that
 * asks "what should happen next?" exercises the real engine reading the real
 * store rather than a stand-in that could not disagree with it.
 */
function nextActionService(store: Store) {
  return createNextActionService(
    store as never,
    createAccountStateReader(store as never),
    createAccountIndexReader(store as never),
  );
}

/**
 * Wire the Revenue Graph service the way the production wiring does: the same
 * account reader and account index, so a route test asking for a graph
 * exercises the real derivation over the real store rather than a stand-in
 * that could not disagree with it.
 */
function revenueGraphService(store: Store) {
  return createRevenueGraphService(
    store as never,
    createRevenueGraphReader(store as never),
    createRevenueGraphIndexReader(store as never),
  );
}

/**
 * Wire the Personalization service the way the production wiring does.
 *
 * The readers are the same narrow ones `createDefaultHandlers` builds: the
 * newest qualification for an account, and the active offers whose own words a
 * draft may quote. Route tests then exercise the real service rather than a
 * stand-in.
 */
function personalizationService(store: Store, clock?: () => Date) {
  return createPersonalizationService(
    store as never,
    {
      latest: (workspaceId, userId, accountId) => {
        const auth = store.authorize(workspaceId, userId);
        if (!auth.ok) return null;
        const listed = store.listQualifications(workspaceId, userId, { accountId });
        if (!listed.ok) return null;
        const latest = listed.value[0];
        return latest === undefined ? null : toQualificationSnapshot(latest);
      },
      byId: (qualificationId, userId) => {
        const found = store.getQualification(qualificationId, userId);
        return found.ok ? toQualificationSnapshot(found.value) : null;
      },
    },
    {
      byId: (offerId, userId) => {
        const found = store.getOffer(offerId, userId);
        return found.ok ? toOfferSnapshot(found.value) : null;
      },
      listActive: (workspaceId, userId) => {
        const auth = store.authorize(workspaceId, userId);
        if (!auth.ok) return [];
        const offers = store.listOffers(workspaceId, userId);
        if (!offers.ok) return [];
        return offers.value.filter((offer) => offer.status === "active").map(toOfferSnapshot);
      },
    },
    clock,
  );
}

/**
 * Two tenants with real sessions. The session resolver maps tokens to a user
 * id exactly as the auth package does, so a handler only ever learns the
 * identity from the token.
 */
function fixture(options?: {
  researchProviders?: readonly ResearchProvider[];
  /** A fixed clock for the evidence layer, so freshness is reproducible. */
  evidenceClock?: () => Date;
}): {
  handlers: ReturnType<typeof createHandlers>;
  tokenA: string;
  tokenB: string;
  workspaceA: string;
  workspaceB: string;
  userA: string;
  userB: string;
  store: Store;
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
    research: createResearchService(store as never, [
      new AccountRecordProvider(),
      ...(options?.researchProviders ?? []),
    ]),
    evidence: createEvidenceService(store as never, options?.evidenceClock),
    qualification: qualificationService(store, options?.evidenceClock),
    personalization: personalizationService(store),
    approval: approvalService(store),
    outbound: outboundService(store),
    conversation: conversationService(store),
    meeting: meetingService(store),
    nextaction: nextActionService(store),
    revenuegraph: revenueGraphService(store),
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
    store,
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
      research: createResearchService(store as never),
      evidence: createEvidenceService(store as never),
      qualification: qualificationService(store),
      personalization: personalizationService(store),
      approval: approvalService(store),
      outbound: outboundService(store),
      conversation: conversationService(store),
      meeting: meetingService(store),
      nextaction: nextActionService(store),
      revenuegraph: revenueGraphService(store),
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
      research: createResearchService(store as never),
      evidence: createEvidenceService(store as never),
      qualification: qualificationService(store),
      personalization: personalizationService(store),
      approval: approvalService(store),
      outbound: outboundService(store),
      conversation: conversationService(store),
      meeting: meetingService(store),
      nextaction: nextActionService(store),
      revenuegraph: revenueGraphService(store),
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
    const failingStore = new Store(emptyState());
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
      research: createResearchService(
        {
          authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as never,
        [new AccountRecordProvider()],
      ),
      evidence: createEvidenceService({
        authorize: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      } as never),
      qualification: qualificationService(failingStore),
      personalization: personalizationService(failingStore),
      approval: approvalService(failingStore),
      outbound: outboundService(failingStore),
      conversation: conversationService(failingStore),
      meeting: meetingService(failingStore),
      nextaction: nextActionService(failingStore),
      revenuegraph: revenueGraphService(failingStore),
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
      research: createResearchService(store as never),
      evidence: createEvidenceService(store as never),
      qualification: qualificationService(store),
      personalization: personalizationService(store),
      approval: approvalService(store),
      outbound: outboundService(store),
      conversation: conversationService(store),
      meeting: meetingService(store),
      nextaction: nextActionService(store),
      revenuegraph: revenueGraphService(store),
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

describe("API Research routes", () => {
  type ResearchRow = {
    id: string;
    workspaceId: string;
    accountId: string;
    provider: string;
    status: string;
    categories: string[];
    findingCount: number;
    failureCode: string | null;
    requestedBy?: string;
  };

  const observation = {
    category: "company_overview",
    field: "products_services.summary",
    value: "The public site lists three service tiers.",
    claimKind: "fact",
    sourceUrl: "https://northwind.example/services",
    sourceTitle: "Services page",
    observedAt: "2026-09-01T00:00:00.000Z",
    confidence: "medium",
    relevance: "high",
    note: null,
  };

  /** A provider declared by the test, not a real external retrieval. */
  const declaredProvider = (id: string, findings: unknown[]): ResearchProvider =>
    new StaticResearchProvider(id, "public_web", findings as never);

  async function accountFor(handlers: unknown, token: string, workspaceId: string) {
    return (await dataOf(
      (handlers as ReturnType<typeof fixture>["handlers"]).createAccountHandler(
        request({
          token,
          params: { workspaceId },
          body: { name: "Northwind Trading", website: "https://northwind.example" },
        }),
      ),
    )) as { account: { id: string } };
  }

  it("creates, runs and reads an attributed research request", async () => {
    const { handlers, tokenA, workspaceA } = fixture({
      researchProviders: [declaredProvider("public_site", [observation])],
    });
    const account = await accountFor(handlers, tokenA, workspaceA);

    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId: account.account.id },
          body: { provider: "public_site", categories: ["company_overview"] },
        }),
      ),
    )) as { request: ResearchRow };
    expect(created.request.status).toBe("pending");
    expect(created.request.workspaceId).toBe(workspaceA);

    const run = (await dataOf(
      handlers.runResearchRequestHandler(
        request({ token: tokenA, params: { id: created.request.id } }),
      ),
    )) as { request: ResearchRow; findings: { sourceUrl: string; retrievedAt: string }[] };
    expect(run.request.status).toBe("completed");
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]?.sourceUrl).toBe("https://northwind.example/services");
    expect(run.findings[0]?.retrievedAt).toBeTruthy();

    const findings = (await dataOf(
      handlers.getResearchFindingsHandler(
        request({ token: tokenA, params: { id: created.request.id } }),
      ),
    )) as { findings: unknown[] };
    expect(findings.findings).toHaveLength(1);

    const listed = (await dataOf(
      handlers.listResearchRequestsHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA } }),
      ),
    )) as { requests: ResearchRow[] };
    expect(listed.requests).toHaveLength(1);
  });

  it("reports a failed run as a failed request, not as an empty success", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const account = await accountFor(handlers, tokenA, workspaceA);
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId: account.account.id },
          body: { provider: "account_record" },
        }),
      ),
    )) as { request: ResearchRow };

    const run = (await dataOf(
      handlers.runResearchRequestHandler(
        request({ token: tokenA, params: { id: created.request.id } }),
      ),
    )) as { request: ResearchRow };
    expect(run.request.status).toBe("completed");

    // Running it again is an illegal transition, not a silent second pass.
    const again = await errorOf(
      handlers.runResearchRequestHandler(
        request({ token: tokenA, params: { id: created.request.id } }),
      ),
    );
    expect(again.code).toBe("CONFLICT");
  });

  it("refuses an unregistered provider as a validation failure", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const account = await accountFor(handlers, tokenA, workspaceA);
    const error = await errorOf(
      handlers.createResearchRequestHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId: account.account.id },
          body: { provider: "some_scraper" },
        }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid status filter and an unauthenticated caller", async () => {
    const { handlers, workspaceA } = fixture();
    const badStatus = await errorOf(
      handlers.listResearchRequestsHandler(
        request({
          token: "token-alice",
          params: { workspaceId: workspaceA },
          query: { status: "x" },
        }),
      ),
    );
    expect(badStatus.code).toBe("VALIDATION_ERROR");

    const anonymous = await errorOf(
      handlers.listResearchRequestsHandler(request({ params: { workspaceId: workspaceA } })),
    );
    expect(anonymous.code).toBe("UNAUTHENTICATED");
  });

  it("enforces workspace isolation on every research entry point", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture({
      researchProviders: [declaredProvider("public_site", [observation])],
    });
    const account = await accountFor(handlers, tokenA, workspaceA);
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId: account.account.id },
          body: { provider: "public_site" },
        }),
      ),
    )) as { request: ResearchRow };
    await dataOf(
      handlers.runResearchRequestHandler(
        request({ token: tokenA, params: { id: created.request.id } }),
      ),
    );

    const denials = await Promise.all([
      errorOf(
        handlers.getResearchRequestHandler(
          request({ token: tokenB, params: { id: created.request.id } }),
        ),
      ),
      errorOf(
        handlers.runResearchRequestHandler(
          request({ token: tokenB, params: { id: created.request.id } }),
        ),
      ),
      errorOf(
        handlers.cancelResearchRequestHandler(
          request({ token: tokenB, params: { id: created.request.id } }),
        ),
      ),
      errorOf(
        handlers.getResearchFindingsHandler(
          request({ token: tokenB, params: { id: created.request.id } }),
        ),
      ),
      errorOf(
        handlers.listResearchRequestsHandler(
          request({ token: tokenB, params: { workspaceId: workspaceA } }),
        ),
      ),
    ]);
    for (const denial of denials) {
      expect(denial.code).toBe("UNAUTHORIZED");
      // A denial discloses nothing about the other tenant's research.
      expect(JSON.stringify(denial)).not.toContain("northwind.example");
    }

    // Researching another tenant's account is reported as "not found": the
    // account must not even be revealed to exist.
    const foreignAccount = await errorOf(
      handlers.createResearchRequestHandler(
        request({
          token: tokenB,
          params: { workspaceId: workspaceB, accountId: account.account.id },
          body: { provider: "public_site" },
        }),
      ),
    );
    expect(foreignAccount.code).toBe("NOT_FOUND");
    expect(JSON.stringify(foreignAccount)).not.toContain("northwind.example");
  });

  it("ignores a workspace or user identity supplied in the request body", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    const account = await accountFor(handlers, tokenA, workspaceA);
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId: account.account.id },
          body: {
            provider: "account_record",
            workspaceId: workspaceB,
            userId: tokenB,
            accountId: "some-other-account",
          },
        }),
      ),
    )) as { request: ResearchRow };

    // The route's workspace and account win; the token's user owns it.
    expect(created.request.workspaceId).toBe(workspaceA);
    expect(created.request.accountId).toBe(account.account.id);
    expect(created.request.requestedBy).not.toBe(tokenB);

    const bView = (await dataOf(
      handlers.listResearchRequestsHandler(
        request({ token: tokenB, params: { workspaceId: workspaceB } }),
      ),
    )) as { requests: ResearchRow[] };
    expect(bView.requests).toEqual([]);
  });

  it("maps a research storage failure to SERVER_ERROR without leaking internals", async () => {
    const store = new Store(emptyState());
    const handlers = createHandlers({
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
      planContext: () => readPlanBrain(store, "w1", "u1"),
      plan: new RevenuePlanService(
        store as unknown as PlanRepository,
        deterministicPlanCompiler,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        () => readPlanBrain(store, "w1", "u1"),
      ),
      account: new AccountService(store as unknown as AccountRepository, () => ({
        ok: false,
        error: { code: "UNAVAILABLE" },
      })),
      research: createResearchService(
        {
          authorize: () => ({ ok: true as const, value: {} }),
          listResearchRequests: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as never,
        [new AccountRecordProvider()],
      ),
      evidence: createEvidenceService({
        authorize: () => ({ ok: true as const, value: {} }),
        listEvidence: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      } as never),
      qualification: qualificationService(store),
      personalization: personalizationService(store),
      approval: approvalService(store),
      outbound: outboundService(store),
      conversation: conversationService(store),
      meeting: meetingService(store),
      nextaction: nextActionService(store),
      revenuegraph: revenueGraphService(store),
      resolveSession: () => ({ userId: "u1" }),
    });
    const error = await errorOf(
      handlers.listResearchRequestsHandler(request({ token: "t", params: { workspaceId: "w1" } })),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("UNAVAILABLE");
  });

  it("never surfaces an evidence storage failure to the caller", async () => {
    const store = new Store(emptyState());
    const handlers = createHandlers({
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
      planContext: () => readPlanBrain(store, "w1", "u1"),
      plan: new RevenuePlanService(
        store as unknown as PlanRepository,
        deterministicPlanCompiler,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        () => readPlanBrain(store, "w1", "u1"),
      ),
      account: new AccountService(store as unknown as AccountRepository, () => ({
        ok: false,
        error: { code: "UNAVAILABLE" },
      })),
      research: createResearchService(store as never),
      evidence: createEvidenceService({
        authorize: () => ({ ok: true as const, value: {} }),
        listEvidence: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      } as never),
      qualification: qualificationService(store),
      personalization: personalizationService(store),
      approval: approvalService(store),
      outbound: outboundService(store),
      conversation: conversationService(store),
      meeting: meetingService(store),
      nextaction: nextActionService(store),
      revenuegraph: revenueGraphService(store),
      resolveSession: () => ({ userId: "u1" }),
    });
    const error = await errorOf(
      handlers.listEvidenceHandler(request({ token: "t", params: { workspaceId: "w1" } })),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("UNAVAILABLE");
  });
});

describe("API Evidence routes", () => {
  type EvidenceRow = {
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
  };
  type ClaimRow = {
    id: string;
    workspaceId: string;
    accountId: string;
    category: string;
    field: string;
    value: string;
    claimKind: string;
    status: string;
  };
  type Outcome = { evidence: EvidenceRow; claim: ClaimRow; contradicted: EvidenceRow[] };

  /** A declared provider, not a real external retrieval. */
  const declaredProvider = (id: string, findings: unknown[]): ResearchProvider =>
    new StaticResearchProvider(id, "public_web", findings as never);

  const sizeObservation = (value: string) => ({
    category: "company_overview",
    field: "employee_count",
    value,
    claimKind: "fact",
    sourceUrl: "https://registry.example/northwind",
    sourceTitle: "Company registry entry",
    observedAt: "2026-09-01T00:00:00.000Z",
    confidence: "medium",
    relevance: "high",
    note: null,
  });

  async function seedAccount(
    handlers: ReturnType<typeof fixture>["handlers"],
    token: string,
    workspaceId: string,
  ): Promise<string> {
    const created = (await dataOf(
      handlers.createAccountHandler(
        request({
          token,
          params: { workspaceId },
          body: { name: "Northwind Trading", website: "https://northwind.example" },
        }),
      ),
    )) as { account: { id: string } };
    return created.account.id;
  }

  /** Research an account and return the recorded findings. */
  async function research(
    handlers: ReturnType<typeof fixture>["handlers"],
    token: string,
    workspaceId: string,
    accountId: string,
    providerId: string,
  ): Promise<{ id: string; field: string }[]> {
    const created = (await dataOf(
      handlers.createResearchRequestHandler(
        request({
          token,
          params: { workspaceId, accountId },
          body: { provider: providerId },
        }),
      ),
    )) as { request: { id: string } };
    const run = (await dataOf(
      handlers.runResearchRequestHandler(request({ token, params: { id: created.request.id } })),
    )) as { findings: { id: string; field: string }[] };
    return run.findings;
  }

  it("converts a finding into evidence and traces the claim back to it", async () => {
    const { handlers, tokenA, workspaceA } = fixture({
      researchProviders: [declaredProvider("registry", [sizeObservation("120")])],
    });
    const accountId = await seedAccount(handlers, tokenA, workspaceA);
    const findings = await research(handlers, tokenA, workspaceA, accountId, "registry");
    const findingId = findings[0]?.id ?? "";

    const outcome = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, researchFindingId: findingId },
        }),
      ),
    )) as Outcome;

    // The source metadata came from the finding, not from the request.
    expect(outcome.evidence.sourceName).toBe("registry");
    expect(outcome.evidence.source).toBe("public_web");
    expect(outcome.evidence.sourceUrl).toBe("https://registry.example/northwind");
    expect(outcome.evidence.observedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(outcome.evidence.confidence).toBe("medium");
    expect(outcome.evidence.relevance).toBe("high");
    expect(outcome.evidence.freshness).toBeTruthy();
    expect(outcome.evidence.provenance).toBe("research_finding");
    expect(outcome.evidence.researchFindingId).toBe(findingId);
    expect(outcome.evidence.status).toBe("recorded");

    // The claim states the assertion and nothing more.
    expect(outcome.claim.field).toBe("employee_count");
    expect(outcome.claim.value).toBe("120");
    expect(outcome.claim.claimKind).toBe("fact");
    expect(outcome.claim.status).toBe("asserted");

    // The traceability direction: claim -> evidence.
    const support = (await dataOf(
      handlers.listClaimEvidenceHandler(
        request({ token: tokenA, params: { id: outcome.claim.id } }),
      ),
    )) as { evidence: EvidenceRow[] };
    expect(support.evidence).toHaveLength(1);
    expect(support.evidence[0]?.researchFindingId).toBe(findingId);

    const one = (await dataOf(
      handlers.getEvidenceHandler(request({ token: tokenA, params: { id: outcome.evidence.id } })),
    )) as { evidence: EvidenceRow };
    expect(one.evidence.id).toBe(outcome.evidence.id);
  });

  it("records user-supplied evidence and ignores identity in the body", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB, userA } = fixture();
    const accountId = await seedAccount(handlers, tokenA, workspaceA);

    const outcome = (await dataOf(
      handlers.recordUserEvidenceHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId },
          body: {
            category: "company_overview",
            field: "geography",
            value: "United Kingdom",
            claimKind: "fact",
            sourceName: "workspace account record",
            confidence: "medium",
            relevance: "high",
            // A caller cannot name its own workspace, user or account.
            workspaceId: workspaceB,
            userId: userA,
            source: "public_web",
          },
        }),
      ),
    )) as Outcome;

    expect(outcome.evidence.workspaceId).toBe(workspaceA);
    expect(outcome.evidence.accountId).toBe(accountId);
    // The source kind follows from the provenance, not from the caller.
    expect(outcome.evidence.source).toBe("account_record");
    expect(outcome.evidence.provenance).toBe("user_supplied");
    expect(outcome.evidence.researchFindingId).toBeNull();
    expect(outcome.evidence.sourceUrl).toBeNull();
    // No observation date supplied, so no currency is claimed.
    expect(outcome.evidence.freshness).toBe("unknown");

    // And nothing landed in the other tenant.
    const bList = (await dataOf(
      handlers.listEvidenceHandler(request({ token: tokenB, params: { workspaceId: workspaceB } })),
    )) as { evidence: EvidenceRow[] };
    expect(bList.evidence).toEqual([]);
  });

  it("preserves both sides of a contradiction and names neither the winner", async () => {
    const { handlers, tokenA, workspaceA } = fixture({
      researchProviders: [
        declaredProvider("registry_a", [sizeObservation("50")]),
        declaredProvider("registry_b", [sizeObservation("120")]),
      ],
    });
    const accountId = await seedAccount(handlers, tokenA, workspaceA);

    const aFindings = await research(handlers, tokenA, workspaceA, accountId, "registry_a");
    const first = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, researchFindingId: aFindings[0]?.id ?? "" },
        }),
      ),
    )) as Outcome;
    expect(first.evidence.status).toBe("recorded");
    expect(first.claim.status).toBe("asserted");

    const bFindings = await research(handlers, tokenA, workspaceA, accountId, "registry_b");
    const second = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, researchFindingId: bFindings[0]?.id ?? "" },
        }),
      ),
    )) as Outcome;

    // Both records exist, both are marked, and neither overwrote the other.
    expect(second.contradicted).toHaveLength(1);
    expect(second.contradicted[0]?.id).toBe(first.evidence.id);
    expect(second.evidence.status).toBe("contradicted");
    expect(second.claim.status).toBe("contested");

    const all = (await dataOf(
      handlers.listEvidenceHandler(request({ token: tokenA, params: { workspaceId: workspaceA } })),
    )) as { evidence: EvidenceRow[] };
    expect(all.evidence).toHaveLength(2);
    expect(all.evidence.every((e) => e.status === "contradicted")).toBe(true);
    // Each side still carries its own citation.
    expect(new Set(all.evidence.map((e) => e.id)).size).toBe(2);
    expect(all.evidence.every((e) => e.sourceUrl === "https://registry.example/northwind")).toBe(
      true,
    );

    // A contested claim cannot be quietly returned to asserted.
    const reverted = await errorOf(
      handlers.changeAccountClaimStatusHandler(
        request({ token: tokenA, params: { id: second.claim.id }, body: { status: "asserted" } }),
      ),
    );
    expect(reverted.code).toBe("CONFLICT");
  });

  it("supersedes only when the replacement is named, and keeps the old record", async () => {
    const { handlers, tokenA, workspaceA } = fixture({
      researchProviders: [declaredProvider("registry", [sizeObservation("120")])],
    });
    const accountId = await seedAccount(handlers, tokenA, workspaceA);
    const findings = await research(handlers, tokenA, workspaceA, accountId, "registry");

    const outcome = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, researchFindingId: findings[0]?.id ?? "" },
        }),
      ),
    )) as Outcome;

    // Superseding by status alone is refused: it would record a supersession
    // with nothing to supersede it.
    const bare = await errorOf(
      handlers.changeEvidenceStatusHandler(
        request({
          token: tokenA,
          params: { id: outcome.evidence.id },
          body: { status: "superseded" },
        }),
      ),
    );
    expect(bare.code).toBe("VALIDATION_ERROR");

    // A second, agreeing record from the same account record.
    const again = await research(handlers, tokenA, workspaceA, accountId, "registry");
    const replacement = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, researchFindingId: again[0]?.id ?? "" },
        }),
      ),
    )) as Outcome;

    const superseded = (await dataOf(
      handlers.supersedeEvidenceHandler(
        request({
          token: tokenA,
          params: { id: outcome.evidence.id },
          body: { replacementEvidenceId: replacement.evidence.id },
        }),
      ),
    )) as { superseded: EvidenceRow; replacement: EvidenceRow };
    expect(superseded.superseded.status).toBe("superseded");
    expect(superseded.replacement.id).toBe(replacement.evidence.id);

    // The old observation is history, not a deletion.
    const reread = (await dataOf(
      handlers.getEvidenceHandler(request({ token: tokenA, params: { id: outcome.evidence.id } })),
    )) as { evidence: EvidenceRow };
    expect(reread.evidence.status).toBe("superseded");
    expect(reread.evidence.sourceUrl).toBe(outcome.evidence.sourceUrl);
    expect(reread.evidence.retrievedAt).toBe(outcome.evidence.retrievedAt);
    expect(reread.evidence.researchFindingId).toBe(outcome.evidence.researchFindingId);

    // And a superseded record is terminal.
    const changed = await errorOf(
      handlers.changeEvidenceStatusHandler(
        request({
          token: tokenA,
          params: { id: outcome.evidence.id },
          body: { status: "rejected" },
        }),
      ),
    );
    expect(changed.code).toBe("CONFLICT");
  });

  it("rejects invalid statuses and unsupported values", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const accountId = await seedAccount(handlers, tokenA, workspaceA);
    const outcome = (await dataOf(
      handlers.recordUserEvidenceHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId },
          body: {
            category: "company_overview",
            field: "employee_count",
            value: "120",
            claimKind: "fact",
            sourceName: "workspace account record",
            confidence: "medium",
            relevance: "high",
          },
        }),
      ),
    )) as Outcome;

    // Nothing here can be marked verified, scored or qualified.
    for (const status of ["verified", "qualified", "scored", "promoted"]) {
      const error = await errorOf(
        handlers.changeEvidenceStatusHandler(
          request({
            token: tokenA,
            params: { id: outcome.evidence.id },
            body: { status },
          }),
        ),
      );
      expect(error.code).toBe("VALIDATION_ERROR");
    }

    // A qualification-flavoured category is not a research category.
    const badCategory = await errorOf(
      handlers.recordUserEvidenceHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId },
          body: {
            category: "buying_intent",
            field: "intent",
            value: "hot",
            claimKind: "fact",
            sourceName: "workspace account record",
            confidence: "high",
            relevance: "high",
          },
        }),
      ),
    );
    expect(badCategory.code).toBe("VALIDATION_ERROR");

    const badFilter = await errorOf(
      handlers.listEvidenceHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          query: { status: "verified" },
        }),
      ),
    );
    expect(badFilter.code).toBe("VALIDATION_ERROR");

    const badClaimFilter = await errorOf(
      handlers.listAccountClaimsHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          query: { status: "qualified" },
        }),
      ),
    );
    expect(badClaimFilter.code).toBe("VALIDATION_ERROR");
  });

  it("withdraws a claim softly and keeps its evidence readable", async () => {
    const { handlers, tokenA, workspaceA } = fixture({
      researchProviders: [declaredProvider("registry", [sizeObservation("120")])],
    });
    const accountId = await seedAccount(handlers, tokenA, workspaceA);
    const findings = await research(handlers, tokenA, workspaceA, accountId, "registry");
    const outcome = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, researchFindingId: findings[0]?.id ?? "" },
        }),
      ),
    )) as Outcome;

    const retracted = (await dataOf(
      handlers.changeAccountClaimStatusHandler(
        request({ token: tokenA, params: { id: outcome.claim.id }, body: { status: "retracted" } }),
      ),
    )) as { claim: ClaimRow };
    expect(retracted.claim.status).toBe("retracted");

    // The evidence that supported it survives the withdrawal.
    const support = (await dataOf(
      handlers.listClaimEvidenceHandler(
        request({ token: tokenA, params: { id: outcome.claim.id } }),
      ),
    )) as { evidence: EvidenceRow[] };
    expect(support.evidence).toHaveLength(1);

    // A retracted claim is terminal.
    const revived = await errorOf(
      handlers.changeAccountClaimStatusHandler(
        request({ token: tokenA, params: { id: outcome.claim.id }, body: { status: "asserted" } }),
      ),
    );
    expect(revived.code).toBe("CONFLICT");
  });

  it("enforces workspace isolation and never reveals a foreign finding", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture({
      researchProviders: [declaredProvider("registry", [sizeObservation("120")])],
    });
    const accountId = await seedAccount(handlers, tokenA, workspaceA);
    const findings = await research(handlers, tokenA, workspaceA, accountId, "registry");
    const findingId = findings[0]?.id ?? "";
    const outcome = (await dataOf(
      handlers.createEvidenceFromFindingHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, researchFindingId: findingId },
        }),
      ),
    )) as Outcome;

    const denials = await Promise.all([
      // Another tenant cannot convert, read or list this evidence.
      errorOf(
        handlers.createEvidenceFromFindingHandler(
          request({
            token: tokenB,
            params: { workspaceId: workspaceB, researchFindingId: findingId },
          }),
        ),
      ),
      errorOf(
        handlers.getEvidenceHandler(
          request({ token: tokenB, params: { id: outcome.evidence.id } }),
        ),
      ),
      errorOf(
        handlers.getAccountClaimHandler(
          request({ token: tokenB, params: { id: outcome.claim.id } }),
        ),
      ),
      errorOf(
        handlers.listClaimEvidenceHandler(
          request({ token: tokenB, params: { id: outcome.claim.id } }),
        ),
      ),
      errorOf(
        handlers.changeEvidenceStatusHandler(
          request({
            token: tokenB,
            params: { id: outcome.evidence.id },
            body: { status: "rejected" },
          }),
        ),
      ),
      errorOf(
        handlers.changeAccountClaimStatusHandler(
          request({
            token: tokenB,
            params: { id: outcome.claim.id },
            body: { status: "retracted" },
          }),
        ),
      ),
      // Nor write evidence into another tenant's account.
      errorOf(
        handlers.recordUserEvidenceHandler(
          request({
            token: tokenB,
            params: { workspaceId: workspaceB, accountId },
            body: {
              category: "company_overview",
              field: "employee_count",
              value: "999",
              claimKind: "fact",
              sourceName: "workspace account record",
              confidence: "high",
              relevance: "high",
            },
          }),
        ),
      ),
    ]);

    for (const denial of denials) {
      // A foreign account or finding is not even revealed to exist.
      expect(["UNAUTHORIZED", "NOT_FOUND"]).toContain(denial.code);
      expect(JSON.stringify(denial)).not.toContain("northwind");
      expect(JSON.stringify(denial)).not.toContain("registry.example");
    }

    // The other tenant sees nothing at all.
    const bList = (await dataOf(
      handlers.listEvidenceHandler(request({ token: tokenB, params: { workspaceId: workspaceB } })),
    )) as { evidence: EvidenceRow[] };
    expect(bList.evidence).toEqual([]);
    const bClaims = (await dataOf(
      handlers.listAccountClaimsHandler(
        request({ token: tokenB, params: { workspaceId: workspaceB } }),
      ),
    )) as { claims: ClaimRow[] };
    expect(bClaims.claims).toEqual([]);
  });

  it("requires authentication", async () => {
    const { handlers, workspaceA } = fixture();
    const denials = await Promise.all([
      errorOf(handlers.listEvidenceHandler(request({ params: { workspaceId: workspaceA } }))),
      errorOf(handlers.listAccountClaimsHandler(request({ params: { workspaceId: workspaceA } }))),
      errorOf(handlers.getEvidenceHandler(request({ params: { id: "e1" } }))),
      errorOf(handlers.getAccountClaimHandler(request({ params: { id: "c1" } }))),
      errorOf(
        handlers.createEvidenceFromFindingHandler(
          request({ params: { workspaceId: workspaceA, researchFindingId: "f1" } }),
        ),
      ),
    ]);
    for (const denial of denials) expect(denial.code).toBe("UNAUTHENTICATED");
  });
});

describe("API Qualification routes", () => {
  type QualificationRow = {
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
  };

  /** A workspace with an ICP, a goal, a plan and an account, all real. */
  async function qualifyFixture(options?: { evidenceClock?: () => Date }) {
    const context = fixture(options);
    const { handlers, tokenA, workspaceA } = context;
    const icp = (await dataOf(
      handlers.upsertIcpHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            industries: ["saas"],
            companySizes: ["120 employees"],
            geographies: ["united kingdom"],
            businessModels: ["subscription"],
            disqualifiers: ["agency"],
          },
        }),
      ),
    )) as { icp: { id: string } };
    const offer = (await dataOf(
      handlers.createOfferHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { name: "AI automation", description: "Automates the revenue motion" },
        }),
      ),
    )) as { offer: { id: string } };
    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            objective: "Generate $80,000 of pipeline from US SaaS companies",
            targetMetric: "pipeline",
            targetValue: 80000,
            currency: "USD",
            timeWindow: { start: "2026-07-01", end: "2026-12-31" },
            market: "B2B SaaS",
            offerId: offer.offer.id,
            icpId: icp.icp.id,
            successMetrics: [{ kind: "pipeline", target: 80000, unit: "USD" }],
          },
        }),
      ),
    )) as { goal: RevenueGoal };
    const plan = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: { revenueGoalId: goal.goal.id },
        }),
      ),
    )) as { plan: { id: string } };
    const account = (await dataOf(
      handlers.createAccountHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA },
          body: {
            name: "Northwind Trading",
            website: "https://northwind.example",
            revenuePlanId: plan.plan.id,
          },
        }),
      ),
    )) as { account: { id: string } };
    return {
      ...context,
      icpId: icp.icp.id,
      goalId: goal.goal.id,
      planId: plan.plan.id,
      accountId: account.account.id,
    };
  }

  /** Record evidence for one account field, exactly as Phase 7 stores it. */
  async function evidenceFor(
    handlers: ReturnType<typeof createHandlers>,
    token: string,
    workspaceId: string,
    accountId: string,
    body: Record<string, unknown>,
  ) {
    return dataOf(
      handlers.recordUserEvidenceHandler(
        request({ token, params: { workspaceId, accountId }, body }),
      ),
    );
  }

  const completeEvidence = (
    handlers: ReturnType<typeof createHandlers>,
    token: string,
    workspaceId: string,
    accountId: string,
  ) =>
    Promise.all([
      evidenceFor(handlers, token, workspaceId, accountId, {
        category: "industry",
        field: "industry",
        value: "B2B SaaS",
        claimKind: "fact",
        sourceName: "company_registry",
        confidence: "high",
        relevance: "high",
      }),
      evidenceFor(handlers, token, workspaceId, accountId, {
        category: "company_overview",
        field: "geography",
        value: "United Kingdom",
        claimKind: "fact",
        sourceName: "company_registry",
        confidence: "high",
        relevance: "high",
      }),
      evidenceFor(handlers, token, workspaceId, accountId, {
        category: "company_overview",
        field: "company_size",
        value: "120 employees",
        claimKind: "fact",
        sourceName: "company_registry",
        confidence: "high",
        relevance: "high",
      }),
      evidenceFor(handlers, token, workspaceId, accountId, {
        category: "business_model",
        field: "model",
        value: "Subscription",
        claimKind: "fact",
        sourceName: "company_registry",
        confidence: "high",
        relevance: "high",
      }),
      evidenceFor(handlers, token, workspaceId, accountId, {
        category: "hiring",
        field: "open_roles",
        value: "Hiring a support operations lead.",
        claimKind: "fact",
        sourceName: "company_registry",
        confidence: "high",
        relevance: "high",
        observedAt: "2026-09-15T00:00:00.000Z",
      }),
      evidenceFor(handlers, token, workspaceId, accountId, {
        category: "technology_signals",
        field: "stack_change",
        value: "Moved its helpdesk to a new vendor.",
        claimKind: "fact",
        sourceName: "company_registry",
        confidence: "high",
        relevance: "high",
        observedAt: "2026-09-15T00:00:00.000Z",
      }),
      evidenceFor(handlers, token, workspaceId, accountId, {
        category: "leadership_changes",
        field: "new_leader",
        value: "Appointed a VP of Revenue in September.",
        claimKind: "fact",
        sourceName: "company_registry",
        confidence: "high",
        relevance: "high",
        observedAt: "2026-09-15T00:00:00.000Z",
      }),
      evidenceFor(handlers, token, workspaceId, accountId, {
        category: "expansion",
        field: "new_region",
        value: "Opened a new region in October.",
        claimKind: "fact",
        sourceName: "company_registry",
        confidence: "high",
        relevance: "high",
        observedAt: "2026-09-15T00:00:00.000Z",
      }),
    ]);

  it("evaluates an account and returns an explainable, evidence-backed score", async () => {
    const { handlers, tokenA, workspaceA, accountId, goalId, icpId } = await qualifyFixture({
      evidenceClock: () => new Date("2026-10-03T12:00:00.000Z"),
    });
    await completeEvidence(handlers, tokenA, workspaceA, accountId);

    const created = (await dataOf(
      handlers.createQualificationHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA, accountId }, body: {} }),
      ),
    )) as { qualification: QualificationRow };

    const qualification = created.qualification;
    expect(qualification.state).toBe("qualified");
    expect(qualification.score).toBe(100);
    expect(qualification.confidence).toBe("high");
    expect(qualification.version).toBe(1);
    expect(qualification.workspaceId).toBe(workspaceA);
    expect(qualification.icpId).toBe(icpId);
    expect(qualification.revenueGoalId).toBe(goalId);
    expect(qualification.ruleVersion).toBe("deterministic-1.0.0");
    expect(qualification.contextDigest).toMatch(/^fnv1a-/);
    expect(qualification.evaluatedAt).toBe("2026-10-03T12:00:00.000Z");
    expect(qualification.dimensions).toHaveLength(5);
    expect(qualification.dimensions.map((dimension) => dimension.dimension)).toEqual([
      "icp_fit",
      "need_fit",
      "buying_signal",
      "timing",
      "company_fit",
    ]);
    // ROADMAP.md §15: every score carries a reason, its evidence and a confidence.
    for (const dimension of qualification.dimensions) {
      expect(dimension.reason.length).toBeGreaterThan(0);
      expect(["pass", "fail", "unknown"]).toContain(dimension.result);
      for (const criterion of dimension.criteria) {
        expect(criterion.reason.length).toBeGreaterThan(0);
        expect(criterion.expectation.length).toBeGreaterThan(0);
        expect(["pass", "fail", "unknown"]).toContain(criterion.result);
      }
    }
    expect(qualification.evidenceIds.length).toBeGreaterThan(0);
    expect(qualification.claimIds.length).toBeGreaterThan(0);
  });

  it("returns insufficient_data, with no score, for an un-researched account", async () => {
    const { handlers, tokenA, workspaceA, accountId } = await qualifyFixture();
    const created = (await dataOf(
      handlers.createQualificationHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA, accountId }, body: {} }),
      ),
    )) as { qualification: QualificationRow };

    expect(created.qualification.state).toBe("insufficient_data");
    expect(created.qualification.score).toBeNull();
    expect(created.qualification.confidence).toBeNull();
    expect(created.qualification.evidenceIds).toEqual([]);
    for (const dimension of created.qualification.dimensions) {
      expect(dimension.result).toBe("unknown");
      expect(dimension.score).toBeNull();
    }
  });

  it("lets a user inspect why an account received a score", async () => {
    const { handlers, tokenA, workspaceA, accountId } = await qualifyFixture({
      evidenceClock: () => new Date("2026-10-03T12:00:00.000Z"),
    });
    await completeEvidence(handlers, tokenA, workspaceA, accountId);
    const created = (await dataOf(
      handlers.createQualificationHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA, accountId }, body: {} }),
      ),
    )) as { qualification: QualificationRow };

    const explained = (await dataOf(
      handlers.getQualificationExplanationHandler(
        request({ token: tokenA, params: { id: created.qualification.id } }),
      ),
    )) as {
      qualification: QualificationRow;
      claims: { id: string; value: string }[];
      evidence: { id: string; sourceName: string; confidence: string }[];
    };

    expect(explained.qualification.id).toBe(created.qualification.id);
    // Every claim and evidence record the decision read comes back with it.
    expect(explained.claims).toHaveLength(created.qualification.claimIds.length);
    expect(explained.evidence).toHaveLength(created.qualification.evidenceIds.length);
    expect(explained.claims.some((claim) => claim.value === "B2B SaaS")).toBe(true);
    expect(explained.evidence.every((record) => record.sourceName === "company_registry")).toBe(
      true,
    );
    // And the criterion that read them points at exactly those records.
    const icpFit = explained.qualification.dimensions.find(
      (dimension) => dimension.dimension === "icp_fit",
    );
    const industry = icpFit?.criteria.find((criterion) => criterion.criterion === "industry_match");
    expect(industry?.evidenceIds[0]).toBeDefined();
    expect(explained.evidence.some((record) => record.id === industry?.evidenceIds[0])).toBe(true);
  });

  it("exposes the criteria before an account is evaluated", async () => {
    const { handlers, tokenA, workspaceA, icpId } = await qualifyFixture();
    const view = (await dataOf(
      handlers.getQualificationCriteriaHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA } }),
      ),
    )) as {
      ruleVersion: string;
      supportedRuleVersions: string[];
      dimensions: {
        dimension: string;
        label: string;
        criteria: { criterion: string; expectation: string }[];
      }[];
    };

    expect(view.ruleVersion).toBe("deterministic-1.0.0");
    expect(view.supportedRuleVersions).toContain("deterministic-1.0.0");
    expect(view.dimensions.map((dimension) => dimension.label)).toEqual([
      "ICP Fit",
      "Need Fit",
      "Buying Signal",
      "Timing",
      "Company Fit",
    ]);
    expect(icpId.length).toBeGreaterThan(0);
    const industry = view.dimensions
      .flatMap((dimension) => dimension.criteria)
      .find((criterion) => criterion.criterion === "industry_match");
    expect(industry?.expectation).toContain("saas");
  });

  it("keeps a historical evaluation readable and adds a new one on re-evaluation", async () => {
    const { handlers, tokenA, workspaceA, accountId } = await qualifyFixture({
      evidenceClock: () => new Date("2026-10-03T12:00:00.000Z"),
    });
    const first = (await dataOf(
      handlers.createQualificationHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA, accountId }, body: {} }),
      ),
    )) as { qualification: QualificationRow };
    expect(first.qualification.state).toBe("insufficient_data");

    await completeEvidence(handlers, tokenA, workspaceA, accountId);
    const second = (await dataOf(
      handlers.createQualificationHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA, accountId }, body: {} }),
      ),
    )) as { qualification: QualificationRow };
    expect(second.qualification.version).toBe(2);
    expect(second.qualification.state).toBe("qualified");

    // The earlier record is untouched.
    const reread = (await dataOf(
      handlers.getQualificationHandler(
        request({ token: tokenA, params: { id: first.qualification.id } }),
      ),
    )) as { qualification: QualificationRow };
    expect(reread.qualification.state).toBe("insufficient_data");
    expect(reread.qualification.version).toBe(1);

    const listed = (await dataOf(
      handlers.listQualificationsHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA }, query: { accountId } }),
      ),
    )) as { qualifications: QualificationRow[] };
    expect(listed.qualifications.map((entry) => entry.version)).toEqual([2, 1]);
  });

  it("never lets a caller supply the score, the state or the criteria", async () => {
    const { handlers, tokenA, workspaceA, accountId } = await qualifyFixture({
      evidenceClock: () => new Date("2026-10-03T12:00:00.000Z"),
    });
    const injected = (await dataOf(
      handlers.createQualificationHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId },
          body: {
            score: 100,
            state: "qualified",
            confidence: "high",
            priority: 10,
            dimensions: [{ dimension: "icp_fit", score: 100, result: "pass" }],
            ruleVersion: "deterministic-1.0.0",
            workspaceId: "some-other-workspace",
            userId: "some-other-user",
          },
        }),
      ),
    )) as { qualification: QualificationRow };

    // Nothing asserted was accepted: with no evidence the result is still the
    // honest one, and it is attributed to the route's workspace.
    expect(injected.qualification.state).toBe("insufficient_data");
    expect(injected.qualification.score).toBeNull();
    expect(injected.qualification.workspaceId).toBe(workspaceA);
    expect(injected.qualification.createdBy).not.toBe("some-other-user");
    expect(
      injected.qualification.dimensions[0]?.criteria.every(
        (criterion) => criterion.result === "unknown",
      ),
    ).toBe(true);
  });

  it("refuses an unsupported rule version", async () => {
    const { handlers, tokenA, workspaceA, accountId } = await qualifyFixture();
    const error = await errorOf(
      handlers.createQualificationHandler(
        request({
          token: tokenA,
          params: { workspaceId: workspaceA, accountId },
          body: { ruleVersion: "llm-ranked-1" },
        }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unknown state filter rather than silently ignoring it", async () => {
    const { handlers, tokenA, workspaceA } = await qualifyFixture();
    const error = await errorOf(
      handlers.listQualificationsHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA }, query: { state: "hot" } }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("enforces workspace authorization on every qualification route", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB, accountId, goalId } =
      await qualifyFixture({
        evidenceClock: () => new Date("2026-10-03T12:00:00.000Z"),
      });
    await completeEvidence(handlers, tokenA, workspaceA, accountId);
    const created = (await dataOf(
      handlers.createQualificationHandler(
        request({ token: tokenA, params: { workspaceId: workspaceA, accountId }, body: {} }),
      ),
    )) as { qualification: QualificationRow };

    const denials = await Promise.all([
      errorOf(
        handlers.createQualificationHandler(
          request({ token: tokenB, params: { workspaceId: workspaceB, accountId }, body: {} }),
        ),
      ),
      errorOf(
        handlers.getQualificationHandler(
          request({ token: tokenB, params: { id: created.qualification.id } }),
        ),
      ),
      errorOf(
        handlers.getQualificationExplanationHandler(
          request({ token: tokenB, params: { id: created.qualification.id } }),
        ),
      ),
      errorOf(
        handlers.listQualificationsHandler(
          request({ token: tokenB, params: { workspaceId: workspaceA } }),
        ),
      ),
      errorOf(
        handlers.getQualificationCriteriaHandler(
          request({ token: tokenB, params: { workspaceId: workspaceA } }),
        ),
      ),
      // A goal from another tenant cannot be borrowed as context.
      errorOf(
        handlers.createQualificationHandler(
          request({
            token: tokenB,
            params: { workspaceId: workspaceB, accountId },
            body: { revenueGoalId: goalId },
          }),
        ),
      ),
    ]);

    for (const denial of denials) {
      expect(["UNAUTHORIZED", "NOT_FOUND", "VALIDATION_ERROR"]).toContain(denial.code);
      expect(JSON.stringify(denial)).not.toContain("Northwind");
      expect(JSON.stringify(denial)).not.toContain("company_registry");
    }

    // And tenant B sees an empty world.
    const listed = (await dataOf(
      handlers.listQualificationsHandler(
        request({ token: tokenB, params: { workspaceId: workspaceB } }),
      ),
    )) as { qualifications: QualificationRow[] };
    expect(listed.qualifications).toEqual([]);
  });

  it("requires an unauthenticated caller to authenticate first", async () => {
    const { handlers, workspaceA, accountId } = await qualifyFixture();
    const error = await errorOf(
      handlers.createQualificationHandler(
        request({ token: "", params: { workspaceId: workspaceA, accountId }, body: {} }),
      ),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("never surfaces a qualification storage failure to the caller", async () => {
    const store = new Store(emptyState());
    const handlers = createHandlers({
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
      planContext: () => readPlanBrain(store, "w1", "u1"),
      plan: new RevenuePlanService(
        store as unknown as PlanRepository,
        deterministicPlanCompiler,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        () => readPlanBrain(store, "w1", "u1"),
      ),
      account: new AccountService(store as unknown as AccountRepository, () => ({
        ok: false,
        error: { code: "UNAVAILABLE" },
      })),
      research: createResearchService(store as never),
      evidence: createEvidenceService(store as never),
      qualification: createQualificationService(
        {
          authorize: () => ({ ok: true as const, value: {} }),
          listQualifications: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as never,
        () => null,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      ),
      personalization: createPersonalizationService(
        {
          authorize: () => ({ ok: true as const, value: {} }),
          listDrafts: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as never,
        { latest: () => null, byId: () => null },
        { byId: () => null, listActive: () => [] },
      ),
      approval: createApprovalService(
        {
          authorize: () => ({ ok: true as const, value: {} }),
          listApprovalRequests: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        } as never,
        { byId: () => null, latestVersion: () => null },
      ),
      outbound: outboundService(store),
      conversation: conversationService(store),
      meeting: meetingService(store),
      nextaction: nextActionService(store),
      revenuegraph: revenueGraphService(store),
      resolveSession: () => ({ userId: "u1" }),
    });

    const error = await errorOf(
      handlers.listQualificationsHandler(request({ token: "t", params: { workspaceId: "w1" } })),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("UNAVAILABLE");
  });
});

describe("API Next Best Action routes", () => {
  /** One account in tenant A, so the routes have something real to read. */
  function nextActionFixture(): {
    handlers: ReturnType<typeof createHandlers>;
    token: string;
    workspaceId: string;
    accountId: string;
  } {
    const built = fixture();
    const account = built.store.createAccount({
      workspaceId: built.workspaceA,
      createdBy: built.userA,
      account: {
        name: "Northwind",
        website: null,
        domain: "northwind.example",
        industry: "SaaS",
        companySize: "50-200",
        geography: "Germany",
        description: null,
        source: "manual",
        sourceReference: null,
        revenuePlanId: null,
        status: "active",
      },
    });
    if (!isOk(account)) throw new Error("fixture account failed");
    return {
      handlers: built.handlers,
      token: built.tokenA,
      workspaceId: built.workspaceA,
      accountId: account.value.id,
    };
  }

  it("answers the next action for an account, with all seven required fields", async () => {
    const f = nextActionFixture();
    const data = (await dataOf(
      f.handlers.recommendNextActionHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: { accountId: f.accountId },
        }),
      ),
    )) as Record<string, unknown>;

    expect(data.action).toBe("research_account");
    expect(data.supportingState).toBe("no_research");
    expect(data.reason).toEqual(expect.any(String));
    expect(data.confidenceReasons).toEqual(expect.any(Array));
    expect(["low", "medium", "high"]).toContain(data.confidence);
    expect(data.expectedOutcome).toBe("research_findings_available");
    expect(data.approvalRequired).toBe(false);
    expect(data.riskLevel).toBe("level_0_read");
    expect(data.ruleVersion).toBe("next-action-1.0.0");
  });

  it("requires authentication on every Phase 14 route", async () => {
    const f = nextActionFixture();
    const anonymous = { ...request({ params: { workspaceId: f.workspaceId } }) };
    delete (anonymous.query as Record<string, unknown>).sessionToken;
    const calls = [
      f.handlers.recommendNextActionHandler({
        ...anonymous,
        body: { accountId: f.accountId },
      }),
      f.handlers.recommendWorkspaceActionsHandler(anonymous),
      f.handlers.recordNextActionHandler({ ...anonymous, body: { accountId: f.accountId } }),
      f.handlers.listNextActionsHandler(anonymous),
      f.handlers.getNextActionHandler(request({ params: { id: "nb-1" } })),
      f.handlers.getNextActionPolicyHandler(anonymous),
    ];
    for (const call of calls) {
      const error = await errorOf(call);
      expect(error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("requires a workspace id on the workspace-scoped routes", async () => {
    const f = nextActionFixture();
    const error = await errorOf(
      f.handlers.recommendNextActionHandler(request({ token: f.token, body: { accountId: "a1" } })),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("maps a domain refusal onto the transport envelope", async () => {
    const f = nextActionFixture();
    const notFound = await errorOf(
      f.handlers.recommendNextActionHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: { accountId: "acct-does-not-exist" },
        }),
      ),
    );
    expect(notFound.code).toBe("NOT_FOUND");

    const invalid = await errorOf(
      f.handlers.recommendNextActionHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: { accountId: 42 },
        }),
      ),
    );
    expect(invalid.code).toBe("VALIDATION_ERROR");
  });

  it("records, lists and reads back a recommendation", async () => {
    const f = nextActionFixture();

    const recorded = (await dataOf(
      f.handlers.recordNextActionHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: { accountId: f.accountId },
        }),
      ),
    )) as { id: string; action: string; createdBy: string };
    expect(recorded.action).toBe("research_account");

    const reread = (await dataOf(
      f.handlers.getNextActionHandler(request({ token: f.token, params: { id: recorded.id } })),
    )) as { id: string };
    expect(reread.id).toBe(recorded.id);

    const listed = (await dataOf(
      f.handlers.listNextActionsHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as { recommendations: { id: string }[] };
    expect(listed.recommendations.map((r) => r.id)).toContain(recorded.id);

    const filtered = (await dataOf(
      f.handlers.listNextActionsHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          query: { action: "research_account" },
        }),
      ),
    )) as { recommendations: { id: string }[] };
    expect(filtered.recommendations).toHaveLength(1);

    const unknownFilter = await errorOf(
      f.handlers.listNextActionsHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          query: { action: "escalate_to_manager" },
        }),
      ),
    );
    expect(unknownFilter.code).toBe("VALIDATION_ERROR");
  });

  it("keeps tenant A's recommendation out of tenant B's reach", async () => {
    const built = fixture();
    const account = built.store.createAccount({
      workspaceId: built.workspaceA,
      createdBy: built.userA,
      account: {
        name: "Northwind",
        website: null,
        domain: "northwind.example",
        industry: "SaaS",
        companySize: "50-200",
        geography: "Germany",
        description: null,
        source: "manual",
        sourceReference: null,
        revenuePlanId: null,
        status: "active",
      },
    });
    if (!isOk(account)) throw new Error("fixture account failed");

    const recorded = (await dataOf(
      built.handlers.recordNextActionHandler(
        request({
          token: built.tokenA,
          params: { workspaceId: built.workspaceA },
          body: { accountId: account.value.id },
        }),
      ),
    )) as { id: string; createdBy: string };
    // The author came from the session, not from the body.
    expect(recorded.createdBy).toBe(built.userA);

    const stolen = await errorOf(
      built.handlers.getNextActionHandler(
        request({ token: built.tokenB, params: { id: recorded.id } }),
      ),
    );
    expect(stolen.code).toBe("NOT_FOUND");

    const crossed = await errorOf(
      built.handlers.recommendNextActionHandler(
        request({
          token: built.tokenB,
          params: { workspaceId: built.workspaceB },
          body: { accountId: account.value.id },
        }),
      ),
    );
    expect(crossed.code).toBe("NOT_FOUND");
  });

  it("publishes the whole rule set through the policy route", async () => {
    const f = nextActionFixture();
    const policy = (await dataOf(
      f.handlers.getNextActionPolicyHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as { states: string[]; actions: string[]; rules: unknown[]; neverDoes: string[] };
    expect(policy.states.length).toBe(policy.rules.length);
    expect(policy.actions.length).toBeGreaterThan(0);
    expect(policy.neverDoes.length).toBeGreaterThan(0);
  });

  it("turns a storage failure into SERVER_ERROR without surfacing the message", async () => {
    const failingStore = new Store(emptyState());
    const broken = {
      authorize: () => ({ ok: true as const }),
      listNextBestActions: () => ({
        ok: false as const,
        error: { code: "UNAVAILABLE", message: "the disk is on fire" },
      }),
    };
    const handlers = createHandlers({
      identity: {
        signup: () => {
          throw new Error("not used");
        },
        authenticate: () => {
          throw new Error("not used");
        },
        listWorkspaces: () => ({ ok: true, value: [] }),
        getWorkspace: () => ({ ok: true, value: undefined }) as never,
        authorize: () => ({ ok: true }) as never,
        updateWorkspace: () => {
          throw new Error("not used");
        },
        getUser: () => ({ ok: true, value: undefined }) as never,
      },
      brain: new BusinessBrainService(failingStore as unknown as BrainRepository),
      goal: new RevenueGoalService(
        failingStore as unknown as GoalRepository,
        deterministicGoalParser,
      ),
      brainContext: () => {
        throw new Error("not used");
      },
      plan: new RevenuePlanService(
        failingStore as unknown as PlanRepository,
        deterministicPlanCompiler,
        () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
        () => {
          throw new Error("not used");
        },
      ),
      planContext: () => {
        throw new Error("not used");
      },
      account: new AccountService(failingStore as unknown as AccountRepository, () => ({
        ok: false,
        error: { code: "UNAVAILABLE" },
      })),
      research: createResearchService(failingStore as never),
      evidence: createEvidenceService(failingStore as never),
      qualification: qualificationService(failingStore),
      personalization: personalizationService(failingStore),
      approval: approvalService(failingStore),
      outbound: outboundService(failingStore),
      conversation: conversationService(failingStore),
      meeting: meetingService(failingStore),
      nextaction: createNextActionService(
        broken as never,
        createAccountStateReader(failingStore as never),
        createAccountIndexReader(failingStore as never),
      ),
      revenuegraph: createRevenueGraphService(
        broken as never,
        createRevenueGraphReader(failingStore as never),
        createRevenueGraphIndexReader(failingStore as never),
      ),
      resolveSession: () => ({ userId: "u1" }),
    });

    const error = await errorOf(
      handlers.listNextActionsHandler(request({ token: "t", params: { workspaceId: "w1" } })),
    );
    expect(error.code).toBe("SERVER_ERROR");
    // `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("disk");

    // The same envelope for the Revenue Graph, whose workspace account index
    // fails the same way: the internal reason never reaches the wire.
    const graphError = await errorOf(
      handlers.getRevenueGraphHandler(request({ token: "t", params: { workspaceId: "w1" } })),
    );
    expect(graphError.code).toBe("SERVER_ERROR");
    expect(graphError.message).toBe("unexpected failure");
    expect(JSON.stringify(graphError)).not.toContain("could not be read");
  });
});

describe("API Revenue Graph routes", () => {
  /** One account in tenant A, so the routes have something real to read. */
  function graphFixture(): {
    handlers: ReturnType<typeof createHandlers>;
    token: string;
    workspaceId: string;
    accountId: string;
    built: ReturnType<typeof fixture>;
  } {
    const built = fixture();
    const account = built.store.createAccount({
      workspaceId: built.workspaceA,
      createdBy: built.userA,
      account: {
        name: "Northwind",
        website: null,
        domain: "northwind.example",
        industry: "SaaS",
        companySize: "50-200",
        geography: "Germany",
        description: null,
        source: "manual",
        sourceReference: null,
        revenuePlanId: null,
        status: "active",
      },
    });
    if (!isOk(account)) throw new Error("fixture account failed");
    return {
      handlers: built.handlers,
      token: built.tokenA,
      workspaceId: built.workspaceA,
      accountId: account.value.id,
      built,
    };
  }

  interface GraphNode {
    id: string;
    kind: string;
    occurredAt: string;
    label: string | null;
    state: string | null;
  }

  interface GraphEdge {
    kind: string;
    from: string;
    to: string;
    occurredAt: string;
    derivedFrom: { kind: string; id: string }[];
  }

  interface GraphTrace {
    ruleVersion: string;
    accountId: string;
    accountName: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    lifecycle: {
      stages: { stage: string; nodeIds: string[] }[];
      frontier: string;
      opportunity: string | null;
    };
  }

  interface WorkspaceGraphData {
    ruleVersion: string;
    accountCount: number;
    nodes: GraphNode[];
    edges: GraphEdge[];
  }

  it("answers the workspace graph, merged from the accounts the caller holds", async () => {
    const f = graphFixture();
    const graph = (await dataOf(
      f.handlers.getRevenueGraphHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as WorkspaceGraphData;
    expect(graph.ruleVersion).toBe("revenue-graph-1.0.0");
    expect(graph.accountCount).toBe(1);
    expect(graph.nodes.map((node) => node.id)).toContain(f.accountId);
    // One node per stored row — nothing beside them.
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
  });

  it("traces one account's lifecycle from stored rows", async () => {
    const f = graphFixture();
    const trace = (await dataOf(
      f.handlers.traceOpportunityHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: { accountId: f.accountId },
        }),
      ),
    )) as GraphTrace;
    expect(trace.ruleVersion).toBe("revenue-graph-1.0.0");
    expect(trace.accountId).toBe(f.accountId);
    expect(trace.accountName).toBe("Northwind");
    expect(trace.nodes).toHaveLength(1);
    expect(trace.lifecycle).toEqual({
      stages: [{ stage: "company", nodeIds: [f.accountId] }],
      frontier: "company",
      opportunity: null,
    });
  });

  it("never lets a client dictate a node, an edge, an opportunity or a frontier", async () => {
    const f = graphFixture();
    const clean = (await dataOf(
      f.handlers.traceOpportunityHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: { accountId: f.accountId },
        }),
      ),
    )) as GraphTrace;
    const forged = (await dataOf(
      f.handlers.traceOpportunityHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: {
            accountId: f.accountId,
            nodes: [{ id: "forged-node", kind: "revenue" }],
            edges: [{ kind: "forged_edge", from: "a", to: "b" }],
            opportunity: "forged-opportunity",
            lifecycle: { frontier: "meeting", stages: [] },
            ruleVersion: "forged-9.9.9",
          },
        }),
      ),
    )) as GraphTrace;
    // The answer is byte-for-byte what the rows produce, never what the body said.
    expect(forged).toEqual(clean);
    expect(JSON.stringify(forged)).not.toContain("forged");
    expect(forged.lifecycle.opportunity).toBeNull();
  });

  it("requires authentication on every Phase 15 route", async () => {
    const f = graphFixture();
    const anonymous = { ...request({ params: { workspaceId: f.workspaceId } }) };
    delete (anonymous.query as Record<string, unknown>).sessionToken;
    const calls = [
      f.handlers.getRevenueGraphHandler(anonymous),
      f.handlers.traceOpportunityHandler({ ...anonymous, body: { accountId: f.accountId } }),
      f.handlers.getRevenueGraphPolicyHandler(anonymous),
    ];
    for (const call of calls) {
      const error = await errorOf(call);
      expect(error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("requires a workspace id on every workspace-scoped route", async () => {
    const f = graphFixture();
    for (const call of [
      f.handlers.getRevenueGraphHandler(request({ token: f.token })),
      f.handlers.traceOpportunityHandler(
        request({ token: f.token, body: { accountId: f.accountId } }),
      ),
      f.handlers.getRevenueGraphPolicyHandler(request({ token: f.token })),
    ]) {
      const error = await errorOf(call);
      expect(error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("maps domain refusals onto the transport envelope", async () => {
    const f = graphFixture();
    const notFound = await errorOf(
      f.handlers.traceOpportunityHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: { accountId: "acct-does-not-exist" },
        }),
      ),
    );
    expect(notFound.code).toBe("NOT_FOUND");

    for (const accountId of [undefined, null, "", 42, {}]) {
      const invalid = await errorOf(
        f.handlers.traceOpportunityHandler(
          request({
            token: f.token,
            params: { workspaceId: f.workspaceId },
            body: { accountId },
          }),
        ),
      );
      expect(invalid.code).toBe("VALIDATION_ERROR");
    }
  });

  it("keeps every graph read inside one tenant", async () => {
    const mine = graphFixture();
    const theirGraph = (await dataOf(
      mine.built.handlers.getRevenueGraphHandler(
        request({ token: mine.built.tokenB, params: { workspaceId: mine.built.workspaceB } }),
      ),
    )) as WorkspaceGraphData;
    // Tenant B's graph never contains tenant A's account.
    expect(theirGraph.accountCount).toBe(0);
    expect(theirGraph.nodes).toEqual([]);

    // Naming tenant A's account from tenant B reads as absent, not forbidden.
    const crossed = await errorOf(
      mine.built.handlers.traceOpportunityHandler(
        request({
          token: mine.built.tokenB,
          params: { workspaceId: mine.built.workspaceB },
          body: { accountId: mine.accountId },
        }),
      ),
    );
    expect(crossed.code).toBe("NOT_FOUND");

    // And calling into a workspace the caller does not hold is refused at the
    // workspace guard before any account is looked up.
    const foreignWorkspace = await errorOf(
      mine.built.handlers.getRevenueGraphHandler(
        request({ token: mine.built.tokenA, params: { workspaceId: mine.built.workspaceB } }),
      ),
    );
    expect(foreignWorkspace.code).toBe("UNAUTHORIZED");
  });

  it("publishes the whole vocabulary, including everything it refuses", async () => {
    const f = graphFixture();
    const policy = (await dataOf(
      f.handlers.getRevenueGraphPolicyHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as {
      ruleVersion: string;
      nodeKinds: string[];
      edgeKinds: string[];
      stages: string[];
      refused: { name: string; reason: string; owningPhase: string | null }[];
      neverDoes: string[];
    };
    expect(policy.ruleVersion).toBe("revenue-graph-1.0.0");
    expect(policy.nodeKinds).toHaveLength(7);
    expect(policy.edgeKinds).toHaveLength(12);
    expect(policy.stages).toHaveLength(7);
    // The seven published kinds plus the five refusals partition ROADMAP.md's
    // twelve core relationship names, so no later-phase vocabulary leaks in.
    const refusedNames = policy.refused.map((entry) => entry.name).sort();
    expect(refusedNames).toEqual(["agent", "campaign", "customer", "revenue", "workflow"]);
    expect([...policy.nodeKinds, ...refusedNames].sort()).toEqual(
      [
        "agent",
        "campaign",
        "company",
        "conversation",
        "customer",
        "evidence",
        "meeting",
        "opportunity",
        "person",
        "revenue",
        "signal",
        "workflow",
      ].sort(),
    );
    for (const entry of policy.refused) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(policy.refused.find((entry) => entry.name === "campaign")?.owningPhase).toBeNull();
    expect(policy.neverDoes.join(" ")).toContain("never write");
    expect(policy.neverDoes.join(" ")).toContain("never act");
  });
});
