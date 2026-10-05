/**
 * @dealora/agent — types for the Phase 18 Agent System (`ROADMAP.md` §25,
 * `DEALORA_BLUEPRINT.md` §12 agent list, §29 governance, §30 registry).
 *
 * This phase builds the **registry and its governance**, not the agents'
 * behaviour. `ROADMAP.md` §25 asks for twelve named agents that each *declare*
 * what they are, and for a seven-value lifecycle; `BLUEPRINT.md` §30 asks that
 * every agent carry a fixed set of registry fields, and §29 asks for the
 * governance layer around them. Nothing here executes an agent, runs a model,
 * calls a tool or reaches a network — and the split is deliberate, because the
 * roadmap puts the three phases that *would* do that later and in order:
 *
 * - **Phase 19 — Agent Evaluation** measures agents. Phase 18 therefore
 *   **declares** `evaluationMetrics` (which metrics will gate promotion) and
 *   refuses to promote any agent to `production`, because admitting an
 *   unevaluated agent to production is exactly what `BLUEPRINT.md` §"Every
 *   production agent must be evaluated" forbids.
 * - **Phase 20 — Agent Trace & Observability** traces runs. Phase 18 therefore
 *   writes no run log and no trace: it records only *governance* events — a
 *   human changing an agent's lifecycle state — because that is an auditable
 *   decision about the registry, not a trace of agent behaviour.
 *
 * The negative space, stated once:
 * - never executes: this package has no runner, no dispatcher and no tool
 *   invoker, so an agent cannot act here even in principle;
 * - never calls a model: `model` is a *configuration* field a declaration
 *   carries, never a live client, and no provider is imported;
 * - never reaches the network or a scheduler;
 * - never duplicates another phase's authority: an agent's declaration names
 *   the phase that owns its capability (`owner`) and the tools it may use, but
 *   the tool itself is executed by that phase's existing, approved boundary —
 *   this registry grants nothing;
 * - never fabricates: the registry reports what was declared and what a person
 *   decided; it invents no capability, no evaluation result and no trace;
 * - never crosses a workspace: every read and write is workspace-scoped with
 *   the caller's own identity;
 * - never promotes silently: `production` is unreachable in this phase, by
 *   design, and the refusal names Phase 19.
 *
 * Determinism: the twelve declarations are a closed table in `rules.ts`, the
 * lifecycle is a closed transition table, and every listing is a total order
 * over that table — so the same registry state prints the same JSON on every
 * read, with no clock and no randomness in any derivation.
 */

import type { ApprovalRiskLevel, DateTime, EntityId } from "@dealora/db";

/** The closed error vocabulary this domain reports to the transport layer. */
export type AgentErrorCode =
  "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_ERROR" | "CONFLICT" | "UNAVAILABLE";

