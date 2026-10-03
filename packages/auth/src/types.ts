/** Secure session value returned to the client. */
export interface SessionToken {
  token: string;
  expiresAt: string;
}

/** Server-side session record. */
export interface Session {
  id: EntityId;
  userId: EntityId;
  workspaceId: EntityId;
  token: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Structured error returned to callers. Discriminated by `code` so handlers
 * can render user-safe messages without exposing internals. Exported as a
 * value so session/auth services can `throw` it directly.
 */
export class AuthError extends Error {
  constructor(
    public readonly code:
      "UNAUTHORIZED" | "UNAUTHENTICATED" | "NOT_FOUND" | "INVALID" | "CONFLICT" | "RATE_LIMITED",
    public readonly message: string,
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

/**
 * Build a typed AuthError from a discriminated union so handlers remain
 * strict and avoid accidental `any`/stringly-typed errors.
 */
export function authError(error: AuthError): AuthError {
  return new AuthError(error.code, error.message);
}
