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

// ---------------------------------------------------------------------------
// Phase 4 — Revenue Plan Compiler (DEALORA_BLUEPRINT.md §8, ROADMAP.md §11)
// ---------------------------------------------------------------------------

/**
 * Plan lifecycle.
 *
 * Deliberately minimal. `approved` records that a human accepted the
 * *proposal*; it never authorizes an external action.
 */
export type RevenuePlanStatus = "draft" | "proposed" | "approved" | "archived";

/**
 * How a plan statement is supported.
 *
 * This is the core safety property of Phase 4 (ROADMAP.md §11: "separate
 * facts from recommendations"). A recommendation must never be presented as a
 * fact, and no evidence may be fabricated to justify one.
 */
export type PlanStatementKind =
  /** Recorded verbatim from the goal or the canonical Business Brain. */
  | "fact"
  /** Derived by combining known facts; the derivation is stated. */
  | "inference"
  /** A rule the compiler applied; recorded so it can be challenged. */
  | "assumption"
  /** What the compiler proposes. Never a statement of reality. */
  | "recommendation"
  /** Not determinable from the goal or the Business Brain. */
  | "unknown";

/** Where a statement's support comes from. */
export type PlanBasis =
  | "goal"
  | "goal:success_metrics"
  | "goal:economics"
  | "goal:constraints"
  | "goal:approval_policy"
  | "brain:company"
  | "brain:offer"
  | "brain:icp"
  | "brain:persona"
  | "brain:positioning"
  | "brain:brand_voice"
  | "brain:claims"
  | "compiler"
  | "none";

/** A single classified statement inside the plan. */
export interface PlanStatement {
  kind: PlanStatementKind;
  /** The statement itself, in plain language. */
  text: string;
  /** What supports it. `none` for an unknown. */
  basis: PlanBasis;
  /** Canonical record ids the statement depends on, when applicable. */
  references?: string[];
}

/** Who the plan is aimed at. */
export interface RevenuePlanIcpStrategy {
  targetMarket: string | null;
  industries: string[];
  companySizes: string[];
  geographies: string[];
  characteristics: string[];
  disqualifiers: string[];
  statements: PlanStatement[];
}

/** One persona the plan addresses. References the canonical persona. */
export interface RevenuePlanBuyerTarget {
  personaId: string | null;
  title: string;
  buyerContext: string | null;
  painPoints: string[];
  goals: string[];
  statements: PlanStatement[];
}

export interface RevenuePlanBuyerStrategy {
  personas: RevenuePlanBuyerTarget[];
  statements: PlanStatement[];
}

/**
 * What accounts will eventually be sourced, and how.
 *
 * Phase 4 sources nothing: this describes the target account profile and the
 * permitted approach only.
 */
export interface RevenuePlanSourcingStrategy {
  accountProfile: string;
  approach: string[];
  constraints: string[];
  statements: PlanStatement[];
}

/** A signal category the plan would watch for. Never a claim about a real company. */
export interface RevenuePlanSignal {
  kind: string;
  description: string;
  statements: PlanStatement[];
}

export interface RevenuePlanSignalStrategy {
  signals: RevenuePlanSignal[];
  excludedSources: string[];
  statements: PlanStatement[];
}

/** A criterion the later Qualification Engine would apply. */
export interface RevenuePlanQualificationCriterion {
  name: string;
  description: string;
  statements: PlanStatement[];
}

export interface RevenuePlanQualificationStrategy {
  criteria: RevenuePlanQualificationCriterion[];
  statements: PlanStatement[];
}

/**
 * How outreach would be conducted.
 *
 * Nothing is sent in Phase 4. `approvalRequired` records that any future send
 * is an external action needing separate approval.
 */
export interface RevenuePlanOutreachStrategy {
  channels: string[];
  messagingAngles: string[];
  valueProposition: string | null;
  personalizationPrinciple: string | null;
  frequencyCap: string | null;
  stopPrinciples: string[];
  approvalRequired: boolean;
  statements: PlanStatement[];
}

export interface RevenuePlanFollowUpStrategy {
  principles: string[];
  responseStates: string[];
  stopConditions: string[];
  escalationConditions: string[];
  statements: PlanStatement[];
}

export interface RevenuePlanMeetingStrategy {
  objective: string | null;
  qualificationPurpose: string;
  preparation: string[];
  statements: PlanStatement[];
}

/** What future CRM handling would record. Phase 4 writes nothing. */
export interface RevenuePlanCrmPolicy {
  recordFields: string[];
  prohibitedWrites: string[];
  statements: PlanStatement[];
}

/** A measurable KPI the later Measurement phases would record against. */
export interface RevenuePlanKpi {
  name: string;
  metricKind: GoalMetricKind;
  target: number;
  unit: string;
  statements: PlanStatement[];
}

export interface RevenuePlanMeasurementPlan {
  kpis: RevenuePlanKpi[];
  reviewCadence: string | null;
  statements: PlanStatement[];
}

/** A dimension that a later Optimization phase could tune. */
export interface RevenuePlanOptimizationLever {
  name: string;
  description: string;
  requiresData: boolean;
  statements: PlanStatement[];
}

export interface RevenuePlanOptimizationPlan {
  levers: RevenuePlanOptimizationLever[];
  guardrails: string[];
  statements: PlanStatement[];
}

/**
 * Approval context for the plan.
 *
 * `approvesExternalActions` is typed as the literal `false`: approving a plan
 * is not approving an email, a CRM write, or a calendar action. Those belong
 * to the later phases and carry their own risk levels.
 */
export interface RevenuePlanApproval {
  approvesExternalActions: false;
  /** Blueprint §17 risk levels later phases must clear before acting. */
  requiredFor: RevenueGoalApprovalPolicy["maxRiskLevel"][];
  statements: PlanStatement[];
}

/** Every strategy section of the plan, each with its classified statements. */
export interface RevenuePlanStrategies {
  icp: RevenuePlanIcpStrategy;
  buyer: RevenuePlanBuyerStrategy;
  sourcing: RevenuePlanSourcingStrategy;
  signal: RevenuePlanSignalStrategy;
  qualification: RevenuePlanQualificationStrategy;
  outreach: RevenuePlanOutreachStrategy;
  followUp: RevenuePlanFollowUpStrategy;
  meeting: RevenuePlanMeetingStrategy;
  crm: RevenuePlanCrmPolicy;
  measurement: RevenuePlanMeasurementPlan;
  optimization: RevenuePlanOptimizationPlan;
}

/**
 * The compiled proposal: how DEALORA proposes to pursue a RevenueGoal.
 *
 * A plan references its goal and the canonical Business Brain records it used
 * rather than copying them, and carries a digest of the Brain state so a
 * historical plan stays interpretable without embedding the whole Brain.
 */
