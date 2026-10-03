/**
 * @dealora/research — Research Engine (ROADMAP.md §13).
 *
 * Workspace-scoped research requests over existing accounts, executed through
 * permitted providers, producing structured research findings that carry their
 * source attribution and timestamps.
 *
 * Research is not evidence, not a qualification decision, not personalization
 * and not outreach. This package has no score, no message and no outbound call
 * in it, and Phase 7 (Evidence) is where verification begins.
 */
export {
  ResearchService,
  type CreateResearchRequestInput,
  type ResearchRunOutcome,
} from "./service.js";

export {
  ACTIVE_RESEARCH_STATUSES,
  LIMITS,
  RESEARCH_CATEGORIES,
  RESEARCH_CLAIM_KINDS,
  RESEARCH_CONFIDENCES,
  RESEARCH_FRESHNESS,
  RESEARCH_LIFECYCLE,
  RESEARCH_RELEVANCES,
  RESEARCH_REQUEST_STATUSES,
  RESEARCH_SOURCE_KINDS,
  ResearchIssues,
  canTransition,
  findingKey,
  freshnessFor,
  normalizeCategories,
  normalizeProviderFindings,
  providerFailureMessage,
} from "./validation.js";
export type { NormalizedFinding } from "./validation.js";

export { researchError } from "./types.js";
export { createProviderRegistry } from "./types.js";
export type {
  Clock,
  ProviderFailureCode,
  RawProviderFinding,
  ResearchError,
  ResearchErrorCode,
  ResearchProvider,
  ResearchProviderRegistry,
  ResearchProviderResult,
  ResearchQuery,
  ResearchRepository,
} from "./types.js";
export type {
  ResearchCategory,
  ResearchClaimKind,
  ResearchConfidence,
  ResearchFailureCode,
  ResearchFinding,
  ResearchFreshness,
  ResearchRelevance,
  ResearchRequest,
  ResearchRequestStatus,
  ResearchSourceKind,
} from "@dealora/db";

export {
  ACCOUNT_RECORD_PROVIDER_ID,
  AccountRecordProvider,
  StaticResearchProvider,
} from "./provider.js";

/**
 * Convenience factory wiring the Research service to the concrete repository.
 * Application code may construct the service with any {@link ResearchProvider}
 * implementation and any {@link ResearchRepository}, which keeps the domain
 * decoupled from both storage and data sources.
 */
export { createResearchService } from "./factory.js";
