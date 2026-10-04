import { ConversationService } from "./service.js";
import type {
  Clock,
  ConversationOutboundReader,
  ConversationOutboundSnapshot,
  ConversationRepository,
  ConversationSuppressionWriter,
} from "./types.js";

/**
 * Convenience factory wiring the Conversation service to the concrete store.
 *
 * Both collaborators are narrow on purpose. The service can see whether a
 * message actually went out, to whom, and for which contact and account; and it
 * can add an address to the suppression list that already exists. It cannot see
 * the text that was sent, the approval behind it, any credential, or any
 * provider — which is what keeps "a response was read" from ever becoming "a
 * reply was sent".
 */
export function createConversationService(
  repo: ConversationRepository,
  outbound: ConversationOutboundReader,
  suppressions: ConversationSuppressionWriter,
  clock?: Clock,
): ConversationService {
  return new ConversationService(repo, outbound, suppressions, clock);
}

/** The minimum an outbound reader needs from storage. */
export interface OutboundLookup {
  getOutboundAction(
    id: string,
    userId: string,
  ): { ok: true; value: ConversationOutboundRow } | { ok: false; error: unknown };
  getContact(
    id: string,
    userId: string,
  ):
    | { ok: true; value: { id: string; workspaceId: string; accountId: string } }
    | { ok: false; error: unknown };
}

/**
 * What the reader needs from a stored outbound action.
 *
 * Declared structurally rather than as the whole `OutboundAction`, so this module
 * keeps no dependency on the Phase 11 record's shape and the reader cannot grow
 * access to the message text by accident.
 */
export interface ConversationOutboundRow {
  id: string;
  workspaceId: string;
  contactId: string;
  recipientEmail: string;
  draftId: string;
  draftVersion: number;
  status: string;
}

/**
 * Build the outbound reader over persisted rows.
 *
 * Two properties are enforced here rather than trusted to the service:
 *
 * - Only a `sent` action is visible, so a response can only be recorded against
 *   a message that genuinely left the system. An unsent or failed action is
 *   indistinguishable from one that does not exist, which also means a caller
 *   cannot probe the action table by watching which ids are refused.
 * - The account is read through the action's own contact, so the response is
 *   filed against the person the message actually went to rather than against a
 *   denormalized copy that could drift.
 */
export function createOutboundReader(lookup: OutboundLookup): ConversationOutboundReader {
  return {
    sentAction(outboundActionId, userId): ConversationOutboundSnapshot | null {
      const found = lookup.getOutboundAction(outboundActionId, userId);
      if (!found.ok || found.value.status !== "sent") return null;
      const contact = lookup.getContact(found.value.contactId, userId);
      if (!contact.ok) return null;
      return {
        id: found.value.id,
        workspaceId: found.value.workspaceId,
        contactId: found.value.contactId,
        accountId: contact.value.accountId,
        recipientEmail: found.value.recipientEmail,
        draftId: found.value.draftId,
        draftVersion: found.value.draftVersion,
        status: found.value.status,
      };
    },
  };
}

/** The minimum a suppression writer needs from storage. */
export interface SuppressionLookup {
  createOutboundSuppression(input: {
    workspaceId: string;
    createdBy: string;
    suppression: { email: string; reason: string };
  }):
    | { ok: true; value: { id: string; email: string } }
    | { ok: false; error: { code: string; message: string } };
}

/**
 * Build the suppression writer over the **existing** Phase 11 opt-out list.
 *
 * Reuse rather than a second mechanism: the send path already checks this exact
 * list before every provider call, so writing here is what makes an opt-out
 * effective immediately, with no change to how sending behaves and nothing to
 * keep in sync.
 */
export function createSuppressionWriter(lookup: SuppressionLookup): ConversationSuppressionWriter {
  return {
    suppress(input) {
      return lookup.createOutboundSuppression(input);
    },
  };
}
