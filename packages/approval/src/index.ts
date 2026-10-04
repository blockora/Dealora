/**
 * @dealora/approval — Approval Engine (DEALORA_BLUEPRINT.md §17, ROADMAP.md §17).
 *
 * The persisted human decision that must exist before any consequential action.
 * A request binds to exactly one immutable draft version and a digest of the
 * exact content the reviewer was shown; the decision records who made it and
 * when, and only an explicit, human, in-date `approved` authorizes anything.
 *
 * There is no auto-approval: no score, threshold, timer or model can reach that
 * state, and a client cannot name an approver, a timestamp or a decision. This
 * package executes nothing — the send path is Phase 11, and it re-verifies these
 * records independently before it calls a provider.
 */
export { ApprovalService } from "./service.js";
export type { ApprovalDecisionResult, RequestApprovalOptions } from "./service.js";

export {
  APPROVAL_ACTION_KIND,
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  AUTHORIZING_DECISION,
  LIMITS,
  REASONS_REQUIRED,
  RISK_LEVELS,
  RISK_LEVEL_LABELS,
  SEND_MESSAGE_RISK_LEVEL,
  STATUS_DECISION,
  TERMINAL_STATUSES,
  bounded,
  approvesNothing,
  previewDigest,
} from "./rules.js";
export type { DecidableRequestShape } from "./rules.js";

export {
  ApprovalIssues,
  authorizesAction,
  decisionRequiresReason,
  describeApprovalPolicy,
  isApprovalDecision,
  isApprovalStatus,
  isDecidable,
  isExpired,
  text,
} from "./validation.js";
export type { ApprovalPolicyView, ApprovalPreview } from "./validation.js";

export { approvalError } from "./types.js";
export type {
  ApprovalActionKind,
  ApprovalDecision,
  ApprovalDraftReader,
  ApprovalDraftSnapshot,
  ApprovalError,
  ApprovalErrorCode,
  ApprovalEventKind,
  ApprovalRepository,
  ApprovalRequest,
  ApprovalRequestEvent,
  ApprovalRiskLevel,
  ApprovalStatus,
  Clock,
  EntityId,
  PersonalizedDraft,
} from "./types.js";

/**
 * Convenience factory wiring the Approval service to the concrete repository.
 * Application code may construct the service with any {@link ApprovalRepository},
 * which keeps the domain decoupled from storage.
 */
export { createApprovalService, toApprovalDraftSnapshot } from "./factory.js";
