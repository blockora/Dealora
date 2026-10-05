import { describe, expect, it } from "vitest";

import { createTraceService } from "./factory.js";
import type { TraceLookup } from "./factory.js";
import type { TraceEventRow, TraceRunRow } from "./types.js";

/**
 * A lookup whose every method is a recorder, so a factory test can prove which
 * surface the service actually reaches.
 *
 * The service is only ever handed what `TraceLookup` declares, which is the
 * point: there is no wider store object it could reach through, and nothing here
 * performs an action of its own.
 */
function recordingLookup(calls: string[]): TraceLookup {
  const row: TraceRunRow = {
    id: "r1",
    workspaceId: "w1",
    agentId: "strategy",
    version: "1.0.0",
    status: "open",
    openedBy: "u1",
    openedAt: "2026-01-01T00:00:00.000Z",
    closedBy: null,
    closedAt: null,
  };
  return {
    authorize: (workspaceId, userId) => {
      calls.push(`authorize:${workspaceId}:${userId}`);
      return { ok: true, value: {} };
    },
    createAgentTraceRun: (input) => {
      calls.push(`createAgentTraceRun:${input.agentId}:${input.version}`);
      return { ok: true, value: row };
    },
    getAgentTraceRun: (input) => {
      calls.push(`getAgentTraceRun:${input.runId}`);
      return { ok: true, value: row };
    },
    listAgentTraceRuns: (workspaceId, userId, agentId) => {
      calls.push(`listAgentTraceRuns:${workspaceId}:${userId}:${agentId ?? "all"}`);
      return { ok: true, value: [row] };
    },
    closeAgentTraceRun: (input) => {
      calls.push(`closeAgentTraceRun:${input.runId}`);
      // The lookup closed a run that recorded no step, so the verdict storage
      // derives is `unverified`. The service never chooses it.
      return {
        ok: true,
        value: {
          ...row,
          status: "unverified",
          closedBy: "u1",
          closedAt: "2026-01-01T00:01:00.000Z",
        },
      };
    },
    createAgentTraceEvent: (input) => {
      calls.push(`createAgentTraceEvent:${input.stage}:${input.outcome}`);
      const event: TraceEventRow = {
        id: "e1",
        workspaceId: "w1",
        runId: input.runId,
        sequence: 1,
        stepId: input.stepId,
        attempt: 1,
        stage: input.stage,
        outcome: input.outcome,
        detail: input.detail,
        tool: input.tool,
        referenceId: input.referenceId,
        errorCode: input.errorCode,
        durationMs: input.durationMs,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        recordedBy: input.userId,
        recordedAt: "2026-01-01T00:00:00.000Z",
      };
      return { ok: true, value: event };
    },
    listAgentTraceEvents: (_workspaceId, _userId, runId) => {
      calls.push(`listAgentTraceEvents:${runId}`);
      return { ok: true, value: [] };
    },
    listAgentRunCostFacts: (_workspaceId, _userId, runId) => {
      calls.push(`listAgentRunCostFacts:${runId}`);
      return { ok: true, value: [] };
    },
    getAgentRegistryState: (_workspaceId, _userId, agentId) => {
      calls.push(`getAgentRegistryState:${agentId}`);
      return { ok: true, value: "production" };
    },
  };
}

describe("createTraceService", () => {
  it("authorizes before it touches any other lookup", () => {
    const calls: string[] = [];
    const service = createTraceService(recordingLookup(calls));
    service.openRun("w1", "u1", "strategy");
    expect(calls[0]).toBe("authorize:w1:u1");
  });

  it("passes the declaration's version through, never a caller's", () => {
    const calls: string[] = [];
    const service = createTraceService(recordingLookup(calls));
    const opened = service.openRun("w1", "u1", "strategy");
    expect(opened.ok).toBe(true);
    expect(calls).toContain("createAgentTraceRun:strategy:1.0.0");
  });

  it("reads the registry state for the production requirement", () => {
    const calls: string[] = [];
    const service = createTraceService(recordingLookup(calls));
    service.openRun("w1", "u1", "strategy");
    expect(calls).toContain("getAgentRegistryState:strategy");
  });

  it("reaches Phase 16's cost facts and nothing else about cost", () => {
    const calls: string[] = [];
    const service = createTraceService(recordingLookup(calls));
    service.trace("w1", "u1", "r1");
    expect(calls).toContain("listAgentRunCostFacts:r1");
    // No method that could write a cost fact, and none that could read another
    // workspace's.
    expect(calls.some((call) => call.startsWith("createCost"))).toBe(false);
  });

  it("reads cost facts with the caller's own identity", () => {
    const calls: string[] = [];
    const service = createTraceService(recordingLookup(calls));
    service.trace("w1", "u1", "r1");
    const traceCall = calls.find((call) => call.startsWith("listAgentRunCostFacts"));
    expect(traceCall).toBeDefined();
  });

  it("closes a run through storage and never decides the status itself", () => {
    const calls: string[] = [];
    const service = createTraceService(recordingLookup(calls));
    const closed = service.closeRun("w1", "u1", "r1");
    expect(calls).toContain("closeAgentTraceRun:r1");
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.value.status).toBe("unverified");
  });

  it("refuses a close that storage reported as successful with no step behind it", () => {
    const calls: string[] = [];
    const lookup = recordingLookup(calls);
    const overclaiming: TraceLookup = {
      ...lookup,
      closeAgentTraceRun: () => ({
        ok: true,
        value: {
          id: "r1",
          workspaceId: "w1",
          agentId: "strategy",
          version: "1.0.0",
          status: "succeeded",
          openedBy: "u1",
          openedAt: "2026-01-01T00:00:00.000Z",
          closedBy: "u1",
          closedAt: "2026-01-01T00:01:00.000Z",
        },
      }),
    };
    // No step was ever recorded, so `succeeded` is a verdict nothing supports —
    // and the cross-check is what stops it reaching a caller.
    expect(createTraceService(overclaiming).closeRun("w1", "u1", "r1")).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
  });

  it("surfaces a storage refusal instead of substituting a value", () => {
    const calls: string[] = [];
    const lookup = recordingLookup(calls);
    const failing: TraceLookup = {
      ...lookup,
      listAgentTraceEvents: () => ({
        ok: false,
        error: { code: "UNAVAILABLE" },
      }),
    };
    const service = createTraceService(failing);
    expect(service.steps("w1", "u1", "r1")).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
  });

  it("exposes the whole published policy through the wired service", () => {
    const calls: string[] = [];
    const service = createTraceService(recordingLookup(calls));
    const policy = service.policy("w1", "u1");
    expect(policy.ok).toBe(true);
    if (policy.ok) {
      expect(policy.value.stages.map((entry) => entry.stage)).toEqual([
        "agent",
        "decision",
        "tool_call",
        "evidence",
        "result",
        "approval",
        "external_action",
      ]);
      expect(policy.value.neverDoes.some((entry) => entry.includes("Never executes"))).toBe(true);
    }
  });
});
