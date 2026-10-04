/**
 * @dealora/conversation — the types Phase 12's response engine needs.
 *
 * The shape of this file is the design. An inbound response is **recorded
 * material, not a decision and not a fact**: it is stored verbatim with its
 * provenance, read by a deterministic classifier, and turned into a
 * *recommendation* plus an explicit "does a person have to look at this" flag.
 * Nothing here can send a message, create an approval, or write to the Phase 7
 * evidence graph, and the types are shaped so that none of those is even
 * expressible: there is no `sent` here, no `approved`, and no `evidence`.
 */

import type {
  ConversationClassification,
  ConversationConfidence,
  ConversationDisposition,
  ConversationEvent,
  ConversationEventKind,
  ConversationIntent,
  ConversationSignalKind,
  DateTime,
  EntityId,
  InboundMessage,
  InboundSource,
  OutboundAction,
} from "@dealora/db";

export type {
  ConversationClassification,
  ConversationConfidence,
  ConversationDisposition,
  ConversationEvent,
  ConversationEventKind,
  ConversationIntent,
  ConversationSignalKind,
  InboundMessage,
  InboundSource,
  OutboundAction,
};

/**
 * Error codes this domain raises.
 *
 * Closed and mapped case by case at the transport boundary, like every other
 * DEALORA domain, so a new failure cannot appear over the wire as a code the
 * API contract does not define.
 */
export type ConversationErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "UNSUPPORTED_CLASSIFIER_VERSION"
  | "UNAVAILABLE";

export interface ConversationError {
  readonly code: ConversationErrorCode;
  readonly message: string;
  readonly details?: readonly { field: string; message: string }[];
}

/** An injectable clock, so every timestamp the service writes is reproducible. */
export type Clock = () => Date;

/**
 * The narrow view of an outbound action a response must answer.
 *
 * Deliberately narrower than the action itself: the conversation engine needs to
 * know that a message genuinely went out, to whom, and for which contact — and
 * nothing else. It gets no ability to write to the action, so classifying a
 * response cannot change what was sent.
 */
export interface ConversationOutboundReader {
  /**
   * One sent outbound action, authorized against the caller's own workspace.
   *
   * Returns `null` for an action that does not exist *or* that the caller is not
   * a member of. The engine must not be able to tell those apart, and must not
   * be able to read a foreign action at all.
   */
  sentAction(outboundActionId: EntityId, userId: EntityId): ConversationOutboundSnapshot | null;
}

/**
 * Everything Phase 12 needs from a sent outbound action.
 *
 * `recipientEmail` is included because an opt-out has to be suppressable at the
 * address the message actually went to — which is the address the action
 * resolved and validated at send time, not a re-derivation from the contact
 * that might have changed since.
 */
export interface ConversationOutboundSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  contactId: EntityId;
  accountId: EntityId;
  recipientEmail: string;
  draftId: EntityId;
  draftVersion: number;
  status: string;
}

/**
 * The narrow write surface Phase 12 needs on the suppression list.
 *
 * The Phase 11 store already owns this list and already checks it before every
 * send, so an opt-out classified here is honoured by the existing send path with
 * no new mechanism at all. That reuse is the point: honouring an unsubscribe
 * must not be a second, parallel implementation of "do not contact".
 */
export interface ConversationSuppressionWriter {
  suppress(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    suppression: { email: string; reason: string };
  }):
    | { ok: true; value: { id: EntityId; email: string } }
    | { ok: false; error: { code: string; message: string } };
}

/** The storage surface Phase 12 needs. Every call is workspace-scoped. */
export interface ConversationRepository {
  authorize(
    workspaceId: EntityId,
    userId: EntityId,
  ): { ok: true } | { ok: false; error: { code: string; message: string } };

  createInboundMessage(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    message: {
      outboundActionId: EntityId;
      source: InboundSource;
      fromAddress: string | null;
      subject: string | null;
      body: string;
      providerMessageId: string | null;
      receivedAt: DateTime;
    };
  }): { ok: true; value: InboundMessage } | { ok: false; error: { code: string; message: string } };

  getInboundMessage(
    id: EntityId,
    userId: EntityId,
  ): { ok: true; value: InboundMessage } | { ok: false; error: { code: string; message: string } };

  listInboundMessages(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { outboundActionId?: EntityId; contactId?: EntityId },
  ):
    { ok: true; value: InboundMessage[] } | { ok: false; error: { code: string; message: string } };

  findConversationClassificationByMessage(
    inboundMessageId: EntityId,
    userId: EntityId,
  ):
    | { ok: true; value: ConversationClassification | null }
    | { ok: false; error: { code: string; message: string } };

  createConversationClassification(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    classification: {
      inboundMessageId: EntityId;
      outboundActionId: EntityId;
      classifierVersion: string;
      intent: ConversationIntent;
      confidence: ConversationConfidence;
      reasons: string[];
      signals: ConversationSignalKind[];
      recommendedNextAction: ConversationDisposition;
      humanInterventionRequired: boolean;
      suppressed: boolean;
    };
  }):
    | { ok: true; value: ConversationClassification }
    | { ok: false; error: { code: string; message: string } };

  getConversationClassification(
    id: EntityId,
    userId: EntityId,
  ):
    | { ok: true; value: ConversationClassification }
    | { ok: false; error: { code: string; message: string } };

  listConversationClassifications(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { intent?: ConversationIntent; outboundActionId?: EntityId },
  ):
    | { ok: true; value: ConversationClassification[] }
    | { ok: false; error: { code: string; message: string } };

  createConversationEvent(input: {
    workspaceId: EntityId;
    actorUserId: EntityId;
    event: {
      classificationId: EntityId;
      inboundMessageId: EntityId;
      kind: ConversationEventKind;
      detail: string | null;
    };
  }):
    | { ok: true; value: ConversationEvent }
    | { ok: false; error: { code: string; message: string } };

  listConversationEvents(
    classificationId: EntityId,
    userId: EntityId,
  ):
    | { ok: true; value: ConversationEvent[] }
    | { ok: false; error: { code: string; message: string } };
}

/**
 * What a classification is, and what DEALORA makes of it.
 *
 * A recommendation, never an instruction that has already been carried out: the
 * only thing this phase can *do* about a response is suppress an address, and it
 * does that only when the response said to stop.
 */
export interface ConversationResult {
  message: InboundMessage;
  classification: ConversationClassification;
  /** Every step this classification took, oldest first. */
  events: ConversationEvent[];
}

/**
 * The policy this deployment enforces, as data.
 *
 * A workspace can read what the engine will and will not do before it has
 * classified anything — the same "inspect the rules first" affordance the
 * Qualification and Approval engines expose.
 */
export interface ConversationPolicyView {
  classifierVersion: string;
  supportedClassifierVersions: readonly string[];
  intents: readonly ConversationIntent[];
  dispositions: readonly ConversationDisposition[];
  signals: readonly ConversationSignalKind[];
  /** Every rule that forces a person to look at the response. */
  requiresHumanIntervention: string[];
  /** Every thing this phase will never do, stated plainly. */
  neverDoes: string[];
}

/** Options a caller may influence: never the classification itself. */
export interface RecordInboundOptions {
  /** Where the text came from. Defaults to `manual`. */
  source?: unknown;
  /** When the response arrived, as an ISO instant. Defaults to the clock. */
  receivedAt?: unknown;
  /** Which rule set to classify under. Validated against what we implement. */
  classifierVersion?: unknown;
}

export interface RecordInboundInput {
  fromAddress?: unknown;
  subject?: unknown;
  body: unknown;
  providerMessageId?: unknown;
}
