import type { GoalCompleteness, GoalMetricKind, RevenueGoal, RevenueGoalStatus } from "@dealora/db";

/**
 * Domain error vocabulary for the Revenue Goal Engine.
 *
 * Closed and safe to render: storage codes are translated into these before
 * they reach the API boundary.
 */
export type GoalErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "UNAVAILABLE";

export interface GoalError {
  code: GoalErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export function goalError(
  code: GoalErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): GoalError {
  return details ? { code, message, details } : { code, message };
}

export type { GoalCompleteness, GoalMetricKind, RevenueGoal, RevenueGoalStatus };

/**
 * Where a piece of goal information came from.
 *
 * This separation is the core safety property of Phase 3: the system must
 * never present an assumption or an inference as a user-stated fact.
 */
export type GoalFieldOrigin =
  /** Stated directly by the user in the input. */
  | "explicit"
  /** Derived from canonical Business Brain data, not invented. */
  | "inferred"
  /** A rule the engine applied; recorded so it can be challenged. */
  | "assumption"
  /** Not determinable from the input or the Business Brain. */
  | "unknown";

export interface GoalDraftField<T> {
  value: T | null;
  origin: GoalFieldOrigin;
  /** Human-readable justification, required for non-explicit origins. */
  note?: string;
}

/**
 * The parser's output. A structured *draft*, not a persisted goal: it carries
 * provenance for every field so the domain layer can decide what is
 * trustworthy before anything is stored.
 */
export interface GoalDraft {
  input: string;
  fields: {
    objective: GoalDraftField<string>;
    targetMetric: GoalDraftField<GoalMetricKind>;
    targetValue: GoalDraftField<number>;
    currency: GoalDraftField<string>;
    timeWindow: GoalDraftField<{ start: string; end: string }>;
    market: GoalDraftField<string>;
    offerId: GoalDraftField<string>;
    icpId: GoalDraftField<string>;
    buyerPersonaIds: GoalDraftField<string[]>;
    minimumContractValue: GoalDraftField<number>;
    constraints: GoalDraftField<{
      geographies: string[];
      industries: string[];
      companySizes: string[];
      channels: string[];
    }>;
  };
  /** Business Brain references the parser could not resolve. */
  unresolvedReferences: { kind: "offer" | "icp" | "persona"; value: string }[];
}

/**
 * The parsing boundary.
 *
 * The deterministic implementation ships in this package. An LLM-backed
 * parser can be substituted later without touching the domain, because the
 * domain only ever consumes a {@link GoalDraft} with explicit provenance.
 */
export interface GoalParser {
  /**
   * @param input   the user's natural-language goal
   * @param context canonical Business Brain context for the workspace
   * @param now     reference instant, injected so parsing is deterministic
   */
  parse(input: string, context: BusinessBrainSnapshot, now: Date): GoalDraft;
}

/**
 * The slice of Business Brain the parser may read.
 *
 * Kept deliberately small so the parser cannot depend on the whole Brain
 * surface, and so a reference can only ever come from canonical context.
 */
export interface BusinessBrainSnapshot {
  workspaceId: string;
  company: { name: string; market: string | null; industry: string | null } | null;
  offers: { id: string; name: string }[];
  icp: { id: string } | null;
  personas: { id: string; title: string }[];
}
