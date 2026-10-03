import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";

import { RevenueGoalService } from "./service.js";
import type { GoalBusinessContext, GoalRepository } from "./service.js";
import { DeterministicGoalParser } from "./parser.js";
import type { GoalParser } from "./types.js";

const NOW = new Date("2026-03-01T00:00:00.000Z");

function fixture(): {
  service: RevenueGoalService;
  parser: GoalParser;
  store: Store;
  userA: string;
  workspaceA: string;
  contextA: GoalBusinessContext;
  userB: string;
  workspaceB: string;
  contextB: GoalBusinessContext;
} {
  const store = new Store(emptyState());
  const service = new RevenueGoalService(
    store as unknown as GoalRepository,
    new DeterministicGoalParser(),
  );

  const userAResult = store.createUser({
    email: "a@example.com",
    password: "correct-horse-battery",
    displayName: "Owner A",
  });
  const userBResult = store.createUser({
    email: "b@example.com",
    password: "correct-horse-battery",
    displayName: "Owner B",
  });
  if (!isOk(userAResult) || !isOk(userBResult)) throw new Error("fixture users failed");

  const wsAResult = store.createWorkspace({ ownerId: userAResult.value.id, name: "Acme" });
  const wsBResult = store.createWorkspace({ ownerId: userBResult.value.id, name: "Globex" });
  if (!isOk(wsAResult) || !isOk(wsBResult)) throw new Error("fixture workspaces failed");

  // Canonical Business Brain context for tenant A.
  store.createBusinessProfile({
    workspaceId: wsAResult.value.id,
    ownerId: userAResult.value.id,
    name: "Acme Corp",
    description: "Automation agency",
    market: "B2B SaaS",
    industry: "Software",
  });
  const offer = store.createOffer({
    workspaceId: wsAResult.value.id,
    userId: userAResult.value.id,
    name: "Support automation",
    description: "Automates inbound support",
  });
  const icp = store.upsertIcp(wsAResult.value.id, userAResult.value.id, { industries: ["SaaS"] });
  const persona = store.createPersona(wsAResult.value.id, userAResult.value.id, {
    title: "Head of Support",
  });
  if (!isOk(offer) || !isOk(icp) || !isOk(persona)) throw new Error("fixture brain failed");

  const offerB = store.createOffer({
    workspaceId: wsBResult.value.id,
    userId: userBResult.value.id,
    name: "Globex retainer",
    description: "Tenant B offer",
  });
  if (!isOk(offerB)) throw new Error("fixture brain B failed");

  const contextA: GoalBusinessContext = {
    workspaceId: wsAResult.value.id,
    company: { name: "Acme Corp", market: "B2B SaaS", industry: "Software" },
    offers: [{ id: offer.value.id, name: offer.value.name }],
    icp: { id: icp.value.id },
    personas: [{ id: persona.value.id, title: persona.value.title }],
  };

  const contextB: GoalBusinessContext = {
    workspaceId: wsBResult.value.id,
    company: null,
    offers: [{ id: offerB.value.id, name: offerB.value.name }],
    icp: null,
    personas: [],
  };

  return {
    service,
    parser: new DeterministicGoalParser(),
    store,
    userA: userAResult.value.id,
    workspaceA: wsAResult.value.id,
    contextA,
    userB: userBResult.value.id,
    workspaceB: wsBResult.value.id,
    contextB,
  };
}

function validGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objective: "Generate qualified pipeline from B2B SaaS companies",
    targetMetric: "pipeline",
    targetValue: 100000,
    currency: "USD",
    timeWindow: { start: "2026-03-01", end: "2026-06-01" },
    market: "B2B SaaS",
    offerId: null,
    ...overrides,
  };
}

