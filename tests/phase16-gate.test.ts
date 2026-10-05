import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { SandboxEmailProvider } from "@dealora/outbound";
import { SandboxCalendarProvider } from "@dealora/meeting";

/**
 * Phase 16 gate — ROADMAP.md §23.
 *
 * Its gate is one sentence: *a workflow execution can show estimated or
 * measured cost*. This file therefore attaches facts to real executions —
 * research runs that were actually created and completed through the routes —
 * and reads the per-execution summary back, showing both bases over a total
 * that counts a superseded estimate exactly once.
 *
 * The properties under test are the phase's integrity story:
 *
 * - **Recorded vs derived.** Facts are appended; every total, average and
 *   ratio is recomputed on read. The gate proves it by summing the stored
 *   rows by hand and comparing with the derived answer, twice.
 * - **Attribution and totals are never the client's.** Forged `createdBy`,
 *   `createdAt`, `workspaceId`, `totalMinor` and `id` fields in the body are
 *   ignored in favour of the session, the server clock and the stored rows.
 * - **Immutability.** Row counts of every other table are snapshotted before
 *   recording and re-checked after; the cost rows themselves are byte-compared
 *   across reads and replays. A replay returns the same row; a reused key with
 *   a different payload is a conflict, never a rewrite.
 * - **No float, no mixed currency, no overflow.** Amounts are whole minor
 *   units within the safe range, one currency per workspace, and a total that
 *   would leave the safe range refuses the answer rather than rounding it.
 * - **The published partition.** Six categories, two bases, three executable
 *   execution kinds plus the `workflow` refusal (Phase 24), and exactly six
 *   metrics — three derived, three refused with their owning phases.
 *
 * The email and calendar providers are sandboxes, and the research provider
 * is the built-in account-record provider: no network I/O exists in this
 * phase at all.
 */

