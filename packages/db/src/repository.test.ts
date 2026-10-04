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
import type {
  Claim,
  Evidence,
  Qualification,
  ResearchFinding,
  RevenueGoal,
  RevenuePlan,
  User,
} from "./types.js";

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

/** A minimal valid goal row for migration fixtures. */
function seedGoal(
  _state: DbState,
  id: string,
  workspaceId: string,
  createdBy: string,
): RevenueGoal {
  return {
    id,
    workspaceId,
    createdBy,
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
    successMetrics: [{ kind: "pipeline", target: 100000, unit: "USD" }],
    status: "draft",
    completeness: "complete",
    unknowns: [],
    assumptions: [],
    createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
    updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
  };
}

/** A minimal valid plan row for migration fixtures. */
function seedPlan(
  _state: DbState,
  id: string,
  revenueGoalId: string,
  workspaceId: string,
  createdBy: string,
  version: number,
): RevenuePlan {
  return {
    id,
    workspaceId,
    createdBy,
    revenueGoalId,
    version,
    compilerVersion: "deterministic-1.0.0",
    brainSnapshotDigest: "digest-1",
    references: { offerId: null, icpId: null, personaIds: [] },
    strategies: {
      icp: {
        targetMarket: "B2B SaaS",
        industries: [],
        companySizes: [],
        geographies: [],
        characteristics: [],
        disqualifiers: [],
        statements: [],
      },
      buyer: { personas: [], statements: [] },
      sourcing: { accountProfile: "", approach: [], constraints: [], statements: [] },
      signal: { signals: [], excludedSources: [], statements: [] },
      qualification: { criteria: [], statements: [] },
      outreach: {
        channels: [],
        messagingAngles: [],
        valueProposition: null,
        personalizationPrinciple: null,
        frequencyCap: null,
        stopPrinciples: [],
        approvalRequired: true,
        statements: [],
      },
      followUp: {
        principles: [],
        responseStates: [],
        stopConditions: [],
        escalationConditions: [],
        statements: [],
      },
      meeting: { objective: null, qualificationPurpose: "", preparation: [], statements: [] },
      crm: { recordFields: [], prohibitedWrites: [], statements: [] },
      measurement: { kpis: [], reviewCadence: null, statements: [] },
      optimization: { levers: [], guardrails: [], statements: [] },
    },
    facts: [],
    inferences: [],
    assumptions: [],
    recommendations: [],
    unknowns: [],
    approval: {
      approvesExternalActions: false,
      requiredFor: ["level_2_external_action"],
      statements: [],
    },
    status: "proposed",
    rationale: "Seeded plan",
    createdAt: toDateTime(new Date("2026-02-01T00:00:00.000Z")),
    updatedAt: toDateTime(new Date("2026-02-01T00:00:00.000Z")),
  };
}

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
    // Phase 4 table is added by the same additive migration.
    expect(migrated.revenuePlans).toEqual([]);
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
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.claims).toHaveLength(1);
    expect(migrated.claims[0]?.text).toBe("Preserved across the Phase 3 migration");
    expect(migrated.claims[0]?.approvedBy).toBe("u1");
    expect(migrated.revenueGoals).toEqual([]);
    // The Phase 4 table is additive: an older document gains it empty.
    expect(migrated.revenuePlans).toEqual([]);
  });

  it("preserves Phase 3 goals when migrating a v3 document to v4", () => {
    const v3 = emptyState();
    v3.schemaVersion = 3;
    const state = structuredClone(v3);
    const goal = seedGoal(state, "goal-keep", "w1", "u1");
    v3.revenueGoals = [goal];

    const migrated = migrateState(v3);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.revenueGoals).toHaveLength(1);
    expect(migrated.revenueGoals[0]?.id).toBe("goal-keep");
    expect(migrated.revenueGoals[0]?.objective).toBe(goal.objective);
    expect(migrated.revenueGoalEvents).toEqual([]);
    expect(migrated.revenuePlans).toEqual([]);
  });

  it("keeps Phase 4 plan rows across a repeat migration", () => {
    const state = emptyState();
    state.revenuePlans = [seedPlan(state, "plan-1", "goal-keep", "w1", "u1", 1)];

    const migrated = migrateState(state);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.revenuePlans).toHaveLength(1);
    expect(migrated.revenuePlans[0]?.id).toBe("plan-1");
    expect(migrated.revenuePlans[0]?.version).toBe(1);
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

describe("accounts and contacts", () => {
  const accountSeed = (
    store: Store,
    workspaceId: string,
    userId: string,
    overrides: Partial<{
      name: string;
      domain: string | null;
      revenuePlanId: string | null;
      source: "manual" | "csv" | "approved_integration";
      sourceReference: string | null;
    }> = {},
  ) => {
    const created = store.createAccount({
      workspaceId,
      createdBy: userId,
      account: {
        name: overrides.name ?? "Northwind Trading",
        website: null,
        domain: overrides.domain === undefined ? "northwind.example" : overrides.domain,
        industry: null,
        companySize: null,
        geography: null,
        description: null,
        source: overrides.source ?? "manual",
        sourceReference: overrides.sourceReference ?? null,
        revenuePlanId: overrides.revenuePlanId ?? null,
        status: "active",
      },
    });
    if (!isOk(created)) throw new Error("seed account creation failed");
    return created.value;
  };

  it("stores an account and a contact with their provenance", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Accounts Co");

    const account = accountSeed(store, workspaceId, owner.id, {
      source: "csv",
      sourceReference: "q1-target-list.csv",
    });
    expect(account.workspaceId).toBe(workspaceId);
    expect(account.createdBy).toBe(owner.id);
    expect(account.source).toBe("csv");
    expect(account.status).toBe("active");

    const contact = store.createContact({
      workspaceId,
      createdBy: owner.id,
      contact: {
        accountId: account.id,
        firstName: "Ada",
        lastName: "Wong",
        fullName: "Ada Wong",
        jobTitle: "VP Revenue",
        email: "ada@northwind.example",
        phone: null,
        profileUrl: null,
        source: "csv",
        sourceReference: "people.csv",
        status: "active",
      },
    });
    if (!isOk(contact)) throw new Error("contact creation failed");
    expect(contact.value.accountId).toBe(account.id);

    const listed = store.listContacts(workspaceId, owner.id, { accountId: account.id });
    if (!isOk(listed)) throw new Error("contact listing failed");
    expect(listed.value.map((c) => c.fullName)).toEqual(["Ada Wong"]);
  });

  it("archives an account together with its contacts, without deleting rows", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Archive Co");
    const account = accountSeed(store, workspaceId, owner.id);

    for (const email of ["a@archive.example", "b@archive.example"]) {
      const contact = store.createContact({
        workspaceId,
        createdBy: owner.id,
        contact: {
          accountId: account.id,
          firstName: null,
          lastName: null,
          fullName: "",
          jobTitle: null,
          email,
          phone: null,
          profileUrl: null,
          source: "manual",
          sourceReference: null,
          status: "active",
        },
      });
      if (!isOk(contact)) throw new Error("contact creation failed");
    }

    const archived = store.archiveAccount(account.id, owner.id);
    if (!isOk(archived)) throw new Error("archive failed");
    expect(archived.value.status).toBe("archived");

    // Nothing is hard-deleted: both rows survive in archived state.
    expect(store.db.contacts).toHaveLength(2);
    expect(store.db.contacts?.every((c) => c.status === "archived")).toBe(true);

    const active = store.listAccounts(workspaceId, owner.id, { status: "active" });
    if (!isOk(active)) throw new Error("listing failed");
    expect(active.value).toEqual([]);
    const all = store.listAccounts(workspaceId, owner.id);
    if (!isOk(all)) throw new Error("listing failed");
    expect(all.value).toHaveLength(1);
  });

  it("keeps tenants apart and refuses a contact on another workspace's account", () => {
    const store = seed();
    const ownerA = makeOwner(store, "tenant-a@example.com");
    const ownerB = makeOwner(store, "tenant-b@example.com");
    const workspaceA = makeWorkspace(store, ownerA.id, "Tenant A");
    const workspaceB = makeWorkspace(store, ownerB.id, "Tenant B");

    const account = accountSeed(store, workspaceA, ownerA.id);

    const foreignRead = store.getAccount(account.id, ownerB.id);
    expect(isErr(foreignRead)).toBe(true);
    if (isErr(foreignRead)) expect(foreignRead.error.code).toBe("UNAUTHORIZED");

    const crossWorkspace = store.createContact({
      workspaceId: workspaceB,
      createdBy: ownerB.id,
      contact: {
        accountId: account.id,
        firstName: "Mallory",
        lastName: "Malice",
        fullName: "Mallory Malice",
        jobTitle: null,
        email: "mallory@evil.example",
        phone: null,
        profileUrl: null,
        source: "manual",
        sourceReference: null,
        status: "active",
      },
    });
    expect(isErr(crossWorkspace)).toBe(true);
    if (isErr(crossWorkspace)) expect(crossWorkspace.error.code).toBe("INVALID");
    expect(store.db.contacts).toHaveLength(0);

    // Domain lookup never crosses the tenant boundary: B's own lookup finds
    // nothing, and A's lookup still sees only A's row.
    const fromB = store.findAccountByDomain(workspaceB, ownerB.id, "northwind.example");
    if (!isOk(fromB)) throw new Error("domain lookup failed");
    expect(fromB.value).toBeNull();
    const fromA = store.findAccountByDomain(workspaceA, ownerA.id, "northwind.example");
    if (!isOk(fromA)) throw new Error("domain lookup failed");
    expect(fromA.value?.id).toBe(account.id);
  });

  it("preserves Phase 4 data when migrating a v4 document to v5", () => {
    const v4 = emptyState();
    v4.schemaVersion = 4;
    v4.revenueGoals = [seedGoal(v4, "goal-keep", "w1", "u1")];
    v4.revenuePlans = [seedPlan(v4, "plan-keep", "goal-keep", "w1", "u1", 1)];

    const migrated = migrateState(v4);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.revenueGoals).toHaveLength(1);
    expect(migrated.revenuePlans).toHaveLength(1);
    expect(migrated.revenuePlans[0]?.id).toBe("plan-keep");
    // The Phase 5 tables are additive: an older document gains them empty.
    expect(migrated.accounts).toEqual([]);
    expect(migrated.contacts).toEqual([]);
  });

  it("keeps Phase 5 rows across a repeat migration", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Migration Co");
    accountSeed(store, workspaceId, owner.id, { source: "csv", sourceReference: "list.csv" });

    const migrated = migrateState(store.db);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.accounts).toHaveLength(1);
    expect(migrated.accounts[0]?.source).toBe("csv");
    expect(migrated.accounts[0]?.sourceReference).toBe("list.csv");
    expect(migrated.accounts[0]?.domain).toBe("northwind.example");
    expect(migrated.accounts[0]?.status).toBe("active");
    expect(migrated.contacts).toEqual([]);
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

