import { describe, expect, it } from "vitest";

import { AgentService } from "./service.js";
import type {
  AgentRegistryEvent,
  AgentRegistryRepository,
  AgentRegistryRow,
  StorageResult,
} from "./types.js";

/**
 * An in-memory repository standing in for the store.
 *
 * Every method receives the caller's own identity and enforces the workspace
 * itself, exactly as `packages/db`'s repository does — so the tests below
 * exercise the service's own authorization rather than trusting it.
 */
class FakeRepository implements AgentRegistryRepository {
  readonly rows: AgentRegistryRow[] = [];
  readonly events: AgentRegistryEvent[] = [];
  /** The (workspaceId, userId) pairs this repository will admit. */
  readonly members = new Map<string, Set<string>>();
  /** The tables that should refuse, so error mapping can be exercised. */
  faults: Partial<Record<"list" | "get" | "set" | "events", string>> = {};
  writes = 0;
  /** Advances on every write, so timestamps are strictly increasing. */
  private clock = 0;

  private admit(workspaceId: string, userId: string): StorageResult<true> {
    const members = this.members.get(workspaceId);
    if (!members) return { ok: false, error: { code: "NOT_FOUND" } };
    if (!members.has(userId)) return { ok: false, error: { code: "UNAUTHORIZED" } };
    return { ok: true, value: true };
  }

  authorize(workspaceId: string, userId: string): StorageResult<true> {
    return this.admit(workspaceId, userId);
  }

