/**
 * @dealora/agent — the closed rule table for Phase 18.
 *
 * Every fact the registry reports comes from this file, so it is the only place
 * an agent can be defined. Nothing here is derived from a request, a caller, a
 * clock or a model: `AGENT_DECLARATIONS` is a constant, the lifecycle is a
 * constant transition table, and `AGENT_IDS` fixes the order every listing
 * prints. That is what makes a registry read byte-identical on every call.
 *
 * The three deliberate refusals, stated once and enforced in `engine.ts`:
 *
 * 1. **No agent is `production` in Phase 18.** `ROADMAP.md` §25 defines
 *    `Production` as a state, and `ROADMAP.md` §26 gates it: *"Production
 *    agents require evaluation evidence"*. Phase 19 is the phase that produces
 *    that evidence. So `production` is published vocabulary and an unreachable
 *    transition — entering it would admit an unmeasured agent to production,
 *    which is precisely what §26 exists to prevent. The vocabulary stays so no
 *    caller is surprised by a missing state.
 * 2. **No agent runs.** There is no runner, dispatcher or tool invoker in this
 *    package. `AGENT_TOOLS` maps a grant name to the *phase that owns* it; the
 *    registry records the grant and nothing more.
 * 3. **No agent has a model.** Every declaration's `model` is the honest
 *    `null`, because every capability named here is owned by a deterministic
 *    engine from Phases 3–16. Naming a provider without calling one would be a
 *    declaration the registry could not honour.
 */

import type {
  AgentDeclaration,
  AgentError,
  AgentErrorCode,
  AgentEvaluationMetric,
  AgentEvaluationMetricView,
  AgentId,
  AgentMemoryLayer,
  AgentPermissionView,
  AgentState,
  AgentToolView,
  AgentTransitionView,
  AgentUsableState,
} from "./types.js";

/** Bumped with the declarations below; the registry reports it verbatim. */
export const AGENT_RULE_VERSION = "agent-1.0.0";

/**
 * The twelve agents `ROADMAP.md` §25 names, in roadmap order.
 *
 * This order is the registry's **total order**: listings, the policy view and
 * the gate all print in exactly this sequence, so there is never a question of
 * what "sorted by id" meant and no reliance on object key order.
 */
export const AGENT_IDS = [
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
] as const satisfies readonly AgentId[];

/**
 * The seven lifecycle states `ROADMAP.md` §25 names, in roadmap order.
 *
 * `AGENT_STATE_ORDER` is the published order; `MEETABLE_AGENT_STATES` is the
 * subset in which anything downstream may *use* an agent, which in Phase 18 is
 * empty by design (see refusal 1).
 */
export const AGENT_STATE_ORDER = [
  "draft",
  "testing",
  "approved",
  "production",
  "paused",
  "disabled",
  "archived",
] as const satisfies readonly AgentState[];

/**
 * States in which an agent may be used by anything downstream.
 *
 * Empty in Phase 18, and typed as `AgentUsableState[]` so that emptiness is a
 * value the compiler accepts rather than a widening the type system hides: the
 * only usable state is `production`, and `production` is unreachable until
 * Phase 19. Phase 19 will add `"production"` here when it has the evidence to
 * justify it.
 */
export const MEETABLE_AGENT_STATES: readonly AgentUsableState[] = [];

/**
 * The published transition table.
 *
 * Read as the whole of what the lifecycle permits:
 * - a new agent starts in `draft` (`initialState`);
 * - `draft → testing` is the only way forward;
 * - `testing → approved` records that a person signed off on the declaration;
 * - `approved → production` is **listed but refused** — it appears so the
 *   machine is legible, and `engine.ts` rejects it by naming Phase 19;
 * - `production/testing/approved → paused` is the operational brake;
 * - `paused → testing` resumes evaluation;
 * - anything live → `disabled` stops it, `disabled → paused` restores it;
 * - anything → `archived` retires it, and `archived` is terminal: no transition
 *   leaves it, so a retired declaration cannot be silently resurrected.
 *
 * Absent pairs are absences of permission, not oversights. There is no
 * `draft → production` shortcut and no `archived → draft` revival.
 */