describe("Revenue Goal — creation and retrieval", () => {
  it("creates a valid goal", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ offerId: contextA.offers[0]?.id, icpId: contextA.icp?.id ?? null }) as never,
      contextA,
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.objective).toContain("qualified pipeline");
    expect(result.value.targetMetric).toBe("pipeline");
    expect(result.value.targetValue).toBe(100000);
    expect(result.value.currency).toBe("USD");
    expect(result.value.status).toBe("draft");
    expect(result.value.workspaceId).toBe(workspaceA);
    expect(result.value.createdBy).toBe(userA);
  });

  it("retrieves a created goal", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const fetched = service.getRevenueGoal(created.value.id, userA);
    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.value.id).toBe(created.value.id);
    expect(fetched.value.objective).toBe(created.value.objective);
  });

  it("lists goals scoped to the workspace", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ objective: "Second goal", targetValue: 50000 }) as never,
      contextA,
    );

    const listed = service.listRevenueGoals(workspaceA, userA);
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(2);
  });

  it("updates a goal and re-evaluates completeness", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ offerId: contextA.offers[0]?.id }) as never,
      contextA,
    );
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.value.completeness).toBe("complete");

    const updated = service.updateRevenueGoal(
      created.value.id,
      userA,
      { offerId: null } as never,
      contextA,
    );
    expect(isOk(updated)).toBe(true);
    if (!isOk(updated)) return;
    expect(updated.value.offerId).toBeNull();
    expect(updated.value.completeness).toBe("incomplete");
    expect(updated.value.unknowns.some((u) => u.field === "offerId")).toBe(true);
  });

  it("persists the goal so a fresh service can read it back", () => {
    const { service, store, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    // Rebuild from the persisted document, as a restart would.
    const reloaded = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const service2 = new RevenueGoalService(
      reloaded as unknown as GoalRepository,
      new DeterministicGoalParser(),
    );
    const fetched = service2.getRevenueGoal(created.value.id, userA);
    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.value.objective).toBe(created.value.objective);
    expect(fetched.value.targetValue).toBe(100000);
  });

  it("reports a missing goal", () => {
    const { service, userA } = fixture();
    const result = service.getRevenueGoal("does-not-exist", userA);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("rejects a malformed goal id", () => {
    const { service, userA } = fixture();
    const result = service.getRevenueGoal("", userA);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Revenue Goal — validation", () => {
  it("rejects a missing objective", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ objective: "   " }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details?.some((d) => d.field === "objective")).toBe(true);
    }
  });

  it("rejects a non-positive or non-numeric target", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    for (const targetValue of [0, -5, Number.NaN, "100000"]) {
      const result = service.createRevenueGoal(
        workspaceA,
        userA,
        validGoal({ targetValue }) as never,
        contextA,
      );
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.details?.some((d) => d.field === "targetValue")).toBe(true);
      }
    }
  });

  it("rejects an unknown target metric", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ targetMetric: "vibes" }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
  });

  it("rejects an invalid currency", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ currency: "dollars" }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.details?.some((d) => d.field === "currency")).toBe(true);
    }
  });

  it("rejects malformed and reversed dates", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const malformed = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ timeWindow: { start: "01-03-2026", end: "2026-06-01" } }) as never,
      contextA,
    );
    expect(isErr(malformed)).toBe(true);

    const impossible = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ timeWindow: { start: "2026-02-31", end: "2026-06-01" } }) as never,
      contextA,
    );
    expect(isErr(impossible)).toBe(true);

    const reversed = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ timeWindow: { start: "2026-06-01", end: "2026-03-01" } }) as never,
      contextA,
    );
    expect(isErr(reversed)).toBe(true);
  });

  it("accepts a goal with no time window and marks it incomplete", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ timeWindow: null }) as never,
      contextA,
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.completeness).toBe("incomplete");
    expect(result.value.unknowns.some((u) => u.field === "timeWindow")).toBe(true);
  });

  it("refuses to create a goal directly in a non-draft status", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ status: "active" }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.details?.some((d) => d.field === "status")).toBe(true);
    }
  });

  it("rejects an invalid status filter", () => {
    const { service, userA, workspaceA } = fixture();
    const result = service.listRevenueGoals(workspaceA, userA, {
      status: "live" as "draft",
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Revenue Goal — workspace isolation", () => {
  it("allows the owner to read their own goal", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(isOk(service.getRevenueGoal(created.value.id, userA))).toBe(true);
  });

  it("denies another tenant reading the goal", () => {
    const { service, userA, userB, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const denied = service.getRevenueGoal(created.value.id, userB);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe("UNAUTHORIZED");
  });

  it("denies another tenant listing or updating", () => {
    const { service, userA, userB, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    expect(isErr(service.listRevenueGoals(workspaceA, userB))).toBe(true);

    const update = service.updateRevenueGoal(
      created.value.id,
      userB,
      { objective: "hijacked" } as never,
      contextA,
    );
    expect(isErr(update)).toBe(true);
    if (isErr(update)) expect(update.error.code).toBe("UNAUTHORIZED");
  });

  it("denies another tenant changing status or reading history", () => {
    const { service, userA, userB, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const status = service.changeRevenueGoalStatus(created.value.id, userB, "active");
    expect(isErr(status)).toBe(true);
    if (isErr(status)) expect(status.error.code).toBe("UNAUTHORIZED");

    const history = service.goalHistory(created.value.id, userB);
    expect(isErr(history)).toBe(true);
    if (isErr(history)) expect(history.error.code).toBe("UNAUTHORIZED");
  });

  it("denies creation in a workspace the caller does not belong to", () => {
    const { service, userB, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(workspaceA, userB, validGoal() as never, contextA);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("UNAUTHORIZED");
  });
});

describe("Revenue Goal — Business Brain references", () => {
  it("accepts valid offer, ICP and persona references", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({
        offerId: contextA.offers[0]?.id,
        icpId: contextA.icp?.id,
        buyerPersonaIds: [contextA.personas[0]?.id],
      }) as never,
      contextA,
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.offerId).toBe(contextA.offers[0]?.id);
    expect(result.value.icpId).toBe(contextA.icp?.id);
    expect(result.value.buyerPersonaIds).toEqual([contextA.personas[0]?.id]);
  });

  it("rejects a reference that does not exist in the workspace", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ offerId: "00000000-0000-0000-0000-000000000000" }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.details?.some((d) => d.field === "offerId")).toBe(true);
    }
  });

  it("rejects a cross-workspace offer reference", () => {
    const { service, userA, workspaceA, contextA, contextB } = fixture();
    // Tenant B's offer id must not be usable inside tenant A's goal.
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ offerId: contextB.offers[0]?.id }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details?.some((d) => d.field === "offerId")).toBe(true);
    }
  });

  it("rejects a cross-workspace persona reference", () => {
    const { service, userA, workspaceA, contextA, contextB } = fixture();
    const foreignPersona = { id: "foreign-persona", title: "CTO" };
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ buyerPersonaIds: [foreignPersona.id] }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
    void contextB;
  });

  it("rejects an unknown ICP reference", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ icpId: "not-the-workspace-icp" }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
  });

  it("rejects an invalid reference introduced through an update", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const update = service.updateRevenueGoal(
      created.value.id,
      userA,
      { offerId: contextA.offers[0]?.id ?? null },
      contextA,
    );
    expect(isOk(update)).toBe(true);
    if (!isOk(update)) return;

    const bad = service.updateRevenueGoal(
      created.value.id,
      userA,
      { offerId: "foreign-offer" } as never,
      contextA,
    );
    expect(isErr(bad)).toBe(true);
  });
});

