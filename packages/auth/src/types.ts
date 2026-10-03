import type { EntityId, User, UserRole } from "@dealora/db";

/** Secure session value returned to the client. */
export interface SessionToken {
  token: string;
  expiresAt: DateTimeString;
}

/** RFC 3339 timestamp. */
export type DateTimeString = string;

/** Server-side session record. */
export interface Session {
  id: EntityId;
  userId: EntityId;
  workspaceId: EntityId;
  token: string;
  expiresAt: string;
  createdAt: string;
}

/** Structured authentication failure codes. */
export type AuthErrorCode =
  | "UNAUTHORIZED"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "INVALID"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

/**
 * Structured error returned to callers. Discriminated by `code` so handlers
 * can render user-safe messages without exposing internals. Exported as a
 * value so session/auth services can `throw` it directly.
 */
export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Everything the application service needs to act on a request. */
export interface AuthContext {
  userId: EntityId;
  sessionToken: string;
  expiresAt: string;
  currentWorkspaceId: EntityId | null;
}

export type { EntityId, User, UserRole };
