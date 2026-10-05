import { describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore, LATEST_SCHEMA_VERSION } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { signup } from "@dealora/auth";
import { AGENT_IDS, AGENT_STATE_ORDER, MEETABLE_AGENT_STATES } from "@dealora/agent";
import { LATENCY_CEILING_MS } from "@dealora/evaluation";

/**
 * Phase 19 gate — ROADMAP.md §26 (Agent Evaluation).
 *
 * §26 asks for one thing, stated as an objective and a gate: **prevent fluent
 * but unreliable agents from entering production**, by measuring thirteen named
 * metrics, behind the rule *production agents require evaluation evidence*.
 * This gate drives the **real** API over the **real** store and checks that
 * the phase delivers exactly that — and nothing that looks like it:
 *
 * - **All thirteen metrics are measured, each against its own bar.** The
 *   numbers are read back over the wire from the route the production wiring
 *   built, and each one is checked for a published threshold, a minimum sample
 *   and a reason.
 * - **Evidence is real and derived.** A caller contributes a subject and a
 *   judgement; the rate, the total, the threshold comparison and the verdict
 *   come back from stored rows. There is no request that says "this passed".
 * - **The gate is fail-closed at every step**: no round, no evidence,
 *   incomplete coverage, a failing metric, a superseded round, another
 *   version's evidence, another workspace's evidence, or an unreadable store —
 *   every one refuses, and every refusal names what is missing and writes
 *   nothing.
 * - **The lifecycle transition is real but narrow.** `approved → production`
 *   succeeds on complete, passing evidence for the exact declared version — and
 *   grants a governance state and **no capability**: nothing becomes usable,
 *   because this repository still has no runner.
 * - **The negative space holds.** No trace of a run, no runner, no model, no
 *   network, and a snapshot proving evaluation wrote to its own two tables and
 *   touched nothing else.
 */