export const AGENT_TRANSITIONS: readonly AgentTransitionView[] = [
  {
    from: "draft",
    to: "testing",
    reason: "The declaration is complete and ready to be exercised.",
  },
  {
    from: "testing",
    to: "approved",
    reason: "A person has signed off on the declaration before it may be evaluated in production.",
  },
  {
    from: "approved",
    to: "production",
    reason: "Refused in Phase 18: ROADMAP.md §26 requires Phase 19 evaluation evidence first.",
  },
  {
    from: "approved",
    to: "paused",
    reason: "The operational brake may be applied before promotion.",
  },
  {
    from: "production",
    to: "paused",
    reason: "The operational brake applies at every live state.",
  },
  { from: "testing", to: "paused", reason: "Evaluation can be suspended and resumed." },
  { from: "paused", to: "testing", reason: "Resuming re-enters evaluation, never production." },
  { from: "production", to: "disabled", reason: "Disabling is available from any live state." },
  { from: "testing", to: "disabled", reason: "Disabling is available from any live state." },
  { from: "approved", to: "disabled", reason: "Disabling is available from any live state." },
  { from: "paused", to: "disabled", reason: "Disabling is available from any live state." },
  {
    from: "disabled",
    to: "paused",
    reason: "Restoring returns to the paused state, never to a live one.",
  },
  {
    from: "draft",
    to: "archived",
    reason: "A declaration abandoned before testing is retired rather than left open.",
  },
  {
    from: "testing",
    to: "archived",
    reason: "An agent can be retired from evaluation at any point.",
  },
  {
    from: "approved",
    to: "archived",
    reason: "An agent can be retired before it is ever promoted.",
  },
  { from: "production", to: "archived", reason: "An agent can be retired once it is live." },
  { from: "paused", to: "archived", reason: "An agent can be retired from the brake." },
  { from: "disabled", to: "archived", reason: "An agent can be retired after being disabled." },
];

/** The transitions this phase refuses, and the phase that will own them. */
export const AGENT_REFUSED_TRANSITIONS: readonly {
  readonly from: AgentState;
  readonly to: AgentState;
  readonly owningPhase: string;
  readonly reason: string;
}[] = [
  {
    from: "approved",
    to: "production",
    owningPhase: "Phase 19",
    reason:
      "ROADMAP.md §26: production agents require evaluation evidence. Phase 18 declares the metrics; it does not measure them, so no agent can reach production yet.",
  },
];

/**
 * Every tool an agent may hold, and the phase whose boundary executes it.
 *
 * `executedBy` names an **existing** boundary, never a new one. An agent's
 * grant is a declaration that the agent *may ask* for that capability; the tool
 * still runs its own phase's authorization, and `send_message` still passes
 * Phase 10's approval and Phase 11's suppression checks. Granting a tool here
 * bypasses nothing.
 *
 * `approvalImplied` is true for exactly three tools — the ones that either
 * require a person to decide (`request_approval`), leave the system
 * (`send_message`) or book against someone's calendar (`book_meeting`). It is
 * deliberately **false** for `write_evidence`: evidence needs *provenance*,
 * which Phase 7 enforces on every row, and conflating the two would claim that
 * an internal record needs a human sign-off when it needs a citable source.
 * An agent holding any approval-implied tool must declare `approvalRequired`,
 * and the package test asserts exactly that.
 */
export const AGENT_TOOLS: readonly AgentToolView[] = [
  { tool: "read_business_context", executedBy: "Phase 4 business brain", approvalImplied: false },
  { tool: "read_revenue_goal", executedBy: "Phase 3 revenue goal", approvalImplied: false },
  { tool: "read_accounts", executedBy: "Phase 5 accounts", approvalImplied: false },
  { tool: "create_account", executedBy: "Phase 5 accounts", approvalImplied: false },
  { tool: "request_research", executedBy: "Phase 6 research", approvalImplied: false },
  { tool: "read_evidence", executedBy: "Phase 7 evidence", approvalImplied: false },
  { tool: "write_evidence", executedBy: "Phase 7 evidence", approvalImplied: false },
  { tool: "request_qualification", executedBy: "Phase 8 qualification", approvalImplied: false },
  { tool: "render_draft", executedBy: "Phase 9 personalization", approvalImplied: false },
  { tool: "request_approval", executedBy: "Phase 10 human approval", approvalImplied: true },
  {
    tool: "send_message",
    executedBy: "Phase 11 outbound behind Phase 10 approval",
    approvalImplied: true,
  },
  { tool: "record_inbound_message", executedBy: "Phase 12 conversation", approvalImplied: false },
  { tool: "classify_reply", executedBy: "Phase 12 conversation", approvalImplied: false },
  { tool: "recommend_meeting", executedBy: "Phase 13 meeting workflow", approvalImplied: false },
  { tool: "book_meeting", executedBy: "Phase 13 meeting workflow", approvalImplied: true },
  {
    tool: "read_next_best_action",
    executedBy: "Phase 14 next best action",
    approvalImplied: false,
  },
  { tool: "read_revenue_graph", executedBy: "Phase 15 revenue graph", approvalImplied: false },
  { tool: "record_cost", executedBy: "Phase 16 cost engine", approvalImplied: false },
];

