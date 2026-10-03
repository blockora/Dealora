import { store } from "@dealora/db";

import { AccountRecordProvider } from "./provider.js";
import { ResearchService } from "./service.js";
import type { ResearchProvider, ResearchRepository } from "./types.js";
import { createProviderRegistry } from "./types.js";

/**
 * Bind the Research service to the default store.
 *
 * The permitted providers are supplied, not discovered. The default is the one
 * source this phase can honestly offer — the workspace's own account record —
 * because no external source is configured and none is simulated. Registering
 * an authorized-API or permitted-public-source provider is a deployment
 * decision with its own terms, rate limits and attribution.
 *
 * The clock is injectable so freshness and timestamps are reproducible under
 * test; application code leaves it alone.
 */
export function createResearchService(
  repository: ResearchRepository = store as unknown as ResearchRepository,
  providers: readonly ResearchProvider[] = [new AccountRecordProvider()],
  clock?: () => Date,
): ResearchService {
  const registry = createProviderRegistry(providers);
  return new ResearchService(repository, registry, clock ?? (() => new Date()));
}
