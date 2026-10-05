/**
 * @dealora/trace — the published rule set for Phase 20.
 *
 * Every vocabulary §27 and `DEALORA_BLUEPRINT.md` §32/§69/§70 imply is
 * declared **once**, here, and every validator, the policy route, the trace
 * ordering and the tests are derived from these arrays. That is the only way a
 * stage or outcome can be advertised without being enforceable: if a value is
 * not in this file, it cannot be validated, so it cannot be stored, so it
 * cannot be printed.
 *
 * Three properties hold throughout:
 *
 * 1. **The chain is the roadmap's, in the roadmap's order.** `TRACE_STAGES` is
 *    agent → decision → tool call → evidence → result → approval → external
 *    action, exactly as §27 prints it, and it is also this package's sort key.
 * 2. **Nothing here runs anything.** The stage named `tool_call` names a step
 *    somebody reported, and the tool it may cite is read from `@dealora/agent`'s
 *    declared vocabulary rather than restated, so a trace cannot cite a tool no
 *    agent may use and there is still one list of what a tool is.
 * 3. **The critical rule is a value, not a sentence.** `TRACE_CRITICAL_RULE`
 *    names what is refused; `deriveTraceStatus` in `engine.ts` is what enforces
 *    it. `TRACE_NEVER_DOES` records the negative space so a reader can check it
 *    without reading a derivation.
 */

import { AGENT_TOOLS } from "@dealora/agent";

import type {
  TraceError,
  TraceErrorCode,
  TraceOutcome,
  TraceRunStatus,
  TraceRunStatusDefinition,
  TraceStage,
  TraceStageDefinition,
  TrackedDimension,
} from "./types.js";

/** Bumped with the tables below; every trace states the version it used. */
export const TRACE_RULE_VERSION = "trace-1.0.0";

/**
 * The seven steps of `ROADMAP.md` §27's chain, in order.
 *
 * This array is the report's **total order**: the trail, the stage counts and
 * the policy route all print in exactly this sequence, so "ordered by stage"
 * never has to mean anything and a stage with no steps is still visible as zero
 * rather than missing.
 */
export const TRACE_STAGES: readonly TraceStageDefinition[] = [
  {
    stage: "agent",
    position: 0,
    meaning:
      "A named agent began or finished a unit of work. `DEALORA_BLUEPRINT.md` §32 opens its example trace with `Strategy Agent created plan`.",
    mayNameTool: false,
    mayCarryDuration: true,
  },
  {
    stage: "decision",
    position: 1,
    meaning:
      "The agent chose between options it had. Recorded as a step with its own outcome, so a decision nobody could complete reads as `unknown` rather than as never having been made.",
    mayNameTool: false,
    mayCarryDuration: true,
  },
  {
    stage: "tool_call",
    position: 2,
    meaning:
      "A capability some other phase already owns was invoked. `ROADMAP.md` §27 tracks tool calls, and the tool must be one of the eighteen `ROADMAP.md` §25's declarations name — this phase records the invocation, it does not perform one.",
    mayNameTool: true,
    mayCarryDuration: true,
  },
  {
    stage: "evidence",
    position: 3,
    meaning:
      "A source-backed record was read or written, named by id. A trace **references** Phase 7's evidence and never copies it, promotes it or writes to it.",
    mayNameTool: false,
    mayCarryDuration: true,
  },
  {
    stage: "result",
    position: 4,
    meaning:
      "The run produced an answer or an artefact. This is the step that carries the run's work product, and the one whose absence keeps a run from claiming success.",
    mayNameTool: false,
    mayCarryDuration: true,
  },
  {
    stage: "approval",
    position: 5,
    meaning:
      "A person was asked to decide, and what they decided. Phase 10 owns the approval itself; this step records that the run reached the human and what came back.",
    mayNameTool: false,
    mayCarryDuration: true,
  },
  {
    stage: "external_action",
    position: 6,
    meaning:
      "Something left the system, or was intended to. `ROADMAP.md` §27's last tracked step and the one its critical rule is about: an action whose outcome nobody confirmed is recorded `unknown`, never `succeeded`.",
    mayNameTool: false,
    mayCarryDuration: true,
  },
];

