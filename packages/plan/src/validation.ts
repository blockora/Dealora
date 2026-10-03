import type { PlanStatement, RevenuePlanStatus } from "@dealora/db";

import { planError } from "./types.js";
import type { PlanError, RevenuePlanDraft } from "./types.js";

export { planError };

/**
 * Plan validation and lifecycle.
 *
 * The compiler produces a draft; nothing is persisted until the draft passes
 * validation. A plan that cannot be inspected safely must not be stored.
 */

export const PLAN_STATUSES: readonly RevenuePlanStatus[] = [
  "draft",
  "proposed",
  "approved",
  "archived",
];

/**
 * Allowed plan transitions.
 *
 * Minimal by design (ROADMAP.md §11). `approved` records that a human accepted
 * the proposal; it never authorizes an external action, which is why the plan
 * carries `approval.approvesExternalActions: false` independently of status.
 */
export const PLAN_TRANSITIONS: Record<RevenuePlanStatus, readonly RevenuePlanStatus[]> = {
  draft: ["proposed", "archived"],
  proposed: ["approved", "draft", "archived"],
  approved: ["archived"],
  archived: [],
};

export const PLAN_STATEMENT_KINDS = [
  "fact",
  "inference",
  "assumption",
  "recommendation",
  "unknown",
] as const;

/** Collect field-level issues, as the goal and brain packages do. */
export class PlanIssues {
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

  toError(message = "validation failed"): PlanError {
    return planError("VALIDATION_ERROR", message, this.all());
  }
}

/**
 * Validate a compiled draft before it may be persisted.
 *
 * The checks that matter most are the honesty checks: every statement must be
 * classified, and a plan must never claim it approves external actions.
 */
export function validatePlanDraft(draft: RevenuePlanDraft): PlanError | null {
  const issues = new PlanIssues();

  if (typeof draft.revenueGoalId !== "string" || draft.revenueGoalId.trim() === "") {
    issues.add("revenueGoalId", "a plan must reference a revenue goal");
  }
  if (typeof draft.compilerVersion !== "string" || draft.compilerVersion.trim() === "") {
    issues.add("compilerVersion", "compilerVersion is required");
  }
  if (typeof draft.brainSnapshotDigest !== "string" || draft.brainSnapshotDigest.trim() === "") {
    issues.add("brainSnapshotDigest", "the Business Brain snapshot digest is required");
  }

  const sections = draft.strategies;
  if (!sections || typeof sections !== "object") {
    issues.add("strategies", "plan strategies are required");
  } else {
    // Every roadmap section must be present, even when the plan can say
    // nothing useful about it — that is what the `unknown` statements are for.
    for (const key of REQUIRED_SECTIONS) {
      if (!(key in sections) || sections[key] === undefined || sections[key] === null) {
        issues.add(`strategies.${key}`, `the ${key} strategy is required`);
      }
    }
  }

  validateStatements(issues, "strategies", statementsOf(sections));

  if (draft.approval?.approvesExternalActions !== false) {
    issues.add(
      "approval.approvesExternalActions",
      "a plan must never record that it approves external actions",
    );
  }

  // A plan with no measurement criteria cannot answer "how will success be
  // measured", which the phase gate requires.
  const kpis = sections?.measurement?.kpis;
  if (!Array.isArray(kpis) || kpis.length === 0) {
    issues.add("strategies.measurement.kpis", "a plan must define at least one measurable KPI");
  }

  if (typeof draft.rationale !== "string" || draft.rationale.trim() === "") {
    issues.add("rationale", "a plan must explain why it was proposed");
  }

  if (issues.length > 0) return issues.toError("the compiled plan is not valid");
  return null;
}

/** Sections the roadmap requires every plan to expose. */
export const REQUIRED_SECTIONS = [
  "icp",
  "buyer",
  "sourcing",
  "signal",
  "qualification",
  "outreach",
  "followUp",
  "meeting",
  "crm",
  "measurement",
  "optimization",
] as const satisfies readonly (keyof RevenuePlanDraft["strategies"])[];

/**
 * Every statement must carry a kind and non-empty text.
 *
 * An unclassified statement is the failure mode this phase exists to prevent:
 * a recommendation wearing a fact's clothes.
 */
function validateStatements(
  issues: PlanIssues,
  path: string,
  statements: readonly PlanStatement[],
): void {
  for (const [index, statement] of statements.entries()) {
    if (!statement || typeof statement !== "object") {
      issues.add(`${path}.statements[${index}]`, "statement must be an object");
      continue;
    }
    if (!PLAN_STATEMENT_KINDS.includes(statement.kind)) {
      issues.add(
        `${path}.statements[${index}].kind`,
        `statement kind must be one of: ${PLAN_STATEMENT_KINDS.join(", ")}`,
      );
    }
    if (typeof statement.text !== "string" || statement.text.trim() === "") {
      issues.add(`${path}.statements[${index}].text`, "statement text is required");
    }
    if (statement.kind === "unknown" && statement.basis !== "none") {
      issues.add(
        `${path}.statements[${index}].basis`,
        "an unknown statement must not claim a basis",
      );
    }
  }
}

/** Collect statements from anywhere in a strategies subtree. */
export function statementsOf(node: unknown): PlanStatement[] {
  const found: PlanStatement[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (key === "statements" && Array.isArray(child)) {
        for (const entry of child) found.push(entry as PlanStatement);
        continue;
      }
      walk(child);
    }
  };
  walk(node);
  return found;
}

/**
 * Validate a status transition.
 *
 * Transitions are checked server-side against the stored status, so a client
 * can request a new status but can never assert the current one.
 */
export function assertPlanTransition(
  from: RevenuePlanStatus,
  to: RevenuePlanStatus,
): PlanError | null {
  if (!PLAN_STATUSES.includes(to)) {
    return planError("VALIDATION_ERROR", `unknown plan status: ${String(to)}`, [
      { field: "status", message: `status must be one of: ${PLAN_STATUSES.join(", ")}` },
    ]);
  }
  const allowed = PLAN_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return planError("INVALID_TRANSITION", `cannot move a plan from ${from} to ${to}`, [
      { field: "status", message: `allowed from ${from}: ${allowed.join(", ") || "none"}` },
    ]);
  }
  return null;
}

/**
 * Preconditions a goal must satisfy before a plan may be compiled.
 *
 * An incomplete goal is refused rather than completed by guessing: the missing
 * fields are returned so the user can supply them.
 */
export function assertGoalCompilable(goal: {
  status: string;
  completeness: string;
  unknowns: readonly { field: string; reason: string }[];
}): PlanError | null {
  if (goal.status === "archived") {
    return planError("CONFLICT", "an archived revenue goal cannot be compiled into a plan", [
      { field: "revenueGoalId", message: "the goal is archived; restore or replace it first" },
    ]);
  }
  if (goal.completeness !== "complete") {
    const details = goal.unknowns.map((u) => ({
      field: u.field,
      message: u.reason,
    }));
    return planError(
      "VALIDATION_ERROR",
      "the revenue goal is incomplete and cannot be compiled into a plan",
      details.length > 0
        ? details
        : [{ field: "completeness", message: "the goal is missing required information" }],
    );
  }
  return null;
}
