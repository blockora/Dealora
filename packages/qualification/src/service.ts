import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type { Account, AccountClaim, EntityId, Evidence, Qualification } from "@dealora/db";

import { evaluateQualification } from "./evaluator.js";
import type { QualificationEvaluation } from "./evaluator.js";
import {
  QUALIFICATION_CRITERIA,
  QUALIFICATION_RULE_VERSION,
  SUPPORTED_RULE_VERSIONS,
  contextDigest,
  renderExpectation,
} from "./rules.js";
import { describeCriteria, isQualificationState, isSupportedRuleVersion } from "./validation.js";
import type { QualificationCriteriaView } from "./validation.js";
import type {
  Clock,
  QualificationError,
  QualificationGoalReader,
  QualificationGoalSnapshot,
  QualificationIcpReader,
  QualificationIcpSnapshot,
  QualificationPlanReader,
  QualificationRepository,
} from "./types.js";
import { qualificationError } from "./types.js";

export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";
export { evaluateQualification } from "./evaluator.js";
export type { QualificationEvaluation, QualificationEvaluationInput } from "./evaluator.js";

function fromStorage(code: string, fallback: string): QualificationError {
  switch (code) {
    case "NOT_FOUND":
      return qualificationError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return qualificationError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return qualificationError("CONFLICT", fallback);
    case "INVALID":
      return qualificationError("VALIDATION_ERROR", fallback);
    default:
      // Never surface an internal storage message.
      return qualificationError("UNAVAILABLE", "storage unavailable");
  }
}

/** What the caller may influence: never the result, only the context. */
export interface EvaluateOptions {
  /** Which of the workspace's goals supplies the timing window. */
  revenueGoalId?: unknown;
  /** Which rule set to evaluate under. Validated against what we implement. */
  ruleVersion?: unknown;
}

/** A qualification together with the records that explain it. */
export interface QualificationInspection {
  qualification: Qualification;
  /** The full claim records every criterion referenced. */
  claims: AccountClaim[];
  /** The full evidence records every criterion referenced. */
  evidence: Evidence[];
}

/**
 * The Qualification Engine application service.
 *
 * Responsibilities:
 * - Authorize every call against the server-side identity.
 * - Resolve the account, the canonical ICP and the Revenue Goal server-side, so
 *   a caller can select *which of its own* context to measure against but can
 *   never supply the criteria, the outcome or the score.
 * - Evaluate through the pure evaluator and persist the result as a new,
 *   versioned, immutable record.
 * - Keep a historical result readable after the rules or the ICP move on.
 *
 * It makes no personalization decision, contacts nobody, approves nothing and
 * creates no opportunity. `ROADMAP.md` §15 calls a score a decision aid, and a
 * decision aid that acted on its own decision would not be one.
 */
