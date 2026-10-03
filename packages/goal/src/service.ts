import type { Result } from "@dealora/core";
import { err, ok } from "@dealora/core";
import type {
  EntityId,
  GoalMetricKind,
  RevenueGoal,
  RevenueGoalEvent,
  RevenueGoalMetric,
  RevenueGoalStatus,
} from "@dealora/db";

import { goalError } from "./types.js";
import type { GoalDraft, GoalError, GoalParser } from "./types.js";
import {
  GOAL_STATUSES,
  METRIC_UNITS,
  assertTransition,
  assessCompleteness,
  isValidCurrency,
  isValidMetricTarget,
  validateGoalCore,
} from "./validation.js";

export * from "./types.js";
export * from "./validation.js";
export { DeterministicGoalParser, deterministicGoalParser, toBrainSnapshot } from "./parser.js";

/**
 * Storage the Revenue Goal Engine depends on.
 *
 * Declared as an interface so the domain is testable in isolation and a
 * future database driver can replace the JSON store without touching it.
 */
export interface GoalRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;
  createRevenueGoal(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    goal: Omit<RevenueGoal, "id" | "workspaceId" | "createdBy" | "createdAt" | "updatedAt">;
  }): Result<RevenueGoal, { code: string }>;
  listRevenueGoals(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: RevenueGoalStatus },
  ): Result<RevenueGoal[], { code: string }>;
  getRevenueGoal(id: EntityId, userId: EntityId): Result<RevenueGoal, { code: string }>;
  updateRevenueGoal(
    id: EntityId,
    input: {
      userId: EntityId;
      patch: Partial<Omit<RevenueGoal, "id" | "workspaceId" | "createdBy" | "createdAt">>;
    },
  ): Result<RevenueGoal, { code: string }>;
  setRevenueGoalStatus(
    id: EntityId,
    userId: EntityId,
    status: RevenueGoalStatus,
  ): Result<RevenueGoal, { code: string }>;
  listRevenueGoalEvents(
    goalId: EntityId,
    userId: EntityId,
  ): Result<RevenueGoalEvent[], { code: string }>;
}

/**
 * Canonical business context the goal may reference.
 *
 * Only the read surface the engine needs, and always scoped to one
 * workspace: references are validated against this, so a goal can never
 * point at another workspace's data.
 */
export interface GoalBusinessContext {
  workspaceId: string;
  company: { name: string; market: string | null; industry: string | null } | null;
  offers: { id: string; name: string }[];
  /** The workspace's single canonical ICP, if one exists. */
  icp: { id: string } | null;
  personas: { id: string; title: string }[];
}

function fromStorage(code: string, fallback: string): GoalError {
  switch (code) {
    case "NOT_FOUND":
      return goalError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return goalError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return goalError("CONFLICT", fallback);
    case "INVALID":
      return goalError("VALIDATION_ERROR", fallback);
    default:
      // Never surface raw storage messages.
      return goalError("UNAVAILABLE", "storage unavailable");
  }
}

const REQUIRED_METRIC_KINDS: readonly GoalMetricKind[] = [
  "revenue",
  "pipeline",
  "qualified_opportunity",
  "meeting",
  "customer",
  "conversion_rate",
  "time_to_target",
];

function isMetricKind(value: unknown): value is GoalMetricKind {
  return typeof value === "string" && (REQUIRED_METRIC_KINDS as readonly string[]).includes(value);
}

/**
 * Goal input as received from a transport layer.
 *
 * Deliberately untrusted: every field is `unknown` because validation is the
 * service's job, not the handler's. Callers that already hold typed data
 * (the natural-language path) can pass it directly — a typed value is
 * assignable to `unknown`.
 */
export interface CreateGoalInput {
  objective?: unknown;
  targetMetric?: unknown;
  targetValue?: unknown;
  currency?: unknown;
  timeWindow?: unknown;
  market?: unknown;
  offerId?: unknown;
  icpId?: unknown;
  buyerPersonaIds?: unknown;
  economics?: unknown;
  constraints?: unknown;
  approvalPolicy?: unknown;
  successMetrics?: unknown;
  status?: unknown;
}

/** Narrow untrusted input to the shapes the service uses internally. */
function asOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asTimeWindow(value: unknown): { start: string; end: string } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const raw = asObject(value);
  const start = typeof raw.start === "string" ? raw.start : "";
  const end = typeof raw.end === "string" ? raw.end : "";
  return { start, end };
}

