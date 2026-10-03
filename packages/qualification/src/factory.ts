import type { EntityId, Icp, RevenueGoal, RevenuePlan } from "@dealora/db";

import { QualificationService } from "./service.js";
import type {
  QualificationGoalReader,
  QualificationGoalSnapshot,
  QualificationIcpReader,
  QualificationIcpSnapshot,
  QualificationPlanReader,
  QualificationPlanSnapshot,
  QualificationRepository,
} from "./types.js";

/**
 * Convenience factory wiring the Qualification service to the concrete store.
 *
 * Application code may construct the service with any
 * {@link QualificationRepository} plus readers for the Business Brain ICP, the
 * Revenue Goal and the Revenue Plan, which keeps the domain decoupled from
 * storage: the domain never learns that any of them is a JSON document.
 *
 * The readers are deliberately narrow. Qualification reads the ICP's target
 * terms and the goal's time window, and nothing else — it never gets the whole
 * Business Brain, a goal's economics, or a plan's outreach strategy.
 */
export function createQualificationService(
  repo: QualificationRepository,
  icp: QualificationIcpReader,
  goals: QualificationGoalReader,
  plans: QualificationPlanReader,
  clock?: () => Date,
): QualificationService {
  return new QualificationService(repo, icp, goals, plans, clock);
}

/** Narrow a stored {@link RevenueGoal} to the window the engine reads. */
export function toGoalSnapshot(goal: RevenueGoal): QualificationGoalSnapshot {
  return { id: goal.id, workspaceId: goal.workspaceId, timeWindow: goal.timeWindow };
}

/** Narrow a stored {@link RevenuePlan} to the goal it was compiled from. */
export function toPlanReader(
  read: (id: EntityId, userId: EntityId) => RevenuePlan | null,
): QualificationPlanReader {
  return (planId: EntityId, userId: EntityId) => {
    const plan = read(planId, userId);
    return plan === null
      ? { ok: false, error: { code: "NOT_FOUND" } }
      : { ok: true, value: toPlanSnapshot(plan) };
  };
}

/** Narrow a stored {@link RevenuePlan} to its provenance. */
export function toPlanSnapshot(plan: RevenuePlan): QualificationPlanSnapshot {
  return { id: plan.id, workspaceId: plan.workspaceId, revenueGoalId: plan.revenueGoalId };
}

/** Narrow a stored ICP to the target terms the rules actually read. */
export function toIcpSnapshot(icp: Icp): QualificationIcpSnapshot {
  return {
    id: icp.id,
    industries: icp.industries,
    companySizes: icp.companySizes,
    geographies: icp.geographies,
    businessModels: icp.businessModels,
    disqualifiers: icp.disqualifiers,
  };
}
