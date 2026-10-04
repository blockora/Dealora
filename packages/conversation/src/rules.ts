/**
 * The vocabulary Phase 12 decides with, and the text matching it uses.
 *
 * Everything a classification can say is declared here, once, as data. Nothing
 * in this package invents an intent, a disposition or a signal: a value outside
 * these lists cannot be produced, and the schema CHECK constraints agree.
 */

import type {
  ConversationConfidence,
  ConversationDisposition,
  ConversationError,
  ConversationErrorCode,
  ConversationIntent,
  ConversationSignalKind,
  InboundSource,
} from "./types.js";

/**
 * The rule set, stored with every classification.
 *
 * A version is part of the record rather than an implementation detail, because
 * "why did DEALORA read that as an objection" is only answerable if the reader
 * knows which rules answered it. Phases 3 to 11 all store their version for the
 * same reason.
 */
export const CONVERSATION_CLASSIFIER_VERSION = "deterministic-1.0.0";

export const SUPPORTED_CLASSIFIER_VERSIONS: readonly string[] = [CONVERSATION_CLASSIFIER_VERSION];

/**
 * Exactly the ten states `DEALORA_BLUEPRINT.md` §18 and `ROADMAP.md` §19 name.
 *
 * Closed so that `unknown` is a real, reportable answer rather than a place to
 * put anything the rules did not recognise.
 */
export const CONVERSATION_INTENTS: readonly ConversationIntent[] = [
  "interested",
  "question",
  "pricing",
  "objection",
  "not_now",
  "wrong_person",
  "unsubscribe",
  "positive_intent",
  "negative_intent",
  "unknown",
];

/** What DEALORA recommends doing about a classified response. Never an effect. */
export const CONVERSATION_DISPOSITIONS: readonly ConversationDisposition[] = [
  "stop_contacting",
  "prepare_reply_for_approval",
  "request_human_review",
  "record_and_hold",
];

/** The closed safety and content vocabulary behind a classification. */
export const CONVERSATION_SIGNALS: readonly ConversationSignalKind[] = [
  "opt_out",
  "negative_sentiment",
  "sensitive_topic",
  "uncertainty",
  "unusual_request",
  "interest",
  "positive_sentiment",
  "question_signal",
  "pricing_signal",
  "objection_signal",
  "deferral",
  "routing",
];

export const CONVERSATION_CONFIDENCES: readonly ConversationConfidence[] = [
  "low",
  "medium",
  "high",
];

/** Bounds on stored text, so one enormous response cannot be persisted. */
export const LIMITS = {
  body: 8000,
  subject: 500,
  fromAddress: 320,
  providerMessageId: 200,
  reason: 300,
  reasons: 8,
  score: 100,
} as const;

/**
 * One phrase a rule looks for, and what it says the phrase means.
 *
 * `weight` is how much one match contributes to its intent. It is declared,
 * fixed data — never derived from the input — so the same message always scores
 * the same, and a strong unambiguous phrase outranks a weak incidental one.
 */
export interface ConversationRule {
  intent: ConversationIntent;
  signal: ConversationSignalKind;
  /** Lower-case phrase, matched on word boundaries, never as a substring. */
  phrase: string;
  weight: number;
}

/**
 * Phrases that say what the response is.
 *
 * Ordered by intent, not by importance; the ordering that matters is the
 * safety precedence in `classify.ts`, not the order of this list.
 */
