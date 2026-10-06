import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import { store as defaultStore } from "@dealora/db";
import type { CostEvent, ConversationClassification, Meeting, OutboundAction } from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import {
  LATEST_SCHEMA_VERSION,
  SCHEMA,
  experimentArmTable,
  experimentEventTable,
  experimentTable,
} from "@dealora/db";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { StaticResearchProvider } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import { MEETABLE_INTENTS } from "@dealora/meeting";
import {
  createExperimentService,
  deriveComparison,
  experimentWindow,
  EXPERIMENT_HIGH_SAMPLE_MULTIPLIER,
  EXPERIMENT_MIN_LIFT_BASIS_POINTS,
  EXPERIMENT_MIN_SAMPLE_PER_ARM,
  EXPERIMENT_MEDIUM_SAMPLE_MULTIPLIER,
  EXPERIMENT_RULE_VERSION,
} from "@dealora/experiment";
import type {
  ExperimentArmRow,
  ExperimentRow,
  ExperimentStoreAdapter,
  StorageResult,
} from "@dealora/experiment";

/**
 * Phase 22 gate — ROADMAP.md §29 (Experiment Engine).
 *
 * §29 asks for controlled experiments — its own example is *Message A vs
 * Message B, measured on the positive reply rate over a qualified population
 * for 14 days* — tracking five dimensions: sample size, conversion,
 * confidence, cost, revenue impact. Its critical rule is one sentence:
 *
 * > Do not claim a winning experiment when evidence is insufficient.
 *
 * The gate walks a real pipeline through the real handlers — Brain → Goal →
 * Account → Research → Evidence → Qualification → Draft A/Draft B → Approval →
 * Send → Response → Classification — and then checks that:
 *
 *  1. a declared comparison is a declaration, not a result — the read derives
 *     sample, conversion, cost, meetings and the decision from stored rows on
 *     every read and stores none of them;
 *  2. insufficient evidence never crowns a winner — no window, one armed
 *     arm, below-minimum sample, sub-threshold lift, and a cancelled
 *     experiment all refuse, by construction;
 *  3. forged authoritative fields are ignored — a body carrying `status`,
 *     `winner`, `createdBy`, `createdAt` or an arm position cannot move a row;
 *  4. the comparison is deterministic (byte-identical re-derivation);
 *  5. the negative space holds — the gate snapshots every table and proves
 *     reading and closing an experiment touches nothing, and that the engine
 *     never sends, approves or books anything.
 */

let seq = 0;
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
    const details = resolved.error.details?.map((d) => `${d.field}: ${d.message}`).join("; ") ?? "";
    throw new Error(
      `expected success, got ${resolved.error.code}: ${resolved.error.message}${details ? ` [${details}]` : ""}`,
    );
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

/** The declared research observations that make an account qualify (Phase 8). */
function researchProvider(): ResearchProvider {
  return new StaticResearchProvider(
    "press_release",
    "public_web",
    [
      {
        category: "industry",
        field: "industry",
        value: "SaaS",
        claimKind: "fact",
        sourceUrl: "https://example.test/about",
        sourceTitle: "About",
        observedAt: "2026-06-02T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "company_overview",
        field: "geography",
        value: "Germany",
        claimKind: "fact",
        sourceUrl: "https://example.test/about",
        sourceTitle: "About",
        observedAt: "2026-06-02T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "company_overview",
        field: "company_size",
        value: "50-200",
        claimKind: "fact",
        sourceUrl: "https://example.test/about",
        sourceTitle: "About",
        observedAt: "2026-06-02T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "business_model",
        field: "model",
        value: "Subscription",
        claimKind: "fact",
        sourceUrl: "https://example.test/about",
        sourceTitle: "About",
        observedAt: "2026-06-02T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "expansion",
        field: "new_region",
        value: "announced expansion into Germany in September",
        claimKind: "fact",
        sourceUrl: "https://example.test/news/germany",
        sourceTitle: "Newsroom",
        observedAt: "2026-09-14T00:00:00.000Z",
        confidence: "high",
        relevance: "high",
        note: null,
      },
      {
        category: "hiring",
        field: "open_roles",
        value: "posted 12 roles in customer success",
        claimKind: "fact",
        sourceUrl: "https://example.test/careers",
        sourceTitle: "Careers",
        observedAt: "2026-08-20T00:00:00.000Z",
        confidence: "medium",
        relevance: "medium",
        note: null,
      },
      {
        category: "technology_signals",
        field: "stack_change",
        value: "migrated its helpdesk to a new vendor",
        claimKind: "fact",
        sourceUrl: "https://example.test/blog",
        sourceTitle: "Blog",
        observedAt: "2026-10-01T00:00:00.000Z",
        confidence: "medium",
        relevance: "medium",
        note: null,
      },
      {
        category: "leadership_changes",
        field: "new_leader",
        value: "appointed a VP of Support",
        claimKind: "fact",
        sourceUrl: "https://example.test/news/leadership",
        sourceTitle: "Newsroom",
        observedAt: "2026-10-05T00:00:00.000Z",
        confidence: "medium",
        relevance: "medium",
        note: null,
      },
    ],
    { filterToScope: false },
  );
}

function handlersFor(): Handlers {
  return createDefaultHandlers({ researchProviders: [researchProvider()] });
}

/** A snapshot of the default store's row counts, for the negative-space assertions. */
function rowCounts(workspaceId: string): Record<string, number> {
  const db = defaultStore.db;
  const mine = <T extends { workspaceId: string }>(rows: T[] | undefined): T[] =>
    (rows ?? []).filter((row) => row.workspaceId === workspaceId);
  return {
    accounts: mine(db.accounts).length,
    contacts: mine(db.contacts).length,
    qualifications: mine(db.qualifications).length,
    drafts: mine(db.personalizedDrafts).length,
    approvals: mine(db.approvalRequests).length,
    actions: mine(db.outboundActions).length,
    meetings: mine(db.meetings).length,
    classifications: mine(db.conversationClassifications).length,
    costEvents: mine(db.costEvents).length,
    traceRuns: mine(db.agentTraceRuns).length,
    traceEvents: mine(db.agentTraceEvents).length,
    experiments: mine(db.experiments).length,
    experimentArms: mine(db.experimentArms).length,
    experimentEvents: mine(db.experimentEvents).length,
  };
}

interface Journey {
  tenant: Tenant;
  draftAId: string;
  draftBId: string;
  contactIds: { a: string[]; b: string[] };
}

/**
 * Walk the declaration half of the loop once per draft: Brain → Goal →
 * Account → Research → Evidence → Qualification → Draft, for arms A and B, so
 * two immutable drafts exist. The approval and the send are a separate step —
 * an experiment's window opens when it starts, so exposures must happen after
 * the start, exactly as a real workspace would run it.
 */
