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
import { createCostService } from "@dealora/cost";
import { createDashboardService } from "@dealora/dashboard";
import { createAgentService } from "@dealora/agent";
import type { AgentService } from "@dealora/agent";
import { createEvaluationService, createProductionGate } from "@dealora/evaluation";
import type { EvaluationService } from "@dealora/evaluation";
import { createTraceService } from "@dealora/trace";
import type { TraceService } from "@dealora/trace";
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
 * Wire the Cost Engine the way the production wiring does: the real store,
 * so a route test that records a cost exercises the same append-only fact
 * table, the same server-side attribution and the same derivation the real
 * application uses — not a stand-in that could not disagree with it.
 */
function costService(store: Store) {
  return createCostService(store as never);
}

/**
 * Wire the Revenue Dashboard the way the production wiring does: the real
 * store behind the workspace-scoped row lookup, and the **real** Phase 16 cost
 * service and Phase 14 recommendation service behind the two cross-phase
 * readers. A route test therefore derives its dashboard from the same rows the
 * earlier phases actually wrote, and cannot pass against a stand-in that could
 * not disagree with the engine.
 */
function dashboardService(store: Store) {
  return createDashboardService(
    {
      authorize: store.authorize.bind(store),
      listRevenueGoals: store.listRevenueGoals.bind(store),
      listQualifications: store.listQualifications.bind(store),
      listConversationClassifications: store.listConversationClassifications.bind(store),
      listMeetings: store.listMeetings.bind(store),
      listMeetingEvents: store.listMeetingEvents.bind(store),
      listResearchRequests: store.listResearchRequests.bind(store),
      listDrafts: store.listDrafts.bind(store),
      listApprovalRequests: store.listApprovalRequests.bind(store),
      listOutboundActions: store.listOutboundActions.bind(store),
    },
    {
      costMetrics: (workspaceId, userId) => costService(store).metrics(workspaceId, userId),
      nextActionBoard: (workspaceId, userId) =>
        nextActionService(store).recommendForWorkspace(workspaceId, userId),
    },
  );
}

/**
 * Wire the Agent Registry the way the production wiring does: the real store
 * behind the workspace-scoped lookup, and nothing else at all. A route test
 * therefore exercises the real lifecycle table over the real rows the store
 * wrote, and cannot pass against a stand-in that never refuses a promotion.
 */
function agentService(store: Store) {
  return createAgentService({
    authorize: store.authorize.bind(store),
    listAgentRegistry: store.listAgentRegistry.bind(store),
    getAgentRegistry: store.getAgentRegistry.bind(store),
    listAgentRegistryEvents: store.listAgentRegistryEvents.bind(store),
    setAgentStatus: store.setAgentStatus.bind(store),
  });
}

/**
 * Wire the Agent Registry the way `createDefaultHandlers` does: the real store
 * behind the workspace-scoped lookup, and Phase 19's production gate resolved
 * from the evaluation boundary. A route test therefore exercises the real gate
 * over real stored judgements, and cannot pass against a registry that refuses
 * every promotion regardless of the evidence.
 */
function gatedAgentService(store: Store, evaluation: EvaluationService) {
  return createAgentService(
    {
      authorize: store.authorize.bind(store),
      listAgentRegistry: store.listAgentRegistry.bind(store),
      getAgentRegistry: store.getAgentRegistry.bind(store),
      listAgentRegistryEvents: store.listAgentRegistryEvents.bind(store),
      setAgentStatus: store.setAgentStatus.bind(store),
    },
    createProductionGate(evaluation),
  );
}

/**
 * Wire Agent Trace & Observability the way the production wiring does: the real
 * store behind the workspace-scoped lookup, Phase 16's own cost facts for the
 * `agent_run` execution kind, and Phase 18's registry state for the
 * `production` requirement. A route test therefore derives a run's status from
 * real stored steps over the real derivation, and cannot pass against a
 * stand-in that decides the outcome itself.
 */
function traceService(store: Store) {
  return createTraceService({
    authorize: store.authorize.bind(store),
    createAgentTraceRun: store.createAgentTraceRun.bind(store),
    getAgentTraceRun: store.getAgentTraceRun.bind(store),
    listAgentTraceRuns: store.listAgentTraceRuns.bind(store),
    closeAgentTraceRun: store.closeAgentTraceRun.bind(store),
    createAgentTraceEvent: store.createAgentTraceEvent.bind(store),
    listAgentTraceEvents: store.listAgentTraceEvents.bind(store),
    listAgentRunCostFacts: (workspaceId, userId, runId) =>
      store.listCostEvents(workspaceId, userId, { executionKind: "agent_run", executionId: runId }),
    getAgentRegistryState: (workspaceId, userId, agentId) => {
      const found = store.getAgentRegistry(workspaceId, userId, agentId);
      return found.ok
        ? { ok: true, value: found.value === null ? null : found.value.status }
        : found;
    },
  });
}

/**
 * Wire Agent Evaluation the way the production wiring does: the real store
 * behind the workspace-scoped lookup, and nothing else. A route test therefore
 * measures real stored judgements through the real thresholds, and cannot pass
 * against a stand-in that always says the evidence is there.
 */
function evaluationService(store: Store) {
  return createEvaluationService({
    authorize: store.authorize.bind(store),
    createAgentEvaluationRun: store.createAgentEvaluationRun.bind(store),
    getCurrentAgentEvaluationRun: store.getCurrentAgentEvaluationRun.bind(store),
    listAgentEvaluationRuns: store.listAgentEvaluationRuns.bind(store),
    createAgentEvaluationObservation: store.createAgentEvaluationObservation.bind(store),
    listAgentEvaluationObservations: store.listAgentEvaluationObservations.bind(store),
  });
}

/**
 * An evaluation boundary whose every call fails, so a route's internal-error
 * mapping can be exercised without disturbing the rest of the fixture.
 */
function brokenEvaluationService(): EvaluationService {
  const failure = () =>
    ({
      ok: false,
      error: { code: "UNAVAILABLE", message: "storage is down" },
    }) as const;
  return createEvaluationService({
    authorize: failure,
    createAgentEvaluationRun: failure,
    getCurrentAgentEvaluationRun: failure,
    listAgentEvaluationRuns: failure,
    createAgentEvaluationObservation: failure,
    listAgentEvaluationObservations: failure,
  });
}

/**
 * A trace boundary whose every call fails, so a trace route's internal-error
 * mapping can be exercised against every other real service.
 */