describe("research requests and findings", () => {
  const researchAccount = (store: Store, workspaceId: string, userId: string) => {
    const created = store.createAccount({
      workspaceId,
      createdBy: userId,
      account: {
        name: "Northwind Trading",
        website: "https://northwind.example",
        domain: "northwind.example",
        industry: "Wholesale",
        companySize: "120",
        geography: "UK",
        description: null,
        source: "manual",
        sourceReference: "q1-list.csv",
        revenuePlanId: null,
        status: "active",
      },
    });
    if (!isOk(created)) throw new Error("seed account creation failed");
    return created.value;
  };

  const findingInput = (
    overrides: Partial<{
      field: string;
      value: string;
      sourceUrl: string | null;
      observedAt: string | null;
      freshness: ResearchFinding["freshness"];
      claimKind: ResearchFinding["claimKind"];
    }> = {},
  ) => ({
    category: "company_overview" as const,
    field: overrides.field ?? "website",
    value: overrides.value ?? "https://northwind.example",
    claimKind: overrides.claimKind ?? ("fact" as const),
    source: "account_record" as const,
    sourceName: "account_record",
    sourceUrl:
      overrides.sourceUrl === undefined ? "https://northwind.example" : overrides.sourceUrl,
    sourceTitle: "workspace account record",
    observedAt: overrides.observedAt === undefined ? null : overrides.observedAt,
    retrievedAt: "2026-10-01T00:00:00.000Z",
    confidence: "medium" as const,
    freshness: overrides.freshness ?? ("unknown" as const),
    relevance: "high" as const,
    note: null,
    status: "recorded" as const,
  });

  it("stores a request and its findings with their provenance", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Research Co");
    const account = researchAccount(store, workspaceId, owner.id);

    const request = store.createResearchRequest({
      workspaceId,
      requestedBy: owner.id,
      accountId: account.id,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isOk(request)) throw new Error("research request creation failed");
    expect(request.value.status).toBe("pending");
    expect(request.value.workspaceId).toBe(workspaceId);
    expect(request.value.findingCount).toBe(0);
    expect(request.value.failureCode).toBeNull();
    expect(request.value.startedAt).toBeNull();

    const finding = store.createResearchFinding({
      researchRequestId: request.value.id,
      createdBy: owner.id,
      finding: findingInput(),
    });
    if (!isOk(finding)) throw new Error("research finding creation failed");
    // The finding inherits its tenant boundary from the request.
    expect(finding.value.workspaceId).toBe(workspaceId);
    expect(finding.value.accountId).toBe(account.id);
    expect(finding.value.sourceUrl).toBe("https://northwind.example");
    expect(finding.value.retrievedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(finding.value.status).toBe("recorded");

    const listed = store.listResearchFindings(workspaceId, owner.id, {
      researchRequestId: request.value.id,
    });
    if (!isOk(listed)) throw new Error("research finding listing failed");
    expect(listed.value).toHaveLength(1);
    const counted = store.countResearchFindings(request.value.id, owner.id);
    if (!isOk(counted)) throw new Error("research finding count failed");
    expect(counted.value).toBe(1);
  });

  it("refuses to research an account from another workspace", () => {
    const store = seed();
    const ownerA = makeOwner(store, "a@example.com");
    const ownerB = makeOwner(store, "b@example.com");
    const workspaceA = makeWorkspace(store, ownerA.id, "Research A");
    const workspaceB = makeWorkspace(store, ownerB.id, "Research B");
    const account = researchAccount(store, workspaceA, ownerA.id);

    const crossWorkspace = store.createResearchRequest({
      workspaceId: workspaceB,
      requestedBy: ownerB.id,
      accountId: account.id,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isErr(crossWorkspace)) throw new Error("cross-workspace research was allowed");
    expect(crossWorkspace.error.code).toBe("INVALID");
    expect(store.db.researchRequests).toHaveLength(0);
  });

  it("keeps findings and requests inside their own tenant", () => {
    const store = seed();
    const ownerA = makeOwner(store, "a@example.com");
    const ownerB = makeOwner(store, "b@example.com");
    const workspaceA = makeWorkspace(store, ownerA.id, "Tenant A");
    const workspaceB = makeWorkspace(store, ownerB.id, "Tenant B");
    const account = researchAccount(store, workspaceA, ownerA.id);

    const request = store.createResearchRequest({
      workspaceId: workspaceA,
      requestedBy: ownerA.id,
      accountId: account.id,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isOk(request)) throw new Error("research request creation failed");
    store.createResearchFinding({
      researchRequestId: request.value.id,
      createdBy: ownerA.id,
      finding: findingInput(),
    });

    // B cannot read, run, or discover the request by guessing ids.
    expect(isErr(store.getResearchRequest(request.value.id, ownerB.id))).toBe(true);
    const bList = store.listResearchRequests(workspaceB, ownerB.id);
    if (!isOk(bList)) throw new Error("research listing failed");
    expect(bList.value).toEqual([]);
    const bFindings = store.listResearchFindings(workspaceB, ownerB.id);
    if (!isOk(bFindings)) throw new Error("research findings listing failed");
    expect(bFindings.value).toEqual([]);
    const bActive = store.findActiveResearchRequest(
      workspaceB,
      ownerB.id,
      account.id,
      "account_record",
    );
    if (!isOk(bActive)) throw new Error("active research lookup failed");
    expect(bActive.value).toBeNull();

    // A still sees exactly its own row.
    const aFindings = store.listResearchFindings(workspaceA, ownerA.id, {
      accountId: account.id,
    });
    if (!isOk(aFindings)) throw new Error("research findings listing failed");
    expect(aFindings.value).toHaveLength(1);
  });

  it("reports one active request per account and provider", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Active Research Co");
    const account = researchAccount(store, workspaceId, owner.id);

    const first = store.createResearchRequest({
      workspaceId,
      requestedBy: owner.id,
      accountId: account.id,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isOk(first)) throw new Error("research request creation failed");

    const active = store.findActiveResearchRequest(
      workspaceId,
      owner.id,
      account.id,
      "account_record",
    );
    if (!isOk(active)) throw new Error("active research lookup failed");
    expect(active.value?.id).toBe(first.value.id);

    // Running still occupies the slot.
    store.updateResearchRequest(first.value.id, { userId: owner.id, status: "running" });
    const whileRunning = store.findActiveResearchRequest(
      workspaceId,
      owner.id,
      account.id,
      "account_record",
    );
    if (!isOk(whileRunning)) throw new Error("active research lookup failed");
    expect(whileRunning.value?.id).toBe(first.value.id);

    // A finished request frees the slot for a later refresh.
    store.updateResearchRequest(first.value.id, {
      userId: owner.id,
      status: "completed",
      completedAt: "2026-10-01T00:00:00.000Z",
      findingCount: 1,
    });
    const afterCompletion = store.findActiveResearchRequest(
      workspaceId,
      owner.id,
      account.id,
      "account_record",
    );
    if (!isOk(afterCompletion)) throw new Error("active research lookup failed");
    expect(afterCompletion.value).toBeNull();
  });

  it("finds a request by its idempotency key within the workspace", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Idempotency Co");
    const account = researchAccount(store, workspaceId, owner.id);

    const created = store.createResearchRequest({
      workspaceId,
      requestedBy: owner.id,
      accountId: account.id,
      provider: "account_record",
      categories: ["company_overview"],
      idempotencyKey: "q1-refresh",
    });
    if (!isOk(created)) throw new Error("research request creation failed");

    const found = store.findResearchRequestByIdempotencyKey(workspaceId, owner.id, "q1-refresh");
    if (!isOk(found)) throw new Error("idempotency lookup failed");
    expect(found.value?.id).toBe(created.value.id);

    const missing = store.findResearchRequestByIdempotencyKey(workspaceId, owner.id, "other");
    if (!isOk(missing)) throw new Error("idempotency lookup failed");
    expect(missing.value).toBeNull();
  });

  it("records a failed run's reason and completion timestamp", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Failure Co");
    const account = researchAccount(store, workspaceId, owner.id);

    const request = store.createResearchRequest({
      workspaceId,
      requestedBy: owner.id,
      accountId: account.id,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isOk(request)) throw new Error("research request creation failed");

    const failed = store.updateResearchRequest(request.value.id, {
      userId: owner.id,
      status: "failed",
      startedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T00:00:05.000Z",
      failureCode: "provider_unavailable",
      failureMessage: "the research source is not available right now",
    });
    if (!isOk(failed)) throw new Error("research request update failed");
    expect(failed.value.status).toBe("failed");
    expect(failed.value.failureCode).toBe("provider_unavailable");
    expect(failed.value.completedAt).toBe("2026-10-01T00:00:05.000Z");
  });

  it("preserves Phase 5 data when migrating a v5 document to v6", () => {
    const v5 = emptyState();
    v5.schemaVersion = 5;
    const store = new Store(v5);
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "V5 Research Co");
    const account = researchAccount(store, workspaceId, owner.id);

    const migrated = migrateState(JSON.parse(JSON.stringify(store.db)) as never);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    // Phase 5 rows survive untouched.
    expect(migrated.accounts).toHaveLength(1);
    expect(migrated.accounts[0]?.id).toBe(account.id);
    expect(migrated.accounts[0]?.sourceReference).toBe("q1-list.csv");
    expect(migrated.contacts).toEqual([]);
    // The Phase 6 tables are additive: an older document gains them empty.
    expect(migrated.researchRequests).toEqual([]);
    expect(migrated.researchFindings).toEqual([]);
  });

  it("keeps Phase 6 rows across a repeat migration", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Repeat Research Co");
    const account = researchAccount(store, workspaceId, owner.id);
    const request = store.createResearchRequest({
      workspaceId,
      requestedBy: owner.id,
      accountId: account.id,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isOk(request)) throw new Error("research request creation failed");
    store.createResearchFinding({
      researchRequestId: request.value.id,
      createdBy: owner.id,
      finding: findingInput({ sourceUrl: null }),
    });

    const migrated = migrateState(JSON.parse(JSON.stringify(store.db)) as never);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.researchRequests).toHaveLength(1);
    expect(migrated.researchFindings).toHaveLength(1);
    // Provenance is preserved exactly, including an absent source URL: a
    // citation that was never supplied must not appear after a migration.
    expect(migrated.researchFindings[0]?.sourceUrl).toBeNull();
    expect(migrated.researchFindings[0]?.source).toBe("account_record");
    expect(migrated.researchFindings[0]?.observedAt).toBeNull();
  });
});

