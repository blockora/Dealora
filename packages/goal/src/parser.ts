import type { GoalMetricKind } from "@dealora/db";

import type { BusinessBrainSnapshot, GoalDraft, GoalDraftField, GoalParser } from "./types.js";

/**
 * Deterministic natural-language goal parser.
 *
 * No model is involved: the same input plus the same Business Brain snapshot
 * and the same reference instant always produces the same draft. That makes
 * goal structuring testable, auditable and reproducible (ADR 0004).
 *
 * The parser never invents business facts. Anything it cannot derive from the
 * input or from canonical Business Brain data is emitted as `unknown` with a
 * reason, so the domain layer can record it as a gap instead of a guess.
 */

/** Ordered so that a more specific phrase wins over a generic one. */
const METRIC_PATTERNS: { kind: GoalMetricKind; patterns: RegExp[] }[] = [
  {
    kind: "qualified_opportunity",
    patterns: [
      /\bqualified\s+(opportunit|pipeline|deal)/i,
      /\bqualified\s+\w+\s+(deals?|opportunities)/i,
    ],
  },
  { kind: "pipeline", patterns: [/\bpipeline\b/i] },
  { kind: "meeting", patterns: [/\bmeetings?\b/i, /\bbooked\s+calls?\b/i, /\bdemos?\b/i] },
  {
    kind: "customer",
    patterns: [/\bcustomers?\b/i, /\bnew\s+logos?\b/i, /\baccounts?\s+closed\b/i],
  },
  {
    // "revenue" only names an outcome when an amount accompanies it; a bare
    // mention ("do more revenue somehow") is a topic, not a measurable target.
    kind: "revenue",
    patterns: [
      /(?:[$€£¥]\s?)?\b\d[\d,]*(?:\.\d+)?\s*(?:k|K|m|M)?\s+(?:in|of|booked\s+)?\s*revenue\b/i,
      /\bARR\b/,
      /\bMRR\b/,
      /\bbooked\s+revenue\b/i,
    ],
  },
  {
    kind: "conversion_rate",
    patterns: [/\bconversion\s+rate\b/i, /\bclose\s+rate\b/i, /\bwin\s+rate\b/i],
  },
  {
    kind: "time_to_target",
    patterns: [/\bwithin\s+\d+\s+(days?|weeks?|months?)\b/i, /\btime\s+to\s+\w+/i],
  },
];

/** Metric kinds whose target is a count rather than an amount of money. */
const COUNT_METRICS: ReadonlySet<GoalMetricKind> = new Set<GoalMetricKind>([
  "meeting",
  "customer",
  "qualified_opportunity",
]);

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

const GEOGRAPHY_CODES = new Set([
  "US",
  "USA",
  "UK",
  "GB",
  "EU",
  "EEA",
  "CA",
  "CANADA",
  "AU",
  "DE",
  "FR",
  "NL",
  "IE",
  "SE",
  "PL",
  "IN",
  "SG",
  "AE",
  "BR",
  "MX",
]);

function field<T>(
  value: T | null,
  origin: GoalDraftField<T>["origin"],
  note?: string,
): GoalDraftField<T> {
  const out: GoalDraftField<T> = { value, origin };
  if (note !== undefined) out.note = note;
  return out;
}

function unknown<T>(reason: string): GoalDraftField<T> {
  return field<T>(null, "unknown", reason);
}

