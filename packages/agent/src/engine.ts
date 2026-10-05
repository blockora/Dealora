/**
 * @dealora/agent — pure derivations for the Phase 18 registry.
 *
 * Everything here is a function of its arguments and the constant tables in
 * `rules.ts`. No clock, no randomness, no store, no network, no model: a given
 * set of rows and a given call always produce byte-identical output. The order
 * is total, because it is `AGENT_IDS` — a constant table of unique ids — rather
 * than anything the store or `Object.keys` could influence.
 *
 * The registry reads **one** row kind: a per-workspace lifecycle state. There is
 * no second copy of a declaration in storage. A declaration is code, versioned
 * here, and the store holds only what a workspace's people have decided about
 * it — which is also what makes the Phase 19 promotion gate meaningful later:
 * there is exactly one place a promotion would have to be recorded.
 */

import {
  AGENT_DECLARATIONS,
  AGENT_EVALUATION_METRICS,
  AGENT_GATED_TRANSITIONS,
  AGENT_IDS,
  AGENT_MEMORY_LAYERS,
  AGENT_NEVER_DOES,
  AGENT_PERMISSIONS,
  AGENT_PROMOTION_RULE,
  AGENT_REQUIRED_FIELDS,
  AGENT_RULE_VERSION,
  AGENT_STATE_ORDER,
  AGENT_TOOLS,
  AGENT_TRANSITIONS,
  MEETABLE_AGENT_STATES,
  declarationFor,
  isAgentId,
} from "./rules.js";
import type {
  AgentId,
  AgentPolicyView,
  AgentRegistryEvent,
  AgentRegistryRow,
  AgentRegistryView,
  AgentState,
  ProductionGateOutcome,
  RegisteredAgent,
} from "./types.js";

/** Why a transition was refused, with the phase that will own it instead. */
export interface TransitionRefusal {
  readonly allowed: false;
  readonly reason: string;
  readonly owningPhase: string | null;
}

/** A transition the lifecycle permits. */
export interface TransitionAllowed {
  readonly allowed: true;
  readonly reason: string;
}

export type TransitionDecision = TransitionAllowed | TransitionRefusal;

/**
 * Decide one lifecycle transition.
 *
 * Three outcomes, checked in this order so the answer is always specific:
 *
 * 1. **Gated.** `approved → production` is a published edge that exists only
 *    while an external gate says it may, and Phase 19 owns that gate. The check
 *    comes first on purpose: a caller must never be told "that pair is not in
 *    the table" for the one pair whose absence is a decision rather than an
 *    oversight. The gate is **fail-closed**: with no gate supplied — an
 *    unwired deployment, a unit test, a future caller — the answer is the
 *    Phase 18 refusal, verbatim, naming Phase 19.
 * 2. **Same state.** A no-op transition is allowed and performs no write, so a
 *    repeated request is idempotent rather than an error.
 * 3. **In the table.** Everything else is decided by `AGENT_TRANSITIONS`; an
 *    absent pair is refused with the ordered states quoted, because the legal
 *    alternatives are what a caller needs to know.
 *
 * A satisfied gate does not skip step 3: the edge still has to be published,
 * so a gate can never introduce a transition the lifecycle does not have.
 */
export function decideTransition(
  from: AgentState,
  to: AgentState,
  gate?: ProductionGateOutcome,
): TransitionDecision {
  const gated = AGENT_GATED_TRANSITIONS.find((entry) => entry.from === from && entry.to === to);
  if (gated && !(gate !== undefined && gate.satisfied)) {
    const detail =
      gate === undefined ? gated.refusalReason : `${gated.refusalReason} ${gate.reason}`;
    return { allowed: false, reason: detail, owningPhase: gated.owningPhase };
  }
  if (from === to) {
    return { allowed: true, reason: "The agent is already in this state; nothing changes." };
  }
  const published = AGENT_TRANSITIONS.find((entry) => entry.from === from && entry.to === to);
  if (published) {
    return { allowed: true, reason: published.reason };
  }
  return {
    allowed: false,
    reason: `The agent lifecycle does not allow ${from} → ${to}.`,
    owningPhase: null,
  };
}

/** Whether one transition would be permitted, for callers that need no reason. */
export function transitionAllowed(
  from: AgentState,
  to: AgentState,
  gate?: ProductionGateOutcome,
): boolean {
  return decideTransition(from, to, gate).allowed;
}

