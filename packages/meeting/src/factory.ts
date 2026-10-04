import { MeetingService } from "./service.js";
import type {
  Clock,
  MeetingCalendarProvider,
  MeetingClassificationReader,
  MeetingClassificationSnapshot,
  MeetingContactReader,
  MeetingContactSnapshot,
  MeetingQualificationReader,
  MeetingQualificationSnapshot,
  MeetingRepository,
  MeetingSuppressionReader,
} from "./types.js";

/**
 * Convenience factory wiring the Meeting service to the concrete store.
 *
 * Every collaborator is narrow on purpose. The service can see whether a response
 * read as positive, whether the account qualified, who the contact is, whether
 * the address is suppressed, and a calendar adapter. It cannot see the outbound
 * message, the approval behind it, a credential, or anything else in the
 * workspace — which is what keeps "a meeting was proposed" from ever becoming
 * "a message was sent".
 */
export function createMeetingService(
  repo: MeetingRepository,
  classifications: MeetingClassificationReader,
  qualifications: MeetingQualificationReader,
  contacts: MeetingContactReader,
  suppressions: MeetingSuppressionReader,
  calendar: MeetingCalendarProvider,
  clock?: Clock,
): MeetingService {
  return new MeetingService(
    repo,
    classifications,
    qualifications,
    contacts,
    suppressions,
    calendar,
    clock,
  );
}

/** The minimum a classification reader needs from storage. */
export interface ClassificationLookup {
  getConversationClassification(
    id: string,
    userId: string,
  ):
    | { ok: true; value: MeetingClassificationRow }
    | { ok: false; error: { code: string; message: string } };
  getInboundMessage(
    id: string,
    userId: string,
  ): { ok: true; value: MeetingInboundRow } | { ok: false; error: unknown };
}

/**
 * What the reader needs from a stored classification.
 *
 * Declared structurally rather than as the whole `ConversationClassification`, so
 * this module keeps no dependency on the Phase 12 record's shape. Note that the
 * classification itself carries no account or contact: those live on the
 * **response**, and the reader resolves them through it rather than
 * re-deriving them from the outbound action a second time.
 */
export interface MeetingClassificationRow {
  id: string;
  workspaceId: string;
  inboundMessageId: string;
  outboundActionId: string;
  intent: string;
  confidence: string;
  suppressed: boolean;
}

/** What the reader needs from a stored response. */
export interface MeetingInboundRow {
  id: string;
  workspaceId: string;
  accountId: string;
  contactId: string;
  body: string;
}

/**
 * Build the classification reader over persisted rows.
 *
 * The account and contact come from the response the classification was made
 * from — the record Phase 12 already resolved server-side from the sent action —
 * rather than from anything the caller supplied. So a meeting is filed against
 * the person DEALORA actually wrote to, and there is no second derivation that
 * could disagree with the response's own.
 *
 * A classification that does not exist, belongs to another workspace, or was
 * suppressed is all reported as `null`. The service asks "is there a positive
 * classification I may use?" and the answer is yes or no, with no way to probe
 * which of the three reasons applied.
 */
export function createClassificationReader(
  lookup: ClassificationLookup,
): MeetingClassificationReader {
  return {
    positiveClassification(
      classificationId: string,
      userId: string,
    ): MeetingClassificationSnapshot | null {
      const found = lookup.getConversationClassification(classificationId, userId);
      if (!found.ok) return null;
      const row = found.value;
      if (row.suppressed) return null;
      const message = lookup.getInboundMessage(row.inboundMessageId, userId);
      if (!message.ok) return null;
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        accountId: message.value.accountId,
        contactId: message.value.contactId,
        outboundActionId: row.outboundActionId,
        inboundMessageId: row.inboundMessageId,
        intent: row.intent as MeetingClassificationSnapshot["intent"],
        confidence: row.confidence,
        body: message.value.body,
        suppressed: row.suppressed,
      };
    },
  };
}

