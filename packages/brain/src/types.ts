/**
 * Domain error for the Business Brain.
 *
 * These codes are the safe, user-facing vocabulary. Internal storage errors
 * are translated into these codes by the repository layer so handlers never
 * leak implementation detail (SECURITY.md).
 */
export type BrainErrorCode =
  "VALIDATION_ERROR" | "NOT_FOUND" | "UNAUTHORIZED" | "CONFLICT" | "UNAVAILABLE";

export interface BrainError {
  code: BrainErrorCode;
  message: string;
  /** Field-level detail for validation failures. */
  details?: { field: string; message: string }[];
}

export function brainError(
  code: BrainErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): BrainError {
  return details ? { code, message, details } : { code, message };
}

export type ValidationIssue = { field: string; message: string };

/**
 * The deterministic snapshot handed to future agents.
 *
 * This is the canonical context shape for DEALORA (DEALORA_BLUEPRINT.md §9):
 * it is structured rather than prose, workspace-scoped, and explicit about
 * which claims are approved. An agent must be able to answer "what may I
 * say?" from `claims` alone.
 */
export interface BusinessContext {
  workspaceId: string;
  /** Company section — the Phase 1 business profile, not a second record. */
  company: {
    name: string;
    description: string;
    website: string | null;
    type: string | null;
    market: string | null;
    industry: string | null;
    size: string | null;
  } | null;
  /** Commercial offers. */
  offers: {
    name: string;
    description: string;
    targetCustomer: string | null;
    problemSolved: string | null;
    outcome: string | null;
    deliveryModel: string | null;
    status: string;
    /**
     * Pricing is only present when the business explicitly approved stating
     * it. Unapproved pricing is never handed to an agent as a fact.
     */
    pricing: {
      model: string;
      amountMin: number | null;
      amountMax: number | null;
      currency: string | null;
      notes: string | null;
    } | null;
  }[];
  icp: {
    industries: string[];
    companySizes: string[];
    geographies: string[];
    businessModels: string[];
    characteristics: string[];
    disqualifiers: string[];
    notes: string | null;
  } | null;
  personas: {
    title: string;
    responsibilities: string[];
    painPoints: string[];
    goals: string[];
    buyingContext: string | null;
  }[];
  positioning: {
    statement: string;
    differentiators: string[];
    approvedValuePropositions: string[];
    competitorContext: string[];
  } | null;
  brandVoice: {
    tone: string[];
    style: string | null;
    terminology: string[];
    constraints: string[];
  } | null;
  /**
   * Claims grouped by approval status.
   *
   * - `approved`   may be stated externally.
   * - `unverified` is context only; an agent must not present it as fact.
   * - `restricted` must never be used externally.
   */
  claims: {
    approved: { id: string; text: string; category: string }[];
    unverified: { id: string; text: string; category: string }[];
    restricted: { id: string; text: string; category: string }[];
  };
}
