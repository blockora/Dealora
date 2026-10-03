import { randomBytes, randomUUID } from "node:crypto";

import { AuthError } from "./types.js";
import type { Session, EntityId } from "./types.js";

/** In-memory session index keyed by token. Tests can seed an index. */
export interface SessionIndex {
  map: Map<string, Session>;
  userIndex: Map<EntityId, Set<string>>;
}

/** Factory for an empty, in-memory session index (tests seed this). */
export function createIndex(): SessionIndex {
  return { map: new Map(), userIndex: new Map() };
}

/** Create a session for a user in the given workspace. The workspace is
 *  validated server-side against the requesting user. */
export function createSession(
  userId: EntityId,
  workspaceId: EntityId,
  assignee: User,
  sessions: SessionIndex,
  authorize: (id: EntityId, userId: EntityId) => boolean,
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
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    createdAt: new Date().toISOString(),
  };
  sessions.map.set(token, session);
  const byUser = sessions.userIndex.get(userId) ?? new Set();
  byUser.add(token);
  sessions.userIndex.set(userId, byUser);
  return { token, session };
}

/** Return the session for a token, or null when the token is unknown. */
export function getSession(token: string, sessions: SessionIndex): Session | null {
  if (!token) return null;
  const found = sessions.map.get(token);
  if (!found) return null;
  return found;
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
 * Enforce that the signed-in user owns a workspace. Used by handlers for
 * write operations and by the business profile services.
 */
export function requireOwnership(
  ctx: AuthContext,
  workspaceId: EntityId,
  allowMemberRead: boolean,
  authorize: (workspaceId: EntityId, userId: EntityId) => boolean,
): void {
  if (!ctx.userId) {
    throw new AuthError({ code: "UNAUTHENTICATED", message: "authentication required" });
  }
  if (!authorize(workspaceId, ctx.userId)) {
    throw new AuthError({ code: "UNAUTHORIZED", message: "workspace access denied" });
  }
}
