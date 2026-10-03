import type {
  Account,
  AccountStatus,
  Contact,
  ContactStatus,
  EntityId,
  RecordSource,
} from "@dealora/db";
import type { Result } from "@dealora/core";

/**
 * @dealora/account — Account & Prospect Input (ROADMAP.md §12).
 *
 * Stores what the user provides: target accounts and the contacts at them.
 *
 * This package makes no claim about whether any of it is true. An imported
 * company name is not research, a contact email is not a verified person, and
 * nothing here is scored, ranked, enriched or researched. Verification belongs
 * to the Research and Evidence phases; qualification to the Qualification
 * phase; contact to the outreach phases.
 */

/** Domain error vocabulary, closed and safe to render. */
export type AccountErrorCode =
  "VALIDATION_ERROR" | "NOT_FOUND" | "UNAUTHORIZED" | "CONFLICT" | "UNAVAILABLE";

export interface AccountError {
  code: AccountErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export function accountError(
  code: AccountErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): AccountError {
  return details ? { code, message, details } : { code, message };
}

export type { Account, AccountStatus, Contact, ContactStatus, RecordSource };

/** What happened to one CSV row. */
export type ImportRowStatus = "created" | "updated" | "skipped" | "failed";

/** Per-row outcome. A row is never dropped silently. */
export interface ImportRowResult {
  /** 1-based row number in the source file, including the header. */
  row: number;
  status: ImportRowStatus;
  id?: string;
  /** Machine-readable reason, e.g. `duplicate`, `ambiguous_name`, `unknown_account`. */
  reason?: string;
  field?: string;
  message?: string;
}

/**
 * The outcome of one import.
 *
 * Row-level partial success is the documented policy: a bad row is reported
 * and skipped, and never affects the rows around it. `total` always equals
 * `created + updated + skipped + failed`.
 */
export interface CsvImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  results: ImportRowResult[];
}

/**
 * Storage the Account domain depends on.
 *
 * Declared as an interface so the domain is testable in isolation and a
 * different database driver can replace the JSON store without touching it.
 */
export interface AccountRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;

  createAccount(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    account: Omit<Account, "id" | "workspaceId" | "createdBy" | "createdAt" | "updatedAt">;
  }): Result<Account, { code: string }>;
  listAccounts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: AccountStatus; revenuePlanId?: EntityId },
  ): Result<Account[], { code: string }>;
  getAccount(id: EntityId, userId: EntityId): Result<Account, { code: string }>;
  updateAccount(
    id: EntityId,
    input: {
      userId: EntityId;
      patch: Partial<Omit<Account, "id" | "workspaceId" | "createdBy" | "createdAt">>;
    },
  ): Result<Account, { code: string }>;
  archiveAccount(id: EntityId, userId: EntityId): Result<Account, { code: string }>;
  findAccountByDomain(
    workspaceId: EntityId,
    userId: EntityId,
    domain: string,
  ): Result<Account | null, { code: string }>;
  findAccountByName(
    workspaceId: EntityId,
    userId: EntityId,
    name: string,
  ): Result<Account[], { code: string }>;

  createContact(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    contact: Omit<Contact, "id" | "workspaceId" | "createdBy" | "createdAt" | "updatedAt">;
  }): Result<Contact, { code: string }>;
  listContacts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId; status?: ContactStatus },
  ): Result<Contact[], { code: string }>;
  getContact(id: EntityId, userId: EntityId): Result<Contact, { code: string }>;
  updateContact(
    id: EntityId,
    input: {
      userId: EntityId;
      patch: Partial<Omit<Contact, "id" | "workspaceId" | "createdBy" | "createdAt">>;
    },
  ): Result<Contact, { code: string }>;
  archiveContact(id: EntityId, userId: EntityId): Result<Contact, { code: string }>;
  findContactByEmail(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    email: string,
  ): Result<Contact | null, { code: string }>;
}

/**
 * Reads a plan's workspace, so an account can be associated with a plan only
 * when both live in the same workspace.
 *
 * Narrow on purpose: the account domain must not depend on plan execution.
 */
export type PlanLinkReader = (
  revenuePlanId: EntityId,
  userId: EntityId,
) => Result<{ workspaceId: string }, { code: string }>;
