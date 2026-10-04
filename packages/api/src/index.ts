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
 * The Approval domain's public surface, re-exported so API consumers can type
 * an approval response without depending on the domain package directly.
 */
export type {
  ApprovalDecision,
  ApprovalPolicyView,
  ApprovalPreview,
  ApprovalRequest,
  ApprovalRequestEvent,
  ApprovalRiskLevel,
  ApprovalStatus,
} from "@dealora/approval";

/**
 * The Outbound domain's public surface, re-exported so API consumers can type an
 * outbound response without depending on the domain package directly.
 */
export type {
  OutboundAction,
  OutboundActionStatus,
  OutboundChannel,
  OutboundError,
  OutboundEvent,
  OutboundEventKind,
  OutboundFailureCode,
  OutboundPolicyView,
  OutboundProvider,
  OutboundSendResult,
  OutboundSuppression,
} from "@dealora/outbound";

/**
 * The Conversation domain's public surface, re-exported so API consumers can
 * type a classification response without depending on the domain package
 * directly.
 */
export type {
  ConversationClassification,
  ConversationConfidence,
  ConversationDisposition,
  ConversationError,
  ConversationEvent,
  ConversationEventKind,
  ConversationIntent,
  ConversationPolicyView,
  ConversationResult,
  ConversationSignalKind,
  InboundMessage,
  InboundSource,
} from "@dealora/conversation";

/**
 * The Meeting domain's public surface, re-exported so API consumers can type a
 * booking response without depending on the domain package directly.
 */
export type {
  Meeting,
  MeetingBrief,
  MeetingBookingChannel,
  MeetingBookingState,
  MeetingEvent,
  MeetingEventKind,
  MeetingPolicyView,
  MeetingRecommendationReason,
} from "@dealora/meeting";

/**
 * The Next Best Action domain's public surface, re-exported so API consumers can
 * type a recommendation response without depending on the domain package
 * directly.
 */
export type {
  NextActionBoard,
  NextActionError,
  NextActionPolicyView,
  NextActionRecommendation,
  NextActionRuleView,
  NextBestAction,
  NextBestActionKind,
  NextBestActionOutcome,
  NextBestActionRiskLevel,
  NextBestActionState,
} from "@dealora/nextaction";

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
