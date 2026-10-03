import type { ResearchCategory } from "@dealora/db";

import type { QualificationGoalSnapshot, QualificationIcpSnapshot } from "./types.js";

/**
 * The rule set.
 *
 * Everything a score depends on that is not the account's own evidence lives
 * here, in one file, as data. That is the whole defence against a hidden
 * criterion: there is nowhere else for a heuristic to hide, and the criteria
 * are readable through the API before an account is ever evaluated.
 *
 * Bump {@link QUALIFICATION_RULE_VERSION} whenever a criterion, a dimension, a
 * threshold or a weight changes. Existing records keep the version that
 * produced them, so a score stays interpretable after the rules move on.
 */
export const QUALIFICATION_RULE_VERSION = "deterministic-1.0.0";

/** Every rule set this deployment implements. A caller may only ask for one of these. */
export const SUPPORTED_RULE_VERSIONS: readonly string[] = [QUALIFICATION_RULE_VERSION];

/**
 * The five scoring dimensions, exactly as `ROADMAP.md` §15 names them and
 * exactly as `DEALORA_BLUEPRINT.md` §12.5 assigns them to the Qualification
 * Agent ("evaluate ICP fit, evaluate need, evaluate company fit, evaluate
 * potential timing, evaluate buying signals").
 *
 * The list is closed and ordered. It is also the aggregation order, so a score
 * always breaks down in the same sequence.
 */
export const QUALIFICATION_DIMENSIONS = [
  "icp_fit",
  "need_fit",
  "buying_signal",
  "timing",
  "company_fit",
] as const;

export type QualificationDimensionName = (typeof QUALIFICATION_DIMENSIONS)[number];

/** The label each dimension is presented with, matching the roadmap's wording. */
export const QUALIFICATION_DIMENSION_LABELS: Record<QualificationDimensionName, string> = {
  icp_fit: "ICP Fit",
  need_fit: "Need Fit",
  buying_signal: "Buying Signal",
  timing: "Timing",
  company_fit: "Company Fit",
};

/** What one dimension is for, in the user's terms. */
export const QUALIFICATION_DIMENSION_PURPOSES: Record<QualificationDimensionName, string> = {
  icp_fit: "Whether the account matches the industries, geographies and exclusions of the ICP.",
  need_fit:
    "Whether the account shows the operational problem the offer addresses, using the signal taxonomy the Revenue Plan defines.",
  buying_signal:
    "Whether a permitted source observed a buying signal: a relevant new decision-maker, or the account scaling.",
  timing:
    "Whether a permitted source observed account activity inside the time window of the Revenue Goal being worked to.",
  company_fit: "Whether the account's size and business model fit the ICP.",
};

/**
 * How a criterion decides.
 *
 * - `term_match` — a named account claim must state one of the ICP's terms.
 * - `term_absent` — no eligible account claim may state one of the ICP's
 *   exclusion terms. The only criterion that can fail on the *absence* of a
 *   match, and only after there is at least one claim to compare.
 * - `category_present` — at least one eligible claim must exist in the
 *   named research categories.
 * - `observed_in_window` — at least one eligible claim in the named
 *   categories must carry supporting evidence observed inside the Revenue
 *   Goal's time window.
 */
export type CriterionKind =
  "term_match" | "term_absent" | "category_present" | "observed_in_window";

/** Which ICP list a term criterion reads. */
export type IcpList =
  "industries" | "companySizes" | "geographies" | "businessModels" | "disqualifiers";

export interface CriterionRule {
  dimension: QualificationDimensionName;
  /** Stable key, unique within the rule version. */
  criterion: string;
  kind: CriterionKind;
  /** What the criterion is, in one line, for the criteria inspector. */
  label: string;
  /** Set for `term_match` / `term_absent`: which ICP list supplies the terms. */
  icpList: IcpList | null;
  /**
   * For `term_match`: the claim fields this criterion may read, in a fixed
   * priority order. The first field that carries a usable claim wins; a
   * *contested* claim stops the search rather than falling through, because
   * switching fields to escape a disagreement would resolve it by fiat.
   */
  claimFields: readonly string[];
  /** For the category criteria: the research categories this criterion reads. */
  categories: readonly ResearchCategory[];
  /** Static part of the expectation, before the ICP or goal is named. */
  expectation: string;
}

