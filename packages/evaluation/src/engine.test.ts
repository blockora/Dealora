import { describe, expect, it } from "vitest";
import type { AgentCostLimit, AgentDeclaration } from "@dealora/agent";
import { AGENT_EVALUATION_METRICS, declarationFor } from "@dealora/agent";
import { SCHEMA } from "@dealora/db";

import {
  deriveEvaluationReport,
  deriveGateDecision,
  deriveReportStatus,
  latestRun,
  measureCost,
  measureLatency,
  measureMetric,
  measureRate,
  sortObservations,
  sortRuns,
} from "./engine.js";
import {
  BASIS_POINT_SCALE,
  EVALUATION_METRICS,
  EVALUATION_NEVER_DOES,
  EVALUATION_RULE_VERSION,
  EVALUATION_VERDICTS,
  LATENCY_CEILING_MS,
  isEvaluationMetric,
  isEvaluationVerdict,
  metricOrder,
} from "./rules.js";
import type {
  EvaluationMetricResult,
  EvaluationObservationView,
  EvaluationRunRow,
  EvaluationRunView,
} from "./types.js";

/** The eleven of §26's metrics that are a rate, and `cost`/`latency` beside it. */
const RATE_METRICS = EVALUATION_METRICS.filter((rule) => rule.kind === "rate");

function limits(maxSpendMinor = 200_000, maxPerExecutionMinor = 20_000): AgentCostLimit {
  return { maxSpendMinor, maxPerExecutionMinor, currency: "USD" };
}

/**
 * Build judgement rows for one metric.
 *
 * The ids are deliberately non-sequential so a test can never pass by accident
 * because the input happened to arrive in the order the answer expects.
 */
function observations(
  metric: EvaluationMetricResult["metric"],
  verdicts: readonly EvaluationObservationView["verdict"][],
): readonly EvaluationObservationView[] {
  return verdicts.map((verdict, index) => ({
    id: `obs-${index}-${metric}`,
    runId: "run-1",
    metric,
    subjectId: `subject-${String(index).padStart(2, "0")}`,
    verdict,
    amountMinor: null,
    durationMs: null,
    note: null,
    recordedBy: "user-1",
    recordedAt: "2026-01-01T00:00:00.000Z",
  }));
}

function spend(amounts: readonly number[]): readonly EvaluationObservationView[] {
  return amounts.map((amountMinor, index) => ({
    id: `spend-${index}`,
    runId: "run-1",
    metric: "cost",
    subjectId: `subject-${String(index).padStart(2, "0")}`,
    verdict: null,
    amountMinor,
    durationMs: null,
    note: null,
    recordedBy: "user-1",
    recordedAt: "2026-01-01T00:00:00.000Z",
  }));
}

function durations(values: readonly number[]): readonly EvaluationObservationView[] {
  return values.map((durationMs, index) => ({
    id: `run-${index}`,
    runId: "run-1",
    metric: "latency",
    subjectId: `subject-${String(index).padStart(2, "0")}`,
    verdict: null,
    amountMinor: null,
    durationMs,
    note: null,
    recordedBy: "user-1",
    recordedAt: "2026-01-01T00:00:00.000Z",
  }));
}

