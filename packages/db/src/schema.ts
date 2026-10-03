/**
 * Phase 1 + Phase 2 schema.
 *
 * The goal is a schema that can evolve without destructive redesign: every
 * table uses an `id` primary key, UTC `created_at`/`updated_at` instants, and
 * a `deleted_at` tombstone. Deleted rows stay isolated by `workspace_id` and
 * are never returned by default queries.
 *
 * Relations (Phase 1):
 *   User 1 -- * Workspace
 *   User 1 -- * WorkspaceMember (membership)
 *   Workspace 1 -- 1 BusinessProfile  (the company section of the Brain)
 *
 * Relations (Phase 2 — Business Brain, DEALORA_BLUEPRINT.md §9):
 *   Workspace 1 -- * Offer
 *   Workspace 1 -- 1 Icp
 *   Workspace 1 -- * Persona
 *   Workspace 1 -- 1 Positioning
 *   Workspace 1 -- 1 BrandVoice
 *   Workspace 1 -- * Claim
 *
 * Sections that hold a single record per workspace (Icp, Positioning,
 * BrandVoice, BusinessProfile) are keyed by a UNIQUE `workspace_id` so the
 * Business Brain stays a single canonical source of truth rather than a
 * competing set of records.
 *
 * Relations (Phase 6 — Research Engine, ROADMAP.md §13):
 *   Account 1 -- * ResearchRequest
 *   ResearchRequest 1 -- * ResearchFinding
 *
 * No other tables exist yet: ROADMAP.md §8 explicitly says "Not every entity
 * needs full functionality in Phase 1", and §9 lists further Business Brain
 * concepts (case studies, FAQs, competitors, playbooks) that the phases that
 * consume them introduce.
 */

export const COLUMNS = {
  id: "id",
  tenantId: "tenant_id",
  userId: "user_id",
  workspaceId: "workspace_id",
  ownerId: "owner_id",
  email: "email",
  passwordHash: "password_hash",
  displayName: "display_name",
  role: "role",
  name: "name",
  slug: "slug",
  logoUrl: "logo_url",
  timezone: "timezone",
  settings: "settings",
  description: "description",
  website: "website",
  type: "type",
  offer: "offer",
  industry: "industry",
  size: "size",
  market: "market",
  createdAt: "created_at",
  updatedAt: "updated_at",
  deletedAt: "deleted_at",
  invitedAt: "invited_at",
  acceptedAt: "accepted_at",
  targetCustomer: "target_customer",
  problemSolved: "problem_solved",
  outcome: "outcome",
  pricing: "pricing",
  deliveryModel: "delivery_model",
  status: "status",
  title: "title",
  responsibilities: "responsibilities",
  painPoints: "pain_points",
  goals: "goals",
  buyingContext: "buying_context",
  industries: "industries",
  companySizes: "company_sizes",
  geographies: "geographies",
  businessModels: "business_models",
  characteristics: "characteristics",
  disqualifiers: "disqualifiers",
  notes: "notes",
  statement: "statement",
  differentiators: "differentiators",
  approvedValuePropositions: "approved_value_propositions",
  competitorContext: "competitor_context",
  tone: "tone",
  style: "style",
  terminology: "terminology",
  constraints: "constraints",
  text: "text",
  category: "category",
  sourceNote: "source_note",
  approvedBy: "approved_by",
  approvedAt: "approved_at",
  objective: "objective",
  targetMetric: "target_metric",
  targetValue: "target_value",
  currency: "currency",
  timeWindow: "time_window",
  icpId: "icp_id",
  buyerPersonaIds: "buyer_persona_ids",
  offerId: "offer_id",
  economics: "economics",
  approvalPolicy: "approval_policy",
  successMetrics: "success_metrics",
  completeness: "completeness",
  unknowns: "unknowns",
  assumptions: "assumptions",
  recommendations: "recommendations",
  accountId: "account_id",
  domain: "domain",
  geography: "geography",
  companySize: "company_size",
  source: "source",
  sourceReference: "source_reference",
  firstName: "first_name",
  lastName: "last_name",
  fullName: "full_name",
  jobTitle: "job_title",
  phone: "phone",
  profileUrl: "profile_url",
  goalId: "goal_id",
  actorUserId: "actor_user_id",
  kind: "kind",
  fromStatus: "from_status",
  toStatus: "to_status",
  revenueGoalId: "revenue_goal_id",
  revenuePlanId: "revenue_plan_id",
  planVersion: "plan_version",
  compilerVersion: "compiler_version",
  brainSnapshotDigest: "brain_snapshot_digest",
  references: "references",
  strategies: "strategies",
  facts: "facts",
  inferences: "inferences",
  approval: "approval",
  rationale: "rationale",
  provider: "provider",
  idempotencyKey: "idempotency_key",
  categories: "categories",
  findingCount: "finding_count",
  failureCode: "failure_code",
  failureMessage: "failure_message",
  startedAt: "started_at",
  completedAt: "completed_at",
  researchRequestId: "research_request_id",
  field: "field",
  value: "value",
  claimKind: "claim_kind",
  sourceName: "source_name",
  sourceUrl: "source_url",
  sourceTitle: "source_title",
  observedAt: "observed_at",
  retrievedAt: "retrieved_at",
  confidence: "confidence",
  freshness: "freshness",
  relevance: "relevance",
  note: "note",
} as const;