export const CONVERSATION_RULES: readonly ConversationRule[] = [
  // --- Opt-out: the one outcome that must never wait for a human -----------
  { intent: "unsubscribe", signal: "opt_out", phrase: "unsubscribe", weight: 5 },
  { intent: "unsubscribe", signal: "opt_out", phrase: "opt out", weight: 5 },
  { intent: "unsubscribe", signal: "opt_out", phrase: "remove me", weight: 5 },
  { intent: "unsubscribe", signal: "opt_out", phrase: "take me off", weight: 5 },
  { intent: "unsubscribe", signal: "opt_out", phrase: "do not contact", weight: 5 },
  { intent: "unsubscribe", signal: "opt_out", phrase: "stop emailing", weight: 5 },
  { intent: "unsubscribe", signal: "opt_out", phrase: "stop contacting", weight: 5 },
  { intent: "unsubscribe", signal: "opt_out", phrase: "delete my data", weight: 5 },
  { intent: "unsubscribe", signal: "opt_out", phrase: "no longer wish", weight: 5 },

  // --- Negative intent: escalate, never argue -------------------------------
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "not interested", weight: 4 },
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "no thank you", weight: 4 },
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "not a good fit", weight: 4 },
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "never mind", weight: 4 },
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "not looking", weight: 4 },
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "no need", weight: 3 },
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "do not want", weight: 3 },
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "waste of time", weight: 4 },
  { intent: "negative_intent", signal: "negative_sentiment", phrase: "not relevant", weight: 4 },

  // --- Interest and positive intent ----------------------------------------
  { intent: "positive_intent", signal: "positive_sentiment", phrase: "sounds good", weight: 3 },
  { intent: "positive_intent", signal: "positive_sentiment", phrase: "happy to chat", weight: 4 },
  { intent: "positive_intent", signal: "positive_sentiment", phrase: "would like to", weight: 3 },
  { intent: "positive_intent", signal: "positive_sentiment", phrase: "book a call", weight: 4 },
  { intent: "positive_intent", signal: "positive_sentiment", phrase: "lets talk", weight: 4 },
  { intent: "interested", signal: "interest", phrase: "interested", weight: 4 },
  { intent: "interested", signal: "interest", phrase: "more information", weight: 3 },
  { intent: "interested", signal: "interest", phrase: "tell me more", weight: 3 },
  { intent: "interested", signal: "interest", phrase: "curious about", weight: 3 },

  // --- Question and pricing -------------------------------------------------
  { intent: "pricing", signal: "pricing_signal", phrase: "how much", weight: 4 },
  { intent: "pricing", signal: "pricing_signal", phrase: "pricing", weight: 4 },
  { intent: "pricing", signal: "pricing_signal", phrase: "price", weight: 3 },
  { intent: "pricing", signal: "pricing_signal", phrase: "cost", weight: 3 },
  { intent: "pricing", signal: "pricing_signal", phrase: "budget", weight: 2 },
  { intent: "pricing", signal: "pricing_signal", phrase: "quote", weight: 2 },
  { intent: "pricing", signal: "pricing_signal", phrase: "fees", weight: 3 },
  { intent: "question", signal: "question_signal", phrase: "question", weight: 2 },
  { intent: "question", signal: "question_signal", phrase: "could you tell me", weight: 4 },
  { intent: "question", signal: "question_signal", phrase: "can you tell me", weight: 4 },
  { intent: "question", signal: "question_signal", phrase: "i wanted to ask", weight: 4 },
  { intent: "question", signal: "question_signal", phrase: "just checking", weight: 3 },
  { intent: "question", signal: "question_signal", phrase: "wondering about", weight: 3 },

  // --- Objection, deferral, routing ----------------------------------------
  { intent: "objection", signal: "objection_signal", phrase: "too expensive", weight: 5 },
  { intent: "objection", signal: "objection_signal", phrase: "already have", weight: 4 },
  { intent: "objection", signal: "objection_signal", phrase: "no budget", weight: 4 },
  { intent: "objection", signal: "objection_signal", phrase: "using another", weight: 4 },
  { intent: "objection", signal: "objection_signal", phrase: "not convinced", weight: 4 },
  { intent: "not_now", signal: "deferral", phrase: "not now", weight: 4 },
  { intent: "not_now", signal: "deferral", phrase: "another time", weight: 4 },
  { intent: "not_now", signal: "deferral", phrase: "next quarter", weight: 4 },
  { intent: "not_now", signal: "deferral", phrase: "get back to you", weight: 4 },
  { intent: "not_now", signal: "deferral", phrase: "revisit", weight: 3 },
  { intent: "not_now", signal: "deferral", phrase: "new year", weight: 4 },
  { intent: "not_now", signal: "deferral", phrase: "following", weight: 3 },
  { intent: "wrong_person", signal: "routing", phrase: "wrong person", weight: 5 },
  { intent: "wrong_person", signal: "routing", phrase: "not the right contact", weight: 5 },
  { intent: "wrong_person", signal: "routing", phrase: "who else", weight: 4 },
  { intent: "wrong_person", signal: "routing", phrase: "another colleague", weight: 4 },
  { intent: "wrong_person", signal: "routing", phrase: "not me", weight: 4 },
  { intent: "wrong_person", signal: "routing", phrase: "forwarded", weight: 3 },
];

/**
 * Triggers that force a person into the loop regardless of intent.
 *
 * `ROADMAP.md` §19 names a sensitive issue, uncertainty and an unusual request
 * as reasons to stop or escalate. They are *not* intents on purpose: a
 * sensitive message can also be a question, and the safe reading of that
 * question is still "a human should read this", not "treat it as a question and
 * answer it".
 */
export const CONVERSATION_SAFETY_RULES: readonly ConversationRule[] = [
  { intent: "unknown", signal: "sensitive_topic", phrase: "legal", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "lawyer", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "solicitor", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "complaint", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "breach", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "security incident", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "personal data", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "discrimination", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "gdpr", weight: 1 },
  { intent: "unknown", signal: "sensitive_topic", phrase: "press", weight: 1 },
  { intent: "unknown", signal: "uncertainty", phrase: "not sure", weight: 1 },
  { intent: "unknown", signal: "uncertainty", phrase: "unsure", weight: 1 },
  { intent: "unknown", signal: "uncertainty", phrase: "no idea", weight: 1 },
  { intent: "unknown", signal: "uncertainty", phrase: "who are you", weight: 1 },
  { intent: "unknown", signal: "uncertainty", phrase: "are you a robot", weight: 1 },
  { intent: "unknown", signal: "unusual_request", phrase: "wire transfer", weight: 1 },
  { intent: "unknown", signal: "unusual_request", phrase: "bank details", weight: 1 },
  { intent: "unknown", signal: "unusual_request", phrase: "password", weight: 1 },
  { intent: "unknown", signal: "unusual_request", phrase: "under nda", weight: 1 },
  { intent: "unknown", signal: "unusual_request", phrase: "on another channel", weight: 1 },
  { intent: "unknown", signal: "unusual_request", phrase: "whatsapp", weight: 1 },
];

