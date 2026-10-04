import { describe, expect, it } from "vitest";
import { Store, emptyState } from "@dealora/db";
import type { PersonalizedDraft } from "@dealora/db";

import {
  FailingEmailProvider,
  ProviderRegistry,
  SandboxEmailProvider,
  ThrowingEmailProvider,
  createApprovalVerifier,
  createContactReader,
  createDraftReader,
  createOutboundService,
  isDeliverableAddress,
} from "./index.js";

/**
 * Phase 11 package tests — ROADMAP.md §18.
 *
 * The properties under test are the ones the phase exists for: a message leaves
 * this system only through an explicit send of an action whose **exact** draft
 * version a human approved, addressed to someone who has not opted out, exactly
 * once, and a failure is never mistaken for a delivery.
 *
 * Every test runs against the real store. The provider is the sandbox — it
 * performs no network I/O, records what it accepted, and returns a confirmation
 * the service then has to earn. Nothing here fakes a delivery: what is asserted
 * about delivery is that the provider recorded it, not that an email arrived
 * somewhere.
 */

function clockAt(iso: string): () => Date {
  return () => new Date(iso);
}

interface Fixture {
  store: Store;
  userId: string;
  workspaceId: string;
  draft: PersonalizedDraft;
  contactId: string;
  service: ReturnType<typeof createOutboundService>;
  provider: SandboxEmailProvider;
  registry: ProviderRegistry;
}

/**
 * A workspace with a qualified-and-drafted account, an approved draft version and
 * a sandbox provider registered for email.
 */
function seeded(options?: {
  now?: string;
  contactEmail?: string | null;
  registerProvider?: boolean;
}): Fixture {
  const now = options?.now ?? "2026-10-01T00:00:00.000Z";
  const store = new Store(emptyState());
  const user = store.createUser({
    email: "owner@example.com",
    password: "correct-horse-battery",
    displayName: "Owner",
  });
  if (!user.ok) throw new Error("seed user failed");
  const workspace = store.createWorkspace({ ownerId: user.value.id, name: "Acme Agency" });
  if (!workspace.ok) throw new Error("seed workspace failed");

  const account = store.createAccount({
    workspaceId: workspace.value.id,
    createdBy: user.value.id,
    account: {
      name: "Northwind",
      website: null,
      domain: "northwind.example",
      industry: "SaaS",
      companySize: "50-200",
      geography: "Germany",
      description: null,
      source: "manual",
      sourceReference: null,
      revenuePlanId: null,
      status: "active",
    },
  });
  if (!account.ok) throw new Error("seed account failed");

  const email =
    options?.contactEmail === undefined ? "ada@northwind.example" : options.contactEmail;
  const contact = store.createContact({
    workspaceId: workspace.value.id,
    createdBy: user.value.id,
    contact: {
      accountId: account.value.id,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      jobTitle: "VP Support",
      email,
      phone: null,
      profileUrl: null,
      source: "manual",
      sourceReference: null,
      status: "active",
    },
  });
  if (!contact.ok) throw new Error("seed contact failed");

  const created = store.createDraft({
    workspaceId: workspace.value.id,
    createdBy: user.value.id,
    accountId: account.value.id,
    draft: {
      contactId: contact.value.id,
      rendererVersion: "deterministic-1.0.0",
      contextDigest: "fnv1a-seed",
      qualificationId: null,
      offerId: null,
      subject: "Support Automation for Northwind",
      body: "Hi Ada,\n\nAbout Support Automation: We build support automation for SaaS teams.\n\nWould a short conversation be useful?",
      personalizationPoints: [],
      approvedClaimIds: [],
      warnings: [],
    },
  });
  if (!created.ok) throw new Error("seed draft failed");

  const provider = new SandboxEmailProvider();
  const registry = new ProviderRegistry();
  if (options?.registerProvider !== false) {
    registry.register("email", provider);
  }

  const service = createOutboundService(
    store as never,
    createApprovalVerifier(store as never),
    createDraftReader(store as never),
    createContactReader(store as never),
    registry,
    clockAt(now),
  );

  return {
    store,
    userId: user.value.id,
    workspaceId: workspace.value.id,
    draft: created.value,
    contactId: contact.value.id,
    service,
    provider,
    registry,
  };
}

