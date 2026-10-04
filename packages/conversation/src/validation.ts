/**
 * Validation for the conversation boundary.
 *
 * Written as a collector rather than a chain of early returns so a caller gets
 * every problem with their response at once, the way the Outbound and Approval
 * engines do it.
 */

import type {
  ConversationDisposition,
  ConversationIntent,
  ConversationPolicyView,
  ConversationSignalKind,
} from "./types.js";
import {
  CONVERSATION_CLASSIFIER_VERSION,
  CONVERSATION_DISPOSITIONS,
  CONVERSATION_INTENTS,
  CONVERSATION_SIGNALS,
  LIMITS,
  SUPPORTED_CLASSIFIER_VERSIONS,
} from "./rules.js";

export class ConversationIssues {
  private readonly issues: { field: string; message: string }[] = [];

  add(field: string, message: string): void {
    this.issues.push({ field, message });
  }

  get length(): number {
    return this.issues.length;
  }

  all(): { field: string; message: string }[] {
    return [...this.issues];
  }
}

/** A trimmed string within bounds, or `null` when it is not one. */
export function text(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length <= max ? trimmed : null;
}

/**
 * An optional string within bounds.
 *
 * Returns `undefined` for "not supplied" and `null` for "supplied but not a
 * usable string", which are different refusals: a caller who sent an empty
 * subject made a mistake, while a caller who sent nothing did not.
 */
export function optionalText(value: unknown, max = 1000): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length <= max ? trimmed : null;
}

/** A conservatively validated address, or `null`. */
export function address(value: unknown, max = LIMITS.fromAddress): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed.length > max) return null;
  return /^[^\s@]+@([a-z0-9-]+\.)+[a-z]{2,}$/.test(trimmed) ? trimmed : null;
}

/** An ISO-8601 instant, or `null`. Never guessed from a locale. */
export function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * The policy this deployment enforces, as data.
 *
 * Readable before anything has been classified, so a workspace can see what the
 * engine will do with a response before it hands one over.
 */
export function describeConversationPolicy(): ConversationPolicyView {
  return {
    classifierVersion: CONVERSATION_CLASSIFIER_VERSION,
    supportedClassifierVersions: SUPPORTED_CLASSIFIER_VERSIONS,
    intents: CONVERSATION_INTENTS as readonly ConversationIntent[],
    dispositions: CONVERSATION_DISPOSITIONS as readonly ConversationDisposition[],
    signals: CONVERSATION_SIGNALS as readonly ConversationSignalKind[],
    requiresHumanIntervention: [
      "Any response that is not an opt-out.",
      "Any response mentioning a sensitive topic: legal, a lawyer, a complaint, a breach, personal data or discrimination.",
      "Any response expressing uncertainty about who DEALORA is or what it is.",
      "Any response making an unusual request: payment details, credentials, an NDA or another channel.",
      "Any negative response or objection.",
      "Any classification whose confidence is low.",
    ],
    neverDoes: [
      "It never sends a message. A reply is only ever recommended for approval, and Phase 10 still decides.",
      "It never approves anything on a workspace's behalf.",
      "It never turns a response into evidence or a claim. Phase 7 remains the only route, and it stays human-driven.",
      "It never resolves a disagreement between sources; it only records what one message said.",
      "It never schedules anything, and nothing here runs without an authenticated request.",
      "It never contacts anyone on its own initiative, including after an opt-out.",
    ],
  };
}
