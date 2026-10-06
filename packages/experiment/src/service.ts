/**
 * The Experiment Engine's service — every Phase 22 route's behavior.
 *
 * The service validates, authorizes and answers; it never stores a derived
 * number and never accepts one. Identity fields (`workspaceId`, `userId`,
 * every timestamp, every status transition) come from the caller's
 * server-resolved session and storage's own transitions, so a request body
 * that carries a `winner`, a `status`, a `createdAt` or a `createdBy` is
 * ignored in those places rather than believed — the same contract the cost
 * engine published in Phase 16.
 *
 * Fail-closed everywhere: an unknown metric is refused, a comparison the
 * engine cannot order is refused, a cancelled experiment answers but refuses
 * a winner, and an unauthorized caller sees UNAUTHORIZED before anything
 * else happens.
 */

import type { Result } from "@dealora/core";
import { ok, err } from "@dealora/core";
import type { ExperimentStatus } from "@dealora/db";

import { deriveComparison } from "./engine.js";
import {
  describeExperimentPolicy,
  EXPERIMENT_DURATION_LIMITS,
  EXPERIMENT_LABEL_LIMIT,
  EXPERIMENT_METRIC,
  EXPERIMENT_NAME_LIMIT,
  EXPERIMENT_REFUSED_METRICS,
} from "./rules.js";
import type {
  AddExperimentArmInput,
  CancelExperimentInput,
  CreateExperimentInput,
  ExperimentArmView,
  ExperimentComparison,
  ExperimentError,
  ExperimentEventView,
  ExperimentLookup,
  ExperimentRead,
  ExperimentView,
} from "./types.js";
import { experimentError } from "./rules.js";

/** The store may report an experiment status string; this narrows or refuses. */
function statusVocabulary(value: unknown): ExperimentStatus | null {
  return typeof value === "string" && ["draft", "running", "closed", "cancelled"].includes(value)
    ? (value as ExperimentStatus)
    : null;
}

export class ExperimentService {
  constructor(private readonly lookup: ExperimentLookup) {}

  /** Authorize the caller against the workspace using server-side identity. */
  private guard(workspaceId: string, userId: string): Result<true, ExperimentError> {
    if (typeof workspaceId !== "string" || workspaceId === "") {
      return err(experimentError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (typeof userId !== "string" || userId === "") {
      return err(experimentError("VALIDATION_ERROR", "user id is required"));
    }
    const auth = this.lookup.authorize(workspaceId, userId);
    if (!auth.ok) {
      return err(experimentError("UNAUTHORIZED", "not a member of this workspace"));
    }
    return ok(true);
  }

  /** Map a storage refusal onto the domain vocabulary without leaking details. */
  private fromStorage(
    error: { readonly code: string; readonly message?: string },
    fallback: string,
  ): ExperimentError {
    switch (error.code) {
      case "NOT_FOUND":
        return experimentError("NOT_FOUND", fallback);
      case "CONFLICT":
        return experimentError("CONFLICT", error.message ?? fallback);
      case "INVALID":
      case "VALIDATION_ERROR":
        return experimentError("VALIDATION_ERROR", error.message ?? fallback);
      case "UNAUTHORIZED":
        return experimentError("UNAUTHORIZED", "not a member of this workspace");
      default:
        return experimentError("UNAVAILABLE", "experiment storage is unavailable");
    }
  }

  /** Validate and declare one experiment. Created as a `draft` with no arms. */
  create(
    workspaceId: string,
    userId: string,
    input: CreateExperimentInput,
  ): Result<ExperimentView, ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "" || name.length > EXPERIMENT_NAME_LIMIT) {
      return err(
        experimentError(
          "VALIDATION_ERROR",
          `name must be 1 to ${EXPERIMENT_NAME_LIMIT} characters`,
        ),
      );
    }
    const metric = typeof input.metric === "string" ? input.metric : "";
    if (metric !== EXPERIMENT_METRIC.name) {
      const refused = EXPERIMENT_REFUSED_METRICS.find((entry) => entry.name === metric);
      if (refused !== undefined) {
        return err(
          experimentError(
            "VALIDATION_ERROR",
            `metric ${metric} is refused: ${refused.reason}${
              refused.owningPhase === null ? "" : ` Owning phase: ${refused.owningPhase}.`
            }`,
          ),
        );
      }
      return err(
        experimentError("VALIDATION_ERROR", `metric must be one of: ${EXPERIMENT_METRIC.name}`),
      );
    }
    if (
      typeof input.durationDays !== "number" ||
      !Number.isSafeInteger(input.durationDays) ||
      input.durationDays < EXPERIMENT_DURATION_LIMITS.minDays ||
      input.durationDays > EXPERIMENT_DURATION_LIMITS.maxDays
    ) {
      return err(
        experimentError(
          "VALIDATION_ERROR",
          `durationDays must be a whole number from ${EXPERIMENT_DURATION_LIMITS.minDays} to ${EXPERIMENT_DURATION_LIMITS.maxDays}`,
        ),
      );
    }

    const created = this.lookup.createExperiment({
      workspaceId,
      userId,
      name,
      metric,
      durationDays: input.durationDays,
    });
    if (!created.ok) {
      return err(this.fromStorage(created.error, "experiment could not be declared"));
    }
    return ok(toExperimentView(created.value));
  }

