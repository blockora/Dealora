import { describe, expect, it } from "vitest";

import { createAgentService } from "./factory.js";
import type { AgentRegistryLookup } from "./factory.js";
import type { AgentRegistryRow, StorageResult } from "./types.js";

/**
 * A lookup that records every call, so the wiring can be inspected rather than
 * assumed: a factory that silently dropped a method would leave the service
 * unable to do its job, and one that added a method would let a future phase
 * reach a capability nobody decided it needed.
 */
function recordingLookup(): {
  lookup: AgentRegistryLookup;
  calls: { method: string; args: readonly unknown[] }[];
} {
  const calls: { method: string; args: readonly unknown[] }[] = [];
  const record = <T>(method: string, value: T, args: readonly unknown[]): StorageResult<T> => {
    calls.push({ method, args });
    return { ok: true, value };
  };
  const empty: AgentRegistryRow[] = [];
  const written: AgentRegistryRow = {
    workspaceId: "ws-a",
    agentId: "qualification",
    status: "testing",
    updatedBy: "user-a",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  return {
    calls,
    lookup: {
      authorize: (workspaceId, userId) => record("authorize", undefined, [workspaceId, userId]),
      listAgentRegistry: (workspaceId, userId) =>
        record("listAgentRegistry", empty, [workspaceId, userId]),
      getAgentRegistry: (workspaceId, userId, agentId) =>
        record("getAgentRegistry", null, [workspaceId, userId, agentId]),
      listAgentRegistryEvents: (workspaceId, userId, agentId) =>
        record("listAgentRegistryEvents", [], [workspaceId, userId, agentId]),
      setAgentStatus: (input) => record("setAgentStatus", written, [input]),
    },
  };
}

describe("createAgentService", () => {
  it("reads the registry through the lookup it was given", () => {
    const { lookup, calls } = recordingLookup();
    const service = createAgentService(lookup);
    const result = service.registry("ws-a", "user-a");
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["authorize", "listAgentRegistry"]);
  });

  it("passes the caller's own identity through, never a claim from the request", () => {
    const { lookup, calls } = recordingLookup();
    const service = createAgentService(lookup);
    service.registry("ws-a", "user-a");
    const list = calls.find((call) => call.method === "listAgentRegistry");
    expect(list?.args).toEqual(["ws-a", "user-a"]);
  });

  it("hands the lookup's workspace-scoped write straight to storage", () => {
    const { lookup, calls } = recordingLookup();
    const service = createAgentService(lookup);
    service.changeStatus("ws-a", "user-a", "qualification", "testing");
    const set = calls.find((call) => call.method === "setAgentStatus");
    expect(set?.args[0]).toEqual({
      workspaceId: "ws-a",
      userId: "user-a",
      agentId: "qualification",
      status: "testing",
    });
  });

  it("forwards an optional agent filter to the event read", () => {
    const { lookup, calls } = recordingLookup();
    const service = createAgentService(lookup);
    service.events("ws-a", "user-a", "analytics");
    const read = calls.find((call) => call.method === "listAgentRegistryEvents");
    expect(read?.args).toEqual(["ws-a", "user-a", "analytics"]);
  });

  it("exposes no capability beyond the lookup it was handed", () => {
    // The declared surface is exactly the five methods the service needs; a
    // runner, a model client or a tool invoker is not among them.
    const { lookup } = recordingLookup();
    expect(Object.keys(lookup).sort()).toEqual([
      "authorize",
      "getAgentRegistry",
      "listAgentRegistry",
      "listAgentRegistryEvents",
      "setAgentStatus",
    ]);
  });

  it("still refuses promotion after wiring, because the rules live in the domain", () => {
    const { lookup, calls } = recordingLookup();
    const service = createAgentService(lookup);
    const promotion = service.changeStatus("ws-a", "user-a", "qualification", "production");
    expect(promotion.ok).toBe(false);
    if (promotion.ok) throw new Error("promotion must be refused after wiring");
    // No write reached storage: the refusal is a domain rule, not a storage one.
    expect(calls.some((call) => call.method === "setAgentStatus")).toBe(false);
  });
});
