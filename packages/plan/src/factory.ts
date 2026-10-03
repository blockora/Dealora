import { store } from "@dealora/db";

import { RevenuePlanService } from "./service.js";
import type { GoalReader, PlanBrainReader, PlanRepository } from "./service.js";
import { deterministicPlanCompiler } from "./compiler.js";
import type { RevenuePlanCompiler } from "./types.js";

/**
 * Bind the Revenue Plan service to the default store.
 *
 * The service depends only on {@link PlanRepository}, {@link GoalReader},
 * {@link PlanBrainReader} and {@link RevenuePlanCompiler}, so an LLM-backed
 * compiler or a different database can be substituted without changing domain
 * logic.
 */
export function createRevenuePlanService(
  repository: PlanRepository = store as unknown as PlanRepository,
  compiler: RevenuePlanCompiler = deterministicPlanCompiler,
  goals: GoalReader = ((goalId, userId) => store.getRevenueGoal(goalId, userId)) as GoalReader,
  brain: PlanBrainReader = () => {
    throw new Error("plan compilation requires a Business Brain reader");
  },
): RevenuePlanService {
  return new RevenuePlanService(repository, compiler, goals, brain);
}
