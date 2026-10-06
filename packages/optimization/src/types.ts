/** @dealora/optimization — types for the Phase 21 Optimization Engine.

 * `ROADMAP.md` §28 asks this phase to compare the eight dimensions
 * (audiences, messages, signals, channels, timing, qualification rules,
 * follow-up sequences, offers), to answer the five questions (what worked,
 * what failed, where conversion drops, what should be tested, the likely
 * impact), and to be *measurable, reversible and auditable*.
 *
 * It does **not** ask for a runner, a dispatcher, live model calls,
 * scheduled sends, calendar holds or CRM writes — this phase reads what
 * the earlier phases already stored and turns those facts into optimization
 * *observations*, never into actions.
 *
 * Phase 21 introduced the optimization package; the shapes below are public
 * only so other phases can evolve in lockstep. They are intentionally
 * verbose on purpose: every entry describes the observable surface the
 * phase may read, never the internal implementation detail.
 */

import type {
  EntityId,
  IsoDate,
  Account,
  Contact,
  PersonalizedDraft,
  OutboundAction,
  OutboundEvent,
  ConversationClassification,
  Meeting,
  Offer,
  Qualification,
  ResearchFinding,
  AgentTraceRun,
  AgentTraceEvent,
  InboundMessage,
  CostEvent,
} from "@dealora/db";

/** The read surface this phase reads from. It is intentionally read-only. */
export interface OptimizationRepository {
  authorize(workspaceId: EntityId, userId: EntityId): boolean;
  listAccounts(workspaceId: EntityId, userId: EntityId): readonly Account[];
  listContacts(workspaceId: EntityId, userId: EntityId): readonly Contact[];
  listOffers(workspaceId: EntityId, userId: EntityId): readonly Offer[];
  listDrafts(workspaceId: EntityId, userId: EntityId): readonly PersonalizedDraft[];
  listOutboundActions(workspaceId: EntityId, userId: EntityId): readonly OutboundAction[];
  listOutboundEvents(workspaceId: EntityId, userId: EntityId): readonly OutboundEvent[];
  listConversationClassifications(
    workspaceId: EntityId,
    userId: EntityId,
  ): readonly ConversationClassification[];
  listMeetings(workspaceId: EntityId, userId: EntityId): readonly Meeting[];
  listQualifications(workspaceId: EntityId, userId: EntityId): readonly Qualification[];
  listResearchFindings(workspaceId: EntityId, userId: EntityId): readonly ResearchFinding[];
  listCostEvents(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { executionKind?: string },
  ): readonly CostEvent[];
  listAgentTraceRuns(
    workspaceId: EntityId,
    userId: EntityId,
    options?: { agentId?: EntityId },
  ): readonly AgentTraceRun[];
  listAgentTraceEvents(
    workspaceId: EntityId,
    userId: EntityId,
    runId: EntityId,
  ): readonly AgentTraceEvent[];
  listInboundMessages(workspaceId: EntityId, userId: EntityId): readonly InboundMessage[];
}

/** One source row the optimizer may examine, normalized to a common shape. */
export type OptSource = {
  id: EntityId;
  workspaceId: EntityId;
  signature: string;
  perspective: string;
  createdAt: IsoDate;
};

/** One optimization facet (one of the eight §28 dimensions). */
export type OptFacet = {
  facet: string;
  dimension: string;
  sources: readonly OptSource[];
  observations: readonly OptObservation[];
  learnings: readonly OptLearning[];
  questions: readonly OptQuestion[];
  hypotheses: readonly OptHypothesis[];
};

/** One observation within a facet: a measured, auditable read of the workspace data. */
export type OptObservation = {
  label: string;
  value: number | string | null;
  unit: string;
  direction: "up" | "down" | "flat" | "unknown";
  confidence: "high" | "low";
  evidence: readonly string[];
};

/** One suggested learning within a facet: a conclusion the optimizer can defend. */
export type OptLearning = {
  title: string;
  weight: number;
  reason: string;
  evidence: readonly string[];
};

/** One candidate test within a facet: something the optimizer flags for Phase 22 experimentation. */
export type OptQuestion = {
  question: string;
  candidateTest: string;
  rationale: string;
};

/** One likely-impact hypothesis within a facet. */
export type OptHypothesis = {
  hypothesis: string;
  expectedImpact: string;
  basis: readonly string[];
  confidence: "high" | "low";
};

/** The full optimization result for a workspace: eight facets across five answers. */
export type OptimizationResult = {
  workspaceId: EntityId;
  ruleVersion: string;
  facets: readonly OptFacet[];
  headlines: readonly OptHeadline[];
  learnings: readonly OptLearning[];
  questions: readonly OptQuestion[];
  hypotheses: readonly OptHypothesis[];
  audit: readonly string[];
};

/** One defensible headline across the workspace. */
export type OptHeadline = {
  kind: "worked" | "failed" | "dropping" | "test" | "impact";
  text: string;
  evidence: readonly string[];
  confidence: "high" | "low";
};
