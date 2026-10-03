import type { Result } from "@dealora/core";
import { err, ok } from "@dealora/core";
import type { EntityId, RevenueGoal, RevenuePlan, RevenuePlanStatus } from "@dealora/db";

import { planError } from "./types.js";
import type {
  PlanBrainSnapshot,
  PlanError,
  RevenuePlanCompiler,
  RevenuePlanDraft,
} from "./types.js";
import {
  PLAN_STATUSES,
  assertGoalCompilable,
  assertPlanTransition,
  validatePlanDraft,
} from "./validation.js";

export * from "./types.js";
export * from "./validation.js";
export {
  DeterministicPlanCompiler,
  brainSnapshotDigest,
  collectStatements,
  deterministicPlanCompiler,
} from "./compiler.js";

/**
 * Storage the Revenue Plan Compiler depends on.
 *
 * Declared as an interface so the domain is testable in isolation and a
 * different database driver can replace the JSON store without touching it.
 */
export interface PlanRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;
  nextRevenuePlanVersion(revenueGoalId: EntityId): Result<number, { code: string }>;
  createRevenuePlan(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    plan: Omit<
      RevenuePlan,
      "id" | "workspaceId" | "createdBy" | "version" | "createdAt" | "updatedAt"
    >;
  }): Result<RevenuePlan, { code: string }>;
  listRevenuePlans(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { revenueGoalId?: EntityId; status?: RevenuePlanStatus },
  ): Result<RevenuePlan[], { code: string }>;
  getRevenuePlan(id: EntityId, userId: EntityId): Result<RevenuePlan, { code: string }>;
  listRevenuePlansForGoal(
    revenueGoalId: EntityId,
    userId: EntityId,
  ): Result<RevenuePlan[], { code: string }>;
  updateRevenuePlan(
    id: EntityId,
    input: {
      userId: EntityId;
      patch: Partial<
        Omit<RevenuePlan, "id" | "workspaceId" | "createdBy" | "version" | "createdAt">
      >;
    },
  ): Result<RevenuePlan, { code: string }>;
  setRevenuePlanStatus(
    id: EntityId,
    userId: EntityId,
    status: RevenuePlanStatus,
  ): Result<RevenuePlan, { code: string }>;
}

/**
 * Loads a goal the plan is compiled from.
 *
 * Narrowed to a reader so the compiler depends on the goal's shape, not on the
 * goal service's whole surface.
 */
export type GoalReader = (
  goalId: EntityId,
  userId: EntityId,
) => Result<RevenueGoal, { code: string }>;

/**
 * Reads the canonical Business Brain for one workspace.
 *
 * Always workspace-scoped and always authorized by the caller of the reader,
 * so a plan can never be compiled against another tenant's context.
 */
export type PlanBrainReader = (workspaceId: EntityId, userId: EntityId) => PlanBrainSnapshot;

function fromStorage(code: string, fallback: string): PlanError {
  switch (code) {
    case "NOT_FOUND":
      return planError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return planError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return planError("CONFLICT", fallback);
    case "INVALID":
      return planError("VALIDATION_ERROR", fallback);
    default:
      // Never surface raw storage messages.
      return planError("UNAVAILABLE", "storage unavailable");
  }
}

/**
 * The Revenue Plan application service.
 *
 * Responsibilities:
 * - Resolve authorization from the authenticated identity on every call.
 * - Enforce the goal preconditions before compiling anything.
 * - Compile deterministically through the replaceable compiler boundary.
 * - Validate the draft before persisting it.
 * - Version plans without destroying earlier versions.
 *
 * It never performs an external action: Phase 4 is a planning phase.
 */
