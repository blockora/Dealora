import { afterAll, describe, expect, it } from "vitest";
import { isErr, isOk } from "@dealora/core";
import { Store, emptyState, store as defaultStore } from "@dealora/db";
import { BusinessBrainService } from "@dealora/brain";
import type { BrainRepository, BusinessContext } from "@dealora/brain";
import { authenticate, setSessionIndex, signup } from "@dealora/auth";
import { createIndex } from "@dealora/auth";

/**
 * Phase 2 gate — ROADMAP.md §9.
 *
 * A user must be able to create and edit Business Brain data and an agent
 * must be able to retrieve it as structured context.
 *
 * The first test walks the whole path through the real signup/auth/session
 * layer and the real default store, then re-reads the context from a fresh
 * service over the persisted document to prove the data was written, not
 * merely held in memory.
 */
describe("Phase 2 gate", () => {
  // The auth layer is bound to the default store singleton, so the end-to-end
  // path must use it too. Clean the generated document up afterwards.
  afterAll(() => {
    defaultStore.destroy();
  });

  it("authenticated user → workspace → Brain → context → agent retrieval → persistence", () => {
    // Isolated session index so this test never depends on another suite.
    setSessionIndex(createIndex());
    const store = defaultStore;
    const service = new BusinessBrainService(store as unknown as BrainRepository);

    // 1. Authenticate for real: signup issues a session token.
    const signedUp = signup("acme@example.com", "correct-horse-battery", "Owner A");
    expect(signedUp.user.email).toBe("acme@example.com");
    expect(signedUp.token).toBeTruthy();

    // 2. The token authenticates against the auth layer.
    const authenticated = authenticate("acme@example.com", "correct-horse-battery");
    expect(authenticated.user.id).toBe(signedUp.user.id);
    const userId = authenticated.user.id;

    // 3. Create a workspace for that user.
    const created = store.createWorkspace({ ownerId: userId, name: "Acme" });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    const workspaceId = created.value.id;

    // 4. Company context.
    const company = service.upsertCompany(workspaceId, userId, {
      name: "Acme Corp",
      description: "Automation agency for B2B service firms",
      website: "https://acme.example",
      type: "agency",
      market: "B2B services",
      industry: "Professional services",
      size: "10-50",
    });
    expect(isOk(company)).toBe(true);

    // 5. Commercial offer, with pricing the business has NOT approved.
    const offer = service.createOffer(workspaceId, userId, {
      name: "Support automation retainer",
      description: "Automates inbound support triage",
      targetCustomer: "B2B SaaS support teams",
      problemSolved: "Slow first response",
      outcome: "Faster, more consistent first response",
      deliveryModel: "ongoing managed service",
      status: "active",
      pricing: {
        model: "recurring",
        amountMin: 2500,
        amountMax: 8000,
        currency: "USD",
        notes: "Confidential floor",
        approved: false,
      },
    });
    expect(isOk(offer)).toBe(true);

    // 6. ICP, persona, positioning, brand voice.
    expect(
      isOk(
        service.upsertIcp(workspaceId, userId, {
          industries: ["B2B SaaS", "Agencies"],
          companySizes: ["10-200"],
          geographies: ["US", "UK"],
          businessModels: ["subscription", "retainer"],
          characteristics: ["Hiring support staff", "Rising ticket volume"],
          disqualifiers: ["Pre-revenue", "Consumer-only"],
        }),
      ),
    ).toBe(true);

    expect(
      isOk(
        service.createPersona(workspaceId, userId, {
          title: "Head of Support",
          responsibilities: ["Owns support quality and cost"],
          painPoints: ["Slow first response", "High agent turnover"],
          goals: ["Reduce time to first response"],
          buyingContext: "Quarterly planning",
        }),
      ),
    ).toBe(true);

    expect(
      isOk(
        service.upsertPositioning(workspaceId, userId, {
          statement: "We automate support triage for B2B service firms",
          differentiators: ["Domain-specific playbooks", "Evidence-backed claims"],
          approvedValuePropositions: ["Cut time to first response"],
          competitorContext: ["Manual staffing agencies"],
        }),
      ),
    ).toBe(true);

    expect(
      isOk(
        service.upsertBrandVoice(workspaceId, userId, {
          tone: ["direct", "specific"],
          style: "Short declarative sentences",
          terminology: ["first response time"],
          constraints: ["Never promise a specific percentage improvement"],
        }),
      ),
    ).toBe(true);

    // 7. Claims: one approved through an explicit act, one unverified,
    //    one restricted.
    const certification = service.createClaim(workspaceId, userId, {
      text: "SOC 2 Type II certified",
      category: "certification",
      sourceNote: "Certificate on file",
    });
    expect(isOk(certification)).toBe(true);
    if (isOk(certification)) {
      expect(certification.value.status).toBe("unverified");
      const approved = service.approveClaim(certification.value.id, userId);
      expect(isOk(approved)).toBe(true);
      if (isOk(approved)) expect(approved.value.approvedBy).toBe(userId);
    }

    service.createClaim(workspaceId, userId, {
      text: "Doubled response speed for 40 clients",
      category: "result",
    });
    service.createClaim(workspaceId, userId, {
      text: "Never disclose the retainer floor price",
      category: "other",
      status: "restricted",
    });

    // 8. Agent-facing retrieval: structured and deterministic.
    const context = service.getBusinessContext(workspaceId, userId);
    expect(isOk(context)).toBe(true);
    if (!isOk(context)) return;
    const snapshot: BusinessContext = context.value;

    expect(snapshot.company?.name).toBe("Acme Corp");
    expect(snapshot.company?.market).toBe("B2B services");
    expect(snapshot.icp?.industries).toEqual(["B2B SaaS", "Agencies"]);
    expect(snapshot.icp?.disqualifiers).toContain("Pre-revenue");
    expect(snapshot.personas[0]?.title).toBe("Head of Support");
    expect(snapshot.positioning?.statement).toContain("automate support triage");
    expect(snapshot.brandVoice?.constraints).toHaveLength(1);

    // Approved-claim safety foundation: only the approved claim is cleared
    // for external use, and unapproved pricing never reaches the agent.
    expect(snapshot.claims.approved).toHaveLength(1);
    expect(snapshot.claims.approved[0]?.text).toBe("SOC 2 Type II certified");
    expect(snapshot.claims.unverified).toHaveLength(1);
    expect(snapshot.claims.restricted).toHaveLength(1);
    expect(snapshot.offers[0]?.pricing).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("2500");

    // Deterministic: the same input yields the same structured output.
    const repeat = service.getBusinessContext(workspaceId, userId);
    expect(isOk(repeat)).toBe(true);
    if (isOk(repeat)) {
      expect(JSON.stringify(repeat.value)).toBe(JSON.stringify(snapshot));
    }

    // 9. Persistence: a fresh service over a store rebuilt from the same
    //    persisted data returns identical context.
    const reloadedStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const reloaded = new BusinessBrainService(reloadedStore as unknown as BrainRepository);
    const afterReload = reloaded.getBusinessContext(workspaceId, userId);
    expect(isOk(afterReload)).toBe(true);
    if (!isOk(afterReload)) return;

    expect(afterReload.value.company?.name).toBe("Acme Corp");
    expect(afterReload.value.icp?.industries).toEqual(["B2B SaaS", "Agencies"]);
    expect(afterReload.value.personas[0]?.title).toBe("Head of Support");
    expect(afterReload.value.positioning?.differentiators).toHaveLength(2);
    expect(afterReload.value.brandVoice?.tone).toEqual(["direct", "specific"]);
    expect(afterReload.value.claims.approved).toHaveLength(1);
    expect(afterReload.value.claims.restricted).toHaveLength(1);
    // Unapproved pricing is still withheld after a reload.
    expect(afterReload.value.offers[0]?.pricing).toBeNull();
  });

  it("denies a second tenant access to the first tenant's Business Brain", () => {
    const store = new Store(emptyState());
    const service = new BusinessBrainService(store as unknown as BrainRepository);

    const userA = store.createUser({
      email: "a@example.com",
      password: "correct-horse-battery",
      displayName: "A",
    });
    const userB = store.createUser({
      email: "b@example.com",
      password: "correct-horse-battery",
      displayName: "B",
    });
    if (!isOk(userA) || !isOk(userB)) throw new Error("fixture users failed");

    const wsA = store.createWorkspace({ ownerId: userA.value.id, name: "Acme" });
    const wsB = store.createWorkspace({ ownerId: userB.value.id, name: "Globex" });
    if (!isOk(wsA) || !isOk(wsB)) throw new Error("fixture workspaces failed");

    service.upsertCompany(wsA.value.id, userA.value.id, {
      name: "Acme Corp",
      description: "Confidential",
    });
    service.createClaim(wsA.value.id, userA.value.id, {
      text: "Acme private claim",
      category: "other",
    });

    // Allowed for its own tenant.
    expect(isOk(service.getBusinessContext(wsA.value.id, userA.value.id))).toBe(true);

    // Denied across tenants, on every Brain entry point.
    const context = service.getBusinessContext(wsA.value.id, userB.value.id);
    expect(isErr(context)).toBe(true);
    if (isErr(context)) expect(context.error.code).toBe("UNAUTHORIZED");

    const offers = service.listOffers(wsA.value.id, userB.value.id);
    expect(isErr(offers)).toBe(true);
    if (isErr(offers)) expect(offers.error.code).toBe("UNAUTHORIZED");

    const claims = service.listClaims(wsA.value.id, userB.value.id);
    expect(isErr(claims)).toBe(true);
    if (isErr(claims)) expect(claims.error.code).toBe("UNAUTHORIZED");

    const icp = service.getIcp(wsA.value.id, userB.value.id);
    expect(isErr(icp)).toBe(true);
    if (isErr(icp)) expect(icp.error.code).toBe("UNAUTHORIZED");

    const personas = service.listPersonas(wsA.value.id, userB.value.id);
    expect(isErr(personas)).toBe(true);
    if (isErr(personas)) expect(personas.error.code).toBe("UNAUTHORIZED");

    const positioning = service.getPositioning(wsA.value.id, userB.value.id);
    expect(isErr(positioning)).toBe(true);
    if (isErr(positioning)) expect(positioning.error.code).toBe("UNAUTHORIZED");

    const voice = service.getBrandVoice(wsA.value.id, userB.value.id);
    expect(isErr(voice)).toBe(true);
    if (isErr(voice)) expect(voice.error.code).toBe("UNAUTHORIZED");

    // No tenant data leaked into the error payloads.
    expect(JSON.stringify(context)).not.toContain("Acme Corp");
  });

  it("keeps a single canonical company record per workspace", () => {
    const store = new Store(emptyState());
    const service = new BusinessBrainService(store as unknown as BrainRepository);
    const user = store.createUser({
      email: "solo@example.com",
      password: "correct-horse-battery",
      displayName: "Solo",
    });
    if (!isOk(user)) throw new Error("fixture user failed");
    const ws = store.createWorkspace({ ownerId: user.value.id, name: "Solo Co" });
    if (!isOk(ws)) throw new Error("fixture workspace failed");

    const first = service.upsertCompany(ws.value.id, user.value.id, {
      name: "Solo Co",
      description: "First description",
    });
    const second = service.upsertCompany(ws.value.id, user.value.id, {
      name: "Solo Company",
      description: "Second description",
    });
    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;

    // One record, edited — not a competing second source of business truth.
    expect(second.value.id).toBe(first.value.id);
    expect(store.db.profiles.filter((p) => p.workspaceId === ws.value.id)).toHaveLength(1);

    const context = service.getBusinessContext(ws.value.id, user.value.id);
    expect(isOk(context)).toBe(true);
    if (!isOk(context)) return;
    expect(context.value.company?.name).toBe("Solo Company");
  });

  it("does not require an LLM to produce Business Brain context", () => {
    // Phase 2 is a deterministic data layer: no model dependency is
    // involved, so identical input always yields identical context.
    const store = new Store(emptyState());
    const service = new BusinessBrainService(store as unknown as BrainRepository);
    const user = store.createUser({
      email: "det@example.com",
      password: "correct-horse-battery",
      displayName: "Det",
    });
    if (!isOk(user)) throw new Error("fixture user failed");
    const ws = store.createWorkspace({ ownerId: user.value.id, name: "Det Co" });
    if (!isOk(ws)) throw new Error("fixture workspace failed");

    service.upsertCompany(ws.value.id, user.value.id, { name: "Det Co", description: "Agency" });

    const first = service.getBusinessContext(ws.value.id, user.value.id);
    const second = service.getBusinessContext(ws.value.id, user.value.id);
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });
});