function asMetrics(value: unknown): RevenueGoalMetric[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const metric = asObject(entry);
    return {
      kind: (typeof metric.kind === "string" ? metric.kind : "revenue") as GoalMetricKind,
      target: typeof metric.target === "number" ? metric.target : Number.NaN,
      unit: typeof metric.unit === "string" ? metric.unit : METRIC_UNITS.revenue,
    };
  });
}

/**
 * The Revenue Goal application service.
 *
 * Responsibilities:
 * - Resolve authorization from the authenticated identity on every call.
 * - Validate goal structure and reject invalid goals outright.
 * - Validate that Business Brain references belong to this workspace.
 * - Validate lifecycle transitions server-side.
 * - Convert parser drafts into goals while preserving field provenance.
 *
 * It never performs an external action: Phase 3 is goal definition only.
 */
export class RevenueGoalService {
  constructor(
    private readonly repo: GoalRepository,
    private readonly parser: GoalParser,
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, GoalError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(goalError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(goalError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * Verify every Business Brain reference belongs to this workspace.
   *
   * A workspace-A goal pointing at a workspace-B offer is rejected: the ids
   * are looked up in the caller-supplied canonical context, which is itself
   * workspace-scoped, and any id absent from it is refused.
   */
  private validateReferences(
    refs: { offerId?: string | null; icpId?: string | null; buyerPersonaIds?: readonly string[] },
    context: GoalBusinessContext,
  ): GoalError | null {
    if (refs.offerId) {
      if (!context.offers.some((o) => o.id === refs.offerId)) {
        return goalError("VALIDATION_ERROR", "referenced offer does not exist in this workspace", [
          { field: "offerId", message: "offerId does not belong to this workspace" },
        ]);
      }
    }
    if (refs.icpId) {
      if (context.icp?.id !== refs.icpId) {
        return goalError("VALIDATION_ERROR", "referenced ICP does not exist in this workspace", [
          { field: "icpId", message: "icpId does not belong to this workspace" },
        ]);
      }
    }
    for (const personaId of refs.buyerPersonaIds ?? []) {
      if (!context.personas.some((p) => p.id === personaId)) {
        return goalError(
          "VALIDATION_ERROR",
          "referenced persona does not exist in this workspace",
          [
            {
              field: "buyerPersonaIds",
              message: `persona ${personaId} does not belong to this workspace`,
            },
          ],
        );
      }
    }
    return null;
  }

  // --- Create / read ----------------------------------------------------

  createRevenueGoal(
    workspaceId: EntityId,
    userId: EntityId,
    input: CreateGoalInput,
    context: GoalBusinessContext,
  ): Result<RevenueGoal, GoalError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const objective = typeof input.objective === "string" ? input.objective : "";
    const targetValue = typeof input.targetValue === "number" ? input.targetValue : Number.NaN;
    const currency = asOptionalString(input.currency) ?? null;
    const timeWindow = asTimeWindow(input.timeWindow) ?? null;
    const market = asOptionalString(input.market) ?? null;
    const offerId = asOptionalString(input.offerId) ?? null;
    const icpId = asOptionalString(input.icpId) ?? null;
    const buyerPersonaIds = asOptionalStringArray(input.buyerPersonaIds) ?? [];

    const core = validateGoalCore({
      objective,
      targetMetric: input.targetMetric,
      targetValue,
      currency,
      timeWindow: timeWindow ? { start: timeWindow.start, end: timeWindow.end } : null,
    });
    if (core) return err(core);

    if (!isMetricKind(input.targetMetric)) {
      return err(
        goalError("VALIDATION_ERROR", "targetMetric is invalid", [
          { field: "targetMetric", message: `must be one of: ${REQUIRED_METRIC_KINDS.join(", ")}` },
        ]),
      );
    }

    const referenceError = this.validateReferences({ offerId, icpId, buyerPersonaIds }, context);
    if (referenceError) return err(referenceError);

    const providedMetrics = asMetrics(input.successMetrics) ?? [];
    for (const metric of providedMetrics) {
      if (!isValidMetricTarget(metric.target)) {
        return err(
          goalError("VALIDATION_ERROR", "success metric target is invalid", [
            { field: "successMetrics", message: "each metric target must be greater than 0" },
          ]),
        );
      }
    }

    // A goal must always carry at least one measurable success criterion. When
    // the caller states none explicitly, the headline target *is* that
    // criterion: it is restated from what the caller already said, never
    // invented, so it is not recorded as an assumption.
    const kind = input.targetMetric as GoalMetricKind;
    const successMetrics =
      providedMetrics.length > 0
        ? providedMetrics
        : [
            {
              kind,
              target: targetValue,
              unit: currency ?? METRIC_UNITS[kind],
            },
          ];

    const status: RevenueGoalStatus =
      typeof input.status === "string" ? (input.status as RevenueGoalStatus) : "draft";
    if (status !== "draft") {
      return err(
        goalError("VALIDATION_ERROR", "a new goal must start in draft", [
          { field: "status", message: "use changeRevenueGoalStatus to activate a goal" },
        ]),
      );
    }

    const rawEconomics = asObject(input.economics);
    const economics = {
      averageDealValue:
        typeof rawEconomics.averageDealValue === "number" ? rawEconomics.averageDealValue : null,
      minimumContractValue:
        typeof rawEconomics.minimumContractValue === "number"
          ? rawEconomics.minimumContractValue
          : null,
      targetCustomers:
        typeof rawEconomics.targetCustomers === "number" ? rawEconomics.targetCustomers : null,
      currency: asOptionalString(rawEconomics.currency) ?? asOptionalString(input.currency) ?? null,
    };

    const rawConstraints = asObject(input.constraints);
    const constraints = {
      geographies: asOptionalStringArray(rawConstraints.geographies) ?? [],
      industries: asOptionalStringArray(rawConstraints.industries) ?? [],
      companySizes: asOptionalStringArray(rawConstraints.companySizes) ?? [],
      channels: asOptionalStringArray(rawConstraints.channels) ?? [],
      budget: asOptionalString(rawConstraints.budget) ?? null,
      maxOutreachPerDay:
        typeof rawConstraints.maxOutreachPerDay === "number"
          ? rawConstraints.maxOutreachPerDay
          : null,
      notes: asOptionalString(rawConstraints.notes) ?? null,
    };

    const { completeness, gaps } = assessCompleteness({
      timeWindow,
      successMetrics,
      offerId,
      market,
    });

    const rawPolicy = asObject(input.approvalPolicy);
    const created = this.repo.createRevenueGoal({
      workspaceId,
      createdBy: userId,
      goal: {
        objective: objective.trim(),
        targetMetric: input.targetMetric,
        targetValue,
        currency,
        timeWindow: timeWindow ?? { start: "", end: "" },
        market,
        icpId,
        buyerPersonaIds,
        offerId,
        economics,
        constraints,
        approvalPolicy: {
          // Level 2 is the default ceiling: downstream execution of a revenue
          // goal reaches external actions, which require approval.
          maxRiskLevel:
            typeof rawPolicy.maxRiskLevel === "string"
              ? (rawPolicy.maxRiskLevel as RevenueGoal["approvalPolicy"]["maxRiskLevel"])
              : "level_2_external_action",
          externalActionsRequireApproval:
            typeof rawPolicy.externalActionsRequireApproval === "boolean"
              ? rawPolicy.externalActionsRequireApproval
              : true,
          approverUserId: asOptionalString(rawPolicy.approverUserId) ?? null,
        },
        successMetrics,
        status,
        completeness,
        unknowns: gaps,
        assumptions: [],
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "revenue goal creation failed"));
    return ok(created.value);
  }

  getRevenueGoal(id: EntityId, userId: EntityId): Result<RevenueGoal, GoalError> {
    if (!id || typeof id !== "string") {
      return err(goalError("VALIDATION_ERROR", "goal id is required"));
    }
    const goal = this.repo.getRevenueGoal(id, userId);
    if (!goal.ok) return err(fromStorage(goal.error.code, "revenue goal not found"));
    return ok(goal.value);
  }

  listRevenueGoals(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: RevenueGoalStatus },
  ): Result<RevenueGoal[], GoalError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.status !== undefined && !GOAL_STATUSES.includes(filter.status)) {
      return err(
        goalError("VALIDATION_ERROR", "invalid status filter", [
          { field: "status", message: `status must be one of: ${GOAL_STATUSES.join(", ")}` },
        ]),
      );
    }
    const goals = this.repo.listRevenueGoals(workspaceId, userId, filter);
    if (!goals.ok) return err(fromStorage(goals.error.code, "revenue goals unavailable"));
    return ok(goals.value);
  }