export class QualificationService {
  constructor(
    private readonly repo: QualificationRepository,
    private readonly icp: QualificationIcpReader,
    private readonly goals: QualificationGoalReader,
    private readonly plans: QualificationPlanReader,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, QualificationError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(qualificationError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(qualificationError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * The canonical ICP, or an explicit refusal.
   *
   * There is no default ICP and no criteria of last resort. If the workspace
   * has not said what it sells to, qualification is undefined rather than
   * quietly measured against DEALORA's assumptions about a good account.
   */
  private requireIcp(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<QualificationIcpSnapshot, QualificationError> {
    let snapshot: QualificationIcpSnapshot | null;
    try {
      snapshot = this.icp(workspaceId, userId);
    } catch {
      return err(qualificationError("UNAVAILABLE", "business context unavailable"));
    }
    if (snapshot === null) {
      return err(
        qualificationError("NOT_FOUND", "this workspace has no icp to qualify accounts against", [
          { field: "icpId", message: "define an icp before qualifying an account" },
        ]),
      );
    }
    return ok(snapshot);
  }

  /**
   * Load an account and prove it belongs to the caller's workspace.
   *
   * The lookup itself is authorized, so another tenant's account is simply not
   * found; the equality check is the belt to those braces.
   */
  private requireAccount(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
  ): Result<Account, QualificationError> {
    if (!accountId || typeof accountId !== "string") {
      return err(
        qualificationError("VALIDATION_ERROR", "account id is required", [
          { field: "accountId", message: "accountId must be a string" },
        ]),
      );
    }
    const found = this.repo.getAccount(accountId, userId);
    if (!found.ok) {
      // A foreign account is not revealed to exist.
      return err(
        qualificationError("NOT_FOUND", "account not found", [
          { field: "accountId", message: "the account does not exist in this workspace" },
        ]),
      );
    }
    if (found.value.workspaceId !== workspaceId) {
      return err(qualificationError("UNAUTHORIZED", "workspace access denied"));
    }
    if (found.value.status === "archived") {
      return err(
        qualificationError("CONFLICT", "this account is archived and is no longer a target", [
          { field: "accountId", message: "an archived account cannot be qualified" },
        ]),
      );
    }
    return ok(found.value);
  }

  /** Only a rule set this deployment implements may be asked for. */
  private requireRuleVersion(requested: unknown): Result<string, QualificationError> {
    if (requested === undefined || requested === null || requested === "") {
      return ok(QUALIFICATION_RULE_VERSION);
    }
    if (!isSupportedRuleVersion(requested)) {
      return err(
        qualificationError(
          "UNSUPPORTED_RULE_VERSION",
          "that qualification rule version is not supported",
          [
            {
              field: "ruleVersion",
              message: `ruleVersion must be one of: ${QUALIFICATION_RULE_VERSION}`,
            },
          ],
        ),
      );
    }
    return ok(requested);
  }

  /**
   * Resolve the goal whose window the timing criterion reads.
   *
   * Precedence: a goal the caller named, validated to belong to the workspace;
   * otherwise the goal of the plan this account was sourced against. When
   * neither exists the window is `null` and the timing criterion stays
   * unresolved — a goal is never inferred from a market name or a date range
   * typed into a request.
   */
  private resolveGoal(
    workspaceId: EntityId,
    userId: EntityId,
    account: Account,
    requested: unknown,
  ): Result<QualificationGoalSnapshot | null, QualificationError> {
    const read = (goalId: EntityId): Result<QualificationGoalSnapshot, QualificationError> => {
      const loaded = this.goals(goalId, userId);
      if (!loaded.ok) {
        return err(
          loaded.error.code === "UNAUTHORIZED"
            ? qualificationError("NOT_FOUND", "revenue goal not found", [
                { field: "revenueGoalId", message: "no such revenue goal in this workspace" },
              ])
            : fromStorage(loaded.error.code, "revenue goal not found"),
        );
      }
      // The goal must belong to the workspace being written into, even if the
      // reader returned it: authorization never rests on the caller alone.
      if (loaded.value.workspaceId !== workspaceId) {
        return err(qualificationError("NOT_FOUND", "revenue goal not found"));
      }
      return ok(loaded.value);
    };

    if (requested !== undefined && requested !== null && requested !== "") {
      if (typeof requested !== "string") {
        return err(
          qualificationError("VALIDATION_ERROR", "revenueGoalId must be a string", [
            { field: "revenueGoalId", message: "revenueGoalId must be a string" },
          ]),
        );
      }
      return read(requested);
    }

    if (account.revenuePlanId === null) return ok(null);
    const plan = this.plans(account.revenuePlanId, userId);
    // A plan that has gone missing is not an error: the account simply has no
    // goal context, and the timing criterion says so.
    if (!plan.ok || plan.value.workspaceId !== workspaceId || plan.value.revenueGoalId === null) {
      return ok(null);
    }
    return read(plan.value.revenueGoalId);
  }

  /**
   * The criteria this workspace would be measured against, before any account
   * is evaluated.
   *
   * The point of exposing this is inspectability: a user can read the exact
   * rules and the exact ICP terms their accounts will be measured against,
   * rather than discovering them from a score.
   */
  describeQualificationCriteria(
    workspaceId: EntityId,
    userId: EntityId,
    requested?: { ruleVersion?: unknown },
  ): Result<QualificationCriteriaView, QualificationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const ruleVersion = this.requireRuleVersion(requested?.ruleVersion);
    if (!ruleVersion.ok) return ruleVersion;
    const icp = this.requireIcp(workspaceId, userId);
    if (!icp.ok) return icp;

    const expectations = new Map<string, string>();
    for (const rule of QUALIFICATION_CRITERIA) {
      // The timing expectation is stated without a goal here, because no
      // account is being measured: it names the requirement, not a window.
      expectations.set(rule.criterion, renderExpectation(rule, icp.value, null));
    }
    return ok(describeCriteria({ ruleVersion: ruleVersion.value, expectations }));
  }

  /**
   * Evaluate one account and persist the result as a new version.
   *
   * The full precondition chain runs before anything is read for judgement:
   * authenticate → authorize → rule version → ICP → account → goal → claims and
   * evidence → evaluate → persist.
   *
   * Nothing about the outcome is accepted from the caller. `options` chooses
   * *which of the workspace's own* goal and rule set to measure against; the
   * score, the state, every criterion result and every confidence come from the
   * evaluator alone.
   */
  evaluateAccount(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    options?: EvaluateOptions,
  ): Result<Qualification, QualificationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const ruleVersion = this.requireRuleVersion(options?.ruleVersion);
    if (!ruleVersion.ok) return ruleVersion;
    const icp = this.requireIcp(workspaceId, userId);
    if (!icp.ok) return icp;
    const account = this.requireAccount(workspaceId, userId, accountId);
    if (!account.ok) return account;
    const goal = this.resolveGoal(workspaceId, userId, account.value, options?.revenueGoalId);
    if (!goal.ok) return goal;

    const claims = this.repo.listAccountClaims(workspaceId, userId, account.value.id);
    if (!claims.ok) return err(fromStorage(claims.error.code, "account claims unavailable"));
    const evidence = this.repo.listEvidence(workspaceId, userId, { accountId: account.value.id });
    if (!evidence.ok) return err(fromStorage(evidence.error.code, "evidence unavailable"));

    const evaluation: QualificationEvaluation = evaluateQualification({
      accountId: account.value.id,
      icp: icp.value,
      goal: goal.value,
      claims: claims.value,
      evidence: evidence.value,
    });

    const created = this.repo.createQualification({
      workspaceId,
      createdBy: userId,
      accountId: account.value.id,
      qualification: {
        ruleVersion: ruleVersion.value,
        revenuePlanId: account.value.revenuePlanId,
        revenueGoalId: goal.value?.id ?? null,
        icpId: icp.value.id,
        // A fingerprint of the exact context used, never a copy of the Brain.
        contextDigest: contextDigest(ruleVersion.value, icp.value, goal.value),
        state: evaluation.state,
        score: evaluation.score,
        confidence: evaluation.confidence,
        reason: evaluation.reason,
        evidenceIds: evaluation.evidenceIds,
        claimIds: evaluation.claimIds,
        conflictedClaimIds: evaluation.conflictedClaimIds,
        dimensions: evaluation.dimensions,
        // The only use of the clock: when this evaluation was taken.
        evaluatedAt: this.clock().toISOString(),
      },
    });
    if (!created.ok) {
      return err(fromStorage(created.error.code, "qualification creation failed"));
    }
    return ok(created.value);
  }

  getQualification(id: EntityId, userId: EntityId): Result<Qualification, QualificationError> {
    if (!id || typeof id !== "string") {
      return err(qualificationError("VALIDATION_ERROR", "qualification id is required"));
    }
    const found = this.repo.getQualification(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "qualification not found"));
    return ok(found.value);
  }

  /**
   * A workspace's evaluations, newest first.
   *
   * Nothing is filtered out by default: every version stays listable, because a
   * trail that hides the superseded half is not a trail.
   */
  listQualifications(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId; state?: unknown; ruleVersion?: unknown },
  ): Result<Qualification[], QualificationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.state !== undefined && filter.state !== null && filter.state !== "") {
      if (!isQualificationState(filter.state)) {
        return err(
          qualificationError("VALIDATION_ERROR", "invalid qualification state filter", [
            {
              field: "state",
              message: "state must be one of: qualified, unqualified, insufficient_data, contested",
            },
          ]),
        );
      }
    }
    if (
      filter?.ruleVersion !== undefined &&
      filter.ruleVersion !== null &&
      filter.ruleVersion !== ""
    ) {
      if (!isSupportedRuleVersion(filter.ruleVersion)) {
        return err(
          qualificationError(
            "UNSUPPORTED_RULE_VERSION",
            "that qualification rule version is not supported",
            [
              {
                field: "ruleVersion",
                message: `ruleVersion must be one of: ${QUALIFICATION_RULE_VERSION}`,
              },
            ],
          ),
        );
      }
    }
    const narrowed: {
      accountId?: EntityId;
      state?: Qualification["state"];
      ruleVersion?: string;
    } = {};
    if (filter?.accountId) narrowed.accountId = filter.accountId;
    if (isQualificationState(filter?.state)) narrowed.state = filter.state;
    if (isSupportedRuleVersion(filter?.ruleVersion)) narrowed.ruleVersion = filter.ruleVersion;

    const listed = this.repo.listQualifications(
      workspaceId,
      userId,
      Object.keys(narrowed).length > 0 ? narrowed : undefined,
    );
    if (!listed.ok) return err(fromStorage(listed.error.code, "qualifications unavailable"));
    return ok(listed.value);
  }

  /**
   * Why an account received a score: the evaluation, plus the claim and
   * evidence records each criterion actually read.
   *
   * This is the phase's gate — "a user can inspect why an account received a
   * score" — served in one read. The records are joined from storage, not
   * copied into the qualification, so the stored evaluation stays small and the
   * sources stay the single source of truth.
   */
  inspectQualification(
    id: EntityId,
    userId: EntityId,
  ): Result<QualificationInspection, QualificationError> {
    const found = this.getQualification(id, userId);
    if (!found.ok) return found;
    const record = found.value;

    const claims = this.repo.listAccountClaims(record.workspaceId, userId, record.accountId);
    if (!claims.ok) return err(fromStorage(claims.error.code, "account claims unavailable"));
    const evidence = this.repo.listEvidence(record.workspaceId, userId, {
      accountId: record.accountId,
    });
    if (!evidence.ok) return err(fromStorage(evidence.error.code, "evidence unavailable"));

    // Only what the evaluation actually read, so the view cannot imply that
    // evidence exists which the decision did not rest on.
    const claimIds = new Set(record.claimIds);
    const evidenceIds = new Set(record.evidenceIds);
    return ok({
      qualification: record,
      claims: claims.value.filter((claim) => claimIds.has(claim.id)),
      evidence: evidence.value.filter((item) => evidenceIds.has(item.id)),
    });
  }

  /** Every rule version this deployment can evaluate under. */
  static supportedRuleVersions(): readonly string[] {
    return SUPPORTED_RULE_VERSIONS;
  }
}