export type ColumnName = (typeof COLUMNS)[keyof typeof COLUMNS];

/** Table: users. */
export const userTable = "users" as const;

/** Table: workspaces (the tenant boundary). */
export const workspaceTable = "workspaces" as const;

/** Table: workspace members (membership + ownership). */
export const workspaceMembersTable = "workspace_members" as const;

/** Table: business profiles — the company section of the Business Brain. */
export const businessProfilesTable = "business_profiles" as const;

/** Table: commercial offers (Phase 2). */
export const offerTable = "offers" as const;

/** Table: ideal customer profile, one per workspace (Phase 2). */
export const icpTable = "icps" as const;

/** Table: buyer personas (Phase 2). */
export const personaTable = "personas" as const;

/** Table: positioning, one per workspace (Phase 2). */
export const positioningTable = "positioning" as const;

/** Table: brand voice, one per workspace (Phase 2). */
export const brandVoiceTable = "brand_voice" as const;

/** Table: business claims with explicit approval status (Phase 2). */
export const claimTable = "claims" as const;

/** Table: structured revenue goals (Phase 3). */
export const revenueGoalTable = "revenue_goals" as const;

/** Table: auditable revenue-goal status transitions (Phase 3). */
export const revenueGoalEventTable = "revenue_goal_events" as const;

/**
 * Table: compiled revenue plans (Phase 4).
 *
 * One row per compiled plan version. Recompiling a goal inserts a new version
 * rather than overwriting, so historical plans stay inspectable.
 */
export const revenuePlanTable = "revenue_plans" as const;

/** Table: target accounts supplied by the user (Phase 5). */
export const accountTable = "accounts" as const;

/** Table: contacts at a target account, supplied by the user (Phase 5). */
export const contactTable = "contacts" as const;

/**
 * Table: research requests (Phase 6).
 *
 * One row per research job against an account. Holds what was asked and which
 * permitted provider answers it — not the findings themselves.
 */
export const researchRequestTable = "research_requests" as const;

/**
 * Table: research findings (Phase 6).
 *
 * Structured, attributed observations. Not evidence: verification and linking
 * are Phase 7, so nothing here carries a verification state.
 */
export const researchFindingTable = "research_findings" as const;

/** All tables, in creation order — the canonical table list. */
export const tables = [
  userTable,
  workspaceTable,
  workspaceMembersTable,
  businessProfilesTable,
  offerTable,
  icpTable,
  personaTable,
  positioningTable,
  brandVoiceTable,
  claimTable,
  revenueGoalTable,
  revenueGoalEventTable,
  revenuePlanTable,
  accountTable,
  contactTable,
  researchRequestTable,
  researchFindingTable,
] as const;

function COLUMN(table: string, column: string): string {
  return `"${table}"."${column}"`;
}

