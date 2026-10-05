import { describe, expect, it } from "vitest";

import { DashboardService } from "./service.js";
import type {
  ApprovalRow,
  ClassificationRow,
  DashboardRepository,
  DraftRow,
  MeetingEventRow,
  MeetingRow,
  OutboundActionRow,
  QualificationRow,
  ResearchRequestRow,
  RevenueGoalRow,
  StorageResult,
  WorkspaceCostMetrics,
} from "./types.js";

const WORKSPACE = "ws-1";
const USER = "user-1";
const FOREIGN_WORKSPACE = "ws-2";
const FOREIGN_USER = "user-2";

const emptyCost: WorkspaceCostMetrics = {
  ruleVersion: "cost-1.0.0",
  totals: {
    currency: null,
    eventCount: 0,
    totalMinor: 0,
    estimatedMinor: 0,
    measuredMinor: 0,
    supersededEstimateMinor: 0,
    byCategory: [],
  },
  denominators: { prospects: 0, qualifiedOpportunities: 0, meetings: 0 },
  metrics: [],
  refused: [],
};

const emptyBoard = { ruleVersion: "next-action-1.0.0", recommendations: [] };

/**
 * A store holding one workspace's rows. Tenant isolation is modelled the way
 * the repository does it: every list is scoped by workspace and re-checked
 * against the caller's identity, so a foreign id cannot be read by asking
 * with someone else's workspace.
 */
interface Store {
  readonly workspaceId: string;
  readonly memberIds: readonly string[];
  readonly goals: readonly RevenueGoalRow[];
  readonly qualifications: readonly QualificationRow[];
  readonly classifications: readonly ClassificationRow[];
  readonly meetings: readonly MeetingRow[];
  readonly meetingEvents: ReadonlyMap<string, readonly MeetingEventRow[]>;
  readonly research: readonly ResearchRequestRow[];
  readonly drafts: readonly DraftRow[];
  readonly approvals: readonly ApprovalRow[];
  readonly outbound: readonly OutboundActionRow[];
  readonly cost: WorkspaceCostMetrics;
  readonly board: typeof emptyBoard;
}

function emptyStore(overrides: Partial<Store> = {}): Store {
  return {
    workspaceId: WORKSPACE,
    memberIds: [USER],
    goals: [],
    qualifications: [],
    classifications: [],
    meetings: [],
    meetingEvents: new Map(),
    research: [],
    drafts: [],
    approvals: [],
    outbound: [],
    cost: emptyCost,
    board: emptyBoard,
    ...overrides,
  };
}

/** What the store was asked for, in call order — the audit a test needs. */
interface Call {
  readonly method: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly subjectId: string | null;
}

interface Harness {
  readonly service: DashboardService;
  readonly calls: Call[];
}

/** An injected storage refusal, named by the method it fails. */
type Faults = Readonly<Record<string, { readonly code: string; readonly message?: string }>>;