/** The three recorded outcomes, in the order every report prints them. */
export const TRACE_OUTCOMES: readonly TraceOutcome[] = ["succeeded", "failed", "unknown"];

/**
 * The five run statuses, with exactly what each one asserts.
 *
 * This table is the readable form of `deriveTraceStatus`. It is published rather
 * than kept inside the derivation so a caller can answer "what does `unknown`
 * actually mean?" without reading the function, and so the reason a run closed
 * a particular way is always one sentence rather than a re-derivation.
 */
export const TRACE_RUN_STATUSES: readonly TraceRunStatusDefinition[] = [
  {
    status: "open",
    terminal: false,
    meaning:
      "The run is still accepting steps and has recorded no verdict. This asserts nothing about the run's outcome.",
  },
  {
    status: "succeeded",
    terminal: true,
    meaning:
      "At least one step reported `succeeded` and no step reported `failed` or `unknown`. A recorder asserted this by recording an outcome; no caller may assert it directly.",
  },
  {
    status: "failed",
    terminal: true,
    meaning:
      "At least one step reported `failed`. One failure outranks every success, so a run that mostly worked and then broke is never reported as succeeded.",
  },
  {
    status: "unknown",
    terminal: true,
    meaning:
      "Nothing failed, but at least one step reported `unknown`. Something may or may not have happened, and this trace declines to say which.",
  },
  {
    status: "unverified",
    terminal: true,
    meaning:
      "The run was closed with no step that reported any outcome at all. This is what makes §27's critical rule structural: closing an empty trace cannot produce a success.",
  },
];

/**
 * The nine things `ROADMAP.md` §27 says to track, each with the column it is
 * derived from.
 *
 * Published as data so the policy route can answer "does this phase track
 * cost?" without a reader tracing a derivation, and so a dimension that cannot
 * be tracked would have to be removed from this table rather than quietly
 * missing from a report.
 */
export const TRACE_TRACKED: readonly TrackedDimension[] = [
  {
    dimension: "execution time",
    source:
      "each step's reported `durationMs`; the trace reports the slowest step, never a sum, because steps in one run may overlap.",
  },
  {
    dimension: "model usage",
    source: "each step's reported `modelProvider` and `modelName`, and how many steps named one.",
  },
  {
    dimension: "token usage",
    source:
      "each step's reported `inputTokens` and `outputTokens`, summed exactly and never estimated here.",
  },
  {
    dimension: "tool calls",
    source:
      "each `tool_call` step's tool name, checked against the eighteen tools `ROADMAP.md` §25 declares.",
  },
  {
    dimension: "errors",
    source:
      "each step's `outcome: failed` and optional `errorCode`, counted rather than summarised away.",
  },
  {
    dimension: "retries",
    source:
      "storage's `attempt` number: a second event for the same `stepId` is a retry, derived from stored rows and never sent by a caller.",
  },
  {
    dimension: "approvals",
    source: "`approval` steps and how many of them reported `succeeded`.",
  },
  {
    dimension: "external actions",
    source:
      "`external_action` steps, counted separately from successes because an unconfirmed action is not a delivery.",
  },
  {
    dimension: "cost",
    source:
      "`ROADMAP.md` §27 requires cost, so this phase attributes cost to a run through Phase 16's own immutable `cost_events` rows under the `agent_run` execution kind, and totals them with `@dealora/cost`'s published derivation. It creates no second cost table and computes no second total.",
  },
];

/**
 * The tools a `tool_call` step may name.
 *
 * Read from `@dealora/agent` rather than restated, so the eighteen names have
 * exactly one owner and a tool Phase 20 has never heard of cannot be cited in a
 * trace. This is a genuine domain check rather than a formality: it means a
 * trace cannot claim an agent reached for a capability no declaration grants.
 */
export const TRACE_TOOLS: readonly string[] = AGENT_TOOLS.map((tool) => tool.tool);

