import { normalizeText, normalizeUrl } from "@dealora/account";
import { RESEARCH_CATEGORIES, RESEARCH_CLAIM_KINDS } from "@dealora/research";
import type {
  AccountClaim,
  AccountClaimStatus,
  EvidenceProvenance,
  EvidenceStatus,
  ResearchCategory,
  ResearchClaimKind,
  ResearchConfidence,
  ResearchRelevance,
  ResearchSourceKind,
} from "@dealora/db";

import type { EvidenceError } from "./types.js";
import { evidenceError } from "./types.js";

/**
 * Normalization, validation and the lifecycle rules.
 *
 * Every function here is pure: the current time arrives as a parameter and
 * nothing reads global state or performs I/O. Given the same input and the
 * same clock, the same evidence comes out.
 */

export const LIMITS = {
  field: 100,
  value: 2000,
  sourceName: 200,
  sourceUrl: 500,
  sourceTitle: 300,
  note: 1000,
} as const;

/**
 * Re-exported for callers that only import the evidence package.
 *
 * The vocabularies are **not** redefined here. Phase 7 deliberately reuses the
 * Phase 6 bands rather than inventing parallel ones: a confidence that means
 * one thing in research and another in evidence would make the two phases
 * impossible to compare, and would give an obvious place for a score to hide.
 */
export {
  RESEARCH_CATEGORIES,
  RESEARCH_CLAIM_KINDS,
  RESEARCH_CONFIDENCES,
  RESEARCH_FRESHNESS,
  RESEARCH_RELEVANCES,
  freshnessFor,
} from "@dealora/research";

export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = [
  "recorded",
  "superseded",
  "contradicted",
  "rejected",
];

export const ACCOUNT_CLAIM_STATUSES: readonly AccountClaimStatus[] = [
  "asserted",
  "contested",
  "retracted",
];

export const EVIDENCE_PROVENANCES: readonly EvidenceProvenance[] = [
  "research_finding",
  "user_supplied",
];

/** Permitted source kinds (DEALORA_BLUEPRINT.md §43). */
export const PERMITTED_SOURCE_KINDS: readonly ResearchSourceKind[] = [
  "account_record",
  "approved_api",
  "public_web",
];

/**
 * The evidence lifecycle.
 *
 *   recorded ──▶ superseded     (the workspace named a replacement)
 *      ├───────▶ contradicted ──▶ superseded
 *      └───────▶ rejected            (the workspace rejected it as support)
 *
 * `superseded` and `rejected` are terminal.
 *
 * `contradicted ──▶ superseded` is the one edge out of a non-`recorded` state,
 * and it is deliberate. Two sources that disagree become a contradiction
 * automatically and neither is ever declared the winner. Resolving that
 * conflict is a decision about which source to believe, so it is never made
 * here: it happens only when the workspace explicitly names the replacement.
 *
 * `contradicted ──▶ recorded` does **not** exist. A contested record cannot be
 * quietly un-contested, because that would resolve the conflict by fiat with
 * nothing to point at. The forward path is a supersession naming a real
 * replacement, which stays auditable on both sides.
 */
export const EVIDENCE_LIFECYCLE: Record<EvidenceStatus, readonly EvidenceStatus[]> = {
  recorded: ["superseded", "contradicted", "rejected"],
  contradicted: ["superseded"],
  superseded: [],
  rejected: [],
};

/** Is this evidence transition legal? */
export function canTransitionEvidence(from: EvidenceStatus, to: EvidenceStatus): boolean {
  return EVIDENCE_LIFECYCLE[from].includes(to);
}

/**
 * The claim lifecycle.
 *
 *   asserted ──▶ contested    (a source-backed contradiction was recorded)
 *      └───────▶ retracted    (the workspace withdrew it — terminal)
 *
 * `contested ──▶ asserted` is deliberately **absent**. A claim that has been
 * contradicted does not quietly become uncontested because a later source
 * agreed with it: resolving that is a judgement about which source to believe,
 * and Phase 7 does not make judgements. The path forward is a fresh claim
 * carrying its own evidence.
 */
export const ACCOUNT_CLAIM_LIFECYCLE: Record<AccountClaimStatus, readonly AccountClaimStatus[]> = {
  asserted: ["contested", "retracted"],
  contested: ["retracted"],
  retracted: [],
};

