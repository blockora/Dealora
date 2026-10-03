import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";
import type { Account, AccountClaim, Evidence, ResearchFinding, User } from "@dealora/db";

import { EvidenceService } from "./service.js";
import { createEvidenceService } from "./factory.js";
import type { EvidenceError, EvidenceRepository } from "./types.js";
import {
  ACCOUNT_CLAIM_LIFECYCLE,
  EVIDENCE_LIFECYCLE,
  canTransitionClaim,
  canTransitionEvidence,
  claimKey,
  isContradiction,
  isPermittedSourceKind,
  isSelfAttributableSource,
  normalizeReference,
  normalizeUserEvidence,
} from "./validation.js";

const NOW = () => new Date("2026-10-03T12:00:00.000Z");

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

function makeAccount(store: Store, workspaceId: string, userId: string, name: string): Account {
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
}

/** A completed research run, so a finding exists to convert. */
function seedFinding(
  store: Store,
  workspaceId: string,
  userId: string,
  accountId: string,
  overrides: Partial<{
    field: string;
    value: string;
    sourceUrl: string | null;
    observedAt: string | null;
    freshness: ResearchFinding["freshness"];
    source: ResearchFinding["source"];
    sourceName: string;
  }> = {},
): ResearchFinding {
  const request = store.createResearchRequest({
    workspaceId,
    requestedBy: userId,
    accountId,
    provider: overrides.sourceName ?? "permitted_public_site",
    categories: ["company_overview"],
  });
  if (!isOk(request)) throw new Error("seed research request failed");
  const finding = store.createResearchFinding({
    researchRequestId: request.value.id,
    createdBy: userId,
    finding: {
      category: "company_overview",
      field: overrides.field ?? "website",
      value: overrides.value ?? "https://northwind.example",
      claimKind: "fact",
      source: overrides.source ?? "public_web",
      sourceName: overrides.sourceName ?? "permitted_public_site",
      sourceUrl:
        overrides.sourceUrl === undefined ? "https://northwind.example" : overrides.sourceUrl,
      sourceTitle: "About page",
      observedAt:
        overrides.observedAt === undefined ? "2026-09-01T00:00:00.000Z" : overrides.observedAt,
      retrievedAt: "2026-10-01T00:00:00.000Z",
      confidence: "medium",
      freshness: overrides.freshness ?? "recent",
      relevance: "high",
      note: null,
      status: "recorded",
    },
  });
  if (!isOk(finding)) throw new Error("seed research finding failed");
  return finding.value;
}

function service(store: Store, clock: () => Date = NOW): EvidenceService {
  return new EvidenceService(store as unknown as EvidenceRepository, clock);
}

/** A ready-made tenant with one account. */
function scenario(
  store: Store,
  email = "owner@example.com",
  workspaceName = "Evidence Co",
  accountName = "Northwind Trading",
): { owner: User; workspaceId: string; account: Account } {
  const owner = makeOwner(store, email);
  const workspaceId = makeWorkspace(store, owner.id, workspaceName);
  const account = makeAccount(store, workspaceId, owner.id, accountName);
  return { owner, workspaceId, account };
}

