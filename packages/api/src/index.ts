/** @dealora/api — transport handlers and application service. */
export type { ApiError, ApiResponse, Pagination, RequestBody, ApiHandler } from "./types.js";
export {
  authenticateHandler,
  signupHandler,
  createWorkspaceHandler,
  getWorkspaceHandler,
  updateWorkspaceHandler,
  listWorkspacesHandler,
  createBusinessProfileHandler,
  getBusinessProfileHandler,
  updateBusinessProfileHandler,
  listBusinessProfilesHandler,
  authorizeHandler,
  meHandler,
} from "./handlers.js";
export {
  authenticate,
  signup,
  changePassword,
  authenticatePassword,
  setSessionIndex,
  createSession,
  getSession,
  invalidateSession,
  listSessions,
  verifySession,
  assertSignedIn,
  requireOwnership,
} from "@dealora/auth";
export { store, db } from "@dealora/db";
