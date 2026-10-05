import { beforeEach, describe, expect, it } from "vitest";

import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";

import { TraceService } from "./service.js";
import type { TraceEventRow, TraceRepository, TraceRunRow, TraceStorageResult } from "./types.js";

const WORKSPACE = "w1";
const OTHER = "w2";
const USER = "u1";
const STRANGER = "uX";

/**
 * An in-memory trace store with Phase 20's server-derived fields intact.
 *
 * It allocates `sequence` and `attempt` and derives a run's status the way the
 * real store does, so a service test cannot pass against a boundary that let a
 * caller choose an ordering key or a verdict.
 */
class FakeStore {
  readonly runs: TraceRunRow[] = [];
  readonly events: TraceEventRow[] = [];
  readonly registry = new Map<string, string>();
  /** Set to make every call fail, so error mapping is exercised honestly. */
  failing = false;
  nextId = 0;

  private fail(): TraceStorageResult<never> {
    return { ok: false, error: { code: "UNAVAILABLE", message: "storage is down" } };
  }

  /** The identities that exist, as real storage would know them. */
  readonly members = new Set<string>([USER]);

  authorize(workspaceId: string, userId: string): TraceStorageResult<unknown> {
    if (this.failing) return this.fail();
    if (workspaceId === OTHER || !this.members.has(userId)) {
      return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
    }
    return ok({});
  }

  seedRun(overrides: Partial<TraceRunRow>): TraceRunRow {
    this.nextId += 1;
    const row: TraceRunRow = {
      id: `run-${this.nextId}`,
      workspaceId: WORKSPACE,
      agentId: "strategy",
      version: "1.0.0",
      status: "open",
      openedBy: USER,
      openedAt: "2026-01-01T00:00:00.000Z",
      closedBy: null,
      closedAt: null,
      ...overrides,
    };
    this.runs.push(row);
    return row;
  }

  seedEvent(runId: string, overrides: Partial<TraceEventRow>): TraceEventRow {
    this.nextId += 1;
    const existing = this.events.filter((row) => row.runId === runId);
    const row: TraceEventRow = {
      id: `e-${this.nextId}`,
      workspaceId: WORKSPACE,
      runId,
      sequence: existing.length + 1,
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
      recordedBy: USER,
      recordedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
    this.events.push(row);
    return row;
  }

  /** The identical rule the real store applies, kept here to test the service. */
  deriveStatus(runId: string): TraceRunRow["status"] {
    const outcomes = this.events.filter((row) => row.runId === runId).map((row) => row.outcome);
    if (outcomes.length === 0) return "unverified";
    if (outcomes.includes("failed")) return "failed";
    if (outcomes.includes("unknown")) return "unknown";
    if (outcomes.includes("succeeded")) return "succeeded";
    return "unverified";
  }

  readonly repo: TraceRepository = {
    authorize: (workspaceId, userId) => this.authorize(workspaceId, userId),

    createAgentTraceRun: ({ workspaceId, userId, agentId, version }) => {
      if (this.failing) return this.fail();
      if (workspaceId === OTHER || !this.members.has(userId)) {
        return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
      }
      return ok(this.seedRun({ workspaceId, agentId, version, openedBy: userId }));
    },

    getAgentTraceRun: ({ workspaceId, userId, runId }) => {
      if (this.failing) return this.fail();
      if (workspaceId === OTHER || !this.members.has(userId)) {
        return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
      }
      return ok(this.runs.find((row) => row.id === runId) ?? null);
    },

    listAgentTraceRuns: (workspaceId, userId, agentId) => {
      if (this.failing) return this.fail();
      if (workspaceId === OTHER || !this.members.has(userId)) {
        return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
      }
      return ok(
        this.runs.filter(
          (row) =>
            row.workspaceId === workspaceId && (agentId === undefined || row.agentId === agentId),
        ),
      );
    },

    closeAgentTraceRun: ({ workspaceId, userId, runId }) => {
      if (this.failing) return this.fail();
      if (workspaceId === OTHER || !this.members.has(userId)) {
        return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
      }
      const index = this.runs.findIndex((row) => row.id === runId);
      const run = this.runs[index];
      if (!run) return { ok: false, error: { code: "NOT_FOUND", message: "run not found" } };
      if (run.status !== "open") return ok(run);
      const closed: TraceRunRow = {
        ...run,
        status: this.deriveStatus(runId),
        closedBy: USER,
        closedAt: "2026-01-01T00:01:00.000Z",
      };
      this.runs[index] = closed;
      return ok(closed);
    },

    createAgentTraceEvent: (input) => {
      if (this.failing) return this.fail();
      if (input.workspaceId === OTHER) {
        return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
      }
      const run = this.runs.find((row) => row.id === input.runId);
      if (!run) return { ok: false, error: { code: "NOT_FOUND", message: "run not found" } };
      if (run.status !== "open") {
        return { ok: false, error: { code: "CONFLICT", message: "run already closed" } };
      }
      const existing = this.events.filter((row) => row.runId === run.id);
      const attempt = existing.filter((row) => row.stepId === input.stepId).length + 1;
      return ok(
        this.seedEvent(run.id, {
          stepId: input.stepId,
          attempt,
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
        }),
      );
    },

    listAgentTraceEvents: (workspaceId, userId, runId) => {
      if (this.failing) return this.fail();
      if (workspaceId === OTHER || !this.members.has(userId)) {
        return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
      }
      return ok(this.events.filter((row) => row.runId === runId));
    },

    listAgentRunCostFacts: (workspaceId, userId, _runId) => {
      if (this.failing) return this.fail();
      if (workspaceId === OTHER || !this.members.has(userId)) {
        return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
      }
      return ok([]);
    },

    getAgentRegistryState: (workspaceId, userId, agentId) => {
      if (this.failing) return this.fail();
      if (workspaceId === OTHER || !this.members.has(userId)) {
        return { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } };
      }
      return ok(this.registry.get(agentId) ?? null);
    },
  };
}

