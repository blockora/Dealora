/** @dealora/db — schema, repository, and tenant-isolated persistence. */
export type {
  User,
  Workspace,
  WorkspaceMember,
  BusinessProfile,
  EntityId,
  UserRole,
} from "./types.js";
export { userSchema, workspaceSchema, businessProfileSchema } from "./schema.js";
export { toDateTime } from "./schema.js";
export { Store, newId, hashPassword, verifyPassword } from "./repository.js";
export {
  createUser,
  getUser,
  getUserByEmail,
  listUsers,
  getWorkspaces,
  createWorkspace,
  getWorkspace,
  updateWorkspace,
  getBusinessProfile,
  createBusinessProfile,
  updateBusinessProfile,
  workspaceOwner,
  workspaceIsMember,
  resolveWorkspace,
  authorize,
  assertOwnsWorkspace,
} from "./repository.js";
