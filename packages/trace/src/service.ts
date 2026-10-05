/**
 * @dealora/trace — the Agent Trace & Observability application service
 * (`ROADMAP.md` §27, `DEALORA_BLUEPRINT.md` §32, §69, §70).
 *
 * The chain runs, every time:
 *
 *   authenticate → authorize (server-side) → resolve the agent's declaration →
 *   require this workspace's registry to hold it in `production` → read or
 *   append → derive on read → answer
 *
 * Five properties this service exists to hold:
 *
 * 1. **The caller contributes a step, never an outcome about the run.** A
 *    request carries a step key, a stage, an outcome for *that step*, and the
 *    facts about it. The run's status, its sequence numbers, its attempt
 *    numbers, its timestamps, its agent version, its workspace and its actor
 *    are all derived server-side. There is no request that can say "this run
 *    succeeded".
 * 2. **It never runs anything.** There is no model call, no tool call, no
 *    provider, no network and no queue. Recording that a tool was invoked
 *    performs no invocation.
 * 3. **It never crosses a workspace.** Every read and write is workspace-scoped
 *    with the caller's own identity, and storage re-checks the same pair.
 * 4. **It never rewrites a step.** Steps are append-only, a closed run accepts
 *    nothing further, and there is no update or delete anywhere in this path.
 * 5. **It never ages a trace by the clock.** Ordering is a server-derived
 *    sequence, so identical rows always print identically.
 *
 * Narrowing, not assertion: storage returns rows whose `stage`, `outcome` and
 * `status` are plain strings, and every conversion to this domain's closed
 * vocabularies happens in the functions below. A row outside the published
 * vocabulary is **dropped** rather than cast, so an unreadable record reduces
 * what the trace can claim instead of widening it.
 */

import { declarationFor, isAgentId } from "@dealora/agent";
import type { AgentDeclaration, AgentId } from "@dealora/agent";
import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";

import {
  deriveStageCounts,
  deriveTraceCost,
  deriveTraceStatus,
  deriveUsageSummary,
  sortTraceEvents,
  sortTraceRuns,
  statusesAgree,
} from "./engine.js";
import {
  TRACE_CRITICAL_RULE,
  TRACE_NEVER_DOES,
  TRACE_OUTCOMES,
  TRACE_RUN_STATUSES,
  TRACE_STAGES,
  TRACE_TOOLS,
  TRACE_TRACKED,
  TRACE_RULE_VERSION,
  isTraceOutcome,
  isTraceRunStatus,
  isTraceStage,
  isTraceTool,
} from "./rules.js";
import type {
  TraceError,
  TraceEventRow,
  TraceEventView,
  TracePolicyView,
  TraceRepository,
  TraceRunRow,
  TraceRunSummary,
  TraceStorageResult,
  TraceView,
} from "./types.js";

/** The lifecycle state `ROADMAP.md` §27 scopes a trace to. */
const PRODUCTION_STATE = "production";

/** Map a storage refusal onto the domain vocabulary, hiding internals. */
function fromStorage(
  error: { code: string; message?: string },
  notFoundMessage: string,
): TraceError {
  switch (error.code) {
    case "NOT_FOUND":
      return { code: "NOT_FOUND", message: notFoundMessage };
    case "UNAUTHORIZED":
      return { code: "UNAUTHORIZED", message: "workspace access denied" };
    case "VALIDATION_ERROR":
    case "INVALID":
      // A rule the caller can act on, so it travels with its message.
      return { code: "VALIDATION_ERROR", message: error.message ?? "invalid value" };
    case "CONFLICT":
      return { code: "CONFLICT", message: error.message ?? "conflicting trace record" };
    default:
      // An internal condition is never surfaced verbatim.
      return { code: "UNAVAILABLE", message: "trace storage unavailable" };
  }
}

/** Collapse a storage result onto the domain error vocabulary. */
function resultOr<T>(
  result: TraceStorageResult<T>,
  notFoundMessage: string,
): Result<T, TraceError> {
  if (result.ok) return ok(result.value);
  return err(fromStorage(result.error, notFoundMessage));
}

