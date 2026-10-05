/**
 * Store integration for the Agent Registry.
 *
 * The tenant boundary lives in storage, not here: every method on the lookup
 * is workspace-scoped inside the repository with the caller's own identity, so
 * this factory only wires — it never widens a scope, never caches a row and
 * never decides a state of its own.
 *
 * The lookup declares only the fields the registry reads, so the concrete
 * store's rows are structurally assignable and the service never sees a whole
 * workspace or user object. There is deliberately no second, richer interface:
 * the registry's only state is `(workspace, agent) → lifecycle state`, and
 * widening the surface here would be widening what a future phase could reach
 * without a decision having been made.
 */

import { AgentService } from "./service.js";
import type {
  AgentRegistryEvent,
  AgentRegistryRepository,
  AgentRegistryRow,
  ProductionGateResolver,
  StorageResult,
} from "./types.js";

/** The minimum the registry needs from storage. Every call is scoped. */
export interface AgentRegistryLookup {
  authorize(workspaceId: string, userId: string): StorageResult<unknown>;
  listAgentRegistry(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly AgentRegistryRow[]>;
  getAgentRegistry(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): StorageResult<AgentRegistryRow | null>;
  listAgentRegistryEvents(
    workspaceId: string,
    userId: string,
    agentId?: string,
  ): StorageResult<readonly AgentRegistryEvent[]>;
  setAgentStatus(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    status: string;
  }): StorageResult<AgentRegistryRow>;
}

/**
 * Wire the registry to storage, and optionally to Phase 19's evaluation gate.
 *
 * Everything is passed through unchanged: the lifecycle rules live in
 * `rules.ts`, the derivations in `engine.ts`, and this function's whole job
 * is to prove — by its types — that the service can reach nothing except
 * workspace-scoped registry rows and the governance trail.
 *
 * `gate` is optional because omitting it is the *safer* configuration, not a
 * wider one: with no resolver, `approved → production` is refused with the
 * published wording. A deployment that has not wired `@dealora/evaluation`
 * therefore cannot promote an agent by omission, only by measuring it.
 */
export function createAgentService(
  lookup: AgentRegistryLookup,
  gate?: ProductionGateResolver,
): AgentService {
  const repo: AgentRegistryRepository = { ...lookup };
  return new AgentService(repo, gate);
}