function harness(store: Store, faults: Faults = {}): Harness {
  const calls: Call[] = [];
  const record = (
    method: string,
    workspaceId: string,
    userId: string,
    subjectId: string | null,
  ) => {
    calls.push({ method, workspaceId, userId, subjectId });
  };
  /** The injected refusal for a method, if this harness was given one. */
  const faultFor = (
    method: string,
  ): { readonly code: string; readonly message?: string } | undefined => faults[method];
  const refuse = <T>(method: string, fallback: T): StorageResult<T> => {
    const fault = faultFor(method);
    return fault === undefined ? { ok: true, value: fallback } : { ok: false, error: fault };
  };
  /** The tenant gate every read passes through, exactly as the store has it. */
  const scope = (method: string, workspaceId: string, userId: string): StorageResult<true> => {
    record(method, workspaceId, userId, null);
    if (workspaceId !== store.workspaceId) return { ok: false, error: { code: "NOT_FOUND" } };
    if (!store.memberIds.includes(userId)) return { ok: false, error: { code: "UNAUTHORIZED" } };
    return { ok: true, value: true };
  };
  const scoped = <T>(
    method: string,
    workspaceId: string,
    userId: string,
    rows: readonly T[],
  ): StorageResult<readonly T[]> => {
    const gate = scope(method, workspaceId, userId);
    if (!gate.ok) return gate;
    return refuse(method, rows);
  };

  const repo: DashboardRepository = {
    authorize: (workspaceId, userId) => scope("authorize", workspaceId, userId),
    listRevenueGoals: (workspaceId, userId) =>
      scoped("listRevenueGoals", workspaceId, userId, store.goals),
    listQualifications: (workspaceId, userId) =>
      scoped("listQualifications", workspaceId, userId, store.qualifications),
    listConversationClassifications: (workspaceId, userId) =>
      scoped("listConversationClassifications", workspaceId, userId, store.classifications),
    listMeetings: (workspaceId, userId) =>
      scoped("listMeetings", workspaceId, userId, store.meetings),
    listMeetingEvents: (meetingId, userId) => {
      record("listMeetingEvents", store.workspaceId, userId, meetingId);
      if (!store.memberIds.includes(userId)) {
        return { ok: false, error: { code: "UNAUTHORIZED" } };
      }
      return refuse("listMeetingEvents", store.meetingEvents.get(meetingId) ?? []);
    },
    listResearchRequests: (workspaceId, userId) =>
      scoped("listResearchRequests", workspaceId, userId, store.research),
    listDrafts: (workspaceId, userId) => scoped("listDrafts", workspaceId, userId, store.drafts),
    listApprovalRequests: (workspaceId, userId) =>
      scoped("listApprovalRequests", workspaceId, userId, store.approvals),
    listOutboundActions: (workspaceId, userId) =>
      scoped("listOutboundActions", workspaceId, userId, store.outbound),
    costMetrics: (workspaceId, userId) => {
      const gate = scope("costMetrics", workspaceId, userId);
      return gate.ok ? refuse("costMetrics", store.cost) : gate;
    },
    nextActionBoard: (workspaceId, userId) => {
      const gate = scope("nextActionBoard", workspaceId, userId);
      if (!gate.ok) return gate;
      return refuse("nextActionBoard", store.board);
    },
  };
  return { service: new DashboardService(repo), calls };
}

