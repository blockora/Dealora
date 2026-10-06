/**
 * The pure derivation core for CRM Integrations (ROADMAP.md §30,
 * DEALORA_BLUEPRINT.md §23).
 *
 * Given one account's narrowed snapshot it produces the change-set a person
 * will approve — deterministically, with no clock, no randomness, no model
 * and no I/O, exactly as the Phase 15 graph and the Phase 22 comparison
 * derive from the rows Phases 5–13 already wrote.
 *
 * Vocabulary narrowing happens here, in one place: every stored status,
 * state, intent and source is checked against its closed list, and a row
 * outside the list makes the whole derivation fail (`null`) rather than
 * publish a half-understood change-set — a store that disagrees with its own
 * vocabulary is a defect, not an empty account.
 *
 * What the derivation produces maps one-to-one onto §23's CRM AGENT
 * responsibilities: upsert contacts (with their source attribution), create
 * activities from recorded interactions, update the lifecycle stage, update
 * the opportunity status, attach a note quoting the qualification verdict,
 * and synchronize classified conversations. Every operation carries
 * `derivedFrom` — the exact stored rows it came from — so an executed sync
 * traces back to storage instead of to a claim, and no operation carries an
 * amount or value of any kind (the Phase 4 plan's CRM policy forbids one
 * without a human-confirmed figure, and no row here confirms anything).
 */

import type {
  CrmChangeSet,
  CrmCreateActivityOperation,
  CrmOperation,
  CrmOpportunityStatus,
  CrmUpsertContactOperation,
} from "@dealora/db";

import { INTEGRATION_LIMITS } from "./rules.js";

// --- Narrowed snapshots -----------------------------------------------------

export interface CrmAccountSnapshot {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly sourceReference: string | null;
  readonly revenuePlanId: string | null;
}

export interface CrmContactSnapshot {
  readonly id: string;
  readonly accountId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly jobTitle: string | null;
  readonly status: string;
  readonly source: string;
  readonly sourceReference: string | null;
}

export interface CrmQualificationSnapshot {
  readonly id: string;
  readonly accountId: string;
  readonly version: number;
  readonly state: string;
  readonly score: number | null;
  readonly reason: string;
  readonly ruleVersion: string;
  readonly evidenceIds: readonly string[];
  readonly revenueGoalId: string | null;
}

export interface CrmActionSnapshot {
  readonly id: string;
  readonly contactId: string;
  readonly status: string;
  readonly channel: string;
  readonly sentAt: string | null;
}

export interface CrmClassificationSnapshot {
  readonly id: string;
  readonly outboundActionId: string;
  readonly intent: string;
  readonly confidence: string;
  readonly recommendedNextAction: string;
  readonly createdAt: string;
}

export interface CrmMeetingSnapshot {
  readonly id: string;
  readonly contactId: string;
  readonly state: string;
  readonly title: string;
  readonly startsAt: string;
  readonly createdAt: string;
}

// --- Closed vocabularies the stored rows must match -------------------------

