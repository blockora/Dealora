import { store } from "@dealora/db";

import { EvidenceService } from "./service.js";
import type { EvidenceRepository } from "./types.js";

/**
 * Bind the Evidence service to the default store.
 *
 * The clock is injectable so freshness and recorded timestamps are reproducible
 * under test; application code leaves it alone.
 */
export function createEvidenceService(
  repository: EvidenceRepository = store as unknown as EvidenceRepository,
  clock?: () => Date,
): EvidenceService {
  return new EvidenceService(repository, clock ?? (() => new Date()));
}
