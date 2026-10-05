/**
 * @dealora/revenuegraph — types for the Phase 15 Revenue Graph (ROADMAP.md §22,
 * DEALORA_BLUEPRINT.md §11).
 *
 * The graph is **derived, never stored**: every node and edge is computed on
 * read from rows other phases already wrote, so this phase adds no table, no
 * schema version and no migration — a persisted graph would duplicate the
 * facts it represents.
 *
 * Negative space, stated once and enforced everywhere:
 * - never writes (the repository surface is `authorize` alone),
 * - never acts (no sender, approver, scheduler, provider, clock or network),
 * - never recommends (Phase 14 owns advice; this phase only reports),
 * - never infers (a node appears only when its row exists; an edge only when
 *   the stored linkage proves it),
 * - never crosses a workspace (the account is resolved with the caller's
 *   identity first; a foreign id reads as missing).
 *
 * Ordering is a deterministic total order: nodes by (occurredAt, stage rank,
 * id), edges by (occurredAt, kind, from, to), an edge's occurredAt being its
 * target node's.
 */

import type { DateTime, EntityId } from "@dealora/db";

export type { DateTime, EntityId };

/**
 * The closed node vocabulary. These seven are exactly the CORE RELATIONSHIP
 * names of ROADMAP.md §22 that Phases 0-15 can actually produce; the other
 * five roadmap names (campaign, customer, revenue, agent, workflow) are
 * refused with a reason in `rules.ts`, and the two lists are asserted to
 * partition the roadmap list in the tests.
 */
export type RevenueGraphNodeKind =
  "company" | "person" | "signal" | "evidence" | "opportunity" | "conversation" | "meeting";

/**
 * Lifecycle stages, in the order the revenue loop visits them. A node's stage
 * rank is its index here, which is what makes node ordering lifecycle-shaped
 * even when several rows share an instant.
 */
export const REVENUE_GRAPH_STAGES = [
  "company",
  "person",
  "signal",
  "evidence",
  "opportunity",
  "conversation",
  "meeting",
] as const satisfies readonly RevenueGraphNodeKind[];

export type RevenueGraphStage = (typeof REVENUE_GRAPH_STAGES)[number];

/** Stage rank per kind; derived from the one declaration above. */
export const REVENUE_GRAPH_STAGE_RANK: ReadonlyMap<RevenueGraphNodeKind, number> = new Map(
  REVENUE_GRAPH_STAGES.map((kind, index) => [kind, index]),
);

/** The closed edge vocabulary: five aboutness anchors plus seven provenance links. */
export type RevenueGraphEdgeKind =
  | "company_has_person"
  | "company_has_signal"
  | "company_has_evidence"
  | "signal_became_evidence"
  | "company_has_opportunity"
  | "evidence_supports_opportunity"
  | "company_has_conversation"
  | "company_has_meeting"
  | "person_had_conversation"
  | "opportunity_led_to_conversation"
  | "conversation_led_to_meeting"
  | "person_joined_meeting";

/**
 * One graph node. `id` is the source row id (all DEALORA ids are random
 * UUIDs, globally unique). `label` and `state` are drawn verbatim from the
 * row; `state` is narrowed to a closed vocabulary per kind (`company`/`person`
 * → active|archived, `evidence` → its four statuses, `opportunity` → always
 * "qualified", `conversation` → intent, `meeting` → booking state, `signal` →
 * none). A row whose status disagrees with its vocabulary refuses the whole
 * account read rather than publish a half-understood graph.
 */
export interface RevenueGraphNode {
  readonly id: EntityId;
  readonly kind: RevenueGraphNodeKind;
  readonly occurredAt: DateTime;
  readonly label: string | null;
  readonly state: string | null;
}

/**
 * One graph edge. `derivedFrom` names the exact stored rows the derivation
 * rule read (table + id), so any edge can be audited against the database
 * without trusting the graph itself.
 */
export interface RevenueGraphEdge {
  readonly kind: RevenueGraphEdgeKind;
  readonly from: EntityId;
  readonly to: EntityId;
  readonly occurredAt: DateTime;
  readonly derivedFrom: readonly { kind: string; id: EntityId }[];
}

/** One stage of an opportunity lifecycle with the node ids at that stage. */
export interface OpportunityStage {
  readonly stage: RevenueGraphStage;
  readonly nodeIds: readonly EntityId[];
}

/**
 * The lifecycle view: non-empty stages in loop order, the furthest stage the
 * account has reached, and the opportunity node when one exists. `frontier`
 * is `company` only when the graph is empty (an unknown account never reaches
 * this type — the service refuses first).
 */
export interface OpportunityLifecycle {
  readonly stages: readonly OpportunityStage[];
  readonly frontier: RevenueGraphStage;
  readonly opportunity: EntityId | null;
}

