/**
 * @dealora/evaluation — the Agent Evaluation application service
 * (`ROADMAP.md` §26, `DEALORA_BLUEPRINT.md` §31).
 *
 * The chain runs, every time:
 *
 *   authenticate → authorize (server-side) → resolve the agent's declaration →
 *   read the live evaluation round for **that exact version** → validate what
 *   the caller supplied against the published rule table → write or derive →
 *   answer
 *
 * Four properties this service exists to hold:
 *
 * 1. **The caller contributes an observation, never an outcome.** A request
 *    carries a metric, a subject and either a judgement or a measured
 *    quantity. The rate, the total, the threshold comparison, the pass, the
 *    agent version, the workspace, the actor and the timestamp are all derived
 *    here. There is no request that can say "this agent passed".
 * 2. **It never runs anything.** There is no model call, no tool call, no
 *    provider and no network. A judgement describes work a person did elsewhere;
 *    recording one performs no work.
 * 3. **It never crosses a workspace.** Every read and write is workspace-scoped
 *    with the caller's own identity, and storage re-checks the same pair.
 * 4. **It never ages evidence by the clock.** A new round supersedes the old
 *    one, so a stored state always produces the same report.
 *
 * Narrowing, not assertion: storage returns rows whose `metric` and `verdict`
 * are plain strings, and every conversion to the domain's closed vocabularies
 * happens in the two functions below. If a value is not in the published
 * vocabulary the row is **dropped** rather than cast, so an unreadable record
 * reduces the evidence instead of inflating it.
 */

import { declarationFor, isAgentId } from "@dealora/agent";
import type { AgentDeclaration, AgentId } from "@dealora/agent";
import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";

import { deriveEvaluationReport, latestRun, sortObservations, sortRuns } from "./engine.js";
import {
  EVALUATION_GATE_RULE,
  EVALUATION_MEASURED_METRICS,
  EVALUATION_METRICS,
  EVALUATION_NEVER_DOES,
  EVALUATION_RULE_VERSION,
  EVALUATION_VERDICTS,
  isEvaluationMetric,
  isEvaluationVerdict,
  isMeasuredMetric,
} from "./rules.js";
import type {
  EvaluationError,
  EvaluationGateDecision,
  EvaluationObservationRow,
  EvaluationObservationView,
  EvaluationPolicyView,
  EvaluationReport,
  EvaluationRepository,
  EvaluationRunRow,
  EvaluationRunView,
  EvaluationStorageResult,
} from "./types.js";

/** Map a storage refusal onto the domain vocabulary, hiding internals. */
function fromStorage(
  error: { code: string; message?: string },
  notFoundMessage: string,
): EvaluationError {
  switch (error.code) {
    case "NOT_FOUND":
      return { code: "NOT_FOUND", message: notFoundMessage };
    case "UNAUTHORIZED":
      return { code: "UNAUTHORIZED", message: "workspace access denied" };
    case "VALIDATION_ERROR":
    case "INVALID":
      // A rule the caller can act on, so it travels with its message.
      return { code: "VALIDATION_ERROR", message: error.message ?? "invalid value" };
    case "CONFLICT":
      return { code: "CONFLICT", message: error.message ?? "conflicting evaluation record" };
    default:
      // An internal condition is never surfaced verbatim.
      return { code: "UNAVAILABLE", message: "evaluation storage unavailable" };
  }
}

/** Collapse a storage result onto the domain error vocabulary. */
function resultOr<T>(
  result: EvaluationStorageResult<T>,
  notFoundMessage: string,
): Result<T, EvaluationError> {
  if (result.ok) return ok(result.value);
  return err(fromStorage(result.error, notFoundMessage));
}

/** Narrow an unknown to a non-empty trimmed string, or `null` (refuse). */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A stored judgement as the domain reads it, or `null` when its vocabulary is
 * not one this build publishes.
 *
 * Dropping rather than casting is the point: an unreadable judgement is missing
 * evidence, and missing evidence must never be read as a good one.
 */
function toObservationView(row: EvaluationObservationRow): EvaluationObservationView | null {
  if (!isEvaluationMetric(row.metric)) return null;
  if (row.verdict !== null && !isEvaluationVerdict(row.verdict)) return null;
  return {
    id: row.id,
    runId: row.runId,
    metric: row.metric,
    subjectId: row.subjectId,
    verdict: row.verdict,
    amountMinor: row.amountMinor,
    durationMs: row.durationMs,
    note: row.note,
    recordedBy: row.createdBy,
    recordedAt: row.createdAt,
  };
}

/** The stored rows this domain will read, in their published vocabulary. */
function readable(rows: readonly EvaluationObservationRow[]): readonly EvaluationObservationView[] {
  return rows
    .map(toObservationView)
    .filter((row): row is EvaluationObservationView => row !== null);
}

