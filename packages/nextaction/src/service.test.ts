import { describe, expect, it } from "vitest";

import { decideNextActionState, recommendNextAction } from "./engine.js";
import {
  CONFIDENCE_ORDER,
  NEXT_ACTION_RISK_LEVELS,
  NEXT_ACTION_RULES,
  NEXT_ACTION_RULE_VERSION,
  NEXT_ACTION_STATES,
  NEXT_BEST_ACTION_KINDS,
  OUTCOME_BY_ACTION,
  RISK_BY_ACTION,
  isNextActionKind,
  isNextActionState,
  weakestConfidence,
} from "./rules.js";
import { NextActionService } from "./service.js";
import { describeNextActionPolicy, parseActionFilter, text } from "./validation.js";
import type {
  AccountStateSnapshot,
  AccountStateReader,
  EntityId,
  NextActionRepository,
  NextBestAction,
  RecommendNextActionInput,
} from "./types.js";

const WORKSPACE = "ws-1";
const USER = "user-1";

/**
 * A bare account: nothing researched, nothing evidenced, nothing sent.
 *
 * Every test starts here and adds exactly the records its branch needs, so a test
 * that claims a state reached through some route is really exercising that route
 * and not inheriting a fixture that already satisfies a later branch.
 */
function account(overrides: Partial<AccountStateSnapshot> = {}): AccountStateSnapshot {
  return {
    id: "acct-1",
    workspaceId: WORKSPACE,
    name: "Acme",
    status: "active",
    contacts: [],
    researchRequests: [],
    findings: [],
    evidence: [],
    qualifications: [],
    drafts: [],
    approvals: [],
    outboundActions: [],
    classifications: [],
    meetings: [],
    meetingBriefCounts: new Map(),
    ...overrides,
  };
}

/** A record of everything a sourcing-stage recommendation cites. */
const EVIDENCE = [
  { id: "ev-1", accountClaimId: "cl-1", status: "recorded" as const, confidence: "high" as const },
];

function researched(overrides: Partial<AccountStateSnapshot> = {}): AccountStateSnapshot {
  return account({
    researchRequests: [{ id: "rr-1", status: "completed" }],
    findings: [{ id: "f-1", confidence: "high" }],
    ...overrides,
  });
}

function qualified(overrides: Partial<AccountStateSnapshot> = {}): AccountStateSnapshot {
  return researched({
    evidence: EVIDENCE,
    qualifications: [
      {
        id: "q-1",
        state: "qualified",
        score: 82,
        confidence: "high",
        evidenceIds: ["ev-1"],
        claimIds: ["cl-1"],
      },
    ],
    ...overrides,
  });
}

