import type { ValidationIssue } from "./types.js";

/**
 * Validation helpers used at the application boundary.
 *
 * Rules:
 * - Collect every issue instead of failing on the first one, so a client
 *   gets one complete, safe validation response.
 * - Never echo internal state or storage errors.
 * - Enforce hard caps so oversized input cannot reach persistence.
 */

export const LIMITS = {
  shortText: 200,
  longText: 2000,
  claimText: 1000,
  listItem: 300,
  listLength: 50,
} as const;

/** Accumulates field-level issues for a single validation pass. */
export class Issues {
  private readonly collected: ValidationIssue[] = [];

  add(field: string, message: string): void {
    this.collected.push({ field, message });
  }

  get length(): number {
    return this.collected.length;
  }

  all(): ValidationIssue[] {
    return [...this.collected];
  }
}

/** Required, trimmed, length-capped string. */
export function requireString(
  issues: Issues,
  field: string,
  value: unknown,
  max: number,
): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(field, `${field} must be a non-empty string`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    issues.add(field, `${field} must be at most ${max} characters`);
    return null;
  }
  return trimmed;
}

/** Optional string; `null` clears the field, `undefined` leaves it unchanged. */
export function optionalString(
  issues: Issues,
  field: string,
  value: unknown,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.add(field, `${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    issues.add(field, `${field} must be at most ${max} characters`);
    return undefined;
  }
  return trimmed;
}

/** Validate a value against an enum of literals. */
export function requireEnum<T extends string>(
  issues: Issues,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.add(field, `${field} must be one of: ${allowed.join(", ")}`);
    return null;
  }
  return value as T;
}

/** Validate a list of short strings. */
export function requireStringList(issues: Issues, field: string, value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    issues.add(field, `${field} must be an array of strings`);
    return null;
  }
  if (value.length > LIMITS.listLength) {
    issues.add(field, `${field} must have at most ${LIMITS.listLength} items`);
    return null;
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      issues.add(`${field}[${index}]`, `${field} items must be strings`);
      return null;
    }
    const trimmed = item.trim();
    if (trimmed === "") {
      issues.add(`${field}[${index}]`, `${field} items must not be empty`);
      return null;
    }
    if (trimmed.length > LIMITS.listItem) {
      issues.add(
        `${field}[${index}]`,
        `${field} items must be at most ${LIMITS.listItem} characters`,
      );
      return null;
    }
    out.push(trimmed);
  }
  return out;
}

/**
 * Assign a validated optional field onto a patch object.
 *
 * Under `exactOptionalPropertyTypes`, `undefined` must not be assigned to an
 * optional property, so an omitted field must be left off the object entirely.
 * `null` is a real value here: it clears the stored field.
 */
export function setOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: string | null | undefined,
): void {
  if (value !== undefined) {
    target[key] = value as T[K];
  }
}

/**
 * Assign a validated optional string list onto a patch object, using the same
 * undefined-vs-null distinction as {@link setOptional}.
 */
export function setOptionalList<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: string[] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value as T[K];
  }
}

/**
 * Validate a URL. Only http(s) is accepted, so a stored value can never be
 * used to smuggle a `javascript:` or `data:` target into a client.
 */
export function optionalUrl(
  issues: Issues,
  field: string,
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(field, `${field} must be a URL or null`);
    return undefined;
  }
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    issues.add(field, `${field} must be a valid URL`);
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    issues.add(field, `${field} must use http or https`);
    return undefined;
  }
  if (trimmed.length > LIMITS.listItem) {
    issues.add(field, `${field} is too long`);
    return undefined;
  }
  return trimmed;
}

/** Validate an optional non-negative finite number. */
export function optionalAmount(
  value: unknown,
  field: string,
  issues: Issues,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    issues.add(field, `${field} must be a non-negative number`);
    return undefined;
  }
  return value;
}

/** Validate an optional ISO-4217-ish currency code. */
export function optionalCurrency(
  issues: Issues,
  field: string,
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value.trim())) {
    issues.add(field, `${field} must be a 3-letter currency code`);
    return undefined;
  }
  return value.trim();
}
