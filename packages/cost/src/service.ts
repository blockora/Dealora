/**
 * The Cost Engine application service — ROADMAP.md §23,
 * `DEALORA_BLUEPRINT.md` §33.
 *
 * The chain runs, every time:
 *
 *   authenticate → authorize (server-side) → validate the request against the
 *   closed vocabulary → append the fact / derive the aggregates → answer
 *
 * The split this file exists to keep honest:
 *
 * - **Recording** appends one immutable fact per call. `createdBy` is the
 *   session's user and `createdAt` the server's clock — the body is read for
 *   the fact's fields and for nothing else, so a forged `createdBy`,
 *   `workspaceId` or `totalMinor` in the request is ignored rather than
 *   trusted. A replayed `idempotencyKey` returns the same fact; a reused key
 *   with a different payload is a CONFLICT; storage re-checks every rule the
 *   service checks, because a boundary that trusts its own validation once
 *   can lose that guarantee under a future refactor.
 * - **Reading** derives every total from the facts on each request. There is
 *   no stored aggregate anywhere in this phase, so a stale number cannot be
 *   served and a fact is never rewritten to make a sum prettier.
 *
 * Nothing here schedules, queues, retries, or reaches the network: a fact is
 * recorded when a caller asks, and metrics are computed when a caller looks.
 */

import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type { CostBasis, CostCategory, CostExecutionKind } from "@dealora/db";

import { deriveBreakdown, deriveMetrics } from "./engine.js";
import { isMinorAmount } from "./money.js";
import {
  COST_BASIS_VALUES,
  COST_CATEGORY_VALUES,
  COST_CURRENCIES,
  COST_EXECUTION_KINDS,
  COST_LIMITS,
  COST_RULE_VERSION,
  REFUSED_EXECUTION_KINDS,
  costError,
  describeCostPolicy,
  inVocabulary,
} from "./rules.js";
import type {
  CostError,
  CostEventFilter,
  CostEventRow,
  CostEventView,
  CostPolicyView,
  CostRepository,
  ExecutionCostQuery,
  ExecutionCostSummary,
  RecordCostCommand,
  RecordCostInput,
  StorageResult,
  WorkspaceCostMetrics,
} from "./types.js";

/** Narrow an unknown to a non-empty trimmed string, or `null` (refuse). */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Map a storage refusal onto the domain vocabulary, hiding internals. */
function fromStorage(
  error: { code: string; message?: string },
  notFoundMessage: string,
): CostError {
  switch (error.code) {
    case "NOT_FOUND":
      return costError("NOT_FOUND", notFoundMessage);
    case "UNAUTHORIZED":
      return costError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return costError("CONFLICT", error.message ?? "the idempotency key was already used");
    case "INVALID":
      return costError("VALIDATION_ERROR", error.message ?? "invalid value");
    default:
      // An internal condition (overflow, a row contradicting its own
      // vocabulary) is never surfaced verbatim.
      return costError("UNAVAILABLE", "cost storage unavailable");
  }
}

/** Collapse a storage result onto the domain error vocabulary. */
function resultOr<T>(result: StorageResult<T>, notFoundMessage: string): Result<T, CostError> {
  if (result.ok) return ok(result.value);
  return err(fromStorage(result.error, notFoundMessage));
}