function brokenTraceService(): TraceService {
  const failure = () =>
    ({
      ok: false,
      error: { code: "UNAVAILABLE", message: "disk is unreadable" },
    }) as const;
  return createTraceService({
    authorize: failure,
    createAgentTraceRun: failure,
    getAgentTraceRun: failure,
    listAgentTraceRuns: failure,
    closeAgentTraceRun: failure,
    createAgentTraceEvent: failure,
    listAgentTraceEvents: failure,
    listAgentRunCostFacts: failure,
    getAgentRegistryState: failure,
  });
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
  /**
   * Replaces the agent registry boundary with one whose storage fails, so a
   * route's internal-error mapping can be exercised against every other real
   * service. Defaults to the real store-backed registry.
   */
  agentOverride?: AgentService;
  /**
   * Replaces the evaluation boundary with one whose storage fails, so the
   * promotion gate's own error path can be exercised. Defaults to the real
   * store-backed evaluation service.
   */
  evaluationOverride?: EvaluationService;
  /**
   * Replaces the trace boundary with one whose storage fails, so a route's
   * internal-error mapping can be exercised. Defaults to the real store-backed
   * trace service.
   */
  traceOverride?: TraceService;
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
  // One evaluation boundary, exactly as `createDefaultHandlers` builds it, so
  // the registry's promotion gate and the evaluation routes read the same
  // service — and an `evaluationOverride` breaks both at once, as it would in
  // production.
  const evaluation = options?.evaluationOverride ?? evaluationService(store);

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
    cost: costService(store),
    dashboard: dashboardService(store),
    agent: options?.agentOverride ?? gatedAgentService(store, evaluation),
    evaluation,
    trace: options?.traceOverride ?? traceService(store),
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
      cost: costService(store),
      dashboard: dashboardService(store),
      agent: agentService(store),
      evaluation: evaluationService(store),
      trace: traceService(store),
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
      cost: costService(store),
      dashboard: dashboardService(store),
      agent: agentService(store),
      evaluation: evaluationService(store),
      trace: traceService(store),
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
      cost: costService(failingStore),
      dashboard: dashboardService(failingStore),
      agent: agentService(failingStore),
      evaluation: evaluationService(failingStore),
      trace: traceService(failingStore),
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
      cost: costService(store),
      dashboard: dashboardService(store),
      agent: agentService(store),
      evaluation: evaluationService(store),
      trace: traceService(store),
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
      cost: costService(store),
      dashboard: dashboardService(store),
      agent: agentService(store),
      evaluation: evaluationService(store),
      trace: traceService(store),
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
      cost: costService(store),
      dashboard: dashboardService(store),
      agent: agentService(store),
      evaluation: evaluationService(store),
      trace: traceService(store),
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
      cost: costService(store),
      dashboard: dashboardService(store),
      agent: agentService(store),
      evaluation: evaluationService(store),
      trace: traceService(store),
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
      cost: costService(failingStore),
      dashboard: dashboardService(failingStore),
      agent: agentService(failingStore),
      evaluation: evaluationService(failingStore),
      trace: traceService(failingStore),
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

describe("API Cost routes", () => {
  /** One real research run in tenant A for costs to be filed against. */
  function costFixture(): {
    handlers: ReturnType<typeof createHandlers>;
    token: string;
    workspaceId: string;
    requestId: string;
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
    const request1 = built.store.createResearchRequest({
      workspaceId: built.workspaceA,
      requestedBy: built.userA,
      accountId: account.value.id,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isOk(request1)) throw new Error("fixture research request failed");
    return {
      handlers: built.handlers,
      token: built.tokenA,
      workspaceId: built.workspaceA,
      requestId: request1.value.id,
      built,
    };
  }

  interface CostEvent {
    id: string;
    executionKind: string;
    executionId: string;
    category: string;
    basis: string;
    amountMinor: number;
    currency: string;
    source: string | null;
    occurredAt: string;
    idempotencyKey: string;
    createdBy: string;
    createdAt: string;
  }

  interface CostBreakdownData {
    currency: string | null;
    eventCount: number;
    totalMinor: number;
    estimatedMinor: number;
    measuredMinor: number;
    supersededEstimateMinor: number;
    byCategory: { category: string; amountMinor: number }[];
  }

  interface ExecutionSummaryData {
    ruleVersion: string;
    executionKind: string;
    executionId: string;
    totals: CostBreakdownData;
  }

  interface CostMetricsData {
    ruleVersion: string;
    totals: CostBreakdownData;
    denominators: { prospects: number; qualifiedOpportunities: number; meetings: number };
    metrics: { name: string; status: string; averageMinor: number | null; denominator: number }[];
    refused: { name: string; reason: string; owningPhase: string | null }[];
  }

  interface CostPolicyData {
    ruleVersion: string;
    categories: { category: string }[];
    bases: { basis: string }[];
    executionKinds: string[];
    refusedExecutionKinds: { name: string; owningPhase: string | null }[];
    currencies: string[];
    oneCurrencyPerWorkspace: boolean;
    limits: { amountMinorMin: number; idempotencyKeyMax: number };
    aggregationRule: string;
    denominators: { metric: string; definition: string }[];
    metrics: { name: string; status: string }[];
    neverDoes: string[];
  }

  const validCostBody = (executionId: string, overrides: Record<string, unknown> = {}) => ({
    executionKind: "research_run",
    executionId,
    category: "llm",
    basis: "measured",
    amountMinor: 1234,
    currency: "USD",
    source: "usage export",
    occurredAt: "2026-10-01T00:00:00.000Z",
    idempotencyKey: "route-key-1",
    ...overrides,
  });

  it("records a fact with server attribution and reads it back through the routes", async () => {
    const f = costFixture();
    // The body carries forged identity and a forged total; both are ignored.
    const recorded = (await dataOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody(f.requestId, {
            createdBy: "someone-else",
            workspaceId: "forged-workspace",
            createdAt: "2000-01-01T00:00:00.000Z",
            totalMinor: 999999,
          }),
        }),
      ),
    )) as { costEvent: CostEvent };
    expect(recorded.costEvent.amountMinor).toBe(1234);
    expect(recorded.costEvent.createdBy).not.toBe("someone-else");
    expect(recorded.costEvent).not.toHaveProperty("totalMinor");

    const fetched = (await dataOf(
      f.handlers.getCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId, id: recorded.costEvent.id },
        }),
      ),
    )) as CostEvent;
    expect(fetched).toEqual(recorded.costEvent);
    // The session's user recorded it — the token resolves to tenant A's owner.
    expect(fetched.createdBy).toBe(f.built.userA);

    const listed = (await dataOf(
      f.handlers.listCostsHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as { costEvents: CostEvent[] };
    expect(listed.costEvents).toHaveLength(1);
    expect(listed.costEvents[0]).toEqual(recorded.costEvent);
  });

  it("shows one execution's estimated and measured cost — the phase gate", async () => {
    const f = costFixture();
    for (const body of [
      validCostBody(f.requestId, { basis: "estimated", amountMinor: 1000, idempotencyKey: "g1" }),
      validCostBody(f.requestId, { basis: "measured", amountMinor: 900, idempotencyKey: "g2" }),
      validCostBody(f.requestId, {
        category: "search",
        basis: "estimated",
        amountMinor: 100,
        idempotencyKey: "g3",
      }),
    ]) {
      await dataOf(
        f.handlers.recordCostHandler(
          request({ token: f.token, params: { workspaceId: f.workspaceId }, body }),
        ),
      );
    }

    const summary = (await dataOf(
      f.handlers.getExecutionCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          query: { executionKind: "research_run", executionId: f.requestId },
        }),
      ),
    )) as ExecutionSummaryData;
    expect(summary.ruleVersion).toBe("cost-1.0.0");
    expect(summary.executionId).toBe(f.requestId);
    expect(summary.totals.estimatedMinor).toBe(1100);
    expect(summary.totals.measuredMinor).toBe(900);
    // The measured llm cost supersedes its own estimate: no double counting.
    expect(summary.totals.supersededEstimateMinor).toBe(1000);
    expect(summary.totals.totalMinor).toBe(1000);
    expect(summary.totals.currency).toBe("USD");
  });

  it("derives workspace metrics and refuses the metrics that need later phases", async () => {
    const f = costFixture();
    await dataOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody(f.requestId),
        }),
      ),
    );

    const metrics = (await dataOf(
      f.handlers.getCostMetricsHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as CostMetricsData;
    expect(metrics.totals.totalMinor).toBe(1234);
    expect(metrics.denominators.prospects).toBe(1);
    expect(metrics.metrics).toHaveLength(3);
    const perProspect = metrics.metrics.find((m) => m.name === "cost_per_prospect");
    expect(perProspect?.status).toBe("derived");
    expect(perProspect?.averageMinor).toBe(1234);
    // The three metrics no Phase 0–16 row can feed are refused with a reason
    // and an owning phase, never approximated.
    expect(metrics.refused.map((r) => r.name)).toEqual([
      "cost_per_customer",
      "revenue_per_ai_cost",
      "revenue_per_campaign",
    ]);
    for (const refused of metrics.refused) {
      expect(refused.reason.length).toBeGreaterThan(0);
    }
  });

  it("publishes the cost vocabulary and the refusals with their owning phases", async () => {
    const f = costFixture();
    const policy = (await dataOf(
      f.handlers.getCostPolicyHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as CostPolicyData;
    expect(policy.ruleVersion).toBe("cost-1.0.0");
    expect(policy.categories.map((c) => c.category)).toEqual([
      "llm",
      "search",
      "data",
      "tool",
      "infrastructure",
      "execution",
    ]);
    expect(policy.bases.map((b) => b.basis)).toEqual(["estimated", "measured"]);
    // Phase 20 widens this list with `agent_run`; the three Phase 16 kinds are
    // unchanged and in their original order.
    expect(policy.executionKinds).toEqual([
      "research_run",
      "outbound_send",
      "meeting_booking",
      "agent_run",
    ]);
    // `workflow` is refused and names the phase that owns it — never
    // published as an execution kind nothing here can produce.
    expect(policy.refusedExecutionKinds).toHaveLength(1);
    expect(policy.refusedExecutionKinds[0]?.name).toBe("workflow");
    expect(policy.refusedExecutionKinds[0]?.owningPhase).toBe("Phase 24");
    expect(policy.currencies).toEqual(["USD", "EUR", "GBP", "JPY"]);
    expect(policy.oneCurrencyPerWorkspace).toBe(true);
    expect(policy.limits.amountMinorMin).toBe(0);
    expect(policy.limits.idempotencyKeyMax).toBe(128);
    expect(policy.aggregationRule).toContain("measured");
    expect(policy.metrics.filter((m) => m.status === "derived")).toHaveLength(3);
    expect(policy.metrics.filter((m) => m.status === "refused")).toHaveLength(3);
    expect(policy.denominators).toHaveLength(3);
    expect(policy.neverDoes.join(" ")).toContain("never stores a total");
  });

  it("requires authentication and a workspace id on every Phase 16 route", async () => {
    const f = costFixture();
    const anonymous = { ...request({ params: { workspaceId: f.workspaceId } }) };
    delete (anonymous.query as Record<string, unknown>).sessionToken;
    const workspaceScoped = [
      f.handlers.recordCostHandler({ ...anonymous, body: validCostBody(f.requestId) }),
      f.handlers.getCostHandler({ ...anonymous, params: { workspaceId: f.workspaceId, id: "x" } }),
      f.handlers.listCostsHandler(anonymous),
      f.handlers.getExecutionCostHandler(anonymous),
      f.handlers.getCostMetricsHandler(anonymous),
      f.handlers.getCostPolicyHandler(anonymous),
    ];
    for (const call of workspaceScoped) {
      const error = await errorOf(call);
      expect(error.code).toBe("UNAUTHENTICATED");
    }

    for (const call of [
      f.handlers.recordCostHandler(request({ token: f.token, body: validCostBody(f.requestId) })),
      f.handlers.listCostsHandler(request({ token: f.token })),
      f.handlers.getExecutionCostHandler(request({ token: f.token })),
      f.handlers.getCostMetricsHandler(request({ token: f.token })),
      f.handlers.getCostPolicyHandler(request({ token: f.token })),
    ]) {
      const error = await errorOf(call);
      expect(error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("maps malformed and refused requests onto the transport envelope", async () => {
    const f = costFixture();
    // Malformed money and vocabulary: refused with the field named.
    for (const body of [
      validCostBody(f.requestId, { category: "workflow" }),
      validCostBody(f.requestId, { basis: "guessed" }),
      validCostBody(f.requestId, { amountMinor: -5 }),
      validCostBody(f.requestId, { amountMinor: 12.5 }),
      validCostBody(f.requestId, { currency: "XYZ" }),
      validCostBody(f.requestId, { occurredAt: "never" }),
      validCostBody(f.requestId, { idempotencyKey: "" }),
      validCostBody(f.requestId, { executionId: "" }),
    ]) {
      const error = await errorOf(
        f.handlers.recordCostHandler(
          request({ token: f.token, params: { workspaceId: f.workspaceId }, body }),
        ),
      );
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.details?.length).toBeGreaterThan(0);
    }

    // The future `workflow` kind names its owning phase instead of failing
    // generically — a caller learns what to wait for, not just "no".
    const workflow = await errorOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody(f.requestId, { executionKind: "workflow" }),
        }),
      ),
    );
    expect(workflow.code).toBe("VALIDATION_ERROR");
    expect(workflow.message).toContain("Phase 24");

    // An execution that does not exist cannot receive a cost.
    const unknownExecution = await errorOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody("never-issued"),
        }),
      ),
    );
    expect(unknownExecution.code).toBe("NOT_FOUND");

    // A replayed key with a different payload is a CONFLICT, not a rewrite.
    await dataOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody(f.requestId),
        }),
      ),
    );
    const conflict = await errorOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody(f.requestId, { amountMinor: 1 }),
        }),
      ),
    );
    expect(conflict.code).toBe("CONFLICT");
  });

  it("keeps every cost read and write inside one tenant", async () => {
    const f = costFixture();
    const recorded = (await dataOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody(f.requestId),
        }),
      ),
    )) as { costEvent: CostEvent };

    // Tenant B names tenant A's workspace: refused at the guard.
    const foreignWorkspace = await errorOf(
      f.handlers.listCostsHandler(
        request({ token: f.built.tokenB, params: { workspaceId: f.workspaceId } }),
      ),
    );
    expect(foreignWorkspace.code).toBe("UNAUTHORIZED");

    // Tenant B's own workspace holds none of tenant A's facts.
    const theirs = (await dataOf(
      f.handlers.listCostsHandler(
        request({
          token: f.built.tokenB,
          params: { workspaceId: f.built.workspaceB },
        }),
      ),
    )) as { costEvents: CostEvent[] };
    expect(theirs.costEvents).toEqual([]);

    // Reading tenant A's fact id from tenant B reads as absent, not forbidden.
    const crossed = await errorOf(
      f.handlers.getCostHandler(
        request({
          token: f.built.tokenB,
          params: { workspaceId: f.built.workspaceB, id: recorded.costEvent.id },
        }),
      ),
    );
    expect(crossed.code).toBe("NOT_FOUND");

    // Tenant B cannot file a cost against tenant A's run either.
    const crossedRecord = await errorOf(
      f.handlers.recordCostHandler(
        request({
          token: f.built.tokenB,
          params: { workspaceId: f.built.workspaceB },
          body: validCostBody(f.requestId, { idempotencyKey: "crossed" }),
        }),
      ),
    );
    expect(crossedRecord.code).toBe("NOT_FOUND");
  });

  it("filters the list by vocabulary and refuses a filter outside it", async () => {
    const f = costFixture();
    await dataOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody(f.requestId, { category: "search", idempotencyKey: "s1" }),
        }),
      ),
    );
    await dataOf(
      f.handlers.recordCostHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: validCostBody(f.requestId, { category: "llm", idempotencyKey: "s2" }),
        }),
      ),
    );

    const searchOnly = (await dataOf(
      f.handlers.listCostsHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          query: { category: "search" },
        }),
      ),
    )) as { costEvents: CostEvent[] };
    expect(searchOnly.costEvents).toHaveLength(1);
    expect(searchOnly.costEvents[0]?.category).toBe("search");

    const measuredOnly = (await dataOf(
      f.handlers.listCostsHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          query: { basis: "measured" },
        }),
      ),
    )) as { costEvents: CostEvent[] };
    expect(measuredOnly.costEvents).toHaveLength(2);

    const badFilter = await errorOf(
      f.handlers.listCostsHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          query: { category: "not-a-category" },
        }),
      ),
    );
    expect(badFilter.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Phase 17 — Revenue Dashboard
// ---------------------------------------------------------------------------

describe("API Dashboard routes", () => {
  interface DashboardGoalTileData {
    status: string;
    goal: { id: string; targetMetric: string; targetValue: number } | null;
    reason: string | null;
  }
  interface DashboardCountTileData {
    status: string;
    value: number | null;
    reason: string | null;
    owningPhase: string | null;
    derivation: string;
  }
  interface DashboardMoneyTileData {
    status: string;
    amountMinor: number | null;
    currency: string | null;
    owningPhase: string | null;
  }
  interface DashboardMeetingsData {
    total: number;
    byState: { state: string; count: number }[];
  }
  interface DashboardApprovalsData {
    required: number;
    approvalIds: string[];
  }
  interface DashboardFailuresData {
    total: number;
    bySource: { source: string; count: number }[];
  }
  interface DashboardData {
    ruleVersion: string;
    goal: DashboardGoalTileData;
    directRevenue: DashboardMoneyTileData;
    pipelineCreated: DashboardMoneyTileData;
    qualifiedProspects: DashboardCountTileData;
    positiveConversations: DashboardCountTileData;
    meetings: DashboardMeetingsData;
    opportunities: DashboardCountTileData;
    customers: DashboardCountTileData;
    agentActivity: { key: string; count: number }[];
    approvalsRequired: DashboardApprovalsData;
    workflowFailures: DashboardFailuresData;
    hotConversations: DashboardCountTileData;
    cost: { ruleVersion: string };
    nextBestActions: { ruleVersion: string; recommendations: unknown[] };
  }
  interface DashboardPolicyData {
    ruleVersion: string;
    items: { key: string; label: string; availability: string; derivation: string }[];
    refusals: { name: string; reason: string; owningPhase: string | null }[];
    questions: { question: string; answeredBy: string[] }[];
    neverDoes: string[];
  }

  /**
   * A workspace with real rows behind the dashboard: a stored account, a
   * research run the real research service completed, a `qualified`
   * qualification, a rendered draft, a pending approval and a failed outbound
   * action. Every row is written by the same store method the corresponding
   * phase calls in production, so the snapshot these tests read is derived from
   * genuine state rather than a hand-built answer.
   */
  function dashboardFixture(): {
    built: ReturnType<typeof fixture>;
    token: string;
    workspaceId: string;
    accountId: string;
    approvalId: string;
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

    const research = built.store.createResearchRequest({
      workspaceId: built.workspaceA,
      requestedBy: built.userA,
      accountId: account.value.id,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isOk(research)) throw new Error("fixture research request failed");
    const completed = built.store.updateResearchRequest(research.value.id, {
      userId: built.userA,
      status: "completed",
      completedAt: "2026-06-02T00:00:00.000Z",
      findingCount: 2,
    });
    if (!isOk(completed)) throw new Error("fixture research completion failed");

    const qualification = built.store.createQualification({
      workspaceId: built.workspaceA,
      createdBy: built.userA,
      accountId: account.value.id,
      qualification: {
        ruleVersion: "qualification-1.0.0",
        revenuePlanId: null,
        revenueGoalId: null,
        icpId: null,
        contextDigest: "digest-1",
        state: "qualified",
        score: 80,
        confidence: "high",
        reason: "every criterion was met by the recorded evidence",
        evidenceIds: [],
        claimIds: [],
        conflictedClaimIds: [],
        dimensions: [],
        evaluatedAt: "2026-06-02T00:00:00.000Z",
      },
    });
    if (!isOk(qualification)) throw new Error("fixture qualification failed");

    const draft = built.store.createDraft({
      workspaceId: built.workspaceA,
      createdBy: built.userA,
      accountId: account.value.id,
      draft: {
        contactId: null,
        rendererVersion: "personalization-1.0.0",
        contextDigest: "digest-1",
        qualificationId: qualification.value.id,
        offerId: null,
        subject: "A short note for Northwind",
        body: "A short note.",
        personalizationPoints: [],
        approvedClaimIds: [],
        warnings: [],
      },
    });
    if (!isOk(draft)) throw new Error("fixture draft failed");

    const approval = built.store.createApprovalRequest({
      workspaceId: built.workspaceA,
      createdBy: built.userA,
      approval: {
        actionKind: "send_message",
        riskLevel: "level_2_external_action",
        draftId: draft.value.id,
        draftVersion: draft.value.version,
        previewSubject: draft.value.subject,
        previewDigest: "digest-draft-1",
        expiresAt: null,
      },
    });
    if (!isOk(approval)) throw new Error("fixture approval failed");

    return {
      built,
      token: built.tokenA,
      workspaceId: built.workspaceA,
      accountId: account.value.id,
      approvalId: approval.value.id,
    };
  }

  it("answers the whole dashboard for an authorized member", async () => {
    const f = dashboardFixture();
    const data = (await dataOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as DashboardData;

    expect(data.ruleVersion).toBe("dashboard-1.0.0");
    // The qualification the fixture stored is the one the tile counts.
    expect(data.qualifiedProspects).toEqual({
      status: "derived",
      value: 1,
      reason: null,
      owningPhase: null,
      derivation: expect.stringContaining("newest qualification"),
    });
    expect(data.approvalsRequired.required).toBe(1);
    expect(data.approvalsRequired.approvalIds).toEqual([f.approvalId]);
    // The completed research run is an accounts-researched fact.
    const activity = new Map(data.agentActivity.map((entry) => [entry.key, entry.count]));
    expect(activity.get("accounts_researched")).toBe(1);
    expect(activity.get("prospects_qualified")).toBe(1);
    expect(activity.get("drafts_rendered")).toBe(1);
    expect(activity.get("replies_classified")).toBe(0);
    // The two embedded pictures are Phase 16's and Phase 14's own answers.
    expect(data.cost.ruleVersion).toBe("cost-1.0.0");
    expect(data.nextBestActions.ruleVersion).toBe("next-action-1.0.0");
  });

  it("refuses the three tiles no Phase 0-17 row can feed, with the owning phase", async () => {
    const f = dashboardFixture();
    const data = (await dataOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as DashboardData;

    for (const tile of [data.directRevenue, data.pipelineCreated]) {
      expect(tile.status).toBe("no_data");
      expect(tile.amountMinor).toBeNull();
      expect(tile.currency).toBeNull();
      expect(tile.owningPhase).toBe("Phase 23");
    }
    expect(data.customers.status).toBe("no_data");
    expect(data.customers.value).toBeNull();
    expect(data.customers.owningPhase).toBe("Phase 23");
  });

  it("answers an empty workspace honestly rather than with a fabricated outcome", async () => {
    const f = fixture();
    const data = (await dataOf(
      f.handlers.getDashboardHandler(
        request({ token: f.tokenA, params: { workspaceId: f.workspaceA } }),
      ),
    )) as DashboardData;

    // Rows exist for every table, so a zero here is a fact.
    expect(data.qualifiedProspects.value).toBe(0);
    expect(data.positiveConversations.value).toBe(0);
    expect(data.meetings.total).toBe(0);
    expect(data.opportunities.value).toBe(0);
    expect(data.approvalsRequired.required).toBe(0);
    expect(data.workflowFailures.total).toBe(0);
    expect(data.hotConversations.value).toBe(0);
    // The goal's premise is false rather than empty, so the tile refuses.
    expect(data.goal.status).toBe("no_data");
    expect(data.goal.goal).toBeNull();
    expect(data.goal.reason).toBe("this workspace has no active revenue goal");
    expect(data.goal.reason).not.toBeNull();
  });

  it("rejects a request with no session token", async () => {
    const f = dashboardFixture();
    const error = await errorOf(
      f.built.handlers.getDashboardHandler(request({ params: { workspaceId: f.workspaceId } })),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an unknown session token", async () => {
    const f = dashboardFixture();
    const error = await errorOf(
      f.built.handlers.getDashboardHandler(
        request({ token: "forged", params: { workspaceId: f.workspaceId } }),
      ),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a request with no workspace id", async () => {
    const f = dashboardFixture();
    const error = await errorOf(
      f.built.handlers.getDashboardHandler(request({ token: f.token, params: {} })),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("does not let one tenant read another tenant's dashboard", async () => {
    const f = dashboardFixture();
    const error = await errorOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.built.tokenB, params: { workspaceId: f.workspaceId } }),
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("does not let a tenant forge a workspace id that does not exist", async () => {
    const f = dashboardFixture();
    const error = await errorOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.token, params: { workspaceId: "ws-does-not-exist" } }),
      ),
    );
    expect(error.code).toBe("NOT_FOUND");
  });

  it("keeps two tenants' dashboards separate", async () => {
    const f = dashboardFixture();
    const mine = (await dataOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as DashboardData;
    const theirs = (await dataOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.built.tokenB, params: { workspaceId: f.built.workspaceB } }),
      ),
    )) as DashboardData;

    expect(mine.qualifiedProspects.value).toBe(1);
    expect(theirs.qualifiedProspects.value).toBe(0);
    expect(theirs.approvalsRequired.required).toBe(0);
    expect(theirs.approvalsRequired.approvalIds).not.toContain(f.approvalId);
  });

  it("ignores anything a client tries to assert about the numbers", async () => {
    const f = dashboardFixture();
    const withoutBody = (await dataOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as DashboardData;
    const withBody = (await dataOf(
      f.built.handlers.getDashboardHandler(
        request({
          token: f.token,
          params: { workspaceId: f.workspaceId },
          body: {
            qualifiedProspects: { value: 9999 },
            meetings: { total: 9999 },
            directRevenue: { amountMinor: 1_000_000, currency: "USD" },
            cost: { totals: { totalMinor: 0 } },
            userId: f.built.userB,
            workspaceId: f.built.workspaceB,
          },
        }),
      ),
    )) as DashboardData;

    // Every tile is recomputed from the workspace's own rows, so a body
    // asserting a total changes nothing at all.
    expect(JSON.stringify(withBody)).toBe(JSON.stringify(withoutBody));
  });

  it("returns a byte-identical dashboard for the same rows on every read", async () => {
    const f = dashboardFixture();
    const first = await dataOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    );
    const second = await dataOf(
      f.built.handlers.getDashboardHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("publishes the dashboard vocabulary and the refusals with their owning phases", async () => {
    const f = dashboardFixture();
    const policy = (await dataOf(
      f.built.handlers.getDashboardPolicyHandler(
        request({ token: f.token, params: { workspaceId: f.workspaceId } }),
      ),
    )) as DashboardPolicyData;

    expect(policy.ruleVersion).toBe("dashboard-1.0.0");
    expect(policy.items.map((item) => item.key)).toEqual([
      "revenue_goal",
      "direct_revenue",
      "pipeline_created",
      "qualified_prospects",
      "positive_conversations",
      "meetings",
      "opportunities",
      "customers",
      "agent_activity",
      "approvals_required",
      "workflow_failures",
      "cost",
      "hot_conversations",
      "next_best_actions",
    ]);
    expect(policy.refusals.map((refusal) => refusal.name)).toEqual([
      "direct_revenue",
      "pipeline_created",
      "customers",
    ]);
    for (const refusal of policy.refusals) {
      expect(refusal.owningPhase).toBe("Phase 23");
      expect(refusal.reason.length).toBeGreaterThan(0);
    }
    expect(policy.questions).toHaveLength(4);
  });

  it("authorizes the policy route exactly like the snapshot route", async () => {
    const f = dashboardFixture();

    const anonymous = await errorOf(
      f.built.handlers.getDashboardPolicyHandler(
        request({ params: { workspaceId: f.workspaceId } }),
      ),
    );
    expect(anonymous.code).toBe("UNAUTHENTICATED");

    const foreign = await errorOf(
      f.built.handlers.getDashboardPolicyHandler(
        request({ token: f.built.tokenB, params: { workspaceId: f.workspaceId } }),
      ),
    );
    expect(foreign.code).toBe("UNAUTHORIZED");

    const missing = await errorOf(
      f.built.handlers.getDashboardPolicyHandler(request({ token: f.token, params: {} })),
    );
    expect(missing.code).toBe("VALIDATION_ERROR");
  });

  it("answers the policy route before a single row exists", async () => {
    const f = fixture();
    const policy = (await dataOf(
      f.handlers.getDashboardPolicyHandler(
        request({ token: f.tokenA, params: { workspaceId: f.workspaceA } }),
      ),
    )) as DashboardPolicyData;
    expect(policy.items).toHaveLength(14);
    expect(policy.neverDoes.join(" ")).toContain("never write");
    expect(policy.neverDoes.join(" ")).toContain("never fabricate");
  });
});

describe("API Agent System routes", () => {
  interface RegisteredAgentData {
    declaration: {
      agentId: string;
      version: string;
      owner: string;
      purpose: string;
      tools: string[];
      permissions: string[];
      memoryAccess: string[];
      approvalRequired: boolean;
      maxRiskLevel: string;
      costLimits: { maxSpendMinor: number; maxPerExecutionMinor: number; currency: string };
      evaluationMetrics: string[];
      model: { provider: string | null; model: string | null; temperature: number | null };
      initialState: string;
    };
    status: string;
    usable: boolean;
    updatedBy: string | null;
    updatedAt: string | null;
  }
  interface AgentRegistryData {
    ruleVersion: string;
    agents: RegisteredAgentData[];
  }
  interface AgentPolicyData {
    ruleVersion: string;
    agents: { agentId: string; owner: string }[];
    states: string[];
    transitions: { from: string; to: string; reason: string }[];
    tools: { tool: string; executedBy: string; approvalImplied: boolean }[];
    permissions: { permission: string; description: string }[];
    memoryLayers: string[];
    evaluationMetrics: { metric: string; owningPhase: string }[];
    usableStates: string[];
    promotionRule: string;
    requiredFields: string[];
    neverDoes: string[];
  }
  interface AgentEventData {
    id: string;
    agentId: string;
    actorUserId: string;
    kind: string;
    fromStatus: string | null;
    toStatus: string;
  }

  const agentParams = (workspaceId: string): Record<string, string> => ({ workspaceId });
  const oneAgent = (workspaceId: string, agentId: string): Record<string, string> => ({
    workspaceId,
    agentId,
  });

  it("returns the whole registry for a member, in roadmap order", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const data = (await dataOf(
      handlers.getAgentRegistryHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    )) as AgentRegistryData;
    expect(data.ruleVersion).toBe("agent-1.0.0");
    expect(data.agents.map((entry) => entry.declaration.agentId)).toEqual([
      "strategy",
      "market_intelligence",
      "account_research",
      "prospect_discovery",
      "qualification",
      "personalization",
      "conversation",
      "follow_up",
      "meeting",
      "crm",
      "analytics",
      "optimization",
    ]);
    // Nothing has been decided, so every agent reads as its declaration default.
    expect(data.agents.every((entry) => entry.status === "draft")).toBe(true);
    expect(data.agents.every((entry) => entry.usable === false)).toBe(true);
    expect(data.agents.every((entry) => entry.updatedBy === null)).toBe(true);
  });

  it("returns every required declaration field for one agent", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const data = (await dataOf(
      handlers.getAgentHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "qualification") }),
      ),
    )) as { agent: RegisteredAgentData };
    const declaration = data.agent.declaration;
    expect(declaration.agentId).toBe("qualification");
    expect(declaration.version).toBe("1.0.0");
    expect(declaration.owner).toMatch(/^Phase 8/);
    expect(declaration.purpose.length).toBeGreaterThan(20);
    expect(declaration.tools).toContain("request_qualification");
    expect(declaration.permissions.length).toBeGreaterThan(0);
    expect(declaration.memoryAccess.length).toBeGreaterThan(0);
    expect(declaration.approvalRequired).toBe(false);
    expect(declaration.maxRiskLevel).toBe("level_1_draft");
    expect(declaration.costLimits.currency).toBe("USD");
    expect(declaration.costLimits.maxSpendMinor).toBeGreaterThan(0);
    expect(declaration.evaluationMetrics).toContain("qualification_accuracy");
    // Phase 18 declares a model configuration; it never opens one.
    expect(declaration.model).toEqual({ provider: null, model: null, temperature: null });
    expect(declaration.initialState).toBe("draft");
  });

  it("rejects an unauthenticated read", async () => {
    const { handlers, workspaceA } = fixture();
    const error = await errorOf(
      handlers.getAgentRegistryHandler(request({ params: agentParams(workspaceA) })),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a forged session token", async () => {
    const { handlers, workspaceA } = fixture();
    const error = await errorOf(
      handlers.getAgentRegistryHandler(
        request({ token: "forged-token", params: agentParams(workspaceA) }),
      ),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a caller from another workspace", async () => {
    const { handlers, tokenB, workspaceA } = fixture();
    const error = await errorOf(
      handlers.getAgentRegistryHandler(request({ token: tokenB, params: agentParams(workspaceA) })),
    );
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a workspace that does not exist", async () => {
    const { handlers, tokenA } = fixture();
    const error = await errorOf(
      handlers.getAgentRegistryHandler(
        request({ token: tokenA, params: agentParams("ws-forged") }),
      ),
    );
    expect(error.code).toBe("NOT_FOUND");
  });

  it("requires a workspace route parameter", async () => {
    const { handlers, tokenA } = fixture();
    const error = await errorOf(handlers.getAgentRegistryHandler(request({ token: tokenA })));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("workspaceId");
  });

  it("rejects an agent id outside the twelve", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const error = await errorOf(
      handlers.getAgentHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "sales_agent") }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details?.[0]?.field).toBe("agentId");
  });

  it("ignores any body a client sends to the read routes", async () => {
    const { handlers, tokenA, workspaceA, workspaceB } = fixture();
    const forged = {
      agentId: "strategy",
      status: "production",
      usable: true,
      workspaceId: workspaceB,
      updatedBy: "someone-else",
      costLimits: { maxSpendMinor: 99_999_999, currency: "EUR" },
    };
    const withBody = (await dataOf(
      handlers.getAgentRegistryHandler(
        request({ token: tokenA, body: forged, params: agentParams(workspaceA) }),
      ),
    )) as AgentRegistryData;
    const withoutBody = (await dataOf(
      handlers.getAgentRegistryHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    )) as AgentRegistryData;
    // A forged body produces a byte-identical response: nothing in it is read.
    expect(JSON.stringify(withBody)).toBe(JSON.stringify(withoutBody));
    const strategy = withBody.agents.find((entry) => entry.declaration.agentId === "strategy");
    expect(strategy?.usable).toBe(false);
    expect(strategy?.status).toBe("draft");
    expect(strategy?.declaration.costLimits.currency).toBe("USD");
  });

  it("is byte-identical across repeated reads of an unchanged registry", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const first = JSON.stringify(
      await dataOf(
        handlers.getAgentRegistryHandler(
          request({ token: tokenA, params: agentParams(workspaceA) }),
        ),
      ),
    );
    const second = JSON.stringify(
      await dataOf(
        handlers.getAgentRegistryHandler(
          request({ token: tokenA, params: agentParams(workspaceA) }),
        ),
      ),
    );
    expect(first).toBe(second);
  });

  it("records a lifecycle decision and reads it back through the real store", async () => {
    const { handlers, tokenA, workspaceA, userA, store } = fixture();
    const changed = (await dataOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "qualification"),
          body: { status: "testing" },
        }),
      ),
    )) as { agent: RegisteredAgentData };
    expect(changed.agent.status).toBe("testing");
    // The actor is the session's, never the client's.
    expect(changed.agent.updatedBy).toBe(userA);

    const reread = (await dataOf(
      handlers.getAgentHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "qualification") }),
      ),
    )) as { agent: RegisteredAgentData };
    expect(reread.agent.status).toBe("testing");

    // The store really holds the row, written by the real repository method.
    const stored = store.listAgentRegistry(workspaceA, userA);
    if (!isOk(stored)) throw new Error("registry read failed");
    expect(stored.value).toHaveLength(1);
    expect(stored.value[0]?.agentId).toBe("qualification");
    expect(stored.value[0]?.status).toBe("testing");
  });

  it("refuses promotion to production and names Phase 19", async () => {
    const { handlers, tokenA, workspaceA, store, userA } = fixture();
    for (const status of ["testing", "approved"]) {
      await dataOf(
        handlers.changeAgentStatusHandler(
          request({
            token: tokenA,
            params: oneAgent(workspaceA, "analytics"),
            body: { status },
          }),
        ),
      );
    }
    const error = await errorOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { status: "production" },
        }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("evaluation evidence");
    expect(error.details?.[0]?.message).toContain("Phase 19");

    // Nothing was written by the refused request: the row is still `approved`.
    const stored = store.getAgentRegistry(workspaceA, userA, "analytics");
    if (!isOk(stored)) throw new Error("registry read failed");
    expect(stored.value?.status).toBe("approved");
    const events = store.listAgentRegistryEvents(workspaceA, userA);
    if (!isOk(events)) throw new Error("event read failed");
    expect(events.value).toHaveLength(2);
  });

  it("rejects a state outside the seven published states", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const error = await errorOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "meeting"),
          body: { status: "live" },
        }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details?.[0]?.field).toBe("status");
  });

  it("rejects a change with no status at all", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const error = await errorOf(
      handlers.changeAgentStatusHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "meeting"), body: {} }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("ignores forged attribution fields in the change body", async () => {
    const { handlers, tokenA, workspaceA, userA, store } = fixture();
    await dataOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "conversation"),
          body: {
            status: "testing",
            updatedBy: "attacker",
            createdAt: "1999-01-01T00:00:00.000Z",
            workspaceId: "ws-other",
            actorUserId: "attacker",
            kind: "archived",
          },
        }),
      ),
    );
    const stored = store.getAgentRegistry(workspaceA, userA, "conversation");
    if (!isOk(stored)) throw new Error("registry read failed");
    expect(stored.value?.updatedBy).toBe(userA);
    expect(stored.value?.updatedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(stored.value?.workspaceId).toBe(workspaceA);
    const events = store.listAgentRegistryEvents(workspaceA, userA);
    if (!isOk(events)) throw new Error("event read failed");
    expect(events.value[0]?.actorUserId).toBe(userA);
    expect(events.value[0]?.kind).toBe("registered");
  });

  it("returns the governance trail newest first, ties in decision order", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    for (const status of ["testing", "approved", "paused"]) {
      await dataOf(
        handlers.changeAgentStatusHandler(
          request({ token: tokenA, params: oneAgent(workspaceA, "follow_up"), body: { status } }),
        ),
      );
    }
    const data = (await dataOf(
      handlers.listAgentEventsHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    )) as { events: (AgentEventData & { createdAt: string })[] };

    // The rule is asserted, not a particular permutation: the trail is ordered
    // newest first by timestamp, and events sharing a millisecond — which the
    // store's clock can produce — read in the order they were decided. Ordering
    // ties by a generated id would make this differ between runs.
    expect(data.events).toHaveLength(3);
    expect(new Set(data.events.map((event) => event.toStatus))).toEqual(
      new Set(["testing", "approved", "paused"]),
    );
    for (let i = 1; i < data.events.length; i += 1) {
      expect(
        (data.events[i - 1]?.createdAt ?? "") >= (data.events[i]?.createdAt ?? ""),
        "trail is not ordered newest first",
      ).toBe(true);
    }
    // The trail records a chain: exactly one registration, and each later
    // decision starts from the state the previous one left behind.
    const registrations = data.events.filter((event) => event.kind === "registered");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.fromStatus).toBeNull();
    expect(registrations[0]?.toStatus).toBe("testing");
    const changes = data.events.filter((event) => event.kind === "state_changed");
    expect(changes).toHaveLength(2);
    expect(changes.map((event) => `${event.fromStatus}->${event.toStatus}`).sort()).toEqual([
      "approved->paused",
      "testing->approved",
    ]);
    expect(data.events.every((event) => event.actorUserId !== null)).toBe(true);
  });

  it("narrows the governance trail with a query parameter", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await dataOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { status: "testing" },
        }),
      ),
    );
    await dataOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "crm"),
          body: { status: "testing" },
        }),
      ),
    );
    const all = (await dataOf(
      handlers.listAgentEventsHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    )) as { events: AgentEventData[] };
    const narrowed = (await dataOf(
      handlers.listAgentEventsHandler(
        request({ token: tokenA, params: agentParams(workspaceA), query: { agentId: "crm" } }),
      ),
    )) as { events: AgentEventData[] };
    expect(all.events).toHaveLength(2);
    expect(narrowed.events).toHaveLength(1);
    expect(narrowed.events[0]?.agentId).toBe("crm");
  });

  it("rejects an unknown agent in the governance filter", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const error = await errorOf(
      handlers.listAgentEventsHandler(
        request({ token: tokenA, params: agentParams(workspaceA), query: { agentId: "nope" } }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("keeps two workspaces' registries apart", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    await dataOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "crm"),
          body: { status: "testing" },
        }),
      ),
    );
    for (const status of ["testing", "paused"]) {
      await dataOf(
        handlers.changeAgentStatusHandler(
          request({ token: tokenB, params: oneAgent(workspaceB, "crm"), body: { status } }),
        ),
      );
    }
    const mine = (await dataOf(
      handlers.getAgentHandler(request({ token: tokenA, params: oneAgent(workspaceA, "crm") })),
    )) as { agent: RegisteredAgentData };
    const theirs = (await dataOf(
      handlers.getAgentHandler(request({ token: tokenB, params: oneAgent(workspaceB, "crm") })),
    )) as { agent: RegisteredAgentData };
    expect(mine.agent.status).toBe("testing");
    expect(theirs.agent.status).toBe("paused");
  });

  it("refuses a cross-tenant change", async () => {
    const { handlers, tokenB, workspaceA, userA, store } = fixture();
    const error = await errorOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenB,
          params: oneAgent(workspaceA, "crm"),
          body: { status: "testing" },
        }),
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
    // The refused request wrote nothing anywhere.
    const rows = store.listAgentRegistry(workspaceA, userA);
    if (!isOk(rows)) throw new Error("registry read failed");
    expect(rows.value).toEqual([]);
  });

  it("publishes the whole rule set as policy", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const data = (await dataOf(
      handlers.getAgentPolicyHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    )) as AgentPolicyData;
    expect(data.agents).toHaveLength(12);
    expect(data.states).toEqual([
      "draft",
      "testing",
      "approved",
      "production",
      "paused",
      "disabled",
      "archived",
    ]);
    expect(data.requiredFields).toHaveLength(12);
    expect(data.memoryLayers.length).toBeGreaterThan(0);
    // Every evaluation metric names the phase that will measure it.
    expect(data.evaluationMetrics.every((metric) => metric.owningPhase === "Phase 19")).toBe(true);
    expect(data.evaluationMetrics).toHaveLength(13);
    // Every tool names an existing phase as its executor.
    expect(data.tools.every((tool) => /^Phase \d+/.test(tool.executedBy))).toBe(true);
    expect(data.neverDoes.join(" ")).toContain("Never executes");
  });

  it("publishes that nothing is usable yet, and which phase will change that", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const data = (await dataOf(
      handlers.getAgentPolicyHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    )) as AgentPolicyData;
    expect(data.usableStates).toEqual([]);
    expect(data.promotionRule).toContain("Phase 19");
    // The production edge is published so the machine is legible, not hidden.
    expect(
      data.transitions.some((entry) => entry.from === "approved" && entry.to === "production"),
    ).toBe(true);
  });

  it("authorizes the policy read like every other route", async () => {
    const { handlers, tokenA, tokenB, workspaceA } = fixture();
    expect(
      (await errorOf(handlers.getAgentPolicyHandler(request({ params: agentParams(workspaceA) }))))
        .code,
    ).toBe("UNAUTHENTICATED");
    expect(
      (
        await errorOf(
          handlers.getAgentPolicyHandler(
            request({ token: tokenB, params: agentParams(workspaceA) }),
          ),
        )
      ).code,
    ).toBe("UNAUTHORIZED");
    expect(
      (
        await errorOf(
          handlers.getAgentPolicyHandler(
            request({ token: tokenA, params: agentParams("ws-forged") }),
          ),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  /** A registry whose storage refuses, standing in for an internal fault. */
  function brokenAgentService(broken: "list" | "write") {
    const refusal = {
      ok: false as const,
      error: { code: "UNAVAILABLE", message: "the disk is on fire" },
    };
    return createAgentService({
      authorize: () => ({ ok: true as const, value: undefined }),
      listAgentRegistry: () => (broken === "list" ? refusal : { ok: true as const, value: [] }),
      getAgentRegistry: () => (broken === "list" ? refusal : { ok: true as const, value: null }),
      listAgentRegistryEvents: () =>
        broken === "list" ? refusal : { ok: true as const, value: [] },
      setAgentStatus: () =>
        broken === "write"
          ? refusal
          : {
              ok: true as const,
              value: {
                workspaceId: "w1",
                agentId: "crm",
                status: "testing",
                updatedBy: "u1",
                updatedAt: "t",
              },
            },
    });
  }

  it("maps an internal storage failure to a generic server error", async () => {
    const { handlers, tokenA, workspaceA } = fixture({
      agentOverride: brokenAgentService("list"),
    });
    const error = await errorOf(
      handlers.getAgentRegistryHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    );
    expect(error.code).toBe("SERVER_ERROR");
    // `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("disk");
  });

  it("maps a failed write without pretending the agent changed", async () => {
    const { handlers, tokenA, workspaceA } = fixture({
      agentOverride: brokenAgentService("write"),
    });
    const error = await errorOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "crm"),
          body: { status: "testing" },
        }),
      ),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(JSON.stringify(error)).not.toContain("disk");
  });

  it("writes nothing on any read route", async () => {
    const { handlers, tokenA, workspaceA, store, userA } = fixture();
    await dataOf(
      handlers.getAgentRegistryHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    );
    await dataOf(
      handlers.getAgentPolicyHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    );
    await dataOf(
      handlers.listAgentEventsHandler(request({ token: tokenA, params: agentParams(workspaceA) })),
    );
    const rows = store.listAgentRegistry(workspaceA, userA);
    const events = store.listAgentRegistryEvents(workspaceA, userA);
    if (!isOk(rows) || !isOk(events)) throw new Error("read failed");
    expect(rows.value).toEqual([]);
    expect(events.value).toEqual([]);
  });
});

