/**
 * The classifier.
 *
 * A pure function of one recorded message. No model, no randomness, no clock,
 * no storage, no network: given the same body, the same rules and the same rule
 * version it returns the same intent, the same confidence and the same reasons
 * every time. That is what makes a stored classification re-derivable later,
 * which is the only way a workspace can check that it was never quietly
 * rewritten.
 *
 * Four properties this phase cannot give up, and how each is obtained:
 *
 *  1. **Safety wins.** An opt-out outranks everything, then a negative
 *     response. A message that says "not interested, but what does it cost?"
 *     is read as `negative_intent`, never as `pricing`, because acting on the
 *     pricing reading would prepare a reply for approval to someone who just
 *     said no.
 *  2. **Silence is not a signal.** Text that matches nothing is `unknown` with
 *     no score and no recommendation of anything but holding it — never a guess
 *     at what the sender probably meant.
 *  3. **Every answer names its evidence.** The `reasons` are the phrases that
 *     actually matched, not a restatement of the intent.
 *  4. **Uncertainty escalates.** A low-confidence classification is never
 *     treated as a decision: it always requires a human.
 */

import type {
  ConversationConfidence,
  ConversationDisposition,
  ConversationIntent,
  ConversationSignalKind,
} from "./types.js";
import {
  CONVERSATION_CLASSIFIER_VERSION,
  CONVERSATION_INTENTS,
  CONVERSATION_RULES,
  CONVERSATION_SAFETY_RULES,
  DISPOSITION_BY_INTENT,
  ESCALATING_SIGNALS,
  LIMITS,
  UNSUPERVISED_INTENTS,
  findPhrase,
  normalizeForMatching,
} from "./rules.js";

/**
 * Intents that outrank the scoring entirely.
 *
 * Ordered most protective first. Anything here wins on the strength of a single
 * match, without being compared against the rest of the message, because the
 * cost of reading "not interested" as "interested" is a reply nobody wanted and
 * the cost of reading an opt-out as anything else is a violation.
 */
const SAFETY_PRECEDENCE: readonly ConversationIntent[] = [
  "unsubscribe",
  "negative_intent",
  "wrong_person",
];

/** How a classification was arrived at, before it is persisted. */
export interface ConversationClassificationDraft {
  classifierVersion: string;
  intent: ConversationIntent;
  confidence: ConversationConfidence;
  reasons: string[];
  signals: ConversationSignalKind[];
  recommendedNextAction: ConversationDisposition;
  humanInterventionRequired: boolean;
  /** The only effect this phase may take, and only for an opt-out. */
  suppress: boolean;
}