  /** Auditable goal history. */
  goalHistory(id: EntityId, userId: EntityId): Result<RevenueGoalEvent[], GoalError> {
    if (!id || typeof id !== "string") {
      return err(goalError("VALIDATION_ERROR", "goal id is required"));
    }
    const events = this.repo.listRevenueGoalEvents(id, userId);
    if (!events.ok) return err(fromStorage(events.error.code, "goal history unavailable"));
    return ok(events.value);
  }

  // --- Update -----------------------------------------------------------

  updateRevenueGoal(
    id: EntityId,
    userId: EntityId,
    patch: Partial<CreateGoalInput>,
    context: GoalBusinessContext,
  ): Result<RevenueGoal, GoalError> {
    if (!id || typeof id !== "string") {
      return err(goalError("VALIDATION_ERROR", "goal id is required"));
    }
    const existing = this.repo.getRevenueGoal(id, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "revenue goal not found"));

    // `unknown` is narrowed to the validated shapes after `validateGoalCore`
    // has accepted the merged goal below.
    const mergedInput = {
      objective: patch.objective ?? existing.value.objective,
      targetMetric: patch.targetMetric ?? existing.value.targetMetric,
      targetValue: patch.targetValue ?? existing.value.targetValue,
      currency:
        patch.currency === undefined
          ? existing.value.currency
          : (asOptionalString(patch.currency) ?? null),
      timeWindow:
        patch.timeWindow === undefined
          ? existing.value.timeWindow.start
            ? { start: existing.value.timeWindow.start, end: existing.value.timeWindow.end }
            : null
          : (asTimeWindow(patch.timeWindow) ?? null),
    };

