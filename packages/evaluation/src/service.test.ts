import { describe, expect, it } from "vitest";

import { EvaluationService } from "./service.js";
import { createProductionGate } from "./factory.js";
import { EVALUATION_METRICS, EVALUATION_RULE_VERSION, metricOrder } from "./rules.js";
import type {
  EvaluationObservationRow,
  EvaluationRepository,
  EvaluationRunRow,
  EvaluationStorageResult,
} from "./types.js";

/**
 * An in-memory repository standing in for the store.
 *
 * Every method receives the caller's own identity and enforces the workspace
 * itself, exactly as `packages/db`'s repository does — so the tests below
 * exercise the service's own authorization rather than trusting it, and the
 * storage-level guarantees (append-only rows, one judgement per subject, a
 * derived run number) are modelled rather than assumed.
 */
class FakeRepository implements EvaluationRepository {
  readonly runs: EvaluationEvaluationRun[] = [];
  readonly observations: EvaluationObservationRow[] = [];
  /** The (workspaceId, userId) pairs this repository will admit. */
  readonly members = new Map<string, Set<string>>();
  /** The tables that should refuse, so error mapping can be exercised. */
  faults: Partial<Record<"run" | "observation" | "list", string>> = {};
  writes = 0;

  private counter = 0;
  private stamp = 0;

  private admit(workspaceId: string, userId: string): EvaluationStorageResult<true> {
    const members = this.members.get(workspaceId);
    if (!members) return { ok: false, error: { code: "NOT_FOUND" } };
    if (!members.has(userId)) return { ok: false, error: { code: "UNAUTHORIZED" } };
    return { ok: true, value: true };
  }

  authorize(workspaceId: string, userId: string): EvaluationStorageResult<true> {
    return this.admit(workspaceId, userId);
  }

  createAgentEvaluationRun(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): EvaluationStorageResult<EvaluationRunRow> {
    const auth = this.admit(input.workspaceId, input.userId);
    if (!auth.ok) return auth;
    if (this.faults.run) return { ok: false, error: { code: this.faults.run } };
    const existing = this.runs.filter(
      (row) =>
        row.workspaceId === input.workspaceId &&
        row.agentId === input.agentId &&
        row.version === input.version,
    );
    const highest = existing.reduce((max, row) => Math.max(max, row.runNumber), 0);
    this.counter += 1;
    this.stamp += 1;
    const row: EvaluationEvaluationRun = {
      id: `run-${this.counter}`,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      version: input.version,
      runNumber: highest + 1,
      createdBy: input.userId,
      createdAt: `2026-01-01T00:00:0${this.stamp}.000Z`,
    };
    this.runs.push(row);
    this.writes += 1;
    return { ok: true, value: row };
  }

