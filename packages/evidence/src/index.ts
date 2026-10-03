/**
 * @dealora/evidence — Evidence System (DEALORA_BLUEPRINT.md §10,
 * ROADMAP.md §14).
 *
 * First-class, source-backed evidence and structured account claims, with the
 * provenance, contradiction and supersession history preserved.
 *
 * Evidence is not qualification, not a score, not personalization and not
 * outreach. This package makes claims traceable; Phase 8 decides what they are
 * worth.
 */
export { EvidenceService, type EvidenceOutcome } from "./service.js";

export {
  ACCOUNT_CLAIM_LIFECYCLE,
  ACCOUNT_CLAIM_STATUSES,
  EVIDENCE_LIFECYCLE,
  EVIDENCE_PROVENANCES,
  EVIDENCE_STATUSES,
  EvidenceIssues,
  PERMITTED_SOURCE_KINDS,
  RESEARCH_CATEGORIES,
  RESEARCH_CLAIM_KINDS,
  RESEARCH_CONFIDENCES,
  RESEARCH_FRESHNESS,
  RESEARCH_RELEVANCES,
  canTransitionClaim,
  canTransitionEvidence,
  claimKey,
  evidenceStatusMessage,
  freshnessFor,
  isContradiction,
  isPermittedSourceKind,
  isSelfAttributableSource,
  normalizeReference,
  normalizeUserEvidence,
  text,
} from "./validation.js";
export type { NormalizedUserEvidence, UserEvidenceInput } from "./validation.js";

export { evidenceError } from "./types.js";
export type {
  Account,
  AccountClaim,
  Clock,
  EntityId,
  Evidence,
  EvidenceError,
  EvidenceErrorCode,
  EvidenceProvenance,
  EvidenceRepository,
  EvidenceStatus,
  ResearchCategory,
  ResearchClaimKind,
  ResearchConfidence,
  ResearchFinding,
  ResearchFreshness,
  ResearchRelevance,
  ResearchSourceKind,
} from "./types.js";

export { LIMITS } from "./validation.js";

/**
 * Convenience factory wiring the Evidence service to the concrete repository.
 * Application code may construct the service with any {@link EvidenceRepository},
 * which keeps the domain decoupled from storage.
 */
export { createEvidenceService } from "./factory.js";