    const core = validateGoalCore(mergedInput);
    if (core) return err(core);

    // validateGoalCore guarantees these shapes; narrow them once, here.
    const merged = {
      objective: typeof mergedInput.objective === "string" ? mergedInput.objective : "",
      targetMetric: mergedInput.targetMetric as GoalMetricKind,
      targetValue:
        typeof mergedInput.targetValue === "number" ? mergedInput.targetValue : Number.NaN,
      currency: mergedInput.currency,
      timeWindow: mergedInput.timeWindow,
    };

    const nextOfferId =
      patch.offerId === undefined
        ? existing.value.offerId
        : (asOptionalString(patch.offerId) ?? null);
    const nextIcpId =
      patch.icpId === undefined ? existing.value.icpId : (asOptionalString(patch.icpId) ?? null);
    const nextPersonaIds =
      patch.buyerPersonaIds === undefined
        ? existing.value.buyerPersonaIds
        : (asOptionalStringArray(patch.buyerPersonaIds) ?? []);

    if (
      patch.offerId !== undefined ||
      patch.icpId !== undefined ||
      patch.buyerPersonaIds !== undefined
    ) {
      const referenceError = this.validateReferences(
        { offerId: nextOfferId, icpId: nextIcpId, buyerPersonaIds: nextPersonaIds },
        context,
      );
      if (referenceError) return err(referenceError);
    }

    const nextMetrics = asMetrics(patch.successMetrics);
    if (nextMetrics !== undefined) {
      for (const metric of nextMetrics) {
        if (!isValidMetricTarget(metric.target)) {
          return err(
            goalError("VALIDATION_ERROR", "success metric target is invalid", [
              { field: "successMetrics", message: "each metric target must be greater than 0" },
            ]),
          );
        }
      }
    }

    const nextEconomicsCurrency = asOptionalString(asObject(patch.economics).currency);
    if (nextEconomicsCurrency !== undefined && nextEconomicsCurrency !== null) {
      if (!isValidCurrency(nextEconomicsCurrency)) {
        return err(
          goalError("VALIDATION_ERROR", "currency must be a 3-letter code such as USD", [
            { field: "economics.currency", message: "invalid currency code" },
          ]),
        );
      }
    }

    const nextTimeWindow = merged.timeWindow;
    const resolvedMetrics = nextMetrics ?? existing.value.successMetrics;
    const nextMarket =
      patch.market === undefined ? existing.value.market : (asOptionalString(patch.market) ?? null);
    const { completeness, gaps } = assessCompleteness({
      timeWindow: nextTimeWindow,
      successMetrics: resolvedMetrics,
      offerId: nextOfferId,
      market: nextMarket,
    });

