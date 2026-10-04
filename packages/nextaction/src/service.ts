import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";

import { recommendNextAction } from "./engine.js";
import { BOARD_LIMIT, NEXT_ACTION_RULE_VERSION, nextActionError } from "./rules.js";
import { describeNextActionPolicy, parseActionFilter, text } from "./validation.js";
import type {
  AccountIndexReader,
  AccountStateReader,
  NextActionBoard,
  NextActionError,
  NextActionPolicyView,
  NextActionRecommendation,
  NextActionRepository,
  NextBestAction,
  RecommendNextActionInput,
} from "./types.js";

export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";
export { decideNextActionState, recommendNextAction } from "./engine.js";

/**
 * Map a storage code onto a domain code.
 *
 * `INVALID` becomes `VALIDATION_ERROR`, because storage refuses a write here only
 * when the recommendation contradicts itself — an `approvalRequired` that
 * disagrees with its own §17 risk level, or a blank reason. That is a defect in
 * what DEALORA produced, never something the caller sent, so it is reported as an
 * internal condition rather than blamed on the request.
 */
function fromStorage(code: string, fallback: string): NextActionError {
  switch (code) {
    case "NOT_FOUND":
      return nextActionError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return nextActionError("UNAUTHORIZED", "workspace access denied");
    case "INVALID":
      return nextActionError("UNAVAILABLE", "the recommendation could not be stored");
    default:
      // Never surface an internal storage message.
      return nextActionError("UNAVAILABLE", "storage unavailable");
  }
}

/**
 * The Next Best Action application service — ROADMAP.md §21.
 *
 * It answers one question — *what should happen next?* — for one account and for
 * a whole workspace, and it does so by reading stored rows and applying a fixed
 * rule set. The chain runs in this order, every time:
 *
 *   authenticate → authorize → read the account's state → decide → answer
 *
 * and, when the answer is recorded:
 *
 *   authenticate → authorize → read → decide → persist → answer
 *
 * The negative space is the point of this file.
 *
 * - **Nothing is acted on.** There is no sender, no approver, no calendar, no
 *   scheduler and no queue anywhere in this package. A recommendation is a
 *   sentence in a record, and the strongest thing a caller can do with one is read
 *   it and then call the Phase that owns the work — Phase 10, 11 or 13 — which
 *   re-derives its own approval, suppression check and digest before it acts.
 * - **The live answer is recomputed, never replayed.** Every read re-decides from
 *   current rows, so a workspace can never be shown a stale suggestion. The
 *   persisted rows are the *history* of what DEALORA advised and on what
 *   evidence, which is a different and also useful question.
 * - **It never fabricates a support.** `evidenceIds` and `claimIds` reference the
 *   live Phase 7 records a branch actually read; a branch with nothing to cite
 *   cites nothing, because an invented citation would be the exact failure mode
 *   Phase 7 exists to prevent.
 * - **Confidence is a band, never a percentage.** ADR 0009's weakest-band rule,
 *   for the same reason: this repository has no calibration data from which "93%"
 *   could mean anything, and `DEALORA_BLUEPRINT.md` §25 prints it only to show
 *   the shape of the answer.
 * - **An opt-out outranks everything.** `suppressed` is the first branch in the
 *   engine, so an account that asked to stop being contacted can never come back
 *   with a recommendation to contact them.
 */
