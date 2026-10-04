import {
  APPROVAL_ACTION_KIND,
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  LIMITS,
  REASONS_REQUIRED,
  RISK_LEVEL_LABELS,
  RISK_LEVELS,
  SEND_MESSAGE_RISK_LEVEL,
  STATUS_DECISION,
  TERMINAL_STATUSES,
  bounded,
} from "./rules.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRiskLevel,
  ApprovalStatus,
} from "./types.js";

/**
 * Validation and the read model a caller inspects.
 *
 * Every function here is pure: the current time arrives as a parameter, nothing
 * reads global state and nothing performs I/O.
 */

/** Collect field-level issues, as the other domain packages do. */
export class ApprovalIssues {
  private readonly collected: { field: string; message: string }[] = [];

  add(field: string, message: string): void {
    this.collected.push({ field, message });
  }

  get length(): number {
    return this.collected.length;
  }

  all(): { field: string; message: string }[] {
    return [...this.collected];
  }
}

/** A trimmed, whitespace-collapsed string, or null when absent/blank. */
export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized === "" ? null : normalized;
}

/** Is this a decision the closed vocabulary contains? */
export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === "string" && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

/** Is this a status the closed vocabulary contains? */
export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** Does this decision require the reviewer to say why? */
export function decisionRequiresReason(decision: ApprovalDecision): boolean {
  return REASONS_REQUIRED.includes(decision);
}

/**
 * Has this request passed its own expiry?
 *
 * A deadline is compared against the injected `now`, never `Date.now()`, so the
 * answer is reproducible under test. `expiresAt` is `null` when a request never
 * expires, and a request with no deadline is never expired.
 */
export function isExpired(request: ApprovalRequest, now: Date): boolean {
  if (request.expiresAt === null) return false;
  const deadline = Date.parse(request.expiresAt);
  if (Number.isNaN(deadline)) return false;
  return now.getTime() >= deadline;
}

/**
 * May a decision be recorded on this request right now?
 *
 * The two refusals are distinct and both matter: a request that has already
 * been decided cannot be re-decided, and a request past its own deadline cannot
 * be decided at all — a timeout closes the door rather than approving anything.
 */
export function isDecidable(
  request: ApprovalRequest,
  now: Date,
): { ok: true } | { ok: false; reason: "already_decided" | "expired"; status: ApprovalStatus } {
  if (request.status !== "pending")
    return { ok: false, reason: "already_decided", status: request.status };
  if (isExpired(request, now)) return { ok: false, reason: "expired", status: "expired" };
  return { ok: true };
}

/**
 * Does this request currently authorize the action it names?
 *
 * The single question Phase 11 asks before it calls a provider, and the answer
 * is deliberately narrow. It is `true` only for a request that is `approved`,
 * was decided by a human at a recorded instant, and is not past any deadline.
 * A `pending`, `rejected`, `changes_requested`, `cancelled` or `expired`
 * request authorizes nothing — there is no partial credit and no "probably".
 */
export function authorizesAction(request: ApprovalRequest, now: Date): boolean {
  return (
    request.status === STATUS_DECISION[request.status] &&
    request.status === "approved" &&
    request.decision === "approved" &&
    request.decidedBy !== null &&
    request.decidedAt !== null &&
    !isExpired(request, now)
  );
}

/** The plain-language meaning of one risk level. */
export function riskLabelOf(level: ApprovalRiskLevel): string {
  return RISK_LEVEL_LABELS[level] ?? `Level: ${level}`;
}

/**
 * The approval policy this deployment enforces, inspectable before any request
 * exists.
 *
 * The point of exposing this is the same as the qualification criteria and
 * personalization renderer inspectors: what the system will and will not do on
 * its own is readable on its own terms, rather than only as a by-product of a
 * refusal.
 */
export interface ApprovalPolicyView {
  actionKind: typeof APPROVAL_ACTION_KIND;
  riskLevel: typeof SEND_MESSAGE_RISK_LEVEL;
  riskLevelLabel: string;
  riskLevels: { riskLevel: ApprovalRiskLevel; label: string }[];
  decisions: ApprovalDecision[];
  decisionsRequiringReason: ApprovalDecision[];
  statuses: ApprovalStatus[];
  terminalStatuses: ApprovalStatus[];
  /** What the system will never do, stated as plainly as possible. */
  neverDoes: string[];
  /** What a reviewer sees when they open a request. */
  reviewerSees: string[];
}

export function describeApprovalPolicy(): ApprovalPolicyView {
  return {
    actionKind: APPROVAL_ACTION_KIND,
    riskLevel: SEND_MESSAGE_RISK_LEVEL,
    riskLevelLabel: RISK_LEVEL_LABELS[SEND_MESSAGE_RISK_LEVEL],
    riskLevels: RISK_LEVELS.map((level) => ({ riskLevel: level, label: riskLabelOf(level) })),
    decisions: [...APPROVAL_DECISIONS],
    decisionsRequiringReason: [...REASONS_REQUIRED],
    statuses: [...APPROVAL_STATUSES],
    terminalStatuses: [...TERMINAL_STATUSES],
    neverDoes: [
      "approve anything without an authenticated human decision",
      "approve on a score, a threshold, a timer or a model output",
      "accept an approver, a decision timestamp or an approval flag from a request body",
      "record a second decision on a request that already has one",
      "treat an expired or cancelled request as an approval",
      "execute the action it authorizes — that is Phase 11, and it re-verifies this record first",
    ],
    reviewerSees: [
      "the exact subject and body of the draft version under review",
      "the personalization points and their evidence, so every factual statement is checkable",
      "the warnings the renderer recorded, including anything it declined to state",
      "the draft version and a digest of the content, so the decision names what it covered",
    ],
  };
}

/** One request together with the content the reviewer was shown. */
export interface ApprovalPreview {
  request: ApprovalRequest;
  /** The exact subject and body of the version this request is bound to. */
  subject: string;
  body: string;
  /** Everything the renderer recorded that it would not state as fact. */
  warnings: string[];
}

export { bounded, LIMITS };
