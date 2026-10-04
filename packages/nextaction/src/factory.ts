import { NextActionService } from "./service.js";
import type {
  AccountApprovalSnapshot,
  AccountClassificationSnapshot,
  AccountContactSnapshot,
  AccountDraftSnapshot,
  AccountEvidenceSnapshot,
  AccountFindingSnapshot,
  AccountMeetingSnapshot,
  AccountOutboundSnapshot,
  AccountQualificationSnapshot,
  AccountResearchRequestSnapshot,
  AccountStateReader,
  AccountStateSnapshot,
  AccountIndexReader,
  EntityId,
  NextActionRepository,
} from "./types.js";

/**
 * Convenience factory wiring the Next Action engine to the concrete store.
 *
 * The engine gets exactly one collaborator: a reader that answers "where does
 * this account stand?". It cannot reach the store, a provider, a clock's peers or
 * any other workspace, and it never sees a message body or a draft's text — which
 * is what keeps "DEALORA knows what should happen next" from ever becoming
 * "DEALORA did something about it".
 */

/**
 * Convenience factory wiring the Next Action service to the concrete store.
 *
 * Three collaborators and nothing else: the store, the account-state reader and
 * the account index. There is deliberately no provider, no clock and no sender —
 * the service never writes a timestamp itself (storage stamps `createdAt` from
 * the server clock) and never reaches anything outside the database, so a
 * deployment cannot accidentally give this boundary a way to act.
 */
export function createNextActionService(
  repo: NextActionRepository,
  reader: AccountStateReader,
  accounts: AccountIndexReader,
): NextActionService {
  return new NextActionService(repo, reader, accounts);
}

/** The minimum an account-state reader needs from storage. */
export interface AccountStateLookup {
  getAccount(
    id: string,
    userId: string,
  ):
    | { ok: true; value: { id: string; workspaceId: string; name: string; status: string } }
    | { ok: false; error: { code: string; message: string } };

