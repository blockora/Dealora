/**
 * The pure derivation core. Given one account's narrowed snapshot it produces
 * the graph: nodes for the rows that exist, edges for the stored linkages
 * that prove them, and the opportunity lifecycle — deterministically, with no
 * clock, no randomness, no model and no I/O.
 *
 * Vocabulary narrowing happens here, in one place: every published status,
 * state and intent is checked against its closed list, and a row outside the
 * list makes the whole derivation fail (return `null`) rather than publish a
 * half-understood graph — a store that disagrees with its own vocabulary is a
 * defect, not an empty account.
 *
 * Ordering is a total order, so identical rows always print identical graphs:
 * nodes by (occurredAt, stage rank, id); edges by (occurredAt, kind, from,
 * to), an edge's occurredAt being its target node's. Undated instants sort
 * last, so a well-formed dated row never loses to an undated one at random.
 */

import type {
  AccountGraph,
  AccountGraphSnapshot,
  OpportunityLifecycle,
  OpportunityStage,
  RevenueGraphEdge,
  RevenueGraphEdgeKind,
  RevenueGraphNode,
} from "./types.js";
import { REVENUE_GRAPH_STAGES, REVENUE_GRAPH_STAGE_RANK } from "./types.js";

/** Every closed vocabulary the engine narrows, declared next to where it is used. */
const ACCOUNT_STATUS = ["active", "archived"] as const;
const CONTACT_STATUS = ["active", "archived"] as const;
const EVIDENCE_STATUS = ["recorded", "contradicted", "superseded", "rejected"] as const;
const QUALIFICATION_STATE = ["qualified", "unqualified", "insufficient_data", "contested"] as const;
const CONVERSATION_INTENT = [
  "interested",
  "question",
  "pricing",
  "objection",
  "not_now",
  "wrong_person",
  "unsubscribe",
  "positive_intent",
  "negative_intent",
  "unknown",
] as const;
const BOOKING_STATE = [
  "recommended",
  "awaiting_approval",
  "approved",
  "booked",
  "held",
  "no_show",
  "cancelled",
] as const;
/** The opportunity node's state is the one word that produced it. */
const OPPORTUNITY_STATE = ["qualified"] as const;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Parse a stored instant for ordering; undated sorts last (deterministically). */
function instant(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function compareInstants(a: string, b: string): number {
  const left = instant(a);
  const right = instant(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNodes(a: RevenueGraphNode, b: RevenueGraphNode): number {
  const byTime = compareInstants(a.occurredAt, b.occurredAt);
  if (byTime !== 0) return byTime;
  const byStage =
    (REVENUE_GRAPH_STAGE_RANK.get(a.kind) ?? 0) - (REVENUE_GRAPH_STAGE_RANK.get(b.kind) ?? 0);
  if (byStage !== 0) return byStage;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareEdges(a: RevenueGraphEdge, b: RevenueGraphEdge): number {
  const byTime = compareInstants(a.occurredAt, b.occurredAt);
  if (byTime !== 0) return byTime;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
}

function edgeKey(edge: RevenueGraphEdge): string {
  return `${edge.kind}|${edge.from}|${edge.to}`;
}

/**
 * The account's current opportunity: its newest qualification (version is
 * never reused within an account's lineage, so the highest version governs;
 * ties break by newest instant, then id — a total order). Present only when
 * that qualification is `qualified`.
 */
function latestQualified(
  snapshot: AccountGraphSnapshot,
): { id: string; createdAt: string; evidenceIds: readonly string[] } | null {
  let governing: AccountGraphSnapshot["qualifications"][number] | null = null;
  for (const qualification of snapshot.qualifications) {
    if (oneOf(QUALIFICATION_STATE, qualification.state) === null) return null;
    if (governing === null) {
      governing = qualification;
      continue;
    }
    if (qualification.version !== governing.version) {
      if (qualification.version > governing.version) governing = qualification;
      continue;
    }
    const byTime = compareInstants(qualification.createdAt, governing.createdAt);
    if (byTime > 0 || (byTime === 0 && qualification.id > governing.id)) {
      governing = qualification;
    }
  }
  if (governing === null || governing.state !== "qualified") return null;
  return {
    id: governing.id,
    createdAt: governing.createdAt,
    evidenceIds: governing.evidenceIds,
  };
}

/**
 * Derive one account's graph. `null` means a published field disagreed with
 * its closed vocabulary — the caller reports an unavailable graph rather than
 * a fabricated one.
 */
export function deriveAccountGraph(snapshot: AccountGraphSnapshot): AccountGraph | null {
  const nodes: RevenueGraphNode[] = [];

  const accountStatus = oneOf(ACCOUNT_STATUS, snapshot.account.status);
  if (accountStatus === null) return null;
  nodes.push({
    id: snapshot.account.id,
    kind: "company",
    occurredAt: snapshot.account.createdAt,
    label: snapshot.account.name,
    state: accountStatus,
  });

  const contactIds = new Set<string>();
  for (const contact of snapshot.contacts) {
    const status = oneOf(CONTACT_STATUS, contact.status);
    if (status === null) return null;
    contactIds.add(contact.id);
    nodes.push({
      id: contact.id,
      kind: "person",
      occurredAt: contact.createdAt,
      label: contact.fullName,
      state: status,
    });
  }

  const findingIds = new Set<string>();
  for (const finding of snapshot.findings) {
    findingIds.add(finding.id);
    nodes.push({
      id: finding.id,
      kind: "signal",
      occurredAt: finding.createdAt,
      label: `${finding.category}.${finding.field}`,
      state: null,
    });
  }

  const evidenceIds = new Set<string>();
  for (const evidence of snapshot.evidence) {
    const status = oneOf(EVIDENCE_STATUS, evidence.status);
    if (status === null) return null;
    evidenceIds.add(evidence.id);
    nodes.push({
      id: evidence.id,
      kind: "evidence",
      occurredAt: evidence.createdAt,
      label: null,
      state: status,
    });
  }

  const opportunity = latestQualified(snapshot);
  if (opportunity !== null) {
    nodes.push({
      id: opportunity.id,
      kind: "opportunity",
      occurredAt: opportunity.createdAt,
      label: null,
      state: OPPORTUNITY_STATE[0],
    });
  }

  const classificationIds = new Set<string>();
  for (const classification of snapshot.classifications) {
    const intent = oneOf(CONVERSATION_INTENT, classification.intent);
    if (intent === null) return null;
    classificationIds.add(classification.id);
    nodes.push({
      id: classification.id,
      kind: "conversation",
      occurredAt: classification.createdAt,
      label: null,
      state: intent,
    });
  }

  const meetingIds = new Set<string>();
  for (const meeting of snapshot.meetings) {
    const state = oneOf(BOOKING_STATE, meeting.state);
    if (state === null) return null;
    meetingIds.add(meeting.id);
    nodes.push({
      id: meeting.id,
      kind: "meeting",
      occurredAt: meeting.createdAt,
      label: meeting.title,
      state,
    });
  }

  nodes.sort(compareNodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const edges: RevenueGraphEdge[] = [];
  const pushEdge = (
    kind: RevenueGraphEdgeKind,
    from: string,
    to: string,
    derivedFrom: readonly { kind: string; id: string }[],
  ): void => {
    const target = nodeById.get(to);
    if (target === undefined || !nodeById.has(from)) return;
    edges.push({ kind, from, to, occurredAt: target.occurredAt, derivedFrom });
  };

  const account = snapshot.account;

  // Aboutness anchors: every record the account holds hangs off the company.
  for (const contact of snapshot.contacts) {
    pushEdge("company_has_person", account.id, contact.id, [
      { kind: "accounts", id: account.id },
      { kind: "contacts", id: contact.id },
    ]);
  }
  for (const finding of snapshot.findings) {
    pushEdge("company_has_signal", account.id, finding.id, [
      { kind: "accounts", id: account.id },
      { kind: "research_findings", id: finding.id },
    ]);
  }
  for (const evidence of snapshot.evidence) {
    pushEdge("company_has_evidence", account.id, evidence.id, [
      { kind: "accounts", id: account.id },
      { kind: "evidence", id: evidence.id },
    ]);
  }
  for (const meeting of snapshot.meetings) {
    pushEdge("company_has_meeting", account.id, meeting.id, [
      { kind: "accounts", id: account.id },
      { kind: "meetings", id: meeting.id },
    ]);
  }

  // Research → evidence: the Phase 7 conversion, only for finding-derived rows.
  for (const evidence of snapshot.evidence) {
    if (evidence.researchFindingId === null) continue;
    if (!findingIds.has(evidence.researchFindingId)) continue;
    pushEdge("signal_became_evidence", evidence.researchFindingId, evidence.id, [
      { kind: "research_findings", id: evidence.researchFindingId },
      { kind: "evidence", id: evidence.id },
    ]);
  }

  // The opportunity and its supports.
  if (opportunity !== null) {
    pushEdge("company_has_opportunity", account.id, opportunity.id, [
      { kind: "accounts", id: account.id },
      { kind: "qualifications", id: opportunity.id },
    ]);
    for (const evidenceId of opportunity.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) continue;
      pushEdge("evidence_supports_opportunity", evidenceId, opportunity.id, [
        { kind: "evidence", id: evidenceId },
        { kind: "qualifications", id: opportunity.id },
      ]);
    }
  }

  // Conversation lineage: classification → outbound action → contact, and the
  // reply row the classification was made from.
  const outboundById = new Map(snapshot.outboundActions.map((row) => [row.id, row]));
  const inboundById = new Map(snapshot.inboundMessages.map((row) => [row.id, row]));
  for (const classification of snapshot.classifications) {
    const outbound = outboundById.get(classification.outboundActionId);
    if (outbound === undefined || !contactIds.has(outbound.contactId)) continue;
    pushEdge("company_has_conversation", account.id, classification.id, [
      { kind: "accounts", id: account.id },
      { kind: "contacts", id: outbound.contactId },
      { kind: "outbound_actions", id: outbound.id },
      { kind: "conversation_classifications", id: classification.id },
    ]);
    const inbound = inboundById.get(classification.inboundMessageId);
    if (inbound === undefined || !contactIds.has(inbound.contactId)) continue;
    pushEdge("person_had_conversation", inbound.contactId, classification.id, [
      { kind: "contacts", id: inbound.contactId },
      { kind: "inbound_messages", id: inbound.id },
      { kind: "conversation_classifications", id: classification.id },
    ]);
  }

  // Opportunity → conversation, through the draft whose qualification made the
  // opportunity, the approval that authorized the send, and the action itself.
  if (opportunity !== null) {
    const qualifiedQualificationIds = new Set<string>();
    for (const qualification of snapshot.qualifications) {
      if (oneOf(QUALIFICATION_STATE, qualification.state) === "qualified") {
        qualifiedQualificationIds.add(qualification.id);
      }
    }
    const outboundByDraft = new Map(snapshot.outboundActions.map((row) => [row.draftId, row]));
    for (const draft of snapshot.drafts) {
      if (draft.qualificationId === null) continue;
      if (!qualifiedQualificationIds.has(draft.qualificationId)) continue;
      const outbound = outboundByDraft.get(draft.id);
      if (outbound === undefined) continue;
      for (const classification of snapshot.classifications) {
        if (classification.outboundActionId !== outbound.id) continue;
        pushEdge("opportunity_led_to_conversation", opportunity.id, classification.id, [
          { kind: "qualifications", id: draft.qualificationId },
          { kind: "drafts", id: draft.id },
          { kind: "approval_requests", id: outbound.approvalId },
          { kind: "outbound_actions", id: outbound.id },
          { kind: "conversation_classifications", id: classification.id },
        ]);
      }
    }
  }

  // Conversation → meeting, and the person who joined it.
  for (const meeting of snapshot.meetings) {
    if (classificationIds.has(meeting.classificationId)) {
      pushEdge("conversation_led_to_meeting", meeting.classificationId, meeting.id, [
        { kind: "conversation_classifications", id: meeting.classificationId },
        { kind: "meetings", id: meeting.id },
      ]);
    }
    if (contactIds.has(meeting.contactId)) {
      pushEdge("person_joined_meeting", meeting.contactId, meeting.id, [
        { kind: "contacts", id: meeting.contactId },
        { kind: "meetings", id: meeting.id },
      ]);
    }
  }

  // One edge per (kind, from, to): the same stored fact is never represented
  // twice, whatever path discovered it.
  const seen = new Set<string>();
  const deduped = edges.filter((edge) => {
    const key = edgeKey(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort(compareEdges);

  // The lifecycle: non-empty stages in loop order, furthest stage reached,
  // and the opportunity node when one exists.
  const stages: OpportunityStage[] = [];
  for (const stage of REVENUE_GRAPH_STAGES) {
    const nodeIds = nodes.filter((node) => node.kind === stage).map((node) => node.id);
    if (nodeIds.length > 0) stages.push({ stage, nodeIds });
  }
  const lifecycle: OpportunityLifecycle = {
    stages,
    frontier: stages.at(-1)?.stage ?? "company",
    opportunity: opportunity === null ? null : opportunity.id,
  };

  return { nodes, edges: deduped, lifecycle };
}

/**
 * Merge every account's graph into the workspace's graph: concatenate,
 * deduplicate by node id and edge identity, and re-apply the same total
 * order, so the workspace graph is exactly what a single derivation over the
 * union would print.
 */
export function deriveWorkspaceGraph(graphs: readonly AccountGraph[]): {
  nodes: RevenueGraphNode[];
  edges: RevenueGraphEdge[];
} {
  const nodesById = new Map<string, RevenueGraphNode>();
  const edgesByKey = new Map<string, RevenueGraphEdge>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (!nodesById.has(node.id)) nodesById.set(node.id, node);
    }
    for (const edge of graph.edges) {
      if (!edgesByKey.has(edgeKey(edge))) edgesByKey.set(edgeKey(edge), edge);
    }
  }
  const nodes = [...nodesById.values()].sort(compareNodes);
  const edges = [...edgesByKey.values()].sort(compareEdges);
  return { nodes, edges };
}
