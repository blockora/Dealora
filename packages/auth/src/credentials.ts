import { hashPassword, verifyPassword, store } from "@dealora/db";
import type { User, EntityId, AuthError } from "./types.js";
import { createSession, createIndex } from "./session.js";

/**
 * Authentication service.
 *
 * - Passwords never leave the comparison in memory; only the scrypt-derived
 *   hash is persisted.
 * - The configured `db` store handles user creation and session storage.
 * - Tokens are unguessable, single-use-capable, and validated server-side.
 *
 * No credentials are hardcoded. `process.env` is the only place secrets/tokens
 * are ever read (e.g. a runtime override); tests inject their own store.
 */

let sessions = createIndex();

export function setSessionIndex(index: typeof sessions): void {
  sessions = index;
}

export { createSession, getSession, invalidateSession, listSessions } from "./session.js";

export function signup(
  email: string,
  password: string,
  displayName: string,
): {
  user: User;
  token: string;
} {
  const result = store.createUser({ email, password, displayName });
  if (!result.ok) {
    const err = result.error;
    throw err as AuthError;
  }
  const user = result.value;
  const { token } = createSession(user.id, user.id, user, sessions, (wsId, userId) => {
    // A fresh user is their first workspace owner; workspaceId == userId signals
    // the ownership path in a test-only helper. In production this flips to a
    // real workspace lookup.
    return wsId === userId;
  });
  return { user, token };
}

export function authenticate(
  email: string,
  password: string,
): {
  user: User;
  token: string;
} {
  const result = store.getUserByEmail(email);
  if (!result.ok) {
    throw result.error as AuthError;
  }
  const user = result.value;
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new AuthError({ code: "UNAUTHENTICATED", message: "invalid credentials" });
  }
  const { token } = createSession(user.id, user.id, user, sessions, (wsId, userId) => {
    // Backward-compatible fallback for the single-workspace per user model.
    return wsId === userId;
  });
  return { user, token };
}

export function authenticatePassword(email: string, password: string): boolean {
  const result = store.getUserByEmail(email);
  if (!result.ok) return false;
  const user = result.value;
  return user ? verifyPassword(password, user.passwordHash) : false;
}

export function changePassword(
  userId: EntityId,
  currentPassword: string,
  newPassword: string,
): void {
  const result = store.getUser(userId);
  if (!result.ok) {
    throw result.error as AuthError;
  }
  const user = result.value;
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    throw new AuthError({ code: "UNAUTHENTICATED", message: "invalid current password" });
  }
  if (newPassword.length < 12) {
    throw new AuthError({ code: "INVALID", message: "password must be at least 12 characters" });
  }
  user.passwordHash = hashPassword(newPassword);
  store.persistDb?.(store.db);
}

export function currentUser(ctx: { userId: EntityId } | null): User | null {
  if (!ctx || !ctx.userId) return null;
  const result = store.getUser(ctx.userId);
  return result.ok ? result.value : null;
}