/** `ROADMAP.md` §27's critical rule, stated in this phase's own words. */
export const TRACE_CRITICAL_RULE =
  "ROADMAP.md §27: never silently pretend an action succeeded. A traced run's status is derived in storage from the outcomes its own recorded steps carry; no request, body or route may supply one. A run with a `failed` step is failed, a run with an `unknown` step is unknown, a run with no outcome at all is unverified, and only a run with at least one `succeeded` step and no `failed` or `unknown` step reads as succeeded. An external action a provider never confirmed is recorded `unknown`, because reporting it as either a delivery or a failure would be a claim nobody made.";

/** What this phase refuses to do, in its own words. */
export const TRACE_NEVER_DOES: readonly string[] = [
  "Never executes an agent: there is no runner, dispatcher, loop, scheduler, queue or worker in this package.",
  "Never invokes a tool: a `tool_call` step records that a tool was reported as invoked, and this phase calls nothing.",
  "Never opens a model client: provider and model names are reported usage copied from whatever reported them, and no provider is imported.",
  "Never reaches a network, an email client, a calendar, a CRM or a browser.",
  "Never records a success nobody reported: the run's status is derived from recorded outcomes, and an absent outcome is `unverified` rather than `succeeded`.",
  "Never edits or deletes a step: runs and steps are append-only, a closed run accepts nothing further, and the only way to change what a run says is to open another run.",
  "Never trusts a caller for an ordering key: `sequence` and `attempt` are allocated in storage, so two steps recorded in the same millisecond still have one defined order.",
  "Never crosses a workspace: every read and write is workspace-scoped with the caller's own identity and re-checked inside storage.",
  "Never opens a trace for an agent this workspace has not put in `production`: `ROADMAP.md` §27 scopes the trace to production workflows, and reaching that state still requires Phase 19's evaluation gate to have been satisfied.",
  "Never writes an evaluation judgement: Phase 19 owns evaluation, and a trace is not evidence and is never converted into one.",
  "Never computes a cost total of its own: the total comes from Phase 16's immutable facts through `@dealora/cost`'s published derivation.",
  "Never uses the clock to decide anything: steps are ordered by a server-derived sequence, so the same recorded rows always produce the same trace.",
];

const STAGE_BY_NAME = new Map<string, TraceStageDefinition>();
for (const definition of TRACE_STAGES) {
  STAGE_BY_NAME.set(definition.stage, definition);
}

const OUTCOME_SET: ReadonlySet<string> = new Set(TRACE_OUTCOMES);
const STATUS_SET: ReadonlySet<string> = new Set(TRACE_RUN_STATUSES.map((entry) => entry.status));
const TOOL_SET: ReadonlySet<string> = new Set(TRACE_TOOLS);

/** The published definition for one stage, or `null` when it is not one of the seven. */
export function stageDefinition(stage: string): TraceStageDefinition | null {
  return STAGE_BY_NAME.get(stage) ?? null;
}

/** Whether a string names one of the seven published stages. */
export function isTraceStage(value: string): value is TraceStage {
  return STAGE_BY_NAME.has(value);
}

/** Whether a string names one of the three recorded outcomes. */
export function isTraceOutcome(value: string): value is TraceOutcome {
  return OUTCOME_SET.has(value);
}

/** Whether a string names one of the five run statuses. */
export function isTraceRunStatus(value: string): value is TraceRunStatus {
  return STATUS_SET.has(value);
}

/** Whether a string names one of the eighteen declared agent tools. */
export function isTraceTool(value: string): boolean {
  return TOOL_SET.has(value);
}

/**
 * A stage's position in the published chain.
 *
 * The sort key for every stage-ordered list, so the trail never has to mean
 * anything by "stage order" and an unknown value cannot sort to an arbitrary
 * place — it sorts to `-1`, ahead of the chain, which is what a value this
 * build does not publish should look like rather than hiding at the end.
 */
export function stageOrder(stage: string): number {
  const definition = STAGE_BY_NAME.get(stage);
  return definition === undefined ? -1 : definition.position;
}

/** Whether a run status is one of the four terminal values. */
export function isTerminalStatus(status: TraceRunStatus): boolean {
  return status !== "open";
}

/** Construct a domain error, keeping field details when there are any. */
export function traceError(
  code: TraceErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): TraceError {
  return details && details.length > 0 ? { code, message, details } : { code, message };
}
