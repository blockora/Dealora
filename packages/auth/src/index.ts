/** @dealora/auth — identity, sessions, and server-side authentication. */
export { AuthError } from "./types.js";
export type { AuthContext, AuthErrorCode, EntityId, Session, User, UserRole } from "./types.js";

export {
  createIndex,
  createSession,
  getSession,
  verifySession,
  invalidateSession,
  listSessions,
  destroyAllSessionsForUser,
  assertSignedIn,
  requireOwnership,
  SESSION_TTL_MS,
} from "./session.js";
export type { SessionIndex, AuthorizeFn } from "./session.js";

export {
  signup,
  authenticate,
  authenticatePassword,
  changePassword,
  currentUser,
  setSessionIndex,
  getSessionIndex,
  MIN_PASSWORD_LENGTH,
} from "./credentials.js";

export { generateToken, generateId } from "./tokens.js";
