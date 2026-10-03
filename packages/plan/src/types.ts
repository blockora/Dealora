import type {
  PlanBasis,
  PlanStatement,
  PlanStatementKind,
  RevenueGoal,
  RevenuePlan,
  RevenuePlanApproval,
  RevenuePlanStatus,
  RevenuePlanStrategies,
} from "@dealora/db";

/**
 * @dealora/plan — the Revenue Plan Compiler.
 *
 * Turns a RevenueGoal into an inspectable RevenuePlan: a proposal for how to
 * pursue the goal, never an execution. Every meaningful statement carries its
 * provenance so a recommendation is never presented as a fact, and no evidence
 * is fabricated to justify one (ROADMAP.md §11, DEALORA_BLUEPRINT.md §8).
 */

/** Domain error vocabulary, closed and safe to render. */
export type PlanErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "UNAVAILABLE";

export interface PlanError {
  code: PlanErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export function planError(
  code: PlanErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): PlanError {
  return details ? { code, message, details } : { code, message };
}

export type {
  PlanBasis,
  PlanStatement,
  PlanStatementKind,
  RevenueGoal,
  RevenuePlan,
  RevenuePlanApproval,
  RevenuePlanStatus,
  RevenuePlanStrategies,
};

/**
 * The slice of the canonical Business Brain the compiler may read.
 *
 * Deliberately narrow: the plan references Brain records, it never copies the
 * Brain. Unverified and restricted claims are included only so the compiler can
 * prove it excluded them, which is why they are modelled separately.
 */
export interface PlanBrainSnapshot {
  workspaceId: string;
  company: {
    name: string;
    market: string | null;
    industry: string | null;
    size: string | null;
  } | null;
  offers: { id: string; name: string; description: string | null; outcome: string | null }[];
  icp: {
    id: string;
    industries: string[];
    companySizes: string[];
    geographies: string[];
    characteristics: string[];
    disqualifiers: string[];
  } | null;
  personas: {
    id: string;
    title: string;
    painPoints: string[];
    goals: string[];
    buyingContext: string | null;
  }[];
  positioning: {
    statement: string;
    differentiators: string[];
    approvedValuePropositions: string[];
  } | null;
  brandVoice: { tone: string[]; constraints: string[] } | null;
  /** Claims the business has explicitly approved for external use. */
  approvedClaims: { id: string; text: string }[];
  /** Counts only: the compiler must never quote these. */
  withheldClaims: { unverified: number; restricted: number };
}

/** What the compiler receives. No clock, so the output is reproducible. */
export interface PlanCompileInput {
  goal: RevenueGoal;
  brain: PlanBrainSnapshot;
}

/**
 * The compiler's output: a structured *draft*.
 *
 * A draft is not yet a plan. Validation runs over it, and only a valid draft
 * is persisted, so an invalid plan can never be stored.
 */
export interface RevenuePlanDraft {
  revenueGoalId: string;
  compilerVersion: string;
  brainSnapshotDigest: string;
  references: {
    offerId: string | null;
    icpId: string | null;
    personaIds: string[];
  };
  strategies: RevenuePlanStrategies;
  facts: PlanStatement[];
  inferences: PlanStatement[];
  assumptions: PlanStatement[];
  recommendations: PlanStatement[];
  unknowns: PlanStatement[];
  approval: RevenuePlanApproval;
  rationale: string;
}

/**
 * The replaceable compiler boundary.
 *
 * Phase 4 ships a deterministic implementation. An LLM-backed compiler, if one
 * is ever added, implements this same interface — the domain is never wired to
 * a specific provider.
 */
export interface RevenuePlanCompiler {
  /** Identifies the strategy logic that produced a plan. Persisted with it. */
  readonly compilerVersion: string;
  /**
   * Pure function of its input: the same goal, Brain snapshot and compiler
   * version always yield the same draft. No clock, no randomness.
   */
  compile(input: PlanCompileInput): RevenuePlanDraft;
}
