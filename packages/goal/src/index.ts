/** @dealora/goal — the Revenue Goal Engine: structured, validated revenue outcomes. */
export { RevenueGoalService } from "./service.js";
export type { GoalRepository, GoalBusinessContext, CreateGoalInput } from "./service.js";

export { DeterministicGoalParser, deterministicGoalParser, toBrainSnapshot } from "./parser.js";

export {
  goalError,
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  METRIC_UNITS,
  LIMITS,
  FieldIssues,
  assessCompleteness,
  assertTransition,
  isValidCurrency,
  isValidIsoDate,
  isValidMetricTarget,
  isValidTimeWindow,
  validateGoalCore,
} from "./validation.js";
export type { Gap } from "./validation.js";

export type {
  GoalDraft,
  GoalDraftField,
  GoalError,
  GoalErrorCode,
  GoalFieldOrigin,
  GoalParser,
  BusinessBrainSnapshot,
  GoalCompleteness,
  GoalMetricKind,
  RevenueGoal,
  RevenueGoalStatus,
} from "./types.js";

/**
 * Convenience factory binding the goal service to the deterministic parser
 * and the default store. Tests construct the service directly with an
 * isolated store and an alternative parser.
 */
export { createRevenueGoalService } from "./factory.js";
