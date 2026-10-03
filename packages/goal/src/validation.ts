import type { GoalMetricKind, RevenueGoalStatus } from "@dealora/db";

import { goalError } from "./types.js";
import type { GoalError } from "./types.js";

export { goalError };

/**
 * Goal validation.
 *
 * Three outcomes are distinguished:
 *   - INVALID    — the goal cannot be stored (missing objective, non-positive
 *                  target, malformed dates, bad currency). Rejected outright.
 *   - INCOMPLETE — the goal is storable and useful, but some fields could not
 *                  be determined. The gaps are recorded on the goal.
 *   - VALID      — everything required to measure the outcome is present.
 *
 * The engine deliberately does not over-constrain: a goal may be incomplete
 * without being corrupt.
 */

export const LIMITS = {
  objective: 2000,
  currency: 3,
  metricTarget: 1e15,
  metrics: 20,
} as const;

/** A field the goal still needs before it can be measured. */
export interface Gap {
  field: string;
  reason: string;
}

export class FieldIssues {
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

  toError(message = "validation failed"): GoalError {
    return goalError("VALIDATION_ERROR", message, this.all());
  }
}

/** Valid currency: a 3-letter ISO-4217-shaped code. */
export function isValidCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/** Valid ISO calendar date (`YYYY-MM-DD`) that also exists. */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Reject roll-over dates such as 2026-02-31.
  return parsed.toISOString().slice(0, 10) === value;
}

/** A start strictly before the end. Equal dates are allowed (single-day goal). */
export function isValidTimeWindow(start: string, end: string): boolean {
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) return false;
  return start <= end;
}

export function isValidMetricTarget(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= LIMITS.metricTarget;
}

/**
 * Validate the parts of a goal that must always be sound.
 *
 * Returns a `GoalError` when the goal is invalid, otherwise `null`.
 */
export function validateGoalCore(input: {
  objective: unknown;
  targetMetric: unknown;
  targetValue: unknown;
  currency: unknown;
  timeWindow: { start: unknown; end: unknown } | null;
  status?: unknown;
}): GoalError | null {
  const issues = new FieldIssues();

  if (typeof input.objective !== "string" || input.objective.trim() === "") {
    issues.add("objective", "objective must be a non-empty string");
  } else if (input.objective.length > LIMITS.objective) {
    issues.add("objective", `objective must be at most ${LIMITS.objective} characters`);
  }

  if (typeof input.targetMetric !== "string") {
    issues.add("targetMetric", "targetMetric is required");
  }

  if (typeof input.targetValue !== "number" || !isValidMetricTarget(input.targetValue)) {
    issues.add("targetValue", "targetValue must be a number greater than 0");
  }

  if (input.currency !== null && input.currency !== undefined) {
    if (typeof input.currency !== "string" || !isValidCurrency(input.currency)) {
      issues.add("currency", "currency must be a 3-letter code such as USD");
    }
  }

  if (input.timeWindow !== null && input.timeWindow !== undefined) {
    const { start, end } = input.timeWindow;
    if (typeof start !== "string" || typeof end !== "string") {
      issues.add("timeWindow", "timeWindow must have string start and end dates");
    } else if (!isValidIsoDate(start)) {
      issues.add("timeWindow.start", "start must be a valid YYYY-MM-DD date");
    } else if (!isValidIsoDate(end)) {
      issues.add("timeWindow.end", "end must be a valid YYYY-MM-DD date");
    } else if (!isValidTimeWindow(start, end)) {
      issues.add("timeWindow", "start must not be after end");
    }
  }

  if (issues.length > 0) return issues.toError();
  return null;
}

/**
 * Decide whether a structurally valid goal is complete enough to measure.
 *
 * Gaps are returned so the caller can persist them on the goal rather than
 * silently filling them in.
 */
export function assessCompleteness(goal: {
  timeWindow: { start: string; end: string } | null;
  successMetrics: readonly unknown[];
  offerId: string | null;
  market: string | null;
}): { completeness: "complete" | "incomplete"; gaps: Gap[] } {
  const gaps: Gap[] = [];
  if (!goal.timeWindow) {
    gaps.push({ field: "timeWindow", reason: "no time window was determined" });
  }
  if (goal.successMetrics.length === 0) {
    gaps.push({ field: "successMetrics", reason: "no success metric was determined" });
  }
  if (!goal.offerId) {
    gaps.push({ field: "offerId", reason: "no Business Brain offer is referenced" });
  }
  if (!goal.market) {
    gaps.push({ field: "market", reason: "no target market was determined" });
  }
  return { completeness: gaps.length === 0 ? "complete" : "incomplete", gaps };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Allowed status transitions.
 *
 * `archived` is terminal. A goal cannot jump from draft straight to
 * completed, because that would skip the active phase the workflow runs in.
 */
export const GOAL_TRANSITIONS: Record<RevenueGoalStatus, readonly RevenueGoalStatus[]> = {
  draft: ["active", "archived"],
  active: ["paused", "completed", "archived"],
  paused: ["active", "archived"],
  completed: ["archived"],
  archived: [],
};

export const GOAL_STATUSES: readonly RevenueGoalStatus[] = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
];

/**
 * Validate a status transition.
 *
 * Transitions are checked server-side against the stored status; a client can
 * request a new status but can never assert the current one.
 */
export function assertTransition(from: RevenueGoalStatus, to: RevenueGoalStatus): GoalError | null {
  if (!GOAL_STATUSES.includes(to)) {
    return goalError("VALIDATION_ERROR", `unknown status: ${String(to)}`, [
      { field: "status", message: `status must be one of: ${GOAL_STATUSES.join(", ")}` },
    ]);
  }
  const allowed = GOAL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return goalError("INVALID_TRANSITION", `cannot move a goal from ${from} to ${to}`, [
      { field: "status", message: `allowed from ${from}: ${allowed.join(", ") || "none"}` },
    ]);
  }
  return null;
}

/** Default metric unit for a metric kind. */
export const METRIC_UNITS: Record<GoalMetricKind, string> = {
  revenue: "currency",
  pipeline: "currency",
  qualified_opportunity: "count",
  meeting: "count",
  customer: "count",
  conversion_rate: "percent",
  time_to_target: "days",
};