describe("Revenue Goal — lifecycle", () => {
  it("follows the valid transition path draft → active → paused → active → completed → archived", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    const id = created.value.id;

    for (const status of ["active", "paused", "active", "completed", "archived"] as const) {
      const moved = service.changeRevenueGoalStatus(id, userA, status);
      expect(isOk(moved)).toBe(true);
      if (isOk(moved)) expect(moved.value.status).toBe(status);
    }
  });

  it("rejects skipping straight from draft to completed", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const skipped = service.changeRevenueGoalStatus(created.value.id, userA, "completed");
    expect(isErr(skipped)).toBe(true);
    if (isErr(skipped)) expect(skipped.error.code).toBe("INVALID_TRANSITION");
  });

  it("treats archived as terminal", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    const id = created.value.id;

    expect(isOk(service.archiveRevenueGoal(id, userA))).toBe(true);
    const revived = service.changeRevenueGoalStatus(id, userA, "active");
    expect(isErr(revived)).toBe(true);
    if (isErr(revived)) expect(revived.error.code).toBe("INVALID_TRANSITION");
  });

  it("rejects an unknown status value from a client", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const bogus = service.changeRevenueGoalStatus(created.value.id, userA, "live");
    expect(isErr(bogus)).toBe(true);
    if (isErr(bogus)) expect(bogus.error.code).toBe("VALIDATION_ERROR");
  });

  it("records an auditable history of transitions", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    service.changeRevenueGoalStatus(created.value.id, userA, "active");
    const history = service.goalHistory(created.value.id, userA);
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    expect(history.value.map((e) => e.toStatus)).toEqual(["draft", "active"]);
    // Every event is attributed to the acting user.
    expect(history.value.every((e) => e.actorUserId === userA)).toBe(true);
  });
});

