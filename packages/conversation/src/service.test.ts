import { describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";
import type { Account, Contact, User } from "@dealora/db";

import {
  ConversationService,
  classifyConversation,
  createOutboundReader,
  createSuppressionWriter,
} from "./index.js";
import type { ConversationClassificationInput } from "./classifier.js";
import type {
  ConversationOutboundSnapshot,
  ConversationRepository,
  ConversationSuppressionWriter,
} from "./types.js";
import {
  CONVERSATION_CLASSIFIER_VERSION,
  CONVERSATION_DISPOSITIONS,
  CONVERSATION_INTENTS,
  DISPOSITION_BY_INTENT,
  findPhrase,
  normalizeForMatching,
} from "./rules.js";

const NOW = () => new Date("2026-10-05T12:00:00.000Z");
const RECEIVED = "2026-10-05T09:30:00.000Z";

function seed(): Store {
  return new Store(emptyState());
}

function makeOwner(store: Store, email = "owner@example.com"): User {
  const created = store.createUser({
    email,
    password: "correct-horse-battery",
    displayName: "Owner",
  });
  if (!isOk(created)) throw new Error("seed user creation failed");
  return created.value;
}

function makeWorkspace(store: Store, ownerId: string, name: string): string {
  const created = store.createWorkspace({ ownerId, name });
  if (!isOk(created)) throw new Error("seed workspace failed");
  return created.value.id;
}

interface Fixture {
  owner: User;
  workspaceId: string;
  account: Account;
  contact: Contact;
  sentActionId: string;
  /** Staged but never sent, so "only a sent action can be answered" is testable. */
  readyActionId: string;
}

/**
 * A workspace with one contact and one **sent** outbound action.
 *
 * Phase 12 only ever answers a message that actually went out, so the fixture
 * builds the real thing: an action row the store reports as `sent`. Building it
 * through the real store rather than a stub is what makes the "only a sent
 * action can be answered" rule testable rather than assumed.
 */
function scenario(store: Store, options: { email?: string; workspaceName?: string } = {}): Fixture {
  const owner = makeOwner(store, options.email ?? "owner@example.com");
  const workspaceId = makeWorkspace(store, owner.id, options.workspaceName ?? "Conversation Co");
  const account = store.createAccount({
    workspaceId,
    createdBy: owner.id,
    account: {
      name: "Northwind Trading",
      website: "https://northwind.example",
      domain: "northwind.example",
      industry: null,
      companySize: null,
      geography: null,
      description: null,
      source: "manual",
      sourceReference: null,
      revenuePlanId: null,
      status: "active",
    },
  });
  if (!isOk(account)) throw new Error("seed account failed");
  const contact = store.createContact({
    workspaceId,
    createdBy: owner.id,
    contact: {
      accountId: account.value.id,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      jobTitle: "VP Support",
      email: "ada@northwind.example",
      phone: null,
      profileUrl: null,
      source: "manual",
      sourceReference: null,
      status: "active",
    },
  });
  if (!isOk(contact)) throw new Error("seed contact failed");

  // A real draft and a real approval, because the outbound store refuses an
  // action that does not point at rows that exist. Seeding through the store
  // rather than by hand is what makes the fixture exercise the same
  // preconditions a real send would.
  const draft = store.createDraft({
    workspaceId,
    createdBy: owner.id,
    accountId: account.value.id,
    draft: {
      contactId: contact.value.id,
      rendererVersion: "deterministic-1.0.0",
      contextDigest: "fnv1a-seed",
      qualificationId: null,
      offerId: null,
      subject: "Support Automation for Northwind",
      body: "Hi Ada,\n\nAbout Support Automation: we build support automation.",
      personalizationPoints: [],
      approvedClaimIds: [],
      warnings: [],
    },
  });
  if (!isOk(draft)) throw new Error("seed draft failed");

  const approval = store.createApprovalRequest({
    workspaceId,
    createdBy: owner.id,
    approval: {
      actionKind: "send_message",
      riskLevel: "level_2_external_action",
      draftId: draft.value.id,
      draftVersion: draft.value.version,
      previewSubject: draft.value.subject,
      previewDigest: "fnv1a-preview",
      expiresAt: null,
    },
  });
  if (!isOk(approval)) throw new Error("seed approval failed");

  const action = store.createOutboundAction({
    workspaceId,
    createdBy: owner.id,
    action: {
      channel: "email",
      draftId: draft.value.id,
      draftVersion: draft.value.version,
      draftDigest: "fnv1a-draft",
      approvalId: approval.value.id,
      contactId: contact.value.id,
      recipientEmail: "ada@northwind.example",
    },
  });
  if (!isOk(action)) throw new Error("seed outbound action failed");
  // Drive the action to `sent` through the two writes the real send path makes.
  const attempted = store.recordOutboundAttempt({
    id: action.value.id,
    userId: owner.id,
    provider: "sandbox-email",
    attemptedAt: "2026-10-05T09:00:00.000Z",
  });
  if (!isOk(attempted)) throw new Error("seed outbound attempt failed");
  const sent = store.confirmOutboundSent({
    id: action.value.id,
    userId: owner.id,
    provider: "sandbox-email",
    providerReference: "provider-1",
    sentAt: "2026-10-05T09:00:01.000Z",
  });
  if (!isOk(sent)) throw new Error("seed outbound confirmation failed");

  // A second, real approved action that is deliberately left in `ready`: the
  // counterpart to the sent one, so the "only a sent action can be answered"
  // rule is proved against a genuine unsent record rather than a fake id.
  const secondDraft = store.createDraft({
    workspaceId,
    createdBy: owner.id,
    accountId: account.value.id,
    draft: {
      contactId: contact.value.id,
      rendererVersion: "deterministic-1.0.0",
      contextDigest: "fnv1a-seed-2",
      qualificationId: null,
      offerId: null,
      subject: "A second note for Northwind",
      body: "Hi Ada,\n\nOne more note.",
      personalizationPoints: [],
      approvedClaimIds: [],
      warnings: [],
    },
  });
  if (!isOk(secondDraft)) throw new Error("seed second draft failed");
  const secondApproval = store.createApprovalRequest({
    workspaceId,
    createdBy: owner.id,
    approval: {
      actionKind: "send_message",
      riskLevel: "level_2_external_action",
      draftId: secondDraft.value.id,
      draftVersion: secondDraft.value.version,
      previewSubject: secondDraft.value.subject,
      previewDigest: "fnv1a-preview-2",
      expiresAt: null,
    },
  });
  if (!isOk(secondApproval)) throw new Error("seed second approval failed");
  const ready = store.createOutboundAction({
    workspaceId,
    createdBy: owner.id,
    action: {
      channel: "email",
      draftId: secondDraft.value.id,
      draftVersion: secondDraft.value.version,
      draftDigest: "fnv1a-draft-2",
      approvalId: secondApproval.value.id,
      contactId: contact.value.id,
      recipientEmail: "ada@northwind.example",
    },
  });
  if (!isOk(ready)) throw new Error("seed ready action failed");

  return {
    owner,
    workspaceId,
    account: account.value,
    contact: contact.value,
    sentActionId: sent.value.id,
    readyActionId: ready.value.id,
  };
}

function service(store: Store): ConversationService {
  const repo = store as unknown as ConversationRepository;
  const outbound = createOutboundReader({
    getOutboundAction: (id, userId) => store.getOutboundAction(id, userId),
    getContact: (id, userId) => store.getContact(id, userId),
  });
  const suppressions: ConversationSuppressionWriter = createSuppressionWriter({
    createOutboundSuppression: (input) => store.createOutboundSuppression(input),
  });
  return new ConversationService(repo, outbound, suppressions, NOW);
}

/** Record and classify one response against the fixture's sent action. */
function record(
  store: Store,
  fixture: Fixture,
  body: string,
  subject: string | null = "Re: support automation",
  options: { outboundActionId?: string; source?: unknown; receivedAt?: unknown } = {},
) {
  return service(store).recordInbound(
    fixture.workspaceId,
    fixture.owner.id,
    options.outboundActionId ?? fixture.sentActionId,
    { body, subject },
    {
      receivedAt: options.receivedAt ?? RECEIVED,
      ...(options.source === undefined ? {} : { source: options.source }),
    },
  );
}

function classify(body: string, subject: string | null = null) {
  return classifyConversation({ body, subject } satisfies ConversationClassificationInput);
}

// ---------------------------------------------------------------------------

describe("conversation vocabulary", () => {
  it("covers exactly the ten states DEALORA_BLUEPRINT.md §18 names", () => {
    expect([...CONVERSATION_INTENTS].sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(CONVERSATION_INTENTS).toHaveLength(10);
  });

  it("maps every intent to exactly one recommendation", () => {
    for (const intent of CONVERSATION_INTENTS) {
      expect(CONVERSATION_DISPOSITIONS).toContain(DISPOSITION_BY_INTENT[intent]);
    }
    // And no intent ever recommends sending: the strongest outcome only
    // recommends preparing a reply *for approval*.
    expect(Object.values(DISPOSITION_BY_INTENT)).not.toContain("send_reply");
    expect(DISPOSITION_BY_INTENT.unsubscribe).toBe("stop_contacting");
    expect(DISPOSITION_BY_INTENT.positive_intent).toBe("prepare_reply_for_approval");
  });

  it("matches phrases on word boundaries, never as substrings", () => {
    expect(findPhrase("please stop emailing", "stop emailing")).not.toBeNull();
    expect(findPhrase("a stopwatch arrived", "stop")).toBeNull();
    expect(findPhrase("that was priceless", "price")).toBeNull();
    expect(findPhrase("anything", "")).toBeNull();
  });

  it("sees a negated phrase and says so", () => {
    const negated = findPhrase(normalizeForMatching("i am not interested"), "interested");
    expect(negated?.negated).toBe(true);
    const plain = findPhrase(normalizeForMatching("i am interested"), "interested");
    expect(plain?.negated).toBe(false);
    // The guard reads across a small window, not the whole sentence.
    const distant = findPhrase(
      normalizeForMatching("i am not sure but i am interested"),
      "interested",
    );
    expect(distant?.negated).toBe(false);
  });
});

describe("the classifier reads a response", () => {
  it("reads an opt-out, and only an opt-out, as unsubscribe", () => {
    expect(classify("Please unsubscribe me from this list.").intent).toBe("unsubscribe");
    expect(classify("Please remove me from your emails.").intent).toBe("unsubscribe");
    expect(classify("Stop emailing me.").intent).toBe("unsubscribe");
    expect(classify("Do not contact me again.").intent).toBe("unsubscribe");
    // "Do not opt out" is a request to keep being contacted.
    expect(classify("Actually please do not opt out, I want to hear from you.").intent).not.toBe(
      "unsubscribe",
    );
  });

  it("never reads a refusal as interest", () => {
    const draft = classify("Thanks, but I am not interested at this time.");
    expect(draft.intent).toBe("negative_intent");
    expect(draft.signals).toContain("negative_sentiment");
    // The positive phrase did fire; it was negated, and the reason says so.
    expect(draft.reasons.join(" ")).toContain("negated");
  });

  it("lets safety outrank a question asked in the same breath", () => {
    // The classic failure: "not interested, but what does it cost?" read as a
    // pricing question would recommend a reply to someone who just said no.
    const draft = classify("We are not interested, but what does it cost?");
    expect(draft.intent).toBe("negative_intent");
    expect(draft.recommendedNextAction).toBe("request_human_review");
    expect(draft.humanInterventionRequired).toBe(true);
  });

  it("reads routing and deferral apart from refusal", () => {
    expect(classify("I am not the right person for this, who else handles it?").intent).toBe(
      "wrong_person",
    );
    expect(classify("Not now, can we revisit next quarter?").intent).toBe("not_now");
    expect(classify("No thank you, this is not a good fit for us.").intent).toBe("negative_intent");
  });

  it("reads interest, pricing and questions", () => {
    expect(classify("This sounds good, I would like to book a call.").intent).toBe(
      "positive_intent",
    );
    expect(classify("I am interested, could you tell me more?").intent).toBe("interested");
    expect(classify("How much does this cost per month?").intent).toBe("pricing");
    expect(classify("I had a question about your pricing.").intent).toBe("pricing");
  });

  it("escalates a sensitive topic whatever the intent was", () => {
    const draft = classify("How much is this? Also our lawyer has asked about a complaint.");
    expect(draft.signals).toContain("sensitive_topic");
    // The question is still what it said, but the recommendation is not "reply".
    expect(draft.recommendedNextAction).toBe("request_human_review");
    expect(draft.humanInterventionRequired).toBe(true);
    // A sensitive subject can never make a classification *more* confident.
    expect(draft.confidence).not.toBe("high");
  });

  it("escalates uncertainty and an unusual request", () => {
    expect(classify("Who are you? I am not sure this is legitimate.").signals).toContain(
      "uncertainty",
    );
    const unusual = classify("Send me your bank details by wire transfer please.");
    expect(unusual.signals).toContain("unusual_request");
    expect(unusual.recommendedNextAction).toBe("request_human_review");
  });

  it("says nothing matched rather than guessing", () => {
    const draft = classify("Team meeting moved to Thursday.");
    expect(draft.intent).toBe("unknown");
    expect(draft.reasons).toEqual(["no rule matched this response"]);
    expect(draft.confidence).toBe("low");
    expect(draft.recommendedNextAction).toBe("record_and_hold");
    expect(draft.humanInterventionRequired).toBe(true);
  });

  it("requires a human for everything except an opt-out", () => {
    for (const body of [
      "Unsubscribe me please.",
      "Not interested.",
      "Too expensive.",
      "Sounds good, book a call.",
      "How much?",
      "Team meeting Thursday.",
    ]) {
      const draft = classify(body);
      if (draft.intent === "unsubscribe") {
        expect(draft.humanInterventionRequired).toBe(false);
      } else {
        expect(draft.humanInterventionRequired).toBe(true);
      }
    }
  });

  it("is deterministic: the same text classifies identically every time", () => {
    const body = "Not now, can we revisit next quarter? Also what does it cost?";
    const first = classify(body);
    for (let run = 0; run < 5; run += 1) {
      expect(JSON.stringify(classify(body))).toBe(JSON.stringify(first));
    }
    expect(first.classifierVersion).toBe(CONVERSATION_CLASSIFIER_VERSION);
  });

  it("does not depend on the message subject alone", () => {
    const asSubject = classify("stop emailing me", "Re: support automation");
    const asBody = classify("stop emailing me", null);
    expect(asSubject.intent).toBe("unsubscribe");
    expect(asBody.intent).toBe("unsubscribe");
  });
});

describe("recording a response", () => {
  it("stores it verbatim and classifies it in one call", () => {
    const store = seed();
    const fixture = scenario(store);
    const result = record(store, fixture, "This sounds good, I would like to book a call.");
    if (!isOk(result)) throw new Error(`expected success, got ${result.error.code}`);

    expect(result.value.message.body).toBe("This sounds good, I would like to book a call.");
    expect(result.value.message.source).toBe("manual");
    expect(result.value.message.receivedAt).toBe(RECEIVED);
    expect(result.value.classification.intent).toBe("positive_intent");
    expect(result.value.classification.classifierVersion).toBe(CONVERSATION_CLASSIFIER_VERSION);
    // The contact and account are resolved server-side from the action.
    expect(result.value.message.contactId).toBe(fixture.contact.id);
    expect(result.value.message.accountId).toBe(fixture.account.id);
    // And the trail explains what happened.
    expect(result.value.events.map((event) => event.kind)).toEqual(["classified", "escalated"]);
  });

  it("refuses a response to a message that was never sent", () => {
    const store = seed();
    const fixture = scenario(store);
    // `readyActionId` is a real, approved, staged action that was never sent.
    const result = record(store, fixture, "Sounds good!", null, {
      outboundActionId: fixture.readyActionId,
    });
    if (isOk(result)) throw new Error("a response was recorded against an unsent message");
    expect(result.error.code).toBe("NOT_FOUND");
    // Nothing was written.
    expect(store.db.inboundMessages).toHaveLength(0);
  });

  it("honours an opt-out immediately, and only an opt-out", () => {
    const store = seed();
    const fixture = scenario(store);
    const optedOut = record(store, fixture, "Please unsubscribe me.");
    if (!isOk(optedOut)) throw new Error("expected success");
    expect(optedOut.value.classification.suppressed).toBe(true);
    expect(optedOut.value.events.map((event) => event.kind)).toEqual(["classified", "suppressed"]);
    // The existing Phase 11 list is what changed — no new mechanism.
    const listed = store.listOutboundSuppressions(fixture.workspaceId, fixture.owner.id);
    if (!isOk(listed)) throw new Error("suppression read failed");
    expect(listed.value.map((entry) => entry.email)).toEqual(["ada@northwind.example"]);

    // A second workspace's positive reply suppresses nobody.
    const other = scenario(store, { email: "other@example.com", workspaceName: "Other Co" });
    const positive = record(store, other, "This sounds good, book a call.");
    if (!isOk(positive)) throw new Error("expected success");
    expect(positive.value.classification.suppressed).toBe(false);
    const otherListed = store.listOutboundSuppressions(other.workspaceId, other.owner.id);
    if (!isOk(otherListed)) throw new Error("suppression read failed");
    expect(otherListed.value).toEqual([]);
  });

  it("never lets a caller supply the classification", () => {
    const store = seed();
    const fixture = scenario(store);
    const asserted: Record<string, unknown> = {
      intent: "positive_intent",
      confidence: "high",
      recommendedNextAction: "stop_contacting",
      humanInterventionRequired: false,
      suppressed: true,
      signals: ["opt_out"],
      classifierVersion: "deterministic-9.9.9",
      workspaceId: fixture.workspaceId,
      accountId: "some-other-account",
    };
    const engine = service(store);
    const result = engine.recordInbound(
      fixture.workspaceId,
      fixture.owner.id,
      fixture.sentActionId,
      { body: "Team meeting Thursday.", subject: null, ...asserted },
    );
    if (!isOk(result)) throw new Error(`expected success, got ${result.error.code}`);
    // Every asserted field was ignored: the rules, not the caller, decided.
    expect(result.value.classification.intent).toBe("unknown");
    expect(result.value.classification.classifierVersion).toBe(CONVERSATION_CLASSIFIER_VERSION);
    expect(result.value.classification.humanInterventionRequired).toBe(true);
    expect(result.value.classification.suppressed).toBe(false);
    expect(result.value.classification.signals).toEqual([]);
    expect(result.value.message.accountId).toBe(fixture.account.id);
  });

  it("rejects an empty, oversized or non-string body", () => {
    const store = seed();
    const fixture = scenario(store);
    const engine = service(store);
    for (const body of ["", "   ", 42, null, undefined]) {
      const result = engine.recordInbound(
        fixture.workspaceId,
        fixture.owner.id,
        fixture.sentActionId,
        { body },
      );
      if (isOk(result)) throw new Error(`an unusable body was accepted: ${String(body)}`);
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
    const long = record(store, fixture, "a".repeat(9000));
    if (isOk(long)) throw new Error("an oversized body was accepted");
    expect(long.error.code).toBe("VALIDATION_ERROR");
    expect(store.db.inboundMessages).toHaveLength(0);
  });

  it("rejects an unusable source, instant and classifier version", () => {
    const store = seed();
    const fixture = scenario(store);
    const badSource = record(store, fixture, "Hello", null, { source: "carrier-pigeon" });
    if (isOk(badSource)) throw new Error("an unusable source was accepted");
    expect(badSource.error.code).toBe("VALIDATION_ERROR");
    const badInstant = record(store, fixture, "Hello", null, { receivedAt: "last tuesday" });
    if (isOk(badInstant)) throw new Error("an unusable instant was accepted");
    expect(badInstant.error.code).toBe("VALIDATION_ERROR");

    const engine = service(store);
    const version = engine.recordInbound(
      fixture.workspaceId,
      fixture.owner.id,
      fixture.sentActionId,
      { body: "Hello" },
      { classifierVersion: "gpt-read-9.9.9" },
    );
    if (isOk(version)) throw new Error("an unsupported classifier version was accepted");
    expect(version.error.code).toBe("UNSUPPORTED_CLASSIFIER_VERSION");
  });

  it("refuses another tenant's action without confirming it exists", () => {
    const store = seed();
    const mine = scenario(store, { email: "mine@example.com", workspaceName: "Mine Co" });
    const theirs = scenario(store, { email: "theirs@example.com", workspaceName: "Theirs Co" });

    const result = service(store).recordInbound(
      mine.workspaceId,
      mine.owner.id,
      theirs.sentActionId,
      { body: "Sounds good!", subject: null },
    );
    if (isOk(result)) throw new Error("a foreign action was answered");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(result.error)).not.toContain("Northwind");
  });

  it("refuses a caller who does not belong to the workspace", () => {
    const store = seed();
    const ownerA = makeOwner(store, "a@example.com");
    const ownerB = makeOwner(store, "b@example.com");
    const workspaceA = makeWorkspace(store, ownerA.id, "Acme A");
    const fixture = scenario(store, { email: "c@example.com", workspaceName: "Acme C" });

    const denied = service(store).recordInbound(workspaceA, ownerB.id, fixture.sentActionId, {
      body: "Sounds good!",
    });
    if (isOk(denied)) throw new Error("an unauthorized workspace recorded a response");
    expect(denied.error.code).toBe("UNAUTHORIZED");
  });

  it("reads a response back with its classification and its trail", () => {
    const store = seed();
    const fixture = scenario(store);
    const recorded = record(store, fixture, "Too expensive for us right now.");
    if (!isOk(recorded)) throw new Error("expected success");

    const inspected = service(store).inspectResponse(recorded.value.message.id, fixture.owner.id);
    if (!isOk(inspected)) throw new Error("expected success");
    expect(inspected.value.classification.intent).toBe("objection");
    expect(inspected.value.events).toHaveLength(2);
    expect(inspected.value.message.id).toBe(recorded.value.message.id);

    // Another tenant cannot read it.
    const other = scenario(store, { email: "x@example.com", workspaceName: "X Co" });
    const denied = service(store).getInbound(recorded.value.message.id, other.owner.id);
    if (isOk(denied)) throw new Error("a foreign response was read");
    expect(denied.error.code).toBe("NOT_FOUND");
  });

  it("records each response as its own event, and classifies each once", () => {
    const store = seed();
    const fixture = scenario(store);
    const first = record(store, fixture, "How much is this?");
    if (!isOk(first)) throw new Error("expected success");
    // Recording the same text again is a second event, not a rewrite of the
    // first: two things arrived, so two things are on the record. What must
    // never happen is one message carrying two answers, and that is refused by
    // the store (see the storage-layer guard in `repository.test.ts`).
    const second = record(store, fixture, "How much is this?");
    if (!isOk(second)) throw new Error("expected success");
    expect(second.value.message.id).not.toBe(first.value.message.id);
    expect(store.db.inboundMessages).toHaveLength(2);
    expect(store.db.conversationClassifications).toHaveLength(2);
    // And both read the same way, because the classifier is deterministic.
    expect(second.value.classification.intent).toBe(first.value.classification.intent);
    expect(second.value.classification.reasons).toEqual(first.value.classification.reasons);
  });

  it("states the policy it enforces, before any response exists", () => {
    const store = seed();
    const fixture = scenario(store);
    const view = service(store).policy(fixture.workspaceId, fixture.owner.id);
    if (!isOk(view)) throw new Error("expected success");
    expect(view.value.classifierVersion).toBe(CONVERSATION_CLASSIFIER_VERSION);
    expect(view.value.intents).toHaveLength(10);
    expect(view.value.dispositions).toHaveLength(4);
    expect(view.value.requiresHumanIntervention.length).toBeGreaterThan(0);
    expect(view.value.neverDoes.join(" ")).toContain("never turns a response into evidence");
    expect(ConversationService.supportedClassifierVersions()).toEqual([
      CONVERSATION_CLASSIFIER_VERSION,
    ]);
  });
});

describe("the conversation engine takes no action of its own", () => {
  it("writes only inbound, classification and event rows", () => {
    const store = seed();
    const fixture = scenario(store);
    const before = JSON.stringify({
      drafts: store.db.personalizedDrafts,
      approvals: store.db.approvalRequests,
      actions: store.db.outboundActions,
      claims: store.db.accountClaims,
      evidence: store.db.evidence,
      qualifications: store.db.qualifications,
    });

    record(store, fixture, "This sounds good, I would like to book a call.");

    expect(store.db.personalizedDrafts).toEqual(JSON.parse(before).drafts);
    expect(store.db.approvalRequests).toEqual(JSON.parse(before).approvals);
    expect(store.db.outboundActions).toEqual(JSON.parse(before).actions);
    // The two that matter most: a reply is not evidence, and reading a reply
    // never becomes an account fact.
    expect(store.db.accountClaims).toEqual(JSON.parse(before).claims);
    expect(store.db.evidence).toEqual(JSON.parse(before).evidence);
    expect(store.db.qualifications).toEqual(JSON.parse(before).qualifications);
    expect(store.db.inboundMessages).toHaveLength(1);
    expect(store.db.conversationClassifications).toHaveLength(1);
  });

  it("holds no provider, scheduler or outbound capability", () => {
    // A response classified as positive recommends preparing a reply *for
    // approval*; it never carries an approval, a status, or a send.
    const draft = classify("Sounds good, book a call.");
    expect(draft.recommendedNextAction).toBe("prepare_reply_for_approval");
    const persisted = Object.keys(draft).sort();
    expect(persisted).not.toContain("sent");
    expect(persisted).not.toContain("approved");
    expect(persisted).not.toContain("status");
    expect(persisted).not.toContain("evidenceId");
  });

  it("classifies a response whose action is a sent one, and nothing else", () => {
    // The reader is the boundary: anything that is not `sent` is invisible.
    const store = seed();
    const fixture = scenario(store);
    const reader = createOutboundReader({
      getOutboundAction: (id, userId) => store.getOutboundAction(id, userId),
      getContact: (id, userId) => store.getContact(id, userId),
    });
    const asOwner: ConversationOutboundSnapshot | null = reader.sentAction(
      fixture.sentActionId,
      fixture.owner.id,
    );
    expect(asOwner?.status).toBe("sent");
    const asStranger = reader.sentAction(fixture.sentActionId, "someone-else");
    expect(asStranger).toBeNull();
    expect(reader.sentAction("no-such-action", fixture.owner.id)).toBeNull();
  });
});
