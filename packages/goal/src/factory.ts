import { store } from "@dealora/db";

import { RevenueGoalService } from "./service.js";
import type { GoalRepository } from "./service.js";
import { deterministicGoalParser } from "./parser.js";
import type { GoalParser } from "./types.js";

/**
 * Bind the Revenue Goal service to the default store and the deterministic
 * parser.
 *
 * The service depends only on {@link GoalRepository} and {@link GoalParser},
 * so an LLM-backed parser or a different database can be substituted without
 * changing domain logic.
 */
export function createRevenueGoalService(
  repository: GoalRepository = store as unknown as GoalRepository,
  parser: GoalParser = deterministicGoalParser,
): RevenueGoalService {
  return new RevenueGoalService(repository, parser);
}