describe("evidence vocabulary", () => {
  it("keys a claim by category and field", () => {
    expect(claimKey("company_overview", "website")).toBe("company_overview:website");
  });

  it("permits only the source kinds DEALORA_BLUEPRINT.md §43 allows", () => {
    expect(isPermittedSourceKind("account_record")).toBe(true);
    expect(isPermittedSourceKind("approved_api")).toBe(true);
    expect(isPermittedSourceKind("public_web")).toBe(true);
    expect(isPermittedSourceKind("linkedin_scrape")).toBe(false);
    expect(isPermittedSourceKind(42)).toBe(false);
    // Only the workspace's own record is self-describing.
    expect(isSelfAttributableSource("account_record")).toBe(true);
    expect(isSelfAttributableSource("approved_api")).toBe(false);
    expect(isSelfAttributableSource("public_web")).toBe(false);
  });

  it("never constructs a source reference", () => {
    expect(normalizeReference(undefined)).toEqual({ url: null, error: null });
    expect(normalizeReference("")).toEqual({ url: null, error: null });
    expect(normalizeReference(null)).toEqual({ url: null, error: null });
    expect(normalizeReference("https://northwind.example/about").url).toBe(
      "https://northwind.example/about",
    );
    expect(normalizeReference("not a url").error).not.toBeNull();
    expect(normalizeReference("javascript:alert(1)").error).not.toBeNull();
    expect(normalizeReference(42).error).not.toBeNull();
  });

  it("treats a disagreement as a contradiction and agreement as support", () => {
    const claim = { value: "50 employees" } as unknown as AccountClaim;
    expect(isContradiction(claim, "120 employees")).toBe(true);
    expect(isContradiction(claim, "50 employees")).toBe(false);
  });

  it("keeps superseded and rejected terminal, and contradictions resolvable only by naming a replacement", () => {
    expect(EVIDENCE_LIFECYCLE.recorded).toEqual(["superseded", "contradicted", "rejected"]);
    expect(EVIDENCE_LIFECYCLE.superseded).toEqual([]);
    expect(EVIDENCE_LIFECYCLE.rejected).toEqual([]);
    // The one edge out of a contradiction, and it requires a named
    // replacement rather than asserting the conflict away.
    expect(EVIDENCE_LIFECYCLE.contradicted).toEqual(["superseded"]);
    expect(canTransitionEvidence("recorded", "contradicted")).toBe(true);
    expect(canTransitionEvidence("contradicted", "recorded")).toBe(false);
    expect(canTransitionEvidence("superseded", "recorded")).toBe(false);
    expect(canTransitionEvidence("rejected", "recorded")).toBe(false);
  });

  it("never lets a contested claim quietly become uncontested", () => {
    expect(canTransitionClaim("asserted", "contested")).toBe(true);
    expect(canTransitionClaim("asserted", "retracted")).toBe(true);
    expect(canTransitionClaim("contested", "retracted")).toBe(true);
    // The missing edge is the point: no automatic truth resolution.
    expect(canTransitionClaim("contested", "asserted")).toBe(false);
    expect(ACCOUNT_CLAIM_LIFECYCLE.retracted).toEqual([]);
    expect(canTransitionClaim("retracted", "asserted")).toBe(false);
  });
});

describe("user-supplied evidence validation", () => {
  const valid = {
    category: "company_overview",
    field: "employee_count",
    value: "120",
    claimKind: "fact",
    sourceName: "workspace account record",
    confidence: "medium",
    relevance: "high",
  };

  it("accepts a well-formed record and keeps an absent citation absent", () => {
    const { record, error } = normalizeUserEvidence({ ...valid, observedAt: null });
    expect(error).toBeNull();
    expect(record?.sourceUrl).toBeNull();
    expect(record?.observedAt).toBeNull();
  });

  it("rejects every malformed field", () => {
    const cases: [unknown, string][] = [
      [{ ...valid, category: "buying_intent" }, "category"],
      [{ ...valid, category: "icp_fit" }, "category"],
      [{ ...valid, field: "" }, "field"],
      [{ ...valid, field: "Employee Count" }, "field"],
      [{ ...valid, value: "" }, "value"],
      [{ ...valid, value: "x".repeat(2001) }, "value"],
      [{ ...valid, claimKind: "verified" }, "claimKind"],
      [{ ...valid, sourceName: "" }, "sourceName"],
      [{ ...valid, sourceUrl: "not-a-url" }, "sourceUrl"],
      [{ ...valid, observedAt: "last tuesday" }, "observedAt"],
      [{ ...valid, confidence: "very_high" }, "confidence"],
      [{ ...valid, relevance: "certain" }, "relevance"],
      [{ ...valid, note: "x".repeat(1001) }, "note"],
    ];
    for (const [input, field] of cases) {
      const { record, error } = normalizeUserEvidence(input as never);
      expect(record, `expected ${field} to be rejected`).toBeNull();
      expect(error?.code).toBe("VALIDATION_ERROR");
      expect(error?.details?.some((d) => d.field === field)).toBe(true);
    }
  });
});

