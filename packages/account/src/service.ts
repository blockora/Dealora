import type { Result } from "@dealora/core";
import { err, ok } from "@dealora/core";
import type {
  Account,
  AccountStatus,
  Contact,
  ContactStatus,
  EntityId,
  RecordSource,
} from "@dealora/db";

import { parseCsv } from "./csv.js";
import { accountError } from "./types.js";
import type {
  AccountError,
  AccountRepository,
  CsvImportResult,
  ImportRowResult,
  PlanLinkReader,
} from "./types.js";
import {
  ACCOUNT_STATUSES,
  CONTACT_STATUSES,
  buildFullName,
  normalizeDomain,
  normalizeEmail,
  normalizeText,
  normalizeUrl,
  validateAccount,
  validateContact,
} from "./validation.js";

export * from "./types.js";
export * from "./validation.js";
export { normalizeHeader, parseCsv } from "./csv.js";
export type { ParsedCsv } from "./csv.js";

/** Supported CSV columns, documented in `docs/csv-import.md`. */
export const ACCOUNT_CSV_COLUMNS = [
  "name",
  "website",
  "domain",
  "industry",
  "company_size",
  "geography",
  "description",
  "revenue_plan_id",
  "source_reference",
] as const;

export const CONTACT_CSV_COLUMNS = [
  "account",
  "first_name",
  "last_name",
  "job_title",
  "email",
  "phone",
  "profile_url",
  "source_reference",
] as const;

function fromStorage(code: string, fallback: string): AccountError {
  switch (code) {
    case "NOT_FOUND":
      return accountError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return accountError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return accountError("CONFLICT", fallback);
    case "INVALID":
      return accountError("VALIDATION_ERROR", fallback);
    default:
      return accountError("UNAVAILABLE", "storage unavailable");
  }
}

/** Untrusted account input: every field may be absent or of any type. */
export interface CreateAccountInput {
  name?: unknown;
  website?: unknown;
  domain?: unknown;
  industry?: unknown;
  companySize?: unknown;
  geography?: unknown;
  description?: unknown;
  source?: unknown;
  sourceReference?: unknown;
  revenuePlanId?: unknown;
}

/** Untrusted contact input. */
export interface CreateContactInput {
  accountId?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  jobTitle?: unknown;
  email?: unknown;
  phone?: unknown;
  profileUrl?: unknown;
  source?: unknown;
  sourceReference?: unknown;
}

/** Trim and collapse whitespace; null when the value is absent or not a string. */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = normalizeText(value);
  return trimmed === "" ? null : trimmed;
}