  getCurrentAgentEvaluationRun(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    version: string;
  }): EvaluationStorageResult<EvaluationRunRow | null> {
    const auth = this.admit(input.workspaceId, input.userId);
    if (!auth.ok) return auth;
    if (this.faults.list) return { ok: false, error: { code: this.faults.list } };
    const rows = this.runs.filter(
      (row) =>
        row.workspaceId === input.workspaceId &&
        row.agentId === input.agentId &&
        row.version === input.version,
    );
    const live = rows.reduce<EvaluationRunRow | null>(
      (max, row) => (max === null || row.runNumber > max.runNumber ? row : max),
      null,
    );
    return { ok: true, value: live };
  }

  listAgentEvaluationRuns(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): EvaluationStorageResult<readonly EvaluationRunRow[]> {
    const auth = this.admit(workspaceId, userId);
    if (!auth.ok) return auth;
    if (this.faults.list) return { ok: false, error: { code: this.faults.list } };
    return {
      ok: true,
      value: this.runs.filter((row) => row.workspaceId === workspaceId && row.agentId === agentId),
    };
  }

  createAgentEvaluationObservation(input: {
    workspaceId: string;
    userId: string;
    runId: string;
    metric: string;
    subjectId: string;
    verdict: string | null;
    amountMinor: number | null;
    durationMs: number | null;
    note: string | null;
  }): EvaluationStorageResult<EvaluationObservationRow> {
    const auth = this.admit(input.workspaceId, input.userId);
    if (!auth.ok) return auth;
    if (this.faults.observation) return { ok: false, error: { code: this.faults.observation } };
    const run = this.runs.find(
      (row) => row.id === input.runId && row.workspaceId === input.workspaceId,
    );
    if (!run) return { ok: false, error: { code: "NOT_FOUND" } };
    const existing = this.observations.find(
      (row) =>
        row.runId === run.id && row.metric === input.metric && row.subjectId === input.subjectId,
    );
    if (existing) {
      const identical =
        existing.verdict === input.verdict &&
        existing.amountMinor === input.amountMinor &&
        existing.durationMs === input.durationMs;
      return identical ? { ok: true, value: existing } : { ok: false, error: { code: "CONFLICT" } };
    }
    this.counter += 1;
    this.stamp += 1;
    const row: EvaluationObservationRow = {
      id: `obs-${this.counter}`,
      workspaceId: input.workspaceId,
      runId: run.id,
      metric: input.metric,
      subjectId: input.subjectId,
      verdict: input.verdict,
      amountMinor: input.amountMinor,
      durationMs: input.durationMs,
      note: input.note,
      createdBy: input.userId,
      createdAt: `2026-01-01T00:00:0${this.stamp}.000Z`,
    };
    this.observations.push(row);
    this.writes += 1;
    return { ok: true, value: row };
  }

  listAgentEvaluationObservations(
    workspaceId: string,
    userId: string,
    runId: string,
  ): EvaluationStorageResult<readonly EvaluationObservationRow[]> {
    const auth = this.admit(workspaceId, userId);
    if (!auth.ok) return auth;
    if (this.faults.list) return { ok: false, error: { code: this.faults.list } };
    const run = this.runs.find((row) => row.id === runId && row.workspaceId === workspaceId);
    if (!run) return { ok: false, error: { code: "NOT_FOUND" } };
    return {
      ok: true,
      value: this.observations.filter(
        (row) => row.workspaceId === workspaceId && row.runId === runId,
      ),
    };
  }
}

type EvaluationEvaluationRun = EvaluationRunRow;

function fixture(): { repo: FakeRepository; service: EvaluationService } {
  const repo = new FakeRepository();
  repo.members.set("ws-1", new Set(["user-1"]));
  repo.members.set("ws-2", new Set(["user-2"]));
  return { repo, service: new EvaluationService(repo) };
}

/** A full, passing evaluation for `analytics`, whose limits are 100000/10000. */
function passAnalytics(
  service: EvaluationService,
  overrides?: Partial<{ verdicts: readonly ("met" | "unmet" | "unobserved")[] }>,
): void {
  const judged = overrides?.verdicts ?? ["met", "met", "met", "met", "met"];
  service.openRun("ws-1", "user-1", "analytics");
  for (const metric of ["task_success", "accuracy", "relevance"]) {
    judged.forEach((verdict, index) => {
      const result = service.recordObservation("ws-1", "user-1", "analytics", {
        metric,
        subjectId: `${metric}-${index}`,
        verdict,
      });
      if (!result.ok) throw new Error(`${metric} judgement failed: ${result.error.message}`);
    });
  }
  const spend = service.recordObservation("ws-1", "user-1", "analytics", {
    metric: "cost",
    subjectId: "run-cost",
    amountMinor: 500,
  });
  if (!spend.ok) throw new Error(`cost failed: ${spend.error.message}`);
  const latency = service.recordObservation("ws-1", "user-1", "analytics", {
    metric: "latency",
    subjectId: "run-latency",
    durationMs: 1_200,
  });
  if (!latency.ok) throw new Error(`latency failed: ${latency.error.message}`);
}