    const updatePatch: Partial<
      Omit<RevenueGoal, "id" | "workspaceId" | "createdBy" | "createdAt">
    > = {
      objective: merged.objective.trim(),
      targetMetric: merged.targetMetric,
      targetValue: merged.targetValue,
      currency: merged.currency,
      timeWindow: nextTimeWindow ?? { start: "", end: "" },
      completeness,
      unknowns: gaps,
    };
    if (patch.market !== undefined) updatePatch.market = nextMarket;
    if (patch.offerId !== undefined) updatePatch.offerId = nextOfferId;
    if (patch.icpId !== undefined) updatePatch.icpId = nextIcpId;
    if (patch.buyerPersonaIds !== undefined) updatePatch.buyerPersonaIds = nextPersonaIds;
    if (nextMetrics !== undefined) updatePatch.successMetrics = nextMetrics;
    if (patch.economics !== undefined) {
      updatePatch.economics = {
        ...existing.value.economics,
        ...asObject(patch.economics),
      } as RevenueGoal["economics"];
    }
    if (patch.constraints !== undefined) {
      updatePatch.constraints = {
        ...existing.value.constraints,
        ...asObject(patch.constraints),
      } as RevenueGoal["constraints"];
    }
    if (patch.approvalPolicy !== undefined) {
      updatePatch.approvalPolicy = {
        ...existing.value.approvalPolicy,
        ...asObject(patch.approvalPolicy),
      } as RevenueGoal["approvalPolicy"];
    }

