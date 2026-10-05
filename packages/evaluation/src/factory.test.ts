import { describe, expect, it } from "vitest";

import { createEvaluationService, createProductionGate } from "./factory.js";
import type { EvaluationLookup } from "./factory.js";
import type {
  EvaluationObservationRow,
  EvaluationRunRow,
  EvaluationStorageResult,
} from "./types.js";

/**
 * A lookup that records what it was asked and answers from memory.
 *
 * It implements only the six methods `EvaluationLookup` declares, which is the
 * point: the factory's types are what stop the service reaching a writer, a
 * runner or a wider row.
 */
class SpyLookup implements EvaluationLookup {
  readonly calls: string[] = [];
  runs: EvaluationRunRow[] = [];
  observations: EvaluationObservationRow[] = [];
  failure: string | null = null;

  /**
   * Arrow properties rather than methods, because the factory spreads the
   * lookup exactly as the production wiring supplies it: the store's methods,
   * already bound. A prototype method would lose its receiver on the way
   * through, and the failure would be in the test rather than the wiring.
   */
  private answer = <T>(name: string, value: T): EvaluationStorageResult<T> => {
    this.calls.push(name);
    if (this.failure !== null) return { ok: false, error: { code: this.failure } };
    return { ok: true, value };
  };

  authorize = (): EvaluationStorageResult<unknown> => this.answer("authorize", true);

  createAgentEvaluationRun = (input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): EvaluationStorageResult<EvaluationRunRow> => {
    this.calls.push("createAgentEvaluationRun");
    if (this.failure !== null) return { ok: false, error: { code: this.failure } };
    const row: EvaluationRunRow = {
      id: `run-${this.runs.length + 1}`,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      version: input.version,
      runNumber: this.runs.length + 1,
      createdBy: input.userId,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    this.runs.push(row);
    return { ok: true, value: row };
  };

  getCurrentAgentEvaluationRun = (input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): EvaluationStorageResult<EvaluationRunRow | null> =>
    this.answer(
      "getCurrentAgentEvaluationRun",
      this.runs.find(
        (row) =>
          row.workspaceId === input.workspaceId &&
          row.agentId === input.agentId &&
          row.version === input.version,
      ) ?? null,
    );

  listAgentEvaluationRuns = (): EvaluationStorageResult<readonly EvaluationRunRow[]> =>
    this.answer("listAgentEvaluationRuns", this.runs);

  createAgentEvaluationObservation = (
    input: Parameters<EvaluationLookup["createAgentEvaluationObservation"]>[0],
  ): EvaluationStorageResult<EvaluationObservationRow> => {
    this.calls.push("createAgentEvaluationObservation");
    if (this.failure !== null) return { ok: false, error: { code: this.failure } };
    const row: EvaluationObservationRow = {
      id: `obs-${this.observations.length + 1}`,
      workspaceId: input.workspaceId,
      runId: input.runId,
      metric: input.metric,
      subjectId: input.subjectId,
      verdict: input.verdict,
      amountMinor: input.amountMinor,
      durationMs: input.durationMs,
      note: input.note,
      createdBy: input.userId,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    this.observations.push(row);
    return { ok: true, value: row };
  };

  listAgentEvaluationObservations = (
    _workspaceId: string,
    _userId: string,
    runId: string,
  ): EvaluationStorageResult<readonly EvaluationObservationRow[]> =>
    this.answer(
      "listAgentEvaluationObservations",
      this.observations.filter((row) => row.runId === runId),
    );
}

describe("createEvaluationService", () => {
  it("passes every lookup through unchanged", async () => {
    const lookup = new SpyLookup();
    const service = createEvaluationService(lookup);
    const opened = service.openRun("ws-1", "user-1", "analytics");
    expect(opened.ok).toBe(true);
    const recorded = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "cost",
      subjectId: "run-1",
      amountMinor: 100,
    });
    expect(recorded.ok).toBe(true);
    const report = service.report("ws-1", "user-1", "analytics");
    expect(report.ok).toBe(true);
    expect(lookup.calls).toEqual([
      "authorize",
      "createAgentEvaluationRun",
      "authorize",
      "getCurrentAgentEvaluationRun",
      "createAgentEvaluationObservation",
      "authorize",
      "getCurrentAgentEvaluationRun",
      "listAgentEvaluationObservations",
    ]);
  });

  it("asks storage for the declared version, never one a caller named", () => {
    const lookup = new SpyLookup();
    const service = createEvaluationService(lookup);
    service.openRun("ws-1", "user-1", "analytics");
    expect(lookup.runs[0]?.version).toBe("1.0.0");
  });

  it("surfaces a storage failure as an unavailable domain error", () => {
    const lookup = new SpyLookup();
    lookup.failure = "UNAVAILABLE";
    const service = createEvaluationService(lookup);
    const failed = service.report("ws-1", "user-1", "analytics");
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("UNAVAILABLE");
      expect(failed.error.message).toBe("evaluation storage unavailable");
    }
  });
});

describe("createProductionGate", () => {
  const query = {
    workspaceId: "ws-1",
    userId: "user-1",
    agentId: "analytics" as const,
    version: "1.0.0",
  };

  it("refuses an unmeasured agent and says which metrics are missing", () => {
    const gate = createProductionGate(createEvaluationService(new SpyLookup()));
    const answer = gate(query);
    expect(answer.satisfied).toBe(false);
    expect(answer.reason).toContain("insufficient_evidence");
  });

  it("fails closed when the evidence cannot be read at all", () => {
    const lookup = new SpyLookup();
    lookup.failure = "UNAVAILABLE";
    const gate = createProductionGate(createEvaluationService(lookup));
    const answer = gate(query);
    // An outage must never be read as permission.
    expect(answer.satisfied).toBe(false);
    expect(answer.reason).toContain("could not be read");
  });

  it("fails closed for an agent outside the twelve rather than throwing", () => {
    // The typed query only admits one of the twelve, so this state is only
    // reachable from unvalidated input — which is exactly why it is tested.
    const service = createEvaluationService(new SpyLookup());
    const refused = service.gate("ws-1", "user-1", "sales_agent");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("VALIDATION_ERROR");
  });

  it("always returns a reason, because a bare boolean is not reviewable", () => {
    const gate = createProductionGate(createEvaluationService(new SpyLookup()));
    expect(gate(query).reason.length).toBeGreaterThan(0);
  });
});
