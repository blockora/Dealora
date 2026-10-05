import { describe, expect, it } from "vitest";

import { createDashboardService } from "./factory.js";
import type { DashboardLookup, DashboardReaders } from "./factory.js";
import type { StorageResult, WorkspaceCostMetrics } from "./types.js";

const WORKSPACE = "ws-1";
const USER = "user-1";

const cost: WorkspaceCostMetrics = {
  ruleVersion: "cost-1.0.0",
  totals: {
    currency: "USD",
    eventCount: 2,
    totalMinor: 400,
    estimatedMinor: 400,
    measuredMinor: 0,
    supersededEstimateMinor: 0,
    byCategory: [],
  },
  denominators: { prospects: 1, qualifiedOpportunities: 0, meetings: 1 },
  metrics: [],
  refused: [],
};

const board = { ruleVersion: "next-action-1.0.0", recommendations: [] };

/** A lookup that answers empty lists for any authorized read. */
function emptyLookup(overrides: Partial<DashboardLookup> = {}): DashboardLookup {
  const authorized: StorageResult<true> = { ok: true, value: true };
  const rows = <T>(): StorageResult<readonly T[]> => ({ ok: true, value: [] });
  return {
    authorize: () => authorized,
    listRevenueGoals: rows,
    listQualifications: rows,
    listConversationClassifications: rows,
    listMeetings: rows,
    listMeetingEvents: rows,
    listResearchRequests: rows,
    listDrafts: rows,
    listApprovalRequests: rows,
    listOutboundActions: rows,
    ...overrides,
  };
}

function readers(overrides: Partial<DashboardReaders> = {}): DashboardReaders {
  return {
    costMetrics: () => ({ ok: true, value: cost }),
    nextActionBoard: () => ({ ok: true, value: board }),
    ...overrides,
  };
}

describe("createDashboardService", () => {
  it("returns a service that answers a snapshot through the wired lookup", () => {
    const service = createDashboardService(emptyLookup(), readers());
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a snapshot");
    expect(result.value.cost).toEqual(cost);
    expect(result.value.nextBestActions).toEqual(board);
  });

  it("uses the two cross-phase readers it was given, not its own", () => {
    const asked: string[] = [];
    const service = createDashboardService(
      emptyLookup(),
      readers({
        costMetrics: () => {
          asked.push("costMetrics");
          return { ok: true, value: cost };
        },
        nextActionBoard: () => {
          asked.push("nextActionBoard");
          return { ok: true, value: board };
        },
      }),
    );
    service.snapshot(WORKSPACE, USER);
    expect(asked).toEqual(["costMetrics", "nextActionBoard"]);
  });

  it("passes the caller's workspace and identity through to every read", () => {
    const seen: { method: string; workspaceId: string; userId: string }[] = [];
    const watch = (method: string) => (workspaceId: string, userId: string) => {
      seen.push({ method, workspaceId, userId });
      return { ok: true, value: [] } as StorageResult<readonly never[]>;
    };
    const service = createDashboardService(
      emptyLookup({
        listRevenueGoals: watch("listRevenueGoals"),
        listDrafts: watch("listDrafts"),
      }),
      readers(),
    );
    service.snapshot(WORKSPACE, USER);
    expect(seen).toEqual([
      { method: "listRevenueGoals", workspaceId: WORKSPACE, userId: USER },
      { method: "listDrafts", workspaceId: WORKSPACE, userId: USER },
    ]);
  });

  it("refuses through the lookup's own authorization gate", () => {
    const service = createDashboardService(
      emptyLookup({
        authorize: () => ({ ok: false, error: { code: "UNAUTHORIZED" } }),
      }),
      readers(),
    );
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("surfaces a reader's refusal rather than substituting a value", () => {
    const service = createDashboardService(
      emptyLookup(),
      readers({
        costMetrics: () => ({ ok: false, error: { code: "NOT_FOUND" } }),
      }),
    );
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("wires the lookup's authorization ahead of every list read", () => {
    const order: string[] = [];
    const authorized: StorageResult<true> = { ok: true, value: true };
    const service = createDashboardService(
      emptyLookup({
        authorize: () => {
          order.push("authorize");
          return authorized;
        },
        listRevenueGoals: () => {
          order.push("listRevenueGoals");
          return { ok: true, value: [] };
        },
      }),
      readers(),
    );
    service.snapshot(WORKSPACE, USER);
    expect(order[0]).toBe("authorize");
  });
});
