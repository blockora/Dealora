/**
 * Core domain types for the DEALORA application foundation and the Phase 2
 * Business Brain.
 *
 * These mirror the entities in ROADMAP.md §8 and §9 and stay deliberately
 * minimal. They are value objects: persistence converts them into rows via
 * the repository in `packages/db`.
 */

/**
 * Owner or member role for a workspace member.
 *
 * Actor/role model as required by ROADMAP.md §29 (roles as an explicit,
 * auditable concept) while staying out of scope for Phase 1.
 */
export type UserRole = "owner" | "member";

/** Stable, database-generated identifier. */
export type EntityId = string;

/** RFC 3339 timestamp stored with every persisted record. */
export type DateTime = string;

/** Timezone-naive UTC instant in `YYYY-MM-DDTHH:MM:SS.sssZ` form. */
export function toDateTime(now: Date): DateTime {
  return now.toISOString();
}

/** Core user identity. */
export interface User {
  id: EntityId;
  email: string;
  passwordHash: string;
  displayName: string;
  role: UserRole;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** Workspaces are the tenant boundary for every workspace-level operation. */
export interface Workspace {
  id: EntityId;
  ownerId: EntityId;
  name: string;
  slug: string;
  logoUrl: string | null;
  timezone: string;
  settings: Record<string, unknown>;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** Owner membership plus explicit member list in one place for fast access. */
export interface WorkspaceMember {
  workspaceId: EntityId;
  userId: EntityId;
  role: UserRole;
  invitedAt: DateTime;
  acceptedAt: DateTime | null;
}

/**
 * Minimal business profile the Phase 1 foundation must carry.
 *
 * Phase 2 keeps this as the *company* section of the Business Brain rather
 * than a second, competing company record (see ADR 0003).
 */
export interface BusinessProfile {
  id: EntityId;
  workspaceId: EntityId;
  ownerId: EntityId;
  name: string;
  description: string;
  website: string | null;
  type: string | null;
  offer: string | null;
  industry: string | null;
  size: string | null;
  /** Phase 2: market / category the business operates in. */
  market: string | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 2 — Business Brain
//
// Every entity below is workspace-scoped. `workspaceId` is the tenant
// boundary: reads and writes must resolve authorization from the
// authenticated identity, never from a client-supplied id.
// ---------------------------------------------------------------------------

/** Commercial status of an offer. Only `active` offers may be published. */
export type OfferStatus = "draft" | "active" | "retired";

/** Pricing shape. `approved` gates whether pricing may be stated externally. */
export type PricingModel = "one_time" | "recurring" | "usage_based" | "custom";

export interface OfferPricing {
  model: PricingModel;
  amountMin: number | null;
  amountMax: number | null;
  currency: string | null;
  notes: string | null;
  /**
   * Whether the business has approved stating this pricing externally.
   * Unapproved pricing must never be asserted by an agent
   * (DEALORA_BLUEPRINT.md §9).
   */
  approved: boolean;
}

/** The commercial offer a business sells. */
export interface Offer {
  id: EntityId;
  workspaceId: EntityId;
  name: string;
  description: string;
  targetCustomer: string | null;
  problemSolved: string | null;
  outcome: string | null;
  pricing: OfferPricing | null;
  deliveryModel: string | null;
  status: OfferStatus;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** Structured ideal-customer profile. One per workspace. */
export interface Icp {
  id: EntityId;
  workspaceId: EntityId;
  industries: string[];
  companySizes: string[];
  geographies: string[];
  businessModels: string[];
  /** Positive qualification characteristics. */
  characteristics: string[];
  /** Explicit exclusions so qualification can reject a fit. */
  disqualifiers: string[];
  notes: string | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** A buyer persona. Several may exist per workspace. */
export interface Persona {
  id: EntityId;
  workspaceId: EntityId;
  title: string;
  responsibilities: string[];
  painPoints: string[];
  goals: string[];
  buyingContext: string | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** Positioning statement and approved differentiation. One per workspace. */
export interface Positioning {
  id: EntityId;
  workspaceId: EntityId;
  statement: string;
  differentiators: string[];
  /** Value propositions cleared for external use. */
  approvedValuePropositions: string[];
  competitorContext: string[];
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** Brand voice guidance. One per workspace. */
export interface BrandVoice {
  id: EntityId;
  workspaceId: EntityId;
  tone: string[];
  style: string | null;
  terminology: string[];
  /** Hard communication constraints the business imposes. */
  constraints: string[];
  createdAt: DateTime;
  updatedAt: DateTime;
}

/**
 * Claim safety status.
 *
 * - `approved`   — the business has cleared this text for external use.
 * - `unverified` — user-entered text with no approval; an agent may treat it
 *                  as context but must never present it as an established
 *                  fact.
 * - `restricted` — must not be used externally at all.
 */
export type ClaimStatus = "approved" | "unverified" | "restricted";

/** What kind of statement a claim makes, for safety checks and filtering. */
export type ClaimCategory =
  | "capability"
  | "pricing"
  | "result"
  | "case_study"
  | "testimonial"
  | "certification"
  | "partnership"
  | "guarantee"
  | "other";

/**
 * A business statement with an explicit approval status.
 *
 * DEALORA must never invent capabilities, customer results, case studies,
 * pricing, certifications, partnerships, or guarantees. Those are exactly the
 * statements recorded here, each carrying its own approval status.
 */
export interface Claim {
  id: EntityId;
  workspaceId: EntityId;
  text: string;
  category: ClaimCategory;
  status: ClaimStatus;
  /** Where the claim came from, in the business's own words. */
  sourceNote: string | null;
  /** Set only when `status === "approved"`; records who approved it. */
  approvedBy: EntityId | null;
  approvedAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** Status used for validation bugs and lifecycle bookkeeping. */
export type ValidationSeverity = "error" | "warn" | "info";

export interface ValidationError {
  field: string;
  message: string;
  severity: ValidationSeverity;
}

// ---------------------------------------------------------------------------
// Phase 3 — Revenue Goal Engine
// ---------------------------------------------------------------------------

/**
 * Goal lifecycle.
 *
 * `draft` is the entry state. `archived` is terminal. Transitions are
 * validated by the domain layer, never by the client.
 */
export type RevenueGoalStatus = "draft" | "active" | "paused" | "completed" | "archived";

/**
 * Whether a goal carries everything needed to be measured.
 *
 * A goal may legitimately be `incomplete` — the missing fields are recorded
 * explicitly rather than invented — but it is never `invalid`.
 */
export type GoalCompleteness = "complete" | "incomplete";

/** The outcome a goal targets. */
export type GoalMetricKind =
  | "revenue"
  | "pipeline"
  | "qualified_opportunity"
  | "meeting"
  | "customer"
  | "conversion_rate"
  | "time_to_target";

/** ISO-8601 calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/** An explicit success criterion recorded against the goal. */
export interface RevenueGoalMetric {
  kind: GoalMetricKind;
  /** Target value in `unit`. */
  target: number;
  unit: string;
}

/**
 * Commercial assumptions. Deliberately minimal: no forecasting, no
 * optimization (ROADMAP.md §10/§23 are later phases).
 */
export interface RevenueGoalEconomics {
  averageDealValue: number | null;
  minimumContractValue: number | null;
  targetCustomers: number | null;
  currency: string | null;
}

/**
 * Explicit limits on how the goal may be pursued.
 *
 * Constraints are never silently reinterpreted as part of the objective.
 */
export interface RevenueGoalConstraints {
  geographies: string[];
  industries: string[];
  companySizes: string[];
  channels: string[];
  budget: string | null;
  maxOutreachPerDay: number | null;
  notes: string | null;
}

/**
 * Approval context carried by the goal.
 *
 * Mirrors the Blueprint §17 risk levels. Phase 3 records the policy only —
 * it never performs an external action.
 */
export interface RevenueGoalApprovalPolicy {
  /**
   * Highest risk level the downstream workflow may reach under this goal.
   * Level 2 and 3 require approval before execution (Phase 10).
   */
  maxRiskLevel:
    "level_0_read" | "level_1_draft" | "level_2_external_action" | "level_3_high_impact";
  externalActionsRequireApproval: boolean;
  approverUserId: string | null;
}

/** A field the goal still needs before it can be measured. */
export interface RevenueGoalUnknown {
  field: string;
  reason: string;
}

/** The structured revenue outcome a workspace is working toward. */
export interface RevenueGoal {
  id: EntityId;
  workspaceId: EntityId;
  createdBy: EntityId;
  /** Natural-language objective as stated by the user. */
  objective: string;
  targetMetric: GoalMetricKind;
  targetValue: number;
  currency: string | null;
  timeWindow: { start: IsoDate; end: IsoDate };
  market: string | null;
  /** References to canonical Business Brain records — never copies. */
  icpId: EntityId | null;
  buyerPersonaIds: EntityId[];
  offerId: EntityId | null;
  economics: RevenueGoalEconomics;
  constraints: RevenueGoalConstraints;
  approvalPolicy: RevenueGoalApprovalPolicy;
  successMetrics: RevenueGoalMetric[];
  status: RevenueGoalStatus;
  completeness: GoalCompleteness;
  /** Missing information, recorded rather than invented. */
  unknowns: RevenueGoalUnknown[];
  /** Assumptions the system made while structuring the input. */
  assumptions: string[];
  createdAt: DateTime;
  updatedAt: DateTime;
}

/**
 * An auditable status transition. Satisfies the roadmap's "goal history"
 * requirement and SECURITY.md's auditability rule.
 */
export interface RevenueGoalEvent {
  id: EntityId;
  goalId: EntityId;
  workspaceId: EntityId;
  actorUserId: EntityId;
  kind: "created" | "updated" | "status_changed";
  fromStatus: RevenueGoalStatus | null;
  toStatus: RevenueGoalStatus;
  createdAt: DateTime;
}
