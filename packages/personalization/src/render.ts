import type {
  AccountClaim,
  Contact,
  DraftPersonalizationPoint,
  Evidence,
  PersonalizedDraft,
} from "@dealora/db";

import {
  LIMITS,
  bounded,
  draftContextDigest,
  orderPoints,
  renderOfferParagraph,
  renderPointStatement,
  sortedIds,
} from "./rules.js";
import type { PersonalizationApprovedClaim, PersonalizationOfferSnapshot } from "./types.js";

/**
 * The renderer.
 *
 * A pure function of its input. No clock, no randomness, no network, no model,
 * no storage: given the same account, claims, evidence, qualification, offer,
 * contact, approved claims and renderer version, it returns the same subject,
 * body, points and warnings byte for byte. That is what makes a draft
 * reproducible and therefore auditable — a draft an approval was granted on can
 * be re-derived later to prove nothing about it changed.
 *
 * The renderer can only compose from three kinds of piece, and each piece is a
 * stored record quoted verbatim:
 *
 *  1. **Personalization points** — evidence-backed account claims. A claim
 *     counts only when it is `asserted`, carries at least one `recorded`
 *     evidence record, and has no `contradicted` evidence on record. The value
 *     is quoted verbatim and attributed to its source; the renderer never
 *     paraphrases, because a paraphrase is where a fabricated fact would enter.
 *  2. **Approved Business Brain claims** — Phase 2 claims whose status is
 *     `approved`, quoted verbatim. Unverified text is context, not quotable
 *     text; restricted text never appears.
 *  3. **The offer's own description** — quoted verbatim, with the outcome when
 *     the business stated one. Pricing is never rendered: an unapproved price
 *     is recorded as a warning instead.
 *
 * Everything else the renderer could not honestly state is recorded in
 * `warnings` — a draft that found nothing says so rather than inventing
 * familiarity.
 */

/** Everything the renderer reads, already resolved and authorized. */
export interface DraftRenderInput {
  rendererVersion: string;
  account: { id: string; name: string };
  contact: Pick<Contact, "id" | "fullName"> | null;
  qualificationId: string | null;
  offer: PersonalizationOfferSnapshot;
  claims: readonly AccountClaim[];
  evidence: readonly Evidence[];
  approvedClaims: readonly PersonalizationApprovedClaim[];
}

export interface DraftRenderOutput {
  subject: string;
  body: string;
  points: DraftPersonalizationPoint[];
  approvedClaimIds: string[];
  warnings: string[];
  contextDigest: string;
}

/** The evidence attached to one claim, split into support and contradiction. */
interface ClaimReading {
  claim: AccountClaim;
  support: Evidence[];
  conflict: Evidence[];
}

function readingFor(claim: AccountClaim, evidence: readonly Evidence[]): ClaimReading {
  const support: Evidence[] = [];
  const conflict: Evidence[] = [];
  for (const record of evidence) {
    if (record.accountClaimId !== claim.id) continue;
    if (record.status === "recorded") support.push(record);
    else if (record.status === "contradicted") conflict.push(record);
  }
  return { claim, support, conflict };
}

/** Closed confidence vocabulary, ranked weakest first. */
type ConfidenceBand = DraftPersonalizationPoint["confidence"];

/** Closed relevance vocabulary, ranked weakest first. */
type RelevanceBand = DraftPersonalizationPoint["relevance"];

const CONFIDENCE_RANK: Record<ConfidenceBand, number> = { low: 1, medium: 2, high: 3 };

const RELEVANCE_RANK: Record<RelevanceBand, number> = { low: 1, medium: 2, high: 3 };

/** The weakest confidence band among records, or `low` when the list is empty. */
function weakestConfidence(records: readonly Evidence[]): ConfidenceBand {
  let weakest: ConfidenceBand = "high";
  for (const record of records) {
    if (CONFIDENCE_RANK[record.confidence] < CONFIDENCE_RANK[weakest]) weakest = record.confidence;
  }
  return weakest;
}

/** The best relevance band among records, or `low` when the list is empty. */
function bestRelevance(records: readonly Evidence[]): RelevanceBand {
  let best: RelevanceBand = "low";
  for (const record of records) {
    if (RELEVANCE_RANK[record.relevance] > RELEVANCE_RANK[best]) best = record.relevance;
  }
  return best;
}

/**
 * The newest support record for a citation: the source a reader would check
 * first. Ties break by id, deterministically.
 */
