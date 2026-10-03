import { normalizeText } from "@dealora/account";
import type { QualificationDimension, QualificationState } from "@dealora/db";

import {
  QUALIFICATION_CRITERIA,
  QUALIFICATION_DIMENSION_LABELS,
  QUALIFICATION_DIMENSION_PURPOSES,
  QUALIFICATION_DIMENSIONS,
  SUPPORTED_RULE_VERSIONS,
} from "./rules.js";

/**
 * Validation and the read models a caller inspects.
 *
 * Every function here is pure: the current time arrives as a parameter, nothing
 * reads global state and nothing performs I/O.
 */

/** Collect field-level issues, as the other domain packages do. */
export class QualificationIssues {
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
}

/** A trimmed, whitespace-collapsed string, or null when absent/blank. */
export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeText(value);
  return normalized === "" ? null : normalized;
}

/** Is this a rule set this deployment implements? */
export function isSupportedRuleVersion(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_RULE_VERSIONS.includes(value);
}

/** Is this a dimension the closed vocabulary contains? */
export function isQualificationDimension(value: unknown): value is QualificationDimension {
  return (
    typeof value === "string" && (QUALIFICATION_DIMENSIONS as readonly string[]).includes(value)
  );
}

/** Is this a state the closed vocabulary contains? */
export function isQualificationState(value: unknown): value is QualificationState {
  return (
    typeof value === "string" &&
    (["qualified", "unqualified", "insufficient_data", "contested"] as string[]).includes(value)
  );
}

/**
 * The criteria a workspace is about to be measured against.
 *
 * Returned *before* an account is evaluated, so the rules are inspectable on
 * their own terms rather than only as a by-product of a score. This is the
 * phase's answer to "do not implement hidden criteria": the same data the
 * evaluator walks is the data this view prints.
 */
export interface QualificationCriteriaView {
  /** The rule set that produced this view. */
  ruleVersion: string;
  /** Every rule set this deployment can evaluate. */
  supportedRuleVersions: string[];
  dimensions: {
    dimension: QualificationDimension;
    label: string;
    purpose: string;
    criteria: {
      criterion: string;
      label: string;
      /** The rendered expectation, with this workspace's own ICP and goal. */
      expectation: string;
      /** What kind of evidence the criterion requires. */
      requires: string;
    }[];
  }[];
}

/** Build the inspector view from the rule set and the resolved context. */
export function describeCriteria(input: {
  ruleVersion: string;
  expectations: ReadonlyMap<string, string>;
}): QualificationCriteriaView {
  return {
    ruleVersion: input.ruleVersion,
    supportedRuleVersions: [...SUPPORTED_RULE_VERSIONS],
    dimensions: QUALIFICATION_DIMENSIONS.map((dimension) => ({
      dimension,
      label: QUALIFICATION_DIMENSION_LABELS[dimension],
      purpose: QUALIFICATION_DIMENSION_PURPOSES[dimension],
      criteria: QUALIFICATION_CRITERIA.filter((rule) => rule.dimension === dimension).map(
        (rule) => ({
          criterion: rule.criterion,
          label: rule.label,
          expectation: input.expectations.get(rule.criterion) ?? rule.expectation,
          requires: requirementOf(rule.kind, rule.categories),
        }),
      ),
    })),
  };
}

/** A plain-language statement of what a criterion kind demands. */
function requirementOf(kind: string, categories: readonly string[]): string {
  switch (kind) {
    case "term_match":
      return "a source-backed account claim naming one of the listed ICP terms";
    case "term_absent":
      return `at least one readable account claim, none of which states an ICP exclusion${
        categories.length > 0 ? ` (${categories.join(", ")})` : ""
      }`;
    case "category_present":
      return `a source-backed claim in ${categories.join(" or ")}`;
    default:
      return `a source-backed claim in ${categories.join(
        " or ",
      )} whose evidence carries an observation date inside the revenue goal window`;
  }
}

/**
 * The lifecycle question, answered once.
 *
 * There is no `canTransitionQualification`. A qualification is an immutable,
 * versioned evaluation: re-evaluating an account inserts a new record rather
 * than moving the old one, so there is no state for a caller to advance and no
 * path by which a historical score can be rewritten. Approval is Phase 10
 * (`ROADMAP.md` §17) and prioritization is Phase 14; importing either
 * vocabulary here would let a qualification look like something it is not.
 */
export const QUALIFICATIONS_ARE_IMMUTABLE = true;
