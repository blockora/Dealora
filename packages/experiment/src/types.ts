/**
 * @dealora/experiment — types for the Phase 22 Experiment Engine
 * (`ROADMAP.md` §29, `DEALORA_BLUEPRINT.md` §27).
 *
 * §29 asks for controlled experiments — Message A vs Message B, measured on
 * the positive reply rate over a qualified population for a declared duration
 * — and for five tracked dimensions: sample size, conversion, confidence,
 * cost and revenue impact. Its critical rule is one sentence:
 *
 * > Do not claim a winning experiment when evidence is insufficient.
 *
 * The package is split along the declared/derived line, exactly like the cost
 * engine before it:
 *
 * - **Declared facts** (`ExperimentRow` / `ExperimentArmRow` /
 *   `ExperimentEventRow`): the workspace's declaration — which immutable
 *   drafts are compared, on which metric, over how many days — plus the
 *   append-only lifecycle trail. Written by the store's transition methods;
 *   no request can supply a status, a timestamp or a winner.
 *
 * - **Derived answers** (`ExperimentComparison` and everything under it):
 *   recomputed on every read from rows the earlier phases already stored.
 *   There is no stored rate, total or verdict anywhere, so nothing can go
 *   stale and §29's critical rule is structural — a winner exists only in the
 *   answer, and only when the published evidence rule says so.
 *
 * Negative space, stated once: this package sends nothing, books nothing,
 * assigns nobody to anything, and owns no clock inside a derivation. The
 * send still runs through Phase 10's approval and Phase 11's suppression
 * checks; a reply is still read by Phase 12; the population is still decided
 * by Phase 8's qualifications. The experiment measures the revenue loop; it
 * does not drive it.
 */

import type {
  CostEvent,
  ConversationClassification,
  EntityId,
  Experiment,
  ExperimentArm,
  ExperimentEvent,
  Meeting,
  OutboundAction,
} from "@dealora/db";
import type { CostBreakdown } from "@dealora/cost";

/** One declared experiment, exactly as the store holds it. */
export type ExperimentRow = Experiment;

/** One declared arm, exactly as the store holds it. */
export type ExperimentArmRow = ExperimentArm;

/** One append-only lifecycle event, exactly as the store holds it. */
export type ExperimentEventRow = ExperimentEvent;

/** The closed error vocabulary this domain reports to the transport layer. */
export type ExperimentErrorCode =
  "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_ERROR" | "CONFLICT" | "UNAVAILABLE";

