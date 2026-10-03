/**
 * @dealora/plan — the Revenue Plan Compiler.
 *
 * Compiles a RevenueGoal into an inspectable RevenuePlan: structured,
 * evidence-aware, deterministic, versioned and workspace-isolated. It produces
 * a proposal and never performs an external action.
 */
export { RevenuePlanService } from "./service.js";
export type { GoalReader, PlanBrainReader, PlanRepository } from "./service.js";

export { planError } from "./types.js";
export type {
  PlanBasis,
  PlanBrainSnapshot,
  PlanCompileInput,
  PlanError,
  PlanErrorCode,
  PlanStatement,
  PlanStatementKind,
  RevenueGoal,
  RevenuePlan,
  RevenuePlanApproval,
  RevenuePlanCompiler,
  RevenuePlanDraft,
  RevenuePlanStatus,
  RevenuePlanStrategies,
} from "./types.js";

export {
  DETERMINISTIC_COMPILER_VERSION,
  DeterministicPlanCompiler,
  brainSnapshotDigest,
  collectStatements,
  deterministicPlanCompiler,
} from "./compiler.js";

export {
  PLAN_STATEMENT_KINDS,
  PLAN_STATUSES,
  PLAN_TRANSITIONS,
  PlanIssues,
  REQUIRED_SECTIONS,
  assertGoalCompilable,
  assertPlanTransition,
  statementsOf,
  validatePlanDraft,
} from "./validation.js";

/**
 * Convenience factory wiring the Revenue Plan service to the concrete
 * repository. Application code may construct the service with any
 * {@link PlanRepository} implementation, which keeps the domain decoupled from
 * storage.
 */
export { createRevenuePlanService } from "./factory.js";