/** Is this claim transition legal? */
export function canTransitionClaim(from: AccountClaimStatus, to: AccountClaimStatus): boolean {
  return ACCOUNT_CLAIM_LIFECYCLE[from].includes(to);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The deterministic identity of a claim on an account.
 *
 * One field per category per account. It is what makes repeated research runs
 * accumulate evidence against a single assertion instead of minting a new
 * claim every time, and it is the key a contradiction is detected on: two
 * records that share this key but disagree on `value` conflict.
 */
export function claimKey(category: ResearchCategory, field: string): string {
  return `${category}:${field}`;
}

/**
 * Does a source kind exist to be attributed to?
 *
 * A source outside DEALORA_BLUEPRINT.md §43 cannot be represented at all, so
 * it cannot be stored. There is no "unauthorized source" member to fall back
 * to.
 */
export function isPermittedSourceKind(value: unknown): value is ResearchSourceKind {
  return typeof value === "string" && PERMITTED_SOURCE_KINDS.includes(value as ResearchSourceKind);
}

/**
 * Can evidence with `provenance: "user_supplied"` claim this source kind?
 *
 * No. A record the workspace supplied itself is, by definition,
 * *user-provided data*. Letting a caller stamp `approved_api` or `public_web`
 * on it would let any workspace manufacture evidence that looks like it came
 * from a source DEALORA has not read. Only `account_record` is self-describing,
 * so only `account_record` is accepted here.
 */
export function isSelfAttributableSource(value: ResearchSourceKind): boolean {
  return value === "account_record";
}

// ---------------------------------------------------------------------------
// Issue collection
// ---------------------------------------------------------------------------

/** Collect field-level issues, as the other domain packages do. */
export class EvidenceIssues {
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

  toError(message: string): EvidenceError {
    return evidenceError("VALIDATION_ERROR", message, this.all());
  }
}

// ---------------------------------------------------------------------------
// Field-level validation
// ---------------------------------------------------------------------------

/** A trimmed, whitespace-collapsed string, or null when absent/blank. */
export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeText(value);
  return normalized === "" ? null : normalized;
}

/** An ISO instant, normalized, or null. Never guesses a date it was not given. */
function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * A source reference, or null — never constructed.
 *
 * A reference the source did not supply stays `null`; DEALORA will not build
 * a plausible URL from an account's domain to fill the gap. A reference that
 * was supplied but is not a valid `http(s)` URL fails the record rather than
 * being stored as something unusable.
 */
export function normalizeReference(value: unknown): { url: string | null; error: string | null } {
  if (value === undefined || value === null || value === "") return { url: null, error: null };
  if (typeof value !== "string") return { url: null, error: "sourceUrl must be a string" };
  if (value.length > LIMITS.sourceUrl) {
    return { url: null, error: `sourceUrl must be at most ${LIMITS.sourceUrl} characters` };
  }
  const normalized = normalizeUrl(value);
  if (normalized === null) return { url: null, error: "sourceUrl must be a valid http(s) URL" };
  return { url: normalized, error: null };
}

/**
 * Validate the caller-supplied part of a user-supplied evidence record.
 *
 * Everything here is untrusted input from a request body. `workspaceId`,
 * `userId` and `accountId` are **not** read from it: the workspace is the
 * route's, the identity the session's, and the account is resolved and
 * authorized server-side.
 */
export interface UserEvidenceInput {
  category?: unknown;
  field?: unknown;
  value?: unknown;
  claimKind?: unknown;
  sourceName?: unknown;
  sourceUrl?: unknown;
  sourceTitle?: unknown;
  observedAt?: unknown;
  confidence?: unknown;
  relevance?: unknown;
  note?: unknown;
}

/** A record that has passed every rule and is ready to persist. */
export interface NormalizedUserEvidence {
  category: ResearchCategory;
  field: string;
  value: string;
  claimKind: ResearchClaimKind;
  sourceName: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  observedAt: string | null;
  confidence: ResearchConfidence;
  relevance: ResearchRelevance;
  note: string | null;
}

