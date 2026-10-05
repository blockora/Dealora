/**
 * The Revenue Graph application service — ROADMAP.md §22.
 *
 * It answers two questions — how does this workspace's graph look, and where
 * does one account's opportunity stand? — plus the policy that says what the
 * graph may say at all. The chain runs, every time:
 *
 *   authenticate → authorize → read the account's rows → derive → answer
 *
 * The negative space is the point of this file:
 *
 * - **Nothing is written.** The repository surface is `authorize` alone; there
 *   is no create, update or delete anywhere in this package. A graph node is a
 *   view of a row another phase stored, so persisting it would duplicate the
 *   fact it represents.
 * - **Nothing is acted on.** No sender, approver, scheduler, CRM or calendar
 *   exists here; a graph is a picture of stored records and pictures do not
 *   move.
 * - **Nothing is recommended.** Phase 14 owns advice. The graph reports what
 *   has happened, never what should happen next.
 * - **Nothing is inferred.** The caller supplies an account id and nothing
 *   else: a body that carries nodes, edges, an opportunity or a lifecycle is
 *   ignored rather than trusted, because every relationship is derived from
 *   stored linkage the client cannot write.
 * - **The graph is recomputed, never replayed.** Every read re-derives from
 *   current rows, so a downgraded qualification removes the opportunity node
 *   immediately and no stale relationship can be served.
 */

import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";

import { deriveAccountGraph, deriveWorkspaceGraph } from "./engine.js";
import {
  EDGE_KINDS,
  GRAPH_ACCOUNT_LIMIT,
  GRAPH_RULE_VERSION,
  NEVER_DO,
  NODE_KINDS,
  REFUSED,
  revenueGraphError,
} from "./rules.js";
import { REVENUE_GRAPH_STAGES } from "./types.js";
import type {
  OpportunityTrace,
  RevenueGraphError,
  RevenueGraphIndexReader,
  RevenueGraphPolicyView,
  RevenueGraphReader,
  RevenueGraphRepository,
  TraceOpportunityInput,
  WorkspaceGraph,
} from "./types.js";

/** Narrow an unknown to a non-empty trimmed string, or `null` (refuse). */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Map a storage code onto a domain code, never surfacing internal messages. */
function fromStorage(code: string): RevenueGraphError {
  switch (code) {
    case "NOT_FOUND":
      return revenueGraphError("NOT_FOUND", "workspace not found");
    case "UNAUTHORIZED":
      return revenueGraphError("UNAUTHORIZED", "workspace access denied");
    default:
      return revenueGraphError("UNAVAILABLE", "storage unavailable");
  }
}

/** The rule set this deployment enforces, derived from the publication tables. */
export function describePolicy(): RevenueGraphPolicyView {
  return {
    ruleVersion: GRAPH_RULE_VERSION,
    nodeKinds: NODE_KINDS.map((entry) => entry.kind),
    edgeKinds: EDGE_KINDS.map((entry) => entry.kind),
    stages: [...REVENUE_GRAPH_STAGES],
    nodes: NODE_KINDS.map((entry) => ({
      kind: entry.kind,
      source: entry.source,
      semantics: entry.semantics,
    })),
    edges: EDGE_KINDS.map((entry) => ({
      kind: entry.kind,
      from: entry.from,
      to: entry.to,
      semantics: entry.semantics,
      derivation: entry.derivation,
    })),
    refused: REFUSED.map((entry) => ({ ...entry })),
    neverDoes: [...NEVER_DO],
  };
}

