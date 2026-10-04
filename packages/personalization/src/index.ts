/**
 * @dealora/personalization — Personalization Engine (DEALORA_BLUEPRINT.md §15,
 * ROADMAP.md §16).
 *
 * Deterministic, evidence-backed outreach **drafts**. Every factual statement a
 * draft makes is quoted from a stored record and carries its provenance, and
 * anything the system cannot honestly state is recorded as a warning rather
 * than invented.
 *
 * A draft is a document, not an action. Nothing here sends, contacts, approves
 * or dispatches, and there is no path from a draft to a provider: approval is
 * Phase 10 and outbound is Phase 11.
 */
export { PersonalizationService } from "./service.js";
export type { DraftInspection, GenerateDraftOptions } from "./service.js";

export { renderDraft } from "./render.js";
export type { DraftRenderInput, DraftRenderOutput, RenderedDraft } from "./render.js";

export {
  CATEGORY_PRIORITY,
  LIMITS,
  PERSONALIZATION_RENDERER_VERSION,
  SUPPORTED_RENDERER_VERSIONS,
  bounded,
  citation,
  draftContextDigest,
  observedMonth,
  orderPoints,
  renderOfferParagraph,
  renderPointStatement,
  sortedIds,
} from "./rules.js";

export {
  DRAFTS_ARE_IMMUTABLE,
  DRAFT_STATUS,
  describeRenderer,
  isSupportedRendererVersion,
  text,
} from "./validation.js";
export type { RendererView } from "./validation.js";

export { personalizationError } from "./types.js";
export type {
  Account,
  AccountClaim,
  Claim,
  Clock,
  Contact,
  EntityId,
  Evidence,
  OfferStatus,
  PersonalizationApprovedClaim,
  PersonalizationError,
  PersonalizationErrorCode,
  PersonalizationOfferReader,
  PersonalizationOfferSnapshot,
  PersonalizationQualificationReader,
  PersonalizationQualificationSnapshot,
  PersonalizationRepository,
  PersonalizedDraft,
  QualificationState,
} from "./types.js";

/**
 * Convenience factory wiring the Personalization service to the concrete
 * repository. Application code may construct the service with any
 * {@link PersonalizationRepository}, which keeps the domain decoupled from
 * storage.
 */
export {
  createPersonalizationService,
  toOfferSnapshot,
  toQualificationSnapshot,
} from "./factory.js";