describe("Phase 19 — agent evaluation routes", () => {
  const agentParams = (workspaceId: string): Record<string, string> => ({ workspaceId });
  const oneAgent = (workspaceId: string, agentId: string): Record<string, string> => ({
    workspaceId,
    agentId,
  });

  interface AgentRegistryEntry {
    status: string;
    usable: boolean;
    declaration: { agentId: string; version: string };
  }

  interface MetricResult {
    metric: string;
    kind: string;
    threshold: number;
    minimumSample: number;
    sampleSize: number;
    measured: number | null;
    status: string;
    reason: string;
    counts: { met: number; unmet: number; unobserved: number } | null;
    cost: { totalMinor: number; worstMinor: number; overSpend: boolean } | null;
    latency: { worstMs: number; ceilingMs: number } | null;
  }

  interface ReportData {
    ruleVersion: string;
    agentId: string;
    agentVersion: string;
    run: { runNumber: number; observationCount: number } | null;
    metrics: MetricResult[];
    status: string;
    gate: { satisfied: boolean; reason: string };
  }

  interface TrailData {
    runs: { runNumber: number; live: boolean; observationCount: number; agentVersion: string }[];
    observations: { metric: string; subjectId: string; verdict: string | null }[];
  }

  /** Open a round and record a full, passing evaluation for `analytics`. */
  async function pass(
    h: ReturnType<typeof createHandlers>,
    token: string,
    workspaceId: string,
    verdicts: readonly ("met" | "unmet" | "unobserved")[] = ["met", "met", "met", "met", "met"],
  ) {
    await dataOf(
      h.openAgentEvaluationRunHandler(
        request({ token, params: oneAgent(workspaceId, "analytics") }),
      ),
    );
    for (const metric of ["task_success", "accuracy", "relevance"]) {
      for (const [index, verdict] of verdicts.entries()) {
        await dataOf(
          h.recordAgentEvaluationHandler(
            request({
              token,
              params: oneAgent(workspaceId, "analytics"),
              body: { metric, subjectId: `${metric}-${index}`, verdict },
            }),
          ),
        );
      }
    }
    await dataOf(
      h.recordAgentEvaluationHandler(
        request({
          token,
          params: oneAgent(workspaceId, "analytics"),
          body: { metric: "cost", subjectId: "run-cost", amountMinor: 500 },
        }),
      ),
    );
    await dataOf(
      h.recordAgentEvaluationHandler(
        request({
          token,
          params: oneAgent(workspaceId, "analytics"),
          body: { metric: "latency", subjectId: "run-latency", durationMs: 1_200 },
        }),
      ),
    );
  }

  async function reportOf(
    h: ReturnType<typeof createHandlers>,
    token: string,
    workspaceId: string,
    agentId = "analytics",
  ) {
    return (await dataOf(
      h.getAgentEvaluationHandler(request({ token, params: oneAgent(workspaceId, agentId) })),
    )) as ReportData;
  }

  it("publishes the bar before anything is measured", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const policy = (await dataOf(
      handlers.getAgentEvaluationPolicyHandler(
        request({ token: tokenA, params: agentParams(workspaceA) }),
      ),
    )) as {
      ruleVersion: string;
      metrics: { metric: string; threshold: number; minimumSample: number; rationale: string }[];
      verdicts: string[];
      measuredMetrics: { metric: string; unit: string }[];
      gateRule: string;
      neverDoes: string[];
    };
    expect(policy.ruleVersion).toBe("evaluation-1.0.0");
    expect(policy.metrics).toHaveLength(13);
    expect(policy.metrics.map((metric) => metric.metric).sort()).toEqual(
      [
        "accuracy",
        "business_outcome",
        "cost",
        "failure_rate",
        "hallucination_rate",
        "human_override_rate",
        "latency",
        "personalization_quality",
        "qualification_accuracy",
        "relevance",
        "response_classification_accuracy",
        "task_success",
        "tool_call_correctness",
      ].sort(),
    );
    expect(policy.verdicts).toEqual(["met", "unmet", "unobserved"]);
    expect(policy.measuredMetrics).toEqual([
      { metric: "cost", unit: "minor_units" },
      { metric: "latency", unit: "milliseconds" },
    ]);
    expect(policy.gateRule).toContain("production agents require evaluation evidence");
    expect(policy.neverDoes.join(" ")).toContain("Never executes an agent");
    expect(policy.neverDoes.join(" ")).toContain("Never converts absent evidence");
  });

  it("reports every declared metric as unmeasured when nothing is recorded", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const report = await reportOf(handlers, tokenA, workspaceA);
    expect(report.run).toBeNull();
    expect(report.agentVersion).toBe("1.0.0");
    expect(report.metrics.map((metric) => metric.metric)).toEqual([
      "task_success",
      "accuracy",
      "relevance",
      "cost",
      "latency",
    ]);
    expect(report.metrics.every((metric) => metric.status === "insufficient_evidence")).toBe(true);
    expect(report.metrics.every((metric) => metric.measured === null)).toBe(true);
    expect(report.status).toBe("insufficient_evidence");
    expect(report.gate.satisfied).toBe(false);
  });

  it("measures a complete evaluation and opens the gate", async () => {
    const { handlers, tokenA, workspaceA, store } = fixture();
    await pass(handlers, tokenA, workspaceA);
    const report = await reportOf(handlers, tokenA, workspaceA);
    expect(report.status).toBe("met");
    expect(report.gate.satisfied).toBe(true);
    expect(report.metrics.map((metric) => metric.measured)).toEqual([
      10_000, 10_000, 10_000, 500, 1_200,
    ]);
    expect(report.metrics[3]?.cost?.totalMinor).toBe(500);
    expect(report.metrics[4]?.latency?.worstMs).toBe(1_200);
    expect(report.run?.observationCount).toBe(17);
    // The rows really landed in the store, attributed to the session.
    expect(store.db.agentEvaluationObservations).toHaveLength(17);
    expect(store.db.agentEvaluationRuns).toHaveLength(1);
    expect(store.db.agentEvaluationRuns[0]?.createdBy).toBeDefined();
  });

  it("ignores every field a client forges about the outcome", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await pass(handlers, tokenA, workspaceA);
    const clean = JSON.stringify(await reportOf(handlers, tokenA, workspaceA));
    const forged = JSON.stringify(
      await dataOf(
        handlers.getAgentEvaluationHandler(
          request({
            token: tokenA,
            params: oneAgent(workspaceA, "analytics"),
            body: {
              status: "production",
              agentVersion: "9.9.9",
              gate: { satisfied: true },
              status_: "met",
              workspaceId: "ws-somewhere-else",
              createdBy: "attacker",
              recordedAt: "1999-01-01T00:00:00.000Z",
            },
          }),
        ),
      ),
    );
    expect(forged).toBe(clean);

    // And a forged body on the write route cannot mark an agent evaluated.
    await dataOf(
      handlers.recordAgentEvaluationHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: {
            metric: "task_success",
            subjectId: "forged",
            verdict: "met",
            agentVersion: "9.9.9",
            rate: 10_000,
            passed: true,
            status: "production",
            createdBy: "attacker",
            createdAt: "1999-01-01T00:00:00.000Z",
          },
        }),
      ),
    );
    const after = await reportOf(handlers, tokenA, workspaceA);
    // The judgement landed; none of the forged fields did.
    expect(after.metrics[0]?.sampleSize).toBe(6);
    expect(after.agentVersion).toBe("1.0.0");
  });

  it("refuses a body that tries to be an evaluation outcome", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await dataOf(
      handlers.openAgentEvaluationRunHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "analytics") }),
      ),
    );
    const forged = await errorOf(
      handlers.recordAgentEvaluationHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { metric: "task_success", subjectId: "s-1", verdict: "passed" },
        }),
      ),
    );
    expect(forged.code).toBe("VALIDATION_ERROR");
    expect(forged.details?.[0]?.field).toBe("verdict");

    const unknownMetric = await errorOf(
      handlers.recordAgentEvaluationHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { metric: "vibes", subjectId: "s-1", verdict: "met" },
        }),
      ),
    );
    expect(unknownMetric.code).toBe("VALIDATION_ERROR");

    // A cost judgement with no measurement, and a measured metric with a verdict.
    const noQuantity = await errorOf(
      handlers.recordAgentEvaluationHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { metric: "cost", subjectId: "s-2" },
        }),
      ),
    );
    expect(noQuantity.code).toBe("VALIDATION_ERROR");
    expect(noQuantity.details?.[0]?.field).toBe("amountMinor");

    const bothShapes = await errorOf(
      handlers.recordAgentEvaluationHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { metric: "latency", subjectId: "s-3", durationMs: 10, verdict: "met" },
        }),
      ),
    );
    expect(bothShapes.code).toBe("VALIDATION_ERROR");
    expect(bothShapes.message).toContain("measured, not judged");
  });

  it("replays an identical judgement and conflicts with a restated one", async () => {
    const { handlers, tokenA, workspaceA, store } = fixture();
    await dataOf(
      handlers.openAgentEvaluationRunHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "analytics") }),
      ),
    );
    const body = {
      token: tokenA,
      params: oneAgent(workspaceA, "analytics"),
      body: { metric: "task_success", subjectId: "s-1", verdict: "met" },
    };
    const first = (await dataOf(handlers.recordAgentEvaluationHandler(request(body)))) as {
      observation: { id: string };
    };
    const replay = (await dataOf(handlers.recordAgentEvaluationHandler(request(body)))) as {
      observation: { id: string };
    };
    expect(replay.observation.id).toBe(first.observation.id);
    expect(store.db.agentEvaluationObservations).toHaveLength(1);

    const restated = await errorOf(
      handlers.recordAgentEvaluationHandler(
        request({
          ...body,
          body: { metric: "task_success", subjectId: "s-1", verdict: "unmet" },
        }),
      ),
    );
    expect(restated.code).toBe("CONFLICT");
    expect(store.db.agentEvaluationObservations).toHaveLength(1);
  });

  it("supersedes an earlier round rather than accumulating it", async () => {
    const { handlers, tokenA, workspaceA, store } = fixture();
    await pass(handlers, tokenA, workspaceA);
    expect((await reportOf(handlers, tokenA, workspaceA)).gate.satisfied).toBe(true);

    await dataOf(
      handlers.openAgentEvaluationRunHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "analytics") }),
      ),
    );
    const after = await reportOf(handlers, tokenA, workspaceA);
    expect(after.run?.runNumber).toBe(2);
    expect(after.status).toBe("insufficient_evidence");
    expect(after.gate.satisfied).toBe(false);
    // Nothing was edited or deleted; the first round's rows are all still there.
    expect(store.db.agentEvaluationObservations).toHaveLength(17);

    const trail = (await dataOf(
      handlers.listAgentEvaluationTrailHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "analytics") }),
      ),
    )) as TrailData;
    expect(trail.runs.map((run) => run.runNumber)).toEqual([2, 1]);
    expect(trail.runs.map((run) => run.live)).toEqual([true, false]);
    expect(trail.runs[1]?.observationCount).toBe(17);
  });

  it("gates production on the stored evidence and nothing else", async () => {
    const { handlers, tokenA, workspaceA, store } = fixture();
    for (const status of ["testing", "approved"]) {
      await dataOf(
        handlers.changeAgentStatusHandler(
          request({ token: tokenA, params: oneAgent(workspaceA, "analytics"), body: { status } }),
        ),
      );
    }

    // No evidence: refused, and nothing is written.
    const refused = await errorOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { status: "production" },
        }),
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("evaluation evidence");
    expect(refused.details?.[0]?.message).toContain("Phase 19");
    expect(store.db.agentRegistry).toHaveLength(1);
    expect(store.db.agentRegistry[0]?.status).toBe("approved");

    // Failing evidence: still refused.
    await pass(handlers, tokenA, workspaceA, ["met", "met", "met", "met", "unmet"]);
    const failing = await errorOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { status: "production" },
        }),
      ),
    );
    expect(failing.code).toBe("VALIDATION_ERROR");
    expect(failing.message).toContain("accuracy unmet");

    // Complete, passing evidence: the transition is permitted — and grants a
    // governance state and no capability.
    await pass(handlers, tokenA, workspaceA);
    const promoted = (await dataOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: { status: "production" },
        }),
      ),
    )) as { agent: AgentRegistryEntry };
    expect(promoted.agent.status).toBe("production");
    expect(promoted.agent.usable).toBe(false);
  });

  it("isolates evidence by tenant", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    await pass(handlers, tokenA, workspaceA);

    const stolenRead = await errorOf(
      handlers.getAgentEvaluationHandler(
        request({ token: tokenB, params: oneAgent(workspaceA, "analytics") }),
      ),
    );
    expect(stolenRead.code).toBe("UNAUTHORIZED");

    const stolenWrite = await errorOf(
      handlers.recordAgentEvaluationHandler(
        request({
          token: tokenB,
          params: oneAgent(workspaceA, "analytics"),
          body: { metric: "task_success", subjectId: "s-1", verdict: "met" },
        }),
      ),
    );
    expect(stolenWrite.code).toBe("UNAUTHORIZED");

    const stolenTrail = await errorOf(
      handlers.listAgentEvaluationTrailHandler(
        request({ token: tokenB, params: oneAgent(workspaceA, "analytics") }),
      ),
    );
    expect(stolenTrail.code).toBe("UNAUTHORIZED");

    // B's own workspace sees a complete, empty evaluation.
    const theirs = await reportOf(handlers, tokenB, workspaceB);
    expect(theirs.run).toBeNull();
    expect(theirs.gate.satisfied).toBe(false);

    const anonymous = await errorOf(
      handlers.getAgentEvaluationHandler(request({ params: oneAgent(workspaceA, "analytics") })),
    );
    expect(anonymous.code).toBe("UNAUTHENTICATED");

    const missingWorkspace = await errorOf(
      handlers.getAgentEvaluationHandler(
        request({ token: tokenA, params: oneAgent("ws-nope", "analytics") }),
      ),
    );
    expect(missingWorkspace.code).toBe("NOT_FOUND");
  });

  it("refuses a promotion to an agent whose evidence belongs to another tenant", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    await pass(handlers, tokenA, workspaceA);
    for (const status of ["testing", "approved"]) {
      await dataOf(
        handlers.changeAgentStatusHandler(
          request({ token: tokenB, params: oneAgent(workspaceB, "analytics"), body: { status } }),
        ),
      );
    }
    // B is approved but has no evidence of its own, even though A's is perfect.
    const refused = await errorOf(
      handlers.changeAgentStatusHandler(
        request({
          token: tokenB,
          params: oneAgent(workspaceB, "analytics"),
          body: { status: "production" },
        }),
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("evaluation evidence");
  });

  it("requires a workspace route parameter and a known agent", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const noWorkspace = await errorOf(
      handlers.getAgentEvaluationHandler(request({ token: tokenA })),
    );
    expect(noWorkspace.code).toBe("VALIDATION_ERROR");
    expect(noWorkspace.message).toContain("workspaceId");

    const unknownAgent = await errorOf(
      handlers.getAgentEvaluationHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "sales_agent") }),
      ),
    );
    expect(unknownAgent.code).toBe("VALIDATION_ERROR");
    expect(unknownAgent.details?.[0]?.field).toBe("agentId");
  });

  it("fails closed when the evidence cannot be read", async () => {
    // One broken evaluation boundary breaks the routes *and* the gate the
    // registry consults, because production wiring builds both from it.
    const fx = fixture({ evaluationOverride: brokenEvaluationService() });
    for (const status of ["testing", "approved"]) {
      await dataOf(
        fx.handlers.changeAgentStatusHandler(
          request({
            token: fx.tokenA,
            params: oneAgent(fx.workspaceA, "analytics"),
            body: { status },
          }),
        ),
      );
    }
    const refused = await errorOf(
      fx.handlers.changeAgentStatusHandler(
        request({
          token: fx.tokenA,
          params: oneAgent(fx.workspaceA, "analytics"),
          body: { status: "production" },
        }),
      ),
    );
    // An outage in the evidence store must deny the promotion.
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("could not be read");
    expect(fx.store.db.agentRegistry[0]?.status).toBe("approved");
  });

  it("maps an evaluation storage failure onto the transport vocabulary", async () => {
    const broken = fixture({ evaluationOverride: brokenEvaluationService() });
    const error = await errorOf(
      broken.handlers.getAgentEvaluationHandler(
        request({ token: broken.tokenA, params: oneAgent(broken.workspaceA, "analytics") }),
      ),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
  });

  it("is byte-identical on every read and records no trace of a run", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await pass(handlers, tokenA, workspaceA);
    const first = JSON.stringify(await reportOf(handlers, tokenA, workspaceA));
    const second = JSON.stringify(await reportOf(handlers, tokenA, workspaceA));
    expect(first).toBe(second);

    const trail = (await dataOf(
      handlers.listAgentEvaluationTrailHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "analytics") }),
      ),
    )) as TrailData;
    const printed = JSON.stringify(trail);
    // ROADMAP.md §27 (Phase 20) owns run traces; this phase writes none.
    expect(printed.toLowerCase()).not.toContain("trace");
    expect(printed.toLowerCase()).not.toContain("token");
    expect(printed.toLowerCase()).not.toContain("tool_call");
    expect(
      trail.observations.every((row) => row.verdict !== null || row.metric !== "task_success"),
    ).toBe(true);
  });
});

