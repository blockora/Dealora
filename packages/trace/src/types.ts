/**
 * @dealora/trace — types for Phase 20 Agent Trace & Observability
 * (`ROADMAP.md` §27, `DEALORA_BLUEPRINT.md` §32 agent trace, §69
 * observability, §70 failure handling, §33 cost engine, §30 registry).
 *
 * ## What this phase is
 *
 * §27 asks for two things and this package implements exactly them:
 *
 * 1. **Expose** the chain a production workflow goes through —
 *    agent → decision → tool call → evidence → result → approval →
 *    external action — as seven ordered stages.
 * 2. **Track** nine things about it: execution time, model usage, token usage,
 *    tool calls, errors, retries, approvals, external actions and cost.
 *
 * Underneath both is §27's one critical rule: **never silently pretend an
 * action succeeded.** That rule is not a convention this package follows; it is
 * the shape of its types. `TraceRunStatus` has exactly five members and **no
 * request anywhere can supply one** — a close carries a run id and nothing
 * else, and the status is derived from the recorded outcomes. A run with no
 * recorded outcome closes as `unverified`, so success cannot be asked for.
 *
 * ## The negative space, stated once
 *
 * - **never executes**: there is no runner, dispatcher, loop, scheduler, queue
 *   or tool invoker here. Recording a `tool_call` step records that somebody
 *   reported invoking a tool; it does not invoke one;
 * - **never calls a model**: `modelProvider` / `modelName` / `inputTokens` /
 *   `outputTokens` are *reported usage*, copied from whatever reported them.
 *   No client is opened and no provider is imported;
 * - **never reaches a network or an external system**: no email, no calendar, no
 *   CRM write, no browser;
 * - **never fabricates a success**: an outcome is what the recorder reported,
 *   the run's status is what those outcomes prove, and nothing upgrades an
 *   absence into a pass;
 * - **never crosses a workspace**: every read and write is workspace-scoped with
 *   the caller's own identity, re-checked inside storage;
 * - **never rewrites history**: runs and events are append-only. A closed run
 *   accepts no further step, and no row is ever updated or deleted;
 * - **never decides an evaluation**: Phase 19 owns judgements and this package
 *   writes none. A trace is not evidence and is never converted into one;
 * - **never duplicates a cost calculation**: the total comes from Phase 16's
 *   own immutable `cost_events` rows through `@dealora/cost`'s published
 *   derivation, under the `agent_run` execution kind this phase adds.
 *
 * ## Determinism
 *
 * No clock, no randomness, no network and no model sits in any derivation below.
 * Steps are ordered by `sequence`, which storage allocates as a monotonic
 * counter inside the run — **not** by `recordedAt`, because two steps recorded
 * inside the same millisecond are ordinary and a timestamp-only order would be
 * ambiguous between them. A run listing is ordered by `(agentId, id)`, both
 * stable fields, so the same stored rows always print the same JSON.
 */

import type { AgentId } from "@dealora/agent";
import type { CostBreakdown, CostEventRow } from "@dealora/cost";
import type { DateTime, EntityId } from "@dealora/db";

/** The closed error vocabulary this domain reports to the transport layer. */
export type TraceErrorCode =
  "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_ERROR" | "CONFLICT" | "UNAVAILABLE";