describe("EvaluationService authorization", () => {
  it("refuses an unauthenticated, unauthorized or missing workspace", () => {
    const { service } = fixture();
    const anonymous = service.policy("", "user-1");
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.error.code).toBe("VALIDATION_ERROR");

    const unauthenticated = service.policy("ws-1", "");
    expect(unauthenticated.ok).toBe(false);
    if (!unauthenticated.ok) expect(unauthenticated.error.code).toBe("UNAUTHORIZED");

    const absent = service.policy("ws-nope", "user-1");
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.error.code).toBe("NOT_FOUND");

    const stranger = service.report("ws-1", "user-2", "analytics");
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects an agent outside the twelve, before touching storage", () => {
    const { service, repo } = fixture();
    const unknown = service.report("ws-1", "user-1", "sales_agent");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("VALIDATION_ERROR");
      expect(unknown.error.details?.[0]?.field).toBe("agentId");
    }
    expect(repo.writes).toBe(0);
  });

  it("maps an internal storage failure onto the domain vocabulary", () => {
    const { service, repo } = fixture();
    repo.faults.list = "UNAVAILABLE";
    const failed = service.report("ws-1", "user-1", "analytics");
    expect(failed.ok).toBe(false);
    // The message is the domain's own, never storage's text.
    if (!failed.ok) {
      expect(failed.error.code).toBe("UNAVAILABLE");
      expect(failed.error.message).not.toContain("down");
    }
  });
});

describe("opening an evaluation round", () => {
  it("pins the declared version and never a request value", () => {
    const { service, repo } = fixture();
    const opened = service.openRun("ws-1", "user-1", "analytics");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.agentVersion).toBe("1.0.0");
    expect(opened.value.runNumber).toBe(1);
    expect(opened.value.openedBy).toBe("user-1");
    expect(opened.value.live).toBe(true);
    expect(repo.runs[0]?.version).toBe("1.0.0");
  });

  it("numbers rounds from what is already stored, so a caller cannot renumber", () => {
    const { service, repo } = fixture();
    for (const expected of [1, 2, 3]) {
      const opened = service.openRun("ws-1", "user-1", "analytics");
      if (!opened.ok) throw new Error("openRun failed");
      expect(opened.value.runNumber).toBe(expected);
    }
    expect(repo.runs.map((row) => row.runNumber)).toEqual([1, 2, 3]);
  });

  it("is isolated per workspace and per agent", () => {
    const { service } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    service.openRun("ws-1", "user-1", "strategy");
    service.openRun("ws-2", "user-2", "analytics");
    const first = service.report("ws-1", "user-1", "analytics");
    const second = service.report("ws-1", "user-1", "strategy");
    const other = service.report("ws-2", "user-2", "analytics");
    if (!first.ok || !second.ok || !other.ok) throw new Error("report failed");
    // Three rounds, three independent lives.
    expect(first.value.run?.runNumber).toBe(1);
    expect(second.value.run?.runNumber).toBe(1);
    expect(other.value.run?.runNumber).toBe(1);
    expect(first.value.agentId).toBe("analytics");
    expect(other.value.agentId).toBe("analytics");
  });
});