describe("account claims and evidence", () => {
  const evidenceAccount = (store: Store, workspaceId: string, userId: string, name: string) => {
    const created = store.createAccount({
      workspaceId,
      createdBy: userId,
      account: {
        name,
        website: "https://northwind.example",
        domain: "northwind.example",
        industry: "Wholesale",
        companySize: "120",
        geography: "UK",
        description: null,
        source: "manual",
        sourceReference: "q1-list.csv",
        revenuePlanId: null,
        status: "active",
      },
    });
    if (!isOk(created)) throw new Error("seed account creation failed");
    return created.value;
  };

  const seedFinding = (store: Store, workspaceId: string, userId: string, accountId: string) => {
    const request = store.createResearchRequest({
      workspaceId,
      requestedBy: userId,
      accountId,
      provider: "account_record",
      categories: ["company_overview"],
    });
    if (!isOk(request)) throw new Error("seed research request failed");
    const finding = store.createResearchFinding({
      researchRequestId: request.value.id,
      createdBy: userId,
      finding: {
        category: "company_overview",
        field: "website",
        value: "https://northwind.example",
        claimKind: "fact",
        source: "account_record",
        sourceName: "account_record",
        sourceUrl: "https://northwind.example",
        sourceTitle: "workspace account record",
        observedAt: null,
        retrievedAt: "2026-10-01T00:00:00.000Z",
        confidence: "medium",
        freshness: "unknown",
        relevance: "high",
        note: null,
        status: "recorded",
      },
    });
    if (!isOk(finding)) throw new Error("seed research finding failed");
    return finding.value;
  };

  const evidenceInput = (
    overrides: Partial<{
      value: string;
      confidence: Evidence["confidence"];
      freshness: Evidence["freshness"];
      relevance: Evidence["relevance"];
      status: Evidence["status"];
    }> = {},
  ) => ({
    researchFindingId: null,
    provenance: "user_supplied" as const,
    source: "account_record" as const,
    sourceName: "account_record",
    sourceUrl: null,
    sourceTitle: null,
    observedAt: null,
    retrievedAt: "2026-10-02T00:00:00.000Z",
    confidence: overrides.confidence ?? ("medium" as const),
    freshness: overrides.freshness ?? ("unknown" as const),
    relevance: overrides.relevance ?? ("high" as const),
    note: null,
    status: overrides.status ?? ("recorded" as const),
  });

  it("stores a claim and evidence with full provenance and survives a reload", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Evidence Co");
    const account = evidenceAccount(store, workspaceId, owner.id, "Northwind Trading");

    const claim = store.createAccountClaim({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      category: "company_overview",
      field: "website",
      value: "https://northwind.example",
      claimKind: "fact",
    });
    if (!isOk(claim)) throw new Error("claim creation failed");
    expect(claim.value.status).toBe("asserted");
    expect(claim.value.workspaceId).toBe(workspaceId);
    expect(claim.value.accountId).toBe(account.id);

    const evidence = store.createEvidence({
      workspaceId,
      accountClaimId: claim.value.id,
      evidence: evidenceInput({ confidence: "high", freshness: "fresh", relevance: "high" }),
    });
    if (!isOk(evidence)) throw new Error("evidence creation failed");
    // The evidence inherits its tenant boundary from the claim.
    expect(evidence.value.workspaceId).toBe(workspaceId);
    expect(evidence.value.accountId).toBe(account.id);
    expect(evidence.value.accountClaimId).toBe(claim.value.id);
    expect(evidence.value.sourceUrl).toBeNull();
    expect(evidence.value.status).toBe("recorded");

    const reloaded = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const found = reloaded.getEvidence(evidence.value.id, owner.id);
    if (!isOk(found)) throw new Error("evidence read after reload failed");
    expect(found.value.confidence).toBe("high");
    expect(found.value.freshness).toBe("fresh");
    expect(found.value.retrievedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(found.value.provenance).toBe("user_supplied");
  });

  it("resolves the same claim for the same account field", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Evidence Lookup Co");
    const account = evidenceAccount(store, workspaceId, owner.id, "Lookup Trading");
    const claim = store.createAccountClaim({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      category: "company_overview",
      field: "website",
      value: "https://northwind.example",
      claimKind: "fact",
    });
    if (!isOk(claim)) throw new Error("claim creation failed");

    const found = store.findAccountClaimByField(
      workspaceId,
      owner.id,
      account.id,
      "company_overview",
      "website",
    );
    if (!isOk(found)) throw new Error("claim lookup failed");
    expect(found.value?.id).toBe(claim.value.id);

    const missing = store.findAccountClaimByField(
      workspaceId,
      owner.id,
      account.id,
      "company_overview",
      "hiring",
    );
    if (!isOk(missing)) throw new Error("claim lookup failed");
    expect(missing.value).toBeNull();
  });

  it("keeps claims and evidence inside their own tenant", () => {
    const store = seed();
    const ownerA = makeOwner(store, "a@example.com");
    const ownerB = makeOwner(store, "b@example.com");
    const workspaceA = makeWorkspace(store, ownerA.id, "Tenant Evidence A");
    const workspaceB = makeWorkspace(store, ownerB.id, "Tenant Evidence B");
    const accountA = evidenceAccount(store, workspaceA, ownerA.id, "Confidential Trading");
    const claim = store.createAccountClaim({
      workspaceId: workspaceA,
      createdBy: ownerA.id,
      accountId: accountA.id,
      category: "company_overview",
      field: "website",
      value: "https://confidential.example",
      claimKind: "fact",
    });
    if (!isOk(claim)) throw new Error("claim creation failed");
    const evidence = store.createEvidence({
      workspaceId: workspaceA,
      accountClaimId: claim.value.id,
      evidence: evidenceInput(),
    });
    if (!isOk(evidence)) throw new Error("evidence creation failed");

    // Another tenant reads neither record, and the error never reveals why.
    const foreignClaim = store.getAccountClaim(claim.value.id, ownerB.id);
    if (!isErr(foreignClaim)) throw new Error("cross-tenant claim read was allowed");
    expect(foreignClaim.error.code).toBe("UNAUTHORIZED");
    const foreignEvidence = store.getEvidence(evidence.value.id, ownerB.id);
    if (!isErr(foreignEvidence)) throw new Error("cross-tenant evidence read was allowed");
    expect(foreignEvidence.error.code).toBe("UNAUTHORIZED");
    expect(store.listEvidence(workspaceB, ownerB.id)).toEqual({ ok: true, value: [] });
    expect(store.listAccountClaims(workspaceB, ownerB.id)).toEqual({ ok: true, value: [] });
  });

  it("refuses to write a claim against another workspace's account", () => {
    const store = seed();
    const ownerA = makeOwner(store, "a@example.com");
    const ownerB = makeOwner(store, "b@example.com");
    const workspaceA = makeWorkspace(store, ownerA.id, "Claim Tenant A");
    const workspaceB = makeWorkspace(store, ownerB.id, "Claim Tenant B");
    const accountA = evidenceAccount(store, workspaceA, ownerA.id, "Cross Tenant Trading");

    const crossWorkspace = store.createAccountClaim({
      workspaceId: workspaceB,
      createdBy: ownerB.id,
      accountId: accountA.id,
      category: "company_overview",
      field: "website",
      value: "https://cross.example",
      claimKind: "fact",
    });
    if (!isErr(crossWorkspace)) throw new Error("cross-workspace claim was allowed");
    expect(crossWorkspace.error.code).toBe("INVALID");
    expect(store.db.accountClaims).toHaveLength(0);
  });

  it("changes status only, so recorded provenance is never rewritten", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Evidence Status Co");
    const account = evidenceAccount(store, workspaceId, owner.id, "Status Trading");
    const claim = store.createAccountClaim({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      category: "company_overview",
      field: "website",
      value: "https://northwind.example",
      claimKind: "fact",
    });
    if (!isOk(claim)) throw new Error("claim creation failed");
    const evidence = store.createEvidence({
      workspaceId,
      accountClaimId: claim.value.id,
      evidence: evidenceInput(),
    });
    if (!isOk(evidence)) throw new Error("evidence creation failed");

    const superseded = store.updateEvidence(evidence.value.id, {
      userId: owner.id,
      status: "superseded",
    });
    if (!isOk(superseded)) throw new Error("evidence status update failed");
    expect(superseded.value.status).toBe("superseded");
    // Only the status moved. The source, retrieval time and provenance are
    // exactly what was recorded.
    expect(superseded.value.retrievedAt).toBe(evidence.value.retrievedAt);
    expect(superseded.value.sourceName).toBe(evidence.value.sourceName);
    expect(superseded.value.confidence).toBe(evidence.value.confidence);
    // And the record is still listable: history does not disappear.
    const listed = store.listEvidence(workspaceId, owner.id, { status: "superseded" });
    if (!isOk(listed)) throw new Error("evidence listing failed");
    expect(listed.value).toHaveLength(1);

    const retracted = store.updateAccountClaim(claim.value.id, {
      userId: owner.id,
      status: "retracted",
    });
    if (!isOk(retracted)) throw new Error("claim status update failed");
    expect(retracted.value.status).toBe("retracted");
    // Retracting a claim does not remove the evidence that supported it.
    expect(store.db.evidence).toHaveLength(1);
  });

  it("exposes a research finding to the evidence layer without trusting the caller", () => {
    const store = seed();
    const ownerA = makeOwner(store, "a@example.com");
    const ownerB = makeOwner(store, "b@example.com");
    const workspaceA = makeWorkspace(store, ownerA.id, "Finding Tenant A");
    const accountA = evidenceAccount(store, workspaceA, ownerA.id, "Finding Trading");
    const finding = seedFinding(store, workspaceA, ownerA.id, accountA.id);

    const owned = store.getResearchFinding(finding.id, ownerA.id);
    if (!isOk(owned)) throw new Error("finding read failed");
    expect(owned.value.accountId).toBe(accountA.id);

    const foreign = store.getResearchFinding(finding.id, ownerB.id);
    if (!isErr(foreign)) throw new Error("cross-tenant finding read was allowed");
    expect(foreign.error.code).toBe("UNAUTHORIZED");

    const absent = store.getResearchFinding(newId(), ownerA.id);
    if (!isErr(absent)) throw new Error("unknown finding read was allowed");
    expect(absent.error.code).toBe("NOT_FOUND");
  });

  it("preserves Phase 6 data when migrating a v6 document to v7", () => {
    const v6 = emptyState();
    v6.schemaVersion = 6;
    const store = new Store(v6);
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "V6 Evidence Co");
    const account = evidenceAccount(store, workspaceId, owner.id, "V6 Trading");
    const finding = seedFinding(store, workspaceId, owner.id, account.id);

    const migrated = migrateState(JSON.parse(JSON.stringify(store.db)) as never);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    // Phase 6 rows survive untouched, so evidence can still be derived later.
    expect(migrated.researchRequests).toHaveLength(1);
    expect(migrated.researchFindings).toHaveLength(1);
    expect(migrated.researchFindings[0]?.id).toBe(finding.id);
    // The Phase 7 tables are additive: an older document gains them empty.
    expect(migrated.accountClaims).toEqual([]);
    expect(migrated.evidence).toEqual([]);
  });

  it("keeps Phase 7 rows across a repeat migration", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Repeat Evidence Co");
    const account = evidenceAccount(store, workspaceId, owner.id, "Repeat Trading");
    const finding = seedFinding(store, workspaceId, owner.id, account.id);
    const claim = store.createAccountClaim({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      category: "company_overview",
      field: "website",
      value: "https://northwind.example",
      claimKind: "fact",
    });
    if (!isOk(claim)) throw new Error("claim creation failed");
    store.createEvidence({
      workspaceId,
      accountClaimId: claim.value.id,
      evidence: {
        ...evidenceInput(),
        researchFindingId: finding.id,
        provenance: "research_finding",
        sourceUrl: "https://northwind.example",
      },
    });

    const migrated = migrateState(JSON.parse(JSON.stringify(store.db)) as never);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.accountClaims).toHaveLength(1);
    expect(migrated.evidence).toHaveLength(1);
    // The provenance chain survives the round trip intact.
    expect(migrated.evidence[0]?.researchFindingId).toBe(finding.id);
    expect(migrated.evidence[0]?.provenance).toBe("research_finding");
    expect(migrated.evidence[0]?.accountClaimId).toBe(claim.value.id);
    expect(migrated.evidence[0]?.accountId).toBe(account.id);
  });
});

