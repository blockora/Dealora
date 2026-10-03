/**
 * @dealora/account — Account & Prospect Input (ROADMAP.md §12).
 *
 * Stores target accounts and their contacts exactly as the user supplied them,
 * workspace-isolated, with deterministic deduplication and a safe CSV import.
 * Nothing here is researched, enriched, scored or verified.
 */
export { AccountService, ACCOUNT_CSV_COLUMNS, CONTACT_CSV_COLUMNS } from "./service.js";
export type { CreateAccountInput, CreateContactInput } from "./service.js";

export { accountError } from "./types.js";
export type {
  Account,
  AccountError,
  AccountErrorCode,
  AccountRepository,
  AccountStatus,
  Contact,
  ContactStatus,
  CsvImportResult,
  ImportRowResult,
  ImportRowStatus,
  PlanLinkReader,
  RecordSource,
} from "./types.js";

export {
  ACCOUNT_STATUSES,
  AccountIssues,
  CONTACT_STATUSES,
  LIMITS,
  RECORD_SOURCES,
  accountNameKey,
  accountStrongKey,
  buildFullName,
  contactStrongKey,
  isValidDomain,
  isValidEmail,
  normalizeDomain,
  normalizeEmail,
  normalizeText,
  normalizeUrl,
  validateAccount,
  validateContact,
} from "./validation.js";

export { normalizeHeader, parseCsv } from "./csv.js";
export type { ParsedCsv } from "./csv.js";

/**
 * Convenience factory wiring the Account service to the concrete repository.
 * Application code may construct the service with any {@link AccountRepository}
 * implementation, which keeps the domain decoupled from storage.
 */
export { createAccountService } from "./factory.js";