/** Narrow an unknown to a non-empty trimmed string, or `null` (refuse). */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A stored step as the domain reads it, or `null` when its vocabulary is not
 * one this build publishes.
 *
 * Dropping rather than casting is the point: an unreadable step is a step the
 * trace cannot account for, and a trace that silently counted an unknown record
 * would be making a claim nobody made.
 */
function toEventView(row: TraceEventRow): TraceEventView | null {
  if (!isTraceStage(row.stage)) return null;
  if (!isTraceOutcome(row.outcome)) return null;
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    stepId: row.stepId,
    attempt: row.attempt,
    stage: row.stage,
    outcome: row.outcome,
    detail: row.detail,
    tool: row.tool,
    referenceId: row.referenceId,
    errorCode: row.errorCode,
    durationMs: row.durationMs,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt,
  };
}

/** The stored steps this domain will read, in their published vocabulary. */
function readable(rows: readonly TraceEventRow[]): readonly TraceEventView[] {
  return rows.map(toEventView).filter((row): row is TraceEventView => row !== null);
}

/**
 * A stored run as the domain reads it, or `null` when its agent id is not one
 * this build publishes.
 *
 * Dropped rather than cast, for the same reason as a step: a row naming an
 * agent outside the twelve is not a trace about any agent this product has.
 */
function toRunView(row: TraceRunRow): TraceRunSummary | null {
  if (!isAgentId(row.agentId)) return null;
  if (!isTraceRunStatus(row.status)) return null;
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersion: row.version,
    status: row.status,
    openedBy: row.openedBy,
    openedAt: row.openedAt,
    closedBy: row.closedBy,
    closedAt: row.closedAt,
    stepCount: 0,
  };
}

