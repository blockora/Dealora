import { describe, expect, it } from "vitest";

import type { Result } from "@dealora/core";

import { deriveAccountGraph, deriveWorkspaceGraph } from "./engine.js";
import { createRevenueGraphIndexReader, createRevenueGraphReader } from "./factory.js";
import type { RevenueGraphLookup } from "./factory.js";
import {
  EDGE_KINDS,
  GRAPH_ACCOUNT_LIMIT,
  GRAPH_RULE_VERSION,
  NEVER_DO,
  NODE_KINDS,
  REFUSED,
  ROADMAP_CORE_RELATIONSHIPS,
} from "./rules.js";
import { RevenueGraphService, describePolicy } from "./service.js";
import { REVENUE_GRAPH_STAGES, REVENUE_GRAPH_STAGE_RANK } from "./types.js";
import type {
  AccountGraph,
  AccountGraphSnapshot,
  RevenueGraphEdge,
  RevenueGraphNode,
  RevenueGraphReader,
} from "./types.js";

/**
 * Phase 15 domain tests — ROADMAP.md §22's Revenue Graph.
 *
 * The graph is **derived, never stored**, so these tests exercise the whole
 * phase: the pure engine over narrowed snapshots, the publication tables that
 * define the closed vocabularies, the application service's refusal surface,
 * and the store integration that enforces the tenant boundary.
 *
 * Four invariants get the most attention because they are the phase:
 *
 * 1. **Producibility** — every published node kind and every published edge
 *    kind is emitted by a snapshot of stored rows this repository can actually
 *    write; nothing is advertised that no branch can produce.
 * 2. **The partition** — the seven published kinds plus the five refusals
 *    equal ROADMAP.md §22's twelve CORE RELATIONSHIP names, disjointly, so no
 *    later-phase vocabulary leaks in and no roadmap name is silently dropped.
 * 3. **Determinism** — identical rows always print identical graphs, whatever
 *    order the lists arrived in, because ordering is a total order.
 * 4. **Negative space** — the service has no writer, the client cannot name a
 *    relationship, and a store row that disagrees with its own vocabulary
 *    refuses the read rather than publishing a half-understood graph.
 */

const WORKSPACE = "ws-1";
const USER = "user-1";

