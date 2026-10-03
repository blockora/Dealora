import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";

import { BusinessBrainService } from "./service.js";
import type { BrainRepository } from "./service.js";
import type { BusinessContext } from "./types.js";

/**
 * Two tenants in one store, so isolation is exercised for real rather than
 * with two unrelated fixtures.
 */
function fixture(): {
  service: BusinessBrainService;
  store: Store;
  userA: string;
  workspaceA: string;
  userB: string;
  workspaceB: string;
} {
  const store = new Store(emptyState());
  const service = new BusinessBrainService(store as unknown as BrainRepository);

  const userAResult = store.createUser({
    email: "a@example.com",
    password: "correct-horse-battery",
    displayName: "Owner A",
  });
  if (!isOk(userAResult)) throw new Error("fixture user A failed");
  const userBResult = store.createUser({
    email: "b@example.com",
    password: "correct-horse-battery",
    displayName: "Owner B",
  });
  if (!isOk(userBResult)) throw new Error("fixture user B failed");

  const wsAResult = store.createWorkspace({ ownerId: userAResult.value.id, name: "Acme" });
  if (!isOk(wsAResult)) throw new Error("fixture workspace A failed");
  const wsBResult = store.createWorkspace({ ownerId: userBResult.value.id, name: "Globex" });
  if (!isOk(wsBResult)) throw new Error("fixture workspace B failed");

  return {
    service,
    store,
    userA: userAResult.value.id,
    workspaceA: wsAResult.value.id,
    userB: userBResult.value.id,
    workspaceB: wsBResult.value.id,
  };
}

