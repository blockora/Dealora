import { describe, expect, it } from "vitest";

import { SCHEMA } from "@dealora/db";
import type { CostEventRow } from "@dealora/cost";
import { AGENT_IDS, AGENT_TOOLS, isAgentId } from "@dealora/agent";

import {
  TRACE_CRITICAL_RULE,
  TRACE_NEVER_DOES,
  TRACE_OUTCOMES,
  TRACE_RUN_STATUSES,
  TRACE_STAGES,
  TRACE_TOOLS,
  TRACE_TRACKED,
  isTerminalStatus,
  isTraceOutcome,
  isTraceRunStatus,
  isTraceStage,
  isTraceTool,
  stageDefinition,
  stageOrder,
  traceError,
} from "./rules.js";
import {
  deriveStageCounts,
  deriveTraceCost,
  deriveTraceStatus,
  deriveUsageSummary,
  outcomesOf,
  publishedOutcomes,
  sortTraceEvents,
  sortTraceRuns,
  statusDerivationRule,
  statusesAgree,
} from "./engine.js";
import type { TraceEventRow, TraceEventView, TraceOutcome, TraceRunRow } from "./types.js";

/** A stored step, with every field spelled out so nothing is inherited. */
function step(overrides: Partial<TraceEventView> = {}): TraceEventView {
  return {
    id: "e1",
    runId: "r1",
    sequence: 1,
    stepId: "step",
    attempt: 1,
    stage: "agent",
    outcome: "succeeded",
    detail: null,
    tool: null,
    referenceId: null,
    errorCode: null,
    durationMs: null,
    modelProvider: null,
    modelName: null,
    inputTokens: null,
    outputTokens: null,
    recordedBy: "u1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A stored run, with every field spelled out. */
function run(overrides: Partial<TraceRunRow> = {}): TraceRunRow {
  return {
    id: "r1",
    workspaceId: "w1",
    agentId: "strategy",
    version: "1.0.0",
    status: "open",
    openedBy: "u1",
    openedAt: "2026-01-01T00:00:00.000Z",
    closedBy: null,
    closedAt: null,
    ...overrides,
  };
}

describe("trace rules — the published vocabulary", () => {
  it("publishes exactly ROADMAP.md §27's chain, in the roadmap's order", () => {
    expect(TRACE_STAGES.map((entry) => entry.stage)).toEqual([
      "agent",
      "decision",
      "tool_call",
      "evidence",
      "result",
      "approval",
      "external_action",
    ]);
    // `position` is the sort key, so it must equal the array index exactly.
    TRACE_STAGES.forEach((entry, index) => {
      expect(entry.position).toBe(index);
      expect(stageOrder(entry.stage)).toBe(index);
    });
  });

  it("gives every stage a meaning and marks only tool_call as tool-bearing", () => {
    for (const entry of TRACE_STAGES) {
      expect(entry.meaning.length).toBeGreaterThan(0);
    }
    const toolBearing = TRACE_STAGES.filter((entry) => entry.mayNameTool);
    expect(toolBearing.map((entry) => entry.stage)).toEqual(["tool_call"]);
    expect(TRACE_STAGES.every((entry) => entry.mayCarryDuration)).toBe(true);
  });

  it("publishes three outcomes, with `unknown` among them", () => {
    expect(TRACE_OUTCOMES).toEqual(["succeeded", "failed", "unknown"]);
    expect(publishedOutcomes()).toEqual(TRACE_OUTCOMES);
  });

  it("publishes five run statuses, four of them terminal", () => {
    expect(TRACE_RUN_STATUSES.map((entry) => entry.status)).toEqual([
      "open",
      "succeeded",
      "failed",
      "unknown",
      "unverified",
    ]);
    const terminal = TRACE_RUN_STATUSES.filter((entry) => entry.terminal);
    expect(terminal).toHaveLength(4);
    expect(terminal.map((entry) => entry.status)).not.toContain("open");
    expect(isTerminalStatus("open")).toBe(false);
    for (const status of ["succeeded", "failed", "unknown", "unverified"] as const) {
      expect(isTerminalStatus(status)).toBe(true);
    }
    for (const entry of TRACE_RUN_STATUSES) expect(entry.meaning.length).toBeGreaterThan(0);
  });

  it("publishes all nine of §27's tracked dimensions, each with its source", () => {
    expect(TRACE_TRACKED.map((entry) => entry.dimension)).toEqual([
      "execution time",
      "model usage",
      "token usage",
      "tool calls",
      "errors",
      "retries",
      "approvals",
      "external actions",
      "cost",
    ]);
    for (const entry of TRACE_TRACKED) expect(entry.source.length).toBeGreaterThan(0);
  });

  it("reuses @dealora/agent's tool vocabulary rather than restating it", () => {
    expect(TRACE_TOOLS).toEqual(AGENT_TOOLS.map((tool) => tool.tool));
    expect(TRACE_TOOLS).toHaveLength(18);
    for (const tool of TRACE_TOOLS) expect(isTraceTool(tool)).toBe(true);
    expect(isTraceTool("delete_everything")).toBe(false);
  });

  it("recognises only published values", () => {
    for (const entry of TRACE_STAGES) expect(isTraceStage(entry.stage)).toBe(true);
    for (const outcome of TRACE_OUTCOMES) expect(isTraceOutcome(outcome)).toBe(true);
    for (const entry of TRACE_RUN_STATUSES) expect(isTraceRunStatus(entry.status)).toBe(true);
    expect(isTraceStage("tool_call_out")).toBe(false);
    expect(isTraceOutcome("probably")).toBe(false);
    expect(isTraceRunStatus("done")).toBe(false);
    expect(stageDefinition("nonsense")).toBeNull();
    expect(stageOrder("nonsense")).toBe(-1);
  });

  it("states the critical rule and the negative space", () => {
    expect(TRACE_CRITICAL_RULE).toContain("never silently pretend an action succeeded");
    expect(TRACE_CRITICAL_RULE).toContain("unknown");
    expect(TRACE_NEVER_DOES.length).toBeGreaterThanOrEqual(10);
    const joined = TRACE_NEVER_DOES.join(" ");
    for (const forbidden of ["runner", "invokes a tool", "model client", "network"]) {
      expect(joined).toContain(forbidden);
    }
  });

  it("builds an error with and without field details", () => {
    expect(traceError("NOT_FOUND", "gone")).toEqual({ code: "NOT_FOUND", message: "gone" });
    expect(traceError("VALIDATION_ERROR", "bad", [{ field: "stage", message: "unknown" }])).toEqual(
      {
        code: "VALIDATION_ERROR",
        message: "bad",
        details: [{ field: "stage", message: "unknown" }],
      },
    );
    expect(traceError("CONFLICT", "same", [])).toEqual({ code: "CONFLICT", message: "same" });
  });
});

describe("trace rules — no drift from the schema", () => {
  /** The one `CREATE TABLE` statement for a table, sliced out of the DDL. */
  function statement(table: string): string {
    const start = SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS "${table}"`);
    expect(start, table).toBeGreaterThan(-1);
    return SCHEMA.slice(start, SCHEMA.indexOf(";", start));
  }

  /**
   * The quoted values of one column's `IN (...)` CHECK, in DDL order.
   *
   * Read by locating the column and taking the next `IN (...)` list after it,
   * rather than by one big pattern: this file's DDL attaches each constraint as
   * `"table"."column" CHECK ("table"."column" IN (...))`, and a regex written
   * against one column's punctuation would silently stop matching if a future
   * constraint ever attaches differently.
   */
  function checkedValues(ddl: string, column: string): string[] {
    const at = ddl.indexOf(`"${column}"`);
    expect(at, column).toBeGreaterThan(-1);
    const listAt = ddl.indexOf("IN (", at);
    expect(listAt, `${column} has no IN (...) check`).toBeGreaterThan(-1);
    return ddl
      .slice(listAt + 4, ddl.indexOf(")", listAt))
      .split(",")
      .map((entry) => entry.trim().replaceAll("'", ""));
  }

  it("publishes exactly the stages the events table CHECK accepts", () => {
    expect(checkedValues(statement("agent_trace_events"), "stage")).toEqual(
      TRACE_STAGES.map((entry) => entry.stage),
    );
  });

  it("publishes exactly the outcomes the events table CHECK accepts", () => {
    expect(checkedValues(statement("agent_trace_events"), "outcome")).toEqual([...TRACE_OUTCOMES]);
  });

  it("publishes exactly the run statuses the runs table CHECK accepts", () => {
    expect(checkedValues(statement("agent_trace_runs"), "status")).toEqual(
      TRACE_RUN_STATUSES.map((entry) => entry.status),
    );
  });

  it("restricts the runs table to the twelve declared agent ids", () => {
    expect(checkedValues(statement("agent_trace_runs"), "agent_id")).toEqual([...AGENT_IDS]);
    expect(AGENT_IDS.every((id) => isAgentId(id))).toBe(true);
  });

  it("keeps the cost execution kind Phase 20 added, and only that one", () => {
    expect(checkedValues(statement("cost_events"), "execution_kind")).toEqual([
      "research_run",
      "outbound_send",
      "meeting_booking",
      "agent_run",
      "crm_sync",
    ]);
  });

  it("stores no computed outcome, pass, total or evaluation verdict", () => {
    // The run's status is derived from the rows below it, and Phase 19's
    // judgements live in their own table. A stored column for any of these would
    // be a value a caller could write and the trace would then report.
    const events = statement("agent_trace_events");
    for (const forbidden of [
      "passed",
      "threshold",
      "rate",
      "total",
      "verdict",
      "evaluated",
      "workspace_id_",
    ]) {
      expect(events, forbidden).not.toContain(`"${forbidden}"`);
    }
    // What it does store: what was reported, and where it came from.
    expect(events).toContain('"stage"');
    expect(events).toContain('"outcome"');
    expect(events).toContain('"sequence"');
    expect(events).toContain('"attempt"');
    expect(events).toContain('"recorded_by"');
  });

  it("constrains the run table so a closed run always names who closed it", () => {
    const runs = statement("agent_trace_runs");
    expect(runs).toContain('"closed_at"');
    expect(runs).toContain('"closed_by"');
    // Both halves of the agreement: an open run has neither, a closed run both.
    expect(runs).toContain("= 'open'");
    expect(runs).toContain("<> 'open'");
  });

  it("constrains sequence and attempt to be positive, and pins both per run", () => {
    const events = statement("agent_trace_events");
    expect(events).toContain(
      '"agent_trace_events"."sequence" CHECK ("agent_trace_events"."sequence" > 0)',
    );
    expect(events).toContain(
      '"agent_trace_events"."attempt" CHECK ("agent_trace_events"."attempt" > 0)',
    );
    // Two uniqueness keys, and both are what makes the ordering total: one per
    // (run, sequence) and one per (run, step, attempt).
    expect(events).toContain(
      'UNIQUE("agent_trace_events"."run_id", "agent_trace_events"."sequence")',
    );
    expect(events).toContain(
      'UNIQUE("agent_trace_events"."run_id", "agent_trace_events"."step_id", "agent_trace_events"."attempt")',
    );
    expect(events.match(/UNIQUE\(/g)).toHaveLength(2);
  });

  it("forbids an error code on a step that did not fail", () => {
    expect(statement("agent_trace_events")).toContain(
      '"agent_trace_events"."error_code" CHECK ("agent_trace_events"."error_code" IS NULL',
    );
    expect(statement("agent_trace_events")).toContain("= 'failed')");
  });

  it("forbids naming a tool on any stage but tool_call", () => {
    expect(statement("agent_trace_events")).toContain(
      '"agent_trace_events"."tool" CHECK ("agent_trace_events"."tool" IS NULL',
    );
    expect(statement("agent_trace_events")).toContain("= 'tool_call')");
  });
});

describe("deriveTraceStatus — ROADMAP.md §27's critical rule", () => {
  it("reports unverified for a run with no recorded outcome at all", () => {
    // The load-bearing case: closing an empty trace must never report success.
    expect(deriveTraceStatus([])).toBe("unverified");
  });

  it("reports succeeded only when a success exists and nothing contradicts it", () => {
    expect(deriveTraceStatus(["succeeded"])).toBe("succeeded");
    expect(deriveTraceStatus(["succeeded", "succeeded"])).toBe("succeeded");
  });

  it("lets one failure outrank every success", () => {
    expect(deriveTraceStatus(["succeeded", "failed"])).toBe("failed");
    expect(deriveTraceStatus(["succeeded", "succeeded", "failed"])).toBe("failed");
    // Order must not matter: a failure anywhere wins.
    expect(deriveTraceStatus(["failed", "succeeded"])).toBe("failed");
  });

  it("reports unknown rather than succeeded when something was left open", () => {
    expect(deriveTraceStatus(["unknown"])).toBe("unknown");
    expect(deriveTraceStatus(["succeeded", "unknown"])).toBe("unknown");
    expect(deriveTraceStatus(["succeeded", "unknown", "failed"])).toBe("failed");
  });

  it("never produces a status outside the published five", () => {
    const every: TraceOutcome[] = ["succeeded", "failed", "unknown"];
    for (const a of every) {
      for (const b of every) {
        for (const c of every) {
          expect(isTraceRunStatus(deriveTraceStatus([a, b, c]))).toBe(true);
        }
      }
      expect(isTraceRunStatus(deriveTraceStatus([a]))).toBe(true);
    }
    expect(isTraceRunStatus(deriveTraceStatus([]))).toBe(true);
  });

  it("is a pure function of its input", () => {
    const outcomes: TraceOutcome[] = ["succeeded", "unknown"];
    expect(deriveTraceStatus(outcomes)).toBe(deriveTraceStatus(outcomes));
    expect(statusesAgree("unknown", deriveTraceStatus(outcomes))).toBe(true);
    expect(statusesAgree("succeeded", deriveTraceStatus(outcomes))).toBe(false);
  });

  it("describes the rule it implements", () => {
    const described = statusDerivationRule();
    for (const status of ["failed", "unknown", "succeeded", "unverified"]) {
      expect(described).toContain(status);
    }
  });
});

describe("deriveStageCounts — the whole chain, always", () => {
  it("reports all seven stages even when the run recorded nothing", () => {
    const counts = deriveStageCounts([]);
    expect(counts).toHaveLength(7);
    for (const entry of counts) {
      expect(entry.count).toBe(0);
      expect(entry.succeeded).toBe(0);
      expect(entry.failed).toBe(0);
      expect(entry.unknown).toBe(0);
      expect(entry.retried).toBe(0);
    }
    // "No approval was requested" must be visible as zero, never as absence.
    expect(counts.find((entry) => entry.stage === "approval")?.count).toBe(0);
  });

  it("counts outcomes and retries per stage", () => {
    const counts = deriveStageCounts([
      step({ stage: "tool_call", outcome: "failed", attempt: 1 }),
      step({ stage: "tool_call", outcome: "succeeded", attempt: 2 }),
      step({ stage: "result", outcome: "succeeded" }),
    ]);
    const tool = counts.find((entry) => entry.stage === "tool_call");
    expect(tool).toEqual({
      stage: "tool_call",
      count: 2,
      succeeded: 1,
      failed: 1,
      unknown: 0,
      retried: 1,
    });
    expect(counts.find((entry) => entry.stage === "result")?.succeeded).toBe(1);
  });
});

describe("deriveUsageSummary — the nine tracked dimensions", () => {
  it("reports nothing measured for an empty trace, never zero", () => {
    const usage = deriveUsageSummary([]);
    expect(usage.slowestStepMs).toBeNull();
    expect(usage.slowestStepId).toBeNull();
    expect(usage.modelInvocations).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.retryCount).toBe(0);
    expect(usage.errorCount).toBe(0);
    expect(usage.toolsInvoked).toEqual([]);
    expect(usage.models).toEqual([]);
  });

  it("takes the slowest step, never a sum or an average", () => {
    const usage = deriveUsageSummary([
      step({ stepId: "a", durationMs: 100 }),
      step({ stepId: "b", durationMs: 900 }),
      step({ stepId: "c", durationMs: 400 }),
    ]);
    expect(usage.slowestStepMs).toBe(900);
    expect(usage.slowestStepId).toBe("b");
    // The sum would be 1400; reporting it would invent a span the run never had.
    expect(usage.slowestStepMs).not.toBe(1400);
  });

  it("ignores a step that reported no duration rather than counting it as zero", () => {
    const usage = deriveUsageSummary([
      step({ stepId: "a", durationMs: null }),
      step({ stepId: "b", durationMs: 250 }),
    ]);
    expect(usage.slowestStepMs).toBe(250);
    expect(usage.slowestStepId).toBe("b");
  });

  it("breaks a duration tie on sequence, not on the order steps arrived in", () => {
    // Two steps reporting the same duration is ordinary. The tie-break is the
    // server-derived sequence, so storage order cannot change the answer.
    const first = deriveUsageSummary([
      step({ stepId: "a", sequence: 1, durationMs: 500 }),
      step({ stepId: "b", sequence: 2, durationMs: 500 }),
    ]);
    const second = deriveUsageSummary([
      step({ stepId: "b", sequence: 2, durationMs: 500 }),
      step({ stepId: "a", sequence: 1, durationMs: 500 }),
    ]);
    expect(first.slowestStepMs).toBe(500);
    expect(first.slowestStepId).toBe("a");
    expect(second.slowestStepId).toBe("a");
  });

  it("sums tokens exactly and counts model invocations", () => {
    const usage = deriveUsageSummary([
      step({ modelProvider: "openai", modelName: "m", inputTokens: 10, outputTokens: 3 }),
      step({ modelProvider: "openai", modelName: "m", inputTokens: 5, outputTokens: 2 }),
    ]);
    expect(usage.modelInvocations).toBe(2);
    expect(usage.inputTokens).toBe(15);
    expect(usage.outputTokens).toBe(5);
    expect(usage.models).toEqual([{ provider: "openai", model: "m" }]);
  });

  it("distinguishes two providers offering a model of the same name", () => {
    const usage = deriveUsageSummary([
      step({ modelProvider: "openai", modelName: "shared", inputTokens: 1 }),
      step({ modelProvider: "anthropic", modelName: "shared", inputTokens: 2 }),
    ]);
    expect(usage.models).toHaveLength(2);
    expect(usage.models.map((entry) => entry.provider).sort()).toEqual(["anthropic", "openai"]);
  });

  it("prints invoked tools in the published tool order, not storage order", () => {
    const usage = deriveUsageSummary([
      step({ stage: "tool_call", tool: "record_cost" }),
      step({ stage: "tool_call", tool: "read_accounts" }),
    ]);
    expect(usage.toolsInvoked).toEqual(["read_accounts", "record_cost"]);
    expect(TRACE_TOOLS.indexOf("read_accounts")).toBeLessThan(TRACE_TOOLS.indexOf("record_cost"));
  });

  it("counts retries, errors, approvals and external actions separately", () => {
    const usage = deriveUsageSummary([
      step({ stage: "tool_call", outcome: "failed", attempt: 1 }),
      step({ stage: "tool_call", outcome: "succeeded", attempt: 2 }),
      step({ stage: "approval", outcome: "succeeded" }),
      step({ stage: "approval", outcome: "failed" }),
      step({ stage: "external_action", outcome: "succeeded" }),
      step({ stage: "external_action", outcome: "unknown" }),
      step({ stage: "external_action", outcome: "failed" }),
    ]);
    expect(usage.retryCount).toBe(1);
    expect(usage.errorCount).toBe(3);
    expect(usage.approvalsRequested).toBe(2);
    expect(usage.approvalsGranted).toBe(1);
    expect(usage.externalActions).toBe(3);
    // The gap between these two numbers is the unverified part of the run.
    expect(usage.externalActionsSucceeded).toBe(1);
  });

  it("saturates rather than wrapping an absurd token total", () => {
    const usage = deriveUsageSummary([
      step({ modelName: "m", inputTokens: Number.MAX_SAFE_INTEGER }),
      step({ modelName: "m", inputTokens: 10 }),
    ]);
    expect(usage.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("deriveTraceCost — Phase 16's facts, Phase 16's arithmetic", () => {
  it("reports null for a run with no cost facts, never a zero", () => {
    expect(deriveTraceCost([])).toBeNull();
  });

  it("totals facts with @dealora/cost's own derivation", () => {
    // Typed as Phase 16's own row, so the vocabulary is checked here rather
    // than widened into the function under test.
    const facts: CostEventRow[] = [
      {
        id: "c1",
        workspaceId: "w1",
        executionKind: "agent_run",
        executionId: "r1",
        category: "llm",
        basis: "measured",
        amountMinor: 120,
        currency: "USD",
        source: null,
        occurredAt: "2026-01-01T00:00:00.000Z",
        idempotencyKey: "k1",
        createdBy: "u1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "c2",
        workspaceId: "w1",
        executionKind: "agent_run",
        executionId: "r1",
        category: "tool",
        basis: "estimated",
        amountMinor: 30,
        currency: "USD",
        source: null,
        occurredAt: "2026-01-01T00:00:01.000Z",
        idempotencyKey: "k2",
        createdBy: "u1",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ];
    const breakdown = deriveTraceCost(facts);
    expect(breakdown).not.toBeNull();
    expect(breakdown?.totalMinor).toBe(150);
    expect(breakdown?.measuredMinor).toBe(120);
    expect(breakdown?.estimatedMinor).toBe(30);
    expect(breakdown?.eventCount).toBe(2);
    expect(breakdown?.currency).toBe("USD");
  });
});

describe("ordering — total, deterministic, and not id-based", () => {
  it("sorts steps by sequence and is stable when given in any order", () => {
    const rows = [
      step({ id: "e3", sequence: 3 }),
      step({ id: "e1", sequence: 1 }),
      step({ id: "e2", sequence: 2 }),
    ];
    expect(sortTraceEvents(rows).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(sortTraceEvents([...rows].reverse()).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it("orders same-millisecond steps by their sequence, not their timestamp", () => {
    // Two steps recorded in one millisecond is ordinary; the trace still has one
    // defined order because the key is the server-derived sequence.
    const same = "2026-01-01T00:00:00.000Z";
    const rows = [
      step({ id: "b", sequence: 2, recordedAt: same }),
      step({ id: "a", sequence: 1, recordedAt: same }),
    ];
    const sorted = sortTraceEvents(rows);
    expect(sorted.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(sorted.every((entry) => entry.recordedAt === same)).toBe(true);
  });

  it("sorts runs by (agentId, id) — both stable fields", () => {
    const rows = [
      run({ id: "r2", agentId: "strategy" }),
      run({ id: "r1", agentId: "qualification" }),
      run({ id: "r3", agentId: "strategy" }),
    ];
    // qualification first (by agent id), then the two strategy runs by id.
    expect(sortTraceRuns(rows).map((entry) => entry.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("reads a run's outcomes in step order", () => {
    const rows = [
      step({ sequence: 2, outcome: "failed" }),
      step({ sequence: 1, outcome: "succeeded" }),
    ];
    expect(outcomesOf(rows)).toEqual(["succeeded", "failed"]);
  });
});

describe("the row shapes the engine reads", () => {
  it("accepts a fully-populated stored step", () => {
    const row: TraceEventRow = {
      id: "e1",
      workspaceId: "w1",
      runId: "r1",
      sequence: 1,
      stepId: "s",
      attempt: 1,
      stage: "tool_call",
      outcome: "succeeded",
      detail: "d",
      tool: "read_accounts",
      referenceId: "a1",
      errorCode: null,
      durationMs: 5,
      modelProvider: null,
      modelName: null,
      inputTokens: null,
      outputTokens: null,
      recordedBy: "u1",
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(row.stage).toBe("tool_call");
    expect(row.tool).not.toBeNull();
  });
});
