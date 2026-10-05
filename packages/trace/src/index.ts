/**
 * @dealora/trace — the Phase 20 Agent Trace & Observability public surface.
 *
 * Importing this package gives a caller the seven stages `ROADMAP.md` §27's
 * chain names, the outcomes a step may report, the derivation that turns those
 * outcomes into a run's status, the engine that summarises what a run tracked,
 * and the service that records and reads traces.
 *
 * It does **not** give a caller a way to run an agent. There is no runner, no
 * dispatcher, no tool invoker, no model client, no queue and no network client
 * exported here, and no function in this package that performs anything. A
 * recorded `tool_call` step is a record that a tool was reported as invoked; it
 * is not an invocation, and the tool's own phase still runs its own
 * authorization.
 *
 * The one thing a caller cannot do is make a run look successful: the status is
 * derived from the recorded outcomes, and no exported function accepts a status.
 */

export type {
  TraceCostSummary,
  TraceError,
  TraceErrorCode,
  TraceEventRow,
  TraceEventView,
  TraceOutcome,
  TracePolicyView,
  TraceRepository,
  TraceRunRow,
  TraceRunStatus,
  TraceRunStatusDefinition,
  TraceRunSummary,
  TraceStage,
  TraceStageCounts,
  TraceStageDefinition,
  TraceStorageResult,
  TraceTerminalStatus,
  TraceUsageSummary,
  TraceView,
  TrackedDimension,
} from "./types.js";

export {
  TRACE_CRITICAL_RULE,
  TRACE_NEVER_DOES,
  TRACE_OUTCOMES,
  TRACE_RULE_VERSION,
  TRACE_RUN_STATUSES,
  TRACE_STAGES,
  TRACE_TOOLS,
  TRACE_TRACKED,
  isTerminalStatus,
  isTraceOutcome,
  isTraceRunStatus,
  isTraceStage,
  isTraceTool,
  stageDefinition,
  stageOrder,
  traceError,
} from "./rules.js";

export {
  deriveStageCounts,
  deriveTraceCost,
  deriveTraceStatus,
  deriveUsageSummary,
  outcomesOf,
  publishedOutcomes,
  publishedStageOrder,
  sortTraceEvents,
  sortTraceRuns,
  statusDerivationRule,
  statusesAgree,
} from "./engine.js";

export { TraceService } from "./service.js";
export type { EventInput } from "./service.js";

export type { TraceLookup } from "./factory.js";
export { createTraceService } from "./factory.js";