const RECORD_SOURCES = ["manual", "csv", "approved_integration"] as const;
const CONVERSATION_INTENTS = [
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
const CONVERSATION_CONFIDENCES = ["low", "medium", "high"] as const;
const CONVERSATION_DISPOSITIONS = [
  "stop_contacting",
  "prepare_reply_for_approval",
  "request_human_review",
  "record_and_hold",
] as const;
const MEETING_BOOKING_STATES = [
  "recommended",
  "awaiting_approval",
  "approved",
  "booked",
  "held",
  "no_show",
  "cancelled",
] as const;
const OUTBOUND_STATUSES = ["ready", "sending", "sent", "failed", "cancelled"] as const;
const QUALIFICATION_STATES = [
  "qualified",
  "unqualified",
  "insufficient_data",
  "contested",
] as const;

/**
 * Meeting states in which a calendar event actually existed. `recommended`,
 * `awaiting_approval`, `approved` and `cancelled` are deliberately absent:
 * nothing here may report an interaction that never reached a calendar
 * (the same honesty rule Phase 13 books `booked` under).
 */
const INTERACTION_MEETING_STATES = ["booked", "held", "no_show"] as const;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Clamp to a bound without returning an empty string; storage re-checks. */
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Derive the exact change-set for one account.
 *
 * Operation order is fixed — contacts (by id), the account-level operations
 * (lifecycle, opportunity, note), activities (by instant then id),
 * conversations (by instant then id) — so two preparations of the same rows
 * produce byte-identical documents and therefore the same digest. Returns
 * `null` only when a stored row falls outside its published vocabulary.
 */
export function deriveCrmChangeSet(input: {
  readonly account: CrmAccountSnapshot;
  readonly contacts: readonly CrmContactSnapshot[];
  readonly qualifications: readonly CrmQualificationSnapshot[];
  readonly actions: readonly CrmActionSnapshot[];
  readonly classifications: readonly CrmClassificationSnapshot[];
  readonly meetings: readonly CrmMeetingSnapshot[];
}): CrmChangeSet | null {
  const account = input.account;
  const accountSource = oneOf(RECORD_SOURCES, account.source);
  if (accountSource === null) return null;
  if (account.name.trim() === "") return null;

  // Every contact at this account: only `active` ones are synchronized
  // (archived contacts are soft-deleted), but history below still counts
  // archived contacts so a past interaction does not vanish from the record.
  const accountContacts = input.contacts.filter((contact) => contact.accountId === account.id);
  const activeContacts = accountContacts.filter((contact) => contact.status === "active");
  const accountContactIds = new Set(accountContacts.map((contact) => contact.id));

  const operations: CrmOperation[] = [];

  // 1. Contacts — with the source attribution the record arrived under, never
  //    re-labelled by the sync.
  for (const contact of [...activeContacts].sort(byId)) {
    const source = oneOf(RECORD_SOURCES, contact.source);
    if (source === null) return null;
    const operation: CrmUpsertContactOperation = {
      kind: "upsert_contact",
      contactId: contact.id,
      fullName: contact.fullName,
      email: contact.email,
      jobTitle: contact.jobTitle,
      source,
      sourceReference: contact.sourceReference,
      derivedFrom: [{ kind: "contacts", id: contact.id }],
    };
    operations.push(operation);
  }

  // Governing qualification: highest version wins; versions are never reused
  // within an account's lineage, so the order is total.
  let governing: CrmQualificationSnapshot | null = null;
  for (const qualification of input.qualifications) {
    if (qualification.accountId !== account.id) continue;
    if (oneOf(QUALIFICATION_STATES, qualification.state) === null) return null;
    if (governing === null || qualification.version > governing.version) {
      governing = qualification;
    }
  }

  // The account's recorded interactions, attributed through its contacts.
  const sentActions = input.actions
    .filter(
      (action) =>
        accountContactIds.has(action.contactId) &&
        oneOf(OUTBOUND_STATUSES, action.status) !== null &&
        action.status === "sent" &&
        action.sentAt !== null,
    )
    .sort((a, b) => {
      const left = a.sentAt ?? "";
      const right = b.sentAt ?? "";
      if (left !== right) return left < right ? -1 : 1;
      return byId(a, b);
    });
  const sentActionIds = new Set(sentActions.map((action) => action.id));

  const repliedClassifications = input.classifications
    .filter((classification) => sentActionIds.has(classification.outboundActionId))
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return byId(a, b);
    });

  const interactionMeetings = input.meetings
    .filter(
      (meeting) =>
        accountContactIds.has(meeting.contactId) &&
        oneOf(MEETING_BOOKING_STATES, meeting.state) !== null &&
        (INTERACTION_MEETING_STATES as readonly string[]).includes(meeting.state),
    )
    .sort((a, b) => {
      if (a.startsAt !== b.startsAt) return a.startsAt < b.startsAt ? -1 : 1;
      return byId(a, b);
    });

  // 2. Lifecycle stage — the furthest stage the loop has actually reached,
  //    with the single decisive row as its witness. The stage is always
  //    derivable (at worst `new`, witnessed by the account record itself).
  const stage = deriveLifecycleStage({
    account,
    governing,
    sentActions,
    repliedClassifications,
    interactionMeetings,
  });
  if (stage === null) return null;
  operations.push(stage);

  // 3. Opportunity status — the Phase 15 definition in CRM words. An
  //    `insufficient_data` qualification is *not* a verdict: neither open nor
  //    closed, so no operation is emitted at all rather than a guess.
  if (governing !== null) {
    const status = deriveOpportunityStatus(governing.state);
    if (status === null && governing.state !== "insufficient_data") return null;
    if (status !== null) {
      operations.push({
        kind: "update_opportunity_status",
        status,
        qualificationId: governing.id,
        derivedFrom: [{ kind: "qualifications", id: governing.id }],
      });
    }
  }

  // 4. The note — the qualification verdict quoted verbatim, capped, with its
  //    evidence records named. There is no qualification, no note: an empty
  //    note would be an invented claim.
  if (governing !== null) {
    const cited = governing.evidenceIds.slice(0, INTEGRATION_LIMITS.evidenceCitedMax);
    const more = governing.evidenceIds.length - cited.length;
    const body = clamp(
      [
        `DEALORA qualification v${governing.version} (${governing.ruleVersion}): ${governing.state}.`,
        governing.score === null
          ? "No score: at least one dimension is unresolved."
          : `Score ${governing.score}/100.`,
        governing.reason,
        governing.evidenceIds.length === 0
          ? "Evidence read: none."
          : `Evidence read: ${cited.join(", ")}${more > 0 ? ` (+${more} more)` : ""}.`,
      ].join(" "),
      INTEGRATION_LIMITS.noteLengthMax,
    );
    operations.push({
      kind: "attach_note",
      qualificationId: governing.id,
      body,
      derivedFrom: [{ kind: "qualifications", id: governing.id }],
    });
  }

  // 5. Activities — recorded interactions only, most recent first, capped at
  //    the published limit so the preview always fits what will be applied.
  const activities: CrmCreateActivityOperation[] = [];
  for (const action of sentActions) {
    const channel = typeof action.channel === "string" ? action.channel.trim() : "";
    if (channel === "" || channel.length > 64) return null;
    activities.push({
      kind: "create_activity",
      activityKind: "message_sent",
      occurredAt: action.sentAt ?? "",
      detail: clamp(`message sent via ${channel}`, INTEGRATION_LIMITS.activityDetailMax),
      derivedFrom: [{ kind: "outbound_actions", id: action.id }],
    });
  }
  for (const meeting of interactionMeetings) {
    const state = oneOf(MEETING_BOOKING_STATES, meeting.state);
    if (state === null) return null;
    activities.push({
      kind: "create_activity",
      activityKind: "meeting_recorded",
      occurredAt: meeting.startsAt,
      detail: clamp(`meeting "${meeting.title}" ${state}`, INTEGRATION_LIMITS.activityDetailMax),
      derivedFrom: [{ kind: "meetings", id: meeting.id }],
    });
  }
  activities.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
    const left = a.derivedFrom[0]?.id ?? "";
    const right = b.derivedFrom[0]?.id ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });
  operations.push(...activities.slice(-INTEGRATION_LIMITS.activitiesPerSyncMax));

  // 6. Conversations — classified replies whose outbound action belongs to
  //    this account's contacts, most recent first, capped alike. The
  //    classification's own fields travel verbatim; nothing is re-read or
  //    re-judged here.
  const actionById = new Map(input.actions.map((action) => [action.id, action]));
  const conversations = input.classifications
    .filter((classification) => {
      const action = actionById.get(classification.outboundActionId);
      return action !== undefined && accountContactIds.has(action.contactId);
    })
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return byId(a, b);
    });
  for (const classification of conversations.slice(-INTEGRATION_LIMITS.conversationsPerSyncMax)) {
    const action = actionById.get(classification.outboundActionId);
    const intent = oneOf(CONVERSATION_INTENTS, classification.intent);
    const confidence = oneOf(CONVERSATION_CONFIDENCES, classification.confidence);
    const disposition = oneOf(CONVERSATION_DISPOSITIONS, classification.recommendedNextAction);
    if (action === undefined || intent === null || confidence === null || disposition === null) {
      return null;
    }
    operations.push({
      kind: "sync_conversation",
      classificationId: classification.id,
      contactId: action.contactId,
      intent,
      confidence,
      recommendedNextAction: disposition,
      occurredAt: classification.createdAt,
      derivedFrom: [{ kind: "conversation_classifications", id: classification.id }],
    });
  }

  return {
    accountId: account.id,
    accountName: account.name,
    source: accountSource,
    sourceReference: account.sourceReference,
    revenuePlanId: account.revenuePlanId,
    revenueGoalId: governing?.revenueGoalId ?? null,
    operations,
  };
}

