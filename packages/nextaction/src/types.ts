/**
 * @dealora/nextaction — the types Phase 14's recommendation engine needs.
 *
 * The shape of this file is the design. `ROADMAP.md` §21 asks for an engine that
 * answers "*what should happen next?*" and lists seven things every
 * recommendation must carry: action, reason, supporting state, evidence,
 * confidence, expected outcome and approval requirement. All seven are fields on
 * {@link NextActionRecommendation} rather than prose assembled at read time, so a
 * recommendation stays checkable long after the rules that produced it move on.
 *
 * The negative space is the important half, and it is large on purpose.
 *
 * **A recommendation is advice, never an action.** This package has no sender,
 * no approver, no calendar, no scheduler and no queue. It reads stored rows and
 * says what should happen next; it never makes it happen. Nothing here writes to
 * the Phase 7 evidence graph either: "what to do next" is DEALORA's own inference
 * about the workspace's records, not an attested fact about an account, and
 * Phase 7 stays the only route from something a source said to something DEALORA
 * treats as true.
 *
 * **Confidence is a band, never a percentage.** `DEALORA_BLUEPRINT.md` §25's
 * example prints "93%", but the same repository already decided — in ADR 0009 —
 * that confidence is the *weakest* band among the records that produced it,
 * because DEALORA has no calibration data from which a percentage could mean
 * anything. A fabricated number would look more precise and mean less, so the
 * blueprint's percentage is treated as a display illustration and the band is
 * what ships.
 */

import type {
  AccountStatus,
  ApprovalStatus,
  ConversationClassification,
  ConversationIntent,
  DateTime,
  EntityId,
  EvidenceStatus,
  MeetingBookingState,
  NextBestAction,
  NextBestActionKind,
  NextBestActionOutcome,
  NextBestActionRiskLevel,
  NextBestActionState,
  OutboundActionStatus,
  QualificationState,
  ResearchConfidence,
  ResearchRequestStatus,
} from "@dealora/db";

export type {
  AccountStatus,
  DateTime,
  EntityId,
  EvidenceStatus,
  NextBestAction,
  NextBestActionKind,
  NextBestActionOutcome,
  NextBestActionRiskLevel,
  NextBestActionState,
  QualificationState,
  ResearchConfidence,
};

/**
 * Error codes this domain raises.
 *
 * Closed and mapped case by case at the transport boundary, like every other
 * DEALORA domain, so a new failure cannot appear over the wire as a code the API
 * contract does not define.
 */
export type NextActionErrorCode = "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_ERROR" | "UNAVAILABLE";

export interface NextActionError {
  readonly code: NextActionErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** An injectable clock, so every timestamp the service writes is reproducible. */
export type Clock = () => Date;

// ---------------------------------------------------------------------------
// The narrow reader
// ---------------------------------------------------------------------------

/**
 * One account's position in the revenue loop, as far as Phase 14 needs to see it.
 *
 * **Narrower than the records it summarizes.** Every field here is one the engine
 * reads to decide something; the message bodies, the draft text, the evidence
 * values and the qualification criteria are all deliberately absent. The engine
 * can learn *that* a response was classified and *what* it was read as; it can
 * never see what the prospect wrote, so "classify a response" cannot become
 * "answer it" through this reader by accident.
 *
 * Every list is the workspace's own, already filtered to this account.
 */
export interface AccountStateSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  name: string;
  status: AccountStatus;
  /** Every Phase 5 contact at this account. */
  contacts: AccountContactSnapshot[];
  /** Every Phase 6 research request raised for this account. */
  researchRequests: AccountResearchRequestSnapshot[];
  /** Every Phase 6 finding recorded for this account. */
  findings: AccountFindingSnapshot[];
  /** Every Phase 7 evidence record about this account. */
  evidence: AccountEvidenceSnapshot[];
  /** Every Phase 8 evaluation for this account, newest first. */
  qualifications: AccountQualificationSnapshot[];
  /** Every Phase 9 draft rendered for this account, newest first. */
  drafts: AccountDraftSnapshot[];
  /** Every Phase 10 approval request this account's drafts have raised. */
  approvals: AccountApprovalSnapshot[];
  /** Every Phase 11 outbound action addressed to this account's contacts. */
  outboundActions: AccountOutboundSnapshot[];
  /** Every Phase 12 classification of a response to this account. */
  classifications: AccountClassificationSnapshot[];
  /** Every Phase 13 meeting proposed for this account, newest first. */
  meetings: AccountMeetingSnapshot[];
  /** How many Phase 13 briefs exist per meeting id. */
  meetingBriefCounts: ReadonlyMap<EntityId, number>;
}

export interface AccountContactSnapshot {
  id: EntityId;
  status: "active" | "archived";
}

export interface AccountResearchRequestSnapshot {
  id: EntityId;
  status: ResearchRequestStatus;
}

export interface AccountFindingSnapshot {
  id: EntityId;
  /** How strongly the source supports this finding. */
  confidence: ResearchConfidence;
}

export interface AccountEvidenceSnapshot {
  id: EntityId;
  accountClaimId: EntityId;
  status: EvidenceStatus;
  confidence: ResearchConfidence;
}

export interface AccountQualificationSnapshot {
  id: EntityId;
  state: QualificationState;
  score: number | null;
  confidence: ResearchConfidence | null;
  evidenceIds: EntityId[];
  claimIds: EntityId[];
}

export interface AccountDraftSnapshot {
  id: EntityId;
  version: number;
  createdAt: DateTime;
}