describe("qualification evaluations", () => {
  const qualificationAccount = (
    store: Store,
    workspaceId: string,
    userId: string,
    name: string,
  ) => {
    const created = store.createAccount({
      workspaceId,
      createdBy: userId,
      account: {
        name,
        website: null,
        domain: null,
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
    if (!isOk(created)) throw new Error("seed account creation failed");
    return created.value;
  };

  const criterionResult = (
    overrides: Partial<{
      result: "pass" | "fail" | "unknown";
      criterion: string;
      confidence: "low" | "medium" | "high" | null;
    }> = {},
  ) => ({
    dimension: "icp_fit" as const,
    criterion: overrides.criterion ?? "industry_match",
    expectation: "ICP industries: saas",
    observed: overrides.result === "unknown" ? null : "B2B SaaS",
    result: overrides.result ?? ("pass" as const),
    reason: 'the account\'s industry evidence states "B2B SaaS"',
    confidence: overrides.confidence === undefined ? ("high" as const) : overrides.confidence,
    evidenceIds: ["evidence-industry"],
    claimIds: ["claim-industry"],
  });

  const qualificationInput = (
    overrides: Partial<{
      score: number | null;
      state: Qualification["state"];
      confidence: "low" | "medium" | "high" | null;
      revenuePlanId: string | null;
      revenueGoalId: string | null;
      icpId: string | null;
    }> = {},
  ) => ({
    ruleVersion: "deterministic-1.0.0",
    revenuePlanId: overrides.revenuePlanId ?? null,
    revenueGoalId: overrides.revenueGoalId ?? null,
    icpId: overrides.icpId ?? null,
    contextDigest: "fnv1a-0a1b2c3d",
    state: overrides.state ?? ("qualified" as const),
    score: overrides.score === undefined ? 100 : overrides.score,
    confidence: overrides.confidence === undefined ? ("high" as const) : overrides.confidence,
    reason: "every criterion resolved and passed against the workspace icp",
    evidenceIds: ["evidence-industry"],
    claimIds: ["claim-industry"],
    conflictedClaimIds: [],
    dimensions: [
      {
        dimension: "icp_fit" as const,
        score: 100,
        result: "pass" as const,
        reason: "every icp_fit criterion resolved and passed",
        confidence: "high" as const,
        resolvedCriteria: 1,
        criteria: [criterionResult()],
      },
    ],
    evaluatedAt: "2026-10-03T12:00:00.000Z",
  });

  it("stores an evaluation with its criterion results and survives a reload", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Qualification Co");
    const account = qualificationAccount(store, workspaceId, owner.id, "Northwind Trading");

    const created = store.createQualification({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      qualification: qualificationInput(),
    });
    if (!isOk(created)) throw new Error("qualification creation failed");
    // The tenant boundary and the lineage version come from storage, not the caller.
    expect(created.value.workspaceId).toBe(workspaceId);
    expect(created.value.accountId).toBe(account.id);
    expect(created.value.createdBy).toBe(owner.id);
    expect(created.value.version).toBe(1);
    expect(created.value.state).toBe("qualified");
    expect(created.value.score).toBe(100);
    expect(created.value.ruleVersion).toBe("deterministic-1.0.0");

    const reloaded = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const found = reloaded.getQualification(created.value.id, owner.id);
    if (!isOk(found)) throw new Error("qualification read after reload failed");
    // The per-criterion detail survives intact: that is the "why".
    expect(found.value.dimensions).toHaveLength(1);
    expect(found.value.dimensions[0]?.criteria[0]?.criterion).toBe("industry_match");
    expect(found.value.dimensions[0]?.criteria[0]?.expectation).toBe("ICP industries: saas");
    expect(found.value.dimensions[0]?.criteria[0]?.evidenceIds).toEqual(["evidence-industry"]);
    expect(found.value.evaluatedAt).toBe("2026-10-03T12:00:00.000Z");
    expect(found.value.contextDigest).toBe("fnv1a-0a1b2c3d");
  });

  it("versions each account's lineage instead of overwriting it", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Qualification Lineage Co");
    const account = qualificationAccount(store, workspaceId, owner.id, "Lineage Trading");
    const other = qualificationAccount(store, workspaceId, owner.id, "Other Trading");

    const first = store.createQualification({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      qualification: qualificationInput({ state: "insufficient_data", score: null }),
    });
    const second = store.createQualification({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      qualification: qualificationInput(),
    });
    const otherAccount = store.createQualification({
      workspaceId,
      createdBy: owner.id,
      accountId: other.id,
      qualification: qualificationInput(),
    });
    if (!isOk(first) || !isOk(second) || !isOk(otherAccount)) {
      throw new Error("qualification creation failed");
    }
    expect(first.value.version).toBe(1);
    expect(second.value.version).toBe(2);
    // A different account has its own lineage.
    expect(otherAccount.value.version).toBe(1);

    const listed = store.listQualifications(workspaceId, owner.id, { accountId: account.id });
    if (!isOk(listed)) throw new Error("qualification listing failed");
    expect(listed.value).toHaveLength(2);
    // Newest first, so the current judgement is what a user sees.
    expect(listed.value[0]?.version).toBe(2);
    expect(listed.value[1]?.version).toBe(1);
    // And the earlier version is still readable, including its unresolved state.
    expect(listed.value[1]?.state).toBe("insufficient_data");
    expect(listed.value[1]?.score).toBeNull();

    const next = store.nextQualificationVersion(account.id);
    if (!isOk(next)) throw new Error("version read failed");
    expect(next.value).toBe(3);
  });

  it("filters by state and rule version without hiding history", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Qualification Filter Co");
    const account = qualificationAccount(store, workspaceId, owner.id, "Filter Trading");

    store.createQualification({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      qualification: qualificationInput(),
    });
    store.createQualification({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      qualification: qualificationInput({
        state: "contested",
        score: null,
        confidence: null,
      }),
    });

    const contested = store.listQualifications(workspaceId, owner.id, { state: "contested" });
    if (!isOk(contested)) throw new Error("qualification listing failed");
    expect(contested.value).toHaveLength(1);
    expect(contested.value[0]?.state).toBe("contested");
    expect(contested.value[0]?.score).toBeNull();

    const unknownRules = store.listQualifications(workspaceId, owner.id, {
      ruleVersion: "deterministic-0.0.0",
    });
    if (!isOk(unknownRules)) throw new Error("qualification listing failed");
    expect(unknownRules.value).toEqual([]);

    const all = store.listQualifications(workspaceId, owner.id);
    if (!isOk(all)) throw new Error("qualification listing failed");
    expect(all.value).toHaveLength(2);
  });

  it("keeps tenants apart and refuses another workspace's context", () => {
    const store = seed();
    const ownerA = makeOwner(store, "qual-a@example.com");
    const ownerB = makeOwner(store, "qual-b@example.com");
    const wsA = makeWorkspace(store, ownerA.id, "Qualification Globex");
    const wsB = makeWorkspace(store, ownerB.id, "Qualification Initech");
    const accountA = qualificationAccount(store, wsA, ownerA.id, "Confidential Trading");

    const created = store.createQualification({
      workspaceId: wsA,
      createdBy: ownerA.id,
      accountId: accountA.id,
      qualification: qualificationInput(),
    });
    if (!isOk(created)) throw new Error("qualification creation failed");

    // A foreign caller cannot read it, and cannot even learn that it exists.
    const denied = store.getQualification(created.value.id, ownerB.id);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");
    const foreignList = store.listQualifications(wsA, ownerB.id);
    expect(isErr(foreignList)).toBe(true);
    const emptyList = store.listQualifications(wsB, ownerB.id);
    if (!isOk(emptyList)) throw new Error("qualification listing failed");
    expect(emptyList.value).toEqual([]);

    // An evaluation cannot be written for another workspace's account...
    const foreignAccount = store.createQualification({
      workspaceId: wsB,
      createdBy: ownerB.id,
      accountId: accountA.id,
      qualification: qualificationInput(),
    });
    expect(isErr(foreignAccount)).toBe(true);
    if (isErr(foreignAccount)) expect(foreignAccount.error.code).toBe("INVALID");

    // ...and the workspace context it points at must be its own too.
    const goalA = store.createRevenueGoal({
      workspaceId: wsA,
      createdBy: ownerA.id,
      goal: {
        objective: "Grow pipeline",
        targetMetric: "pipeline",
        targetValue: 10000,
        currency: "USD",
        timeWindow: { start: "2026-01-01", end: "2026-06-01" },
        market: null,
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
        successMetrics: [],
        status: "active",
        completeness: "incomplete",
        unknowns: [],
        assumptions: [],
      },
    });
    if (!isOk(goalA)) throw new Error("seed goal creation failed");

    const foreignGoal = store.createQualification({
      workspaceId: wsB,
      createdBy: ownerB.id,
      accountId: qualificationAccount(store, wsB, ownerB.id, "Initech Trading").id,
      qualification: qualificationInput({ revenueGoalId: goalA.value.id }),
    });
    expect(isErr(foreignGoal)).toBe(true);
    if (isErr(foreignGoal)) expect(foreignGoal.error.code).toBe("INVALID");
  });

  it("preserves Phase 7 data when migrating a v7 document to v8", () => {
    const v7 = emptyState();
    v7.schemaVersion = 7;
    const store = new Store(v7);
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "V7 Qualification Co");
    const account = qualificationAccount(store, workspaceId, owner.id, "V7 Qualification Trading");
    const claim = store.createAccountClaim({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      category: "company_overview",
      field: "website",
      value: "https://northwind.example",
      claimKind: "fact",
    });
    if (!isOk(claim)) throw new Error("seed claim creation failed");
    store.createEvidence({
      workspaceId,
      accountClaimId: claim.value.id,
      evidence: {
        researchFindingId: null,
        provenance: "research_finding",
        source: "public_web",
        sourceName: "company_registry",
        sourceUrl: "https://northwind.example",
        sourceTitle: "Company registry entry",
        observedAt: "2026-09-01T00:00:00.000Z",
        retrievedAt: "2026-10-02T00:00:00.000Z",
        confidence: "medium",
        freshness: "fresh",
        relevance: "high",
        note: null,
        status: "recorded",
      },
    });

    const migrated = migrateState(JSON.parse(JSON.stringify(store.db)) as never);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    // Phase 7 rows survive untouched, so the account can still be qualified.
    expect(migrated.accountClaims).toHaveLength(1);
    expect(migrated.evidence).toHaveLength(1);
    expect(migrated.evidence[0]?.sourceName).toBe("company_registry");
    // The Phase 8 table is additive: an older document gains it empty.
    expect(migrated.qualifications).toEqual([]);

    // And the upgraded document still holds an untouched Phase 7 chain.
    const upgraded = new Store(migrated);
    const reread = upgraded.listEvidence(workspaceId, owner.id, { accountId: account.id });
    if (!isOk(reread)) throw new Error("evidence read after migration failed");
    expect(reread.value).toHaveLength(1);
    const evaluations = upgraded.listQualifications(workspaceId, owner.id);
    if (!isOk(evaluations)) throw new Error("qualification listing failed");
    expect(evaluations.value).toEqual([]);
  });

  it("keeps Phase 8 rows across a repeat migration", () => {
    const store = seed();
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Repeat Qualification Co");
    const account = qualificationAccount(
      store,
      workspaceId,
      owner.id,
      "Repeat Qualification Trading",
    );
    const created = store.createQualification({
      workspaceId,
      createdBy: owner.id,
      accountId: account.id,
      qualification: qualificationInput(),
    });
    if (!isOk(created)) throw new Error("qualification creation failed");

    const migrated = migrateState(JSON.parse(JSON.stringify(store.db)) as never);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.qualifications).toHaveLength(1);
    expect(migrated.qualifications[0]?.id).toBe(created.value.id);
    expect(migrated.qualifications[0]?.version).toBe(1);
    // Migrating again is idempotent, so the lineage does not shift underneath.
    expect(migrateState(migrated).qualifications).toHaveLength(1);
  });

  it("reports a missing evaluation rather than an empty one", () => {
    const store = seed();
    const owner = makeOwner(store);
    const absent = store.getQualification(newId(), owner.id);
    expect(isErr(absent)).toBe(true);
    if (isErr(absent)) expect(absent.error.code).toBe("NOT_FOUND");
  });
});