describe("the published rule table", () => {
  it("publishes exactly the thirteen metrics ROADMAP.md §26 names", () => {
    expect(EVALUATION_METRICS.map((rule) => rule.metric).sort()).toEqual([
      "accuracy",
      "business_outcome",
      "cost",
      "failure_rate",
      "hallucination_rate",
      "human_override_rate",
      "latency",
      "personalization_quality",
      "qualification_accuracy",
      "relevance",
      "response_classification_accuracy",
      "task_success",
      "tool_call_correctness",
    ]);
    // Every metric Phase 18 declared is measured here, and none is invented.
    expect(new Set(EVALUATION_METRICS.map((rule) => rule.metric))).toEqual(
      new Set(AGENT_EVALUATION_METRICS.map((entry) => entry.metric)),
    );
  });

  it("gives every metric a bar, a minimum sample and a reason", () => {
    for (const rule of EVALUATION_METRICS) {
      expect(rule.rationale.length, rule.metric).toBeGreaterThan(20);
      expect(rule.description.length, rule.metric).toBeGreaterThan(10);
      expect(rule.minimumSample, rule.metric).toBeGreaterThan(0);
      if (rule.kind === "rate") {
        expect(rule.threshold, rule.metric).toBeGreaterThan(0);
        expect(rule.threshold, rule.metric).toBeLessThanOrEqual(BASIS_POINT_SCALE);
        expect(rule.minimumSample, rule.metric).toBeGreaterThanOrEqual(5);
      }
    }
    // `cost` never judges against its published placeholder: the real ceiling
    // comes from the agent's own declaration.
    const cost = EVALUATION_METRICS.find((rule) => rule.metric === "cost");
    expect(cost?.threshold).toBe(0);
    expect(cost?.minimumSample).toBe(1);
    expect(LATENCY_CEILING_MS).toBeGreaterThan(0);
  });

  it("narrows only its own vocabulary", () => {
    expect(isEvaluationMetric("task_success")).toBe(true);
    expect(isEvaluationMetric("sales")).toBe(false);
    expect(isEvaluationVerdict("met")).toBe(true);
    expect(isEvaluationVerdict("passed")).toBe(false);
    expect(EVALUATION_VERDICTS).toEqual(["met", "unmet", "unobserved"]);
  });

  it("orders metrics by the published table, never by insertion order", () => {
    const published = EVALUATION_METRICS.map((rule) => rule.metric);
    const reversed = [...published].reverse();
    // Every metric has a distinct position in the published table, and the
    // position is what an observation listing sorts by.
    expect(new Set(published.map(metricOrder)).size).toBe(13);
    expect([...published].sort((a, b) => metricOrder(a) - metricOrder(b))).toEqual(published);
    expect([...reversed].sort((a, b) => metricOrder(a) - metricOrder(b))).toEqual(published);
    expect(metricOrder("task_success")).toBe(0);
    expect(metricOrder("nope")).toBe(-1);
  });

  it("states its negative space", () => {
    const never = EVALUATION_NEVER_DOES.join(" ");
    expect(never).toContain("Never executes");
    expect(never).toContain("Never calls a model");
    expect(never).toContain("Never fabricates");
    expect(never).toContain("Never scores a judgement");
    expect(never).toContain("Never converts absent evidence");
    expect(never).toContain("Never uses the clock");
    expect(never).toContain("Never traces a run");
    expect(never).toContain("Never grants an agent a capability");
  });
});

