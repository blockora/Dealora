/**
 * Store integration for the revenue graph: the structural lookup the readers
 * need, the account-graph reader, the workspace account index, and the
 * service factory.
 *
 * Tenant boundary lives here, in exactly one place: the account is resolved
 * through storage with the caller's own identity first, and an account that
 * does not exist, belongs to another workspace, or whose reply lineage cannot
 * be followed returns `null` — indistinguishable, so a foreign id is never
 * discoverable and a half-readable account is refused rather than rendered
 * incomplete.
 *
 * The lookup declares only the fields the graph reads; the concrete store's
 * richer rows are structurally assignable. Every method is workspace-scoped
 * by storage itself, so a reader cannot reach past its own tenant even if it
 * wanted to.
 */

import type {
  AccountGraphSnapshot,
  RevenueGraphIndexReader,
  RevenueGraphReader,
  RevenueGraphRepository,
} from "./types.js";
import type { RevenueGraphService } from "./service.js";
import { RevenueGraphService as RevenueGraphServiceImpl } from "./service.js";

/** The minimum the graph needs from storage. Every call is workspace-scoped. */
export interface RevenueGraphLookup {
  getAccount(
    id: string,
    userId: string,
  ):
    | {
        ok: true;
        value: { id: string; workspaceId: string; name: string; status: string; createdAt: string };
      }
    | { ok: false; error: { code: string; message: string } };

  listContacts(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | { ok: true; value: { id: string; fullName: string; status: string; createdAt: string }[] }
    | { ok: false; error: { code: string; message: string } };

  listResearchFindings(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | { ok: true; value: { id: string; category: string; field: string; createdAt: string }[] }
    | { ok: false; error: { code: string; message: string } };

  listEvidence(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | {
        ok: true;
        value: {
          id: string;
          researchFindingId: string | null;
          status: string;
          createdAt: string;
        }[];
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
          version: number;
          evidenceIds: readonly string[];
          createdAt: string;
        }[];
      }
    | { ok: false; error: { code: string; message: string } };

  listDrafts(
    workspaceId: string,
    userId: string,
    filter?: { accountId?: string },
  ):
    | { ok: true; value: { id: string; qualificationId: string | null; createdAt: string }[] }
    | { ok: false; error: { code: string; message: string } };

  listOutboundActions(
    workspaceId: string,
    userId: string,
    filter?: { contactId?: string },
  ):
    | {
        ok: true;
        value: {
          id: string;
          draftId: string;
          contactId: string;
          approvalId: string;
          createdAt: string;
        }[];
      }
    | { ok: false; error: { code: string; message: string } };

  listInboundMessages(
    workspaceId: string,
    userId: string,
    filter?: { contactId?: string; outboundActionId?: string },
  ):
    | {
        ok: true;
        value: { id: string; outboundActionId: string; contactId: string; createdAt: string }[];
      }
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
          outboundActionId: string;
          inboundMessageId: string;
          createdAt: string;
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
        value: {
          id: string;
          title: string;
          state: string;
          contactId: string;
          classificationId: string;
          createdAt: string;
        }[];
      }
    | { ok: false; error: { code: string; message: string } };

  listAccounts(
    workspaceId: string,
    userId: string,
  ):
    { ok: true; value: { id: string }[] } | { ok: false; error: { code: string; message: string } };
}

/**
 * Build the account-graph reader over persisted rows.
 *
 * The reply lineage is resolved here rather than in the engine, because
 * classifications carry no account id: classification → outbound action →
 * contact → account is the only chain that proves a reply belongs to this
 * account, and inbound messages are keyed the same way. A classification
 * whose inbound row cannot be found among the account's own messages is a
 * lineage break — the read is refused, never approximated.
 */
export function createRevenueGraphReader(lookup: RevenueGraphLookup): RevenueGraphReader {
  return {
    accountGraph(
      workspaceId: string,
      accountId: string,
      userId: string,
    ): AccountGraphSnapshot | null {
      const account = lookup.getAccount(accountId, userId);
      if (!account.ok) return null;
      if (account.value.workspaceId !== workspaceId) return null;

      const contacts = lookup.listContacts(workspaceId, userId, { accountId });
      const findings = lookup.listResearchFindings(workspaceId, userId, { accountId });
      const evidence = lookup.listEvidence(workspaceId, userId, { accountId });
      const qualifications = lookup.listQualifications(workspaceId, userId, { accountId });
      const drafts = lookup.listDrafts(workspaceId, userId, { accountId });
      const meetings = lookup.listMeetings(workspaceId, userId, { accountId });
      if (
        !contacts.ok ||
        !findings.ok ||
        !evidence.ok ||
        !qualifications.ok ||
        !drafts.ok ||
        !meetings.ok
      ) {
        return null;
      }

      const outboundActions: {
        id: string;
        draftId: string;
        contactId: string;
        approvalId: string;
        createdAt: string;
      }[] = [];
      const inboundMessages: {
        id: string;
        outboundActionId: string;
        contactId: string;
        createdAt: string;
      }[] = [];
      for (const contact of contacts.value) {
        const outbound = lookup.listOutboundActions(workspaceId, userId, { contactId: contact.id });
        if (!outbound.ok) return null;
        outboundActions.push(...outbound.value);
        const inbound = lookup.listInboundMessages(workspaceId, userId, { contactId: contact.id });
        if (!inbound.ok) return null;
        inboundMessages.push(...inbound.value);
      }

      const classifications: {
        id: string;
        intent: string;
        outboundActionId: string;
        inboundMessageId: string;
        createdAt: string;
      }[] = [];
      const outboundIds = new Set(outboundActions.map((row) => row.id));
      const inboundIds = new Set(inboundMessages.map((row) => row.id));
      for (const outboundActionId of outboundIds) {
        const found = lookup.listConversationClassifications(workspaceId, userId, {
          outboundActionId,
        });
        if (!found.ok) return null;
        for (const classification of found.value) {
          // Lineage break: the reply the classification was made from must be
          // among this account's own messages, or the chain proving ownership
          // is incomplete and the honest answer is to refuse the read.
          if (!inboundIds.has(classification.inboundMessageId)) return null;
          classifications.push(classification);
        }
      }

      return {
        account: account.value,
        contacts: contacts.value,
        findings: findings.value,
        evidence: evidence.value,
        qualifications: qualifications.value,
        drafts: drafts.value,
        outboundActions,
        inboundMessages,
        classifications,
        meetings: meetings.value,
      };
    },
  };
}

/**
 * The workspace's account index. `null` on any storage refusal — the service
 * reports UNAVAILABLE rather than presenting an empty workspace graph as an
 * answer.
 */
export function createRevenueGraphIndexReader(lookup: RevenueGraphLookup): RevenueGraphIndexReader {
  return {
    accountIds(workspaceId: string, userId: string): string[] | null {
      const found = lookup.listAccounts(workspaceId, userId);
      if (!found.ok) return null;
      return found.value.map((row) => row.id);
    },
  };
}

/**
 * Convenience factory wiring the revenue graph service to the concrete store:
 * the repository for authorization, the account-graph reader for one account,
 * and the account index for the workspace view. There is deliberately no
 * provider, no clock and no writer of any kind — the service never writes a
 * row and never reaches outside the database.
 */
export function createRevenueGraphService(
  repo: RevenueGraphRepository,
  reader: RevenueGraphReader,
  accounts: RevenueGraphIndexReader,
): RevenueGraphService {
  return new RevenueGraphServiceImpl(repo, reader, accounts);
}