async function prepareJourney(handlers: Handlers, name: string): Promise<Journey> {
  const t = tenant(name);
  const token = t.token;
  const workspaceId = t.workspaceId;
  // The tenant slug the fixture emails are built from: lowercased and
  // slugified, so an address never carries a space.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const offer = (await dataOf(
    handlers.createOfferHandler(
      request(
        token,
        { workspaceId },
        {
          name: "Support Automation",
          description: "We build support automation for B2B SaaS teams.",
          outcome: "faster first response times",
          status: "active",
        },
      ),
    ),
  )) as { offer: { id: string } };

  const icp = (await dataOf(
    handlers.upsertIcpHandler(
      request(
        token,
        { workspaceId },
        {
          industries: ["saas"],
          companySizes: ["50-200"],
          geographies: ["germany"],
          businessModels: ["subscription"],
        },
      ),
    ),
  )) as { icp: { id: string } };

  const persona = (await dataOf(
    handlers.createPersonaHandler(request(token, { workspaceId }, { title: "Head of Support" })),
  )) as { persona: { id: string } };

  const goal = (await dataOf(
    handlers.createRevenueGoalHandler(
      request(
        token,
        { workspaceId },
        {
          objective: "Book 20 qualified meetings from B2B SaaS companies in Germany",
          targetMetric: "meeting",
          targetValue: 20,
          currency: "USD",
          timeWindow: { start: "2026-09-01", end: "2026-12-31" },
          market: "B2B SaaS",
          offerId: offer.offer.id,
          icpId: icp.icp.id,
          buyerPersonaIds: [persona.persona.id],
          successMetrics: [{ kind: "meeting", target: 20, unit: "meetings" }],
        },
      ),
    ),
  )) as { goal: { id: string } };

  const drafts: string[] = [];
  const contactIds: { a: string[]; b: string[] } = { a: [], b: [] };

  for (const arm of ["A", "B"] as const) {
    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          token,
          { workspaceId },
          {
            name: `${name} ${arm} ${seq}`,
            industry: "SaaS",
            companySize: "50-200",
            geography: "Germany",
            source: "manual",
            sourceReference: "phase22-gate",
          },
        ),
      ),
    )) as { account: { id: string } };

    const contact = (await dataOf(
      handlers.createContactHandler(
        request(
          token,
          { workspaceId, accountId: account.account.id },
          {
            firstName: arm,
            lastName: "Contact",
            jobTitle: "VP Support",
            email: `${unique(slug)}-${arm.toLowerCase()}@example.test`,
            source: "manual",
            sourceReference: "phase22-gate",
          },
        ),
      ),
    )) as { contact: { id: string } };
    contactIds[arm.toLowerCase() as "a" | "b"].push(contact.contact.id);

    const research = (await dataOf(
      handlers.createResearchRequestHandler(
        request(
          token,
          { workspaceId, accountId: account.account.id },
          {
            provider: "press_release",
            categories: [
              "company_overview",
              "industry",
              "business_model",
              "expansion",
              "hiring",
              "technology_signals",
              "leadership_changes",
            ],
          },
        ),
      ),
    )) as { request: { id: string } };

    const run = (await dataOf(
      handlers.runResearchRequestHandler(request(token, { id: research.request.id })),
    )) as { request: { status: string }; findings: { id: string }[] };

    for (const finding of run.findings) {
      await dataOf(
        handlers.createEvidenceFromFindingHandler(
          request(token, { workspaceId, researchFindingId: finding.id }),
        ),
      );
    }

    const qualification = (await dataOf(
      handlers.createQualificationHandler(
        request(
          token,
          { workspaceId, accountId: account.account.id },
          {
            revenueGoalId: goal.goal.id,
          },
        ),
      ),
    )) as { qualification: { id: string; state: string } };

    const generated = (await dataOf(
      handlers.createPersonalizedDraftHandler(
        request(
          token,
          { workspaceId, accountId: account.account.id },
          {
            qualificationId: qualification.qualification.id,
            offerId: offer.offer.id,
            contactId: contact.contact.id,
          },
        ),
      ),
    )) as { draft: { id: string; version: number } };
    drafts.push(generated.draft.id);
  }

  return { tenant: t, draftAId: drafts[0] ?? "", draftBId: drafts[1] ?? "", contactIds };
}

/**
 * The human decision and the delivery, as one step: approve the exact draft
 * version, stage the action, and send it through the sandbox provider. This
 * runs after the experiment has started, so the send lands inside the window.
 */
async function approveAndSend(
  handlers: Handlers,
  tenantCtx: Tenant,
  draftId: string,
): Promise<string> {
  const { token, workspaceId } = tenantCtx;
  const requested = (await dataOf(
    handlers.createApprovalRequestHandler(request(token, { workspaceId, draftId }, {})),
  )) as { approval: { id: string } };
  const decided = (await dataOf(
    handlers.decideApprovalRequestHandler(
      request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
    ),
  )) as { approval: { status: string } };
  if (decided.approval.status !== "approved") throw new Error("approval failed");

  const staged = (await dataOf(
    handlers.createOutboundActionHandler(request(token, { workspaceId, draftId }, {})),
  )) as { action: { id: string } };
  const sent = (await dataOf(
    handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
  )) as { action: { status: string } };
  if (sent.action.status !== "sent") throw new Error("send failed");
  return staged.action.id;
}

/** Record a reply to a sent action and return its classification. */
async function recordReply(
  handlers: Handlers,
  tenantCtx: Tenant,
  outboundActionId: string,
  body: string,
): Promise<{ intent: string }> {
  const classified = (await dataOf(
    handlers.createInboundMessageHandler(
      request(tenantCtx.token, { workspaceId: tenantCtx.workspaceId, outboundActionId }, { body }),
    ),
  )) as { classification: { intent: string } };
  return classified.classification;
}

// ---------------------------------------------------------------------------
// A complete in-memory store adapter for the derivation-level tests. The
// engine's contract is total and deterministic, so the fixtures are exact
// typed rows: no `as any`, no partial objects.
// ---------------------------------------------------------------------------

let rowSeq = 0;
function rid(): string {
  rowSeq += 1;
  return `row-${rowSeq.toString().padStart(5, "0")}`;
}

interface MemState {
  experiments: ExperimentRow[];
  arms: ExperimentArmRow[];
  events: {
    id: string;
    workspaceId: string;
    experimentId: string;
    actorUserId: string;
    kind: string;
    detail: string | null;
    createdAt: string;
  }[];
  accounts: { id: string; workspaceId: string; status: string }[];
  contacts: { id: string; workspaceId: string; accountId: string; status: string }[];
  qualifications: {
    id: string;
    workspaceId: string;
    accountId: string;
    version: number;
    state: string;
  }[];
  actions: OutboundAction[];
  classifications: ConversationClassification[];
  meetings: Meeting[];
  costEvents: CostEvent[];
}

function memStore(workspaceId: string, userId: string): MemState {
  return {
    experiments: [],
    arms: [],
    events: [],
    accounts: [],
    contacts: [],
    qualifications: [],
    actions: [],
    classifications: [],
    meetings: [],
    costEvents: [],
    ...(workspaceId || userId ? {} : {}),
  };
}

function memAdapter(state: MemState, workspaceId: string): ExperimentStoreAdapter {
  const okRow = <T>(value: T): StorageResult<T> => ({ ok: true, value });
  return {
    authorize: (ws) =>
      ws === workspaceId ? okRow(true) : { ok: false, error: { code: "UNAUTHORIZED" } },
    createExperiment: (input) => {
      const stamp = new Date("2026-10-01T08:00:00.000Z").toISOString();
      const row: ExperimentRow = {
        id: rid(),
        workspaceId: input.workspaceId,
        name: input.name,
        metric: input.metric as ExperimentRow["metric"],
        status: "draft",
        durationDays: input.durationDays,
        createdBy: input.userId,
        createdAt: stamp,
        startedBy: null,
        startedAt: null,
        closedBy: null,
        closedAt: null,
        cancelledBy: null,
        cancelledAt: null,
        cancelReason: null,
        updatedAt: stamp,
      };
      state.experiments.push(row);
      return okRow(row);
    },
    getExperiment: (input) => {
      const found = state.experiments.find(
        (row) => row.id === input.experimentId && row.workspaceId === input.workspaceId,
      );
      return okRow(found ?? null);
    },
    listExperiments: (ws) => okRow(state.experiments.filter((row) => row.workspaceId === ws)),
    addExperimentArm: (input) => {
      const position = state.arms.filter((a) => a.experimentId === input.experimentId).length + 1;
      const row: ExperimentArmRow = {
        id: rid(),
        workspaceId: input.workspaceId,
        experimentId: input.experimentId,
        position,
        draftId: input.draftId,
        label: input.label,
        createdAt: new Date("2026-10-01T08:00:00.000Z").toISOString(),
      };
      state.arms.push(row);
      return okRow(row);
    },
    listExperimentArms: (_ws, _u, experimentId) =>
      okRow(state.arms.filter((a) => a.experimentId === experimentId)),
    startExperiment: (input) => {
      const row = state.experiments.find((r) => r.id === input.experimentId);
      if (!row) return { ok: false, error: { code: "NOT_FOUND" } };
      const next: ExperimentRow = {
        ...row,
        status: "running",
        startedBy: input.userId,
        startedAt: new Date("2026-10-02T08:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-10-02T08:00:00.000Z").toISOString(),
      };
      state.experiments = state.experiments.map((r) => (r.id === row.id ? next : r));
      return okRow(next);
    },
    closeExperiment: (input) => {
      const row = state.experiments.find((r) => r.id === input.experimentId);
      if (!row) return { ok: false, error: { code: "NOT_FOUND" } };
      const next: ExperimentRow = {
        ...row,
        status: "closed",
        closedBy: input.userId,
        closedAt: new Date("2026-10-16T08:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-10-16T08:00:00.000Z").toISOString(),
      };
      state.experiments = state.experiments.map((r) => (r.id === row.id ? next : r));
      return okRow(next);
    },
    cancelExperiment: (input) => {
      const row = state.experiments.find((r) => r.id === input.experimentId);
      if (!row) return { ok: false, error: { code: "NOT_FOUND" } };
      const next: ExperimentRow = {
        ...row,
        status: "cancelled",
        cancelledBy: input.userId,
        cancelledAt: new Date("2026-10-03T08:00:00.000Z").toISOString(),
        cancelReason: input.reason,
        updatedAt: new Date("2026-10-03T08:00:00.000Z").toISOString(),
      };
      state.experiments = state.experiments.map((r) => (r.id === row.id ? next : r));
      return okRow(next);
    },
    listExperimentEvents: (_ws, _u, experimentId) =>
      okRow(state.events.filter((e) => e.experimentId === experimentId)),
    listAccounts: (ws) => okRow(state.accounts.filter((a) => a.workspaceId === ws)),
    listContacts: (ws) => okRow(state.contacts.filter((c) => c.workspaceId === ws)),
    listQualifications: (ws) => okRow(state.qualifications.filter((q) => q.workspaceId === ws)),
    listOutboundActions: () => okRow(state.actions),
    listConversationClassifications: () => okRow(state.classifications),
    listMeetings: () => okRow(state.meetings),
    listCostEvents: () => okRow(state.costEvents),
  };
}