/** The minimum a qualification reader needs from storage. */
export interface QualificationLookup {
  listQualifications(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string; state?: string },
  ):
    | { ok: true; value: MeetingQualificationRow[] }
    | { ok: false; error: { code: string; message: string } };
}

export interface MeetingQualificationRow {
  id: string;
  workspaceId: string;
  accountId: string;
  state: string;
  score: number | null;
  createdAt?: string;
}

/**
 * Build the qualification reader.
 *
 * Reads the **newest** evaluation for the account, matching the lineage Phase 8
 * already stores: re-evaluating inserts a new version, so "the newest" is the one
 * a workspace currently acts on.
 */
export function createQualificationReader(lookup: QualificationLookup): MeetingQualificationReader {
  return {
    latestForAccount(
      workspaceId: string,
      accountId: string,
      userId: string,
    ): MeetingQualificationSnapshot | null {
      // Scoped to the caller's own workspace, so a qualification from another
      // tenant is not merely filtered out afterwards — it is never read.
      const found = lookup.listQualifications(workspaceId, userId, { accountId });
      if (!found.ok || found.value.length === 0) return null;
      const ordered = [...found.value].sort((a, b) => {
        const left = Date.parse(a.createdAt ?? "");
        const right = Date.parse(b.createdAt ?? "");
        if (Number.isNaN(left) && Number.isNaN(right)) return 0;
        // A row with no readable instant sorts last, so a well-formed newer
        // evaluation always wins over an undated one rather than losing at random.
        if (Number.isNaN(left)) return 1;
        if (Number.isNaN(right)) return -1;
        return right - left;
      });
      const latest = ordered[0];
      if (latest === undefined) return null;
      return {
        id: latest.id,
        workspaceId: latest.workspaceId,
        accountId: latest.accountId,
        state: latest.state as MeetingQualificationSnapshot["state"],
        score: latest.score,
      };
    },
  };
}

/** The minimum a contact reader needs from storage. */
export interface ContactLookup {
  getContact(
    id: string,
    userId: string,
  ):
    | { ok: true; value: MeetingContactRow }
    | { ok: false; error: { code: string; message: string } };
}

export interface MeetingContactRow {
  id: string;
  workspaceId: string;
  accountId: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
}

/**
 * Build the contact reader.
 *
 * Resolved through storage with the caller's own id, so a meeting can never be
 * attached to a contact from another workspace.
 */
export function createContactReader(lookup: ContactLookup): MeetingContactReader {
  return {
    contact(contactId: string, userId: string): MeetingContactSnapshot | null {
      const found = lookup.getContact(contactId, userId);
      if (!found.ok) return null;
      const row = found.value;
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        accountId: row.accountId,
        fullName: row.fullName,
        jobTitle: row.jobTitle,
        email: row.email,
      };
    },
  };
}

/** The minimum a suppression reader needs from storage. */
export interface SuppressionLookup {
  isSuppressed(
    workspaceId: string,
    userId: string,
    email: string,
  ): { ok: true; value: boolean } | { ok: false; error: { code: string; message: string } };
}

/**
 * Build the suppression reader over the **existing** Phase 11 opt-out list.
 *
 * Reuse rather than a second mechanism: the send path already checks this exact
 * list before every provider call, so consulting it here is what makes an opt-out
 * stop a meeting booking as well as an email, with nothing to keep in sync.
 *
 * A failed lookup is reported as **not suppressed**, never as "blocked". Reading
 * the list is authorized, and a caller who cannot read it has already been
 * refused by the workspace guard upstream — treating an unreadable list as a
 * suppression would turn an authorization failure into a silent block.
 */
export function createSuppressionReader(lookup: SuppressionLookup): MeetingSuppressionReader {
  return {
    isSuppressed(workspaceId: string, userId: string, email: string): boolean {
      const checked = lookup.isSuppressed(workspaceId, userId, email);
      return checked.ok ? checked.value : false;
    },
  };
}
