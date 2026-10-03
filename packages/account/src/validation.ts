import type { AccountStatus, ContactStatus } from "@dealora/db";

import { accountError } from "./types.js";
import type { AccountError } from "./types.js";

/**
 * Normalization, validation and deterministic duplicate keys.
 *
 * Every function here is deterministic and side-effect free. Normalization is
 * applied only where it is safe and lossless: a company name is never
 * rewritten beyond trimming and collapsing whitespace, and no missing value is
 * ever invented.
 */

export const LIMITS = {
  name: 200,
  website: 500,
  domain: 253,
  industry: 200,
  companySize: 100,
  geography: 200,
  description: 4000,
  sourceReference: 500,
  fullName: 200,
  jobTitle: 200,
  email: 320,
  phone: 100,
  profileUrl: 500,
  csvCell: 4000,
  csvRows: 5000,
} as const;

export const ACCOUNT_STATUSES: readonly AccountStatus[] = ["active", "archived"];
export const CONTACT_STATUSES: readonly ContactStatus[] = ["active", "archived"];

export const RECORD_SOURCES = ["manual", "csv", "approved_integration"] as const;

export type RecordSourceValue = (typeof RECORD_SOURCES)[number];

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Trim and collapse internal whitespace runs. Never changes casing. */
export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Lower-case a domain and strip scheme, path, port and a leading `www.`.
 *
 * Deterministic and reversible enough for matching, and it never invents a
 * domain that was not supplied.
 */
export function normalizeDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return null;
  let host = trimmed;
  // Strip a scheme if the user pasted a full URL into a domain field.
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//.exec(host);
  if (schemeMatch) host = host.slice(schemeMatch[0].length);
  // Keep only the authority component.
  host = host.split("/")[0] ?? host;
  host = host.split("?")[0] ?? host;
  host = host.split("#")[0] ?? host;
  // Strip credentials and port.
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  host = host.replace(/:\d+$/, "");
  host = host.replace(/^www\./, "");
  if (host === "") return null;
  return isValidDomain(host) ? host : null;
}

/**
 * Normalize a website URL to an absolute `https://` URL.
 *
 * A bare host is treated as `https://<host>`. Nothing is fetched, and a value
 * that is not a plausible web URL is rejected rather than coerced.
 */
export function normalizeUrl(value: string): string | null {
  const trimmed = normalizeText(value);
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname === "" || !isValidDomain(parsed.hostname)) return null;
  // Drop a trailing slash on a bare origin so `https://x.com` and
  // `https://x.com/` normalize identically.
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
}

/** Lower-case an email and trim it. Formatting oddities are rejected, not fixed. */
export function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return null;
  return isValidEmail(trimmed) ? trimmed : null;
}

/** A plausible hostname: dot-separated labels of letters, digits and hyphens. */
export function isValidDomain(value: string): boolean {
  if (value.length === 0 || value.length > LIMITS.domain) return false;
  if (value.includes("..")) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

/** A syntactically valid email address. No deliverability claim is made. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) && value.length <= LIMITS.email;
}

/** Build a display name from the parts supplied. Returns "" when neither is. */
export function buildFullName(firstName: string | null, lastName: string | null): string {
  return [firstName ?? "", lastName ?? ""]
    .map(normalizeText)
    .filter((p) => p !== "")
    .join(" ");
}

// ---------------------------------------------------------------------------
// Issue collection
// ---------------------------------------------------------------------------

/** Collect field-level issues, as the other domain packages do. */
export class AccountIssues {
  private readonly collected: { field: string; message: string }[] = [];

  add(field: string, message: string): void {
    this.collected.push({ field, message });
  }

  get length(): number {
    return this.collected.length;
  }

  all(): { field: string; message: string }[] {
    return [...this.collected];
  }

  toError(message = "validation failed"): AccountError {
    return accountError("VALIDATION_ERROR", message, this.all());
  }
}

function requiredText(issues: AccountIssues, value: unknown, field: string, max: number): void {
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(field, `${field} is required`);
  } else if (value.length > max) {
    issues.add(field, `${field} must be at most ${max} characters`);
  }
}

function optionalText(issues: AccountIssues, value: unknown, field: string, max: number): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") {
    issues.add(field, `${field} must be a string`);
  } else if (value.length > max) {
    issues.add(field, `${field} must be at most ${max} characters`);
  }
}

/**
 * Validate a normalized account.
 *
 * Shared by manual creation and CSV import so there is exactly one set of
 * rules — an import can never bypass a check a manual entry would face.
 */