/**
 * Every criterion the engine evaluates.
 *
 * Each one is traceable to the source-of-truth model rather than to a
 * heuristic DEALORA invented:
 *
 * - `industry_match`, `geography_match`, `company_size`, `business_model` and
 *   `no_disqualifier` read the canonical {@link Icp} fields
 *   (`ROADMAP.md` §15 "does the account fit the user's target"; Phase 2's ICP).
 *   Note that nothing here says "more than 100 employees is good": the
 *   workspace states its sizes and DEALORA compares them.
 * - `hiring_signal` and `technology_signal` are the two signal definitions the
 *   Revenue Plan compiler itself emits for need ("role postings showing the
 *   account is hiring for the capability the offer addresses", "a stack change
 *   that raises or lowers the cost of the problem"), evaluated inside the Phase
 *   6 categories that can carry them.
 * - `leadership_change` and `expansion_signal` are the plan's other two
 *   observable signals ("a new decision-maker arriving with a mandate
 *   relevant to the offer", "new markets, offices, or product lines
 *   indicating the account is scaling the problem").
 * - `activity_in_window` is the only criterion that reads the Revenue Goal: it
 *   asks whether an observation lands inside the window the business committed
 *   to.
 *
 * The criteria deliberately do **not** include anything about a contact, a
 * persona, an offer's price or a deal size. No criterion in Phase 8 depends on
 * a person, because that is Phase 9's ground and DEALORA_BLUEPRINT.md §12.4
 * keeps contact selection a separate responsibility.
 */
export const QUALIFICATION_CRITERIA: readonly CriterionRule[] = [
  {
    dimension: "icp_fit",
    criterion: "industry_match",
    kind: "term_match",
    label: "industry matches a target industry",
    icpList: "industries",
    claimFields: ["industry.industry"],
    categories: [],
    expectation: "the account's industry evidence must state one of the workspace ICP industries",
  },
  {
    dimension: "icp_fit",
    criterion: "geography_match",
    kind: "term_match",
    label: "geography matches a target geography",
    icpList: "geographies",
    claimFields: ["company_overview.geography"],
    categories: [],
    expectation: "the account's geography evidence must state one of the workspace ICP geographies",
  },
  {
    dimension: "icp_fit",
    criterion: "no_disqualifier",
    kind: "term_absent",
    label: "no ICP exclusion applies",
    icpList: "disqualifiers",
    claimFields: [],
    categories: [],
    expectation: "no eligible account evidence may state one of the workspace ICP disqualifiers",
  },
  {
    dimension: "need_fit",
    criterion: "hiring_signal",
    kind: "category_present",
    label: "a hiring observation shows the capability the offer addresses",
    icpList: null,
    claimFields: [],
    categories: ["hiring"],
    expectation: "at least one source-backed hiring observation must exist for the account",
  },
  {
    dimension: "need_fit",
    criterion: "technology_signal",
    kind: "category_present",
    label: "a technology observation shows the operational problem",
    icpList: null,
    claimFields: [],
    categories: ["technology_signals"],
    expectation: "at least one source-backed technology observation must exist for the account",
  },
  {
    dimension: "buying_signal",
    criterion: "leadership_change",
    kind: "category_present",
    label: "a relevant new decision-maker was observed",
    icpList: null,
    claimFields: [],
    categories: ["leadership_changes"],
    expectation: "at least one source-backed leadership change must exist for the account",
  },
  {
    dimension: "buying_signal",
    criterion: "expansion_signal",
    kind: "category_present",
    label: "the account was observed scaling",
    icpList: null,
    claimFields: [],
    categories: ["expansion"],
    expectation: "at least one source-backed expansion observation must exist for the account",
  },
  {
    dimension: "timing",
    criterion: "activity_in_window",
    kind: "observed_in_window",
    label: "account activity was observed inside the revenue goal window",
    icpList: null,
    claimFields: [],
    categories: ["recent_announcements", "public_business_changes", "hiring", "expansion"],
    expectation:
      "at least one source-backed observation must fall inside the revenue goal time window",
  },
  {
    dimension: "company_fit",
    criterion: "company_size",
    kind: "term_match",
    label: "company size matches a target size",
    icpList: "companySizes",
    claimFields: ["company_overview.company_size", "company_overview.employee_count"],
    categories: [],
    expectation: "the account's size evidence must state one of the workspace ICP company sizes",
  },
  {
    dimension: "company_fit",
    criterion: "business_model",
    kind: "term_match",
    label: "business model matches a target business model",
    icpList: "businessModels",
    claimFields: ["business_model.model"],
    categories: [],
    expectation:
      "the account's business model evidence must state one of the workspace ICP business models",
  },
];

