import { randomBytes, randomUUID } from "node:crypto";

/**
 * Token handling is deliberately thin: tokens are random bytes with no
 * internal structure, no "signed" payload, and no user data embedded.
 * Verification rests on the database lookup.
 */

/** Minimum 256-bit entropy for bearer tokens. */
const TOKEN_BYTES = 32;

/** Fresh opaque bearer token usable for a session. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Opaque session identifier; never derived from user input. */
export function generateId(): string {
  return randomUUID();
}