/**
 * Words that reverse the sense of a phrase immediately before it.
 *
 * "not interested" contains "interested". Without this, the single most
 * important sentence a prospect can send would be classified as interest — and
 * the classifier would then recommend preparing a reply for approval to someone
 * who just said no. The guard is applied to *every* phrase, so "do not opt out"
 * also cannot suppress anyone, which is the right way round for that too.
 */
export const NEGATORS: readonly string[] = [
  "not",
  "no",
  "never",
  "none",
  "cannot",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "wont",
  "wouldnt",
  "aint",
  "nor",
];

/**
 * The recommendation for each intent.
 *
 * Stated as data, and stated *once*, so "what would DEALORA do about an
 * objection" has exactly one answer in the codebase.
 *
 * Note what is not here: no intent maps to "send a reply". The strongest
 * positive outcome only recommends preparing a reply **for approval**, because
 * Phase 10 is what makes a message leave the system and this phase does not get
 * to skip it.
 */
export const DISPOSITION_BY_INTENT: Record<ConversationIntent, ConversationDisposition> = {
  unsubscribe: "stop_contacting",
  negative_intent: "request_human_review",
  objection: "request_human_review",
  question: "prepare_reply_for_approval",
  pricing: "prepare_reply_for_approval",
  interested: "prepare_reply_for_approval",
  positive_intent: "prepare_reply_for_approval",
  not_now: "record_and_hold",
  wrong_person: "record_and_hold",
  unknown: "record_and_hold",
};

/**
 * Signals that mean "a person must look at this" whatever the intent was.
 *
 * Every safety signal escalates. So does an intent that would otherwise lead to
 * contact, which is everything except an opt-out — and an opt-out is the one
 * outcome that is honoured immediately, because waiting for a human to honour an
 * opt-out is how a workspace ends up mailing someone who asked it to stop.
 */
export const ESCALATING_SIGNALS: readonly ConversationSignalKind[] = [
  "sensitive_topic",
  "uncertainty",
  "unusual_request",
  "negative_sentiment",
  "objection_signal",
];

/** Intents that never need a person before the recommendation is acted on. */
export const UNSUPERVISED_INTENTS: readonly ConversationIntent[] = ["unsubscribe"];

export function conversationError(
  code: ConversationErrorCode,
  message: string,
  details?: readonly { field: string; message: string }[],
): ConversationError {
  // `details` is omitted entirely when there is nothing to say, because an
  // empty array reads as "no problems" on a refusal that is about to be shown
  // to a user as a reason.
  return details && details.length > 0 ? { code, message, details } : { code, message };
}

export function isConversationIntent(value: unknown): value is ConversationIntent {
  return typeof value === "string" && (CONVERSATION_INTENTS as readonly string[]).includes(value);
}

export function isConversationSignal(value: unknown): value is ConversationSignalKind {
  return typeof value === "string" && (CONVERSATION_SIGNALS as readonly string[]).includes(value);
}

export function isSupportedClassifierVersion(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (SUPPORTED_CLASSIFIER_VERSIONS as readonly string[]).includes(value)
  );
}

export function isInboundSource(value: unknown): value is InboundSource {
  return value === "manual" || value === "provider_ingest";
}

/**
 * Lower-case, drop apostrophes, collapse whitespace.
 *
 * Apostrophes go because "don't" and "dont" are the same word to a person and
 * treating them as different would let a negated phrase slip past the guard.
 */
export function normalizeForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A phrase and where it was found, so its negation can be checked. */
export interface PhraseMatch {
  phrase: string;
  /** True when a negator sits immediately before the phrase. */
  negated: boolean;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a phrase on word boundaries, and report whether it is negated.
 *
 * Word boundaries matter: "stop" must not fire inside "stopwatch", and "price"
 * must not fire inside "priceless". A classifier built on substring matching
 * would invent intents nobody wrote.
 */
export function findPhrase(haystack: string, phrase: string): PhraseMatch | null {
  if (phrase === "") return null;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeForRegex(phrase)}([^a-z0-9]|$)`, "i");
  const found = pattern.exec(haystack);
  if (!found) return null;
  // Group 1 is the leading boundary, empty when the phrase starts the string.
  const start = found.index + (found[1] === undefined || found[1] === "" ? 0 : 1);
  const before = haystack.slice(0, start);
  const lastTwoWords = before
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  const negated = lastTwoWords
    .slice(-2)
    .some((word) => (NEGATORS as readonly string[]).includes(word));
  return { phrase, negated };
}
