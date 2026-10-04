import type { ApprovalRequest, EntityId, PersonalizedDraft } from "@dealora/db";

import { OutboundService } from "./service.js";
import type {
  Clock,
  OutboundApprovalVerifier,
  OutboundContactReader,
  OutboundContactSnapshot,
  OutboundDraftReader,
  OutboundDraftSnapshot,
  OutboundProviderResolver,
  OutboundRepository,
} from "./types.js";

/**
 * Convenience factory wiring the Outbound service to the concrete store.
 *
 * The five collaborators are all narrow on purpose. The service can see a
 * draft's identity, version, addresses and digest; a contact's identity and
 * address; and an approval's status, reviewer and version. It cannot see
 * evidence, claims, credentials or anything else, which is what keeps the send
 * boundary small enough to read in one sitting.
 */
export function createOutboundService(
  repo: OutboundRepository,
  approvals: OutboundApprovalVerifier,
  drafts: OutboundDraftReader,
  contacts: OutboundContactReader,
  providers: OutboundProviderResolver,
  clock?: Clock,
): OutboundService {
  return new OutboundService(repo, approvals, drafts, contacts, providers, clock);
}

/**
 * Narrow a stored draft to what the send boundary reads.
 *
 * The subject and body travel deliberately: the message that goes out must be
 * read from the immutable record the reviewer approved, never carried in the
 * action row or supplied by a caller.
 */
export function toOutboundDraftSnapshot(draft: {
  id: EntityId;
  workspaceId: EntityId;
  version: number;
  subject: string;
  body: string;
  contactId: EntityId | null;
  contextDigest: string;
}): OutboundDraftSnapshot {
  return {
    id: draft.id,
    workspaceId: draft.workspaceId,
    version: draft.version,
    subject: draft.subject,
    body: draft.body,
    contactId: draft.contactId,
    contextDigest: draft.contextDigest,
  };
}

/** Narrow a stored contact to what the send boundary reads. */
export function toOutboundContactSnapshot(contact: {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  email: string | null;
  status: string;
}): OutboundContactSnapshot {
  return {
    id: contact.id,
    workspaceId: contact.workspaceId,
    accountId: contact.accountId,
    email: contact.email,
    status: contact.status,
  };
}

/**
 * The minimum a draft reader needs from storage.
 *
 * Declared as an interface rather than a concrete class so this module keeps no
 * dependency on how a draft is stored, and so the factory can be handed anything
 * that satisfies it.
 */
export interface DraftLookup {
  getDraft(
    id: EntityId,
    userId: EntityId,
  ): { ok: true; value: PersonalizedDraft } | { ok: false; error: unknown };
}

/**
 * Build a draft reader over a storage lookup.
 *
 * A draft that is not readable by this caller — absent, or in a workspace they do
 * not belong to — resolves to `null`, so the service reports it as not found
 * rather than authorizing against a record it could not see.
 */
export function createDraftReader(lookup: DraftLookup): OutboundDraftReader {
  return {
    byId(draftId, userId): OutboundDraftSnapshot | null {
      const found = lookup.getDraft(draftId, userId);
      return found.ok ? toOutboundDraftSnapshot(found.value) : null;
    },
  };
}

/** The minimum a contact reader needs from storage. */
export interface ContactLookup {
  getContact(
    id: EntityId,
    userId: EntityId,
  ):
    | {
        ok: true;
        value: {
          id: EntityId;
          workspaceId: EntityId;
          accountId: EntityId;
          email: string | null;
          status: string;
        };
      }
    | { ok: false; error: unknown };
}

/** Build a contact reader over a storage lookup. */
export function createContactReader(lookup: ContactLookup): OutboundContactReader {
  return {
    byId(contactId, userId): OutboundContactSnapshot | null {
      const found = lookup.getContact(contactId, userId);
      return found.ok ? toOutboundContactSnapshot(found.value) : null;
    },
  };
}

/** The minimum an approval verifier needs from storage. */
export interface ApprovalLookup {
  getApprovalRequest(
    id: EntityId,
    userId: EntityId,
  ): { ok: true; value: ApprovalRequest } | { ok: false; error: unknown };
  listApprovalRequests(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { draftId?: EntityId; status?: ApprovalRequest["status"] },
  ): { ok: true; value: ApprovalRequest[] } | { ok: false; error: unknown };
}

/**
 * Build the independent approval verifier.
 *
 * This reads the **persisted rows**, not another domain service. That is the
 * whole point: a send must re-derive "is this approved?" from storage itself,
 * rather than asking the component that wrote the approval whether it still
 * agrees with itself. The cost is one extra read; the benefit is that "approved"
 * means a stored fact, checked here, every single time.
 */
export function createApprovalVerifier(lookup: ApprovalLookup): OutboundApprovalVerifier {
  return {
    verify(approvalId, userId): ApprovalRequest | null {
      const found = lookup.getApprovalRequest(approvalId, userId);
      return found.ok ? found.value : null;
    },
    findApprovedForDraftVersion(
      workspaceId,
      userId,
      draftId,
      draftVersion,
    ): ApprovalRequest | null {
      const listed = lookup.listApprovalRequests(workspaceId, userId, { draftId });
      if (!listed.ok) return null;
      // Scoped to the workspace and to the exact version. Among the requests for
      // this version, an approved one wins; if none is approved, nothing
      // authorizes a send, whatever the other statuses say.
      const forVersion = listed.value.filter(
        (approval) => approval.draftId === draftId && approval.draftVersion === draftVersion,
      );
      const approved = forVersion.find(
        (approval) =>
          approval.status === "approved" &&
          approval.decidedBy !== null &&
          approval.decidedAt !== null,
      );
      return approved ?? null;
    },
  };
}
