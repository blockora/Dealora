/** @dealora/api — transport handlers and application-service wiring. */
export { createHandlers, publicUser } from "./handlers.js";
export type { HandlerDeps } from "./handlers.js";

export type {
  ApiError,
  ApiErrorCode,
  ApiHandler,
  ApiResponse,
  ApiSuccess,
  AuthenticatedActor,
  IdentityService,
  RequestBody,
  SessionResolver,
} from "./types.js";

/**
 * Build the default handler set wired to the real identity service, Business
 * Brain service, and session index.
 *
 * The session resolver is derived from the auth package's session index, so a
 * handler can never accept a client-supplied user id.
 */
export { createDefaultHandlers } from "./wiring.js";

/**
 * The Evidence domain's public surface, re-exported so API consumers can type
 * a response without depending on the domain package directly.
 */
export type { Evidence, EvidenceError, EvidenceStatus, AccountClaim } from "@dealora/evidence";
export type { DraftPersonalizationPoint } from "@dealora/db";

/**
 * The Qualification domain's public surface, re-exported so API consumers can
 * type a qualification response without depending on the domain package
 * directly.
 */
export type {
  Qualification,
  QualificationCriteriaView,
  QualificationCriterionResult,
  QualificationDimension,
  QualificationDimensionResult,
  QualificationError,
  QualificationState,
} from "@dealora/qualification";

/**
 * The Personalization domain's public surface, re-exported so API consumers can
 * type a draft response without depending on the domain package directly.
 * `DraftPersonalizationPoint` is a `@dealora/db` type, re-exported by the
 * domain package, so it is listed with the db re-exports above rather than
 * here.
 */
export type {
  DraftInspection,
  DraftRenderInput,
  DraftRenderOutput,
  PersonalizedDraft,
  PersonalizationApprovedClaim,
  PersonalizationError,
  PersonalizationOfferSnapshot,
  PersonalizationQualificationSnapshot,
} from "@dealora/personalization";