/**
 * The published permission strings.
 *
 * Each is a *declaration of intent*, and each names a capability that some
 * other phase already enforces. `write_external` is the one worth reading
 * twice: it does not let anything out of the system on its own — Phase 10
 * approval and Phase 11 suppression still apply — and no agent declares it.
 */
export const AGENT_PERMISSIONS: readonly AgentPermissionView[] = [
  {
    permission: "read_business_context",
    description: "Read the workspace's declared business brain.",
  },
  {
    permission: "read_revenue_data",
    description: "Read goals, plans, accounts, research and evidence.",
  },
  { permission: "write_records", description: "Create or update records inside the workspace." },
  { permission: "write_evidence", description: "Attach provenance-carrying evidence to a record." },
  {
    permission: "request_human_approval",
    description: "Ask a person to decide, through Phase 10 only.",
  },
  {
    permission: "write_external",
    description: "Never granted in Phase 18: sending stays behind Phase 10 approval.",
  },
  { permission: "read_own_memory", description: "Read the memory layers this declaration lists." },
  {
    permission: "recommend_only",
    description: "Produce advice that stays advice until a person acts on it.",
  },
];

/** The memory layers `DEALORA_BLUEPRINT.md` §28 names, declared never opened. */
export const AGENT_MEMORY_LAYERS: readonly AgentMemoryLayer[] = [
  "global",
  "business",
  "campaign",
  "account",
  "person",
  "conversation",
  "agent",
  "workflow",
];

/**
 * The evaluation metrics `ROADMAP.md` §26 names.
 *
 * Phase 18 **declares which metrics will gate promotion and measures none of
 * them** — `owningPhase` is Phase 19 throughout. This is what makes the
 * promotion refusal checkable instead of aspirational.
 */
export const AGENT_EVALUATION_METRICS: readonly AgentEvaluationMetricView[] = [
  {
    metric: "task_success",
    description: "Did the agent accomplish the task it was given?",
    owningPhase: "Phase 19",
  },
  {
    metric: "accuracy",
    description: "Were the agent's outputs factually correct?",
    owningPhase: "Phase 19",
  },
  {
    metric: "relevance",
    description: "Did the output serve the task that was asked?",
    owningPhase: "Phase 19",
  },
  {
    metric: "hallucination_rate",
    description: "How often did the agent assert something unsupported?",
    owningPhase: "Phase 19",
  },
  {
    metric: "tool_call_correctness",
    description: "Did the agent call the right tool with the right arguments?",
    owningPhase: "Phase 19",
  },
  {
    metric: "qualification_accuracy",
    description: "Did qualification agree with the evidence?",
    owningPhase: "Phase 19",
  },
  {
    metric: "personalization_quality",
    description: "Was the draft specific, sourced and non-generic?",
    owningPhase: "Phase 19",
  },
  {
    metric: "response_classification_accuracy",
    description: "Was the reply intent read correctly?",
    owningPhase: "Phase 19",
  },
  {
    metric: "cost",
    description: "What did the run cost, against the declared limit?",
    owningPhase: "Phase 19",
  },
  { metric: "latency", description: "How long did the run take?", owningPhase: "Phase 19" },
  {
    metric: "failure_rate",
    description: "How often did the run fail outright?",
    owningPhase: "Phase 19",
  },
  {
    metric: "human_override_rate",
    description: "How often did a person override the agent's output?",
    owningPhase: "Phase 19",
  },
  {
    metric: "business_outcome",
    description: "Did the agent's work produce the outcome it claimed?",
    owningPhase: "Phase 19",
  },
];

