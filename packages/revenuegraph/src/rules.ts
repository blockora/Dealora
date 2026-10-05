/**
 * The single publication table for the revenue graph. Everything the policy,
 * the API and the tests print is derived from the declarations below, so a
 * kind cannot appear in the policy without semantics, and semantics cannot
 * exist without a kind.
 *
 * The partition invariant (asserted in the tests): the seven published node
 * kinds plus the five refused names equal ROADMAP.md §22's twelve CORE
 * RELATIONSHIP names, disjointly. Nothing later-phase is exposed by accident,
 * and nothing the roadmap asks for is silently dropped.
 */

import type { RevenueGraphEdgeKind, RevenueGraphError, RevenueGraphNodeKind } from "./types.js";

/** Pinned semantics version for every graph, trace and policy response. */
export const GRAPH_RULE_VERSION = "revenue-graph-1.0.0" as const;

/**
 * A workspace above this account count is refused rather than truncated: a
 * graph that quietly stopped would be read as complete (same discipline as
 * Phase 14's BOARD_LIMIT = 100).
 */
export const GRAPH_ACCOUNT_LIMIT = 100;

export function revenueGraphError(
  code: RevenueGraphError["code"],
  message: string,
  details?: readonly { field: string; message: string }[],
): RevenueGraphError {
  return details === undefined ? { code, message } : { code, message, details };
}

/** A published node kind with the table it is built from and what it means. */
export interface NodeKindDeclaration {
  readonly kind: RevenueGraphNodeKind;
  readonly source: string;
  readonly semantics: string;
}

export const NODE_KINDS: readonly NodeKindDeclaration[] = [
  {
    kind: "company",
    source: "accounts",
    semantics:
      "one node per target account (Phase 5): the subject of the graph, labelled with the account's own name.",
  },
  {
    kind: "person",
    source: "contacts",
    semantics:
      "one node per contact at the account (Phase 5), labelled with the contact's stored full name — the people behind every conversation and meeting.",
  },
  {
    kind: "signal",
    source: "research_findings",
    semantics:
      "one node per research finding recorded about the account (Phase 6), labelled `category.field`: the observed signal the workflow acted on, and this deployment's meaning of the roadmap's \"signal\".",
  },
  {
    kind: "evidence",
    source: "evidence",
    semantics:
      "one node per evidence record about the account (Phase 7), printed with its status (recorded, contradicted, superseded, rejected) because a contradicted row is still part of the account's history.",
  },
  {
    kind: "opportunity",
    source: "qualifications (latest, state qualified)",
    semantics:
      "one derived node per account: its current opportunity — ROADMAP.md §53's \"qualified opportunity\" — produced only when the account's newest qualification (version never reused) is `qualified`, and absent the moment a newer evaluation says otherwise. Stored as state `qualified` on the node, never as a new row.",
  },
  {
    kind: "conversation",
    source: "conversation_classifications",
    semantics:
      "one node per classified inbound response (Phase 12), printed with the intent read from it. The reply's text is deliberately not part of the graph.",
  },
  {
    kind: "meeting",
    source: "meetings",
    semantics:
      "one node per meeting record (Phase 13), labelled with the booking title and printed with its booking state — the furthest stage the revenue loop can reach.",
  },
];

/** A published edge kind with its endpoints, meaning and stored-field proof. */
export interface EdgeKindDeclaration {
  readonly kind: RevenueGraphEdgeKind;
  readonly from: RevenueGraphNodeKind;
  readonly to: RevenueGraphNodeKind;
  readonly semantics: string;
  readonly derivation: string;
}

