import { hashPassword, store, verifyPassword } from "@dealora/db";
import type { User } from "@dealora/db";

import { AuthError } from "./types.js";
import type { EntityId } from "./types.js";
import { createIndex, createSession } from "./session.js";
import type { AuthorizeFn, SessionIndex } from "./session.js";

/**
 * Authentication service.
 *
 * - Passwords never leave the comparison in memory; only the scrypt-derived
 *   hash is persisted.
 * - The configured store handles user creation; sessions live in an
 *   injectable index so tests stay isolated.
 * - Tokens are unguessable and validated server-side.
 *
 * No credentials are hardcoded and no secret is read at module scope.
 */

/** Minimum accepted password length. */
export const MIN_PASSWORD_LENGTH = 12;

let sessions: SessionIndex = createIndex();

/** Swap the session index (tests inject an isolated index). */
export function setSessionIndex(index: SessionIndex): void {
  sessions = index;
}

/** Current session index, for verification and tests. */
export function getSessionIndex(): SessionIndex {
  return sessions;
}

/**
 * Default authorizer: a session may only be opened in a workspace the user
 * actually owns or is an accepted member of.
 */
const defaultAuthorize: AuthorizeFn = (workspaceId, userId) =>
  store.authorize(workspaceId, userId).ok;

export {
  createSession,
  createIndex,
  getSession,
  invalidateSession,
  listSessions,
  verifySession,
  assertSignedIn,
  requireOwnership,
} from "./session.js";

export function signup(
  email: string,
  password: string,
  displayName: string,
): { user: User; token: string } {
  const result = store.createUser({ email, password, displayName });
  if (!result.ok) {
    throw new AuthError(result.error.code, result.error.message);
  }
  const user = result.value;

  // A new user has no workspace yet, so the first session is issued against
  // the identity itself; workspace sessions are opened once a workspace
  // exists and can be authorized.
  const authorize: AuthorizeFn = (workspaceId, userId) =>
    workspaceId === userId ? userId === user.id : defaultAuthorize(workspaceId, userId);

  const { token } = createSession(user.id, user.id, user, sessions, authorize);
  return { user, token };
}

export function authenticate(email: string, password: string): { user: User; token: string } {
  const result = store.getUserByEmail(email);
  if (!result.ok) {
    throw new AuthError("UNAVAILABLE", "authentication service unavailable");
  }
  const user = result.value;
  if (!user || !verifyPassword(password, user.passwordHash)) {
    // One message for both "no such user" and "wrong password" so the
    // response cannot be used to enumerate accounts.
    throw new AuthError("UNAUTHENTICATED", "invalid credentials");
  }

  const authorize: AuthorizeFn = (workspaceId, userId) =>
    workspaceId === userId ? userId === user.id : defaultAuthorize(workspaceId, userId);

  const { token } = createSession(user.id, user.id, user, sessions, authorize);
  return { user, token };
}

export function authenticatePassword(email: string, password: string): boolean {
  const result = store.getUserByEmail(email);
  if (!result.ok) return false;
  const user = result.value;
  return user ? verifyPassword(password, user.passwordHash) : false;
}

/**
 * Rotate a password after verifying the current one.
 *
 * Only the derived hash is written; the plaintext never touches storage, and
 * every other session for the user is revoked.
 */
export function changePassword(
  userId: EntityId,
  currentPassword: string,
  newPassword: string,
): void {
  const result = store.getUser(userId);
  if (!result.ok) {
    throw new AuthError("NOT_FOUND", "user not found");
  }
  const user = result.value;
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    throw new AuthError("UNAUTHENTICATED", "invalid current password");
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError("INVALID", `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  store.updatePasswordHash(userId, hashPassword(newPassword));
}

export function currentUser(ctx: { userId: EntityId } | null): User | null {
  if (!ctx || !ctx.userId) return null;
  const result = store.getUser(ctx.userId);
  return result.ok ? result.value : null;
}