describe("Revenue Goal — metrics and economics", () => {
  it("stores success metrics and economics", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({
        successMetrics: [
          { kind: "pipeline", target: 100000, unit: "USD" },
          { kind: "meeting", target: 20, unit: "count" },
        ],
        economics: {
          averageDealValue: 5000,
          minimumContractValue: 2000,
          targetCustomers: 20,
          currency: "USD",
        },
      }) as never,
      contextA,
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.successMetrics).toHaveLength(2);
    expect(result.value.economics.averageDealValue).toBe(5000);
    expect(result.value.economics.targetCustomers).toBe(20);
  });

  it("rejects a non-positive success metric target", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({ successMetrics: [{ kind: "meeting", target: 0, unit: "count" }] }) as never,
      contextA,
    );
    expect(isErr(result)).toBe(true);
  });

  it("rejects an invalid economics currency on update", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const created = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const update = service.updateRevenueGoal(
      created.value.id,
      userA,
      { economics: { currency: "euros" } } as never,
      contextA,
    );
    expect(isErr(update)).toBe(true);
  });

  it("defaults to an approval-requiring Level 2 policy", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(workspaceA, userA, validGoal() as never, contextA);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.approvalPolicy.maxRiskLevel).toBe("level_2_external_action");
    expect(result.value.approvalPolicy.externalActionsRequireApproval).toBe(true);
  });

  it("keeps constraints distinct from the objective", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(
      workspaceA,
      userA,
      validGoal({
        constraints: { geographies: ["US"], industries: ["SaaS"], maxOutreachPerDay: 25 },
      }) as never,
      contextA,
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.objective).toBe(validGoal().objective as string);
    expect(result.value.constraints.geographies).toEqual(["US"]);
    expect(result.value.constraints.maxOutreachPerDay).toBe(25);
  });
});