export interface RevenuePlan {
  id: EntityId;
  workspaceId: EntityId;
  createdBy: EntityId;
  /** The goal this plan was compiled from. */
  revenueGoalId: EntityId;
  /** 1-based version within the goal's lineage. Never reused. */
  version: number;
  /** Which compiler produced this plan. */
  compilerVersion: string;
  /** Digest of the Business Brain state the plan was compiled against. */
  brainSnapshotDigest: string;
  /** Canonical Business Brain records this plan depends on. */
  references: {
    offerId: string | null;
    icpId: string | null;
    personaIds: string[];
  };
  strategies: RevenuePlanStrategies;
  /** Roll-ups across every section, for review. */
  facts: PlanStatement[];
  inferences: PlanStatement[];
  assumptions: PlanStatement[];
  recommendations: PlanStatement[];
  unknowns: PlanStatement[];
  approval: RevenuePlanApproval;
  status: RevenuePlanStatus;
  /** Why this plan was proposed, in one sentence. */
  rationale: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 5 — Account & Prospect Input (DEALORA_BLUEPRINT.md §9, ROADMAP.md §12)
// ---------------------------------------------------------------------------

/**
 * Target account lifecycle.
 *
 * Minimal by design (ROADMAP.md §12): an account is either usable input or
 * archived. Opportunity stages belong to a later phase.
 */
export type AccountStatus = "active" | "archived";

/** Contact lifecycle, mirroring {@link AccountStatus}. */
export type ContactStatus = "active" | "archived";

/**
 * Where a record came from.
 *
 * An account or contact entering DEALORA is **user-provided input**, not
 * verified business evidence. Phase 5 stores what the user supplied and makes
 * no claim that it is true; the Research and Evidence phases are what verify
 * external facts.
 */
export type RecordSource =
  /** Typed in by a user through the application. */
  | "manual"
  /** Arrived through a CSV import. */
  | "csv"
  /** Supplied by an approved, user-authorized integration. */
  | "approved_integration";

/**
 * A target account: a company the workspace is considering.
 *
 * Every field is exactly what the user supplied. Nothing here is inferred,
 * enriched, scored or verified.
 */
export interface Account {
  id: EntityId;
  workspaceId: EntityId;
  createdBy: EntityId;
  name: string;
  website: string | null;
  /** Lower-cased registrable host, used for deterministic deduplication. */
  domain: string | null;
  industry: string | null;
  companySize: string | null;
  geography: string | null;
  description: string | null;
  source: RecordSource;
  /** Where this record came from in the user's terms: a filename, a list name. */
  sourceReference: string | null;
  /** Optional association with the plan that targeted this account. */
  revenuePlanId: EntityId | null;
  status: AccountStatus;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** A person at an account, as supplied by the user. Never enriched. */
export interface Contact {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  createdBy: EntityId;
  firstName: string | null;
  lastName: string | null;
  /** Denormalized for display; derived from the parts, never invented. */
  fullName: string;
  jobTitle: string | null;
  /** Lower-cased, used for deterministic deduplication within an account. */
  email: string | null;
  phone: string | null;
  /** A profile URL the user supplied. Never crawled or resolved. */
  profileUrl: string | null;
  source: RecordSource;
  sourceReference: string | null;
  status: ContactStatus;
  createdAt: DateTime;
  updatedAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 6 — Research Engine (DEALORA_BLUEPRINT.md §12.3, ROADMAP.md §13)
// ---------------------------------------------------------------------------

/**
 * Research request lifecycle.
 *
 * Deliberately minimal (ROADMAP.md does not ask for a workflow engine here):
 * a request is created `pending`, executed once, and ends up `completed`,
 * `failed` or `cancelled`. A `failed` request may be retried; `completed` and
 * `cancelled` are terminal.
 */
export type ResearchRequestStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Why a research run ended without producing findings.
 *
 * Recorded on the request so a failure is an inspectable outcome rather than a
 * silent one (DEALORA_BLUEPRINT.md §20: "Never silently pretend an action
 * succeeded").
 */
export type ResearchFailureCode =
  "provider_unavailable" | "provider_failed" | "invalid_provider_output" | "storage_failed";

/**
 * The kind of permitted source a finding came from
 * (DEALORA_BLUEPRINT.md §43 — user-provided data, authorized APIs, permitted
 * public/business information, approved integrations).
 *
 * There is no "unauthorized source" member: a source outside this list cannot
 * be represented, let alone stored.
 */
export type ResearchSourceKind = "account_record" | "approved_api" | "public_web";

/**
 * The epistemic label carried by every research statement.
 *
 * ROADMAP.md §13: "Never treat inference as fact" and use explicit labels.
 * `fact` means *this source states this* — it is not a claim that DEALORA has
 * verified anything. Verification is the Evidence System's job (Phase 7).
 */
export type ResearchClaimKind = "fact" | "inference" | "hypothesis" | "recommendation";

/**
 * Research categories, exactly the list ROADMAP.md §13 gives for Phase 6:
 * company overview, industry, business model, product/service information,
 * recent announcements, hiring, expansion, leadership changes, relevant
 * technology signals and public business changes.
 *
 * These are *observation buckets*, not scores. Nothing in this vocabulary
 * expresses buying intent, funding, a technology fingerprint, competitor
 * analysis or qualification — those are Phase 8 and later.
 */
export type ResearchCategory =
  | "company_overview"
  | "industry"
  | "business_model"
  | "products_services"
  | "recent_announcements"
  | "hiring"
  | "expansion"
  | "leadership_changes"
  | "technology_signals"
  | "public_business_changes";

/**
 * How much weight to give a statement, as a coarse band rather than a number.
 *
 * Bands, not percentages: DEALORA has no calibration data in this phase and
 * must not invent a score it cannot defend.
 */
export type ResearchConfidence = "low" | "medium" | "high";

/** How recently the source said the statement was true. */
export type ResearchFreshness = "unknown" | "fresh" | "recent" | "stale";

/** How close the statement is to what the request asked for. */
export type ResearchRelevance = "low" | "medium" | "high";

/**
 * A research finding.
 *
 * Intermediate research output, deliberately **not** an evidence record: the
 * Evidence System (Phase 7) owns verification, linking and audit. What a
 * finding does carry, always, is provenance — which permitted source, when it
 * was retrieved, and when the source said the statement was true.
 *
 * Every externally-derived finding keeps its `source`, `sourceName` and
 * `retrievedAt`. `sourceUrl` is stored exactly as the provider returned it and
 * is `null` when the provider supplied no reference: a citation is never
 * invented.
 */
export interface ResearchFinding {
  id: EntityId;
  researchRequestId: EntityId;
  /** Denormalized so findings can never outlive their tenant boundary. */
  workspaceId: EntityId;
  accountId: EntityId;
  category: ResearchCategory;
  /** Stable field key inside the category, e.g. `products_services.offerings`. */
  field: string;
  value: string;
  claimKind: ResearchClaimKind;
  source: ResearchSourceKind;
  /** The provider that produced this finding. */
  sourceName: string;
  /** The provider's own citation. `null` when it returned none. */
  sourceUrl: string | null;
  sourceTitle: string | null;
  /** When the source says the statement was true. `null` when unknown. */
  observedAt: DateTime | null;
  /** When DEALORA retrieved the statement. */
  retrievedAt: DateTime;
  confidence: ResearchConfidence;
  freshness: ResearchFreshness;
  relevance: ResearchRelevance;
  /** Bounded provider note, never a store for free-form model output. */
  note: string | null;
  /**
   * Phase 6 only records findings; it never withdraws or verifies them.
   * Supersession and verification belong to the Evidence System.
   */
  status: "recorded";
  createdAt: DateTime;
  updatedAt: DateTime;
}

/**
 * One research job against one account.
 *
 * A request records *what was asked*, *which permitted provider answered*, and
 * *how it ended*. It is workspace-scoped to exactly the account's workspace:
 * `workspaceId === Account.workspaceId` is enforced on every path.
 */
export interface ResearchRequest {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  requestedBy: EntityId;
  /** The registered provider that will answer this request. */
  provider: string;
  status: ResearchRequestStatus;
  categories: ResearchCategory[];
  /**
   * Optional caller-supplied key. Replaying a create with the same key returns
   * the same request instead of starting a second job.
   */
  idempotencyKey: string | null;
  /** How many findings this run recorded. Usage metadata, not a cost figure. */
  findingCount: number;
  failureCode: ResearchFailureCode | null;
  failureMessage: string | null;
  startedAt: DateTime | null;
  completedAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 7 — Evidence System (DEALORA_BLUEPRINT.md §10, ROADMAP.md §14)
// ---------------------------------------------------------------------------

/**
 * The lifecycle of a claim about an external account.
 *
 * Three states, and the third one is the point of the phase:
 *
 * - `asserted`  — a claim exists and carries at least one source-backed
 *                 evidence record. DEALORA is **not** saying the claim is true;
 *                 it is saying a permitted source stated it.
 * - `contested` — a source-backed contradiction was recorded against this
 *                 claim. DEALORA never resolves it on the user's behalf.
 * - `retracted` — the workspace withdrew the claim. Terminal, and soft: the
 *                 claim row and every evidence record attached to it stay
 *                 readable so the audit trail survives the withdrawal.
 *
 * There is deliberately no `verified` state and no score. Verification is not
 * something this phase can honestly perform, and qualification is Phase 8
 * (`ROADMAP.md` §15).
 */
export type AccountClaimStatus = "asserted" | "contested" | "retracted";

/**
 * The lifecycle of one piece of evidence.
 *
 * Every state records a fact about this record, and none of them is a verdict
 * about the wider world:
 *
 * - `recorded`      — captured, with full provenance, from a research finding
 *                     or from a source the workspace supplied directly.
 * - `contradicted`  — another record for the same claim field carries a
 *                     different value. **Both** records are marked; neither is
 *                     deleted and no winner is declared.
 * - `superseded`    — the workspace pointed this record at a named replacement
 *                     for the same claim field. The old value, source and
 *                     timestamps are all preserved. Terminal.
 * - `rejected`      — the workspace rejected this record as support. Terminal.
 *
 * `superseded` and `rejected` are terminal: a record that was replaced or
 * rejected cannot quietly come back, and a `contradicted` record cannot be
 * returned to `recorded`, because that would resolve the conflict by fiat. A
 * conflict is resolved only by an explicit supersession naming a real
 * replacement, which leaves both sides readable.
 */
export type EvidenceStatus = "recorded" | "contradicted" | "superseded" | "rejected";

/**
 * How an evidence record came to exist.
 *
 * - `research_finding` — converted from a Phase 6 `ResearchFinding`, so the
 *   full chain evidence → claim → finding → request → account is walkable.
 * - `user_supplied`    — the workspace supplied the source directly, so there
 *   is no research request and `researchFindingId` is `null`. A research
 *   request is never invented to fill the gap.
 */
export type EvidenceProvenance = "research_finding" | "user_supplied";

/**
 * A structured assertion about an external account.
 *
 * Distinct from the Phase 2 {@link Claim}, which is a statement the *business
 * itself* authored about itself with an approval status. These go the other
 * way: an assertion about a company DEALORA does not own, derived from a
 * permitted source and supported by one or more {@link Evidence} records. The
 * two are never merged, because their trust directions are opposite.
 *
 * The claim stores only what the source supports. It holds no source URL — a
 * citation belongs to the evidence that carries it, so the same claim can be
 * supported by several sources without any of them being overwritten.
 */
export interface AccountClaim {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  /** Observation bucket, exactly the Phase 6 categories (`ROADMAP.md` §13). */
  category: ResearchCategory;
  /** Stable field key inside the category, e.g. `products_services.offerings`. */
  field: string;
  value: string;
  /** What kind of statement this is. `fact` still means "this source says so". */
  claimKind: ResearchClaimKind;
  status: AccountClaimStatus;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/**
 * One traceable, source-backed support for a claim.
 *
 * `ROADMAP.md` §14 asks evidence to be first-class rather than text hidden in a
 * prompt, and lists its fields. The mapping is exact:
 *
 * | Roadmap field   | Field                                                        |
 * | --------------- | ------------------------------------------------------------ |
 * | `id`            | `id`                                                          |
 * | `source`        | `sourceName` — which provider or record made the statement   |
 * | `source_type`   | `source` — which permitted source kind (§43)                  |
 * | `source_url`    | `sourceUrl` — `null` when the source supplied no reference   |
 * | `claim`         | `accountClaimId` → `AccountClaim.value`                      |
 * | `claim_type`    | `accountClaimId` → `AccountClaim.claimKind`                  |
 * | `confidence`    | `confidence`                                                  |
 * | `freshness`     | `freshness`                                                   |
 * | `retrieved_at`  | `retrievedAt`                                                 |
 * | `relevance`     | `relevance`                                                   |
 * | `related_entity`| `accountId` — the entity the claim is about                   |
 *
 * Plus the provenance that makes the record auditable: `researchFindingId`,
 * `provenance`, `sourceTitle`, `observedAt`, `status` and `note`.
 *
 * Every source field is a restatement of what the underlying record or
 * provider actually supplied. A citation that does not exist is stored as
 * `null`; it is never constructed, guessed or completed from a domain name.
 */
export interface Evidence {
  id: EntityId;
  /** Denormalized so evidence can never outlive its tenant boundary. */
  workspaceId: EntityId;
  /** ROADMAP's `related_entity`: the account this evidence is about. */
  accountId: EntityId;
  accountClaimId: EntityId;
  /** The Phase 6 finding this came from. `null` for `user_supplied` provenance. */
  researchFindingId: EntityId | null;
  provenance: EvidenceProvenance;
  /** The permitted source kind (DEALORA_BLUEPRINT.md §43). ROADMAP's `source_type`. */
  source: ResearchSourceKind;
  /** The provider or record that made the statement. ROADMAP's `source`. */
  sourceName: string;
  /** The source's own reference. `null` when it supplied none. */
  sourceUrl: string | null;
  sourceTitle: string | null;
  /** When the source says the statement was true. `null` when unknown. */
  observedAt: DateTime | null;
  /** When DEALORA retrieved it. ROADMAP's `retrieved_at`. */
  retrievedAt: DateTime;
  /** Strength of support. Never an account, lead or buying-intent score. */
  confidence: ResearchConfidence;
  /** Temporal metadata, derived from `observedAt`. Never inferred from confidence. */
  freshness: ResearchFreshness;
  /** How directly the record relates to the claim context. Never a ranking. */
  relevance: ResearchRelevance;
  status: EvidenceStatus;
  /** Bounded note. Not a store for free-form model output. */
  note: string | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 8 — Qualification Engine (DEALORA_BLUEPRINT.md §12.5, ROADMAP.md §15)
// ---------------------------------------------------------------------------

/**
 * The five scoring dimensions `ROADMAP.md` §15 names for Phase 8, spelled
 * exactly as the Qualification Agent responsibilities in
 * `DEALORA_BLUEPRINT.md` §12.5 ("evaluate ICP fit, evaluate need, evaluate
 * company fit, evaluate potential timing, evaluate buying signals").
 *
 * These are the only dimensions the engine evaluates. The list is closed: no
 * dimension may be added, removed or renamed without a new `ruleVersion`, so a
 * historical score stays interpretable against the rules that produced it.
 */
export type QualificationDimension =
  "icp_fit" | "need_fit" | "buying_signal" | "timing" | "company_fit";

/**
 * The outcome of one criterion.
 *
 * Deliberately exactly three, and the third one is load-bearing:
 *
 * - `pass`    — every requirement of the criterion is satisfied by evidence
 *               that is present, current and unopposed.
 * - `fail`    — evidence is present and contradicts the criterion.
 * - `unknown` — the criterion could not be resolved.
 *
 * `unknown` covers both "nothing was researched yet" and "the sources
 * disagree". It never becomes `fail`, so an un-researched account is not
 * penalised, and it never becomes `pass`, so a missing fact is never read as
 * a fit. There is no `conflicted` outcome: a disagreement is an `unknown` with
 * a reason that names the conflict, so the conflict can never hide inside a
 * status nobody looks for.
 */
export type QualificationCriterionOutcome = "pass" | "fail" | "unknown";

/**
 * The state of a whole evaluation.
 *
 * Four states, and only one of them is a verdict:
 *
 * - `qualified`        — every dimension resolved and every criterion passed.
 * - `unqualified`      — every dimension resolved and at least one criterion
 *                        failed against the criteria the business defined.
 * - `insufficient_data`— at least one criterion is `unknown`, so no verdict
 *                        is issued. This is a first-class outcome, not an
 *                        error and not a failure.
 * - `contested`        — at least one criterion is `unknown` because its
 *                        sources disagree. Strictly stronger than
 *                        `insufficient_data`: the data exists and conflicts,
 *                        and DEALORA does not resolve it. Checked first.
 *
 * There is deliberately no `approved`, `picked`, `contacted` or `prioritised`
 * member. Approval is Phase 10 (`ROADMAP.md` §17) and prioritization is
 * Phase 14; a qualification result is an input to both and never their output.
 */
export type QualificationState = "qualified" | "unqualified" | "insufficient_data" | "contested";

/**
 * One criterion evaluation.
 *
 * `ROADMAP.md` §15 requires every score to carry a score, a reason, its
 * evidence and a confidence. This record is that unit, and it is the smallest
 * thing a user can inspect: `expectation` states the rule as the business's own
 * ICP defines it, `observed` states what the account's evidence actually said,
 * and `evidenceIds`/`claimIds` name exactly which records were compared.
 *
 * `confidence` is `null` only when `result` is `unknown`, because there is no
 * agreed value to be confident about. It is the weakest supporting evidence
 * band, not a new scale.
 */
export interface QualificationCriterionResult {
  dimension: QualificationDimension;
  /** The stable criterion key, unique within the rule version. */
  criterion: string;
  /** What the ICP, plan or goal this rule reads requires, rendered. */
  expectation: string;
  /** The claim value the comparison actually used. `null` when unresolved. */
  observed: string | null;
  result: QualificationCriterionOutcome;
  reason: string;
  confidence: ResearchConfidence | null;
  /** The evidence records this criterion read. References, never copies. */
  evidenceIds: EntityId[];
  /** The claims this criterion read. References, never copies. */
  claimIds: EntityId[];
}

/**
 * One dimension's roll-up over its criteria.
 *
 * `score` is `null` whenever the dimension is `unknown`: a partially-evidenced
 * dimension has no honest number, and reporting one is how a missing fact
 * becomes a fake pass. When the dimension did resolve, the score is the share
 * of its criteria that passed, weighted equally — a ratio of counts, not a
 * calibrated probability.
 */
export interface QualificationDimensionResult {
  dimension: QualificationDimension;
  score: number | null;
  result: QualificationCriterionOutcome;
  reason: string;
  confidence: ResearchConfidence | null;
  /** How many of the dimension's criteria could be resolved at all. */
  resolvedCriteria: number;
  criteria: QualificationCriterionResult[];
}

/**
 * One qualification evaluation: the "why" behind a score, persisted.
 *
 * The record is an immutable, versioned snapshot. Re-evaluating inserts a new
 * `version` for the account rather than rewriting this one, so a score a user
 * acted on last quarter is still explainable after the rules change — and it
 * stays explainable because the record names the `ruleVersion`, the Business
 * Brain `icpId` and the `contextDigest` of the exact ICP and goal state that
 * produced it, rather than copying the Business Brain into itself.
 */
export interface Qualification {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  createdBy: EntityId;
  /** 1-based version within the account's lineage. Never reused. */
  version: number;
  /** Which rule set produced this evaluation. Never overwritten. */
  ruleVersion: string;
  /** The plan this account was sourced against, when it has one. */
  revenuePlanId: EntityId | null;
  /** The goal whose time window the timing criterion read. */
  revenueGoalId: EntityId | null;
  /** The canonical ICP record this evaluation was measured against. */
  icpId: EntityId | null;
  /** Digest of the ICP and goal context actually used. Never the objects. */
  contextDigest: string;
  state: QualificationState;
  /**
   * The Dealora Score, 0-100, or `null` when any dimension is unresolved.
   *
   * All-or-nothing on purpose: a score averaged over a partially-researched
   * account would let missing evidence read as a fit.
   */
  score: number | null;
  /** Weakest confidence band across the scored dimensions. `null` with `null`. */
  confidence: ResearchConfidence | null;
  reason: string;
  /** Every evidence record the evaluation read, for one-hop traceability. */
  evidenceIds: EntityId[];
  /** Every claim the evaluation read. */
  claimIds: EntityId[];
  /**
   * Claims whose sources disagree.
   *
   * Named explicitly so a conflict can never be resolved quietly: this list is
   * why `state` can be `contested` rather than being flattened into
   * `insufficient_data`.
   */
  conflictedClaimIds: EntityId[];
  dimensions: QualificationDimensionResult[];
  evaluatedAt: DateTime;
  createdAt: DateTime;
  updatedAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 9 — Personalization Engine (DEALORA_BLUEPRINT.md §15, ROADMAP.md §16)
// ---------------------------------------------------------------------------

/**
 * One evidence-backed observation a draft states, exactly as the source
 * recorded it.
 *
 * A point never paraphrases. `value` is the claim's stored text quoted
 * verbatim, and `statement` — the sentence that appears in the body — is that
 * value plus its attribution and nothing else, so every factual statement in a
 * draft is traceable to the {@link AccountClaim} and {@link Evidence} records
 * it came from (ROADMAP.md §16: never fabricate personalization).
 */
export interface DraftPersonalizationPoint {
  /** The Phase 6 observation bucket the claim came from. */
  category: ResearchCategory;
  /** Stable field key inside the category. */
  field: string;
  /** The claim value, quoted verbatim. Never rewritten. */
  value: string;
  /** The account claim this point states. A reference, never a copy. */
  claimId: EntityId;
  /** The recorded evidence records behind the claim. References, never copies. */
  evidenceIds: EntityId[];
  /** The source the point's citation names: the newest support record's. */
  sourceName: string;
  /** When the source says the statement was true. `null` when unknown. */
  observedAt: DateTime | null;
  /** The weakest confidence band among the point's support records. */
  confidence: ResearchConfidence;
  /** The best relevance band among the point's support records. */
  relevance: ResearchRelevance;
  /** The exact sentence that appears in the draft body. */
  statement: string;
}

/**
 * One personalized outreach draft (Phase 9).
 *
 * A draft is a **document, not an action**. It carries no recipient address, no
 * channel, no provider and no send state — the draft lifecycle that leads to a
 * send begins in Phase 10 (approval) and Phase 11 (outbound). It is an
 * immutable, versioned record like a qualification: regenerating inserts a new
 * `version` rather than rewriting, so an approval can bind to exactly one
 * draft version forever.
 *
 * Every factual statement the body makes is one of:
 *
 * - a {@link DraftPersonalizationPoint}, quoted from an evidence-backed
 *   account claim and attributed to its source;
 * - an approved Phase 2 Business Brain claim, quoted verbatim
 *   (`approvedClaimIds`);
 * - the offer's own description, quoted verbatim.
 *
 * Anything the system could not honestly state is recorded in `warnings`
 * rather than smoothed over.
 */
export interface PersonalizedDraft {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  /** The person the draft addresses. `null` when the workspace named none. */
  contactId: EntityId | null;
  createdBy: EntityId;
  /** 1-based version within the account's draft lineage. Never reused. */
  version: number;
  /** Which renderer produced this draft. Never overwritten. */
  rendererVersion: string;
  /** Digest of the exact context the renderer was given. Never the objects. */
  contextDigest: string;
  /** The qualification this draft was generated for. State `qualified`. */
  qualificationId: EntityId | null;
  /** The active offer the draft presents. */
  offerId: EntityId | null;
  subject: string;
  body: string;
  /** The evidence-backed observations the body states, in render order. */
  personalizationPoints: DraftPersonalizationPoint[];
  /** The approved Business Brain claims the body quotes. */
  approvedClaimIds: EntityId[];
  /** What the renderer could not honestly state, recorded rather than hidden. */
  warnings: string[];
  createdAt: DateTime;
  updatedAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 10 — Approval Engine (DEALORA_BLUEPRINT.md §17, ROADMAP.md §17)
// ---------------------------------------------------------------------------

/**
 * The lifecycle of an approval request.
 *
 * Exactly one state is a yes: `approved`. Every other state refuses a send:
 *
 * - `pending`            — requested, no human decision yet.
 * - `approved`           — an explicit human decision, attributed and timestamped.
 * - `rejected`           — an explicit human refusal, with a reason.
 * - `changes_requested`  — the reviewer wants a different draft; terminal for
 *                          this version, because a changed draft is a *new*
 *                          draft version and needs its own request.
 * - `cancelled`          — the requester withdrew it before any decision.
 * - `expired`            — the request passed its expiry before a decision.
 *                          A timeout never approves anything; it only closes
 *                          the door.
 *
 * There is no auto-approval and no state a score, a model or a timer can move
 * to `approved`: only {@link ApprovalRequestEvent} records written by explicit
 * human decisions through the service reach that state.
 */
export type ApprovalStatus =
  "pending" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired";

/** The decision a reviewer recorded. Mirrors the terminal states above. */
export type ApprovalDecision = "approved" | "rejected" | "changes_requested";

/**
 * Risk levels, exactly DEALORA_BLUEPRINT.md §17's vocabulary and the same
 * strings Phase 3's `RevenueGoalApprovalPolicy.maxRiskLevel` already carries.
 */
export type ApprovalRiskLevel =
  "level_0_read" | "level_1_draft" | "level_2_external_action" | "level_3_high_impact";

/** The action kinds an approval can cover. Phase 10 issues exactly one. */
export type ApprovalActionKind = "send_message";

/**
 * One explicit request for a human decision before a consequential action.
 *
 * The request binds to exactly one immutable draft version (`draftId` +
 * `draftVersion`) and carries the `previewDigest` of the content the reviewer
 * is shown, so the answer "which version was approved?" is a stored field, not
 * a reconstruction. Identity fields are filled by the server only: the
 * requester from the session at creation, the reviewer from the session at
 * decision time. A client can never name an approver.
 */
export interface ApprovalRequest {
  id: EntityId;
  workspaceId: EntityId;
  /** Who asked for the approval. Always the authenticated caller. */
  createdBy: EntityId;
  actionKind: ApprovalActionKind;
  riskLevel: ApprovalRiskLevel;
  /** The draft the decision is about. */
  draftId: EntityId;
  /** The exact draft version bound to this request. Never re-bound. */
  draftVersion: number;
  /** One-line preview of the action, for lists. */
  previewSubject: string;
  /** Digest of the full previewed content, verified again at decision time. */
  previewDigest: string;
  status: ApprovalStatus;
  /** The recorded decision. `null` while pending. */
  decision: ApprovalDecision | null;
  /** Who decided. Set by the server from the session, never from the body. */
  decidedBy: EntityId | null;
  decidedAt: DateTime | null;
  /** Required for `rejected` and `changes_requested`; optional for `approved`. */
  decisionReason: string | null;
  /** When the request stops being decidable. `null` when it never expires. */
  expiresAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** The kinds of audit event an approval can record. */
export type ApprovalEventKind =
  "requested" | "approved" | "rejected" | "changes_requested" | "cancelled" | "expired";

/**
 * One append-only audit record for an approval request.
 *
 * Every state a request passes through leaves one of these behind, so the
 * history of a decision — what was approved, which version, who, when, why —
 * survives any later change. Events are never edited or deleted.
 */
export interface ApprovalRequestEvent {
  id: EntityId;
  approvalId: EntityId;
  /** Denormalized so events can never outlive their tenant boundary. */
  workspaceId: EntityId;
  actorUserId: EntityId;
  kind: ApprovalEventKind;
  /** The decision reason, when the event records one. */
  detail: string | null;
  createdAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 11 — First Outbound Integration (ROADMAP.md §18)
// ---------------------------------------------------------------------------

/** The one channel Phase 11 integrates. Choosing exactly one is the requirement. */
export type OutboundChannel = "email";

/**
 * The lifecycle of an outbound action.
 *
 * - `ready`     — created, approval verified, nothing sent yet. Cancellable.
 * - `sending`   — the provider call is in flight. Never a resting state: the
 *                 call is synchronous, so a record is only ever observed here
 *                 if the process died mid-attempt.
 * - `sent`      — the provider **confirmed** submission. Nothing else can set
 *                 this, and it is terminal.
 * - `failed`    — the provider refused or errored. The failure code and message
 *                 are recorded; a failed action may be retried explicitly, and
 *                 the retry is idempotent because the provider sees the same
 *                 action id.
 * - `cancelled` — the requester withdrew it before any send. Terminal.
 *
 * There is no `queued` and no automatic retry loop: a message leaves this
 * system only through an explicit send of a ready (or failed) action, and every
 * attempt is recorded as an event.
 */
export type OutboundActionStatus = "ready" | "sending" | "sent" | "failed" | "cancelled";

/**
 * Why a provider refused a message.
 *
 * A closed vocabulary, so a failure is always an inspectable outcome rather
 * than a free-form provider message (DEALORA_BLUEPRINT.md §20). The provider's
 * own words are kept alongside in `failureMessage`.
 */
export type OutboundFailureCode =
  | "invalid_recipient"
  | "provider_rejected"
  | "rate_limited"
  | "suppressed"
  | "provider_unavailable";

/**
 * One controlled external communication (Phase 11).
 *
 * An action is the system's memory of one send: which approved draft version,
 * which approval record covers it, which contact receives it, which provider
 * was used, and what came back. The content is referenced from the immutable
 * draft (`draftId`, `draftVersion`, `draftDigest`) rather than copied, so there
 * is exactly one text of record and the action stays small.
 *
 * `recipientEmail` is resolved server-side from the contact record at creation
 * and validated. Provider identity, references, statuses and timestamps are
 * all written by the server from provider responses — never accepted from a
 * client.
 */
export interface OutboundAction {
  id: EntityId;
  workspaceId: EntityId;
  createdBy: EntityId;
  channel: OutboundChannel;
  /** The approved draft version this action sends. */
  draftId: EntityId;
  draftVersion: number;
  /** Digest of the exact draft content the action refers to. */
  draftDigest: string;
  /** The approval that authorized this send. */
  approvalId: EntityId;
  /** The person who receives the message. */
  contactId: EntityId;
  /** Resolved server-side from the contact record and validated. */
  recipientEmail: string;
  /** The provider that handled (or will handle) the send. */
  provider: string | null;
  status: OutboundActionStatus;
  /** How many times the provider was called for this action. */
  attemptCount: number;
  /** The provider's own reference. `null` until a provider supplies one. */
  providerReference: string | null;
  failureCode: OutboundFailureCode | null;
  failureMessage: string | null;
  /** When the most recent provider attempt started. */
  attemptedAt: DateTime | null;
  /** When the provider confirmed submission. Only set with `sent`. */
  sentAt: DateTime | null;
  /** When the action reached a terminal state. */
  completedAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/** The kinds of audit event an outbound action can record. */
export type OutboundEventKind = "created" | "send_attempted" | "sent" | "failed" | "cancelled";

/**
 * One append-only audit record for an outbound action.
 *
 * What was attempted, what came back, who cancelled — every step an action
 * takes is recorded here by the server, so the send is explainable without
 * trusting the action's current status alone.
 */
export interface OutboundEvent {
  id: EntityId;
  actionId: EntityId;
  /** Denormalized so events can never outlive their tenant boundary. */
  workspaceId: EntityId;
  actorUserId: EntityId;
  kind: OutboundEventKind;
  detail: string | null;
  createdAt: DateTime;
}

/**
 * One address a workspace has opted out of contacting.
 *
 * ROADMAP.md §18 requires opt-out protection in the first integration. A
 * suppressed address is checked **before** every provider call, and a
 * suppressed recipient is never sent to. Suppression is permanent and
 * attributed: the record keeps who recorded it and why.
 */
export interface OutboundSuppression {
  id: EntityId;
  workspaceId: EntityId;
  /** The suppressed address, lower-cased. */
  email: string;
  /** Why the address was suppressed, in the workspace's words. */
  reason: string;
  createdBy: EntityId;
  createdAt: DateTime;
  updatedAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 12 — Conversation Engine
// ---------------------------------------------------------------------------

/**
 * How an inbound message reached DEALORA.
 *
 * Provenance, not decoration: "who supplied this text" decides how much the
 * classification may be trusted, so the vocabulary is closed.
 *
 * Phase 12 ships exactly one way in — `manual`, a workspace user recording what
 * they received. `provider_ingest` is part of the vocabulary because a
 * deployment may later wire an adapter that fetches replies across the Phase 11
 * provider boundary, but **no such adapter exists here** and nothing in this
 * repository can set it. It is recorded as a known ingress shape rather than
 * silently invented; see `docs/adr/0012-conversation-engine.md`.
 */
export type InboundSource = "manual" | "provider_ingest";

/**
 * What an inbound response turned out to be.
 *
 * Exactly the ten states `DEALORA_BLUEPRINT.md` §18 and `ROADMAP.md` §19 name,
 * spelled in the closed snake_case the rest of the domain uses. The list is
 * closed so that "unknown" is a real, reportable outcome rather than a dumping
 * ground for anything the rules failed to recognise.
 */
export type ConversationIntent =
  | "interested"
  | "question"
  | "pricing"
  | "objection"
  | "not_now"
  | "wrong_person"
  | "unsubscribe"
  | "positive_intent"
  | "negative_intent"
  | "unknown";

/**
 * What DEALORA recommends doing about a classified response.
 *
 * A recommendation and nothing more. None of these values executes anything:
 * the phase has no scheduler, no sender and no approver, so a recommendation can
 * never become an effect on its own.
 */
export type ConversationDisposition =
  "stop_contacting" | "prepare_reply_for_approval" | "request_human_review" | "record_and_hold";

/**
 * Why a response was treated the way it was.
 *
 * `ROADMAP.md` §19 makes unsubscribe, negative intent, a sensitive issue,
 * uncertainty and an unusual request the safety triggers. They are a closed set
 * so that a safety decision is inspectable rather than a mood.
 */
export type ConversationSignalKind =
  | "opt_out"
  | "negative_sentiment"
  | "sensitive_topic"
  | "uncertainty"
  | "unusual_request"
  | "interest"
  | "positive_sentiment"
  | "question_signal"
  | "pricing_signal"
  | "objection_signal"
  | "deferral"
  | "routing";

/** How strongly the rules support a classification. */
export type ConversationConfidence = "low" | "medium" | "high";

/** The steps a classification's audit trail records. */
export type ConversationEventKind = "recorded" | "classified" | "suppressed" | "escalated" | "held";

/**
 * One inbound response, recorded verbatim (Phase 12).
 *
 * This is **not** evidence and never becomes evidence here. Phase 7 exists so
 * that a fact about an account carries a source, a confidence and a lifecycle,
 * and nothing in this phase may shortcut it: a prospect's own words are a claim
 * by an interested party, not an attested fact about their company. The message
 * is therefore stored here, attributed and timestamped, and converting it into
 * a claim is a separate, human-driven Phase 7 decision that this package does
 * not perform.
 *
 * It is also not a copy of an outbound message. It answers one specific
 * `outboundActionId`, so a response to something DEALORA never sent cannot be
 * recorded, and the contact and account are resolved server-side from that
 * action rather than accepted from a caller.
 */
export interface InboundMessage {
  id: EntityId;
  workspaceId: EntityId;
  recordedBy: EntityId;
  /** The sent outbound action this message answers. */
  outboundActionId: EntityId;
  /** Resolved server-side from the outbound action, never from the caller. */
  contactId: EntityId;
  /** Resolved server-side from the contact, never from the caller. */
  accountId: EntityId;
  source: InboundSource;
  /** The address the message says it came from, when a source supplied one. */
  fromAddress: string | null;
  subject: string | null;
  /** The response text, stored exactly as received. */
  body: string;
  /** A provider's own reference for this message, when one was supplied. */
  providerMessageId: string | null;
  /** When the response was received, as recorded. Never inferred. */
  receivedAt: DateTime;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/**
 * One classification of one inbound response (Phase 12).
 *
 * Immutable and versioned, like every other decision record in DEALORA: the
 * `classifierVersion` is stored so a later reader can tell which rules produced
 * the intent, and the record is never rewritten when the rules move on.
 *
 * `reasons` names the phrases that decided the intent and `signals` names the
 * safety triggers that fired, so a user can always answer "why did DEALORA read
 * it that way" without re-running anything.
 */
export interface ConversationClassification {
  id: EntityId;
  workspaceId: EntityId;
  inboundMessageId: EntityId;
  outboundActionId: EntityId;
  classifierVersion: string;
  intent: ConversationIntent;
  confidence: ConversationConfidence;
  reasons: string[];
  signals: ConversationSignalKind[];
  recommendedNextAction: ConversationDisposition;
  /**
   * Whether a person must look at this before anything happens.
   *
   * True for every outcome that could lead to contact. An opt-out is the single
   * exception, because honouring it is the one action that must not wait for a
   * human.
   */
  humanInterventionRequired: boolean;
  /** True when this classification put the address on the suppression list. */
  suppressed: boolean;
  createdBy: EntityId;
  createdAt: DateTime;
}

/**
 * One append-only audit record for a classification (Phase 12).
 *
 * `ROADMAP.md` Rule 13: every consequential action needs an audit trail. These
 * rows are written by the server and never edited, so "we stopped contacting
 * them" is a claim the workspace can check rather than take on trust.
 */
export interface ConversationEvent {
  id: EntityId;
  classificationId: EntityId;
  inboundMessageId: EntityId;
  workspaceId: EntityId;
  actorUserId: EntityId;
  kind: ConversationEventKind;
  detail: string | null;
  createdAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 13 — Meeting Workflow (DEALORA_BLUEPRINT.md §21/§22, ROADMAP.md §20)
// ---------------------------------------------------------------------------

/**
 * The booking state a meeting moves through.
 *
 * `DEALORA_BLUEPRINT.md` §17 classifies *scheduling an event* as a **Level 2
 * external action**: it "requires configurable approval or policy authorization".
 * The vocabulary is built around that, which is why it starts at `recommended`
 * and passes through `awaiting_approval` and `approved` before anything reaches
 * a calendar: there is no state in which a meeting is booked without a human
 * having authorized the exact booking first.
 *
 * The states are deliberately *measurable* rather than optimistic —
 * `ROADMAP.md` §20's gate is "a qualified positive response can result in a
 * measurable meeting state". A meeting that has merely been suggested is
 * `recommended` and says so; it is never reported as a meeting that happened.
 */
export type MeetingBookingState =
  /** Suggested from a positive response. Nothing scheduled, nothing sent. */
  | "recommended"
  /** A person has been asked to authorize this exact booking. */
  | "awaiting_approval"
  /** A person authorized this exact booking. Still not on any calendar. */
  | "approved"
  /** The calendar provider confirmed the event exists. */
  | "booked"
  /** The meeting time passed without being cancelled. */
  | "held"
  /** The meeting time passed and it was cancelled or missed. */
  | "no_show"
  /** A person withdrew it before booking, or after. Terminal. */
  | "cancelled";

/**
 * Why DEALORA recommended a meeting.
 *
 * Closed and inspectable, for the same reason ROADMAP.md Rule 9 exists: a
 * recommendation the user cannot interrogate is an assertion, not a decision aid.
 *
 * Every member is one the rules can actually produce. There is no "a human asked
 * for this" member, because the recommendation reason is derived server-side
 * from the classification — a member no code path could emit would be a value
 * the policy route advertises and the engine never produces.
 */
export type MeetingRecommendationReason =
  /** The response read as positive intent. */
  | "positive_intent"
  /** The response expressed interest without an explicit positive signal. */
  | "expressed_interest";

/**
 * How a booking reached the calendar, or failed to.
 *
 * Phase 13 ships the *boundary*, not a live calendar: ROADMAP.md §30 defers
 * "CRM, calendar, email, Slack" integrations to Phase 23, explicitly "only after
 * the core revenue loop works". The adapter interface is real and the shipped
 * implementation performs no network I/O, so every booking claim in this
 * repository means "the provider recorded it", never "DEALORA asserted it".
 */
export type MeetingBookingChannel = "sandbox" | "provider";

/** The steps a meeting's audit trail records. */
export type MeetingEventKind =
  | "recommended"
  | "approval_requested"
  | "approved"
  | "declined"
  | "booking_attempted"
  | "booked"
  | "booking_failed"
  | "brief_generated"
  | "cancelled"
  | "marked_held"
  | "marked_no_show";

/**
 * One meeting booking, persisted — the phase's measurable state.
 *
 * Every id this record carries is a **reference** to the record it came from, not
 * a copy of its content, and the chain is verifiable in both directions:
 *
 *   classification (positive intent)
 *     → qualification (the account qualified)
 *       → contact / account (who it is for)
 *         → approval (a person authorized this exact booking)
 *           → calendar (the provider confirmed an event exists)
 *
 * The chain is stored rather than re-derived because each link is a fact someone
 * made: re-computing "was this authorized?" from the current state of the world
 * would make an approval retroactively valid or invalid, which is exactly the
 * failure mode Phase 10 was built to prevent.
 *
 * **A booking record is not evidence.** Nothing here feeds `evidence` or
 * `accountClaims`, and meeting metadata is exactly what its owner supplied — not
 * an attested fact about the account.
 */
export interface Meeting {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  /** The contact the meeting is with. Always resolved server-side. */
  contactId: EntityId;
  /** The positive-intent classification this meeting came from. */
  classificationId: EntityId;
  /** The inbound response that classification was made from. */
  inboundMessageId: EntityId;
  /** The outbound action that response answers. */
  outboundActionId: EntityId;
  /** The qualification that made this account worth a meeting. */
  qualificationId: EntityId;
  state: MeetingBookingState;
  recommendationReason: MeetingRecommendationReason;
  /** The rule set that produced the recommendation. Never overwritten. */
  policyVersion: string;
  /**
   * A digest of the exact booking a person was shown.
   *
   * Re-derived at decision time exactly as Phase 10 re-derives a draft digest, so
   * an approval can only ever mean "I authorized *this* booking" — never "I
   * authorized something like it".
   */
  bookingDigest: string;
  /** The meeting's own metadata. Supplied by a person, never invented. */
  title: string;
  /** ISO-8601 instant the meeting is proposed to start. */
  startsAt: DateTime;
  /** ISO-8601 instant the meeting is proposed to end. */
  endsAt: DateTime;
  /** IANA timezone the times above were stated in. */
  timezone: string;
  durationMinutes: number;
  channel: MeetingBookingChannel;
  /** The provider's own reference for the created event, when one was issued. */
  externalEventId: string | null;
  /**
   * Whether the booking is still permitted by the Phase 11 opt-out list.
   *
   * Denormalized on purpose: an opt-out recorded *after* a meeting was approved
   * must be able to stop the booking, and the send path already re-checks the
   * suppression list for exactly this reason.
   */
  suppressionCheckedAt: DateTime | null;
  /** The Phase 10 approval behind this booking, once one exists. */
  approvedBy: EntityId | null;
  approvedAt: DateTime | null;
  bookedAt: DateTime | null;
  cancelledAt: DateTime | null;
  /** Why a booking was declined or cancelled. Required for both. */
  decisionReason: string | null;
  createdBy: EntityId;
  createdAt: DateTime;
  updatedAt: DateTime;
}

/**
 * The preparation brief for one meeting — BLUEPRINT.md §22.
 *
 * Assembled from records that already exist, never from a new claim. Each section
 * names the record it came from, so a reader can check the brief against the
 * workspace's own record instead of taking it on trust, and an empty section says
 * `unavailable` rather than being quietly filled in.
 *
 * **The brief is not a recommendation engine.** ROADMAP.md §21 (Next Best
 * Action) is a later phase; this brief reports what is known and what is missing,
 * and names the questions a person should ask. It does not score, rank or
 * predict.
 */
export interface MeetingBrief {
  id: EntityId;
  workspaceId: EntityId;
  meetingId: EntityId;
  /** 1-based version within the meeting's lineage. Never reused. */
  version: number;
  /** Which brief renderer produced this. Never overwritten. */
  rendererVersion: string;
  /** The account this brief is about. */
  accountId: EntityId;
  contactId: EntityId;
  /** The qualification the brief reads, referenced not copied. */
  qualificationId: EntityId;
  /** The score the qualification resolved to, or `null` when it resolved none. */
  qualificationScore: number | null;
  /** The classification the brief reads, referenced not copied. */
  classificationId: EntityId;
  /** The intent that classification resolved to. */
  intent: ConversationIntent;
  /** Every claim the brief quoted. References, never copies. */
  claimIds: EntityId[];
  /** Every evidence record behind those claims. References, never copies. */
  evidenceIds: EntityId[];
  /** The response text this meeting came from, quoted verbatim. */
  conversationExcerpt: string;
  /**
   * Named gaps: things §22 lists that the workspace has no record of.
   *
   * Present so the brief is honest about its own limits. An empty array would
   * read as "everything is known", which is a claim nobody can make.
   */
  gaps: string[];
  createdBy: EntityId;
  createdAt: DateTime;
}

/**
 * One append-only audit record for a meeting booking (Phase 13).
 *
 * A booking that reached someone's calendar has to be explainable: which
 * response proposed it, who authorized it, and whether the provider confirmed it.
 * These rows are written by the server and never edited or deleted.
 */
export interface MeetingEvent {
  id: EntityId;
  meetingId: EntityId;
  workspaceId: EntityId;
  actorUserId: EntityId;
  kind: MeetingEventKind;
  detail: string | null;
  createdAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 14 — Next Best Action Engine (DEALORA_BLUEPRINT.md §25, ROADMAP.md §21)
// ---------------------------------------------------------------------------

/**
 * What DEALORA recommends doing next about one account.
 *
 * Closed and, more importantly, **entirely producible**: every member is emitted
 * by a branch of the engine that reads stored rows. A vocabulary a reader cannot
 * trust to be reachable is worse than a short one, and an earlier draft of this
 * phase was corrected for exactly that.
 *
 * None of these is an action DEALORA takes. They are the next *step a person or
 * a later phase could take*, and the strongest ones still name the phase that
 * owns doing it.
 */
export type NextBestActionKind =
  /** Do not contact this address: it asked to stop, or refused. */
  | "stop_contacting"
  /** The account has no research yet, so nothing downstream can be honest. */
  | "research_account"
  /** Findings exist but no one has converted them into evidence. */
  | "convert_findings_to_evidence"
  /** Evidence exists but the account has never been evaluated against the ICP. */
  | "qualify_account"
  /** The account qualified and nobody has written a draft for it. */
  | "personalize_outreach"
  /** A draft exists and no approval has ever been requested for it. */
  | "request_approval"
  /** An approval is in hand and nothing has gone out. */
  | "send_approved_message"
  /** A response was read as positive and nobody has proposed a meeting. */
  | "propose_meeting"
  /** A meeting a person approved has not reached a calendar. */
  | "book_meeting"
  /** A meeting is booked and nobody has prepared the brief. */
  | "prepare_meeting_brief"
  /** A response was read as a question or a price and no reply is prepared. */
  | "prepare_reply_for_approval"
  /** Nothing is actionable without a person. Reported rather than guessed. */
  | "hold";

/**
 * The revenue state that produced the recommendation.
 *
 * Closed, and **one member per decision branch of the engine**, so "supporting
 * state" is always a named, checkable fact about the workspace's own records
 * rather than a summary that could drift from them. Every member is reachable
 * from stored rows and each one is tested by the engine; the two properties are
 * kept together deliberately, because a state the engine can never observe is
 * the same kind of dead vocabulary Phase 13 was corrected for.
 *
 * The list walks the revenue loop in the order it actually happens, with the
 * safety conditions first — exactly the precedence the engine applies, so the
 * order here is also the answer to "which condition wins when several are true".
 */
export type NextBestActionState =
  /** Phase 11 suppression or a Phase 12 opt-out already blocks this account. */
  | "suppressed"
  /** A meeting was proposed and no one has requested approval for it yet. */
  | "meeting_recommended"
  /** A meeting is waiting on a person's approval decision. */
  | "meeting_awaiting_approval"
  /** A meeting a person approved has not reached a calendar. */
  | "meeting_approved"
  /** A meeting is booked and has no preparation brief. */
  | "meeting_booked_without_brief"
  /** A meeting is booked and briefed. Nothing further is DEALORA's to do. */
  | "meeting_booked"
  /** The newest meeting reached a terminal Phase 13 state. */
  | "meeting_closed"
  /** A response read as positive and no meeting has ever been proposed. */
  | "positive_response_without_meeting"
  /** No Phase 6 research request exists for the account. */
  | "no_research"
  /** Findings exist and no one has converted any of them into evidence. */
  | "researched_without_evidence"
  /** Evidence exists and the account has never been evaluated. */
  | "evidenced_without_qualification"
  /** The newest Phase 8 evaluation exists but is not `qualified`. */
  | "not_qualified"
  /** The account qualified and no draft has been rendered. */
  | "qualified_without_draft"
  /** A draft exists and no approval request has ever been raised for it. */
  | "drafted_without_approval"
  /** An approval request is waiting on a reviewer. */
  | "approval_pending"
  /** An approval was granted and nothing has gone out for it. */
  | "approved_without_send"
  /** A message went out and no response has been classified yet. */
  | "awaiting_response"
  /** A response was classified and needs a reply a person must approve. */
  | "response_needing_reply";

/**
 * The `DEALORA_BLUEPRINT.md` §17 risk classification of the recommended step.
 *
 * The Blueprint's own vocabulary rather than an invented one, because
 * "approval requirement" in `ROADMAP.md` §21 means exactly this: whether acting
 * on the recommendation requires a person first.
 *
 * `level_3_high_impact` is deliberately absent. No branch in this phase
 * recommends a financial commitment, a contract action or an irreversible
 * change, and listing a level nothing can reach would be advertising behaviour
 * that does not exist.
 */
export type NextBestActionRiskLevel = "level_0_read" | "level_1_draft" | "level_2_external_action";

/**
 * What acting on the recommendation is expected to produce.
 *
 * Closed, and derived from the action through a single map, so "expected
 * outcome" can never disagree with the action it belongs to and can never be a
 * free-text promise the engine has no way to keep.
 */
export type NextBestActionOutcome =
  | "contact_stopped"
  | "research_findings_available"
  | "evidence_available"
  | "qualification_available"
  | "draft_available"
  | "approval_decided"
  | "message_delivered"
  | "meeting_proposed"
  | "meeting_booked"
  | "brief_available"
  | "reply_prepared"
  | "no_action_available";

/**
 * One recommendation, immutable once written (Phase 14).
 *
 * `ROADMAP.md` §21 requires seven things on every recommendation — action,
 * reason, supporting state, evidence, confidence, expected outcome and approval
 * requirement — and all seven are fields here rather than prose assembled at
 * read time, so a stored recommendation can still be checked against it years
 * later.
 *
 * **A recommendation is not a decision and not a fact.** Nothing in this phase
 * acts on one, and this record writes nothing to the Phase 7 evidence graph: a
 * "next step" is DEALORA's own advice, which is an inference about the
 * workspace's own records, not an attested fact about an account.
 */
export interface NextBestAction {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  action: NextBestActionKind;
  /** The named revenue state this recommendation came from. */
  supportingState: NextBestActionState;
  /**
   * Why, in one sentence, assembled from named stored facts.
   *
   * Never a claim about the account that the workspace's own records do not
   * support: every clause names something the engine read.
   */
  reason: string;
  /** The specific factors that set the confidence band, in order. */
  confidenceReasons: string[];
  confidence: ResearchConfidence;
  riskLevel: NextBestActionRiskLevel;
  /** True exactly when `riskLevel` is `level_2_external_action`. */
  approvalRequired: boolean;
  expectedOutcome: NextBestActionOutcome;
  /** Every evidence record that supports this recommendation. References. */
  evidenceIds: EntityId[];
  /** Every account claim that supports it. References. */
  claimIds: EntityId[];
  /** Which rule set produced it. Never overwritten. */
  ruleVersion: string;
  createdBy: EntityId;
  createdAt: DateTime;
}

// ---------------------------------------------------------------------------
// Phase 16 — Cost Engine
// ---------------------------------------------------------------------------

/**
 * The six cost categories `ROADMAP.md` §23 and `DEALORA_BLUEPRINT.md` §33
 * name — a closed vocabulary, so a cost outside this list cannot be
 * represented, advertised or silently folded into another bucket.
 */
export type CostCategory = "llm" | "search" | "data" | "tool" | "infrastructure" | "execution";

/**
 * Whether an amount was **estimated** before the fact or **measured** from a
 * usage or billing record. `ROADMAP.md` §23's gate turns on exactly this
 * distinction: a workflow execution can show estimated or measured cost.
 */
export type CostBasis = "estimated" | "measured";

/**
 * The run a cost event is attributed to. Phase 16's closed list covers the
 * runs this repository can actually perform; `workflow` is refused with the
 * phase that owns it rather than published as an unreachable kind.
 */
export type CostExecutionKind = "research_run" | "outbound_send" | "meeting_booking";

/**
 * An immutable recorded cost fact — `DEALORA_BLUEPRINT.md` §33's "every run
 * should record".
 *
 * The row is append-only: `amountMinor` is a whole number of the currency's
 * minor units (never a float), `occurredAt` is the instant the cost was
 * incurred (a validated fact, never an authoritative timestamp), and
 * `createdBy` / `createdAt` are written server-side, so who recorded a cost
 * and when is never a client claim. `idempotencyKey` is unique per workspace,
 * which is what makes a replayed request return the same fact instead of
 * counting it twice.
 */
export interface CostEvent {
  id: EntityId;
  workspaceId: EntityId;
  executionKind: CostExecutionKind;
  executionId: EntityId;
  category: CostCategory;
  basis: CostBasis;
  /** Whole minor units of `currency` (e.g. cents for USD). Integer, ≥ 0. */
  amountMinor: number;
  /** One currency per workspace; totals never mix currencies. */
  currency: string;
  /** The system that reported the fact (e.g. a billing export). Optional. */
  source: string | null;
  /** The instant the cost was incurred. A validated fact, not an authority. */
  occurredAt: DateTime;
  /** Client-chosen replay key, unique within the workspace. */
  idempotencyKey: string;
  /** Server-derived: who recorded it, taken from the session. */
  createdBy: EntityId;
  /** Server-derived: when it was recorded. Never client-controlled. */
  createdAt: DateTime;
}
