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
    /**
     * Evidence is the only writer that promotes a research observation into a
     * source-backed record. It reads the finding from storage rather than
     * trusting a caller's account id, and it makes no qualification decision:
     * scoring, ranking and outreach are Phases 8-11.
     */
    evidence: createEvidenceService(store as never),
    /**
     * Qualification reads three narrow things from the rest of the system: the
     * canonical ICP's target terms, the time window of a Revenue Goal, and the
     * provenance of the plan an account was sourced against.
     *
     * Each read is authorized before it is used, so an evaluation can never be
     * measured against another tenant's target, and the engine never sees a
     * whole Business Brain or a whole plan.
     */
    qualification: createQualificationService(
      store as never,
      (workspaceId, userId) => {
        const auth = store.authorize(workspaceId, userId);
        if (!auth.ok) {
          throw new Error(`business brain unavailable: ${auth.error.code}`);
        }
        const icp = store.getIcp(workspaceId, userId);
        if (!icp.ok) throw new Error(`icp unavailable: ${icp.error.code}`);
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
    ),
    /**
     * Personalization reads two narrow things from the rest of the system: the
     * qualification a draft may be generated for, and the active offer whose own
     * words it may quote.
     *
     * Each read is authorized before it is used, and both return `null` for a
     * record that does not exist or belongs to another workspace, so a draft can
     * never be rendered against another tenant's qualification or offer — and
     * a foreign one is never revealed to exist. The engine never sees a whole
     * Business Brain, a whole offer or a whole qualification record.
     */
    personalization: createPersonalizationService(
      store as never,
      {
        latest: (workspaceId, userId, accountId) => {
          const auth = store.authorize(workspaceId, userId);
          if (!auth.ok) return null;
          const listed = store.listQualifications(workspaceId, userId, { accountId });
          if (!listed.ok) return null;
          // Newest first, as the store orders them: the evaluation a draft
          // would be generated against by default.
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
    ),
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