describe("recording a judgement", () => {
  it("needs a round before it accepts anything", () => {
    const { service, repo } = fixture();
    const none = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "task_success",
      subjectId: "s-1",
      verdict: "met",
    });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe("CONFLICT");
    expect(repo.writes).toBe(0);
  });

  it("attributes the judgement to the session, never to a request", () => {
    const { service, repo } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    const recorded = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "task_success",
      subjectId: "s-1",
      verdict: "met",
      note: "checked against the source",
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.recordedBy).toBe("user-1");
    expect(recorded.value.metric).toBe("task_success");
    expect(recorded.value.verdict).toBe("met");
    expect(recorded.value.note).toBe("checked against the source");
    expect(recorded.value.amountMinor).toBeNull();
    // The row has no workspace, version, rate or pass written by a caller.
    expect(Object.keys(repo.observations[0] ?? {}).sort()).toEqual([
      "amountMinor",
      "createdAt",
      "createdBy",
      "durationMs",
      "id",
      "metric",
      "note",
      "runId",
      "subjectId",
      "verdict",
      "workspaceId",
    ]);
  });

  it("refuses a metric outside the published thirteen", () => {
    const { service, repo } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    const unknown = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "vibes",
      subjectId: "s-1",
      verdict: "met",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("VALIDATION_ERROR");
      expect(unknown.error.details?.[0]?.field).toBe("metric");
    }
    expect(repo.observations).toHaveLength(0);
  });

  it("refuses a metric the agent does not declare", () => {
    const { service } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    // `analytics` declares task_success, accuracy, relevance, cost and latency.
    const undeclared = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "hallucination_rate",
      subjectId: "s-1",
      verdict: "met",
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.error.code).toBe("VALIDATION_ERROR");
      expect(undeclared.error.message).toContain("does not declare");
    }
  });

  it("refuses a missing subject and an unknown verdict by field name", () => {
    const { service, repo } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    const noSubject = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "task_success",
      subjectId: "   ",
      verdict: "met",
    });
    expect(noSubject.ok).toBe(false);
    if (!noSubject.ok) expect(noSubject.error.details?.[0]?.field).toBe("subjectId");

    const badVerdict = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "task_success",
      subjectId: "s-1",
      verdict: "passed",
    });
    expect(badVerdict.ok).toBe(false);
    if (!badVerdict.ok) {
      expect(badVerdict.error.code).toBe("VALIDATION_ERROR");
      expect(badVerdict.error.details?.[0]?.field).toBe("verdict");
      expect(badVerdict.error.details?.[0]?.message).toContain("unobserved");
    }
    expect(repo.observations).toHaveLength(0);
  });

  it("accepts a measured quantity for cost and latency, and nothing else", () => {
    const { service, repo } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    const cost = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "cost",
      subjectId: "run-1",
      amountMinor: 900,
    });
    expect(cost.ok).toBe(true);
    if (cost.ok) {
      expect(cost.value.amountMinor).toBe(900);
      // The verdict is derived later; the row never claims one.
      expect(cost.value.verdict).toBeNull();
    }

    const latency = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "latency",
      subjectId: "run-2",
      durationMs: 750,
    });
    expect(latency.ok).toBe(true);

    const negative = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "cost",
      subjectId: "run-3",
      amountMinor: -1,
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.error.details?.[0]?.field).toBe("amountMinor");

    const fractional = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "latency",
      subjectId: "run-4",
      durationMs: 12.5,
    });
    expect(fractional.ok).toBe(false);

    const both = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "cost",
      subjectId: "run-5",
      amountMinor: 100,
      verdict: "met",
    });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error.message).toContain("measured, not judged");

    const judgedWithAmount = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "task_success",
      subjectId: "s-9",
      verdict: "met",
      amountMinor: 100,
    });
    expect(judgedWithAmount.ok).toBe(false);
    if (!judgedWithAmount.ok)
      expect(judgedWithAmount.error.message).toContain("judged, not measured");

    expect(repo.observations).toHaveLength(2);
  });

  it("replays an identical judgement and refuses a restated one", () => {
    const { service, repo } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    const first = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "task_success",
      subjectId: "s-1",
      verdict: "met",
    });
    const replay = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "task_success",
      subjectId: "s-1",
      verdict: "met",
    });
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    // The same row, not a second vote.
    expect(replay.value.id).toBe(first.value.id);
    expect(repo.observations).toHaveLength(1);

    const restated = service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "task_success",
      subjectId: "s-1",
      verdict: "unmet",
    });
    expect(restated.ok).toBe(false);
    if (!restated.ok) expect(restated.error.code).toBe("CONFLICT");
    expect(repo.observations).toHaveLength(1);
  });

  it("is isolated: one tenant's judgement is never another's evidence", () => {
    const { service, repo } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "cost",
      subjectId: "run-1",
      amountMinor: 10,
    });

    // A second tenant has no round of its own, so it has nothing to judge into.
    const crossed = service.recordObservation("ws-2", "user-2", "analytics", {
      metric: "task_success",
      subjectId: "s-1",
      verdict: "met",
    });
    expect(crossed.ok).toBe(false);

    // Opening its own round leaves it empty: the first tenant's cost evidence
    // never appears in the second tenant's report.
    const opened = service.openRun("ws-2", "user-2", "analytics");
    expect(opened.ok).toBe(true);
    const theirs = service.report("ws-2", "user-2", "analytics");
    if (!theirs.ok) throw new Error("report failed");
    expect(theirs.value.run?.observationCount).toBe(0);
    expect(theirs.value.status).toBe("insufficient_evidence");

    // And cannot read the first tenant's report either.
    const stolen = service.report("ws-1", "user-2", "analytics");
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.error.code).toBe("UNAUTHORIZED");

    // Forging another tenant's workspace id is refused by the same check.
    const forged = service.recordObservation("ws-1", "user-2", "analytics", {
      metric: "task_success",
      subjectId: "s-2",
      verdict: "met",
    });
    expect(forged.ok).toBe(false);

    expect(repo.observations.filter((row) => row.workspaceId === "ws-2")).toHaveLength(0);
    expect(repo.observations).toHaveLength(1);
  });
});