describe("rate metrics", () => {
  it("measures every rate metric against its own threshold", () => {
    // A hundred subjects makes every published threshold a whole number of
    // observations, so "exactly at the threshold" is exactly expressible and the
    // pass/fail pair below differs by a single judgement.
    const sample = 100;
    for (const rule of RATE_METRICS) {
      const required =
        rule.direction === "at_least"
          ? (rule.threshold * sample) / BASIS_POINT_SCALE
          : ((BASIS_POINT_SCALE - rule.threshold) * sample) / BASIS_POINT_SCALE;
      expect(Number.isInteger(required), rule.metric).toBe(true);
      const passing = observations(
        rule.metric,
        Array.from({ length: sample }, (_unused, index) => (index < required ? "met" : "unmet")),
      );
      const failing = observations(
        rule.metric,
        Array.from({ length: sample }, (_unused, index) =>
          index < required - 1 ? "met" : "unmet",
        ),
      );
      const atThreshold = measureRate(rule.metric, passing);
      expect(atThreshold.status, rule.metric).toBe("met");
      expect(atThreshold.measured, rule.metric).toBe(
        rule.direction === "at_least" ? rule.threshold : BASIS_POINT_SCALE - rule.threshold,
      );
      const justBelow = measureRate(rule.metric, failing);
      expect(justBelow.status, rule.metric).toBe("unmet");
      expect(justBelow.sampleSize, rule.metric).toBe(sample);
    }
  });

  it("decides the exact threshold, one above it and one below it", () => {
    // `task_success` is "at least 8000" basis points. 4/5 is exactly 8000 and
    // passes; 3/5 is 6000 and does not. There is no rounding to hide behind.
    const exact = measureRate(
      "task_success",
      observations("task_success", ["met", "met", "met", "met", "unmet"]),
    );
    expect(exact.measured).toBe(8_000);
    expect(exact.status).toBe("met");

    const below = measureRate(
      "task_success",
      observations("task_success", ["met", "met", "met", "unmet", "unmet"]),
    );
    expect(below.measured).toBe(6_000);
    expect(below.status).toBe("unmet");

    // A rate that is not exactly representable in basis points still decides the
    // same way every run: 2/3 is 6666 basis points, which is below 8000.
    const third = measureRate(
      "task_success",
      observations("task_success", ["met", "met", "unmet", "met", "met", "unmet"]),
    );
    expect(third.measured).toBe(6_666);
    expect(third.status).toBe("unmet");
  });

  it("reads an `at_most` threshold as a ceiling on failures", () => {
    // `hallucination_rate` is "at most 500" failures per 10000, i.e. 9500 met.
    const judged = (met: number) =>
      observations(
        "hallucination_rate",
        Array.from({ length: 100 }, (_unused, index) => (index < met ? "met" : "unmet")),
      );
    const exact = measureRate("hallucination_rate", judged(95));
    expect(exact.measured).toBe(9_500);
    expect(exact.status).toBe("met");
    // One more failure in a hundred is 9400 met, below the floor.
    const over = measureRate("hallucination_rate", judged(94));
    expect(over.measured).toBe(9_400);
    expect(over.status).toBe("unmet");
  });

  it("counts an unobserved subject in the denominator, never as a good one", () => {
    // Declining to judge must never raise a metric: the unobserved row makes
    // this 4/5, which fails, rather than 4/4, which would pass.
    const withUnobserved = measureRate(
      "task_success",
      observations("task_success", ["met", "met", "met", "met", "unobserved"]),
    );
    expect(withUnobserved.measured).toBe(8_000);
    expect(withUnobserved.status).toBe("met");
    expect(withUnobserved.counts).toEqual({ met: 4, unmet: 0, unobserved: 1 });

    const declineTwo = measureRate(
      "task_success",
      observations("task_success", ["met", "met", "met", "unobserved", "unobserved"]),
    );
    expect(declineTwo.measured).toBe(6_000);
    expect(declineTwo.status).toBe("unmet");
  });

  it("refuses to measure below the minimum sample, with no value at all", () => {
    const four = measureRate(
      "task_success",
      observations("task_success", ["met", "met", "met", "met"]),
    );
    expect(four.status).toBe("insufficient_evidence");
    // Not zero: `null` is not a number any measurement could take.
    expect(four.measured).toBeNull();
    expect(four.sampleSize).toBe(4);
    expect(four.minimumSample).toBe(5);
    expect(four.reason).toContain("has not been measured");

    const none = measureRate("task_success", []);
    expect(none.status).toBe("insufficient_evidence");
    expect(none.measured).toBeNull();
    expect(none.counts).toEqual({ met: 0, unmet: 0, unobserved: 0 });
  });

  it("refuses a metric it does not publish, rather than inventing one", () => {
    expect(() => measureRate("vibes", [])).toThrow(/no published evaluation rule/);
  });
});