export interface AgentError {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** Every store method's result shape, stated structurally. */
export type StorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

/**
 * The twelve agents `ROADMAP.md` §25 names, as a closed vocabulary.
 *
 * Closed rather than open: an agent id that is not one of these twelve cannot
 * be declared, stored or read, so the registry cannot grow vocabulary that no
 * product requirement asked for. A later phase that adds an agent adds a member
 * here with its own ADR, exactly as Phases 13 and 14 corrected for.
 */
export type AgentId =
  | "strategy"
  | "market_intelligence"
  | "account_research"
  | "prospect_discovery"
  | "qualification"
  | "personalization"
  | "conversation"
  | "follow_up"
  | "meeting"
  | "crm"
  | "analytics"
  | "optimization";

/**
 * The seven lifecycle states `ROADMAP.md` §25 and `BLUEPRINT.md` §30 name.
 *
 * `production` is **declared but unreachable in Phase 18** — see the module
 * note. Publishing the state keeps the vocabulary honest while the transition
 * into it refuses, so nothing advertises a lifecycle this phase cannot honour.
 */
export type AgentState =
  "draft" | "testing" | "approved" | "production" | "paused" | "disabled" | "archived";

/** The states from which an agent may be used by anything downstream. */
export type AgentUsableState = "production";

/**
 * What an external gate says about one promotion.
 *
 * Declared here, structurally, rather than imported: `@dealora/agent` must not
 * depend on `@dealora/evaluation`, which depends on this package. The
 * dependency runs one way, and the only thing crossing it is this answer.
 *
 * `satisfied` is a conclusion somebody reached from stored evidence. Nothing in
 * this package trusts a caller to produce one: `decideTransition` is given the
 * gate by the wiring, and a missing gate is a refusal.
 */
export interface ProductionGateOutcome {
  readonly satisfied: boolean;
  /** Why it says so — required, because a bare boolean is not reviewable. */
  readonly reason: string;
}

/** Everything the gate is asked about, all of it resolved server-side. */
export interface ProductionGateQuery {
  readonly workspaceId: string;
  readonly userId: string;
  readonly agentId: AgentId;
  /** The declaration's version, read from this package's own table. */
  readonly version: string;
}

/** Answers `ProductionGateQuery`. Wired in by the application, never by a caller. */
export type ProductionGateResolver = (query: ProductionGateQuery) => ProductionGateOutcome;

/**
 * The tools an agent may be granted, as a closed vocabulary.
 *
 * A tool is a *name for a capability some other phase already owns*. The
 * registry records the grant; it never performs the call. `send_message` in
 * particular names Phase 11's boundary, which re-derives its own approval and
 * suppression checks before anything leaves the system — an agent holding this
 * tool has still earned nothing.
 */
export type AgentToolId =
  | "read_business_context"
  | "read_revenue_goal"
  | "read_accounts"
  | "create_account"
  | "request_research"
  | "read_evidence"
  | "write_evidence"
  | "request_qualification"
  | "render_draft"
  | "request_approval"
  | "send_message"
  | "record_inbound_message"
  | "classify_reply"
  | "recommend_meeting"
  | "book_meeting"
  | "read_next_best_action"
  | "read_revenue_graph"
  | "record_cost";

/**
 * The memory layers `BLUEPRINT.md` §28 names.
 *
 * Declared, never opened: this phase reads and writes no agent memory. The
 * layer list exists so a later phase's access can be reviewed against a stated
 * declaration rather than discovered after the fact, and so `memoryAccess` can
 * be empty for every agent that needs nothing.
 */
export type AgentMemoryLayer =
  "global" | "business" | "campaign" | "account" | "person" | "conversation" | "agent" | "workflow";

/**
 * The evaluation metrics `ROADMAP.md` §26 (Phase 19) names.
 *
 * Phase 18 **declares which metrics gate promotion and measures none of
 * them.** Naming them is what makes the Phase 19 refusal checkable instead of
 * aspirational.
 */
export type AgentEvaluationMetric =
  | "task_success"
  | "accuracy"
  | "relevance"
  | "hallucination_rate"
  | "tool_call_correctness"
  | "qualification_accuracy"
  | "personalization_quality"
  | "response_classification_accuracy"
  | "cost"
  | "latency"
  | "failure_rate"
  | "human_override_rate"
  | "business_outcome";

/**
 * What an agent declares about its model.
 *
 * A **configuration**, never a client: naming a model is what makes the
 * registry reviewable, and nothing in this package opens one. `null` is the
 * honest value for every agent in Phase 18, because the deterministic phases
 * that own these capabilities use no model at all.
 */
export interface AgentModelConfig {
  readonly provider: string | null;
  readonly model: string | null;
  readonly temperature: number | null;
}

/** A whole-minute budget an agent may spend, declared before it can be used. */
export interface AgentCostLimit {
  /** Whole minor units in the workspace's one currency, never a float. */
  readonly maxSpendMinor: number;
  /** Whole minor units per single execution. */
  readonly maxPerExecutionMinor: number;
  readonly currency: string;
}

/**
 * One agent's declaration: the registry fields `ROADMAP.md` §25 requires,
 * plus `owner` and `model` from `BLUEPRINT.md` §30.
 *
 * The whole set is **required**, with no field optional except `memoryAccess`
 * (an agent that needs no memory declares an empty list, which is a statement,
 * not an omission). That is the point of the phase: an agent that cannot say
 * what it may touch cannot be registered.
 */
export interface AgentDeclaration {
  readonly agentId: AgentId;
  /** Semantic version of the declaration itself, bumped with the behaviour. */
  readonly version: string;
  /** The phase that owns this capability. An agent never owns its own work. */
  readonly owner: string;
  readonly purpose: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly tools: readonly AgentToolId[];
  readonly permissions: readonly string[];
  readonly memoryAccess: readonly AgentMemoryLayer[];
  readonly approvalRequired: boolean;
  /** The highest `BLUEPRINT.md` §17 risk level this agent's tools carry. */
  readonly maxRiskLevel: ApprovalRiskLevel;
  readonly costLimits: AgentCostLimit;
  readonly evaluationMetrics: readonly AgentEvaluationMetric[];
  readonly model: AgentModelConfig;
  /** The state a freshly registered agent starts in. Never `production`. */
  readonly initialState: AgentState;
}

/** A declaration paired with the state one workspace has put that agent in. */
export interface RegisteredAgent {
  readonly declaration: AgentDeclaration;
  readonly status: AgentState;
  /** True only for `production`, which Phase 18 cannot yet reach. */
  readonly usable: boolean;
  readonly updatedBy: EntityId | null;
  readonly updatedAt: DateTime | null;
}

/**
 * The stored, per-workspace override: only the lifecycle state is a row.
 *
 * `agentId` is a `string` here rather than an `AgentId`, because it comes from
 * a column whose validity the store checks against the published vocabulary.
 * The domain refines it to `AgentId` at the point of use, which is where the
 * twelve-agent guarantee actually has to hold.
 */
export interface AgentRegistryRow {
  readonly workspaceId: EntityId;
  readonly agentId: string;
  readonly status: AgentState;
  readonly updatedBy: EntityId;
  readonly updatedAt: DateTime;
}

/** The append-only governance event trail for one lifecycle change. */
export type AgentRegistryEventKind = "registered" | "state_changed" | "archived";

export interface AgentRegistryEvent {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  /** A string the store has already checked against the twelve published ids. */
  readonly agentId: string;
  readonly actorUserId: EntityId;
  readonly kind: AgentRegistryEventKind;
  readonly fromStatus: AgentState | null;
  readonly toStatus: AgentState;
  readonly detail: string | null;
  readonly createdAt: DateTime;
}

/** One published transition in the lifecycle machine. */
export interface AgentTransitionView {
  readonly from: AgentState;
  readonly to: AgentState;
  readonly reason: string;
}

/** One tool in the published vocabulary, with the phase that executes it. */
export interface AgentToolView {
  readonly tool: AgentToolId;
  readonly executedBy: string;
  readonly approvalImplied: boolean;
}

/** One published permission string and what it permits. */
export interface AgentPermissionView {
  readonly permission: string;
  readonly description: string;
}

/** One evaluation metric this registry will require before promotion. */
export interface AgentEvaluationMetricView {
  readonly metric: AgentEvaluationMetric;
  readonly description: string;
  readonly owningPhase: string;
}

/** The whole governance rule set, readable before any agent is registered. */
export interface AgentPolicyView {
  readonly ruleVersion: string;
  readonly agents: readonly {
    readonly agentId: AgentId;
    readonly version: string;
    readonly owner: string;
    readonly purpose: string;
    readonly tools: readonly AgentToolId[];
    readonly permissions: readonly string[];
    readonly memoryAccess: readonly AgentMemoryLayer[];
    readonly approvalRequired: boolean;
    readonly maxRiskLevel: ApprovalRiskLevel;
    readonly costLimits: AgentCostLimit;
    readonly evaluationMetrics: readonly AgentEvaluationMetric[];
    readonly model: AgentModelConfig;
    readonly initialState: AgentState;
  }[];
  readonly states: readonly AgentState[];
  readonly transitions: readonly AgentTransitionView[];
  readonly tools: readonly AgentToolView[];
  readonly permissions: readonly AgentPermissionView[];
  readonly memoryLayers: readonly AgentMemoryLayer[];
  readonly evaluationMetrics: readonly AgentEvaluationMetricView[];
  /** States an agent may be used in. Empty in Phase 18, by design. */
  readonly usableStates: readonly AgentUsableState[];
  /** Why `production` cannot be entered yet, and who will change that. */
  readonly promotionRule: string;
  readonly requiredFields: readonly string[];
  readonly neverDoes: readonly string[];
}

/** The workspace's whole registry, one entry per declared agent. */
export interface AgentRegistryView {
  readonly ruleVersion: string;
  readonly agents: readonly RegisteredAgent[];
}

/**
 * The storage surface the registry reads through. Every method is
 * workspace-scoped inside the repository: the service passes the caller's
 * identity and never a role or a claim a client sent.
 */
export interface AgentRegistryRepository {
  authorize(workspaceId: string, userId: string): StorageResult<unknown>;
  listAgentRegistry(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly AgentRegistryRow[]>;
  getAgentRegistry(
    workspaceId: string,
    userId: string,
    agentId: AgentId,
  ): StorageResult<AgentRegistryRow | null>;
  setAgentStatus(input: {
    workspaceId: string;
    userId: string;
    agentId: AgentId;
    status: AgentState;
  }): StorageResult<AgentRegistryRow>;
  listAgentRegistryEvents(
    workspaceId: string,
    userId: string,
    agentId?: AgentId,
  ): StorageResult<readonly AgentRegistryEvent[]>;
}