describe("the report and the gate", () => {
  it("reports every declared metric as unmeasured when nothing exists", () => {
    const { service } = fixture();
    const report = service.report("ws-1", "user-1", "analytics");
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.run).toBeNull();
    expect(report.value.metrics).toHaveLength(5);
    expect(report.value.metrics.every((metric) => metric.status === "insufficient_evidence")).toBe(
      true,
    );
    // Never a zero: absence is not a measurement of anything.
    expect(report.value.metrics.every((metric) => metric.measured === null)).toBe(true);
    expect(report.value.status).toBe("insufficient_evidence");
    expect(report.value.gate.satisfied).toBe(false);
  });

  it("is satisfied only by evidence that meets every threshold", () => {
    const { service } = fixture();
    passAnalytics(service);
    const report = service.report("ws-1", "user-1", "analytics");
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.status).toBe("met");
    expect(report.value.gate.satisfied).toBe(true);
    expect(report.value.ruleVersion).toBe(EVALUATION_RULE_VERSION);
    expect(report.value.metrics.map((metric) => metric.status)).toEqual([
      "met",
      "met",
      "met",
      "met",
      "met",
    ]);
  });

  it("fails the gate on a single failing metric and names it", () => {
    const { service } = fixture();
    passAnalytics(service, { verdicts: ["met", "met", "met", "met", "unmet"] });
    // `task_success` and `accuracy` now sit at exactly 8000 bp: task_success
    // passes (threshold 8000) and accuracy fails (threshold 9500).
    const report = service.report("ws-1", "user-1", "analytics");
    if (!report.ok) throw new Error("report failed");
    const byMetric = new Map(report.value.metrics.map((metric) => [metric.metric, metric]));
    expect(byMetric.get("task_success")?.status).toBe("met");
    expect(byMetric.get("accuracy")?.status).toBe("unmet");
    expect(report.value.status).toBe("unmet");
    expect(report.value.gate.satisfied).toBe(false);
    expect(report.value.gate.reason).toContain("accuracy unmet");
  });

  it("fails the gate on insufficient coverage even when nothing failed", () => {
    const { service } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    for (const metric of ["task_success", "accuracy", "relevance"]) {
      service.recordObservation("ws-1", "user-1", "analytics", {
        metric,
        subjectId: `${metric}-1`,
        verdict: "met",
      });
    }
    service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "cost",
      subjectId: "run-cost",
      amountMinor: 10,
    });
    const report = service.report("ws-1", "user-1", "analytics");
    if (!report.ok) throw new Error("report failed");
    expect(report.value.status).toBe("insufficient_evidence");
    expect(report.value.gate.reason).toContain("latency insufficient_evidence");
    expect(report.value.gate.reason).toContain("task_success insufficient_evidence");
  });

  it("supersedes an earlier round rather than accumulating it", () => {
    const { service, repo } = fixture();
    passAnalytics(service);
    const before = service.report("ws-1", "user-1", "analytics");
    if (!before.ok) throw new Error("report failed");
    expect(before.value.gate.satisfied).toBe(true);

    // A fresh round starts empty, so the passing evidence stops being current
    // without being edited or deleted.
    const reopened = service.openRun("ws-1", "user-1", "analytics");
    if (!reopened.ok) throw new Error("openRun failed");
    expect(reopened.value.runNumber).toBe(2);
    const after = service.report("ws-1", "user-1", "analytics");
    if (!after.ok) throw new Error("report failed");
    expect(after.value.run?.runNumber).toBe(2);
    expect(after.value.status).toBe("insufficient_evidence");
    expect(after.value.gate.satisfied).toBe(false);
    // Nothing was removed: the first round's rows are all still stored.
    expect(repo.observations).toHaveLength(17);
  });

  it("never reads evidence recorded against another agent version", () => {
    const { service, repo } = fixture();
    passAnalytics(service);
    // A run pinned to a version no declaration can produce: the service asks
    // storage only for the declared version, so this row is invisible.
    repo.runs.push({
      id: "run-other-version",
      workspaceId: "ws-1",
      agentId: "analytics",
      version: "0.9.0",
      runNumber: 99,
      createdBy: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const report = service.report("ws-1", "user-1", "analytics");
    if (!report.ok) throw new Error("report failed");
    expect(report.value.run?.runNumber).toBe(1);
    expect(report.value.gate.satisfied).toBe(true);
  });

  it("is byte-identical on every read", () => {
    const { service } = fixture();
    passAnalytics(service);
    const first = JSON.stringify(service.report("ws-1", "user-1", "analytics"));
    const second = JSON.stringify(service.report("ws-1", "user-1", "analytics"));
    expect(first).toBe(second);
  });
});