/** The answer to "trace the lifecycle of this account's opportunity". */
export interface OpportunityTrace {
  readonly ruleVersion: string;
  readonly accountId: EntityId;
  readonly accountName: string;
  readonly nodes: readonly RevenueGraphNode[];
  readonly edges: readonly RevenueGraphEdge[];
  readonly lifecycle: OpportunityLifecycle;
}

/** The workspace-wide graph: merged, deduplicated, deterministically ordered. */
export interface WorkspaceGraph {
  readonly ruleVersion: string;
  readonly accountCount: number;
  readonly nodes: readonly RevenueGraphNode[];
  readonly edges: readonly RevenueGraphEdge[];
}

/** The deployment's graph rule set, as data, plus everything it refuses. */
export interface RevenueGraphPolicyView {
  readonly ruleVersion: string;
  readonly nodeKinds: readonly RevenueGraphNodeKind[];
  readonly edgeKinds: readonly RevenueGraphEdgeKind[];
  readonly stages: readonly RevenueGraphStage[];
  readonly nodes: readonly {
    readonly kind: RevenueGraphNodeKind;
    readonly source: string;
    readonly semantics: string;
  }[];
  readonly edges: readonly {
    readonly kind: RevenueGraphEdgeKind;
    readonly from: RevenueGraphNodeKind;
    readonly to: RevenueGraphNodeKind;
    readonly semantics: string;
    readonly derivation: string;
  }[];
  readonly refused: readonly {
    readonly name: string;
    readonly reason: string;
    readonly owningPhase: string | null;
  }[];
  readonly neverDoes: readonly string[];
}

export type RevenueGraphErrorCode =
  "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_ERROR" | "UNAVAILABLE";

export interface RevenueGraphError {
  readonly code: RevenueGraphErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** What a caller may send to the trace route: an account id, and nothing else. */
export interface TraceOpportunityInput {
  readonly accountId: unknown;
}

/**
 * One account's whole position in the revenue loop, narrowed to the fields
 * the graph's rules read. Lists are the account's own (the store filtered
 * them to this workspace and account). This snapshot carries no message text
 * and no draft text — the graph is a picture of records, not of content.
 */
export interface AccountGraphSnapshot {
  readonly account: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly createdAt: string;
  };
  readonly contacts: readonly {
    readonly id: string;
    readonly fullName: string;
    readonly status: string;
    readonly createdAt: string;
  }[];
  readonly findings: readonly {
    readonly id: string;
    readonly category: string;
    readonly field: string;
    readonly createdAt: string;
  }[];
  readonly evidence: readonly {
    readonly id: string;
    readonly researchFindingId: string | null;
    readonly status: string;
    readonly createdAt: string;
  }[];
  readonly qualifications: readonly {
    readonly id: string;
    readonly state: string;
    readonly version: number;
    readonly evidenceIds: readonly string[];
    readonly createdAt: string;
  }[];
  readonly drafts: readonly {
    readonly id: string;
    readonly qualificationId: string | null;
    readonly createdAt: string;
  }[];
  readonly outboundActions: readonly {
    readonly id: string;
    readonly draftId: string;
    readonly contactId: string;
    readonly approvalId: string;
    readonly createdAt: string;
  }[];
  readonly inboundMessages: readonly {
    readonly id: string;
    readonly outboundActionId: string;
    readonly contactId: string;
    readonly createdAt: string;
  }[];
  readonly classifications: readonly {
    readonly id: string;
    readonly intent: string;
    readonly outboundActionId: string;
    readonly inboundMessageId: string;
    readonly createdAt: string;
  }[];
  readonly meetings: readonly {
    readonly id: string;
    readonly title: string;
    readonly state: string;
    readonly contactId: string;
    readonly classificationId: string;
    readonly createdAt: string;
  }[];
}

/** What the pure engine produces for one account. */
export interface AccountGraph {
  readonly nodes: readonly RevenueGraphNode[];
  readonly edges: readonly RevenueGraphEdge[];
  readonly lifecycle: OpportunityLifecycle;
}

/**
 * The one reader the service needs: resolve one account's snapshot through
 * storage with the caller's identity. `null` means the account does not
 * exist, belongs to another workspace, or its rows are unreadable — the
 * caller cannot tell which, so a foreign id is never discoverable.
 */
export interface RevenueGraphReader {
  accountGraph(
    workspaceId: EntityId,
    accountId: EntityId,
    userId: EntityId,
  ): AccountGraphSnapshot | null;
}

/**
 * The workspace's account index. `null` is a storage refusal — the service
 * turns it into UNAVAILABLE rather than presenting an empty graph as an
 * answer.
 */
export interface RevenueGraphIndexReader {
  accountIds(workspaceId: EntityId, userId: EntityId): EntityId[] | null;
}

/**
 * The storage surface the service needs. `authorize` writes nothing; there is
 * no create/update/delete method anywhere in this package.
 */
export interface RevenueGraphRepository {
  authorize(
    workspaceId: EntityId,
    userId: EntityId,
  ): { ok: true } | { ok: false; error: { code: string; message: string } };
}
