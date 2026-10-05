/**
 * The Agent Registry application service — `ROADMAP.md` §25,
 * `DEALORA_BLUEPRINT.md` §30.
 *
 * The chain runs, every time:
 *
 *   authenticate → authorize (server-side) → read this workspace's own
 *   lifecycle rows → validate the transition against the published table →
 *   write → answer
 *
 * Three properties this service is built to hold:
 *
 * 1. **It never executes.** There is no runner here, no tool invocation and no
 *    model call. The only write it performs is a lifecycle state on a row, and
 *    the only reader is the declaration table in `rules.ts`. An agent holding
 *    the `send_message` tool has still sent nothing: Phase 10 approval and
 *    Phase 11 suppression are untouched by anything written here.
 * 2. **It cannot promote without evidence.** `approved → production` is gated.
 *    When the application has wired Phase 19's evaluation boundary, the gate is
 *    asked — with this workspace, this session, this agent and the version read
 *    from the declaration table — and the transition is refused unless the
 *    stored judgements meet every published threshold. When nothing is wired,
 *    the answer is the Phase 18 refusal: no gate means no promotion. The
 *    refusal is a domain error, so no caller can route around it by reaching for
 *    the store directly — the store takes the same table through this service.
 * 3. **It never trusts the caller.** The request carries an agent id and a
 *    target state and nothing else. The actor, the timestamp, the prior state
 *    and the workspace are resolved server-side; a client cannot set them, and
 *    cannot name an agent outside the twelve. A gate answer is never among the
 *    inputs either.
 */

import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";

import {
  decideTransition,
  derivePolicyView,
  deriveRegistryView,
  sortRegistryEvents,
} from "./engine.js";
import {
  AGENT_GATED_TRANSITIONS,
  agentError,
  declarationFor,
  isAgentId,
  isAgentState,
} from "./rules.js";
import type {
  AgentError,
  AgentPolicyView,
  AgentRegistryEvent,
  AgentRegistryRepository,
  AgentRegistryView,
  AgentState,
  ProductionGateResolver,
  StorageResult,
} from "./types.js";

/** Map a storage refusal onto the domain vocabulary, hiding internals. */
function fromStorage(
  error: { code: string; message?: string },
  notFoundMessage: string,
): AgentError {
  switch (error.code) {
    case "NOT_FOUND":
      return agentError("NOT_FOUND", notFoundMessage);
    case "UNAUTHORIZED":
      return agentError("UNAUTHORIZED", "workspace access denied");
    case "VALIDATION_ERROR":
    case "INVALID":
      // A rule the caller can act on, so it travels with its message.
      return agentError("VALIDATION_ERROR", error.message ?? "invalid value");
    default:
      // An internal condition is never surfaced verbatim.
      return agentError("UNAVAILABLE", "agent registry storage unavailable");
  }
}

/** Collapse a storage result onto the domain error vocabulary. */
function resultOr<T>(result: StorageResult<T>, notFoundMessage: string): Result<T, AgentError> {
  if (result.ok) return ok(result.value);
  return err(fromStorage(result.error, notFoundMessage));
}

/** Narrow an unknown to a non-empty trimmed string, or `null` (refuse). */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Whether this edge exists only while an external gate says it may. */
function isGatedTransition(from: AgentState, to: AgentState): boolean {
  return AGENT_GATED_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}

export class AgentService {
  /**
   * @param repo Workspace-scoped registry reads and writes.
   * @param gate Phase 19's evaluation boundary. Optional **only** in the sense
   *   that omitting it makes the registry stricter, never more permissive:
   *   with no gate, `approved → production` is refused with the published
   *   Phase 18 wording, so an unwired deployment cannot promote anything.
   */
  constructor(
    private readonly repo: AgentRegistryRepository,
    private readonly gate?: ProductionGateResolver,
  ) {}