describe("research finding to evidence", () => {
  it("creates a claim and evidence, preserving the finding's provenance", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const finding = seedFinding(store, workspaceId, owner.id, account.id);

    const result = service(store).createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isOk(result)) throw new Error(`expected success: ${result.error.message}`);

    // The claim states the source's assertion and nothing more.
    expect(result.value.claim.category).toBe("company_overview");
    expect(result.value.claim.field).toBe("website");
    expect(result.value.claim.value).toBe(finding.value);
    expect(result.value.claim.claimKind).toBe("fact");
    expect(result.value.claim.status).toBe("asserted");
    expect(result.value.claim.workspaceId).toBe(workspaceId);
    expect(result.value.claim.accountId).toBe(account.id);

    // The evidence copies the source metadata verbatim.
    const evidence = result.value.evidence;
    expect(evidence.researchFindingId).toBe(finding.id);
    expect(evidence.provenance).toBe("research_finding");
    expect(evidence.source).toBe(finding.source);
    expect(evidence.sourceName).toBe(finding.sourceName);
    expect(evidence.sourceUrl).toBe(finding.sourceUrl);
    expect(evidence.sourceTitle).toBe(finding.sourceTitle);
    expect(evidence.observedAt).toBe(finding.observedAt);
    expect(evidence.retrievedAt).toBe(finding.retrievedAt);
    expect(evidence.confidence).toBe(finding.confidence);
    expect(evidence.freshness).toBe(finding.freshness);
    expect(evidence.relevance).toBe(finding.relevance);
    expect(evidence.status).toBe("recorded");
    expect(evidence.workspaceId).toBe(workspaceId);
    expect(evidence.accountId).toBe(account.id);
  });

  it("keeps an uncited finding uncited rather than inventing a URL", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const finding = seedFinding(store, workspaceId, owner.id, account.id, {
      sourceUrl: null,
      observedAt: null,
      freshness: "unknown",
    });

    const result = service(store).createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isOk(result)) throw new Error("expected success");
    expect(result.value.evidence.sourceUrl).toBeNull();
    // And with no observation date, no currency is claimed.
    expect(result.value.evidence.observedAt).toBeNull();
  });

  it("reuses the same claim across runs instead of minting a rival one", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const first = seedFinding(store, workspaceId, owner.id, account.id);
    const second = seedFinding(store, workspaceId, owner.id, account.id);

    const evidence = service(store);
    const a = evidence.createEvidenceFromFinding(workspaceId, owner.id, first.id);
    const b = evidence.createEvidenceFromFinding(workspaceId, owner.id, second.id);
    if (!isOk(a) || !isOk(b)) throw new Error("expected success");

    expect(b.value.claim.id).toBe(a.value.claim.id);
    expect(store.db.accountClaims).toHaveLength(1);
    // Agreement is support, not a contradiction.
    expect(b.value.contradicted).toEqual([]);
    expect(b.value.evidence.status).toBe("recorded");
    expect(store.db.evidence).toHaveLength(2);
  });

  it("refuses a finding that belongs to another tenant or workspace", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store, "a@example.com", "Tenant A");
    const finding = seedFinding(store, workspaceId, owner.id, account.id);
    const intruder = makeOwner(store, "b@example.com");
    const otherWorkspace = makeWorkspace(store, intruder.id, "Tenant B");

    // Another tenant: reported as not found, never as unauthorized, so the
    // finding's existence is not revealed.
    const foreign = service(store).createEvidenceFromFinding(
      otherWorkspace,
      intruder.id,
      finding.id,
    );
    if (!isErr(foreign)) throw new Error("cross-tenant conversion was allowed");
    expect(foreign.error.code).toBe("NOT_FOUND");

    // The wrong workspace for the right caller: denied, not written.
    const mismatch = service(store).createEvidenceFromFinding(otherWorkspace, owner.id, finding.id);
    if (!isErr(mismatch)) throw new Error("cross-workspace conversion was allowed");
    expect(["NOT_FOUND", "UNAUTHORIZED"]).toContain(mismatch.error.code);

    expect(store.db.evidence).toEqual([]);
    expect(store.db.accountClaims).toEqual([]);
  });

  it("refuses a missing finding id and an unknown finding", () => {
    const store = seed();
    const { owner, workspaceId } = scenario(store);
    const evidence = service(store);

    const absent = evidence.createEvidenceFromFinding(workspaceId, owner.id, "");
    if (!isErr(absent)) throw new Error("missing id was accepted");
    expect(absent.error.code).toBe("VALIDATION_ERROR");

    const unknown = evidence.createEvidenceFromFinding(workspaceId, owner.id, "no-such-finding");
    if (!isErr(unknown)) throw new Error("unknown finding was accepted");
    expect(unknown.error.code).toBe("NOT_FOUND");
  });

  it("refuses to cite a source kind that is not permitted", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    // A source outside DEALORA_BLUEPRINT.md §43 reaching storage is a defect;
    // the conversion refuses rather than propagating it.
    const finding = seedFinding(store, workspaceId, owner.id, account.id, {
      source: "linkedin_scrape" as never,
    });

    const result = service(store).createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isErr(result)) throw new Error("an unpermitted source was cited");
    expect(result.error.code).toBe("UNSUPPORTED_SOURCE");
    expect(store.db.evidence).toEqual([]);
  });

  it("requires an authenticated caller", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const finding = seedFinding(store, workspaceId, owner.id, account.id);

    const anonymous = service(store).createEvidenceFromFinding(workspaceId, "", finding.id);
    if (!isErr(anonymous)) throw new Error("an anonymous caller was accepted");
    expect(anonymous.error.code).toBe("UNAUTHORIZED");
  });
});