/** What a caller may contribute to one observation. */
export interface ObservationInput {
  readonly metric: string;
  readonly subjectId: string;
  readonly verdict?: string;
  readonly amountMinor?: number;
  readonly durationMs?: number;
  readonly note?: string;
}

export class EvaluationService {
  constructor(private readonly repo: EvaluationRepository) {}

  /**
   * Authorize the caller against the workspace using server-side identity.
   *
   * Both values are resolved from the request's route and session by the
   * transport layer; neither is ever taken from a body.
   */
  private guard(workspaceId: string, userId: string): Result<true, EvaluationError> {
    if (text(workspaceId) === null) {
      return err({ code: "VALIDATION_ERROR", message: "workspace id is required" });
    }
    if (text(userId) === null) {
      return err({ code: "UNAUTHORIZED", message: "authentication required" });
    }
    const authorized = resultOr(this.repo.authorize(workspaceId, userId), "workspace not found");
    if (!authorized.ok) return authorized;
    return ok(true);
  }

  /**
   * Resolve the agent and its declaration, or refuse by name.
   *
   * The declaration supplies `version` and `costLimits` to everything
   * downstream, so an agent that is not one of the twelve can never be measured
   * at all. The error is the same regardless of whether such an agent exists
   * anywhere, so this cannot be used to probe the vocabulary.
   */
  private resolve(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Result<{ agentId: AgentId; declaration: AgentDeclaration }, EvaluationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (!isAgentId(agentId)) {
      return err({
        code: "VALIDATION_ERROR",
        message: "unknown agent id",
        details: [{ field: "agentId", message: "must name one of the twelve declared agents" }],
      });
    }
    const declaration = declarationFor(agentId);
    if (declaration === null) {
      return err({ code: "NOT_FOUND", message: "agent not found" });
    }
    return ok({ agentId, declaration });
  }