/** Request approval for the seeded draft and approve it, as a human would. */
function approve(
  fixture: Fixture,
  decision: "approved" | "rejected" | "changes_requested" = "approved",
): { approvalId: string; reason: string | null } {
  const requested = fixture.store.createApprovalRequest({
    workspaceId: fixture.workspaceId,
    createdBy: fixture.userId,
    approval: {
      actionKind: "send_message",
      riskLevel: "level_2_external_action",
      draftId: fixture.draft.id,
      draftVersion: fixture.draft.version,
      previewSubject: fixture.draft.subject,
      previewDigest: "fnv1a-whatever",
      expiresAt: null,
    },
  });
  if (!requested.ok) throw new Error("seed approval request failed");
  const reason =
    decision === "approved" ? null : decision === "rejected" ? "not now" : "say something else";
  const decided = fixture.store.decideApproval({
    id: requested.value.id,
    userId: fixture.userId,
    decision,
    reason,
    decidedAt: "2026-10-01T00:00:00.000Z",
  });
  if (!decided.ok) throw new Error("seed approval decision failed");
  return { approvalId: requested.value.id, reason };
}

describe("OutboundService", () => {
  it("sends one approved message and records the provider's confirmation", async () => {
    const fixture = seeded();
    const { approvalId } = approve(fixture);

    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value.status).toBe("ready");
    expect(staged.value.approvalId).toBe(approvalId);
    expect(staged.value.draftVersion).toBe(fixture.draft.version);
    // The recipient is resolved from the contact record, not from the caller.
    expect(staged.value.recipientEmail).toBe("ada@northwind.example");
    expect(staged.value.channel).toBe("email");
    expect(staged.value.attemptCount).toBe(0);

    const sent = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    expect(sent.value.delivered).toBe(true);
    expect(sent.value.action.status).toBe("sent");
    expect(sent.value.action.sentAt).not.toBeNull();
    expect(sent.value.action.provider).toBe("sandbox_email");
    expect(sent.value.action.providerReference).not.toBeNull();
    expect(sent.value.action.failureCode).toBeNull();

    // The provider itself recorded the message, so "sent" is a confirmed fact
    // rather than a status the system asserted about itself.
    const deliveries = fixture.provider.deliveries();
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    expect(delivery?.to).toBe("ada@northwind.example");
    expect(delivery?.subject).toBe(fixture.draft.subject);
    // The delivered body is the approved body, byte for byte.
    expect(delivery?.body).toBe(fixture.draft.body);

    // And the audit trail explains the whole thing.
    expect(sent.value.events.map((event) => event.kind)).toEqual([
      "created",
      "send_attempted",
      "sent",
    ]);
    for (const event of sent.value.events) {
      expect(event.actorUserId).toBe(fixture.userId);
      expect(event.createdAt).not.toBe("");
    }
  });

  it("sends nothing at all without a persisted human approval", async () => {
    const fixture = seeded();

    // No approval exists yet: there is nothing that could authorize a send.
    const unapproved = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    expect(unapproved.ok).toBe(false);
    if (unapproved.ok) return;
    expect(unapproved.error.code).toBe("UNAPPROVED");
    expect(fixture.provider.callCount()).toBe(0);

    // A requested-but-undecided approval is still nothing.
    const requested = fixture.store.createApprovalRequest({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.userId,
      approval: {
        actionKind: "send_message",
        riskLevel: "level_2_external_action",
        draftId: fixture.draft.id,
        draftVersion: fixture.draft.version,
        previewSubject: fixture.draft.subject,
        previewDigest: "fnv1a-whatever",
        expiresAt: null,
      },
    });
    if (!requested.ok) return;
    const pending = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    expect(pending.ok).toBe(false);
    if (pending.ok) return;
    expect(pending.error.code).toBe("UNAPPROVED");

    // A refusal authorizes nothing either.
    const refused = approve(fixture, "rejected");
    void refused;
    const refusedStage = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    expect(refusedStage.ok).toBe(false);
    if (refusedStage.ok) return;
    expect(refusedStage.error.code).toBe("UNAPPROVED");
    expect(fixture.provider.callCount()).toBe(0);
  });

  it("refuses to authorize a draft version no approval covers", async () => {
    const fixture = seeded();
    approve(fixture);

    // A second, newer version of the same lineage. The approval covers version 1.
    const regenerated = fixture.store.createDraft({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.userId,
      accountId: fixture.draft.accountId,
      draft: {
        contactId: fixture.draft.contactId,
        rendererVersion: "deterministic-1.0.0",
        contextDigest: "fnv1a-seed-2",
        qualificationId: null,
        offerId: null,
        subject: "A completely different subject nobody reviewed",
        body: "Sign here first.",
        personalizationPoints: [],
        approvedClaimIds: [],
        warnings: [],
      },
    });
    if (!regenerated.ok) return;
    expect(regenerated.value.version).toBe(2);

    // Version 2 is a different document, and no approval names it.
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      regenerated.value.id,
    );
    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.error.code).toBe("UNAPPROVED");

    // And naming the *approved* version on the new draft is refused too: the
    // approval names one draft, not a lineage.
    const misnamed = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      regenerated.value.id,
      { draftVersion: fixture.draft.version },
    );
    expect(misnamed.ok).toBe(false);
    if (misnamed.ok) return;
    expect(misnamed.error.code).toBe("NOT_FOUND");

    // And a version that never existed is refused.
    const imaginary = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
      { draftVersion: 99 },
    );
    expect(imaginary.ok).toBe(false);
    if (imaginary.ok) return;
    expect(imaginary.error.code).toBe("NOT_FOUND");

    expect(fixture.provider.callCount()).toBe(0);
  });

  it("refuses to send twice: one approval authorizes one message", async () => {
    const fixture = seeded();
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");
    const first = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(first.ok).toBe(true);
    expect(fixture.provider.callCount()).toBe(1);

    // The same action again is refused: it is already `sent`.
    const again = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe("CONFLICT");

    // And staging the same approval again returns the existing action rather
    // than creating a second one that could be sent.
    const restaged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    expect(restaged.ok).toBe(true);
    if (!restaged.ok) return;
    expect(restaged.value.id).toBe(staged.value.id);

    // One message, one provider acceptance, whatever was asked for.
    expect(fixture.provider.deliveries()).toHaveLength(1);
    expect(fixture.provider.callCount()).toBe(1);
  });

  it("never marks a provider failure as sent", async () => {
    const failing = new FailingEmailProvider("rate_limited", "slow down");
    const fixture = seeded({ registerProvider: false });
    fixture.registry.register("email", failing);
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");

    const sent = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(sent.error.code).toBe("PROVIDER_FAILED");

    const stored = fixture.service.getOutbound(staged.value.id, fixture.userId);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.status).toBe("failed");
    // A failed attempt carries no `sentAt`, no reference and no delivery.
    expect(stored.value.sentAt).toBeNull();
    expect(stored.value.providerReference).toBeNull();
    expect(stored.value.failureCode).toBe("rate_limited");
    // The provider's own words are kept verbatim alongside the closed code.
    expect(stored.value.failureMessage).toBe("slow down");
    expect(stored.value.attemptCount).toBe(1);
    expect(stored.value.completedAt).not.toBeNull();
    expect(failing.attempts()).toBe(1);

    // The trail records the failure as its own step.
    const history = fixture.service.actionHistory(staged.value.id, fixture.userId);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.map((event) => event.kind)).toEqual([
      "created",
      "send_attempted",
      "failed",
    ]);
  });

  it("records a thrown provider call as a failure, never as a send", async () => {
    const throwing = new ThrowingEmailProvider();
    const fixture = seeded({ registerProvider: false });
    fixture.registry.register("email", throwing);
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");

    const sent = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(sent.ok).toBe(false);

    const stored = fixture.service.getOutbound(staged.value.id, fixture.userId);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.status).toBe("failed");
    expect(stored.value.sentAt).toBeNull();
    expect(stored.value.failureCode).toBe("provider_unavailable");
    expect(stored.value.failureMessage).toContain("connection dropped");
  });

  it("retries a failure explicitly, and de-duplicates at the provider", async () => {
    const fixture = seeded({ registerProvider: false });
    const flaky = new FailingEmailProvider("provider_unavailable", "try again");
    fixture.registry.register("email", flaky);
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await fixture.service.sendOutbound(
        fixture.workspaceId,
        fixture.userId,
        staged.value.id,
      );
      expect(result.ok).toBe(false);
    }
    const counted = fixture.service.getOutbound(staged.value.id, fixture.userId);
    if (!counted.ok) throw new Error("read failed");
    expect(counted.value.attemptCount).toBe(2);
    expect(counted.value.status).toBe("failed");

    // The provider now works. The same action can be sent again, because a
    // failed action is retryable — by a human, one call at a time.
    fixture.registry.register("email", fixture.provider);
    const recovered = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.action.status).toBe("sent");
    expect(recovered.value.action.attemptCount).toBe(3);
    expect(fixture.provider.deliveries()).toHaveLength(1);
  });

  it("stops retrying an action that has used all of its attempts", async () => {
    const fixture = seeded({ registerProvider: false });
    const failing = new FailingEmailProvider();
    fixture.registry.register("email", failing);
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await fixture.service.sendOutbound(
        fixture.workspaceId,
        fixture.userId,
        staged.value.id,
      );
      expect(result.ok).toBe(false);
    }
    expect(failing.attempts()).toBe(5);

    // The sixth is refused before the provider is reached at all.
    const sixth = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(sixth.ok).toBe(false);
    if (sixth.ok) return;
    expect(sixth.error.code).toBe("CONFLICT");
    expect(sixth.error.message).toContain("attempts");
    expect(failing.attempts()).toBe(5);
  });

  it("refuses to reach a suppressed address, before the provider is called", async () => {
    const fixture = seeded();
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");

    const suppressed = fixture.service.suppress(
      fixture.workspaceId,
      fixture.userId,
      "Ada@Northwind.Example",
      "asked us to stop emailing her",
    );
    expect(suppressed.ok).toBe(true);
    if (!suppressed.ok) return;
    // Normalized, so an opt-out cannot be dodged by changing the casing.
    expect(suppressed.value.email).toBe("ada@northwind.example");
    expect(suppressed.value.createdBy).toBe(fixture.userId);

    const sent = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(sent.error.code).toBe("SUPPRESSED");
    // The provider was never reached.
    expect(fixture.provider.callCount()).toBe(0);

    // The attempt is recorded as failed with the suppression code, so the trail
    // says why nothing went out.
    const stored = fixture.service.getOutbound(staged.value.id, fixture.userId);
    if (!stored.ok) throw new Error("read failed");
    expect(stored.value.status).toBe("failed");
    expect(stored.value.failureCode).toBe("suppressed");
    expect(stored.value.sentAt).toBeNull();
    // A pre-flight refusal never reached a provider, so it names none and it
    // does not spend an attempt.
    expect(stored.value.provider).toBeNull();
    expect(stored.value.attemptCount).toBe(0);

    // Suppressing the same address twice is one record, not two.
    const again = fixture.service.suppress(
      fixture.workspaceId,
      fixture.userId,
      "ada@northwind.example",
      "asked us to stop emailing her",
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.id).toBe(suppressed.value.id);
    const list = fixture.service.listSuppressions(fixture.workspaceId, fixture.userId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
  });

  it("refuses to send without a configured provider", async () => {
    const fixture = seeded({ registerProvider: false });
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");

    const sent = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(sent.error.code).toBe("PROVIDER_UNAVAILABLE");

    // The action is untouched: no attempt was made, so nothing was recorded as
    // one. It is still `ready`, and still sendable once a provider exists.
    const stored = fixture.service.getOutbound(staged.value.id, fixture.userId);
    if (!stored.ok) throw new Error("read failed");
    expect(stored.value.status).toBe("ready");
    expect(stored.value.attemptCount).toBe(0);
    expect(stored.value.provider).toBeNull();

    fixture.registry.register("email", fixture.provider);
    expect(fixture.service.configuredProviders()).toEqual(["sandbox_email"]);
    const sentNow = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(sentNow.ok).toBe(true);
  });

  it("refuses a recipient the contact record cannot support", async () => {
    // No address at all: Phase 5 stores that honestly, and a send refuses it.
    const fixture = seeded({ contactEmail: null });
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.error.code).toBe("VALIDATION_ERROR");
    expect(staged.error.details?.map((detail) => detail.field)).toContain("email");
    expect(fixture.provider.callCount()).toBe(0);
  });

  it("treats a cancelled action as a closure, not as a pending send", async () => {
    const fixture = seeded();
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");

    const cancelled = fixture.service.cancelOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
      "wrote the wrong recipient",
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.status).toBe("cancelled");
    expect(cancelled.value.sentAt).toBeNull();

    // A cancelled action cannot be sent, and cancelling twice is refused.
    const sent = await fixture.service.sendOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
    );
    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(sent.error.code).toBe("CONFLICT");
    expect(fixture.provider.callCount()).toBe(0);

    const again = fixture.service.cancelOutbound(
      fixture.workspaceId,
      fixture.userId,
      staged.value.id,
      "changed my mind again",
    );
    expect(again.ok).toBe(false);
  });

  it("never reveals another tenant's draft, action or suppression list", async () => {
    const fixture = seeded();
    approve(fixture);
    const staged = fixture.service.stageOutbound(
      fixture.workspaceId,
      fixture.userId,
      fixture.draft.id,
    );
    if (!staged.ok) throw new Error("staging failed");

    const other = fixture.store.createUser({
      email: "intruder@example.com",
      password: "correct-horse-battery",
      displayName: "Intruder",
    });
    if (!other.ok) return;
    const otherWorkspace = fixture.store.createWorkspace({
      ownerId: other.value.id,
      name: "Globex",
    });
    if (!otherWorkspace.ok) return;

    // Not a member of the seeded workspace: refused at the tenant boundary.
    const denied = await fixture.service.sendOutbound(
      fixture.workspaceId,
      other.value.id,
      staged.value.id,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("UNAUTHORIZED");

    const read = fixture.service.getOutbound(staged.value.id, other.value.id);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe("UNAUTHORIZED");

    // Inside their own workspace they are a legitimate member, and the foreign
    // draft is simply not there.
    const hidden = fixture.service.stageOutbound(
      otherWorkspace.value.id,
      other.value.id,
      fixture.draft.id,
    );
    expect(hidden.ok).toBe(false);
    if (hidden.ok) return;
    expect(hidden.error.code).toBe("NOT_FOUND");

    // And an address suppressed by one workspace does not suppress another.
    fixture.service.suppress(
      fixture.workspaceId,
      fixture.userId,
      "shared@example.com",
      "one workspace opted out",
    );
    const elsewhere = fixture.service.isSuppressed(
      otherWorkspace.value.id,
      other.value.id,
      "shared@example.com",
    );
    expect(elsewhere.ok).toBe(true);
    if (!elsewhere.ok) return;
    expect(elsewhere.value).toBe(false);
    expect(fixture.provider.callCount()).toBe(0);
  });

  it("states what it requires and what it will never do, before anything is sent", () => {
    const fixture = seeded();
    const policy = fixture.service.policy(fixture.workspaceId, fixture.userId);
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;

    expect(policy.value.channel).toBe("email");
    expect(policy.value.requires.join(" ")).toContain(
      "persisted human approval covering the exact draft version",
    );
    expect(policy.value.neverDoes.join(" ")).toContain("send autonomously");
    expect(policy.value.neverDoes.join(" ")).toContain("mark a message sent unless the provider");
    expect(policy.value.neverDoes.join(" ")).toContain("send twice for one approval");
    expect(policy.value.retryPolicy).toContain("no automatic retry");
    expect(policy.value.maxAttempts).toBe(5);

    // No mass-outreach surface exists: one channel, no campaign, no schedule.
    const surface = Object.getOwnPropertyNames(
      Object.getPrototypeOf(fixture.service) as object,
    ).map((name) => name.toLowerCase());
    for (const forbidden of ["schedule", "queue", "campaign", "bulk", "blast", "autosend"]) {
      expect(surface.some((name) => name === forbidden)).toBe(false);
    }
  });

  it("validates addresses conservatively, without inventing an RFC parser", () => {
    for (const good of ["ada@northwind.example", "a.b+c@sub.domain.co.uk"]) {
      expect(isDeliverableAddress(good)).toBe(true);
    }
    for (const bad of [
      "",
      "ada",
      "ada@",
      "@northwind.example",
      "ada@northwind",
      "ada@northwind.",
      "ada@@northwind.example",
      "ada lovelace@northwind.example",
      ".ada@northwind.example",
    ]) {
      expect(isDeliverableAddress(bad)).toBe(false);
    }
  });

  it("exposes no method that sends without an approval check", () => {
    const fixture = seeded();
    const surface = Object.getOwnPropertyNames(
      Object.getPrototypeOf(fixture.service) as object,
    ).map((name) => name.toLowerCase());

    // `sendOutbound` is the only send path, and it is the one that verifies the
    // approval. There is no `execute`, `dispatch` or `autosend` beside it.
    expect(surface).toContain("sendoutbound");
    for (const forbidden of ["execute", "dispatch", "autosend", "schedule", "start"]) {
      expect(surface.some((name) => name === forbidden)).toBe(false);
    }
  });
});
