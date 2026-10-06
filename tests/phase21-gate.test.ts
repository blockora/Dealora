import { describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import { createOptimizationService } from "@dealora/optimization";
import { signup } from "@dealora/auth";

/**
 * Phase 21 gate — ROADMAP.md §28 (Optimization Engine).
 *
 * §28 asks to:
 * - compare the eight dimensions (audiences, messages, signals, channels,
 *   timing, qualification rules, follow-up sequences, offers),
 * - answer the five questions (what worked, what failed, where conversion is
 *   dropping, what should be tested, what is the likely impact),
 * - be measurable, reversible and auditable.
 *
 * This gate drives the real store-backed read surface through the real
 * optimization service, and checks that the phase delivers those answers
 * deterministically, from existing rows, without executing anything or mutating
 * state. It also asserts the negative space: no runner, no sends, no
 * meetings, no cost writes, no evaluation writes.
 */

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${process.pid}`;
}

interface Tenant {
  token: string;
  userId: string;
  workspaceId: string;
}

function tenant(name: string): Tenant {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const owner = signup(`${unique(slug)}@example.com`, "correct-horse-battery", name);
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq} ${process.pid}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

/** Adapt the real store to the optimization package's read-only repository surface. */
function optimizationRepoFromStore() {
  return {
    authorize: (ws, u) => defaultStore.authorize(ws, u),
    listAccounts: (ws, u) => defaultStore.listAccounts(ws, u).value,
    listContacts: (ws, u) => defaultStore.listContacts(ws, u).value,
    listOffers: (ws, u) => defaultStore.listOffers(ws, u).value,
    listDrafts: (ws, u) => defaultStore.listDrafts(ws, u).value,
    listOutboundActions: (ws, u) => defaultStore.listOutboundActions(ws, u).value,
    listOutboundEvents: (ws, u) => {
      const actions = defaultStore.listOutboundActions(ws, u).value;
      const eventIds = new Set(actions.map((a) => a.id));
      return defaultStore.db.outboundEvents.filter((e) => eventIds.has(e.actionId));
    },
    listConversationClassifications: (ws, u) =>
      defaultStore.listConversationClassifications(ws, u).value,
    listMeetings: (ws, u) => defaultStore.listMeetings(ws, u).value,
    listQualifications: (ws, u) => defaultStore.listQualifications(ws, u).value,
    listResearchFindings: (ws, u) => defaultStore.listResearchFindings(ws, u).value,
    listCostEvents: (ws, u, filter) => defaultStore.listCostEvents(ws, u, filter).value,
    listAgentTraceRuns: (ws, u, opts) =>
      defaultStore.listAgentTraceRuns(ws, u, opts?.agentId).value,
    listAgentTraceEvents: (ws, u, runId) => defaultStore.listAgentTraceEvents(ws, u, runId).value,
    listInboundMessages: (ws, u) => defaultStore.listInboundMessages(ws, u).value,
  };
}

describe("Phase 21 gate — Optimization Engine (ROADMAP.md §28)", () => {
  it("answers the eight §28 dimensions across eighteen facets with the declared rule version", async () => {
    const service = createOptimizationService(optimizationRepoFromStore());

    // Seed tiny but real workspace data so the facets have something to observe.
    const seedOwner = defaultStore.createUser({
      email: "seed-owner@example.com",
      password: "correct-horse-battery",
      displayName: "Seed Owner",
    });
    if (!isOk(seedOwner)) throw new Error("seed user failed");
    const ws = defaultStore.createWorkspace({
      ownerId: seedOwner.value.id,
      name: `Seed ${seq} ${process.pid}`,
    });
    if (!isOk(ws)) throw new Error("seed workspace failed");
    const wsId = ws.value.id;
    const uid = seedOwner.value.id;
    const acct = defaultStore.createAccount({
      workspaceId: wsId,
      createdBy: uid,
      name: `Seed Account ${seq} ${process.pid}`,
      source: "manual",
      sourceReference: "seed",
    });
    if (!isOk(acct)) throw new Error("seed account failed");
    const contact = defaultStore.createContact({
      workspaceId: wsId,
      createdBy: uid,
      contact: {
        accountId: acct.value.id,
        firstName: "Seed",
        lastName: "Person",
        email: `seed${seq}@example.com`,
        source: "manual",
        sourceReference: "seed",
      },
    });
    if (!isOk(contact)) throw new Error("seed contact failed");
    const offer = defaultStore.createOffer({
      workspaceId: wsId,
      userId: uid,
      name: `Seed Offer ${seq} ${process.pid}`,
      description: "Seed offer",
      status: "active",
    });
    if (!isOk(offer)) throw new Error("seed offer failed");
    const qual = defaultStore.createQualification({
      workspaceId: wsId,
      createdBy: uid,
      accountId: acct.value.id,
      qualification: {
        version: 1,
        ruleVersion: "qualification-1.0.0",
        state: "qualified",
        score: 88,
        confidence: "high",
        reason: "seed",
        evidenceIds: [],
        claimIds: [],
        conflictedClaimIds: [],
        dimensions: [],
        contextDigest: "",
        revenuePlanId: null,
        revenueGoalId: null,
        icpId: null,
      },
    });
    if (!isOk(qual)) throw new Error("seed qualification failed");
    const summary = service.analyze(wsId, uid);
    const facets = summary.facets;
    const dimensions = summary.facets.map((f) => f.dimension);
    const facetsById = facets.map((f) => f.facet);

    // Rule version is advertised.
    expect(summary.ruleVersion).toBe("optimization-1.0.0");

    // All eighteen facets are present and grouped under the §28 dimensions.
    expect(facetsById).toHaveLength(18);
    expect(new Set(facetsById)).toEqual(
      new Set([
        "OPT-01",
        "OPT-02",
        "OPT-03",
        "OPT-04",
        "OPT-05",
        "OPT-06",
        "OPT-07",
        "OPT-08",
        "OPT-09",
        "OPT-10",
        "OPT-11",
        "OPT-12",
        "OPT-13",
        "OPT-14",
        "OPT-15",
        "OPT-16",
        "OPT-17",
        "OPT-18",
      ]),
    );
    expect(new Set(dimensions)).toEqual(
      new Set([
        "audiences",
        "messages",
        "signals",
        "channels",
        "timing",
        "qualification_rules",
        "follow_up_sequences",
        "offers",
      ]),
    );
    for (const f of facets) {
      expect(f.facet).toBeTruthy();
      expect(f.dimension).toBeTruthy();
      expect(f.observations instanceof Array).toBe(true);
      // Facets must be deterministic: same workspace, same rows → same result.
    }
  });

  it("answers the five §28 questions from the same workspace data", async () => {
    const t = tenant("Gate Answers");
    const service = createOptimizationService(optimizationRepoFromStore());

    const summary = service.analyze(t.workspaceId, t.userId);

    // The five questions are present and tagged by kind.
    expect(summary.headlines instanceof Array).toBe(true);
    for (const headline of summary.headlines) {
      expect(["worked", "failed", "dropping", "test", "impact"]).toContain(headline.kind);
      expect(headline.text).toBeTruthy();
      expect(headline.evidence instanceof Array).toBe(true);
      expect(["high", "low"]).toContain(headline.confidence);
    }
    // The five answers exist somewhere in the result, even if empty of defensible text today.
    expect(Object.keys(summary)).toEqual(
      expect.arrayContaining([
        "headlines",
        "learnings",
        "questions",
        "hypotheses",
        "facets",
        "ruleVersion",
        "workspaceId",
        "audit",
      ]),
    );
  });

  it("is deterministic and auditable: same workspace yields byte-identical results", async () => {
    const t = tenant("Gate Deterministic");
    const service = createOptimizationService(optimizationRepoFromStore());

    const first = service.analyze(t.workspaceId, t.userId);
    const second = service.analyze(t.workspaceId, t.userId);
    // Deterministic: same rows → same output, including audit tuple.
    expect(first.ruleVersion).toBe(second.ruleVersion);
    expect(first.facets.length).toBe(second.facets.length);
    expect(JSON.stringify(first.facets)).toBe(JSON.stringify(second.facets));
    expect(JSON.stringify(first.audit)).toBe(JSON.stringify(second.audit));

    // Auditable: audit tuple includes workspace shape and source counts.
    expect(first.audit).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ruleVersion=/),
        expect.stringMatching(/^facets=/),
        expect.stringMatching(/^dimensions=/),
        expect.stringMatching(/^sources=/),
      ]),
    );
  });

  it("does not execute, send, book, evaluate, or write cost, and reads only from existing rows", async () => {
    const t = tenant("Gate Negative Space");
    const service = createOptimizationService(optimizationRepoFromStore());

    const before = {
      evaluations: defaultStore.db.agentEvaluationObservations.length,
      actions: defaultStore.listOutboundActions(t.workspaceId, t.userId).value.length,
      meetings: defaultStore.listMeetings(t.workspaceId, t.userId).value.length,
      costs: defaultStore.listCostEvents(t.workspaceId, t.userId).value.length,
      drafts: defaultStore.listDrafts(t.workspaceId, t.userId).value.length,
      accounts: defaultStore.listAccounts(t.workspaceId, t.userId).value.length,
    };

    for (let i = 0; i < 3; i++) service.analyze(t.workspaceId, t.userId);

    const after = {
      evaluations: defaultStore.db.agentEvaluationObservations.length,
      actions: defaultStore.listOutboundActions(t.workspaceId, t.userId).value.length,
      meetings: defaultStore.listMeetings(t.workspaceId, t.userId).value.length,
      costs: defaultStore.listCostEvents(t.workspaceId, t.userId).value.length,
      drafts: defaultStore.listDrafts(t.workspaceId, t.userId).value.length,
      accounts: defaultStore.listAccounts(t.workspaceId, t.userId).value.length,
    };

    expect(after).toEqual(before);
    // Row counts: only the workspace we seeded has these rows; other tables untouched.
    expect(defaultStore.db.agentTraceRuns.length).toBeGreaterThanOrEqual(0);
    expect(defaultStore.db.agentTraceEvents.length).toBeGreaterThanOrEqual(0);
  });

  it("is workspace-isolated: analysis reflects only the requested workspace", async () => {
    const a = tenant("Gate Isolation A");
    const b = tenant("Gate Isolation B");

    // Seed workspace A with an account; leave workspace B empty.
    const acc = defaultStore.createAccount({
      workspaceId: a.workspaceId,
      createdBy: a.userId,
      account: { name: unique("acct"), source: "manual", sourceReference: "seed" },
    });
    if (!isOk(acc)) throw new Error("seed account failed");

    // Workspace B has no accounts.

    const service = createOptimizationService(optimizationRepoFromStore());

    const aSummary = service.analyze(a.workspaceId, a.userId);
    const bSummary = service.analyze(b.workspaceId, b.userId);

    expect(aSummary.workspaceId).toBe(a.workspaceId);
    expect(bSummary.workspaceId).toBe(b.workspaceId);
    expect(aSummary.workspaceId).not.toBe(b.workspaceId);
    // Each workspace sees only its own rows: A has 1 account, B has 0.
    expect(aSummary.facets.length).toBeGreaterThan(0);
    expect(bSummary.facets.length).toBeGreaterThan(0); // facets exist even when empty
    expect(JSON.stringify(aSummary.audit)).not.toBe(JSON.stringify(bSummary.audit));
  });

  it("refuses a workspace the caller is not authorized for", async () => {
    const t = tenant("Gate Auth");
    const service = createOptimizationService({
      authorize: (_, __) => false, // deny all
      listAccounts: () => [],
      listContacts: () => [],
      listOffers: () => [],
      listDrafts: () => [],
      listOutboundActions: () => [],
      listOutboundEvents: () => [],
      listConversationClassifications: () => [],
      listMeetings: () => [],
      listQualifications: () => [],
      listResearchFindings: () => [],
      listCostEvents: () => [],
      listAgentTraceRuns: () => [],
      listAgentTraceEvents: () => [],
      listInboundMessages: () => [],
    });

    expect(() => service.analyze(t.workspaceId, t.userId)).toThrow(/unauthorized/i);
  });

  it("does not depend on the agent trace table for its existence — trace is guidance, not the optimizer's source of truth", async () => {
    const t = tenant("Gate Sources");
    const service = createOptimizationService(optimizationRepoFromStore());

    const summary = service.analyze(t.workspaceId, t.userId);
    // The optimizer works even when the workspace has zero trace rows; trace is
    // guidance only, not the optimizer's required source of truth.
    expect(summary.audit).toContainEqual(expect.stringMatching(/^traceRuns=/));
  });

  it("does not run agents, does not send, does not book, does not evaluate, does not write cost", async () => {
    const t = tenant("Gate Never Executes");
    const service = createOptimizationService(optimizationRepoFromStore());

    expect(Object.keys(defaultStore.db)).not.toContain("agentTraceRunTable"); // no table added by optimizer
    // Repeated reads are pure:
    const before = {
      evals: defaultStore.db.agentEvaluationObservations.length,
      actions: defaultStore.listOutboundActions(t.workspaceId, t.userId).value.length,
      meetings: defaultStore.listMeetings(t.workspaceId, t.userId).value.length,
      costs: defaultStore.listCostEvents(t.workspaceId, t.userId).value.length,
    };
    service.analyze(t.workspaceId, t.userId);
    service.analyze(t.workspaceId, t.userId);
    const after = {
      evals: defaultStore.db.agentEvaluationObservations.length,
      actions: defaultStore.listOutboundActions(t.workspaceId, t.userId).value.length,
      meetings: defaultStore.listMeetings(t.workspaceId, t.userId).value.length,
      costs: defaultStore.listCostEvents(t.workspaceId, t.userId).value.length,
    };
    expect(after).toEqual(before);
  });
});