/** What a caller may contribute to one recorded step. */
export interface EventInput {
  readonly stepId: string;
  readonly stage: string;
  readonly outcome: string;
  readonly detail?: string;
  readonly tool?: string;
  readonly referenceId?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly modelProvider?: string;
  readonly modelName?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export class TraceService {
  constructor(private readonly repo: TraceRepository) {}

  /**
   * Authorize the caller against the workspace using server-side identity.
   *
   * Both values are resolved from the request's route and session by the
   * transport layer; neither is ever taken from a body.
   */
  private guard(workspaceId: string, userId: string): Result<true, TraceError> {
    if (text(workspaceId) === null) {
      return err({ code: "VALIDATION_ERROR", message: "workspace id is required" });
    }
    if (text(userId) === null) {
      return err({ code: "UNAUTHORIZED", message: "authentication required" });
    }
    const authorized = resultOr(this.repo.authorize(workspaceId, userId), "workspace not found");
    if (!authorized.ok) return authorized;
    return ok(true);
  }

  /**
   * Resolve the agent and its declaration, or refuse by name.
   *
   * The declaration supplies `version` to the run, so an agent that is not one
   * of the twelve can never be traced at all. The error is the same whether or
   * not such an agent exists anywhere, so this cannot probe the vocabulary.
   */
  private resolve(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Result<{ agentId: AgentId; declaration: AgentDeclaration }, TraceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (!isAgentId(agentId)) {
      return err({
        code: "VALIDATION_ERROR",
        message: "unknown agent id",
        details: [{ field: "agentId", message: "must name one of the twelve declared agents" }],
      });
    }
    const declaration = declarationFor(agentId);
    if (declaration === null) {
      return err({ code: "NOT_FOUND", message: "agent not found" });
    }
    return ok({ agentId, declaration });
  }

  /**
   * Require this workspace's registry to hold the agent in `production`.
   *
   * This is the whole of Phase 20's relationship with Phase 19, and it is a
   * refusal rather than a capability. `ROADMAP.md` §27 scopes the trace to
   * *production* workflows, so a workspace that has not put the agent into
   * `production` has nothing this phase traces — and reaching that state is
   * Phase 19's decision, made only on evaluation evidence. This check therefore
   * cannot be satisfied by a request, cannot be bypassed by a flag, and is
   * re-read from storage at the moment the run is opened rather than cached.
   *
   * The refusal names the state found, because "your agent is in `approved`"
   * is a materially different sentence from "your agent does not exist" and the
   * caller cannot tell which without asking.
   */
  private requireProduction(
    workspaceId: string,
    userId: string,
    agentId: AgentId,
  ): Result<string, TraceError> {
    const state = resultOr(
      this.repo.getAgentRegistryState(workspaceId, userId, agentId),
      "agent not found",
    );
    if (!state.ok) return state;
    const current = state.value;
    if (current === PRODUCTION_STATE) return ok(current);
    const found = current === null ? "no registry row" : `\`${current}\``;
    return err({
      code: "CONFLICT",
      message: `this agent is in ${found}, not \`production\``,
      details: [
        {
          field: "agentId",
          message:
            "ROADMAP.md §27 traces production workflows; reaching `production` is Phase 19's decision and requires evaluation evidence this phase does not grant.",
        },
      ],
    });
  }

  /**
   * Open one traced run for this agent's current declared version.
   *
   * The version is read from the declaration table, never from the request, so
   * a trace can only ever be about a version that exists — and so a later
   * declaration change opens a *new* run rather than rewriting what this one
   * meant.
   *
   * Opening a run records nothing about any execution. It creates the container
   * a recorder will append steps to; a run with no steps is a real, readable
   * state and reports `open`, which asserts no outcome at all.
   */
  openRun(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Result<TraceRunSummary, TraceError> {
    const resolved = this.resolve(workspaceId, userId, agentId);
    if (!resolved.ok) return resolved;
    const production = this.requireProduction(workspaceId, userId, resolved.value.agentId);
    if (!production.ok) return production;

    const opened = resultOr(
      this.repo.createAgentTraceRun({
        workspaceId,
        userId,
        agentId: resolved.value.agentId,
        version: resolved.value.declaration.version,
      }),
      "agent trace run not found",
    );
    if (!opened.ok) return opened;
    const view = toRunView(opened.value);
    if (view === null) return err({ code: "UNAVAILABLE", message: "trace run is unreadable" });
    return ok(view);
  }

  /**
   * Record one step in one traced run.
   *
   * The caller supplies a `stepId`, a `stage`, an `outcome` **for that step**,
   * and the facts about it. It never supplies — and there is no field to
   * supply — the run's status, a sequence number, an attempt number, a
   * timestamp, the actor, the workspace or the agent version. Every one of
   * those is derived in storage.
   *
   * The stage's shape is checked here *and* in the schema: a `tool` may only be
   * named on a `tool_call` step and must be one of the eighteen tools an agent
   * declaration may be granted, an `errorCode` may only be recorded on a failed
   * step, and token counts require the model that reported them.
   *
   * Repeating the same `stepId` is how `ROADMAP.md` §27's *retries* are
   * recorded: storage counts the attempts already on record and allocates the
   * next one, so `attempt` is a fact about the trace rather than a claim the
   * caller can inflate. An **identical resend** is returned unchanged — a
   * retried request must not append a duplicate — while a **different** outcome
   * for the same step becomes the next attempt, because that is exactly the
   * retry-and-degrade chain `DEALORA_BLUEPRINT.md` §70 asks a trace to show and
   * refusing it would refuse the behaviour being traced. Nothing is ever
   * overwritten: the earlier attempts stay on the record.
   */
  recordStep(
    workspaceId: string,
    userId: string,
    runId: string,
    input: EventInput,
  ): Result<TraceEventView, TraceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const run = resultOr(
      this.repo.getAgentTraceRun({ workspaceId, userId, runId }),
      "trace run not found",
    );
    if (!run.ok) return run;
    if (run.value === null) {
      return err({ code: "NOT_FOUND", message: "trace run not found" });
    }
    if (!isAgentId(run.value.agentId)) {
      // The row names an agent this build does not publish, so no step may be
      // filed against it: an unreadable run cannot become a readable one by
      // having steps appended to it.
      return err({ code: "NOT_FOUND", message: "trace run not found" });
    }

    const stepId = text(input.stepId);
    if (stepId === null) {
      return err({
        code: "VALIDATION_ERROR",
        message: "stepId is required",
        details: [
          {
            field: "stepId",
            message:
              "name the logical step; recording the same stepId again is how a retry is traced",
          },
        ],
      });
    }
    if (!isTraceStage(input.stage)) {
      return err({
        code: "VALIDATION_ERROR",
        message: "unknown trace stage",
        details: [
          {
            field: "stage",
            message: `must be one of ${TRACE_STAGES.map((entry) => entry.stage).join(", ")}`,
          },
        ],
      });
    }
    if (!isTraceOutcome(input.outcome)) {
      return err({
        code: "VALIDATION_ERROR",
        message: "unknown trace outcome",
        details: [
          {
            field: "outcome",
            message: `must be one of ${TRACE_OUTCOMES.join(", ")}; every step says what happened, because "recorded" on its own would claim nothing`,
          },
        ],
      });
    }

    const tool = optionalText(input.tool);
    if (tool !== null) {
      if (input.stage !== "tool_call") {
        return err({
          code: "VALIDATION_ERROR",
          message: "only a tool_call step may name a tool",
          details: [{ field: "tool", message: `stage is \`${input.stage}\`` }],
        });
      }
      if (!isTraceTool(tool)) {
        return err({
          code: "VALIDATION_ERROR",
          message: "unknown agent tool",
          details: [
            {
              field: "tool",
              message: `must be one of the ${TRACE_TOOLS.length} tools ROADMAP.md §25 declares`,
            },
          ],
        });
      }
    }

    const errorCode = optionalText(input.errorCode);
    if (errorCode !== null && input.outcome !== "failed") {
      return err({
        code: "VALIDATION_ERROR",
        message: "an errorCode may only be recorded on a failed step",
        details: [
          {
            field: "errorCode",
            message:
              "`DEALORA_BLUEPRINT.md` §70 separates the two signals: a failure carries its code, anything else does not",
          },
        ],
      });
    }

    const durationMs = optionalCount(input.durationMs);
    if (input.durationMs !== undefined && durationMs === null) {
      return err({
        code: "VALIDATION_ERROR",
        message: "durationMs must be a whole non-negative number of milliseconds",
        details: [{ field: "durationMs", message: "leave it out rather than reporting a guess" }],
      });
    }

    const modelProvider = optionalText(input.modelProvider);
    const modelName = optionalText(input.modelName);
    const inputTokens = optionalCount(input.inputTokens);
    const outputTokens = optionalCount(input.outputTokens);
    const badToken =
      (input.inputTokens !== undefined && inputTokens === null) ||
      (input.outputTokens !== undefined && outputTokens === null);
    if (badToken) {
      return err({
        code: "VALIDATION_ERROR",
        message: "token counts must be whole non-negative numbers",
        details: [{ field: "token counts", message: "`inputTokens` and `outputTokens`" }],
      });
    }
    if ((inputTokens !== null || outputTokens !== null) && modelName === null) {
      return err({
        code: "VALIDATION_ERROR",
        message: "token usage must name the model that reported it",
        details: [
          {
            field: "modelName",
            message:
              "tokens without a model cannot be interpreted, so the half-populated shape is refused",
          },
        ],
      });
    }

    const written = resultOr(
      this.repo.createAgentTraceEvent({
        workspaceId,
        userId,
        runId,
        stepId,
        stage: input.stage,
        outcome: input.outcome,
        detail: optionalText(input.detail),
        tool,
        referenceId: optionalText(input.referenceId),
        errorCode,
        durationMs,
        modelProvider,
        modelName,
        inputTokens,
        outputTokens,
      }),
      "trace run not found",
    );
    if (!written.ok) return written;
    const view = toEventView(written.value);
    if (view === null) {
      // Storage accepted a row in a vocabulary this build does not publish.
      // Refused rather than asserted past: an unreadable step is not a step.
      return err({ code: "UNAVAILABLE", message: "trace step is unreadable" });
    }
    return ok(view);
  }

  /**
   * Close a run.
   *
   * **There is no status argument, and that is the phase.** A close request
   * carries a run id and nothing else, so the status is whatever the recorded
   * outcomes prove — which is how `ROADMAP.md` §27's critical rule stops being
   * a promise and becomes a shape. Closing a run with no steps closes it
   * `unverified`; there is no request anywhere in this package that can produce
   * a successful run.
   *
   * Closing is not reversible. Nothing reopens a run, and no later step may be
   * appended to it, so a reader who has seen a status can rely on it.
   */
  closeRun(
    workspaceId: string,
    userId: string,
    runId: string,
  ): Result<TraceRunSummary, TraceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const closed = resultOr(
      this.repo.closeAgentTraceRun({ workspaceId, userId, runId }),
      "trace run not found",
    );
    if (!closed.ok) return closed;
    const view = toRunView(closed.value);
    if (view === null) return err({ code: "UNAVAILABLE", message: "trace run is unreadable" });
    // The stored status is cross-checked against the recorded outcomes here
    // too, so a run that was closed into `succeeded` without a supporting step
    // is refused on the way out rather than handed back as a success.
    const events = this.loadEvents(workspaceId, userId, view.id);
    if (!events.ok) return events;
    const derived = deriveTraceStatus(events.value.map((event) => event.outcome));
    // Only a **closed** run's status is a verdict, so only a closed run can
    // disagree with the derivation. An `open` run asserts nothing and is never
    // cross-checked against one.
    if (closed.value.status !== "open" && !statusesAgree(closed.value.status, derived)) {
      return err({
        code: "UNAVAILABLE",
        message: "the stored run status does not match its recorded outcomes",
      });
    }
    return ok(view);
  }

