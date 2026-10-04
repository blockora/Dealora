/**
 * Validation for the Next Best Action boundary.
 *
 * Deliberately the thinnest validation module in the repository, and that is the
 * design rather than an omission. Every other domain has to check a caller-supplied
 * payload because a caller supplies one. This boundary has a caller that names
 * **an account id and nothing else**: the action, the reason, the supporting
 * state, the confidence, the risk level, the approval requirement and the expected
 * outcome are all `ROADMAP.md` §21's *output*, derived server-side from stored
 * rows.
 *
 * There is therefore no `action`, no `reason`, no `confidence`, no `riskLevel`,
 * no `approvalRequired` and no `expectedOutcome` on any input type. Leaving them
 * off is what makes it impossible for a handler to pass one in by accident, and a
 * caller that sends them is ignored rather than trusted.
 */

import {
  BOARD_LIMIT,
  CONFIDENCE_ORDER,
  NEXT_ACTION_RISK_LEVELS,
  NEXT_ACTION_RULES,
  NEXT_ACTION_STATES,
  NEXT_BEST_ACTION_KINDS,
  NEXT_ACTION_RULE_VERSION,
  TERMINAL_MEETING_STATES,
  isNextActionKind,
} from "./rules.js";
import type { NextActionPolicyView, NextActionRuleView, NextBestActionKind } from "./types.js";

/** A trimmed, non-empty string within bounds, or `null`. */
export function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length <= max ? trimmed : null;
}

/**
 * Parse an optional `action` filter on the list routes.
 *
 * Three answers on purpose: `undefined` for "not supplied", a string for a kind
 * this deployment can actually produce, and `null` for anything else. An unknown
 * kind is a **validation error** rather than an empty result — a caller who named
 * a recommendation kind this engine does not produce has sent a bad request, and
 * handing back an empty list would look like an answer.
 */
export function parseActionFilter(value: unknown): NextBestActionKind | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isNextActionKind(value)) return null;
  return value;
}

/**
 * The policy this deployment enforces, as data.
 *
 * Readable before a workspace has a single account, so a workspace can see
 * exactly which states exist, what each one recommends, at which §17 level and
 * with which expected outcome — and, in the same place, everything the engine
 * refuses to do.
 */
export function describeNextActionPolicy(): NextActionPolicyView {
  const rules: NextActionRuleView[] = NEXT_ACTION_RULES.map((rule) => ({
    supportingState: rule.supportingState,
    action: rule.action,
    riskLevel: rule.riskLevel,
    approvalRequired: rule.approvalRequired,
    expectedOutcome: rule.expectedOutcome,
  }));
  return {
    ruleVersion: NEXT_ACTION_RULE_VERSION,
    states: NEXT_ACTION_STATES,
    actions: NEXT_BEST_ACTION_KINDS,
    riskLevels: NEXT_ACTION_RISK_LEVELS,
    confidenceBands: CONFIDENCE_ORDER,
    rules,
    prerequisites: [
      "A Phase 8 evaluation and the Phase 12 classifications of this workspace's own account — DEALORA recommends against stored rows, never against a caller's assertion.",
      "For a meeting recommendation, the approval of a person already recorded against the Phase 13 booking; booking is never proposed ahead of a human.",
      "For any outreach recommendation, that the Phase 11 opt-out list is clear for the address at read time.",
    ],
    neverDoes: [
      "It never acts on a recommendation. There is no sender, no approver, no calendar, no scheduler and no queue in this phase, so reading a recommendation can never become an effect.",
      "It never sends a message or schedules an event on its own. Both are Level 2 external actions under DEALORA_BLUEPRINT.md §17, and they are named here, never performed.",
      "It never writes to the Phase 7 evidence graph. A next step is DEALORA's own inference about the workspace's records, not an attested fact about an account.",
      "It never produces a confidence percentage. Confidence is the weakest band among the records that produced the recommendation; there is no calibration data here from which a number could mean anything.",
      "It never recommends contact for a suppressed address. An opt-out outranks every other consideration about that account.",
      "It never invents a signal, a need, a decision maker or a next step. Every clause of every reason names something the engine actually read, so the account's own rows are the check.",
      "It never reaches an external system. This phase performs no network I/O of any kind and adds no provider seam.",
    ],
  };
}

/**
 * The meeting states the engine treats as a person's finished decision.
 *
 * Published with the policy so a workspace can see that `meeting_closed` is not
 * DEALORA giving up on an account — it is DEALORA declining to re-propose a
 * meeting over the top of a cancellation.
 */
export const MEETING_TERMINAL_STATES = TERMINAL_MEETING_STATES;

/** The board cap, published so a caller can size its request. */
export const MAX_BOARD_ACCOUNTS = BOARD_LIMIT;