export class NextActionService {
  constructor(
    private readonly repo: NextActionRepository,
    private readonly reader: AccountStateReader,
    private readonly accounts: AccountIndexReader,
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: string, userId: string): Result<true, NextActionError> {
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(nextActionError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (typeof userId !== "string" || userId === "") {
      return err(nextActionError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * The next recommended action for one account, computed live.
   *
   * The caller supplies an account id and **nothing else**. The action, reason,
   * supporting state, evidence, confidence, expected outcome and approval
   * requirement are all derived here from stored rows — a client cannot name its
   * own advice, cannot attach evidence it has not got, and cannot mark a
   * recommendation as needing no approval.
   *
   * Nothing is written. This is the read path, and it is the one that answers
   * "what should happen right now?".
   */
  recommendNextAction(
    workspaceId: string,
    userId: string,
    input: RecommendNextActionInput,
  ): Result<NextActionRecommendation, NextActionError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const accountId = text(input.accountId);
    if (accountId === null) {
      return err(
        nextActionError("VALIDATION_ERROR", "accountId is required", [
          { field: "accountId", message: "accountId must be a non-empty string" },
        ]),
      );
    }

    const state = this.reader.accountState(workspaceId, accountId, userId);
    if (state === null) {
      // Reported as not found whether the account is absent or belongs to
      // another tenant, so a foreign id is indistinguishable from one that was
      // never issued.
      return err(
        nextActionError("NOT_FOUND", "account not found", [
          {
            field: "accountId",
            message: "an account must exist in this workspace before it can be recommended for",
          },
        ]),
      );
    }

    return ok(recommendNextAction(state));
  }

  /**
   * The next recommended action for every account in a workspace.
   *
   * This is the route §25's "constantly answer" is really about: a workspace
   * asking what should happen next across the whole pipeline rather than one
   * account at a time.
   *
   * The cap is a **refusal**, not a truncation. A caller handed a board that
   * quietly stopped at 100 accounts would read it as "these are all your
   * accounts", and would be wrong about a number that decides what gets worked
   * on — so an oversized workspace is told to narrow its request instead.
   */
  recommendForWorkspace(
    workspaceId: string,
    userId: string,
  ): Result<NextActionBoard, NextActionError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const accountIds = this.accounts.accountIds(workspaceId, userId);
    if (accountIds.length > BOARD_LIMIT) {
      return err(
        nextActionError("VALIDATION_ERROR", "too many accounts for one board", [
          {
            field: "workspaceId",
            message: `this workspace holds ${accountIds.length} accounts; ask for at most ${BOARD_LIMIT} at a time rather than receive a truncated board`,
          },
        ]),
      );
    }

    const recommendations: NextActionRecommendation[] = [];
    for (const accountId of accountIds) {
      const state = this.reader.accountState(workspaceId, accountId, userId);
      // One unreadable account does not widen the boundary or empty the board; it
      // is simply absent from an answer that is otherwise about the workspace's
      // own records.
      if (state === null) continue;
      recommendations.push(recommendNextAction(state));
    }

    return ok({ ruleVersion: NEXT_ACTION_RULE_VERSION, recommendations });
  }

  /**
   * Record the current recommendation for one account.
   *
   * Recording is explicit rather than a side effect of reading, so "DEALORA
   * advised this, on this evidence, at this rule version" is something the
   * workspace chose to keep. The row is immutable and the storage layer re-checks
   * the one invariant prose cannot enforce: `approvalRequired` must agree with the
   * §17 risk level.
   *
   * **This still does not act.** The row is advice with its reasons attached; the
   * phases that own doing the work still require their own human approval.
   */
  recordRecommendation(
    workspaceId: string,
    userId: string,
    input: RecommendNextActionInput,
  ): Result<NextBestAction, NextActionError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const accountId = text(input.accountId);
    if (accountId === null) {
      return err(
        nextActionError("VALIDATION_ERROR", "accountId is required", [
          { field: "accountId", message: "accountId must be a non-empty string" },
        ]),
      );
    }

    const state = this.reader.accountState(workspaceId, accountId, userId);
    if (state === null) {
      return err(nextActionError("NOT_FOUND", "account not found"));
    }

    const recommendation = recommendNextAction(state);
    const stored = this.repo.createNextBestAction({
      workspaceId,
      createdBy: userId,
      recommendation: {
        accountId: recommendation.accountId,
        action: recommendation.action,
        supportingState: recommendation.supportingState,
        reason: recommendation.reason,
        confidence: recommendation.confidence,
        confidenceReasons: recommendation.confidenceReasons,
        riskLevel: recommendation.riskLevel,
        approvalRequired: recommendation.approvalRequired,
        expectedOutcome: recommendation.expectedOutcome,
        evidenceIds: recommendation.evidenceIds,
        claimIds: recommendation.claimIds,
        ruleVersion: recommendation.ruleVersion,
      },
    });
    if (!stored.ok) return err(fromStorage(stored.error.code, "recommendation not stored"));
    return ok(stored.value);
  }

  /**
   * One recorded recommendation.
   *
   * Authorized against the caller's own workspace, and reported as not found
   * rather than unauthorized for a foreign id so its existence is never revealed.
   */
  getRecommendation(id: string, userId: string): Result<NextBestAction, NextActionError> {
    if (text(id) === null) {
      return err(
        nextActionError("VALIDATION_ERROR", "recommendation id is required", [
          { field: "id", message: "id must be a non-empty string" },
        ]),
      );
    }
    const found = this.repo.getNextBestAction(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "recommendation not found"));
    return ok(found.value);
  }

  /**
   * The recorded history, newest first, optionally narrowed.
   *
   * An unknown `action` filter is a **validation error** rather than an empty
   * list: a caller who named a recommendation kind this deployment cannot produce
   * has sent a bad request, and "no recommendations match" would look like an
   * answer rather than a mistake.
   */
  listRecommendations(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: unknown; action?: unknown },
  ): Result<NextBestAction[], NextActionError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const action = parseActionFilter(filter?.action);
    if (action === null) {
      return err(
        nextActionError("VALIDATION_ERROR", "unknown action filter", [
          {
            field: "action",
            message: "action must be one this deployment can produce, or be omitted",
          },
        ]),
      );
    }

    let accountId: string | undefined;
    if (filter?.accountId !== undefined && filter?.accountId !== null) {
      const parsed = text(filter.accountId);
      if (parsed === null) {
        return err(
          nextActionError("VALIDATION_ERROR", "accountId is required to be a string", [
            { field: "accountId", message: "accountId must be a non-empty string" },
          ]),
        );
      }
      accountId = parsed;
    }

    const found = this.repo.listNextBestActions(workspaceId, userId, {
      ...(accountId === undefined ? {} : { accountId }),
      ...(action === undefined ? {} : { action }),
    });
    if (!found.ok) return err(fromStorage(found.error.code, "recommendations not read"));
    return ok(found.value);
  }

  /**
   * The rule set this deployment enforces.
   *
   * Authorized like every other route, because it describes which states this
   * workspace's own records can reach — and, in `neverDoes`, the list of things
   * the engine will not do with them.
   */
  policy(workspaceId: string, userId: string): Result<NextActionPolicyView, NextActionError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeNextActionPolicy());
  }
}