  /**
   * One whole run: its steps, its chain, its usage and its cost.
   *
   * Derived on every read, never cached. `derivedStatus` is printed next to the
   * stored `status` so a reader can see that the recorded verdict and the
   * evidence behind it agree; a disagreement is refused rather than papered
   * over, because it would mean something wrote outside both storage and this
   * engine.
   *
   * Complete for a run with no steps: the seven stages all appear with zero, the
   * chain reads as "nothing happened yet", the status is `open`, and cost is
   * `null` — never an empty list and never a fabricated total.
   */
  trace(workspaceId: string, userId: string, runId: string): Result<TraceView, TraceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const run = resultOr(
      this.repo.getAgentTraceRun({ workspaceId, userId, runId }),
      "trace run not found",
    );
    if (!run.ok) return run;
    if (run.value === null) {
      return err({ code: "NOT_FOUND", message: "trace run not found" });
    }
    const summary = toRunView(run.value);
    if (summary === null) {
      return err({ code: "NOT_FOUND", message: "trace run not found" });
    }

    const events = this.loadEvents(workspaceId, userId, summary.id);
    if (!events.ok) return events;
    const derivedStatus = deriveTraceStatus(events.value.map((event) => event.outcome));
    // The same rule as `closeRun`: only a closed run's status is a verdict.
    // While a run is open, `derivedStatus` reports what closing it **now** would
    // produce — informative, and not a claim about a run nobody has closed.
    if (summary.status !== "open" && !statusesAgree(summary.status, derivedStatus)) {
      return err({
        code: "UNAVAILABLE",
        message:
          "the stored run status does not match the outcomes its own steps record, so this trace will not report a verdict",
        details: [
          {
            field: "status",
            message: `stored \`${summary.status}\`, derived \`${derivedStatus}\``,
          },
        ],
      });
    }