export const EDGE_KINDS: readonly EdgeKindDeclaration[] = [
  {
    kind: "company_has_person",
    from: "company",
    to: "person",
    semantics: "the contact is a person this account holds.",
    derivation: "contacts.accountId === company.id",
  },
  {
    kind: "company_has_signal",
    from: "company",
    to: "signal",
    semantics: "the finding is a signal observed about this company.",
    derivation: "research_findings.accountId === company.id",
  },
  {
    kind: "company_has_evidence",
    from: "company",
    to: "evidence",
    semantics: "the evidence record is about this company.",
    derivation: "evidence.accountId === company.id",
  },
  {
    kind: "signal_became_evidence",
    from: "signal",
    to: "evidence",
    semantics:
      "the evidence is what Phase 7 built from this finding — the one controlled conversion from research data to usable support. `user_supplied` evidence has no signal and gets no such edge.",
    derivation: "evidence.researchFindingId === signal.id",
  },
  {
    kind: "company_has_opportunity",
    from: "company",
    to: "opportunity",
    semantics: "the account currently holds a qualified opportunity.",
    derivation: "the account's newest qualification (max version) with state `qualified`",
  },
  {
    kind: "evidence_supports_opportunity",
    from: "evidence",
    to: "opportunity",
    semantics:
      'this evidence was among the records the governing qualification read — ROADMAP.md §53\'s "Evidence → Qualified Opportunity".',
    derivation:
      "membership in the opportunity qualification's evidenceIds, restricted to evidence present in this account's graph",
  },
  {
    kind: "company_has_conversation",
    from: "company",
    to: "conversation",
    semantics: "the reply belongs to this company: a response to its outreach.",
    derivation:
      "classification.outboundActionId → outbound_actions.contactId → contact of this account",
  },
  {
    kind: "company_has_meeting",
    from: "company",
    to: "meeting",
    semantics: "the meeting is with someone at this account.",
    derivation: "meetings.accountId === company.id",
  },
  {
    kind: "person_had_conversation",
    from: "person",
    to: "conversation",
    semantics: "the reply came from this person: the address it was filed under.",
    derivation: "classification.inboundMessageId → inbound_messages.contactId",
  },
  {
    kind: "opportunity_led_to_conversation",
    from: "opportunity",
    to: "conversation",
    semantics:
      "the reply answered outreach whose draft came from a qualified qualification of this account — the person replied to something the opportunity's own pipeline wrote.",
    derivation:
      "draft.qualificationId ∈ { this account's qualified qualifications } → outbound_actions → classification; the approval id rides in derivedFrom so the human decision behind the send stays checkable",
  },
  {
    kind: "conversation_led_to_meeting",
    from: "conversation",
    to: "meeting",
    semantics: "the meeting was proposed from this classified reply.",
    derivation: "meetings.classificationId === conversation.id",
  },
  {
    kind: "person_joined_meeting",
    from: "person",
    to: "meeting",
    semantics: "the meeting was with this person: the meeting's contact.",
    derivation: "meetings.contactId === person.id",
  },
];

/**
 * ROADMAP.md §22's twelve CORE RELATIONSHIP names, verbatim. The tests
 * assert that NODE_KINDS ∪ REFUSED partitions this list exactly.
 */
export const ROADMAP_CORE_RELATIONSHIPS = [
  "company",
  "person",
  "signal",
  "evidence",
  "campaign",
  "conversation",
  "meeting",
  "opportunity",
  "customer",
  "revenue",
  "agent",
  "workflow",
] as const;

/** Why a roadmap relationship name is not published, and who owns it later. */
export const REFUSED: readonly {
  readonly name: string;
  readonly reason: string;
  readonly owningPhase: string | null;
}[] = [
  {
    name: "campaign",
    reason:
      "no phase through 15 produces a campaign: BLUEPRINT.md §16 defines the campaign object but ROADMAP.md assigns it no phase yet, and Phase 11 ships one approved message at a time — never a campaign.",
    owningPhase: null,
  },
  {
    name: "customer",
    reason:
      "no phase through 15 records a customer; the dashboard (Phase 17) reports Customers as an outcome and the CRM integrations (Phase 23) would sync them.",
    owningPhase: "Phase 17 / 23",
  },
  {
    name: "revenue",
    reason:
      "no phase through 15 writes a realized-revenue row; Phase 16 measures cost and Phase 17 reports Direct Revenue as an outcome.",
    owningPhase: "Phase 16 / 17",
  },
  {
    name: "agent",
    reason: "the agent system (ROADMAP.md §18) does not exist yet.",
    owningPhase: "Phase 18",
  },
  {
    name: "workflow",
    reason: "no workflow engine through 15; ROADMAP.md §24 ships it.",
    owningPhase: "Phase 24",
  },
];

/** The negative space, stated plainly and printed by the policy route. */
export const NEVER_DO: readonly string[] = [
  "never write: no table, no migration, no schema version — every node and edge is derived on read from rows another phase stored",
  "never act: no sender, approver, scheduler, CRM sync, calendar sync, queue or provider anywhere in this package",
  "never recommend: Phase 14 owns advice; the graph reports what happened, never what should happen next",
  "never infer: a node appears only when its row exists and an edge only when the stored linkage proves it",
  "never fabricate support: every edge names its source rows in derivedFrom, and an edge whose rows are missing is not emitted",
  "never guess: campaign, customer, revenue, agent and workflow vocabulary is refused with a reason, never backfilled from context",
  "never read time as a fact: occurredAt drives ordering only; the graph never reasons about the clock",
  "never cross a workspace: the account resolves with the caller's own identity first; a foreign id reads as missing",
];