describe("contradictions", () => {
  it("preserves both sides and declares no winner", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);

    const low = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "50",
      sourceName: "registry_a",
      sourceUrl: "https://registry-a.example/northwind",
    });
    const high = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "120",
      sourceName: "registry_b",
      sourceUrl: "https://registry-b.example/northwind",
      observedAt: "2026-10-02T00:00:00.000Z",
    });

    const first = evidence.createEvidenceFromFinding(workspaceId, owner.id, low.id);
    if (!isOk(first)) throw new Error("expected success");
    expect(first.value.evidence.status).toBe("recorded");
    expect(first.value.contradicted).toEqual([]);
    expect(first.value.claim.status).toBe("asserted");

    const second = evidence.createEvidenceFromFinding(workspaceId, owner.id, high.id);
    if (!isOk(second)) throw new Error("expected success");

    // The earlier record is marked, not overwritten, and keeps its own source.
    expect(second.value.contradicted).toHaveLength(1);
    expect(second.value.contradicted[0]?.id).toBe(first.value.evidence.id);
    expect(second.value.contradicted[0]?.sourceName).toBe("registry_a");
    expect(second.value.contradicted[0]?.sourceUrl).toBe("https://registry-a.example/northwind");
    // The arriving record is marked on creation, never as an unopposed fact.
    expect(second.value.evidence.status).toBe("contradicted");
    // And the claim itself is flagged rather than silently carrying one value.
    expect(second.value.claim.status).toBe("contested");
    // The claim keeps the value it was created with; the disagreement is
    // recorded on the evidence, not resolved by rewriting the assertion.
    expect(second.value.claim.value).toBe("50");

    // Both rows survive in full.
    expect(store.db.evidence).toHaveLength(2);
    expect(store.db.evidence.every((e) => e.status === "contradicted")).toBe(true);
  });

  it("does not let a contradicted record be returned to recorded", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const low = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "50",
      sourceName: "registry_a",
    });
    const high = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "120",
      sourceName: "registry_b",
    });
    evidence.createEvidenceFromFinding(workspaceId, owner.id, low.id);
    const second = evidence.createEvidenceFromFinding(workspaceId, owner.id, high.id);
    if (!isOk(second)) throw new Error("expected success");

    const reverted = evidence.changeEvidenceStatus(second.value.evidence.id, owner.id, "recorded");
    if (!isErr(reverted)) throw new Error("a contradicted record was un-contradicted");
    expect(reverted.error.code).toBe("INVALID_TRANSITION");
  });

  it("does not let a contested claim be quietly un-contested", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const low = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "50",
      sourceName: "registry_a",
    });
    const high = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "120",
      sourceName: "registry_b",
    });
    evidence.createEvidenceFromFinding(workspaceId, owner.id, low.id);
    const second = evidence.createEvidenceFromFinding(workspaceId, owner.id, high.id);
    if (!isOk(second)) throw new Error("expected success");

    const reverted = evidence.changeAccountClaimStatus(second.value.claim.id, owner.id, "asserted");
    if (!isErr(reverted)) throw new Error("a contested claim was un-contested");
    expect(reverted.error.code).toBe("INVALID_TRANSITION");
  });
});