let seq = 0;
/** Unique per test run and per process, so repeated runs never collide. */
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${process.pid}`;
}

function request(
  token: string,
  params: Record<string, string>,
  body?: unknown,
  query?: Record<string, unknown>,
): RequestBody {
  return { body, query: { sessionToken: token, ...(query ?? {}) }, params };
}

async function dataOf(result: Promise<Result<ApiResponse<unknown>, ApiError>>): Promise<unknown> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(`expected success, got ${resolved.error.code}: ${resolved.error.message}`);
  }
  if (resolved.value.status !== "ok") throw new Error("expected an ok response envelope");
  return resolved.value.data;
}

async function errorOf(result: Promise<Result<ApiResponse<unknown>, ApiError>>): Promise<ApiError> {
  const resolved = await result;
  if (resolved.ok) throw new Error("expected a failure");
  return resolved.error;
}

type Handlers = ReturnType<typeof createDefaultHandlers>;

interface GateMetric {
  metric: string;
  kind: string;
  direction: string;
  unit: string;
  threshold: number;
  minimumSample: number;
  sampleSize: number;
  measured: number | null;
  status: string;
  reason: string;
  counts: { met: number; unmet: number; unobserved: number } | null;
  cost: {
    currency: string;
    totalMinor: number;
    worstMinor: number;
    maxSpendMinor: number;
    maxPerExecutionMinor: number;
    overSpend: boolean;
    overPerExecution: boolean;
  } | null;
  latency: { worstMs: number; ceilingMs: number } | null;
}

interface GateReport {
  ruleVersion: string;
  agentId: string;
  agentVersion: string;
  run: { runNumber: number; observationCount: number } | null;
  metrics: GateMetric[];
  status: string;
  gate: { satisfied: boolean; reason: string };
}

interface GateTrail {
  runs: {
    id: string;
    agentVersion: string;
    runNumber: number;
    observationCount: number;
    live: boolean;
    openedBy: string;
  }[];
  observations: {
    id: string;
    metric: string;
    subjectId: string;
    verdict: string | null;
    amountMinor: number | null;
    durationMs: number | null;
    recordedBy: string;
    recordedAt: string;
  }[];
}

interface GatePolicy {
  ruleVersion: string;
  metrics: { metric: string; threshold: number; minimumSample: number; rationale: string }[];
  verdicts: string[];
  measuredMetrics: { metric: string; unit: string }[];
  gateRule: string;
  neverDoes: string[];
}

interface GateAgent {
  declaration: { agentId: string; version: string };
  status: string;
  usable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * A snapshot of every table the evaluation surface could conceivably touch.
 *
 * Scoped to one workspace: the gate file shares the process-wide store with
 * every other tenant it creates, so an unscoped count would measure the file.
 */
function rowCounts(workspaceId?: string): Record<string, number> {
  const db = defaultStore.db;
  const mine = (rows?: readonly { workspaceId: string }[]): number =>
    rows === undefined
      ? 0
      : workspaceId === undefined
        ? rows.length
        : rows.filter((row) => row.workspaceId === workspaceId).length;
  return {
    runs: mine(db.agentEvaluationRuns),
    observations: mine(db.agentEvaluationObservations),
    registry: mine(db.agentRegistry),
    registryEvents: mine(db.agentRegistryEvents),
    goals: mine(db.revenueGoals),
    accounts: mine(db.accounts),
    evidence: mine(db.evidence),
    qualifications: mine(db.qualifications),
    drafts: mine(db.personalizedDrafts),
    approvals: mine(db.approvalRequests),
    actions: mine(db.outboundActions),
    suppressions: mine(db.outboundSuppressions),
    messages: mine(db.inboundMessages),
    classifications: mine(db.conversationClassifications),
    meetings: mine(db.meetings),
    costs: mine(db.costEvents),
    recommendations: mine(db.nextBestActions),
  };
}

function tenant(name: string): { token: string; userId: string; workspaceId: string } {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const owner = signup(`${unique(slug)}@example.com`, "correct-horse-battery", name);
  // The slug is derived from the name, so the process id keeps a repeated run
  // from colliding with a workspace the previous run left on disk.
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq} ${process.pid}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

const analytics = (workspaceId: string) => ({ workspaceId, agentId: "analytics" });

/** Open an evaluation round for `analytics` through the real route. */
async function openRound(t: { token: string; workspaceId: string }, h?: Handlers) {
  const handlers = h ?? createDefaultHandlers();
  return dataOf(handlers.openAgentEvaluationRunHandler(request(t.token, analytics(t.workspaceId))));
}

/** Record one judgement through the real route. */
async function judge(
  t: { token: string; workspaceId: string },
  body: Record<string, unknown>,
  h?: Handlers,
) {
  const handlers = h ?? createDefaultHandlers();
  return dataOf(
    handlers.recordAgentEvaluationHandler(request(t.token, analytics(t.workspaceId), body)),
  );
}

/** Record `verdicts` for each of `analytics`' three rate metrics. */
async function judgeRates(
  t: { token: string; workspaceId: string },
  verdicts: readonly ("met" | "unmet" | "unobserved")[],
  h?: Handlers,
) {
  for (const metric of ["task_success", "accuracy", "relevance"]) {
    for (const [index, verdict] of verdicts.entries()) {
      await judge(t, { metric, subjectId: `${metric}-${index}`, verdict }, h);
    }
  }
}

/** A complete, passing evaluation for `analytics`. */
async function passAnalytics(
  t: { token: string; workspaceId: string },
  verdicts: readonly ("met" | "unmet" | "unobserved")[] = ["met", "met", "met", "met", "met"],
  h?: Handlers,
) {
  await openRound(t, h);
  await judgeRates(t, verdicts, h);
  await judge(t, { metric: "cost", subjectId: "run-cost", amountMinor: 500 }, h);
  await judge(t, { metric: "latency", subjectId: "run-latency", durationMs: 1_200 }, h);
}

async function reportOf(
  t: { token: string; workspaceId: string },
  h?: Handlers,
): Promise<GateReport> {
  const handlers = h ?? createDefaultHandlers();
  return (await dataOf(
    handlers.getAgentEvaluationHandler(request(t.token, analytics(t.workspaceId))),
  )) as GateReport;
}

/** Walk one agent to `approved` through the real route. */
async function approve(t: { token: string; workspaceId: string }, agentId: string, h?: Handlers) {
  const handlers = h ?? createDefaultHandlers();
  for (const status of ["testing", "approved"]) {
    await dataOf(
      handlers.changeAgentStatusHandler(
        request(t.token, { workspaceId: t.workspaceId, agentId }, { status }),
      ),
    );
  }
}

describe("Phase 19 gate — Agent Evaluation (ROADMAP.md §26)", () => {
  it("measures all thirteen metrics §26 names, each against its own published bar", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Metrics");
    const policy = (await dataOf(
      h.getAgentEvaluationPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as GatePolicy;

    // ROADMAP.md §26's thirteen, read back over the wire, in its own order.
    expect(policy.metrics.map((metric) => metric.metric)).toEqual([
      "task_success",
      "accuracy",
      "relevance",
      "hallucination_rate",
      "tool_call_correctness",
      "qualification_accuracy",
      "personalization_quality",
      "response_classification_accuracy",
      "cost",
      "latency",
      "failure_rate",
      "human_override_rate",
      "business_outcome",
    ]);
    expect(policy.ruleVersion).toBe("evaluation-1.0.0");

    // Each has a bar, a minimum sample and a stated reason. The ten rate
    // metrics need five judgements before they are judged at all; the two
    // absolute limits need one, because a ceiling is exceeded by a single run.
    for (const metric of policy.metrics) {
      expect(metric.threshold, metric.metric).toBeGreaterThanOrEqual(0);
      expect(metric.minimumSample, metric.metric).toBeGreaterThan(0);
      expect(metric.rationale.length, metric.metric).toBeGreaterThan(20);
      if (metric.metric === "cost" || metric.metric === "latency") {
        expect(metric.minimumSample, metric.metric).toBe(1);
      } else {
        expect(metric.minimumSample, metric.metric).toBe(5);
        expect(metric.threshold, metric.metric).toBeGreaterThan(0);
      }
    }
    expect(policy.metrics.find((metric) => metric.metric === "latency")?.threshold).toBe(
      LATENCY_CEILING_MS,
    );
    expect(policy.verdicts).toEqual(["met", "unmet", "unobserved"]);
    expect(policy.gateRule).toContain("production agents require evaluation evidence");
  });

  it("reports every declared metric as unmeasured when nothing is recorded", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Empty");
    const report = await reportOf(t, h);

    expect(report.run).toBeNull();
    expect(report.agentVersion).toBe("1.0.0");
    expect(report.metrics.map((metric) => metric.metric)).toEqual([
      "task_success",
      "accuracy",
      "relevance",
      "cost",
      "latency",
    ]);
    // Absence is reported, never zero-filled: zero would read as a perfect
    // `hallucination_rate` and a total failure for `task_success`.
    expect(report.metrics.every((metric) => metric.status === "insufficient_evidence")).toBe(true);
    expect(report.metrics.every((metric) => metric.measured === null)).toBe(true);
    expect(report.status).toBe("insufficient_evidence");
    expect(report.gate.satisfied).toBe(false);
    expect(report.gate.reason).toContain("insufficient_evidence");
  });

  it("derives every rate from recorded judgements, exactly and deterministically", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Rates");

    // Four of five is exactly 8000 basis points: `task_success` (threshold
    // 8000) passes, `accuracy` (threshold 9500) does not. Both are decided by
    // integer arithmetic, so "exactly at the threshold" is a real boundary and
    // not a rounding artefact.
    await passAnalytics(t, ["met", "met", "met", "met", "unmet"], h);
    const report = await reportOf(t, h);
    const byMetric = new Map(report.metrics.map((metric) => [metric.metric, metric]));

    expect(byMetric.get("task_success")?.measured).toBe(8_000);
    expect(byMetric.get("task_success")?.status).toBe("met");
    expect(byMetric.get("task_success")?.counts).toEqual({
      met: 4,
      unmet: 1,
      unobserved: 0,
    });
    // `accuracy` (9500) and `relevance` (9000) both demand more than 4/5.
    expect(byMetric.get("accuracy")?.measured).toBe(8_000);
    expect(byMetric.get("accuracy")?.status).toBe("unmet");
    expect(byMetric.get("relevance")?.measured).toBe(8_000);
    expect(byMetric.get("relevance")?.status).toBe("unmet");
    expect(report.status).toBe("unmet");
    expect(report.gate.satisfied).toBe(false);
    expect(report.gate.reason).toContain("accuracy unmet");
    expect(report.gate.reason).toContain("relevance unmet");

    // The same rows print the same answer every time.
    expect(JSON.stringify(await reportOf(t, h))).toBe(JSON.stringify(report));
  });

  it("counts an unjudged subject against the agent, never for it", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Unobserved");
    await openRound(t, h);
    // Four met and one unobserved: 4/5 = 8000, which passes `task_success`.
    // Declining to look at the fifth subject must never have helped.
    await judgeRates(t, ["met", "met", "met", "met", "unobserved"], h);
    const report = await reportOf(t, h);
    const taskSuccess = report.metrics.find((metric) => metric.metric === "task_success");
    expect(taskSuccess?.counts?.unobserved).toBe(1);
    expect(taskSuccess?.measured).toBe(8_000);
    // Declining two makes it 3/5 and the gate refuses.
    await openRound(t, h);
    await judgeRates(t, ["met", "met", "met", "unobserved", "unobserved"], h);
    const declined = await reportOf(t, h);
    expect(declined.metrics.find((metric) => metric.metric === "task_success")?.measured).toBe(
      6_000,
    );
    expect(declined.gate.satisfied).toBe(false);
  });

  it("measures cost against the agent's own declared ceiling, not a Phase 19 guess", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Cost");
    await openRound(t, h);
    await judgeRates(t, ["met", "met", "met", "met", "met"], h);
    await judge(t, { metric: "latency", subjectId: "run-1", durationMs: 500 }, h);

    // `analytics` declares 100000 per run and 10000 per execution.
    await judge(t, { metric: "cost", subjectId: "run-2", amountMinor: 12_000 }, h);
    const overOne = await reportOf(t, h);
    const cost = overOne.metrics.find((metric) => metric.metric === "cost");
    expect(cost?.kind).toBe("spend_minor");
    expect(cost?.threshold).toBe(100_000);
    expect(cost?.cost?.maxPerExecutionMinor).toBe(10_000);
    expect(cost?.cost?.overSpend).toBe(false);
    expect(cost?.cost?.overPerExecution).toBe(true);
    expect(cost?.status).toBe("unmet");

    // One minor unit inside the ceiling is met: the comparison is inclusive.
    await openRound(t, h);
    await judgeRates(t, ["met", "met", "met", "met", "met"], h);
    await judge(t, { metric: "latency", subjectId: "run-1", durationMs: 500 }, h);
    await judge(t, { metric: "cost", subjectId: "run-2", amountMinor: 10_000 }, h);
    const inside = await reportOf(t, h);
    expect(inside.metrics.find((metric) => metric.metric === "cost")?.status).toBe("met");
    expect(inside.gate.satisfied).toBe(true);
  });

  it("measures latency as the slowest run, against Phase 19's published ceiling", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Latency");
    await openRound(t, h);
    await judgeRates(t, ["met", "met", "met", "met", "met"], h);
    await judge(t, { metric: "cost", subjectId: "run-cost", amountMinor: 10 }, h);
    // Four fast runs and one slow one: an average would have hidden it.
    await judge(t, { metric: "latency", subjectId: "run-1", durationMs: 10 }, h);
    await judge(t, { metric: "latency", subjectId: "run-2", durationMs: 10 }, h);
    await judge(t, { metric: "latency", subjectId: "run-3", durationMs: 10 }, h);
    await judge(t, { metric: "latency", subjectId: "run-4", durationMs: 10 }, h);
    await judge(
      t,
      { metric: "latency", subjectId: "run-5", durationMs: LATENCY_CEILING_MS + 1 },
      h,
    );

    const report = await reportOf(t, h);
    const latency = report.metrics.find((metric) => metric.metric === "latency");
    expect(latency?.measured).toBe(LATENCY_CEILING_MS + 1);
    expect(latency?.latency).toEqual({
      worstMs: LATENCY_CEILING_MS + 1,
      ceilingMs: LATENCY_CEILING_MS,
    });
    expect(latency?.status).toBe("unmet");
    expect(report.gate.satisfied).toBe(false);
  });

  it("records provenance and nothing a caller could have forged", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Provenance");
    await passAnalytics(t, ["met", "met", "met", "met", "met"], h);

    const trail = (await dataOf(
      h.listAgentEvaluationTrailHandler(request(t.token, analytics(t.workspaceId))),
    )) as GateTrail;
    expect(trail.runs).toHaveLength(1);
    expect(trail.runs[0]?.agentVersion).toBe("1.0.0");
    expect(trail.runs[0]?.runNumber).toBe(1);
    expect(trail.runs[0]?.live).toBe(true);
    expect(trail.runs[0]?.openedBy).toBe(t.userId);
    expect(trail.observations).toHaveLength(17);
    // Who judged what, against which agent version.
    expect(trail.observations.every((row) => row.recordedBy === t.userId)).toBe(true);
    expect(
      trail.observations
        .filter((row) => row.metric === "cost")
        .every((row) => row.amountMinor === 500 && row.verdict === null),
    ).toBe(true);

    // The trail is a total order over `(metric, subjectId)` — no generated id
    // tiebreak, and equal timestamps never reorder anything.
    const keys = trail.observations.map((row) => `${row.metric}|${row.subjectId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(trail.observations.map((row) => row.metric)).toEqual(
      [...trail.observations.map((row) => row.metric)].sort((a, b) => {
        const published = [
          "task_success",
          "accuracy",
          "relevance",
          "hallucination_rate",
          "tool_call_correctness",
          "qualification_accuracy",
          "personalization_quality",
          "response_classification_accuracy",
          "cost",
          "latency",
          "failure_rate",
          "human_override_rate",
          "business_outcome",
        ];
        return published.indexOf(a) - published.indexOf(b);
      }),
    );

    // Every stored row carries the session's identity, never a body's.
    const rows = defaultStore.db.agentEvaluationObservations.filter(
      (row) => row.workspaceId === t.workspaceId,
    );
    expect(rows.length).toBe(17);
    expect(rows.every((row) => row.createdBy === t.userId)).toBe(true);
    expect(rows.every((row) => typeof row.createdAt === "string")).toBe(true);
    // And no stored column holds a computed outcome.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
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

  it("appends rather than edits: a new round supersedes the old evidence", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Supersede");
    await passAnalytics(t, ["met", "met", "met", "met", "met"], h);
    expect((await reportOf(t, h)).gate.satisfied).toBe(true);
    const before = rowCounts(t.workspaceId);

    await openRound(t, h);
    const after = await reportOf(t, h);
    expect(after.run?.runNumber).toBe(2);
    expect(after.status).toBe("insufficient_evidence");
    expect(after.gate.satisfied).toBe(false);
    // Nothing was edited or deleted: the first round's seventeen rows survive.
    expect(rowCounts(t.workspaceId).observations).toBe(before.observations);
    const trail = (await dataOf(
      h.listAgentEvaluationTrailHandler(request(t.token, analytics(t.workspaceId))),
    )) as GateTrail;
    expect(trail.runs.map((run) => run.runNumber)).toEqual([2, 1]);
    expect(trail.runs.map((run) => run.live)).toEqual([true, false]);
    expect(trail.runs[1]?.observationCount).toBe(17);
  });

  it("refuses promotion with no evidence, and writes nothing at all", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate No Evidence");
    await approve(t, "analytics", h);
    const before = rowCounts(t.workspaceId);

    const error = await errorOf(
      h.changeAgentStatusHandler(
        request(t.token, analytics(t.workspaceId), { status: "production" }),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("evaluation evidence");
    expect(error.details?.[0]?.message).toContain("Phase 19");
    expect(rowCounts(t.workspaceId)).toEqual(before);

    const agent = (await dataOf(h.getAgentHandler(request(t.token, analytics(t.workspaceId))))) as {
      agent: GateAgent;
    };
    expect(agent.agent.status).toBe("approved");
  });

  it("refuses promotion on incomplete coverage, and on a failing metric", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Incomplete");
    await approve(t, "analytics", h);

    // Everything met, but two rate metrics are one judgement short and latency
    // was never measured: coverage is part of the gate, not a formality.
    await openRound(t, h);
    await judgeRates(t, ["met", "met", "met", "met", "unmet"], h);
    await judge(t, { metric: "cost", subjectId: "run-cost", amountMinor: 100 }, h);
    const incomplete = await reportOf(t, h);
    expect(incomplete.metrics.find((metric) => metric.metric === "latency")?.status).toBe(
      "insufficient_evidence",
    );

    const refused = await errorOf(
      h.changeAgentStatusHandler(
        request(t.token, analytics(t.workspaceId), { status: "production" }),
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("latency insufficient_evidence");
    expect(refused.message).toContain("accuracy unmet");

    const agent = (await dataOf(h.getAgentHandler(request(t.token, analytics(t.workspaceId))))) as {
      agent: GateAgent;
    };
    expect(agent.agent.status).toBe("approved");
  });

  it("permits approved → production on complete, passing evidence — and grants no capability", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Promotion");
    await approve(t, "analytics", h);
    await passAnalytics(t, ["met", "met", "met", "met", "met"], h);
    expect((await reportOf(t, h)).gate.satisfied).toBe(true);

    const promoted = (await dataOf(
      h.changeAgentStatusHandler(
        request(t.token, analytics(t.workspaceId), { status: "production" }),
      ),
    )) as { agent: GateAgent };
    expect(promoted.agent.status).toBe("production");
    expect(promoted.agent.updatedBy).toBe(t.userId);

    // The four states that matter are kept apart, and only the first two moved:
    // a production agent is **not** a usable one, because nothing in this
    // repository runs an agent.
    expect(promoted.agent.usable).toBe(false);
    const policy = (await dataOf(
      h.getAgentPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as { usableStates: string[] };
    expect(policy.usableStates).toEqual([]);
    expect([...MEETABLE_AGENT_STATES]).toEqual([]);

    // The transition is recorded as a governance decision, like every other.
    const events = (await dataOf(
      h.listAgentEventsHandler(
        request(t.token, { workspaceId: t.workspaceId }, undefined, {
          agentId: "analytics",
        }),
      ),
    )) as { events: { fromStatus: string | null; toStatus: string }[] };
    expect(
      events.events.some(
        (event) => event.fromStatus === "approved" && event.toStatus === "production",
      ),
    ).toBe(true);
  });

  it("refuses promotion on evidence recorded against another agent version", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Version");
    await approve(t, "analytics", h);
    await passAnalytics(t, ["met", "met", "met", "met", "met"], h);

    // A round pinned to a version no declaration can produce. The registry asks
    // storage for the declared version, so this is invisible to the report —
    // and an agent whose declared version has no round of its own still has no
    // evidence, which is checked below with a second agent.
    const stray = defaultStore.createAgentEvaluationRun({
      workspaceId: t.workspaceId,
      userId: t.userId,
      agentId: "analytics",
      version: "0.9.0",
    });
    if (!isOk(stray)) throw new Error("stray run failed");
    expect((await reportOf(t, h)).gate.satisfied).toBe(true);
    const trail = (await dataOf(
      h.listAgentEvaluationTrailHandler(request(t.token, analytics(t.workspaceId))),
    )) as GateTrail;
    // The trail shows every round, and only the declared version's is live.
    expect(trail.runs.map((run) => run.agentVersion).sort()).toEqual(["0.9.0", "1.0.0"]);
    expect(trail.runs.filter((run) => run.live).map((run) => run.agentVersion)).toEqual(["1.0.0"]);

    // A different agent with the same passing evidence shape has none of its
    // own: evidence is per (workspace, agent, version), never shared.
    const untouched = (await dataOf(
      h.getAgentEvaluationHandler(request(t.token, { workspaceId: t.workspaceId, agentId: "crm" })),
    )) as GateReport;
    expect(untouched.run).toBeNull();
    expect(untouched.status).toBe("insufficient_evidence");
    expect(untouched.gate.satisfied).toBe(false);
  });

  it("refuses promotion on another workspace's evidence, and keeps every read per tenant", async () => {
    const h: Handlers = createDefaultHandlers();
    const a = tenant("Gate Tenant A");
    const b = tenant("Gate Tenant B");
    await approve(b, "analytics", h);
    await passAnalytics(a, ["met", "met", "met", "met", "met"], h);

    // B is approved, A's evidence is perfect, and B still cannot promote.
    const refused = await errorOf(
      h.changeAgentStatusHandler(
        request(b.token, analytics(b.workspaceId), { status: "production" }),
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("evaluation evidence");
    expect(refused.message).toContain("insufficient_evidence");

    // A cannot read, write or trace B's evidence, and vice versa.
    expect(
      (await errorOf(h.getAgentEvaluationHandler(request(a.token, analytics(b.workspaceId))))).code,
    ).toBe("UNAUTHORIZED");
    expect(
      (
        await errorOf(
          h.recordAgentEvaluationHandler(
            request(a.token, analytics(b.workspaceId), {
              metric: "task_success",
              subjectId: "s-1",
              verdict: "met",
            }),
          ),
        )
      ).code,
    ).toBe("UNAUTHORIZED");
    expect(
      (await errorOf(h.listAgentEvaluationTrailHandler(request(a.token, analytics(b.workspaceId)))))
        .code,
    ).toBe("UNAUTHORIZED");
    // B's own report is complete and empty.
    expect((await reportOf(b, h)).run).toBeNull();
    // A forged workspace id that does not exist reads as missing.
    expect(
      (await errorOf(h.getAgentEvaluationHandler(request(a.token, analytics("ws-does-not-exist")))))
        .code,
    ).toBe("NOT_FOUND");
    // And an unauthenticated caller gets nothing.
    expect(
      (await errorOf(h.getAgentEvaluationHandler(request("", analytics(a.workspaceId))))).code,
    ).toBe("UNAUTHENTICATED");
  });

  it("lets a client contribute an observation and nothing else", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Forgery");
    await passAnalytics(t, ["met", "met", "met", "met", "met"], h);

    // A forged body on the read route produces a byte-identical response: none
    // of it — a status, a version, a gate, a workspace, an actor — is read.
    const clean = JSON.stringify(await reportOf(t, h));
    const forged = JSON.stringify(
      await dataOf(
        h.getAgentEvaluationHandler(
          request(t.token, analytics(t.workspaceId), {
            status: "production",
            agentVersion: "9.9.9",
            gate: { satisfied: true, reason: "trust me" },
            passed: true,
            rate: 10_000,
            workspaceId: "ws-somewhere-else",
            createdBy: "attacker",
            recordedAt: "1999-01-01T00:00:00.000Z",
            runNumber: 99,
          }),
        ),
      ),
    );
    expect(forged).toBe(clean);

    // A forged body on the write route cannot mark anything evaluated: it
    // contributes one judgement, and every field it invented is ignored.
    await judge(
      t,
      {
        metric: "task_success",
        subjectId: "forged",
        verdict: "met",
        agentVersion: "9.9.9",
        rate: 10_000,
        passed: true,
        status: "production",
        usable: true,
        workspaceId: "ws-somewhere-else",
        createdBy: "attacker",
        recordedAt: "1999-01-01T00:00:00.000Z",
        runNumber: 99,
        threshold: 0,
      },
      h,
    );
    const after = await reportOf(t, h);
    expect(after.agentVersion).toBe("1.0.0");
    expect(after.run?.runNumber).toBe(1);
    expect(after.metrics.find((metric) => metric.metric === "task_success")?.sampleSize).toBe(6);
    const rows = defaultStore.db.agentEvaluationObservations.filter(
      (row) => row.workspaceId === t.workspaceId && row.subjectId === "forged",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdBy).toBe(t.userId);
    expect(rows[0]?.createdAt).not.toBe("1999-01-01T00:00:00.000Z");

    // Shapes the metric does not take are refused by name.
    const wrongVerdict = await errorOf(
      h.recordAgentEvaluationHandler(
        request(t.token, analytics(t.workspaceId), {
          metric: "task_success",
          subjectId: "s-2",
          verdict: "passed",
        }),
      ),
    );
    expect(wrongVerdict.details?.[0]?.field).toBe("verdict");
    const bothShapes = await errorOf(
      h.recordAgentEvaluationHandler(
        request(t.token, analytics(t.workspaceId), {
          metric: "cost",
          subjectId: "s-3",
          amountMinor: 10,
          verdict: "met",
        }),
      ),
    );
    expect(bothShapes.message).toContain("measured, not judged");
    const unknownMetric = await errorOf(
      h.recordAgentEvaluationHandler(
        request(t.token, analytics(t.workspaceId), {
          metric: "vibes",
          subjectId: "s-4",
          verdict: "met",
        }),
      ),
    );
    expect(unknownMetric.details?.[0]?.field).toBe("metric");
    // A metric the agent does not declare is refused too: the gate would not
    // read it, so storing it would be storing a measurement nobody looks at.
    const undeclared = await errorOf(
      h.recordAgentEvaluationHandler(
        request(t.token, analytics(t.workspaceId), {
          metric: "hallucination_rate",
          subjectId: "s-5",
          verdict: "met",
        }),
      ),
    );
    expect(undeclared.message).toContain("does not declare");

    // And a judgement needs a round: there is nowhere to file it otherwise.
    const fresh = tenant("Gate No Round");
    const noRound = await errorOf(
      h.recordAgentEvaluationHandler(
        request(fresh.token, analytics(fresh.workspaceId), {
          metric: "task_success",
          subjectId: "s-1",
          verdict: "met",
        }),
      ),
    );
    expect(noRound.code).toBe("CONFLICT");
  });

  it("replays a judgement without adding a second vote, and conflicts on a restatement", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Replay");
    await openRound(t, h);
    const body = { metric: "task_success", subjectId: "s-1", verdict: "met" } as const;
    const first = (await judge(t, body, h)) as { observation: { id: string } };
    const replay = (await judge(t, body, h)) as { observation: { id: string } };
    expect(replay.observation.id).toBe(first.observation.id);
    expect(
      defaultStore.db.agentEvaluationObservations.filter(
        (row) => row.workspaceId === t.workspaceId,
      ),
    ).toHaveLength(1);

    const restated = await errorOf(
      h.recordAgentEvaluationHandler(
        request(t.token, analytics(t.workspaceId), {
          metric: "task_success",
          subjectId: "s-1",
          verdict: "unmet",
        }),
      ),
    );
    expect(restated.code).toBe("CONFLICT");
    // Judgements are append-only, so a changed mind opens a new round.
    await openRound(t, h);
    await judge(t, { metric: "task_success", subjectId: "s-1", verdict: "unmet" }, h);
    expect(
      defaultStore.db.agentEvaluationObservations.filter(
        (row) => row.workspaceId === t.workspaceId,
      ),
    ).toHaveLength(2);
  });

  it("measures agents and executes nothing: no trace, no runner, no other table touched", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Negative Space");
    await passAnalytics(t, ["met", "met", "met", "met", "met"], h);

    // ROADMAP.md §27 (Phase 20) owns run traces. This phase writes none: the
    // whole evaluation surface contains no execution, token or tool record.
    const trail = (await dataOf(
      h.listAgentEvaluationTrailHandler(request(t.token, analytics(t.workspaceId))),
    )) as GateTrail;
    const printed = JSON.stringify(trail).toLowerCase();
    for (const phaseTwentyOwns of ["trace", "token", "tool_call", "run_id", "retry", "approval"]) {
      expect(printed, phaseTwentyOwns).not.toContain(phaseTwentyOwns);
    }

    // Recording seventeen judgements, reading them back, and promoting an
    // agent touched the two evaluation tables and the registry — and nothing
    // else. No outbound action, no approval, no draft, no evidence record, no
    // meeting, no cost.
    await approve(t, "analytics", h);
    await dataOf(
      h.changeAgentStatusHandler(
        request(t.token, analytics(t.workspaceId), { status: "production" }),
      ),
    );
    const counts = rowCounts(t.workspaceId);
    expect(counts.observations).toBe(17);
    expect(counts.runs).toBe(1);
    expect(counts.registry).toBe(1);
    expect(counts.registryEvents).toBe(3);
    expect(counts.actions).toBe(0);
    expect(counts.approvals).toBe(0);
    expect(counts.drafts).toBe(0);
    expect(counts.evidence).toBe(0);
    expect(counts.meetings).toBe(0);
    expect(counts.costs).toBe(0);
    expect(counts.messages).toBe(0);
    expect(counts.classifications).toBe(0);

    // The twelve declared agents and seven states are untouched by the phase.
    expect(AGENT_IDS).toHaveLength(12);
    expect(AGENT_STATE_ORDER).toHaveLength(7);
    expect(defaultStore.db.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    // Every declared agent still reads as unevaluated, whatever this one did.
    const registry = (await dataOf(
      h.getAgentRegistryHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as { agents: GateAgent[] };
    expect(registry.agents).toHaveLength(12);
    expect(
      registry.agents.filter((entry) => entry.declaration.agentId !== "analytics"),
    ).toHaveLength(11);
    expect(
      registry.agents
        .filter((entry) => entry.declaration.agentId !== "analytics")
        .every((entry) => entry.status === "draft" && entry.usable === false),
    ).toBe(true);
  });
});