describe("Business Brain — company", () => {
  it("creates and retrieves the company context", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.upsertCompany(workspaceA, userA, {
      name: "Acme Corp",
      description: "Automation agency",
      website: "https://acme.example",
      type: "agency",
      market: "B2B services",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.value.name).toBe("Acme Corp");
    expect(created.value.market).toBe("B2B services");

    const read = service.getCompany(workspaceA, userA);
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.value?.description).toBe("Automation agency");
  });

  it("updates the single canonical company record rather than adding another", () => {
    const { service, userA, workspaceA } = fixture();
    const first = service.upsertCompany(workspaceA, userA, {
      name: "Acme Corp",
      description: "Automation agency",
    });
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const second = service.upsertCompany(workspaceA, userA, {
      name: "Acme Corporation",
      description: "Revenue automation agency",
    });
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.name).toBe("Acme Corporation");
  });

  it("rejects a missing name or description", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.upsertCompany(workspaceA, userA, { description: "No name" });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details?.some((d) => d.field === "name")).toBe(true);
    }
  });

  it("rejects a non-http website", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.upsertCompany(workspaceA, userA, {
      name: "Acme",
      description: "Agency",
      website: "javascript:alert(1)",
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects oversized input", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.upsertCompany(workspaceA, userA, {
      name: "A".repeat(5000),
      description: "Agency",
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Business Brain — offers", () => {
  it("creates, lists and updates an offer", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createOffer(workspaceA, userA, {
      name: "Support automation",
      description: "Automates inbound support",
      problemSolved: "Slow first response",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.value.status).toBe("draft");

    const listed = service.listOffers(workspaceA, userA);
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(1);

    const updated = service.updateOffer(created.value.id, userA, { status: "active" });
    expect(isOk(updated)).toBe(true);
    if (!isOk(updated)) return;
    expect(updated.value.status).toBe("active");
  });

  it("rejects an invalid status enum", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createOffer(workspaceA, userA, {
      name: "Offer",
      description: "Description",
      status: "published",
    });
    expect(isErr(created)).toBe(true);
    if (isErr(created)) expect(created.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid pricing model and inverted amounts", () => {
    const { service, userA, workspaceA } = fixture();
    const badModel = service.createOffer(workspaceA, userA, {
      name: "Offer",
      description: "Description",
      pricing: { model: "free_money" },
    });
    expect(isErr(badModel)).toBe(true);

    const inverted = service.createOffer(workspaceA, userA, {
      name: "Offer",
      description: "Description",
      pricing: { model: "recurring", amountMin: 500, amountMax: 100 },
    });
    expect(isErr(inverted)).toBe(true);
  });

  it("denies offer access across workspaces", () => {
    const { service, userA, workspaceA, userB } = fixture();
    const created = service.createOffer(workspaceA, userA, {
      name: "Private offer",
      description: "For Acme only",
    });
    expect(isOk(created)).toBe(true);

    const deniedList = service.listOffers(workspaceA, userB);
    expect(isErr(deniedList)).toBe(true);
    if (isErr(deniedList)) expect(deniedList.error.code).toBe("UNAUTHORIZED");

    if (!isOk(created)) return;
    const deniedGet = service.getOffer(created.value.id, userB);
    expect(isErr(deniedGet)).toBe(true);
    if (isErr(deniedGet)) expect(deniedGet.error.code).toBe("UNAUTHORIZED");
  });

  it("reports a missing offer", () => {
    const { service, userA } = fixture();
    const result = service.getOffer("does-not-exist", userA);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("rejects a malformed identifier", () => {
    const { service, userA } = fixture();
    const result = service.updateOffer("", userA, { status: "active" });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Business Brain — ICP", () => {
  it("persists and updates structured ICP data", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.upsertIcp(workspaceA, userA, {
      industries: ["SaaS"],
      companySizes: ["10-200"],
      geographies: ["US"],
      businessModels: ["subscription"],
      characteristics: ["hiring support staff"],
      disqualifiers: ["pre-revenue"],
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    const id = created.value.id;

    const updated = service.upsertIcp(workspaceA, userA, { industries: ["SaaS", "Agency"] });
    expect(isOk(updated)).toBe(true);
    if (!isOk(updated)) return;
    expect(updated.value.id).toBe(id);
    expect(updated.value.industries).toEqual(["SaaS", "Agency"]);
    expect(updated.value.disqualifiers).toEqual(["pre-revenue"]);

    const read = service.getIcp(workspaceA, userA);
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.value?.characteristics).toEqual(["hiring support staff"]);
  });

  it("rejects a non-array list value", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.upsertIcp(workspaceA, userA, { industries: "SaaS" });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("denies ICP access across workspaces", () => {
    const { service, userA, workspaceA, userB } = fixture();
    service.upsertIcp(workspaceA, userA, { industries: ["SaaS"] });
    const denied = service.getIcp(workspaceA, userB);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");
  });
});

describe("Business Brain — personas", () => {
  it("persists, lists and updates personas", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createPersona(workspaceA, userA, {
      title: "Head of Support",
      responsibilities: ["Owns support quality"],
      painPoints: ["Slow first response"],
      goals: ["Reduce response time"],
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const listed = service.listPersonas(workspaceA, userA);
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(1);

    const updated = service.updatePersona(created.value.id, userA, {
      buyingContext: "Quarterly planning",
    });
    expect(isOk(updated)).toBe(true);
    if (!isOk(updated)) return;
    expect(updated.value.buyingContext).toBe("Quarterly planning");
  });

  it("requires a title", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.createPersona(workspaceA, userA, { painPoints: ["Something"] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("denies persona access across workspaces", () => {
    const { service, userA, workspaceA, userB } = fixture();
    const created = service.createPersona(workspaceA, userA, { title: "CTO" });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const denied = service.updatePersona(created.value.id, userB, { title: "CEO" });
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");
  });
});

describe("Business Brain — positioning and brand voice", () => {
  it("persists and updates positioning", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.upsertPositioning(workspaceA, userA, {
      statement: "We automate support for B2B SaaS",
      differentiators: ["Domain-specific playbooks"],
      approvedValuePropositions: ["Cut first response time"],
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const updated = service.upsertPositioning(workspaceA, userA, {
      statement: "We automate support for B2B SaaS and agencies",
    });
    expect(isOk(updated)).toBe(true);
    if (!isOk(updated)) return;
    expect(updated.value.id).toBe(created.value.id);
    // Omitted fields are preserved, not wiped.
    expect(updated.value.differentiators).toEqual(["Domain-specific playbooks"]);
  });

  it("requires a positioning statement", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.upsertPositioning(workspaceA, userA, { differentiators: ["Fast"] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("persists brand voice guidance including constraints", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.upsertBrandVoice(workspaceA, userA, {
      tone: ["direct", "specific"],
      style: "Short sentences",
      terminology: ["first response time"],
      constraints: ["Never promise a specific percentage improvement"],
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.value.constraints).toHaveLength(1);

    const read = service.getBrandVoice(workspaceA, userA);
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.value?.tone).toEqual(["direct", "specific"]);
  });

  it("rejects brand voice without a tone", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.upsertBrandVoice(workspaceA, userA, { style: "Formal" });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("denies positioning and brand voice access across workspaces", () => {
    const { service, userA, workspaceA, userB } = fixture();
    service.upsertPositioning(workspaceA, userA, { statement: "A statement" });
    service.upsertBrandVoice(workspaceA, userA, { tone: ["calm"] });

    const positioning = service.getPositioning(workspaceA, userB);
    const voice = service.getBrandVoice(workspaceA, userB);
    expect(isErr(positioning)).toBe(true);
    expect(isErr(voice)).toBe(true);
    if (isErr(positioning)) expect(positioning.error.code).toBe("UNAUTHORIZED");
    if (isErr(voice)) expect(voice.error.code).toBe("UNAUTHORIZED");
  });
});

describe("Business Brain — claim safety", () => {
  it("refuses to create a claim as approved", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.createClaim(workspaceA, userA, {
      text: "We doubled response time for 40 clients",
      category: "result",
      status: "approved",
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      // The rejected field is reported as structured detail, not prose.
      expect(result.error.details?.some((d) => d.field === "status")).toBe(true);
    }
  });

  it("defaults new claims to unverified", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createClaim(workspaceA, userA, {
      text: "SOC 2 Type II certified",
      category: "certification",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.value.status).toBe("unverified");
    expect(created.value.approvedBy).toBeNull();
    expect(created.value.approvedAt).toBeNull();
  });

  it("approves a claim through an explicit attributed action", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createClaim(workspaceA, userA, {
      text: "SOC 2 Type II certified",
      category: "certification",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const approved = service.approveClaim(created.value.id, userA);
    expect(isOk(approved)).toBe(true);
    if (!isOk(approved)) return;
    expect(approved.value.status).toBe("approved");
    expect(approved.value.approvedBy).toBe(userA);
    expect(approved.value.approvedAt).not.toBeNull();
  });

  it("revokes approval when the wording changes", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createClaim(workspaceA, userA, {
      text: "Trusted by 40 clients",
      category: "result",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(isOk(service.approveClaim(created.value.id, userA))).toBe(true);

    const edited = service.updateClaim(created.value.id, userA, {
      text: "Trusted by 4000 clients",
    });
    expect(isOk(edited)).toBe(true);
    if (!isOk(edited)) return;
    expect(edited.value.status).toBe("unverified");
    expect(edited.value.approvedBy).toBeNull();
  });

  it("keeps approval when only metadata changes", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createClaim(workspaceA, userA, {
      text: "Trusted by 40 clients",
      category: "result",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(isOk(service.approveClaim(created.value.id, userA))).toBe(true);

    const noted = service.updateClaim(created.value.id, userA, {
      sourceNote: "Reference available on request",
    });
    expect(isOk(noted)).toBe(true);
    if (!isOk(noted)) return;
    expect(noted.value.status).toBe("approved");
  });

  it("refuses to set approved through a generic update", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createClaim(workspaceA, userA, {
      text: "A claim",
      category: "other",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const attempted = service.updateClaim(created.value.id, userA, { status: "approved" });
    expect(isErr(attempted)).toBe(true);
    if (isErr(attempted)) expect(attempted.error.code).toBe("VALIDATION_ERROR");
  });

  it("supports restricting a claim", () => {
    const { service, userA, workspaceA } = fixture();
    const created = service.createClaim(workspaceA, userA, {
      text: "We guarantee a 10x return",
      category: "guarantee",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const restricted = service.updateClaim(created.value.id, userA, { status: "restricted" });
    expect(isOk(restricted)).toBe(true);
    if (!isOk(restricted)) return;
    expect(restricted.value.status).toBe("restricted");
  });

  it("filters claims by status", () => {
    const { service, userA, workspaceA } = fixture();
    const approved = service.createClaim(workspaceA, userA, {
      text: "Approved claim",
      category: "capability",
    });
    expect(isOk(approved)).toBe(true);
    if (!isOk(approved)) return;
    service.approveClaim(approved.value.id, userA);
    service.createClaim(workspaceA, userA, {
      text: "Restricted claim",
      category: "guarantee",
      status: "restricted",
    });

    const filtered = service.listClaims(workspaceA, userA, { status: "approved" });
    expect(isOk(filtered)).toBe(true);
    if (!isOk(filtered)) return;
    expect(filtered.value).toHaveLength(1);
    expect(filtered.value[0]?.status).toBe("approved");
  });

  it("rejects an invalid status filter", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.listClaims(workspaceA, userA, {
      status: "verified" as "approved",
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("denies claim access and approval across workspaces", () => {
    const { service, userA, workspaceA, userB } = fixture();
    const created = service.createClaim(workspaceA, userA, {
      text: "Private claim",
      category: "other",
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const deniedList = service.listClaims(workspaceA, userB);
    expect(isErr(deniedList)).toBe(true);
    if (isErr(deniedList)) expect(deniedList.error.code).toBe("UNAUTHORIZED");

    const deniedApprove = service.approveClaim(created.value.id, userB);
    expect(isErr(deniedApprove)).toBe(true);
    if (isErr(deniedApprove)) expect(deniedApprove.error.code).toBe("UNAUTHORIZED");
  });
});

describe("Business Brain — agent-facing context", () => {
  function seedFullContext(): {
    service: BusinessBrainService;
    userA: string;
    workspaceA: string;
    userB: string;
    workspaceB: string;
  } {
    const base = fixture();
    const { service, userA, workspaceA } = base;

    service.upsertCompany(workspaceA, userA, {
      name: "Acme Corp",
      description: "Automation agency",
      market: "B2B services",
    });
    service.createOffer(workspaceA, userA, {
      name: "Support automation",
      description: "Automates inbound support",
      status: "active",
      pricing: {
        model: "recurring",
        amountMin: 2000,
        amountMax: 5000,
        currency: "USD",
        notes: null,
        approved: true,
      },
    });
    service.createOffer(workspaceA, userA, {
      name: "Advisory",
      description: "Advisory retainer",
      pricing: {
        model: "recurring",
        amountMin: 9000,
        amountMax: 9000,
        currency: "USD",
        notes: null,
        approved: false,
      },
    });
    service.upsertIcp(workspaceA, userA, { industries: ["SaaS"] });
    service.createPersona(workspaceA, userA, { title: "Head of Support" });
    service.upsertPositioning(workspaceA, userA, { statement: "Revenue automation" });
    service.upsertBrandVoice(workspaceA, userA, { tone: ["direct"] });

    const approved = service.createClaim(workspaceA, userA, {
      text: "SOC 2 Type II certified",
      category: "certification",
    });
    if (isOk(approved)) service.approveClaim(approved.value.id, userA);
    service.createClaim(workspaceA, userA, {
      text: "Loved by 5000 companies",
      category: "result",
    });
    service.createClaim(workspaceA, userA, {
      text: "Never disclose our pricing floor",
      category: "other",
      status: "restricted",
    });

    return base;
  }

  it("returns a structured, deterministic snapshot", () => {
    const { service, userA, workspaceA } = seedFullContext();
    const result = service.getBusinessContext(workspaceA, userA);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const context: BusinessContext = result.value;

    expect(context.workspaceId).toBe(workspaceA);
    expect(context.company?.name).toBe("Acme Corp");
    expect(context.offers).toHaveLength(2);
    expect(context.icp?.industries).toEqual(["SaaS"]);
    expect(context.personas).toHaveLength(1);
    expect(context.positioning?.statement).toBe("Revenue automation");
    expect(context.brandVoice?.tone).toEqual(["direct"]);

    // Repeated calls return the same shape — no hidden nondeterminism.
    const again = service.getBusinessContext(workspaceA, userA);
    expect(isOk(again)).toBe(true);
    if (isOk(again)) expect(JSON.stringify(again.value)).toBe(JSON.stringify(context));
  });

  it("withholds pricing that the business has not approved", () => {
    const { service, userA, workspaceA } = seedFullContext();
    const result = service.getBusinessContext(workspaceA, userA);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [approvedOffer, unapprovedOffer] = result.value.offers;

    // Only the explicitly approved pricing is exposed as a fact.
    expect(approvedOffer?.pricing?.amountMin).toBe(2000);
    expect(unapprovedOffer?.pricing).toBeNull();

    // The withheld floor price must not appear anywhere in the snapshot.
    // Asserted on the pricing numbers themselves: a substring scan of the
    // whole context also matches random ids, and failed intermittently when a
    // generated claim id happened to contain "9000".
    const exposedAmounts = result.value.offers.flatMap((offer) =>
      offer.pricing ? [offer.pricing.amountMin, offer.pricing.amountMax] : [],
    );
    expect(exposedAmounts).toEqual([2000, 5000]);
  });

  it("groups claims by approval status", () => {
    const { service, userA, workspaceA } = seedFullContext();
    const result = service.getBusinessContext(workspaceA, userA);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.claims.approved).toHaveLength(1);
    expect(result.value.claims.unverified).toHaveLength(1);
    expect(result.value.claims.restricted).toHaveLength(1);
    expect(result.value.claims.approved[0]?.text).toBe("SOC 2 Type II certified");
  });

  it("denies the context across workspaces", () => {
    const { service, workspaceA, userB, workspaceB } = seedFullContext();
    const denied = service.getBusinessContext(workspaceA, userB);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");

    // The caller's own workspace still resolves.
    const own = service.getBusinessContext(workspaceB, userB);
    expect(isOk(own)).toBe(true);
  });

  it("returns an empty but valid context before any data exists", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.getBusinessContext(workspaceA, userA);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.company).toBeNull();
    expect(result.value.offers).toEqual([]);
    expect(result.value.icp).toBeNull();
    expect(result.value.claims.approved).toEqual([]);
  });

  it("rejects a missing workspace or user", () => {
    const { service, userA, workspaceA } = fixture();
    expect(isErr(service.getBusinessContext("", userA))).toBe(true);
    expect(isErr(service.getBusinessContext(workspaceA, ""))).toBe(true);
  });
});

describe("Business Brain — storage failure", () => {
  it("maps an unavailable store to a safe error without leaking internals", () => {
    const brokenRepo = {
      authorize: () => ({ ok: true as const, value: {} }),
      getBusinessProfileFor: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
    } as unknown as BrainRepository;

    const service = new BusinessBrainService(brokenRepo);
    const result = service.getCompany("w1", "u1");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("UNAVAILABLE");
      expect(result.error.message).toBe("storage unavailable");
      // No internal detail or stack information is surfaced.
      expect(JSON.stringify(result.error)).not.toContain("stack");
    }
  });
});