  listAgentRegistry(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly AgentRegistryRow[]> {
    const auth = this.admit(workspaceId, userId);
    if (!auth.ok) return auth;
    if (this.faults.list) return { ok: false, error: { code: this.faults.list } };
    return { ok: true, value: this.rows.filter((row) => row.workspaceId === workspaceId) };
  }

  getAgentRegistry(
    workspaceId: string,
    userId: string,
    agentId: AgentRegistryRow["agentId"],
  ): StorageResult<AgentRegistryRow | null> {
    const auth = this.admit(workspaceId, userId);
    if (!auth.ok) return auth;
    if (this.faults.get) return { ok: false, error: { code: this.faults.get } };
    return {
      ok: true,
      value:
        this.rows.find((row) => row.workspaceId === workspaceId && row.agentId === agentId) ?? null,
    };
  }

  setAgentStatus(input: {
    workspaceId: string;
    userId: string;
    agentId: AgentRegistryRow["agentId"];
    status: AgentRegistryRow["status"];
  }): StorageResult<AgentRegistryRow> {
    const auth = this.admit(input.workspaceId, input.userId);
    if (!auth.ok) return auth;
    if (this.faults.set) return { ok: false, error: { code: this.faults.set } };
    this.writes += 1;
    const existing = this.rows.find(
      (row) => row.workspaceId === input.workspaceId && row.agentId === input.agentId,
    );
    // A counter over every write, not over rows: a repeated write to the same
    // agent replaces its row, so a row count would repeat a timestamp and the
    // trail's ordering could not be asserted.
    this.clock += 1;
    const at = `2026-10-01T00:00:${String(this.clock).padStart(2, "0")}.000Z`;
    const row: AgentRegistryRow = existing
      ? { ...existing, status: input.status, updatedBy: input.userId, updatedAt: at }
      : {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          status: input.status,
          updatedBy: input.userId,
          updatedAt: at,
        };
    if (existing) this.rows.splice(this.rows.indexOf(existing), 1, row);
    else this.rows.push(row);
    this.events.push({
      id: `event-${this.events.length + 1}`,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      actorUserId: input.userId,
      kind: existing ? "state_changed" : "registered",
      fromStatus: existing ? existing.status : null,
      toStatus: input.status,
      detail: null,
      createdAt: at,
    });
    return { ok: true, value: row };
  }

  listAgentRegistryEvents(
    workspaceId: string,
    userId: string,
    agentId?: AgentRegistryRow["agentId"],
  ): StorageResult<readonly AgentRegistryEvent[]> {
    const auth = this.admit(workspaceId, userId);
    if (!auth.ok) return auth;
    if (this.faults.events) return { ok: false, error: { code: this.faults.events } };
    return {
      ok: true,
      value: this.events.filter(
        (event) =>
          event.workspaceId === workspaceId && (agentId === undefined || event.agentId === agentId),
      ),
    };
  }
}

function fixture(): {
  repo: FakeRepository;
  service: AgentService;
  workspaceId: string;
  userId: string;
} {
  const repo = new FakeRepository();
  repo.members.set("ws-a", new Set(["user-a"]));
  repo.members.set("ws-b", new Set(["user-b"]));
  return { repo, service: new AgentService(repo), workspaceId: "ws-a", userId: "user-a" };
}

describe("AgentService authorization", () => {
  it("reads the registry for a member", () => {
    const fx = fixture();
    const result = fx.service.registry(fx.workspaceId, fx.userId);
    expect(result.ok).toBe(true);
  });

  it("requires a workspace id", () => {
    const fx = fixture();
    for (const empty of ["", "   "]) {
      const result = fx.service.registry(empty, fx.userId);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a blank workspace must be refused");
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("requires an authenticated caller", () => {
    const fx = fixture();
    for (const anonymous of ["", "   "]) {
      const result = fx.service.registry(fx.workspaceId, anonymous);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an anonymous caller must be refused");
      expect(result.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("refuses a caller who is not a member of the workspace", () => {
    const fx = fixture();
    const result = fx.service.registry(fx.workspaceId, "user-b");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a non-member must be refused");
    expect(result.error.code).toBe("UNAUTHORIZED");
    // The refusal happens before a single row is read.
    expect(fx.repo.rows).toEqual([]);
  });

  it("reports an unknown workspace as not found", () => {
    const fx = fixture();
    const result = fx.service.registry("ws-forged", fx.userId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a forged workspace must be refused");
    expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("AgentService registry reads", () => {
  it("reports twelve drafts for a workspace that has decided nothing", () => {
    const fx = fixture();
    const result = fx.service.registry(fx.workspaceId, fx.userId);
    if (!result.ok) throw new Error("registry read failed");
    expect(result.value.agents).toHaveLength(12);
    expect(result.value.agents.every((entry) => entry.status === "draft")).toBe(true);
    expect(fx.repo.writes).toBe(0);
  });

  it("describes one agent with its full declaration", () => {
    const fx = fixture();
    const result = fx.service.describe(fx.workspaceId, fx.userId, "qualification");
    if (!result.ok) throw new Error("describe failed");
    expect(result.value.declaration.agentId).toBe("qualification");
    expect(result.value.declaration.tools).toContain("request_qualification");
    expect(result.value.status).toBe("draft");
    expect(fx.repo.writes).toBe(0);
  });

  it("refuses an agent id outside the twelve", () => {
    const fx = fixture();
    const result = fx.service.describe(fx.workspaceId, fx.userId, "sales_agent");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an unknown agent must be refused");
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.details?.[0]?.field).toBe("agentId");
  });

  it("authorizes a describe before it reveals whether the agent exists", () => {
    const fx = fixture();
    const result = fx.service.describe(fx.workspaceId, "user-b", "qualification");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a non-member must be refused");
    expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the governance trail newest first", () => {
    const fx = fixture();
    for (const status of ["testing", "approved", "paused"]) {
      fx.service.changeStatus(fx.workspaceId, fx.userId, "conversation", status);
    }
    const result = fx.service.events(fx.workspaceId, fx.userId);
    if (!result.ok) throw new Error("events read failed");
    expect(result.value.map((event) => event.toStatus)).toEqual(["paused", "approved", "testing"]);
    expect(result.value[0]?.actorUserId).toBe("user-a");
  });

  it("narrows the trail to one agent", () => {
    const fx = fixture();
    fx.service.changeStatus(fx.workspaceId, fx.userId, "conversation", "testing");
    fx.service.changeStatus(fx.workspaceId, fx.userId, "analytics", "testing");
    const all = fx.service.events(fx.workspaceId, fx.userId);
    const one = fx.service.events(fx.workspaceId, fx.userId, "analytics");
    if (!all.ok || !one.ok) throw new Error("events read failed");
    expect(all.value).toHaveLength(2);
    expect(one.value).toHaveLength(1);
    expect(one.value[0]?.agentId).toBe("analytics");
  });

  it("refuses an unknown agent in the event filter", () => {
    const fx = fixture();
    const result = fx.service.events(fx.workspaceId, fx.userId, "not_an_agent");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an unknown agent must be refused");
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("AgentService status changes", () => {
  it("records the first decision and reads it back", () => {
    const fx = fixture();
    const result = fx.service.changeStatus(fx.workspaceId, fx.userId, "qualification", "testing");
    if (!result.ok) throw new Error("status change failed");
    expect(result.value.status).toBe("testing");
    expect(result.value.usable).toBe(false);
    expect(result.value.updatedBy).toBe("user-a");
    expect(fx.repo.writes).toBe(1);
  });

  it("walks draft → testing → approved", () => {
    const fx = fixture();
    fx.service.changeStatus(fx.workspaceId, fx.userId, "analytics", "testing");
    const approved = fx.service.changeStatus(fx.workspaceId, fx.userId, "analytics", "approved");
    if (!approved.ok) throw new Error("status change failed");
    expect(approved.value.status).toBe("approved");
  });

  it("refuses promotion to production and names Phase 19", () => {
    const fx = fixture();
    fx.service.changeStatus(fx.workspaceId, fx.userId, "analytics", "testing");
    fx.service.changeStatus(fx.workspaceId, fx.userId, "analytics", "approved");
    const promotion = fx.service.changeStatus(fx.workspaceId, fx.userId, "analytics", "production");
    expect(promotion.ok).toBe(false);
    if (promotion.ok) throw new Error("promotion must be refused");
    expect(promotion.error.code).toBe("VALIDATION_ERROR");
    expect(promotion.error.message).toContain("evaluation evidence");
    expect(promotion.error.details?.[0]?.message).toContain("Phase 19");
    // The refusal wrote nothing at all: no row, no event, no state change.
    expect(fx.repo.writes).toBe(2);
    const current = fx.service.describe(fx.workspaceId, fx.userId, "analytics");
    if (!current.ok) throw new Error("describe failed");
    expect(current.value.status).toBe("approved");
  });

  it("refuses a promotion out of any other state too", () => {
    const fx = fixture();
    const fromDraft = fx.service.changeStatus(fx.workspaceId, fx.userId, "crm", "production");
    expect(fromDraft.ok).toBe(false);
    if (!fromDraft.ok) expect(fromDraft.error.code).toBe("CONFLICT");
    expect(fx.repo.writes).toBe(0);
  });

  it("refuses a pair the lifecycle does not publish", () => {
    const fx = fixture();
    const shortcut = fx.service.changeStatus(fx.workspaceId, fx.userId, "crm", "approved");
    expect(shortcut.ok).toBe(false);
    if (!shortcut.ok) expect(shortcut.error.code).toBe("CONFLICT");
    expect(fx.repo.writes).toBe(0);
  });

  it("treats a repeated decision as a no-op rather than a second write", () => {
    const fx = fixture();
    fx.service.changeStatus(fx.workspaceId, fx.userId, "meeting", "testing");
    const again = fx.service.changeStatus(fx.workspaceId, fx.userId, "meeting", "testing");
    if (!again.ok) throw new Error("repeat change failed");
    expect(again.value.status).toBe("testing");
    expect(fx.repo.writes).toBe(1);
    const events = fx.service.events(fx.workspaceId, fx.userId, "meeting");
    if (!events.ok) throw new Error("events read failed");
    expect(events.value).toHaveLength(1);
  });

  it("refuses a state outside the seven", () => {
    const fx = fixture();
    const result = fx.service.changeStatus(fx.workspaceId, fx.userId, "meeting", "live");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an unknown state must be refused");
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.details?.[0]?.field).toBe("status");
  });

  it("refuses an agent outside the twelve", () => {
    const fx = fixture();
    const result = fx.service.changeStatus(fx.workspaceId, fx.userId, "sales_agent", "testing");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an unknown agent must be refused");
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("authorizes before it changes anything", () => {
    const fx = fixture();
    const result = fx.service.changeStatus(fx.workspaceId, "user-b", "qualification", "testing");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a non-member must be refused");
    expect(result.error.code).toBe("UNAUTHORIZED");
    expect(fx.repo.writes).toBe(0);
    expect(fx.repo.rows).toEqual([]);
  });

  it("archives an agent and records it as the terminal decision", () => {
    const fx = fixture();
    fx.service.changeStatus(fx.workspaceId, fx.userId, "strategy", "testing");
    const archived = fx.service.changeStatus(fx.workspaceId, fx.userId, "strategy", "archived");
    if (!archived.ok) throw new Error("archive failed");
    expect(archived.value.status).toBe("archived");
    const events = fx.service.events(fx.workspaceId, fx.userId, "strategy");
    if (!events.ok) throw new Error("events read failed");
    expect(events.value[0]?.kind).toBe("state_changed");
    // Nothing leaves `archived`: a retired declaration cannot be revived.
    const revive = fx.service.changeStatus(fx.workspaceId, fx.userId, "strategy", "draft");
    expect(revive.ok).toBe(false);
    if (revive.ok) throw new Error("an archived agent must stay archived");
    expect(fx.service.describe(fx.workspaceId, fx.userId, "strategy").ok).toBe(true);
  });

  it("retires an agent straight from draft, without a testing detour", () => {
    const fx = fixture();
    const archived = fx.service.changeStatus(fx.workspaceId, fx.userId, "optimization", "archived");
    if (!archived.ok) throw new Error("archive from draft failed");
    expect(archived.value.status).toBe("archived");
  });
});

describe("AgentService isolation", () => {
  it("keeps two workspaces' decisions apart in both directions", () => {
    const fx = fixture();
    fx.service.changeStatus(fx.workspaceId, fx.userId, "conversation", "testing");
    fx.service.changeStatus("ws-b", "user-b", "conversation", "testing");
    fx.service.changeStatus("ws-b", "user-b", "conversation", "paused");

    const mine = fx.service.describe(fx.workspaceId, fx.userId, "conversation");
    const theirs = fx.service.describe("ws-b", "user-b", "conversation");
    if (!mine.ok || !theirs.ok) throw new Error("describe failed");
    expect(mine.value.status).toBe("testing");
    expect(theirs.value.status).toBe("paused");

    const theirEvents = fx.service.events("ws-b", "user-b");
    if (!theirEvents.ok) throw new Error("events read failed");
    expect(theirEvents.value.every((event) => event.workspaceId === "ws-b")).toBe(true);
  });

  it("answers a cross-tenant read as a denial, never as another tenant's data", () => {
    const fx = fixture();
    fx.service.changeStatus("ws-b", "user-b", "conversation", "paused");
    const crossing = fx.service.registry("ws-b", "user-a");
    expect(crossing.ok).toBe(false);
    if (crossing.ok) throw new Error("a cross-tenant read must be refused");
    expect(crossing.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AgentService storage failures", () => {
  it("maps a storage refusal to the domain vocabulary without internals", () => {
    const cases: [string, string][] = [
      ["NOT_FOUND", "NOT_FOUND"],
      ["UNAUTHORIZED", "UNAUTHORIZED"],
      ["VALIDATION_ERROR", "VALIDATION_ERROR"],
      ["INVALID", "VALIDATION_ERROR"],
      ["SOMETHING_INTERNAL", "UNAVAILABLE"],
    ];
    for (const [storageCode, expected] of cases) {
      const fx = fixture();
      fx.repo.faults.list = storageCode;
      const result = fx.service.registry(fx.workspaceId, fx.userId);
      expect(result.ok, storageCode).toBe(false);
      if (result.ok) throw new Error("a storage failure must not read as success");
      expect(result.error.code, storageCode).toBe(expected);
      // An internal condition is never surfaced verbatim.
      if (expected === "UNAVAILABLE")
        expect(result.error.message).not.toContain("SOMETHING_INTERNAL");
    }
  });

  it("maps a failed write without pretending the agent changed", () => {
    const fx = fixture();
    fx.repo.faults.set = "SOMETHING_INTERNAL";
    const result = fx.service.changeStatus(fx.workspaceId, fx.userId, "qualification", "testing");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a storage failure must not read as success");
    expect(result.error.code).toBe("UNAVAILABLE");
    expect(fx.repo.rows).toEqual([]);
  });

  it("maps a failed prior-state read as unavailable, never as a promotion", () => {
    const fx = fixture();
    fx.repo.faults.get = "SOMETHING_INTERNAL";
    const result = fx.service.changeStatus(fx.workspaceId, fx.userId, "qualification", "testing");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a storage failure must not read as success");
    expect(result.error.code).toBe("UNAVAILABLE");
  });

  it("maps a failed event read", () => {
    const fx = fixture();
    fx.repo.faults.events = "SOMETHING_INTERNAL";
    const result = fx.service.events(fx.workspaceId, fx.userId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a storage failure must not read as success");
    expect(result.error.code).toBe("UNAVAILABLE");
  });
});

describe("AgentService policy", () => {
  it("publishes the rule set to an authorized member of an empty workspace", () => {
    const fx = fixture();
    const result = fx.service.policy(fx.workspaceId, fx.userId);
    if (!result.ok) throw new Error("policy read failed");
    expect(result.value.agents).toHaveLength(12);
    expect(result.value.usableStates).toEqual([]);
    expect(fx.repo.writes).toBe(0);
  });

  it("authorizes the policy read exactly like every other read", () => {
    const fx = fixture();
    for (const [workspaceId, userId, code] of [
      ["ws-forged", "user-a", "NOT_FOUND"],
      ["ws-a", "user-b", "UNAUTHORIZED"],
      ["", "user-a", "VALIDATION_ERROR"],
      ["ws-a", "", "UNAUTHORIZED"],
    ] as const) {
      const result = fx.service.policy(workspaceId, userId);
      expect(result.ok, `${workspaceId}/${userId}`).toBe(false);
      if (result.ok) throw new Error("policy must be authorized");
      expect(result.error.code).toBe(code);
    }
  });
});
