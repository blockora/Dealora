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
import { createApprovalService, toApprovalDraftSnapshot } from "@dealora/approval";
import {
  ProviderRegistry,
  SandboxEmailProvider,
  createApprovalVerifier,
  createContactReader,
  createDraftReader,
  createOutboundService,
} from "@dealora/outbound";
import type { OutboundProvider } from "@dealora/outbound";
import {
  createConversationService,
  createOutboundReader,
  createSuppressionWriter,
} from "@dealora/conversation";
import {
  SandboxCalendarProvider,
  createClassificationReader,
  createContactReader as createMeetingContactReader,
  createMeetingService,
  createQualificationReader,
  createSuppressionReader,
} from "@dealora/meeting";
import type { MeetingCalendarProvider } from "@dealora/meeting";
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
import type { DashboardLookup, DashboardReaders } from "@dealora/dashboard";
import { createAgentService } from "@dealora/agent";
import type { AgentRegistryLookup } from "@dealora/agent";

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
  /**
   * The providers this deployment has configured for the outbound channel.
   *
   * Nothing is registered by default beyond the **sandbox** provider, which
   * performs no network I/O at all and records what it accepted. That is
   * deliberate: no outbound credential is configured in this repository, and a
   * provider that pretended to deliver would make the phase's central claim
   * unverifiable. A deployment supplies its own provider here; the send boundary
   * does not change.
   */
  outboundProviders?: readonly OutboundProvider[];
  /**
   * The calendar adapters the meeting boundary may book through.
   *
   * Defaults to a single sandbox that performs no network I/O. Supplying a real
   * adapter is an explicit deployment decision whose keys must be documented in
   * the same commit that introduces them — ROADMAP.md §30 puts live calendar
   * integrations in Phase 23.
   */
  calendarProviders?: readonly MeetingCalendarProvider[];
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

  /**
   * The recommendation boundary reads the account's whole revenue position and
   * nothing else.
   *
   * The reader resolves the account through storage with the caller's own
   * identity and returns nothing for an account that does not exist or belongs
   * to another workspace, so the engine has no way to probe for a foreign id.
   * It is given **no** sender, approver, calendar or scheduler: the strongest
   * thing it can do is produce a sentence, which is the whole point.
   */
  const nextaction = createNextActionService(
    store as never,
    createAccountStateReader(store as never),
    createAccountIndexReader(store as never),
  );

  /**
   * The cost boundary: it appends one immutable fact per request for a run
   * that exists in this workspace, and derives every total and metric on
   * read. Attribution is the session's (`createdBy`) and the server's clock
   * (`createdAt`) inside storage — the request body contributes the fact's
   * own fields and nothing else, so a client cannot name who recorded a
   * cost, when, or what the total should be.
   */
  const cost = createCostService(store as never);

  /**
   * The dashboard's row lookup: every method is the store's own workspace-
   * scoped list, passed through unchanged. The tenant check lives inside the
   * store, and each method re-runs it with the caller's own identity, so this
   * wiring cannot widen a scope — it only names which lists exist.
   */
  const dashboardLookup: DashboardLookup = {
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
  };

  /**
   * The two answers this phase does not own. Cost is Phase 16's own picture
   * and next steps are Phase 14's own board, both read through the services'
   * public methods, so the dashboard can never disagree with either about
   * what a cost or a next step is.
   */
  const dashboardReaders: DashboardReaders = {
    costMetrics: (workspaceId, userId) => cost.metrics(workspaceId, userId),
    nextActionBoard: (workspaceId, userId) => nextaction.recommendForWorkspace(workspaceId, userId),
  };

  /**
   * The agent registry's lookup: every method is the store's own workspace-
   * scoped read and write, passed through unchanged. The tenant check lives
   * inside the store and each method re-runs it with the caller's own
   * identity, so this wiring cannot widen a scope — it only names which
   * registry methods exist.
   *
   * There is deliberately nothing else to wire: an agent registry has no
   * runner, no dispatcher, no model client and no outbound sender. Phase 18
   * declares agents and records what people decided about them, so a wider
   * surface here would be a capability nobody authorised.
   */
  const agentLookup: AgentRegistryLookup = {
    authorize: store.authorize.bind(store),
    listAgentRegistry: store.listAgentRegistry.bind(store),
    getAgentRegistry: store.getAgentRegistry.bind(store),
    listAgentRegistryEvents: store.listAgentRegistryEvents.bind(store),
    setAgentStatus: store.setAgentStatus.bind(store),
  };

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
    /**
     * Approval reads exactly one thing from the rest of the system: the subject,
     * body, warnings and version of a draft, so a reviewer is shown the precise
     * text the decision will cover.
     *
     * Each read is authorized before it is used and returns `null` for a record
     * that does not exist or belongs to another workspace, so a foreign draft is
     * never revealed to exist. The boundary never sees the evidence behind a
     * draft, never re-renders anything, and never touches a provider.
     */
    approval: createApprovalService(store as never, {
      byId: (draftId, userId) => {
        const found = store.getDraft(draftId, userId);
        return found.ok ? toApprovalDraftSnapshot(found.value) : null;
      },
      latestVersion: (draftId, userId) => {
        const found = store.getDraft(draftId, userId);
        return found.ok ? toApprovalDraftSnapshot(found.value) : null;
      },
    }),
    /**
     * The send boundary reads three things and no more: a draft's identity,
     * version, addresses and digest; a contact's identity, address and status;
     * and an approval's status, reviewer and version.
     *
     * The approval verifier reads the **persisted rows** rather than asking the
     * Approval service, so "is this approved?" is re-derived from storage on
     * every send instead of being confirmed by the component that wrote the
     * approval.
     */
    outbound: createOutboundService(
      store as never,
      createApprovalVerifier(store as never),
      createDraftReader(store as never),
      createContactReader(store as never),
      providerRegistry(options?.outboundProviders),
    ),
    /**
     * The response boundary reads two things and no more: whether an outbound
     * action actually went out, and the address it went to. It writes to the
     * **same** Phase 11 suppression list the send path already checks, so an
     * opt-out recorded here is honoured by the existing send logic with no new
     * mechanism and nothing to keep in sync.
     */
    conversation: createConversationService(
      store as never,
      createOutboundReader(store as never),
      createSuppressionWriter(store as never),
    ),
    /**
     * The meeting boundary reads four things and reaches one external system:
     * whether a response read as positive, whether the account qualified, who the
     * contact is, and whether the address is suppressed. It reuses the Phase 11
     * opt-out list rather than keeping a second one, so an unsubscribe stops a
     * booking as reliably as it stops a send.
     *
     * The calendar adapter defaults to the sandbox, which performs no network
     * I/O — ROADMAP.md §30 puts real calendar integrations in Phase 23.
     */
    meeting: createMeetingService(
      store as never,
      createClassificationReader(store as never),
      createQualificationReader(store as never),
      createMeetingContactReader(store as never),
      createSuppressionReader(store as never),
      calendarProvider(options?.calendarProviders),
    ),
    /**
     * The recommendation boundary reads the account's whole revenue position and
     * nothing else.
     *
     * The reader resolves the account through storage with the caller's own
     * identity and returns nothing for an account that does not exist or belongs
     * to another workspace, so the engine has no way to probe for a foreign id.
     * It is given **no** sender, approver, calendar or scheduler: the strongest
     * thing it can do is produce a sentence, which is the whole point.
     */
    nextaction,
    /**
     * The revenue graph boundary: it derives nodes and edges from rows the
     * other phases already stored and writes nothing back. The reader resolves
     * each account through storage with the caller's own identity, so a
     * foreign id reads as missing and the engine never sees another tenant's
     * records. It is given no sender, no approver, no scheduler and no
     * provider: the strongest thing it can do is draw a picture.
     */
    revenuegraph: createRevenueGraphService(
      store as never,
      createRevenueGraphReader(store as never),
      createRevenueGraphIndexReader(store as never),
    ),
    /**
     * The cost boundary: it appends one immutable fact per request for a run
     * that exists in this workspace, and derives every total and metric on
     * read. Attribution is the session's (`createdBy`) and the server's clock
     * (`createdAt`) inside storage — the request body contributes the fact's
     * own fields and nothing else, so a client cannot name who recorded a
     * cost, when, or what the total should be.
     */
    cost,
    /**
     * The dashboard boundary: read-only, and derived on every request. It is
     * given the workspace-scoped row lookup and the two owning services'
     * answers — no sender, approver, scheduler, provider, clock or network.
     */
    dashboard: createDashboardService(dashboardLookup, dashboardReaders),
    /**
     * The agent registry boundary: it decides lifecycle transitions and
     * records governance events, and it is given nothing with which to
     * execute an agent, call a model, reach a network or send a message.
     */
    agent: createAgentService(agentLookup),
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

/**
 * Register the configured providers for the one channel this phase integrates.
 *
 * The sandbox provider is the default and the only thing shipped here. An
 * explicit list **replaces** it — including an empty one, because a deployment
 * that deliberately configured no provider must reach the "nothing configured"
 * state rather than silently receiving a sandbox one. That state is a real
 * refusal, not an edge case, so it has to be reachable.
 */
function providerRegistry(configured?: readonly OutboundProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  const providers = configured === undefined ? [new SandboxEmailProvider()] : configured;
  for (const provider of providers) {
    registry.register("email", provider);
  }
  return registry;
}

/**
 * The calendar adapter the meeting boundary books through.
 *
 * Defaults to the Phase 11-shaped sandbox: no network I/O, no credential, and a
 * record of what it accepted. `ROADMAP.md` §30 places real calendar integrations
 * in Phase 23, so a deployment registers its own here and the booking boundary
 * does not change — the same seam Phase 11 established for email.
 */
function calendarProvider(
  configured?: readonly MeetingCalendarProvider[],
): MeetingCalendarProvider {
  const providers = configured === undefined ? [new SandboxCalendarProvider()] : configured;
  const first = providers[0];
  if (first === undefined) return new SandboxCalendarProvider();
  return first;
}