  /** Pin one arm to an exact immutable draft of this workspace. */
  addArm(
    workspaceId: string,
    userId: string,
    experimentId: string,
    input: AddExperimentArmInput,
  ): Result<ExperimentArmView, ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const draftId = typeof input.draftId === "string" ? input.draftId.trim() : "";
    if (draftId === "") {
      return err(experimentError("VALIDATION_ERROR", "draftId is required"));
    }
    const label = typeof input.label === "string" ? input.label.trim() : "";
    if (label === "" || label.length > EXPERIMENT_LABEL_LIMIT) {
      return err(
        experimentError(
          "VALIDATION_ERROR",
          `label must be 1 to ${EXPERIMENT_LABEL_LIMIT} characters`,
        ),
      );
    }

    const added = this.lookup.addExperimentArm({
      workspaceId,
      userId,
      experimentId,
      draftId,
      label,
    });
    if (!added.ok) {
      return err(this.fromStorage(added.error, "arm could not be declared"));
    }
    return ok(toArmView(added.value));
  }

  /** Every experiment in this workspace, oldest declaration first. */
  list(
    workspaceId: string,
    userId: string,
    status: unknown,
  ): Result<readonly ExperimentView[], ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    let filter: { readonly status: string } | undefined;
    if (status !== undefined && status !== null) {
      const narrowed = statusVocabulary(status);
      if (narrowed === null) {
        return err(experimentError("VALIDATION_ERROR", "unknown experiment status"));
      }
      filter = { status: narrowed };
    }

    const listed = this.lookup.listExperiments(workspaceId, userId, filter);
    if (!listed.ok) {
      return err(this.fromStorage(listed.error, "experiments could not be listed"));
    }
    return ok(listed.value.map(toExperimentView));
  }

  /**
   * One experiment read back complete: declaration, arms, lifecycle trail and
   * the whole derived comparison. The read is a pure derivation over this
   * request's rows — nothing is stored, nothing cached, nothing stale.
   */
  get(
    workspaceId: string,
    userId: string,
    experimentId: string,
  ): Result<ExperimentRead, ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const found = this.lookup.getExperiment({ workspaceId, userId, experimentId });
    if (!found.ok) {
      return err(this.fromStorage(found.error, "experiment not found"));
    }
    if (found.value === null) {
      return err(experimentError("NOT_FOUND", "experiment not found"));
    }

    const armsListed = this.lookup.listExperimentArms(workspaceId, userId, experimentId);
    if (!armsListed.ok) {
      return err(this.fromStorage(armsListed.error, "experiment arms could not be listed"));
    }
    const eventsListed = this.lookup.listExperimentEvents(workspaceId, userId, experimentId);
    if (!eventsListed.ok) {
      return err(this.fromStorage(eventsListed.error, "experiment events could not be listed"));
    }

    const rows = this.readComparisonRows(workspaceId, userId);
    if (!rows.ok) return err(rows.error);

    const comparison = deriveComparison({
      experiment: found.value,
      arms: armsListed.value,
      accounts: rows.value.accounts,
      contacts: rows.value.contacts,
      qualifications: rows.value.qualifications,
      actions: rows.value.actions,
      classifications: rows.value.classifications,
      meetings: rows.value.meetings,
      costEvents: rows.value.costEvents,
    });

    return ok({
      experiment: toExperimentView(found.value),
      arms: armsListed.value.map(toArmView),
      events: eventsListed.value.map(toEventView),
      comparison,
    });
  }

  /** Open the declared window. Caller supplies the experiment id and nothing else. */
  start(
    workspaceId: string,
    userId: string,
    experimentId: string,
  ): Result<ExperimentView, ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const started = this.lookup.startExperiment({ workspaceId, userId, experimentId });
    if (!started.ok) {
      return err(this.fromStorage(started.error, "experiment could not be started"));
    }
    return ok(toExperimentView(started.value));
  }

  /** Freeze the window. There is no winner argument to pass, by design. */
  close(
    workspaceId: string,
    userId: string,
    experimentId: string,
  ): Result<ExperimentView, ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const closed = this.lookup.closeExperiment({ workspaceId, userId, experimentId });
    if (!closed.ok) {
      return err(this.fromStorage(closed.error, "experiment could not be closed"));
    }
    return ok(toExperimentView(closed.value));
  }

  /** Withdraw the experiment, keeping every collected row for audit. */
  cancel(
    workspaceId: string,
    userId: string,
    experimentId: string,
    input: CancelExperimentInput,
  ): Result<ExperimentView, ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    let reason: string | null = null;
    if (input.reason !== null && input.reason !== undefined) {
      if (typeof input.reason !== "string") {
        return err(experimentError("VALIDATION_ERROR", "reason must be null or a string"));
      }
      const trimmed = input.reason.trim();
      if (trimmed.length > 280) {
        return err(experimentError("VALIDATION_ERROR", "reason must be at most 280 characters"));
      }
      reason = trimmed === "" ? null : trimmed;
    }

    const cancelled = this.lookup.cancelExperiment({
      workspaceId,
      userId,
      experimentId,
      reason,
    });
    if (!cancelled.ok) {
      return err(this.fromStorage(cancelled.error, "experiment could not be cancelled"));
    }
    return ok(toExperimentView(cancelled.value));
  }

  /** One experiment's lifecycle trail, oldest first. */
  history(
    workspaceId: string,
    userId: string,
    experimentId: string,
  ): Result<readonly ExperimentEventView[], ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const found = this.lookup.getExperiment({ workspaceId, userId, experimentId });
    if (!found.ok) {
      return err(this.fromStorage(found.error, "experiment not found"));
    }
    if (found.value === null) {
      return err(experimentError("NOT_FOUND", "experiment not found"));
    }

    const listed = this.lookup.listExperimentEvents(workspaceId, userId, experimentId);
    if (!listed.ok) {
      return err(this.fromStorage(listed.error, "experiment events could not be listed"));
    }
    return ok(listed.value.map(toEventView));
  }

  /** The published rule set: the metric, the decision rule, the thresholds. */
  policy(
    workspaceId: string,
    userId: string,
  ): Result<ReturnType<typeof describeExperimentPolicy>, ExperimentError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeExperimentPolicy());
  }

  /**
   * The comparison's row slice, read once per request through the workspace-
   * scoped methods. Narrower than the whole world on purpose: the engine gets
   * the rows it needs and nothing else.
   */
  private readComparisonRows(
    workspaceId: string,
    userId: string,
  ): Result<
    {
      readonly accounts: readonly { id: string; status: string }[];
      readonly contacts: readonly { id: string; accountId: string; status: string }[];
      readonly qualifications: readonly { accountId: string; version: number; state: string }[];
      readonly actions: readonly import("@dealora/db").OutboundAction[];
      readonly classifications: readonly import("@dealora/db").ConversationClassification[];
      readonly meetings: readonly import("@dealora/db").Meeting[];
      readonly costEvents: readonly import("@dealora/db").CostEvent[];
    },
    ExperimentError
  > {
    const accounts = this.lookup.listAccounts(workspaceId, userId);
    if (!accounts.ok) {
      return err(this.fromStorage(accounts.error, "workspace accounts could not be listed"));
    }
    const contacts = this.lookup.listContacts(workspaceId, userId);
    if (!contacts.ok) {
      return err(this.fromStorage(contacts.error, "workspace contacts could not be listed"));
    }
    const qualifications = this.lookup.listQualifications(workspaceId, userId);
    if (!qualifications.ok) {
      return err(
        this.fromStorage(qualifications.error, "workspace qualifications could not be listed"),
      );
    }
    const actions = this.lookup.listOutboundActions(workspaceId, userId);
    if (!actions.ok) {
      return err(this.fromStorage(actions.error, "workspace actions could not be listed"));
    }
    const classifications = this.lookup.listConversationClassifications(workspaceId, userId);
    if (!classifications.ok) {
      return err(
        this.fromStorage(classifications.error, "workspace classifications could not be listed"),
      );
    }
    const meetings = this.lookup.listMeetings(workspaceId, userId);
    if (!meetings.ok) {
      return err(this.fromStorage(meetings.error, "workspace meetings could not be listed"));
    }
    const costEvents = this.lookup.listCostEvents(workspaceId, userId, {
      executionKind: "outbound_send",
    });
    if (!costEvents.ok) {
      return err(this.fromStorage(costEvents.error, "workspace cost facts could not be listed"));
    }
    return ok({
      accounts: accounts.value,
      contacts: contacts.value,
      qualifications: qualifications.value,
      actions: actions.value,
      classifications: classifications.value,
      meetings: meetings.value,
      costEvents: costEvents.value,
    });
  }
}

function toExperimentView(row: {
  id: string;
  name: string;
  metric: string;
  status: string;
  durationDays: number;
  createdBy: string;
  createdAt: string;
  startedBy: string | null;
  startedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}): ExperimentView {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    status: row.status,
    durationDays: row.durationDays,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    startedBy: row.startedBy,
    startedAt: row.startedAt,
    closedBy: row.closedBy,
    closedAt: row.closedAt,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
  };
}

function toArmView(row: {
  id: string;
  position: number;
  draftId: string;
  label: string;
}): ExperimentArmView {
  return { id: row.id, position: row.position, draftId: row.draftId, label: row.label };
}

function toEventView(row: {
  id: string;
  kind: string;
  actorUserId: string;
  detail: string | null;
  createdAt: string;
}): ExperimentEventView {
  return {
    id: row.id,
    kind: row.kind,
    actorUserId: row.actorUserId,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}

export type { ExperimentComparison };
