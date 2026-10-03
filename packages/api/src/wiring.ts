import { store } from "@dealora/db";
import { authenticate, signup, verifySession } from "@dealora/auth";
import { getSessionIndex, createIndex } from "@dealora/auth";
import { createBusinessBrainService } from "@dealora/brain";
import { createRevenueGoalService } from "@dealora/goal";
import { createRevenuePlanService } from "@dealora/plan";
import type { PlanBrainSnapshot } from "@dealora/plan";
import { createAccountService } from "@dealora/account";
import { AccountRecordProvider, createResearchService } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";

import { createHandlers } from "./handlers.js";
import type { HandlerDeps } from "./handlers.js";
import type { IdentityService, WorkspaceBrainContext } from "./types.js";

/**
 * Default wiring for local/server use.
 *
 * `sessionToken` values are resolved through the auth package's session
 * index. The resulting `userId` is the only identity any handler sees, so
 * client-supplied identity fields cannot influence authorization.
 */
export function createDefaultHandlers(options?: {
  researchProviders?: readonly ResearchProvider[];
}): ReturnType<typeof createHandlers> {
  const identity: IdentityService = {
    signup,
    authenticate,
    listWorkspaces: (userId) => store.getWorkspaces(userId),
    getWorkspace: (id, userId) => store.authorize(id, userId),
    authorize: (workspaceId, userId) => store.authorize(workspaceId, userId),
    updateWorkspace: (id, userId, input) => {
      // Authorize before mutating: ownership is re-checked server-side.
      const auth = store.authorize(id, userId);
      if (!auth.ok) return auth;
      return store.updateWorkspace(id, input);
    },
    getUser: (id) => store.getUser(id),
  };

  const brain = createBusinessBrainService();

  const deps: HandlerDeps = {
    identity,
    brain,
    goal: createRevenueGoalService(),

    /**
     * The plan compiler reads a richer, still-narrow, slice of the same
     * canonical Business Brain: the account profile, personas, positioning and
     * the claim counts the compiler must prove it excluded.
     *
     * Authorization runs first, so a plan can never be compiled against
     * another tenant's context.
     */
    planContext: (workspaceId, userId): PlanBrainSnapshot => {
      const auth = store.authorize(workspaceId, userId);
      if (!auth.ok) {
        throw new Error(`business brain unavailable: ${auth.error.code}`);
      }
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
      const approved = claims.value.filter((c) => c.status === "approved");
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
        approvedClaims: approved.map((c) => ({ id: c.id, text: c.text })),
        // Counts only: the compiler must never quote an unapproved claim.
        withheldClaims: {
          unverified: claims.value.filter((c) => c.status === "unverified").length,
          restricted: claims.value.filter((c) => c.status === "restricted").length,
        },
      };
    },
    plan: createRevenuePlanService(
      store as never,
      undefined,
      (goalId, userId) => store.getRevenueGoal(goalId, userId) as never,
      (workspaceId, userId) => deps.planContext(workspaceId, userId),
    ),
    /**
     * Goal references are validated against this canonical, workspace-scoped
     * context. Reads go through the Business Brain service, which authorizes
     * the caller first — a goal can never reference another tenant's data.
     */
    /**
     * Goal references are validated against this canonical, workspace-scoped
     * context. Authorization runs first, so a goal can never reference
     * another tenant's offer, ICP or persona.
     *
     * The agent-facing BusinessContext deliberately omits record ids, so the
     * reference ids are read from the tenant-scoped store instead.
     */
    brainContext: (workspaceId, userId): WorkspaceBrainContext => {
      const auth = store.authorize(workspaceId, userId);
      if (!auth.ok) {
        throw new Error(`business context unavailable: ${auth.error.code}`);
      }
      const offers = store.listOffers(workspaceId, userId);
      const icp = store.getIcp(workspaceId, userId);
      const personas = store.listPersonas(workspaceId, userId);
      const profile = store.getBusinessProfileFor(workspaceId, userId);
      if (!offers.ok || !icp.ok || !personas.ok || !profile.ok) {
        throw new Error("business context unavailable");
      }
      return {
        workspaceId,
        company: profile.value
          ? {
              name: profile.value.name,
              market: profile.value.market,
              industry: profile.value.industry,
            }
          : null,
        offers: offers.value.map((o) => ({ id: o.id, name: o.name })),
        icp: icp.value ? { id: icp.value.id } : null,
        personas: personas.value.map((p) => ({ id: p.id, title: p.title })),
      };
    },
    /**
     * The Account domain reads one narrow thing from the plan layer: which
     * workspace a plan belongs to. It never compiles, approves or executes a
     * plan, so an account can never make a plan run.
     */
    account: createAccountService(
      store as never,
      (revenuePlanId, userId) => store.getRevenuePlan(revenuePlanId, userId) as never,
    ),
    /**
     * Research runs only through providers this deployment permits.
     *
     * The default set is the workspace's own account record — user-provided
     * data, the one permitted source that needs no external access. No
     * external source is configured and none is simulated: a deployment that
     * has an authorized API or a permitted public source registers it here,
     * with its own terms, rate limits and attribution.
     */
    research: createResearchService(store as never, [
      new AccountRecordProvider(),
      ...(options?.researchProviders ?? []),
    ]),
    resolveSession: (token) => {
      try {
        const verified = verifySession(token, getSessionIndex());
        return { userId: verified.userId };
      } catch {
        return null;
      }
    },
  };

  return createHandlers(deps);
}

export { createIndex };
