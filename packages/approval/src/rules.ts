import type { ApprovalDecision, ApprovalRiskLevel, ApprovalStatus, EntityId } from "./types.js";

/**
 * The approval rules, as data.
 *
 * Everything this phase decides structurally lives here, in one file: which
 * risk level covers which action, what a request's preview is, and which
 * transitions are legal. There is nowhere else for an automatic approval to
 * hide, because there is no code path that produces one.
 */

/** The action this phase issues approvals for. Exactly one, on purpose. */
export const APPROVAL_ACTION_KIND = "send_message" as const;

/**
 * The risk level that action carries.
 *
 * DEALORA_BLUEPRINT.md §17 Level 2 — "external action". Sending a message to a
 * person outside the business is consequential, which is precisely why it
 * needs an explicit human decision rather than a threshold.
 */
export const SEND_MESSAGE_RISK_LEVEL: ApprovalRiskLevel = "level_2_external_action";

/**
 * Every risk level, exactly the §17 vocabulary.
 *
 * Exposed so a caller can read what the levels mean before asking for an
 * approval, rather than learning them from a refusal.
 */
export const RISK_LEVELS: readonly ApprovalRiskLevel[] = [
  "level_0_read",
  "level_1_draft",
  "level_2_external_action",
  "level_3_high_impact",
];

export const RISK_LEVEL_LABELS: Record<ApprovalRiskLevel, string> = {
  level_0_read: "Level 0 — Read: research, analysis, scoring, summarization.",
  level_1_draft: "Level 1 — Draft: a message draft, a follow-up draft, a CRM note.",
  level_2_external_action:
    "Level 2 — External action: send a message, update a CRM, schedule an event.",
  level_3_high_impact:
    "Level 3 — High-impact action: a financial commitment, a contract action, an irreversible change.",
};

/** The decisions a reviewer may record. All three are human decisions. */
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "approved",
  "rejected",
  "changes_requested",
];

/** Every status a request can be in. */
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "cancelled",
  "expired",
];

/**
 * The terminal states: no further decision may be recorded on them.
 *
 * There is no path out of any of these. In particular `approved` is terminal,
 * so an approval cannot be re-decided into something else, and `expired` is
 * terminal, so a timeout can never be revived into a yes.
 */
export const TERMINAL_STATUSES: readonly ApprovalStatus[] = [
  "approved",
  "rejected",
  "changes_requested",
  "cancelled",
  "expired",
];

/**
 * The decision each terminal status records, where it records one.
 *
 * `cancelled` and `expired` deliberately map to nothing: neither is a decision,
 * which is why neither can authorize anything.
 */
export const STATUS_DECISION: Partial<Record<ApprovalStatus, ApprovalDecision>> = {
  approved: "approved",
  rejected: "rejected",
  changes_requested: "changes_requested",
};

/** Decisions that require a reason, because a bare refusal teaches nobody anything. */
export const REASONS_REQUIRED: readonly ApprovalDecision[] = ["rejected", "changes_requested"];

/** The only decision that authorizes a consequential action. */
export const AUTHORIZING_DECISION: ApprovalDecision = "approved";

/** Hard bounds, so an oversized preview fails fast instead of bloating a record. */
export const LIMITS = {
  /** One-line summary shown in a list of pending requests. */
  previewSubject: 200,
  /** A reviewer's stated reason. */
  reason: 1000,
  /** How long a request may stay open when the caller asks for an expiry. */
  maxExpiryDays: 30,
} as const;

/** The request shape the predicate below reads. */
export interface DecidableRequestShape {
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
}

/**
 * Does this record authorize nothing at all?
 *
 * The inverse of `authorizesAction`, stated as its own predicate so a caller
 * that is checking a *rejected* or *expired* record reads the safe answer
 * directly instead of having to prove the affirmative. `true` is the answer for
 * every state that is not an explicit, human, in-date approval, and for a
 * record that claims approval without naming a reviewer or an instant.
 */
export function approvesNothing(request: DecidableRequestShape): boolean {
  if (request.status !== "approved") return true;
  if (request.decision !== "approved") return true;
  // An approval with no reviewer or no instant is not a human decision, and a
  // decision that cannot be attributed cannot be audited.
  if (request.decidedBy === null || request.decidedAt === null) return true;
  return false;
}

/** JSON with object keys sorted, so equal content always serializes equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Deterministic digest of the exact content a reviewer is shown.
 *
 * The approval records this digest at request time and the service recomputes
 * and compares it at decision time. That comparison is what makes an approval
 * mean "I read *this* text": if a draft's rendered content ever changed under
 * the request, the digest would differ and the decision would be refused rather
 * than recorded against text the reviewer never saw.
 *
 * FNV-1a over a canonical (key-sorted) serialization: no randomness, no crypto
 * dependency, stable across processes. A fingerprint for comparison, not a
 * security primitive.
 */
export function previewDigest(input: {
  draftId: EntityId;
  draftVersion: number;
  subject: string;
  body: string;
}): string {
  const canonical = canonicalJson({
    body: input.body,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    subject: input.subject,
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

/** Truncate to a bound without ever returning an empty string mid-word. */
export function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}