/** The stored row as callers see it: the fact's fields and nothing else. */
function toView(row: CostEventRow): CostEventView {
  return {
    id: row.id,
    executionKind: row.executionKind,
    executionId: row.executionId,
    category: row.category,
    basis: row.basis,
    amountMinor: row.amountMinor,
    currency: row.currency,
    source: row.source,
    occurredAt: row.occurredAt,
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** A validation refusal that names the offending field. */
function invalid(field: string, message: string): CostError {
  return costError("VALIDATION_ERROR", message, [{ field, message }]);
}

export class CostService {
  constructor(private readonly repo: CostRepository) {}

  /**
   * Resolve an execution kind against the published partition: the three
   * kinds this repository can perform, a named refusal for `workflow` that
   * carries its owning phase, and a generic refusal for anything else.
   */
  private executionKind(value: unknown): Result<CostExecutionKind, CostError> {
    const kind = inVocabulary(value, COST_EXECUTION_KINDS);
    if (kind !== null) return ok(kind);
    if (typeof value === "string") {
      const refused = REFUSED_EXECUTION_KINDS.find((entry) => entry.name === value);
      if (refused !== undefined) {
        return err(
          invalid(
            "executionKind",
            `${refused.reason}${refused.owningPhase === null ? "" : ` Owning phase: ${refused.owningPhase}.`}`,
          ),
        );
      }
    }
    return err(
      invalid("executionKind", `executionKind must be one of: ${COST_EXECUTION_KINDS.join(", ")}`),
    );
  }

  /** Authorize the caller against the workspace using server-side identity. */
  private guard(workspaceId: string, userId: string): Result<true, CostError> {
    if (text(workspaceId) === null) {
      return err(invalid("workspaceId", "workspace id is required"));
    }
    if (text(userId) === null) {
      return err(costError("UNAUTHORIZED", "authentication required"));
    }
    const authorized = resultOr(this.repo.authorize(workspaceId, userId), "workspace not found");
    if (!authorized.ok) return authorized;
    return ok(true);
  }

  /**
   * Append one immutable cost fact.
   *
   * Every field of the body is validated against the closed vocabulary, and
   * the identity fields are never read from it: `workspaceId` and `userId`
   * are the caller's server-resolved session context, so a body carrying its
   * own `createdBy`, `workspaceId`, `totalMinor` or `createdAt` is ignored in
   * those places rather than believed.
   */
  record(
    workspaceId: string,
    userId: string,
    input: RecordCostInput,
  ): Result<CostEventView, CostError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const executionKind = this.executionKind(input.executionKind);
    if (!executionKind.ok) return executionKind;

    const executionId = text(input.executionId);
    if (executionId === null) {
      return err(invalid("executionId", "executionId must be a non-empty string"));
    }

    const category = inVocabulary(input.category, COST_CATEGORY_VALUES);
    if (category === null) {
      return err(
        invalid("category", `category must be one of: ${COST_CATEGORY_VALUES.join(", ")}`),
      );
    }

    const basis = inVocabulary(input.basis, COST_BASIS_VALUES);
    if (basis === null) {
      return err(invalid("basis", "basis must be estimated or measured"));
    }

    if (!isMinorAmount(input.amountMinor)) {
      return err(
        invalid(
          "amountMinor",
          `amountMinor must be a whole number of minor units from ${COST_LIMITS.amountMinorMin} to ${COST_LIMITS.amountMinorMax}`,
        ),
      );
    }

    const currency = inVocabulary(input.currency, COST_CURRENCIES);
    if (currency === null) {
      return err(invalid("currency", `currency must be one of: ${COST_CURRENCIES.join(", ")}`));
    }

    if (typeof input.occurredAt !== "string" || Number.isNaN(Date.parse(input.occurredAt))) {
      return err(invalid("occurredAt", "occurredAt must be a valid instant"));
    }

    const key = text(input.idempotencyKey);
    if (key === null || key.length > COST_LIMITS.idempotencyKeyMax) {
      return err(
        invalid(
          "idempotencyKey",
          `idempotencyKey must be ${COST_LIMITS.idempotencyKeyMin} to ${COST_LIMITS.idempotencyKeyMax} characters`,
        ),
      );
    }

    let source: string | null = null;
    if (input.source !== null && input.source !== undefined) {
      if (typeof input.source !== "string") {
        return err(invalid("source", "source must be null or a string"));
      }
      const trimmed = input.source.trim();
      if (trimmed === "" || trimmed.length > COST_LIMITS.sourceMax) {
        return err(
          invalid(
            "source",
            `source must be ${COST_LIMITS.sourceMin} to ${COST_LIMITS.sourceMax} characters`,
          ),
        );
      }
      source = trimmed;
    }

    const event: RecordCostCommand = {
      executionKind: executionKind.value,
      executionId,
      category,
      basis,
      amountMinor: input.amountMinor,
      currency,
      source,
      occurredAt: input.occurredAt,
      idempotencyKey: key,
    };

    const created = this.repo.createCostEvent({ workspaceId, createdBy: userId, event });
    if (!created.ok) return err(fromStorage(created.error, "execution not found"));
    return ok(toView(created.value));
  }

  /**
   * One recorded cost fact, authorized against the caller's own workspace.
   *
   * A fact belonging to a workspace other than the one named in the request
   * reads as not found — indistinguishable from an id that was never issued,
   * so another tenant's fact ids stay undiscoverable even to a caller who
   * somehow holds both sessions.
   */
  get(workspaceId: string, userId: string, id: unknown): Result<CostEventView, CostError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const factId = text(id);
    if (factId === null) {
      return err(invalid("id", "cost event id is required"));
    }

    const found = resultOr(this.repo.getCostEvent(factId, userId), "cost event not found");
    if (!found.ok) return found;
    if (found.value.workspaceId !== workspaceId) {
      return err(costError("NOT_FOUND", "cost event not found"));
    }
    return ok(toView(found.value));
  }

  /**
   * The workspace's recorded cost facts, optionally narrowed, newest first.
   * Every filter value is vocabulary-checked before it reaches storage, so a
   * filter can neither widen the tenant boundary nor smuggle a value into a
   * closed field.
   */
  list(
    workspaceId: string,
    userId: string,
    filter: CostEventFilter,
  ): Result<readonly CostEventView[], CostError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    let executionKind: CostExecutionKind | undefined;
    if (filter.executionKind !== undefined) {
      const resolved = this.executionKind(filter.executionKind);
      if (!resolved.ok) return resolved;
      executionKind = resolved.value;
    }

    let executionId: string | undefined;
    if (filter.executionId !== undefined) {
      const id = text(filter.executionId);
      if (id === null) {
        return err(invalid("executionId", "executionId must be a non-empty string"));
      }
      executionId = id;
    }

    let category: CostCategory | undefined;
    if (filter.category !== undefined) {
      const resolved = inVocabulary(filter.category, COST_CATEGORY_VALUES);
      if (resolved === null) {
        return err(
          invalid("category", `category must be one of: ${COST_CATEGORY_VALUES.join(", ")}`),
        );
      }
      category = resolved;
    }

    let basis: CostBasis | undefined;
    if (filter.basis !== undefined) {
      const resolved = inVocabulary(filter.basis, COST_BASIS_VALUES);
      if (resolved === null) {
        return err(invalid("basis", "basis must be estimated or measured"));
      }
      basis = resolved;
    }

    const listed = resultOr(
      this.repo.listCostEvents(workspaceId, userId, {
        executionKind,
        executionId,
        category,
        basis,
      }),
      "cost events not found",
    );
    if (!listed.ok) return listed;
    return ok(listed.value.map(toView));
  }

  /**
   * What one execution cost — ROADMAP.md §23's gate: *a workflow execution
   * can show estimated or measured cost*.
   *
   * The execution must be a real run of this workspace (re-derived from
   * storage, never assumed from the request), and the totals are computed
   * from that execution's own facts with the supersession rule applied, so an
   * estimate that was later measured shows once — as the measurement.
   */
  executionCost(
    workspaceId: string,
    userId: string,
    query: ExecutionCostQuery,
  ): Result<ExecutionCostSummary, CostError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const executionKind = this.executionKind(query.executionKind);
    if (!executionKind.ok) return executionKind;

    const executionId = text(query.executionId);
    if (executionId === null) {
      return err(invalid("executionId", "executionId must be a non-empty string"));
    }

    const exists = resultOr(
      this.repo.executionExists(workspaceId, userId, executionKind.value, executionId),
      "execution not found",
    );
    if (!exists.ok) return exists;

    const listed = resultOr(
      this.repo.listCostEvents(workspaceId, userId, {
        executionKind: executionKind.value,
        executionId,
      }),
      "cost events not found",
    );
    if (!listed.ok) return listed;

    const totals = deriveBreakdown(listed.value);
    if (totals === null) {
      return err(costError("UNAVAILABLE", "execution totals could not be derived"));
    }

    return ok({
      ruleVersion: COST_RULE_VERSION,
      executionKind: executionKind.value,
      executionId,
      totals,
    });
  }

  /**
   * The workspace's whole cost picture: derived totals, the metric
   * denominators counted from stored rows, the three metrics Phase 16 can
   * derive, and the three it refuses with their owning phase.
   *
   * Everything here is computed from the facts on this request — there is no
   * cached aggregate to go stale and no client-supplied total anywhere in the
   * answer.
   */
  metrics(workspaceId: string, userId: string): Result<WorkspaceCostMetrics, CostError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const listed = resultOr(this.repo.listCostEvents(workspaceId, userId), "cost events not found");
    if (!listed.ok) return listed;

    const totals = deriveBreakdown(listed.value);
    if (totals === null) {
      return err(costError("UNAVAILABLE", "workspace totals could not be derived"));
    }

    const denominators = resultOr(
      this.repo.denominators(workspaceId, userId),
      "metric denominators not found",
    );
    if (!denominators.ok) return denominators;

    const derived = deriveMetrics(totals, denominators.value);
    return ok({
      ruleVersion: COST_RULE_VERSION,
      totals,
      denominators: denominators.value,
      metrics: derived.metrics,
      refused: derived.refused,
    });
  }

  /**
   * The vocabulary this deployment enforces — categories, bases, execution
   * kinds, currencies, limits, the aggregation rule, the denominator
   * definitions — plus everything it refuses and why. Authorized like every
   * other route, and readable before a single fact exists so a workspace can
   * inspect the whole rule set first.
   */
  policy(workspaceId: string, userId: string): Result<CostPolicyView, CostError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeCostPolicy());
  }
}