/**
 * The furthest stage reached, with one decisive witness row.
 *
 * Precedence is fixed and total: a meeting that reached a calendar beats a
 * recorded reply, which beats a confirmed send, which beats a qualified
 * evaluation, which beats nothing at all. Each stage cites the single row
 * that proves it — a minimal witness is auditable, and `new` cites the
 * account record itself because absence cannot cite a row.
 */
function deriveLifecycleStage(input: {
  readonly account: CrmAccountSnapshot;
  readonly governing: CrmQualificationSnapshot | null;
  readonly sentActions: readonly CrmActionSnapshot[];
  readonly repliedClassifications: readonly CrmClassificationSnapshot[];
  readonly interactionMeetings: readonly CrmMeetingSnapshot[];
}): CrmOperation | null {
  const firstMeeting = input.interactionMeetings[0];
  if (firstMeeting !== undefined) {
    return {
      kind: "update_lifecycle_stage",
      stage: "meeting_booked",
      reason: "a meeting for this account reached a calendar",
      derivedFrom: [{ kind: "meetings", id: firstMeeting.id }],
    };
  }
  const firstReply = input.repliedClassifications[0];
  if (firstReply !== undefined) {
    return {
      kind: "update_lifecycle_stage",
      stage: "engaged",
      reason: "recorded replies exist for this account's outreach",
      derivedFrom: [{ kind: "conversation_classifications", id: firstReply.id }],
    };
  }
  const firstSend = input.sentActions[0];
  if (firstSend !== undefined) {
    return {
      kind: "update_lifecycle_stage",
      stage: "contacted",
      reason: "outbound messages for this account are confirmed sent",
      derivedFrom: [{ kind: "outbound_actions", id: firstSend.id }],
    };
  }
  if (input.governing !== null && input.governing.state === "qualified") {
    return {
      kind: "update_lifecycle_stage",
      stage: "qualified",
      reason: "the account's newest qualification is qualified",
      derivedFrom: [{ kind: "qualifications", id: input.governing.id }],
    };
  }
  return {
    kind: "update_lifecycle_stage",
    stage: "new",
    reason: "no sent outreach, no recorded reply and no qualifying evaluation exists",
    derivedFrom: [{ kind: "accounts", id: input.account.id }],
  };
}

/**
 * The opportunity verdict, mapped one-to-one from the governing
 * qualification. `insufficient_data` yields `null` (no verdict, no
 * operation); any other state outside the closed list yields `null` from the
 * caller's perspective only as a vocabulary failure — handled there.
 */
function deriveOpportunityStatus(state: string): CrmOpportunityStatus | null {
  if (state === "qualified") return "open";
  if (state === "unqualified") return "closed";
  if (state === "contested") return "contested";
  return null;
}