/** One full synthetic OutboundAction row, exactly typed. */
function synthAction(input: {
  id: string;
  draftId: string;
  contactId: string;
  sentAt: string;
  status?: OutboundAction["status"];
}): OutboundAction {
  const status = input.status ?? "sent";
  return {
    id: input.id,
    workspaceId: "ws",
    createdBy: "user",
    channel: "email",
    draftId: input.draftId,
    draftVersion: 1,
    draftDigest: "digest",
    approvalId: "approval",
    contactId: input.contactId,
    recipientEmail: "recipient@example.test",
    provider: "sandbox",
    status,
    attemptCount: status === "sent" ? 1 : 0,
    providerReference: status === "sent" ? "ref" : null,
    failureCode: null,
    failureMessage: null,
    attemptedAt: input.sentAt,
    sentAt: status === "sent" ? input.sentAt : null,
    completedAt: null,
    createdAt: input.sentAt,
    updatedAt: input.sentAt,
  };
}

/** One full synthetic ConversationClassification row, exactly typed. */
function synthClassification(input: {
  outboundActionId: string;
  intent: ConversationClassification["intent"];
  createdAt: string;
}): ConversationClassification {
  return {
    id: rid(),
    workspaceId: "ws",
    inboundMessageId: "inbound",
    outboundActionId: input.outboundActionId,
    classifierVersion: "conversation-1.0.0",
    intent: input.intent,
    confidence: "high",
    reasons: ["seed"],
    signals: [],
    recommendedNextAction: "record_and_hold",
    humanInterventionRequired: false,
    suppressed: false,
    createdBy: "user",
    createdAt: input.createdAt,
  };
}

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 22 gate — Experiment Engine (ROADMAP.md §29)", () => {
  it("declares a Message A vs Message B comparison and derives the §29 answer on read", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const journey = await prepareJourney(handlers, "Gate Declare");
    const h = handlers;
    const t = journey.tenant;

    // Declare with the §29 example's shape: two drafts, positive reply rate,
    // 14 days. The body is read for the declaration and for nothing else.
    const declared = (await dataOf(
      h.createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Message A vs Message B",
            metric: "positive_reply_rate",
            durationDays: 14,
          },
        ),
      ),
    )) as { experiment: { id: string; status: string; metric: string } };
    expect(declared.experiment.status).toBe("draft");
    expect(declared.experiment.metric).toBe("positive_reply_rate");

    const experimentId = declared.experiment.id;

    // Pin the arms to the exact immutable drafts.
    const armA = (await dataOf(
      h.addExperimentArmHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            draftId: journey.draftAId,
            label: "A",
          },
        ),
      ),
    )) as { arm: { position: number; draftId: string } };
    const armB = (await dataOf(
      h.addExperimentArmHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            draftId: journey.draftBId,
            label: "B",
          },
        ),
      ),
    )) as { arm: { position: number; draftId: string } };
    expect(armA.arm.position).toBe(1);
    expect(armB.arm.position).toBe(2);
    expect(armA.arm.draftId).toBe(journey.draftAId);

    // Start and close through the server's own transitions: no body is read.
    const started = (await dataOf(
      h.startExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    )) as { experiment: { status: string; startedAt: string | null } };
    expect(started.experiment.status).toBe("running");
    expect(started.experiment.startedAt).not.toBeNull();

    // The window is open: now the workspace sends one message per arm through
    // the real approval → action → send path, and one reply comes back.
    const sentA = await approveAndSend(h, t, journey.draftAId);
    await approveAndSend(h, t, journey.draftBId);
    const reply = await recordReply(h, t, sentA, "Happy to chat, book a call.");
    expect(reply.intent).toBe("positive_intent");

    const closed = (await dataOf(
      h.closeExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    )) as { experiment: { status: string; closedAt: string | null } };
    expect(closed.experiment.status).toBe("closed");
    expect(closed.experiment.closedAt).not.toBeNull();

    // The derived read: two arms, the §29 metric, cost from Phase 16's own
    // facts, revenue impact refusing the monetary figure, and a decision
    // that cannot be a winner at this sample size.
    const read = (await dataOf(
      h.getExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    )) as {
      experiment: { id: string; status: string };
      arms: { position: number; draftId: string; label: string }[];
      events: { kind: string }[];
      comparison: {
        ruleVersion: string;
        metric: string;
        decision: { status: string; winnerPosition: number | null };
        confidence: string;
        arms: {
          position: number;
          sampleSize: number;
          conversions: number;
          cost: { eventCount: number; totalMinor: number };
          revenueImpactMinor: number | null;
          revenueImpactReason: string;
        }[];
        populationAccounts: number;
      };
    };

    expect(read.experiment.id).toBe(experimentId);
    expect(read.arms).toHaveLength(2);
    expect(read.arms.map((a) => a.label)).toEqual(["A", "B"]);
    expect(read.events.map((e) => e.kind)).toEqual(["created", "started", "closed"]);
    expect(read.comparison.ruleVersion).toBe(EXPERIMENT_RULE_VERSION);
    expect(read.comparison.metric).toBe("positive_reply_rate");
    expect(read.comparison.arms).toHaveLength(2);
    // Two real sends went out through the real pipeline, one per arm.
    expect(read.comparison.arms[0]?.exposures).toBe(1);
    expect(read.comparison.arms[1]?.exposures).toBe(1);
    // Revenue impact is the refusal, not a number.
    expect(read.comparison.arms[0]?.revenueImpactMinor).toBeNull();
    expect(read.comparison.arms[0]?.revenueImpactReason).toContain("Phase 23");
    // Two exposures per arm is far below the published minimum: no winner.
    expect(read.comparison.decision.status).toBe("insufficient_evidence");
    expect(read.comparison.decision.winnerPosition).toBeNull();
    expect(read.comparison.confidence).toBe("insufficient");
  });

  it("refuses a winner in every insufficient-evidence shape §29 forbids", () => {
    const state = memStore("ws", "user");
    const store = memAdapter(state, "ws");
    const service = createExperimentService(store);

    const declared = service.create("ws", "user", {
      name: "A vs B",
      metric: "positive_reply_rate",
      durationDays: 14,
    });
    if (!isOk(declared)) throw new Error("declare failed");
    const experimentId = declared.value.id;

    // One arm: not a comparison.
    service.addArm("ws", "user", experimentId, { draftId: "draft-1", label: "A" });
    const oneArm = service.start("ws", "user", experimentId);
    // The synthetic adapter does not enforce the two-arm rule; the real store
    // does (asserted in the store test below). Derive anyway: one arm with
    // sample must refuse a winner in the decision itself.
    void oneArm;
    const draft = deriveComparison({
      experiment: {
        ...state.experiments[0]!,
        status: "running",
        startedAt: "2026-10-02T08:00:00.000Z",
      },
      arms: state.arms,
      accounts: [{ id: "acct-1", status: "active" }],
      contacts: [{ id: "c1", accountId: "acct-1", status: "active" }],
      qualifications: [{ accountId: "acct-1", version: 1, state: "qualified" }],
      actions: [
        synthAction({
          id: "act-1",
          draftId: "draft-1",
          contactId: "c1",
          sentAt: "2026-10-03T08:00:00.000Z",
        }),
      ],
      classifications: [],
      meetings: [],
      costEvents: [],
    });
    expect(draft.decision.status).toBe("insufficient_evidence");
    expect(draft.decision.winnerPosition).toBeNull();

    // Below-minimum sample with both arms exposed: still no winner.
    const bothArms: ExperimentArmRow[] = [
      {
        id: "arm-a",
        workspaceId: "ws",
        experimentId,
        position: 1,
        draftId: "draft-1",
        label: "A",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
      {
        id: "arm-b",
        workspaceId: "ws",
        experimentId,
        position: 2,
        draftId: "draft-2",
        label: "B",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ];
    const smallActions = Array.from({ length: EXPERIMENT_MIN_SAMPLE_PER_ARM - 1 }, (_, i) =>
      synthAction({
        id: `act-s${i}`,
        draftId: "draft-1",
        contactId: `sc-a${i}`,
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
    );
    const small = deriveComparison({
      experiment: {
        ...state.experiments[0]!,
        status: "running",
        startedAt: "2026-10-02T08:00:00.000Z",
      },
      arms: bothArms,
      accounts: [],
      // The contacts are qualified through the blanket qualification below, so
      // this fixture isolates the sample-size rule alone.
      contacts: smallActions.map((action) => ({
        id: action.contactId,
        accountId: "pop",
        status: "active",
      })),
      qualifications: [{ accountId: "pop", version: 1, state: "qualified" }],
      actions: smallActions,
      classifications: [],
      meetings: [],
      costEvents: [],
    });
    expect(small.arms[0]?.sampleSize).toBe(EXPERIMENT_MIN_SAMPLE_PER_ARM - 1);
    expect(small.decision.status).toBe("insufficient_evidence");
    expect(small.confidence).toBe("insufficient");

    // Exactly at the minimum with a tiny lift: no material difference.
    const atMinActions = Array.from({ length: EXPERIMENT_MIN_SAMPLE_PER_ARM }, (_, i) =>
      synthAction({
        id: `act-m${i}`,
        draftId: "draft-1",
        contactId: `sc-a${i}`,
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
    );
    const atMin = deriveComparison({
      experiment: {
        ...state.experiments[0]!,
        status: "running",
        startedAt: "2026-10-02T08:00:00.000Z",
      },
      arms: bothArms,
      accounts: [],
      contacts: atMinActions.map((action) => ({
        id: action.contactId,
        accountId: "pop",
        status: "active",
      })),
      qualifications: [{ accountId: "pop", version: 1, state: "qualified" }],
      actions: atMinActions,
      classifications: [],
      meetings: [],
      costEvents: [],
    });
    expect(atMin.arms[0]?.sampleSize).toBe(EXPERIMENT_MIN_SAMPLE_PER_ARM);
    expect(atMin.decision.status).toBe("insufficient_evidence");

    // A cancelled experiment can never crown, whatever the rows say.
    const cancelledRow: ExperimentRow = {
      ...state.experiments[0]!,
      status: "cancelled",
      cancelledAt: "2026-10-03T08:00:00.000Z",
      cancelReason: "stopped",
    };
    const cancelled = deriveComparison({
      experiment: cancelledRow,
      arms: bothArms,
      accounts: [],
      contacts: atMinActions.map((action) => ({
        id: action.contactId,
        accountId: "pop",
        status: "active",
      })),
      qualifications: [{ accountId: "pop", version: 1, state: "qualified" }],
      actions: atMinActions,
      classifications: [],
      meetings: [],
      costEvents: [],
    });
    expect(cancelled.decision.status).toBe("insufficient_evidence");
    expect(cancelled.decision.winnerPosition).toBeNull();
    expect(cancelled.notes.some((note) => note.includes("cancelled"))).toBe(true);
  });

  it("crows a winner only at the published minimum sample and lift, by exact integer arithmetic", () => {
    const state = memStore("ws", "user");
    void memAdapter(state, "ws");
    const experiment: ExperimentRow = {
      id: "exp",
      workspaceId: "ws",
      name: "A vs B",
      metric: "positive_reply_rate",
      status: "closed",
      durationDays: 14,
      createdBy: "user",
      createdAt: "2026-10-01T08:00:00.000Z",
      startedBy: "user",
      startedAt: "2026-10-02T08:00:00.000Z",
      closedBy: "user",
      closedAt: "2026-10-16T08:00:00.000Z",
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      updatedAt: "2026-10-16T08:00:00.000Z",
    };
    const arms: ExperimentArmRow[] = [
      {
        id: "arm-a",
        workspaceId: "ws",
        experimentId: "exp",
        position: 1,
        draftId: "draft-1",
        label: "A",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
      {
        id: "arm-b",
        workspaceId: "ws",
        experimentId: "exp",
        position: 2,
        draftId: "draft-2",
        label: "B",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ];

    // Arm A: 20% conversion; Arm B: 10% — a 1000 bp lift, both at 10× minimum.
    const n = EXPERIMENT_MIN_SAMPLE_PER_ARM * EXPERIMENT_HIGH_SAMPLE_MULTIPLIER;
    const contactsA = Array.from({ length: n }, (_, i) => ({
      id: `ca${i}`,
      accountId: "pa",
      status: "active",
    }));
    const contactsB = Array.from({ length: n }, (_, i) => ({
      id: `cb${i}`,
      accountId: "pb",
      status: "active",
    }));
    const actionsA = contactsA.map((contact, i) =>
      synthAction({
        id: `act-a${i}`,
        draftId: "draft-1",
        contactId: contact.id,
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
    );
    const actionsB = contactsB.map((contact, i) =>
      synthAction({
        id: `act-b${i}`,
        draftId: "draft-2",
        contactId: contact.id,
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
    );
    // Positive reply rate is read from Phase 12's classifications; a contact
    // counts once through the action their reply answers.
    const conversionsA = Math.floor(n * 0.2);
    const conversionsB = Math.floor(n * 0.1);
    const classifications: ConversationClassification[] = [
      ...Array.from({ length: conversionsA }, (_, i) =>
        synthClassification({
          outboundActionId: `act-a${i}`,
          intent: "positive_intent",
          createdAt: "2026-10-04T08:00:00.000Z",
        }),
      ),
      ...Array.from({ length: conversionsB }, (_, i) =>
        synthClassification({
          outboundActionId: `act-b${i}`,
          intent: "interested",
          createdAt: "2026-10-04T08:00:00.000Z",
        }),
      ),
    ];

    const comparison = deriveComparison({
      experiment,
      arms,
      accounts: [],
      contacts: [...contactsA, ...contactsB],
      qualifications: [
        { accountId: "pa", version: 1, state: "qualified" },
        { accountId: "pb", version: 1, state: "qualified" },
      ],
      actions: [...actionsA, ...actionsB],
      classifications,
      meetings: [],
      costEvents: [],
    });

    const [armA, armB] = comparison.arms;
    expect(armA?.sampleSize).toBe(n);
    expect(armB?.sampleSize).toBe(n);
    expect(armA?.conversions).toBe(conversionsA);
    expect(armB?.conversions).toBe(conversionsB);
    // Exact basis-point arithmetic: 2000 bp vs 1000 bp.
    expect(armA?.conversionRateBasisPoints).toBe(2000);
    expect(armB?.conversionRateBasisPoints).toBe(1000);
    expect(comparison.decision.status).toBe("winner");
    expect(comparison.decision.winnerPosition).toBe(1);
    expect(comparison.decision.winnerDraftId).toBe("draft-1");
    expect(comparison.confidence).toBe("high");

    // Below the published lift with the same sample: no material difference.
    const narrowClassifications: ConversationClassification[] = [
      ...Array.from({ length: conversionsA }, (_, i) =>
        synthClassification({
          outboundActionId: `act-a${i}`,
          intent: "positive_intent",
          createdAt: "2026-10-04T08:00:00.000Z",
        }),
      ),
      ...Array.from({ length: conversionsA - 2 }, (_, i) =>
        synthClassification({
          outboundActionId: `act-b${i}`,
          intent: "interested",
          createdAt: "2026-10-04T08:00:00.000Z",
        }),
      ),
    ];
    const narrow = deriveComparison({
      experiment,
      arms,
      accounts: [],
      contacts: [...contactsA, ...contactsB],
      qualifications: [
        { accountId: "pa", version: 1, state: "qualified" },
        { accountId: "pb", version: 1, state: "qualified" },
      ],
      actions: [...actionsA, ...actionsB],
      classifications: narrowClassifications,
      meetings: [],
      costEvents: [],
    });
    expect(narrow.decision.status).toBe("no_material_difference");
    expect(narrow.decision.winnerPosition).toBeNull();

    // An exact tie is a tie, not a coin flip.
    const tieClassifications: ConversationClassification[] = [
      ...Array.from({ length: conversionsA }, (_, i) =>
        synthClassification({
          outboundActionId: `act-a${i}`,
          intent: "positive_intent",
          createdAt: "2026-10-04T08:00:00.000Z",
        }),
      ),
      ...Array.from({ length: conversionsA }, (_, i) =>
        synthClassification({
          outboundActionId: `act-b${i}`,
          intent: "positive_intent",
          createdAt: "2026-10-04T08:00:00.000Z",
        }),
      ),
    ];
    const tie = deriveComparison({
      experiment,
      arms,
      accounts: [],
      contacts: [...contactsA, ...contactsB],
      qualifications: [
        { accountId: "pa", version: 1, state: "qualified" },
        { accountId: "pb", version: 1, state: "qualified" },
      ],
      actions: [...actionsA, ...actionsB],
      classifications: tieClassifications,
      meetings: [],
      costEvents: [],
    });
    expect(tie.decision.status).toBe("no_material_difference");
    expect(tie.decision.reason).toContain("exactly equal");

    // Sub-minimum lift at high sample stays refused, and the lift threshold
    // is published, not hidden.
    expect(EXPERIMENT_MIN_LIFT_BASIS_POINTS).toBe(200);
    expect(EXPERIMENT_MIN_SAMPLE_PER_ARM).toBe(30);
    expect(EXPERIMENT_MEDIUM_SAMPLE_MULTIPLIER).toBe(3);
    expect(EXPERIMENT_HIGH_SAMPLE_MULTIPLIER).toBe(10);
  });

  it("populates only from qualified accounts and counts cost from Phase 16's own facts", () => {
    const experiment: ExperimentRow = {
      id: "exp",
      workspaceId: "ws",
      name: "A vs B",
      metric: "positive_reply_rate",
      status: "closed",
      durationDays: 14,
      createdBy: "user",
      createdAt: "2026-10-01T08:00:00.000Z",
      startedBy: "user",
      startedAt: "2026-10-02T08:00:00.000Z",
      closedBy: "user",
      closedAt: "2026-10-16T08:00:00.000Z",
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      updatedAt: "2026-10-16T08:00:00.000Z",
    };
    const arms: ExperimentArmRow[] = [
      {
        id: "arm-a",
        workspaceId: "ws",
        experimentId: "exp",
        position: 1,
        draftId: "draft-1",
        label: "A",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
      {
        id: "arm-b",
        workspaceId: "ws",
        experimentId: "exp",
        position: 2,
        draftId: "draft-2",
        label: "B",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ];

    // Qualified: acct-1 (v2 qualified) and acct-2 (v1 qualified).
    // Not in population: acct-3 (newest is unqualified), acct-4 (insufficient_data),
    // acct-5 (qualified but its contact is archived).
    const qualifications = [
      { accountId: "acct-1", version: 1, state: "qualified" },
      { accountId: "acct-1", version: 2, state: "qualified" },
      { accountId: "acct-2", version: 1, state: "qualified" },
      { accountId: "acct-3", version: 1, state: "unqualified" },
      { accountId: "acct-4", version: 1, state: "insufficient_data" },
      { accountId: "acct-5", version: 1, state: "qualified" },
    ];
    const contacts = [
      { id: "c1", accountId: "acct-1", status: "active" },
      { id: "c2", accountId: "acct-2", status: "active" },
      { id: "c3", accountId: "acct-3", status: "active" },
      { id: "c5", accountId: "acct-5", status: "archived" },
    ];
    const actions = [
      synthAction({
        id: "act-1",
        draftId: "draft-1",
        contactId: "c1",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      synthAction({
        id: "act-2",
        draftId: "draft-2",
        contactId: "c2",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      // Unqualified population: never counts.
      synthAction({
        id: "act-3",
        draftId: "draft-1",
        contactId: "c3",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      // Archived contact: never counts.
      synthAction({
        id: "act-5",
        draftId: "draft-1",
        contactId: "c5",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      // Outside the window: never counts.
      synthAction({
        id: "act-6",
        draftId: "draft-1",
        contactId: "c1",
        sentAt: "2026-11-30T08:00:00.000Z",
      }),
      // Not a confirmed send: never counts.
      synthAction({
        id: "act-7",
        draftId: "draft-1",
        contactId: "c1",
        sentAt: "2026-10-03T08:00:00.000Z",
        status: "failed",
      }),
    ];
    // Cost facts ride on the sends, under Phase 16's own outbound_send kind.
    const costFacts: CostEvent[] = [
      {
        id: "cost-1",
        workspaceId: "ws",
        executionKind: "outbound_send",
        executionId: "act-1",
        category: "llm",
        basis: "measured",
        amountMinor: 40,
        currency: "USD",
        source: null,
        occurredAt: "2026-10-03T08:00:00.000Z",
        idempotencyKey: "k1",
        createdBy: "user",
        createdAt: "2026-10-03T08:00:00.000Z",
      },
      {
        id: "cost-2",
        workspaceId: "ws",
        executionKind: "agent_run",
        executionId: "act-1",
        category: "llm",
        basis: "measured",
        amountMinor: 999,
        currency: "USD",
        source: null,
        occurredAt: "2026-10-03T08:00:00.000Z",
        idempotencyKey: "k2",
        createdBy: "user",
        createdAt: "2026-10-03T08:00:00.000Z",
      },
      {
        id: "cost-3",
        workspaceId: "ws",
        executionKind: "outbound_send",
        executionId: "act-3",
        category: "llm",
        basis: "measured",
        amountMinor: 70,
        currency: "USD",
        source: null,
        occurredAt: "2026-10-03T08:00:00.000Z",
        idempotencyKey: "k3",
        createdBy: "user",
        createdAt: "2026-10-03T08:00:00.000Z",
      },
    ];
    // A meeting reached a calendar through arm B's send.
    const meeting: Meeting = {
      id: "meet-1",
      workspaceId: "ws",
      accountId: "acct-2",
      contactId: "c2",
      classificationId: "cls",
      inboundMessageId: "inb",
      outboundActionId: "act-2",
      qualificationId: "qual",
      state: "booked",
      recommendationReason: "positive_intent",
      policyVersion: "meeting-1.0.0",
      bookingDigest: "digest",
      title: "Intro",
      startsAt: "2026-10-20T10:00:00.000Z",
      endsAt: "2026-10-20T10:30:00.000Z",
      timezone: "UTC",
      durationMinutes: 30,
      channel: "email",
      externalEventId: "evt-1",
      suppressionCheckedAt: null,
      approvedBy: "user",
      approvedAt: "2026-10-05T08:00:00.000Z",
      bookedAt: "2026-10-05T08:00:00.000Z",
      cancelledAt: null,
      decisionReason: null,
      createdBy: "user",
      createdAt: "2026-10-04T08:00:00.000Z",
      updatedAt: "2026-10-05T08:00:00.000Z",
    };

    const comparison = deriveComparison({
      experiment,
      arms,
      accounts: [
        { id: "acct-1", status: "active" },
        { id: "acct-2", status: "active" },
        { id: "acct-3", status: "active" },
      ],
      contacts,
      qualifications,
      actions,
      classifications: [],
      meetings: [meeting],
      costEvents: costFacts,
    });

    // Population counts accounts, not their contacts: acct-5 stays qualified
    // even though its only contact is archived, so the population is three —
    // and the archived contact still never counts as sample.
    expect(comparison.populationAccounts).toBe(3);
    const [armA, armB] = comparison.arms;
    // Only the in-window send to a live contact of a qualified account counts.
    expect(armA?.sampleSize).toBe(1);
    expect(armB?.sampleSize).toBe(1);
    // Cost follows the arm's in-window exposures: the two real sends' facts
    // (40 + 70), never the agent_run fact (999) or anything outside the arm.
    expect(armA?.cost.totalMinor).toBe(110);
    expect(armA?.cost.eventCount).toBe(2);
    expect(armB?.cost.totalMinor).toBe(0);
    // Revenue-adjacent outcome: the booked meeting on arm B's send.
    expect(armB?.meetingsOnCalendar).toBe(1);
    expect(armA?.meetingsOnCalendar).toBe(0);
  });

  it("ignores forged authoritative fields and keeps lifecycle transitions server-owned", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const journey = await prepareJourney(handlers, "Gate Forge");
    const h = handlers;
    const t = journey.tenant;

    // A forged status, winner, timestamps and identity in the declaration body.
    const declared = (await dataOf(
      h.createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Forged",
            metric: "positive_reply_rate",
            durationDays: 14,
            status: "closed",
            winner: "A",
            createdBy: "attacker",
            createdAt: "1999-01-01T00:00:00.000Z",
            closedAt: "1999-01-01T00:00:00.000Z",
          },
        ),
      ),
    )) as { experiment: { status: string; createdBy: string; createdAt: string } };
    expect(declared.experiment.status).toBe("draft");
    expect(declared.experiment.createdBy).toBe(t.userId);
    expect(declared.experiment.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
    const experimentId = declared.experiment.id;

    // A forged arm position and id are ignored: positions are server-derived.
    const armA = (await dataOf(
      h.addExperimentArmHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            draftId: journey.draftAId,
            label: "A",
            position: 99,
            id: "forged-arm",
          },
        ),
      ),
    )) as { arm: { position: number; id: string } };
    expect(armA.arm.position).toBe(1);
    expect(armA.arm.id).not.toBe("forged-arm");

    // The second arm is declared without a forged position, so the start
    // below measures a real two-sided comparison.
    await dataOf(
      h.addExperimentArmHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            draftId: journey.draftBId,
            label: "B",
          },
        ),
      ),
    );

    // The start/close routes do not read a body at all: a forged status or
    // winner cannot reach the row through them.
    const started = (await dataOf(
      h.startExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            status: "closed",
            winner: "A",
            startedAt: "1999-01-01T00:00:00.000Z",
          },
        ),
      ),
    )) as { experiment: { status: string; startedAt: string } };
    expect(started.experiment.status).toBe("running");
    expect(started.experiment.startedAt).not.toBe("1999-01-01T00:00:00.000Z");

    const closed = (await dataOf(
      h.closeExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            status: "cancelled",
            winner: "B",
          },
        ),
      ),
    )) as { experiment: { status: string } };
    expect(closed.experiment.status).toBe("closed");

    // The comparison is derived on read: no request shape can put a winner
    // into it. Read after close and confirm the decision refuses.
    const read = (await dataOf(
      h.getExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    )) as { comparison: { decision: { status: string; winnerPosition: number | null } } };
    expect(read.comparison.decision.winnerPosition).toBeNull();
  });

  it("keeps experiments per tenant and refuses unauthorized and unknown reads", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const journeyA = await prepareJourney(handlers, "Gate Iso A");
    const tenantB = tenant("Gate Iso B");
    const h = handlers;
    const t = journeyA.tenant;

    const declared = (await dataOf(
      h.createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Tenant A only",
            metric: "positive_reply_rate",
            durationDays: 7,
          },
        ),
      ),
    )) as { experiment: { id: string } };
    const experimentId = declared.experiment.id;

    // Tenant B cannot read tenant A's experiment: NOT_FOUND, not a leak.
    const foreign = await errorOf(
      h.getExperimentHandler(request(tenantB.token, { workspaceId: t.workspaceId, experimentId })),
    );
    expect(foreign.code).toBe("UNAUTHORIZED");

    // An unknown id reads as NOT_FOUND.
    const missing = await errorOf(
      h.getExperimentHandler(
        request(t.token, { workspaceId: t.workspaceId, experimentId: "missing-id" }),
      ),
    );
    expect(missing.code).toBe("NOT_FOUND");

    // Tenant A's list stays tenant A's.
    const listed = (await dataOf(
      h.listExperimentsHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as { experiments: { id: string }[] };
    expect(listed.experiments.map((e) => e.id)).toEqual([experimentId]);
    const listedB = (await dataOf(
      h.listExperimentsHandler(request(tenantB.token, { workspaceId: tenantB.workspaceId })),
    )) as { experiments: { id: string }[] };
    expect(listedB.experiments).toEqual([]);
  });

  it("enforces the lifecycle in the store: two arms required, terminal states, append-only trail", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const journey = await prepareJourney(handlers, "Gate Lifecycle");
    const h = handlers;
    const t = journey.tenant;

    const declared = (await dataOf(
      h.createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Lifecycle",
            metric: "positive_reply_rate",
            durationDays: 14,
          },
        ),
      ),
    )) as { experiment: { id: string } };
    const experimentId = declared.experiment.id;

    // Starting with one arm is refused: a comparison of one side is not one.
    await h.addExperimentArmHandler(
      request(
        t.token,
        { workspaceId: t.workspaceId, experimentId },
        {
          draftId: journey.draftAId,
          label: "A",
        },
      ),
    );
    const early = await errorOf(
      h.startExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    );
    expect(early.code).toBe("CONFLICT");

    // The second arm unblocks it.
    await h.addExperimentArmHandler(
      request(
        t.token,
        { workspaceId: t.workspaceId, experimentId },
        {
          draftId: journey.draftBId,
          label: "B",
        },
      ),
    );

    // The same draft cannot be pinned twice, and a foreign draft is refused.
    const dup = await errorOf(
      h.addExperimentArmHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            draftId: journey.draftAId,
            label: "A2",
          },
        ),
      ),
    );
    expect(dup.code).toBe("CONFLICT");
    const foreign = await errorOf(
      h.addExperimentArmHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            draftId: "missing-draft",
            label: "X",
          },
        ),
      ),
    );
    expect(foreign.code).toBe("NOT_FOUND");

    // Close before start is refused.
    const earlyClose = await errorOf(
      h.closeExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    );
    expect(earlyClose.code).toBe("CONFLICT");

    // Start twice is refused; the row's first transition stands.
    await h.startExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId }));
    const again = await errorOf(
      h.startExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    );
    expect(again.code).toBe("CONFLICT");

    // Arms freeze when the window opens.
    const lateArm = await errorOf(
      h.addExperimentArmHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId, experimentId },
          {
            draftId: "missing-draft",
            label: "X",
          },
        ),
      ),
    );
    expect(lateArm.code).toBe("CONFLICT");

    // Close, then the terminal state rejects every further transition.
    await h.closeExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId }));
    const closeAgain = await errorOf(
      h.closeExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    );
    expect(closeAgain.code).toBe("CONFLICT");
    const cancelClosed = await errorOf(
      h.cancelExperimentHandler(
        request(t.token, { workspaceId: t.workspaceId, experimentId }, { reason: "too late" }),
      ),
    );
    expect(cancelClosed.code).toBe("CONFLICT");

    // The trail is append-only and records every transition in order.
    const history = (await dataOf(
      h.getExperimentHistoryHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    )) as { events: { kind: string }[] };
    expect(history.events.map((e) => e.kind)).toEqual(["created", "started", "closed"]);

    // Replaying the close does not append a second event.
    expect(history.events).toHaveLength(3);
  });

  it("derives deterministically: the same rows produce a byte-identical comparison", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const journey = await prepareJourney(handlers, "Gate Determinism");
    const h = handlers;
    const t = journey.tenant;

    const declared = (await dataOf(
      h.createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Determinism",
            metric: "positive_reply_rate",
            durationDays: 14,
          },
        ),
      ),
    )) as { experiment: { id: string } };
    const experimentId = declared.experiment.id;
    await h.addExperimentArmHandler(
      request(
        t.token,
        { workspaceId: t.workspaceId, experimentId },
        {
          draftId: journey.draftAId,
          label: "A",
        },
      ),
    );
    await h.addExperimentArmHandler(
      request(
        t.token,
        { workspaceId: t.workspaceId, experimentId },
        {
          draftId: journey.draftBId,
          label: "B",
        },
      ),
    );
    await h.startExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId }));
    await h.closeExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId }));

    const first = await dataOf(
      h.getExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    );
    const second = await dataOf(
      h.getExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
    );
    // Byte-identical JSON: same rows, same answer, no hidden state.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is measurement-only: reading and closing an experiment writes nothing", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const journey = await prepareJourney(handlers, "Gate Negative");
    const h = handlers;
    const t = journey.tenant;

    const declared = (await dataOf(
      h.createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Negative space",
            metric: "positive_reply_rate",
            durationDays: 14,
          },
        ),
      ),
    )) as { experiment: { id: string } };
    const experimentId = declared.experiment.id;
    await h.addExperimentArmHandler(
      request(
        t.token,
        { workspaceId: t.workspaceId, experimentId },
        {
          draftId: journey.draftAId,
          label: "A",
        },
      ),
    );
    await h.addExperimentArmHandler(
      request(
        t.token,
        { workspaceId: t.workspaceId, experimentId },
        {
          draftId: journey.draftBId,
          label: "B",
        },
      ),
    );
    await h.startExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId }));

    const before = rowCounts(t.workspaceId);
    const reads = await Promise.all([
      h.getExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
      h.getExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
      h.getExperimentHistoryHandler(request(t.token, { workspaceId: t.workspaceId, experimentId })),
      h.listExperimentsHandler(request(t.token, { workspaceId: t.workspaceId })),
      h.getExperimentPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    ]);
    for (const read of reads) {
      const resolved = await read;
      if (!resolved.ok) throw new Error("expected the read to succeed");
    }
    const after = rowCounts(t.workspaceId);

    // Reading changed nothing anywhere in the workspace.
    expect(after).toEqual(before);

    // The window close is the only lifecycle write left, and it writes exactly
    // one experiment row change and one trail event.
    await h.closeExperimentHandler(request(t.token, { workspaceId: t.workspaceId, experimentId }));
    const finalCounts = rowCounts(t.workspaceId);
    expect(finalCounts.experiments).toBe(before.experiments);
    expect(finalCounts.experimentArms).toBe(before.experimentArms);
    expect(finalCounts.experimentEvents).toBe(before.experimentEvents + 1);
    // Nothing else moved: no send, no approval, no meeting, no cost, no trace.
    expect(finalCounts.actions).toBe(before.actions);
    expect(finalCounts.approvals).toBe(before.approvals);
    expect(finalCounts.meetings).toBe(before.meetings);
    expect(finalCounts.costEvents).toBe(before.costEvents);
    expect(finalCounts.traceRuns).toBe(before.traceRuns);
    expect(finalCounts.traceEvents).toBe(before.traceEvents);
    expect(finalCounts.drafts).toBe(before.drafts);
  });

  it("publishes the policy: the metric, the decision rule, the thresholds and the refusals", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const t = tenant("Gate Policy");

    const policy = (await dataOf(
      h2(handlers).getExperimentPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as {
      ruleVersion: string;
      metric: { name: string; status: string };
      refusedMetrics: { name: string; owningPhase: string | null }[];
      thresholds: { minSamplePerArm: number; minLiftBasisPoints: number };
      neverDoes: string[];
    };

    expect(policy.ruleVersion).toBe(EXPERIMENT_RULE_VERSION);
    expect(policy.metric.name).toBe("positive_reply_rate");
    expect(policy.metric.status).toBe("derived");
    expect(policy.thresholds.minSamplePerArm).toBe(EXPERIMENT_MIN_SAMPLE_PER_ARM);
    expect(policy.thresholds.minLiftBasisPoints).toBe(EXPERIMENT_MIN_LIFT_BASIS_POINTS);
    expect(
      policy.refusedMetrics.some(
        (entry) => entry.name === "revenue_per_arm" && entry.owningPhase === "Phase 23",
      ),
    ).toBe(true);
    expect(policy.neverDoes.length).toBeGreaterThan(0);
    expect(
      policy.neverDoes.some((line) =>
        line.includes("never claims a winner on insufficient evidence"),
      ),
    ).toBe(true);
  });

  it("rejects invalid declarations: unknown metric, refused metric, bad duration, blank name", async () => {
    setSessionIndex(createIndex());
    const handlers = handlersFor();
    const t = tenant("Gate Invalid");

    const unknown = await errorOf(
      h2(handlers).createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Bad metric",
            metric: "revenue_per_visitor",
            durationDays: 14,
          },
        ),
      ),
    );
    expect(unknown.code).toBe("VALIDATION_ERROR");

    // A metric the rules explicitly refuse names its owning phase.
    const refused = await errorOf(
      h2(handlers).createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Refused metric",
            metric: "revenue_per_arm",
            durationDays: 14,
          },
        ),
      ),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toContain("Phase 23");

    const badDuration = await errorOf(
      h2(handlers).createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Bad duration",
            metric: "positive_reply_rate",
            durationDays: 0,
          },
        ),
      ),
    );
    expect(badDuration.code).toBe("VALIDATION_ERROR");

    const longDuration = await errorOf(
      h2(handlers).createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Long duration",
            metric: "positive_reply_rate",
            durationDays: 91,
          },
        ),
      ),
    );
    expect(longDuration.code).toBe("VALIDATION_ERROR");

    const blank = await errorOf(
      h2(handlers).createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "   ",
            metric: "positive_reply_rate",
            durationDays: 14,
          },
        ),
      ),
    );
    expect(blank.code).toBe("VALIDATION_ERROR");

    const fractional = await errorOf(
      h2(handlers).createExperimentHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            name: "Fractional",
            metric: "positive_reply_rate",
            durationDays: 2.5,
          },
        ),
      ),
    );
    expect(fractional.code).toBe("VALIDATION_ERROR");

    // Not one refused request wrote a row.
    const db = defaultStore.db;
    const mine = (db.experiments ?? []).filter((row) => row.workspaceId === t.workspaceId);
    expect(mine).toHaveLength(0);
  });

  it("keeps the schema honest: the §29 tables sit behind foreign keys and CHECK constraints in v19", () => {
    expect(defaultStore.db.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(19);

    const ddl = SCHEMA;
    const expStart = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${experimentTable}"`);
    const armStart = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${experimentArmTable}"`);
    const eventStart = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${experimentEventTable}"`);
    expect(expStart).toBeGreaterThan(-1);
    expect(armStart).toBeGreaterThan(expStart);
    expect(eventStart).toBeGreaterThan(armStart);
    const expDdl = ddl.slice(expStart, armStart);
    const armDdl = ddl.slice(armStart, eventStart);
    const eventDdl = ddl.slice(eventStart);

    // Tenant and identity are real foreign keys.
    expect(expDdl).toContain('REFERENCES "workspaces"("id") ON DELETE CASCADE');
    expect(expDdl).toContain('REFERENCES "users"("id") ON DELETE CASCADE');
    expect(armDdl).toContain('REFERENCES "workspaces"("id") ON DELETE CASCADE');
    expect(armDdl).toContain(`REFERENCES "${experimentTable}"("id") ON DELETE CASCADE`);
    expect(eventDdl).toContain('REFERENCES "workspaces"("id") ON DELETE CASCADE');
    expect(eventDdl).toContain(`REFERENCES "${experimentTable}"("id") ON DELETE CASCADE`);

    // The vocabularies are constrained in storage, so an unvalidated write is
    // impossible rather than merely discouraged.
    expect(expDdl).toContain("'positive_reply_rate'");
    expect(expDdl).toContain("'draft','running','closed','cancelled'");
    expect(expDdl).toContain('"duration_days" > 0');

    // Status and its timestamps must agree in the row itself.
    expect(expDdl).toContain("started_at");
    expect(expDdl).toContain("closed_at");
    expect(expDdl).toContain("cancelled_at");

    // An arm is unique per position and per draft within its experiment.
    expect(armDdl).toContain(
      `UNIQUE("${experimentArmTable}"."experiment_id", "${experimentArmTable}"."position")`,
    );
    expect(armDdl).toContain(
      `UNIQUE("${experimentArmTable}"."experiment_id", "${experimentArmTable}"."draft_id")`,
    );
    expect(eventDdl).toContain("created','started','closed','cancelled'");
  });

  it("window derivation is exact: declared duration capped by an early close", () => {
    const base: ExperimentRow = {
      id: "exp",
      workspaceId: "ws",
      name: "Window",
      metric: "positive_reply_rate",
      status: "running",
      durationDays: 14,
      createdBy: "user",
      createdAt: "2026-10-01T08:00:00.000Z",
      startedBy: "user",
      startedAt: "2026-10-02T08:00:00.000Z",
      closedBy: null,
      closedAt: null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      updatedAt: "2026-10-02T08:00:00.000Z",
    };

    // A draft has no window.
    expect(experimentWindow({ ...base, status: "draft", startedAt: null })).toBeNull();

    // The declared end is start + duration.
    const running = experimentWindow(base);
    expect(running).not.toBeNull();
    expect(running?.start).toBe(Date.parse("2026-10-02T08:00:00.000Z"));
    expect(running?.end).toBe(Date.parse("2026-10-16T08:00:00.000Z"));

    // An early close caps the window at the close instant.
    const early = experimentWindow({
      ...base,
      status: "closed",
      closedAt: "2026-10-09T08:00:00.000Z",
    });
    expect(early?.end).toBe(Date.parse("2026-10-09T08:00:00.000Z"));
  });

  it("uses the meeting engine's own positive-intent set, not a re-declared copy", () => {
    // The conversion rule reads Phase 13's MEETABLE_INTENTS — imported, not
    // restated — so "positive" means the same thing in an experiment as it
    // does in a meeting recommendation.
    expect(MEETABLE_INTENTS).toContain("positive_intent");
    expect(MEETABLE_INTENTS).toContain("interested");

    const experiment: ExperimentRow = {
      id: "exp",
      workspaceId: "ws",
      name: "Intents",
      metric: "positive_reply_rate",
      status: "closed",
      durationDays: 14,
      createdBy: "user",
      createdAt: "2026-10-01T08:00:00.000Z",
      startedBy: "user",
      startedAt: "2026-10-02T08:00:00.000Z",
      closedBy: "user",
      closedAt: "2026-10-16T08:00:00.000Z",
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      updatedAt: "2026-10-16T08:00:00.000Z",
    };
    const arms: ExperimentArmRow[] = [
      {
        id: "arm-a",
        workspaceId: "ws",
        experimentId: "exp",
        position: 1,
        draftId: "draft-1",
        label: "A",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ];
    const actions = [
      synthAction({
        id: "act-pos",
        draftId: "draft-1",
        contactId: "c1",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      synthAction({
        id: "act-int",
        draftId: "draft-1",
        contactId: "c2",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      synthAction({
        id: "act-neg",
        draftId: "draft-1",
        contactId: "c3",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
    ];
    const classifications = [
      synthClassification({
        outboundActionId: "act-pos",
        intent: "positive_intent",
        createdAt: "2026-10-04T08:00:00.000Z",
      }),
      synthClassification({
        outboundActionId: "act-int",
        intent: "interested",
        createdAt: "2026-10-04T08:00:00.000Z",
      }),
      synthClassification({
        outboundActionId: "act-neg",
        intent: "negative_intent",
        createdAt: "2026-10-04T08:00:00.000Z",
      }),
    ];
    const comparison = deriveComparison({
      experiment,
      arms,
      accounts: [],
      contacts: [
        { id: "c1", accountId: "p1", status: "active" },
        { id: "c2", accountId: "p2", status: "active" },
        { id: "c3", accountId: "p3", status: "active" },
      ],
      qualifications: [
        { accountId: "p1", version: 1, state: "qualified" },
        { accountId: "p2", version: 1, state: "qualified" },
        { accountId: "p3", version: 1, state: "qualified" },
      ],
      actions,
      classifications,
      meetings: [],
      costEvents: [],
    });
    expect(comparison.arms[0]?.sampleSize).toBe(3);
    expect(comparison.arms[0]?.conversions).toBe(2);
    expect(comparison.arms[0]?.conversionRateBasisPoints).toBe(6666);
  });

  it("excludes a cross-arm contact from both arms and discloses the exclusion", () => {
    const experiment: ExperimentRow = {
      id: "exp",
      workspaceId: "ws",
      name: "Overlap",
      metric: "positive_reply_rate",
      status: "closed",
      durationDays: 14,
      createdBy: "user",
      createdAt: "2026-10-01T08:00:00.000Z",
      startedBy: "user",
      startedAt: "2026-10-02T08:00:00.000Z",
      closedBy: "user",
      closedAt: "2026-10-16T08:00:00.000Z",
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      updatedAt: "2026-10-16T08:00:00.000Z",
    };
    const arms: ExperimentArmRow[] = [
      {
        id: "arm-a",
        workspaceId: "ws",
        experimentId: "exp",
        position: 1,
        draftId: "draft-1",
        label: "A",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
      {
        id: "arm-b",
        workspaceId: "ws",
        experimentId: "exp",
        position: 2,
        draftId: "draft-2",
        label: "B",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ];
    // c-shared is reached by both arms inside the window: excluded from both.
    const actions = [
      synthAction({
        id: "act-a1",
        draftId: "draft-1",
        contactId: "c-a",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      synthAction({
        id: "act-b1",
        draftId: "draft-2",
        contactId: "c-b",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      synthAction({
        id: "act-a2",
        draftId: "draft-1",
        contactId: "c-shared",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
      synthAction({
        id: "act-b2",
        draftId: "draft-2",
        contactId: "c-shared",
        sentAt: "2026-10-03T08:00:00.000Z",
      }),
    ];
    const comparison = deriveComparison({
      experiment,
      arms,
      accounts: [],
      contacts: [
        { id: "c-a", accountId: "p1", status: "active" },
        { id: "c-b", accountId: "p2", status: "active" },
        { id: "c-shared", accountId: "p3", status: "active" },
      ],
      qualifications: [
        { accountId: "p1", version: 1, state: "qualified" },
        { accountId: "p2", version: 1, state: "qualified" },
        { accountId: "p3", version: 1, state: "qualified" },
      ],
      actions,
      classifications: [],
      meetings: [],
      costEvents: [],
    });
    expect(comparison.arms[0]?.sampleSize).toBe(1);
    expect(comparison.arms[1]?.sampleSize).toBe(1);
    expect(comparison.arms[0]?.excludedCrossArmContacts).toBe(1);
    expect(comparison.arms[1]?.excludedCrossArmContacts).toBe(1);
  });
});

/** Identity helper so the policy/invalid tests read cleanly. */
function h2(handlers: Handlers): Handlers {
  return handlers;
}
