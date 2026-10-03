/**
 * Core domain types for the DEALORA application foundation.
 *
 * These mirror the Phase 1 entities in ROADMAP.md §8 and stay deliberately
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

/** @internal Plumbing only; public consumers receive the types above. */
export interface Row<T extends object> {
  id: EntityId;
  createdAt: DateTime;
  updatedAt: DateTime;
  deletedAt: DateTime | null;
  _raw: T;
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

/** Minimal business profile the Phase 1 foundation must carry. */
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
