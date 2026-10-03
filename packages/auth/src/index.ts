/** @dealora/auth — identity, sessions, and server-side authentication. */
export type { User, UserRole, Session, AuthError, AuthContext } from "./types.js";
export {
  createSession,
  getSession,
  invalidateSession,
  listSessions,
  destroyAllSessionsForUser,
  verifySession,
  assertSignedIn,
  requireOwnership,
} from "./session.js";
export { signup, authenticate, changePassword, authenticatePassword } from "./credentials.js";
export { generateToken, generateId } from "./tokens.js";