export function validateAccount(input: {
  name: unknown;
  website: unknown;
  domain: unknown;
  industry: unknown;
  companySize: unknown;
  geography: unknown;
  description: unknown;
  source: unknown;
  sourceReference?: unknown;
  status?: unknown;
}): AccountError | null {
  const issues = new AccountIssues();
  requiredText(issues, input.name, "name", LIMITS.name);
  optionalText(issues, input.website, "website", LIMITS.website);
  optionalText(issues, input.domain, "domain", LIMITS.domain);
  optionalText(issues, input.industry, "industry", LIMITS.industry);
  optionalText(issues, input.companySize, "companySize", LIMITS.companySize);
  optionalText(issues, input.geography, "geography", LIMITS.geography);
  optionalText(issues, input.description, "description", LIMITS.description);
  optionalText(issues, input.sourceReference, "sourceReference", LIMITS.sourceReference);

  if (
    typeof input.website === "string" &&
    input.website !== "" &&
    normalizeUrl(input.website) === null
  ) {
    issues.add("website", "website must be a valid http(s) URL");
  }
  if (
    typeof input.domain === "string" &&
    input.domain !== "" &&
    normalizeDomain(input.domain) === null
  ) {
    issues.add("website", "domain must be a valid hostname");
  }
  if (!RECORD_SOURCES.includes(input.source as RecordSourceValue)) {
    issues.add("source", `source must be one of: ${RECORD_SOURCES.join(", ")}`);
  }
  if (input.status !== undefined && !ACCOUNT_STATUSES.includes(input.status as AccountStatus)) {
    issues.add("status", `status must be one of: ${ACCOUNT_STATUSES.join(", ")}`);
  }

  if (issues.length > 0) return issues.toError("the account is not valid");
  return null;
}

/** Validate a normalized contact. Same rules for manual entry and CSV import. */
export function validateContact(input: {
  accountId: unknown;
  firstName: unknown;
  lastName: unknown;
  jobTitle: unknown;
  email: unknown;
  phone: unknown;
  profileUrl: unknown;
  source: unknown;
  sourceReference?: unknown;
  status?: unknown;
}): AccountError | null {
  const issues = new AccountIssues();
  if (typeof input.accountId !== "string" || input.accountId === "") {
    issues.add("accountId", "a contact must belong to an account");
  }
  optionalText(issues, input.firstName, "firstName", LIMITS.fullName);
  optionalText(issues, input.lastName, "lastName", LIMITS.fullName);
  optionalText(issues, input.jobTitle, "jobTitle", LIMITS.jobTitle);
  optionalText(issues, input.phone, "phone", LIMITS.phone);
  optionalText(issues, input.profileUrl, "profileUrl", LIMITS.profileUrl);

  const hasName =
    (typeof input.firstName === "string" && input.firstName.trim() !== "") ||
    (typeof input.lastName === "string" && input.lastName.trim() !== "");
  if (!hasName && (typeof input.email !== "string" || input.email.trim() === "")) {
    issues.add("firstName", "a contact needs a name or an email address");
  }
  if (
    typeof input.email === "string" &&
    input.email !== "" &&
    normalizeEmail(input.email) === null
  ) {
    issues.add("email", "email must be a valid address");
  }
  if (
    typeof input.profileUrl === "string" &&
    input.profileUrl !== "" &&
    normalizeUrl(input.profileUrl) === null
  ) {
    issues.add("profileUrl", "profileUrl must be a valid http(s) URL");
  }
  optionalText(issues, input.sourceReference, "sourceReference", LIMITS.sourceReference);
  if (!RECORD_SOURCES.includes(input.source as RecordSourceValue)) {
    issues.add("source", `source must be one of: ${RECORD_SOURCES.join(", ")}`);
  }
  if (input.status !== undefined && !CONTACT_STATUSES.includes(input.status as ContactStatus)) {
    issues.add("status", `status must be one of: ${CONTACT_STATUSES.join(", ")}`);
  }

  if (issues.length > 0) return issues.toError("the contact is not valid");
  return null;
}

// ---------------------------------------------------------------------------
// Duplicate keys
// ---------------------------------------------------------------------------

/**
 * The deterministic account identity.
 *
 * A normalized domain is a strong key: the same domain in the same workspace
 * is the same company, so a re-import updates rather than duplicates.
 *
 * A name is deliberately **not** a strong key. Two unrelated companies can
 * share a name, so a name collision is reported as ambiguity and both records
 * are preserved rather than silently merged.
 */
export function accountStrongKey(domain: string | null): string | null {
  return domain !== null && domain !== "" ? `domain:${domain}` : null;
}

/** The weak key used only to *report* a possible duplicate. */
export function accountNameKey(name: string): string {
  return `name:${normalizeText(name).toLowerCase()}`;
}

/** Contacts are identified within an account by normalized email. */
export function contactStrongKey(accountId: string, email: string | null): string | null {
  return email !== null && email !== "" ? `${accountId}:email:${email}` : null;
}
