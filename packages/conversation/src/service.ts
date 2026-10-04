import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type {
  ConversationClassification,
  ConversationEvent,
  EntityId,
  InboundMessage,
} from "@dealora/db";

import { classifyConversation } from "./classifier.js";
import {
  CONVERSATION_CLASSIFIER_VERSION,
  LIMITS,
  SUPPORTED_CLASSIFIER_VERSIONS,
  conversationError,
  isConversationIntent,
  isInboundSource,
  isSupportedClassifierVersion,
} from "./rules.js";
import {
  ConversationIssues,
  address,
  describeConversationPolicy,
  instant,
  optionalText,
  text,
} from "./validation.js";
import type {
  Clock,
  ConversationError,
  ConversationOutboundReader,
  ConversationPolicyView,
  ConversationRepository,
  ConversationResult,
  ConversationSuppressionWriter,
  RecordInboundInput,
  RecordInboundOptions,
} from "./types.js";

export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";
export { classifyConversation } from "./classifier.js";
export type {
  ConversationClassificationDraft,
  ConversationClassificationInput,
} from "./classifier.js";

function fromStorage(code: string, fallback: string): ConversationError {
  switch (code) {
    case "NOT_FOUND":
      return conversationError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return conversationError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return conversationError("CONFLICT", fallback);
    case "INVALID":
      return conversationError("VALIDATION_ERROR", fallback);
    default:
      // Never surface an internal storage message.
      return conversationError("UNAVAILABLE", "storage unavailable");
  }
}

/**
 * The Conversation application service — ROADMAP.md §19.
 *
 * It records an inbound response, reads it with a deterministic classifier, and
 * persists the result with a recommendation and an explicit escalation flag.
 *
 * The chain runs in this order, every time:
 *
 *   authenticate → authorize → sent-action lookup → record verbatim
 *   → classify → apply the opt-out → persist → audit
 *
 * What it deliberately cannot do is the more important half of this file's
 * design:
 *
 * - **It cannot send.** There is no sender, no provider and no queue here, and
 *   no method that calls one. The strongest recommendation it can produce is
 *   `prepare_reply_for_approval`, which is a note to a person: the Phase 10
 *   approval and the Phase 11 send path still have to run before anything
 *   reaches anyone.
 * - **It cannot turn a response into a fact.** Nothing in this package writes
 *   to `accountClaims` or `evidence`. A prospect's own words are an interested
 *   party's claim, and Phase 7 is the only route by which anything becomes
 *   evidence — a route that stays human-driven.
 * - **It cannot act without a request.** There is no scheduler, no poller and
 *   no webhook. Recording a response happens because an authenticated caller
 *   asked for it.
 *
 * The one effect it *does* take is the opt-out suppression, and only for a
 * response that said to stop. That is the single outcome where waiting for a
 * human would be the unsafe choice, and it reuses the Phase 11 suppression list
 * that the send path already checks — so honouring an unsubscribe is not a
 * second, parallel mechanism that could drift from the first.
 */