function newestSupport(support: readonly Evidence[]): Evidence | null {
  let newest: Evidence | null = null;
  for (const record of support) {
    if (
      newest === null ||
      record.retrievedAt > newest.retrievedAt ||
      (record.retrievedAt === newest.retrievedAt && record.id < newest.id)
    ) {
      newest = record;
    }
  }
  return newest;
}

/**
 * Render the draft. The assembly order is fixed and each decision is stated in
 * the record, because an output nobody can restate is an output nobody can
 * audit:
 *
 * - points: at most {@link LIMITS.maxPoints}, in {@link orderPoints} order;
 * - approved claims: at most {@link LIMITS.maxApprovedClaims}, in stored
 *   creation order, quoted verbatim;
 * - subject: the offer and the account, nothing else;
 * - body: greeting → observations → offer → approved claims → closing;
 * - warnings: everything the renderer refused to state, said out loud.
 */
export function renderDraft(input: DraftRenderInput): DraftRenderOutput {
  const warnings: string[] = [];
  const points: DraftPersonalizationPoint[] = [];
  const contested: AccountClaim[] = [];

  const readings = input.claims
    .filter((claim) => claim.status !== "retracted")
    .map((claim) => readingFor(claim, input.evidence));

  for (const reading of readings) {
    if (reading.support.length === 0) continue;
    if (reading.claim.status === "contested" || reading.conflict.length > 0) {
      contested.push(reading.claim);
      continue;
    }
    const cited = newestSupport(reading.support);
    if (cited === null) continue;
    points.push({
      category: reading.claim.category,
      field: reading.claim.field,
      value: reading.claim.value,
      claimId: reading.claim.id,
      evidenceIds: sortedIds(reading.support.map((record) => record.id)),
      sourceName: cited.sourceName,
      observedAt: cited.observedAt,
      confidence: weakestConfidence(reading.support),
      relevance: bestRelevance(reading.support),
      statement: renderPointStatement(reading.claim.value, cited.sourceName, cited.observedAt),
    });
  }

  const ordered = orderPoints(points).slice(0, LIMITS.maxPoints);
  if (points.length > ordered.length) {
    warnings.push(
      bounded(
        `${points.length - ordered.length} further eligible observation(s) were left out to keep the draft brief.`,
        LIMITS.warning,
      ),
    );
  }

  const approvedClaims = [...input.approvedClaims]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, LIMITS.maxApprovedClaims);

  if (contested.length > 0) {
    warnings.push(
      bounded(
        `${contested.length} contested observation(s) were excluded: the sources disagree, and a disagreement is never stated as fact.`,
        LIMITS.warning,
      ),
    );
  }
  if (ordered.length === 0) {
    warnings.push(
      bounded(
        "No eligible source-backed evidence about this account was found, so the draft makes no account-specific factual statement.",
        LIMITS.warning,
      ),
    );
  }
  if (!input.offer.pricingApproved) {
    warnings.push(
      bounded(
        "The offer's pricing is not approved for external use, so no pricing is stated.",
        LIMITS.warning,
      ),
    );
  }
  if (input.contact === null) {
    warnings.push(
      bounded(
        "No contact is attached, so the draft is not addressed to a specific person.",
        LIMITS.warning,
      ),
    );
  }

  const subject = bounded(`${input.offer.name} for ${input.account.name}`, LIMITS.subject);

  const lines: string[] = [];
  lines.push(input.contact === null ? "Hi there," : `Hi ${input.contact.fullName},`);
  lines.push("");
  if (ordered.length > 0) {
    lines.push(`Here is what stood out when we looked at ${input.account.name}:`);
    for (const point of ordered) {
      lines.push(`- ${point.statement}`);
    }
    lines.push("");
  }
  lines.push(renderOfferParagraph(input.offer));
  if (approvedClaims.length > 0) {
    lines.push("");
    for (const claim of approvedClaims) {
      lines.push(claim.text);
    }
  }
  lines.push("");
  lines.push("Would a short conversation be useful?");
  const body = bounded(lines.join("\n"), LIMITS.body);

  return {
    subject,
    body,
    points: ordered,
    approvedClaimIds: sortedIds(approvedClaims.map((claim) => claim.id)),
    warnings,
    contextDigest: draftContextDigest({
      rendererVersion: input.rendererVersion,
      qualificationId: input.qualificationId,
      offerId: input.offer.id,
      contactId: input.contact?.id ?? null,
    }),
  };
}

/** Re-exported for the service, which persists the rendered document. */
export type RenderedDraft = Pick<
  PersonalizedDraft,
  "subject" | "body" | "personalizationPoints" | "approvedClaimIds" | "warnings" | "contextDigest"
>;