export class RevenueGraphService {
  constructor(
    private readonly repo: RevenueGraphRepository,
    private readonly reader: RevenueGraphReader,
    private readonly accounts: RevenueGraphIndexReader,
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: string, userId: string): Result<true, RevenueGraphError> {
    if (text(workspaceId) === null) {
      return err(revenueGraphError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (text(userId) === null) {
      return err(revenueGraphError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code));
    return ok(true);
  }

  /**
   * The deterministic graph for a whole workspace: every account's nodes and
   * edges, merged, deduplicated and ordered by the revenue loop.
   *
   * The account cap is a refusal, not a truncation — a graph that quietly
   * stopped would be read as the complete picture of the pipeline. An account
   * whose rows cannot be read is simply absent from the workspace view rather
   * than rendered half-empty; a direct trace of that account is refused
   * instead, because there the caller asked about that account specifically.
   */
  workspaceGraph(workspaceId: string, userId: string): Result<WorkspaceGraph, RevenueGraphError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const accountIds = this.accounts.accountIds(workspaceId, userId);
    if (accountIds === null) {
      return err(revenueGraphError("UNAVAILABLE", "workspace accounts could not be read"));
    }
    if (accountIds.length > GRAPH_ACCOUNT_LIMIT) {
      return err(
        revenueGraphError("VALIDATION_ERROR", "too many accounts for one graph", [
          {
            field: "workspaceId",
            message: `this workspace holds ${accountIds.length} accounts; ask for at most ${GRAPH_ACCOUNT_LIMIT} at a time rather than receive a truncated graph`,
          },
        ]),
      );
    }

    const graphs = [];
    for (const accountId of accountIds) {
      const snapshot = this.reader.accountGraph(workspaceId, accountId, userId);
      if (snapshot === null) continue;
      const derived = deriveAccountGraph(snapshot);
      if (derived === null) continue;
      graphs.push(derived);
    }
    const merged = deriveWorkspaceGraph(graphs);
    return ok({
      ruleVersion: GRAPH_RULE_VERSION,
      accountCount: graphs.length,
      nodes: merged.nodes,
      edges: merged.edges,
    });
  }

  /**
   * Trace the lifecycle of one account's opportunity: the deterministic graph
   * plus the ordered stages the account has reached, its frontier, and the
   * opportunity node when its latest qualification is `qualified`.
   *
   * The caller supplies an account id and **nothing else**. The nodes, the
   * edges, the opportunity and the frontier are derived from stored rows — a
   * client cannot name a relationship, cannot forge an opportunity and cannot
   * extend a lifecycle, because none of those values are ever read from the
   * request.
   *
   * A foreign account is reported as not found, indistinguishable from one
   * that was never issued, so the existence of another tenant's ids is never
   * revealed.
   */
  traceOpportunity(
    workspaceId: string,
    userId: string,
    input: TraceOpportunityInput,
  ): Result<OpportunityTrace, RevenueGraphError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const accountId = text(input.accountId);
    if (accountId === null) {
      return err(
        revenueGraphError("VALIDATION_ERROR", "accountId is required", [
          { field: "accountId", message: "accountId must be a non-empty string" },
        ]),
      );
    }

    const snapshot = this.reader.accountGraph(workspaceId, accountId, userId);
    if (snapshot === null) {
      return err(
        revenueGraphError("NOT_FOUND", "account not found", [
          {
            field: "accountId",
            message: "an account must exist in this workspace before it can be traced",
          },
        ]),
      );
    }

    const derived = deriveAccountGraph(snapshot);
    if (derived === null) {
      return err(revenueGraphError("UNAVAILABLE", "the account's records could not be read"));
    }

    return ok({
      ruleVersion: GRAPH_RULE_VERSION,
      accountId: snapshot.account.id,
      accountName: snapshot.account.name,
      nodes: derived.nodes,
      edges: derived.edges,
      lifecycle: derived.lifecycle,
    });
  }

  /**
   * The vocabulary this deployment enforces and everything it refuses, with
   * the phase that owns each refusal. Authorized like every other route, and
   * readable before any account exists so a workspace can inspect the whole
   * rule set before handing over a single row.
   */
  policy(workspaceId: string, userId: string): Result<RevenueGraphPolicyView, RevenueGraphError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describePolicy());
  }
}