describe("supersession and history", () => {
  it("marks the older record superseded without erasing it", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const oldFinding = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "50",
      sourceName: "registry_a",
      sourceUrl: "https://registry-a.example/northwind",
    });
    const newFinding = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "120",
      sourceName: "registry_b",
      sourceUrl: "https://registry-b.example/northwind",
    });
    const first = evidence.createEvidenceFromFinding(workspaceId, owner.id, oldFinding.id);
    if (!isOk(first)) throw new Error("expected success");
    const second = evidence.createEvidenceFromFinding(workspaceId, owner.id, newFinding.id);
    if (!isOk(second)) throw new Error("expected success");

    const superseded = evidence.supersedeEvidence(
      first.value.evidence.id,
      owner.id,
      second.value.evidence.id,
    );
    if (!isOk(superseded)) throw new Error(`expected success: ${superseded.error.message}`);

    expect(superseded.value.superseded.status).toBe("superseded");
    // The old observation is history, not a deletion: it keeps its own value,
    // source and timestamps, and it is still retrievable.
    expect(superseded.value.superseded.sourceName).toBe("registry_a");
    expect(superseded.value.superseded.sourceUrl).toBe("https://registry-a.example/northwind");
    expect(superseded.value.superseded.retrievedAt).toBe(first.value.evidence.retrievedAt);
    const reread = evidence.getEvidence(first.value.evidence.id, owner.id);
    if (!isOk(reread)) throw new Error("superseded evidence became unreadable");
    expect(reread.value.status).toBe("superseded");
    expect(store.db.evidence).toHaveLength(2);
  });

  it("never supersedes automatically by age", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const older = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "50",
      sourceName: "registry_a",
      observedAt: "2020-01-01T00:00:00.000Z",
    });
    const newer = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "120",
      sourceName: "registry_b",
      observedAt: "2026-10-02T00:00:00.000Z",
    });
    const a = evidence.createEvidenceFromFinding(workspaceId, owner.id, older.id);
    const b = evidence.createEvidenceFromFinding(workspaceId, owner.id, newer.id);
    if (!isOk(a) || !isOk(b)) throw new Error("expected success");

    // A far newer observation contradicting an old one is a *contradiction*,
    // not a supersession: the decision is the workspace's to make.
    expect(a.value.evidence.status).toBe("contradicted");
    expect(b.value.evidence.status).toBe("contradicted");
    expect(b.value.claim.status).toBe("contested");
  });

  it("refuses to supersede across claims, itself, or a terminal record", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const size = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "120",
      sourceName: "registry_a",
    });
    const website = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "website",
      value: "https://northwind.example",
      sourceName: "registry_a",
    });
    const first = evidence.createEvidenceFromFinding(workspaceId, owner.id, size.id);
    const second = evidence.createEvidenceFromFinding(workspaceId, owner.id, website.id);
    if (!isOk(first) || !isOk(second)) throw new Error("expected success");

    // Different claims: a supersession would be a cross-wiring.
    const crossClaim = evidence.supersedeEvidence(
      first.value.evidence.id,
      owner.id,
      second.value.evidence.id,
    );
    if (!isErr(crossClaim)) throw new Error("cross-claim supersession was allowed");
    expect(crossClaim.error.code).toBe("CONFLICT");

    const itself = evidence.supersedeEvidence(
      first.value.evidence.id,
      owner.id,
      first.value.evidence.id,
    );
    if (!isErr(itself)) throw new Error("self-supersession was allowed");
    expect(itself.error.code).toBe("VALIDATION_ERROR");

    const missing = evidence.supersedeEvidence(first.value.evidence.id, owner.id, undefined);
    if (!isErr(missing)) throw new Error("a missing replacement id was accepted");
    expect(missing.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires the replacement to be named rather than inferring it", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const finding = seedFinding(store, workspaceId, owner.id, account.id);
    const created = service(store).createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isOk(created)) throw new Error("expected success");

    const bare = service(store).changeEvidenceStatus(
      created.value.evidence.id,
      owner.id,
      "superseded",
    );
    if (!isErr(bare)) throw new Error("supersession without a replacement was allowed");
    expect(bare.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a superseded record and keeps history listable", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const first = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "50",
      sourceName: "registry_a",
    });
    const second = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "120",
      sourceName: "registry_b",
    });
    const a = evidence.createEvidenceFromFinding(workspaceId, owner.id, first.id);
    const b = evidence.createEvidenceFromFinding(workspaceId, owner.id, second.id);
    if (!isOk(a) || !isOk(b)) throw new Error("expected success");
    evidence.supersedeEvidence(a.value.evidence.id, owner.id, b.value.evidence.id);

    // A superseded record is terminal: it cannot be rejected as well.
    const rejected = evidence.changeEvidenceStatus(a.value.evidence.id, owner.id, "rejected");
    if (!isErr(rejected)) throw new Error("a superseded record changed again");
    expect(rejected.error.code).toBe("INVALID_TRANSITION");

    // Nothing is hidden from the listing.
    const all = evidence.listEvidence(workspaceId, owner.id);
    if (!isOk(all)) throw new Error("listing failed");
    expect(all.value).toHaveLength(2);
    const supersededOnly = evidence.listEvidence(workspaceId, owner.id, {
      status: "superseded",
    });
    if (!isOk(supersededOnly)) throw new Error("filtered listing failed");
    expect(supersededOnly.value).toHaveLength(1);
  });

  it("rejects a recorded record on request and leaves it auditable", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const finding = seedFinding(store, workspaceId, owner.id, account.id);
    const created = service(store).createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isOk(created)) throw new Error("expected success");

    const rejected = service(store).changeEvidenceStatus(
      created.value.evidence.id,
      owner.id,
      "rejected",
    );
    if (!isOk(rejected)) throw new Error("expected success");
    expect(rejected.value.status).toBe("rejected");
    // The provenance that justified the rejection is still there.
    expect(rejected.value.sourceUrl).toBe(created.value.evidence.sourceUrl);
    expect(rejected.value.researchFindingId).toBe(finding.id);
  });

  it("rejects an unknown status outright", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const finding = seedFinding(store, workspaceId, owner.id, account.id);
    const created = service(store).createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isOk(created)) throw new Error("expected success");
    const evidence = service(store);

    for (const status of ["verified", "qualified", "scored", 42, null]) {
      const result = evidence.changeEvidenceStatus(created.value.evidence.id, owner.id, status);
      if (!isErr(result)) throw new Error(`status ${String(status)} was accepted`);
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
    // In particular, nothing can be declared verified here.
    const verified = evidence.changeEvidenceStatus(created.value.evidence.id, owner.id, "verified");
    if (!isErr(verified)) throw new Error("a verified status was accepted");
  });
});