let seq = 0;
/** Unique per test run, so parallel and repeated runs never collide. */
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Date.now()}`;
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

function handlersFor(): ReturnType<typeof createDefaultHandlers> {
  return createDefaultHandlers({
    outboundProviders: [new SandboxEmailProvider()],
    calendarProviders: [new SandboxCalendarProvider()],
  });
}

function tenant(
  name: string,
  email: string,
): { token: string; userId: string; workspaceId: string } {
  const owner = signup(email, "correct-horse-battery", name);
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

type Handlers = ReturnType<typeof createDefaultHandlers>;

interface GateCostEvent {
  id: string;
  executionKind: string;
  executionId: string;
  category: string;
  basis: string;
  amountMinor: number;
  currency: string;
  source: string | null;
  occurredAt: string;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
}

interface GateBreakdown {
  currency: string | null;
  eventCount: number;
  totalMinor: number;
  estimatedMinor: number;
  measuredMinor: number;
  supersededEstimateMinor: number;
  byCategory: { category: string; amountMinor: number }[];
}

interface GateSummary {
  ruleVersion: string;
  executionKind: string;
  executionId: string;
  totals: GateBreakdown;
}

interface GateMetrics {
  ruleVersion: string;
  totals: GateBreakdown;
  denominators: { prospects: number; qualifiedOpportunities: number; meetings: number };
  metrics: {
    name: string;
    status: string;
    numeratorMinor: number;
    denominator: number;
    averageMinor: number | null;
    remainderMinor: number;
    currency: string | null;
    reason: string | null;
  }[];
  refused: { name: string; reason: string; owningPhase: string | null }[];
}

interface GatePolicy {
  ruleVersion: string;
  categories: { category: string; semantics: string }[];
  bases: { basis: string; semantics: string }[];
  executionKinds: string[];
  refusedExecutionKinds: { name: string; reason: string; owningPhase: string | null }[];
  currencies: string[];
  oneCurrencyPerWorkspace: boolean;
  limits: {
    amountMinorMin: number;
    amountMinorMax: number;
    idempotencyKeyMin: number;
    idempotencyKeyMax: number;
    sourceMin: number;
    sourceMax: number;
  };
  aggregationRule: string;
  denominators: { metric: string; definition: string }[];
  metrics: { name: string; status: string; reason: string; owningPhase: string | null }[];
  neverDoes: string[];
}

/** A record request body, with per-test overrides. */
function costBody(executionId: string, overrides: Record<string, unknown> = {}) {
  return {
    executionKind: "research_run",
    executionId,
    category: "llm",
    basis: "measured",
    amountMinor: 1234,
    currency: "USD",
    source: "usage export",
    occurredAt: "2026-10-01T00:00:00.000Z",
    idempotencyKey: unique("gate-key"),
    ...overrides,
  };
}

/** Create an account and complete a real research run — one live execution. */
async function researchExecution(
  handlers: Handlers,
  token: string,
  workspaceId: string,
  accountName: string,
): Promise<{ accountId: string; requestId: string }> {
  const account = (await dataOf(
    handlers.createAccountHandler(
      request(
        token,
        { workspaceId },
        { name: accountName, industry: "SaaS", companySize: "50-200", geography: "Germany" },
      ),
    ),
  )) as { account: { id: string } };
  const created = (await dataOf(
    handlers.createResearchRequestHandler(
      request(
        token,
        { workspaceId, accountId: account.account.id },
        { provider: "account_record", categories: ["company_overview", "industry"] },
      ),
    ),
  )) as { request: { id: string } };
  const run = (await dataOf(
    handlers.runResearchRequestHandler(request(token, { id: created.request.id })),
  )) as { request: { status: string }; findings: { id: string }[] };
  expect(run.request.status).toBe("completed");
  return { accountId: account.account.id, requestId: created.request.id };
}

/** A snapshot of every table a cost record could conceivably touch. */
function rowCounts(): Record<string, number> {
  const db = defaultStore.db;
  return {
    accounts: db.accounts?.length ?? 0,
    contacts: db.contacts?.length ?? 0,
    findings: db.researchFindings?.length ?? 0,
    requests: db.researchRequests?.length ?? 0,
    claims: db.accountClaims?.length ?? 0,
    evidence: db.evidence?.length ?? 0,
    qualifications: db.qualifications?.length ?? 0,
    drafts: db.personalizedDrafts?.length ?? 0,
    approvals: db.approvalRequests?.length ?? 0,
    actions: db.outboundActions?.length ?? 0,
    inbound: db.inboundMessages?.length ?? 0,
    classifications: db.conversationClassifications?.length ?? 0,
    meetings: db.meetings?.length ?? 0,
    briefs: db.meetingBriefs?.length ?? 0,
    recommendations: db.nextBestActions?.length ?? 0,
    costs: db.costEvents?.length ?? 0,
  };
}

/** The stored cost rows, byte-for-byte, for immutability comparisons. */
function costRowsJson(): string {
  return JSON.stringify(defaultStore.db.costEvents ?? []);
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 16 gate — cost engine", () => {
  it("shows one execution's estimated and measured cost — the phase gate", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Cost Gate", unique("p16") + "@example.com");
    const run = await researchExecution(handlers, token, workspaceId, "Northwind Trading");

    // Two facts about one execution: an estimate made before, a measurement
    // taken after — plus an estimate nothing ever measured.
    for (const body of [
      costBody(run.requestId, { basis: "estimated", amountMinor: 1000 }),
      costBody(run.requestId, { basis: "measured", amountMinor: 900 }),
      costBody(run.requestId, { category: "search", basis: "estimated", amountMinor: 100 }),
    ]) {
      await dataOf(handlers.recordCostHandler(request(token, { workspaceId }, body)));
    }

    const summary = (await dataOf(
      handlers.getExecutionCostHandler(
        request(token, { workspaceId }, undefined, {
          executionKind: "research_run",
          executionId: run.requestId,
        }),
      ),
    )) as GateSummary;
    expect(summary.ruleVersion).toBe("cost-1.0.0");
    expect(summary.executionKind).toBe("research_run");
    expect(summary.executionId).toBe(run.requestId);
    expect(summary.totals.currency).toBe("USD");
    expect(summary.totals.eventCount).toBe(3);
    // Estimated OR measured — both bases are visible for the same run.
    expect(summary.totals.estimatedMinor).toBe(1100);
    expect(summary.totals.measuredMinor).toBe(900);
    // The measured llm cost supersedes its own estimate, so the total counts
    // it once: 900 (measured llm) + 100 (never-measured search) = 1000.
    expect(summary.totals.supersededEstimateMinor).toBe(1000);
    expect(summary.totals.totalMinor).toBe(1000);
    // The published invariant, checked against the response itself.
    expect(summary.totals.totalMinor).toBe(
      summary.totals.measuredMinor +
        (summary.totals.estimatedMinor - summary.totals.supersededEstimateMinor),
    );
    expect(summary.totals.byCategory.find((entry) => entry.category === "llm")?.amountMinor).toBe(
      900,
    );
    expect(
      summary.totals.byCategory.find((entry) => entry.category === "search")?.amountMinor,
    ).toBe(100);

    // A second execution that only ever estimated: its summary shows the
    // estimate with an empty measured side.
    const second = await researchExecution(handlers, token, workspaceId, "Contoso");
    await dataOf(
      handlers.recordCostHandler(
        request(
          token,
          { workspaceId },
          costBody(second.requestId, { basis: "estimated", amountMinor: 500 }),
        ),
      ),
    );
    const estimatedOnly = (await dataOf(
      handlers.getExecutionCostHandler(
        request(token, { workspaceId }, undefined, {
          executionKind: "research_run",
          executionId: second.requestId,
        }),
      ),
    )) as GateSummary;
    expect(estimatedOnly.totals.estimatedMinor).toBe(500);
    expect(estimatedOnly.totals.measuredMinor).toBe(0);
    expect(estimatedOnly.totals.totalMinor).toBe(500);

    // A third execution with nothing recorded: an honest zero, not a guess.
    const third = await researchExecution(handlers, token, workspaceId, "Fabrikam");
    const unpriced = (await dataOf(
      handlers.getExecutionCostHandler(
        request(token, { workspaceId }, undefined, {
          executionKind: "research_run",
          executionId: third.requestId,
        }),
      ),
    )) as GateSummary;
    expect(unpriced.totals.eventCount).toBe(0);
    expect(unpriced.totals.totalMinor).toBe(0);
    expect(unpriced.totals.currency).toBeNull();
  });

  it("appends only cost rows and never rewrites a recorded fact", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId, userId } = tenant(
      "Cost Immutability",
      unique("p16") + "@example.com",
    );
    const run = await researchExecution(handlers, token, workspaceId, "Immuta");

    const before = rowCounts();
    const first = (await dataOf(
      handlers.recordCostHandler(
        request(token, { workspaceId }, costBody(run.requestId, { amountMinor: 400 })),
      ),
    )) as { costEvent: GateCostEvent };
    await dataOf(
      handlers.recordCostHandler(
        request(token, { workspaceId }, costBody(run.requestId, { amountMinor: 600 })),
      ),
    );
    const after = rowCounts();

    // Recording cost touched exactly one table: cost_events grew by two and
    // every other row count is untouched.
    expect(after.costs).toBe(before.costs + 2);
    for (const table of Object.keys(before)) {
      if (table === "costs") continue;
      expect(after[table]).toBe(before[table]);
    }

    // Attribution came from the session, not the request.
    expect(first.costEvent.createdBy).toBe(userId);

    // Reads, metrics and lists never mutate the facts: the rows are
    // byte-identical before and after every derived answer.
    const snapshotAfterWrite = costRowsJson();
    await dataOf(
      handlers.getExecutionCostHandler(
        request(token, { workspaceId }, undefined, {
          executionKind: "research_run",
          executionId: run.requestId,
        }),
      ),
    );
    await dataOf(handlers.getCostMetricsHandler(request(token, { workspaceId })));
    await dataOf(handlers.listCostsHandler(request(token, { workspaceId })));
    await dataOf(handlers.getCostPolicyHandler(request(token, { workspaceId })));
    expect(costRowsJson()).toBe(snapshotAfterWrite);

    // A replayed key returns the same row and writes nothing new.
    const replay = (await dataOf(
      handlers.recordCostHandler(
        request(
          token,
          { workspaceId },
          costBody(run.requestId, { amountMinor: 400, idempotencyKey: "replay-key" }),
        ),
      ),
    )) as { costEvent: GateCostEvent };
    const withReplayKey = (await dataOf(
      handlers.recordCostHandler(
        request(
          token,
          { workspaceId },
          costBody(run.requestId, { amountMinor: 400, idempotencyKey: "replay-key" }),
        ),
      ),
    )) as { costEvent: GateCostEvent };
    expect(withReplayKey.costEvent.id).toBe(replay.costEvent.id);
    expect(rowCounts().costs).toBe(after.costs + 1); // only the first replay wrote

    // The rows recorded before the replay are still byte-identical.
    const current = JSON.parse(costRowsJson()) as GateCostEvent[];
    const original = JSON.parse(snapshotAfterWrite) as GateCostEvent[];
    expect(current.slice(0, original.length)).toEqual(original);

    // A reused key with a different payload is a conflict, never a rewrite:
    // not one byte of the stored facts changes.
    const beforeConflict = costRowsJson();
    const conflict = await errorOf(
      handlers.recordCostHandler(
        request(
          token,
          { workspaceId },
          costBody(run.requestId, { amountMinor: 401, idempotencyKey: "replay-key" }),
        ),
      ),
    );
    expect(conflict.code).toBe("CONFLICT");
    expect(costRowsJson()).toBe(beforeConflict);
  });
});

describe("Phase 16 gate — attribution, totals and determinism", () => {
  it("ignores forged attribution, identity and totals in the request body", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const owner = tenant("Cost Forger", unique("p16") + "@example.com");
    const attacker = tenant("Cost Attacker", unique("p16b") + "@example.com");
    const run = await researchExecution(handlers, owner.token, owner.workspaceId, "Forged Co");

    const forged = (await dataOf(
      handlers.recordCostHandler(
        request(
          owner.token,
          { workspaceId: owner.workspaceId },
          costBody(run.requestId, {
            createdBy: attacker.userId,
            createdAt: "2000-01-01T00:00:00.000Z",
            workspaceId: attacker.workspaceId,
            totalMinor: 999999999,
            id: "forged-id",
            currencyTotal: 42,
          }),
        ),
      ),
    )) as { costEvent: GateCostEvent };

    // Every forged field is ignored: the session attributed it, the server
    // stamped it, and the amount is what the fact actually said.
    expect(forged.costEvent.createdBy).toBe(owner.userId);
    expect(forged.costEvent.createdBy).not.toBe(attacker.userId);
    expect(forged.costEvent.id).not.toBe("forged-id");
    expect(forged.costEvent.amountMinor).toBe(1234);
    const stored = costRowsJson();
    expect(stored).not.toContain("forged-id");
    expect(stored).not.toContain("totalMinor");
    expect(stored).not.toContain(attacker.userId);
    expect(stored).not.toContain("2000-01-01");

    // The derived totals equal the stored rows summed by hand — the route
    // reports what was recorded, never what a body asked for.
    const list = (await dataOf(
      handlers.listCostsHandler(request(owner.token, { workspaceId: owner.workspaceId })),
    )) as { costEvents: GateCostEvent[] };
    const manual = list.costEvents
      .filter((row) => row.executionId === run.requestId)
      .reduce((sum, row) => sum + row.amountMinor, 0);
    const summary = (await dataOf(
      handlers.getExecutionCostHandler(
        request(owner.token, { workspaceId: owner.workspaceId }, undefined, {
          executionKind: "research_run",
          executionId: run.requestId,
        }),
      ),
    )) as GateSummary;
    expect(summary.totals.totalMinor).toBe(manual);
    expect(summary.totals.totalMinor).toBe(1234);
  });

  it("derives the same answer every time, from the rows alone", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Cost Determinism", unique("p16") + "@example.com");
    const run = await researchExecution(handlers, token, workspaceId, "Deterministic");
    for (const body of [
      costBody(run.requestId, { basis: "estimated", amountMinor: 700 }),
      costBody(run.requestId, { basis: "measured", amountMinor: 650 }),
      costBody(run.requestId, { category: "tool", basis: "estimated", amountMinor: 50 }),
    ]) {
      await dataOf(handlers.recordCostHandler(request(token, { workspaceId }, body)));
    }

    const summaryOf = async (): Promise<GateSummary> =>
      (await dataOf(
        handlers.getExecutionCostHandler(
          request(token, { workspaceId }, undefined, {
            executionKind: "research_run",
            executionId: run.requestId,
          }),
        ),
      )) as GateSummary;
    const metricsOf = async (): Promise<GateMetrics> =>
      (await dataOf(
        handlers.getCostMetricsHandler(request(token, { workspaceId })),
      )) as GateMetrics;
    const listOf = async (): Promise<GateCostEvent[]> =>
      (
        (await dataOf(handlers.listCostsHandler(request(token, { workspaceId })))) as {
          costEvents: GateCostEvent[];
        }
      ).costEvents;

    // Repeated reads are byte-identical: nothing accumulates, no clock and
    // no randomness enters a derivation.
    expect(await summaryOf()).toEqual(await summaryOf());
    expect(await metricsOf()).toEqual(await metricsOf());
    expect(await listOf()).toEqual(await listOf());

    // The workspace metrics recompute the same total the summary shows. The
    // raw basis sums equal the rows added up by hand; the combined total
    // applies the supersession rule (700 llm estimate → measured 650, plus
    // the never-measured 50 tool estimate = 700, never 1400).
    const rows = await listOf();
    const manual = rows.reduce((sum, row) => sum + row.amountMinor, 0);
    const metrics = await metricsOf();
    const summary = await summaryOf();
    expect(metrics.totals.totalMinor).toBe(summary.totals.totalMinor);
    expect(metrics.totals.estimatedMinor).toBe(750);
    expect(metrics.totals.measuredMinor).toBe(650);
    expect(metrics.totals.supersededEstimateMinor).toBe(700);
    expect(metrics.totals.estimatedMinor + metrics.totals.measuredMinor).toBe(manual);
    expect(summary.totals.totalMinor).toBe(700);
    expect(summary.totals.totalMinor).toBe(
      metrics.totals.measuredMinor +
        (metrics.totals.estimatedMinor - metrics.totals.supersededEstimateMinor),
    );

    // Ordering is a total order: newest first, id tie-break, stable reads.
    expect(rows).toHaveLength(3);
    const listedTwice = await listOf();
    expect(listedTwice.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });
});

describe("Phase 16 gate — tenant isolation and limits", () => {
  it("keeps every cost fact, total and execution summary inside one tenant", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const alice = tenant("Cost Alice", unique("p16a") + "@example.com");
    const bob = tenant("Cost Bob", unique("p16z") + "@example.com");
    const run = await researchExecution(handlers, alice.token, alice.workspaceId, "Isolated Co");
    const recorded = (await dataOf(
      handlers.recordCostHandler(
        request(alice.token, { workspaceId: alice.workspaceId }, costBody(run.requestId)),
      ),
    )) as { costEvent: GateCostEvent };

    // Bob naming Alice's workspace is refused at the workspace guard.
    for (const call of [
      handlers.listCostsHandler(request(bob.token, { workspaceId: alice.workspaceId })),
      handlers.getCostMetricsHandler(request(bob.token, { workspaceId: alice.workspaceId })),
      handlers.getCostPolicyHandler(request(bob.token, { workspaceId: alice.workspaceId })),
      handlers.getExecutionCostHandler(
        request(bob.token, { workspaceId: alice.workspaceId }, undefined, {
          executionKind: "research_run",
          executionId: run.requestId,
        }),
      ),
    ]) {
      const error = await errorOf(call);
      expect(error.code).toBe("UNAUTHORIZED");
    }

    // From Bob's own workspace, Alice's fact id reads as absent — not as a
    // fact he is merely not allowed to see, which would confirm it exists.
    const crossed = await errorOf(
      handlers.getCostHandler(
        request(bob.token, { workspaceId: bob.workspaceId, id: recorded.costEvent.id }),
      ),
    );
    expect(crossed.code).toBe("NOT_FOUND");

    // Bob cannot file a cost against Alice's run, and cannot see it in lists.
    const crossedRecord = await errorOf(
      handlers.recordCostHandler(
        request(
          bob.token,
          { workspaceId: bob.workspaceId },
          costBody(run.requestId, { idempotencyKey: "crossed-key" }),
        ),
      ),
    );
    expect(crossedRecord.code).toBe("NOT_FOUND");
    const bobList = (await dataOf(
      handlers.listCostsHandler(request(bob.token, { workspaceId: bob.workspaceId })),
    )) as { costEvents: GateCostEvent[] };
    expect(bobList.costEvents).toEqual([]);
    // A run that does not exist in Bob's workspace is not found there either
    // — he gets no summary implying the run is his with merely no cost.
    const bobSummary = await errorOf(
      handlers.getExecutionCostHandler(
        request(bob.token, { workspaceId: bob.workspaceId }, undefined, {
          executionKind: "research_run",
          executionId: run.requestId,
        }),
      ),
    );
    expect(bobSummary.code).toBe("NOT_FOUND");

    // Bob's metrics see Bob's workspace only: no facts, no data.
    const bobMetrics = (await dataOf(
      handlers.getCostMetricsHandler(request(bob.token, { workspaceId: bob.workspaceId })),
    )) as GateMetrics;
    expect(bobMetrics.totals.eventCount).toBe(0);
    expect(bobMetrics.totals.totalMinor).toBe(0);
    expect(bobMetrics.metrics.every((metric) => metric.status === "no_data")).toBe(true);
  });

  it("enforces the published limits and refuses currency that would mix", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Cost Limits", unique("p16") + "@example.com");
    const run = await researchExecution(handlers, token, workspaceId, "Boundary Co");

    // Boundary values inside the published limits are accepted.
    const zero = (await dataOf(
      handlers.recordCostHandler(
        request(
          token,
          { workspaceId },
          costBody(run.requestId, { amountMinor: 0, idempotencyKey: "zero" }),
        ),
      ),
    )) as { costEvent: GateCostEvent };
    expect(zero.costEvent.amountMinor).toBe(0);
    const max = (await dataOf(
      handlers.recordCostHandler(
        request(
          token,
          { workspaceId },
          costBody(run.requestId, {
            amountMinor: Number.MAX_SAFE_INTEGER,
            idempotencyKey: "max",
          }),
        ),
      ),
    )) as { costEvent: GateCostEvent };
    expect(max.costEvent.amountMinor).toBe(Number.MAX_SAFE_INTEGER);

    // Just past every boundary is refused with the field named.
    for (const overrides of [
      { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { amountMinor: -1 },
      { amountMinor: 0.5 },
      { idempotencyKey: "k".repeat(129) },
      { source: "s".repeat(129) },
      { currency: "DOGE" },
      { occurredAt: "yesterday-ish" },
    ]) {
      const error = await errorOf(
        handlers.recordCostHandler(
          request(token, { workspaceId }, costBody(run.requestId, overrides)),
        ),
      );
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.details?.length).toBeGreaterThan(0);
    }

    // One currency per workspace: the first fact fixed USD, so EUR is refused.
    const mixed = await errorOf(
      handlers.recordCostHandler(
        request(
          token,
          { workspaceId },
          costBody(run.requestId, { currency: "EUR", idempotencyKey: "eur" }),
        ),
      ),
    );
    expect(mixed.code).toBe("VALIDATION_ERROR");
    expect(mixed.message).toContain("USD");

    // A total that would leave the safe-integer range refuses the answer
    // instead of rounding: two individually-valid facts of 2^52 each.
    setSessionIndex(createIndex());
    const big = tenant("Cost Overflow", unique("p16o") + "@example.com");
    const bigRun = await researchExecution(handlers, big.token, big.workspaceId, "Overflow Co");
    for (const key of ["half-1", "half-2"]) {
      await dataOf(
        handlers.recordCostHandler(
          request(
            big.token,
            { workspaceId: big.workspaceId },
            costBody(bigRun.requestId, { amountMinor: 2 ** 52, idempotencyKey: key }),
          ),
        ),
      );
    }
    const overflow = await errorOf(
      handlers.getCostMetricsHandler(request(big.token, { workspaceId: big.workspaceId })),
    );
    expect(overflow.code).toBe("SERVER_ERROR");
    expect(overflow.message).toBe("unexpected failure");
  });
});

describe("Phase 16 gate — the published partition", () => {
  it("publishes exactly the §23 vocabulary, with every refusal and its owner", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const { token, workspaceId } = tenant("Cost Policy", unique("p16") + "@example.com");
    const policy = (await dataOf(
      handlers.getCostPolicyHandler(request(token, { workspaceId })),
    )) as GatePolicy;

    // Six categories, two bases — exactly what ROADMAP.md §23 and
    // BLUEPRINT.md §33 name, each with semantics.
    expect(policy.categories.map((entry) => entry.category)).toEqual([
      "llm",
      "search",
      "data",
      "tool",
      "infrastructure",
      "execution",
    ]);
    for (const entry of policy.categories) expect(entry.semantics.length).toBeGreaterThan(0);
    expect(policy.bases.map((entry) => entry.basis)).toEqual(["estimated", "measured"]);

    // Four executable kinds; `workflow` refused with its owning phase —
    // unreachable vocabulary is never published as available.
    //
    // `agent_run` is Phase 20's one addition to this list, and it is a
    // **widening of an existing vocabulary** rather than a new table: §27
    // requires a traced production agent run to report its cost, and Phase 16's
    // own rule is that cost belongs on `cost_events`. The three kinds Phase 16
    // published are unchanged and in their original order.
    expect(policy.executionKinds).toEqual([
      "research_run",
      "outbound_send",
      "meeting_booking",
      "agent_run",
    ]);
    expect(policy.refusedExecutionKinds).toHaveLength(1);
    expect(policy.refusedExecutionKinds[0]?.name).toBe("workflow");
    expect(policy.refusedExecutionKinds[0]?.owningPhase).toBe("Phase 24");
    expect(policy.refusedExecutionKinds[0]?.reason).toContain("Workflow Engine");
    // No published execution kind may appear in the refusal list, and vice
    // versa: the two lists are disjoint.
    for (const kind of policy.executionKinds) {
      expect(policy.refusedExecutionKinds.some((entry) => entry.name === kind)).toBe(false);
    }

    // Currencies and the published limits.
    expect(policy.currencies).toEqual(["USD", "EUR", "GBP", "JPY"]);
    expect(policy.oneCurrencyPerWorkspace).toBe(true);
    expect(policy.limits).toEqual({
      amountMinorMin: 0,
      amountMinorMax: Number.MAX_SAFE_INTEGER,
      idempotencyKeyMin: 1,
      idempotencyKeyMax: 128,
      sourceMin: 1,
      sourceMax: 128,
    });

    // The six metrics of §23 as a partition: three derived, three refused,
    // disjoint and total.
    const derived = policy.metrics
      .filter((entry) => entry.status === "derived")
      .map((entry) => entry.name)
      .sort();
    const refused = policy.metrics
      .filter((entry) => entry.status === "refused")
      .map((entry) => entry.name)
      .sort();
    expect(derived).toEqual([
      "cost_per_meeting",
      "cost_per_prospect",
      "cost_per_qualified_opportunity",
    ]);
    expect(refused).toEqual(["cost_per_customer", "revenue_per_ai_cost", "revenue_per_campaign"]);
    expect([...derived, ...refused]).toHaveLength(6);
    expect(policy.metrics.find((entry) => entry.name === "cost_per_customer")?.owningPhase).toBe(
      "Phase 17 / 23",
    );
    expect(policy.metrics.find((entry) => entry.name === "revenue_per_ai_cost")?.owningPhase).toBe(
      "Phase 17",
    );
    expect(
      policy.metrics.find((entry) => entry.name === "revenue_per_campaign")?.owningPhase,
    ).toBeNull();
    for (const entry of policy.metrics) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    // Each derived metric's denominator is defined in the same rule set.
    expect(policy.denominators.map((entry) => entry.metric).sort()).toEqual(derived);
    expect(policy.aggregationRule).toContain("measured");
    expect(policy.neverDoes.join(" ")).toContain("never stores a total");
    expect(policy.neverDoes.join(" ")).toContain("never mixes currencies");
    expect(policy.neverDoes.join(" ")).toContain("never trusts a client-supplied total");

    // The refused workflow kind is refused at the record route too, naming
    // the phase that owns it rather than failing generically.
    const workflow = await errorOf(
      handlers.recordCostHandler(
        request(token, { workspaceId }, costBody("some-execution", { executionKind: "workflow" })),
      ),
    );
    expect(workflow.code).toBe("VALIDATION_ERROR");
    expect(workflow.message).toContain("Phase 24");
  });
});