  listContacts(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string; status?: string },
  ):
    | { ok: true; value: { id: string; status: string }[] }
    | { ok: false; error: { code: string; message: string } };

  listResearchRequests(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | { ok: true; value: { id: string; status: string }[] }
    | { ok: false; error: { code: string; message: string } };

  listResearchFindings(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | {
        ok: true;
        value: { id: string; confidence: string }[];
      }
    | { ok: false; error: { code: string; message: string } };

  listEvidence(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | {
        ok: true;
        value: { id: string; accountClaimId: string; status: string; confidence: string }[];
      }
    | { ok: false; error: { code: string; message: string } };

  listQualifications(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | {
        ok: true;
        value: {
          id: string;
          state: string;
          score: number | null;
          confidence: string | null;
          evidenceIds: string[];
          claimIds: string[];
          createdAt?: string;
        }[];
      }
    | { ok: false; error: { code: string; message: string } };

  listDrafts(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | { ok: true; value: { id: string; version: number; createdAt: string }[] }
    | { ok: false; error: { code: string; message: string } };

  listApprovalRequests(
    workspaceId: string,
    userId: string,
    filter?: { draftId?: string; status?: string },
  ):
    | { ok: true; value: { id: string; draftId: string; status: string }[] }
    | { ok: false; error: { code: string; message: string } };

  listOutboundActions(
    workspaceId: string,
    userId: string,
    filter?: { draftId?: string; contactId?: string; status?: string },
  ):
    | { ok: true; value: { id: string; draftId: string; contactId: string; status: string }[] }
    | { ok: false; error: { code: string; message: string } };

  listConversationClassifications(
    workspaceId: string,
    userId: string,
    filter?: { outboundActionId?: string },
  ):
    | {
        ok: true;
        value: {
          id: string;
          intent: string;
          confidence: string;
          suppressed: boolean;
          createdAt?: string;
        }[];
      }
    | { ok: false; error: { code: string; message: string } };

  listMeetings(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | {
        ok: true;
        value: { id: string; state: string; classificationId: string; createdAt?: string }[];
      }
    | { ok: false; error: { code: string; message: string } };

  listMeetingBriefs(
    meetingId: string,
    userId: string,
  ):
    { ok: true; value: { id: string }[] } | { ok: false; error: { code: string; message: string } };
}

/** The minimum an account-index reader needs from storage. */
export interface AccountIndexLookup {
  listAccounts(
    workspaceId: string,
    userId: string,
  ):
    { ok: true; value: { id: string }[] } | { ok: false; error: { code: string; message: string } };
}

/**
 * Newest first by `createdAt`.
 *
 * Phase 6, 8 and 13 all store versions rather than replacing rows, so "the one
 * that governs" is the newest. A row with no readable instant sorts last, so a
 * well-formed newer record always wins over an undated one rather than losing at
 * random — the same rule the meeting qualification reader uses.
 */
function byNewest<T extends { createdAt?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const left = Date.parse(a.createdAt ?? "");
    const right = Date.parse(b.createdAt ?? "");
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
}

/**
 * Narrow a string to one of a closed vocabulary, or `null`.
 *
 * The reader's structural lookups declare these fields as plain `string`, so
 * without this the engine would receive a **narrowed** value that nobody ever
 * checked — a `MeetingBookingState` of `"booked"` and a typo'd `"boooked"` would
 * look identical to the type system, and the typo would silently route an account
 * to the wrong branch.
 *
 * `null` means "refuse this read", which is the same answer the reader gives for
 * a storage failure or a foreign account. An account whose records cannot be
 * parsed is not an account with no recommendations — it is an account whose
 * position DEALORA cannot honestly determine, and saying nothing is the truth.
 */
function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Every closed vocabulary the reader narrows, declared next to where it is used. */
const CONTACT_STATUS = ["active", "archived"] as const;
const ACCOUNT_STATUS = ["active", "archived"] as const;
const CONFIDENCE_BAND = ["low", "medium", "high"] as const;
const RESEARCH_REQUEST_STATUS = ["pending", "running", "completed", "failed", "cancelled"] as const;
const EVIDENCE_STATUS = ["recorded", "contradicted", "superseded", "rejected"] as const;
const QUALIFICATION_STATE = ["qualified", "unqualified", "insufficient_data", "contested"] as const;
const APPROVAL_STATUS = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "cancelled",
  "expired",
] as const;
const OUTBOUND_STATUS = ["ready", "sending", "sent", "failed", "cancelled"] as const;
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
/** Exactly the seven booking states Phase 13's machine can produce. */
const BOOKING_STATE = [
  "recommended",
  "awaiting_approval",
  "approved",
  "booked",
  "held",
  "no_show",
  "cancelled",
] as const;

/**
 * Build the account-state reader over persisted rows.
 *
 * Every read is scoped to the caller's **own** workspace and to the account the
 * caller named, and the account itself is resolved through storage with the
 * caller's identity first. An account that does not exist and an account in
 * another workspace are both `null`, so the engine cannot be used to discover
 * that a foreign id exists — the same existence-leak prevention the store applies
 * to a direct read.
 *
 * The account's lineage is resolved here rather than in the engine, which is the
 * part worth being strict about. Classifications do not carry an account id: they
 * point at the outbound action that was answered, and that action points at a
 * contact, and the contact points at the account. So the reader walks
 * classification → outbound action → contact → account and keeps only the
 * classifications that really belong to this account. Resolving it any other way
 * would let one account's reply look like another's, and a recommendation built
 * on that would be advice about the wrong company.
 */
export function createAccountStateReader(lookup: AccountStateLookup): AccountStateReader {
  return {
    accountState(
      workspaceId: EntityId,
      accountId: EntityId,
      userId: EntityId,
    ): AccountStateSnapshot | null {
      const account = lookup.getAccount(accountId, userId);
      if (!account.ok) return null;
      const row = account.value;
      if (row.workspaceId !== workspaceId) return null;

      const contacts = lookup.listContacts(workspaceId, userId, { accountId });
      const researchRequests = lookup.listResearchRequests(workspaceId, userId, { accountId });
      const findings = lookup.listResearchFindings(workspaceId, userId, { accountId });
      const evidence = lookup.listEvidence(workspaceId, userId, { accountId });
      const qualifications = lookup.listQualifications(workspaceId, userId, { accountId });
      const drafts = lookup.listDrafts(workspaceId, userId, { accountId });
      const meetings = lookup.listMeetings(workspaceId, userId, { accountId });

      // A refusal to read any of these is a refusal, not an empty account. The
      // engine would otherwise be handed a half-empty account and recommend
      // "research this" for an account that was researched an hour ago.
      if (
        !contacts.ok ||
        !researchRequests.ok ||
        !findings.ok ||
        !evidence.ok ||
        !qualifications.ok ||
        !drafts.ok ||
        !meetings.ok
      ) {
        return null;
      }

      const contactRows = contacts.value;
      const contactIds = new Set(contactRows.map((c) => c.id));
      const accountContactSnapshots: AccountContactSnapshot[] = [];
      for (const c of contactRows) {
        const status = oneOf(CONTACT_STATUS, c.status);
        if (status === null) return null;
        accountContactSnapshots.push({ id: c.id, status });
      }

      // Only the newest draft's lineage matters for "what is the next step", but
      // the full list is kept so an approval raised against an older version is
      // still visible as *not* covering the current one.
      const draftRows = byNewest(drafts.value);
      const approvals: AccountApprovalSnapshot[] = [];
      for (const draft of draftRows) {
        const found = lookup.listApprovalRequests(workspaceId, userId, { draftId: draft.id });
        if (!found.ok) return null;
        for (const approval of found.value) {
          const status = oneOf(APPROVAL_STATUS, approval.status);
          if (status === null) return null;
          approvals.push({ id: approval.id, draftId: approval.draftId, status });
        }
      }

      // An outbound action belongs to this account exactly when the contact it
      // addressed belongs to this account.
      const outboundActions: AccountOutboundSnapshot[] = [];
      const outboundActionIds = new Set<string>();
      for (const contactId of contactIds) {
        const found = lookup.listOutboundActions(workspaceId, userId, { contactId });
        if (!found.ok) return null;
        for (const action of found.value) {
          const status = oneOf(OUTBOUND_STATUS, action.status);
          if (status === null) return null;
          outboundActions.push({ id: action.id, draftId: action.draftId, status });
          outboundActionIds.add(action.id);
        }
      }

      // The stored instant rides along only long enough to order the lineage;
      // it is stripped before the snapshot reaches the engine, which has no use
      // for a timestamp and must not be tempted to reason about one.
      const classifiedRows: (AccountClassificationSnapshot & { createdAt: string })[] = [];
      for (const outboundActionId of outboundActionIds) {
        const found = lookup.listConversationClassifications(workspaceId, userId, {
          outboundActionId,
        });
        if (!found.ok) return null;
        for (const classification of found.value) {
          const intent = oneOf(CONVERSATION_INTENT, classification.intent);
          const confidence = oneOf(CONFIDENCE_BAND, classification.confidence);
          if (intent === null || confidence === null) return null;
          classifiedRows.push({
            id: classification.id,
            intent,
            confidence,
            suppressed: classification.suppressed,
            createdAt: classification.createdAt ?? "",
          });
        }
      }
      const orderedClassifications: AccountClassificationSnapshot[] = byNewest(classifiedRows).map(
        ({ createdAt: _createdAt, ...snapshot }) => snapshot,
      );

      const meetingRows = byNewest(meetings.value);
      const accountMeetings: AccountMeetingSnapshot[] = [];
      const meetingBriefCounts = new Map<EntityId, number>();
      for (const meeting of meetingRows) {
        // Phase 13's booking state is the engine's most consequential input: a
        // state it could not read must not silently fall through to a branch
        // that would advise booking something.
        const state = oneOf(BOOKING_STATE, meeting.state);
        if (state === null) return null;
        accountMeetings.push({ id: meeting.id, state, classificationId: meeting.classificationId });
        const briefs = lookup.listMeetingBriefs(meeting.id, userId);
        if (!briefs.ok) return null;
        meetingBriefCounts.set(meeting.id, briefs.value.length);
      }

      const qualificationRows = byNewest(qualifications.value);
      const accountQualifications: AccountQualificationSnapshot[] = [];
      for (const q of qualificationRows) {
        const state = oneOf(QUALIFICATION_STATE, q.state);
        if (state === null) return null;
        // `confidence` is legitimately nullable alongside a `null` score.
        const confidence = q.confidence === null ? null : oneOf(CONFIDENCE_BAND, q.confidence);
        if (q.confidence !== null && confidence === null) return null;
        accountQualifications.push({
          id: q.id,
          state,
          score: q.score,
          confidence,
          evidenceIds: [...q.evidenceIds],
          claimIds: [...q.claimIds],
        });
      }

      const accountResearchRequests: AccountResearchRequestSnapshot[] = [];
      for (const r of researchRequests.value) {
        const status = oneOf(RESEARCH_REQUEST_STATUS, r.status);
        if (status === null) return null;
        accountResearchRequests.push({ id: r.id, status });
      }
      const accountFindings: AccountFindingSnapshot[] = [];
      for (const f of findings.value) {
        const confidence = oneOf(CONFIDENCE_BAND, f.confidence);
        if (confidence === null) return null;
        accountFindings.push({ id: f.id, confidence });
      }
      const accountEvidence: AccountEvidenceSnapshot[] = [];
      for (const e of evidence.value) {
        const status = oneOf(EVIDENCE_STATUS, e.status);
        const confidence = oneOf(CONFIDENCE_BAND, e.confidence);
        if (status === null || confidence === null) return null;
        accountEvidence.push({ id: e.id, accountClaimId: e.accountClaimId, status, confidence });
      }
      const accountDrafts: AccountDraftSnapshot[] = draftRows.map((d) => ({
        id: d.id,
        version: d.version,
        createdAt: d.createdAt,
      }));

      const accountStatus = oneOf(ACCOUNT_STATUS, row.status);
      if (accountStatus === null) return null;

      return {
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        status: accountStatus,
        contacts: accountContactSnapshots,
        researchRequests: accountResearchRequests,
        findings: accountFindings,
        evidence: accountEvidence,
        qualifications: accountQualifications,
        drafts: accountDrafts,
        approvals,
        outboundActions,
        classifications: orderedClassifications,
        meetings: accountMeetings,
        meetingBriefCounts,
      };
    },
  };
}

/**
 * Build the account index over persisted rows.
 *
 * Only the ids are returned. The board route reads each account through the
 * account-state reader — which authorizes again per account — rather than being
 * handed a whole workspace's data in one call, so a single unreadable account
 * cannot widen the boundary for the rest.
 */
export function createAccountIndexReader(lookup: AccountIndexLookup): AccountIndexReader {
  return {
    accountIds(workspaceId: EntityId, userId: EntityId): EntityId[] {
      const found = lookup.listAccounts(workspaceId, userId);
      if (!found.ok) return [];
      return found.value.map((a) => a.id);
    },
  };
}
