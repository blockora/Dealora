import type {
  DraftPersonalizationPoint,
  EntityId,
  ResearchCategory,
  ResearchRelevance,
} from "@dealora/db";

import type { PersonalizationOfferSnapshot } from "./types.js";

/**
 * The renderer's rules, as data.
 *
 * Everything a draft depends on that is not the account's own evidence lives
 * here, in one file. There is nowhere else for a made-up sentence to hide: the
 * renderer can only compose from these pieces, and every piece carries its
 * provenance.
 *
 * Bump {@link PERSONALIZATION_RENDERER_VERSION} whenever a template, an
 * ordering rule or a limit changes. Existing drafts keep the version that
 * produced them, so a draft an approval was granted on stays readable after the
 * renderer moves on.
 */
export const PERSONALIZATION_RENDERER_VERSION = "deterministic-1.0.0";

/** Every renderer this deployment implements. A caller may only ask for one of these. */
export const SUPPORTED_RENDERER_VERSIONS: readonly string[] = [PERSONALIZATION_RENDERER_VERSION];

/** Hard bounds so an oversized input fails fast instead of bloating a draft. */
export const LIMITS = {
  subject: 200,
  body: 4000,
  statement: 400,
  warning: 300,
  /** Brevity is a roadmap priority: at most three observations in one draft. */
  maxPoints: 3,
  /** And at most two approved business claims. */
  maxApprovedClaims: 2,
} as const;

/**
 * Which observation buckets make the most useful openers, in order.
 *
 * Roadmap priorities: specificity, relevance, recency, evidence, usefulness,
 * brevity. A recent announcement or an expansion is specific and checkable; a
 * company-overview line rarely is. This order breaks ties — it never overrides
 * the evidence's own relevance and recency, which are sorted first.
 */
export const CATEGORY_PRIORITY: readonly ResearchCategory[] = [
  "recent_announcements",
  "expansion",
  "hiring",
  "leadership_changes",
  "technology_signals",
  "products_services",
  "company_overview",
  "industry",
  "business_model",
  "public_business_changes",
];

/** A stable order for reference lists, so two runs serialize identically. */
export function sortedIds(ids: Iterable<EntityId>): EntityId[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Truncate to a bound without ever returning an empty string mid-word. */
export function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
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
 * Deterministic digest of the exact context a draft was rendered from.
 *
 * The draft must not copy the records it quotes — the claim, evidence and
 * approved-claim records are the single source of truth and are joined on read
 * — but a historical draft still has to stay interpretable. So the record keeps
 * the qualification, offer and contact references plus this digest, the same
 * pattern a Phase 8 qualification uses with its ICP and goal, and a Phase 4
 * plan with its `brainSnapshotDigest`.
 *
 * FNV-1a over a canonical (key-sorted) serialization: no randomness, no crypto
 * dependency, stable across processes. A fingerprint for comparison, not a
 * security primitive.
 */
export function draftContextDigest(input: {
  rendererVersion: string;
  qualificationId: EntityId | null;
  offerId: EntityId | null;
  contactId: EntityId | null;
}): string {
  const canonical = canonicalJson(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * The month a source says a statement was true, or `null` when it says none.
 *
 * Read from the stored `observedAt`, never guessed and never defaulted to now.
 */
export function observedMonth(observedAt: string | null): string | null {
  if (observedAt === null) return null;
  const parsed = new Date(observedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${MONTHS[parsed.getUTCMonth()] ?? ""} ${parsed.getUTCFullYear()}`.trim();
}

/**
 * The citation a point is attributed with: the source's name and, when the
 * source recorded one, the month of the observation. Built from stored fields
 * only, so two drafts from the same records always cite identically.
 */
export function citation(sourceName: string, observedAt: string | null): string {
  const month = observedMonth(observedAt);
  return month === null ? sourceName : `${sourceName}, ${month}`;
}

/** The ranking of a relevance band, highest first. */
const RELEVANCE_ORDER: Record<ResearchRelevance, number> = { high: 3, medium: 2, low: 1 };

/**
 * Order personalization points the way the roadmap asks: most relevant first,
 * then most recent, then by the fixed category priority, then stably by field
 * and claim id. Nothing about the account changes the order; only the records
 * do.
 */
export function orderPoints(
  points: readonly DraftPersonalizationPoint[],
): DraftPersonalizationPoint[] {
  return [...points].sort((a, b) => {
    const relevance = RELEVANCE_ORDER[b.relevance] - RELEVANCE_ORDER[a.relevance];
    if (relevance !== 0) return relevance;
    const aTime = a.observedAt === null ? 0 : Date.parse(a.observedAt);
    const bTime = b.observedAt === null ? 0 : Date.parse(b.observedAt);
    if (aTime !== bTime) return bTime - aTime;
    const category =
      CATEGORY_PRIORITY.indexOf(a.category) === -1
        ? CATEGORY_PRIORITY.length
        : CATEGORY_PRIORITY.indexOf(a.category);
    const categoryB =
      CATEGORY_PRIORITY.indexOf(b.category) === -1
        ? CATEGORY_PRIORITY.length
        : CATEGORY_PRIORITY.indexOf(b.category);
    if (category !== categoryB) return category - categoryB;
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0;
  });
}

/**
 * The one sentence a draft states for one observation, and the only way a
 * claim value reaches a body.
 *
 * The value is quoted verbatim between typographic quotes and attributed to
 * its source and month. Nothing is added, removed, reworded or "improved": a
 * paraphrase is where a fabricated fact would enter, so the renderer does not
 * produce one.
 */
export function renderPointStatement(
  value: string,
  sourceName: string,
  observedAt: string | null,
): string {
  return bounded(`"${value}" — ${citation(sourceName, observedAt)}.`, LIMITS.statement);
}

/**
 * The offer paragraph: the business's own description, quoted verbatim, with
 * the outcome when the business stated one.
 *
 * Pricing is deliberately never rendered. Whether the price may be stated is
 * the offer's own `approved` flag; when it is false the draft's warnings say
 * pricing was withheld rather than silently publishing or silently dropping it.
 */
export function renderOfferParagraph(offer: PersonalizationOfferSnapshot): string {
  const outcome =
    offer.outcome === null || offer.outcome.trim() === ""
      ? ""
      : ` The outcome it aims for: ${offer.outcome.trim()}`;
  return `About ${offer.name}: ${offer.description.trim()}${outcome}`;
}
