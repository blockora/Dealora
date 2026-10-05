import { describe, expect, it } from "vitest";

import { isErr, isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";

import { deriveBreakdown, deriveMetric, deriveMetrics } from "./engine.js";
import { createCostService } from "./factory.js";
import type { CostLookup } from "./factory.js";
import { addMinor, divideMinor, isMinorAmount, sumMinor } from "./money.js";
import {
  COST_CURRENCIES,
  COST_RULE_VERSION,
  METRIC_PARTITION,
  describeCostPolicy,
} from "./rules.js";
import type { CostEventRow, RecordCostInput } from "./types.js";

/**
 * Phase 16 domain tests — ROADMAP.md §23's Cost Engine.
 *
 * The phase's line is recorded facts vs derived aggregates, so the tests run
 * down both sides plus the arithmetic between them:
 *
 * 1. **Money** — whole minor units only; exact integer division even at the
 *    safe-integer boundary where naive `Math.floor` miscounts.
 * 2. **Engine** — the same facts always produce the same breakdown, the
 *    supersession rule prevents double counting, and a mixed-currency or
 *    unrepresentable input refuses the derivation instead of guessing.
 * 3. **Service over the real store** — attribution is the session's, forged
 *    identity fields are ignored, replays are idempotent, refusals carry
 *    their owning phase, and every read is workspace-scoped.
 */

const WORKSPACE = "ws-1";
const USER = "user-1";

function costRow(overrides: Partial<CostEventRow> = {}): CostEventRow {
  return {
    id: "cost-1",
    workspaceId: WORKSPACE,
    executionKind: "research_run",
    executionId: "run-1",
    category: "llm",
    basis: "estimated",
    amountMinor: 1000,
    currency: "USD",
    source: null,
    occurredAt: "2026-10-01T00:00:00.000Z",
    idempotencyKey: "key-1",
    createdBy: USER,
    createdAt: "2026-10-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("cost money", () => {
  it("accepts only whole, non-negative, safe amounts", () => {
    expect(isMinorAmount(0)).toBe(true);
    expect(isMinorAmount(1)).toBe(true);
    expect(isMinorAmount(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isMinorAmount(-1)).toBe(false);
    expect(isMinorAmount(12.5)).toBe(false);
    expect(isMinorAmount(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isMinorAmount("100")).toBe(false);
  });

  it("refuses a sum that would leave the safe-integer range", () => {
    expect(addMinor(1, 2)).toBe(3);
    expect(addMinor(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
    expect(addMinor(0.5, 1)).toBeNull();
    expect(sumMinor([])).toBe(0);
    expect(sumMinor([1, 2, 3])).toBe(6);
    expect(sumMinor([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
  });

  it("divides exactly where naive floor arithmetic loses a minor unit", () => {
    // (2^53 - 1) / 8 = 1125899906842623.875 — a tie in IEEE-754 that rounds
    // UP to 2^50, so `Math.floor(n / d)` would report ...624 with remainder
    // -1 nonsense. BigInt division truncates toward zero, exactly.
    expect(divideMinor(Number.MAX_SAFE_INTEGER, 8)).toEqual({
      averageMinor: 1125899906842623,
      remainderMinor: 7,
    });
    // The quotient and remainder reconstruct the numerator exactly:
    // average * denominator + remainder === numerator.
    const divided = divideMinor(1234, 7);
    expect(divided).toEqual({ averageMinor: 176, remainderMinor: 2 });
    expect(176 * 7 + 2).toBe(1234);
  });

  it("refuses to divide by an empty denominator or a non-integer one", () => {
    expect(divideMinor(100, 0)).toBeNull();
    expect(divideMinor(100, -1)).toBeNull();
    expect(divideMinor(100, 2.5)).toBeNull();
    expect(divideMinor(-100, 2)).toBeNull();
  });
});

describe("cost engine breakdown", () => {
  it("reports an empty workspace as no data, never as a fabricated currency", () => {
    const breakdown = deriveBreakdown([]);
    expect(breakdown).toEqual({
      currency: null,
      eventCount: 0,
      totalMinor: 0,
      estimatedMinor: 0,
      measuredMinor: 0,
      supersededEstimateMinor: 0,
      byCategory: [
        { category: "llm", amountMinor: 0 },
        { category: "search", amountMinor: 0 },
        { category: "data", amountMinor: 0 },
        { category: "tool", amountMinor: 0 },
        { category: "infrastructure", amountMinor: 0 },
        { category: "execution", amountMinor: 0 },
      ],
    });
  });

  it("never double counts: a measurement supersedes its own estimate", () => {
    const facts = [
      costRow({ id: "c1", basis: "estimated", amountMinor: 1000 }),
      costRow({ id: "c2", basis: "measured", amountMinor: 900 }),
      costRow({ id: "c3", category: "search", basis: "estimated", amountMinor: 100 }),
    ];
    const breakdown = deriveBreakdown(facts);
    if (breakdown === null) throw new Error("breakdown failed");
    // The llm estimate was measured: only the measurement counts (900), and
    // the un-measured search estimate counts in full (100).
    expect(breakdown.totalMinor).toBe(1000);
    expect(breakdown.estimatedMinor).toBe(1100);
    expect(breakdown.measuredMinor).toBe(900);
    expect(breakdown.supersededEstimateMinor).toBe(1000);
    // The published invariant holds exactly.
    expect(breakdown.totalMinor).toBe(
      breakdown.measuredMinor + (breakdown.estimatedMinor - breakdown.supersededEstimateMinor),
    );
    expect(breakdown.byCategory).toEqual([
      { category: "llm", amountMinor: 900 },
      { category: "search", amountMinor: 100 },
      { category: "data", amountMinor: 0 },
      { category: "tool", amountMinor: 0 },
      { category: "infrastructure", amountMinor: 0 },
      { category: "execution", amountMinor: 0 },
    ]);
  });

  it("keeps supersession per execution and category — separate runs never merge", () => {
    const facts = [
      costRow({ id: "c1", executionId: "run-1", basis: "measured", amountMinor: 500 }),
      costRow({ id: "c2", executionId: "run-2", basis: "estimated", amountMinor: 700 }),
      costRow({
        id: "c3",
        executionId: "run-1",
        category: "search",
        basis: "estimated",
        amountMinor: 300,
      }),
    ];
    const breakdown = deriveBreakdown(facts);
    if (breakdown === null) throw new Error("breakdown failed");
    expect(breakdown.totalMinor).toBe(1500);
    expect(breakdown.supersededEstimateMinor).toBe(0);
  });

  it("is deterministic regardless of the order the facts arrive in", () => {
    const facts = [
      costRow({ id: "c1", basis: "estimated", amountMinor: 1000 }),
      costRow({ id: "c2", basis: "measured", amountMinor: 900 }),
      costRow({ id: "c3", category: "tool", amountMinor: 42 }),
    ];
    const forward = deriveBreakdown(facts);
    const reversed = deriveBreakdown([...facts].reverse());
    expect(forward).toEqual(reversed);
  });

  it("refuses mixed currencies, unsafe amounts and overflowing totals", () => {
    // Storage prevents a second currency in a workspace; the engine refuses
    // it again rather than adding across currencies.
    expect(
      deriveBreakdown([
        costRow({ id: "c1", currency: "USD" }),
        costRow({ id: "c2", currency: "EUR" }),
      ]),
    ).toBeNull();
    // An amount outside the representable range is refused, not rounded.
    expect(deriveBreakdown([costRow({ amountMinor: Number.MAX_SAFE_INTEGER + 1 })])).toBeNull();
    // Two individually-valid facts whose total is not a safe integer refuse
    // the whole derivation: no total is better than an imprecise one.
    expect(
      deriveBreakdown([
        costRow({ id: "c1", amountMinor: 2 ** 52 }),
        costRow({ id: "c2", amountMinor: 2 ** 52 }),
      ]),
    ).toBeNull();
  });
});

describe("cost engine metrics", () => {
  const breakdown = () => {
    const derived = deriveBreakdown([costRow({ amountMinor: 1000 })]);
    if (derived === null) throw new Error("breakdown failed");
    return derived;
  };

  it("derives a per-prospect cost with the remainder preserved", () => {
    const metric = deriveMetric("cost_per_prospect", breakdown(), 3);
    expect(metric).toEqual({
      name: "cost_per_prospect",
      status: "derived",
      numeratorMinor: 1000,
      denominator: 3,
      averageMinor: 333,
      remainderMinor: 1,
      currency: "USD",
      reason: null,
    });
    expect(333 * 3 + 1).toBe(1000);
  });

  it("reports no data — never zero cost — for an empty numerator or denominator", () => {
    const empty = deriveBreakdown([]);
    if (empty === null) throw new Error("breakdown failed");
    const noFacts = deriveMetric("cost_per_prospect", empty, 5);
    expect(noFacts.status).toBe("no_data");
    expect(noFacts.averageMinor).toBeNull();
    expect(noFacts.reason).toContain("no cost fact has been recorded");

    const noDenominator = deriveMetric("cost_per_meeting", breakdown(), 0);
    expect(noDenominator.status).toBe("no_data");
    expect(noDenominator.averageMinor).toBeNull();
    expect(noDenominator.reason).toContain("no stored meetings");
  });

  it("publishes the six metrics as a partition: three derived, three refused", () => {
    const derived = deriveMetrics(breakdown(), {
      prospects: 1,
      qualifiedOpportunities: 0,
      meetings: 2,
    });
    expect(derived.metrics.map((m) => m.name)).toEqual([
      "cost_per_prospect",
      "cost_per_qualified_opportunity",
      "cost_per_meeting",
    ]);
    expect(derived.metrics.map((m) => m.status)).toEqual(["derived", "no_data", "derived"]);
    expect(derived.refused.map((r) => r.name)).toEqual([
      "cost_per_customer",
      "revenue_per_ai_cost",
      "revenue_per_campaign",
    ]);
    // Every refused metric names the phase that owns it (or explicitly none).
    for (const refused of derived.refused) {
      expect(refused.reason.length).toBeGreaterThan(0);
      expect(refused.owningPhase === null || typeof refused.owningPhase === "string").toBe(true);
    }
    // The partition is total and disjoint: exactly the six names §23 lists.
    const names = [
      ...METRIC_PARTITION.filter((e) => e.status === "derived").map((e) => e.name),
      ...METRIC_PARTITION.filter((e) => e.status === "refused").map((e) => e.name),
    ];
    expect(new Set(names).size).toBe(6);
  });

  it("is deterministic: the same inputs always print the same metrics", () => {
    const denominators = { prospects: 2, qualifiedOpportunities: 1, meetings: 4 };
    expect(deriveMetrics(breakdown(), denominators)).toEqual(
      deriveMetrics(breakdown(), denominators),
    );
  });
});

describe("cost policy", () => {
  it("publishes the vocabularies, limits and refusals as one rule set", () => {
    const policy = describeCostPolicy();
    expect(policy.ruleVersion).toBe(COST_RULE_VERSION);
    expect(policy.categories.map((c) => c.category)).toEqual([
      "llm",
      "search",
      "data",
      "tool",
      "infrastructure",
      "execution",
    ]);
    expect(policy.bases.map((b) => b.basis)).toEqual(["estimated", "measured"]);
    // Phase 20 widens this list with `agent_run` so §27's required cost figure
    // can come from this table rather than from a second one. The three kinds
    // Phase 16 published are unchanged and keep their order.
    expect(policy.executionKinds).toEqual([
      "research_run",
      "outbound_send",
      "meeting_booking",
      "agent_run",
    ]);
    // `workflow` is refused with its owning phase, never published as an
    // execution kind no branch could produce.
    expect(policy.refusedExecutionKinds).toHaveLength(1);
    expect(policy.refusedExecutionKinds[0]?.name).toBe("workflow");
    expect(policy.refusedExecutionKinds[0]?.owningPhase).toBe("Phase 24");
    expect(policy.currencies).toEqual(COST_CURRENCIES);
    expect(policy.oneCurrencyPerWorkspace).toBe(true);
    expect(policy.limits.amountMinorMin).toBe(0);
    expect(policy.limits.idempotencyKeyMax).toBe(128);
    expect(policy.aggregationRule).toContain("measured");
    expect(policy.metrics.filter((m) => m.status === "derived")).toHaveLength(3);
    expect(policy.metrics.filter((m) => m.status === "refused")).toHaveLength(3);
    expect(policy.neverDoes.join(" ")).toContain("never stores a total");
  });
});

/** A workspace with one real research run a cost can be filed against. */
function fixture() {
  const store = new Store(emptyState());
  const owner = store.createUser({
    email: "owner@example.com",
    password: "correct-horse-battery",
    displayName: "Owner",
  });
  if (!isOk(owner)) throw new Error("seed owner failed");
  const other = store.createUser({
    email: "other@example.com",
    password: "correct-horse-battery",
    displayName: "Other",
  });
  if (!isOk(other)) throw new Error("seed other user failed");
  const workspace = store.createWorkspace({ ownerId: owner.value.id, name: "Cost Co" });
  if (!isOk(workspace)) throw new Error("seed workspace failed");
  const otherWorkspace = store.createWorkspace({
    ownerId: other.value.id,
    name: "Other Co",
  });
  if (!isOk(otherWorkspace)) throw new Error("seed other workspace failed");
  const account = store.createAccount({
    workspaceId: workspace.value.id,
    createdBy: owner.value.id,
    account: {
      name: "Northwind Trading",
      website: "https://northwind.example",
      domain: "northwind.example",
      industry: "Wholesale",
      companySize: "120",
      geography: "UK",
      description: null,
      source: "manual",
      sourceReference: null,
      revenuePlanId: null,
      status: "active",
    },
  });
  if (!isOk(account)) throw new Error("seed account failed");
  const request = store.createResearchRequest({
    workspaceId: workspace.value.id,
    requestedBy: owner.value.id,
    accountId: account.value.id,
    provider: "account_record",
    categories: ["company_overview"],
  });
  if (!isOk(request)) throw new Error("seed research request failed");
  const secondRequest = store.createResearchRequest({
    workspaceId: workspace.value.id,
    requestedBy: owner.value.id,
    accountId: account.value.id,
    provider: "account_record",
    categories: ["company_overview"],
  });
  if (!isOk(secondRequest)) throw new Error("seed second research request failed");
  // Another tenant's real run, for cross-tenant refusal tests.
  const foreignAccount = store.createAccount({
    workspaceId: otherWorkspace.value.id,
    createdBy: other.value.id,
    account: {
      name: "Foreign Account",
      website: null,
      domain: "foreign.example",
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
  if (!isOk(foreignAccount)) throw new Error("seed foreign account failed");
  const foreignRequest = store.createResearchRequest({
    workspaceId: otherWorkspace.value.id,
    requestedBy: other.value.id,
    accountId: foreignAccount.value.id,
    provider: "account_record",
    categories: ["company_overview"],
  });
  if (!isOk(foreignRequest)) throw new Error("seed foreign request failed");

  return {
    store,
    cost: createCostService(store as never),
    ownerId: owner.value.id,
    otherId: other.value.id,
    workspaceId: workspace.value.id,
    otherWorkspaceId: otherWorkspace.value.id,
    accountId: account.value.id,
    requestId: request.value.id,
    secondRequestId: secondRequest.value.id,
    foreignRequestId: foreignRequest.value.id,
  };
}

/** A record request body; extra fields stand in for a forged client body. */
function body(fields: Record<string, unknown>): RecordCostInput {
  return fields as unknown as RecordCostInput;
}

/** A valid record request, with per-test overrides. */
function recordBody(executionId: string, overrides: Record<string, unknown> = {}): RecordCostInput {
  return body({
    executionKind: "research_run",
    executionId,
    category: "llm",
    basis: "measured",
    amountMinor: 1234,
    currency: "USD",
    source: "usage export",
    occurredAt: "2026-10-01T00:00:00.000Z",
    idempotencyKey: "key-1",
    ...overrides,
  });
}

describe("cost service — recording a fact", () => {
  it("records with server-side attribution and reads the fact back", () => {
    const fx = fixture();
    const created = fx.cost.record(fx.workspaceId, fx.ownerId, recordBody(fx.requestId));
    if (!isOk(created)) throw new Error("record failed");
    // The session's user recorded it — not a claim from the body.
    expect(created.value.createdBy).toBe(fx.ownerId);
    expect(created.value.executionId).toBe(fx.requestId);
    expect(created.value.amountMinor).toBe(1234);
    expect(created.value.currency).toBe("USD");
    expect(created.value.basis).toBe("measured");
    expect(created.value.createdAt).toBeTruthy();

    const fetched = fx.cost.get(fx.workspaceId, fx.ownerId, created.value.id);
    if (!isOk(fetched)) throw new Error("get failed");
    expect(fetched.value).toEqual(created.value);

    const listed = fx.cost.list(fx.workspaceId, fx.ownerId, {
      executionKind: undefined,
      executionId: undefined,
      category: undefined,
      basis: undefined,
    });
    if (!isOk(listed)) throw new Error("list failed");
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toEqual(created.value);
  });

  it("ignores forged identity, workspace and total fields in the body", () => {
    const fx = fixture();
    const forged = recordBody(fx.requestId, {
      createdBy: fx.otherId,
      createdAt: "2000-01-01T00:00:00.000Z",
      workspaceId: fx.otherWorkspaceId,
      totalMinor: 999999,
      id: "forged-id",
    });
    const created = fx.cost.record(fx.workspaceId, fx.ownerId, forged);
    if (!isOk(created)) throw new Error("record failed");
    // Every forged field is ignored: the server's attribution and amount stand.
    expect(created.value.createdBy).toBe(fx.ownerId);
    expect(created.value.amountMinor).toBe(1234);
    expect(created.value.id).not.toBe("forged-id");
    expect(created.value).not.toHaveProperty("totalMinor");
    // The fact is filed in the workspace the caller was authorized for, not
    // the one the body named.
    const fetched = fx.cost.get(fx.workspaceId, fx.ownerId, created.value.id);
    expect(isOk(fetched)).toBe(true);
    const foreignRead = fx.cost.get(fx.otherWorkspaceId, fx.otherId, created.value.id);
    expect(isErr(foreignRead)).toBe(true);
  });

  it("refuses vocabulary violations and malformed money", () => {
    const fx = fixture();
    const attempt = (input: RecordCostInput, expectedMessage?: string) => {
      const result = fx.cost.record(fx.workspaceId, fx.ownerId, input);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        if (expectedMessage !== undefined) {
          expect(result.error.message).toContain(expectedMessage);
        }
      }
    };
    attempt(recordBody(fx.requestId, { category: "workflow" }));
    attempt(recordBody(fx.requestId, { basis: "guessed" }));
    attempt(recordBody(fx.requestId, { amountMinor: -1 }));
    attempt(recordBody(fx.requestId, { amountMinor: 12.5 }));
    attempt(recordBody(fx.requestId, { amountMinor: Number.MAX_SAFE_INTEGER + 1 }));
    attempt(recordBody(fx.requestId, { currency: "XYZ" }));
    attempt(recordBody(fx.requestId, { occurredAt: "not-a-time" }));
    attempt(recordBody(fx.requestId, { idempotencyKey: "" }));
    attempt(recordBody(fx.requestId, { idempotencyKey: "k".repeat(129) }));
    attempt(recordBody(fx.requestId, { source: "" }));
    attempt(recordBody(fx.requestId, { executionId: "" }));
    attempt(recordBody(fx.requestId, { executionKind: "teleport" }));
    // The refused future kind names its owner instead of pretending to work.
    attempt(recordBody(fx.requestId, { executionKind: "workflow" }), "Phase 24");

    const listed = fx.cost.list(fx.workspaceId, fx.ownerId, {
      executionKind: undefined,
      executionId: undefined,
      category: undefined,
      basis: undefined,
    });
    if (!isOk(listed)) throw new Error("list failed");
    expect(listed.value).toHaveLength(0);
  });
});

describe("cost service — replay, currency and tenancy", () => {
  it("returns the same fact for a replay and refuses a reused key", () => {
    const fx = fixture();
    const first = fx.cost.record(fx.workspaceId, fx.ownerId, recordBody(fx.requestId));
    if (!isOk(first)) throw new Error("record failed");

    const replay = fx.cost.record(fx.workspaceId, fx.ownerId, recordBody(fx.requestId));
    if (!isOk(replay)) throw new Error("replay failed");
    expect(replay.value.id).toBe(first.value.id);

    const conflict = fx.cost.record(
      fx.workspaceId,
      fx.ownerId,
      recordBody(fx.requestId, { amountMinor: 999 }),
    );
    expect(isErr(conflict)).toBe(true);
    if (isErr(conflict)) expect(conflict.error.code).toBe("CONFLICT");

    const second = fx.cost.record(
      fx.workspaceId,
      fx.ownerId,
      recordBody(fx.requestId, { idempotencyKey: "key-2" }),
    );
    if (!isOk(second)) throw new Error("second record failed");
    expect(second.value.id).not.toBe(first.value.id);

    const listed = fx.cost.list(fx.workspaceId, fx.ownerId, {
      executionKind: undefined,
      executionId: undefined,
      category: undefined,
      basis: undefined,
    });
    if (!isOk(listed)) throw new Error("list failed");
    expect(listed.value).toHaveLength(2);
  });

  it("refuses a second currency in one workspace", () => {
    const fx = fixture();
    const first = fx.cost.record(
      fx.workspaceId,
      fx.ownerId,
      recordBody(fx.requestId, { currency: "USD" }),
    );
    if (!isOk(first)) throw new Error("record failed");
    const mixed = fx.cost.record(
      fx.workspaceId,
      fx.ownerId,
      recordBody(fx.requestId, { currency: "EUR", idempotencyKey: "key-eur" }),
    );
    expect(isErr(mixed)).toBe(true);
    if (isErr(mixed)) {
      expect(mixed.error.code).toBe("VALIDATION_ERROR");
      expect(mixed.error.message).toContain("USD");
    }
  });

  it("refuses a cost filed against an unknown or foreign execution", () => {
    const fx = fixture();
    const unknown = fx.cost.record(fx.workspaceId, fx.ownerId, recordBody("never-issued"));
    expect(isErr(unknown)).toBe(true);
    if (isErr(unknown)) expect(unknown.error.code).toBe("NOT_FOUND");

    const foreign = fx.cost.record(fx.workspaceId, fx.ownerId, recordBody(fx.foreignRequestId));
    expect(isErr(foreign)).toBe(true);
    if (isErr(foreign)) expect(foreign.error.code).toBe("NOT_FOUND");
  });

  it("keeps every read inside the caller's own workspace", () => {
    const fx = fixture();
    const created = fx.cost.record(fx.workspaceId, fx.ownerId, recordBody(fx.requestId));
    if (!isOk(created)) throw new Error("record failed");

    // Another tenant cannot read the fact, list it, or record against our run.
    expect(isErr(fx.cost.get(fx.otherWorkspaceId, fx.otherId, created.value.id))).toBe(true);
    expect(isErr(fx.cost.record(fx.otherWorkspaceId, fx.otherId, recordBody(fx.requestId)))).toBe(
      true,
    );
    const otherList = fx.cost.list(fx.otherWorkspaceId, fx.otherId, {
      executionKind: undefined,
      executionId: undefined,
      category: undefined,
      basis: undefined,
    });
    if (!isOk(otherList)) throw new Error("other list failed");
    expect(otherList.value).toHaveLength(0);

    // A non-member of the owning workspace is refused outright.
    expect(isErr(fx.cost.get(fx.workspaceId, fx.otherId, created.value.id))).toBe(true);
    expect(isErr(fx.cost.policy(fx.workspaceId, fx.otherId))).toBe(true);
    expect(isErr(fx.cost.metrics(fx.workspaceId, fx.otherId))).toBe(true);
  });
});

describe("cost service — the gate: one execution's estimated or measured cost", () => {
  it("shows estimated AND measured cost for one real execution, without double counting", () => {
    const fx = fixture();
    for (const input of [
      recordBody(fx.requestId, { basis: "estimated", amountMinor: 1000, idempotencyKey: "k1" }),
      recordBody(fx.requestId, { basis: "measured", amountMinor: 900, idempotencyKey: "k2" }),
      recordBody(fx.requestId, {
        category: "search",
        basis: "estimated",
        amountMinor: 100,
        idempotencyKey: "k3",
      }),
    ]) {
      const recorded = fx.cost.record(fx.workspaceId, fx.ownerId, input);
      if (!isOk(recorded)) throw new Error("record failed");
    }

    const summary = fx.cost.executionCost(fx.workspaceId, fx.ownerId, {
      executionKind: "research_run",
      executionId: fx.requestId,
    });
    if (!isOk(summary)) throw new Error("execution summary failed");
    expect(summary.value.ruleVersion).toBe(COST_RULE_VERSION);
    expect(summary.value.executionKind).toBe("research_run");
    expect(summary.value.executionId).toBe(fx.requestId);
    expect(summary.value.totals.currency).toBe("USD");
    expect(summary.value.totals.eventCount).toBe(3);
    expect(summary.value.totals.estimatedMinor).toBe(1100);
    expect(summary.value.totals.measuredMinor).toBe(900);
    // The llm estimate was measured, so it contributes once — as the
    // measurement — and the un-measured search estimate contributes fully.
    expect(summary.value.totals.supersededEstimateMinor).toBe(1000);
    expect(summary.value.totals.totalMinor).toBe(1000);
  });

  it("shows an estimated-only execution with an empty measured side", () => {
    const fx = fixture();
    const recorded = fx.cost.record(
      fx.workspaceId,
      fx.ownerId,
      recordBody(fx.secondRequestId, {
        basis: "estimated",
        amountMinor: 500,
        idempotencyKey: "only-estimate",
      }),
    );
    if (!isOk(recorded)) throw new Error("record failed");

    const summary = fx.cost.executionCost(fx.workspaceId, fx.ownerId, {
      executionKind: "research_run",
      executionId: fx.secondRequestId,
    });
    if (!isOk(summary)) throw new Error("execution summary failed");
    expect(summary.value.totals.estimatedMinor).toBe(500);
    expect(summary.value.totals.measuredMinor).toBe(0);
    expect(summary.value.totals.totalMinor).toBe(500);
  });

  it("shows an honest zero for a real execution with no recorded cost", () => {
    const fx = fixture();
    const summary = fx.cost.executionCost(fx.workspaceId, fx.ownerId, {
      executionKind: "research_run",
      executionId: fx.requestId,
    });
    if (!isOk(summary)) throw new Error("execution summary failed");
    expect(summary.value.totals.eventCount).toBe(0);
    expect(summary.value.totals.totalMinor).toBe(0);
    expect(summary.value.totals.currency).toBeNull();
  });

  it("refuses unknown, foreign and workflow executions", () => {
    const fx = fixture();
    const unknown = fx.cost.executionCost(fx.workspaceId, fx.ownerId, {
      executionKind: "research_run",
      executionId: "never-issued",
    });
    expect(isErr(unknown)).toBe(true);
    if (isErr(unknown)) expect(unknown.error.code).toBe("NOT_FOUND");

    const foreign = fx.cost.executionCost(fx.workspaceId, fx.ownerId, {
      executionKind: "research_run",
      executionId: fx.foreignRequestId,
    });
    expect(isErr(foreign)).toBe(true);
    if (isErr(foreign)) expect(foreign.error.code).toBe("NOT_FOUND");

    const workflow = fx.cost.executionCost(fx.workspaceId, fx.ownerId, {
      executionKind: "workflow",
      executionId: fx.requestId,
    });
    expect(isErr(workflow)).toBe(true);
    if (isErr(workflow)) {
      expect(workflow.error.code).toBe("VALIDATION_ERROR");
      expect(workflow.error.message).toContain("Phase 24");
    }
  });
});

describe("cost service — derived metrics and policy", () => {
  it("derives workspace metrics from the recorded facts alone", () => {
    const fx = fixture();
    // Before anything is recorded: honest no data everywhere, refusals listed.
    const empty = fx.cost.metrics(fx.workspaceId, fx.ownerId);
    if (!isOk(empty)) throw new Error("metrics failed");
    expect(empty.value.totals.eventCount).toBe(0);
    expect(empty.value.totals.currency).toBeNull();
    expect(empty.value.metrics.every((m) => m.status === "no_data")).toBe(true);
    expect(empty.value.refused).toHaveLength(3);

    const recorded = fx.cost.record(fx.workspaceId, fx.ownerId, recordBody(fx.requestId));
    if (!isOk(recorded)) throw new Error("record failed");

    const metrics = fx.cost.metrics(fx.workspaceId, fx.ownerId);
    if (!isOk(metrics)) throw new Error("metrics failed");
    expect(metrics.value.ruleVersion).toBe(COST_RULE_VERSION);
    expect(metrics.value.totals.totalMinor).toBe(1234);
    // One stored account = one prospect; no qualification and no meeting yet.
    expect(metrics.value.denominators).toEqual({
      prospects: 1,
      qualifiedOpportunities: 0,
      meetings: 0,
    });
    const perProspect = metrics.value.metrics.find((m) => m.name === "cost_per_prospect");
    expect(perProspect?.status).toBe("derived");
    expect(perProspect?.averageMinor).toBe(1234);
    expect(perProspect?.denominator).toBe(1);
    expect(metrics.value.metrics.find((m) => m.name === "cost_per_meeting")?.status).toBe(
      "no_data",
    );

    // The same request twice produces the same answer: nothing is accumulated.
    const again = fx.cost.metrics(fx.workspaceId, fx.ownerId);
    if (!isOk(again)) throw new Error("metrics failed");
    expect(again.value).toEqual(metrics.value);
  });

  it("never trusts a client-supplied total: totals are recomputed from rows", () => {
    const fx = fixture();
    // Two facts are recorded; whatever a client might claim about totals
    // elsewhere, this answer is a function of these two rows and nothing else.
    for (const key of ["k1", "k2"]) {
      const recorded = fx.cost.record(
        fx.workspaceId,
        fx.ownerId,
        recordBody(fx.requestId, { amountMinor: 500, idempotencyKey: key }),
      );
      if (!isOk(recorded)) throw new Error("record failed");
    }
    const metrics = fx.cost.metrics(fx.workspaceId, fx.ownerId);
    if (!isOk(metrics)) throw new Error("metrics failed");
    expect(metrics.value.totals.eventCount).toBe(2);
    expect(metrics.value.totals.totalMinor).toBe(1000);
  });

  it("serves the policy only to members of the named workspace", () => {
    const fx = fixture();
    const policy = fx.cost.policy(fx.workspaceId, fx.ownerId);
    if (!isOk(policy)) throw new Error("policy failed");
    // Phase 20 added `agent_run` to this partition, so the count is four.
    expect(policy.value.executionKinds).toHaveLength(4);
    expect(policy.value.refusedExecutionKinds[0]?.owningPhase).toBe("Phase 24");
    expect(policy.value.metrics).toHaveLength(6);
    expect(isErr(fx.cost.policy(fx.workspaceId, fx.otherId))).toBe(true);
    expect(isErr(fx.cost.policy("never-issued", fx.ownerId))).toBe(true);
  });
});

describe("cost factory — metric denominators", () => {
  /** A lookup that answers only what the denominator derivation reads. */
  function lookupWith(rows: {
    accounts: readonly { id: string }[];
    qualifications: readonly { accountId: string; version: number; state: string }[];
    meetings: readonly { id: string }[];
  }): CostLookup {
    return {
      authorize: () => ({ ok: true, value: {} }),
      createCostEvent: () => ({ ok: false, error: { code: "UNAVAILABLE" } }),
      getCostEvent: () => ({ ok: false, error: { code: "NOT_FOUND" } }),
      listCostEvents: () => ({ ok: true, value: [] }),
      getResearchRequest: () => ({ ok: false, error: { code: "NOT_FOUND" } }),
      getOutboundAction: () => ({ ok: false, error: { code: "NOT_FOUND" } }),
      getMeeting: () => ({ ok: false, error: { code: "NOT_FOUND" } }),
      getAgentTraceRun: () => ({ ok: true, value: null }),
      listAccounts: () => ({ ok: true, value: rows.accounts }),
      listQualifications: () => ({ ok: true, value: rows.qualifications }),
      listMeetings: () => ({ ok: true, value: rows.meetings }),
    };
  }

  it("counts an opportunity only from an account's NEWEST qualification", () => {
    // Newest says otherwise: the stale `qualified` row must not count.
    const stale = createCostService(
      lookupWith({
        accounts: [{ id: "a1" }],
        qualifications: [
          { accountId: "a1", version: 1, state: "qualified" },
          { accountId: "a1", version: 2, state: "contested" },
        ],
        meetings: [],
      }),
    );
    const staleResult = stale.metrics("ws", "user");
    if (!isOk(staleResult)) throw new Error("metrics failed");
    expect(staleResult.value.denominators.qualifiedOpportunities).toBe(0);

    // Newest is qualified: one opportunity, exactly like Phase 15's rule.
    const fresh = createCostService(
      lookupWith({
        accounts: [{ id: "a1" }, { id: "a2" }],
        qualifications: [
          { accountId: "a1", version: 1, state: "unqualified" },
          { accountId: "a1", version: 2, state: "qualified" },
          { accountId: "a2", version: 1, state: "qualified" },
        ],
        meetings: [{ id: "m1" }],
      }),
    );
    const freshResult = fresh.metrics("ws", "user");
    if (!isOk(freshResult)) throw new Error("metrics failed");
    expect(freshResult.value.denominators).toEqual({
      prospects: 2,
      qualifiedOpportunities: 2,
      meetings: 1,
    });
  });
});