/** Uniqueness keys: email must be unique, workspace slug unique. */
export const indexes = {
  users: [`${COLUMNS.email} UNIQUE NOT NULL`],
  workspaces: [`${COLUMNS.id} PRIMARY KEY`, `${COLUMNS.slug} UNIQUE NOT NULL`],
  workspaceMembers: [
    `${COLUMNS.workspaceId} NOT NULL`,
    `${COLUMN(workspaceMembersTable, "user_id")} NOT NULL`,
    `${COLUMN(workspaceMembersTable, "invited_at")} NOT NULL`,
  ],
  businessProfiles: [
    `${COLUMN(businessProfilesTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(businessProfilesTable, COLUMNS.workspaceId)} UNIQUE NOT NULL`,
  ],
  offers: [
    `${COLUMN(offerTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(offerTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(offerTable, COLUMNS.name)} NOT NULL`,
  ],
  icps: [
    `${COLUMN(icpTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(icpTable, COLUMNS.workspaceId)} UNIQUE NOT NULL`,
  ],
  personas: [
    `${COLUMN(personaTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(personaTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(personaTable, COLUMNS.title)} NOT NULL`,
  ],
  positioning: [
    `${COLUMN(positioningTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(positioningTable, COLUMNS.workspaceId)} UNIQUE NOT NULL`,
  ],
  brandVoice: [
    `${COLUMN(brandVoiceTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(brandVoiceTable, COLUMNS.workspaceId)} UNIQUE NOT NULL`,
  ],
  claims: [
    `${COLUMN(claimTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(claimTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(claimTable, COLUMNS.status)} NOT NULL`,
  ],
  revenueGoals: [
    `${COLUMN(revenueGoalTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(revenueGoalTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(revenueGoalTable, COLUMNS.status)} NOT NULL`,
  ],
  revenuePlans: [
    `${COLUMN(revenuePlanTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(revenuePlanTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(revenuePlanTable, COLUMNS.status)} NOT NULL`,
    `${COLUMN(revenuePlanTable, COLUMNS.planVersion)} NOT NULL`,
  ],
  accounts: [
    `${COLUMN(accountTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(accountTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(accountTable, COLUMNS.name)} NOT NULL`,
    `${COLUMN(accountTable, COLUMNS.status)} NOT NULL`,
  ],
  contacts: [
    `${COLUMN(contactTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(contactTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(contactTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(contactTable, COLUMNS.fullName)} NOT NULL`,
    `${COLUMN(contactTable, COLUMNS.status)} NOT NULL`,
  ],
  revenueGoalEvents: [
    `${COLUMN(revenueGoalEventTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(revenueGoalEventTable, COLUMNS.goalId)} NOT NULL`,
  ],
  researchRequests: [
    `${COLUMN(researchRequestTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(researchRequestTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(researchRequestTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(researchRequestTable, COLUMNS.status)} NOT NULL`,
  ],
  researchFindings: [
    `${COLUMN(researchFindingTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(researchFindingTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(researchFindingTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(researchFindingTable, COLUMNS.researchRequestId)} NOT NULL`,
  ],
};

/** SQL DDL for a single table (PostgreSQL-compatible dialect). */
export function createTableSql(
  table: string,
  columns: readonly string[],
  primaryKey: string,
): string {
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (${primaryKey},`,
    ...columns.map((c) => `  ${c}`),
    `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),`,
    `     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),`,
    `     deleted_at TIMESTAMPTZ)`,
    `;`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_deleted ON "${table}"("deleted_at") WHERE "deleted_at" IS NULL;`,
  ].join("\n");
}