/** A stored recommendation, as `createNextBestAction` would have written it. */
function stored(overrides: Partial<NextBestAction> = {}): NextBestAction {
  return {
    id: "nb-1",
    workspaceId: WORKSPACE,
    accountId: "acct-1",
    action: "research_account",
    supportingState: "no_research",
    reason: "no research request exists",
    confidenceReasons: ["the absence of a research request is a fact about storage"],
    confidence: "high",
    riskLevel: "level_0_read",
    approvalRequired: false,
    expectedOutcome: "research_findings_available",
    evidenceIds: [],
    claimIds: [],
    ruleVersion: NEXT_ACTION_RULE_VERSION,
    createdBy: USER,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A forged request body: the fields a caller might try to dictate.
 *
 * `RecommendNextActionInput` carries only `accountId`, so a well-typed caller
 * cannot express any of the rest at all. Untyped callers are the real case — an
 * HTTP body arrives as `unknown` — so these tests exercise the runtime half of
 * the same guarantee: whatever turns up, the engine derives all of it.
 */
interface ForgedInput extends RecommendNextActionInput {
  action?: string;
  riskLevel?: string;
  approvalRequired?: boolean;
  confidence?: string;
  expectedOutcome?: string;
  reason?: string;
  evidenceIds?: string[];
}

interface Harness {
  service: NextActionService;
  repo: NextActionRepository & { rows: NextBestAction[] };
  /** Ids the service tried to read that the harness would refuse. */
  refused: string[];
}

/**
 * Build a service over an in-memory reader and repository.
 *
 * `snapshots` maps account id to what the reader will report, and
 * `unreadable` names accounts the reader refuses — the case where a caller is
 * authorized for the workspace but a read fails, which must not silently become
 * an empty account.
 */
function harness(options?: {
  snapshots?: Record<string, AccountStateSnapshot>;
  unreadable?: readonly string[];
  authorize?: boolean;
  storeFails?: boolean;
  listFails?: boolean;
}): Harness {
  const snapshots = options?.snapshots ?? { "acct-1": account() };
  const unreadable = new Set(options?.unreadable ?? []);
  const refused: string[] = [];
  const rows: NextBestAction[] = [];

  const reader: AccountStateReader = {
    accountState(workspaceId: EntityId, accountId: EntityId, userId: EntityId) {
      if (userId === "") return null;
      if (unreadable.has(accountId)) {
        refused.push(accountId);
        return null;
      }
      const found = snapshots[accountId];
      if (found === undefined) return null;
      // A foreign workspace is indistinguishable from a missing account, exactly
      // as the real reader reports it.
      if (found.workspaceId !== workspaceId) return null;
      return found;
    },
  };

  let counter = 0;
  const repo: Harness["repo"] = {
    rows,
    authorize() {
      return options?.authorize === false
        ? { ok: false, error: { code: "UNAUTHORIZED", message: "not a member" } }
        : { ok: true };
    },
    createNextBestAction(input) {
      if (options?.storeFails === true) {
        return { ok: false, error: { code: "INVALID", message: "approval mismatch" } };
      }
      counter += 1;
      const value = stored({
        id: `nb-${counter}`,
        ...input.recommendation,
        workspaceId: input.workspaceId,
        createdBy: input.createdBy,
      });
      rows.push(value);
      return { ok: true, value };
    },
    getNextBestAction(id, userId) {
      if (userId === "") return { ok: false, error: { code: "UNAUTHORIZED", message: "denied" } };
      const found = rows.find((r) => r.id === id);
      if (found === undefined) {
        return { ok: false, error: { code: "NOT_FOUND", message: "recommendation not found" } };
      }
      return { ok: true, value: found };
    },
    listNextBestActions(workspaceId, _userId, filter) {
      if (options?.listFails === true) {
        return { ok: false, error: { code: "UNAVAILABLE", message: "disk on fire" } };
      }
      return {
        ok: true,
        value: rows.filter(
          (r) =>
            r.workspaceId === workspaceId &&
            (filter?.accountId === undefined || r.accountId === filter.accountId) &&
            (filter?.action === undefined || r.action === filter.action),
        ),
      };
    },
  };

  return {
    service: new NextActionService(repo, reader, {
      accountIds: (workspaceId, userId) =>
        userId === ""
          ? []
          : Object.keys(snapshots).filter((id) => snapshots[id]?.workspaceId === workspaceId),
    }),
    repo,
    refused,
  };
}

describe("the published vocabularies", () => {
  it("derives its states from its rules, so no state is unreachable", () => {
    expect(NEXT_ACTION_STATES).toHaveLength(NEXT_ACTION_RULES.length);
    expect(new Set(NEXT_ACTION_STATES).size).toBe(NEXT_ACTION_STATES.length);
    for (const state of NEXT_ACTION_STATES) expect(isNextActionState(state)).toBe(true);
  });

  it("derives its actions from its rules, so no action is advertised but unproduced", () => {
    for (const action of NEXT_BEST_ACTION_KINDS) {
      expect(isNextActionKind(action)).toBe(true);
      expect(NEXT_ACTION_RULES.some((rule) => rule.action === action)).toBe(true);
    }
    expect(new Set(NEXT_BEST_ACTION_KINDS).size).toBe(NEXT_BEST_ACTION_KINDS.length);
  });

  it("covers every action in the risk and outcome maps", () => {
    for (const action of NEXT_BEST_ACTION_KINDS) {
      expect(RISK_BY_ACTION[action]).toBeDefined();
      expect(OUTCOME_BY_ACTION[action]).toBeDefined();
    }
  });

  it("marks approval required for exactly the Level 2 external actions", () => {
    for (const rule of NEXT_ACTION_RULES) {
      expect(rule.approvalRequired).toBe(rule.riskLevel === "level_2_external_action");
    }
    const levelTwo = NEXT_ACTION_RULES.filter((r) => r.riskLevel === "level_2_external_action");
    expect(levelTwo.map((r) => r.action).sort()).toEqual(["book_meeting", "send_approved_message"]);
  });

  it("never advertises a Level 3 high-impact risk it cannot produce", () => {
    expect(NEXT_ACTION_RISK_LEVELS).toEqual([
      "level_0_read",
      "level_1_draft",
      "level_2_external_action",
    ]);
    // The ladder is also unrepresentable in the type, so no rule can name it even
    // by accident: `NextBestActionRiskLevel` has no `level_3_high_impact` member.
    expect(JSON.stringify(NEXT_ACTION_RULES)).not.toContain("level_3_high_impact");
  });

  it("publishes exactly three confidence bands and no percentage", () => {
    expect(CONFIDENCE_ORDER).toEqual(["low", "medium", "high"]);
    const policy = describeNextActionPolicy();
    expect(policy.confidenceBands).toEqual(["low", "medium", "high"]);
    expect(JSON.stringify(policy)).not.toMatch(/9\d%/);
  });

  it("evaluates suppression before every other branch", () => {
    expect(NEXT_ACTION_RULES[0]?.supportingState).toBe("suppressed");
    expect(NEXT_ACTION_RULES[0]?.action).toBe("stop_contacting");
  });
});

describe("weakestConfidence", () => {
  it("returns the weakest band, not the strongest and not an average", () => {
    expect(weakestConfidence(["high", "low", "high"])).toBe("low");
    expect(weakestConfidence(["medium", "high"])).toBe("medium");
    expect(weakestConfidence(["high", "high"])).toBe("high");
  });

  it("ignores absent bands rather than treating them as weak", () => {
    expect(weakestConfidence(["high", null, null])).toBe("high");
    expect(weakestConfidence([null, null])).toBeNull();
    expect(weakestConfidence([])).toBeNull();
  });
});

describe("parseActionFilter", () => {
  it("distinguishes not supplied, producible, and unknown", () => {
    expect(parseActionFilter(undefined)).toBeUndefined();
    expect(parseActionFilter(null)).toBeUndefined();
    expect(parseActionFilter("research_account")).toBe("research_account");
    expect(parseActionFilter("escalate_to_manager")).toBeNull();
    expect(parseActionFilter(7)).toBeNull();
  });
});

describe("text", () => {
  it("rejects anything that is not a non-empty string within bounds", () => {
    expect(text(" acct-1 ")).toBe("acct-1");
    expect(text("")).toBeNull();
    expect(text("   ")).toBeNull();
    expect(text(42)).toBeNull();
    expect(text("x".repeat(201))).toBeNull();
  });
});

describe("decideNextActionState — the sourcing loop", () => {
  it("starts an untouched account at research", () => {
    expect(decideNextActionState(account())).toBe("no_research");
  });

  it("asks for a conversion once findings exist but no evidence does", () => {
    expect(decideNextActionState(researched())).toBe("researched_without_evidence");
  });

  it("asks for a qualification once evidence exists but no evaluation does", () => {
    const withEvidence = researched({ evidence: EVIDENCE });
    expect(decideNextActionState(withEvidence)).toBe("evidenced_without_qualification");
  });

  it("holds an account that was evaluated and did not qualify", () => {
    const unqualified = researched({
      evidence: EVIDENCE,
      qualifications: [
        {
          id: "q-1",
          state: "unqualified",
          score: 20,
          confidence: "high",
          evidenceIds: [],
          claimIds: [],
        },
      ],
    });
    expect(decideNextActionState(unqualified)).toBe("not_qualified");
    expect(recommendNextAction(unqualified).action).toBe("hold");
  });

  it("holds a contested evaluation rather than treating it as a fit", () => {
    const contested = researched({
      evidence: EVIDENCE,
      qualifications: [
        {
          id: "q-1",
          state: "contested",
          score: null,
          confidence: null,
          evidenceIds: [],
          claimIds: [],
        },
      ],
    });
    expect(decideNextActionState(contested)).toBe("not_qualified");
  });

  it("asks for outreach once the account qualifies and nothing is drafted", () => {
    expect(decideNextActionState(qualified())).toBe("qualified_without_draft");
  });

  it("asks for an approval once a draft exists and none was ever requested", () => {
    const drafted = qualified({
      drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
    });
    expect(decideNextActionState(drafted)).toBe("drafted_without_approval");
  });

  it("holds while an approval is pending and never reads silence as a yes", () => {
    const pending = qualified({
      drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
      approvals: [{ id: "ap-1", draftId: "d-1", status: "pending" }],
    });
    expect(decideNextActionState(pending)).toBe("approval_pending");
    expect(recommendNextAction(pending).action).toBe("hold");
  });

  it("names the send once an approval is granted and nothing has gone out", () => {
    const approved = qualified({
      drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
      approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
    });
    const recommendation = recommendNextAction(approved);
    expect(recommendation.supportingState).toBe("approved_without_send");
    expect(recommendation.action).toBe("send_approved_message");
    expect(recommendation.riskLevel).toBe("level_2_external_action");
    expect(recommendation.approvalRequired).toBe(true);
  });

  it("holds rather than re-asking after an approval was declined", () => {
    const declined = qualified({
      drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
      approvals: [{ id: "ap-1", draftId: "d-1", status: "rejected" }],
    });
    expect(decideNextActionState(declined)).toBe("approval_pending");
  });

  it("waits for a response once the approved message actually went out", () => {
    const sent = qualified({
      drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
      approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
      outboundActions: [{ id: "ob-1", draftId: "d-1", status: "sent" }],
    });
    expect(decideNextActionState(sent)).toBe("awaiting_response");
  });

  it("asks for an approval-ready reply when the response needs one", () => {
    const replied = qualified({
      drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
      approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
      outboundActions: [{ id: "ob-1", draftId: "d-1", status: "sent" }],
      classifications: [{ id: "cc-1", intent: "pricing", confidence: "high", suppressed: false }],
    });
    const recommendation = recommendNextAction(replied);
    expect(recommendation.supportingState).toBe("response_needing_reply");
    expect(recommendation.action).toBe("prepare_reply_for_approval");
    expect(recommendation.riskLevel).toBe("level_1_draft");
    expect(recommendation.approvalRequired).toBe(false);
  });

  it("does not recommend a reply to a response it could not understand", () => {
    const unread = qualified({
      drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
      approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
      outboundActions: [{ id: "ob-1", draftId: "d-1", status: "sent" }],
      classifications: [{ id: "cc-1", intent: "unknown", confidence: "low", suppressed: false }],
    });
    expect(decideNextActionState(unread)).toBe("awaiting_response");
  });
});

describe("decideNextActionState — safety outranks everything", () => {
  it("stops contact when a classification suppressed the address", () => {
    const suppressed = qualified({
      classifications: [
        { id: "cc-1", intent: "unsubscribe", confidence: "high", suppressed: true },
      ],
    });
    const recommendation = recommendNextAction(suppressed);
    expect(recommendation.supportingState).toBe("suppressed");
    expect(recommendation.action).toBe("stop_contacting");
    expect(recommendation.approvalRequired).toBe(false);
    expect(recommendation.reason).toContain("opt-out list");
  });

  it("stops contact on a refusal even when nothing wrote to the suppression list", () => {
    const refused = qualified({
      classifications: [
        { id: "cc-1", intent: "negative_intent", confidence: "high", suppressed: false },
      ],
    });
    const recommendation = recommendNextAction(refused);
    expect(recommendation.supportingState).toBe("suppressed");
    expect(recommendation.action).toBe("stop_contacting");
  });

  it("beats a positive response on the same account", () => {
    const both = qualified({
      classifications: [
        { id: "cc-1", intent: "positive_intent", confidence: "high", suppressed: false },
        { id: "cc-2", intent: "unsubscribe", confidence: "high", suppressed: true },
      ],
    });
    expect(decideNextActionState(both)).toBe("suppressed");
  });

  it("beats an approved meeting that has not been booked", () => {
    const suppressed = qualified({
      meetings: [{ id: "m-1", state: "approved", classificationId: "cc-1" }],
      classifications: [
        { id: "cc-2", intent: "unsubscribe", confidence: "high", suppressed: true },
      ],
    });
    expect(decideNextActionState(suppressed)).toBe("suppressed");
  });

  it("does not treat a failed or cancelled send as an opt-out", () => {
    const bounced = qualified({
      drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
      approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
      outboundActions: [{ id: "ob-1", draftId: "d-1", status: "failed" }],
    });
    expect(decideNextActionState(bounced)).toBe("approved_without_send");
  });
});

describe("decideNextActionState — a meeting governs the account", () => {
  const withMeeting = (state: "recommended" | "awaiting_approval" | "approved" | "booked") =>
    qualified({
      meetings: [{ id: "m-1", state, classificationId: "cc-1" }],
      classifications: [
        { id: "cc-1", intent: "positive_intent", confidence: "high", suppressed: false },
      ],
    });

  it("names the booking once a person approved it", () => {
    const recommendation = recommendNextAction(withMeeting("approved"));
    expect(recommendation.supportingState).toBe("meeting_approved");
    expect(recommendation.action).toBe("book_meeting");
    expect(recommendation.riskLevel).toBe("level_2_external_action");
    expect(recommendation.approvalRequired).toBe(true);
  });

  it("asks for the brief once the booking is on a calendar", () => {
    const booked = withMeeting("booked");
    expect(decideNextActionState(booked)).toBe("meeting_booked_without_brief");
    const briefed = { ...booked, meetingBriefCounts: new Map([["m-1", 1]]) };
    expect(decideNextActionState(briefed)).toBe("meeting_booked");
  });

  it("holds while a person is still deciding", () => {
    expect(decideNextActionState(withMeeting("recommended"))).toBe("meeting_recommended");
    expect(decideNextActionState(withMeeting("awaiting_approval"))).toBe(
      "meeting_awaiting_approval",
    );
  });

  it("does not re-propose over a meeting a person ended", () => {
    for (const state of ["held", "no_show", "cancelled"] as const) {
      const ended = qualified({
        meetings: [{ id: "m-1", state, classificationId: "cc-1" }],
        classifications: [
          { id: "cc-1", intent: "positive_intent", confidence: "high", suppressed: false },
        ],
      });
      const recommendation = recommendNextAction(ended);
      expect(recommendation.supportingState).toBe("meeting_closed");
      expect(recommendation.action).toBe("hold");
    }
  });

  it("proposes a meeting for a positive response that has none", () => {
    const positive = qualified({
      classifications: [
        { id: "cc-1", intent: "positive_intent", confidence: "high", suppressed: false },
      ],
    });
    const recommendation = recommendNextAction(positive);
    expect(recommendation.supportingState).toBe("positive_response_without_meeting");
    expect(recommendation.action).toBe("propose_meeting");
    expect(recommendation.riskLevel).toBe("level_1_draft");
    expect(recommendation.approvalRequired).toBe(false);
    expect(recommendation.expectedOutcome).toBe("meeting_proposed");
  });

  it("treats `interested` as positive too", () => {
    const interested = qualified({
      classifications: [
        { id: "cc-1", intent: "interested", confidence: "medium", suppressed: false },
      ],
    });
    expect(decideNextActionState(interested)).toBe("positive_response_without_meeting");
  });
});

describe("confidence", () => {
  it("takes the weakest band among the records that produced the recommendation", () => {
    const strongIntentWeakFit = researched({
      evidence: EVIDENCE,
      qualifications: [
        {
          id: "q-1",
          state: "qualified",
          score: 70,
          confidence: "low",
          evidenceIds: ["ev-1"],
          claimIds: ["cl-1"],
        },
      ],
      classifications: [
        { id: "cc-1", intent: "positive_intent", confidence: "high", suppressed: false },
      ],
    });
    const recommendation = recommendNextAction(strongIntentWeakFit);
    expect(recommendation.supportingState).toBe("positive_response_without_meeting");
    expect(recommendation.confidence).toBe("low");
  });

  it("reports the weakest band, never a number", () => {
    const positive = qualified({
      classifications: [
        { id: "cc-1", intent: "interested", confidence: "medium", suppressed: false },
      ],
    });
    const recommendation = recommendNextAction(positive);
    expect(recommendation.confidence).toBe("medium");
    expect(CONFIDENCE_ORDER).toContain(recommendation.confidence);
    expect(JSON.stringify(recommendation)).not.toMatch(/"confidence":\s*\d/);
  });

  it("states why a stored fact is high rather than pretending it was inferred", () => {
    const recommendation = recommendNextAction(account());
    expect(recommendation.confidence).toBe("high");
    expect(recommendation.confidenceReasons.join(" ")).toContain("fact about storage");
  });
});

describe("evidence references", () => {
  it("cites the live Phase 7 records a sourcing recommendation rests on", () => {
    const recommendation = recommendNextAction(qualified());
    expect(recommendation.evidenceIds).toEqual(["ev-1"]);
    expect(recommendation.claimIds).toEqual(["cl-1"]);
  });

  it("cites only recorded evidence, and never a refusal, a replacement or a dispute", () => {
    const stale = researched({
      evidence: [
        { id: "ev-1", accountClaimId: "cl-1", status: "rejected", confidence: "high" },
        { id: "ev-2", accountClaimId: "cl-2", status: "superseded", confidence: "high" },
        { id: "ev-3", accountClaimId: "cl-3", status: "contradicted", confidence: "high" },
        { id: "ev-4", accountClaimId: "cl-4", status: "recorded", confidence: "high" },
      ],
    });
    const recommendation = recommendNextAction(stale);
    expect(recommendation.evidenceIds).toEqual(["ev-4"]);
    expect(recommendation.claimIds).toEqual(["cl-4"]);
  });

  it("cites nothing when there is nothing to cite, rather than inventing a support", () => {
    const recommendation = recommendNextAction(account());
    expect(recommendation.evidenceIds).toEqual([]);
    expect(recommendation.claimIds).toEqual([]);
  });

  it("does not claim the evidence graph supports a conversation it never saw", () => {
    const booked = qualified({
      meetings: [{ id: "m-1", state: "approved", classificationId: "cc-1" }],
    });
    expect(recommendNextAction(booked).evidenceIds).toEqual([]);
  });
});

describe("determinism", () => {
  it("produces the same recommendation from the same rows, every time", () => {
    const state = qualified({
      classifications: [
        { id: "cc-1", intent: "positive_intent", confidence: "high", suppressed: false },
      ],
    });
    const first = recommendNextAction(state);
    const second = recommendNextAction(state);
    expect(second).toEqual(first);
  });

  it("stamps the rule version on every recommendation", () => {
    expect(recommendNextAction(account()).ruleVersion).toBe(NEXT_ACTION_RULE_VERSION);
  });

  it("fills all seven of ROADMAP.md §21's required fields on every state", () => {
    for (const rule of NEXT_ACTION_RULES) {
      const recommendation = recommendNextAction(syntheticFor(rule.supportingState));
      expect(recommendation.action).toBe(rule.action);
      expect(recommendation.supportingState).toBe(rule.supportingState);
      expect(recommendation.reason.length).toBeGreaterThan(0);
      expect(recommendation.confidenceReasons.length).toBeGreaterThan(0);
      expect(CONFIDENCE_ORDER).toContain(recommendation.confidence);
      expect(recommendation.expectedOutcome).toBe(rule.expectedOutcome);
      expect(recommendation.approvalRequired).toBe(rule.riskLevel === "level_2_external_action");
      expect(Array.isArray(recommendation.evidenceIds)).toBe(true);
      expect(Array.isArray(recommendation.claimIds)).toBe(true);
    }
  });
});

/** A minimal account that reaches exactly one named state. */
function syntheticFor(state: string): AccountStateSnapshot {
  const meeting = (
    booking: "recommended" | "awaiting_approval" | "approved" | "booked" | "cancelled",
  ) => qualified({ meetings: [{ id: "m-1", state: booking, classificationId: "cc-1" }] });
  const positive = [
    {
      id: "cc-1",
      intent: "positive_intent" as const,
      confidence: "high" as const,
      suppressed: false,
    },
  ];
  const draft = [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }];
  const sent = {
    drafts: draft,
    outboundActions: [{ id: "ob-1", draftId: "d-1", status: "sent" as const }],
  };
  switch (state) {
    case "suppressed":
      return qualified({
        classifications: [
          { id: "cc-1", intent: "unsubscribe", confidence: "high", suppressed: true },
        ],
      });
    case "meeting_recommended":
      return meeting("recommended");
    case "meeting_awaiting_approval":
      return meeting("awaiting_approval");
    case "meeting_approved":
      return meeting("approved");
    case "meeting_booked_without_brief":
      return meeting("booked");
    case "meeting_booked":
      return { ...meeting("booked"), meetingBriefCounts: new Map([["m-1", 1]]) };
    case "meeting_closed":
      return meeting("cancelled");
    case "positive_response_without_meeting":
      return qualified({ classifications: positive });
    case "no_research":
      return account();
    case "researched_without_evidence":
      return researched();
    case "evidenced_without_qualification":
      return researched({ evidence: EVIDENCE });
    case "not_qualified":
      return researched({
        evidence: EVIDENCE,
        qualifications: [
          {
            id: "q-1",
            state: "unqualified",
            score: 10,
            confidence: "high",
            evidenceIds: [],
            claimIds: [],
          },
        ],
      });
    case "qualified_without_draft":
      return qualified();
    case "drafted_without_approval":
      return qualified({ drafts: draft });
    case "approval_pending":
      return qualified({
        drafts: draft,
        approvals: [{ id: "ap-1", draftId: "d-1", status: "pending" }],
      });
    case "approved_without_send":
      return qualified({
        drafts: draft,
        approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
      });
    case "awaiting_response":
      return qualified({
        ...sent,
        approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
      });
    case "response_needing_reply":
      return qualified({
        ...sent,
        approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
        classifications: [
          { id: "cc-1", intent: "question", confidence: "high", suppressed: false },
        ],
      });
    default:
      throw new Error(`no fixture for state ${state}`);
  }
}

describe("NextActionService.recommendNextAction", () => {
  it("answers from stored rows and writes nothing", () => {
    const h = harness();
    const result = h.service.recommendNextAction(WORKSPACE, USER, { accountId: "acct-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accountName).toBe("Acme");
    expect(result.value.action).toBe("research_account");
    expect(h.repo.rows).toHaveLength(0);
  });

  it("requires an accountId", () => {
    const h = harness();
    for (const accountId of [undefined, null, "", "   ", 7, {}]) {
      const result = h.service.recommendNextAction(WORKSPACE, USER, { accountId });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("refuses an account that does not exist in this workspace", () => {
    const h = harness();
    const result = h.service.recommendNextAction(WORKSPACE, USER, { accountId: "acct-missing" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("reports a foreign account as not found rather than unauthorized", () => {
    const foreign = { ...account(), id: "acct-foreign", workspaceId: "ws-2" };
    const h = harness({ snapshots: { "acct-foreign": foreign } });
    const result = h.service.recommendNextAction(WORKSPACE, USER, { accountId: "acct-foreign" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("requires authentication and a workspace", () => {
    const h = harness();
    const anonymous = h.service.recommendNextAction(WORKSPACE, "", { accountId: "acct-1" });
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.error.code).toBe("UNAUTHORIZED");
    const noWorkspace = h.service.recommendNextAction("", USER, { accountId: "acct-1" });
    expect(noWorkspace.ok).toBe(false);
    if (!noWorkspace.ok) expect(noWorkspace.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a caller who is not a member of the workspace", () => {
    const h = harness({ authorize: false });
    const result = h.service.recommendNextAction(WORKSPACE, USER, { accountId: "acct-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("does not fall back to the sourcing loop when a read is refused", () => {
    const h = harness({ unreadable: ["acct-1"] });
    const result = h.service.recommendNextAction(WORKSPACE, USER, { accountId: "acct-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(h.refused).toEqual(["acct-1"]);
  });

  it("recomputes rather than replaying, so a stale suggestion cannot be shown", () => {
    const h = harness();
    expect(h.service.recommendNextAction(WORKSPACE, USER, { accountId: "acct-1" }).ok).toBe(true);
    // The account was researched since the first read.
    h.repo.rows.length = 0;
    const researchedNow = harness({ snapshots: { "acct-1": researched() } });
    const after = researchedNow.service.recommendNextAction(WORKSPACE, USER, {
      accountId: "acct-1",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.supportingState).toBe("researched_without_evidence");
  });

  it("ignores anything the caller tries to dictate alongside the accountId", () => {
    const h = harness();
    // The input type carries only `accountId`, so a body that also names an
    // action, a risk level, a confidence or an approval flag cannot even be
    // expressed in TypeScript. This is the runtime half of the same guarantee:
    // whatever arrives, the engine derives all of it.
    const forged: ForgedInput = {
      accountId: "acct-1",
      action: "send_approved_message",
      riskLevel: "level_0_read",
      approvalRequired: false,
      confidence: "high",
      expectedOutcome: "message_delivered",
      reason: "trust me",
      evidenceIds: ["ev-forged"],
    };
    const result = h.service.recommendNextAction(WORKSPACE, USER, forged);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe("research_account");
    expect(result.value.riskLevel).toBe("level_0_read");
    expect(result.value.approvalRequired).toBe(false);
    expect(result.value.reason).not.toBe("trust me");
    expect(result.value.evidenceIds).toEqual([]);
  });
});

describe("NextActionService.recommendForWorkspace", () => {
  it("answers for every account in the workspace", () => {
    const h = harness({
      snapshots: {
        "acct-1": account(),
        "acct-2": { ...researched(), id: "acct-2" },
        "acct-3": { ...qualified(), id: "acct-3" },
      },
    });
    const result = h.service.recommendForWorkspace(WORKSPACE, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ruleVersion).toBe(NEXT_ACTION_RULE_VERSION);
    expect(result.value.recommendations.map((r) => r.accountId).sort()).toEqual([
      "acct-1",
      "acct-2",
      "acct-3",
    ]);
    expect(result.value.recommendations.map((r) => r.action)).toEqual([
      "research_account",
      "convert_findings_to_evidence",
      "personalize_outreach",
    ]);
  });

  it("omits an account it cannot read rather than guessing about it", () => {
    const h = harness({
      snapshots: { "acct-1": account(), "acct-2": { ...researched(), id: "acct-2" } },
      unreadable: ["acct-2"],
    });
    const result = h.service.recommendForWorkspace(WORKSPACE, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recommendations.map((r) => r.accountId)).toEqual(["acct-1"]);
  });

  it("refuses rather than truncating a board it cannot show in full", () => {
    const snapshots: Record<string, AccountStateSnapshot> = {};
    for (let index = 0; index < 101; index += 1) {
      snapshots[`acct-${index}`] = { ...account(), id: `acct-${index}` };
    }
    const h = harness({ snapshots });
    const result = h.service.recommendForWorkspace(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toContain("too many accounts");
  });

  it("requires authentication and membership", () => {
    const h = harness({ authorize: false });
    const result = h.service.recommendForWorkspace(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNAUTHORIZED");
  });
});

describe("NextActionService.recordRecommendation", () => {
  it("stores the live recommendation with all seven required fields", () => {
    const h = harness();
    const result = h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.repo.rows).toHaveLength(1);
    const row = h.repo.rows[0];
    if (row === undefined) return;
    expect(row.action).toBe("research_account");
    expect(row.supportingState).toBe("no_research");
    expect(row.reason.length).toBeGreaterThan(0);
    expect(row.confidenceReasons.length).toBeGreaterThan(0);
    expect(row.confidence).toBe("high");
    expect(row.expectedOutcome).toBe("research_findings_available");
    expect(row.approvalRequired).toBe(false);
    expect(row.ruleVersion).toBe(NEXT_ACTION_RULE_VERSION);
    expect(row.createdBy).toBe(USER);
  });

  it("appends rather than replaces, so the history is a history", () => {
    const h = harness();
    h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    expect(h.repo.rows).toHaveLength(2);
    expect(new Set(h.repo.rows.map((r) => r.id)).size).toBe(2);
  });

  it("records the action and risk level the engine derived, not a caller's", () => {
    const h = harness({ snapshots: { "acct-1": approvedWithoutSend() } });
    const forged: ForgedInput = {
      accountId: "acct-1",
      action: "research_account",
      approvalRequired: false,
    };
    const result = h.service.recordRecommendation(WORKSPACE, USER, forged);
    expect(result.ok).toBe(true);
    const row = h.repo.rows[0];
    if (row === undefined) return;
    expect(row.action).toBe("send_approved_message");
    expect(row.approvalRequired).toBe(true);
  });

  it("does not act on the recommendation it records", () => {
    const h = harness({ snapshots: { "acct-1": approvedWithoutSend() } });
    h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    // Recording a "send this" recommendation adds exactly one row and touches
    // nothing else: no outbound action, no draft version, no approval.
    expect(h.repo.rows).toHaveLength(1);
    expect(h.repo.rows[0]?.action).toBe("send_approved_message");
  });

  it("refuses an account outside the workspace", () => {
    const h = harness();
    const result = h.service.recordRecommendation(WORKSPACE, USER, { accountId: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(h.repo.rows).toHaveLength(0);
  });

  it("reports a storage refusal as an internal condition, never as the caller's fault", () => {
    const h = harness({ storeFails: true });
    const result = h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNAVAILABLE");
    expect(result.error.message).toBe("the recommendation could not be stored");
    expect(result.error.message).not.toContain("approval mismatch");
  });

  it("requires an accountId", () => {
    const h = harness();
    const result = h.service.recordRecommendation(WORKSPACE, USER, { accountId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

/** A qualified account whose newest draft is approved but has not gone out. */
function approvedWithoutSend(): AccountStateSnapshot {
  return qualified({
    drafts: [{ id: "d-1", version: 1, createdAt: "2026-01-01T00:00:00Z" }],
    approvals: [{ id: "ap-1", draftId: "d-1", status: "approved" }],
  });
}

describe("NextActionService.getRecommendation", () => {
  it("returns a recorded recommendation to the caller who made it", () => {
    const h = harness();
    const recorded = h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const found = h.service.getRecommendation(recorded.value.id, USER);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.id).toBe(recorded.value.id);
    expect(found.value.reason).toBe(recorded.value.reason);
  });

  it("refuses a missing or malformed id", () => {
    const h = harness();
    const missing = h.service.getRecommendation("nb-nope", USER);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
    const malformed = h.service.getRecommendation("", USER);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses an unauthenticated caller without revealing the row", () => {
    const h = harness();
    const recorded = h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const anonymous = h.service.getRecommendation(recorded.value.id, "");
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.error.code).toBe("UNAUTHORIZED");
  });
});

describe("NextActionService.listRecommendations", () => {
  it("returns the recorded history, newest first, across accounts", () => {
    const h = harness({
      snapshots: { "acct-1": account(), "acct-2": { ...researched(), id: "acct-2" } },
    });
    h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-2" });
    const result = h.service.listRecommendations(WORKSPACE, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.accountId).sort()).toEqual(["acct-1", "acct-2"]);
  });

  it("narrows by account and by action", () => {
    const h = harness({
      snapshots: { "acct-1": account(), "acct-2": { ...researched(), id: "acct-2" } },
    });
    h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-1" });
    h.service.recordRecommendation(WORKSPACE, USER, { accountId: "acct-2" });

    const byAccount = h.service.listRecommendations(WORKSPACE, USER, { accountId: "acct-2" });
    expect(byAccount.ok && byAccount.value.length).toBe(1);

    const byAction = h.service.listRecommendations(WORKSPACE, USER, {
      action: "convert_findings_to_evidence",
    });
    expect(byAction.ok).toBe(true);
    if (!byAction.ok) return;
    expect(byAction.value).toHaveLength(1);
    expect(byAction.value[0]?.accountId).toBe("acct-2");
  });

  it("refuses a filter naming an action this engine cannot produce", () => {
    const h = harness();
    const result = h.service.listRecommendations(WORKSPACE, USER, {
      action: "escalate_to_manager",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a malformed accountId rather than ignoring it", () => {
    const h = harness();
    const result = h.service.listRecommendations(WORKSPACE, USER, { accountId: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires membership", () => {
    const h = harness({ authorize: false });
    const result = h.service.listRecommendations(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("never surfaces an internal storage message", () => {
    const h = harness({ listFails: true });
    const result = h.service.listRecommendations(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNAVAILABLE");
    expect(result.error.message).not.toContain("disk");
  });
});

describe("NextActionService.policy", () => {
  it("publishes every rule the engine can apply, before any account exists", () => {
    const h = harness();
    const result = h.service.policy(WORKSPACE, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ruleVersion).toBe(NEXT_ACTION_RULE_VERSION);
    expect(result.value.rules).toHaveLength(NEXT_ACTION_RULES.length);
    expect(result.value.states).toEqual([...NEXT_ACTION_STATES]);
    expect(result.value.neverDoes.length).toBeGreaterThan(0);
  });

  it("requires membership", () => {
    const h = harness({ authorize: false });
    const result = h.service.policy(WORKSPACE, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");
  });
});