/**
 * The twelve fields `ROADMAP.md` §25 requires of every production agent, in
 * roadmap order.
 *
 * Eleven of them are declaration fields and live in `rules.ts` as code. The
 * twelfth, `status`, is the per-workspace lifecycle state and is deliberately
 * **not** here — a workspace's decision is stored, never declared. Listing it
 * here is what lets the policy route report the whole requirement set, and what
 * lets a test check that none of the twelve is missing.
 */
export const AGENT_REQUIRED_FIELDS = [
  "agentId",
  "version",
  "purpose",
  "inputs",
  "outputs",
  "tools",
  "permissions",
  "memoryAccess",
  "approvalRequired",
  "costLimits",
  "evaluationMetrics",
  "status",
] as const;

/** Why the lifecycle stops where it does, in one sentence per boundary. */
export const AGENT_PROMOTION_RULE =
  "An agent may reach `production` only after Phase 19 records evaluation evidence against every metric this registry declares. Phase 18 declares those metrics and refuses the transition, so `production` is published vocabulary and an unreachable state.";

/** What this registry refuses to do, in its own words. */
export const AGENT_NEVER_DOES: readonly string[] = [
  "Never executes an agent: there is no runner, dispatcher or tool invoker in this package.",
  "Never calls a model or any network: `model` is a configuration field, and every declaration's is null.",
  "Never sends anything: outbound stays behind Phase 10 approval and Phase 11 suppression.",
  "Never writes evidence without provenance: Phase 7 remains the only evidence boundary.",
  "Never fabricates a capability, an evaluation result or a trace: Phase 19 measures, Phase 20 traces.",
  "Never promotes an agent to production without Phase 19 evidence.",
  "Never reads or writes another workspace's registry.",
  "Never reads or writes agent memory: layers are declared, access is Phase 20+.",
  "Never schedules itself or runs on a timer.",
];

/** Whole-minute limits, so a budget is never a float in a money field. */
function limits(maxSpendMinor: number, maxPerExecutionMinor: number) {
  return { maxSpendMinor, maxPerExecutionMinor, currency: "USD" } as const;
}

/**
 * The twelve declarations.
 *
 * Each `owner` is the phase that already does that work, so this table never
 * becomes a second source of truth: an agent *names* a capability that lives
 * somewhere else. Cost limits are deliberately modest and uniform — they are a
 * declared ceiling on a system that does not yet execute, not a measured spend.
 */