export class ConversationService {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly outbound: ConversationOutboundReader,
    private readonly suppressions: ConversationSuppressionWriter,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, ConversationError> {
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(conversationError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (typeof userId !== "string" || userId === "") {
      return err(conversationError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /** Only a rule set this deployment implements may be asked for. */
  private requireClassifierVersion(requested: unknown): Result<string, ConversationError> {
    if (requested === undefined || requested === null || requested === "") {
      return ok(CONVERSATION_CLASSIFIER_VERSION);
    }
    if (typeof requested !== "string" || !isSupportedClassifierVersion(requested)) {
      return err(
        conversationError(
          "UNSUPPORTED_CLASSIFIER_VERSION",
          "that classifier version is not supported",
          [
            {
              field: "classifierVersion",
              message: `classifierVersion must be one of: ${CONVERSATION_CLASSIFIER_VERSION}`,
            },
          ],
        ),
      );
    }
    return ok(requested);
  }

  /** The ingress source, defaulting to the only one a workspace can assert. */
  private requireSource(requested: unknown): Result<InboundMessage["source"], ConversationError> {
    if (requested === undefined || requested === null || requested === "") return ok("manual");
    if (typeof requested !== "string" || !isInboundSource(requested)) {
      return err(
        conversationError("VALIDATION_ERROR", "invalid inbound source", [
          { field: "source", message: "source must be one of: manual, provider_ingest" },
        ]),
      );
    }
    return ok(requested);
  }

  /**
   * Record one inbound response and classify it.
   *
   * The full chain runs before anything is read for judgement. Nothing about the
   * classification is accepted from the caller: there is no `intent`, no
   * `confidence`, no `recommendedNextAction` and no `humanInterventionRequired`
   * field on this input, and the body is the only text that is read.
   *
   * `options` chooses *which rule set* to read with and where the text came
   * from. The intent, the confidence, the signals, the recommendation and the
   * escalation flag all come from the classifier alone.
   */
  recordInbound(
    workspaceId: EntityId,
    userId: EntityId,
    outboundActionId: unknown,
    input: RecordInboundInput,
    options?: RecordInboundOptions,
  ): Result<ConversationResult, ConversationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const classifierVersion = this.requireClassifierVersion(options?.classifierVersion);
    if (!classifierVersion.ok) return classifierVersion;

    if (typeof outboundActionId !== "string" || outboundActionId.trim() === "") {
      return err(
        conversationError("VALIDATION_ERROR", "outbound action id is required", [
          { field: "outboundActionId", message: "outboundActionId must be a string" },
        ]),
      );
    }

    const issues = new ConversationIssues();

    const body = text(input.body, LIMITS.body);
    if (body === null) {
      issues.add("body", `body must be a non-empty string of at most ${LIMITS.body} characters`);
    }

    const subject = optionalText(input.subject, LIMITS.subject);
    if (subject === null) {
      issues.add("subject", `subject must be a string of at most ${LIMITS.subject} characters`);
    }

    const fromAddress = optionalText(input.fromAddress, LIMITS.fromAddress);
    if (fromAddress === null) {
      issues.add("fromAddress", "fromAddress must be a string when supplied");
    } else if (fromAddress !== undefined && address(fromAddress) === null) {
      issues.add("fromAddress", "fromAddress must be an email address when supplied");
    }

    const providerMessageId = optionalText(input.providerMessageId, LIMITS.providerMessageId);
    if (providerMessageId === null) {
      issues.add(
        "providerMessageId",
        `providerMessageId must be a string of at most ${LIMITS.providerMessageId} characters`,
      );
    }

    const receivedAt = optionalText(options?.receivedAt, 64);
    if (receivedAt === null) {
      issues.add("receivedAt", "receivedAt must be an ISO-8601 instant");
    } else if (receivedAt !== undefined && instant(receivedAt) === null) {
      issues.add("receivedAt", "receivedAt must be an ISO-8601 instant");
    }

    const source = this.requireSource(options?.source);
    if (!source.ok) return source;

    if (issues.length > 0) {
      return err(
        conversationError("VALIDATION_ERROR", "the response could not be recorded", issues.all()),
      );
    }

    // A response answers a message. If nothing was sent, there is nothing to
    // have replied to, and a foreign action is simply not found — the caller
    // cannot tell "no such action" from "not yours".
    const action = this.outbound.sentAction(outboundActionId, userId);
    if (action === null) {
      return err(
        conversationError("NOT_FOUND", "outbound action not found", [
          {
            field: "outboundActionId",
            message: "a response can only be recorded against a sent outbound action",
          },
        ]),
      );
    }
    if (action.workspaceId !== workspaceId) {
      return err(conversationError("UNAUTHORIZED", "workspace access denied"));
    }

    const recorded = this.repo.createInboundMessage({
      workspaceId,
      createdBy: userId,
      message: {
        outboundActionId: action.id,
        source: source.value,
        fromAddress: fromAddress ?? null,
        subject: subject ?? null,
        body: body ?? "",
        providerMessageId: providerMessageId ?? null,
        receivedAt: instant(receivedAt ?? "") ?? this.clock().toISOString(),
      },
    });
    if (!recorded.ok)
      return err(fromStorage(recorded.error.code, "the response could not be saved"));

    const draft = classifyConversation(
      { body: recorded.value.body, subject: recorded.value.subject },
      classifierVersion.value,
    );

    const suppressed = this.applyOptOut(workspaceId, userId, action.recipientEmail, draft.suppress);
    if (!suppressed.ok) return suppressed;

    const created = this.repo.createConversationClassification({
      workspaceId,
      createdBy: userId,
      classification: {
        inboundMessageId: recorded.value.id,
        outboundActionId: action.id,
        classifierVersion: draft.classifierVersion,
        intent: draft.intent,
        confidence: draft.confidence,
        reasons: draft.reasons,
        signals: draft.signals,
        recommendedNextAction: draft.recommendedNextAction,
        humanInterventionRequired: draft.humanInterventionRequired,
        suppressed: suppressed.value,
      },
    });
    if (!created.ok) {
      return err(fromStorage(created.error.code, "the response could not be classified"));
    }

    const events = this.recordTrail(workspaceId, userId, created.value, suppressed.value);

    return ok({ message: recorded.value, classification: created.value, events });
  }

  /**
   * Honour an opt-out, and only an opt-out.
   *
   * This is the single consequential thing the phase does by itself, and it is
   * bounded three ways: it only ever runs when the classifier read the response
   * as `unsubscribe`, it writes to the existing Phase 11 suppression list rather
   * than a new mechanism, and it records the address exactly as the send path
   * resolved it — so the suppression and the send check cannot disagree about
   * who is blocked.
   */
  private applyOptOut(
    workspaceId: EntityId,
    userId: EntityId,
    recipientEmail: string,
    requested: boolean,
  ): Result<boolean, ConversationError> {
    if (!requested) return ok(false);
    const written = this.suppressions.suppress({
      workspaceId,
      createdBy: userId,
      suppression: {
        email: recipientEmail,
        reason: "the recipient asked to stop being contacted",
      },
    });
    if (!written.ok)
      return err(fromStorage(written.error.code, "the opt-out could not be recorded"));
    return ok(true);
  }

  /**
   * The append-only trail for one classification.
   *
   * `ROADMAP.md` Rule 13: a consequential action needs an audit trail. A
   * workspace that stopped contacting someone because of one message has to be
   * able to show which message and which rule caused it.
   */
  private recordTrail(
    workspaceId: EntityId,
    userId: EntityId,
    classification: ConversationClassification,
    suppressed: boolean,
  ): ConversationEvent[] {
    const events: ConversationEvent[] = [];
    const record = (kind: ConversationEvent["kind"], detail: string | null): void => {
      const written = this.repo.createConversationEvent({
        workspaceId,
        actorUserId: userId,
        event: {
          classificationId: classification.id,
          inboundMessageId: classification.inboundMessageId,
          kind,
          detail,
        },
      });
      if (written.ok) events.push(written.value);
    };

    record("classified", `${classification.intent} at ${classification.confidence} confidence`);
    if (suppressed) {
      record("suppressed", "the recipient asked to stop being contacted");
    } else if (classification.humanInterventionRequired) {
      record("escalated", classification.recommendedNextAction);
    } else {
      record("held", classification.recommendedNextAction);
    }
    return events;
  }

  /** One recorded response, authorized against the caller's own workspace. */
  getInbound(id: EntityId, userId: EntityId): Result<InboundMessage, ConversationError> {
    if (typeof id !== "string" || id.trim() === "") {
      return err(conversationError("VALIDATION_ERROR", "inbound message id is required"));
    }
    const found = this.repo.getInboundMessage(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "inbound message not found"));
    return ok(found.value);
  }

  /** A workspace's recorded responses, newest first. */
  listInbound(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { outboundActionId?: unknown; contactId?: unknown },
  ): Result<InboundMessage[], ConversationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const narrowed: { outboundActionId?: EntityId; contactId?: EntityId } = {};
    const outboundActionId = filter?.outboundActionId;
    if (typeof outboundActionId === "string" && outboundActionId !== "") {
      narrowed.outboundActionId = outboundActionId;
    }
    const contactId = filter?.contactId;
    if (typeof contactId === "string" && contactId !== "") narrowed.contactId = contactId;
    const listed = this.repo.listInboundMessages(
      workspaceId,
      userId,
      Object.keys(narrowed).length > 0 ? narrowed : undefined,
    );
    if (!listed.ok) return err(fromStorage(listed.error.code, "inbound messages unavailable"));
    return ok(listed.value);
  }

  /** One classification, authorized against the caller's own workspace. */
  getClassification(
    id: EntityId,
    userId: EntityId,
  ): Result<ConversationClassification, ConversationError> {
    if (typeof id !== "string" || id.trim() === "") {
      return err(conversationError("VALIDATION_ERROR", "classification id is required"));
    }
    const found = this.repo.getConversationClassification(id, userId);
    if (!found.ok) {
      return err(fromStorage(found.error.code, "conversation classification not found"));
    }
    return ok(found.value);
  }

  /**
   * One response together with its classification and its audit trail.
   *
   * This is the phase's gate — "a response can be classified and converted into
   * a next action" — served as one read, so a user sees the text, the reading
   * and the reason together rather than having to correlate three endpoints.
   */
  inspectResponse(id: EntityId, userId: EntityId): Result<ConversationResult, ConversationError> {
    const message = this.getInbound(id, userId);
    if (!message.ok) return message;
    const classified = this.repo.findConversationClassificationByMessage(id, userId);
    if (!classified.ok) {
      return err(fromStorage(classified.error.code, "inbound message unavailable"));
    }
    if (classified.value === null) {
      return err(
        conversationError("CONFLICT", "this response has not been classified yet", [
          { field: "status", message: "record the response to classify it" },
        ]),
      );
    }
    const events = this.repo.listConversationEvents(classified.value.id, userId);
    if (!events.ok) return err(fromStorage(events.error.code, "conversation events unavailable"));
    return ok({
      message: message.value,
      classification: classified.value,
      events: events.value,
    });
  }

  /** A workspace's classifications, newest first. */
  listClassifications(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { intent?: unknown; outboundActionId?: unknown },
  ): Result<ConversationClassification[], ConversationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.intent !== undefined && filter.intent !== null && filter.intent !== "") {
      if (!isConversationIntent(filter.intent)) {
        return err(
          conversationError("VALIDATION_ERROR", "invalid intent filter", [
            { field: "intent", message: "intent must be one of the closed intent vocabulary" },
          ]),
        );
      }
    }
    const narrowed: { intent?: ConversationClassification["intent"]; outboundActionId?: EntityId } =
      {};
    const intent = filter?.intent;
    if (isConversationIntent(intent)) narrowed.intent = intent;
    const outboundActionId = filter?.outboundActionId;
    if (typeof outboundActionId === "string") narrowed.outboundActionId = outboundActionId;
    const listed = this.repo.listConversationClassifications(
      workspaceId,
      userId,
      Object.keys(narrowed).length > 0 ? narrowed : undefined,
    );
    if (!listed.ok) {
      return err(fromStorage(listed.error.code, "conversation classifications unavailable"));
    }
    return ok(listed.value);
  }

  /** One classification's audit trail, oldest first. */
  classificationHistory(
    id: EntityId,
    userId: EntityId,
  ): Result<ConversationEvent[], ConversationError> {
    const found = this.getClassification(id, userId);
    if (!found.ok) return found;
    const events = this.repo.listConversationEvents(id, userId);
    if (!events.ok) return err(fromStorage(events.error.code, "conversation events unavailable"));
    return ok(events.value);
  }

  /** Every rule version this deployment can classify under. */
  static supportedClassifierVersions(): readonly string[] {
    return SUPPORTED_CLASSIFIER_VERSIONS;
  }

  /** The policy this deployment enforces, before any response exists. */
  policy(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<ConversationPolicyView, ConversationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    return ok(describeConversationPolicy());
  }
}
