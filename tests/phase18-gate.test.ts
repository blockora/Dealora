import { describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { store as defaultStore, LATEST_SCHEMA_VERSION } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { signup } from "@dealora/auth";
import { AGENT_IDS, AGENT_STATE_ORDER, AGENT_TOOLS } from "@dealora/agent";

/**
 * Phase 18 gate — ROADMAP.md §25 (Agent System).
 *
 * §25 asks for twelve named agents, eleven required declaration fields each,
 * and a seven-value lifecycle. This gate drives the **real** API over the
 * **real** store and checks the phase's integrity story:
 *
 * - **Twelve agents, eleven fields, seven states.** The count is not read from
 *   a constant in this file — it is read back over the wire from the registry
 *   the production wiring built, and each declaration is checked field by field
 *   against ROADMAP.md §25's list.
 * - **Declared, never executed.** This is the phase's central safety property.
 *   The gate proves it structurally: no agent is usable in any state, the
 *   promotion edge is refused by name, and after every route call the row
 *   counts of every other table are unchanged. An agent holding the
 *   `send_message` tool has still sent nothing, and Phase 10's approval and
 *   Phase 11's suppression are untouched.
 * - **The refusal is honest.** `ROADMAP.md` §26 gates production on Phase 19
 *   evaluation evidence. Phase 18 declares those metrics and refuses the
 *   transition, naming the phase that will own it — so the refusal is a
 *   decision a reader can check, not a missing feature.
 * - **Governance is recorded, traces are not.** The registry answers "who
 *   approved this agent?" from its own event trail. ROADMAP.md §27 (Phase 20)
 *   owns run traces, and this phase writes none, so no event carries one.
 * - **Deterministic and tenant-scoped.** The same registry prints byte-identical
 *   JSON on every read, and one tenant's decisions can never appear in
 *   another's.
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

interface GateDeclaration {
  agentId: string;
  version: string;
  owner: string;
  purpose: string;
  inputs: string[];
  outputs: string[];
  tools: string[];
  permissions: string[];
  memoryAccess: string[];
  approvalRequired: boolean;
  costLimits: { maxSpendMinor: number; maxPerExecutionMinor: number; currency: string };
  evaluationMetrics: string[];
  model: { provider: string | null; model: string | null; temperature: number | null };
  initialState: string;
}

interface GateAgent {
  declaration: GateDeclaration;
  status: string;
  usable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface GateRegistry {
  ruleVersion: string;
  agents: GateAgent[];
}

interface GatePolicy {
  ruleVersion: string;
  agents: { agentId: string; owner: string }[];
  states: string[];
  transitions: { from: string; to: string; reason: string }[];
  tools: { tool: string; executedBy: string; approvalImplied: boolean }[];
  permissions: { permission: string; description: string }[];
  memoryLayers: string[];
  evaluationMetrics: { metric: string; owningPhase: string }[];
  usableStates: string[];
  promotionRule: string;
  requiredFields: string[];
  neverDoes: string[];
}

interface GateEvent {
  id: string;
  workspaceId: string;
  agentId: string;
  actorUserId: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string;
  createdAt: string;
}

/** A snapshot of every table the registry could conceivably read or write. */
function rowCounts(): Record<string, number> {
  const db = defaultStore.db;
  return {
    registry: db.agentRegistry?.length ?? 0,
    registryEvents: db.agentRegistryEvents?.length ?? 0,
    accounts: db.accounts?.length ?? 0,
    drafts: db.personalizedDrafts?.length ?? 0,
    approvals: db.approvalRequests?.length ?? 0,
    actions: db.outboundActions?.length ?? 0,
    suppressions: db.outboundSuppressions?.length ?? 0,
    meetings: db.meetings?.length ?? 0,
    costs: db.costEvents?.length ?? 0,
    goals: db.revenueGoals?.length ?? 0,
    recommendations: db.nextBestActions?.length ?? 0,
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

/** Read the registry once, through the real route. */
async function registryOf(t: { token: string; workspaceId: string }, h?: Handlers) {
  const handlers = h ?? createDefaultHandlers();
  return (await dataOf(
    handlers.getAgentRegistryHandler(request(t.token, { workspaceId: t.workspaceId })),
  )) as GateRegistry;
}

describe("Phase 18 gate — Agent System (ROADMAP.md §25)", () => {
  it("publishes the twelve agents §25 names, each with all eleven required fields", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Declarations");
    const registry = (await dataOf(
      h.getAgentRegistryHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as GateRegistry;

    // ROADMAP.md §25's twelve, in its order.
    expect(registry.agents.map((entry) => entry.declaration.agentId)).toEqual([
      "strategy",
      "market_intelligence",
      "account_research",
      "prospect_discovery",
      "qualification",
      "personalization",
      "conversation",
      "follow_up",
      "meeting",
      "crm",
      "analytics",
      "optimization",
    ]);

    // §25's eleven required fields, checked one by one on the wire — including
    // Status, which §25 lists and which is the one field the workspace decides.
    for (const entry of registry.agents) {
      const declaration = entry.declaration;
      const label = declaration.agentId;
      expect(declaration.agentId, label).toBeTruthy();
      expect(declaration.version, label).toMatch(/^\d+\.\d+\.\d+$/);
      expect(declaration.purpose.length, label).toBeGreaterThan(20);
      expect(declaration.inputs.length, label).toBeGreaterThan(0);
      expect(declaration.outputs.length, label).toBeGreaterThan(0);
      expect(declaration.tools.length, label).toBeGreaterThan(0);
      expect(declaration.permissions.length, label).toBeGreaterThan(0);
      expect(declaration.memoryAccess.length, label).toBeGreaterThan(0);
      expect(typeof declaration.approvalRequired, label).toBe("boolean");
      expect(declaration.costLimits.maxSpendMinor, label).toBeGreaterThan(0);
      expect(declaration.costLimits.maxPerExecutionMinor, label).toBeGreaterThan(0);
      expect(Number.isInteger(declaration.costLimits.maxSpendMinor), label).toBe(true);
      expect(declaration.evaluationMetrics.length, label).toBeGreaterThan(0);
      expect(entry.status, label).toBeTruthy();
      // Owner and model are §30's additions to §25's list.
      expect(declaration.owner, label).toMatch(/^Phase \d+/);
    }
  });

  it("publishes exactly the seven lifecycle states §25 names", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate States");
    const policy = (await dataOf(
      h.getAgentPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as GatePolicy;
    expect(policy.states).toEqual([
      "draft",
      "testing",
      "approved",
      "production",
      "paused",
      "disabled",
      "archived",
    ]);
    expect(AGENT_STATE_ORDER).toHaveLength(7);
    expect(AGENT_IDS).toHaveLength(12);
  });

  it("declares agents and never executes one: no agent is usable in any state", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate No Execution");
    const policy = (await dataOf(
      h.getAgentPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as GatePolicy;

    // The strongest statement this phase can make: nothing can be *used*.
    expect(policy.usableStates).toEqual([]);
    for (const state of policy.states) {
      const registry = (await dataOf(
        h.getAgentRegistryHandler(request(t.token, { workspaceId: t.workspaceId })),
      )) as GateRegistry;
      for (const entry of registry.agents) {
        expect(entry.usable, `${entry.declaration.agentId} in ${state}`).toBe(false);
      }
    }

    // And it executes nothing even when an agent holds `send_message`: the
    // outbound table, the approval table and the suppression list are
    // untouched by every registry route below.
    const before = rowCounts();
    const followUp = (await dataOf(
      h.getAgentHandler(request(t.token, { workspaceId: t.workspaceId, agentId: "follow_up" })),
    )) as { agent: GateAgent };
    expect(followUp.agent.declaration.tools).toContain("request_approval");
    const after = rowCounts();
    expect(after).toEqual(before);
  });

  it("refuses promotion to production and names Phase 19, the phase that owns it", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Promotion");
    for (const status of ["testing", "approved"]) {
      await dataOf(
        h.changeAgentStatusHandler(
          request(t.token, { workspaceId: t.workspaceId, agentId: "analytics" }, { status }),
        ),
      );
    }
    const before = rowCounts();
    const error = await errorOf(
      h.changeAgentStatusHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, agentId: "analytics" },
          { status: "production" },
        ),
      ),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    // §26's rule, stated rather than merely denied.
    expect(error.message).toContain("evaluation evidence");
    expect(error.details?.[0]?.message).toContain("Phase 19");
    // The refusal wrote nothing at all.
    expect(rowCounts()).toEqual(before);

    const reread = (await dataOf(
      h.getAgentHandler(request(t.token, { workspaceId: t.workspaceId, agentId: "analytics" })),
    )) as { agent: GateAgent };
    expect(reread.agent.status).toBe("approved");
  });

  it("records governance decisions and never a trace of an agent run", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Governance");
    for (const status of ["testing", "approved", "paused"]) {
      await dataOf(
        h.changeAgentStatusHandler(
          request(t.token, { workspaceId: t.workspaceId, agentId: "follow_up" }, { status }),
        ),
      );
    }
    const events = (await dataOf(
      h.listAgentEventsHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as { events: GateEvent[] };

    expect(events.events).toHaveLength(3);
    // Ordered newest first by timestamp; events sharing the store's
    // millisecond clock read in the order they were decided. The rule is
    // asserted rather than a particular permutation, because a generated-id
    // tiebreak would make the order differ between runs.
    expect(new Set(events.events.map((event) => event.toStatus))).toEqual(
      new Set(["testing", "approved", "paused"]),
    );
    for (let i = 1; i < events.events.length; i += 1) {
      expect(
        (events.events[i - 1]?.createdAt ?? "") >= (events.events[i]?.createdAt ?? ""),
        "the trail is not ordered newest first",
      ).toBe(true);
    }
    // The trail is a chain: one registration, then each decision from the state
    // the previous one left behind.
    const registrations = events.events.filter((event) => event.kind === "registered");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.fromStatus).toBeNull();
    expect(registrations[0]?.toStatus).toBe("testing");
    expect(
      events.events
        .filter((event) => event.kind === "state_changed")
        .map((event) => `${event.fromStatus}->${event.toStatus}`)
        .sort(),
    ).toEqual(["approved->paused", "testing->approved"]);
    // The trail answers "who decided this?", and the actor is the session's.
    expect(events.events.every((event) => event.actorUserId === t.userId)).toBe(true);
    // §27 (Phase 20) owns run traces: no event carries one, and no run log
    // exists to carry it.
    const traceish = JSON.stringify(events.events).toLowerCase();
    expect(traceish).not.toContain("trace");
    expect(traceish).not.toContain("run_id");
    expect(traceish).not.toContain("latency");
  });

  it("names an existing phase as the executor of every tool, and withholds send authority", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Tools");
    const policy = (await dataOf(
      h.getAgentPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as GatePolicy;

    for (const tool of policy.tools) {
      expect(tool.executedBy, tool.tool).toMatch(/^Phase \d+/);
    }
    // Every tool an agent declares exists in the published table: a
    // declaration cannot widen the vocabulary it draws from.
    const published = new Set(policy.tools.map((tool) => tool.tool));
    for (const agent of policy.agents) {
      const declared = (await registryOf(t, h)).agents.find(
        (entry) => entry.declaration.agentId === agent.agentId,
      );
      for (const tool of declared?.declaration.tools ?? []) {
        expect(published.has(tool), `${agent.agentId}: ${tool}`).toBe(true);
      }
    }
    // `send_message` is published and named as Phase 10/11's — so an agent may
    // ask for it, and Phase 10 approval plus Phase 11 suppression still decide
    // whether anything leaves the system.
    const send = policy.tools.find((tool) => tool.tool === "send_message");
    expect(send?.executedBy).toContain("Phase 10");
    expect(send?.approvalImplied).toBe(true);
    expect(AGENT_TOOLS.map((tool) => tool.tool)).toContain("send_message");

    // Sending stays behind Phase 10 approval and Phase 11 suppression: the
    // permission is published, and granted to nobody.
    const permissions = policy.permissions.map((entry) => entry.permission);
    expect(permissions).toContain("write_external");
    const registry = await registryOf(t, h);
    for (const entry of registry.agents) {
      expect(entry.declaration.permissions, entry.declaration.agentId).not.toContain(
        "write_external",
      );
    }
  });

  it("declares which metrics will gate promotion, and measures none of them", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Metrics");
    const policy = (await dataOf(
      h.getAgentPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as GatePolicy;

    // ROADMAP.md §26's thirteen metrics, each owned by the phase that measures.
    expect(policy.evaluationMetrics.map((metric) => metric.metric).sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(policy.evaluationMetrics.every((metric) => metric.owningPhase === "Phase 19")).toBe(
      true,
    );
    // Declared, never reported: no route returns a measured value, because
    // nothing in this phase measures one.
    expect(Object.keys(policy).some((key) => key === "scores" || key === "results")).toBe(false);
  });

  it("keeps the registry a decision log, never a second copy of the declaration", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Single Source");
    await dataOf(
      h.changeAgentStatusHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, agentId: "conversation" },
          { status: "testing" },
        ),
      ),
    );
    // The stored row carries only the workspace, the agent, the state and who
    // last set it — the declaration itself is versioned code, so the table
    // cannot drift from it or become a competing answer.
    const rows = defaultStore.listAgentRegistry(t.workspaceId, t.userId);
    if (!isOk(rows)) throw new Error("registry read failed");
    expect(rows.value).toHaveLength(1);
    expect(Object.keys(rows.value[0] ?? {}).sort()).toEqual([
      "agentId",
      "createdAt",
      "id",
      "status",
      "updatedAt",
      "updatedBy",
      "workspaceId",
    ]);
    expect(defaultStore.db.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  });

  it("isolates the registry by workspace, and refuses a forged identity", async () => {
    const h: Handlers = createDefaultHandlers();
    const a = tenant("Gate Tenant A");
    const b = tenant("Gate Tenant B");

    await dataOf(
      h.changeAgentStatusHandler(
        request(a.token, { workspaceId: a.workspaceId, agentId: "crm" }, { status: "testing" }),
      ),
    );

    const otherRead = await errorOf(
      h.getAgentRegistryHandler(request(b.token, { workspaceId: a.workspaceId })),
    );
    expect(otherRead.code).toBe("UNAUTHORIZED");

    const otherWrite = await errorOf(
      h.changeAgentStatusHandler(
        request(b.token, { workspaceId: a.workspaceId, agentId: "crm" }, { status: "paused" }),
      ),
    );
    expect(otherWrite.code).toBe("UNAUTHORIZED");

    // Another tenant's *existing* workspace is denied, not reported missing:
    // membership is checked first, so the answer never confirms it exists.
    const otherWorkspace = await errorOf(
      h.getAgentRegistryHandler(request(a.token, { workspaceId: b.workspaceId })),
    );
    expect(otherWorkspace.code).toBe("UNAUTHORIZED");

    // A workspace that does not exist at all reads as not found.
    const forged = await errorOf(
      h.getAgentRegistryHandler(request(a.token, { workspaceId: "ws-does-not-exist" })),
    );
    expect(forged.code).toBe("NOT_FOUND");

    const anonymous = await errorOf(
      h.getAgentRegistryHandler(request("", { workspaceId: a.workspaceId })),
    );
    expect(anonymous.code).toBe("UNAUTHENTICATED");

    // A's decision is intact and B's registry is still empty.
    const mine = (await dataOf(
      h.getAgentHandler(request(a.token, { workspaceId: a.workspaceId, agentId: "crm" })),
    )) as { agent: GateAgent };
    const theirs = (await dataOf(
      h.getAgentRegistryHandler(request(b.token, { workspaceId: b.workspaceId })),
    )) as GateRegistry;
    expect(mine.agent.status).toBe("testing");
    expect(theirs.agents.every((entry) => entry.status === "draft")).toBe(true);
  });

  it("is byte-identical on every read and ignores anything a client forges", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Determinism");
    await dataOf(
      h.changeAgentStatusHandler(
        request(t.token, { workspaceId: t.workspaceId, agentId: "meeting" }, { status: "testing" }),
      ),
    );

    const first = JSON.stringify(
      await dataOf(h.getAgentRegistryHandler(request(t.token, { workspaceId: t.workspaceId }))),
    );
    const second = JSON.stringify(
      await dataOf(h.getAgentRegistryHandler(request(t.token, { workspaceId: t.workspaceId }))),
    );
    expect(first).toBe(second);

    // A forged body changes nothing: a client's claims about an agent, a
    // status, a workspace or an updater are not read by any route.
    const forged = JSON.stringify(
      await dataOf(
        h.getAgentRegistryHandler(
          request(
            t.token,
            { workspaceId: t.workspaceId },
            {
              agentId: "strategy",
              status: "production",
              usable: true,
              workspaceId: t.userId,
              updatedBy: "attacker",
              evaluationMetrics: [],
            },
          ),
        ),
      ),
    );
    expect(forged).toBe(first);

    // A forged attribution in a write body is ignored the same way.
    await dataOf(
      h.changeAgentStatusHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, agentId: "strategy" },
          { status: "testing", updatedBy: "attacker", createdAt: "1999-01-01T00:00:00.000Z" },
        ),
      ),
    );
    const written = (await dataOf(
      h.getAgentHandler(request(t.token, { workspaceId: t.workspaceId, agentId: "strategy" })),
    )) as { agent: GateAgent };
    expect(written.agent.updatedBy).toBe(t.userId);
    expect(written.agent.updatedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("rejects an agent or state outside the published vocabularies", async () => {
    const h: Handlers = createDefaultHandlers();
    const t = tenant("Gate Vocabulary");
    const unknownAgent = await errorOf(
      h.getAgentHandler(request(t.token, { workspaceId: t.workspaceId, agentId: "sales_agent" })),
    );
    expect(unknownAgent.code).toBe("VALIDATION_ERROR");
    const unknownState = await errorOf(
      h.changeAgentStatusHandler(
        request(t.token, { workspaceId: t.workspaceId, agentId: "meeting" }, { status: "live" }),
      ),
    );
    expect(unknownState.code).toBe("VALIDATION_ERROR");
    // Neither attempt wrote anything.
    const rows = defaultStore.listAgentRegistry(t.workspaceId, t.userId);
    if (!isOk(rows)) throw new Error("registry read failed");
    expect(rows.value).toEqual([]);
  });
});
