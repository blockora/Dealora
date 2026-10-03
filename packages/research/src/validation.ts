import { normalizeText, normalizeUrl } from "@dealora/account";
import type {
  ResearchCategory,
  ResearchClaimKind,
  ResearchConfidence,
  ResearchFinding,
  ResearchFreshness,
  ResearchRelevance,
  ResearchRequestStatus,
  ResearchSourceKind,
} from "@dealora/db";

import type { RawProviderFinding, ResearchError, ResearchProvider } from "./types.js";
import { researchError } from "./types.js";

/**
 * Normalization, validation and the lifecycle rule.
 *
 * Every function here is pure: the current time arrives as a parameter, ids
 * arrive as parameters, and nothing reads global state or performs I/O. Given
 * the same provider output and the same clock, the same findings come out.
 */

export const LIMITS = {
  field: 100,
  value: 2000,
  sourceUrl: 500,
  sourceTitle: 300,
  note: 1000,
  idempotencyKey: 200,
  maxFindings: 200,
  maxCategories: 10,
} as const;

/**
 * Research categories — exactly the list ROADMAP.md §13 gives for Phase 6.
 *
 * These are observation buckets, never scores. There is deliberately no
 * buying-intent, funding, competitor, technology-fingerprint or qualification
 * category: ROADMAP.md does not put them in Phase 6, and inventing them here
 * would be the scope creep this phase forbids.
 */
export const RESEARCH_CATEGORIES: readonly ResearchCategory[] = [
  "company_overview",
  "industry",
  "business_model",
  "products_services",
  "recent_announcements",
  "hiring",
  "expansion",
  "leadership_changes",
  "technology_signals",
  "public_business_changes",
];

/** Permitted source kinds (DEALORA_BLUEPRINT.md §43). */
export const RESEARCH_SOURCE_KINDS: readonly ResearchSourceKind[] = [
  "account_record",
  "approved_api",
  "public_web",
];

/**
 * Explicit epistemic labels (ROADMAP.md §13: "Never treat inference as fact").
 *
 * `fact` means *this source states this*. It does not mean DEALORA verified
 * it — nothing in Phase 6 verifies anything.
 */
export const RESEARCH_CLAIM_KINDS: readonly ResearchClaimKind[] = [
  "fact",
  "inference",
  "hypothesis",
  "recommendation",
];

export const RESEARCH_CONFIDENCES: readonly ResearchConfidence[] = ["low", "medium", "high"];
export const RESEARCH_RELEVANCES: readonly ResearchRelevance[] = ["low", "medium", "high"];
export const RESEARCH_FRESHNESS: readonly ResearchFreshness[] = [
  "unknown",
  "fresh",
  "recent",
  "stale",
];

export const RESEARCH_REQUEST_STATUSES: readonly ResearchRequestStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

/** States in which a request still occupies the account's research slot. */
export const ACTIVE_RESEARCH_STATUSES: readonly ResearchRequestStatus[] = ["pending", "running"];

/**
 * The lifecycle, and nothing more.
 *
 *   pending ──▶ running ──▶ completed
 *      │            ├──────▶ failed ──▶ running   (retry)
 *      │            └──────▶ cancelled
 *      └───────────────────▶ cancelled
 *
 * `completed` and `cancelled` are terminal. A retry re-runs the same request
 * rather than creating a second one, which is what makes a retry idempotent.
 */
export const RESEARCH_LIFECYCLE: Record<ResearchRequestStatus, readonly ResearchRequestStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  failed: ["running"],
  completed: [],
  cancelled: [],
};

/** Is this transition legal? Illegal transitions are rejected, never fudged. */
export function canTransition(from: ResearchRequestStatus, to: ResearchRequestStatus): boolean {
  return RESEARCH_LIFECYCLE[from].includes(to);
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

const FRESH_DAYS = 30;
const RECENT_DAYS = 180;

/**
 * Freshness as a band, derived from the observation age at retrieval time.
 *
 * Deliberately coarse and timestamp-based (ROADMAP.md asks for a freshness
 * value, not a freshness score). A source that reported no observation date
 * is `unknown` rather than `fresh`: DEALORA will not claim currency it cannot
 * see.
 */
export function freshnessFor(observedAt: string | null, now: Date): ResearchFreshness {
  if (observedAt === null) return "unknown";
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) return "unknown";
  const ageDays = (now.getTime() - observed.getTime()) / 86_400_000;
  if (ageDays <= FRESH_DAYS) return "fresh";
  if (ageDays <= RECENT_DAYS) return "recent";
  return "stale";
}

// ---------------------------------------------------------------------------
// Issue collection
// ---------------------------------------------------------------------------

/** Collect field-level issues, as the other domain packages do. */
export class ResearchIssues {
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