    const updated = this.repo.updateRevenueGoal(id, { userId, patch: updatePatch });
    if (!updated.ok) return err(fromStorage(updated.error.code, "revenue goal update failed"));
    return ok(updated.value);
  }

  // --- Lifecycle --------------------------------------------------------

  /**
   * Move a goal through its lifecycle.
   *
   * The current status is read from storage, never supplied by the client, so
   * a caller cannot skip validation by asserting where the goal is.
   */
  changeRevenueGoalStatus(
    id: EntityId,
    userId: EntityId,
    next: unknown,
  ): Result<RevenueGoal, GoalError> {
    if (!id || typeof id !== "string") {
      return err(goalError("VALIDATION_ERROR", "goal id is required"));
    }
    const existing = this.repo.getRevenueGoal(id, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "revenue goal not found"));

    const transition = assertTransition(existing.value.status, next as RevenueGoalStatus);
    if (transition) return err(transition);

    const updated = this.repo.setRevenueGoalStatus(id, userId, next as RevenueGoalStatus);
    if (!updated.ok) return err(fromStorage(updated.error.code, "revenue goal update failed"));
    return ok(updated.value);
  }

  /** Archive a goal. Archiving is the terminal transition. */
  archiveRevenueGoal(id: EntityId, userId: EntityId): Result<RevenueGoal, GoalError> {
    return this.changeRevenueGoalStatus(id, userId, "archived");
  }

  // --- Natural language -------------------------------------------------

  /**
   * Parse natural-language input into a structured goal.
   *
   * Parsing never mutates state and is a pure function of (input, canonical
   * Business Brain context, reference instant). The draft is returned with
   * the provenance of every field; `createFromNaturalLanguage` is what turns
   * it into a persisted goal.
   */
  parseRevenueGoalInput(
    input: string,
    context: GoalBusinessContext,
    now: Date,
  ): Result<GoalDraft, GoalError> {
    if (typeof input !== "string" || input.trim() === "") {
      return err(
        goalError("VALIDATION_ERROR", "goal input is required", [
          { field: "input", message: "input must be a non-empty string" },
        ]),
      );
    }
    return ok(this.parser.parse(input, context, now));
  }

  /**
   * Convert a natural-language goal into a persisted RevenueGoal.
   *
   * Fields the parser could not determine are recorded as unknowns and mark
   * the goal incomplete; nothing is invented to fill the gap. A goal whose
   * core is undeterminable is rejected as invalid instead.
   */
  createFromNaturalLanguage(
    workspaceId: EntityId,
    userId: EntityId,
    input: string,
    context: GoalBusinessContext,
    now: Date,
  ): Result<RevenueGoal, GoalError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const parsed = this.parseRevenueGoalInput(input, context, now);
    if (!parsed.ok) return parsed;
    const draft = parsed.value;
    const f = draft.fields;

    // A goal with no determinable objective, metric or value is invalid, not
    // merely incomplete.
    if (
      f.objective.value === null ||
      f.targetMetric.value === null ||
      f.targetValue.value === null
    ) {
      const details: { field: string; message: string }[] = [];
      if (f.objective.value === null)
        details.push({ field: "objective", message: f.objective.note ?? "missing" });
      if (f.targetMetric.value === null)
        details.push({ field: "targetMetric", message: f.targetMetric.note ?? "missing" });
      if (f.targetValue.value === null)
        details.push({ field: "targetValue", message: f.targetValue.note ?? "missing" });
      return err(
        goalError(
          "VALIDATION_ERROR",
          "the goal input does not state a measurable outcome",
          details,
        ),
      );
    }

    const metrics: RevenueGoalMetric[] = [
      {
        kind: f.targetMetric.value,
        target: f.targetValue.value,
        unit: f.currency.value ? f.currency.value : METRIC_UNITS[f.targetMetric.value],
      },
    ];

    const referenceError = this.validateReferences(
      {
        offerId: f.offerId.value,
        icpId: f.icpId.value,
        buyerPersonaIds: f.buyerPersonaIds.value ?? [],
      },
      context,
    );
    if (referenceError) return err(referenceError);

    const created = this.repo.createRevenueGoal({
      workspaceId,
      createdBy: userId,
      goal: {
        objective: f.objective.value,
        targetMetric: f.targetMetric.value,
        targetValue: f.targetValue.value,
        currency: f.currency.value,
        timeWindow: f.timeWindow.value ?? { start: "", end: "" },
        market: f.market.value,
        icpId: f.icpId.value,
        buyerPersonaIds: f.buyerPersonaIds.value ?? [],
        offerId: f.offerId.value,
        economics: {
          averageDealValue: null,
          minimumContractValue: f.minimumContractValue.value,
          targetCustomers: null,
          currency: f.currency.value,
        },
        constraints: {
          geographies: f.constraints.value?.geographies ?? [],
          industries: f.constraints.value?.industries ?? [],
          companySizes: f.constraints.value?.companySizes ?? [],
          channels: f.constraints.value?.channels ?? [],
          budget: null,
          maxOutreachPerDay: null,
          notes: null,
        },
        approvalPolicy: {
          // Downstream execution is Level 2+ by default: approval is required.
          maxRiskLevel: "level_2_external_action",
          externalActionsRequireApproval: true,
          approverUserId: null,
        },
        successMetrics: metrics,
        status: "draft",
        completeness: "complete",
        unknowns: [],
        assumptions: [],
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "revenue goal creation failed"));

    // Provenance is applied after creation so the persisted record documents
    // exactly which fields were stated, inferred or assumed.
    const assumptions: string[] = [];
    const unknowns = [...created.value.unknowns];
    for (const [name, entry] of Object.entries(f)) {
      if (entry.origin === "assumption" && entry.note) {
        assumptions.push(`${name}: ${entry.note}`);
      }
      if (entry.origin === "unknown" && entry.note) {
        if (!unknowns.some((u) => u.field === name)) {
          unknowns.push({ field: name, reason: entry.note });
        }
      }
    }
    for (const unresolved of draft.unresolvedReferences) {
      if (!unknowns.some((u) => u.field === `${unresolved.kind}Id`)) {
        unknowns.push({
          field: `${unresolved.kind}Id`,
          reason: `"${unresolved.value}" did not match a Business Brain ${unresolved.kind}`,
        });
      }
    }

    const { completeness, gaps } = assessCompleteness({
      timeWindow: f.timeWindow.value,
      successMetrics: metrics,
      offerId: f.offerId.value,
      market: f.market.value,
    });
    const finalUnknowns = [...gaps];
    for (const extra of unknowns) {
      if (!finalUnknowns.some((u) => u.field === extra.field)) finalUnknowns.push(extra);
    }

    const updated = this.repo.updateRevenueGoal(created.value.id, {
      userId,
      patch: {
        completeness,
        unknowns: finalUnknowns,
        assumptions,
      },
    });
    if (!updated.ok) return err(fromStorage(updated.error.code, "revenue goal update failed"));
    return ok(updated.value);
  }
}

export type { EntityId };