  /**
   * Open a new evaluation round for this agent's current declared version.
   *
   * The version is read from the declaration table, never from the request, so
   * evidence can only ever be filed against a version that actually exists. The
   * round number is derived in storage from the rounds already recorded, so a
   * caller cannot open "round 1" twice or renumber history.
   *
   * A new round is how a changed opinion is expressed: judgements are never
   * edited or deleted, so the old evidence stays exactly as recorded and simply
   * stops being current.
   */
  openRun(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Result<EvaluationRunView, EvaluationError> {
    const resolved = this.resolve(workspaceId, userId, agentId);
    if (!resolved.ok) return resolved;
    const opened = resultOr(
      this.repo.createAgentEvaluationRun({
        workspaceId,
        userId,
        agentId: resolved.value.agentId,
        version: resolved.value.declaration.version,
      }),
      "evaluation run not found",
    );
    if (!opened.ok) return opened;
    const view = toRunView(opened.value, true, 0);
    if (view === null) return err({ code: "UNAVAILABLE", message: "evaluation run is unreadable" });
    return ok(view);
  }

  /**
   * Record one judgement about one subject inside the live round.
   *
   * The caller supplies a metric, a subject, and then **either** a verdict
   * **or** the measured quantity — never both, never a rate, a threshold, a
   * pass, a version, a status or a timestamp. Everything the report will later
   * print is derived from the row this writes.
   *
   * The metric's shape is checked here *and* in the schema: `cost` takes whole
   * minor units, `latency` whole milliseconds, and everything else takes one of
   * the three verdicts. An agent whose declaration does not name the metric
   * cannot be measured on it, because the gate would not read the result.
   */
  recordObservation(
    workspaceId: string,
    userId: string,
    agentId: string,
    input: ObservationInput,
  ): Result<EvaluationObservationView, EvaluationError> {
    const resolved = this.resolve(workspaceId, userId, agentId);
    if (!resolved.ok) return resolved;
    const { declaration } = resolved.value;

    if (!isEvaluationMetric(input.metric)) {
      return err({
        code: "VALIDATION_ERROR",
        message: "unknown evaluation metric",
        details: [
          {
            field: "metric",
            message: "must name one of the thirteen metrics ROADMAP.md §26 publishes",
          },
        ],
      });
    }
    const metric = input.metric;
    if (!declaration.evaluationMetrics.some((declared) => declared === metric)) {
      return err({
        code: "VALIDATION_ERROR",
        message: "this agent does not declare that metric",
        details: [
          {
            field: "metric",
            message: `only ${declaration.evaluationMetrics.join(", ")} gate this agent`,
          },
        ],
      });
    }

    const live = resultOr(
      this.repo.getCurrentAgentEvaluationRun({
        workspaceId,
        userId,
        agentId: resolved.value.agentId,
        version: declaration.version,
      }),
      "evaluation run not found",
    );
    if (!live.ok) return live;
    if (live.value === null) {
      return err({
        code: "CONFLICT",
        message: "no evaluation round is open for this agent version",
        details: [{ field: "metric", message: "open a round before recording judgements" }],
      });
    }

    const subjectId = text(input.subjectId);
    if (subjectId === null) {
      return err({
        code: "VALIDATION_ERROR",
        message: "subjectId is required",
        details: [{ field: "subjectId", message: "name the thing that was judged" }],
      });
    }

    const measured = this.readMeasurement(metric, input);
    if (!measured.ok) return measured;

    const note = text(input.note);
    const written = resultOr(
      this.repo.createAgentEvaluationObservation({
        workspaceId,
        userId,
        runId: live.value.id,
        metric,
        subjectId,
        verdict: measured.value.verdict,
        amountMinor: measured.value.amountMinor,
        durationMs: measured.value.durationMs,
        note,
      }),
      "evaluation run not found",
    );
    if (!written.ok) return written;
    const view = toObservationView(written.value);
    if (view === null) {
      // Storage accepted a row in a vocabulary this build does not publish.
      // Refused rather than asserted past: unreadable evidence is not evidence.
      return err({ code: "UNAVAILABLE", message: "evaluation record is unreadable" });
    }
    return ok(view);
  }

  /**
   * Read the one shape this metric accepts, or refuse with the field named.
   *
   * Split out so the rules are in one place: a measured metric takes a whole
   * non-negative quantity and no verdict, and a judged metric takes a verdict
   * and no quantity.
   */
  private readMeasurement(
    metric: string,
    input: ObservationInput,
  ): Result<
    {
      readonly verdict: string | null;
      readonly amountMinor: number | null;
      readonly durationMs: number | null;
    },
    EvaluationError
  > {
    const none = { verdict: null, amountMinor: null, durationMs: null } as const;

    if (isMeasuredMetric(metric)) {
      const field = metric === "cost" ? "amountMinor" : "durationMs";
      const raw = metric === "cost" ? input.amountMinor : input.durationMs;
      if (raw === undefined || !Number.isSafeInteger(raw) || raw < 0) {
        return err({
          code: "VALIDATION_ERROR",
          message: `${metric} must be measured`,
          details: [
            {
              field,
              message:
                metric === "cost"
                  ? "whole minor units, zero or more, never a fraction"
                  : "whole milliseconds, zero or more",
            },
          ],
        });
      }
      if (input.verdict !== undefined) {
        return err({
          code: "VALIDATION_ERROR",
          message: `${metric} is measured, not judged`,
          details: [
            {
              field: "verdict",
              message: "send the measured quantity only; the engine decides the verdict",
            },
          ],
        });
      }
      return ok(metric === "cost" ? { ...none, amountMinor: raw } : { ...none, durationMs: raw });
    }

    if (input.amountMinor !== undefined || input.durationMs !== undefined) {
      return err({
        code: "VALIDATION_ERROR",
        message: `${metric} is judged, not measured`,
        details: [
          {
            field: metric === "cost" ? "amountMinor" : "durationMs",
            message: `only ${EVALUATION_MEASURED_METRICS.map((entry) => entry.metric).join(" and ")} carry a measured quantity`,
          },
        ],
      });
    }
    const rawVerdict = text(input.verdict);
    if (rawVerdict === null || !isEvaluationVerdict(rawVerdict)) {
      return err({
        code: "VALIDATION_ERROR",
        message: "unknown evaluation verdict",
        details: [
          { field: "verdict", message: `must be one of ${EVALUATION_VERDICTS.join(", ")}` },
        ],
      });
    }
    return ok({ ...none, verdict: rawVerdict });
  }

  /**
   * The whole evaluation for one agent version, derived on read.
   *
   * Read-only, and complete for an agent that has never been measured: every
   * declared metric appears with `insufficient_evidence` and no value, rather
   * than being omitted or defaulted to zero.
   */
  report(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Result<EvaluationReport, EvaluationError> {
    const resolved = this.resolve(workspaceId, userId, agentId);
    if (!resolved.ok) return resolved;
    const loaded = this.loadLive(workspaceId, userId, resolved.value);
    if (!loaded.ok) return loaded;
    return ok(
      deriveEvaluationReport({
        agentId: resolved.value.agentId,
        declaration: resolved.value.declaration,
        run: loaded.value.run,
        observations: loaded.value.observations,
      }),
    );
  }

  /**
   * The provenance trail: every round for this agent, and the judgements in the
   * live one.
   *
   * This is a record of **who judged what, against which agent version** — not
   * a trace of what an agent did while running. `ROADMAP.md` §27 (Phase 20)
   * owns run traces and this phase writes none, so nothing here carries an
   * execution, a token count or a tool call.
   */
  trail(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Result<
    {
      readonly runs: readonly EvaluationRunView[];
      readonly observations: readonly EvaluationObservationView[];
    },
    EvaluationError
  > {
    const resolved = this.resolve(workspaceId, userId, agentId);
    if (!resolved.ok) return resolved;
    const all = resultOr(
      this.repo.listAgentEvaluationRuns(workspaceId, userId, resolved.value.agentId),
      "evaluation runs not found",
    );
    if (!all.ok) return all;

    // Every round's judgements are read, so a superseded round reports the
    // evidence it actually holds rather than a count of zero.
    const byRun = new Map<string, readonly EvaluationObservationView[]>();
    for (const row of all.value) {
      const rows = resultOr(
        this.repo.listAgentEvaluationObservations(workspaceId, userId, row.id),
        "evaluation observations not found",
      );
      if (!rows.ok) return rows;
      byRun.set(row.id, readable(rows.value));
    }

    const live = latestRun(all.value, resolved.value.declaration.version);
    const runs = sortRuns(
      all.value
        .map((row) => {
          const view = toRunView(
            row,
            live !== null && row.id === live.id,
            byRun.get(row.id)?.length ?? 0,
          );
          return view;
        })
        .filter((view): view is EvaluationRunView => view !== null),
    );
    return ok({
      runs,
      observations: sortObservations(live === null ? [] : (byRun.get(live.id) ?? [])),
    });
  }

  /**
   * The published rule set: thirteen metrics, their thresholds and minimum
   * samples, the three judgements, and the gate.
   *
   * Available to a workspace with nothing measured yet, because a team
   * deciding whether to evaluate an agent should be able to read the bar before
   * it has any evidence.
   */
  policy(workspaceId: string, userId: string): Result<EvaluationPolicyView, EvaluationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok({
      ruleVersion: EVALUATION_RULE_VERSION,
      metrics: EVALUATION_METRICS,
      verdicts: EVALUATION_VERDICTS,
      measuredMetrics: EVALUATION_MEASURED_METRICS,
      gateRule: EVALUATION_GATE_RULE,
      neverDoes: EVALUATION_NEVER_DOES,
    });
  }

  /**
   * The promotion gate's answer for this agent, in the shape
   * `@dealora/agent` consumes.
   *
   * Exposed so a caller can ask *before* it attempts a transition, and used by
   * the lifecycle to decide one. It is derived from stored rows on every call:
   * there is no cached verdict and no way to supply one.
   */
  gate(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Result<EvaluationGateDecision, EvaluationError> {
    const report = this.report(workspaceId, userId, agentId);
    if (!report.ok) return report;
    return ok(report.value.gate);
  }

  /**
   * The live round for this agent's current version, and its judgements.
   *
   * Only the **current declaration version** is consulted, so evidence recorded
   * against an older version cannot be read as evidence about this one — a new
   * agent version starts with no evidence at all, by construction rather than by
   * policy.
   */
  private loadLive(
    workspaceId: string,
    userId: string,
    resolved: { agentId: AgentId; declaration: AgentDeclaration },
  ): Result<
    {
      readonly run: EvaluationRunView | null;
      readonly observations: readonly EvaluationObservationView[];
    },
    EvaluationError
  > {
    const current = resultOr(
      this.repo.getCurrentAgentEvaluationRun({
        workspaceId,
        userId,
        agentId: resolved.agentId,
        version: resolved.declaration.version,
      }),
      "evaluation run not found",
    );
    if (!current.ok) return current;
    const row = current.value === null ? null : current.value;
    if (row === null) return ok({ run: null, observations: [] });
    const rows = resultOr(
      this.repo.listAgentEvaluationObservations(workspaceId, userId, row.id),
      "evaluation observations not found",
    );
    if (!rows.ok) return rows;
    const observations = readable(rows.value);
    const view = toRunView(row, true, observations.length);
    if (view === null) return ok({ run: null, observations: [] });
    return ok({ run: view, observations });
  }
}

/**
 * One stored round as the trail reports it, or `null` when its agent id is not
 * one this build publishes.
 *
 * Dropped rather than cast: a row naming an agent outside the twelve is not
 * evidence about any agent this product has.
 */
function toRunView(
  row: EvaluationRunRow,
  live: boolean,
  observationCount: number,
): EvaluationRunView | null {
  if (!isAgentId(row.agentId)) return null;
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersion: row.version,
    runNumber: row.runNumber,
    observationCount,
    live,
    openedBy: row.createdBy,
    openedAt: row.createdAt,
  };
}