export class RevenuePlanService {
  constructor(
    private readonly repo: PlanRepository,
    private readonly compiler: RevenuePlanCompiler,
    private readonly goals: GoalReader,
    private readonly brain: PlanBrainReader,
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, PlanError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(planError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(planError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * Compile a RevenueGoal into a new RevenuePlan version.
   *
   * The full precondition chain runs before the compiler is invoked:
   * authenticate → authorize → load goal → goal belongs to this workspace →
   * goal is not archived → goal is complete → load canonical Brain → compile →
   * validate → persist.
   *
   * Recompiling inserts a new version. The previous plan is never overwritten.
   */
  compileRevenuePlan(
    workspaceId: EntityId,
    userId: EntityId,
    revenueGoalId: unknown,
  ): Result<RevenuePlan, PlanError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    if (typeof revenueGoalId !== "string" || revenueGoalId.trim() === "") {
      return err(planError("VALIDATION_ERROR", "revenueGoalId is required"));
    }

    const loaded = this.goals(revenueGoalId, userId);
    if (!loaded.ok) return err(fromStorage(loaded.error.code, "revenue goal not found"));
    const goal = loaded.value;

    // The goal must belong to the workspace the caller is authorized for, even
    // if the reader returned it: authorization never rests on the caller alone.
    if (goal.workspaceId !== workspaceId) {
      return err(planError("UNAUTHORIZED", "workspace access denied"));
    }

    const compilable = assertGoalCompilable(goal);
    if (compilable) return err(compilable);

    let snapshot: PlanBrainSnapshot;
    try {
      snapshot = this.brain(workspaceId, userId);
    } catch {
      return err(planError("UNAVAILABLE", "storage unavailable"));
    }

    let draft: RevenuePlanDraft;
    try {
      draft = this.compiler.compile({ goal, brain: snapshot });
    } catch {
      // A compiler failure is never allowed to leak internal detail.
      return err(planError("UNAVAILABLE", "revenue plan compilation failed"));
    }

    const invalid = validatePlanDraft(draft);
    if (invalid) return err(invalid);

    const created = this.repo.createRevenuePlan({
      workspaceId,
      createdBy: userId,
      plan: {
        revenueGoalId: draft.revenueGoalId,
        compilerVersion: draft.compilerVersion,
        brainSnapshotDigest: draft.brainSnapshotDigest,
        references: draft.references,
        strategies: draft.strategies,
        facts: draft.facts,
        inferences: draft.inferences,
        assumptions: draft.assumptions,
        recommendations: draft.recommendations,
        unknowns: draft.unknowns,
        approval: draft.approval,
        rationale: draft.rationale,
        // A compiled plan is a proposal awaiting review.
        status: "proposed",
      },
    });
    if (!created.ok) {
      return err(fromStorage(created.error.code, "revenue plan creation failed"));
    }
    return ok(created.value);
  }

  getRevenuePlan(id: EntityId, userId: EntityId): Result<RevenuePlan, PlanError> {
    if (!id || typeof id !== "string") {
      return err(planError("VALIDATION_ERROR", "plan id is required"));
    }
    const plan = this.repo.getRevenuePlan(id, userId);
    if (!plan.ok) return err(fromStorage(plan.error.code, "revenue plan not found"));
    return ok(plan.value);
  }

  listRevenuePlans(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { revenueGoalId?: EntityId; status?: RevenuePlanStatus },
  ): Result<RevenuePlan[], PlanError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.status !== undefined && !PLAN_STATUSES.includes(filter.status)) {
      return err(
        planError("VALIDATION_ERROR", "invalid status filter", [
          { field: "status", message: `status must be one of: ${PLAN_STATUSES.join(", ")}` },
        ]),
      );
    }
    const plans = this.repo.listRevenuePlans(workspaceId, userId, filter);
    if (!plans.ok) return err(fromStorage(plans.error.code, "revenue plans unavailable"));
    return ok(plans.value);
  }

  /**
   * The version history of a plan's lineage.
   *
   * Every version compiled from the same goal, oldest first, so a superseded
   * plan stays inspectable.
   */
  planHistory(planId: EntityId, userId: EntityId): Result<RevenuePlan[], PlanError> {
    if (!planId || typeof planId !== "string") {
      return err(planError("VALIDATION_ERROR", "plan id is required"));
    }
    const plan = this.repo.getRevenuePlan(planId, userId);
    if (!plan.ok) return err(fromStorage(plan.error.code, "revenue plan not found"));
    const history = this.repo.listRevenuePlansForGoal(plan.value.revenueGoalId, userId);
    if (!history.ok)
      return err(fromStorage(history.error.code, "revenue plan history unavailable"));
    return ok(history.value);
  }

  /**
   * Move a plan through its lifecycle.
   *
   * The current status is read from storage, so a caller cannot skip validation
   * by asserting where the plan is. Approving a plan approves the *proposal*;
   * it never authorizes an external action.
   */
  changeRevenuePlanStatus(
    id: EntityId,
    userId: EntityId,
    next: unknown,
  ): Result<RevenuePlan, PlanError> {
    if (!id || typeof id !== "string") {
      return err(planError("VALIDATION_ERROR", "plan id is required"));
    }
    const existing = this.repo.getRevenuePlan(id, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "revenue plan not found"));

    const transition = assertPlanTransition(existing.value.status, next as RevenuePlanStatus);
    if (transition) return err(transition);

    const updated = this.repo.setRevenuePlanStatus(id, userId, next as RevenuePlanStatus);
    if (!updated.ok) return err(fromStorage(updated.error.code, "revenue plan update failed"));
    return ok(updated.value);
  }

  /** Archive a plan. Archiving is terminal. */
  archiveRevenuePlan(id: EntityId, userId: EntityId): Result<RevenuePlan, PlanError> {
    return this.changeRevenuePlanStatus(id, userId, "archived");
  }
}

export type { EntityId };