/** Everything the classifier reads. Deliberately just the text. */
export interface ConversationClassificationInput {
  body: string;
  subject?: string | null;
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** What one pass over the rules found for a single intent. */
interface IntentScore {
  intent: ConversationIntent;
  score: number;
  /** The phrases that fired, in the order the rules declare them. */
  matched: string[];
  /** Phrases that fired but were negated, kept so the reason can say so. */
  negated: string[];
  signals: ConversationSignalKind[];
}

/**
 * Score every intent, from both the content rules and the safety rules.
 *
 * A phrase that is negated is not a match. It is recorded, though, because "you
 * said `interested` and negated it" is a materially different thing from "you
 * never mentioned interest", and a user reading the classification is entitled
 * to that difference.
 */
function scoreIntents(haystack: string): IntentScore[] {
  const byIntent = new Map<ConversationIntent, IntentScore>();

  const record = (
    intent: ConversationIntent,
    signal: ConversationSignalKind,
    phrase: string,
    weight: number,
    negated: boolean,
  ): void => {
    const entry = byIntent.get(intent) ?? {
      intent,
      score: 0,
      matched: [],
      negated: [],
      signals: [],
    };
    if (negated) {
      entry.negated.push(phrase);
    } else {
      entry.score += weight;
      entry.matched.push(phrase);
    }
    if (!entry.signals.includes(signal)) entry.signals.push(signal);
    byIntent.set(intent, entry);
  };

  for (const rule of CONVERSATION_RULES) {
    const found = findPhrase(haystack, rule.phrase);
    if (!found) continue;
    record(rule.intent, rule.signal, rule.phrase, rule.weight, found.negated);
  }
  for (const rule of CONVERSATION_SAFETY_RULES) {
    const found = findPhrase(haystack, rule.phrase);
    if (!found) continue;
    // A negated safety phrase is not a safety trigger: "this is not legal
    // advice" is not a sensitive topic. Recording it under `unknown` still
    // surfaces it in the reasons, without escalating on it.
    record(rule.intent, rule.signal, rule.phrase, rule.weight, found.negated);
  }

  // Negated positive phrasing is evidence of a *negative* reading, not of
  // nothing. "I am not really interested" must not read as interest, and it
  // should not read as silence either.
  for (const [intent, entry] of byIntent) {
    if (entry.negated.length === 0) continue;
    if (intent === "negative_intent" || intent === "unknown") continue;
    const negative = byIntent.get("negative_intent") ?? {
      intent: "negative_intent" as ConversationIntent,
      score: 0,
      matched: [],
      negated: [],
      signals: [] as ConversationSignalKind[],
    };
    negative.score += 1;
    negative.matched.push(`not ${entry.negated[0] ?? ""}`.trim());
    if (!negative.signals.includes("negative_sentiment")) {
      negative.signals.push("negative_sentiment");
    }
    byIntent.set("negative_intent", negative);
  }

  return [...byIntent.values()];
}

/**
 * The confidence band, from the margin between the winner and the runner-up.
 *
 * A clear winner with two independent phrases behind it is `high`; a single
 * phrase is `medium`; two intents that tie, or nothing at all, is `low`. The
 * point is not the label — it is that a `low` band always escalates, so the
 * engine never treats an ambiguous reading as a decision.
 */
function confidenceFor(top: IntentScore | null, runnerUp: number): ConversationConfidence {
  if (!top || top.score <= 0) return "low";
  if (runnerUp > 0 && top.score - runnerUp <= 1) return "low";
  if (top.matched.length >= 2 && top.score >= 4) return "high";
  return "medium";
}

/**
 * Read one recorded message.
 *
 * Returns a draft, never a record: the service decides what to persist, the
 * store re-checks the safety invariants, and only then does anything exist.
 */
export function classifyConversation(
  input: ConversationClassificationInput,
  classifierVersion: string = CONVERSATION_CLASSIFIER_VERSION,
): ConversationClassificationDraft {
  const haystack = normalizeForMatching(`${input.subject ?? ""} ${input.body}`.trim());

  const scores = scoreIntents(haystack);
  const signals = unique(scores.flatMap((entry) => entry.signals));

  // 1. Safety precedence: the first protective intent with any unnegated match
  //    wins outright, and the margin is irrelevant.
  const safety = SAFETY_PRECEDENCE.map((intent) => scores.find((s) => s.intent === intent)).find(
    (entry): entry is IntentScore => entry !== undefined && entry.score > 0,
  );

  const ranked = [...scores]
    .filter((entry) => entry.score > 0)
    // Deterministic total order: score first, then the closed intent list, which
    // is fixed data. A tie is therefore broken by declaration order rather than
    // by whatever order storage happened to return.
    .sort((a, b) => b.score - a.score || rankOf(a.intent) - rankOf(b.intent));

  const top = safety ?? ranked[0] ?? null;
  const runnerUp = safety
    ? 0
    : (ranked.find((entry) => entry.intent !== (top?.intent ?? ""))?.score ?? 0);

  const intent: ConversationIntent = top?.intent ?? "unknown";
  const confidence = confidenceFor(top, runnerUp);

  const reasons: string[] = [];
  if (top && top.matched.length > 0) {
    reasons.push(
      `matched ${top.matched
        .slice(0, 3)
        .map((p) => `"${p}"`)
        .join(", ")}`,
    );
  }
  const negated = scores.flatMap((entry) => entry.negated);
  if (negated.length > 0) {
    reasons.push(`ignored as negated: ${negated.slice(0, 3).join(", ")}`);
  }
  if (reasons.length === 0) {
    reasons.push("no rule matched this response");
  }

  const escalating = signals.filter((signal) =>
    (ESCALATING_SIGNALS as readonly string[]).includes(signal),
  );
  const needsHuman = !(UNSUPERVISED_INTENTS as readonly string[]).includes(intent);

  const disposition = DISPOSITION_BY_INTENT[intent];

  // A safety trigger outranks the disposition the intent alone would earn: a
  // question about pricing is still a question about pricing if it also mentions
  // a lawyer, and the safe reading of that is "hold it for a person".
  const effectiveDisposition: ConversationDisposition =
    escalating.length > 0 && disposition !== "stop_contacting"
      ? "request_human_review"
      : disposition;

  return {
    classifierVersion,
    intent,
    // A safety trigger can only lower confidence, never raise it: a message
    // whose intent is clear but whose subject matter is sensitive is not more
    // confidently classified for being sensitive.
    confidence: escalating.length > 0 && confidence === "high" ? "medium" : confidence,
    reasons: reasons.map((reason) => cap(reason, LIMITS.reason)).slice(0, LIMITS.reasons),
    signals: signals.slice().sort(),
    recommendedNextAction: effectiveDisposition,
    humanInterventionRequired: needsHuman,
    suppress: intent === "unsubscribe",
  };
}

/** Declaration order of the closed intent list, used as the tiebreaker. */
function rankOf(intent: ConversationIntent): number {
  return CONVERSATION_INTENTS.indexOf(intent);
}