describe("the provenance trail", () => {
  it("names every round, marks the live one and counts its judgements", () => {
    const { service } = fixture();
    passAnalytics(service);
    service.openRun("ws-1", "user-1", "analytics");
    const trail = service.trail("ws-1", "user-1", "analytics");
    expect(trail.ok).toBe(true);
    if (!trail.ok) return;
    expect(trail.value.runs.map((run) => run.runNumber)).toEqual([2, 1]);
    expect(trail.value.runs.map((run) => run.live)).toEqual([true, false]);
    // The superseded round still reports the seventeen judgements it holds.
    expect(trail.value.runs[1]?.observationCount).toBe(17);
    expect(trail.value.runs[0]?.observationCount).toBe(0);
    // The live round's judgements are the ones the report reads.
    expect(trail.value.observations).toEqual([]);
  });

  it("orders the trail deterministically by metric then subject", () => {
    const { service } = fixture();
    passAnalytics(service);
    const trail = service.trail("ws-1", "user-1", "analytics");
    if (!trail.ok) throw new Error("trail failed");
    const rows = trail.value.observations;
    const expected = [...rows].sort(
      (a, b) =>
        metricOrder(a.metric) - metricOrder(b.metric) || a.subjectId.localeCompare(b.subjectId),
    );
    expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    // `task_success` is first in the published table, not alphabetically last.
    expect(rows[0]?.metric).toBe("task_success");
    expect(new Set(rows.map((row) => `${row.metric}:${row.subjectId}`)).size).toBe(rows.length);
    expect(rows.every((row) => row.recordedBy === "user-1")).toBe(true);
  });

  it("carries judgements, never a trace of an agent run", () => {
    const { service } = fixture();
    passAnalytics(service);
    const trail = service.trail("ws-1", "user-1", "analytics");
    const printed = JSON.stringify(trail);
    // ROADMAP.md §27 (Phase 20) owns execution traces; nothing here records one.
    expect(printed.toLowerCase()).not.toContain("trace");
    expect(printed.toLowerCase()).not.toContain("token");
    expect(printed.toLowerCase()).not.toContain("tool_call");
  });

  it("records no version, workspace or actor the session did not supply", () => {
    const { service, repo } = fixture();
    service.openRun("ws-1", "user-1", "analytics");
    service.recordObservation("ws-1", "user-1", "analytics", {
      metric: "cost",
      subjectId: "run-1",
      amountMinor: 100,
    });
    const trail = service.trail("ws-1", "user-1", "analytics");
    if (!trail.ok) throw new Error("trail failed");
    expect(trail.value.runs[0]?.agentVersion).toBe("1.0.0");
    expect(trail.value.runs[0]?.openedBy).toBe("user-1");
    expect(repo.runs[0]?.workspaceId).toBe("ws-1");
  });
});