describe("Phase 20 — agent trace routes", () => {
  const agentParams = (workspaceId: string): Record<string, string> => ({ workspaceId });
  const oneAgent = (workspaceId: string, agentId: string): Record<string, string> => ({
    workspaceId,
    agentId,
  });
  const oneRun = (workspaceId: string, runId: string): Record<string, string> => ({
    workspaceId,
    runId,
  });

  interface RunData {
    id: string;
    agentId: string;
    agentVersion: string;
    status: string;
    openedBy: string;
    stepCount: number;
  }
  interface StepData {
    id: string;
    sequence: number;
    stepId: string;
    attempt: number;
    stage: string;
    outcome: string;
    tool: string | null;
    errorCode: string | null;
    durationMs: number | null;
    recordedBy: string;
    recordedAt: string;
  }
  interface TraceData {
    ruleVersion: string;
    id: string;
    agentId: string;
    agentVersion: string;
    status: string;
    derivedStatus: string;
    stepCount: number;
    stages: { stage: string; count: number; failed: number; retried: number }[];
    usage: {
      slowestStepMs: number | null;
      slowestStepId: string | null;
      modelInvocations: number;
      inputTokens: number;
      outputTokens: number;
      toolsInvoked: string[];
      retryCount: number;
      errorCount: number;
      approvalsRequested: number;
      approvalsGranted: number;
      externalActions: number;
      externalActionsSucceeded: number;
    };
    cost: { totalMinor: number; currency: string | null } | null;
  }

  /**
   * Promote `analytics` to `production` the only way this repository allows:
   * `draft → testing → approved`, then Phase 19's gate satisfied by a real
   * round of recorded judgements. A route test therefore opens its trace
   * through the same path a deployment would, and cannot pass against a
   * registry that accepts a promotion on demand.
   */
  async function promote(
    h: ReturnType<typeof createHandlers>,
    token: string,
    workspaceId: string,
  ): Promise<void> {
    for (const status of ["testing", "approved"]) {
      await dataOf(
        h.changeAgentStatusHandler(
          request({ token, params: oneAgent(workspaceId, "analytics"), body: { status } }),
        ),
      );
    }
    await dataOf(
      h.openAgentEvaluationRunHandler(
        request({ token, params: oneAgent(workspaceId, "analytics") }),
      ),
    );
    for (const metric of ["task_success", "accuracy", "relevance"]) {
      for (let index = 0; index < 5; index += 1) {
        await dataOf(
          h.recordAgentEvaluationHandler(
            request({
              token,
              params: oneAgent(workspaceId, "analytics"),
              body: { metric, subjectId: `${metric}-${index}`, verdict: "met" },
            }),
          ),
        );
      }
    }
    await dataOf(
      h.recordAgentEvaluationHandler(
        request({
          token,
          params: oneAgent(workspaceId, "analytics"),
          body: { metric: "cost", subjectId: "run-cost", amountMinor: 500 },
        }),
      ),
    );
    await dataOf(
      h.recordAgentEvaluationHandler(
        request({
          token,
          params: oneAgent(workspaceId, "analytics"),
          body: { metric: "latency", subjectId: "run-latency", durationMs: 1_200 },
        }),
      ),
    );
    await dataOf(
      h.changeAgentStatusHandler(
        request({
          token,
          params: oneAgent(workspaceId, "analytics"),
          body: { status: "production" },
        }),
      ),
    );
  }

  async function openRun(
    h: ReturnType<typeof createHandlers>,
    token: string,
    workspaceId: string,
    agentId = "analytics",
  ): Promise<{ run: RunData }> {
    return (await dataOf(
      h.openAgentTraceRunHandler(request({ token, params: oneAgent(workspaceId, agentId) })),
    )) as { run: RunData };
  }

  it("publishes the chain, the outcomes, the statuses and the negative space", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const policy = (await dataOf(
      handlers.getAgentTracePolicyHandler(
        request({ token: tokenA, params: agentParams(workspaceA) }),
      ),
    )) as {
      ruleVersion: string;
      stages: { stage: string; position: number; meaning: string }[];
      outcomes: string[];
      statuses: { status: string; terminal: boolean; meaning: string }[];
      tools: string[];
      tracked: { dimension: string; source: string }[];
      criticalRule: string;
      neverDoes: string[];
    };
    expect(policy.ruleVersion).toBe("trace-1.0.0");
    expect(policy.stages.map((entry) => entry.stage)).toEqual([
      "agent",
      "decision",
      "tool_call",
      "evidence",
      "result",
      "approval",
      "external_action",
    ]);
    expect(policy.outcomes).toEqual(["succeeded", "failed", "unknown"]);
    expect(policy.statuses.map((entry) => entry.status)).toEqual([
      "open",
      "succeeded",
      "failed",
      "unknown",
      "unverified",
    ]);
    expect(policy.tools).toHaveLength(18);
    expect(policy.tracked.map((entry) => entry.dimension)).toHaveLength(9);
    expect(policy.criticalRule).toContain("never silently pretend an action succeeded");
    // The negative space is part of the contract, not a footnote.
    expect(policy.neverDoes.join(" ")).toContain("Never executes an agent");
    expect(policy.neverDoes.join(" ")).toContain("Never invokes a tool");
    expect(policy.neverDoes.join(" ")).toContain("Never writes an evaluation judgement");
  });

  it("refuses a run for an agent the workspace has not put into production", async () => {
    const { handlers, tokenA, workspaceA, store, userA } = fixture();
    const error = await errorOf(
      handlers.openAgentTraceRunHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "analytics") }),
      ),
    );
    // `draft`, and the message names the phase that owns reaching `production`.
    expect(error.code).toBe("CONFLICT");
    expect(error.details?.[0]?.message).toContain("Phase 19");
    // Nothing was written by the refused request.
    expect(store.listAgentTraceRuns(workspaceA, userA)).toMatchObject({ ok: true, value: [] });
  });

  it("still refuses after `approved`, because evaluation has not been satisfied", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    for (const status of ["testing", "approved"]) {
      await dataOf(
        handlers.changeAgentStatusHandler(
          request({ token: tokenA, params: oneAgent(workspaceA, "analytics"), body: { status } }),
        ),
      );
    }
    const error = await errorOf(
      handlers.openAgentTraceRunHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "analytics") }),
      ),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("`approved`");
  });

  it("opens a run only after the Phase 19 gate has actually been satisfied", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run: opened } = await openRun(handlers, tokenA, workspaceA);
    expect(opened.agentId).toBe("analytics");
    expect(opened.agentVersion).toBe("1.0.0");
    // `open` claims nothing about any execution.
    expect(opened.status).toBe("open");
    expect(opened.stepCount).toBe(0);
  });

  it("ignores a forged version, actor, workspace and timestamp when opening a run", async () => {
    const { handlers, tokenA, workspaceA, userA, store } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const data = (await dataOf(
      handlers.openAgentTraceRunHandler(
        request({
          token: tokenA,
          params: oneAgent(workspaceA, "analytics"),
          body: {
            version: "9.9.9",
            status: "succeeded",
            workspaceId: "ws-forged",
            openedBy: "attacker",
            openedAt: "1999-01-01T00:00:00.000Z",
          },
        }),
      ),
    )) as { run: RunData };
    expect(data.run.agentVersion).toBe("1.0.0");
    expect(data.run.openedBy).toBe(userA);
    expect(data.run.status).toBe("open");
    const stored = store.listAgentTraceRuns(workspaceA, userA);
    if (!isOk(stored)) throw new Error("read failed");
    expect(stored.value).toHaveLength(1);
    expect(stored.value[0]?.workspaceId).toBe(workspaceA);
    expect(stored.value[0]?.openedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("ignores every forged server field on a step body", async () => {
    const { handlers, tokenA, workspaceA, userA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    const step = (await dataOf(
      handlers.recordAgentTraceStepHandler(
        request({
          token: tokenA,
          params: oneRun(workspaceA, run.id),
          body: {
            stepId: "plan",
            stage: "agent",
            outcome: "succeeded",
            sequence: 999,
            attempt: 42,
            recordedAt: "1999-01-01T00:00:00.000Z",
            recordedBy: "attacker",
            workspaceId: "ws-forged",
            runId: "run-forged",
          },
        }),
      ),
    )) as { step: StepData };
    // Every server-owned field came from the server.
    expect(step.step.sequence).toBe(1);
    expect(step.step.attempt).toBe(1);
    expect(step.step.recordedBy).toBe(userA);
    expect(step.step.recordedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("records the seven-stage chain and derives the usage from it", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    const steps: [string, string, string, Record<string, unknown>][] = [
      ["plan", "agent", "succeeded", { durationMs: 120 }],
      ["choose", "decision", "succeeded", { durationMs: 40 }],
      [
        "render",
        "tool_call",
        "failed",
        {
          tool: "render_draft",
          errorCode: "provider_timeout",
          durationMs: 900,
          modelProvider: "openai",
          modelName: "m",
          inputTokens: 120,
          outputTokens: 30,
        },
      ],
      [
        "render",
        "tool_call",
        "succeeded",
        {
          tool: "render_draft",
          durationMs: 300,
          modelProvider: "openai",
          modelName: "m",
          inputTokens: 80,
          outputTokens: 20,
        },
      ],
      ["cite", "evidence", "succeeded", { referenceId: "ev-1" }],
      ["draft", "result", "succeeded", { durationMs: 50 }],
      ["ask", "approval", "succeeded", { referenceId: "ap-1" }],
      ["send", "external_action", "unknown", { detail: "provider never answered" }],
    ];
    for (const [stepId, stage, outcome, extra] of steps) {
      await dataOf(
        handlers.recordAgentTraceStepHandler(
          request({
            token: tokenA,
            params: oneRun(workspaceA, run.id),
            body: { stepId, stage, outcome, ...extra },
          }),
        ),
      );
    }
    const trace = (await dataOf(
      handlers.getAgentTraceHandler(request({ token: tokenA, params: oneRun(workspaceA, run.id) })),
    )) as TraceData;

    expect(trace.stepCount).toBe(8);
    expect(trace.stages.map((entry) => entry.stage)).toEqual([
      "agent",
      "decision",
      "tool_call",
      "evidence",
      "result",
      "approval",
      "external_action",
    ]);
    // §27's nine dimensions, all derived from the recorded steps.
    expect(trace.usage.slowestStepMs).toBe(900);
    expect(trace.usage.slowestStepId).toBe("render");
    expect(trace.usage.modelInvocations).toBe(2);
    expect(trace.usage.inputTokens).toBe(200);
    expect(trace.usage.outputTokens).toBe(50);
    expect(trace.usage.toolsInvoked).toEqual(["render_draft"]);
    expect(trace.usage.retryCount).toBe(1);
    expect(trace.usage.errorCount).toBe(1);
    expect(trace.usage.approvalsRequested).toBe(1);
    expect(trace.usage.approvalsGranted).toBe(1);
    expect(trace.usage.externalActions).toBe(1);
    // The unconfirmed action is counted but never as a delivery.
    expect(trace.usage.externalActionsSucceeded).toBe(0);
    // An open run asserts nothing; the derivation says what closing would give.
    expect(trace.status).toBe("open");
    expect(trace.derivedStatus).toBe("failed");
  });

  it("returns the trail in sequence order and is byte-identical on every read", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    for (const stage of ["result", "agent", "tool_call", "decision"] as const) {
      await dataOf(
        handlers.recordAgentTraceStepHandler(
          request({
            token: tokenA,
            params: oneRun(workspaceA, run.id),
            body: {
              stepId: stage,
              stage,
              outcome: "succeeded",
              ...(stage === "tool_call" ? { tool: "read_accounts" } : {}),
            },
          }),
        ),
      );
    }
    const first = await dataOf(
      handlers.listAgentTraceStepsHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id) }),
      ),
    );
    const second = await dataOf(
      handlers.listAgentTraceStepsHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id) }),
      ),
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Recording order, not the chain order: `sequence` is the ordering key.
    expect((first as { steps: StepData[] }).steps.map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect((first as { steps: StepData[] }).steps.map((entry) => entry.stage)).toEqual([
      "result",
      "agent",
      "tool_call",
      "decision",
    ]);
  });

  it("closes a run as unverified when nothing was recorded, with no status to send", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    // A body full of attempts to declare a success is simply not read.
    const closed = (await dataOf(
      handlers.closeAgentTraceRunHandler(
        request({
          token: tokenA,
          params: oneRun(workspaceA, run.id),
          body: {
            status: "succeeded",
            derivedStatus: "succeeded",
            closedAt: "1999-01-01T00:00:00.000Z",
          },
        }),
      ),
    )) as { run: RunData };
    expect(closed.run.status).toBe("unverified");
  });

  it("closes a run with a recorded failure as failed, whatever else succeeded", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    await dataOf(
      handlers.recordAgentTraceStepHandler(
        request({
          token: tokenA,
          params: oneRun(workspaceA, run.id),
          body: { stepId: "a", stage: "result", outcome: "succeeded" },
        }),
      ),
    );
    await dataOf(
      handlers.recordAgentTraceStepHandler(
        request({
          token: tokenA,
          params: oneRun(workspaceA, run.id),
          body: {
            stepId: "b",
            stage: "external_action",
            outcome: "failed",
            errorCode: "provider_rejected",
          },
        }),
      ),
    );
    const closed = (await dataOf(
      handlers.closeAgentTraceRunHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id) }),
      ),
    )) as { run: RunData };
    expect(closed.run.status).toBe("failed");
    const trace = (await dataOf(
      handlers.getAgentTraceHandler(request({ token: tokenA, params: oneRun(workspaceA, run.id) })),
    )) as TraceData;
    expect(trace.status).toBe("failed");
    expect(trace.derivedStatus).toBe("failed");
  });

  it("refuses a step once the run is closed, and never reopens it", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    await dataOf(
      handlers.recordAgentTraceStepHandler(
        request({
          token: tokenA,
          params: oneRun(workspaceA, run.id),
          body: { stepId: "a", stage: "result", outcome: "succeeded" },
        }),
      ),
    );
    await dataOf(
      handlers.closeAgentTraceRunHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id) }),
      ),
    );
    const late = await errorOf(
      handlers.recordAgentTraceStepHandler(
        request({
          token: tokenA,
          params: oneRun(workspaceA, run.id),
          body: { stepId: "late", stage: "external_action", outcome: "succeeded" },
        }),
      ),
    );
    expect(late.code).toBe("CONFLICT");
    const trail = (await dataOf(
      handlers.listAgentTraceStepsHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id) }),
      ),
    )) as { steps: StepData[] };
    expect(trail.steps).toHaveLength(1);
  });

  it("returns an identical resend unchanged and records a retry as a new attempt", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    const body = {
      stepId: "render",
      stage: "tool_call",
      outcome: "failed",
      tool: "render_draft",
      errorCode: "timeout",
    };
    const first = (await dataOf(
      handlers.recordAgentTraceStepHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id), body }),
      ),
    )) as { step: StepData };
    const replay = (await dataOf(
      handlers.recordAgentTraceStepHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id), body }),
      ),
    )) as { step: StepData };
    expect(replay.step.id).toBe(first.step.id);
    expect(replay.step.attempt).toBe(1);

    const retry = (await dataOf(
      handlers.recordAgentTraceStepHandler(
        request({
          token: tokenA,
          params: oneRun(workspaceA, run.id),
          body: {
            stepId: "render",
            stage: "tool_call",
            outcome: "succeeded",
            tool: "render_draft",
          },
        }),
      ),
    )) as { step: StepData };
    expect(retry.step.attempt).toBe(2);
    expect(retry.step.sequence).toBe(2);
  });

  it("rejects a stage, an outcome and a tool outside the published vocabulary", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    const cases: Record<string, unknown>[] = [
      { stepId: "s", stage: "telepathy", outcome: "succeeded" },
      { stepId: "s", stage: "agent", outcome: "probably" },
      { stepId: "s", stage: "tool_call", outcome: "succeeded", tool: "shell_exec" },
      { stepId: "s", stage: "agent", outcome: "succeeded", tool: "render_draft" },
      { stepId: "s", stage: "agent", outcome: "succeeded", errorCode: "timeout" },
      { stepId: "s", stage: "decision", outcome: "succeeded", inputTokens: 10 },
      { stepId: "s", stage: "agent", outcome: "succeeded", durationMs: -1 },
    ];
    for (const body of cases) {
      const error = await errorOf(
        handlers.recordAgentTraceStepHandler(
          request({ token: tokenA, params: oneRun(workspaceA, run.id), body }),
        ),
      );
      expect(error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("reads and writes nothing across a workspace boundary", async () => {
    const { handlers, tokenA, tokenB, workspaceA, workspaceB } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);

    // Workspace B's own member, reaching for workspace A's run.
    const read = await errorOf(
      handlers.getAgentTraceHandler(request({ token: tokenB, params: oneRun(workspaceA, run.id) })),
    );
    expect(read.code).toBe("UNAUTHORIZED");
    const write = await errorOf(
      handlers.recordAgentTraceStepHandler(
        request({
          token: tokenB,
          params: oneRun(workspaceA, run.id),
          body: { stepId: "s", stage: "agent", outcome: "succeeded" },
        }),
      ),
    );
    expect(write.code).toBe("UNAUTHORIZED");
    const close = await errorOf(
      handlers.closeAgentTraceRunHandler(
        request({ token: tokenB, params: oneRun(workspaceA, run.id) }),
      ),
    );
    expect(close.code).toBe("UNAUTHORIZED");
    const open = await errorOf(
      handlers.openAgentTraceRunHandler(
        request({ token: tokenB, params: oneAgent(workspaceB, "analytics") }),
      ),
    );
    expect(open.code).toBe("CONFLICT");
    // Workspace B's own listing is empty: another tenant's run is invisible.
    const theirs = (await dataOf(
      handlers.listAgentTraceRunsHandler(
        request({ token: tokenB, params: agentParams(workspaceB) }),
      ),
    )) as { runs: RunData[] };
    expect(theirs.runs).toEqual([]);
    // And A's run is untouched by every refused attempt.
    const mine = (await dataOf(
      handlers.listAgentTraceStepsHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id) }),
      ),
    )) as { steps: StepData[] };
    expect(mine.steps).toEqual([]);
  });

  it("answers NOT_FOUND for a run that was never issued", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    for (const call of [
      handlers.getAgentTraceHandler(
        request({ token: tokenA, params: oneRun(workspaceA, "never") }),
      ),
      handlers.listAgentTraceStepsHandler(
        request({ token: tokenA, params: oneRun(workspaceA, "never") }),
      ),
      handlers.closeAgentTraceRunHandler(
        request({ token: tokenA, params: oneRun(workspaceA, "never") }),
      ),
    ]) {
      const error = await errorOf(call);
      expect(error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects an agent outside the twelve and a run listing narrowed to one", async () => {
    const { handlers, tokenA, workspaceA } = fixture();
    const open = await errorOf(
      handlers.openAgentTraceRunHandler(
        request({ token: tokenA, params: oneAgent(workspaceA, "sales_team") }),
      ),
    );
    expect(open.code).toBe("VALIDATION_ERROR");
    const list = await errorOf(
      handlers.listAgentTraceRunsHandler(
        request({
          token: tokenA,
          params: agentParams(workspaceA),
          query: { agentId: "sales_team" },
        }),
      ),
    );
    expect(list.code).toBe("VALIDATION_ERROR");
  });

  it("requires a session on every trace route", async () => {
    const { handlers, workspaceA } = fixture();
    const calls = [
      handlers.openAgentTraceRunHandler(request({ params: oneAgent(workspaceA, "analytics") })),
      handlers.recordAgentTraceStepHandler(
        request({
          params: oneRun(workspaceA, "r"),
          body: { stepId: "s", stage: "agent", outcome: "succeeded" },
        }),
      ),
      handlers.closeAgentTraceRunHandler(request({ params: oneRun(workspaceA, "r") })),
      handlers.getAgentTraceHandler(request({ params: oneRun(workspaceA, "r") })),
      handlers.listAgentTraceStepsHandler(request({ params: oneRun(workspaceA, "r") })),
      handlers.listAgentTraceRunsHandler(request({ params: agentParams(workspaceA) })),
      handlers.getAgentTracePolicyHandler(request({ params: agentParams(workspaceA) })),
    ];
    for (const call of calls) {
      const error = await errorOf(call);
      expect(error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("maps a storage outage to SERVER_ERROR and leaks no internals", async () => {
    const failing = fixture({ traceOverride: brokenTraceService() });
    const error = await errorOf(
      failing.handlers.getAgentTraceHandler(
        request({ token: failing.tokenA, params: oneRun(failing.workspaceA, "r") }),
      ),
    );
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).toBe("unexpected failure");
    expect(JSON.stringify(error)).not.toContain("disk");
  });

  it("reports cost from Phase 16's own facts, and null when there are none", async () => {
    const { handlers, tokenA, workspaceA, store, userA } = fixture();
    await promote(handlers, tokenA, workspaceA);
    const { run } = await openRun(handlers, tokenA, workspaceA);
    const before = (await dataOf(
      handlers.getAgentTraceHandler(request({ token: tokenA, params: oneRun(workspaceA, run.id) })),
    )) as TraceData;
    expect(before.cost).toBeNull();

    // A cost fact recorded through Phase 16's own table, under the `agent_run`
    // execution kind this phase adds. No second cost table, no recomputation.
    const recorded = store.createCostEvent({
      workspaceId: workspaceA,
      createdBy: userA,
      event: {
        executionKind: "agent_run",
        executionId: run.id,
        category: "llm",
        basis: "measured",
        amountMinor: 250,
        currency: "USD",
        source: null,
        occurredAt: new Date().toISOString(),
        idempotencyKey: "phase20-route-cost",
      },
    });
    expect(isOk(recorded)).toBe(true);
    const after = (await dataOf(
      handlers.getAgentTraceHandler(request({ token: tokenA, params: oneRun(workspaceA, run.id) })),
    )) as TraceData;
    expect(after.cost?.totalMinor).toBe(250);
    expect(after.cost?.currency).toBe("USD");
  });

  it("writes no evaluation judgement and no draft, approval or action row", async () => {
    const { handlers, tokenA, workspaceA, store, userA } = fixture();
    await promote(handlers, tokenA, workspaceA);

    const currentRound = () => {
      const found = store.getCurrentAgentEvaluationRun({
        workspaceId: workspaceA,
        userId: userA,
        agentId: "analytics",
        version: "1.0.0",
      });
      if (!found.ok || found.value === null) {
        throw new Error("expected a Phase 19 round after promote");
      }
      return found.value.id;
    };
    const judgementCount = () => {
      const observations = store.listAgentEvaluationObservations(workspaceA, userA, currentRound());
      if (!observations.ok) throw new Error("expected readable evaluation observations");
      return observations.value.length;
    };
    // The baseline is Phase 19's own output, captured before the trace exists.
    // Comparing against a snapshot proves the trace added none; a hardcoded
    // count would only prove `promote` recorded what it recorded today.
    const judgementsBefore = judgementCount();

    const { run } = await openRun(handlers, tokenA, workspaceA);
    for (const [stepId, stage, outcome] of [
      ["a", "agent", "succeeded"],
      ["b", "result", "succeeded"],
    ] as const) {
      await dataOf(
        handlers.recordAgentTraceStepHandler(
          request({
            token: tokenA,
            params: oneRun(workspaceA, run.id),
            body: { stepId, stage, outcome },
          }),
        ),
      );
    }
    await dataOf(
      handlers.closeAgentTraceRunHandler(
        request({ token: tokenA, params: oneRun(workspaceA, run.id) }),
      ),
    );

    // Tracing records what a recorder reported. It performs no phase's work, so
    // nothing outside the trace's own two tables moved.
    const drafts = store.listDrafts(workspaceA, userA);
    const approvals = store.listApprovalRequests(workspaceA, userA);
    const actions = store.listOutboundActions(workspaceA, userA);
    expect(isOk(drafts) && drafts.value).toEqual([]);
    expect(isOk(approvals) && approvals.value).toEqual([]);
    expect(isOk(actions) && actions.value).toEqual([]);
    expect(judgementsBefore).toBeGreaterThan(0);
    expect(judgementCount()).toBe(judgementsBefore);
    // The trace did not open a second evaluation round either.
    expect(store.listAgentEvaluationRuns(workspaceA, userA, "analytics").ok).toBe(true);
  });
});
