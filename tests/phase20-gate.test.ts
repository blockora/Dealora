import { describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import {
  store as defaultStore,
  LATEST_SCHEMA_VERSION,
  SCHEMA,
  agentTraceEventTable,
  agentTraceRunTable,
} from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { signup } from "@dealora/auth";
import { AGENT_IDS, AGENT_TOOLS } from "@dealora/agent";
import {
  TRACE_STAGES,
  deriveTraceStatus,
  sortTraceEvents,
  stageOrder,
  type TraceEventView,
} from "@dealora/trace";

/**
 * Phase 20 gate — ROADMAP.md §27 (Agent Trace & Observability).
 *
 * §27 asks for two exposures and states one critical rule:
 *
 * 1. **every production workflow exposes** the chain
 *    Agent → Decision → Tool Call → Evidence → Result → Approval → External
 *    Action;
 * 2. **track** execution time, model usage, token usage, tool calls, errors,
 *    retries, approvals, external actions and cost;
 * 3. **critical rule:** never silently pretend an action succeeded.
 *
 * This gate drives the **real** API over the **real** store and checks that all
 * three hold, and — just as importantly — that nothing which merely *looks*
 * like execution has been smuggled in:
 *
 * - **The chain is the roadmap's, in the roadmap's order.** Seven stages, read
 *   back over the wire, each with a position that is also the sort key, and
 *   every stage has a tally even at zero.
 * - **All nine dimensions are tracked from real recorded facts.** Durations,
 *   models, tokens, tools, errors, retries, approvals, external actions and
 *   cost are each derived from stored rows and compared against exactly what
 *   the gate recorded — none is zero-filled, estimated or summarised away.
 * - **The critical rule is structural, not a convention.** No route can carry a
 *   status; a failed step makes the run failed; an unconfirmed external action
 *   makes it unknown; an empty trace closes `unverified`; a terminal run accepts
 *   nothing further; and a run that mostly succeeded still reads `failed`.
 * - **The production gate is Phase 19's and fails closed.** A run cannot be
 *   opened for an agent that has not cleared it, and the state found is named.
 * - **History is immutable and deterministically ordered.** Steps are ordered by
 *   a server-derived sequence, so two steps recorded in the same millisecond
 *   still have one defined order, and a retry is the next attempt rather than a
 *   rewrite.
 * - **Traces are isolated, pinned and honest.** Workspace isolation holds, the
 *   agent version is resolved server-side and cannot be forged, and a `tool_call`
 *   step may not cite a tool no declaration grants.
 * - **The negative space holds.** Tracing runs nothing: no runner, no dispatcher,
 *   no tool invoker, no model client, no queue and no network — proven by a
 *   snapshot showing the phase wrote only its own two tables.
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

interface Tenant {
  token: string;
  userId: string;
  workspaceId: string;
}

/** One recorded step, as the trail route reports it. */
interface GateStep {
  id: string;
  runId: string;
  sequence: number;
  stepId: string;
  attempt: number;
  stage: string;
  outcome: string;
  detail: string | null;
  tool: string | null;
  errorCode: string | null;
  durationMs: number | null;
  modelProvider: string | null;
  modelName: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  recordedBy: string;
  recordedAt: string;
}

interface GateStageCounts {
  stage: string;
  count: number;
  succeeded: number;
  failed: number;
  unknown: number;
  retried: number;
}

interface GateTrace {
  ruleVersion: string;
  id: string;
  agentId: string;
  agentVersion: string;
  status: string;
  derivedStatus: string;
  openedBy: string;
  openedAt: string;
  closedBy: string | null;
  closedAt: string | null;
  stepCount: number;
  stages: GateStageCounts[];
  usage: {
    slowestStepMs: number | null;
    slowestStepId: string | null;
    modelInvocations: number;
    inputTokens: number;
    outputTokens: number;
    models: { provider: string | null; model: string }[];
    toolsInvoked: string[];
    retryCount: number;
    errorCount: number;
    approvalsRequested: number;
    approvalsGranted: number;
    externalActions: number;
    externalActionsSucceeded: number;
  };
  cost: { currency: string | null; eventCount: number; totalMinor: number } | null;
}

interface GatePolicy {
  ruleVersion: string;
  stages: { stage: string; position: number; meaning: string }[];
  outcomes: string[];
  statuses: { status: string; terminal: boolean; meaning: string }[];
  tools: string[];
  tracked: { dimension: string; source: string }[];
  criticalRule: string;
  neverDoes: string[];
}

const oneAgent = (workspaceId: string, agentId = "analytics") => ({ workspaceId, agentId });
const oneRun = (workspaceId: string, runId: string) => ({ workspaceId, runId });

function tenant(name: string): Tenant {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const owner = signup(`${unique(slug)}@example.com`, "correct-horse-battery", name);
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq} ${process.pid}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

/** Open a traced run for `analytics` through the real route. */
async function openRun(t: Tenant, h?: Handlers) {
  const handlers = h ?? createDefaultHandlers();
  return (await dataOf(
    handlers.openAgentTraceRunHandler(request(t.token, oneAgent(t.workspaceId))),
  )) as {
    run: { id: string; agentId: string; agentVersion: string; status: string; stepCount: number };
  };
}

/** Record one step through the real route. */
async function step(
  t: Tenant,
  runId: string,
  body: Record<string, unknown>,
  h?: Handlers,
): Promise<GateStep> {
  const handlers = h ?? createDefaultHandlers();
  const recorded = (await dataOf(
    handlers.recordAgentTraceStepHandler(request(t.token, oneRun(t.workspaceId, runId), body)),
  )) as { step: GateStep };
  return recorded.step;
}

/** Read one whole trace through the real route. */
async function traceOf(t: Tenant, runId: string, h?: Handlers): Promise<GateTrace> {
  const handlers = h ?? createDefaultHandlers();
  return (await dataOf(
    handlers.getAgentTraceHandler(request(t.token, oneRun(t.workspaceId, runId))),
  )) as GateTrace;
}

/** Read one run's step trail through the real route. */
async function stepsOf(t: Tenant, runId: string, h?: Handlers): Promise<GateStep[]> {
  const handlers = h ?? createDefaultHandlers();
  const listed = (await dataOf(
    handlers.listAgentTraceStepsHandler(request(t.token, oneRun(t.workspaceId, runId))),
  )) as { steps: GateStep[] };
  return listed.steps;
}

/** Close a run through the real route. */
async function closeRun(t: Tenant, runId: string, h?: Handlers) {
  const handlers = h ?? createDefaultHandlers();
  return (await dataOf(
    handlers.closeAgentTraceRunHandler(request(t.token, oneRun(t.workspaceId, runId))),
  )) as { run: { id: string; status: string; closedBy: string; closedAt: string } };
}

/** Read the published policy through the real route. */
async function policyOf(t: Tenant, h?: Handlers): Promise<GatePolicy> {
  const handlers = h ?? createDefaultHandlers();
  return (await dataOf(
    handlers.getAgentTracePolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
  )) as GatePolicy;
}

/**
 * Walk `analytics` all the way to `production`, the only way this repository
 * allows: `draft → testing → approved`, then Phase 19's evaluation gate
 * satisfied by a real round of recorded judgements.
 *
 * A gate that opens its traces any other way would be testing a registry that
 * does not exist, so every trace test below goes through this.
 */
async function promote(t: Tenant, h?: Handlers): Promise<void> {
  const handlers = h ?? createDefaultHandlers();
  for (const status of ["testing", "approved"]) {
    await dataOf(
      handlers.changeAgentStatusHandler(
        request(t.token, oneAgent(t.workspaceId, "analytics"), { status }),
      ),
    );
  }
  await dataOf(
    handlers.openAgentEvaluationRunHandler(request(t.token, oneAgent(t.workspaceId, "analytics"))),
  );
  for (const metric of ["task_success", "accuracy", "relevance"]) {
    for (let index = 0; index < 5; index += 1) {
      await dataOf(
        handlers.recordAgentEvaluationHandler(
          request(t.token, oneAgent(t.workspaceId, "analytics"), {
            metric,
            subjectId: `${metric}-${index}`,
            verdict: "met",
          }),
        ),
      );
    }
  }
  for (const [metric, facts] of [
    ["cost", { amountMinor: 500 }],
    ["latency", { durationMs: 1_200 }],
  ] as const) {
    await dataOf(
      handlers.recordAgentEvaluationHandler(
        request(t.token, oneAgent(t.workspaceId, "analytics"), {
          metric,
          subjectId: `gate-${metric}`,
          ...facts,
        }),
      ),
    );
  }
  // Only now does Phase 19's gate actually grant `production`. Nothing in a
  // request can assert it, so a trace test that skipped this line would be
  // testing a registry this repository does not have.
  await dataOf(
    handlers.changeAgentStatusHandler(
      request(t.token, oneAgent(t.workspaceId, "analytics"), { status: "production" }),
    ),
  );
}

/**
 * A snapshot of every table the trace surface could conceivably touch.
 *
 * Scoped to one workspace: the gate file shares the process-wide store with
 * every other tenant it creates, so an unscoped count would measure the file.
 */
function rowCounts(workspaceId: string): Record<string, number> {
  const db = defaultStore.db;
  const mine = (rows?: readonly { workspaceId: string }[]): number =>
    rows === undefined ? 0 : rows.filter((row) => row.workspaceId === workspaceId).length;
  return {
    traceRuns: mine(db.agentTraceRuns),
    traceEvents: mine(db.agentTraceEvents),
    evaluationRuns: mine(db.agentEvaluationRuns),
    observations: mine(db.agentEvaluationObservations),
    registry: mine(db.agentRegistry),
    registryEvents: mine(db.agentRegistryEvents),
    drafts: mine(db.personalizedDrafts),
    approvals: mine(db.approvalRequests),
    approvalEvents: mine(db.approvalRequestEvents),
    actions: mine(db.outboundActions),
    outboundEvents: mine(db.outboundEvents),
    suppressions: mine(db.outboundSuppressions),
    messages: mine(db.inboundMessages),
    classifications: mine(db.conversationClassifications),
    meetings: mine(db.meetings),
    evidence: mine(db.evidence),
    claims: mine(db.accountClaims),
    research: mine(db.researchFindings),
    qualifications: mine(db.qualifications),
    costs: mine(db.costEvents),
    recommendations: mine(db.nextBestActions),
  };
}

describe("Phase 20 gate — Agent Trace & Observability (ROADMAP.md §27)", () => {
  it("exposes ROADMAP.md §27's chain: seven stages, in the roadmap's own order", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Chain");
    const policy = await policyOf(t, h);

    // §27's chain, read back over the wire, in §27's order.
    expect(policy.stages.map((entry) => entry.stage)).toEqual([
      "agent",
      "decision",
      "tool_call",
      "evidence",
      "result",
      "approval",
      "external_action",
    ]);
    expect(policy.ruleVersion).toBe("trace-1.0.0");

    // Position is the sort key and matches the declared order exactly, so
    // "ordered by stage" never has to mean anything.
    expect(policy.stages.map((entry) => entry.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const entry of policy.stages) {
      expect(stageOrder(entry.stage), entry.stage).toBe(entry.position);
      expect(TRACE_STAGES.find((stage) => stage.stage === entry.stage)).toBeDefined();
      expect(entry.meaning.length, entry.stage).toBeGreaterThan(20);
    }

    // Only a `tool_call` step may name a tool, and it may only name one of the
    // eighteen tools `ROADMAP.md` §25 already declares.
    expect(AGENT_TOOLS).toHaveLength(18);
    expect(policy.tools).toEqual(AGENT_TOOLS.map((tool) => tool.tool));
    const toolStages = policy.stages.filter((entry) => entry.stage === "tool_call");
    expect(toolStages).toHaveLength(1);

    // Every stage has a tally even at zero, so "no approval was ever
    // requested" is distinguishable from "this trace cannot say".
    await promote(t, h);
    const { run } = await openRun(t, h);
    const trace = await traceOf(t, run.id, h);
    expect(trace.stages.map((entry) => entry.stage)).toEqual([
      "agent",
      "decision",
      "tool_call",
      "evidence",
      "result",
      "approval",
      "external_action",
    ]);
    expect(trace.stages.every((entry) => entry.count === 0)).toBe(true);
  });

  it("tracks all nine dimensions ROADMAP.md §27 names, each from real recorded facts", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Dimensions");
    const policy = await policyOf(t, h);

    // §27's nine, published with the fact each is derived from, so a dimension
    // that could not be tracked would have to be removed rather than go quiet.
    expect(policy.tracked.map((entry) => entry.dimension)).toEqual([
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
    for (const dimension of policy.tracked) {
      expect(dimension.source.length, dimension.dimension).toBeGreaterThan(20);
    }

    await promote(t, h);
    const { run } = await openRun(t, h);

    // One step per stage, plus a retry of the tool call and an unconfirmed
    // external action, so every dimension has something real behind it.
    await step(
      t,
      run.id,
      { stepId: "s-agent", stage: "agent", outcome: "succeeded", durationMs: 40 },
      h,
    );
    await step(
      t,
      run.id,
      { stepId: "s-decision", stage: "decision", outcome: "succeeded", durationMs: 10 },
      h,
    );
    await step(
      t,
      run.id,
      {
        stepId: "s-tool",
        stage: "tool_call",
        outcome: "failed",
        tool: "request_research",
        errorCode: "provider_timeout",
        durationMs: 900,
      },
      h,
    );
    // The retry: same stepId, a different outcome, so it becomes attempt 2
    // rather than overwriting the failure.
    await step(
      t,
      run.id,
      {
        stepId: "s-tool",
        stage: "tool_call",
        outcome: "succeeded",
        tool: "request_research",
        durationMs: 250,
        modelProvider: "openai",
        modelName: "gpt-4o-mini",
        inputTokens: 1200,
        outputTokens: 340,
      },
      h,
    );
    await step(
      t,
      run.id,
      { stepId: "s-evidence", stage: "evidence", outcome: "succeeded", referenceId: "ev-1" },
      h,
    );
    await step(t, run.id, { stepId: "s-result", stage: "result", outcome: "succeeded" }, h);
    await step(t, run.id, { stepId: "s-approval", stage: "approval", outcome: "succeeded" }, h);
    // Nobody confirmed this one. It is recorded `unknown` because that is what
    // was actually known, and the run inherits that.
    await step(t, run.id, { stepId: "s-action", stage: "external_action", outcome: "unknown" }, h);

    const trace = await traceOf(t, run.id, h);
    const usage = trace.usage;

    // execution time — the slowest step, a maximum and never a sum, because
    // steps in one run may overlap.
    expect(usage.slowestStepMs).toBe(900);
    expect(usage.slowestStepId).toBe("s-tool");
    // model usage + token usage — reported usage copied from the recorder,
    // never estimated, and summed exactly.
    expect(usage.modelInvocations).toBe(1);
    expect(usage.models).toEqual([{ provider: "openai", model: "gpt-4o-mini" }]);
    expect(usage.inputTokens).toBe(1200);
    expect(usage.outputTokens).toBe(340);
    // tool calls — distinct tools, in the published order.
    expect(usage.toolsInvoked).toEqual(["request_research"]);
    // errors — counted, not summarised away.
    expect(usage.errorCount).toBe(1);
    // retries — derived from storage's attempt numbers, never sent by a caller.
    expect(usage.retryCount).toBe(1);
    // approvals.
    expect(usage.approvalsRequested).toBe(1);
    expect(usage.approvalsGranted).toBe(1);
    // external actions, counted apart from successes.
    expect(usage.externalActions).toBe(1);
    expect(usage.externalActionsSucceeded).toBe(0);

    // Every stage tally agrees with what was recorded.
    const tally = (stage: string) => trace.stages.find((entry) => entry.stage === stage);
    expect(tally("tool_call")).toMatchObject({ count: 2, succeeded: 1, failed: 1, retried: 1 });
    expect(tally("agent")).toMatchObject({ count: 1, succeeded: 1 });
    expect(tally("external_action")).toMatchObject({ count: 1, unknown: 1 });
    expect(tally("decision")).toMatchObject({ count: 1, succeeded: 1 });
    expect(tally("evidence")).toMatchObject({ count: 1, succeeded: 1 });
    expect(tally("result")).toMatchObject({ count: 1, succeeded: 1 });
    expect(tally("approval")).toMatchObject({ count: 1, succeeded: 1 });
    expect(trace.stepCount).toBe(8);

    // cost — Phase 16's own facts under the `agent_run` execution kind, and
    // `null` before any exist rather than a fabricated zero.
    expect(trace.cost).toBeNull();
    const recorded = defaultStore.createCostEvent({
      workspaceId: t.workspaceId,
      createdBy: t.userId,
      event: {
        executionKind: "agent_run",
        executionId: run.id,
        category: "llm",
        basis: "measured",
        amountMinor: 250,
        currency: "USD",
        source: null,
        occurredAt: new Date().toISOString(),
        idempotencyKey: unique("phase20-gate-cost"),
      },
    });
    expect(isOk(recorded)).toBe(true);
    const withCost = await traceOf(t, run.id, h);
    expect(withCost.cost).toMatchObject({ currency: "USD", eventCount: 1, totalMinor: 250 });
  });

  it("never silently pretends an action succeeded: no route can carry a status", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Critical Rule");
    await promote(t, h);

    // The close route reads no body at all. A caller may send a status, a
    // success flag, a derived status, a completion time and an actor; all of
    // it is ignored because the route carries a run id and nothing else.
    const { run } = await openRun(t, h);
    await step(t, run.id, { stepId: "s-agent", stage: "agent", outcome: "succeeded" }, h);
    const forged = await closeRun(t, run.id, h);
    expect(forged.run.status).toBe("succeeded");
    expect(forged.run.closedBy).toBe(t.userId);

    // Every forged field, sent together on both routes, changes nothing.
    const other = tenant("Gate Forged Fields");
    await promote(other, h);
    const opened = (await dataOf(
      h.openAgentTraceRunHandler(
        request(other.token, oneAgent(other.workspaceId, "analytics"), {
          id: "run-forged",
          agentId: "account_research",
          agentVersion: "9.9.9",
          version: "9.9.9",
          status: "succeeded",
          workspaceId: "forged-workspace",
          actorUserId: "forged-actor",
          openedAt: "1999-01-01T00:00:00.000Z",
          startedAt: "1999-01-01T00:00:00.000Z",
          sequence: 99,
        }),
      ),
    )) as { run: { id: string; agentId: string; agentVersion: string; status: string } };
    expect(opened.run.agentId).toBe("analytics");
    expect(opened.run.agentVersion).toBe("1.0.0");
    expect(opened.run.status).toBe("open");
    expect(opened.run.id).not.toBe("run-forged");

    await step(
      other,
      opened.run.id,
      {
        stepId: "forged",
        stage: "result",
        outcome: "succeeded",
        id: "forged-step",
        sequence: 42,
        attempt: 7,
        runId: "forged-run",
        workspaceId: "forged-workspace",
        recordedBy: "forged-actor",
        recordedAt: "1999-01-01T00:00:00.000Z",
        status: "succeeded",
      },
      h,
    );
    const forgedTrail = await stepsOf(other, opened.run.id, h);
    expect(forgedTrail).toHaveLength(1);
    expect(forgedTrail[0]).toMatchObject({
      sequence: 1,
      attempt: 1,
      runId: opened.run.id,
      recordedBy: other.userId,
    });
    expect(forgedTrail[0]?.id).not.toBe("forged-step");
    expect(forgedTrail[0]?.recordedAt).not.toBe("1999-01-01T00:00:00.000Z");
    // The step is owned by the workspace that recorded it, not the one the
    // body named. The event view is tenant-scoped and never prints a
    // workspace id, so ownership is read from the stored row.
    const storedForged = defaultStore.db.agentTraceEvents.find(
      (row) => row.id === forgedTrail[0]?.id,
    );
    expect(storedForged?.workspaceId).toBe(other.workspaceId);
    expect(storedForged?.workspaceId).not.toBe("forged-workspace");

    // The rule itself, published rather than merely obeyed.
    const policy = await policyOf(t, h);
    expect(policy.criticalRule).toContain("never silently pretend an action succeeded");
    expect(policy.criticalRule).toContain("unverified");
  });

  it("reads the outcome off the steps: failed, unknown and unverified cannot become succeeded", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Derived Status");
    await promote(t, h);

    // A run that mostly worked and then broke is never reported as succeeded.
    const mostly = (await openRun(t, h)).run;
    await step(t, mostly.id, { stepId: "a", stage: "agent", outcome: "succeeded" }, h);
    await step(t, mostly.id, { stepId: "b", stage: "result", outcome: "succeeded" }, h);
    await step(
      t,
      mostly.id,
      {
        stepId: "c",
        stage: "tool_call",
        outcome: "failed",
        tool: "book_meeting",
        errorCode: "denied",
      },
      h,
    );
    await step(t, mostly.id, { stepId: "d", stage: "result", outcome: "succeeded" }, h);
    expect((await closeRun(t, mostly.id, h)).run.status).toBe("failed");

    // Nothing failed, but something was left open, so success is unavailable.
    const openQuestion = (await openRun(t, h)).run;
    await step(
      t,
      openQuestion.id,
      { stepId: "a", stage: "external_action", outcome: "unknown" },
      h,
    );
    await step(t, openQuestion.id, { stepId: "b", stage: "result", outcome: "succeeded" }, h);
    expect((await closeRun(t, openQuestion.id, h)).run.status).toBe("unknown");

    // Closing a run that recorded no outcome at all is `unverified`. This is
    // the structural half of the critical rule: an empty trace cannot produce
    // a success no matter what a caller asks for.
    const empty = (await openRun(t, h)).run;
    expect((await traceOf(t, empty.id, h)).status).toBe("open");
    const closedEmpty = await closeRun(t, empty.id, h);
    expect(closedEmpty.run.status).toBe("unverified");
    const emptySteps = await stepsOf(t, empty.id, h);
    expect(emptySteps).toEqual([]);

    // The derivation agrees with what storage wrote, and the run's own trail
    // still reads as empty rather than as a success.
    const reloaded = await traceOf(t, empty.id, h);
    expect(reloaded.status).toBe("unverified");
    expect(reloaded.derivedStatus).toBe("unverified");
    expect(reloaded.stepCount).toBe(0);
    expect(reloaded.closedAt).not.toBeNull();
    expect(reloaded.closedBy).toBe(t.userId);

    // The pure derivation, exercised directly on the same four inputs.
    expect(deriveTraceStatus(["failed", "succeeded"])).toBe("failed");
    expect(deriveTraceStatus(["unknown", "succeeded"])).toBe("unknown");
    expect(deriveTraceStatus(["succeeded"])).toBe("succeeded");
    expect(deriveTraceStatus([])).toBe("unverified");
  });

  it("is terminal once closed and append-only forever: no edit, no delete, no late step", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Immutable");
    await promote(t, h);
    const { run } = await openRun(t, h);
    await step(t, run.id, { stepId: "a", stage: "agent", outcome: "succeeded" }, h);
    const beforeClose = await stepsOf(t, run.id, h);
    expect(beforeClose).toHaveLength(1);

    await closeRun(t, run.id, h);
    const afterClose = await stepsOf(t, run.id, h);
    expect(afterClose).toHaveLength(1);

    // A terminal run accepts nothing further, and closing it twice does not
    // rewrite the verdict it already reached.
    for (const body of [
      { stepId: "late", stage: "result", outcome: "succeeded" },
      { stepId: "a", stage: "result", outcome: "failed", errorCode: "too_late" },
    ]) {
      const refused = await errorOf(
        h.recordAgentTraceStepHandler(request(t.token, oneRun(t.workspaceId, run.id), body)),
      );
      expect(refused.code).toBe("CONFLICT");
    }
    const reclosed = await closeRun(t, run.id, h);
    expect(reclosed.run.status).toBe("succeeded");
    expect(reclosed.run.closedAt).toBe(afterClose[0] && (await traceOf(t, run.id, h)).closedAt);

    // The rows are byte-identical after every refusal.
    const finalSteps = await stepsOf(t, run.id, h);
    expect(finalSteps).toEqual(beforeClose);
    expect(finalSteps[0]).toMatchObject({ sequence: 1, attempt: 1, outcome: "succeeded" });
    // Exactly one run and one step row exist for this workspace's trace work.
    const stored = defaultStore.db.agentTraceEvents.filter(
      (row) => row.workspaceId === t.workspaceId,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(beforeClose[0]?.id);
  });

  it("orders steps by a server-derived sequence, so the same millisecond still has one order", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Ordering");
    await promote(t, h);
    const { run } = await openRun(t, h);

    // Seven steps recorded back to back. They will very often share a
    // millisecond; the sequence is what makes the order total either way.
    const stages = [
      "agent",
      "decision",
      "tool_call",
      "evidence",
      "result",
      "approval",
      "external_action",
    ];
    for (const [index, stage] of stages.entries()) {
      await step(
        t,
        run.id,
        {
          stepId: `ordered-${index}`,
          stage,
          outcome: "succeeded",
          ...(stage === "tool_call" ? { tool: "read_evidence" } : {}),
        },
        h,
      );
    }
    const trail = await stepsOf(t, run.id, h);
    expect(trail.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(trail.map((row) => row.stepId)).toEqual([
      "ordered-0",
      "ordered-1",
      "ordered-2",
      "ordered-3",
      "ordered-4",
      "ordered-5",
      "ordered-6",
    ]);
    // Sequence is strictly increasing and never repeated within a run, and it
    // is what the trail is ordered by — not `recordedAt`.
    for (const [index, row] of trail.entries()) {
      expect(row.sequence).toBe(index + 1);
    }

    // The same rows always print the same order, even when every timestamp is
    // identical — which is exactly the collision a timestamp sort cannot
    // resolve and a sequence can.
    const stepRow = (stepId: string, sequence: number): TraceEventView => ({
      id: `row-${stepId}`,
      runId: run.id,
      sequence,
      stepId,
      attempt: 1,
      stage: "result",
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
      recordedBy: t.userId,
      recordedAt: "2024-01-01T00:00:00.000Z",
    });
    const colliding: readonly TraceEventView[] = [
      stepRow("a", 4),
      stepRow("b", 3),
      stepRow("c", 2),
      stepRow("d", 1),
    ];
    expect(sortTraceEvents(colliding).map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
    // Reversed input yields the identical order, so ordering is a function of
    // stored rows alone.
    expect(sortTraceEvents([...colliding].reverse()).map((row) => row.sequence)).toEqual([
      1, 2, 3, 4,
    ]);

    // A replay of an identical step returns the original row rather than
    // appending a second one, while a different outcome is a retry.
    const replayed = await step(
      t,
      run.id,
      { stepId: "ordered-2", stage: "tool_call", outcome: "succeeded", tool: "read_evidence" },
      h,
    );
    expect(replayed.id).toBe(trail[2]?.id);
    expect(replayed.sequence).toBe(3);
    const retried = await step(
      t,
      run.id,
      {
        stepId: "ordered-2",
        stage: "tool_call",
        outcome: "failed",
        tool: "read_evidence",
        errorCode: "later",
      },
      h,
    );
    expect(retried.attempt).toBe(2);
    expect(retried.sequence).toBe(8);
    // The earlier attempt is untouched: a retry adds, it never rewrites.
    const finalTrail = await stepsOf(t, run.id, h);
    expect(finalTrail.find((row) => row.sequence === 3)).toMatchObject({
      attempt: 1,
      outcome: "succeeded",
    });
    expect(finalTrail.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("fails closed on the Phase 19 production gate and names the state it found", async () => {
    const h: Handlers = createDefaultHandlers();
    const draft = tenant("Gate Gate Draft");
    const refused = await errorOf(
      h.openAgentTraceRunHandler(request(draft.token, oneAgent(draft.workspaceId, "analytics"))),
    );
    expect(refused.code).toBe("CONFLICT");
    // The refusal names the state the registry actually holds and the phase
    // that owns reaching `production`, and writes nothing.
    expect(refused.message).toContain("no registry row");
    expect(refused.details?.[0]?.message).toContain("Phase 19");
    expect(rowCounts(draft.workspaceId).traceRuns).toBe(0);

    // `approved` is still not enough: Phase 19's evaluation gate has not been
    // satisfied, so the gate is not bypassed by a client's assertion.
    const approved = tenant("Gate Gate Approved");
    for (const status of ["testing", "approved"]) {
      await dataOf(
        h.changeAgentStatusHandler(
          request(approved.token, oneAgent(approved.workspaceId, "analytics"), { status }),
        ),
      );
    }
    const stillRefused = await errorOf(
      h.openAgentTraceRunHandler(
        request(approved.token, oneAgent(approved.workspaceId, "analytics")),
      ),
    );
    expect(stillRefused.code).toBe("CONFLICT");
    expect(stillRefused.message).toContain("approved");
    expect(rowCounts(approved.workspaceId).traceRuns).toBe(0);

    // A body that claims production does not help.
    const claimed = tenant("Gate Gate Claimed");
    const claimError = await errorOf(
      h.openAgentTraceRunHandler(
        request(claimed.token, oneAgent(claimed.workspaceId, "analytics"), {
          status: "production",
        }),
      ),
    );
    expect(claimError.code).toBe("CONFLICT");

    // Only after the real gate is satisfied does a run open.
    const ready = tenant("Gate Gate Ready");
    await promote(ready, h);
    const opened = await openRun(ready, h);
    expect(opened.run.status).toBe("open");

    // A client cannot name an agent outside the twelve declared agents.
    const unknownAgent = await errorOf(
      h.openAgentTraceRunHandler(request(ready.token, oneAgent(ready.workspaceId, "sales_team"))),
    );
    expect(unknownAgent.code).toBe("VALIDATION_ERROR");
  });

  it("isolates workspaces and pins the agent version server-side", async () => {
    const h: Handlers = createDefaultHandlers();
    const mine = tenant("Gate Tenant Mine");
    const theirs = tenant("Gate Tenant Theirs");
    await promote(mine, h);
    await promote(theirs, h);
    const { run } = await openRun(mine, h);
    await step(mine, run.id, { stepId: "a", stage: "agent", outcome: "succeeded" }, h);

    // The same workspace may read its own run.
    expect((await traceOf(mine, run.id, h)).id).toBe(run.id);

    // Another workspace's run is invisible to every route, not merely refused
    // on write, and the error is the ordinary `NOT_FOUND`.
    for (const call of [
      h.getAgentTraceHandler(request(theirs.token, oneRun(theirs.workspaceId, run.id))),
      h.listAgentTraceStepsHandler(request(theirs.token, oneRun(theirs.workspaceId, run.id))),
      h.recordAgentTraceStepHandler(
        request(theirs.token, oneRun(theirs.workspaceId, run.id), {
          stepId: "intruder",
          stage: "result",
          outcome: "succeeded",
        }),
      ),
      h.closeAgentTraceRunHandler(request(theirs.token, oneRun(theirs.workspaceId, run.id))),
    ]) {
      const error = await errorOf(call);
      expect(error.code).toBe("NOT_FOUND");
    }
    // Their workspace's run listing shows nothing of mine.
    const theirRuns = (await dataOf(
      h.listAgentTraceRunsHandler(request(theirs.token, { workspaceId: theirs.workspaceId })),
    )) as { runs: unknown[] };
    expect(theirRuns.runs).toEqual([]);

    // A workspace that has traced nothing gets an empty list, not a failure.
    const virgin = tenant("Gate Tenant Virgin");
    const virginRuns = (await dataOf(
      h.listAgentTraceRunsHandler(request(virgin.token, { workspaceId: virgin.workspaceId })),
    )) as { runs: unknown[] };
    expect(virginRuns.runs).toEqual([]);

    // An unknown run in my own workspace is `NOT_FOUND` too.
    const unknown = await errorOf(
      h.getAgentTraceHandler(request(mine.token, oneRun(mine.workspaceId, "run-does-not-exist"))),
    );
    expect(unknown.code).toBe("NOT_FOUND");

    // Version pinning: the version is read from the registry, not the request,
    // and stays pinned for the life of the run.
    const trace = await traceOf(mine, run.id, h);
    expect(trace.agentVersion).toBe("1.0.0");
    expect(trace.agentId).toBe("analytics");
    expect(trace.openedBy).toBe(mine.userId);

    // An unauthenticated caller reaches nothing on any route.
    for (const call of [
      h.openAgentTraceRunHandler(request("", oneAgent(mine.workspaceId))),
      h.getAgentTraceHandler(request("", oneRun(mine.workspaceId, run.id))),
      h.listAgentTraceStepsHandler(request("", oneRun(mine.workspaceId, run.id))),
      h.closeAgentTraceRunHandler(request("", oneRun(mine.workspaceId, run.id))),
      h.listAgentTraceRunsHandler(request("", { workspaceId: mine.workspaceId })),
      h.getAgentTracePolicyHandler(request("", { workspaceId: mine.workspaceId })),
      h.recordAgentTraceStepHandler(
        request("", oneRun(mine.workspaceId, run.id), {
          stepId: "nope",
          stage: "result",
          outcome: "succeeded",
        }),
      ),
    ]) {
      const error = await errorOf(call);
      expect(error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("validates the recorded vocabulary rather than storing whatever it is sent", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Vocabulary");
    await promote(t, h);
    const { run } = await openRun(t, h);

    // A stage outside the seven, an outcome outside the three, and a tool no
    // agent may use are all refused and write nothing.
    const badStage = await errorOf(
      h.recordAgentTraceStepHandler(
        request(t.token, oneRun(t.workspaceId, run.id), {
          stepId: "s",
          stage: "deployment",
          outcome: "succeeded",
        }),
      ),
    );
    expect(badStage.code).toBe("VALIDATION_ERROR");
    expect(badStage.details?.[0]?.field).toBe("stage");

    const badOutcome = await errorOf(
      h.recordAgentTraceStepHandler(
        request(t.token, oneRun(t.workspaceId, run.id), {
          stepId: "s",
          stage: "result",
          outcome: "probably_fine",
        }),
      ),
    );
    expect(badOutcome.code).toBe("VALIDATION_ERROR");
    expect(badOutcome.details?.[0]?.field).toBe("outcome");

    const badTool = await errorOf(
      h.recordAgentTraceStepHandler(
        request(t.token, oneRun(t.workspaceId, run.id), {
          stepId: "s",
          stage: "tool_call",
          outcome: "succeeded",
          tool: "delete_everything",
        }),
      ),
    );
    expect(badTool.code).toBe("VALIDATION_ERROR");
    expect(badTool.details?.[0]?.field).toBe("tool");

    // An `errorCode` only means something on a failure, and a tool name only
    // on a `tool_call`.
    const errorOnSuccess = await errorOf(
      h.recordAgentTraceStepHandler(
        request(t.token, oneRun(t.workspaceId, run.id), {
          stepId: "s",
          stage: "result",
          outcome: "succeeded",
          errorCode: "nope",
        }),
      ),
    );
    expect(errorOnSuccess.code).toBe("VALIDATION_ERROR");

    const toolOnResult = await errorOf(
      h.recordAgentTraceStepHandler(
        request(t.token, oneRun(t.workspaceId, run.id), {
          stepId: "s",
          stage: "result",
          outcome: "succeeded",
          tool: "send_message",
        }),
      ),
    );
    expect(toolOnResult.code).toBe("VALIDATION_ERROR");

    // Negative durations and token counts are refused rather than stored.
    for (const body of [
      { stepId: "s", stage: "result", outcome: "succeeded", durationMs: -1 },
      { stepId: "s", stage: "result", outcome: "succeeded", inputTokens: -5 },
    ]) {
      const negative = await errorOf(
        h.recordAgentTraceStepHandler(request(t.token, oneRun(t.workspaceId, run.id), body)),
      );
      expect(negative.code).toBe("VALIDATION_ERROR");
    }

    // Not one refused request wrote a row.
    expect(await stepsOf(t, run.id, h)).toEqual([]);
    expect(rowCounts(t.workspaceId).traceEvents).toBe(0);
  });

  it("persists the trace in schema v18 behind foreign keys and CHECK constraints", async () => {
    expect(defaultStore.db.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    // Phase 22 appended v19 additively; this gate's pin is the version the
    // trace tables landed at, updated when the next migration was added.
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);

    // The two tables exist in the published schema, with the invariants the
    // domain relies on stated in the DDL rather than only in TypeScript.
    const ddl = SCHEMA;
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "${agentTraceRunTable}"`);
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "${agentTraceEventTable}"`);

    const runStart = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${agentTraceRunTable}"`);
    const eventStart = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${agentTraceEventTable}"`);
    const runDdl = ddl.slice(runStart, eventStart);
    const eventDdl = ddl.slice(eventStart);
    // Each slice stops where the next table begins, so an invariant asserted
    // against one table cannot be satisfied by the other's DDL.
    expect(runDdl).not.toContain(agentTraceEventTable);

    // Tenant and ownership are real foreign keys, and a step cannot outlive
    // its run.
    expect(runDdl).toContain('REFERENCES "workspaces"("id") ON DELETE CASCADE');
    expect(eventDdl).toContain('REFERENCES "workspaces"("id") ON DELETE CASCADE');
    expect(eventDdl).toContain(`REFERENCES "${agentTraceRunTable}"("id") ON DELETE CASCADE`);
    // The vocabularies are constrained in storage, so an unvalidated write is
    // impossible rather than merely discouraged. The stage vocabulary belongs
    // to the event table; the run table constrains agent and status.
    expect(eventDdl).toContain(
      "'agent','decision','tool_call','evidence','result','approval','external_action'",
    );
    expect(runDdl).toContain(
      "'strategy','market_intelligence','account_research','prospect_discovery','qualification','personalization','conversation','follow_up','meeting','crm','analytics','optimization'",
    );
    expect(eventDdl).toContain(`"outcome" IN ('succeeded','failed','unknown')`);
    expect(runDdl).toContain(`"status" IN ('open','succeeded','failed','unknown','unverified')`);
    // Sequence and attempt are positive, and the version is pinned by shape.
    expect(eventDdl).toContain(`"sequence" > 0`);
    expect(eventDdl).toContain(`"attempt" > 0`);
    expect(runDdl).toContain(`"version" ~ '^\\d+\\.\\d+\\.\\d+$'`);
    // Concurrency: one sequence number per run, one attempt per step id.
    expect(eventDdl).toContain(
      'UNIQUE("agent_trace_events"."run_id", "agent_trace_events"."sequence")',
    );
    expect(eventDdl).toContain(
      'UNIQUE("agent_trace_events"."run_id", "agent_trace_events"."step_id", "agent_trace_events"."attempt")',
    );
    // An open run has no closing fields and a closed one has both, so the two
    // halves cannot disagree in storage.
    expect(runDdl).toContain(`"closed_at" IS NULL`);
    expect(runDdl).toContain(`"closed_at" IS NOT NULL`);
    // A tool name only on a `tool_call`, and an error code only on a failure.
    expect(eventDdl).toContain(`"tool" IS NULL OR "agent_trace_events"."stage" = 'tool_call'`);
    expect(eventDdl).toContain(`"error_code" IS NULL OR "agent_trace_events"."outcome" = 'failed'`);

    // Migration is additive and contiguous: an older state gains only the two
    // tables, and a current state is left alone.
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Schema");
    await promote(t, h);
    const { run } = await openRun(t, h);
    await step(t, run.id, { stepId: "a", stage: "agent", outcome: "succeeded" }, h);
    expect(
      defaultStore.db.agentTraceRuns.filter((row) => row.workspaceId === t.workspaceId),
    ).toHaveLength(1);
    expect(
      defaultStore.db.agentTraceEvents.filter((row) => row.workspaceId === t.workspaceId),
    ).toHaveLength(1);

    // Cost linkage is Phase 16's table under a widened vocabulary, never a
    // second cost table.
    const costTables = Object.keys(defaultStore.db).filter((key) => /cost/i.test(key));
    expect(costTables).toEqual(["costEvents"]);
  });

  it("traces a run and executes nothing: no runner, no tool call, no other table touched", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Negative Space");
    await promote(t, h);

    // The baseline is Phase 19's output plus the registry, captured before the
    // trace exists, so the comparison measures this phase and not the fixture.
    const before = rowCounts(t.workspaceId);
    expect(before.traceRuns).toBe(0);
    expect(before.traceEvents).toBe(0);

    const { run } = await openRun(t, h);
    // Record a `tool_call` step. This names a capability some other phase owns
    // and performs nothing: it writes no approval, no draft, no outbound
    // action and no message.
    await step(
      t,
      run.id,
      {
        stepId: "tool",
        stage: "tool_call",
        outcome: "succeeded",
        tool: "send_message",
        durationMs: 5,
      },
      h,
    );
    await step(t, run.id, { stepId: "result", stage: "result", outcome: "succeeded" }, h);
    await step(t, run.id, { stepId: "approval", stage: "approval", outcome: "succeeded" }, h);
    await step(t, run.id, { stepId: "action", stage: "external_action", outcome: "succeeded" }, h);
    await closeRun(t, run.id, h);

    const after = rowCounts(t.workspaceId);
    // Exactly one run and four steps were written, and nothing else moved.
    expect(after.traceRuns).toBe(before.traceRuns + 1);
    expect(after.traceEvents).toBe(before.traceEvents + 4);
    for (const table of Object.keys(before)) {
      if (table === "traceRuns" || table === "traceEvents") continue;
      expect(after[table], table).toBe(before[table]);
    }
    // In particular: tracing an external action sent nothing, approved nothing
    // and booked nothing, because those phases still own those writes.
    expect(after.actions).toBe(0);
    expect(after.outboundEvents).toBe(0);
    expect(after.approvals).toBe(0);
    expect(after.approvalEvents).toBe(0);
    expect(after.drafts).toBe(0);
    expect(after.messages).toBe(0);
    expect(after.classifications).toBe(0);
    expect(after.meetings).toBe(0);
    expect(after.evidence).toBe(0);
    expect(after.claims).toBe(0);
    expect(after.research).toBe(0);
    expect(after.recommendations).toBe(0);
    // Tracing also wrote no evaluation judgement: a trace is not evidence.
    expect(after.observations).toBe(before.observations);
    expect(after.evaluationRuns).toBe(before.evaluationRuns);

    // The negative space is published, so a reader can check it without
    // reading a derivation.
    const policy = await policyOf(t, h);
    const printed = policy.neverDoes.join(" ");
    for (const claim of [
      "Never executes an agent",
      "Never invokes a tool",
      "Never opens a model client",
      "Never reaches a network",
      "Never records a success nobody reported",
      "Never edits or deletes a step",
      "Never trusts a caller for an ordering key",
      "Never crosses a workspace",
      "Never writes an evaluation judgement",
      "Never computes a cost total of its own",
      "Never uses the clock to decide anything",
    ]) {
      expect(printed, claim).toContain(claim);
    }

    // The registry the phase depends on is unchanged, and the twelve declared
    // agents still read as the registry says they should.
    expect(AGENT_IDS).toHaveLength(12);
    expect(after.registry).toBe(before.registry);
  });
});
