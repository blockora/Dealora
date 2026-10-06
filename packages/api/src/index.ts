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
 * The Revenue Graph domain's public surface, re-exported so API consumers can
 * type a graph or trace response without depending on the domain package
 * directly.
 */
export type {
  OpportunityLifecycle,
  OpportunityStage,
  OpportunityTrace,
  RevenueGraphEdge,
  RevenueGraphEdgeKind,
  RevenueGraphError,
  RevenueGraphNode,
  RevenueGraphNodeKind,
  RevenueGraphPolicyView,
  RevenueGraphStage,
  WorkspaceGraph,
} from "@dealora/revenuegraph";

/**
 * The Cost domain's public surface, re-exported so API consumers can type a
 * cost response without depending on the domain package directly.
 */
export type {
  CostBasis,
  CostBreakdown,
  CostCategory,
  CostError,
  CostEventView,
  CostExecutionKind,
  CostPolicyView,
  DerivedCostMetric,
  ExecutionCostSummary,
  RefusedCostMetric,
  WorkspaceCostMetrics,
} from "@dealora/cost";

/**
 * The Revenue Dashboard domain's public surface, re-exported so API consumers
 * can type a dashboard response without depending on the domain package
 * directly. The cost and next-action tiles embed Phase 16's and Phase 14's own
 * types rather than restating them, which is why those appear here too.
 */
export type {
  ActivityCounterDefinition,
  ActivityCounterKey,
  DashboardActivityCounter,
  DashboardApprovalsTile,
  DashboardCountTile,
  DashboardError,
  DashboardErrorCode,
  DashboardGoal,
  DashboardGoalTile,
  DashboardItemAvailability,
  DashboardItemDefinition,
  DashboardItemKey,
  DashboardMeetingsTile,
  DashboardMeetingStateCount,
  DashboardMoneyTile,
  DashboardPolicyView,
  DashboardQuestion,
  DashboardRefusal,
  DashboardTileStatus,
  RevenueDashboard,
  WorkflowFailureDefinition,
  WorkflowFailureSource,
} from "@dealora/dashboard";

/**
 * The Agent System's public surface, re-exported so API consumers can type a
 * registry response without depending on the domain package directly.
 *
 * Note what is *not* here: no runner, no dispatcher and no model client.
 * Phase 18 declares agents and records governance decisions about them, and
 * re-exporting an execution surface would claim a capability that does not
 * exist.
 */
export type {
  AgentCostLimit,
  AgentDeclaration,
  AgentError,
  AgentErrorCode,
  AgentEvaluationMetric,
  AgentId,
  AgentMemoryLayer,
  AgentModelConfig,
  AgentPolicyView,
  AgentRegistryEvent,
  AgentRegistryEventKind,
  AgentRegistryView,
  AgentState,
  AgentToolId,
  RegisteredAgent,
} from "@dealora/agent";

/**
 * The Agent Evaluation domain's public surface, re-exported so API consumers
 * can type an evaluation response without depending on the domain package
 * directly.
 */
export type {
  EvaluationGateDecision,
  EvaluationMetricResult,
  EvaluationMetricRule,
  EvaluationObservationView,
  EvaluationPolicyView,
  EvaluationReport,
  EvaluationRunView,
  EvaluationStatus,
  EvaluationVerdict,
} from "@dealora/evaluation";

/**
 * The Agent Trace & Observability domain's public surface, re-exported so API
 * consumers can type a trace response without depending on the domain package
 * directly.
 *
 * Note what is *not* here, and what that means for a caller: there is no
 * execution type, because there is no execution. `TraceRunStatus` is the run's
 * **derived** outcome — it is never accepted as input anywhere in this surface,
 * which is how `ROADMAP.md` §27's critical rule holds at the transport layer.
 */
export type {
  TraceEventView,
  TraceOutcome,
  TracePolicyView,
  TraceRunStatus,
  TraceRunSummary,
  TraceStage,
  TraceStageCounts,
  TraceUsageSummary,
  TraceView,
} from "@dealora/trace";

/**
 * The Experiment domain's public surface, re-exported so API consumers can
 * type an experiment response without depending on the domain package
 * directly.
 *
 * Note what is *not* here: no execution type, no assignment type and no
 * winner input, because `ROADMAP.md` §29's critical rule is structural — a
 * winner exists only inside a derived decision, and no request can supply one.
 */
export type {
  ExperimentArmResult,
  ExperimentArmView,
  ExperimentComparison,
  ExperimentConfidence,
  ExperimentDecision,
  ExperimentDecisionStatus,
  ExperimentError,
  ExperimentErrorCode,
  ExperimentEventView,
  ExperimentPolicyView,
  ExperimentRead,
  ExperimentView,
} from "@dealora/experiment";

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

/**
 * The CRM Integrations public surface, re-exported so API consumers can type
 * an integration response without depending on the domain package directly.
 *
 * Note what is *not* here: no credential type, no token type and no
 * execution input, because `DEALORA_BLUEPRINT.md` §17's critical rule is
 * structural — no Level 2 external action reaches an adapter without a
 * stored human decision bound to the change-set's digest, and no request
 * can supply either.
 */
export type {
  CrmApplyRequest,
  CrmApplyResult,
  CrmChangeSetAdapter,
  CrmSyncEventView,
  CrmSyncView,
  IntegrationAdapter,
  IntegrationAdapterView,
  IntegrationConnectionView,
  IntegrationError,
  IntegrationErrorCode,
  IntegrationPolicyView,
  IntegrationRegistry,
} from "@dealora/integration";
