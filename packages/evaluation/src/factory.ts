/**
 * Store integration for Agent Evaluation.
 *
 * The tenant boundary lives in storage, not here: every method on the lookup is
 * workspace-scoped inside the repository with the caller's own identity, so this
 * factory only wires — it never widens a scope, never caches a row and never
 * decides a verdict of its own.
 *
 * The lookup declares only the fields evaluation reads and writes, so the
 * concrete store's rows are structurally assignable and the service never sees a
 * whole workspace or user object. There is deliberately no second, richer
 * interface: evaluation's only state is `(workspace, agent, version) → judged
 * observations`, and widening the surface here would be widening what a later
 * phase could reach without a decision having been made.
 */

import type { ProductionGateOutcome, ProductionGateResolver } from "@dealora/agent";

import { EvaluationService } from "./service.js";
import type {
  EvaluationObservationRow,
  EvaluationRepository,
  EvaluationRunRow,
  EvaluationStorageResult,
} from "./types.js";

/** The minimum evaluation needs from storage. Every call is scoped. */
export interface EvaluationLookup {
  authorize(workspaceId: string, userId: string): EvaluationStorageResult<unknown>;
  createAgentEvaluationRun(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): EvaluationStorageResult<EvaluationRunRow>;
  getCurrentAgentEvaluationRun(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): EvaluationStorageResult<EvaluationRunRow | null>;
  listAgentEvaluationRuns(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): EvaluationStorageResult<readonly EvaluationRunRow[]>;
  createAgentEvaluationObservation(input: {
    workspaceId: string;
    userId: string;
    runId: string;
    metric: string;
    subjectId: string;
    verdict: string | null;
    amountMinor: number | null;
    durationMs: number | null;
    note: string | null;
  }): EvaluationStorageResult<EvaluationObservationRow>;
  listAgentEvaluationObservations(
    workspaceId: string,
    userId: string,
    runId: string,
  ): EvaluationStorageResult<readonly EvaluationObservationRow[]>;
}

/**
 * Wire evaluation to storage.
 *
 * Everything is passed through unchanged: the thresholds live in `rules.ts`, the
 * arithmetic in `engine.ts`, and this function's whole job is to prove — by its
 * types — that the service can reach nothing except workspace-scoped
 * evaluation rows.
 */
export function createEvaluationService(lookup: EvaluationLookup): EvaluationService {
  const repo: EvaluationRepository = { ...lookup };
  return new EvaluationService(repo);
}

/**
 * The promotion gate, in the shape `@dealora/agent` consumes.
 *
 * The registry asks this one question — "may this exact agent version reach
 * `production`?" — and gets an answer derived from stored judgements. That is
 * the whole contract, and it is deliberately a *function* rather than a boolean
 * so the question is asked fresh, against the caller's own workspace, at the
 * moment of the transition.
 *
 * Two properties are worth stating:
 *
 * - **It cannot be satisfied by a caller.** There is no argument that carries a
 *   verdict, an override or a flag; the only inputs are the workspace, the
 *   session, the agent and the version the registry already resolved.
 * - **It cannot be wired wrong into an unsafe answer.** A storage failure is
 *   mapped to `satisfied: false` with the reason, so an outage denies promotion
 *   rather than allowing it. Failing open here would turn a database problem
 *   into an unevaluated agent in production.
 */
export function createProductionGate(service: EvaluationService): ProductionGateResolver {
  return ({ workspaceId, userId, agentId }) => {
    const decision = service.gate(workspaceId, userId, agentId);
    if (!decision.ok) {
      const refused: ProductionGateOutcome = {
        satisfied: false,
        reason: `the evaluation evidence could not be read (${decision.error.code}), so the gate refuses rather than admitting an unmeasured agent.`,
      };
      return refused;
    }
    return decision.value;
  };
}
