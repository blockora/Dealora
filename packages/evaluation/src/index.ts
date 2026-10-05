/**
 * @dealora/evaluation — the Phase 19 Agent Evaluation public surface.
 *
 * Importing this package gives a caller the thirteen published metrics, the
 * engine that measures them from recorded judgements, the service that records
 * and reads them, and the resolver that answers `@dealora/agent`'s production
 * gate.
 *
 * It does not give a caller a way to run an agent: there is no runner, no
 * dispatcher, no tool invoker, no model client and no network client exported
 * here. Satisfying the gate permits one governance transition in the registry
 * and nothing else — `MEETABLE_AGENT_STATES` is still empty, so an agent in
 * `production` still executes nothing.
 */

export type {
  EvaluationCostBreakdown,
  EvaluationError,
  EvaluationErrorCode,
  EvaluationGateDecision,
  EvaluationLatencyBreakdown,
  EvaluationMetricKind,
  EvaluationMetricResult,
  EvaluationMetricRule,
  EvaluationObservationRow,
  EvaluationObservationView,
  EvaluationPolicyView,
  EvaluationReport,
  EvaluationRepository,
  EvaluationRunRow,
  EvaluationRunSummary,
  EvaluationRunView,
  EvaluationStatus,
  EvaluationStorageResult,
  EvaluationVerdict,
  EvaluationVerdictCounts,
} from "./types.js";

export {
  BASIS_POINT_SCALE,
  EVALUATION_GATE_RULE,
  EVALUATION_MEASURED_METRICS,
  EVALUATION_METRICS,
  EVALUATION_NEVER_DOES,
  EVALUATION_RULE_VERSION,
  EVALUATION_VERDICTS,
  LATENCY_CEILING_MS,
  RATE_MINIMUM_SAMPLE,
  evaluationError,
  isEvaluationMetric,
  isEvaluationVerdict,
  isMeasuredMetric,
  metricOrder,
  metricRule,
} from "./rules.js";

export {
  deriveEvaluationReport,
  deriveGateDecision,
  deriveReportStatus,
  latestRun,
  measureCost,
  measureLatency,
  measureMetric,
  measureRate,
  sortObservations,
  sortRuns,
} from "./engine.js";

export { EvaluationService } from "./service.js";
export type { ObservationInput } from "./service.js";

export type { EvaluationLookup } from "./factory.js";
export { createEvaluationService, createProductionGate } from "./factory.js";
