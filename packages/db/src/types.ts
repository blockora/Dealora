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