export const AGENT_DECLARATIONS: readonly AgentDeclaration[] = [
  {
    agentId: "strategy",
    version: "1.0.0",
    owner: "Phase 2 revenue plan",
    purpose:
      "Draft the revenue strategy and plan the business is working to, derived from the declared goal.",
    inputs: ["business_brain", "revenue_goal", "revenue_plan"],
    outputs: ["proposed_plan_change"],
    tools: ["read_business_context", "read_revenue_goal"],
    permissions: ["read_business_context", "read_revenue_data", "recommend_only"],
    memoryAccess: ["business", "global"],
    approvalRequired: true,
    maxRiskLevel: "level_0_read",
    costLimits: limits(200_000, 20_000),
    evaluationMetrics: ["task_success", "accuracy", "relevance", "cost", "business_outcome"],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "market_intelligence",
    version: "1.0.0",
    owner: "Phase 6 research",
    purpose: "Survey a market and surface the segments and signals worth pursuing.",
    inputs: ["business_brain", "segment_definition"],
    outputs: ["research_request", "evidence_candidate"],
    tools: ["read_business_context", "request_research", "read_evidence"],
    permissions: ["read_business_context", "read_revenue_data", "recommend_only"],
    memoryAccess: ["business", "global"],
    approvalRequired: true,
    maxRiskLevel: "level_0_read",
    costLimits: limits(200_000, 20_000),
    evaluationMetrics: ["task_success", "accuracy", "relevance", "hallucination_rate", "cost"],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "account_research",
    version: "1.0.0",
    owner: "Phase 6 research, Phase 7 evidence",
    purpose:
      "Research one account and attach provenance-carrying evidence to what is already known.",
    inputs: ["account", "research_request"],
    outputs: ["research_run", "evidence"],
    tools: ["read_accounts", "request_research", "read_evidence", "write_evidence"],
    permissions: ["read_revenue_data", "write_records", "write_evidence"],
    memoryAccess: ["account", "business"],
    approvalRequired: false,
    maxRiskLevel: "level_1_draft",
    costLimits: limits(300_000, 30_000),
    evaluationMetrics: [
      "task_success",
      "accuracy",
      "hallucination_rate",
      "tool_call_correctness",
      "cost",
    ],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "prospect_discovery",
    version: "1.0.0",
    owner: "Phase 5 accounts",
    purpose: "Find accounts that fit the declared ideal profile and propose them for review.",
    inputs: ["business_brain", "ideal_profile"],
    outputs: ["account_candidate"],
    tools: ["read_business_context", "read_accounts", "create_account"],
    permissions: ["read_business_context", "read_revenue_data", "write_records", "recommend_only"],
    memoryAccess: ["business", "global"],
    approvalRequired: true,
    maxRiskLevel: "level_1_draft",
    costLimits: limits(300_000, 30_000),
    evaluationMetrics: ["task_success", "accuracy", "relevance", "cost", "business_outcome"],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "qualification",
    version: "1.0.0",
    owner: "Phase 8 qualification",
    purpose: "Qualify an account against the revenue goal, using only recorded evidence.",
    inputs: ["account", "evidence", "revenue_goal"],
    outputs: ["qualification"],
    tools: ["read_accounts", "read_evidence", "read_revenue_goal", "request_qualification"],
    permissions: ["read_revenue_data", "write_records"],
    memoryAccess: ["account", "business"],
    approvalRequired: false,
    maxRiskLevel: "level_1_draft",
    costLimits: limits(200_000, 20_000),
    evaluationMetrics: [
      "task_success",
      "qualification_accuracy",
      "accuracy",
      "tool_call_correctness",
      "cost",
    ],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "personalization",
    version: "1.0.0",
    owner: "Phase 9 personalization",
    purpose: "Render a draft grounded in that account's recorded research and evidence.",
    inputs: ["account", "qualification", "evidence"],
    outputs: ["draft"],
    tools: ["read_accounts", "read_evidence", "render_draft"],
    permissions: ["read_revenue_data", "write_records"],
    memoryAccess: ["account", "person", "campaign"],
    approvalRequired: false,
    maxRiskLevel: "level_1_draft",
    costLimits: limits(300_000, 30_000),
    evaluationMetrics: [
      "personalization_quality",
      "accuracy",
      "hallucination_rate",
      "relevance",
      "cost",
    ],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "conversation",
    version: "1.0.0",
    owner: "Phase 12 conversation",
    purpose: "Read an inbound reply, classify its intent and keep the thread consistent.",
    inputs: ["inbound_message", "conversation"],
    outputs: ["classification", "recommended_response"],
    tools: ["record_inbound_message", "classify_reply", "read_accounts"],
    permissions: ["read_revenue_data", "write_records", "recommend_only"],
    memoryAccess: ["conversation", "account"],
    approvalRequired: false,
    maxRiskLevel: "level_1_draft",
    costLimits: limits(200_000, 20_000),
    evaluationMetrics: [
      "response_classification_accuracy",
      "accuracy",
      "relevance",
      "tool_call_correctness",
      "cost",
    ],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "follow_up",
    version: "1.0.0",
    owner: "Phase 11 outbound, Phase 10 approval",
    purpose: "Propose the next follow-up, leaving every send behind human approval.",
    inputs: ["account", "draft", "next_best_action"],
    outputs: ["approval_request", "outbound_action"],
    tools: ["render_draft", "request_approval", "read_next_best_action"],
    permissions: ["read_revenue_data", "request_human_approval", "write_records"],
    memoryAccess: ["account", "conversation", "campaign"],
    approvalRequired: true,
    maxRiskLevel: "level_2_external_action",
    costLimits: limits(300_000, 30_000),
    evaluationMetrics: ["task_success", "human_override_rate", "business_outcome", "cost"],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "meeting",
    version: "1.0.0",
    owner: "Phase 13 meeting workflow",
    purpose: "Recommend and schedule meetings, recording every state change in the meeting log.",
    inputs: ["account", "conversation", "calendar_slot"],
    outputs: ["meeting", "meeting_event"],
    tools: ["recommend_meeting", "book_meeting", "read_accounts"],
    permissions: ["read_revenue_data", "write_records"],
    memoryAccess: ["account", "conversation", "workflow"],
    approvalRequired: true,
    maxRiskLevel: "level_2_external_action",
    costLimits: limits(200_000, 20_000),
    evaluationMetrics: ["task_success", "tool_call_correctness", "failure_rate", "cost", "latency"],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "crm",
    version: "1.0.0",
    owner: "Phase 23 CRM integrations",
    purpose:
      "Keep the workspace's CRM records in step with what Dealora knows, when an integration exists.",
    inputs: ["account", "crm_record"],
    outputs: ["crm_sync_record"],
    tools: ["read_accounts", "read_revenue_graph"],
    permissions: ["read_revenue_data", "recommend_only"],
    memoryAccess: ["account", "global"],
    approvalRequired: true,
    maxRiskLevel: "level_3_high_impact",
    costLimits: limits(500_000, 50_000),
    evaluationMetrics: ["task_success", "accuracy", "failure_rate", "cost"],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "analytics",
    version: "1.0.0",
    owner: "Phase 15 revenue graph, Phase 16 cost engine",
    purpose:
      "Explain what the business is doing by reading the graph and the ledger, never by estimating.",
    inputs: ["revenue_graph", "cost_metrics"],
    outputs: ["analysis"],
    tools: ["read_revenue_graph", "read_next_best_action"],
    permissions: ["read_revenue_data", "recommend_only"],
    memoryAccess: ["business", "workflow", "global"],
    approvalRequired: false,
    maxRiskLevel: "level_0_read",
    costLimits: limits(100_000, 10_000),
    evaluationMetrics: ["task_success", "accuracy", "relevance", "cost", "latency"],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
  {
    agentId: "optimization",
    version: "1.0.0",
    owner: "Phase 21 optimization",
    purpose: "Propose an improvement to the system, as advice only, never as a silent change.",
    inputs: ["revenue_graph", "cost_metrics", "next_best_action"],
    outputs: ["proposal"],
    tools: ["read_revenue_graph", "read_next_best_action", "record_cost"],
    permissions: ["read_revenue_data", "recommend_only"],
    memoryAccess: ["business", "workflow", "global"],
    approvalRequired: true,
    maxRiskLevel: "level_1_draft",
    costLimits: limits(100_000, 10_000),
    evaluationMetrics: ["task_success", "business_outcome", "human_override_rate", "cost"],
    model: { provider: null, model: null, temperature: null },
    initialState: "draft",
  },
];

/**
 * Declaration lookup by id, built once and never mutated.
 *
 * Keyed by `string` rather than by `AgentId` so a caller holding unvalidated
 * input can be looked up without an assertion: the guard that decides whether
 * the string is an agent id at all is `isAgentId`, and this map is only
 * consulted afterwards.
 */
const DECLARATIONS_BY_ID = new Map<string, AgentDeclaration>();
for (const declaration of AGENT_DECLARATIONS) {
  DECLARATIONS_BY_ID.set(declaration.agentId, declaration);
}

/** The seven states as a set, so a guard can narrow without a cast. */
const AGENT_STATE_SET: ReadonlySet<string> = new Set(AGENT_STATE_ORDER);

/** The declaration for one agent, or `null` when the id is not one of twelve. */
export function declarationFor(agentId: string): AgentDeclaration | null {
  return DECLARATIONS_BY_ID.get(agentId) ?? null;
}

/** The published tool view for one tool name, or `null` when unknown. */
export function toolFor(tool: string): AgentToolView | null {
  return AGENT_TOOLS.find((entry) => entry.tool === tool) ?? null;
}

/**
 * The position of an agent id in the published order.
 *
 * Used as the sort key so every listing is a total order over a constant table:
 * no `localeCompare` on free text, no reliance on the store's row order, and a
 * total tie-break that cannot collide because ids are unique in `AGENT_IDS`.
 */
export function agentOrder(agentId: string): number {
  let order = 0;
  for (const declared of AGENT_IDS) {
    if (declared === agentId) return order;
    order += 1;
  }
  return -1;
}

/** Whether an id names one of the twelve agents. */
export function isAgentId(value: string): value is AgentId {
  return DECLARATIONS_BY_ID.has(value);
}

/** Whether a string names one of the seven published states. */
export function isAgentState(value: string): value is AgentState {
  return AGENT_STATE_SET.has(value);
}

/** Whether a string names one of the thirteen published metrics. */
export function isAgentEvaluationMetric(value: string): value is AgentEvaluationMetric {
  return AGENT_EVALUATION_METRICS.some((entry) => entry.metric === value);
}

/** Construct a domain error, keeping field details when there are any. */
export function agentError(
  code: AgentErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): AgentError {
  return details && details.length > 0 ? { code, message, details } : { code, message };
}