export const SCHEMA = [
  createTableSql(
    userTable,
    [
      COLUMN(userTable, COLUMNS.id),
      COLUMN(userTable, COLUMNS.email),
      COLUMN(userTable, COLUMNS.passwordHash),
      COLUMN(userTable, COLUMNS.displayName),
      COLUMN(userTable, COLUMNS.role),
    ],
    `${COLUMN(userTable, COLUMNS.id)} PRIMARY KEY`,
  ),
  createTableSql(
    workspaceTable,
    [
      COLUMN(workspaceTable, COLUMNS.id),
      COLUMN(workspaceTable, COLUMNS.ownerId),
      COLUMN(workspaceTable, COLUMNS.name),
      COLUMN(workspaceTable, COLUMNS.slug),
      COLUMN(workspaceTable, COLUMNS.logoUrl),
      COLUMN(workspaceTable, COLUMNS.timezone),
      COLUMN(workspaceTable, COLUMNS.settings),
    ],
    `${COLUMN(workspaceTable, COLUMNS.id)} PRIMARY KEY`,
  ),
  createTableSql(
    workspaceMembersTable,
    [
      COLUMN(workspaceMembersTable, COLUMNS.workspaceId),
      COLUMN(workspaceMembersTable, COLUMNS.userId),
      COLUMN(workspaceMembersTable, COLUMNS.role),
      COLUMN(workspaceMembersTable, COLUMNS.invitedAt),
      COLUMN(workspaceMembersTable, COLUMNS.acceptedAt),
    ],
    `${COLUMN(workspaceMembersTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(workspaceMembersTable, COLUMNS.userId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
PRIMARY KEY ("${COLUMNS.workspaceId}", "${COLUMNS.userId}")`,
  ),
  createTableSql(
    businessProfilesTable,
    [
      COLUMN(businessProfilesTable, COLUMNS.id),
      COLUMN(businessProfilesTable, COLUMNS.workspaceId),
      COLUMN(businessProfilesTable, COLUMNS.ownerId),
      COLUMN(businessProfilesTable, COLUMNS.name),
      COLUMN(businessProfilesTable, COLUMNS.description),
      COLUMN(businessProfilesTable, COLUMNS.website),
      COLUMN(businessProfilesTable, COLUMNS.type),
      COLUMN(businessProfilesTable, COLUMNS.offer),
      COLUMN(businessProfilesTable, COLUMNS.industry),
      COLUMN(businessProfilesTable, COLUMNS.size),
      COLUMN(businessProfilesTable, COLUMNS.market),
    ],
    `${COLUMN(businessProfilesTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(businessProfilesTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(businessProfilesTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
UNIQUE("${COLUMNS.workspaceId}")`,
  ),
  createTableSql(
    offerTable,
    [
      COLUMN(offerTable, COLUMNS.id),
      COLUMN(offerTable, COLUMNS.workspaceId),
      COLUMN(offerTable, COLUMNS.name),
      COLUMN(offerTable, COLUMNS.description),
      COLUMN(offerTable, COLUMNS.targetCustomer),
      COLUMN(offerTable, COLUMNS.problemSolved),
      COLUMN(offerTable, COLUMNS.outcome),
      COLUMN(offerTable, COLUMNS.pricing),
      COLUMN(offerTable, COLUMNS.deliveryModel),
      COLUMN(offerTable, COLUMNS.status),
    ],
    `${COLUMN(offerTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(offerTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE`,
  ),
  createTableSql(
    icpTable,
    [
      COLUMN(icpTable, COLUMNS.id),
      COLUMN(icpTable, COLUMNS.workspaceId),
      COLUMN(icpTable, COLUMNS.industries),
      COLUMN(icpTable, COLUMNS.companySizes),
      COLUMN(icpTable, COLUMNS.geographies),
      COLUMN(icpTable, COLUMNS.businessModels),
      COLUMN(icpTable, COLUMNS.characteristics),
      COLUMN(icpTable, COLUMNS.disqualifiers),
      COLUMN(icpTable, COLUMNS.notes),
    ],
    `${COLUMN(icpTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(icpTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
UNIQUE("${COLUMNS.workspaceId}")`,
  ),
  createTableSql(
    personaTable,
    [
      COLUMN(personaTable, COLUMNS.id),
      COLUMN(personaTable, COLUMNS.workspaceId),
      COLUMN(personaTable, COLUMNS.title),
      COLUMN(personaTable, COLUMNS.responsibilities),
      COLUMN(personaTable, COLUMNS.painPoints),
      COLUMN(personaTable, COLUMNS.goals),
      COLUMN(personaTable, COLUMNS.buyingContext),
    ],
    `${COLUMN(personaTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(personaTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE`,
  ),
  createTableSql(
    positioningTable,
    [
      COLUMN(positioningTable, COLUMNS.id),
      COLUMN(positioningTable, COLUMNS.workspaceId),
      COLUMN(positioningTable, COLUMNS.statement),
      COLUMN(positioningTable, COLUMNS.differentiators),
      COLUMN(positioningTable, COLUMNS.approvedValuePropositions),
      COLUMN(positioningTable, COLUMNS.competitorContext),
    ],
    `${COLUMN(positioningTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(positioningTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
UNIQUE("${COLUMNS.workspaceId}")`,
  ),
  createTableSql(
    brandVoiceTable,
    [
      COLUMN(brandVoiceTable, COLUMNS.id),
      COLUMN(brandVoiceTable, COLUMNS.workspaceId),
      COLUMN(brandVoiceTable, COLUMNS.tone),
      COLUMN(brandVoiceTable, COLUMNS.style),
      COLUMN(brandVoiceTable, COLUMNS.terminology),
      COLUMN(brandVoiceTable, COLUMNS.constraints),
    ],
    `${COLUMN(brandVoiceTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(brandVoiceTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
UNIQUE("${COLUMNS.workspaceId}")`,
  ),
  createTableSql(
    claimTable,
    [
      COLUMN(claimTable, COLUMNS.id),
      COLUMN(claimTable, COLUMNS.workspaceId),
      COLUMN(claimTable, COLUMNS.text),
      COLUMN(claimTable, COLUMNS.category),
      COLUMN(claimTable, COLUMNS.status),
      COLUMN(claimTable, COLUMNS.sourceNote),
      COLUMN(claimTable, COLUMNS.approvedBy),
      COLUMN(claimTable, COLUMNS.approvedAt),
    ],
    `${COLUMN(claimTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(claimTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(claimTable, COLUMNS.status)} CHECK (${COLUMN(claimTable, COLUMNS.status)} IN ('approved','unverified','restricted'))`,
  ),
  createTableSql(
    revenueGoalTable,
    [
      COLUMN(revenueGoalTable, COLUMNS.id),
      COLUMN(revenueGoalTable, COLUMNS.workspaceId),
      COLUMN(revenueGoalTable, COLUMNS.ownerId),
      COLUMN(revenueGoalTable, COLUMNS.objective),
      COLUMN(revenueGoalTable, COLUMNS.targetMetric),
      COLUMN(revenueGoalTable, COLUMNS.targetValue),
      COLUMN(revenueGoalTable, COLUMNS.currency),
      COLUMN(revenueGoalTable, COLUMNS.timeWindow),
      COLUMN(revenueGoalTable, COLUMNS.market),
      COLUMN(revenueGoalTable, COLUMNS.icpId),
      COLUMN(revenueGoalTable, COLUMNS.buyerPersonaIds),
      COLUMN(revenueGoalTable, COLUMNS.offerId),
      COLUMN(revenueGoalTable, COLUMNS.economics),
      COLUMN(revenueGoalTable, COLUMNS.constraints),
      COLUMN(revenueGoalTable, COLUMNS.approvalPolicy),
      COLUMN(revenueGoalTable, COLUMNS.successMetrics),
      COLUMN(revenueGoalTable, COLUMNS.status),
      COLUMN(revenueGoalTable, COLUMNS.completeness),
      COLUMN(revenueGoalTable, COLUMNS.unknowns),
      COLUMN(revenueGoalTable, COLUMNS.assumptions),
    ],
    `${COLUMN(revenueGoalTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(revenueGoalTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenueGoalTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenueGoalTable, COLUMNS.targetValue)} CHECK (${COLUMN(revenueGoalTable, COLUMNS.targetValue)} > 0),
${COLUMN(revenueGoalTable, COLUMNS.status)} CHECK (${COLUMN(revenueGoalTable, COLUMNS.status)} IN ('draft','active','paused','completed','archived'))`,
  ),
  createTableSql(
    revenueGoalEventTable,
    [
      COLUMN(revenueGoalEventTable, COLUMNS.id),
      COLUMN(revenueGoalEventTable, COLUMNS.goalId),
      COLUMN(revenueGoalEventTable, COLUMNS.workspaceId),
      COLUMN(revenueGoalEventTable, COLUMNS.actorUserId),
      COLUMN(revenueGoalEventTable, COLUMNS.kind),
      COLUMN(revenueGoalEventTable, COLUMNS.fromStatus),
      COLUMN(revenueGoalEventTable, COLUMNS.toStatus),
    ],
    `${COLUMN(revenueGoalEventTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(revenueGoalEventTable, COLUMNS.goalId)} REFERENCES "${revenueGoalTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenueGoalEventTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE`,
  ),
  createTableSql(
    revenuePlanTable,
    [
      COLUMN(revenuePlanTable, COLUMNS.id),
      COLUMN(revenuePlanTable, COLUMNS.workspaceId),
      COLUMN(revenuePlanTable, COLUMNS.ownerId),
      COLUMN(revenuePlanTable, COLUMNS.revenueGoalId),
      COLUMN(revenuePlanTable, COLUMNS.planVersion),
      COLUMN(revenuePlanTable, COLUMNS.compilerVersion),
      COLUMN(revenuePlanTable, COLUMNS.brainSnapshotDigest),
      COLUMN(revenuePlanTable, COLUMNS.references),
      COLUMN(revenuePlanTable, COLUMNS.strategies),
      COLUMN(revenuePlanTable, COLUMNS.facts),
      COLUMN(revenuePlanTable, COLUMNS.inferences),
      COLUMN(revenuePlanTable, COLUMNS.assumptions),
      COLUMN(revenuePlanTable, COLUMNS.recommendations),
      COLUMN(revenuePlanTable, COLUMNS.unknowns),
      COLUMN(revenuePlanTable, COLUMNS.approval),
      COLUMN(revenuePlanTable, COLUMNS.rationale),
      COLUMN(revenuePlanTable, COLUMNS.status),
    ],
    `${COLUMN(revenuePlanTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(revenuePlanTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenuePlanTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenuePlanTable, COLUMNS.revenueGoalId)} REFERENCES "${revenueGoalTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenuePlanTable, COLUMNS.planVersion)} CHECK (${COLUMN(revenuePlanTable, COLUMNS.planVersion)} > 0),
${COLUMN(revenuePlanTable, COLUMNS.status)} CHECK (${COLUMN(revenuePlanTable, COLUMNS.status)} IN ('draft','proposed','approved','archived'))`,
  ),
  createTableSql(
    accountTable,
    [
      COLUMN(accountTable, COLUMNS.id),
      COLUMN(accountTable, COLUMNS.workspaceId),
      COLUMN(accountTable, COLUMNS.ownerId),
      COLUMN(accountTable, COLUMNS.name),
      COLUMN(accountTable, COLUMNS.website),
      COLUMN(accountTable, COLUMNS.domain),
      COLUMN(accountTable, COLUMNS.industry),
      COLUMN(accountTable, COLUMNS.companySize),
      COLUMN(accountTable, COLUMNS.geography),
      COLUMN(accountTable, COLUMNS.description),
      COLUMN(accountTable, COLUMNS.source),
      COLUMN(accountTable, COLUMNS.sourceReference),
      COLUMN(accountTable, COLUMNS.revenuePlanId),
      COLUMN(accountTable, COLUMNS.status),
    ],
    `${COLUMN(accountTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(accountTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(accountTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(accountTable, COLUMNS.name)} NOT NULL,
${COLUMN(accountTable, COLUMNS.source)} CHECK (${COLUMN(accountTable, COLUMNS.source)} IN ('manual','csv','approved_integration')),
${COLUMN(accountTable, COLUMNS.status)} CHECK (${COLUMN(accountTable, COLUMNS.status)} IN ('active','archived'))`,
  ),
  createTableSql(
    contactTable,
    [
      COLUMN(contactTable, COLUMNS.id),
      COLUMN(contactTable, COLUMNS.workspaceId),
      COLUMN(contactTable, COLUMNS.accountId),
      COLUMN(contactTable, COLUMNS.ownerId),
      COLUMN(contactTable, COLUMNS.firstName),
      COLUMN(contactTable, COLUMNS.lastName),
      COLUMN(contactTable, COLUMNS.fullName),
      COLUMN(contactTable, COLUMNS.jobTitle),
      COLUMN(contactTable, COLUMNS.email),
      COLUMN(contactTable, COLUMNS.phone),
      COLUMN(contactTable, COLUMNS.profileUrl),
      COLUMN(contactTable, COLUMNS.source),
      COLUMN(contactTable, COLUMNS.sourceReference),
      COLUMN(contactTable, COLUMNS.status),
    ],
    `${COLUMN(contactTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(contactTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(contactTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(contactTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(contactTable, COLUMNS.source)} CHECK (${COLUMN(contactTable, COLUMNS.source)} IN ('manual','csv','approved_integration')),
${COLUMN(contactTable, COLUMNS.status)} CHECK (${COLUMN(contactTable, COLUMNS.status)} IN ('active','archived'))`,
  ),
  createTableSql(
    researchRequestTable,
    [
      COLUMN(researchRequestTable, COLUMNS.id),
      COLUMN(researchRequestTable, COLUMNS.workspaceId),
      COLUMN(researchRequestTable, COLUMNS.accountId),
      COLUMN(researchRequestTable, COLUMNS.ownerId),
      COLUMN(researchRequestTable, COLUMNS.provider),
      COLUMN(researchRequestTable, COLUMNS.status),
      COLUMN(researchRequestTable, COLUMNS.categories),
      COLUMN(researchRequestTable, COLUMNS.idempotencyKey),
      COLUMN(researchRequestTable, COLUMNS.findingCount),
      COLUMN(researchRequestTable, COLUMNS.failureCode),
      COLUMN(researchRequestTable, COLUMNS.failureMessage),
      COLUMN(researchRequestTable, COLUMNS.startedAt),
      COLUMN(researchRequestTable, COLUMNS.completedAt),
    ],
    `${COLUMN(researchRequestTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(researchRequestTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchRequestTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchRequestTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchRequestTable, COLUMNS.status)} CHECK (${COLUMN(researchRequestTable, COLUMNS.status)} IN ('pending','running','completed','failed','cancelled'))`,
  ),
  createTableSql(
    researchFindingTable,
    [
      COLUMN(researchFindingTable, COLUMNS.id),
      COLUMN(researchFindingTable, COLUMNS.workspaceId),
      COLUMN(researchFindingTable, COLUMNS.researchRequestId),
      COLUMN(researchFindingTable, COLUMNS.accountId),
      COLUMN(researchFindingTable, COLUMNS.category),
      COLUMN(researchFindingTable, COLUMNS.field),
      COLUMN(researchFindingTable, COLUMNS.value),
      COLUMN(researchFindingTable, COLUMNS.claimKind),
      COLUMN(researchFindingTable, COLUMNS.source),
      COLUMN(researchFindingTable, COLUMNS.sourceName),
      COLUMN(researchFindingTable, COLUMNS.sourceUrl),
      COLUMN(researchFindingTable, COLUMNS.sourceTitle),
      COLUMN(researchFindingTable, COLUMNS.observedAt),
      COLUMN(researchFindingTable, COLUMNS.retrievedAt),
      COLUMN(researchFindingTable, COLUMNS.confidence),
      COLUMN(researchFindingTable, COLUMNS.freshness),
      COLUMN(researchFindingTable, COLUMNS.relevance),
      COLUMN(researchFindingTable, COLUMNS.note),
      COLUMN(researchFindingTable, COLUMNS.status),
    ],
    `${COLUMN(researchFindingTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(researchFindingTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchFindingTable, COLUMNS.researchRequestId)} REFERENCES "${researchRequestTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchFindingTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchFindingTable, COLUMNS.source)} CHECK (${COLUMN(researchFindingTable, COLUMNS.source)} IN ('account_record','approved_api','public_web')),
${COLUMN(researchFindingTable, COLUMNS.claimKind)} CHECK (${COLUMN(researchFindingTable, COLUMNS.claimKind)} IN ('fact','inference','hypothesis','recommendation')),
${COLUMN(researchFindingTable, COLUMNS.status)} CHECK (${COLUMN(researchFindingTable, COLUMNS.status)} IN ('recorded'))`,
  ),
].join("\n\n");

/** Normalize a workspace slug from a display name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Validate a scalar against a hard length cap so oversized input fails fast. */
export function capString(value: string, max: number): string {
  if (value.length > max) {
    throw new Error(`must be at most ${max} characters`);
  }
  return value;
}