let store: FakeStore;
let service: TraceService;

beforeEach(() => {
  store = new FakeStore();
  service = new TraceService(store.repo);
});

/** A workspace that has put one agent into `production`, as Phase 19 would. */
function production(agentId = "strategy"): void {
  store.registry.set(agentId, "production");
}

function isErr<T>(value: Result<T, unknown>): boolean {
  return !value.ok;
}

describe("TraceService — authorization and identity", () => {
  it("refuses without a workspace", () => {
    expect(service.runs("", USER).ok).toBe(false);
  });

  it("refuses without a session", () => {
    expect(service.runs(WORKSPACE, "").ok).toBe(false);
    expect(service.runs(WORKSPACE, "")).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("refuses a workspace the caller does not belong to", () => {
    expect(isErr(service.runs(OTHER, USER))).toBe(true);
  });

  it("never reads another workspace's run, whatever id it is given", () => {
    const run = store.seedRun({});
    // Same run id, the wrong tenant: the storage lookup is workspace-scoped.
    expect(service.trace(OTHER, USER, run.id)).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    expect(service.steps(OTHER, USER, run.id).ok).toBe(false);
    expect(service.closeRun(OTHER, USER, run.id).ok).toBe(false);
    expect(
      service.recordStep(OTHER, USER, run.id, {
        stepId: "s",
        stage: "agent",
        outcome: "succeeded",
      }).ok,
    ).toBe(false);
  });

  it("reports a forged actor as unauthorized rather than recording under it", () => {
    production();
    const opened = service.openRun(WORKSPACE, STRANGER, "strategy");
    expect(opened.ok).toBe(false);
    expect(store.runs).toHaveLength(0);
  });

  it("maps a storage outage to UNAVAILABLE, never to a success", () => {
    store.failing = true;
    expect(service.openRun(WORKSPACE, USER, "strategy")).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    expect(service.trace(WORKSPACE, USER, "run-1")).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    expect(service.policy(WORKSPACE, USER)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
  });
});

describe("TraceService — the production requirement", () => {
  it("refuses a run for an agent that is not in production", () => {
    // No registry row at all.
    const unregistered = service.openRun(WORKSPACE, USER, "strategy");
    expect(unregistered).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(store.runs).toHaveLength(0);
  });

  it("names the state it found, so `approved` reads differently from missing", () => {
    store.registry.set("strategy", "approved");
    const approved = service.openRun(WORKSPACE, USER, "strategy");
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.error.message).toContain("`approved`");
      expect(approved.error.details?.[0]?.message).toContain("Phase 19");
    }
  });

  it("refuses every state other than production", () => {
    for (const state of ["draft", "testing", "paused", "disabled", "archived"]) {
      store.registry.set("qualification", state);
      expect(service.openRun(WORKSPACE, USER, "qualification").ok).toBe(false);
    }
  });

  it("opens a run once the workspace has promoted the agent", () => {
    production();
    const opened = service.openRun(WORKSPACE, USER, "strategy");
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.status).toBe("open");
      expect(opened.value.agentId).toBe("strategy");
    }
  });

  it("refuses an agent outside the twelve before it ever reaches the registry", () => {
    production();
    expect(service.openRun(WORKSPACE, USER, "sales_team")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(store.runs).toHaveLength(0);
  });
});