/** A bare account: no contacts, no research, no evaluation, nothing sent. */
function snapshot(overrides: Partial<AccountGraphSnapshot> = {}): AccountGraphSnapshot {
  return {
    account: {
      id: "acct-1",
      name: "Acme",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    contacts: [],
    findings: [],
    evidence: [],
    qualifications: [],
    drafts: [],
    outboundActions: [],
    inboundMessages: [],
    classifications: [],
    meetings: [],
    ...overrides,
  };
}

/**
 * One account walked through the entire revenue loop, exactly as Phases 5–13
 * write the rows: contact, finding, evidence, qualified evaluation, draft,
 * sent action, classified reply, booked meeting.
 *
 * Every timestamp increases with the stage, so the expected node and edge
 * order is readable straight off the fixture.
 */
function looped(overrides: Partial<AccountGraphSnapshot> = {}): AccountGraphSnapshot {
  return snapshot({
    contacts: [
      {
        id: "ct-1",
        fullName: "Ada Lovelace",
        status: "active",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    findings: [
      {
        id: "fnd-1",
        category: "industry",
        field: "industry",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ],
    evidence: [
      {
        id: "ev-1",
        researchFindingId: "fnd-1",
        status: "recorded",
        createdAt: "2026-01-04T00:00:00.000Z",
      },
    ],
    qualifications: [
      {
        id: "q-1",
        state: "qualified",
        version: 1,
        evidenceIds: ["ev-1"],
        createdAt: "2026-01-05T00:00:00.000Z",
      },
    ],
    drafts: [
      {
        id: "dr-1",
        qualificationId: "q-1",
        createdAt: "2026-01-05T01:00:00.000Z",
      },
    ],
    outboundActions: [
      {
        id: "oa-1",
        draftId: "dr-1",
        contactId: "ct-1",
        approvalId: "ap-1",
        createdAt: "2026-01-05T02:00:00.000Z",
      },
    ],
    inboundMessages: [
      {
        id: "im-1",
        outboundActionId: "oa-1",
        contactId: "ct-1",
        createdAt: "2026-01-06T00:00:00.000Z",
      },
    ],
    classifications: [
      {
        id: "cc-1",
        intent: "positive_intent",
        outboundActionId: "oa-1",
        inboundMessageId: "im-1",
        createdAt: "2026-01-06T00:00:00.000Z",
      },
    ],
    meetings: [
      {
        id: "mt-1",
        title: "Intro call with Acme",
        state: "booked",
        contactId: "ct-1",
        classificationId: "cc-1",
        createdAt: "2026-01-07T00:00:00.000Z",
      },
    ],
    ...overrides,
  });
}

/** Derive or fail the test — used where a null means a defect, not a refusal. */
function deriveOrThrow(input: AccountGraphSnapshot): AccountGraph {
  const derived = deriveAccountGraph(input);
  if (derived === null) throw new Error("expected a graph");
  return derived;
}

function okOf<T, E extends { code: string; message: string }>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function errOf<T, E extends { code: string }>(result: Result<T, E>): E {
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

/** An independent restatement of the published total order over nodes. */
function nodeOrdered(a: RevenueGraphNode, b: RevenueGraphNode): boolean {
  const at = Date.parse(a.occurredAt);
  const bt = Date.parse(b.occurredAt);
  const aTime = Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
  const bTime = Number.isNaN(bt) ? Number.POSITIVE_INFINITY : bt;
  if (aTime !== bTime) return aTime < bTime;
  const aStage = REVENUE_GRAPH_STAGE_RANK.get(a.kind) ?? 0;
  const bStage = REVENUE_GRAPH_STAGE_RANK.get(b.kind) ?? 0;
  if (aStage !== bStage) return aStage < bStage;
  return a.id <= b.id;
}

/** An independent restatement of the published total order over edges. */
function edgeOrdered(a: RevenueGraphEdge, b: RevenueGraphEdge): boolean {
  const at = Date.parse(a.occurredAt);
  const bt = Date.parse(b.occurredAt);
  const aTime = Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
  const bTime = Number.isNaN(bt) ? Number.POSITIVE_INFINITY : bt;
  if (aTime !== bTime) return aTime < bTime;
  if (a.kind !== b.kind) return a.kind < b.kind;
  if (a.from !== b.from) return a.from < b.from;
  return a.to <= b.to;
}

/** Assert the published total order over nodes, pair by pair. */
function expectNodesSorted(nodes: readonly RevenueGraphNode[]): void {
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1];
    const current = nodes[index];
    if (previous === undefined || current === undefined) throw new Error("index out of range");
    expect(nodeOrdered(previous, current)).toBe(true);
  }
}

/** Assert the published total order over edges, pair by pair. */
function expectEdgesSorted(edges: readonly RevenueGraphEdge[]): void {
  for (let index = 1; index < edges.length; index += 1) {
    const previous = edges[index - 1];
    const current = edges[index];
    if (previous === undefined || current === undefined) throw new Error("index out of range");
    expect(edgeOrdered(previous, current)).toBe(true);
  }
}

describe("revenue graph engine — nodes", () => {
  it("publishes all seven node kinds from stored rows, with verbatim labels and states", () => {
    const graph = deriveOrThrow(looped());
    const kinds = [...new Set(graph.nodes.map((node) => node.kind))].sort();
    expect(kinds).toEqual([
      "company",
      "conversation",
      "evidence",
      "meeting",
      "opportunity",
      "person",
      "signal",
    ]);

    const byKind = new Map(graph.nodes.map((node) => [node.kind, node]));
    expect(byKind.get("company")).toMatchObject({
      id: "acct-1",
      label: "Acme",
      state: "active",
    });
    expect(byKind.get("person")).toMatchObject({
      id: "ct-1",
      label: "Ada Lovelace",
      state: "active",
    });
    expect(byKind.get("signal")).toMatchObject({
      id: "fnd-1",
      label: "industry.industry",
      state: null,
    });
    expect(byKind.get("evidence")).toMatchObject({ id: "ev-1", state: "recorded" });
    expect(byKind.get("opportunity")).toMatchObject({
      id: "q-1",
      state: "qualified",
      label: null,
    });
    expect(byKind.get("conversation")).toMatchObject({
      id: "cc-1",
      state: "positive_intent",
      label: null,
    });
    expect(byKind.get("meeting")).toMatchObject({
      id: "mt-1",
      label: "Intro call with Acme",
      state: "booked",
    });
  });

  it("labels the opportunity with the qualification that produced it, never a new row", () => {
    const graph = deriveOrThrow(looped());
    const opportunity = graph.nodes.find((node) => node.kind === "opportunity");
    expect(opportunity?.id).toBe("q-1");
    // The node id IS the qualification id: a view of a stored row, not a copy.
    expect(graph.lifecycle.opportunity).toBe("q-1");
  });

  it("emits a company node for the account alone, and nothing invented beside it", () => {
    const graph = deriveOrThrow(snapshot());
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ kind: "company", id: "acct-1" });
    expect(graph.edges).toEqual([]);
    expect(graph.lifecycle).toEqual({
      stages: [{ stage: "company", nodeIds: ["acct-1"] }],
      frontier: "company",
      opportunity: null,
    });
  });
});

describe("revenue graph engine — edges", () => {
  it("emits exactly the twelve declared edge kinds on one completed loop", () => {
    const graph = deriveOrThrow(looped());
    const emitted = [...new Set(graph.edges.map((edge) => edge.kind))].sort();
    const declared = EDGE_KINDS.map((entry) => entry.kind).sort();
    // Producibility in both directions: nothing declared is unreachable, and
    // nothing reachable is undeclared.
    expect(emitted).toEqual(declared);
    expect(emitted).toHaveLength(12);
  });

  it("never emits an edge kind outside the closed vocabulary", () => {
    const graph = deriveOrThrow(looped());
    const declared = new Set(EDGE_KINDS.map((entry) => entry.kind));
    for (const edge of graph.edges) expect(declared.has(edge.kind)).toBe(true);
  });

  it("keeps every edge auditable: derivedFrom names the stored rows, target last", () => {
    const graph = deriveOrThrow(looped());
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(edge.derivedFrom.length).toBeGreaterThanOrEqual(2);
      const last = edge.derivedFrom.at(-1);
      expect(last?.id).toBe(edge.to);
      for (const provenance of edge.derivedFrom) {
        expect(provenance.kind.length).toBeGreaterThan(0);
        expect(provenance.id.length).toBeGreaterThan(0);
      }
    }
  });

  it("anchors every record to the company that holds it", () => {
    const graph = deriveOrThrow(looped());
    const anchors = graph.edges.filter((edge) => edge.from === "acct-1");
    const anchoredKinds = new Set(
      anchors.map((edge) => graph.nodes.find((node) => node.id === edge.to)?.kind),
    );
    expect(anchoredKinds).toEqual(
      new Set(["person", "signal", "evidence", "opportunity", "conversation", "meeting"]),
    );
  });

  it("links research to evidence only through the stored conversion", () => {
    const graph = deriveOrThrow(looped());
    const converted = graph.edges.filter((edge) => edge.kind === "signal_became_evidence");
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({ from: "fnd-1", to: "ev-1" });

    // `user_supplied` evidence has no finding and gets no such edge.
    const userSupplied = deriveOrThrow(
      looped({
        evidence: [
          {
            id: "ev-user",
            researchFindingId: null,
            status: "recorded",
            createdAt: "2026-01-04T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(userSupplied.edges.some((edge) => edge.kind === "signal_became_evidence")).toBe(false);
    expect(userSupplied.edges.some((edge) => edge.kind === "company_has_evidence")).toBe(true);
  });

  it("refuses a relationship the stored rows do not prove", () => {
    // Evidence citing a finding this account does not hold: no conversion edge.
    const foreignFinding = deriveOrThrow(
      looped({
        evidence: [
          {
            id: "ev-1",
            researchFindingId: "fnd-ghost",
            status: "recorded",
            createdAt: "2026-01-04T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(foreignFinding.edges.some((edge) => edge.kind === "signal_became_evidence")).toBe(false);

    // A qualification citing evidence this account does not hold: no support edge.
    const foreignEvidence = deriveOrThrow(
      looped({
        qualifications: [
          {
            id: "q-1",
            state: "qualified",
            version: 1,
            evidenceIds: ["ev-ghost"],
            createdAt: "2026-01-05T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(
      foreignEvidence.edges.some((edge) => edge.kind === "evidence_supports_opportunity"),
    ).toBe(false);

    // A draft whose qualification never qualified: no opportunity lineage edge.
    const unqualifiedDraft = deriveOrThrow(
      looped({
        qualifications: [
          {
            id: "q-1",
            state: "unqualified",
            version: 1,
            evidenceIds: ["ev-1"],
            createdAt: "2026-01-05T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(
      unqualifiedDraft.edges.some((edge) => edge.kind === "opportunity_led_to_conversation"),
    ).toBe(false);

    // No node id is ever an edge endpoint unless it exists as a node.
    const graph = deriveOrThrow(looped());
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });

  it("represents one stored fact once, however many paths discover it", () => {
    // The same classification listed twice must not double any edge.
    const snapshotWithDuplicate = looped();
    const duplicated = deriveOrThrow({
      ...snapshotWithDuplicate,
      classifications: [
        ...snapshotWithDuplicate.classifications,
        ...snapshotWithDuplicate.classifications,
      ],
    });
    const keys = duplicated.edges.map((edge) => `${edge.kind}|${edge.from}|${edge.to}`);
    expect(new Set(keys).size).toBe(keys.length);

    // Merging the same account's graph twice into the workspace changes nothing.
    const once = deriveAccountGraph(snapshotWithDuplicate);
    if (once === null) throw new Error("expected a graph");
    const mergedOnce = deriveWorkspaceGraph([once]);
    const mergedTwice = deriveWorkspaceGraph([once, once]);
    expect(mergedTwice.nodes).toEqual(mergedOnce.nodes);
    expect(mergedTwice.edges).toEqual(mergedOnce.edges);
  });
});

describe("revenue graph engine — opportunity lifecycle", () => {
  it("shows the opportunity only while the newest qualification is qualified", () => {
    const before = deriveOrThrow(looped());
    expect(before.lifecycle.opportunity).toBe("q-1");
    expect(before.nodes.some((node) => node.kind === "opportunity")).toBe(true);

    // A newer evaluation downgrades the account: the opportunity disappears
    // immediately, because every read recomputes rather than replays.
    const after = deriveOrThrow(
      looped({
        qualifications: [
          ...looped().qualifications,
          {
            id: "q-2",
            state: "unqualified",
            version: 2,
            evidenceIds: [],
            createdAt: "2026-01-08T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(after.lifecycle.opportunity).toBeNull();
    expect(after.nodes.some((node) => node.kind === "opportunity")).toBe(false);
    const remaining = [...new Set(after.edges.map((edge) => edge.kind))].sort();
    expect(remaining).toEqual([
      "company_has_conversation",
      "company_has_evidence",
      "company_has_meeting",
      "company_has_person",
      "company_has_signal",
      "conversation_led_to_meeting",
      "person_had_conversation",
      "person_joined_meeting",
      "signal_became_evidence",
    ]);
    // The conversation the opportunity's pipeline produced still happened.
    expect(after.nodes.some((node) => node.kind === "conversation")).toBe(true);
  });

  it("promotes the newest qualification when a later evaluation qualifies", () => {
    const graph = deriveOrThrow(
      looped({
        qualifications: [
          {
            id: "q-1",
            state: "unqualified",
            version: 1,
            evidenceIds: ["ev-1"],
            createdAt: "2026-01-05T00:00:00.000Z",
          },
          {
            id: "q-2",
            state: "qualified",
            version: 2,
            evidenceIds: ["ev-1"],
            createdAt: "2026-01-09T00:00:00.000Z",
          },
        ],
        drafts: [{ id: "dr-1", qualificationId: "q-2", createdAt: "2026-01-09T01:00:00.000Z" }],
      }),
    );
    expect(graph.lifecycle.opportunity).toBe("q-2");
    const opportunityEdges = graph.edges.filter((edge) => edge.to === "q-2");
    expect(opportunityEdges.some((edge) => edge.kind === "company_has_opportunity")).toBe(true);
    expect(opportunityEdges.some((edge) => edge.kind === "evidence_supports_opportunity")).toBe(
      true,
    );
  });

  it("breaks version ties by instant then id, whatever order the list arrives in", () => {
    const qualifications: AccountGraphSnapshot["qualifications"] = [
      {
        id: "q-a",
        state: "qualified",
        version: 1,
        evidenceIds: [],
        createdAt: "2026-01-05T00:00:00.000Z",
      },
      {
        id: "q-b",
        state: "qualified",
        version: 1,
        evidenceIds: [],
        createdAt: "2026-01-06T00:00:00.000Z",
      },
      {
        id: "q-c",
        state: "qualified",
        version: 1,
        evidenceIds: [],
        createdAt: "2026-01-06T00:00:00.000Z",
      },
    ];
    const forward = deriveOrThrow(looped({ qualifications }));
    const reversed = deriveOrThrow(looped({ qualifications: [...qualifications].reverse() }));
    // Newest instant wins; equal instants fall to the id, never to list order.
    expect(forward.lifecycle.opportunity).toBe("q-c");
    expect(reversed.lifecycle.opportunity).toBe("q-c");
  });

  it("never raises an opportunity from a qualification state outside the vocabulary", () => {
    const derived = deriveOrThrow(
      snapshot({
        qualifications: [
          {
            id: "q-1",
            state: "qualified-ish",
            version: 3,
            evidenceIds: [],
            createdAt: "2026-01-05T00:00:00.000Z",
          },
        ],
      }),
    );
    // Absence, never fabrication: an unreadable state cannot produce a node.
    expect(derived.lifecycle.opportunity).toBeNull();
    expect(derived.nodes.some((node) => node.kind === "opportunity")).toBe(false);
    expect(derived.edges.some((edge) => edge.kind === "company_has_opportunity")).toBe(false);
  });

  it("reports non-empty stages in loop order with the furthest stage as the frontier", () => {
    const graph = deriveOrThrow(looped());
    const stageNames = graph.lifecycle.stages.map((stage) => stage.stage);
    expect(stageNames).toEqual([...REVENUE_GRAPH_STAGES]);
    expect(graph.lifecycle.frontier).toBe("meeting");
    for (const stage of graph.lifecycle.stages) {
      expect(stage.nodeIds.length).toBeGreaterThan(0);
    }

    // The stages are always a subsequence of the loop, even after a downgrade.
    const downgraded = deriveOrThrow(
      looped({
        qualifications: [
          {
            id: "q-1",
            state: "contested",
            version: 2,
            evidenceIds: [],
            createdAt: "2026-01-08T00:00:00.000Z",
          },
        ],
      }),
    );
    const downgradedStages = downgraded.lifecycle.stages.map((stage) => stage.stage);
    expect(downgradedStages).not.toContain("opportunity");
    const loop = REVENUE_GRAPH_STAGES.filter((stage) => downgradedStages.includes(stage));
    expect(downgradedStages).toEqual([...loop]);
    expect(downgraded.lifecycle.frontier).toBe("meeting");
    expect(downgraded.lifecycle.opportunity).toBeNull();
  });
});

describe("revenue graph engine — ordering and determinism", () => {
  it("orders nodes by (occurredAt, stage rank, id) — a total order", () => {
    const graph = deriveOrThrow(looped());
    expectNodesSorted(graph.nodes);
  });

  it("orders nodes by stage when rows share an instant", () => {
    const instant = "2026-03-01T00:00:00.000Z";
    const graph = deriveOrThrow(
      snapshot({
        contacts: [{ id: "ct-1", fullName: "Ada", status: "active", createdAt: instant }],
        findings: [{ id: "fnd-1", category: "industry", field: "industry", createdAt: instant }],
        evidence: [
          { id: "ev-1", researchFindingId: "fnd-1", status: "recorded", createdAt: instant },
        ],
        qualifications: [
          {
            id: "q-1",
            state: "qualified",
            version: 1,
            evidenceIds: ["ev-1"],
            createdAt: instant,
          },
        ],
      }),
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "company",
      "person",
      "signal",
      "evidence",
      "opportunity",
    ]);
  });

  it("sorts an undated row last, deterministically", () => {
    const graph = deriveOrThrow(
      snapshot({
        contacts: [
          { id: "ct-2", fullName: "Second", status: "active", createdAt: "not-a-date" },
          {
            id: "ct-1",
            fullName: "First",
            status: "active",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      }),
    );
    const order = graph.nodes.map((node) => node.id);
    expect(order).toEqual(["acct-1", "ct-1", "ct-2"]);
    expectNodesSorted(graph.nodes);
  });

  it("orders edges by (occurredAt, kind, from, to) with the target's instant", () => {
    const graph = deriveOrThrow(looped());
    expectEdgesSorted(graph.edges);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
      expect(edge.occurredAt).toBe(nodeById.get(edge.to)?.occurredAt);
    }
  });

  it("prints the identical graph whatever order the rows arrive in", () => {
    const base = looped();
    const shuffled = looped({
      contacts: [...base.contacts].reverse(),
      findings: [...base.findings].reverse(),
      evidence: [...base.evidence].reverse(),
      qualifications: [...base.qualifications].reverse(),
      drafts: [...base.drafts].reverse(),
      outboundActions: [...base.outboundActions].reverse(),
      inboundMessages: [...base.inboundMessages].reverse(),
      classifications: [...base.classifications].reverse(),
      meetings: [...base.meetings].reverse(),
    });
    expect(deriveOrThrow(shuffled)).toEqual(deriveOrThrow(base));
  });

  it("merges the workspace graph into the same answer whichever order accounts arrive", () => {
    const first = deriveOrThrow(
      snapshot({
        account: {
          id: "acct-1",
          name: "Alpha",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    const second = deriveOrThrow(
      snapshot({
        account: {
          id: "acct-2",
          name: "Beta",
          status: "active",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );
    const forward = deriveWorkspaceGraph([first, second]);
    const backward = deriveWorkspaceGraph([second, first]);
    expect(forward).toEqual(backward);
    expect(forward.nodes.map((node) => node.id)).toEqual(["acct-1", "acct-2"]);
    expectNodesSorted(forward.nodes);
    expectEdgesSorted(forward.edges);
  });
});

describe("revenue graph engine — vocabulary refusals", () => {
  it("refuses a whole account read when a published status disagrees with its vocabulary", () => {
    const cases: { name: string; input: AccountGraphSnapshot }[] = [
      {
        name: "account status",
        input: snapshot({
          account: {
            id: "acct-1",
            name: "Acme",
            status: "frozen",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      },
      {
        name: "contact status",
        input: snapshot({
          contacts: [
            {
              id: "ct-1",
              fullName: "Ada",
              status: "pending",
              createdAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        }),
      },
      {
        name: "evidence status",
        input: snapshot({
          evidence: [
            {
              id: "ev-1",
              researchFindingId: null,
              status: "verified",
              createdAt: "2026-01-04T00:00:00.000Z",
            },
          ],
        }),
      },
      {
        name: "conversation intent",
        input: snapshot({
          classifications: [
            {
              id: "cc-1",
              intent: "enthusiastic",
              outboundActionId: "oa-1",
              inboundMessageId: "im-1",
              createdAt: "2026-01-06T00:00:00.000Z",
            },
          ],
        }),
      },
      {
        name: "meeting state",
        input: snapshot({
          meetings: [
            {
              id: "mt-1",
              title: "Call",
              state: "maybe",
              contactId: "ct-1",
              classificationId: "cc-1",
              createdAt: "2026-01-07T00:00:00.000Z",
            },
          ],
        }),
      },
    ];
    for (const testCase of cases) {
      expect(deriveAccountGraph(testCase.input), testCase.name).toBeNull();
    }
  });
});

describe("revenue graph rules — the published vocabulary", () => {
  it("partitions ROADMAP.md's twelve core relationship names, disjointly", () => {
    const published = NODE_KINDS.map((entry) => entry.kind);
    const refused = REFUSED.map((entry) => entry.name);
    expect(published).toHaveLength(7);
    expect(refused).toHaveLength(5);
    expect(new Set([...published, ...refused]).size).toBe(12);
    const combined = [...published, ...refused].sort();
    expect(combined).toEqual([...ROADMAP_CORE_RELATIONSHIPS].sort());
    for (const name of refused) expect(published).not.toContain(name);
  });

  it("refuses each later-phase name with a reason, and its owning phase when one exists", () => {
    expect(REFUSED.map((entry) => entry.name).sort()).toEqual([
      "agent",
      "campaign",
      "customer",
      "revenue",
      "workflow",
    ]);
    for (const entry of REFUSED) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    // No phase through 15 produces a campaign, so no phase is named as its owner.
    expect(REFUSED.find((entry) => entry.name === "campaign")?.owningPhase).toBeNull();
    expect(REFUSED.find((entry) => entry.name === "agent")?.owningPhase).toBe("Phase 18");
  });

  it("keeps every edge kind between published node kinds, and every stage a node kind", () => {
    const kinds = new Set(NODE_KINDS.map((entry) => entry.kind));
    for (const edge of EDGE_KINDS) {
      expect(kinds.has(edge.from), edge.kind).toBe(true);
      expect(kinds.has(edge.to), edge.kind).toBe(true);
      expect(edge.semantics.length).toBeGreaterThan(0);
      expect(edge.derivation.length).toBeGreaterThan(0);
    }
    expect(new Set(REVENUE_GRAPH_STAGES)).toEqual(kinds);
    for (const node of NODE_KINDS) {
      expect(node.source.length).toBeGreaterThan(0);
      expect(node.semantics.length).toBeGreaterThan(0);
    }
  });

  it("pins one rule version and a refusal-not-truncation account cap", () => {
    expect(GRAPH_RULE_VERSION).toBe("revenue-graph-1.0.0");
    expect(GRAPH_ACCOUNT_LIMIT).toBe(100);
    expect(NEVER_DO.length).toBeGreaterThan(0);
    expect(NEVER_DO.join(" ")).toContain("never write");
    expect(NEVER_DO.join(" ")).toContain("never act");
    expect(NEVER_DO.join(" ")).toContain("never recommend");
    expect(NEVER_DO.join(" ")).toContain("never cross a workspace");
  });
});

/** A service over an in-memory reader, index and repository. */
function harness(options?: {
  snapshots?: Record<string, AccountGraphSnapshot>;
  accountIds?: string[] | null;
  authorize?: { ok: true } | { ok: false; error: { code: string; message: string } };
}): {
  service: RevenueGraphService;
  readerCalls: [string, string, string][];
} {
  const snapshots = options?.snapshots ?? {};
  const readerCalls: [string, string, string][] = [];
  const reader: RevenueGraphReader = {
    accountGraph(workspaceId, accountId, userId) {
      readerCalls.push([workspaceId, accountId, userId]);
      const found = snapshots[accountId];
      return found === undefined ? null : found;
    },
  };
  const accountIds =
    options?.accountIds === undefined ? Object.keys(snapshots) : options.accountIds;
  const service = new RevenueGraphService(
    {
      authorize: () => options?.authorize ?? { ok: true },
    },
    reader,
    {
      accountIds: () => accountIds,
    },
  );
  return { service, readerCalls };
}

describe("RevenueGraphService — tracing one opportunity", () => {
  it("answers the trace with the graph, the stages, the frontier and the opportunity", () => {
    const { service } = harness({ snapshots: { "acct-1": looped() } });
    const trace = okOf(service.traceOpportunity(WORKSPACE, USER, { accountId: "acct-1" }));
    expect(trace.ruleVersion).toBe(GRAPH_RULE_VERSION);
    expect(trace.accountId).toBe("acct-1");
    expect(trace.accountName).toBe("Acme");
    expect(trace.lifecycle.frontier).toBe("meeting");
    expect(trace.lifecycle.opportunity).toBe("q-1");
    expect(trace.nodes.length).toBe(7);
    expect(trace.edges.length).toBe(12);
  });

  it("returns the identical answer on every read", () => {
    const { service } = harness({ snapshots: { "acct-1": looped() } });
    const first = okOf(service.traceOpportunity(WORKSPACE, USER, { accountId: "acct-1" }));
    const second = okOf(service.traceOpportunity(WORKSPACE, USER, { accountId: "acct-1" }));
    expect(second).toEqual(first);
  });

  it("reads an account id and nothing else, ignoring any graph state in the input", () => {
    const { service } = harness({ snapshots: { "acct-1": looped() } });
    const forged = {
      accountId: "acct-1",
      nodes: [
        {
          id: "forged-node",
          kind: "customer",
          occurredAt: "2026-01-01T00:00:00.000Z",
          label: null,
          state: null,
        },
      ],
      edges: [
        {
          kind: "forged_edge",
          from: "acct-1",
          to: "forged-node",
          occurredAt: "2026-01-01T00:00:00.000Z",
          derivedFrom: [],
        },
      ],
      opportunity: { id: "forged-opportunity" },
      lifecycle: { frontier: "customer", stages: [] },
    };
    const trace = okOf(service.traceOpportunity(WORKSPACE, USER, forged));
    const wire = JSON.stringify(trace);
    expect(wire).not.toContain("forged");
    // Neither a later-phase node kind nor a forged frontier reaches the wire.
    expect(wire).not.toContain("customer");
    expect(trace.lifecycle.opportunity).toBe("q-1");
    expect(trace.nodes.some((node) => node.kind === "opportunity")).toBe(true);
  });

  it("requires an account id", () => {
    const { service } = harness({ snapshots: { "acct-1": looped() } });
    for (const accountId of [undefined, null, "", "   ", 7, {}]) {
      const error = errOf(service.traceOpportunity(WORKSPACE, USER, { accountId }));
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.details?.[0]?.field).toBe("accountId");
    }
  });

  it("reports an unknown account and a foreign account identically: not found", () => {
    const { service } = harness({ snapshots: { "acct-1": looped() } });
    const unknown = errOf(service.traceOpportunity(WORKSPACE, USER, { accountId: "acct-none" }));
    expect(unknown.code).toBe("NOT_FOUND");
    expect(unknown.details?.[0]?.field).toBe("accountId");
  });

  it("turns an unreadable row into UNAVAILABLE rather than an empty graph", () => {
    const broken = looped({
      contacts: [
        { id: "ct-1", fullName: "Ada", status: "pending", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    });
    const { service } = harness({ snapshots: { "acct-1": broken } });
    const error = errOf(service.traceOpportunity(WORKSPACE, USER, { accountId: "acct-1" }));
    expect(error.code).toBe("UNAVAILABLE");
  });
});

describe("RevenueGraphService — the workspace graph", () => {
  it("merges every readable account into one deterministic answer", () => {
    const { service } = harness({
      snapshots: {
        "acct-1": snapshot({
          account: {
            id: "acct-1",
            name: "Alpha",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        "acct-2": looped({
          account: {
            id: "acct-2",
            name: "Beta",
            status: "active",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      },
      accountIds: ["acct-1", "acct-2"],
    });
    const graph = okOf(service.workspaceGraph(WORKSPACE, USER));
    expect(graph.ruleVersion).toBe(GRAPH_RULE_VERSION);
    expect(graph.accountCount).toBe(2);
    expect(graph.nodes.some((node) => node.id === "acct-2")).toBe(true);
    expect(graph.edges.length).toBe(12);
    const again = okOf(service.workspaceGraph(WORKSPACE, USER));
    expect(again).toEqual(graph);
  });

  it("skips an account whose rows cannot be read, without failing the workspace", () => {
    const { service } = harness({
      snapshots: { "acct-1": snapshot() },
      accountIds: ["acct-1", "acct-2"],
    });
    const graph = okOf(service.workspaceGraph(WORKSPACE, USER));
    expect(graph.accountCount).toBe(1);
    expect(graph.nodes.every((node) => node.id !== "acct-2")).toBe(true);
  });

  it("refuses a workspace above the published cap instead of truncating it", () => {
    const tooMany = Array.from({ length: GRAPH_ACCOUNT_LIMIT + 1 }, (_, index) => `acct-${index}`);
    const { service, readerCalls } = harness({ accountIds: tooMany });
    const error = errOf(service.workspaceGraph(WORKSPACE, USER));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details?.[0]?.field).toBe("workspaceId");
    expect(error.details?.[0]?.message).toContain(`${GRAPH_ACCOUNT_LIMIT}`);
    // Refused before a single account is read: nothing is partially assembled.
    expect(readerCalls).toEqual([]);
  });

  it("answers a workspace sitting exactly at the cap", () => {
    const atCap = Array.from({ length: GRAPH_ACCOUNT_LIMIT }, (_, index) => `acct-${index}`);
    const snapshots: Record<string, AccountGraphSnapshot> = {};
    for (const accountId of atCap) {
      snapshots[accountId] = snapshot({
        account: {
          id: accountId,
          name: `Account ${accountId}`,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    }
    const { service } = harness({ snapshots, accountIds: atCap });
    const graph = okOf(service.workspaceGraph(WORKSPACE, USER));
    expect(graph.accountCount).toBe(GRAPH_ACCOUNT_LIMIT);
    expect(graph.nodes).toHaveLength(GRAPH_ACCOUNT_LIMIT);
  });

  it("reports an unreadable account index as UNAVAILABLE, never as an empty graph", () => {
    const { service } = harness({ accountIds: null });
    const error = errOf(service.workspaceGraph(WORKSPACE, USER));
    expect(error.code).toBe("UNAVAILABLE");
  });
});

describe("RevenueGraphService — authorization and policy", () => {
  it("maps storage refusals onto domain codes without leaking internal messages", () => {
    const notFound = harness({
      authorize: { ok: false, error: { code: "NOT_FOUND", message: "no such workspace row" } },
    });
    expect(errOf(notFound.service.workspaceGraph(WORKSPACE, USER)).code).toBe("NOT_FOUND");

    const denied = harness({
      authorize: { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } },
    });
    const deniedError = errOf(
      denied.service.traceOpportunity(WORKSPACE, USER, { accountId: "acct-1" }),
    );
    expect(deniedError.code).toBe("UNAUTHORIZED");

    const broken = harness({
      authorize: { ok: false, error: { code: "SOMETHING_ELSE", message: "disk details" } },
    });
    const error = errOf(broken.service.policy(WORKSPACE, USER));
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).not.toContain("disk");
  });

  it("requires a workspace and a user before it reads anything", () => {
    const { service, readerCalls } = harness({ snapshots: { "acct-1": looped() } });
    expect(errOf(service.traceOpportunity("", USER, { accountId: "acct-1" })).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(errOf(service.workspaceGraph("   ", USER)).code).toBe("VALIDATION_ERROR");
    expect(errOf(service.traceOpportunity(WORKSPACE, "", { accountId: "acct-1" })).code).toBe(
      "UNAUTHORIZED",
    );
    expect(readerCalls).toEqual([]);
  });

  it("publishes the whole rule set before a single account exists", () => {
    const { service } = harness({ snapshots: {} });
    const policy = okOf(service.policy(WORKSPACE, USER));
    expect(policy.ruleVersion).toBe(GRAPH_RULE_VERSION);
    expect(policy.nodeKinds).toHaveLength(7);
    expect(policy.edgeKinds).toHaveLength(12);
    expect(policy.stages).toEqual([...REVENUE_GRAPH_STAGES]);
    expect(policy.refused.map((entry) => entry.name).sort()).toEqual([
      "agent",
      "campaign",
      "customer",
      "revenue",
      "workflow",
    ]);
    expect(policy.neverDoes.length).toBeGreaterThan(0);
    // The policy is derived from the same tables the engine enforces.
    expect(policy).toEqual(describePolicy());
    expect(policy.nodeKinds).toEqual(NODE_KINDS.map((entry) => entry.kind));
    expect(policy.edgeKinds).toEqual(EDGE_KINDS.map((entry) => entry.kind));
    for (const edge of policy.edges) {
      expect(policy.nodeKinds).toContain(edge.from);
      expect(policy.nodeKinds).toContain(edge.to);
    }
  });

  it("exposes no writer anywhere on the service", () => {
    const methods = Object.getOwnPropertyNames(RevenueGraphService.prototype).sort();
    expect(methods).toEqual([
      "constructor",
      "guard",
      "policy",
      "traceOpportunity",
      "workspaceGraph",
    ]);
    const writers = methods.filter((method) =>
      /create|update|delete|write|send|schedule|approve|book|recommend/i.test(method),
    );
    expect(writers).toEqual([]);
  });
});

/** In-memory rows shaped like the store's, for the store-integration tests. */
interface LookupRows {
  accounts: {
    id: string;
    workspaceId: string;
    name: string;
    status: string;
    createdAt: string;
  }[];
  contacts: {
    id: string;
    workspaceId: string;
    accountId: string;
    fullName: string;
    status: string;
    createdAt: string;
  }[];
  findings: {
    id: string;
    workspaceId: string;
    accountId: string;
    category: string;
    field: string;
    createdAt: string;
  }[];
  evidence: {
    id: string;
    workspaceId: string;
    accountId: string;
    researchFindingId: string | null;
    status: string;
    createdAt: string;
  }[];
  qualifications: {
    id: string;
    workspaceId: string;
    accountId: string;
    state: string;
    version: number;
    evidenceIds: readonly string[];
    createdAt: string;
  }[];
  drafts: {
    id: string;
    workspaceId: string;
    accountId: string;
    qualificationId: string | null;
    createdAt: string;
  }[];
  outbound: {
    id: string;
    draftId: string;
    contactId: string;
    approvalId: string;
    createdAt: string;
  }[];
  inbound: { id: string; outboundActionId: string; contactId: string; createdAt: string }[];
  classifications: {
    id: string;
    intent: string;
    outboundActionId: string;
    inboundMessageId: string;
    createdAt: string;
  }[];
  meetings: {
    id: string;
    workspaceId: string;
    accountId: string;
    title: string;
    state: string;
    contactId: string;
    classificationId: string;
    createdAt: string;
  }[];
}

function emptyRows(): LookupRows {
  return {
    accounts: [],
    contacts: [],
    findings: [],
    evidence: [],
    qualifications: [],
    drafts: [],
    outbound: [],
    inbound: [],
    classifications: [],
    meetings: [],
  };
}

/** The one account fixture the store-integration tests share. */
function fullRows(): LookupRows {
  return {
    accounts: [
      {
        id: "acct-1",
        workspaceId: WORKSPACE,
        name: "Acme",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    contacts: [
      {
        id: "ct-1",
        workspaceId: WORKSPACE,
        accountId: "acct-1",
        fullName: "Ada Lovelace",
        status: "active",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    findings: [
      {
        id: "fnd-1",
        workspaceId: WORKSPACE,
        accountId: "acct-1",
        category: "industry",
        field: "industry",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ],
    evidence: [
      {
        id: "ev-1",
        workspaceId: WORKSPACE,
        accountId: "acct-1",
        researchFindingId: "fnd-1",
        status: "recorded",
        createdAt: "2026-01-04T00:00:00.000Z",
      },
    ],
    qualifications: [
      {
        id: "q-1",
        workspaceId: WORKSPACE,
        accountId: "acct-1",
        state: "qualified",
        version: 1,
        evidenceIds: ["ev-1"],
        createdAt: "2026-01-05T00:00:00.000Z",
      },
    ],
    drafts: [
      {
        id: "dr-1",
        workspaceId: WORKSPACE,
        accountId: "acct-1",
        qualificationId: "q-1",
        createdAt: "2026-01-05T01:00:00.000Z",
      },
    ],
    outbound: [
      {
        id: "oa-1",
        draftId: "dr-1",
        contactId: "ct-1",
        approvalId: "ap-1",
        createdAt: "2026-01-05T02:00:00.000Z",
      },
    ],
    inbound: [
      {
        id: "im-1",
        outboundActionId: "oa-1",
        contactId: "ct-1",
        createdAt: "2026-01-06T00:00:00.000Z",
      },
    ],
    classifications: [
      {
        id: "cc-1",
        intent: "positive_intent",
        outboundActionId: "oa-1",
        inboundMessageId: "im-1",
        createdAt: "2026-01-06T00:00:00.000Z",
      },
    ],
    meetings: [
      {
        id: "mt-1",
        workspaceId: WORKSPACE,
        accountId: "acct-1",
        title: "Intro call",
        state: "booked",
        contactId: "ct-1",
        classificationId: "cc-1",
        createdAt: "2026-01-07T00:00:00.000Z",
      },
    ],
  };
}

/**
 * A structural stand-in for the store: workspace-scoped lists with the same
 * filters the concrete repository applies, plus knobs for the failure cases.
 */
function lookup(options?: {
  rows?: Partial<LookupRows>;
  getAccountFails?: boolean;
  failingList?: string;
}): RevenueGraphLookup {
  const rows: LookupRows = { ...emptyRows(), ...(options?.rows ?? {}) };
  const result = <T>(name: string, value: T) => {
    if (options?.failingList === name) {
      return { ok: false as const, error: { code: "UNAVAILABLE", message: "lookup failed" } };
    }
    return { ok: true as const, value };
  };

  return {
    getAccount(id) {
      if (options?.getAccountFails === true) {
        return { ok: false, error: { code: "NOT_FOUND", message: "account not found" } };
      }
      const found = rows.accounts.find(
        (account) => account.id === id && account.workspaceId === WORKSPACE,
      );
      return found === undefined
        ? { ok: false, error: { code: "NOT_FOUND", message: "account not found" } }
        : { ok: true, value: found };
    },
    listContacts(_workspaceId, _userId, filter) {
      return result(
        "contacts",
        rows.contacts.filter((contact) => contact.accountId === filter?.accountId),
      );
    },
    listResearchFindings(_workspaceId, _userId, filter) {
      return result(
        "findings",
        rows.findings.filter((finding) => finding.accountId === filter?.accountId),
      );
    },
    listEvidence(_workspaceId, _userId, filter) {
      return result(
        "evidence",
        rows.evidence.filter((evidence) => evidence.accountId === filter?.accountId),
      );
    },
    listQualifications(_workspaceId, _userId, filter) {
      return result(
        "qualifications",
        rows.qualifications.filter((row) => row.accountId === filter?.accountId),
      );
    },
    listDrafts(_workspaceId, _userId, filter) {
      return result(
        "drafts",
        rows.drafts.filter((draft) => draft.accountId === filter?.accountId),
      );
    },
    listOutboundActions(_workspaceId, _userId, filter) {
      return result(
        "outbound",
        rows.outbound.filter((action) => action.contactId === filter?.contactId),
      );
    },
    listInboundMessages(_workspaceId, _userId, filter) {
      return result(
        "inbound",
        rows.inbound.filter((message) => message.contactId === filter?.contactId),
      );
    },
    listConversationClassifications(_workspaceId, _userId, filter) {
      return result(
        "classifications",
        rows.classifications.filter(
          (classification) => classification.outboundActionId === filter?.outboundActionId,
        ),
      );
    },
    listMeetings(_workspaceId, _userId, filter) {
      return result(
        "meetings",
        rows.meetings.filter((meeting) => meeting.accountId === filter?.accountId),
      );
    },
    listAccounts() {
      return result(
        "accounts",
        rows.accounts.map((account) => ({ id: account.id })),
      );
    },
  };
}

describe("store integration — the account graph reader", () => {
  it("assembles one account's snapshot from workspace-scoped lists", () => {
    const reader = createRevenueGraphReader(lookup({ rows: fullRows() }));
    const found = reader.accountGraph(WORKSPACE, "acct-1", USER);
    if (found === null) throw new Error("expected a snapshot");
    expect(found.account.id).toBe("acct-1");
    expect(found.contacts.map((row) => row.id)).toEqual(["ct-1"]);
    expect(found.classifications.map((row) => row.id)).toEqual(["cc-1"]);
    expect(found.meetings.map((row) => row.id)).toEqual(["mt-1"]);

    // And it derives into the full graph, lifecycle included.
    const graph = deriveAccountGraph(found);
    if (graph === null) throw new Error("expected a graph");
    expect(graph.lifecycle.opportunity).toBe("q-1");
    expect(graph.edges).toHaveLength(12);
  });

  it("refuses an account that does not exist or belongs to another workspace", () => {
    const rows = fullRows();
    const account = rows.accounts[0];
    if (account === undefined) throw new Error("fixture account missing");
    rows.accounts = [{ ...account, workspaceId: "ws-other" }];
    const reader = createRevenueGraphReader(lookup({ rows }));
    // The account resolves through storage with the caller's identity first,
    // and a foreign id is indistinguishable from one that never existed.
    expect(reader.accountGraph(WORKSPACE, "acct-1", USER)).toBeNull();

    const missing = createRevenueGraphReader(lookup({ rows: fullRows() }));
    expect(missing.accountGraph(WORKSPACE, "acct-none", USER)).toBeNull();
  });

  it("refuses the read when any list the graph needs fails", () => {
    for (const failingList of [
      "contacts",
      "findings",
      "evidence",
      "qualifications",
      "drafts",
      "meetings",
      "outbound",
      "inbound",
      "classifications",
    ]) {
      const reader = createRevenueGraphReader(lookup({ rows: fullRows(), failingList }));
      expect(reader.accountGraph(WORKSPACE, "acct-1", USER), failingList).toBeNull();
    }
  });

  it("refuses a reply lineage it cannot follow back to this account", () => {
    const rows = fullRows();
    const classification = rows.classifications[0];
    if (classification === undefined) throw new Error("fixture classification missing");
    rows.classifications = [{ ...classification, inboundMessageId: "im-ghost" }];
    const reader = createRevenueGraphReader(lookup({ rows }));
    expect(reader.accountGraph(WORKSPACE, "acct-1", USER)).toBeNull();
  });

  it("refuses an account whose getAccount fails", () => {
    const reader = createRevenueGraphReader(lookup({ rows: fullRows(), getAccountFails: true }));
    expect(reader.accountGraph(WORKSPACE, "acct-1", USER)).toBeNull();
  });
});

describe("store integration — the workspace account index", () => {
  it("lists the workspace's account ids", () => {
    const index = createRevenueGraphIndexReader(lookup({ rows: fullRows() }));
    expect(index.accountIds(WORKSPACE, USER)).toEqual(["acct-1"]);
  });

  it("reports a storage failure as null, never as an empty workspace", () => {
    const index = createRevenueGraphIndexReader(
      lookup({ rows: fullRows(), failingList: "accounts" }),
    );
    expect(index.accountIds(WORKSPACE, USER)).toBeNull();
  });
});