  toError(message: string): ResearchError {
    return researchError("VALIDATION_ERROR", message, this.all());
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Normalize the requested categories.
 *
 * Absent means "every permitted category"; present means exactly that list.
 * Duplicates are collapsed and order is preserved, so the same request always
 * describes the same scope.
 */
export function normalizeCategories(value: unknown): {
  categories: ResearchCategory[] | null;
  error: ResearchError | null;
} {
  if (value === undefined || value === null) {
    return { categories: [...RESEARCH_CATEGORIES], error: null };
  }
  if (!Array.isArray(value)) {
    return {
      categories: null,
      error: researchError("VALIDATION_ERROR", "categories must be an array", [
        { field: "categories", message: "categories must be an array of category names" },
      ]),
    };
  }
  if (value.length === 0) {
    return {
      categories: null,
      error: researchError("VALIDATION_ERROR", "at least one category is required", [
        { field: "categories", message: "categories must not be empty" },
      ]),
    };
  }
  if (value.length > LIMITS.maxCategories) {
    return {
      categories: null,
      error: researchError("VALIDATION_ERROR", "too many categories", [
        {
          field: "categories",
          message: `at most ${LIMITS.maxCategories} categories may be requested`,
        },
      ]),
    };
  }
  const issues = new ResearchIssues();
  const categories: ResearchCategory[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !RESEARCH_CATEGORIES.includes(entry as ResearchCategory)) {
      issues.add("categories", `categories must be a subset of: ${RESEARCH_CATEGORIES.join(", ")}`);
      continue;
    }
    const category = entry as ResearchCategory;
    if (!categories.includes(category)) categories.push(category);
  }
  if (issues.length > 0) return { categories: null, error: issues.toError("invalid categories") };
  return { categories, error: null };
}

// ---------------------------------------------------------------------------
// Provider output
// ---------------------------------------------------------------------------

/** A finding that has passed every domain rule and is ready to persist. */
export interface NormalizedFinding {
  category: ResearchCategory;
  field: string;
  value: string;
  claimKind: ResearchClaimKind;
  source: ResearchSourceKind;
  sourceName: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  observedAt: string | null;
  retrievedAt: string;
  confidence: ResearchConfidence;
  freshness: ResearchFreshness;
  relevance: ResearchRelevance;
  note: string | null;
  status: ResearchFinding["status"];
}

/**
 * The deterministic identity of a finding inside one run.
 *
 * One field per category per run. It is what makes a retry idempotent: a
 * second run of the same request recognizes its own earlier findings instead
 * of piling up near-duplicates.
 */
export function findingKey(category: ResearchCategory, field: string): string {
  return `${category}:${field}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trimmed, whitespace-collapsed string, or null when absent/blank. */
function text(value: unknown): string | null {
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
 * Validate and normalize one provider observation.
 *
 * Returns `null` and fills `issues` when the observation is unusable.
 */
function normalizeOne(
  raw: RawProviderFinding,
  ctx: { provider: ResearchProvider; scope: readonly ResearchCategory[]; now: Date },
  issues: ResearchIssues,
): NormalizedFinding | null {
  if (!isPlainObject(raw)) {
    issues.add("findings", "each finding must be an object");
    return null;
  }

  // Category: must be permitted *and* inside this request's scope. A provider
  // cannot answer a question it was not asked.
  const category = raw.category;
  if (typeof category !== "string" || !RESEARCH_CATEGORIES.includes(category as ResearchCategory)) {
    issues.add("category", `category must be one of: ${RESEARCH_CATEGORIES.join(", ")}`);
  } else if (!ctx.scope.includes(category as ResearchCategory)) {
    issues.add("category", `category "${category}" was not requested by this research request`);
  }

  // Field: a stable, lowercase key inside the category.
  const field = text(raw.field)?.toLowerCase() ?? null;
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

  const value = text(raw.value);
  if (value === null) {
    issues.add("value", "value is required");
  } else if (value.length > LIMITS.value) {
    issues.add("value", `value must be at most ${LIMITS.value} characters`);
  }

  const claimKind = raw.claimKind;
  if (
    typeof claimKind !== "string" ||
    !RESEARCH_CLAIM_KINDS.includes(claimKind as ResearchClaimKind)
  ) {
    issues.add("claimKind", `claimKind must be one of: ${RESEARCH_CLAIM_KINDS.join(", ")}`);
  }

  const confidence = raw.confidence;
  if (
    typeof confidence !== "string" ||
    !RESEARCH_CONFIDENCES.includes(confidence as ResearchConfidence)
  ) {
    issues.add("confidence", `confidence must be one of: ${RESEARCH_CONFIDENCES.join(", ")}`);
  }

  const relevance = raw.relevance;
  if (
    typeof relevance !== "string" ||
    !RESEARCH_RELEVANCES.includes(relevance as ResearchRelevance)
  ) {
    issues.add("relevance", `relevance must be one of: ${RESEARCH_RELEVANCES.join(", ")}`);
  }

  // Provenance. A citation the provider did not supply stays null; a citation
  // it supplied must be a real http(s) URL or the observation is rejected
  // rather than stored as something unusable.
  let sourceUrl: string | null = null;
  if (raw.sourceUrl !== undefined && raw.sourceUrl !== null && raw.sourceUrl !== "") {
    if (typeof raw.sourceUrl !== "string") {
      issues.add("sourceUrl", "sourceUrl must be a string");
    } else if (raw.sourceUrl.length > LIMITS.sourceUrl) {
      issues.add("sourceUrl", `sourceUrl must be at most ${LIMITS.sourceUrl} characters`);
    } else {
      const normalized = normalizeUrl(raw.sourceUrl);
      if (normalized === null) {
        issues.add("sourceUrl", "sourceUrl must be a valid http(s) URL");
      } else {
        sourceUrl = normalized;
      }
    }
  }

  const sourceTitle = text(raw.sourceTitle);
  if (sourceTitle !== null && sourceTitle.length > LIMITS.sourceTitle) {
    issues.add("sourceTitle", `sourceTitle must be at most ${LIMITS.sourceTitle} characters`);
  }

  let observedAt: string | null = null;
  if (raw.observedAt !== undefined && raw.observedAt !== null && raw.observedAt !== "") {
    if (typeof raw.observedAt !== "string") {
      issues.add("observedAt", "observedAt must be a string");
    } else {
      observedAt = instant(raw.observedAt);
      if (observedAt === null) {
        issues.add("observedAt", "observedAt must be an ISO 8601 timestamp");
      }
    }
  }

  const note = text(raw.note);
  if (note !== null && note.length > LIMITS.note) {
    issues.add("note", `note must be at most ${LIMITS.note} characters`);
  }

  if (issues.length > 0) return null;

  const retrievedAt = ctx.now.toISOString();
  return {
    category: category as ResearchCategory,
    field: field as string,
    value: value as string,
    claimKind: claimKind as ResearchClaimKind,
    source: ctx.provider.source,
    sourceName: ctx.provider.id,
    sourceUrl,
    sourceTitle,
    observedAt,
    retrievedAt,
    confidence: confidence as ResearchConfidence,
    freshness: freshnessFor(observedAt, ctx.now),
    relevance: relevance as ResearchRelevance,
    note,
    status: "recorded",
  };
}

/**
 * Validate a whole provider answer before anything is persisted.
 *
 * All-or-nothing on purpose: a run either records a fully validated set of
 * findings or records none, so a malformed response can never leave half a
 * brief behind.
 *
 * Duplicate policy, matching the Phase 5 convention: an identical repeat of a
 * field collapses silently (same observation, stated twice), while two
 * *different* values for the same field are a contradiction DEALORA refuses
 * to resolve on the user's behalf.
 */
export function normalizeProviderFindings(
  raw: readonly RawProviderFinding[],
  ctx: { provider: ResearchProvider; scope: readonly ResearchCategory[]; now: Date },
): { findings: NormalizedFinding[]; error: ResearchError | null } {
  if (!Array.isArray(raw)) {
    return {
      findings: [],
      error: researchError("VALIDATION_ERROR", "provider returned malformed output", [
        { field: "findings", message: "findings must be an array" },
      ]),
    };
  }
  if (raw.length > LIMITS.maxFindings) {
    return {
      findings: [],
      error: researchError("VALIDATION_ERROR", "provider returned too many findings", [
        { field: "findings", message: `at most ${LIMITS.maxFindings} findings per run` },
      ]),
    };
  }

  const issues = new ResearchIssues();
  // A provider declares which permitted source it speaks for. One outside the
  // closed list is refused before any of its output is read: an unregistered
  // source kind is exactly the shape of a source DEALORA may not use.
  if (!RESEARCH_SOURCE_KINDS.includes(ctx.provider.source)) {
    issues.add("source", `provider source must be one of: ${RESEARCH_SOURCE_KINDS.join(", ")}`);
  }

  const findings: NormalizedFinding[] = [];
  const seen = new Map<string, string>();

  for (const entry of raw) {
    // A malformed item records its issues and is skipped; the run fails at the
    // end, so nothing partial is ever persisted.
    const finding = normalizeOne(entry, ctx, issues);
    if (finding === null) continue;
    const key = findingKey(finding.category, finding.field);
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, finding.value);
      findings.push(finding);
      continue;
    }
    if (previous !== finding.value) {
      issues.add(
        "field",
        `the provider reported two different values for "${key}"; the observation is ambiguous`,
      );
    }
    // Identical repeat: collapsed, not stored twice.
  }

  if (issues.length > 0) {
    return {
      findings: [],
      error: researchError("VALIDATION_ERROR", "the provider returned unusable observations", [
        ...issues.all(),
      ]),
    };
  }
  return { findings, error: null };
}

/** The safe, caller-facing summary of a provider refusal. */
export function providerFailureMessage(code: string): string {
  switch (code) {
    case "unavailable":
      return "the research source is not available right now";
    case "invalid_output":
      return "the research source returned data that could not be validated";
    default:
      return "the research source failed to answer";
  }
}