/**
 * Storage-level guards for the two phases whose security claims rest on this
 * layer.
 *
 * Every other test of approvals and outbound goes through a service. That proves
 * the services behave; it does not prove that the *storage* refuses what the
 * services rely on it refusing. These tests close that gap, because the storage
 * guards are the root of several load-bearing claims:
 *
 * - no path can create an already-approved approval request;
 * - a decision cannot be taken twice, and a decided request cannot be re-decided;
 * - one approval raises at most one outbound action;
 * - nothing but a confirmation reaches `sent`, and a failure never carries a
 *   delivery timestamp;
 * - a foreign workspace's draft, approval and contact are all refused.
 */
describe("approval requests and outbound actions", () => {
  interface Fixture {
    store: Store;
    ownerId: string;
    workspaceId: string;
    accountId: string;
    contactId: string;
    draftId: string;
    draftVersion: number;
    approvalId: string;
  }

  /** A workspace with a draft, plus a pending approval request for it. */
  function seeded(name = "Acme", email = "owner@example.com"): Fixture {
    const store = seed();
    const owner = makeOwner(store, email);
    const workspaceId = makeWorkspace(store, owner.id, name);
    const account = store.createAccount({
      workspaceId,
      createdBy: owner.id,
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
    if (!isOk(account)) throw new Error("seed account creation failed");
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
    if (!isOk(contact)) throw new Error("seed contact creation failed");
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
    if (!isOk(draft)) throw new Error("seed draft creation failed");
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
    if (!isOk(approval)) throw new Error("seed approval creation failed");
    return {
      store,
      ownerId: owner.id,
      workspaceId,
      accountId: account.value.id,
      contactId: contact.value.id,
      draftId: draft.value.id,
      draftVersion: draft.value.version,
      approvalId: approval.value.id,
    };
  }

  /** The outbound action payload for an approval, as the service builds it. */
  function actionFor(fixture: Fixture, approvalId = fixture.approvalId) {
    return {
      channel: "email" as const,
      draftId: fixture.draftId,
      draftVersion: fixture.draftVersion,
      draftDigest: "fnv1a-draft",
      approvalId,
      contactId: fixture.contactId,
      recipientEmail: "ada@northwind.example",
    };
  }

  it("creates an action only in a state no caller supplied", () => {
    const fixture = seeded();
    const created = fixture.store.createOutboundAction({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      action: actionFor(fixture),
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    // Everything the provider will later own is written blank, and `sent` is not
    // reachable from a creation call at all.
    expect(created.value.status).toBe("ready");
    expect(created.value.provider).toBeNull();
    expect(created.value.attemptCount).toBe(0);
    expect(created.value.providerReference).toBeNull();
    expect(created.value.failureCode).toBeNull();
    expect(created.value.sentAt).toBeNull();
    expect(created.value.completedAt).toBeNull();
  });

  it("raises at most one action per approval, at the storage layer", () => {
    const fixture = seeded();
    const first = fixture.store.createOutboundAction({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      action: actionFor(fixture),
    });
    expect(isOk(first)).toBe(true);

    // The duplicate-send guarantee does not rest on one caller checking first.
    const second = fixture.store.createOutboundAction({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      action: actionFor(fixture),
    });
    expect(isErr(second)).toBe(true);
    if (!isErr(second)) return;
    expect(second.error.code).toBe("CONFLICT");

    const listed = fixture.store.listOutboundActions(fixture.workspaceId, fixture.ownerId);
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(1);
  });

  it("refuses an action for another workspace's draft, approval or contact", () => {
    const a = seeded("Acme", "a@example.com");
    const b = seeded("Globex", "b@example.com");

    // Tenant B naming tenant A's draft.
    const foreignDraft = b.store.createOutboundAction({
      workspaceId: b.workspaceId,
      createdBy: b.ownerId,
      action: { ...actionFor(b), draftId: a.draftId },
    });
    expect(isErr(foreignDraft)).toBe(true);

    // Tenant B naming tenant A's approval.
    const foreignApproval = b.store.createOutboundAction({
      workspaceId: b.workspaceId,
      createdBy: b.ownerId,
      action: { ...actionFor(b), approvalId: a.approvalId },
    });
    expect(isErr(foreignApproval)).toBe(true);

    // Tenant B naming tenant A's contact.
    const foreignContact = b.store.createOutboundAction({
      workspaceId: b.workspaceId,
      createdBy: b.ownerId,
      action: { ...actionFor(b), contactId: a.contactId },
    });
    expect(isErr(foreignContact)).toBe(true);

    // And nothing was written for any of them.
    const listed = b.store.listOutboundActions(b.workspaceId, b.ownerId);
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(0);
  });

  it("refuses an action whose approval covers a different draft version", () => {
    const fixture = seeded();
    const created = fixture.store.createOutboundAction({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      action: actionFor(fixture),
    });
    if (!isOk(created)) return;

    // A version the draft lineage never had.
    const imaginary = fixture.store.createOutboundAction({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      action: {
        ...actionFor(fixture),
        draftVersion: 99,
        approvalId: `${fixture.approvalId}-other`,
      },
    });
    expect(isErr(imaginary)).toBe(true);
  });

  it("reaches `sent` only from a confirmation, and never from a failure", () => {
    const fixture = seeded();
    const created = fixture.store.createOutboundAction({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      action: actionFor(fixture),
    });
    if (!isOk(created)) return;
    const id = created.value.id;
    const at = toDateTime(new Date("2026-10-01T00:00:00.000Z"));

    // A `ready` action cannot be confirmed out of order.
    const early = fixture.store.confirmOutboundSent({
      id,
      userId: fixture.ownerId,
      provider: "sandbox_email",
      providerReference: "ref-1",
      sentAt: at,
    });
    expect(isErr(early)).toBe(true);
    if (!isErr(early)) return;
    expect(early.error.code).toBe("CONFLICT");

    // Open an attempt, then fail it.
    const attempted = fixture.store.recordOutboundAttempt({
      id,
      userId: fixture.ownerId,
      provider: "sandbox_email",
      attemptedAt: at,
    });
    expect(isOk(attempted)).toBe(true);
    if (!isOk(attempted)) return;
    expect(attempted.value.status).toBe("sending");
    expect(attempted.value.attemptCount).toBe(1);

    const failed = fixture.store.recordOutboundFailure({
      id,
      userId: fixture.ownerId,
      provider: "sandbox_email",
      failureCode: "provider_unavailable",
      failureMessage: "the provider is down",
      failedAt: at,
    });
    expect(isOk(failed)).toBe(true);
    if (!isOk(failed)) return;
    // A failure is not a delivery, on every field that could imply one.
    expect(failed.value.status).toBe("failed");
    expect(failed.value.sentAt).toBeNull();
    expect(failed.value.providerReference).toBeNull();
    expect(failed.value.failureCode).toBe("provider_unavailable");

    // Retry, then confirm. Only now is it sent.
    const retried = fixture.store.recordOutboundAttempt({
      id,
      userId: fixture.ownerId,
      provider: "sandbox_email",
      attemptedAt: at,
    });
    expect(isOk(retried)).toBe(true);
    if (!isOk(retried)) return;
    expect(retried.value.attemptCount).toBe(2);

    const sent = fixture.store.confirmOutboundSent({
      id,
      userId: fixture.ownerId,
      provider: "sandbox_email",
      providerReference: "ref-2",
      sentAt: at,
    });
    expect(isOk(sent)).toBe(true);
    if (!isOk(sent)) return;
    expect(sent.value.status).toBe("sent");
    expect(sent.value.sentAt).toBe(at);
    expect(sent.value.providerReference).toBe("ref-2");

    // A sent action is terminal: no further attempt, failure or cancellation.
    for (const attempt of [
      fixture.store.recordOutboundAttempt({
        id,
        userId: fixture.ownerId,
        provider: "sandbox_email",
        attemptedAt: at,
      }),
      fixture.store.recordOutboundFailure({
        id,
        userId: fixture.ownerId,
        provider: "sandbox_email",
        failureCode: "provider_unavailable",
        failureMessage: "again",
        failedAt: at,
      }),
      fixture.store.cancelOutboundAction(id, fixture.ownerId, "changed my mind", at),
    ]) {
      expect(isErr(attempt)).toBe(true);
      if (!isErr(attempt)) return;
      expect(attempt.error.code).toBe("CONFLICT");
    }
  });

  it("records a pre-flight refusal without claiming a provider attempt", () => {
    const fixture = seeded();
    const created = fixture.store.createOutboundAction({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      action: actionFor(fixture),
    });
    if (!isOk(created)) return;
    const id = created.value.id;
    const at = toDateTime(new Date("2026-10-01T00:00:00.000Z"));

    // A suppression is found before the provider is resolved, so the action is
    // still `ready`: no provider handled it and no attempt was spent.
    const refused = fixture.store.recordOutboundFailure({
      id,
      userId: fixture.ownerId,
      provider: "none",
      failureCode: "suppressed",
      failureMessage: "the recipient has opted out",
      failedAt: at,
    });
    expect(isOk(refused)).toBe(true);
    if (!isOk(refused)) return;
    expect(refused.value.status).toBe("failed");
    expect(refused.value.failureCode).toBe("suppressed");
    expect(refused.value.provider).toBeNull();
    expect(refused.value.attemptCount).toBe(0);
    expect(refused.value.attemptedAt).toBeNull();
    expect(refused.value.sentAt).toBeNull();
  });

  it("refuses a second decision, and refuses a decided request outright", () => {
    const fixture = seeded();
    const at = toDateTime(new Date("2026-10-01T00:00:00.000Z"));

    const decided = fixture.store.decideApproval({
      id: fixture.approvalId,
      userId: fixture.ownerId,
      decision: "approved",
      reason: null,
      decidedAt: at,
    });
    expect(isOk(decided)).toBe(true);
    if (!isOk(decided)) return;
    expect(decided.value.status).toBe("approved");
    expect(decided.value.decidedBy).toBe(fixture.ownerId);

    // A second decision is refused rather than overwriting the first.
    const again = fixture.store.decideApproval({
      id: fixture.approvalId,
      userId: fixture.ownerId,
      decision: "rejected",
      reason: "changed my mind",
      decidedAt: at,
    });
    expect(isErr(again)).toBe(true);
    if (!isErr(again)) return;
    expect(again.error.code).toBe("CONFLICT");

    // And a decided request cannot be closed like a pending one either.
    const closed = fixture.store.closeApproval({
      id: fixture.approvalId,
      userId: fixture.ownerId,
      status: "cancelled",
      reason: null,
      decidedAt: at,
    });
    expect(isErr(closed)).toBe(true);
    if (!isErr(closed)) return;
    expect(closed.error.code).toBe("CONFLICT");

    // The first decision stands.
    const stored = fixture.store.getApprovalRequest(fixture.approvalId, fixture.ownerId);
    expect(isOk(stored)).toBe(true);
    if (!isOk(stored)) return;
    expect(stored.value.status).toBe("approved");
    expect(stored.value.decision).toBe("approved");
  });

  it("normalizes suppressions, keeps them unique per address, and scopes them per workspace", () => {
    const fixture = seeded();
    const first = fixture.store.createOutboundSuppression({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      suppression: { email: "Ada@Northwind.Example", reason: "asked us to stop" },
    });
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    // An opt-out is about a person, not about the casing they typed.
    expect(first.value.email).toBe("ada@northwind.example");
    expect(first.value.createdBy).toBe(fixture.ownerId);

    // The same address twice is one record, so the list stays auditable.
    const again = fixture.store.createOutboundSuppression({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      suppression: { email: "ada@northwind.example", reason: "asked us to stop" },
    });
    expect(isOk(again)).toBe(true);
    if (!isOk(again)) return;
    expect(again.value.id).toBe(first.value.id);

    const listed = fixture.store.listOutboundSuppressions(fixture.workspaceId, fixture.ownerId);
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(1);

    // One tenant's opt-out never silences another's sends.
    const other = seeded("Globex", "b@example.com");
    const elsewhere = other.store.isSuppressed(
      other.workspaceId,
      other.ownerId,
      "ada@northwind.example",
    );
    expect(isOk(elsewhere)).toBe(true);
    if (!isOk(elsewhere)) return;
    expect(elsewhere.value).toBe(false);

    // And a non-member cannot read the list at all.
    const denied = fixture.store.listOutboundSuppressions(fixture.workspaceId, other.ownerId);
    expect(isErr(denied)).toBe(true);
    if (!isErr(denied)) return;
    expect(denied.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Phase 12 — Conversation
//
// Phase 12's storage tests exist because the phase adds a second way for
// something a workspace did not author to enter the system. The invariants
// asserted here are the ones that keeps that safe: a response can only answer a
// message that actually went out, a caller cannot file it against anyone else,
// one message is read once, and the two safety rules the schema also constrains
// are enforced in the store rather than trusted from the caller.
// ---------------------------------------------------------------------------

/**
 * A whole tenant whose one outbound action has been driven all the way to
 * `sent`.
 *
 * Built from real account, contact, draft and approval rows rather than from
 * a stubbed action, because the store refuses an action that does not point at
 * rows that exist — and because a test that passed against a fabricated action
 * would not be testing the rule at all.
 *
 * Declared at module scope because Phase 12 and Phase 13 both build on it: a
 * meeting can only be proposed from a response to a message that genuinely went
 * out, so the Phase 13 fixture starts from exactly this tenant.
 */
function sent(name = "Acme", email = "owner@example.com", shared?: Store) {
  const store = shared ?? seed();
  const owner = makeOwner(store, email);
  const workspaceId = makeWorkspace(store, owner.id, name);
  const account = store.createAccount({
    workspaceId,
    createdBy: owner.id,
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
      body: "Hi Ada,\n\nAbout Support Automation.",
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

  const created = store.createOutboundAction({
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
  if (!isOk(created)) throw new Error("seed action failed");
  const attempted = store.recordOutboundAttempt({
    id: created.value.id,
    userId: owner.id,
    provider: "sandbox-email",
    attemptedAt: "2026-10-05T09:00:00.000Z",
  });
  if (!isOk(attempted)) throw new Error("seed attempt failed");
  const confirmed = store.confirmOutboundSent({
    id: created.value.id,
    userId: owner.id,
    provider: "sandbox-email",
    providerReference: "provider-1",
    sentAt: "2026-10-05T09:00:01.000Z",
  });
  if (!isOk(confirmed)) throw new Error("seed confirmation failed");
  return {
    store,
    ownerId: owner.id,
    workspaceId,
    accountId: account.value.id,
    contactId: contact.value.id,
    actionId: confirmed.value.id,
  };
}

function messageFor(
  fixture: ReturnType<typeof sent>,
  body = "Please unsubscribe me.",
  receivedAt = "2026-10-05T09:30:00.000Z",
) {
  return fixture.store.createInboundMessage({
    workspaceId: fixture.workspaceId,
    createdBy: fixture.ownerId,
    message: {
      outboundActionId: fixture.actionId,
      source: "manual",
      fromAddress: "ada@northwind.example",
      subject: "Re: support automation",
      body,
      providerMessageId: null,
      receivedAt,
    },
  });
}

describe("inbound messages and conversation classifications", () => {
  function classificationFor(
    fixture: ReturnType<typeof sent>,
    inboundMessageId: string,
    overrides: Partial<{
      intent: "unsubscribe" | "pricing" | "question" | "unknown";
      recommendedNextAction: "stop_contacting" | "prepare_reply_for_approval" | "record_and_hold";
      humanInterventionRequired: boolean;
      suppressed: boolean;
    }> = {},
  ) {
    return fixture.store.createConversationClassification({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      classification: {
        inboundMessageId,
        outboundActionId: fixture.actionId,
        classifierVersion: "deterministic-1.0.0",
        intent: overrides.intent ?? "unsubscribe",
        confidence: "high",
        reasons: ["matched unsubscribe"],
        signals: ["opt_out"],
        recommendedNextAction:
          overrides.recommendedNextAction ??
          (overrides.intent === "unsubscribe" ? "stop_contacting" : "prepare_reply_for_approval"),
        humanInterventionRequired: overrides.humanInterventionRequired ?? false,
        suppressed: overrides.suppressed ?? false,
      },
    });
  }

  it("stores a response verbatim and resolves the contact and account itself", () => {
    const fixture = sent();
    const created = messageFor(fixture, "This sounds good.");
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    // The text is exactly what arrived, and neither the contact nor the account
    // is a field the caller supplied: both came from the action.
    expect(created.value.body).toBe("This sounds good.");
    expect(created.value.contactId).toBe(fixture.contactId);
    expect(created.value.accountId).toBe(fixture.accountId);
    expect(created.value.source).toBe("manual");
    expect(created.value.receivedAt).toBe("2026-10-05T09:30:00.000Z");

    const reread = fixture.store.getInboundMessage(created.value.id, fixture.ownerId);
    expect(isOk(reread)).toBe(true);
    if (!isOk(reread)) return;
    expect(reread.value.body).toBe("This sounds good.");
  });

  it("refuses a response against a message that was never sent", () => {
    const fixture = sent();
    // A second, real action that is deliberately left in `ready`: the store
    // refuses an action per approval, so this needs its own approval to exist at
    // all, which is exactly the point — an unsent action is a genuine record.
    const draft = fixture.store.createDraft({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      accountId: fixture.accountId,
      draft: {
        contactId: fixture.contactId,
        rendererVersion: "deterministic-1.0.0",
        contextDigest: "fnv1a-seed-2",
        qualificationId: null,
        offerId: null,
        subject: "A second note",
        body: "Hi Ada,\n\nOne more note.",
        personalizationPoints: [],
        approvedClaimIds: [],
        warnings: [],
      },
    });
    if (!isOk(draft)) throw new Error("seed second draft failed");
    const approval = fixture.store.createApprovalRequest({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      approval: {
        actionKind: "send_message",
        riskLevel: "level_2_external_action",
        draftId: draft.value.id,
        draftVersion: draft.value.version,
        previewSubject: draft.value.subject,
        previewDigest: "fnv1a-preview-2",
        expiresAt: null,
      },
    });
    if (!isOk(approval)) throw new Error("seed second approval failed");
    const unsent = fixture.store.createOutboundAction({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      action: {
        channel: "email",
        draftId: draft.value.id,
        draftVersion: draft.value.version,
        draftDigest: "fnv1a-draft-2",
        approvalId: approval.value.id,
        contactId: fixture.contactId,
        recipientEmail: "ada@northwind.example",
      },
    });
    if (!isOk(unsent)) throw new Error("seed unsent action failed");

    const refused = fixture.store.createInboundMessage({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      message: {
        outboundActionId: unsent.value.id,
        source: "manual",
        fromAddress: null,
        subject: null,
        body: "Sounds good!",
        providerMessageId: null,
        receivedAt: "2026-10-05T09:30:00.000Z",
      },
    });
    expect(isErr(refused)).toBe(true);
    if (!isErr(refused)) return;
    // A message DEALORA never sent cannot have been answered.
    expect(refused.error.code).toBe("CONFLICT");
    expect(fixture.store.db.inboundMessages).toHaveLength(0);
  });

  it("refuses a response to another tenant's action and writes nothing", () => {
    // Two tenants in one document, which is what a shared store actually looks
    // like: the tenant boundary is a workspace id, not a separate file.
    const store = seed();
    const mine = sent("Mine", "mine@example.com", store);
    const theirs = sent("Theirs", "theirs@example.com", store);

    // My workspace asks to answer *their* action: for my workspace that action
    // does not exist, and nothing is written.
    const crossed = store.createInboundMessage({
      workspaceId: mine.workspaceId,
      createdBy: mine.ownerId,
      message: {
        outboundActionId: theirs.actionId,
        source: "manual",
        fromAddress: null,
        subject: null,
        body: "Hello",
        providerMessageId: null,
        receivedAt: "2026-10-05T09:30:00.000Z",
      },
    });
    expect(isErr(crossed)).toBe(true);
    if (!isErr(crossed)) return;
    expect(crossed.error.code).toBe("NOT_FOUND");
    expect(store.db.inboundMessages).toHaveLength(0);

    // And once theirs exists, my tenant still cannot read it — reported as not
    // found, because an unauthorized answer would confirm the id is real.
    const theirsMessage = messageFor(theirs, "Hello");
    expect(isOk(theirsMessage)).toBe(true);
    if (!isOk(theirsMessage)) return;
    const denied = store.getInboundMessage(theirsMessage.value.id, mine.ownerId);
    expect(isErr(denied)).toBe(true);
    if (!isErr(denied)) return;
    expect(denied.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(denied.error)).not.toContain("Northwind");
  });

  it("classifies one message once, and refuses a second answer for it", () => {
    const fixture = sent();
    const created = messageFor(fixture);
    if (!isOk(created)) throw new Error("seed message failed");

    const first = classificationFor(fixture, created.value.id);
    expect(isOk(first)).toBe(true);

    const second = classificationFor(fixture, created.value.id, {
      intent: "question",
      recommendedNextAction: "prepare_reply_for_approval",
      humanInterventionRequired: true,
    });
    expect(isErr(second)).toBe(true);
    if (!isErr(second)) return;
    // Two answers for one response is how an audit trail stops meaning anything.
    expect(second.error.code).toBe("CONFLICT");
    expect(fixture.store.db.conversationClassifications).toHaveLength(1);

    const found = fixture.store.findConversationClassificationByMessage(
      created.value.id,
      fixture.ownerId,
    );
    expect(isOk(found)).toBe(true);
    if (!isOk(found)) return;
    expect(found.value?.intent).toBe("unsubscribe");
  });

  it("enforces the two safety invariants rather than trusting the caller", () => {
    const fixture = sent();
    const created = messageFor(fixture);
    if (!isOk(created)) throw new Error("seed message failed");

    // Only an opt-out may suppress an address.
    const fakeSuppression = classificationFor(fixture, created.value.id, {
      intent: "question",
      recommendedNextAction: "prepare_reply_for_approval",
      humanInterventionRequired: true,
      suppressed: true,
    });
    expect(isErr(fakeSuppression)).toBe(true);
    if (!isErr(fakeSuppression)) return;
    expect(fakeSuppression.error.code).toBe("INVALID");

    // And only an opt-out may proceed without a human.
    const unsupervised = classificationFor(fixture, created.value.id, {
      intent: "question",
      recommendedNextAction: "prepare_reply_for_approval",
      humanInterventionRequired: false,
    });
    expect(isErr(unsupervised)).toBe(true);
    if (!isErr(unsupervised)) return;
    expect(unsupervised.error.code).toBe("INVALID");

    // The honest opt-out is accepted.
    const honest = classificationFor(fixture, created.value.id, {
      suppressed: true,
    });
    expect(isOk(honest)).toBe(true);
  });

  it("writes an append-only trail and refuses an event for a foreign classification", () => {
    const fixture = sent();
    const created = messageFor(fixture);
    if (!isOk(created)) throw new Error("seed message failed");
    const classified = classificationFor(fixture, created.value.id);
    if (!isOk(classified)) throw new Error("seed classification failed");

    for (const kind of ["classified", "suppressed", "escalated", "held"] as const) {
      const event = fixture.store.createConversationEvent({
        workspaceId: fixture.workspaceId,
        actorUserId: fixture.ownerId,
        event: {
          classificationId: classified.value.id,
          inboundMessageId: created.value.id,
          kind,
          detail: "a detail",
        },
      });
      expect(isOk(event)).toBe(true);
    }
    const history = fixture.store.listConversationEvents(classified.value.id, fixture.ownerId);
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    expect(history.value.map((entry) => entry.kind)).toEqual([
      "classified",
      "suppressed",
      "escalated",
      "held",
    ]);
    // A trail that could be read from outside the tenant would be a leak.
    const other = sent("Other", "other@example.com", fixture.store);
    const denied = other.store.listConversationEvents(classified.value.id, other.ownerId);
    expect(isErr(denied)).toBe(true);
    if (!isErr(denied)) return;
    expect(denied.error.code).toBe("NOT_FOUND");
  });

  it("lists a workspace's responses and classifications, newest first", () => {
    const fixture = sent();
    const replies: [string, string][] = [
      ["First reply.", "2026-10-05T09:30:00.000Z"],
      ["Second reply.", "2026-10-05T11:30:00.000Z"],
    ];
    for (const [body, receivedAt] of replies) {
      const created = messageFor(fixture, body, receivedAt);
      if (!isOk(created)) throw new Error("seed message failed");
      const classified = classificationFor(fixture, created.value.id, {
        intent: "question",
        recommendedNextAction: "prepare_reply_for_approval",
        humanInterventionRequired: true,
      });
      if (!isOk(classified)) throw new Error("seed classification failed");
    }
    const messages = fixture.store.listInboundMessages(fixture.workspaceId, fixture.ownerId);
    expect(isOk(messages)).toBe(true);
    if (!isOk(messages)) return;
    expect(messages.value).toHaveLength(2);
    expect(messages.value[0]?.body).toBe("Second reply.");

    const classified = fixture.store.listConversationClassifications(
      fixture.workspaceId,
      fixture.ownerId,
    );
    expect(isOk(classified)).toBe(true);
    if (!isOk(classified)) return;
    expect(classified.value).toHaveLength(2);

    const narrowed = fixture.store.listConversationClassifications(
      fixture.workspaceId,
      fixture.ownerId,
      { intent: "question" },
    );
    expect(isOk(narrowed)).toBe(true);
    if (!isOk(narrowed)) return;
    expect(narrowed.value).toHaveLength(2);

    // Another tenant in the same document sees none of it.
    const other = sent("Other", "other@example.com", fixture.store);
    const elsewhere = other.store.listInboundMessages(other.workspaceId, other.ownerId);
    expect(isOk(elsewhere)).toBe(true);
    if (!isOk(elsewhere)) return;
    expect(elsewhere.value).toEqual([]);
  });

  it("refuses a non-member every read and write", () => {
    const fixture = sent();
    const created = messageFor(fixture);
    if (!isOk(created)) throw new Error("seed message failed");
    const classified = classificationFor(fixture, created.value.id);
    if (!isOk(classified)) throw new Error("seed classification failed");

    const stranger = "a-stranger-with-no-membership";
    expect(isErr(fixture.store.listInboundMessages(fixture.workspaceId, stranger))).toBe(true);
    expect(isErr(fixture.store.getInboundMessage(created.value.id, stranger))).toBe(true);
    expect(isErr(fixture.store.getConversationClassification(classified.value.id, stranger))).toBe(
      true,
    );
    expect(
      isErr(fixture.store.listConversationClassifications(fixture.workspaceId, stranger)),
    ).toBe(true);
  });

  it("migrates a Phase 11 document forward without touching a single outbound row", () => {
    const fixture = sent();
    const document = JSON.parse(JSON.stringify(fixture.store.db)) as typeof fixture.store.db;
    // Pretend the document was written by Phase 11: no conversation tables.
    const phase11 = {
      ...document,
      schemaVersion: 11,
      inboundMessages: undefined,
      conversationClassifications: undefined,
      conversationEvents: undefined,
    };

    const migrated = migrateState(phase11 as unknown as Parameters<typeof migrateState>[0]);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.inboundMessages).toEqual([]);
    expect(migrated.conversationClassifications).toEqual([]);
    expect(migrated.conversationEvents).toEqual([]);
    // Every earlier table is carried over byte for byte.
    expect(migrated.outboundActions).toEqual(document.outboundActions);
    expect(migrated.outboundEvents).toEqual(document.outboundEvents);
    expect(migrated.outboundSuppressions).toEqual(document.outboundSuppressions);
    expect(migrated.approvalRequests).toEqual(document.approvalRequests);
    expect(migrated.personalizedDrafts).toEqual(document.personalizedDrafts);
    expect(migrated.evidence).toEqual(document.evidence);
    expect(migrated.accountClaims).toEqual(document.accountClaims);
  });
});

describe("meetings, briefs and the booking audit trail", () => {
  /**
   * A tenant that has a sent message, a **positive** classification and a
   * `qualified` evaluation — the three prerequisites a meeting record demands.
   *
   * Built on the same real rows the Phase 12 tests use, because the store refuses
   * a meeting whose classification or qualification does not exist, and a test
   * that passed against a fabricated prerequisite would not be testing the rule.
   */
  function meetingFixture(name = "Acme", email = "owner@example.com", shared?: Store) {
    const fixture = sent(name, email, shared);
    const store = fixture.store;
    const message = messageFor(fixture, "Happy to chat, book a call.");
    if (!isOk(message)) throw new Error("seed message failed");
    const classification = store.createConversationClassification({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      classification: {
        inboundMessageId: message.value.id,
        outboundActionId: fixture.actionId,
        classifierVersion: "deterministic-1.0.0",
        intent: "positive_intent",
        confidence: "high",
        reasons: ['matched "book a call"'],
        signals: ["positive_sentiment"],
        recommendedNextAction: "prepare_reply_for_approval",
        humanInterventionRequired: true,
        suppressed: false,
      },
    });
    if (!isOk(classification)) throw new Error("seed classification failed");
    const qualification = store.createQualification({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      accountId: fixture.accountId,
      qualification: {
        ruleVersion: "deterministic-1.0.0",
        revenuePlanId: null,
        revenueGoalId: null,
        icpId: null,
        contextDigest: "digest-seed",
        evaluatedAt: "2026-10-06T00:00:00.000Z",
        state: "qualified",
        score: 82,
        confidence: "high",
        reason: "meets the workspace criteria",
        evidenceIds: [],
        claimIds: [],
        conflictedClaimIds: [],
        dimensions: [],
      },
    });
    if (!isOk(qualification)) throw new Error("seed qualification failed");
    return {
      ...fixture,
      messageId: message.value.id,
      classificationId: classification.value.id,
      qualificationId: qualification.value.id,
    };
  }

  const BOOKING = {
    title: "Intro call with Northwind",
    startsAt: "2026-11-02T10:00:00.000Z",
    endsAt: "2026-11-02T10:30:00.000Z",
    timezone: "Europe/Berlin",
    durationMinutes: 30,
  };

  function meetingFor(
    fixture: ReturnType<typeof meetingFixture>,
    overrides: Record<string, unknown> = {},
  ) {
    return fixture.store.createMeeting({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      meeting: {
        accountId: fixture.accountId,
        contactId: fixture.contactId,
        classificationId: fixture.classificationId,
        inboundMessageId: fixture.messageId,
        outboundActionId: fixture.actionId,
        qualificationId: fixture.qualificationId,
        state: "recommended",
        recommendationReason: "positive_intent",
        policyVersion: "deterministic-1.0.0",
        bookingDigest: "bk_seeddigest",
        channel: "sandbox",
        ...BOOKING,
        ...overrides,
      },
    });
  }

  it("stores a proposed meeting with its whole provenance chain", () => {
    const fixture = meetingFixture();
    const created = meetingFor(fixture);
    if (!isOk(created)) throw new Error("seed meeting failed");

    // The chain is stored as references, so "why is this on a calendar?" is
    // answerable from the row itself rather than by re-running anything.
    expect(created.value.classificationId).toBe(fixture.classificationId);
    expect(created.value.qualificationId).toBe(fixture.qualificationId);
    expect(created.value.inboundMessageId).toBe(fixture.messageId);
    expect(created.value.contactId).toBe(fixture.contactId);
    // A proposal is `recommended`, and carries no approval or booking.
    expect(created.value.state).toBe("recommended");
    expect(created.value.approvedAt).toBeNull();
    expect(created.value.bookedAt).toBeNull();

    const reread = fixture.store.getMeeting(created.value.id, fixture.ownerId);
    if (!isOk(reread)) throw new Error("reload failed");
    expect(reread.value.bookingDigest).toBe("bk_seeddigest");
    expect(reread.value.title).toBe(BOOKING.title);
  });

  it("refuses a meeting for a response that was not positive", () => {
    const fixture = meetingFixture();
    const other = messageFor(fixture, "Too expensive for us right now.");
    if (!isOk(other)) throw new Error("seed message failed");
    const objection = fixture.store.createConversationClassification({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      classification: {
        inboundMessageId: other.value.id,
        outboundActionId: fixture.actionId,
        classifierVersion: "deterministic-1.0.0",
        intent: "objection",
        confidence: "high",
        reasons: ['matched "too expensive"'],
        signals: ["objection_signal"],
        recommendedNextAction: "request_human_review",
        humanInterventionRequired: true,
        suppressed: false,
      },
    });
    if (!isOk(objection)) throw new Error("seed objection failed");

    // The prerequisite is re-derived here, so the domain service cannot be the
    // only thing standing between an objection and a calendar entry.
    const refused = meetingFor(fixture, { classificationId: objection.value.id });
    expect(isErr(refused)).toBe(true);
  });

  it("refuses a meeting whose qualification is not qualified", () => {
    const fixture = meetingFixture();
    const unqualified = fixture.store.createQualification({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      accountId: fixture.accountId,
      qualification: {
        ruleVersion: "deterministic-1.0.0",
        revenuePlanId: null,
        revenueGoalId: null,
        icpId: null,
        contextDigest: "digest-2",
        evaluatedAt: "2026-10-06T00:00:00.000Z",
        state: "unqualified",
        score: 12,
        confidence: "low",
        reason: "does not meet the criteria",
        evidenceIds: [],
        claimIds: [],
        conflictedClaimIds: [],
        dimensions: [],
      },
    });
    if (!isOk(unqualified)) throw new Error("seed qualification failed");
    expect(isErr(meetingFor(fixture, { qualificationId: unqualified.value.id }))).toBe(true);
  });

  it("refuses a second meeting for the same response", () => {
    const fixture = meetingFixture();
    if (!isOk(meetingFor(fixture))) throw new Error("seed meeting failed");
    // One response is one occurrence of interest; a second meeting would be a
    // second calendar entry for one conversation.
    expect(isErr(meetingFor(fixture))).toBe(true);
  });

  it("refuses a booked state with no approval behind it", () => {
    const fixture = meetingFixture();
    const created = meetingFor(fixture);
    if (!isOk(created)) throw new Error("seed meeting failed");
    // A booking that a person never authorized is not representable, whichever
    // layer asks for it.
    const booked = fixture.store.updateMeetingState({
      meetingId: created.value.id,
      actorUserId: fixture.ownerId,
      state: "booked",
      bookedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(isErr(booked)).toBe(true);
    const reread = fixture.store.getMeeting(created.value.id, fixture.ownerId);
    if (!isOk(reread)) throw new Error("reload failed");
    expect(reread.value.state).toBe("recommended");
  });

  it("refuses an approval with no record of who or when", () => {
    const fixture = meetingFixture();
    const created = meetingFor(fixture);
    if (!isOk(created)) throw new Error("seed meeting failed");
    expect(
      isErr(
        fixture.store.updateMeetingState({
          meetingId: created.value.id,
          actorUserId: fixture.ownerId,
          state: "approved",
        }),
      ),
    ).toBe(true);
  });

  it("will not carry a booked meeting back to approved", () => {
    const fixture = meetingFixture();
    const created = meetingFor(fixture);
    if (!isOk(created)) throw new Error("seed meeting failed");
    const approved = fixture.store.updateMeetingState({
      meetingId: created.value.id,
      actorUserId: fixture.ownerId,
      state: "approved",
      approvedBy: fixture.ownerId,
      approvedAt: "2026-11-01T00:00:00.000Z",
    });
    if (!isOk(approved)) throw new Error("approval failed");
    const booked = fixture.store.updateMeetingState({
      meetingId: created.value.id,
      actorUserId: fixture.ownerId,
      state: "booked",
      bookedAt: "2026-11-01T00:01:00.000Z",
      externalEventId: "sandbox-1",
    });
    if (!isOk(booked)) throw new Error("booking failed");
    // A replayed or reordered call cannot resurrect a booking.
    expect(
      isErr(
        fixture.store.updateMeetingState({
          meetingId: created.value.id,
          actorUserId: fixture.ownerId,
          state: "approved",
          approvedBy: fixture.ownerId,
          approvedAt: "2026-11-01T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("requires a cancellation to record when and why", () => {
    const fixture = meetingFixture();
    const created = meetingFor(fixture);
    if (!isOk(created)) throw new Error("seed meeting failed");
    const noReason = fixture.store.updateMeetingState({
      meetingId: created.value.id,
      actorUserId: fixture.ownerId,
      state: "cancelled",
      cancelledAt: "2026-11-01T00:00:00.000Z",
    });
    expect(isErr(noReason)).toBe(true);
    const cancelled = fixture.store.updateMeetingState({
      meetingId: created.value.id,
      actorUserId: fixture.ownerId,
      state: "cancelled",
      cancelledAt: "2026-11-01T00:00:00.000Z",
      decisionReason: "Not the right account",
    });
    if (!isOk(cancelled)) throw new Error("cancellation failed");
    expect(cancelled.value.decisionReason).toBe("Not the right account");
  });

  it("writes an append-only trail and refuses an event for a foreign meeting", () => {
    const fixture = meetingFixture();
    const created = meetingFor(fixture);
    if (!isOk(created)) throw new Error("seed meeting failed");
    const written = fixture.store.createMeetingEvent({
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.ownerId,
      event: { meetingId: created.value.id, kind: "recommended", detail: "positive intent" },
    });
    if (!isOk(written)) throw new Error("event failed");
    const trail = fixture.store.listMeetingEvents(created.value.id, fixture.ownerId);
    if (!isOk(trail)) throw new Error("trail failed");
    expect(trail.value).toHaveLength(1);

    const stranger = "no-membership-here";
    expect(isErr(fixture.store.getMeeting(created.value.id, stranger))).toBe(true);
    expect(isErr(fixture.store.listMeetingEvents(created.value.id, stranger))).toBe(true);
    expect(isErr(fixture.store.listMeetings(fixture.workspaceId, stranger))).toBe(true);
  });

  it("versions briefs instead of rewriting the first one", () => {
    const fixture = meetingFixture();
    const created = meetingFor(fixture);
    if (!isOk(created)) throw new Error("seed meeting failed");
    const brief = {
      meetingId: created.value.id,
      rendererVersion: "brief-1.0.0",
      accountId: fixture.accountId,
      contactId: fixture.contactId,
      qualificationId: fixture.qualificationId,
      qualificationScore: 82,
      classificationId: fixture.classificationId,
      intent: "positive_intent" as const,
      claimIds: [],
      evidenceIds: [],
      conversationExcerpt: "Happy to chat, book a call.",
      gaps: ["No evidence backs this account."],
    };
    const first = fixture.store.createMeetingBrief({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      brief,
    });
    if (!isOk(first)) throw new Error("first brief failed");
    const second = fixture.store.createMeetingBrief({
      workspaceId: fixture.workspaceId,
      createdBy: fixture.ownerId,
      brief,
    });
    if (!isOk(second)) throw new Error("second brief failed");
    expect(first.value.version).toBe(1);
    expect(second.value.version).toBe(2);
    const all = fixture.store.listMeetingBriefs(created.value.id, fixture.ownerId);
    if (!isOk(all)) throw new Error("list failed");
    // A person may have read the first before the second was rendered.
    expect(all.value).toHaveLength(2);
  });

  it("migrates a Phase 12 document forward without touching a single conversation row", () => {
    const fixture = meetingFixture();
    const document = JSON.parse(JSON.stringify(fixture.store.db)) as typeof fixture.store.db;
    const phase12 = {
      ...document,
      schemaVersion: 12,
      meetings: undefined,
      meetingBriefs: undefined,
      meetingEvents: undefined,
    };

    const migrated = migrateState(phase12 as unknown as Parameters<typeof migrateState>[0]);
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.meetings).toEqual([]);
    expect(migrated.meetingBriefs).toEqual([]);
    expect(migrated.meetingEvents).toEqual([]);
    // Every earlier table is carried over byte for byte, including the response
    // this phase was built to read.
    expect(migrated.inboundMessages).toEqual(document.inboundMessages);
    expect(migrated.conversationClassifications).toEqual(document.conversationClassifications);
    expect(migrated.conversationEvents).toEqual(document.conversationEvents);
    expect(migrated.qualifications).toEqual(document.qualifications);
    expect(migrated.outboundActions).toEqual(document.outboundActions);
  });
});