/** Add whole days to a date, returning an ISO `YYYY-MM-DD` string. */
function addDays(now: Date, days: number): string {
  const next = new Date(now.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function toIsoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Match a Business Brain record by name, case-insensitively. */
const GENERIC_NOUNS =
  /\s+(offer|offers|service|services|retainer|retainers|plan|plans|product|products|package|packages|solution|solutions)\s*$/i;

/** Drop a generic trailing noun so a reference can match a canonical record. */
function stripGenericNoun(phrase: string): string {
  return phrase.replace(GENERIC_NOUNS, "").trim();
}

function matchByName<T extends { id: string; name: string }>(
  items: readonly T[],
  needle: string,
): T | null {
  const target = stripGenericNoun(needle).toLowerCase();
  if (target === "") return null;
  return (
    items.find((item) => item.name.trim().toLowerCase() === target) ??
    items.find((item) => item.name.trim().toLowerCase().includes(target)) ??
    null
  );
}

/**
 * Every noun phrase that follows a trigger word, in the order they appear.
 *
 * More than one trigger can match a sentence — "with 10-200 employees, using
 * our Support automation offer" contains two — so callers get every candidate
 * and choose the one that actually resolves, instead of committing to the
 * first and guessing.
 */
function phrasesAfter(text: string, trigger: RegExp): string[] {
  const flags = trigger.flags.includes("g") ? trigger.flags : `${trigger.flags}g`;
  const phrases: string[] = [];
  for (const match of text.matchAll(new RegExp(trigger.source, flags))) {
    const rest = text.slice((match.index ?? 0) + match[0].length);
    const cleaned = rest.replace(/^[\s,:-]+/, "");
    // Stop at a clause boundary so we do not swallow the rest of the sentence.
    const stop = cleaned.search(/[.,;]|\b(for|with|using|from|over|in|by|targeting|and|but)\b/i);
    const phrase = (stop === -1 ? cleaned : cleaned.slice(0, stop)).trim();
    if (phrase !== "") phrases.push(phrase);
  }
  return phrases;
}

/** The first noun phrase following a trigger word. */
function phraseAfter(text: string, trigger: RegExp): string | null {
  return phrasesAfter(text, trigger)[0] ?? null;
}

/** Phrases that describe timing or quantity rather than a market. */
const TEMPORAL_OR_QUANTITY =
  /^(?:next|last|past|coming|the\s+next|within)\b|\b(?:day|days|week|weeks|month|months|year|years|quarter|quarters|today)\b|^\d/i;

export class DeterministicGoalParser implements GoalParser {
  parse(input: string, context: BusinessBrainSnapshot, now: Date): GoalDraft {
    const text = input.trim();

    const objective = field<string>(
      text === "" ? null : text,
      text === "" ? "unknown" : "explicit",
      text === "" ? "no goal text was provided" : undefined,
    );

    // --- Target metric ---------------------------------------------------
    let targetMetric: GoalDraftField<GoalMetricKind> = unknown(
      "no measurable outcome phrase was recognised in the input",
    );
    for (const { kind, patterns } of METRIC_PATTERNS) {
      const pattern = patterns.find((p) => p.test(text));
      if (pattern) {
        targetMetric = field<GoalMetricKind>(
          kind,
          "explicit",
          `matched /${pattern.source}/ in the input`,
        );
        break;
      }
    }

    // --- Target value and currency --------------------------------------
    const moneyMatch = /([$€£¥])\s?([\d][\d,]*(?:\.\d+)?)\s*(k|K|m|M)?/.exec(text);
    const plainNumber =
      /\b(\d[\d,]*(?:\.\d+)?)\s*(qualified\s+\w+|meetings?|opportunities?|deals?|customers?|accounts?|prospects?|leads?)\b/i.exec(
        text,
      );

    let targetValue: GoalDraftField<number> = unknown("no target quantity was stated in the input");
    let currency: GoalDraftField<string> = unknown("no currency was stated in the input");

    // The currency of a goal is the currency the user wrote, whichever amount
    // it attaches to. A "$" is interpreted rather than stated, so it is
    // recorded as an assumption and never presented as user input.
    const symbol = moneyMatch?.[1];
    if (symbol) {
      const resolvedCurrency = CURRENCY_SYMBOLS[symbol] ?? "USD";
      currency = field<string>(
        resolvedCurrency,
        "assumption",
        `symbol "${symbol}" was interpreted as ${resolvedCurrency}`,
      );
    }

    // A count metric ("20 qualified meetings") must win over a money amount
    // that belongs to another clause, e.g. "contract value above $2,000".
    const countMetric = targetMetric.value !== null && COUNT_METRICS.has(targetMetric.value);
    if (countMetric && plainNumber) {
      const rawCount = plainNumber[1];
      if (rawCount !== undefined) {
        targetValue = field<number>(
          Number(rawCount.replace(/,/g, "")),
          "explicit",
          `parsed "${plainNumber[0].trim()}" from the input`,
        );
      }
    } else if (moneyMatch && moneyMatch[2] !== undefined) {
      const rawAmount = moneyMatch[2];
      const magnitude = moneyMatch[3];
      let amount = Number(rawAmount.replace(/,/g, ""));
      if (magnitude === "k" || magnitude === "K") amount *= 1_000;
      if (magnitude === "m" || magnitude === "M") amount *= 1_000_000;
      targetValue = field<number>(
        amount,
        "explicit",
        `parsed ${symbol ?? "$"}${rawAmount}${magnitude ?? ""}`,
      );
    } else if (plainNumber) {
      const rawAmount = plainNumber[1];
      if (rawAmount !== undefined) {
        targetValue = field<number>(
          Number(rawAmount.replace(/,/g, "")),
          "explicit",
          `parsed "${plainNumber[0].trim()}" from the input`,
        );
      }
    }

    // --- Time window ------------------------------------------------------
    const relativeWindow = /in the next (\d+)\s+(day|week|month|year)s?/i.exec(text);
    const withinWindow = /within (\d+)\s+(day|week|month|year)s?/i.exec(text);
    let timeWindow: GoalDraftField<{ start: string; end: string }> = unknown(
      "no time window was stated in the input",
    );
    if (relativeWindow || withinWindow) {
      const match = (relativeWindow ?? withinWindow) as RegExpExecArray;
      const amount = Number(match[1]);
      const unit = (match[2] ?? "day").toLowerCase();
      const days =
        unit === "day"
          ? amount
          : unit === "week"
            ? amount * 7
            : unit === "month"
              ? amount * 30
              : amount * 365;
      const start = relativeWindow ? toIsoDate(now) : addDays(now, -days);
      const end = addDays(now, days);
      timeWindow = field(
        { start, end },
        "explicit",
        `interpreted "${match[0].trim()}" relative to the reference date`,
      );
    }

    // --- Market -----------------------------------------------------------
    let market: GoalDraftField<string> = unknown(
      "no market was stated and none could be taken from the Business Brain",
    );
    const marketPhrase =
      phrasesAfter(text, /\b(?:in|for|from|targeting|within)\s+(?:the\s+)?/i).find(
        (phrase) => !TEMPORAL_OR_QUANTITY.test(phrase),
      ) ?? phraseAfter(text, /\b(?:market|industry|vertical|sector)\s*[:=]?\s*/i);
    if (marketPhrase && !TEMPORAL_OR_QUANTITY.test(marketPhrase)) {
      market = field<string>(marketPhrase, "explicit", `read from the input`);
    } else if (context.company?.market) {
      market = field<string>(
        context.company.market,
        "inferred",
        `taken from the canonical Business Brain company market "${context.company.market}"`,
      );
    }

    // --- Offer reference --------------------------------------------------
    // Every "using/with/via …" candidate is tried; the first that resolves to
    // a canonical offer wins. `for` is deliberately not a trigger: it
    // introduces a market far more often than an offer.
    const offerCandidates = phrasesAfter(
      text,
      /\b(?:using|with|via|leveraging|through)\s+(?:the\s+|our\s+|their\s+|an?\s+)?/i,
    );
    let offerId: GoalDraftField<string> = unknown("no offer was referenced in the input");
    const unresolvedReferences: GoalDraft["unresolvedReferences"] = [];
    for (const candidate of offerCandidates) {
      const matched = matchByName(context.offers, candidate);
      if (matched) {
        offerId = field<string>(
          matched.id,
          "inferred",
          `resolved "${candidate}" to Business Brain offer "${matched.name}"`,
        );
        break;
      }
    }
    if (offerId.value === null && offerCandidates.length > 0) {
      // Nothing resolved. Report the candidate that actually looked like an
      // offer, so the gap is specific instead of pointing at a stray clause.
      const offered =
        offerCandidates.find((c) => GENERIC_NOUNS.test(c)) ?? (offerCandidates[0] as string);
      unresolvedReferences.push({ kind: "offer", value: offered });
    }

    // --- ICP / personas ---------------------------------------------------
    let icpId: GoalDraftField<string> = unknown("no ICP reference was resolved");
    if (context.icp) {
      icpId = field<string>(
        context.icp.id,
        "inferred",
        "the workspace has a single canonical Business Brain ICP",
      );
    }

    let buyerPersonaIds: GoalDraftField<string[]> = unknown(
      "no buyer personas were resolved from the input",
    );
    const buyerWord =
      /\b(?:targeting|aiming at|for)\s+(?:founders?|revenue leaders?|decision makers?|the\s+\w+\s+role)?/i.exec(
        text,
      );
    if (buyerWord) {
      const buyerPhrase = phraseAfter(text, /\b(?:targeting|aiming at)\s+/i);
      if (buyerPhrase) {
        const matchedPersona = context.personas.find((p) =>
          p.title.trim().toLowerCase().includes(buyerPhrase.trim().toLowerCase()),
        );
        if (matchedPersona) {
          buyerPersonaIds = field<string[]>(
            [matchedPersona.id],
            "inferred",
            `resolved "${buyerPhrase}" to Business Brain persona "${matchedPersona.title}"`,
          );
        } else {
          unresolvedReferences.push({ kind: "persona", value: buyerPhrase });
        }
      }
    }

    // --- Minimum contract value -------------------------------------------
    const contractValue =
      /contract value (?:above|over|of|at least|greater than)\s*([$€£¥])\s?([\d][\d,]*(?:\.\d+)?)\s*(k|K)?/i.exec(
        text,
      ) ??
      /((?:[A-Z]{3})\s?([\d][\d,]*(?:\.\d+)?))\s*(?:deal value|contract|average deal)/i.exec(text);
    let minimumContractValue: GoalDraftField<number> = unknown(
      "no contract-value floor was stated in the input",
    );
    if (contractValue) {
      const raw = contractValue[2] ?? contractValue[4];
      if (raw !== undefined) {
        const magnitude = contractValue[3];
        const amount =
          Number(raw.replace(/,/g, "")) * (magnitude === "k" || magnitude === "K" ? 1000 : 1);
        minimumContractValue = field<number>(
          amount,
          "explicit",
          `read from "${contractValue[0]?.trim() ?? ""}"`,
        );
      }
    }

    // --- Constraints ------------------------------------------------------
    const geographies = [...text.matchAll(/\b([A-Z]{2,3})\b/g)]
      .map((m) => m[1] ?? "")
      .filter((token) => GEOGRAPHY_CODES.has(token.toUpperCase()))
      .map((token) => token.toUpperCase());
    const uniqueGeographies = [...new Set(geographies)];
    const industries = context.company?.industry ? [context.company.industry] : [];
    const companySizes = [
      ...text.matchAll(/(\d+)\s*[-–]\s*(\d+)\s*(?:employees|staff|people)/gi),
    ].map((m) => `${m[1]}-${m[2]}`);
    const channels = [...text.matchAll(/\b(email|linkedin|call|phone|outbound)\b/gi)].map((m) =>
      (m[1] ?? "").toLowerCase(),
    );
    const uniqueChannels = [...new Set(channels)];

    const constraints = field<{
      geographies: string[];
      industries: string[];
      companySizes: string[];
      channels: string[];
    }>(
      {
        geographies: uniqueGeographies,
        industries,
        companySizes: [...new Set(companySizes)],
        channels: uniqueChannels,
      },
      uniqueGeographies.length > 0 ? "explicit" : "assumption",
      uniqueGeographies.length > 0
        ? "geographies read from the input"
        : "no explicit geography constraint was stated; empty by default",
    );

    return {
      input: text,
      fields: {
        objective,
        targetMetric,
        targetValue,
        currency,
        timeWindow,
        market,
        offerId,
        icpId,
        buyerPersonaIds,
        minimumContractValue,
        constraints,
      },
      unresolvedReferences,
    };
  }
}

/** Default parser instance used by the service factory. */
export const deterministicGoalParser = new DeterministicGoalParser();

/**
 * Adapt a canonical Business Brain context into the narrow snapshot the
 * parser is allowed to read.
 */
export function toBrainSnapshot(context: {
  workspaceId: string;
  company: { name: string; market: string | null; industry: string | null } | null;
  offers: { id: string; name: string }[];
  icp: { id: string } | null;
  personas: { id: string; title: string }[];
}): BusinessBrainSnapshot {
  return {
    workspaceId: context.workspaceId,
    company: context.company
      ? {
          name: context.company.name,
          market: context.company.market,
          industry: context.company.industry,
        }
      : null,
    offers: context.offers.map((o) => ({ id: o.id, name: o.name })),
    icp: context.icp,
    personas: context.personas,
  };
}