/** Bounded lengths for the strings a criterion result carries. */
export const LIMITS = {
  expectation: 300,
  reason: 300,
  observed: 2000,
} as const;

/**
 * Case-, punctuation- and whitespace-insensitive text, for comparing a
 * workspace's own wording against a source's wording.
 *
 * Deterministic and lossless enough to explain: "B2B SaaS", "b2b, saas" and
 * "  B2B   SaaS " all normalize to the same string, and a user can see
 * exactly what was compared in the criterion's `expectation` and `observed`.
 */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Does a source's statement satisfy one of the workspace's terms?
 *
 * Equality after normalization, or the term appearing as a whole word
 * sequence inside it. "B2B SaaS" satisfies the ICP term "saas"; "saasware"
 * does not, because there the term is not a word of its own.
 *
 * This is a *term* comparison, not a numeric one. A company size is matched as
 * the term the workspace wrote: DEALORA does not parse "10-200" into a range
 * and does not decide that a larger number is a better account. Those are
 * rules only the business can state, and Phase 8 has no authority to invent
 * them.
 */
export function matchesTerm(term: string, value: string): boolean {
  const wanted = normalizeForMatch(term);
  if (wanted === "") return false;
  const actual = normalizeForMatch(value);
  if (actual === "") return false;
  if (actual === wanted) return true;
  return ` ${actual} `.includes(` ${wanted} `);
}

/** The terms a criterion reads from the ICP, in the ICP's own order. */
export function icpTerms(icp: QualificationIcpSnapshot, list: IcpList): string[] {
  return icp[list].filter((term) => normalizeForMatch(term) !== "");
}

/**
 * Render the expectation a criterion is measured against.
 *
 * The rendered text is the *actual* rule for this workspace — the ICP's own
 * words, or the goal's own dates — and it is stored on the result, so the
 * stored record explains itself without the ICP being readable at all.
 */
export function renderExpectation(
  rule: CriterionRule,
  icp: QualificationIcpSnapshot,
  goal: QualificationGoalSnapshot | null,
): string {
  if (rule.kind === "observed_in_window") {
    const window =
      goal === null
        ? "no revenue goal is selected for this account"
        : `${goal.timeWindow.start} to ${goal.timeWindow.end}`;
    return `${rule.expectation} (${window})`;
  }
  if (rule.icpList !== null) {
    const terms = icpTerms(icp, rule.icpList);
    if (terms.length === 0) {
      return `${rule.expectation} (the workspace ICP states none)`;
    }
    return `${rule.expectation}: ${terms.join(", ")}`;
  }
  return rule.expectation;
}

/** Truncate to a bound without ever returning an empty string mid-word. */
export function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

/** JSON with object keys sorted, so equal content always serializes equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Deterministic digest of the business context an evaluation was measured
 * against.
 *
 * The qualification must not copy the Business Brain — a snapshot of the whole
 * Brain inside every evaluation would be both wasteful and a second source of
 * truth — but a historical score still has to stay interpretable. So the record
 * keeps the `icpId`, the `revenueGoalId` and this digest, exactly as a Phase 4
 * plan keeps `compilerVersion` and `brainSnapshotDigest`: enough to tell two
 * evaluations apart, never a copy of the thing itself.
 *
 * FNV-1a over a canonical (key-sorted) serialization: no randomness, no crypto
 * dependency, stable across processes. It is a fingerprint for comparison, not
 * a security primitive, and is labelled as one.
 */
export function contextDigest(
  ruleVersion: string,
  icp: QualificationIcpSnapshot,
  goal: QualificationGoalSnapshot | null,
): string {
  const canonical = canonicalJson({
    ruleVersion,
    icp,
    goal: goal === null ? null : { id: goal.id, timeWindow: goal.timeWindow },
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}
