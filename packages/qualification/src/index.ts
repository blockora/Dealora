/**
 * @dealora/qualification — Qualification Engine (DEALORA_BLUEPRINT.md §12.5,
 * ROADMAP.md §15).
 *
 * Deterministic, evidence-backed scoring of an account against the criteria
 * the workspace itself defined, with every score carrying a reason, its
 * evidence and a confidence.
 *
 * A qualification is decision support. It is not personalization, not
 * outreach, not an approval and not an autonomous action: nothing here sends,
 * writes to a CRM, books a meeting or creates an opportunity.
 */
export {
  QualificationService,
  type EvaluateOptions,
  type QualificationInspection,
} from "./service.js";

export { evaluateQualification } from "./evaluator.js";
export type { QualificationEvaluation, QualificationEvaluationInput } from "./evaluator.js";

export {
  LIMITS,
  QUALIFICATION_CRITERIA,
  QUALIFICATION_DIMENSIONS,
  QUALIFICATION_DIMENSION_LABELS,
  QUALIFICATION_DIMENSION_PURPOSES,
  QUALIFICATION_RULE_VERSION,
  SUPPORTED_RULE_VERSIONS,
  contextDigest,
  icpTerms,
  matchesTerm,
  normalizeForMatch,
  renderExpectation,
} from "./rules.js";
export type { CriterionKind, CriterionRule, IcpList, QualificationDimensionName } from "./rules.js";

export {
  QUALIFICATIONS_ARE_IMMUTABLE,
  QualificationIssues,
  describeCriteria,
  isQualificationDimension,
  isQualificationState,
  isSupportedRuleVersion,
  text,
} from "./validation.js";
export type { QualificationCriteriaView } from "./validation.js";

export { qualificationError } from "./types.js";
export type {
  Account,
  AccountClaim,
  Clock,
  EntityId,
  Evidence,
  IsoDate,
  Qualification,
  QualificationCriterionOutcome,
  QualificationCriterionResult,
  QualificationDimension,
  QualificationDimensionResult,
  QualificationError,
  QualificationErrorCode,
  QualificationGoalReader,
  QualificationGoalSnapshot,
  QualificationIcpReader,
  QualificationIcpSnapshot,
  QualificationPlanReader,
  QualificationPlanSnapshot,
  QualificationRepository,
  QualificationState,
  ResearchCategory,
  ResearchConfidence,
  ResearchFreshness,
} from "./types.js";

/**
 * Convenience factory wiring the Qualification service to the concrete
 * repository. Application code may construct the service with any
 * {@link QualificationRepository}, which keeps the domain decoupled from
 * storage.
 */
export {
  createQualificationService,
  toGoalSnapshot,
  toIcpSnapshot,
  toPlanReader,
  toPlanSnapshot,
} from "./factory.js";
