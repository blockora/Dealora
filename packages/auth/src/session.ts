import { randomBytes, randomUUID } from "node:crypto";

import { AuthError } from "./types.js";
import type { AuthContext, EntityId, Session, User } from "./types.js";

/** In-memory session index keyed by token. Tests can seed an index. */
export interface SessionIndex {
  map: Map<string, Session>;
  userIndex: Map<EntityId, Set<string>>;
}

/** Factory for an empty, in-memory session index (tests seed this). */
export function createIndex(): SessionIndex {
  return { map: new Map(), userIndex: new Map() };
}

/** Session lifetime. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Authorizer callback supplied by the persistence layer.
 *
 * Returning `true` means the user may act in the workspace. The callback is
 * always the server-side store, never a client-supplied decision.
 */
export type AuthorizeFn = (workspaceId: EntityId, userId: EntityId) => boolean;

/**
 * Create a session for a user in the given workspace. The workspace is
 * validated server-side against the requesting user.
 */
export function createSession(
  userId: EntityId,
  workspaceId: EntityId,
  assignee: User,
  sessions: SessionIndex,
  authorize: AuthorizeFn,
): { token: string; session: Session } {
  if (!assignee || assignee.id !== userId) {
    throw new AuthError("UNAUTHENTICATED", "invalid session");
  }
  if (!authorize(workspaceId, userId)) {
    throw new AuthError("UNAUTHORIZED", "workspace access denied");
  }
  const token = randomBytes(32).toString("base64url");
  const session: Session = {
    id: randomUUID(),
    userId,
    workspaceId,
    token,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  };
  sessions.map.set(token, session);
  const byUser = sessions.userIndex.get(userId) ?? new Set<string>();
  byUser.add(token);
  sessions.userIndex.set(userId, byUser);
  return { token, session };
}

/** Return the session for a token, or null when the token is unknown. */
export function getSession(token: string, sessions: SessionIndex): Session | null {
  if (!token) return null;
  return sessions.map.get(token) ?? null;
}

/** Verify the token and return the session, or throw a typed auth error. */
export function verifySession(
  token: string,
  sessions: SessionIndex,
): { ok: true; session: Session; userId: EntityId } {
  const session = getSession(token, sessions);
  if (!session) {
    throw new AuthError("UNAUTHENTICATED", "session expired or missing");
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    sessions.map.delete(token);
    throw new AuthError("UNAUTHENTICATED", "session expired or missing");
  }
  return { ok: true, session, userId: session.userId };
}

/** Revoke a session carefully: remove from both indexes. */
export function invalidateSession(token: string, sessions: SessionIndex): boolean {
  if (!token) return false;
  const session = sessions.map.get(token);
  if (!session) return false;
  sessions.map.delete(token);
  const byUser = sessions.userIndex.get(session.userId);
  if (byUser) {
    byUser.delete(token);
    if (byUser.size === 0) sessions.userIndex.delete(session.userId);
  }
  return true;
}

/** List active sessions (useful for session management / audit). */
export function listSessions(sessions: SessionIndex): Session[] {
  return Array.from(sessions.map.values());
}

/** Invalidate every session a user holds. */
export function destroyAllSessionsForUser(userId: EntityId, sessions: SessionIndex): number {
  const tokens = sessions.userIndex.get(userId);
  if (!tokens) return 0;
  for (const token of tokens) {
    sessions.map.delete(token);
  }
  sessions.userIndex.delete(userId);
  return tokens.size;
}

/**
 * Application-level auth check. Throws typed errors so handlers can map them
 * to HTTP responses consistently.
 */
export function assertSignedIn(ctx: AuthContext | null): AuthContext {
  if (!ctx || !ctx.userId) {
    throw new AuthError("UNAUTHENTICATED", "authentication required");
  }
  return ctx;
}

/**
 * Enforce that the signed-in user may act in a workspace. Membership is
 * resolved through the injected server-side authorizer, so a caller cannot
 * assert its own access.
 */
export function requireOwnership(
  ctx: AuthContext,
  workspaceId: EntityId,
  authorize: AuthorizeFn,
): void {
  if (!ctx.userId) {
    throw new AuthError("UNAUTHENTICATED", "authentication required");
  }
  if (!authorize(workspaceId, ctx.userId)) {
    throw new AuthError("UNAUTHORIZED", "workspace access denied");
  }
}
