import type { Result } from "@dealora/core";
import type {
  Account,
  AccountClaim,
  EntityId,
  Evidence,
  IsoDate,
  Qualification,
} from "@dealora/db";

/**
 * @dealora/qualification — Qualification Engine (DEALORA_BLUEPRINT.md §12.5,
 * ROADMAP.md §15).
 *
 * Answers one question: *does this account satisfy the criteria the business
 * itself defined?* The answer is a number, and the number is only ever the
 * output of this chain:
 *
 *   Business Brain (ICP) + Revenue Goal (window) + Plan (provenance)
 *     → Account claims → Phase 7 Evidence → criterion results → score
 *
 * What this package is not, stated once so every consumer inherits it:
 *
 *   - it is **not** a model opinion. Nothing here calls a language model, reads
 *     a prompt or asks an agent for a feeling. The same inputs always produce
 *     the same score, and the rule that produced it is named in every record
 *     (`ruleVersion`);
 *   - it is **not** an ICP of its own. There is no second ICP model and no
 *     copy of the Business Brain: this package *reads* the canonical
 *     `Icp`, and a qualification record stores the `icpId` plus a digest of
 *     the exact context used;
 *   - it **creates no evidence and modifies none**. A qualification never
 *     improves an account's position; it reads what research already
 *     established;
 *   - it **resolves no contradiction**. When two sources disagree about a
 *     claim, the criteria that depend on it are `unknown` and the evaluation
 *     is `contested`. The newest source does not win, the most confident
 *     source does not win, and no source is quietly preferred;
 *   - it **penalises no silence**. An account that has not been researched
 *     is `unknown`, which is a first-class outcome — never a pass, and never
 *     a failure;
 *   - it **personalizes nothing, contacts nobody and approves nothing**. A
 *     qualification result is an input to later phases (personalization,
 *     approval, prioritization) and is never their output.
 */

/** Domain error vocabulary, closed and safe to render. */
export type QualificationErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "UNAVAILABLE"
  /** The caller asked for a rule set this deployment does not implement. */
  | "UNSUPPORTED_RULE_VERSION";

export interface QualificationError {
  code: QualificationErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export function qualificationError(
  code: QualificationErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): QualificationError {
  return details ? { code, message, details } : { code, message };
}

export type {
  Account,
  AccountClaim,
  EntityId,
  Evidence,
  IsoDate,
  Qualification,
  QualificationCriterionOutcome,
  QualificationCriterionResult,
  QualificationDimension,
  QualificationDimensionResult,
  QualificationState,
  ResearchCategory,
  ResearchConfidence,
  ResearchFreshness,
} from "@dealora/db";

/**
 * The canonical ICP a qualification is measured against.
 *
 * A reference to the Business Brain record, not a copy of it. Only the fields
 * the rules actually read are carried, so a qualification can never smuggle
 * business context into its own model or drift away from the Brain it claims
 * to reflect.
 */
export interface QualificationIcpSnapshot {
  id: EntityId;
  industries: string[];
  companySizes: string[];
  geographies: string[];
  businessModels: string[];
  disqualifiers: string[];
}

/**
 * The Revenue Goal whose time window the timing criterion reads.
 *
 * Narrower than the goal record: qualification reads the window and nothing
 * else. The goal is *referenced*, never copied, and it is never inferred — an
 * account with no goal in its plan lineage gets an `unknown` timing criterion,
 * not an invented window.
 */
export interface QualificationGoalSnapshot {
  id: EntityId;
  /**
   * The goal's own tenant boundary.
   *
   * Carried so the service can prove the goal belongs to the workspace being
   * written into, instead of trusting a reader to have filtered it.
   */
  workspaceId: EntityId;
  timeWindow: { start: IsoDate; end: IsoDate };
}

/**
 * Storage the Qualification domain depends on.
 *
 * Declared as an interface so the domain never touches the JSON store
 * directly and a different driver can replace it without editing a line of
 * qualification logic. The claim and evidence reads are here because Phase 8
 * consumes Phase 7's records rather than any raw provider data: there is no
 * path from a research provider into a criterion result.
 */
export interface QualificationRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;

  /** Resolves through the caller's own authorization: a foreign account is not found. */
  getAccount(id: EntityId, userId: EntityId): Result<Account, { code: string }>;

  /** The account's claims, workspace-scoped. Retracted claims are included. */
  listAccountClaims(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
  ): Result<AccountClaim[], { code: string }>;

  /** The account's evidence, workspace-scoped. Every status is included. */
  listEvidence(
    workspaceId: EntityId,
    userId: EntityId,
    filter: { accountId: EntityId },
  ): Result<Evidence[], { code: string }>;

  createQualification(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    accountId: EntityId;
    qualification: Omit<
      Qualification,
      "id" | "workspaceId" | "accountId" | "createdBy" | "version" | "createdAt" | "updatedAt"
    >;
  }): Result<Qualification, { code: string }>;
  getQualification(id: EntityId, userId: EntityId): Result<Qualification, { code: string }>;
  listQualifications(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      state?: Qualification["state"];
      ruleVersion?: string;
    },
  ): Result<Qualification[], { code: string }>;
}

/**
 * Reads the canonical Business Brain ICP for one workspace.
 *
 * Always workspace-scoped and always authorized by the caller of the reader,
 * so a qualification can never be measured against another tenant's target.
 */
export type QualificationIcpReader = (
  workspaceId: EntityId,
  userId: EntityId,
) => QualificationIcpSnapshot | null;

/**
 * Reads one Revenue Goal through the caller's own authorization.
 *
 * Narrowed to a reader so the domain depends on the goal's shape rather than on
 * the goal service's whole surface.
 */
export type QualificationGoalReader = (
  goalId: EntityId,
  userId: EntityId,
) => Result<QualificationGoalSnapshot, { code: string }>;

/**
 * The plan an account was sourced against, narrowed to its provenance.
 *
 * Qualification needs to know *which goal* an account was sourced for, and
 * nothing else about the plan. A plan's strategies, KPIs and outreach policy are
 * never a criterion here, so the engine never reads them.
 */
export interface QualificationPlanSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  revenueGoalId: EntityId | null;
}

/**
 * Reads the plan an account was sourced against, when it has one.
 *
 * Used only to establish the account's provenance — which goal it was sourced
 * for. A plan is never a criterion and is never executed from here.
 */
export type QualificationPlanReader = (
  planId: EntityId,
  userId: EntityId,
) => Result<QualificationPlanSnapshot, { code: string }>;

/**
 * Injected clock.
 *
 * Only used to stamp `evaluatedAt` and `createdAt`. Evaluation itself reads no
 * clock, so the criterion results and the score are a pure function of the
 * account, its claims, its evidence, the ICP, the goal window and the rule
 * version.
 */
export type Clock = () => Date;