describe("directly-supplied provenance", () => {
  it("records a user-supplied source without inventing a research request", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);

    const result = service(store).recordUserSuppliedEvidence(workspaceId, owner.id, account.id, {
      category: "company_overview",
      field: "employee_count",
      value: "120",
      claimKind: "fact",
      sourceName: "workspace account record",
      sourceUrl: null,
      observedAt: "2026-10-01T00:00:00.000Z",
      confidence: "medium",
      relevance: "high",
    });
    if (!isOk(result)) throw new Error(`expected success: ${result.error.message}`);

    expect(result.value.evidence.provenance).toBe("user_supplied");
    expect(result.value.evidence.researchFindingId).toBeNull();
    // The source kind is fixed, not caller-chosen.
    expect(result.value.evidence.source).toBe("account_record");
    expect(result.value.evidence.sourceUrl).toBeNull();
    // Freshness is temporal: a dated observation two days old is fresh.
    expect(result.value.evidence.freshness).toBe("fresh");
  });

  it("leaves freshness unknown when the source gave no observation date", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);

    const result = service(store).recordUserSuppliedEvidence(workspaceId, owner.id, account.id, {
      category: "company_overview",
      field: "employee_count",
      value: "120",
      claimKind: "fact",
      sourceName: "workspace account record",
      confidence: "medium",
      relevance: "high",
    });
    if (!isOk(result)) throw new Error("expected success");
    // High confidence does not buy currency: freshness is not confidence.
    expect(result.value.evidence.observedAt).toBeNull();
    expect(result.value.evidence.freshness).toBe("unknown");
  });

  it("rejects malformed input before anything is stored", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);

    const result = service(store).recordUserSuppliedEvidence(workspaceId, owner.id, account.id, {
      category: "buying_intent",
      field: "intent",
      value: "hot",
      claimKind: "fact",
    });
    if (!isErr(result)) throw new Error("a malformed record was stored");
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(store.db.evidence).toEqual([]);
    expect(store.db.accountClaims).toEqual([]);
  });

  it("refuses an account from another workspace", () => {
    const store = seed();
    const { account } = scenario(store, "a@example.com", "Supplied A");
    const intruder = makeOwner(store, "b@example.com");
    const otherWorkspace = makeWorkspace(store, intruder.id, "Supplied B");

    const result = service(store).recordUserSuppliedEvidence(
      otherWorkspace,
      intruder.id,
      account.id,
      {
        category: "company_overview",
        field: "employee_count",
        value: "120",
        claimKind: "fact",
        sourceName: "workspace account record",
        confidence: "medium",
        relevance: "high",
      },
    );
    if (!isErr(result)) throw new Error("a foreign account was accepted");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(store.db.evidence).toEqual([]);
  });
});