/**
 * The state an agent starts in, whether or not the workspace has a row.
 *
 * An unregistered agent reads as its declaration's `initialState`, which is
 * `draft` for all twelve. That is the honest answer — nothing has been decided
 * about it yet — and it means an empty registry is a real, readable state
 * rather than a null the caller has to interpret.
 */
export function stateFor(rows: readonly AgentRegistryRow[], agentId: AgentId): AgentState {
  const row = rows.find((entry) => entry.agentId === agentId);
  return row ? row.status : "draft";
}

/** Whether an agent may be used in its current state. Empty in Phase 18. */
export function isUsable(status: AgentState): boolean {
  // `some` rather than `includes` so the narrower usable-state type widens to
  // `AgentState` at the comparison instead of needing a cast at the call.
  return MEETABLE_AGENT_STATES.some((usable) => usable === status);
}

/**
 * One registry entry, assembled from its declaration and its stored state.
 *
 * Takes the id as a `string` and narrows it here, so a caller holding
 * unvalidated input reaches the `null` branch honestly instead of asserting
 * its way past the guard.
 */
export function deriveRegisteredAgent(
  rows: readonly AgentRegistryRow[],
  agentId: string,
): RegisteredAgent | null {
  if (!isAgentId(agentId)) return null;
  const declaration = declarationFor(agentId);
  if (!declaration) return null;
  const row = rows.find((entry) => entry.agentId === agentId);
  const status = stateFor(rows, agentId);
  return {
    declaration,
    status,
    usable: isUsable(status),
    updatedBy: row ? row.updatedBy : null,
    updatedAt: row ? row.updatedAt : null,
  };
}

/**
 * The workspace's whole registry: one entry per declared agent, in roadmap
 * order.
 *
 * Always exactly twelve entries. An agent with no stored row appears with its
 * declaration's initial state and no updater, which is what makes an empty
 * workspace produce a complete, honest registry instead of an empty list.
 */
export function deriveRegistryView(rows: readonly AgentRegistryRow[]): AgentRegistryView {
  return {
    ruleVersion: AGENT_RULE_VERSION,
    agents: AGENT_IDS.map((agentId) => deriveRegisteredAgent(rows, agentId)).filter(
      (entry): entry is RegisteredAgent => entry !== null,
    ),
  };
}

/**
 * The governance events for a workspace, newest first.
 *
 * The sort is deliberately **stable with no id tiebreak**. Several decisions
 * can land in the same millisecond — the store's clock has millisecond
 * resolution — and an id tiebreak would then order them by a randomly generated
 * identifier, so the same decisions could print in different orders on
 * different runs. A stable sort leaves ties in the order storage returned them,
 * which is the order they were made, so the trail reads as a history.
 *
 * The input is copied rather than sorted in place: the caller's array is left
 * exactly as it was.
 */
export function sortRegistryEvents(
  events: readonly AgentRegistryEvent[],
): readonly AgentRegistryEvent[] {
  // `Array.prototype.sort` is specified as stable, so equal timestamps keep
  // their input order — the decisions' own order.
  return [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The whole published rule set, readable before anything is registered.
 *
 * This is what a reviewer reads to learn what the system permits without
 * changing any state: which agents exist, which transitions exist, which phase
 * executes each tool, and — the point of the whole table — that `production` is
 * not one of the states anything can currently be used in.
 */
export function derivePolicyView(): AgentPolicyView {
  return {
    ruleVersion: AGENT_RULE_VERSION,
    agents: AGENT_DECLARATIONS.map((declaration) => ({
      agentId: declaration.agentId,
      version: declaration.version,
      owner: declaration.owner,
      purpose: declaration.purpose,
      tools: declaration.tools,
      permissions: declaration.permissions,
      memoryAccess: declaration.memoryAccess,
      approvalRequired: declaration.approvalRequired,
      maxRiskLevel: declaration.maxRiskLevel,
      costLimits: declaration.costLimits,
      evaluationMetrics: declaration.evaluationMetrics,
      model: declaration.model,
      initialState: declaration.initialState,
    })),
    states: AGENT_STATE_ORDER,
    transitions: AGENT_TRANSITIONS,
    tools: AGENT_TOOLS,
    permissions: AGENT_PERMISSIONS,
    memoryLayers: AGENT_MEMORY_LAYERS,
    evaluationMetrics: AGENT_EVALUATION_METRICS,
    usableStates: MEETABLE_AGENT_STATES,
    promotionRule: AGENT_PROMOTION_RULE,
    requiredFields: AGENT_REQUIRED_FIELDS,
    neverDoes: AGENT_NEVER_DOES,
  };
}