    const facts = resultOr(
      this.repo.listAgentRunCostFacts(workspaceId, userId, summary.id),
      "cost facts not found",
    );
    if (!facts.ok) return facts;

    return ok({
      ruleVersion: TRACE_RULE_VERSION,
      id: summary.id,
      agentId: summary.agentId,
      agentVersion: summary.agentVersion,
      status: summary.status,
      derivedStatus,
      openedBy: summary.openedBy,
      openedAt: summary.openedAt,
      closedBy: summary.closedBy,
      closedAt: summary.closedAt,
      stepCount: events.value.length,
      usage: deriveUsageSummary(events.value),
      cost: deriveTraceCost(facts.value),
      stages: deriveStageCounts(events.value),
    });
  }

  /**
   * The recorded step trail for one run, oldest first.
   *
   * Ordered by `sequence`, which storage allocates as a strictly increasing
   * counter inside the run — not by `recordedAt`, because two steps recorded in
   * the same millisecond are ordinary and a timestamp-only order would be
   * ambiguous between them.
   */
  steps(
    workspaceId: string,
    userId: string,
    runId: string,
  ): Result<readonly TraceEventView[], TraceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const run = resultOr(
      this.repo.getAgentTraceRun({ workspaceId, userId, runId }),
      "trace run not found",
    );
    if (!run.ok) return run;
    if (run.value === null) {
      return err({ code: "NOT_FOUND", message: "trace run not found" });
    }
    const events = this.loadEvents(workspaceId, userId, runId);
    if (!events.ok) return events;
    return ok(events.value);
  }

  /**
   * Every traced run for one agent, or for the whole workspace, newest first.
   *
   * Read-only, and complete for a workspace that has traced nothing: the list
   * is empty rather than absent.
   */
  runs(
    workspaceId: string,
    userId: string,
    agentId?: string,
  ): Result<readonly TraceRunSummary[], TraceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (agentId !== undefined && !isAgentId(agentId)) {
      return err({
        code: "VALIDATION_ERROR",
        message: "unknown agent id",
        details: [{ field: "agentId", message: "must name one of the twelve declared agents" }],
      });
    }
    const listed = resultOr(
      this.repo.listAgentTraceRuns(workspaceId, userId, agentId),
      "trace runs not found",
    );
    if (!listed.ok) return listed;

    const views: TraceRunSummary[] = [];
    for (const row of sortTraceRuns(listed.value)) {
      const view = toRunView(row);
      if (view === null) continue;
      // The step count is read per run so a listing can say how much a run
      // holds without loading its whole trail, and so an unreadable step count
      // reduces a number rather than dropping the run.
      const events = resultOr(
        this.repo.listAgentTraceEvents(workspaceId, userId, row.id),
        "trace steps not found",
      );
      if (!events.ok) return events;
      views.push({ ...view, stepCount: readable(events.value).length });
    }
    return ok(views);
  }

  /**
   * The published rule set: the seven stages, the three outcomes, the five run
   * statuses, the nine tracked dimensions, the eighteen tools, the critical
   * rule and the negative space.
   *
   * Available to a workspace that has traced nothing, because a team deciding
   * whether to turn tracing on should be able to read exactly what it will get
   * — and exactly what it will not — before it records a single step.
   */
  policy(workspaceId: string, userId: string): Result<TracePolicyView, TraceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok({
      ruleVersion: TRACE_RULE_VERSION,
      stages: TRACE_STAGES,
      outcomes: TRACE_OUTCOMES,
      statuses: TRACE_RUN_STATUSES,
      tools: TRACE_TOOLS,
      tracked: TRACE_TRACKED,
      criticalRule: TRACE_CRITICAL_RULE,
      neverDoes: TRACE_NEVER_DOES,
    });
  }

  /**
   * The recorded steps of one run, narrowed to this domain's vocabulary.
   *
   * Split out because three callers need it and each of them would otherwise
   * repeat the same "is this run readable" question.
   */
  private loadEvents(
    workspaceId: string,
    userId: string,
    runId: string,
  ): Result<readonly TraceEventView[], TraceError> {
    const rows = resultOr(
      this.repo.listAgentTraceEvents(workspaceId, userId, runId),
      "trace steps not found",
    );
    if (!rows.ok) return rows;
    return ok(sortTraceEvents(readable(rows.value)));
  }
}

/** Normalize an optional text field to `null` when absent or blank. */
function optionalText(value: string | undefined): string | null {
  const trimmed = text(value);
  return trimmed;
}

/**
 * Normalize an optional whole count.
 *
 * `null` means absent; the `undefined` sentinel is never returned, so a caller
 * distinguishes "not supplied" from "supplied and invalid" by comparing the
 * input to `undefined` itself.
 */
function optionalCount(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}
