import { describe, expect, it } from "vitest";
import { Store, emptyState } from "@dealora/db";
import type { AccountClaim, Evidence, PersonalizedDraft } from "@dealora/db";

import {
  LIMITS,
  PERSONALIZATION_RENDERER_VERSION,
  createPersonalizationService,
  renderDraft,
  toOfferSnapshot,
  toQualificationSnapshot,
} from "./index.js";

/**
 * Phase 9 package tests — ROADMAP.md §16.
 *
 * These prove the renderer's rules against a real store rather than a mock: the
 * draft's every factual statement is quoted from a stored record, a contested
 * claim is never stated as fact, unapproved pricing is withheld and recorded,
 * and the renderer is a pure function of its input.
 */

/** A workspace, an owner, an account and a qualified evaluation, seeded once. */
function seeded() {
  const store = new Store(emptyState());
  const user = store.createUser({
    email: "owner@example.com",
    password: "correct-horse-battery",
    displayName: "Owner",
  });
  if (!user.ok) throw new Error("seed user failed");
  const workspace = store.createWorkspace({ ownerId: user.value.id, name: "Acme Agency" });
  if (!workspace.ok) throw new Error("seed workspace failed");

  const offer = store.createOffer({
    workspaceId: workspace.value.id,
    userId: user.value.id,
    name: "Support Automation",
    description: "We build support automation for SaaS teams.",
    outcome: "faster first response times",
    pricing: {
      model: "one_time",
      amountMin: 5000,
      amountMax: null,
      currency: "USD",
      notes: null,
      // Unapproved: the draft must withhold the price and say so.
      approved: false,
    },
    status: "active",
  });
  if (!offer.ok) throw new Error("seed offer failed");

  const account = store.createAccount({
    workspaceId: workspace.value.id,
    createdBy: user.value.id,
    account: {
      name: "Northwind",
      website: "https://northwind.example",
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

  const service = createPersonalizationService(
    store as never,
    {
      latest: (workspaceId, userId, accountId) => {
        const auth = store.authorize(workspaceId, userId);
        if (!auth.ok) return null;
        const listed = store.listQualifications(workspaceId, userId, { accountId });
        if (!listed.ok) return null;
        const latest = listed.value[0];
        return latest === undefined ? null : toQualificationSnapshot(latest);
      },
      byId: (qualificationId, userId) => {
        const found = store.getQualification(qualificationId, userId);
        return found.ok ? toQualificationSnapshot(found.value) : null;
      },
    },
    {
      byId: (offerId, userId) => {
        const found = store.getOffer(offerId, userId);
        return found.ok ? toOfferSnapshot(found.value) : null;
      },
      listActive: (workspaceId, userId) => {
        const auth = store.authorize(workspaceId, userId);
        if (!auth.ok) return [];
        const offers = store.listOffers(workspaceId, userId);
        if (!offers.ok) return [];
        return offers.value.filter((entry) => entry.status === "active").map(toOfferSnapshot);
      },
    },
  );

  return { store, user, workspace, offer, account, service };
}

/** Record an account claim plus one supporting evidence record. */
function addClaim(
  store: Store,
  workspaceId: string,
  userId: string,
  accountId: string,
  input: {
    category: "expansion" | "recent_announcements" | "hiring";
    field: string;
    value: string;
    observedAt?: string;
    confidence?: "low" | "medium" | "high";
    relevance?: "low" | "medium" | "high";
  },
): { claim: AccountClaim; evidence: Evidence } {
  const claim = store.createAccountClaim({
    workspaceId,
    createdBy: userId,
    accountId,
    category: input.category,
    field: input.field,
    value: input.value,
    claimKind: "fact",
  });
  if (!claim.ok) throw new Error("seed claim failed");
  const evidence = store.createEvidence({
    workspaceId,
    accountClaimId: claim.value.id,
    evidence: {
      researchFindingId: null,
      provenance: "user_supplied",
      source: "public_web",
      sourceName: "Company newsroom",
      sourceUrl: "https://northwind.example/news",
      sourceTitle: "Newsroom",
      observedAt: input.observedAt ?? "2026-08-14T00:00:00.000Z",
      retrievedAt: "2026-09-01T00:00:00.000Z",
      confidence: input.confidence ?? "high",
      freshness: "fresh",
      relevance: input.relevance ?? "high",
      status: "recorded",
      note: null,
    },
  });
  if (!evidence.ok) throw new Error("seed evidence failed");
  return { claim: claim.value, evidence: evidence.value };
}

/** A `qualified` evaluation for the seeded account, created through storage. */
function qualify(
  store: Store,
  workspaceId: string,
  userId: string,
  accountId: string,
  state: "qualified" | "unqualified" = "qualified",
) {
  const created = store.createQualification({
    workspaceId,
    createdBy: userId,
    accountId,
    qualification: {
      ruleVersion: "qualification-rules-1.0.0",
      revenuePlanId: null,
      revenueGoalId: null,
      icpId: null,
      contextDigest: "fnv1a-seed",
      state,
      score: 90,
      confidence: "high",
      reason: "seeded",
      evidenceIds: [],
      claimIds: [],
      conflictedClaimIds: [],
      dimensions: [],
      evaluatedAt: "2026-09-01T00:00:00.000Z",
    },
  });
  if (!created.ok) throw new Error("seed qualification failed");
  return created.value;
}

describe("Personalization renderer", () => {
  const offer = {
    id: "o1",
    name: "Support Automation",
    description: "We build support automation for SaaS teams.",
    outcome: "faster first response times",
    status: "active" as const,
    pricingApproved: false,
  };

  it("quotes an eligible claim verbatim and attributes it to its source", () => {
    const claim: AccountClaim = {
      id: "c1",
      workspaceId: "w1",
      accountId: "a1",
      category: "expansion",
      field: "expansion.geography",
      value: "announced expansion into Germany in September",
      claimKind: "fact",
      status: "asserted",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const evidence: Evidence = {
      id: "e1",
      workspaceId: "w1",
      accountId: "a1",
      accountClaimId: "c1",
      researchFindingId: null,
      provenance: "user_supplied",
      source: "public_web",
      sourceName: "Company newsroom",
      sourceUrl: "https://example.test/news",
      sourceTitle: "Newsroom",
      observedAt: "2026-09-14T00:00:00.000Z",
      retrievedAt: "2026-09-15T00:00:00.000Z",
      confidence: "high",
      freshness: "fresh",
      relevance: "high",
      status: "recorded",
      note: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    };

    const rendered = renderDraft({
      rendererVersion: PERSONALIZATION_RENDERER_VERSION,
      account: { id: "a1", name: "Northwind" },
      contact: null,
      qualificationId: "q1",
      offer,
      claims: [claim],
      evidence: [evidence],
      approvedClaims: [],
    });

    expect(rendered.points).toHaveLength(1);
    const point = rendered.points[0];
    expect(point?.value).toBe("announced expansion into Germany in September");
    // Verbatim between quotes, attributed to the source and its observation
    // month. Nothing is reworded, which is where fabrication would enter.
    expect(point?.statement).toBe(
      '"announced expansion into Germany in September" — Company newsroom, September 2026.',
    );
    expect(rendered.body).toContain(point?.statement);
  });

  it("is a pure function of its input", () => {
    const input = {
      rendererVersion: PERSONALIZATION_RENDERER_VERSION,
      account: { id: "a1", name: "Northwind" },
      contact: { id: "ct1", fullName: "Ada Lovelace" },
      qualificationId: "q1",
      offer,
      claims: [],
      evidence: [],
      approvedClaims: [{ id: "bc1", text: "We ship in two weeks." }],
    };
    const first = renderDraft(input);
    const second = renderDraft(input);
    expect(second).toEqual(first);
    // Two runs, no clock, no randomness: the same bytes every time.
    expect(first.contextDigest).toBe(second.contextDigest);
  });

  it("withholds unapproved pricing and records that it did", () => {
    const rendered = renderDraft({
      rendererVersion: PERSONALIZATION_RENDERER_VERSION,
      account: { id: "a1", name: "Northwind" },
      contact: null,
      qualificationId: "q1",
      offer,
      claims: [],
      evidence: [],
      approvedClaims: [],
    });

    expect(rendered.body).not.toContain("5000");
    expect(rendered.body).not.toContain("USD");
    expect(rendered.warnings.join(" ")).toContain("pricing is not approved");
  });

  it("records a warning instead of inventing familiarity when nothing is eligible", () => {
    const rendered = renderDraft({
      rendererVersion: PERSONALIZATION_RENDERER_VERSION,
      account: { id: "a1", name: "Northwind" },
      contact: null,
      qualificationId: "q1",
      offer,
      claims: [],
      evidence: [],
      approvedClaims: [],
    });

    expect(rendered.points).toHaveLength(0);
    expect(rendered.warnings.join(" ")).toContain("no account-specific factual statement");
    expect(rendered.warnings.join(" ")).toContain("not addressed to a specific person");
  });

  it("keeps every rendered string inside its declared bound", () => {
    const rendered = renderDraft({
      rendererVersion: PERSONALIZATION_RENDERER_VERSION,
      account: { id: "a1", name: "Northwind" },
      contact: null,
      qualificationId: "q1",
      offer,
      claims: [],
      evidence: [],
      approvedClaims: [{ id: "bc1", text: "x".repeat(5000) }],
    });

    expect(rendered.subject.length).toBeLessThanOrEqual(LIMITS.subject);
    expect(rendered.body.length).toBeLessThanOrEqual(LIMITS.body);
    for (const warning of rendered.warnings) {
      expect(warning.length).toBeLessThanOrEqual(LIMITS.warning + 1);
    }
  });
});

describe("PersonalizationService", () => {
  it("requires a qualified account before drafting", () => {
    const { service, user, workspace, account } = seeded();
    const unqualified = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(unqualified.ok).toBe(false);
    if (unqualified.ok) return;
    expect(unqualified.error.code).toBe("NOT_FOUND");
    expect(unqualified.error.message).toContain("no qualification evaluation");
  });

  it("refuses to draft for an account whose evaluation is not qualified", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id, "unqualified");

    const result = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
    expect(result.error.message).toContain("not qualified");
  });

  it("generates a draft whose statements are traceable to evidence", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);
    addClaim(store, workspace.value.id, user.value.id, account.value.id, {
      category: "expansion",
      field: "expansion.geography",
      value: "announced expansion into Germany in September",
    });

    const generated = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const draft: PersonalizedDraft = generated.value;

    expect(draft.version).toBe(1);
    expect(draft.rendererVersion).toBe(PERSONALIZATION_RENDERER_VERSION);
    expect(draft.personalizationPoints).toHaveLength(1);
    expect(draft.personalizationPoints[0]?.evidenceIds).toHaveLength(1);
    expect(draft.body).toContain("announced expansion into Germany in September");

    // The phase's gate: the draft and its supporting evidence, in one read.
    const inspected = service.inspectDraft(draft.id, user.value.id);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.claims).toHaveLength(1);
    expect(inspected.value.evidence).toHaveLength(1);
    expect(inspected.value.qualification?.state).toBe("qualified");
  });

  it("excludes a contested claim and says so in a warning", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);
    const { claim } = addClaim(store, workspace.value.id, user.value.id, account.value.id, {
      category: "hiring",
      field: "hiring.headcount",
      value: "hired 40 engineers",
    });
    store.updateAccountClaim(claim.id, { userId: user.value.id, status: "contested" });

    const generated = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    expect(generated.value.personalizationPoints).toHaveLength(0);
    expect(generated.value.body).not.toContain("hired 40 engineers");
    expect(generated.value.warnings.join(" ")).toContain("contested");
  });

  it("treats a contradicted evidence record as a disagreement, never as fact", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);
    const { claim } = addClaim(store, workspace.value.id, user.value.id, account.value.id, {
      category: "hiring",
      field: "hiring.headcount",
      value: "hired 40 engineers",
    });
    // Mark the supporting record contradicted. The claim stays `asserted` —
    // what makes it contested for a reader is that its sources disagree.
    const listed = store.listEvidence(workspace.value.id, user.value.id, {
      accountClaimId: claim.id,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const support = listed.value[0];
    expect(support).toBeDefined();
    if (support === undefined) return;
    store.updateEvidence(support.id, { userId: user.value.id, status: "contradicted" });

    const generated = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.body).not.toContain("hired 40 engineers");
  });

  it("never quotes an unverified or restricted Business Brain claim", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);

    const unverified = store.createClaim({
      workspaceId: workspace.value.id,
      userId: user.value.id,
      text: "Ten times faster ticket resolution.",
      category: "result",
      // `createClaim` never mints an approved claim: approval is its own
      // explicit, attributed step.
      status: "unverified",
    });
    expect(unverified.ok).toBe(true);
    if (!unverified.ok) return;
    expect(unverified.value.status).toBe("unverified");

    const generated = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.body).not.toContain("Ten times faster");
    expect(generated.value.approvedClaimIds).toHaveLength(0);
  });

  it("quotes an approved Business Brain claim verbatim", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);

    const created = store.createClaim({
      workspaceId: workspace.value.id,
      userId: user.value.id,
      text: "We have shipped support automation for 40 SaaS teams.",
      category: "result",
      status: "unverified",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // The business clears the text for external use through its own route,
    // which is what records who approved it and when.
    const approved = store.approveClaim(created.value.id, user.value.id);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    const generated = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.body).toContain("We have shipped support automation for 40 SaaS teams.");
    expect(generated.value.approvedClaimIds).toContain(approved.value.id);
  });

  it("inserts a new immutable version rather than rewriting a draft", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);

    const first = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = service.generateDraft(workspace.value.id, user.value.id, account.value.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.version).toBe(first.value.version + 1);
    expect(second.value.id).not.toBe(first.value.id);

    // The earlier version is untouched and still readable: an approval may be
    // bound to it and must stay explainable.
    const reloaded = service.getDraft(first.value.id, user.value.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.version).toBe(first.value.version);
    expect(reloaded.value.body).toBe(first.value.body);
  });

  it("does not reveal another workspace's account, contact or qualification", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);

    // A real second tenant, so this is an authorization decision rather than a
    // lookup of a workspace that simply does not exist.
    const otherUserResult = store.createUser({
      email: "intruder@example.com",
      password: "correct-horse-battery",
      displayName: "Intruder",
    });
    expect(otherUserResult.ok).toBe(true);
    if (!otherUserResult.ok) return;
    const otherWorkspace = store.createWorkspace({
      ownerId: otherUserResult.value.id,
      name: "Globex",
    });
    expect(otherWorkspace.ok).toBe(true);
    if (!otherWorkspace.ok) return;

    // The intruder is not a member of the seeded workspace, so this is refused at
    // the tenant boundary, and refused as UNAUTHORIZED rather than NOT_FOUND: a
    // non-member must not be able to tell "this workspace exists" from "it does
    // not" by reading the error code.
    const denied = service.generateDraft(
      workspace.value.id,
      otherUserResult.value.id,
      account.value.id,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("UNAUTHORIZED");
    expect(denied.error.message).toBe("workspace access denied");

    // A workspace that exists to nobody at all is reported as absent, which is
    // the one distinction the previous refusal deliberately preserves.
    const missing = service.generateDraft("ws-does-not-exist", user.value.id, account.value.id);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("NOT_FOUND");

    // Inside their own workspace the intruder is a legitimate member, so the
    // only thing left to refuse is the foreign account — and it is reported as
    // absent rather than confirmed to exist.
    const hidden = service.generateDraft(
      otherWorkspace.value.id,
      otherUserResult.value.id,
      account.value.id,
    );
    expect(hidden.ok).toBe(false);
    if (hidden.ok) return;
    expect(hidden.error.code).toBe("NOT_FOUND");

    // A qualification belonging to another account is refused as not found, so
    // one account's evaluation can never authorize another account's draft.
    const otherAccount = store.createAccount({
      workspaceId: workspace.value.id,
      createdBy: user.value.id,
      account: {
        name: "Globex",
        website: null,
        domain: "globex.example",
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
    expect(otherAccount.ok).toBe(true);
    if (!otherAccount.ok) return;
    const first = qualify(store, workspace.value.id, user.value.id, account.value.id);

    const borrowed = service.generateDraft(
      workspace.value.id,
      user.value.id,
      otherAccount.value.id,
      { qualificationId: first.id },
    );
    expect(borrowed.ok).toBe(false);
    if (borrowed.ok) return;
    expect(borrowed.error.code).toBe("NOT_FOUND");
  });

  it("refuses a contact that belongs to another account", () => {
    const { store, service, user, workspace, account } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);

    const otherAccount = store.createAccount({
      workspaceId: workspace.value.id,
      createdBy: user.value.id,
      account: {
        name: "Globex",
        website: null,
        domain: "globex.example",
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
    expect(otherAccount.ok).toBe(true);
    if (!otherAccount.ok) return;
    const contact = store.createContact({
      workspaceId: workspace.value.id,
      createdBy: user.value.id,
      contact: {
        accountId: otherAccount.value.id,
        firstName: "Grace",
        lastName: "Hopper",
        fullName: "Grace Hopper",
        jobTitle: "CTO",
        email: "grace@globex.example",
        phone: null,
        profileUrl: null,
        source: "manual",
        sourceReference: null,
        status: "active",
      },
    });
    expect(contact.ok).toBe(true);
    if (!contact.ok) return;

    const result = service.generateDraft(workspace.value.id, user.value.id, account.value.id, {
      contactId: contact.value.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("refuses an offer that is not active", () => {
    const { store, service, user, workspace, account, offer } = seeded();
    qualify(store, workspace.value.id, user.value.id, account.value.id);
    const retired = store.updateOffer(offer.value.id, { userId: user.value.id, status: "retired" });
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;

    const result = service.generateDraft(workspace.value.id, user.value.id, account.value.id, {
      offerId: offer.value.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
  });

  it("refuses a renderer version this deployment does not implement", () => {
    const { service, user, workspace, account } = seeded();
    const result = service.generateDraft(workspace.value.id, user.value.id, account.value.id, {
      rendererVersion: "gpt-improvised-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_RENDERER_VERSION");
  });

  it("describes what a draft may and may not state, before any draft exists", () => {
    const { service, user, workspace } = seeded();
    const described = service.describePersonalizationRenderer(workspace.value.id, user.value.id);
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value.rendererVersion).toBe(PERSONALIZATION_RENDERER_VERSION);
    expect(described.value.mayNeverState.join(" ")).toContain("contested");
    expect(described.value.mayNeverState.join(" ")).toContain("delivery result");
  });

  it("exposes no outbound surface at all", () => {
    // Phase 9 produces a document. Nothing on the service can transmit
    // anything: there is no send, no dispatch, no provider and no channel.
    // The only outward movement is `createDraft`, which writes a row.
    const { service } = seeded();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(service) as object).map(
      (name) => name.toLowerCase(),
    );

    for (const forbidden of ["send", "dispatch", "deliver", "provider", "publish"]) {
      expect(surface.some((name) => name.includes(forbidden))).toBe(false);
    }
    expect(surface).toContain("generatedraft");
  });
});
