/**
 * Phase 1 schema.
 *
 * The goal is a schema that can evolve without destructive redesign: every
 * table uses an `id` primary key, UTC `created_at`/`updated_at` instants, and
 * a `deleted_at` tombstone. Deleted rows stay isolated by `tenant_id` and are
 * never returned by default queries.
 *
 * Relations:
 *   User 1 -- * Workspace
 *   User 1 -- * WorkspaceMember (membership)
 *   Workspace 1 -- 1 BusinessProfile
 *
 * No other tables exist yet: ROADMAP.md §8 explicitly says "Not every entity
 * needs full functionality in Phase 1".
 */

export function toDateTime(now: Date): string {
  return now.toISOString();
}

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
  createdAt: "created_at",
  updatedAt: "updated_at",
  deletedAt: "deleted_at",
  invitedAt: "invited_at",
  acceptedAt: "accepted_at",
} as const satisfies { [K in keyof typeof COLUMNS]: string };

/** Table: users. */
export const userTable = "users" as const;

/** Table: workspaces (the tenant boundary). */
export const workspaceTable = "workspaces" as const;

/** Table: workspace members (membership + ownership). */
export const workspaceMembersTable = "workspace_members" as const;

/** Table: business profiles, one per workspace. */
export const businessProfilesTable = "business_profiles" as const;

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
};

function COLUMN(table: string, column: string): string {
  return `"${table}"."${column}"`;
}

/** SQL DDL for a single table (PostgreSQL-compatible dialect). */
export function createTableSql(
  table: string,
  columns: readonly string[],
  primaryKey: string,
): string {
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (${primaryKey},`,
    ...columns.map((c) => `  ${c}`),
    `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     deleted_at TIMESTAMPTZ`,
    `);`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_deleted ON "${table}"(${COLUMN(table, "deleted_at")}) WHERE "deleted_at" IS NULL;`,
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
    `${COLUMN(workspaceMembersTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMN(workspaceTable, COLUMNS.id)}") ON DELETE CASCADE,
${COLUMN(workspaceMembersTable, COLUMNS.userId)} REFERENCES "${userTable}"("${COLUMN(userTable, COLUMNS.id)}") ON DELETE CASCADE,
PRIMARY KEY ("${COLUMN(workspaceMembersTable, COLUMNS.workspaceId)}", "${COLUMN(workspaceMembersTable, COLUMNS.userId)}")`,
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
    ],
    `${COLUMN(businessProfilesTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(businessProfilesTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMN(workspaceTable, COLUMNS.id)}") ON DELETE CASCADE,
${COLUMN(businessProfilesTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMN(userTable, COLUMNS.id)}") ON DELETE CASCADE,
UNIQUE("${COLUMN(businessProfilesTable, COLUMNS.workspaceId)}")`,
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