export interface TraceError {
  readonly code: TraceErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** Every store method's result shape, stated structurally. */
export type TraceStorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

/**
 * The seven stages of the chain `ROADMAP.md` §27 requires a production
 * workflow to expose, in the order the roadmap prints them.
 *
 * Closed and total: the array *is* the report's sort order, so "ordered by
 * stage" never has to mean anything, and a stage no branch can produce cannot
 * be advertised.
 */
export type TraceStage =
  "agent" | "decision" | "tool_call" | "evidence" | "result" | "approval" | "external_action";

/**
 * What happened at one step.
 *
 * `unknown` is the load-bearing member and the reason this is not a boolean.
 * A provider that never answered has not failed — it has left the question
 * open — and reporting that as either success or failure is precisely the
 * dishonesty §27's critical rule and `BLUEPRINT.md` §70 forbid. `DEALORA_BLUEPRINT.md`
 * §70's chain (tool failure → retry → alternative tool → graceful degradation →
 * human escalation) is representable here because each of those is a *separate
 * step with its own outcome*, not a flag flipped on the first one.
 */
export type TraceOutcome = "succeeded" | "failed" | "unknown";

/**
 * What a run turned out to be, decided by storage from the outcomes its own
 * events carry.
 *
 * `open` is the only non-terminal value and it claims nothing: a run that has
 * recorded no outcome yet asserts no outcome. Of the four terminal values,
 *
 * - `failed` outranks everything — one failure is enough;
 * - `unknown` means something was left open, so success cannot be claimed;
 * - `succeeded` requires at least one `succeeded` and no `failed`/`unknown`;
 * - `unverified` is what closing a run with no outcome at all produces.
 *
 * Nothing outside storage writes this value, and the domain re-derives it on
 * every read and refuses to report a row that disagrees.
 */
export type TraceRunStatus = "open" | "succeeded" | "failed" | "unknown" | "unverified";

/** The four statuses a closed run can have, in a fixed total order. */
export type TraceTerminalStatus = Exclude<TraceRunStatus, "open">;

/** How many steps of each stage a run recorded, plus the three outcome counts. */
export interface TraceStageCounts {
  readonly stage: TraceStage;
  readonly count: number;
  /** How many of those steps reported each outcome. */
  readonly succeeded: number;
  readonly failed: number;
  readonly unknown: number;
  /** How many of those steps were a retry of an earlier attempt. */
  readonly retried: number;
}

/**
 * What the trace reports about time, model usage and tokens, derived on read.
 *
 * `slowestStepMs` is a **maximum** and never an average or a sum: steps in one
 * run may overlap, and summing them would invent a duration the run never had.
 * A maximum is safe under overlap, and it is the same shape Phase 19's `latency`
 * metric measures, so "slowest step" means one thing across both phases.
 * `null` means no step reported a duration — never `0`, which would read as an
 * instantaneous run.
 */
export interface TraceUsageSummary {
  /** The slowest step that reported a duration, or `null` when none did. */
  readonly slowestStepMs: number | null;
  /** The `stepId` of that slowest step, so it can be found in the trail. */
  readonly slowestStepId: string | null;
  /** Model invocations reported across the run's steps. */
  readonly modelInvocations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Distinct providers and models the steps named, in a fixed order. */
  readonly models: readonly { provider: string | null; model: string }[];
  /** Distinct tools invoked, in the published tool order. */
  readonly toolsInvoked: readonly string[];
  /** How many steps were a retry of an earlier attempt at the same `stepId`. */
  readonly retryCount: number;
  /** How many steps reported a failure. */
  readonly errorCount: number;
  /** Approval steps, and how many of them were approved. */
  readonly approvalsRequested: number;
  readonly approvalsGranted: number;
  /** External actions, and how many the recorder confirmed actually happened. */
  readonly externalActions: number;
  readonly externalActionsSucceeded: number;
}

/**
 * A whole run: its provenance, its recorded chain, and everything derived from
 * that chain.
 *
 * `status` is the run's derived outcome; `derivedStatus` is what this read
 * re-computed from the events it just loaded. They are printed as separate
 * fields rather than silently reconciled, so a reader can see that the stored
 * verdict and the recorded evidence agree — and a disagreement is refused
 * rather than papered over.
 */
export interface TraceView {
  readonly ruleVersion: string;
  readonly id: EntityId;
  readonly agentId: AgentId;
  /** The declaration version this run traces, copied from the registry table. */
  readonly agentVersion: string;
  /** The stored status: `open`, or the verdict a close derived from the steps. */
  readonly status: TraceRunStatus;
  /**
   * What this read re-derived from the events below.
   *
   * For a closed run this equals `status`, and the read refuses rather than
   * printing a verdict its two sources disagree about. For an open run it is
   * what closing it **now** would produce — informative, and not a claim about a
   * run nobody has closed.
   */
  readonly derivedStatus: TraceRunStatus;
  readonly openedBy: EntityId;
  readonly openedAt: DateTime;
  readonly closedBy: EntityId | null;
  readonly closedAt: DateTime | null;
  readonly stepCount: number;
  /**
   * One tally per stage, all seven always present.
   *
   * A stage with no steps reads as zero rather than being absent, because
   * "no approval was ever requested" and "this trace cannot say whether one was"
   * are different claims and only the first of them is true.
   */
  readonly stages: readonly TraceStageCounts[];
  readonly usage: TraceUsageSummary;
  readonly cost: TraceCostSummary | null;
}

/**
 * What a run cost, in Phase 16's own currency and arithmetic.
 *
 * `null` — not a zero — when no `cost_events` row has been recorded for this
 * run. Phase 16's `CostBreakdown` carries `currency: null` for the same reason,
 * and reusing it keeps there from being a second place that knows how money is
 * added up.
 */
export type TraceCostSummary = CostBreakdown;

/** One recorded step, as the trail reports it. */
export interface TraceEventView {
  readonly id: EntityId;
  readonly runId: EntityId;
  /** Server-derived: 1 for the first step, strictly increasing within the run. */
  readonly sequence: number;
  /** The recorder's stable key for the logical step; a retry reuses it. */
  readonly stepId: string;
  /** Server-derived: steps already recorded for this `stepId`, plus one. */
  readonly attempt: number;
  readonly stage: TraceStage;
  readonly outcome: TraceOutcome;
  readonly detail: string | null;
  /** `tool_call` steps only, and always one of the eighteen declared tools. */
  readonly tool: string | null;
  readonly referenceId: string | null;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
  readonly modelProvider: string | null;
  readonly modelName: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly recordedBy: EntityId;
  readonly recordedAt: DateTime;
}

/** One traced run, as a listing reports it — without loading its steps. */
export interface TraceRunSummary {
  readonly id: EntityId;
  readonly agentId: AgentId;
  readonly agentVersion: string;
  readonly status: TraceRunStatus;
  readonly openedBy: EntityId;
  readonly openedAt: DateTime;
  readonly closedBy: EntityId | null;
  readonly closedAt: DateTime | null;
  /** How many steps the store holds for this run. */
  readonly stepCount: number;
}

/** The whole published rule set, readable before a workspace has traced a run. */
export interface TracePolicyView {
  readonly ruleVersion: string;
  /** The seven stages, in the chain order `ROADMAP.md` §27 prints them. */
  readonly stages: readonly TraceStageDefinition[];
  readonly outcomes: readonly TraceOutcome[];
  /** The five run statuses, with what each one actually asserts. */
  readonly statuses: readonly TraceRunStatusDefinition[];
  /** The tools a `tool_call` step may name, read from `@dealora/agent`. */
  readonly tools: readonly string[];
  readonly tracked: readonly TrackedDimension[];
  readonly criticalRule: string;
  readonly neverDoes: readonly string[];
}

/** One stage, and what a step at that stage means. */
export interface TraceStageDefinition {
  readonly stage: TraceStage;
  readonly position: number;
  /** What the blueprint's example trace shows happening here. */
  readonly meaning: string;
  /** What a step at this stage may additionally name. */
  readonly mayNameTool: boolean;
  readonly mayCarryDuration: boolean;
}

/** What one of §27's nine tracked dimensions is derived from. */
export interface TrackedDimension {
  readonly dimension: string;
  readonly source: string;
}

/** One run status, and the claim it makes. */
export interface TraceRunStatusDefinition {
  readonly status: TraceRunStatus;
  readonly terminal: boolean;
  readonly meaning: string;
}

/** One stored run, exactly as storage holds it. */
export interface TraceRunRow {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly agentId: string;
  readonly version: string;
  readonly status: string;
  readonly openedBy: EntityId;
  readonly openedAt: DateTime;
  readonly closedBy: EntityId | null;
  readonly closedAt: DateTime | null;
}

/** One stored step, exactly as storage holds it. */
export interface TraceEventRow {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly runId: EntityId;
  readonly sequence: number;
  readonly stepId: string;
  readonly attempt: number;
  readonly stage: string;
  readonly outcome: string;
  readonly detail: string | null;
  readonly tool: string | null;
  readonly referenceId: string | null;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
  readonly modelProvider: string | null;
  readonly modelName: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly recordedBy: EntityId;
  readonly recordedAt: DateTime;
}

/**
 * The storage surface this domain reads and writes through.
 *
 * Every method is workspace-scoped inside the repository with the caller's own
 * identity, and none of them accepts an actor, a timestamp, a sequence number,
 * an attempt number or a run status as something it may be told — those are
 * derived in storage, which is the only place they could be derived safely.
 */
export interface TraceRepository {
  authorize(workspaceId: string, userId: string): TraceStorageResult<unknown>;
  createAgentTraceRun(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): TraceStorageResult<TraceRunRow>;
  getAgentTraceRun(input: {
    workspaceId: string;
    userId: string;
    runId: string;
  }): TraceStorageResult<TraceRunRow | null>;
  listAgentTraceRuns(
    workspaceId: string,
    userId: string,
    agentId?: string,
  ): TraceStorageResult<readonly TraceRunRow[]>;
  closeAgentTraceRun(input: {
    workspaceId: string;
    userId: string;
    runId: string;
  }): TraceStorageResult<TraceRunRow>;
  createAgentTraceEvent(input: {
    workspaceId: string;
    userId: string;
    runId: string;
    stepId: string;
    stage: string;
    outcome: string;
    detail: string | null;
    tool: string | null;
    referenceId: string | null;
    errorCode: string | null;
    durationMs: number | null;
    modelProvider: string | null;
    modelName: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }): TraceStorageResult<TraceEventRow>;
  listAgentTraceEvents(
    workspaceId: string,
    userId: string,
    runId: string,
  ): TraceStorageResult<readonly TraceEventRow[]>;
  /**
   * Phase 16's own cost facts for one traced run, under the `agent_run`
   * execution kind Phase 20 adds to that phase's vocabulary.
   *
   * No aggregation happens here and no total is returned: this phase re-uses
   * `@dealora/cost`'s published `deriveBreakdown` over these rows rather than
   * adding money, so there is only ever one place in the system that knows how
   * to add a cost up.
   */
  listAgentRunCostFacts(
    workspaceId: string,
    userId: string,
    runId: string,
  ): TraceStorageResult<readonly CostEventRow[]>;
  /** Whether a workspace's registry has this agent in `production`. */
  getAgentRegistryState(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): TraceStorageResult<string | null>;
}
