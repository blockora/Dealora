import { store } from "@dealora/db";

import { BusinessBrainService } from "./service.js";
import type { BrainRepository } from "./service.js";

/**
 * Bind the Business Brain service to the default store.
 *
 * The service itself depends only on {@link BrainRepository}, so tests can
 * pass an isolated store and future phases can swap in a different
 * persistence implementation without touching domain logic.
 */
export function createBusinessBrainService(
  repository: BrainRepository = store as unknown as BrainRepository,
): BusinessBrainService {
  return new BusinessBrainService(repository);
}