describe("DashboardService.snapshot authorization", () => {
  it("refuses a request with no workspace id", () => {
    const { service, calls } = harness(emptyStore());
    const result = service.snapshot("", USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toEqual({ code: "VALIDATION_ERROR", message: "workspace id is required" });
    expect(calls).toEqual([]);
  });

  it("refuses a request whose workspace id is only whitespace", () => {
    const { service } = harness(emptyStore());
    const result = service.snapshot("   ", USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a request with no identity", () => {
    const { service, calls } = harness(emptyStore());
    const result = service.snapshot(WORKSPACE, "");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toEqual({ code: "UNAUTHORIZED", message: "authentication required" });
    expect(calls).toEqual([]);
  });

  it("authorizes before reading a single row", () => {
    const { service, calls } = harness(emptyStore());
    service.snapshot(WORKSPACE, USER);
    expect(calls[0]).toEqual({
      method: "authorize",
      workspaceId: WORKSPACE,
      userId: USER,
      subjectId: null,
    });
  });

  it("answers NOT_FOUND for a workspace that does not exist", () => {
    const { service } = harness(emptyStore());
    const result = service.snapshot(FOREIGN_WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toEqual({ code: "NOT_FOUND", message: "workspace not found" });
  });

  it("answers UNAUTHORIZED for a non-member of the workspace", () => {
    const { service } = harness(emptyStore());
    const result = service.snapshot(WORKSPACE, FOREIGN_USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toEqual({ code: "UNAUTHORIZED", message: "workspace access denied" });
  });

  it("reads nothing at all after a refused authorization", () => {
    const { service, calls } = harness(emptyStore());
    service.snapshot(FOREIGN_WORKSPACE, FOREIGN_USER);
    expect(calls.map((call) => call.method)).toEqual(["authorize"]);
  });
});

describe("DashboardService.snapshot tenant isolation", () => {
  it("scopes every read to the caller's own workspace and identity", () => {
    const store = emptyStore({
      goals: [
        {
          id: "g1",
          status: "active",
          targetMetric: "pipeline",
          targetValue: 10,
          currency: "USD",
          timeWindow: { start: "2026-01-01", end: "2026-03-31" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      meetings: [{ id: "m1", accountId: "a1", state: "booked" }],
      meetingEvents: new Map([["m1", [{ kind: "booked" }]]]),
    });
    const { service, calls } = harness(store);
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(true);

    const reads = calls.filter((call) => call.method !== "authorize");
    expect(reads.length).toBeGreaterThan(0);
    for (const call of reads) {
      // The meeting-event read is keyed by a meeting id the store already
      // scoped to this workspace; every other read carries the workspace and
      // the caller's identity and nothing else.
      if (call.method === "listMeetingEvents") {
        expect(call.subjectId).toBe("m1");
      } else {
        expect(call.workspaceId).toBe(WORKSPACE);
      }
      expect(call.userId).toBe(USER);
    }
  });

  it("never returns another workspace's rows", () => {
    const { service } = harness(emptyStore({ goals: [] }));
    const own = service.snapshot(WORKSPACE, USER);
    const foreign = service.snapshot(FOREIGN_WORKSPACE, USER);
    expect(own.ok).toBe(true);
    expect(foreign.ok).toBe(false);
  });

  it("reads each meeting's own event trail, and only for meetings in scope", () => {
    const store = emptyStore({
      meetings: [
        { id: "m1", accountId: "a1", state: "booked" },
        { id: "m2", accountId: "a2", state: "held" },
      ],
    });
    const { service, calls } = harness(store);
    service.snapshot(WORKSPACE, USER);
    expect(
      calls.filter((call) => call.method === "listMeetingEvents").map((call) => call.subjectId),
    ).toEqual(["m1", "m2"]);
  });
});

describe("DashboardService.snapshot derivation", () => {
  it("derives every tile from the workspace's own rows", () => {
    const store = emptyStore({
      goals: [
        {
          id: "g1",
          status: "active",
          targetMetric: "revenue",
          targetValue: 500,
          currency: "USD",
          timeWindow: { start: "2026-01-01", end: "2026-03-31" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      qualifications: [{ accountId: "a1", version: 1, state: "qualified" }],
      classifications: [{ intent: "positive_intent", suppressed: false }],
      meetings: [{ id: "m1", accountId: "a1", state: "booked" }],
      meetingEvents: new Map([["m1", [{ kind: "booking_attempted" }, { kind: "booking_failed" }]]]),
      research: [{ accountId: "a1", status: "completed" }],
      drafts: [{ id: "d1" }],
      approvals: [{ id: "ap1", status: "pending" }],
      outbound: [{ status: "failed" }],
    });
    const { service } = harness(store);
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a snapshot");

    expect(result.value.goal.goal?.id).toBe("g1");
    expect(result.value.qualifiedProspects.value).toBe(1);
    expect(result.value.positiveConversations.value).toBe(1);
    expect(result.value.meetings.total).toBe(1);
    expect(result.value.opportunities.value).toBe(1);
    expect(result.value.approvalsRequired.required).toBe(1);
    expect(result.value.workflowFailures.total).toBe(2);
    expect(result.value.directRevenue.status).toBe("no_data");
    expect(result.value.customers.status).toBe("no_data");
  });

  it("answers an empty workspace honestly rather than with a fabricated outcome", () => {
    const { service } = harness(emptyStore());
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a snapshot");

    expect(result.value.goal.status).toBe("no_data");
    expect(result.value.goal.goal).toBeNull();
    expect(result.value.qualifiedProspects.value).toBe(0);
    expect(result.value.positiveConversations.value).toBe(0);
    expect(result.value.meetings.total).toBe(0);
    expect(result.value.opportunities.value).toBe(0);
    expect(result.value.approvalsRequired.required).toBe(0);
    expect(result.value.workflowFailures.total).toBe(0);
    expect(result.value.hotConversations.value).toBe(0);
    expect(result.value.agentActivity.every((counter) => counter.count === 0)).toBe(true);
    // The two embedded pictures are Phase 14's and Phase 16's own answers.
    expect(result.value.cost).toEqual(emptyCost);
    expect(result.value.nextBestActions).toEqual(emptyBoard);
  });

  it("returns the same snapshot for the same rows on every read", () => {
    const { service } = harness(emptyStore({ approvals: [{ id: "ap1", status: "pending" }] }));
    const first = service.snapshot(WORKSPACE, USER);
    const second = service.snapshot(WORKSPACE, USER);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected two snapshots");
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });

  it("writes nothing: the service exposes only the two read routes", () => {
    const { service } = harness(emptyStore());
    service.snapshot(WORKSPACE, USER);
    service.policy(WORKSPACE, USER);
    // `guard` is the private authorization helper; every other member is a
    // read. There is no command on this class to call.
    const surface = Object.getOwnPropertyNames(DashboardService.prototype).sort();
    expect(surface).toEqual(["constructor", "guard", "policy", "snapshot"]);
    const commands = surface.filter((member) =>
      /^(create|record|issue|approve|send|update|delete|set)/.test(member),
    );
    expect(commands).toEqual([]);
  });
});

describe("DashboardService storage refusals", () => {
  it("maps a NOT_FOUND list refusal onto the domain vocabulary", () => {
    const { service } = harness(emptyStore(), {
      listRevenueGoals: { code: "NOT_FOUND" },
    });
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toEqual({ code: "NOT_FOUND", message: "revenue goals not found" });
  });

  it("maps an UNAUTHORIZED list refusal onto a denied workspace", () => {
    const { service } = harness(emptyStore(), {
      listMeetings: { code: "UNAUTHORIZED" },
    });
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toEqual({ code: "UNAUTHORIZED", message: "workspace access denied" });
  });

  it("keeps a rule the caller can act on, such as the board's own refusal", () => {
    const { service } = harness(emptyStore(), {
      nextActionBoard: { code: "VALIDATION_ERROR", message: "too many accounts" },
    });
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toEqual({ code: "VALIDATION_ERROR", message: "too many accounts" });
  });

  it("hides an internal condition instead of surfacing storage internals", () => {
    const { service } = harness(emptyStore(), {
      listDrafts: { code: "ECONNRESET", message: "10.0.0.4:5432" },
    });
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toEqual({ code: "UNAVAILABLE", message: "dashboard storage unavailable" });
    expect(JSON.stringify(result.error)).not.toContain("5432");
  });

  it("stops at the first refused read rather than reporting a partial dashboard", () => {
    const { service, calls } = harness(emptyStore(), {
      listQualifications: { code: "UNAVAILABLE" },
    });
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    // It gave up after the failing read instead of counting the rest.
    expect(calls.map((call) => call.method)).toEqual([
      "authorize",
      "listRevenueGoals",
      "listQualifications",
    ]);
  });

  it("propagates a refused meeting-event read", () => {
    const store = emptyStore({ meetings: [{ id: "m1", accountId: "a1", state: "booked" }] });
    const { service } = harness(store, {
      listMeetingEvents: { code: "NOT_FOUND" },
    });
    const result = service.snapshot(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("DashboardService.policy", () => {
  it("answers the published rule set to a member, before any row exists", () => {
    const { service } = harness(emptyStore());
    const result = service.policy(WORKSPACE, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a policy");
    expect(result.value.ruleVersion).toBe("dashboard-1.0.0");
    expect(result.value.items).toHaveLength(14);
    expect(result.value.refusals.map((entry) => entry.name)).toEqual([
      "direct_revenue",
      "pipeline_created",
      "customers",
    ]);
    expect(result.value.questions).toHaveLength(4);
  });

  it("authorizes the policy route exactly like the snapshot route", () => {
    const { service, calls } = harness(emptyStore());
    service.policy(WORKSPACE, USER);
    expect(calls).toEqual([
      { method: "authorize", workspaceId: WORKSPACE, userId: USER, subjectId: null },
    ]);
  });

  it("refuses the policy route to a non-member", () => {
    const { service } = harness(emptyStore());
    const result = service.policy(WORKSPACE, FOREIGN_USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("refuses the policy route with no identity", () => {
    const { service } = harness(emptyStore());
    const result = service.policy(WORKSPACE, "");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("refuses the policy route with no workspace id", () => {
    const { service } = harness(emptyStore());
    const result = service.policy("", USER);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
