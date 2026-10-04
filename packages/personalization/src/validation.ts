import { normalizeText } from "@dealora/account";

import { PERSONALIZATION_RENDERER_VERSION, SUPPORTED_RENDERER_VERSIONS } from "./rules.js";

/**
 * Validation and the read models a caller inspects.
 *
 * Every function here is pure: nothing reads global state and nothing performs
 * I/O.
 */

/** Is this a renderer this deployment implements? */
export function isSupportedRendererVersion(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_RENDERER_VERSIONS.includes(value);
}

/**
 * The lifecycle question, answered once.
 *
 * There is no `canTransitionDraft`. A draft is an immutable, versioned
 * document: regenerating inserts a new record rather than moving the old one,
 * so there is no state for a caller to advance and no path by which a draft an
 * approval was granted on can be rewritten. Approval is Phase 10
 * (`ROADMAP.md` §17); a draft that changed is a new version that needs its own
 * approval.
 */
export const DRAFTS_ARE_IMMUTABLE = true;

/** The only state a Phase 9 draft can be in: a document awaiting review. */
export const DRAFT_STATUS = "draft" as const;

/**
 * The renderer a workspace would be drafting with, inspectable on its own
 * terms.
 *
 * The point of exposing this is the same as the qualification criteria
 * inspector: the rules a draft will be composed under are readable before any
 * draft exists, rather than only as a by-product of one.
 */
export interface RendererView {
  rendererVersion: string;
  supportedRendererVersions: string[];
  /** What the renderer may state, and what it may never state. */
  mayState: string[];
  mayNeverState: string[];
}

export function describeRenderer(): RendererView {
  return {
    rendererVersion: PERSONALIZATION_RENDERER_VERSION,
    supportedRendererVersions: [...SUPPORTED_RENDERER_VERSIONS],
    mayState: [
      "observations quoted verbatim from evidence-backed account claims, attributed to their source",
      "Business Brain claims whose status is approved, quoted verbatim",
      "the active offer's own name, description and stated outcome",
      "a greeting and a closing that assert nothing",
    ],
    mayNeverState: [
      "any fact about the account that no eligible evidence record supports",
      "any claim whose status is unverified or restricted",
      "a contested observation stated as fact",
      "pricing the business has not approved for external use",
      "a recipient address, a channel, a provider or a delivery result",
    ],
  };
}

/** A trimmed, whitespace-collapsed string, or null when absent/blank. */
export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeText(value);
  return normalized === "" ? null : normalized;
}
