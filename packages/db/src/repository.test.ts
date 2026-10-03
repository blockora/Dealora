import { describe, expect, it } from "vitest";
import { isOk, isErr } from "@dealora/core";

import {
  Store,
  hashPassword,
  verifyPassword,
  newId,
  emptyState,
  migrateState,
  LATEST_SCHEMA_VERSION,
} from "./repository.js";
import type { DbState } from "./repository.js";
import { toDateTime } from "./types.js";
import type { Claim, User } from "./types.js";

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
  if (!isOk(created)) throw new Error("seed workspace creation failed");
  return created.value.id;
}

describe("repository", () => {
  it("generates unique ids", () => {
    expect(newId()).not.toBe(newId());
  });

  describe("hashPassword", () => {
    it("does not store plaintext", () => {
      const hashed = hashPassword("correct-horse-battery");
      expect(hashed).not.toBe("correct-horse-battery");
      expect(hashed).toContain(":");
    });

    it("verifies correct passwords", () => {
      const hashed = hashPassword("sup3r-secret!");
      expect(verifyPassword("sup3r-secret!", hashed)).toBe(true);
    });

    it("rejects wrong passwords", () => {
      const hashed = hashPassword("sup3r-secret!");
      expect(verifyPassword("wrong-password", hashed)).toBe(false);
    });
  });

  describe("users", () => {
    it("creates a user with a hashed password", () => {
      const store = seed();
      const created = store.createUser({
        email: "alice@example.com",
        password: "correct-horse-battery",
        displayName: "Alice",
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;

      expect(created.value.email).toBe("alice@example.com");
      expect(created.value.passwordHash).not.toBe("correct-horse-battery");

      const byEmail = store.getUserByEmail("alice@example.com");
      expect(isOk(byEmail)).toBe(true);
      if (!isOk(byEmail)) return;
      expect(byEmail.value).not.toBeNull();
      expect(byEmail.value?.passwordHash).toContain(":");
    });

    it("rejects duplicate email", () => {
      const store = seed();
      const first = store.createUser({
        email: "alice@example.com",
        password: "correct-horse-battery",
        displayName: "Alice",
      });
      expect(isOk(first)).toBe(true);

      const second = store.createUser({
        email: "alice@example.com",
        password: "other-password",
        displayName: "Alice 2",
      });
      expect(isErr(second)).toBe(true);
      if (isErr(second)) expect(second.error.code).toBe("CONFLICT");
    });

    it("updates a password hash without storing plaintext", () => {
      const store = seed();
      const user = makeOwner(store);
      const updated = store.updatePasswordHash(user.id, hashPassword("another-strong-pass"));
      expect(isOk(updated)).toBe(true);
      if (isErr(updated)) return;
      expect(updated.value.passwordHash).not.toContain("another-strong-pass");
      expect(verifyPassword("another-strong-pass", updated.value.passwordHash)).toBe(true);
    });

    it("rejects a malformed password hash", () => {
      const store = seed();
      const user = makeOwner(store);
      const updated = store.updatePasswordHash(user.id, "plaintext");
      expect(isErr(updated)).toBe(true);
      if (isErr(updated)) expect(updated.error.code).toBe("INVALID");
    });
  });

  describe("workspaces", () => {
    it("creates a workspace owned by the user", () => {
      const store = seed();
      const owner = makeOwner(store);
      const created = store.createWorkspace({ ownerId: owner.id, name: "Acme Corp" });

      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;
      expect(created.value.name).toBe("Acme Corp");
      expect(created.value.slug).toBe("acme-corp");
      expect(created.value.ownerId).toBe(owner.id);

      const list = store.getWorkspaces(owner.id);
      expect(isOk(list)).toBe(true);
      if (!isOk(list)) return;
      expect(list.value).toEqual([created.value]);
    });

    it("rejects workspace creation for unknown owner", () => {
      const store = seed();
      const created = store.createWorkspace({ ownerId: "missing-id", name: "X" });
      expect(isErr(created)).toBe(true);
      if (isErr(created)) expect(created.error.code).toBe("NOT_FOUND");
    });
  });

  describe("business profile", () => {
    it("creates a business profile bound to a workspace", () => {
      const store = seed();
      const owner = makeOwner(store);
      const workspaceId = makeWorkspace(store, owner.id, "Acme");

      const created = store.createBusinessProfile({
        workspaceId,
        ownerId: owner.id,
        name: "Acme Corp",
        description: "Makes widgets",
        website: "https://acme.example",
        market: "B2B services",
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;
      expect(created.value.market).toBe("B2B services");

      const fetched = store.getBusinessProfile(workspaceId);
      expect(isOk(fetched)).toBe(true);
      if (!isOk(fetched)) return;
      expect(fetched.value?.name).toBe("Acme Corp");
    });

    it("rejects a second business profile for the same workspace", () => {
      const store = seed();
      const owner = makeOwner(store);
      const workspaceId = makeWorkspace(store, owner.id, "Acme");
      const input = {
        workspaceId,
        ownerId: owner.id,
        name: "Acme",
        description: "Widgets",
      };
      expect(isOk(store.createBusinessProfile(input))).toBe(true);

      const second = store.createBusinessProfile(input);
      expect(isErr(second)).toBe(true);
      if (isErr(second)) expect(second.error.code).toBe("CONFLICT");
    });

    it("denies cross-workspace access", () => {
      const store = seed();
      const ownerA = makeOwner(store, "a@example.com");
      const ownerB = makeOwner(store, "b@example.com");
      const workspaceA = makeWorkspace(store, ownerA.id, "Workspace A");
      makeWorkspace(store, ownerB.id, "Workspace B");

      expect(isOk(store.authorize(workspaceA, ownerA.id))).toBe(true);

      const denied = store.authorize(workspaceA, ownerB.id);
      expect(isErr(denied)).toBe(true);
      if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");

      const notFound = store.authorize("missing-workspace", ownerA.id);
      expect(isErr(notFound)).toBe(true);
      if (isErr(notFound)) expect(notFound.error.code).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — Business Brain
  // -------------------------------------------------------------------------

  describe("offers", () => {
    it("creates, retrieves and updates an offer", () => {
      const store = seed();
      const owner = makeOwner(store);
      const workspaceId = makeWorkspace(store, owner.id, "Acme");

      const created = store.createOffer({
        workspaceId,
        userId: owner.id,
        name: "Support automation",
        description: "Automates inbound support",
        problemSolved: "Slow first response",
        pricing: {
          model: "recurring",
          amountMin: 2000,
          amountMax: null,
          currency: "USD",
          notes: null,
          approved: false,
        },
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;
      expect(created.value.status).toBe("draft");

      const listed = store.listOffers(workspaceId, owner.id);
      expect(isOk(listed)).toBe(true);
      if (!isOk(listed)) return;
      expect(listed.value).toHaveLength(1);

      const updated = store.updateOffer(created.value.id, {
        userId: owner.id,
        status: "active",
        outcome: "Faster first response",
      });
      expect(isOk(updated)).toBe(true);
      if (!isOk(updated)) return;
      expect(updated.value.status).toBe("active");
      expect(updated.value.outcome).toBe("Faster first response");
    });

    it("denies listing offers for a workspace the user does not belong to", () => {
      const store = seed();
      const ownerA = makeOwner(store, "a@example.com");
      const ownerB = makeOwner(store, "b@example.com");
      const workspaceA = makeWorkspace(store, ownerA.id, "Workspace A");

      store.createOffer({
        workspaceId: workspaceA,
        userId: ownerA.id,
        name: "Offer A",
        description: "For workspace A",
      });

      const denied = store.listOffers(workspaceA, ownerB.id);
      expect(isErr(denied)).toBe(true);
      if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");
    });

    it("reports a missing offer", () => {
      const store = seed();
      const owner = makeOwner(store);
      const missing = store.getOffer("does-not-exist", owner.id);
      expect(isErr(missing)).toBe(true);
      if (isErr(missing)) expect(missing.error.code).toBe("NOT_FOUND");
    });
  });

  describe("icp", () => {
    it("upserts a single structured ICP per workspace", () => {
      const store = seed();
      const owner = makeOwner(store);
      const workspaceId = makeWorkspace(store, owner.id, "Acme");

      const created = store.upsertIcp(workspaceId, owner.id, {
        industries: ["SaaS"],
        companySizes: ["10-200"],
        geographies: ["US"],
        businessModels: ["subscription"],
        characteristics: ["hiring support staff"],
        disqualifiers: ["pre-revenue"],
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;
      const icpId = created.value.id;

      const updated = store.upsertIcp(workspaceId, owner.id, { industries: ["SaaS", "Agency"] });
      expect(isOk(updated)).toBe(true);
      if (!isOk(updated)) return;
      // Same record, extended — the Brain stays a single canonical record.
      expect(updated.value.id).toBe(icpId);
      expect(updated.value.industries).toEqual(["SaaS", "Agency"]);

      const fetched = store.getIcp(workspaceId, owner.id);
      expect(isOk(fetched)).toBe(true);
      if (!isOk(fetched)) return;
      expect(fetched.value?.characteristics).toEqual(["hiring support staff"]);
    });

    it("denies ICP reads across workspaces", () => {
      const store = seed();
      const ownerA = makeOwner(store, "a@example.com");
      const ownerB = makeOwner(store, "b@example.com");
      const workspaceA = makeWorkspace(store, ownerA.id, "Workspace A");
      store.upsertIcp(workspaceA, ownerA.id, { industries: ["SaaS"] });

      const denied = store.getIcp(workspaceA, ownerB.id);
      expect(isErr(denied)).toBe(true);
      if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("personas", () => {
    it("creates, lists, updates and deletes a persona", () => {
      const store = seed();
      const owner = makeOwner(store);
      const workspaceId = makeWorkspace(store, owner.id, "Acme");

      const created = store.createPersona(workspaceId, owner.id, {
        title: "Head of Support",
        responsibilities: ["Owns support quality"],
        painPoints: ["Slow first response"],
        goals: ["Reduce response time"],
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;

      const listed = store.listPersonas(workspaceId, owner.id);
      expect(isOk(listed)).toBe(true);
      if (!isOk(listed)) return;
      expect(listed.value).toHaveLength(1);

      const updated = store.updatePersona(created.value.id, {
        userId: owner.id,
        buyingContext: "Quarterly planning",
      });
      expect(isOk(updated)).toBe(true);
      if (!isOk(updated)) return;
      expect(updated.value.buyingContext).toBe("Quarterly planning");

      expect(isOk(store.deletePersona(created.value.id, owner.id))).toBe(true);
      const afterDelete = store.listPersonas(workspaceId, owner.id);
      expect(isOk(afterDelete)).toBe(true);
      if (!isOk(afterDelete)) return;
      expect(afterDelete.value).toHaveLength(0);
    });

    it("denies persona access across workspaces", () => {
      const store = seed();
      const ownerA = makeOwner(store, "a@example.com");
      const ownerB = makeOwner(store, "b@example.com");
      const workspaceA = makeWorkspace(store, ownerA.id, "Workspace A");
      const persona = store.createPersona(workspaceA, ownerA.id, { title: "CTO" });
      expect(isOk(persona)).toBe(true);
      if (!isOk(persona)) return;

      const denied = store.getPersona(persona.value.id, ownerB.id);
      expect(isErr(denied)).toBe(true);
      if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("positioning and brand voice", () => {
    it("persists and updates positioning", () => {
      const store = seed();
      const owner = makeOwner(store);
      const workspaceId = makeWorkspace(store, owner.id, "Acme");

      const created = store.upsertPositioning(workspaceId, owner.id, {
        statement: "We automate support for B2B SaaS",
        differentiators: ["Domain-specific playbooks"],
        approvedValuePropositions: ["Cut first response time"],
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;

      const updated = store.upsertPositioning(workspaceId, owner.id, {
        statement: "We automate support for B2B SaaS and agencies",
        competitorContext: ["Manual staffing agencies"],
      });
      expect(isOk(updated)).toBe(true);
      if (!isOk(updated)) return;
      expect(updated.value.id).toBe(created.value.id);
      expect(updated.value.differentiators).toEqual(["Domain-specific playbooks"]);
      expect(updated.value.competitorContext).toEqual(["Manual staffing agencies"]);
    });

    it("persists brand voice guidance", () => {
      const store = seed();
      const owner = makeOwner(store);
      const workspaceId = makeWorkspace(store, owner.id, "Acme");

      const created = store.upsertBrandVoice(workspaceId, owner.id, {
        tone: ["direct", "specific"],
        style: "Short sentences",
        terminology: ["first response time"],
        constraints: ["Never promise a specific percentage improvement"],
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;
      expect(created.value.constraints).toHaveLength(1);

      const fetched = store.getBrandVoice(workspaceId, owner.id);
      expect(isOk(fetched)).toBe(true);
      if (!isOk(fetched)) return;
      expect(fetched.value?.tone).toEqual(["direct", "specific"]);
    });

    it("denies positioning and brand voice reads across workspaces", () => {
      const store = seed();
      const ownerA = makeOwner(store, "a@example.com");
      const ownerB = makeOwner(store, "b@example.com");
      const workspaceA = makeWorkspace(store, ownerA.id, "Workspace A");
      store.upsertPositioning(workspaceA, ownerA.id, { statement: "A statement" });
      store.upsertBrandVoice(workspaceA, ownerA.id, { tone: ["calm"] });

      const positioning = store.getPositioning(workspaceA, ownerB.id);
      const voice = store.getBrandVoice(workspaceA, ownerB.id);
      expect(isErr(positioning)).toBe(true);
      expect(isErr(voice)).toBe(true);
      if (isErr(positioning)) expect(positioning.error.code).toBe("UNAUTHORIZED");
      if (isErr(voice)) expect(voice.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("claims safety", () => {
    function claimFixture(): { store: Store; owner: User; workspaceId: string } {
      const store = seed();
      const owner = makeOwner(store);
      const workspaceId = makeWorkspace(store, owner.id, "Acme");
      return { store, owner, workspaceId };
    }

    it("never creates a claim as approved", () => {
      const { store, owner, workspaceId } = claimFixture();
      const created = store.createClaim({
        workspaceId,
        userId: owner.id,
        text: "We doubled response time for 40 clients",
        category: "result",
        status: "approved",
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;
      expect(created.value.status).toBe("unverified");
      expect(created.value.approvedBy).toBeNull();
      expect(created.value.approvedAt).toBeNull();
    });

    it("approves a claim through an explicit attributed action", () => {
      const { store, owner, workspaceId } = claimFixture();
      const created = store.createClaim({
        workspaceId,
        userId: owner.id,
        text: "SOC 2 Type II certified",
        category: "certification",
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;

      const approved = store.approveClaim(created.value.id, owner.id);
      expect(isOk(approved)).toBe(true);
      if (!isOk(approved)) return;
      expect(approved.value.status).toBe("approved");
      expect(approved.value.approvedBy).toBe(owner.id);
      expect(approved.value.approvedAt).not.toBeNull();
    });

    it("revokes approval when the claim wording changes", () => {
      const { store, owner, workspaceId } = claimFixture();
      const created = store.createClaim({
        workspaceId,
        userId: owner.id,
        text: "Trusted by 40 clients",
        category: "result",
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;
      expect(isOk(store.approveClaim(created.value.id, owner.id))).toBe(true);

      const edited = store.updateClaim(created.value.id, {
        userId: owner.id,
        text: "Trusted by 4000 clients",
      });
      expect(isOk(edited)).toBe(true);
      if (!isOk(edited)) return;
      expect(edited.value.status).toBe("unverified");
      expect(edited.value.approvedBy).toBeNull();
      expect(edited.value.approvedAt).toBeNull();
    });

    it("refuses to set approved through a generic update", () => {
      const { store, owner, workspaceId } = claimFixture();
      const created = store.createClaim({
        workspaceId,
        userId: owner.id,
        text: "A claim",
        category: "other",
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;

      const attempted = store.updateClaim(created.value.id, {
        userId: owner.id,
        status: "approved",
      });
      expect(isOk(attempted)).toBe(true);
      if (!isOk(attempted)) return;
      expect(attempted.value.status).toBe("unverified");
    });

    it("filters claims by status", () => {
      const { store, owner, workspaceId } = claimFixture();
      const approved = store.createClaim({
        workspaceId,
        userId: owner.id,
        text: "Approved claim",
        category: "capability",
      });
      expect(isOk(approved)).toBe(true);
      if (!isOk(approved)) return;
      store.approveClaim(approved.value.id, owner.id);
      store.createClaim({
        workspaceId,
        userId: owner.id,
        text: "Restricted claim",
        category: "guarantee",
        status: "restricted",
      });

      const restricted: Claim[] = [];
      const filtered = store.listClaims(workspaceId, owner.id, { status: "approved" });
      expect(isOk(filtered)).toBe(true);
      if (isOk(filtered)) restricted.push(...filtered.value);
      expect(restricted).toHaveLength(1);
      expect(restricted[0]?.status).toBe("approved");
    });

    it("denies claim access across workspaces", () => {
      const store = seed();
      const ownerA = makeOwner(store, "a@example.com");
      const ownerB = makeOwner(store, "b@example.com");
      const workspaceA = makeWorkspace(store, ownerA.id, "Workspace A");
      const created = store.createClaim({
        workspaceId: workspaceA,
        userId: ownerA.id,
        text: "Private claim",
        category: "other",
      });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;

      const denied = store.listClaims(workspaceA, ownerB.id);
      expect(isErr(denied)).toBe(true);
      if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");

      const deniedGet = store.getClaim(created.value.id, ownerB.id);
      expect(isErr(deniedGet)).toBe(true);
      if (isErr(deniedGet)) expect(deniedGet.error.code).toBe("UNAUTHORIZED");
    });
  });
});

describe("Phase 1 -> Phase 2 migration", () => {
  it("upgrades a Phase 1 document without losing data", () => {
    const legacy: DbState = {
      users: [
        {
          id: "u1",
          email: "legacy@example.com",
          passwordHash: "salt:hash",
          displayName: "Legacy",
          role: "owner" as const,
          createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
          updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        },
      ],
      workspaces: [
        {
          id: "w1",
          ownerId: "u1",
          name: "Legacy Co",
          slug: "legacy-co",
          logoUrl: null,
          timezone: "UTC",
          settings: {},
          createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
          updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        },
      ],
      members: [],
      profiles: [
        {
          id: "p1",
          workspaceId: "w1",
          ownerId: "u1",
          name: "Legacy Co",
          description: "Existing business",
          website: null,
          type: null,
          offer: null,
          industry: null,
          size: null,
          // A Phase 1 row predates the `market` column entirely.
          market: undefined as unknown as null,
          createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
          updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        },
      ],
    };

    const migrated = migrateState(legacy);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    // Existing Phase 1 data survives untouched.
    expect(migrated.users).toHaveLength(1);
    expect(migrated.workspaces).toHaveLength(1);
    expect(migrated.profiles).toHaveLength(1);
    expect(migrated.profiles[0]?.name).toBe("Legacy Co");
    // The Phase 2 column defaults without rewriting the stored value.
    expect(migrated.profiles[0]?.market).toBeNull();
    // Phase 2 tables exist and are empty.
    expect(migrated.offers).toEqual([]);
    expect(migrated.icps).toEqual([]);
    expect(migrated.personas).toEqual([]);
    expect(migrated.positioning).toEqual([]);
    expect(migrated.brandVoices).toEqual([]);
    expect(migrated.claims).toEqual([]);
    // Phase 3 tables are added by the same additive migration.
    expect(migrated.revenueGoals).toEqual([]);
    expect(migrated.revenueGoalEvents).toEqual([]);
  });

  it("preserves Phase 2 data when migrating a v2 document to v3", () => {
    const v2 = emptyState();
    v2.schemaVersion = 2;
    v2.claims = [
      {
        id: "c-keep",
        workspaceId: "w1",
        text: "Preserved across the Phase 3 migration",
        category: "other",
        status: "approved",
        sourceNote: null,
        approvedBy: "u1",
        approvedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
      },
    ];

    const migrated = migrateState(v2);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.claims).toHaveLength(1);
    expect(migrated.claims[0]?.text).toBe("Preserved across the Phase 3 migration");
    expect(migrated.claims[0]?.approvedBy).toBe("u1");
    expect(migrated.revenueGoals).toEqual([]);
  });

  it("keeps Phase 3 goal rows across a repeat migration", () => {
    const state = emptyState();
    state.revenueGoals = [
      {
        id: "g1",
        workspaceId: "w1",
        createdBy: "u1",
        objective: "Generate pipeline",
        targetMetric: "pipeline",
        targetValue: 100000,
        currency: "USD",
        timeWindow: { start: "2026-01-01", end: "2026-04-01" },
        market: "B2B SaaS",
        icpId: null,
        buyerPersonaIds: [],
        offerId: null,
        economics: {
          averageDealValue: null,
          minimumContractValue: null,
          targetCustomers: null,
          currency: null,
        },
        constraints: {
          geographies: [],
          industries: [],
          companySizes: [],
          channels: [],
          budget: null,
          maxOutreachPerDay: null,
          notes: null,
        },
        approvalPolicy: {
          maxRiskLevel: "level_2_external_action",
          externalActionsRequireApproval: true,
          approverUserId: null,
        },
        successMetrics: [{ kind: "pipeline", target: 100000, unit: "USD" }],
        status: "draft",
        completeness: "complete",
        unknowns: [],
        assumptions: [],
        createdAt: toDateTime(new Date()),
        updatedAt: toDateTime(new Date()),
      },
    ];

    const migrated = migrateState(state);
    expect(migrated.revenueGoals).toHaveLength(1);
    expect(migrated.revenueGoals[0]?.objective).toBe("Generate pipeline");
    expect(migrated.revenueGoals[0]?.targetValue).toBe(100000);
  });

  it("keeps Phase 2 rows when re-migrating an upgraded document", () => {
    const state = emptyState();
    state.claims = [
      {
        id: "c1",
        workspaceId: "w1",
        text: "Kept",
        category: "other",
        status: "unverified",
        sourceNote: null,
        approvedBy: null,
        approvedAt: null,
        createdAt: toDateTime(new Date()),
        updatedAt: toDateTime(new Date()),
      },
    ];

    const migrated = migrateState(state);
    expect(migrated.claims).toHaveLength(1);
    expect(migrated.claims[0]?.text).toBe("Kept");
  });
});

describe("revenue goal history", () => {
  /**
   * Events written in the same millisecond share a `createdAt`. An audit log
   * must still read chronologically in that case: ordering by the random id
   * would make the history non-deterministic.
   */
  it("keeps same-millisecond events in chronological order", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "History Co");

    const created = store.createRevenueGoal({
      workspaceId,
      createdBy: owner.id,
      goal: {
        objective: "Book revenue",
        targetMetric: "revenue",
        targetValue: 1000,
        currency: "USD",
        timeWindow: { start: "2026-03-01", end: "2026-06-01" },
        market: "B2B SaaS",
        icpId: null,
        buyerPersonaIds: [],
        offerId: null,
        economics: {
          averageDealValue: null,
          minimumContractValue: null,
          targetCustomers: null,
          currency: "USD",
        },
        constraints: {
          geographies: [],
          industries: [],
          companySizes: [],
          channels: [],
          budget: null,
          maxOutreachPerDay: null,
          notes: null,
        },
        approvalPolicy: {
          maxRiskLevel: "level_2_external_action",
          externalActionsRequireApproval: true,
          approverUserId: null,
        },
        successMetrics: [{ kind: "revenue", target: 1000, unit: "USD" }],
        status: "draft",
        completeness: "complete",
        unknowns: [],
        assumptions: [],
      },
    });
    if (!isOk(created)) throw new Error("goal creation failed");

    // Written back-to-back, so several events share a timestamp.
    store.setRevenueGoalStatus(created.value.id, owner.id, "active");
    store.setRevenueGoalStatus(created.value.id, owner.id, "paused");
    store.setRevenueGoalStatus(created.value.id, owner.id, "active");
    store.setRevenueGoalStatus(created.value.id, owner.id, "completed");
    store.setRevenueGoalStatus(created.value.id, owner.id, "archived");

    const expected = ["draft", "active", "paused", "active", "completed", "archived"];
    for (let attempt = 0; attempt < 25; attempt++) {
      const events = store.listRevenueGoalEvents(created.value.id, owner.id);
      if (!isOk(events)) throw new Error("history read failed");
      expect(events.value.map((e) => e.toStatus)).toEqual(expected);
    }

    // The order survives a reload from the persisted document.
    const reloaded = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const afterReload = reloaded.listRevenueGoalEvents(created.value.id, owner.id);
    if (!isOk(afterReload)) throw new Error("history read failed");
    expect(afterReload.value.map((e) => e.toStatus)).toEqual(expected);
  });
});