/** The raw string behind a value, or "" — used to tell "absent" from "invalid". */
function present(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Build an {@link ImportRowResult} without ever setting an optional key to
 * `undefined`, which `exactOptionalPropertyTypes` forbids.
 */
function rowResult(
  row: number,
  status: ImportRowResult["status"],
  extra: {
    reason?: string | undefined;
    id?: string | undefined;
    field?: string | undefined;
    message?: string | undefined;
  } = {},
): ImportRowResult {
  const out: ImportRowResult = { row, status };
  if (extra.reason !== undefined) out.reason = extra.reason;
  if (extra.id !== undefined) out.id = extra.id;
  if (extra.field !== undefined) out.field = extra.field;
  if (extra.message !== undefined) out.message = extra.message;
  return out;
}

/** Roll per-row results into the counters the API returns. */
function summarize(results: ImportRowResult[]): CsvImportResult {
  const count = (status: ImportRowResult["status"]): number =>
    results.filter((r) => r.status === status).length;
  return {
    total: results.length,
    created: count("created"),
    updated: count("updated"),
    skipped: count("skipped"),
    failed: count("failed"),
    results,
  };
}

/**
 * The Account & Prospect Input application service.
 *
 * Responsibilities:
 * - Resolve authorization from the authenticated identity on every call.
 * - Validate and normalize user-supplied records.
 * - Apply the deterministic duplicate policy.
 * - Keep accounts and contacts inside one workspace.
 * - Import CSV with row-level results, never silently dropping a row.
 *
 * It never researches, enriches, scores or verifies anything: every field it
 * stores is a field the user supplied.
 */
export class AccountService {
  constructor(
    private readonly repo: AccountRepository,
    private readonly plans: PlanLinkReader,
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, AccountError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(accountError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(accountError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * Validate an optional RevenuePlan association.
   *
   * The plan is looked up through the caller's own authorization, so a plan id
   * belonging to another workspace does not resolve for them.
   */
  private validatePlanLink(
    workspaceId: EntityId,
    userId: EntityId,
    revenuePlanId: unknown,
  ): Result<EntityId | null, AccountError> {
    if (revenuePlanId === undefined || revenuePlanId === null || revenuePlanId === "") {
      return ok(null);
    }
    if (typeof revenuePlanId !== "string") {
      return err(
        accountError("VALIDATION_ERROR", "revenuePlanId must be a plan id", [
          { field: "revenuePlanId", message: "revenuePlanId must be a string" },
        ]),
      );
    }
    const plan = this.plans(revenuePlanId, userId);
    if (!plan.ok) {
      return err(
        accountError("NOT_FOUND", "revenue plan not found", [
          { field: "revenuePlanId", message: "the plan does not exist" },
        ]),
      );
    }
    if (plan.value.workspaceId !== workspaceId) {
      return err(accountError("UNAUTHORIZED", "workspace access denied"));
    }
    return ok(revenuePlanId);
  }

  // --- Accounts ---------------------------------------------------------

  /**
   * Create an account manually.
   *
   * A duplicate is reported as a conflict rather than merged: a manual create
   * is a deliberate act, and silently updating a different record would hide
   * it from the user.
   */
  createAccount(
    workspaceId: EntityId,
    userId: EntityId,
    input: CreateAccountInput,
  ): Result<Account, AccountError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const name = str(input.name);
    const rawWebsite = present(input.website);
    const rawDomain = present(input.domain);
    const website = rawWebsite !== null ? normalizeUrl(rawWebsite) : null;
    const domain =
      (rawDomain !== null ? normalizeDomain(rawDomain) : null) ??
      (rawWebsite !== null ? normalizeDomain(rawWebsite) : null);

    const invalid = validateAccount({
      name,
      website: rawWebsite,
      domain: rawDomain,
      industry: str(input.industry),
      companySize: str(input.companySize),
      geography: str(input.geography),
      description: str(input.description),
      source: input.source ?? "manual",
      sourceReference: str(input.sourceReference),
    });
    if (invalid) return err(invalid);

    const link = this.validatePlanLink(workspaceId, userId, input.revenuePlanId);
    if (!link.ok) return link;

    if (domain !== null) {
      const existing = this.repo.findAccountByDomain(workspaceId, userId, domain);
      if (!existing.ok) return err(fromStorage(existing.error.code, "account lookup failed"));
      if (existing.value !== null) {
        return err(
          accountError("CONFLICT", "an account with this domain already exists in this workspace", [
            { field: "domain", message: `already used by account ${existing.value.id}` },
          ]),
        );
      }
    }

    const created = this.repo.createAccount({
      workspaceId,
      createdBy: userId,
      account: {
        name: name ?? "",
        website,
        domain,
        industry: str(input.industry),
        companySize: str(input.companySize),
        geography: str(input.geography),
        description: str(input.description),
        source: (input.source ?? "manual") as RecordSource,
        sourceReference: str(input.sourceReference),
        revenuePlanId: link.value,
        status: "active",
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "account creation failed"));
    return ok(created.value);
  }

  getAccount(id: EntityId, userId: EntityId): Result<Account, AccountError> {
    if (!id || typeof id !== "string") {
      return err(accountError("VALIDATION_ERROR", "account id is required"));
    }
    const account = this.repo.getAccount(id, userId);
    if (!account.ok) return err(fromStorage(account.error.code, "account not found"));
    return ok(account.value);
  }

  listAccounts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: AccountStatus; revenuePlanId?: EntityId },
  ): Result<Account[], AccountError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.status !== undefined && !ACCOUNT_STATUSES.includes(filter.status)) {
      return err(
        accountError("VALIDATION_ERROR", "invalid status filter", [
          { field: "status", message: `status must be one of: ${ACCOUNT_STATUSES.join(", ")}` },
        ]),
      );
    }
    const accounts = this.repo.listAccounts(workspaceId, userId, filter);
    if (!accounts.ok) return err(fromStorage(accounts.error.code, "accounts unavailable"));
    return ok(accounts.value);
  }

  /**
   * Accounts a plan targeted, answering "what did this plan target?".
   *
   * The plan is resolved through the same reader used to validate an
   * association, so listing and associating cannot disagree about who may see
   * a plan. The account domain never depends on plan execution.
   */
  listAccountsForPlan(revenuePlanId: EntityId, userId: EntityId): Result<Account[], AccountError> {
    if (!revenuePlanId || typeof revenuePlanId !== "string") {
      return err(accountError("VALIDATION_ERROR", "plan id is required"));
    }
    const plan = this.plans(revenuePlanId, userId);
    if (!plan.ok) return err(fromStorage(plan.error.code, "revenue plan not found"));
    const accounts = this.repo.listAccounts(plan.value.workspaceId, userId, {
      revenuePlanId,
    });
    if (!accounts.ok) return err(fromStorage(accounts.error.code, "accounts unavailable"));
    return ok(accounts.value);
  }

  updateAccount(
    id: EntityId,
    userId: EntityId,
    patch: CreateAccountInput,
  ): Result<Account, AccountError> {
    if (!id || typeof id !== "string") {
      return err(accountError("VALIDATION_ERROR", "account id is required"));
    }
    const existing = this.repo.getAccount(id, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "account not found"));
    if (existing.value.status === "archived") {
      return err(
        accountError("CONFLICT", "an archived account cannot be edited", [
          { field: "status", message: "the account is archived" },
        ]),
      );
    }

    const website =
      patch.website === undefined
        ? existing.value.website
        : present(patch.website) !== null
          ? normalizeUrl(present(patch.website) ?? "")
          : null;
    const domain =
      patch.domain === undefined
        ? existing.value.domain
        : present(patch.domain) !== null
          ? normalizeDomain(present(patch.domain) ?? "")
          : null;

    const merged = {
      name: patch.name === undefined ? existing.value.name : str(patch.name),
      website: present(patch.website) ?? website,
      domain: present(patch.domain) ?? domain,
      industry: patch.industry === undefined ? existing.value.industry : str(patch.industry),
      companySize:
        patch.companySize === undefined ? existing.value.companySize : str(patch.companySize),
      geography: patch.geography === undefined ? existing.value.geography : str(patch.geography),
      description:
        patch.description === undefined ? existing.value.description : str(patch.description),
      source: patch.source === undefined ? existing.value.source : patch.source,
      sourceReference:
        patch.sourceReference === undefined
          ? existing.value.sourceReference
          : str(patch.sourceReference),
    };
    const invalid = validateAccount(merged);
    if (invalid) return err(invalid);

    const link: Result<EntityId | null, AccountError> =
      patch.revenuePlanId === undefined
        ? ok(existing.value.revenuePlanId)
        : this.validatePlanLink(existing.value.workspaceId, userId, patch.revenuePlanId);
    if (!link.ok) return link;

    // Re-check the duplicate domain when an edit could collide with another row.
    if (merged.domain !== null && merged.domain !== existing.value.domain) {
      const duplicate = this.repo.findAccountByDomain(
        existing.value.workspaceId,
        userId,
        merged.domain,
      );
      if (!duplicate.ok) return err(fromStorage(duplicate.error.code, "account lookup failed"));
      if (duplicate.value !== null) {
        return err(
          accountError("CONFLICT", "another account in this workspace already uses this domain", [
            { field: "domain", message: `already used by account ${duplicate.value.id}` },
          ]),
        );
      }
    }

    const updatePatch: Partial<Omit<Account, "id" | "workspaceId" | "createdBy" | "createdAt">> = {
      name: merged.name ?? existing.value.name,
      website: merged.website,
      domain: merged.domain,
      industry: merged.industry,
      companySize: merged.companySize,
      geography: merged.geography,
      description: merged.description,
      revenuePlanId: link.value,
    };
    if (patch.source !== undefined) updatePatch.source = merged.source as RecordSource;
    if (patch.sourceReference !== undefined) {
      updatePatch.sourceReference = str(patch.sourceReference);
    }

    const updated = this.repo.updateAccount(id, { userId, patch: updatePatch });
    if (!updated.ok) return err(fromStorage(updated.error.code, "account update failed"));
    return ok(updated.value);
  }

  /** Archive an account. Its active contacts are archived with it. */
  archiveAccount(id: EntityId, userId: EntityId): Result<Account, AccountError> {
    if (!id || typeof id !== "string") {
      return err(accountError("VALIDATION_ERROR", "account id is required"));
    }
    const existing = this.repo.getAccount(id, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "account not found"));
    if (existing.value.status === "archived") {
      return err(accountError("CONFLICT", "the account is already archived"));
    }
    const archived = this.repo.archiveAccount(id, userId);
    if (!archived.ok) return err(fromStorage(archived.error.code, "account archive failed"));
    return ok(archived.value);
  }

  // --- Contacts ---------------------------------------------------------

  createContact(
    workspaceId: EntityId,
    userId: EntityId,
    input: CreateContactInput,
  ): Result<Contact, AccountError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const accountId = str(input.accountId);
    const email = present(input.email) !== null ? normalizeEmail(present(input.email) ?? "") : null;
    const firstName = str(input.firstName);
    const lastName = str(input.lastName);

    const invalid = validateContact({
      accountId,
      firstName,
      lastName,
      jobTitle: str(input.jobTitle),
      // The raw values are validated, not the normalized ones: a value that
      // cannot be normalized must be reported, never quietly dropped.
      email: present(input.email),
      phone: str(input.phone),
      profileUrl: present(input.profileUrl),
      source: input.source ?? "manual",
      sourceReference: str(input.sourceReference),
    });
    if (invalid) return err(invalid);

    if (accountId === null) {
      return err(
        accountError("VALIDATION_ERROR", "a contact must belong to an account", [
          { field: "accountId", message: "accountId is required" },
        ]),
      );
    }

    const account = this.repo.getAccount(accountId, userId);
    if (!account.ok) {
      return err(
        accountError("NOT_FOUND", "account not found", [
          { field: "accountId", message: "the account does not exist in this workspace" },
        ]),
      );
    }
    // Belt and braces: a contact may never sit on another workspace's account.
    if (account.value.workspaceId !== workspaceId) {
      return err(accountError("UNAUTHORIZED", "workspace access denied"));
    }
    if (account.value.status === "archived") {
      return err(
        accountError("CONFLICT", "an archived account cannot take new contacts", [
          { field: "accountId", message: "the account is archived" },
        ]),
      );
    }

    if (email !== null) {
      const duplicate = this.repo.findContactByEmail(workspaceId, userId, accountId, email);
      if (!duplicate.ok) return err(fromStorage(duplicate.error.code, "contact lookup failed"));
      if (duplicate.value !== null) {
        return err(
          accountError("CONFLICT", "this email already exists on the account", [
            { field: "email", message: `already used by contact ${duplicate.value.id}` },
          ]),
        );
      }
    }

    const created = this.repo.createContact({
      workspaceId,
      createdBy: userId,
      contact: {
        accountId,
        firstName,
        lastName,
        fullName: buildFullName(firstName, lastName),
        jobTitle: str(input.jobTitle),
        email,
        phone: str(input.phone),
        profileUrl:
          present(input.profileUrl) !== null ? normalizeUrl(present(input.profileUrl) ?? "") : null,
        source: (input.source ?? "manual") as RecordSource,
        sourceReference: str(input.sourceReference),
        status: "active",
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "contact creation failed"));
    return ok(created.value);
  }

  getContact(id: EntityId, userId: EntityId): Result<Contact, AccountError> {
    if (!id || typeof id !== "string") {
      return err(accountError("VALIDATION_ERROR", "contact id is required"));
    }
    const contact = this.repo.getContact(id, userId);
    if (!contact.ok) return err(fromStorage(contact.error.code, "contact not found"));
    return ok(contact.value);
  }

  listContacts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId; status?: ContactStatus },
  ): Result<Contact[], AccountError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.status !== undefined && !CONTACT_STATUSES.includes(filter.status)) {
      return err(
        accountError("VALIDATION_ERROR", "invalid status filter", [
          { field: "status", message: `status must be one of: ${CONTACT_STATUSES.join(", ")}` },
        ]),
      );
    }
    const contacts = this.repo.listContacts(workspaceId, userId, filter);
    if (!contacts.ok) return err(fromStorage(contacts.error.code, "contacts unavailable"));
    return ok(contacts.value);
  }

  /** Contacts at one account. */
  listContactsForAccount(accountId: EntityId, userId: EntityId): Result<Contact[], AccountError> {
    if (!accountId || typeof accountId !== "string") {
      return err(accountError("VALIDATION_ERROR", "account id is required"));
    }
    const account = this.repo.getAccount(accountId, userId);
    if (!account.ok) return err(fromStorage(account.error.code, "account not found"));
    const contacts = this.repo.listContacts(account.value.workspaceId, userId, {
      accountId: account.value.id,
    });
    if (!contacts.ok) return err(fromStorage(contacts.error.code, "contacts unavailable"));
    return ok(contacts.value);
  }

  updateContact(
    id: EntityId,
    userId: EntityId,
    patch: CreateContactInput,
  ): Result<Contact, AccountError> {
    if (!id || typeof id !== "string") {
      return err(accountError("VALIDATION_ERROR", "contact id is required"));
    }
    const existing = this.repo.getContact(id, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "contact not found"));
    if (existing.value.status === "archived") {
      return err(
        accountError("CONFLICT", "an archived contact cannot be edited", [
          { field: "status", message: "the contact is archived" },
        ]),
      );
    }

    const firstName =
      patch.firstName === undefined ? existing.value.firstName : str(patch.firstName);
    const lastName = patch.lastName === undefined ? existing.value.lastName : str(patch.lastName);
    const email =
      patch.email === undefined
        ? existing.value.email
        : present(patch.email) !== null
          ? normalizeEmail(present(patch.email) ?? "")
          : null;

    const invalid = validateContact({
      accountId: existing.value.accountId,
      firstName,
      lastName,
      jobTitle: patch.jobTitle === undefined ? existing.value.jobTitle : str(patch.jobTitle),
      email: patch.email === undefined ? existing.value.email : present(patch.email),
      phone: patch.phone === undefined ? existing.value.phone : str(patch.phone),
      profileUrl:
        patch.profileUrl === undefined ? existing.value.profileUrl : present(patch.profileUrl),
      source: patch.source === undefined ? existing.value.source : patch.source,
      sourceReference:
        patch.sourceReference === undefined
          ? existing.value.sourceReference
          : str(patch.sourceReference),
    });
    if (invalid) return err(invalid);

    if (email !== null && email !== existing.value.email) {
      const duplicate = this.repo.findContactByEmail(
        existing.value.workspaceId,
        userId,
        existing.value.accountId,
        email,
      );
      if (!duplicate.ok) return err(fromStorage(duplicate.error.code, "contact lookup failed"));
      if (duplicate.value !== null) {
        return err(
          accountError("CONFLICT", "this email already exists on the account", [
            { field: "email", message: `already used by contact ${duplicate.value.id}` },
          ]),
        );
      }
    }

    const updatePatch: Partial<Omit<Contact, "id" | "workspaceId" | "createdBy" | "createdAt">> = {
      firstName,
      lastName,
      fullName: buildFullName(firstName, lastName),
      jobTitle: patch.jobTitle === undefined ? existing.value.jobTitle : str(patch.jobTitle),
      email,
      phone: patch.phone === undefined ? existing.value.phone : str(patch.phone),
      profileUrl:
        patch.profileUrl === undefined
          ? existing.value.profileUrl
          : present(patch.profileUrl) !== null
            ? normalizeUrl(present(patch.profileUrl) ?? "")
            : null,
    };
    if (patch.source !== undefined) updatePatch.source = patch.source as RecordSource;
    if (patch.sourceReference !== undefined) {
      updatePatch.sourceReference = str(patch.sourceReference);
    }

    const updated = this.repo.updateContact(id, { userId, patch: updatePatch });
    if (!updated.ok) return err(fromStorage(updated.error.code, "contact update failed"));
    return ok(updated.value);
  }

  archiveContact(id: EntityId, userId: EntityId): Result<Contact, AccountError> {
    if (!id || typeof id !== "string") {
      return err(accountError("VALIDATION_ERROR", "contact id is required"));
    }
    const existing = this.repo.getContact(id, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "contact not found"));
    if (existing.value.status === "archived") {
      return err(accountError("CONFLICT", "the contact is already archived"));
    }
    const archived = this.repo.archiveContact(id, userId);
    if (!archived.ok) return err(fromStorage(archived.error.code, "contact archive failed"));
    return ok(archived.value);
  }

  // --- CSV import -------------------------------------------------------

  /**
   * Import accounts from CSV.
   *
   * Policy: **row-level partial success**. Every row is validated and
   * persisted independently, so a bad row is reported and skipped while the
   * rows around it still land. Nothing is dropped silently, and `total` always
   * equals `created + updated + skipped + failed`.
   *
   * Duplicate policy: an identical normalized domain updates the existing
   * record; a name collision with a different domain is reported as
   * `ambiguous_name` and **both records are preserved** — an unverified name
   * match is never treated as proof that two companies are the same.
   */
  importAccountsCsv(
    workspaceId: EntityId,
    userId: EntityId,
    csv: string,
    options?: { sourceReference?: string; revenuePlanId?: string },
  ): Result<CsvImportResult, AccountError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    if (typeof csv !== "string" || csv.trim() === "") {
      return err(
        accountError("VALIDATION_ERROR", "csv is required", [
          { field: "csv", message: "csv must be a non-empty string" },
        ]),
      );
    }

    const parsed = parseCsv(csv);
    const results: ImportRowResult[] = parsed.malformed.map((m) =>
      rowResult(m.line, "failed", { reason: "malformed_row", message: m.message }),
    );

    if (parsed.header.length === 0) {
      return err(
        accountError("VALIDATION_ERROR", "the csv has no header row", [
          { field: "csv", message: "a header row is required" },
        ]),
      );
    }
    if (!parsed.header.includes("name")) {
      return err(
        accountError("VALIDATION_ERROR", "the csv must have a name column", [
          { field: "csv", message: `supported columns: ${ACCOUNT_CSV_COLUMNS.join(", ")}` },
        ]),
      );
    }

    // A plan association given for the whole import is validated once, up front.
    let planId: string | null = null;
    if (options?.revenuePlanId !== undefined) {
      const link = this.validatePlanLink(workspaceId, userId, options.revenuePlanId);
      if (!link.ok) return link;
      planId = link.value;
    }

    // Rows processed in this file, so a domain repeated inside one upload is
    // deduplicated rather than creating two rows.
    const seenDomains = new Map<string, string>();

    for (const row of parsed.rows) {
      const name = str(row.cells.name);
      const rawWebsite = str(row.cells.website);
      const rawDomain = str(row.cells.domain);
      const website = rawWebsite !== null ? normalizeUrl(rawWebsite) : null;
      const domain =
        (rawDomain !== null ? normalizeDomain(rawDomain) : null) ??
        (rawWebsite !== null ? normalizeDomain(rawWebsite) : null);

      const invalid = validateAccount({
        name,
        website: rawWebsite,
        domain: rawDomain,
        industry: str(row.cells.industry),
        companySize: str(row.cells.company_size),
        geography: str(row.cells.geography),
        description: str(row.cells.description),
        source: "csv",
      });
      if (invalid) {
        results.push(
          rowResult(row.line, "failed", {
            reason: "invalid",
            field: invalid.details?.[0]?.field,
            message: invalid.details?.[0]?.message ?? invalid.message,
          }),
        );
        continue;
      }

      let rowPlanId = planId;
      if (rowPlanId === null) {
        const requested = str(row.cells.revenue_plan_id);
        if (requested !== null) {
          const link = this.validatePlanLink(workspaceId, userId, requested);
          if (!link.ok) {
            results.push(
              rowResult(row.line, "failed", {
                reason: "invalid_plan_reference",
                field: "revenue_plan_id",
                message: link.error.message,
              }),
            );
            continue;
          }
          rowPlanId = link.value;
        }
      }

      // --- duplicate policy ---
      if (domain !== null && seenDomains.has(domain)) {
        results.push(
          rowResult(row.line, "skipped", {
            reason: "duplicate_in_file",
            id: seenDomains.get(domain),
            message: "an earlier row in this file already used this domain",
          }),
        );
        continue;
      }

      let existing: Account | null = null;
      if (domain !== null) {
        const found = this.repo.findAccountByDomain(workspaceId, userId, domain);
        if (!found.ok) {
          results.push(
            rowResult(row.line, "failed", {
              reason: "storage_error",
              message: "the account could not be looked up",
            }),
          );
          continue;
        }
        existing = found.value;
      }

      if (existing !== null) {
        // Same domain: a re-import refreshes rather than duplicating. Only
        // fields the file actually supplied are touched.
        const patch: Partial<Omit<Account, "id" | "workspaceId" | "createdBy" | "createdAt">> = {};
        if (row.cells.industry) patch.industry = str(row.cells.industry);
        if (row.cells.company_size) patch.companySize = str(row.cells.company_size);
        if (row.cells.geography) patch.geography = str(row.cells.geography);
        if (row.cells.description) patch.description = str(row.cells.description);
        if (website !== null) patch.website = website;
        if (row.cells.source_reference !== undefined) {
          patch.sourceReference = options?.sourceReference ?? str(row.cells.source_reference);
        }
        if (rowPlanId !== null) patch.revenuePlanId = rowPlanId;
        const updated = this.repo.updateAccount(existing.id, { userId, patch });
        if (!updated.ok) {
          results.push(
            rowResult(row.line, "failed", {
              reason: "storage_error",
              id: existing.id,
              message: "the existing account could not be updated",
            }),
          );
          continue;
        }
        seenDomains.set(domain ?? "", existing.id);
        results.push(rowResult(row.line, "updated", { id: existing.id }));
        continue;
      }

      // No domain match. A shared name is ambiguous, not a duplicate.
      const nameMatches = this.repo.findAccountByName(workspaceId, userId, name ?? "");
      if (nameMatches.ok && nameMatches.value.length > 0) {
        results.push(
          rowResult(row.line, "skipped", {
            reason: "ambiguous_name",
            id: nameMatches.value[0]?.id,
            message:
              "an account with this name exists but has a different or no domain; both records are kept",
          }),
        );
        continue;
      }

      const created = this.repo.createAccount({
        workspaceId,
        createdBy: userId,
        account: {
          name: name ?? "",
          website,
          domain,
          industry: str(row.cells.industry),
          companySize: str(row.cells.company_size),
          geography: str(row.cells.geography),
          description: str(row.cells.description),
          source: "csv",
          sourceReference: options?.sourceReference ?? str(row.cells.source_reference),
          revenuePlanId: rowPlanId,
          status: "active",
        },
      });
      if (!created.ok) {
        results.push(
          rowResult(row.line, "failed", {
            reason: "storage_error",
            message: "the account could not be created",
          }),
        );
        continue;
      }
      if (domain !== null) seenDomains.set(domain, created.value.id);
      results.push(rowResult(row.line, "created", { id: created.value.id }));
    }

    return ok(summarize(results));
  }

  /**
   * Import contacts from CSV.
   *
   * The `account` column holds the account's id, or its name when that name is
   * unique in this workspace. A reference that cannot be resolved to an
   * account in this workspace fails that row only — it can never reach another
   * tenant.
   */
  importContactsCsv(
    workspaceId: EntityId,
    userId: EntityId,
    csv: string,
    options?: { sourceReference?: string },
  ): Result<CsvImportResult, AccountError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    if (typeof csv !== "string" || csv.trim() === "") {
      return err(
        accountError("VALIDATION_ERROR", "csv is required", [
          { field: "csv", message: "csv must be a non-empty string" },
        ]),
      );
    }

    const parsed = parseCsv(csv);
    const results: ImportRowResult[] = parsed.malformed.map((m) =>
      rowResult(m.line, "failed", { reason: "malformed_row", message: m.message }),
    );

    if (parsed.header.length === 0) {
      return err(
        accountError("VALIDATION_ERROR", "the csv has no header row", [
          { field: "csv", message: "a header row is required" },
        ]),
      );
    }
    if (!parsed.header.includes("account")) {
      return err(
        accountError("VALIDATION_ERROR", "the csv must have an account column", [
          { field: "csv", message: `supported columns: ${CONTACT_CSV_COLUMNS.join(", ")}` },
        ]),
      );
    }

    const seen = new Set<string>();

    for (const row of parsed.rows) {
      const accountRef = str(row.cells.account);
      if (accountRef === null) {
        results.push(
          rowResult(row.line, "failed", {
            reason: "missing_account_reference",
            field: "account",
            message: "every contact row must name its account",
          }),
        );
        continue;
      }

      const account = this.resolveAccountRef(workspaceId, userId, accountRef);
      if (account === null) {
        results.push(
          rowResult(row.line, "failed", {
            reason: "unknown_account",
            field: "account",
            message: "no account in this workspace matches that reference",
          }),
        );
        continue;
      }
      if (account.status === "archived") {
        results.push(
          rowResult(row.line, "skipped", {
            reason: "archived_account",
            id: account.id,
            message: "the account is archived, so no contacts were added",
          }),
        );
        continue;
      }

      const firstName = str(row.cells.first_name);
      const lastName = str(row.cells.last_name);
      const email =
        row.cells.email !== undefined && row.cells.email !== ""
          ? normalizeEmail(row.cells.email)
          : null;

      const invalid = validateContact({
        accountId: account.id,
        firstName,
        lastName,
        jobTitle: str(row.cells.job_title),
        // Raw cell values are validated, so a malformed email or URL fails its
        // row instead of being normalized to nothing and stored as absent.
        email: str(row.cells.email),
        phone: str(row.cells.phone),
        profileUrl: str(row.cells.profile_url),
        source: "csv",
        sourceReference: options?.sourceReference ?? str(row.cells.source_reference),
      });
      if (invalid) {
        results.push(
          rowResult(row.line, "failed", {
            reason: "invalid",
            field: invalid.details?.[0]?.field,
            message: invalid.details?.[0]?.message ?? invalid.message,
          }),
        );
        continue;
      }

      if (email !== null && seen.has(`${account.id}:${email}`)) {
        results.push(
          rowResult(row.line, "skipped", {
            reason: "duplicate_in_file",
            message: "an earlier row in this file already used this email on this account",
          }),
        );
        continue;
      }

      if (email !== null) {
        const duplicate = this.repo.findContactByEmail(workspaceId, userId, account.id, email);
        if (!duplicate.ok) {
          results.push(
            rowResult(row.line, "failed", {
              reason: "storage_error",
              message: "the contact could not be looked up",
            }),
          );
          continue;
        }
        if (duplicate.value !== null) {
          // Same person on the same account: refresh only the fields this file
          // actually supplied, so a later file cannot erase an earlier one.
          const patch: Partial<Omit<Contact, "id" | "workspaceId" | "createdBy" | "createdAt">> =
            {};
          if (firstName !== null) patch.firstName = firstName;
          if (lastName !== null) patch.lastName = lastName;
          if (firstName !== null || lastName !== null) {
            patch.fullName = buildFullName(
              firstName ?? duplicate.value.firstName,
              lastName ?? duplicate.value.lastName,
            );
          }
          const jobTitle = str(row.cells.job_title);
          if (jobTitle !== null) patch.jobTitle = jobTitle;
          const phone = str(row.cells.phone);
          if (phone !== null) patch.phone = phone;
          const profileUrl = str(row.cells.profile_url);
          if (profileUrl !== null) patch.profileUrl = normalizeUrl(profileUrl);
          const updated = this.repo.updateContact(duplicate.value.id, { userId, patch });
          if (!updated.ok) {
            results.push(
              rowResult(row.line, "failed", {
                reason: "storage_error",
                id: duplicate.value.id,
                message: "the existing contact could not be updated",
              }),
            );
            continue;
          }
          seen.add(`${account.id}:${email}`);
          results.push(rowResult(row.line, "updated", { id: duplicate.value.id }));
          continue;
        }
      }

      const created = this.repo.createContact({
        workspaceId,
        createdBy: userId,
        contact: {
          accountId: account.id,
          firstName,
          lastName,
          fullName: buildFullName(firstName, lastName),
          jobTitle: str(row.cells.job_title),
          email,
          phone: str(row.cells.phone),
          profileUrl: row.cells.profile_url ? normalizeUrl(row.cells.profile_url) : null,
          source: "csv",
          sourceReference: options?.sourceReference ?? str(row.cells.source_reference),
          status: "active",
        },
      });
      if (!created.ok) {
        results.push(
          rowResult(row.line, "failed", {
            reason: "storage_error",
            message: "the contact could not be created",
          }),
        );
        continue;
      }
      if (email !== null) seen.add(`${account.id}:${email}`);
      results.push(rowResult(row.line, "created", { id: created.value.id }));
    }

    return ok(summarize(results));
  }

  /** Resolve an account by id, or by name when the name is unique. */
  private resolveAccountRef(
    workspaceId: EntityId,
    userId: EntityId,
    reference: string,
  ): Account | null {
    const byId = this.repo.getAccount(reference, userId);
    if (byId.ok) return byId.value;
    const byName = this.repo.findAccountByName(workspaceId, userId, reference);
    if (!byName.ok) return null;
    return byName.value.length === 1 ? (byName.value[0] ?? null) : null;
  }
}