export interface ExperimentError {
  readonly code: ExperimentErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** Every store method's result shape, stated structurally like the cost engine's. */
export type StorageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

/** The write commands a caller may send. No status, timestamp or identity field exists. */
export interface CreateExperimentInput {
  readonly name: unknown;
  readonly metric: unknown;
  readonly durationDays: unknown;
}

export interface AddExperimentArmInput {
  readonly draftId: unknown;
  readonly label: unknown;
}

export interface CancelExperimentInput {
  readonly reason: unknown;
}

/** One experiment as callers see it: the stored declaration and nothing else. */
export interface ExperimentView {
  readonly id: EntityId;
  readonly name: string;
  readonly metric: string;
  readonly status: string;
  readonly durationDays: number;
  readonly createdBy: EntityId;
  readonly createdAt: string;
  readonly startedBy: EntityId | null;
  readonly startedAt: string | null;
  readonly closedBy: EntityId | null;
  readonly closedAt: string | null;
  readonly cancelledBy: EntityId | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
}

/** One arm as callers see it, in declared order. */
export interface ExperimentArmView {
  readonly id: EntityId;
  readonly position: number;
  readonly draftId: EntityId;
  readonly label: string;
}

/** One lifecycle event as callers see it. */
export interface ExperimentEventView {
  readonly id: EntityId;
  readonly kind: string;
  readonly actorUserId: EntityId;
  readonly detail: string | null;
  readonly createdAt: string;
}

/**
 * The five §29 tracked dimensions for one arm. Every number is derived from
 * stored rows on this read; nothing here was ever persisted.
 */
export interface ExperimentArmResult {
  readonly position: number;
  readonly draftId: EntityId;
  readonly label: string;
  /** §29 "sample size": distinct contacts exposed to this arm in the window. */
  readonly sampleSize: number;
  /** §29 "conversion": of those, the contacts whose reply read positive. */
  readonly conversions: number;
  /**
   * The conversion rate in exact integer basis points, floored — with the
   * remainder reported next to it, so the exact quotient
   * `conversions / sampleSize` is always reconstructable. `null` at zero
   * sample, because 0/0 is not a rate.
   */
  readonly conversionRateBasisPoints: number | null;
  readonly conversionRateRemainderTenThousandths: number;
  /** §29 "cost": Phase 16's own facts for this arm's sends, its own totals. */
  readonly cost: CostBreakdown;
  /**
   * §29 "revenue impact", measured as the revenue-adjacent outcome this
   * system actually records: meetings the loop advanced onto a calendar
   * (`booked` or `held`) from this arm's sends. No monetary revenue exists
   * anywhere in the repository yet, and this phase refuses to invent one.
   */
  readonly meetingsOnCalendar: number;
  readonly revenueImpactMinor: null;
  readonly revenueImpactReason: string;
  /** The exposure detail: how many in-window sends this arm recorded. */
  readonly exposures: number;
  /**
   * Contacts excluded from this arm because they also received another arm's
   * message inside the window — a controlled experiment needs arms that do
   * not overlap, so contamination is disclosed rather than silently averaged.
   */
  readonly excludedCrossArmContacts: number;
}

/**
 * §29 "confidence": how much evidence the comparison rests on, as a band —
 * never a percentage. The bands are published policy (see `rules.ts`); no
 * p-value is computed and none is implied.
 */
export type ExperimentConfidence = "insufficient" | "low" | "medium" | "high";

/**
 * §29's decision, derived on read and never stored. `winner` requires both
 * arms to meet the published minimum sample **and** the published minimum
 * lift; every other case preserves §29's critical rule by refusing to crown.
 */
export type ExperimentDecisionStatus =
  "insufficient_evidence" | "no_material_difference" | "winner";

export interface ExperimentDecision {
  readonly status: ExperimentDecisionStatus;
  /** The winning arm's position; `null` unless status is `winner`. */
  readonly winnerPosition: number | null;
  readonly winnerDraftId: EntityId | null;
  /** Why this decision, in a sentence a reader can check against the numbers. */
  readonly reason: string;
}

/** The whole derived comparison for one experiment on this read. */
export interface ExperimentComparison {
  readonly ruleVersion: string;
  readonly metric: string;
  readonly decision: ExperimentDecision;
  readonly confidence: ExperimentConfidence;
  /** The derived analysis window: declared start, capped by an early close. */
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly arms: readonly ExperimentArmResult[];
  readonly populationAccounts: number;
  readonly notes: readonly string[];
}

/** One experiment read back complete: declaration, trail and derived comparison. */
export interface ExperimentRead {
  readonly experiment: ExperimentView;
  readonly arms: readonly ExperimentArmView[];
  readonly events: readonly ExperimentEventView[];
  readonly comparison: ExperimentComparison;
}

/** What a caller may send to the policy route's cousins: nothing here. */
export interface ExperimentPolicyView {
  readonly ruleVersion: string;
  readonly metric: {
    readonly name: string;
    readonly status: "derived";
    readonly definition: string;
  };
  readonly refusedMetrics: readonly {
    readonly name: string;
    readonly reason: string;
    readonly owningPhase: string | null;
  }[];
  readonly decisionRule: string;
  readonly thresholds: {
    readonly minSamplePerArm: number;
    readonly minLiftBasisPoints: number;
    readonly mediumSampleMultiplier: number;
    readonly highSampleMultiplier: number;
  };
  readonly populationDefinition: string;
  readonly conversionDefinition: string;
  readonly costDefinition: string;
  readonly revenueImpactDefinition: string;
  readonly armLimits: { readonly min: number; readonly max: number };
  readonly durationLimits: { readonly minDays: number; readonly maxDays: number };
  readonly labelLimit: number;
  readonly nameLimit: number;
  readonly neverDoes: readonly string[];
}

/**
 * The read surface this phase reads from, stated structurally so the service
 * can be wired to the concrete repository without importing its internals.
 * Every method is workspace-scoped inside the store itself; the service passes
 * the caller's session identity, never a role or a claim the client sent.
 */
export interface ExperimentLookup {
  authorize(workspaceId: string, userId: string): StorageResult<unknown>;
  createExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly name: string;
    readonly metric: string;
    readonly durationDays: number;
  }): StorageResult<ExperimentRow>;
  getExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
  }): StorageResult<ExperimentRow | null>;
  listExperiments(
    workspaceId: string,
    userId: string,
    filter?: { readonly status?: string },
  ): StorageResult<readonly ExperimentRow[]>;
  addExperimentArm(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
    readonly draftId: string;
    readonly label: string;
  }): StorageResult<ExperimentArmRow>;
  listExperimentArms(
    workspaceId: string,
    userId: string,
    experimentId: string,
  ): StorageResult<readonly ExperimentArmRow[]>;
  startExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
  }): StorageResult<ExperimentRow>;
  closeExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
  }): StorageResult<ExperimentRow>;
  cancelExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
    readonly reason: string | null;
  }): StorageResult<ExperimentRow>;
  listExperimentEvents(
    workspaceId: string,
    userId: string,
    experimentId: string,
  ): StorageResult<readonly ExperimentEventRow[]>;

  /** The population and attribution rows, all workspace-scoped by the store. */
  listAccounts(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly { id: string; status: string }[]>;
  listContacts(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly { id: string; accountId: string; status: string }[]>;
  listQualifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly { accountId: string; version: number; state: string }[]>;
  listOutboundActions(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly OutboundAction[]>;
  listConversationClassifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly ConversationClassification[]>;
  listMeetings(workspaceId: string, userId: string): StorageResult<readonly Meeting[]>;
  listCostEvents(
    workspaceId: string,
    userId: string,
    filter?: { readonly executionKind?: string },
  ): StorageResult<readonly CostEvent[]>;
}