/** Validate one user-supplied evidence record against the closed vocabularies. */
export function normalizeUserEvidence(input: UserEvidenceInput): {
  record: NormalizedUserEvidence | null;
  error: EvidenceError | null;
} {
  const issues = new EvidenceIssues();

  const category = input.category;
  if (typeof category !== "string" || !RESEARCH_CATEGORIES.includes(category as ResearchCategory)) {
    issues.add("category", `category must be one of: ${RESEARCH_CATEGORIES.join(", ")}`);
  }

  const field = text(input.field)?.toLowerCase() ?? null;
  if (field === null) {
    issues.add("field", "field is required");
  } else if (field.length > LIMITS.field) {
    issues.add("field", `field must be at most ${LIMITS.field} characters`);
  } else if (!/^[a-z0-9][a-z0-9_.-]*$/.test(field)) {
    issues.add(
      "field",
      "field must be a lowercase key of letters, digits, dots, dashes or underscores",
    );
  }

  const value = text(input.value);
  if (value === null) {
    issues.add("value", "value is required");
  } else if (value.length > LIMITS.value) {
    issues.add("value", `value must be at most ${LIMITS.value} characters`);
  }

  const claimKind = input.claimKind;
  if (
    typeof claimKind !== "string" ||
    !RESEARCH_CLAIM_KINDS.includes(claimKind as ResearchClaimKind)
  ) {
    issues.add("claimKind", `claimKind must be one of: ${RESEARCH_CLAIM_KINDS.join(", ")}`);
  }

  // A user-supplied record is always attributed to the workspace's own record.
  // The kind is not a caller choice: it follows from the provenance.
  const sourceName = text(input.sourceName);
  if (sourceName === null) {
    issues.add("sourceName", "sourceName is required");
  } else if (sourceName.length > LIMITS.sourceName) {
    issues.add("sourceName", `sourceName must be at most ${LIMITS.sourceName} characters`);
  }

  const reference = normalizeReference(input.sourceUrl);
  if (reference.error) issues.add("sourceUrl", reference.error);

  const sourceTitle = text(input.sourceTitle);
  if (sourceTitle !== null && sourceTitle.length > LIMITS.sourceTitle) {
    issues.add("sourceTitle", `sourceTitle must be at most ${LIMITS.sourceTitle} characters`);
  }

  let observedAt: string | null = null;
  if (input.observedAt !== undefined && input.observedAt !== null && input.observedAt !== "") {
    if (typeof input.observedAt !== "string") {
      issues.add("observedAt", "observedAt must be a string");
    } else {
      observedAt = instant(input.observedAt);
      if (observedAt === null) {
        issues.add("observedAt", "observedAt must be an ISO 8601 timestamp");
      }
    }
  }

  const confidence = input.confidence;
  if (typeof confidence !== "string" || !["low", "medium", "high"].includes(confidence)) {
    issues.add("confidence", "confidence must be one of: low, medium, high");
  }

  const relevance = input.relevance;
  if (typeof relevance !== "string" || !["low", "medium", "high"].includes(relevance)) {
    issues.add("relevance", "relevance must be one of: low, medium, high");
  }

  const note = text(input.note);
  if (note !== null && note.length > LIMITS.note) {
    issues.add("note", `note must be at most ${LIMITS.note} characters`);
  }

  if (issues.length > 0) {
    return { record: null, error: issues.toError("the evidence record is not valid") };
  }

  return {
    record: {
      category: category as ResearchCategory,
      field: field as string,
      value: value as string,
      claimKind: claimKind as ResearchClaimKind,
      sourceName: sourceName as string,
      sourceUrl: reference.url,
      sourceTitle,
      observedAt,
      // Freshness is derived by the caller from `observedAt`: it is temporal
      // metadata, never a function of the confidence band.
      confidence: confidence as ResearchConfidence,
      relevance: relevance as ResearchRelevance,
      note,
    },
    error: null,
  };
}

/** Do two records for the same claim field disagree? */
export function isContradiction(claim: AccountClaim, candidateValue: string): boolean {
  return claim.value !== candidateValue;
}

/** The user-facing summary of a superseded/contradicted/rejected record. */
export function evidenceStatusMessage(status: EvidenceStatus): string {
  switch (status) {
    case "superseded":
      return "this evidence was replaced by a later record for the same claim";
    case "contradicted":
      return "another source-backed record states a different value for this claim";
    case "rejected":
      return "this evidence was rejected as support for the claim";
    default:
      return "this evidence is recorded and carries no competing record";
  }
}
