import { describe, expect, it } from "vitest";

import {
  AGENT_DECLARATIONS,
  AGENT_GATED_TRANSITIONS,
  AGENT_IDS,
  AGENT_MEMORY_LAYERS,
  AGENT_PERMISSIONS,
  AGENT_REQUIRED_FIELDS,
  AGENT_RULE_VERSION,
  AGENT_STATE_ORDER,
  AGENT_TOOLS,
  AGENT_TRANSITIONS,
  MEETABLE_AGENT_STATES,
  agentOrder,
  declarationFor,
  isAgentEvaluationMetric,
  isAgentId,
  isAgentState,
  toolFor,
} from "./rules.js";
import {
  decideTransition,
  derivePolicyView,
  deriveRegisteredAgent,
  deriveRegistryView,
  isUsable,
  sortRegistryEvents,
  stateFor,
  transitionAllowed,
} from "./engine.js";
import type { AgentId, AgentRegistryEvent, AgentRegistryRow, AgentState } from "./types.js";
import { SCHEMA } from "@dealora/db";

function row(agentId: AgentId, status: AgentState): AgentRegistryRow {
  return {
    workspaceId: "ws-1",
    agentId,
    status,
    updatedBy: "user-1",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("agent vocabulary", () => {
  it("publishes exactly the twelve agents and seven states the roadmap names", () => {
    expect([...AGENT_IDS]).toEqual([
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
    expect([...AGENT_STATE_ORDER]).toEqual([
      "draft",
      "testing",
      "approved",
      "production",
      "paused",
      "disabled",
      "archived",
    ]);
    expect(AGENT_RULE_VERSION).toBe("agent-1.0.0");
  });

  it("declares every agent with every required field", () => {
    expect(AGENT_DECLARATIONS).toHaveLength(12);
    for (const declaration of AGENT_DECLARATIONS) {
      // ROADMAP.md §25 requires all twelve; a missing one must fail here
      // rather than ship as an agent nobody can review. `status` is the state
      // the registry stores, so it is asserted below rather than here.
      expect(declaration.agentId).toBeTruthy();
      expect(declaration.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(declaration.purpose.length).toBeGreaterThan(20);
      expect(declaration.inputs.length).toBeGreaterThan(0);
      expect(declaration.outputs.length).toBeGreaterThan(0);
      expect(declaration.permissions.length).toBeGreaterThan(0);
      expect(declaration.memoryAccess.length).toBeGreaterThan(0);
      expect(declaration.evaluationMetrics.length).toBeGreaterThan(0);
      // Cost limits are whole minor units, never floats in a money field.
      expect(Number.isInteger(declaration.costLimits.maxSpendMinor)).toBe(true);
      expect(Number.isInteger(declaration.costLimits.maxPerExecutionMinor)).toBe(true);
      expect(declaration.costLimits.maxPerExecutionMinor).toBeLessThanOrEqual(
        declaration.costLimits.maxSpendMinor,
      );
      expect(declaration.owner.length).toBeGreaterThan(0);
    }
  });

  it("starts every agent in a non-usable state", () => {
    for (const declaration of AGENT_DECLARATIONS) {
      expect(declaration.initialState).toBe("draft");
      expect(isUsable(declaration.initialState)).toBe(false);
    }
  });

  it("declares no agent with a model, because Phase 18 executes nothing", () => {
    for (const declaration of AGENT_DECLARATIONS) {
      expect(declaration.model.provider).toBeNull();
      expect(declaration.model.model).toBeNull();
      expect(declaration.model.temperature).toBeNull();
    }
  });

  it("names an existing phase as the owner of every capability", () => {
    for (const declaration of AGENT_DECLARATIONS) {
      expect(declaration.owner).toMatch(/^Phase \d+/);
    }
  });

  it("grants write_external to no agent", () => {
    // The permission is published so a reviewer can see it is withheld; an
    // agent holding it would be a claim about sending nobody has earned.
    expect(AGENT_PERMISSIONS.map((view) => view.permission)).toContain("write_external");
    for (const declaration of AGENT_DECLARATIONS) {
      expect(declaration.permissions).not.toContain("write_external");
    }
  });

  it("requires approval for every agent holding an approval-implied tool", () => {
    for (const declaration of AGENT_DECLARATIONS) {
      const implied = declaration.tools.filter((tool) => toolFor(tool)?.approvalImplied === true);
      if (implied.length > 0) {
        expect(declaration.approvalRequired, `${declaration.agentId}: ${implied.join(", ")}`).toBe(
          true,
        );
      }
    }
    // The three tools that imply approval are exactly the ones that need a
    // person or touch something outside the system.
    expect(AGENT_TOOLS.filter((view) => view.approvalImplied).map((view) => view.tool)).toEqual([
      "request_approval",
      "send_message",
      "book_meeting",
    ]);
  });

  it("declares only known tools, memory layers and metrics", () => {
    for (const declaration of AGENT_DECLARATIONS) {
      for (const tool of declaration.tools) {
        expect(toolFor(tool), `${declaration.agentId}: ${tool}`).not.toBeNull();
      }
      for (const layer of declaration.memoryAccess) {
        expect(AGENT_MEMORY_LAYERS).toContain(layer);
      }
      for (const metric of declaration.evaluationMetrics) {
        expect(isAgentEvaluationMetric(metric)).toBe(true);
      }
    }
  });

  it("gives every published tool an executing phase and no tool is orphaned", () => {
    const declared = new Set(AGENT_DECLARATIONS.flatMap((entry) => entry.tools));
    for (const view of AGENT_TOOLS) {
      expect(view.executedBy.length).toBeGreaterThan(0);
    }
    for (const tool of declared) {
      expect(AGENT_TOOLS.map((view) => view.tool)).toContain(tool);
    }
  });

  it("answers guards from the constant tables, without casting the input", () => {
    expect(isAgentId("qualification")).toBe(true);
    expect(isAgentId("Qualification")).toBe(false);
    expect(isAgentId("")).toBe(false);
    expect(isAgentState("approved")).toBe(true);
    expect(isAgentState("live")).toBe(false);
    expect(agentOrder("strategy")).toBe(0);
    expect(agentOrder("optimization")).toBe(11);
    expect(agentOrder("nope")).toBe(-1);
    expect(declarationFor("meeting")?.owner).toMatch(/^Phase 13/);
    expect(declarationFor("nope")).toBeNull();
  });
});

describe("agent lifecycle", () => {
  it("walks the published path from draft to approved", () => {
    expect(transitionAllowed("draft", "testing")).toBe(true);
    expect(transitionAllowed("testing", "approved")).toBe(true);
  });

  it("refuses promotion to production and names the owning phase", () => {
    const decision = decideTransition("approved", "production");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("promotion must be refused");
    expect(decision.owningPhase).toBe("Phase 19");
    // The refusal states the rule rather than merely denying.
    expect(decision.reason).toContain("evaluation evidence");
  });

  it("makes production unreachable by every route, not just the direct one", () => {
    // The only edge that could enter `production` is `approved → production`,
    // and that edge is refused. Every other origin has no published edge at
    // all, so there is no second way in.
    const entries = AGENT_STATE_ORDER.flatMap((from) =>
      AGENT_TRANSITIONS.filter((entry) => entry.from === from && entry.to === "production").map(
        () => from,
      ),
    );
    expect(entries).toEqual(["approved"]);
    for (const from of AGENT_STATE_ORDER) {
      if (from === "production" || from === "approved") continue;
      expect(transitionAllowed(from, "production"), `${from} -> production`).toBe(false);
    }
  });

  it("keeps every state unusable while Phase 19 has produced no evidence", () => {
    expect([...MEETABLE_AGENT_STATES]).toEqual([]);
    for (const state of AGENT_STATE_ORDER) {
      expect(isUsable(state), state).toBe(false);
    }
  });

  it("treats a same-state request as an allowed no-op", () => {
    const decision = decideTransition("testing", "testing");
    expect(decision.allowed).toBe(true);
  });

  it("reaches every published state and leaves archived from none", () => {
    // Every state must be reachable somehow — as an agent's initial state or
    // as a transition's destination — or it is vocabulary nothing can use.
    // `draft` is reachable only as an initial state: nothing transitions *back*
    // to draft, because an agent is not un-approved by moving backwards.
    const reachable = new Set<string>([
      ...AGENT_DECLARATIONS.map((declaration) => declaration.initialState),
      ...AGENT_TRANSITIONS.map((entry) => entry.to),
    ]);
    for (const state of AGENT_STATE_ORDER) {
      expect(reachable.has(state), `${state} is unreachable`).toBe(true);
    }
    expect(AGENT_TRANSITIONS.filter((entry) => entry.to === "draft")).toEqual([]);
    expect(AGENT_TRANSITIONS.filter((entry) => entry.from === "archived")).toEqual([]);
    // Production is the one published-but-refused destination.
    expect(AGENT_TRANSITIONS.filter((entry) => entry.to === "production")).toHaveLength(1);
  });

  it("refuses pairs the lifecycle does not publish", () => {
    expect(transitionAllowed("draft", "approved")).toBe(false);
    expect(transitionAllowed("draft", "production")).toBe(false);
    expect(transitionAllowed("archived", "draft")).toBe(false);
    expect(transitionAllowed("archived", "testing")).toBe(false);
    expect(transitionAllowed("production", "draft")).toBe(false);
  });

  it("applies the operational brake from every live state and restores to paused", () => {
    for (const from of ["approved", "production", "testing"] as const) {
      expect(transitionAllowed(from, "paused"), `${from} -> paused`).toBe(true);
      expect(transitionAllowed(from, "disabled"), `${from} -> disabled`).toBe(true);
    }
    // Restoring returns to paused, never straight to a live state.
    expect(transitionAllowed("disabled", "testing")).toBe(false);
    expect(transitionAllowed("disabled", "paused")).toBe(true);
  });

  it("names why an unpublished pair is refused", () => {
    const decision = decideTransition("draft", "disabled");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unpublished pair must be refused");
    expect(decision.reason).toContain("draft → disabled");
    expect(decision.owningPhase).toBeNull();
  });
});

describe("registry derivation", () => {
  it("reads an untouched workspace as twelve drafts with no updater", () => {
    const view = deriveRegistryView([]);
    expect(view.ruleVersion).toBe(AGENT_RULE_VERSION);
    expect(view.agents).toHaveLength(12);
    for (const entry of view.agents) {
      expect(entry.status).toBe("draft");
      expect(entry.usable).toBe(false);
      expect(entry.updatedBy).toBeNull();
      expect(entry.updatedAt).toBeNull();
    }
  });

  it("prints every agent in roadmap order regardless of the store's order", () => {
    const rows = [
      row("optimization", "testing"),
      row("strategy", "testing"),
      row("meeting", "paused"),
    ];
    const view = deriveRegistryView(rows);
    expect(view.agents.map((entry) => entry.declaration.agentId)).toEqual([...AGENT_IDS]);
  });

  it("produces byte-identical output from permuted input", () => {
    const rows = [
      row("conversation", "testing"),
      row("analytics", "paused"),
      row("crm", "disabled"),
    ];
    const forwards = JSON.stringify(deriveRegistryView(rows));
    const backwards = JSON.stringify(deriveRegistryView([...rows].reverse()));
    expect(forwards).toBe(backwards);
  });

  it("takes the recorded state for a decided agent and the draft default otherwise", () => {
    const rows = [row("qualification", "approved")];
    expect(stateFor(rows, "qualification")).toBe("approved");
    expect(stateFor(rows, "analytics")).toBe("draft");
    expect(stateFor([], "strategy")).toBe("draft");
  });

  it("assembles one entry from its declaration and its stored state", () => {
    const rows = [row("follow_up", "testing")];
    const entry = deriveRegisteredAgent(rows, "follow_up");
    expect(entry).not.toBeNull();
    expect(entry?.declaration.agentId).toBe("follow_up");
    expect(entry?.status).toBe("testing");
    expect(entry?.updatedBy).toBe("user-1");
    // The stored row carries no declaration: it is read from the rule table,
    // so the registry table can never drift from the code that defines it.
    expect(Object.keys(rows[0] ?? {})).toEqual([
      "workspaceId",
      "agentId",
      "status",
      "updatedBy",
      "updatedAt",
    ]);
  });

  it("returns nothing for an id outside the twelve", () => {
    expect(deriveRegisteredAgent([], "not_an_agent")).toBeNull();
  });

  it("never reports an agent as usable, whatever state was recorded", () => {
    for (const status of AGENT_STATE_ORDER) {
      const entry = deriveRegisteredAgent([row("crm", status)], "crm");
      expect(entry?.usable, status).toBe(false);
    }
  });
});

describe("governance event ordering", () => {
  const event = (id: string, createdAt: string): AgentRegistryEvent => ({
    id,
    workspaceId: "ws-1",
    agentId: "qualification",
    actorUserId: "user-1",
    kind: "state_changed",
    fromStatus: "draft",
    toStatus: "testing",
    detail: null,
    createdAt,
  });

  it("sorts newest first", () => {
    const sorted = sortRegistryEvents([
      event("a", "2026-10-01T00:00:00.000Z"),
      event("b", "2026-10-03T00:00:00.000Z"),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("keeps equal timestamps in decision order, not by random id", () => {
    // Several decisions can land in the same millisecond. Ordering those by a
    // generated id would make the trail differ between runs, so a stable sort
    // is the tiebreak: the events keep the order they were made in.
    const same = "2026-10-01T00:00:00.000Z";
    const events = [event("a", same), event("b", same), event("c", same)];
    expect(sortRegistryEvents(events).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    // A later timestamp still wins outright.
    expect(
      sortRegistryEvents([event("a", same), event("b", "2026-10-01T00:00:01.000Z")]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const events = [event("a", "2026-10-01T00:00:00.000Z"), event("b", "2026-10-03T00:00:00.000Z")];
    sortRegistryEvents(events);
    expect(events.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("policy view", () => {
  const view = derivePolicyView();

  it("publishes the whole rule set in a fixed order", () => {
    expect(view.agents.map((agent) => agent.agentId)).toEqual([...AGENT_IDS]);
    expect(view.states).toEqual(AGENT_STATE_ORDER);
    expect(view.memoryLayers).toEqual(AGENT_MEMORY_LAYERS);
    expect(view.evaluationMetrics).toHaveLength(13);
    expect(view.requiredFields).toEqual(AGENT_REQUIRED_FIELDS);
  });

  it("states plainly that nothing is usable and who will change that", () => {
    expect(view.usableStates).toEqual([]);
    expect(view.promotionRule).toContain("Phase 19");
    expect(
      view.transitions.some((entry) => entry.from === "approved" && entry.to === "production"),
    ).toBe(true);
  });

  it("publishes the negative space as first-class rules", () => {
    const never = view.neverDoes.join(" ");
    expect(never).toContain("Never executes");
    expect(never).toContain("Never calls a model");
    expect(never).toContain("Never sends anything");
    expect(never).toContain("Never fabricates");
    expect(never).toContain("Never promotes");
  });

  it("is byte-identical across calls", () => {
    expect(JSON.stringify(derivePolicyView())).toBe(JSON.stringify(view));
  });
});

describe("storage vocabulary stays in step with the domain", () => {
  it("constrains the agent id column to the twelve declared agents", () => {
    for (const agentId of AGENT_IDS) {
      expect(SCHEMA).toContain(`'${agentId}'`);
    }
    // A thirteenth id must not be representable in DDL either.
    expect(SCHEMA).not.toContain("'sales'");
  });

  it("constrains the status column to the seven published states", () => {
    for (const state of AGENT_STATE_ORDER) {
      expect(SCHEMA).toContain(`'${state}'`);
    }
  });
});

describe("the Phase 19 evaluation gate", () => {
  const satisfied = { satisfied: true, reason: "every declared metric is met" };
  const unsatisfied = {
    satisfied: false,
    reason: "task_success is unmet (measured 6000 basis points).",
  };

  it("publishes exactly one gated transition, owned by Phase 19", () => {
    expect(AGENT_GATED_TRANSITIONS).toHaveLength(1);
    const gated = AGENT_GATED_TRANSITIONS[0];
    expect(gated?.from).toBe("approved");
    expect(gated?.to).toBe("production");
    expect(gated?.owningPhase).toBe("Phase 19");
    expect(gated?.requirement).toContain("exact declared agent version");
    // The edge is still published, so the lifecycle stays legible.
    expect(
      AGENT_TRANSITIONS.some((entry) => entry.from === "approved" && entry.to === "production"),
    ).toBe(true);
  });

  it("fails closed with no gate at all, which is the Phase 18 answer", () => {
    const decision = decideTransition("approved", "production");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("promotion must be refused without evidence");
    expect(decision.owningPhase).toBe("Phase 19");
    expect(decision.reason).toContain("evaluation evidence");
    expect(decision.reason).toContain("no Phase 19 evaluation boundary wired to this registry");
    expect(transitionAllowed("approved", "production")).toBe(false);
  });

  it("refuses when the gate says the evidence is not there, and quotes it", () => {
    const decision = decideTransition("approved", "production", unsatisfied);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("promotion must be refused without evidence");
    expect(decision.owningPhase).toBe("Phase 19");
    expect(decision.reason).toContain("evaluation evidence");
    // The gate's own reason travels with the refusal, so a caller knows what
    // is missing rather than only that something is.
    expect(decision.reason).toContain("task_success is unmet");
  });

  it("permits the transition only when the gate is satisfied", () => {
    const decision = decideTransition("approved", "production", satisfied);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("satisfied evidence must permit promotion");
    expect(decision.reason).toContain("§26");
    expect(transitionAllowed("approved", "production", satisfied)).toBe(true);
  });

  it("consults the gate for the gated edge only", () => {
    // A satisfied gate must not invent transitions. `draft → production` is
    // still absent from the table, so it stays refused with no owning phase.
    const decision = decideTransition("draft", "production", satisfied);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("a gate must not add an unpublished edge");
    expect(decision.owningPhase).toBeNull();
    expect(decision.reason).toContain("does not allow");
  });

  it("grants a governance state and not a capability", () => {
    // Passing the gate moves the registry row and nothing else: `production`
    // is still not a state in which an agent may be used.
    expect(transitionAllowed("approved", "production", satisfied)).toBe(true);
    expect(isUsable("production")).toBe(false);
    expect([...MEETABLE_AGENT_STATES]).toEqual([]);
  });
});
