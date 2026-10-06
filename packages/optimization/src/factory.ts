/** @dealora/optimization — service factory.

 * This package is read-only: it does not execute agents, send external actions,
 * schedule meetings, evaluate agents, or write cost rows. It turns the workspace's
 * existing rows into optimization observations.
 */

import type { OptimizationRepository, OptimizationResult } from "./types.js";
import { deriveOptimization } from "./service.js";

export function createOptimizationService(repo: OptimizationRepository) {
  return {
    analyze(workspaceId: string, userId: string): OptimizationResult {
      if (!repo.authorize(workspaceId, userId)) {
        throw new Error("unauthorized");
      }
      return deriveOptimization(repo, workspaceId, userId);
    },
  };
}