describe("the published policy", () => {
  it("is readable before anything is measured", () => {
    const { service, repo } = fixture();
    const policy = service.policy("ws-1", "user-1");
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    expect(policy.value.metrics).toHaveLength(13);
    expect(policy.value.verdicts).toEqual(["met", "unmet", "unobserved"]);
    expect(policy.value.measuredMetrics).toEqual([
      { metric: "cost", unit: "minor_units" },
      { metric: "latency", unit: "milliseconds" },
    ]);
    expect(policy.value.gateRule).toContain("production agents require evaluation evidence");
    expect(policy.value.neverDoes.length).toBeGreaterThan(0);
    expect(repo.writes).toBe(0);
  });

  it("publishes the same thirteen metrics the engine measures", () => {
    const { service } = fixture();
    const policy = service.policy("ws-1", "user-1");
    if (!policy.ok) throw new Error("policy failed");
    expect(policy.value.metrics).toEqual(EVALUATION_METRICS);
  });
});

describe("the production gate resolver", () => {
  it("answers from stored judgements, and refuses when they cannot be read", () => {
    const { service, repo } = fixture();
    const gate = createProductionGate(service);

    expect(
      gate({ workspaceId: "ws-1", userId: "user-1", agentId: "analytics", version: "1.0.0" }),
    ).toEqual({
      satisfied: false,
      reason: expect.stringContaining("insufficient_evidence"),
    });

    passAnalytics(service);
    const satisfied = gate({
      workspaceId: "ws-1",
      userId: "user-1",
      agentId: "analytics",
      version: "1.0.0",
    });
    expect(satisfied.satisfied).toBe(true);
    expect(satisfied.reason).toContain(EVALUATION_RULE_VERSION);

    // A storage outage must deny the promotion, never allow it.
    repo.faults.list = "UNAVAILABLE";
    const broken = gate({
      workspaceId: "ws-1",
      userId: "user-1",
      agentId: "analytics",
      version: "1.0.0",
    });
    expect(broken.satisfied).toBe(false);
    expect(broken.reason).toContain("could not be read");

    // And a tenant that cannot see the evidence cannot promote with it.
    delete repo.faults.list;
    const stranger = gate({
      workspaceId: "ws-1",
      userId: "user-2",
      agentId: "analytics",
      version: "1.0.0",
    });
    expect(stranger.satisfied).toBe(false);
  });

  it("ignores the version it is handed and uses the declaration's own", () => {
    const { service } = fixture();
    passAnalytics(service);
    const gate = createProductionGate(service);
    // The query's `version` is the registry's own claim; the report reads the
    // declaration, so a caller cannot narrow the gate by naming another one.
    const answer = gate({
      workspaceId: "ws-1",
      userId: "user-1",
      agentId: "analytics",
      version: "0.0.1",
    });
    expect(answer.satisfied).toBe(true);
  });
});
