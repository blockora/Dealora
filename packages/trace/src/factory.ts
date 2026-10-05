/**
 * Store integration for Agent Trace & Observability.
 *
 * The tenant boundary lives in storage, not here: every method on the lookup is
 * workspace-scoped inside the repository with the caller's own identity, so
 * this factory only wires — it never widens a scope, never caches a row and
 * never decides an outcome of its own.
 *
 * The lookup declares only what a trace reads and writes, so the concrete
 * store's rows are structurally assignable and the service never sees a whole
 * workspace or user object. There is deliberately no second, richer interface:
 * a trace's only state is `(workspace, agent, version) → recorded steps`, and
 * widening the surface here would be widening what a later phase could reach
 * without a decision having been made.
 *
 * Two of the lookups are not the trace's own tables, and both are read-only by
 * construction:
 *
 * - `listAgentRunCostFacts` returns **Phase 16's own immutable `cost_events`
 *   rows** under the `agent_run` execution kind. No total is computed here; the
 *   trace totals them with `@dealora/cost`'s published derivation, so there is
 *   one place in the system that knows how to add money up.
 * - `getAgentRegistryState` returns the Phase 18 registry's lifecycle state for
 *   one agent. It is how a trace reaches the `production` requirement without
 *   ever being able to satisfy it: this package asks the registry a question
 *   and records nothing back into it.
 */

import type { CostEventRow } from "@dealora/cost";

import { TraceService } from "./service.js";
import type { TraceEventRow, TraceRepository, TraceRunRow, TraceStorageResult } from "./types.js";

/** The minimum tracing needs from storage. Every call is scoped. */
export interface TraceLookup {
  authorize(workspaceId: string, userId: string): TraceStorageResult<unknown>;
  createAgentTraceRun(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): TraceStorageResult<TraceRunRow>;
  getAgentTraceRun(input: {
    workspaceId: string;
    userId: string;
    runId: string;
  }): TraceStorageResult<TraceRunRow | null>;
  listAgentTraceRuns(
    workspaceId: string,
    userId: string,
    agentId?: string,
  ): TraceStorageResult<readonly TraceRunRow[]>;
  closeAgentTraceRun(input: {
    workspaceId: string;
    userId: string;
    runId: string;
  }): TraceStorageResult<TraceRunRow>;
  createAgentTraceEvent(input: {
    workspaceId: string;
    userId: string;
    runId: string;
    stepId: string;
    stage: string;
    outcome: string;
    detail: string | null;
    tool: string | null;
    referenceId: string | null;
    errorCode: string | null;
    durationMs: number | null;
    modelProvider: string | null;
    modelName: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }): TraceStorageResult<TraceEventRow>;
  listAgentTraceEvents(
    workspaceId: string,
    userId: string,
    runId: string,
  ): TraceStorageResult<readonly TraceEventRow[]>;
  /** Phase 16's own facts for one traced run. No aggregation, no total. */
  listAgentRunCostFacts(
    workspaceId: string,
    userId: string,
    runId: string,
  ): TraceStorageResult<readonly CostEventRow[]>;
  /** Phase 18's registry state for one agent, or `null` when unregistered. */
  getAgentRegistryState(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): TraceStorageResult<string | null>;
}

/**
 * Wire tracing to storage.
 *
 * Everything is passed through unchanged: the vocabulary lives in `rules.ts`,
 * the derivations in `engine.ts`, and this function's whole job is to prove — by
 * its types — that the service can reach nothing except workspace-scoped trace
 * rows, Phase 16's cost facts and the Phase 18 registry's state.
 */
export function createTraceService(lookup: TraceLookup): TraceService {
  const repo: TraceRepository = { ...lookup };
  return new TraceService(repo);
}