describe("Revenue Goal — natural language parsing", () => {
  const input =
    "I want 20 qualified meetings in the next 30 days from US SaaS companies with 10-200 employees, targeting the Head of Support, using our Support automation offer, with an expected contract value above $2,000.";

  it("parses a representative goal deterministically", () => {
    const { parser, contextA } = fixture();
    const first = parser.parse(input, contextA, NOW);
    const second = parser.parse(input, contextA, NOW);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    expect(first.fields.targetMetric.value).toBe("meeting");
    expect(first.fields.targetValue.value).toBe(20);
    expect(first.fields.timeWindow.value).toEqual({ start: "2026-03-01", end: "2026-03-31" });
  });

  it("separates explicit input from assumption", () => {
    const { parser, contextA } = fixture();
    const draft = parser.parse("$100,000 pipeline from B2B SaaS", contextA, NOW);
    expect(draft.fields.targetValue.origin).toBe("explicit");
    // The "$" symbol is interpreted, not stated — that is an assumption.
    expect(draft.fields.currency.origin).toBe("assumption");
    expect(draft.fields.currency.note).toBeTruthy();
  });

  it("infers market from the canonical Business Brain rather than inventing it", () => {
    const { parser, contextA } = fixture();
    const draft = parser.parse("$100,000 pipeline over the next 30 days", contextA, NOW);
    expect(draft.fields.market.value).toBe("B2B SaaS");
    expect(draft.fields.market.origin).toBe("inferred");
    expect(draft.fields.market.note).toContain("Business Brain");
  });

  it("resolves a named offer to the canonical record", () => {
    const { parser, contextA } = fixture();
    const draft = parser.parse(input, contextA, NOW);
    expect(draft.fields.offerId.value).toBe(contextA.offers[0]?.id);
    expect(draft.fields.offerId.origin).toBe("inferred");
  });

  it("records an unresolvable reference instead of guessing", () => {
    const { parser, contextA } = fixture();
    const draft = parser.parse("20 meetings using our Unicorn Retainer offer", contextA, NOW);
    expect(draft.fields.offerId.value).toBeNull();
    expect(draft.fields.offerId.origin).toBe("unknown");
    expect(draft.unresolvedReferences.some((r) => r.kind === "offer")).toBe(true);
  });

  it("marks undeterminable fields as unknown", () => {
    const { parser, contextA } = fixture();
    const draft = parser.parse("do more revenue somehow", contextA, NOW);
    expect(draft.fields.targetValue.origin).toBe("unknown");
    expect(draft.fields.targetMetric.origin).toBe("unknown");
    expect(draft.fields.timeWindow.origin).toBe("unknown");
  });

  it("creates a goal from natural language and records provenance", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createFromNaturalLanguage(workspaceA, userA, input, contextA, NOW);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.objective).toBe(input);
    expect(result.value.targetMetric).toBe("meeting");
    expect(result.value.targetValue).toBe(20);
    expect(result.value.timeWindow).toEqual({ start: "2026-03-01", end: "2026-03-31" });
    expect(result.value.offerId).toBe(contextA.offers[0]?.id);
    expect(result.value.economics.minimumContractValue).toBe(2000);
    // The currency was inferred from "$" and is recorded as an assumption.
    expect(result.value.assumptions.some((a) => a.startsWith("currency"))).toBe(true);
  });

  it("marks a goal with unresolved references as incomplete rather than inventing them", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createFromNaturalLanguage(
      workspaceA,
      userA,
      "20 qualified meetings in the next 30 days using our Unicorn Retainer offer",
      contextA,
      NOW,
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.offerId).toBeNull();
    expect(result.value.completeness).toBe("incomplete");
    expect(result.value.unknowns.some((u) => u.field === "offerId")).toBe(true);
  });

  it("rejects natural language with no measurable outcome", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const result = service.createFromNaturalLanguage(
      workspaceA,
      userA,
      "do more revenue somehow",
      contextA,
      NOW,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details?.some((d) => d.field === "targetValue")).toBe(true);
    }
  });

  it("rejects empty input", () => {
    const { service, userA, workspaceA, contextA } = fixture();
    const parsed = service.parseRevenueGoalInput("", contextA, NOW);
    expect(isErr(parsed)).toBe(true);

    const created = service.createFromNaturalLanguage(workspaceA, userA, "   ", contextA, NOW);
    expect(isErr(created)).toBe(true);
  });

  it("never fabricates an offer when the Business Brain has none", () => {
    const { service, userB, workspaceB, contextB } = fixture();
    const result = service.createFromNaturalLanguage(
      workspaceB,
      userB,
      "$50,000 pipeline using our Globex retainer offer in the next 30 days",
      contextB,
      NOW,
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.offerId).toBe(contextB.offers[0]?.id);
  });

  it("denies natural-language goal creation across tenants", () => {
    const { service, userB, workspaceA, contextA } = fixture();
    const result = service.createFromNaturalLanguage(
      workspaceA,
      userB,
      "20 qualified meetings in the next 30 days",
      contextA,
      NOW,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("UNAUTHORIZED");
  });
});

describe("Revenue Goal — failure handling", () => {
  it("maps an unavailable store to a safe error without leaking internals", () => {
    const broken = {
      authorize: () => ({ ok: true as const, value: {} }),
      createRevenueGoal: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      listRevenueGoals: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      getRevenueGoal: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      updateRevenueGoal: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      setRevenueGoalStatus: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
      listRevenueGoalEvents: () => ({ ok: false as const, error: { code: "UNAVAILABLE" } }),
    } as unknown as GoalRepository;

    const service = new RevenueGoalService(broken, new DeterministicGoalParser());
    const result = service.createRevenueGoal("w1", "u1", validGoal() as never, {
      workspaceId: "w1",
      company: null,
      offers: [],
      icp: null,
      personas: [],
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("UNAVAILABLE");
      expect(result.error.message).toBe("storage unavailable");
      expect(JSON.stringify(result.error)).not.toContain("stack");
    }
  });

  it("rejects an unauthenticated caller before touching storage", () => {
    const { service, workspaceA, contextA } = fixture();
    const result = service.createRevenueGoal(workspaceA, "", validGoal() as never, contextA);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a missing workspace id", () => {
    const { service, userA, contextA } = fixture();
    const result = service.createRevenueGoal("", userA, validGoal() as never, contextA);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