describe("the cost metric", () => {
  it("measures the total against the agent's own declared ceiling", () => {
    const result = measureCost(spend([1_000, 2_000]), limits(200_000, 20_000));
    expect(result.status).toBe("met");
    expect(result.measured).toBe(3_000);
    expect(result.threshold).toBe(200_000);
    expect(result.cost).toEqual({
      currency: "USD",
      totalMinor: 3_000,
      worstMinor: 2_000,
      maxSpendMinor: 200_000,
      maxPerExecutionMinor: 20_000,
      overSpend: false,
      overPerExecution: false,
    });
  });

  it("fails on the total ceiling and on the per-execution ceiling separately", () => {
    const bothOver = measureCost(spend([150_000, 150_000]), limits(200_000, 20_000));
    expect(bothOver.status).toBe("unmet");
    expect(bothOver.cost?.overSpend).toBe(true);
    expect(bothOver.cost?.overPerExecution).toBe(true);

    // Under the total, over a single run: a real failure, checked separately,
    // because "cheap on average" is not "within budget".
    const overOne = measureCost(spend([1_000, 25_000]), limits(200_000, 20_000));
    expect(overOne.cost?.overSpend).toBe(false);
    expect(overOne.cost?.overPerExecution).toBe(true);
    expect(overOne.status).toBe("unmet");

    // Exactly at the per-execution ceiling is met: the comparison is inclusive,
    // and one minor unit over it is not.
    const exact = measureCost(spend([20_000, 20_000]), limits(200_000, 20_000));
    expect(exact.status).toBe("met");
    expect(exact.cost?.worstMinor).toBe(20_000);
    const oneOver = measureCost(spend([20_001, 20_000]), limits(200_000, 20_000));
    expect(oneOver.status).toBe("unmet");
    // Exactly at the total ceiling, with every run inside the per-run ceiling,
    // is also met — the two ceilings are checked independently.
    const atTotal = measureCost(
      spend(Array.from({ length: 10 }, () => 20_000)),
      limits(200_000, 20_000),
    );
    expect(atTotal.cost?.totalMinor).toBe(200_000);
    expect(atTotal.status).toBe("met");
    const overTotal = measureCost(
      spend([...Array.from({ length: 10 }, () => 20_000), 1]),
      limits(200_000, 20_000),
    );
    expect(overTotal.cost?.overSpend).toBe(true);
    expect(overTotal.status).toBe("unmet");
  });

  it("refuses to measure with no recorded spend, with no total of zero", () => {
    const none = measureCost([], limits());
    expect(none.status).toBe("insufficient_evidence");
    expect(none.measured).toBeNull();
    expect(none.reason).toContain("has not been measured");
  });

  it("saturates rather than wrapping an overflowing total", () => {
    const huge = measureCost(spend([Number.MAX_SAFE_INTEGER, 1]), limits());
    expect(huge.cost?.totalMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(huge.status).toBe("unmet");
  });
});

describe("the latency metric", () => {
  it("measures the slowest run, not an average", () => {
    const result = measureLatency(durations([100, 400, 200]));
    expect(result.measured).toBe(400);
    expect(result.status).toBe("met");
    expect(result.latency).toEqual({ worstMs: 400, ceilingMs: LATENCY_CEILING_MS });
  });

  it("decides the exact ceiling, one millisecond over and one under", () => {
    expect(measureLatency(durations([LATENCY_CEILING_MS])).status).toBe("met");
    expect(measureLatency(durations([LATENCY_CEILING_MS - 1])).status).toBe("met");
    expect(measureLatency(durations([LATENCY_CEILING_MS + 1])).status).toBe("unmet");
    // One slow run inside a set of fast ones still fails, which an average
    // would have hidden.
    expect(measureLatency(durations([10, 10, 10, 10, LATENCY_CEILING_MS + 1])).status).toBe(
      "unmet",
    );
  });

  it("refuses to measure with no recorded run", () => {
    const none = measureLatency([]);
    expect(none.status).toBe("insufficient_evidence");
    expect(none.measured).toBeNull();
  });
});

describe("routing one metric to its measurement", () => {
  it("sends every declared metric to exactly one shape", () => {
    for (const rule of EVALUATION_METRICS) {
      const result = measureMetric(rule.metric, [], limits());
      expect(result?.kind, rule.metric).toBe(rule.kind);
      expect(result?.status, rule.metric).toBe("insufficient_evidence");
    }
  });

  it("returns null for a metric outside the published table", () => {
    expect(measureMetric("vibes", [], limits())).toBeNull();
  });
});

describe("the report", () => {
  const declared = declarationFor("analytics");
  if (!declared) throw new Error("analytics must be declared");
  const analytics: AgentDeclaration = declared;

  function run(): EvaluationRunView {
    return {
      id: "run-1",
      agentId: "analytics",
      agentVersion: analytics.version,
      runNumber: 1,
      observationCount: 0,
      live: true,
      openedBy: "user-1",
      openedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  /** A full, passing evaluation for `analytics`: five of everything. */
  function passingRows(): readonly EvaluationObservationView[] {
    const rows: EvaluationObservationView[] = [];
    const judged: readonly EvaluationMetricResult["metric"][] = [
      "task_success",
      "accuracy",
      "relevance",
    ];
    for (const metric of judged) {
      rows.push(...observations(metric, ["met", "met", "met", "met", "met"]));
    }
    rows.push(...spend([500]));
    rows.push(...durations([1_200]));
    return rows;
  }

  it("lists exactly the metrics the declaration names, in declaration order", () => {
    const report = deriveEvaluationReport({
      agentId: "analytics",
      declaration: analytics,
      run: run(),
      observations: passingRows(),
    });
    expect(report.metrics.map((metric) => metric.metric)).toEqual([
      "task_success",
      "accuracy",
      "relevance",
      "cost",
      "latency",
    ]);
    expect(report.agentVersion).toBe(analytics.version);
    expect(report.ruleVersion).toBe(EVALUATION_RULE_VERSION);
    // 5 judgements × 3 rate metrics, plus one spend and one duration.
    expect(report.run?.observationCount).toBe(17);
    expect(report.status).toBe("met");
    expect(report.gate.satisfied).toBe(true);
  });

  it("reports every declared metric as unmeasured for an agent with no round", () => {
    const report = deriveEvaluationReport({
      agentId: "analytics",
      declaration: analytics,
      run: null,
      observations: [],
    });
    expect(report.run).toBeNull();
    expect(report.metrics).toHaveLength(5);
    expect(report.metrics.every((metric) => metric.status === "insufficient_evidence")).toBe(true);
    expect(report.metrics.every((metric) => metric.measured === null)).toBe(true);
    expect(report.status).toBe("insufficient_evidence");
    expect(report.gate.satisfied).toBe(false);
    expect(report.gate.reason).toContain("insufficient_evidence");
  });

  it("ignores observations recorded for a metric this agent does not declare", () => {
    // `analytics` declares no `failure_rate`; rows for it exist, and they must
    // not appear in the report or influence any threshold.
    const report = deriveEvaluationReport({
      agentId: "analytics",
      declaration: analytics,
      run: run(),
      observations: [
        ...passingRows(),
        ...observations("failure_rate", ["unmet", "unmet", "unmet", "unmet", "unmet"]),
      ],
    });
    expect(report.metrics.map((metric) => metric.metric)).not.toContain("failure_rate");
    expect(report.status).toBe("met");
  });

  it("is byte-identical across calls over the same rows", () => {
    const input = {
      agentId: "analytics" as const,
      declaration: analytics,
      run: run(),
      observations: passingRows(),
    };
    expect(JSON.stringify(deriveEvaluationReport(input))).toBe(
      JSON.stringify(deriveEvaluationReport(input)),
    );
    // Reordered input prints identically too, because nothing depends on the
    // order the rows arrived in.
    const shuffled = [...passingRows()].reverse();
    expect(JSON.stringify(deriveEvaluationReport({ ...input, observations: shuffled }))).toBe(
      JSON.stringify(deriveEvaluationReport(input)),
    );
  });

  it("discards a round recorded against another agent version", () => {
    const declaration: AgentDeclaration = { ...analytics, version: "9.9.9" };
    const report = deriveEvaluationReport({
      agentId: "analytics",
      declaration,
      run: run(),
      observations: passingRows(),
    });
    // The judgements exist, but they were made about 1.0.0 and are discarded
    // with their round rather than measured against a declaration they were
    // never made about.
    expect(report.agentVersion).toBe("9.9.9");
    expect(report.run).toBeNull();
    expect(report.metrics.every((metric) => metric.measured === null)).toBe(true);
    expect(report.status).toBe("insufficient_evidence");
  });
});

describe("the promotion gate", () => {
  /** A complete metric result with one field overridden, so no cast is needed. */
  function result(
    metric: EvaluationMetricResult["metric"],
    status: EvaluationMetricResult["status"],
  ): EvaluationMetricResult {
    const rule = EVALUATION_METRICS.find((entry) => entry.metric === metric);
    if (!rule) throw new Error(`no published rule for ${metric}`);
    return {
      metric,
      kind: rule.kind,
      direction: rule.direction,
      unit:
        rule.kind === "rate"
          ? "basis_points"
          : rule.kind === "spend_minor"
            ? "minor_units"
            : "milliseconds",
      threshold: rule.threshold,
      minimumSample: rule.minimumSample,
      sampleSize: rule.minimumSample,
      measured: status === "met" ? rule.threshold : null,
      status,
      counts: null,
      cost: null,
      latency: null,
      reason: `${metric} is ${status}.`,
    };
  }

  it("is satisfied only when every metric is met", () => {
    expect(
      deriveGateDecision([result("task_success", "met"), result("accuracy", "met")]).satisfied,
    ).toBe(true);
    expect(
      deriveGateDecision([
        result("task_success", "met"),
        result("accuracy", "met"),
        result("relevance", "unmet"),
      ]).satisfied,
    ).toBe(false);
  });

  it("names every blocking metric rather than only denying", () => {
    const decision = deriveGateDecision([
      result("task_success", "unmet"),
      result("accuracy", "insufficient_evidence"),
      result("relevance", "met"),
    ]);
    expect(decision.satisfied).toBe(false);
    expect(decision.reason).toContain("2 of 3");
    expect(decision.reason).toContain("task_success unmet");
    expect(decision.reason).toContain("accuracy insufficient_evidence");
  });

  it("ranks insufficient evidence above a plain failure", () => {
    expect(
      deriveReportStatus([
        result("task_success", "unmet"),
        result("accuracy", "insufficient_evidence"),
      ]),
    ).toBe("insufficient_evidence");
    expect(deriveReportStatus([result("task_success", "met"), result("accuracy", "unmet")])).toBe(
      "unmet",
    );
    expect(deriveReportStatus([result("task_success", "met")])).toBe("met");
  });
});

describe("rounds and ordering", () => {
  function round(id: string, version: string, runNumber: number): EvaluationRunRow {
    return {
      id,
      workspaceId: "ws-1",
      agentId: "analytics",
      version,
      runNumber,
      createdBy: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("names the live round by number, never by the clock", () => {
    const runs = [round("r1", "1.0.0", 1), round("r2", "1.0.0", 2), round("r3", "1.0.0", 3)];
    expect(latestRun(runs, "1.0.0")?.id).toBe("r3");
    expect(latestRun([...runs].reverse(), "1.0.0")?.id).toBe("r3");
    expect(latestRun(runs, "2.0.0")).toBeNull();
  });

  it("treats evidence from another agent version as a different round", () => {
    const runs = [round("old", "1.0.0", 7), round("new", "1.1.0", 1)];
    // The higher number belongs to the old version and must not be adopted.
    expect(latestRun(runs, "1.1.0")?.id).toBe("new");
  });

  it("prints rounds newest first", () => {
    const views = [1, 3, 2].map(
      (runNumber) =>
        ({
          id: `r${runNumber}`,
          agentId: "analytics",
          agentVersion: "1.0.0",
          runNumber,
          openedBy: "user-1",
          openedAt: "2026-01-01T00:00:00.000Z",
          observationCount: 0,
          live: false,
        }) satisfies EvaluationRunView,
    );
    expect(sortRuns(views).map((run) => run.runNumber)).toEqual([3, 2, 1]);
    expect(sortRuns(views).map((run) => run.runNumber)).toEqual(
      sortRuns([...views].reverse()).map((run) => run.runNumber),
    );
  });

  it("orders the trail by metric then subject, with no id tiebreak", () => {
    const rows: EvaluationObservationView[] = [
      ...observations("relevance", ["met", "met"]),
      ...observations("task_success", ["met", "met"]),
      ...durations([100, 50]),
    ];
    const sorted = sortObservations(rows);
    expect(sorted.map((row) => `${row.metric}:${row.subjectId}`)).toEqual([
      "task_success:subject-00",
      "task_success:subject-01",
      "relevance:subject-00",
      "relevance:subject-01",
      "latency:subject-00",
      "latency:subject-01",
    ]);
    // Reversed input prints the same trail, so the store's row order can never
    // change an answer.
    expect(sortObservations([...rows].reverse()).map((row) => row.id)).toEqual(
      sorted.map((row) => row.id),
    );
    // Equal timestamps and equal verdicts do not reorder anything.
    expect(new Set(rows.map((row) => row.recordedAt)).size).toBe(1);
    expect(sortObservations([...rows].reverse())).toHaveLength(rows.length);
  });
});

describe("storage vocabulary stays in step with the domain", () => {
  it("constrains the metric column to the thirteen published metrics", () => {
    for (const rule of EVALUATION_METRICS) {
      expect(SCHEMA).toContain(`'${rule.metric}'`);
    }
    expect(SCHEMA).not.toContain("'vibes'");
  });

  it("constrains the verdict column to the three recorded judgements", () => {
    for (const verdict of EVALUATION_VERDICTS) {
      expect(SCHEMA).toContain(`'${verdict}'`);
    }
  });

  it("stores no column for a computed outcome", () => {
    // No column on the judgement table may hold a rate, a threshold comparison
    // or a pass: the engine derives all of them, and a stored one could be
    // forged. Other tables legitimately have a `score` (Phase 8's
    // qualification), so the check is scoped to this one statement.
    const start = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS "agent_evaluation_observations"');
    expect(start).toBeGreaterThan(-1);
    const statement = SCHEMA.slice(start, SCHEMA.indexOf(";", start));
    for (const forbidden of ["rate", "score", "passed", "threshold", "evaluated", "status"]) {
      expect(statement, forbidden).not.toContain(`"${forbidden}"`);
    }
    // What it does store: the judgement, or one measured quantity.
    expect(statement).toContain('"verdict"');
    expect(statement).toContain('"amount_minor"');
    expect(statement).toContain('"duration_ms"');
  });
});