export interface AccountApprovalSnapshot {
  id: EntityId;
  draftId: EntityId;
  status: ApprovalStatus;
}

export interface AccountOutboundSnapshot {
  id: EntityId;
  draftId: EntityId;
  status: OutboundActionStatus;
}

export interface AccountClassificationSnapshot {
  id: EntityId;
  intent: ConversationIntent;
  confidence: ConversationClassification["confidence"];
  /** True when this classification put the address on the Phase 11 opt-out list. */
  suppressed: boolean;
}

export interface AccountMeetingSnapshot {
  id: EntityId;
  state: MeetingBookingState;
  classificationId: EntityId;
}

/**
 * The one reader Phase 14 needs.
 *
 * Deliberately a **single** method rather than eight. The engine does not consult
 * eight independent subsystems; it asks "where does this account stand?", and
 * answering that is the whole of its job. One method also means the tenant
 * boundary is enforced in exactly one place: the reader resolves the account
 * through storage with the caller's own identity and returns `null` for an
 * account that does not exist *or* belongs to another workspace, so the engine
 * cannot tell those apart and cannot be used to probe for foreign ids.
 */
export interface AccountStateReader {
  accountState(
    workspaceId: EntityId,
    accountId: EntityId,
    userId: EntityId,
  ): AccountStateSnapshot | null;
}

/** The storage surface Phase 14 needs. Every call is workspace-scoped. */
export interface NextActionRepository {
  authorize(
    workspaceId: EntityId,
    userId: EntityId,
  ): { ok: true } | { ok: false; error: { code: string; message: string } };

  createNextBestAction(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    recommendation: {
      accountId: EntityId;
      action: NextBestActionKind;
      supportingState: NextBestActionState;
      reason: string;
      confidence: ResearchConfidence;
      confidenceReasons: string[];
      riskLevel: NextBestActionRiskLevel;
      approvalRequired: boolean;
      expectedOutcome: NextBestActionOutcome;
      evidenceIds: EntityId[];
      claimIds: EntityId[];
      ruleVersion: string;
    };
  }): { ok: true; value: NextBestAction } | { ok: false; error: { code: string; message: string } };

  getNextBestAction(
    id: EntityId,
    userId: EntityId,
  ): { ok: true; value: NextBestAction } | { ok: false; error: { code: string; message: string } };

  listNextBestActions(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId; action?: NextBestActionKind },
  ):
    { ok: true; value: NextBestAction[] } | { ok: false; error: { code: string; message: string } };
}

/** Every account a workspace holds, for the workspace-wide answer. */
export interface AccountIndexReader {
  accountIds(workspaceId: EntityId, userId: EntityId): EntityId[];
}

// ---------------------------------------------------------------------------
// What the engine produces
// ---------------------------------------------------------------------------

/**
 * One recommendation, computed live from stored rows.
 *
 * This is the answer, not a copy of it. It carries every one of `ROADMAP.md` §21's
 * seven required fields, and it is recomputed on every read so a workspace can
 * never be shown a stale suggestion. The persisted `NextBestAction` row is the
 * *history* of what DEALORA advised and on what evidence — the same seven fields
 * frozen at the moment the advice was given.
 */
export interface NextActionRecommendation {
  accountId: EntityId;
  accountName: string;
  action: NextBestActionKind;
  supportingState: NextBestActionState;
  /** One sentence naming the stored facts the recommendation was read from. */
  reason: string;
  /** The specific factors that set `confidence`, in the order they were applied. */
  confidenceReasons: string[];
  confidence: ResearchConfidence;
  riskLevel: NextBestActionRiskLevel;
  /**
   * True exactly when `riskLevel` is `level_2_external_action`.
   *
   * Derived rather than stored by the caller, and re-checked in storage, because
   * "this one needs a person" is a property of the §17 level and not something a
   * client may assert about its own advice.
   */
  approvalRequired: boolean;
  expectedOutcome: NextBestActionOutcome;
  /** Every evidence record that supports this. References, never copies. */
  evidenceIds: EntityId[];
  /** Every account claim that supports this. References, never copies. */
  claimIds: EntityId[];
  ruleVersion: string;
}

/** What a caller may send. Only the account — nothing else is theirs to name. */
export interface RecommendNextActionInput {
  accountId: unknown;
}

/** The workspace-wide answer: one recommendation per account that has one. */
export interface NextActionBoard {
  ruleVersion: string;
  recommendations: NextActionRecommendation[];
}

/**
 * The policy this deployment enforces, as data.
 *
 * Readable before any account exists, so a workspace can see the whole rule set
 * — every state, the action each one produces, the §17 level it carries and
 * everything the engine refuses to do — without handing over an account first.
 */
export interface NextActionPolicyView {
  ruleVersion: string;
  states: readonly NextBestActionState[];
  actions: readonly NextBestActionKind[];
  riskLevels: readonly NextBestActionRiskLevel[];
  confidenceBands: readonly ResearchConfidence[];
  /** Every state-to-action move the engine can make, one per decision branch. */
  rules: readonly NextActionRuleView[];
  /** Everything that stops DEALORA acting on its own recommendation. */
  prerequisites: string[];
  /** Every thing this phase will never do, stated plainly. */
  neverDoes: string[];
}

export interface NextActionRuleView {
  supportingState: NextBestActionState;
  action: NextBestActionKind;
  riskLevel: NextBestActionRiskLevel;
  approvalRequired: boolean;
  expectedOutcome: NextBestActionOutcome;
}