  /** Authorize the caller against the workspace using server-side identity. */
  private guard(workspaceId: string, userId: string): Result<true, AgentError> {
    if (text(workspaceId) === null) {
      return err(agentError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (text(userId) === null) {
      return err(agentError("UNAUTHORIZED", "authentication required"));
    }
    const authorized = resultOr(this.repo.authorize(workspaceId, userId), "workspace not found");
    if (!authorized.ok) return authorized;
    return ok(true);
  }

  /**
   * The workspace's whole registry: twelve entries, in roadmap order, with the
   * lifecycle state its people have recorded.
   *
   * Read-only. It registers nothing and promotes nothing — an agent that has
   * never been touched reads as `draft`, which is a statement about what has
   * been decided rather than a gap in the data.
   */
  registry(workspaceId: string, userId: string): Result<AgentRegistryView, AgentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const rows = resultOr(
      this.repo.listAgentRegistry(workspaceId, userId),
      "agent registry not found",
    );
    if (!rows.ok) return rows;
    return ok(deriveRegistryView(rows.value));
  }

  /**
   * One agent's declaration and current state.
   *
   * An id outside the twelve is a `VALIDATION_ERROR` naming the rule, rather
   * than a `NOT_FOUND` that would let a caller probe the vocabulary: the answer
   * is the same regardless of whether such an agent exists anywhere.
   */
  describe(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Result<AgentRegistryView["agents"][number], AgentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (!isAgentId(agentId)) {
      return err(
        agentError("VALIDATION_ERROR", "unknown agent id", [
          { field: "agentId", message: "must name one of the twelve declared agents" },
        ]),
      );
    }
    const rows = resultOr(
      this.repo.listAgentRegistry(workspaceId, userId),
      "agent registry not found",
    );
    if (!rows.ok) return rows;
    const view = deriveRegistryView(rows.value);
    const found = view.agents.find((entry) => entry.declaration.agentId === agentId);
    if (!found) {
      // Unreachable while `AGENT_IDS` and `AGENT_DECLARATIONS` agree, which the
      // package test asserts — refused rather than asserted away.
      return err(agentError("NOT_FOUND", "agent not found"));
    }
    return ok(found);
  }

  /**
   * Move one agent to a new lifecycle state.
   *
   * The target state is the only client-supplied value. The prior state is read
   * from the workspace's own row, the actor is the authenticated caller, and
   * the decision comes from the published table — so a client cannot forge a
   * transition that the machine would not allow, and cannot forge the record of
   * who made it.
   *
   * A same-state request is answered without a write, so repeating a decision is
   * idempotent instead of producing a second governance event.
   */
  changeStatus(
    workspaceId: string,
    userId: string,
    agentId: string,
    status: string,
  ): Result<AgentRegistryView["agents"][number], AgentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (!isAgentId(agentId)) {
      return err(
        agentError("VALIDATION_ERROR", "unknown agent id", [
          { field: "agentId", message: "must name one of the twelve declared agents" },
        ]),
      );
    }
    if (!isAgentState(status)) {
      return err(
        agentError("VALIDATION_ERROR", "unknown agent state", [
          { field: "status", message: "must be one of the seven published lifecycle states" },
        ]),
      );
    }
    const declaration = declarationFor(agentId);
    if (!declaration) {
      return err(agentError("NOT_FOUND", "agent not found"));
    }

    const current = resultOr(
      this.repo.getAgentRegistry(workspaceId, userId, agentId),
      "agent registry entry not found",
    );
    if (!current.ok) return current;
    const from = current.value ? current.value.status : "draft";

    if (from === status) {
      return this.describe(workspaceId, userId, agentId);
    }

    // The gate is consulted only for a gated edge, and always with the caller's
    // own workspace and session plus the version read from the declaration
    // table — never from the request. An unwired gate yields `undefined`, which
    // `decideTransition` treats as a refusal.
    const decision = decideTransition(
      from,
      status,
      this.gate !== undefined && isGatedTransition(from, status)
        ? this.gate({ workspaceId, userId, agentId, version: declaration.version })
        : undefined,
    );
    if (!decision.allowed) {
      return err(
        agentError(
          decision.owningPhase === null ? "CONFLICT" : "VALIDATION_ERROR",
          decision.reason,
          decision.owningPhase === null
            ? undefined
            : [{ field: "status", message: `blocked until ${decision.owningPhase}` }],
        ),
      );
    }

    const written = resultOr(
      this.repo.setAgentStatus({ workspaceId, userId, agentId, status }),
      "agent registry entry not found",
    );
    if (!written.ok) return written;
    return this.describe(workspaceId, userId, agentId);
  }

  /**
   * The governance trail: who moved which agent, when, and from what state to
   * what. Newest first, tiebroken by id.
   *
   * These are decisions about the registry, not traces of agent runs. Phase 20
   * owns the latter, and this phase writes none — so the list answers "who
   * approved this agent?" and never "what did the agent do?".
   */
  events(
    workspaceId: string,
    userId: string,
    agentId?: string,
  ): Result<readonly AgentRegistryEvent[], AgentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (agentId !== undefined && !isAgentId(agentId)) {
      return err(
        agentError("VALIDATION_ERROR", "unknown agent id", [
          { field: "agentId", message: "must name one of the twelve declared agents" },
        ]),
      );
    }
    const events = resultOr(
      this.repo.listAgentRegistryEvents(workspaceId, userId, agentId),
      "agent registry events not found",
    );
    if (!events.ok) return events;
    return ok(sortRegistryEvents(events.value));
  }

  /**
   * The published rule set, readable before anything is registered.
   *
   * Authorized like every other route, and deliberately available to a workspace
   * with an empty registry: a team deciding whether to enable agents should be
   * able to read what the system permits before it has decided anything.
   */
  policy(workspaceId: string, userId: string): Result<AgentPolicyView, AgentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(derivePolicyView());
  }
}
