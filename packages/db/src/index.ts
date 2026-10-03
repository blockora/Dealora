/** @dealora/db — schema, repository, and tenant-isolated persistence. */
export type {
  User,
  UserRole,
  Workspace,
  WorkspaceMember,
  BusinessProfile,
  EntityId,
  DateTime,
  ValidationError,
  ValidationSeverity,
  Offer,
  OfferStatus,
  OfferPricing,
  PricingModel,
  Icp,
  Persona,
  Positioning,
  BrandVoice,
  Claim,
  ClaimStatus,
  ClaimCategory,
} from "./types.js";
export { toDateTime } from "./types.js";

export {
  COLUMNS,
  SCHEMA,
  tables,
  indexes,
  userTable,
  workspaceTable,
  workspaceMembersTable,
  businessProfilesTable,
  offerTable,
  icpTable,
  personaTable,
  positioningTable,
  brandVoiceTable,
  claimTable,
  createTableSql,
  slugify,
  capString,
} from "./schema.js";

export {
  Store,
  store,
  db,
  newId,
  hashPassword,
  verifyPassword,
  DB_DIR,
  LATEST_SCHEMA_VERSION,
  emptyState,
  migrateState,
} from "./repository.js";
export type { StorageError, StorageErrorCode, DbState, CompleteDbState } from "./repository.js";