describe("retrieval, traceability and authorization", () => {
  it("lists a workspace's evidence and one claim's support", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const size = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "employee_count",
      value: "120",
      sourceName: "registry_a",
    });
    const website = seedFinding(store, workspaceId, owner.id, account.id, {
      field: "website",
      value: "https://northwind.example",
      sourceName: "registry_a",
    });
    const a = evidence.createEvidenceFromFinding(workspaceId, owner.id, size.id);
    if (!isOk(a)) throw new Error("expected success");
    const b = evidence.createEvidenceFromFinding(workspaceId, owner.id, website.id);
    if (!isOk(b)) throw new Error("expected success");

    const all = evidence.listEvidence(workspaceId, owner.id);
    if (!isOk(all)) throw new Error("listing failed");
    expect(all.value).toHaveLength(2);
    expect(all.value.every((e) => e.workspaceId === workspaceId)).toBe(true);

    // The traceability direction the phase exists for.
    const support = evidence.listEvidenceForClaim(a.value.claim.id, owner.id);
    if (!isOk(support)) throw new Error("claim evidence listing failed");
    expect(support.value).toHaveLength(1);
    expect(support.value[0]?.researchFindingId).toBe(size.id);

    const byFinding = evidence.listEvidence(workspaceId, owner.id, {
      researchFindingId: size.id,
    });
    if (!isOk(byFinding)) throw new Error("filtered listing failed");
    expect(byFinding.value).toHaveLength(1);
  });

  it("keeps every tenant's evidence to itself", () => {
    const store = seed();
    const a = scenario(store, "a@example.com", "Isolation A", "Alpha Trading");
    const b = scenario(store, "b@example.com", "Isolation B", "Beta Trading");
    const evidence = service(store);
    const findingA = seedFinding(store, a.workspaceId, a.owner.id, a.account.id);
    const findingB = seedFinding(store, b.workspaceId, b.owner.id, b.account.id);
    evidence.createEvidenceFromFinding(a.workspaceId, a.owner.id, findingA.id);
    evidence.createEvidenceFromFinding(b.workspaceId, b.owner.id, findingB.id);

    const foreignEvidence = evidence.getEvidence(
      store.db.evidence.find((e) => e.workspaceId === a.workspaceId)?.id ?? "",
      b.owner.id,
    );
    if (!isErr(foreignEvidence)) throw new Error("cross-tenant evidence read was allowed");
    expect(foreignEvidence.error.code).toBe("UNAUTHORIZED");

    const foreignClaim = evidence.getAccountClaim(
      store.db.accountClaims.find((c) => c.workspaceId === a.workspaceId)?.id ?? "",
      b.owner.id,
    );
    if (!isErr(foreignClaim)) throw new Error("cross-tenant claim read was allowed");
    expect(foreignClaim.error.code).toBe("UNAUTHORIZED");

    // Each tenant sees exactly its own half.
    expect(evidence.listEvidence(a.workspaceId, a.owner.id).ok).toBe(true);
    const bList = evidence.listEvidence(b.workspaceId, b.owner.id);
    if (!isOk(bList)) throw new Error("listing failed");
    expect(bList.value).toHaveLength(1);
    expect(bList.value[0]?.workspaceId).toBe(b.workspaceId);
  });

  it("requires authentication for every entry point", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const finding = seedFinding(store, workspaceId, owner.id, account.id);
    const created = evidence.createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isOk(created)) throw new Error("expected success");

    const denials: { ok: boolean; error?: EvidenceError }[] = [
      evidence.listEvidence(workspaceId, ""),
      evidence.listAccountClaims(workspaceId, ""),
      evidence.getEvidence(created.value.evidence.id, ""),
      evidence.getAccountClaim(created.value.claim.id, ""),
      evidence.listEvidenceForClaim(created.value.claim.id, ""),
    ];
    for (const denial of denials) {
      if (denial.ok) throw new Error("an anonymous read was allowed");
      expect(["UNAUTHORIZED", "NOT_FOUND"]).toContain(denial.error?.code);
    }
  });

  it("rejects invalid filters rather than silently ignoring them", () => {
    const store = seed();
    const { owner, workspaceId } = scenario(store);
    const evidence = service(store);

    const badEvidence = evidence.listEvidence(workspaceId, owner.id, {
      status: "verified" as never,
    });
    if (!isErr(badEvidence)) throw new Error("an invalid status filter was accepted");
    expect(badEvidence.error.code).toBe("VALIDATION_ERROR");

    const badClaim = evidence.listAccountClaims(workspaceId, owner.id, {
      status: "qualified" as never,
    });
    if (!isErr(badClaim)) throw new Error("an invalid claim status filter was accepted");
    expect(badClaim.error.code).toBe("VALIDATION_ERROR");
  });

  it("reports a retracted claim while keeping its evidence readable", () => {
    const store = seed();
    const { owner, workspaceId, account } = scenario(store);
    const evidence = service(store);
    const finding = seedFinding(store, workspaceId, owner.id, account.id);
    const created = evidence.createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isOk(created)) throw new Error("expected success");

    const retracted = evidence.changeAccountClaimStatus(
      created.value.claim.id,
      owner.id,
      "retracted",
    );
    if (!isOk(retracted)) throw new Error("expected success");
    expect(retracted.value.status).toBe("retracted");

    // The evidence that supported it is still there: a withdrawal is not a
    // deletion, and the audit trail outlives the claim.
    const support = evidence.listEvidenceForClaim(created.value.claim.id, owner.id);
    if (!isOk(support)) throw new Error("claim evidence listing failed");
    expect(support.value).toHaveLength(1);
    // And a retracted claim is terminal.
    const revived = evidence.changeAccountClaimStatus(created.value.claim.id, owner.id, "asserted");
    if (!isErr(revived)) throw new Error("a retracted claim was revived");
    expect(revived.error.code).toBe("INVALID_TRANSITION");
  });
});