describe("TraceService — version pinning", () => {
  it("pins the version from the declaration table, never from a caller", () => {
    production("qualification");
    const opened = service.openRun(WORKSPACE, USER, "qualification");
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      // `qualification`'s own declared version, which is 1.0.0 in this build.
      expect(opened.value.agentVersion).toBe("1.0.0");
    }
  });

  it("keeps a historical run pinned when a later run records a new version", () => {
    production();
    const first = service.openRun(WORKSPACE, USER, "strategy");
    const second = service.openRun(WORKSPACE, USER, "strategy");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.agentVersion).toBe(second.value.agentVersion);
      // Two runs are two invocations, not a duplicate.
      expect(first.value.id).not.toBe(second.value.id);
      // A later declaration version, as storage would hold it.
      const newer = store.runs[1];
      if (newer !== undefined) store.runs[1] = { ...newer, version: "2.0.0" };
      const reread = service.trace(WORKSPACE, USER, first.value.id);
      expect(reread.ok && reread.value.agentVersion).toBe("1.0.0");
    }
  });
});

describe("TraceService — recording steps", () => {
  beforeEach(() => {
    production();
  });

  function openRun(): string {
    const opened = service.openRun(WORKSPACE, USER, "strategy");
    if (!opened.ok) throw new Error("open failed");
    return opened.value.id;
  }

  it("records a step and derives its ordering server-side", () => {
    const runId = openRun();
    const step = service.recordStep(WORKSPACE, USER, runId, {
      stepId: "plan",
      stage: "agent",
      outcome: "succeeded",
      detail: "created plan",
      durationMs: 120,
    });
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.value.sequence).toBe(1);
      expect(step.value.attempt).toBe(1);
      expect(step.value.recordedBy).toBe(USER);
    }
  });

  it("allocates a monotonic sequence regardless of the order steps arrive in", () => {
    const runId = openRun();
    for (const stage of ["agent", "decision", "tool_call", "evidence"] as const) {
      service.recordStep(WORKSPACE, USER, runId, { stepId: stage, stage, outcome: "succeeded" });
    }
    const steps = service.steps(WORKSPACE, USER, runId);
    expect(steps.ok).toBe(true);
    if (steps.ok) expect(steps.value.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("counts a retry as a later attempt of the same step, not a new step", () => {
    const runId = openRun();
    service.recordStep(WORKSPACE, USER, runId, {
      stepId: "render",
      stage: "tool_call",
      tool: "render_draft",
      outcome: "failed",
      errorCode: "provider_timeout",
    });
    const retry = service.recordStep(WORKSPACE, USER, runId, {
      stepId: "render",
      stage: "tool_call",
      tool: "render_draft",
      outcome: "succeeded",
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.value.attempt).toBe(2);
      expect(retry.value.sequence).toBe(2);
    }
  });

  it("refuses a blank or missing stepId", () => {
    const runId = openRun();
    expect(
      service.recordStep(WORKSPACE, USER, runId, {
        stepId: "  ",
        stage: "agent",
        outcome: "succeeded",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("refuses a stage outside the published seven", () => {
    const runId = openRun();
    expect(
      service.recordStep(WORKSPACE, USER, runId, {
        stepId: "s",
        stage: "tool_call_out",
        outcome: "succeeded",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("refuses an outcome outside the published three", () => {
    const runId = openRun();
    expect(
      service.recordStep(WORKSPACE, USER, runId, {
        stepId: "s",
        stage: "agent",
        outcome: "probably",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("names a tool only on a tool_call step", () => {
    const runId = openRun();
    expect(
      service.recordStep(WORKSPACE, USER, runId, {
        stepId: "s",
        stage: "agent",
        outcome: "succeeded",
        tool: "render_draft",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("refuses a tool no agent declaration names", () => {
    const runId = openRun();
    expect(
      service.recordStep(WORKSPACE, USER, runId, {
        stepId: "s",
        stage: "tool_call",
        outcome: "succeeded",
        tool: "shell_exec",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("refuses an errorCode on a step that did not fail", () => {
    const runId = openRun();
    expect(
      service.recordStep(WORKSPACE, USER, runId, {
        stepId: "s",
        stage: "tool_call",
        outcome: "succeeded",
        errorCode: "provider_timeout",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("refuses a negative or fractional duration", () => {
    const runId = openRun();
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(
        service.recordStep(WORKSPACE, USER, runId, {
          stepId: "s",
          stage: "agent",
          outcome: "succeeded",
          durationMs: bad,
        }),
      ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("refuses token usage that does not name the model that reported it", () => {
    const runId = openRun();
    expect(
      service.recordStep(WORKSPACE, USER, runId, {
        stepId: "s",
        stage: "decision",
        outcome: "succeeded",
        inputTokens: 10,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("accepts model usage when both the model and the tokens are reported", () => {
    const runId = openRun();
    const step = service.recordStep(WORKSPACE, USER, runId, {
      stepId: "s",
      stage: "decision",
      outcome: "succeeded",
      modelProvider: "openai",
      modelName: "m",
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(step.ok).toBe(true);
  });

  it("refuses a step against a run that does not exist", () => {
    expect(
      service.recordStep(WORKSPACE, USER, "never-issued", {
        stepId: "s",
        stage: "agent",
        outcome: "succeeded",
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("refuses a step against a run whose agent this build does not publish", () => {
    // A row naming an agent outside the twelve can never have steps appended to
    // it: an unreadable run must not become readable by having steps put in it.
    const run = store.seedRun({ agentId: "sales_team" });
    expect(
      service.recordStep(WORKSPACE, USER, run.id, {
        stepId: "s",
        stage: "agent",
        outcome: "succeeded",
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("TraceService — closing a run", () => {
  beforeEach(() => {
    production();
  });

  function openRun(): string {
    const opened = service.openRun(WORKSPACE, USER, "strategy");
    if (!opened.ok) throw new Error("open failed");
    return opened.value.id;
  }

  it("closes an empty run as unverified — never as a success", () => {
    // ROADMAP.md §27's critical rule, at its sharpest: nothing was recorded, so
    // nothing can be claimed, and the close request has no status to offer.
    const closed = service.closeRun(WORKSPACE, USER, openRun());
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.value.status).toBe("unverified");
  });

  it("closes a run whose only step succeeded as succeeded", () => {
    const runId = openRun();
    service.recordStep(WORKSPACE, USER, runId, {
      stepId: "s",
      stage: "result",
      outcome: "succeeded",
    });
    const closed = service.closeRun(WORKSPACE, USER, runId);
    expect(closed.ok && closed.value.status).toBe("succeeded");
  });

  it("closes a run with any failure as failed, whatever else succeeded", () => {
    const runId = openRun();
    service.recordStep(WORKSPACE, USER, runId, {
      stepId: "a",
      stage: "agent",
      outcome: "succeeded",
    });
    service.recordStep(WORKSPACE, USER, runId, {
      stepId: "b",
      stage: "external_action",
      outcome: "failed",
      errorCode: "provider_rejected",
    });
    const closed = service.closeRun(WORKSPACE, USER, runId);
    expect(closed.ok && closed.value.status).toBe("failed");
  });

  it("closes a run with an unconfirmed action as unknown, not as a delivery", () => {
    const runId = openRun();
    service.recordStep(WORKSPACE, USER, runId, {
      stepId: "a",
      stage: "external_action",
      outcome: "unknown",
    });
    const closed = service.closeRun(WORKSPACE, USER, runId);
    expect(closed.ok && closed.value.status).toBe("unknown");
  });

  it("is idempotent: a second close returns the same verdict", () => {
    const runId = openRun();
    service.recordStep(WORKSPACE, USER, runId, {
      stepId: "s",
      stage: "result",
      outcome: "succeeded",
    });
    const first = service.closeRun(WORKSPACE, USER, runId);
    const second = service.closeRun(WORKSPACE, USER, runId);
    expect(first.ok && second.ok && first.value.status === second.value.status).toBe(true);
  });

  it("refuses a further step once the run is closed", () => {
    const runId = openRun();
    service.recordStep(WORKSPACE, USER, runId, {
      stepId: "s",
      stage: "result",
      outcome: "succeeded",
    });
    service.closeRun(WORKSPACE, USER, runId);
    const late = service.recordStep(WORKSPACE, USER, runId, {
      stepId: "later",
      stage: "external_action",
      outcome: "succeeded",
    });
    expect(late).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("refuses a close for a run that does not exist", () => {
    expect(service.closeRun(WORKSPACE, USER, "never-issued")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
});

describe("TraceService — reading a trace", () => {
  beforeEach(() => {
    production();
  });

  it("reads an empty run honestly: seven stages, zero steps, no cost", () => {
    const opened = service.openRun(WORKSPACE, USER, "strategy");
    if (!opened.ok) throw new Error("open failed");
    const trace = service.trace(WORKSPACE, USER, opened.value.id);
    expect(trace.ok).toBe(true);
    if (!trace.ok) return;
    expect(trace.value.status).toBe("open");
    expect(trace.value.derivedStatus).toBe("unverified");
    expect(trace.value.stepCount).toBe(0);
    expect(trace.value.stages).toHaveLength(7);
    expect(trace.value.usage.slowestStepMs).toBeNull();
    expect(trace.value.cost).toBeNull();
  });

  it("prints the stored status beside the one it re-derived", () => {
    const opened = service.openRun(WORKSPACE, USER, "strategy");
    if (!opened.ok) throw new Error("open failed");
    service.recordStep(WORKSPACE, USER, opened.value.id, {
      stepId: "s",
      stage: "result",
      outcome: "succeeded",
    });
    const trace = service.trace(WORKSPACE, USER, opened.value.id);
    expect(trace.ok).toBe(true);
    // Still open, so `status` asserts nothing; `derivedStatus` says what closing
    // it now would produce, which is what the recorded success supports.
    if (trace.ok) {
      expect(trace.value.status).toBe("open");
      expect(trace.value.derivedStatus).toBe("succeeded");
    }
  });

  it("refuses to report a verdict when storage and the events disagree", () => {
    // Something wrote a status the recorded outcomes do not support. The read
    // refuses rather than printing either value.
    const run = store.seedRun({ status: "succeeded" });
    // The recorded step failed, so a stored `succeeded` is a verdict nothing in
    // the run supports.
    store.seedEvent(run.id, { outcome: "failed", errorCode: "boom" });
    const trace = service.trace(WORKSPACE, USER, run.id);
    expect(trace).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });

  it("orders the trail by sequence, so same-millisecond steps stay ordered", () => {
    const run = store.seedRun({});
    for (let i = 1; i <= 3; i += 1) {
      store.seedEvent(run.id, {
        sequence: i,
        stepId: `s${i}`,
        recordedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const steps = service.steps(WORKSPACE, USER, run.id);
    expect(steps.ok).toBe(true);
    if (steps.ok) expect(steps.value.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it("returns an empty list for a run with no steps rather than refusing", () => {
    const run = store.seedRun({});
    const steps = service.steps(WORKSPACE, USER, run.id);
    expect(steps.ok).toBe(true);
    if (steps.ok) expect(steps.value).toEqual([]);
  });

  it("drops a step whose vocabulary this build does not publish", () => {
    // An unreadable record reduces what the trace can account for; it never
    // widens the claims the trace makes.
    const run = store.seedRun({});
    store.seedEvent(run.id, { stage: "telepathy" });
    store.seedEvent(run.id, { sequence: 2, stepId: "b" });
    const trace = service.trace(WORKSPACE, USER, run.id);
    expect(trace.ok).toBe(true);
    // The unreadable step is dropped, not counted: the trace accounts for one
    // step rather than claiming two.
    if (trace.ok) expect(trace.value.stepCount).toBe(1);
  });

  it("lists runs, optionally narrowed to one agent", () => {
    production("qualification");
    const a = service.openRun(WORKSPACE, USER, "strategy");
    const b = service.openRun(WORKSPACE, USER, "qualification");
    expect(a.ok && b.ok).toBe(true);

    const all = service.runs(WORKSPACE, USER);
    expect(all.ok && all.value).toHaveLength(2);
    const narrowed = service.runs(WORKSPACE, USER, "strategy");
    expect(narrowed.ok && narrowed.value).toHaveLength(1);
    if (narrowed.ok) expect(narrowed.value[0]?.agentId).toBe("strategy");

    expect(service.runs(WORKSPACE, USER, "sales_team")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("counts the steps each listed run holds", () => {
    const run = store.seedRun({});
    store.seedEvent(run.id, {});
    const runs = service.runs(WORKSPACE, USER);
    expect(runs.ok && runs.value[0]?.stepCount).toBe(1);
  });

  it("publishes the policy before anything has been traced", () => {
    const policy = service.policy(WORKSPACE, USER);
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    expect(policy.value.stages).toHaveLength(7);
    expect(policy.value.outcomes).toHaveLength(3);
    expect(policy.value.statuses).toHaveLength(5);
    expect(policy.value.tracked).toHaveLength(9);
    expect(policy.value.criticalRule).toContain("never silently pretend");
  });
});

describe("TraceService — the cost figure comes from Phase 16", () => {
  it("reports null cost when no Phase 16 fact exists for the run", async () => {
    const { Store, emptyState } = await import("@dealora/db");
    const db = new Store(emptyState());
    const wired = new TraceService({
      authorize: db.authorize.bind(db),
      createAgentTraceRun: db.createAgentTraceRun.bind(db),
      getAgentTraceRun: db.getAgentTraceRun.bind(db),
      listAgentTraceRuns: db.listAgentTraceRuns.bind(db),
      closeAgentTraceRun: db.closeAgentTraceRun.bind(db),
      createAgentTraceEvent: db.createAgentTraceEvent.bind(db),
      listAgentTraceEvents: db.listAgentTraceEvents.bind(db),
      listAgentRunCostFacts: (workspaceId, userId, runId) =>
        db.listCostEvents(workspaceId, userId, { executionKind: "agent_run", executionId: runId }),
      getAgentRegistryState: (workspaceId, userId, agentId) => {
        const found = db.getAgentRegistry(workspaceId, userId, agentId);
        return found.ok ? ok(found.value?.status ?? null) : err(found.error);
      },
    });

    const user = db.createUser({
      email: "c@example.com",
      password: "pw-12345678",
      displayName: "C",
    });
    if (!user.ok) throw new Error("user failed");
    const workspace = db.createWorkspace({ ownerId: user.value.id, name: "Trace Co" });
    if (!workspace.ok) throw new Error("workspace failed");
    db.setAgentStatus({
      workspaceId: workspace.value.id,
      userId: user.value.id,
      agentId: "strategy",
      status: "production",
    });

    const opened = wired.openRun(workspace.value.id, user.value.id, "strategy");
    if (!opened.ok) throw new Error("open failed");
    const trace = wired.trace(workspace.value.id, user.value.id, opened.value.id);
    expect(trace.ok).toBe(true);
    if (trace.ok) expect(trace.value.cost).toBeNull();
  });
});
