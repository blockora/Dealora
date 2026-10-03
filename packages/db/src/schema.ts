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
  goalId: "goal_id",
  actorUserId: "actor_user_id",
  kind: "kind",
  fromStatus: "from_status",
  toStatus: "to_status",
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
  revenueGoalEvents: [
    `${COLUMN(revenueGoalEventTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(revenueGoalEventTable, COLUMNS.goalId)} NOT NULL`,
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