describe("determinism", () => {
  it("produces identical evidence for identical input and clock", () => {
    const build = (): Pick<Evidence, "source" | "sourceName" | "freshness" | "confidence"> => {
      const store = seed();
      const { owner, workspaceId, account } = scenario(store);
      const result = service(store).recordUserSuppliedEvidence(workspaceId, owner.id, account.id, {
        category: "company_overview",
        field: "employee_count",
        value: "120",
        claimKind: "fact",
        sourceName: "workspace account record",
        observedAt: "2026-09-20T00:00:00.000Z",
        confidence: "medium",
        relevance: "high",
      });
      if (!isOk(result)) throw new Error("expected success");
      const record = result.value.evidence;
      return {
        source: record.source,
        sourceName: record.sourceName,
        freshness: record.freshness,
        confidence: record.confidence,
      };
    };
    expect(build()).toEqual(build());
  });

  it("binds to the default store through the factory", () => {
    const store = seed();
    const bound = createEvidenceService(store as unknown as EvidenceRepository, NOW);
    const owner = makeOwner(store);
    const workspaceId = makeWorkspace(store, owner.id, "Factory Co");
    const account = makeAccount(store, workspaceId, owner.id, "Factory Trading");
    const finding = seedFinding(store, workspaceId, owner.id, account.id);

    const result = bound.createEvidenceFromFinding(workspaceId, owner.id, finding.id);
    if (!isOk(result)) throw new Error("expected success");
    expect(result.value.evidence.accountId).toBe(account.id);
  });
});
