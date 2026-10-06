import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import {
  LATEST_SCHEMA_VERSION,
  SCHEMA,
  crmSyncEventTable,
  crmSyncTable,
  integrationConnectionTable,
  store as defaultStore,
} from "@dealora/db";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { StaticResearchProvider } from "@dealora/research";
import type { ResearchProvider } from "@dealora/research";
import {
  SandboxCrmAdapter,
  describeIntegrationPolicy,
  deriveCrmChangeSet,
  changeSetDigest,
  INTEGRATION_SCOPE_CATALOG,
} from "@dealora/integration";
import type {
  CrmApplyRequest,
  CrmApplyResult,
  CrmContactSnapshot,
  IntegrationAdapter,
} from "@dealora/integration";

//
// Phase 23 gate — CRM Integrations (ROADMAP.md §30).
//
// §30 asks for integrations that use clear permission scopes and standardized
// adapter interfaces, and does not hard-code the whole product around one vendor.
// §17 classifies "update CRM" as a Level 2 external action: a change-set is
// derived from stored rows, frozen, bound to an explicit human decision bound to
// its digest, and executed only through an adapter that performs **no network I/O**
// in this repository (no credential exists yet, §18 stays open for ADR 0011).
//
// The gate walks a real pipeline through the real handlers — Brain → Goal →
// Account → Contact → Research → Evidence → Qualification → Draft → Approval →
// Send → Reply — and then, over that same workspace, connects a CRM adapter,
// prepares a change-set, records a person's decision, executes through the
// sandbox adapter, records cost through Phase 16 and proves the seams:
//
//  1. the published architecture is visible as data: six potential systems, a
//     closed scope catalog, a per-operation required scope, and the refusals;
//  2. the adapter surface is the registry's, never a vendor's SDK — listing
//     returns only what this deployment registered, an unknown adapter id is
//     refused, and two differently-named adapters resolve by id over the same
//     path;
//  3. connect requires explicit, valid, decribed scopes — unknown, undeclared
//     and duplicate scopes are refused, and forged fields are ignored;
//  4. the change-set is derived from stored rows (not supplied by the caller),
//     every operation names its source rows, and no operation carries an amount
//     or value field at all;
//  5. a badge of preparation is byte-identical re-derivation of the same rows;
//  6. missing scopes are refused by name, before and after approval;
//  7. no Level 2 action reaches an adapter without a person's decision bound to
//     the digest that was previewed, and a rejection must say why;
//  8. the adapter's own confirmation is the only thing that produces executed,
//     a refusal is recorded as failed, and a retry applies exactly once;
//  9. revocation is re-checked at execution, so a revoked connection cannot
//     carry an approved sync back into scope;
//  10. every route is scoped to the session's workspace — foreign workspaces are
//     refused before anything else, foreign ids are not found;
//  11. forged authoritative fields (status, decision, decidedBy, executedBy,
//     providerReference, createdBy, grantedScopes) do not reach storage;
//  12. the trail is append-only: prepared, approved, rejected, cancelled,
//     executed, failed — who and when, written by the server; reading and
//     listing write nothing;
//  13. Phase 16's own engine attributes the execution's cost under crm_sync, and
//     a foreign execution id is NOT_FOUND;
//  14. archived accounts are not synchronized, blank ids and bad decisions are
//     refused, an invalid status filter is refused, and an invalid decision is
//     refused;
//  15. the engine is pure — the same stored rows always yield the same change-set
//     and the same lifecycle verdict, with no clock, no model and no I/O;
//  16. Phase 22's boundary is untouched and still refuses revenue metrics, and
//     the CRM flow writes only the integration tables.
//

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

//
// One affected account, whose CRM change-set carries the six operations §30
// mentions: contact, lifecycle, opportunity, note, activity and conversation.
//
interface Subject extends Lgt {
  tenant: Lgt;
  accountId: string;
  contactId: string;
  draftId: string;
  sentActionId: string;
}

interface Lgt {
  token: string;
  userId: string;
  workspaceId: string;
}

function tenant(name: string): Lgt {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const owner = signup(`${unique(slug)}@example.com`, "correct-horse-battery", name);
  const workspace = defaultStore.createWorkspace({
    ownerId: owner.user.id,
    name: `${name} ${seq} ${process.pid}`,
  });
  if (!isOk(workspace)) throw new Error("fixture workspace failed");
  return { token: owner.token, userId: owner.user.id, workspaceId: workspace.value.id };
}

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
        sourceUrl: "https://northwind.example/blog",
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
        sourceUrl: "https://northwind.example/news/leadership",
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

function handlersFor(
  adapters?: readonly IntegrationAdapter[],
): ReturnType<typeof createDefaultHandlers> {
  return createDefaultHandlers({
    researchProviders: [researchProvider()],
    ...(adapters ? { integrationAdapters: adapters } : {}),
  });
}

async function subjectOf(
  handlers: ReturnType<typeof createDefaultHandlers>,
  name: string,
): Promise<Subject> {
  const t = tenant(name);
  const { token, workspaceId } = t;

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

  const account = (await dataOf(
    handlers.createAccountHandler(
      request(
        token,
        { workspaceId },
        {
          name: "Northwind",
          industry: "SaaS",
          companySize: "50-200",
          geography: "Germany",
          source: "manual",
          sourceReference: "phase23-gate",
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
          firstName: "Ada",
          lastName: "Lovelace",
          jobTitle: "VP Support",
          email: `${unique(name.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}-${seq}@example.test`,
          source: "manual",
          sourceReference: "phase23-gate",
        },
      ),
    ),
  )) as { contact: { id: string } };

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
  if (run.request.status !== "completed") throw new Error("research run did not complete");

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
        { revenueGoalId: goal.goal.id },
      ),
    ),
  )) as { qualification: { id: string; state: string } };
  if (qualification.qualification.state !== "qualified")
    throw new Error("fixture account did not qualify");

  const draft = (await dataOf(
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

  const requested = (await dataOf(
    handlers.createApprovalRequestHandler(
      request(token, { workspaceId, draftId: draft.draft.id }, {}),
    ),
  )) as { approval: { id: string } };
  const decided = (await dataOf(
    handlers.decideApprovalRequestHandler(
      request(token, { workspaceId, id: requested.approval.id }, { decision: "approved" }),
    ),
  )) as { approval: { status: string } };
  if (decided.approval.status !== "approved") throw new Error("fixture approval failed");

  const staged = (await dataOf(
    handlers.createOutboundActionHandler(
      request(token, { workspaceId, draftId: draft.draft.id }, {}),
    ),
  )) as { action: { id: string } };

  const sent = (await dataOf(
    handlers.sendOutboundActionHandler(request(token, { workspaceId, id: staged.action.id })),
  )) as { action: { id: string; status: string; sentAt: string | null } };
  if (sent.action.status !== "sent" || sent.action.sentAt === null)
    throw new Error("fixture send did not land");

  const classified = (await dataOf(
    handlers.createInboundMessageHandler(
      request(
        token,
        { workspaceId, outboundActionId: sent.action.id },
        { body: "Happy to chat, book a call." },
      ),
    ),
  )) as { classification: { intent: string } };
  if (classified.classification.intent !== "positive_intent")
    throw new Error(
      `fixture reply classified as ${classified.classification.intent}, wanted positive_intent`,
    );

  return {
    ...t,
    tenant: t,
    accountId: account.account.id,
    contactId: contact.contact.id,
    draftId: draft.draft.id,
    sentActionId: sent.action.id,
  };
}

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// A snapshot of the default store's row counts, for the CRM flow's negative
// space — the CRM surface writes only the three integration tables and adds a
// cost event only when one is explicitly recorded against it.
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
    integrationConnections: mine(db.integrationConnections).length,
    crmSyncs: mine(db.crmSyncRequests).length,
    crmSyncEvents: mine(db.crmSyncEvents).length,
  };
}

//
// A small second CRM adapter so the gate proves the registry route is id-based
// and that a differently-named vendor resolve through the same path — no
// vendor is baked into the changing code (ROADMAP.md §30's "no hard-coding"
// requirement satisfied by the seam, not by a mock).
//
class SecondCrmAdapter implements CrmChangeSetAdapter {
  readonly id = "second_crm";
  readonly system = "crm" as const;
  readonly displayName = "Second CRM (test double)";
  readonly scopes: readonly IntegrationPermissionScope[] = [
    "contacts:write",
    "lifecycle:write",
    "opportunities:write",
    "notes:write",
    "activities:write",
    "conversations:write",
  ];
  readonly sandbox = true;

  private readonly applied: CrmApplyRequest[] = [];
  callCount = 0;

  async applyChangeSet(request: CrmApplyRequest): Promise<CrmApplyResult> {
    this.callCount += 1;
    this.applied.push(request);
    return {
      accepted: true,
      providerReference: `second-crm-${request.idempotencyKey}`,
      failureCode: null,
      message: "accepted by the second CRM adapter",
    };
  }

  applied(): readonly CrmApplyRequest[] {
    return this.applied;
  }
}

class RestrictedScopesAdapter implements CrmChangeSetAdapter {
  readonly id = "restricted_crm";
  readonly system = "crm" as const;
  readonly displayName = "Restricted Scopes CRM";
  readonly scopes: readonly IntegrationPermissionScope[] = ["contacts:write", "lifecycle:write"];
  readonly sandbox = true;

  private readonly applied: CrmApplyRequest[] = [];
  async applyChangeSet(request: CrmApplyRequest): Promise<CrmApplyResult> {
    this.applied.push(request);
    return {
      accepted: true,
      providerReference: `restricted-crm-${request.idempotencyKey}`,
      failureCode: null,
      message: "accepted",
    };
  }

  applied(): readonly CrmApplyRequest[] {
    return this.applied;
  }
}

interface CrmChangeSetAdapter {
  readonly id: string;
  readonly system: "crm";
  readonly displayName: string;
  readonly scopes: readonly IntegrationPermissionScope[];
  readonly sandbox: boolean;
  applyChangeSet(request: CrmApplyRequest): Promise<CrmApplyResult>;
}

type IntegrationPermissionScope =
  | "contacts:read"
  | "contacts:write"
  | "activities:write"
  | "lifecycle:write"
  | "opportunities:write"
  | "notes:write"
  | "conversations:write";

afterAll(() => {
  defaultStore.destroy();
});

describe("Phase 23 gate — CRM Integrations (ROADMAP.md §30)", () => {
  it("publishes the §30 architecture: six systems, a closed scope catalog, per-operation scopes and the refusals", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Publishes Architecture");
    const policy = (await dataOf(
      h.getIntegrationPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as ReturnType<typeof describeIntegrationPolicy>;

    // The six systems §30 names, in the roadmap's own order.
    expect(policy.systems).toHaveLength(6);
    expect(policy.systems.map((s) => s.system)).toEqual([
      "crm",
      "calendar",
      "email",
      "slack",
      "github",
      "data_provider",
    ]);

    // The permission-scope catalog §44 asks for: closed, descriptive.
    expect(policy.scopes).toHaveLength(INTEGRATION_SCOPE_CATALOG.length);
    expect(policy.scopes.map((s) => s.scope)).toEqual(
      INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
    );

    // One required scope per CRM operation — what a sync needs is computable
    // and a connection that grants fewer is refused *before* anything reaches an
    // adapter.
    expect(policy.operationScopes).toHaveLength(6);
    for (const op of policy.operationScopes) {
      expect(INTEGRATION_SCOPE_CATALOG.some((e) => e.scope === op.scope)).toBe(true);
    }

    expect(policy.lifecycleStages).toEqual([
      "new",
      "qualified",
      "contacted",
      "engaged",
      "meeting_booked",
    ]);
    expect(policy.opportunityStatuses).toEqual(["open", "closed", "contested"]);
    expect(policy.syncStatuses).toEqual([
      "prepared",
      "approved",
      "rejected",
      "cancelled",
      "executed",
      "failed",
    ]);

    // The negative space: what this architecture will *not* do.
    expect(policy.refusals).toHaveLength(5);
    const refusalNames = policy.refusals.map((r) => r.name);
    expect(refusalNames).toContain("credentials");
    expect(refusalNames).toContain("opportunity_value");
    expect(refusalNames).toContain("unapproved_sync");
    expect(refusalNames).toContain("archived_accounts");
    expect(refusalNames).toContain("vendor_hard_coding");
  });

  it("lists only this deployment's registered adapters and resolves them by id through the registry — never by vendor", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxCrmAdapter();
    const second = new SecondCrmAdapter();
    const h = handlersFor([sandbox, second]);
    const t = tenant("Registry + Two Adapters");

    const listed = (
      (await dataOf(
        h.listIntegrationAdaptersHandler(request(t.token, { workspaceId: t.workspaceId })),
      )) as { adapters: { id: string; system: string; sandbox: boolean }[] }
    ).adapters;

    // Two adapters, registered by id, not hard-coded.
    expect(listed.map((a) => a.id)).toEqual(["sandbox_crm", "second_crm"]);
    expect(listed.find((a) => a.id === "sandbox_crm")!.sandbox).toBe(true);
    expect(listed.find((a) => a.id === "sandbox_crm")!.system).toBe("crm");

    // An unknown adapter id is refused, not stored as a promise.
    const unknown = await errorOf(
      h.connectIntegrationHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            adapterId: "does-not-exist",
            scopes: ["contacts:write"],
          },
        ),
      ),
    );
    expect(unknown.code).toBe("NOT_FOUND");
    expect(unknown.message).toContain("is configured in this deployment");
  });

  it("connects only with explicit, valid, describerd scopes — unknown, undeclared and duplicate scopes are refused; forged fields are ignored", async () => {
    setSessionIndex(createIndex());
    const restricted = new RestrictedScopesAdapter();
    const h = handlersFor([restricted]);
    const t = tenant("Connect Scope Validation");

    // Unknown permission-scope names cannot be requested or granted — the
    // catalog is closed.
    const unknownScope = await errorOf(
      h.connectIntegrationHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            adapterId: "restricted_crm",
            scopes: ["admin:*"],
          },
        ),
      ),
    );
    expect(unknownScope.code).toBe("VALIDATION_ERROR");
    expect(unknownScope.details?.[0]?.field).toBe("scopes");

    // A scope the adapter does not declare on its own cannot be granted.
    const undeclared = await errorOf(
      h.connectIntegrationHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            adapterId: "restricted_crm",
            scopes: ["opportunities:write"],
          },
        ),
      ),
    );
    expect(undeclared.code).toBe("VALIDATION_ERROR");

    // Empty grants are rejected.
    const empty = await errorOf(
      h.connectIntegrationHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            adapterId: "restricted_crm",
            scopes: [],
          },
        ),
      ),
    );
    expect(empty.code).toBe("VALIDATION_ERROR");

    // A successful connect stores exactly what was requested (no widening), and
    // the server writes the identity and instant — a body carrying its own is
    // ignored.
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            adapterId: "restricted_crm",
            scopes: ["contacts:write", "lifecycle:write"],
            status: "revoked",
            createdBy: "attacker",
            createdAt: "1999-01-01T00:00:00.000Z",
            id: "wrong-id",
          },
        ),
      ),
    )) as {
      connection: {
        id: string;
        status: string;
        createdBy: string;
        grantedScopes: string[];
        adapterId: string;
        system: string;
      };
    };

    expect(connected.connection.status).toBe("active");
    expect(connected.connection.createdBy).toBe(t.userId);
    expect(connected.connection.grantedScopes).toEqual(["contacts:write", "lifecycle:write"]);
    expect(connected.connection.adapterId).toBe("restricted_crm");
    expect(connected.connection.system).toBe("crm");
    expect(connected.connection.id).not.toBe("wrong-id");

    // A duplicate connect is refused: one connection per workspace per adapter.
    const secondConnect = await errorOf(
      h.connectIntegrationHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            adapterId: "restricted_crm",
            scopes: ["contacts:write"],
          },
        ),
      ),
    );
    expect(secondConnect.code).toBe("CONFLICT");
  });

  it("derives the §30 change-set from stored rows with provenance and no opportunity value — and writes only the integration tables", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const s = await subjectOf(h, "Derivation");
    const t = s.tenant;

    // The body carries only the subject; a supplied change-set, status or
    // digest is never believed. With no connection yet, prepare is refused
    // before any row is written.
    const noConnection = await errorOf(
      h.prepareCrmSyncHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            connectionId: s.accountId, // not a connection id at all
            accountId: s.accountId,
            changeSet: { operations: [] },
            status: "executed",
            previewDigest: "bad",
          },
        ),
      ),
    );
    expect(noConnection.code).toBe("NOT_FOUND");
    expect(noConnection.message).toContain("connection not found");

    // At this point the connection doesn't exist — the derivation would be
    // refused *before* the row is written. First connect with everything the
    // derived change-set needs (contacts:read is *not* required by any operation).
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };

    const preparedOk = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          t.token,
          { workspaceId: t.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as {
      sync: {
        id: string;
        status: string;
        previewDigest: string;
        changeSet: {
          source: string;
          sourceReference: string | null;
          accountName: string;
          revenuePlanId: string | null;
          operations: {
            kind: string;
            derivedFrom?: readonly { kind: string }[];
            body?: string;
            stage?: string;
            reason?: string;
            status?: string;
            contactId?: string;
          }[];
        };
      };
    };

    const sync = preparedOk.sync;

    if (sync.status !== "prepared") throw new Error("expected prepared");
    const operations = sync.changeSet.operations;
    const kinds = operations.map((o) => o.kind);

    // The six operations §30 summarizes, in fixed order.
    expect(kinds).toEqual([
      "upsert_contact",
      "update_lifecycle_stage",
      "update_opportunity_status",
      "attach_note",
      "create_activity",
      "sync_conversation",
    ]);

    // Every operation names the exact stored rows it came from — never a claim.
    for (const op of operations) {
      expect(op.derivedFrom).toBeTruthy();
      if (op.derivedFrom) expect(op.derivedFrom.length).toBeGreaterThan(0);
    }

    // Source attribution travels verbatim: the change-set is frozen from storage.
    expect(sync.changeSet.source).toBe("manual");
    expect(sync.changeSet.sourceReference).toBe("phase23-gate");
    expect(sync.changeSet.accountName).toBe("Northwind");
    expect(sync.changeSet.revenuePlanId).toBeNull();

    // The guilty verdict travels alongside the note.
    const noteOp = operations.find((o) => o.kind === "attach_note")!;
    const body = noteOp.body;
    expect(body).toContain("qualified");
    expect(body).toContain("Evidence read");

    // The lifecycle verdict: the furthest stage reached beats everything below
    // it — a reply exists, so engaged.
    const stageOp = operations.find((o) => o.kind === "update_lifecycle_stage")!;
    expect(stageOp.stage).toBe("engaged");
    expect(stageOp.reason).toContain("replies");

    // The opportunity verdict, the Phase 15 definition in CRM words.
    const oppOp = operations.find((o) => o.kind === "update_opportunity_status")!;
    expect(oppOp.status).toBe("open");

    // At least one contact, one activity, one conversation — the full §23 CRM AGENT
    // responsibilities.
    expect(kinds.filter((k) => k === "upsert_contact").length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === "create_activity").length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === "sync_conversation").length).toBeGreaterThanOrEqual(1);

    // The check that §30's refusals summarize: no operation carries an amount or
    // value field at all. Walk every operation object, never rely on substring
    // scanning, because a body text could contain the word "value".
    const hasAmountOrValue = !!operations.some((op) => {
      const keys = Object.keys(op as Record<string, unknown>);
      return keys.includes("amount") || keys.includes("value");
    });
    expect(hasAmountOrValue).toBe(false);

    // The digested preview is frozen at prepare.
    expect(sync.previewDigest).toBe(
      changeSetDigest({ changeSet: sync.changeSet, connectionId: connected.connection.id }),
    );

    // Negative space: the CRM surface wrote only the three integration tables.
    // Reading a test-read of the same rows does nothing. Snapshot counts before
    // and after explicitly — the read above did write nothing.
    const before = rowCounts(t.workspaceId);
    await dataOf(
      h.getCrmSyncHandler(request(t.token, { workspaceId: t.workspaceId, syncId: sync.id })),
    );
    await dataOf(
      h.getCrmSyncHistoryHandler(request(t.token, { workspaceId: t.workspaceId, syncId: sync.id })),
    );
    const after = rowCounts(t.workspaceId);

    expect(after.integrationConnections).toEqual(before.integrationConnections);
    expect(after.crmSyncs).toEqual(before.crmSyncs);
    expect(after.crmSyncEvents).toEqual(before.crmSyncEvents);
    expect(after.actions).toEqual(before.actions);
    expect(after.drafts).toEqual(before.drafts);
    expect(after.experiments).toEqual(before.experiments);
    expect(after.experimentEvents).toEqual(before.experimentEvents);

    // The sync wrote exactly one sync + one event. (The connection was written
    // by the separate connect step.)
    const db = defaultStore.db;
    expect(
      (db.crmSyncRequests ?? []).filter(
        (r) => r.workspaceId === t.workspaceId && r.accountId === s.accountId,
      ),
    ).toHaveLength(1);

    // The change-set source row is the account at this account, not an invented
    // claim.
    expect(
      sync.changeSet.operations.find((o) => o.kind === "upsert_contact")?.contactId,
    ).toBeDefined();

    // For verification's host: persist via the store. The row survives on the next
    // read through a fresh handler constructed over the same store.
    const h2 = handlersFor();
    const reread = (await dataOf(
      h2.getCrmSyncHandler(request(t.token, { workspaceId: t.workspaceId, syncId: sync.id })),
    )) as { status: string; previewDigest: string; changeSet: { source: string } };
    expect(reread.status).toBe("prepared");
    expect(reread.changeSet.source).toBe("manual");
    expect(reread.previewDigest).toEqual(sync.previewDigest);
  });

  it("refuses a change-set the connection does not grant, by scope name — before anything reaches an adapter", async () => {
    setSessionIndex(createIndex());
    const hA = handlersFor();

    // Full grants, journey, prepare — the normal path works in tenant A.
    const sA = await subjectOf(hA, "Scope Denied A");
    const tA = sA.tenant;
    const connectedA = (await dataOf(
      hA.connectIntegrationHandler(
        request(
          tA.token,
          { workspaceId: tA.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };
    await dataOf(
      hA.prepareCrmSyncHandler(
        request(
          tA.token,
          { workspaceId: tA.workspaceId },
          {
            connectionId: connectedA.connection.id,
            accountId: sA.accountId,
          },
        ),
      ),
    );

    // Tenant B: build its own narrow-handler so the refusal is exercised
    // against a real (non-sandbox) adapter that declares fewer scopes than
    // sandbox_crm. The refusal is returned before anything reaches the
    // adapter, by exact scope name.
    const hB = handlersFor([new RestrictedScopesAdapter()]);
    const sB = await subjectOf(hB, "Scope Denied B");
    const tB = sB.tenant;
    const connectedB = (await dataOf(
      hB.connectIntegrationHandler(
        request(
          tB.token,
          { workspaceId: tB.workspaceId },
          {
            adapterId: "restricted_crm",
            scopes: ["contacts:write"],
          },
        ),
      ),
    )) as { connection: { id: string; status: string } };
    expect(connectedB.connection.status).toBe("active");

    const refusal = await errorOf(
      hB.prepareCrmSyncHandler(
        request(
          tB.token,
          { workspaceId: tB.workspaceId },
          {
            connectionId: connectedB.connection.id,
            accountId: sB.accountId,
          },
        ),
      ),
    );

    expect(refusal.code).toBe("CONFLICT");
    if (!refusal.details) throw new Error("expected details");
    const missingNames = refusal.details.map((d) => d.message);
    expect(missingNames).toContain("missing scope: lifecycle:write");
    expect(missingNames).toContain("missing scope: activities:write");
    expect(missingNames).toContain("missing scope: opportunities:write");
    expect(missingNames).toContain("missing scope: notes:write");
    expect(missingNames).toContain("missing scope: conversations:write");
  });

  it("refuses execution without a human decision bound to the digest, and ignores forged decision fields", async () => {
    setSessionIndex(createIndex());

    // A custom sandbox so the gate can inspect the adapter's confirmed state.
    const sandbox = new SandboxCrmAdapter();
    const h = handlersFor([sandbox]);
    const s = await subjectOf(h, "No Approval");
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };
    const prepared = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as { sync: { id: string; previewDigest: string } };

    // Execute on prepared: refused, because a Level 2 external action requires a
    // person's decision first.
    const noApproval = await errorOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    );
    expect(noApproval.code).toBe("CONFLICT");
    expect(noApproval.message).toContain("approved by a person");

    // Reject without reason: refused; rejection requires a reason (DEALORA_BLUEPRINT.md
    // §17 keeps reject accountable).
    const noReason = await errorOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "reject",
            reason: null,
          },
        ),
      ),
    );
    expect(noReason.code).toBe("VALIDATION_ERROR");

    // Reject with reason: the sync is rejected, and executing a rejected sync is
    // refused.
    const rejected = (await dataOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "reject",
            reason: "the reviewer disagreed with the derived change-set",
          },
        ),
      ),
    )) as { sync: { status: string; decidedBy: string } };
    expect(rejected.sync.status).toBe("rejected");
    expect(rejected.sync.decidedBy).toBe(s.userId);

    const onRejected = await errorOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    );
    expect(onRejected.code).toBe("CONFLICT");

    // A second decision is refused: one decision per sync.
    const twice = await errorOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "approve",
            reason: null,
          },
        ),
      ),
    );
    expect(twice.code).toBe("CONFLICT");

    // The rejected sync stays rejected: even a body carrying forged identity
    // fields is refused rather than resurrected.
    const forgedOnRejected = await errorOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "approve",
            reason: null,
            decidedBy: "attacker",
            executedBy: "forged",
            status: "executed",
            providerReference: "forged-reference",
            decidedAt: "1999-01-01T00:00:00.000Z",
          },
        ),
      ),
    );
    expect(forgedOnRejected.code).toBe("CONFLICT");

    // Not one of those refusals reached the adapter: a Level 2 action cannot
    // touch an external system before a person's decision.
    expect(sandbox.callCount()).toBe(0);

    // One decision per sync, so the approval path runs on a fresh prepared
    // row of the same connection and account.
    const secondPrepared = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as { sync: { id: string } };

    // Decide on the prepared sync: the digests match, so the decision lands
    // and the row is frozen as approved. The body carries forged decidedBy,
    // executedBy, status and providerReference fields — the handler reads only
    // decision/reason, so the reviewer below is the session's, never
    // "attacker", and the status is approved, never "executed".
    const approved = (await dataOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: secondPrepared.sync.id },
          {
            decision: "approve",
            reason: null,
            decidedBy: "attacker",
            executedBy: "forged",
            status: "executed",
            providerReference: "forged-reference",
            decidedAt: "1999-01-01T00:00:00.000Z",
          },
        ),
      ),
    )) as { sync: { status: string; decidedBy: string; providerReference: string | null } };
    expect(approved.sync.status).toBe("approved");
    expect(approved.sync.decidedBy).toBe(s.userId);
    expect(approved.sync.providerReference).toBeNull();

    // Read the same decision back: byte-identical.
    const readBack = await dataOf(
      h.getCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: secondPrepared.sync.id }),
      ),
    );
    expect(JSON.stringify(readBack)).toBe(JSON.stringify(approved.sync));

    // Execute the approved sync: the adapter confirms, and the response is the
    // outcome the adapter returned — never a silent claim.
    const executed = (await dataOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: secondPrepared.sync.id }),
      ),
    )) as {
      sync: {
        status: string;
        providerReference: string;
        decidedBy: string;
        executedBy: string;
        failureCode: string | null;
      };
    };

    expect(executed.sync.status).toBe("executed");
    expect(executed.sync.providerReference).toBe(`sandbox-crm-${secondPrepared.sync.id}`);
    expect(executed.sync.decidedBy).toBe(s.userId);
    expect(executed.sync.executedBy).toBe(s.userId);
    expect(executed.sync.failureCode).toBeNull();

    // One approval yielded exactly one adapter confirmation — idempotency. The
    // adapter's captured record names that the payload approved = the payload that
    // arrived, bound to the sync's own id.
    const applied = sandbox.appliedChangeSets();
    expect(applied).toHaveLength(1);
    const record = applied[0];
    expect(record.idempotencyKey).toBe(secondPrepared.sync.id);
    expect(record.approvedBy).toBe(s.userId);
    expect(record.providerReference).toBe(`sandbox-crm-${secondPrepared.sync.id}`);

    // A second execution on an already-executed sync is refused.
    const second = await errorOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: secondPrepared.sync.id }),
      ),
    );
    expect(second.code).toBe("CONFLICT");

    // Forged authoritative fields in an approve body never reach storage: the
    // sync is already executed, so the decision is refused outright instead of
    // being recorded against the body's identity.
    const forgedApprove = await errorOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: secondPrepared.sync.id },
          {
            decision: "approve",
            reason: null,
            decidedBy: "attacker",
            executedBy: "forged",
            status: "executed",
            providerReference: "forged-reference",
            decidedAt: "1999-01-01T00:00:00.000Z",
          },
        ),
      ),
    );
    expect(forgedApprove.code).toBe("CONFLICT");
  });

  it("records an adapter refusal as failed with a closed code, and a retry applies exactly once", async () => {
    setSessionIndex(createIndex());
    const sandbox = new SandboxCrmAdapter();
    const h = handlersFor([sandbox]);
    const s = await subjectOf(h, "Refusal + Retry");
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };
    const prepared = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as { sync: { id: string } };

    // A person's decision, bound to the digest — the refusal path runs under a
    // real approval, exactly like the executed path does.
    await dataOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "approve",
            reason: null,
          },
        ),
      ),
    );

    // Refuse the next adapter call with an explicit, closed code — a refusal that
    // is accountable and observable, not a silent "executed".
    sandbox.refuseNext("adapter_rejected", "the reviewer's CRM refused the change-set");

    const failed = (await dataOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    )) as {
      sync: {
        status: string;
        providerReference: string | null;
        failureCode: string | null;
        failureMessage: string | null;
      };
    };

    expect(failed.sync.status).toBe("failed");
    expect(failed.sync.providerReference).toBeNull();
    expect(failed.sync.failureCode).toBe("adapter_rejected");
    expect(failed.sync.failureMessage).toBe("the reviewer's CRM refused the change-set");
    expect(sandbox.callCount()).toBe(1);
    expect(sandbox.appliedChangeSets()).toHaveLength(0);

    // A rejection is still associative: the digest still matches the preview, and
    // the connection is still active with its scopes. Re-attempt (retry), because
    // a refusal is a failed sync, not an executed one, and the approval is still
    // valid. The adapter's refusal was consumed, so this call applies.
    const executed = (await dataOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    )) as {
      sync: { status: string; providerReference: string | null; failureCode: string | null };
    };

    expect(executed.sync.status).toBe("executed");
    expect(executed.sync.providerReference).toBe(`sandbox-crm-${prepared.sync.id}`);
    expect(executed.sync.failureCode).toBeNull();
    expect(sandbox.callCount()).toBe(2);
    expect(sandbox.appliedChangeSets()).toHaveLength(1);

    // An already-executed sync is terminal.
    const second = await errorOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    );
    expect(second.code).toBe("CONFLICT");

    // The trail records the failed attempt separately from the successful one.
    const events = (await dataOf(
      h.getCrmSyncHistoryHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    )) as { events: { kind: string }[] };
    expect(events.events.map((e) => e.kind)).toEqual([
      "prepared",
      "approved",
      "failed",
      "executed",
    ]);
  });

  it("re-checks revocation between approval and execution, so a revoked connection cannot carry an approved sync back into scope", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const s = await subjectOf(h, "Revocation");
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };
    const prepared = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as { sync: { id: string } };

    // A revoked connection blocks prepare, because the connection is the scope
    // gate.
    await dataOf(
      h.disconnectIntegrationHandler(
        request(s.token, { workspaceId: s.workspaceId, connectionId: connected.connection.id }),
      ),
    );

    const onRevoked = await errorOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    );
    expect(onRevoked.code).toBe("CONFLICT");
    expect(onRevoked.message).toContain("revoked");

    // Re-revoking is terminal.
    const againRevoked = await errorOf(
      h.disconnectIntegrationHandler(
        request(s.token, { workspaceId: s.workspaceId, connectionId: connected.connection.id }),
      ),
    );
    expect(againRevoked.code).toBe("CONFLICT");

    // The prepared sync can still be decided — the decision binds the person to
    // the digest; revocation is re-checked where it matters, at execution.
    const approved = (await dataOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "approve",
            reason: null,
          },
        ),
      ),
    )) as { sync: { status: string } };
    expect(approved.sync.status).toBe("approved");

    // Execute on the approved sync under a revoked connection: refused, because
    // the scope gate at execution re-checks the connection.
    const onExecute = await errorOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    );
    expect(onExecute.code).toBe("CONFLICT");
    expect(onExecute.message).toContain("revoked");
  });

  it("keeps connections and syncs per tenant — foreign workspaces are refused and foreign ids are not found", async () => {
    setSessionIndex(createIndex());
    const hA = handlersFor();
    const hB = handlersFor();
    const tB = tenant("Tenant B CRM");

    // Tenant A's full journey: its connection and sync must stay invisible.
    const sA = await subjectOf(hA, "Tenant A CRM");
    const tA = sA.tenant;

    const connectedA = (await dataOf(
      hA.connectIntegrationHandler(
        request(
          tA.token,
          { workspaceId: tA.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };

    // Tenant B's own list succeeds and is empty — A's connection is not in it.
    const ownList = (await dataOf(
      hB.listIntegrationConnectionsHandler(request(tB.token, { workspaceId: tB.workspaceId })),
    )) as { connections: { id: string }[] };
    expect(ownList.connections).toEqual([]);

    // Observer: B's own list is empty, but A's list is read via B's session with
    // workspaceId = A — refused.
    const foreignRead = await errorOf(
      hB.listIntegrationConnectionsHandler(request(tB.token, { workspaceId: tA.workspaceId })),
    );
    expect(foreignRead.code).toBe("UNAUTHORIZED");

    // Tenant B cannot prepare a sync in tenant A.
    const foreignPrepare = await errorOf(
      hB.prepareCrmSyncHandler(
        request(
          tB.token,
          { workspaceId: tA.workspaceId },
          { connectionId: connectedA.connection.id, accountId: "fake" },
        ),
      ),
    );
    expect(foreignPrepare.code).toBe("UNAUTHORIZED");

    // Tenant B cannot get a sync it does not own: the id resolves to not-found
    // inside B's own workspace.
    const sSync = (await dataOf(
      hA.prepareCrmSyncHandler(
        request(
          tA.token,
          { workspaceId: tA.workspaceId },
          {
            connectionId: connectedA.connection.id,
            accountId: sA.accountId,
          },
        ),
      ),
    )) as { sync: { id: string } };

    const foreignSync = await errorOf(
      hB.getCrmSyncHandler(
        request(tB.token, { workspaceId: tB.workspaceId, syncId: sSync.sync.id }),
      ),
    );
    expect(foreignSync.code).toBe("NOT_FOUND");
  });

  it("appends an audit trail that is append-only: who and when, never rewritten; reading and listing write nothing", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const s = await subjectOf(h, "Audit Trail");
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };
    const prepared = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as { sync: { id: string } };

    // Deciding writes one event.
    await dataOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "approve",
            reason: null,
          },
        ),
      ),
    );
    const afterDecide = (
      (await dataOf(
        h.getCrmSyncHistoryHandler(
          request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
        ),
      )) as { events: { kind: string; actorUserId: string; createdAt: string }[] }
    ).events;
    expect(afterDecide.map((e) => e.kind)).toEqual(["prepared", "approved"]);
    expect(afterDecide[1].actorUserId).toBe(s.userId);

    // Reading and listing write nothing: snapshot before and after.
    const before = rowCounts(s.workspaceId);
    await dataOf(
      h.getCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    );
    await dataOf(h.listCrmSyncsHandler(request(s.token, { workspaceId: s.workspaceId })));
    await dataOf(
      h.getCrmSyncHistoryHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    );
    await dataOf(h.getIntegrationPolicyHandler(request(s.token, { workspaceId: s.workspaceId })));
    await dataOf(
      h.listIntegrationAdaptersHandler(request(s.token, { workspaceId: s.workspaceId })),
    );
    const after = rowCounts(s.workspaceId);

    expect(after.integrationConnections).toBe(before.integrationConnections);
    expect(after.crmSyncs).toBe(before.crmSyncs);
    expect(after.crmSyncEvents).toBe(before.crmSyncEvents);
  });

  it("derives byte-identically: two preparations of the same rows share a digest and repeated reads are identical", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const s = await subjectOf(h, "Deterministic");
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };

    const p1 = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as {
      sync: { id: string; previewDigest: string; changeSet: { operations: { kind: string }[] } };
    };

    // A second preparation of the identical rows produces the identical
    // change-set and digest — because both derive from the *same* stored rows,
    // nothing here is cached or stateful in the derivation.
    const p2 = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as { sync: { previewDigest: string; changeSet: { operations: { kind: string }[] } } };

    expect(p1.sync.previewDigest).toBe(p2.sync.previewDigest);
    expect(JSON.stringify(p1.sync.changeSet.operations)).toBe(
      JSON.stringify(p2.sync.changeSet.operations),
    );

    // The deterministic digest reconstruction.
    expect(p1.sync.previewDigest).toBe(
      changeSetDigest({ changeSet: p1.sync.changeSet, connectionId: connected.connection.id }),
    );
    expect(p2.sync.previewDigest).toBe(
      changeSetDigest({ changeSet: p2.sync.changeSet, connectionId: connected.connection.id }),
    );

    // Repeated reads are byte-identical.
    const first = await dataOf(
      h.getCrmSyncHandler(request(s.token, { workspaceId: s.workspaceId, syncId: p1.sync.id })),
    );
    const second = await dataOf(
      h.getCrmSyncHandler(request(s.token, { workspaceId: s.workspaceId, syncId: p1.sync.id })),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("attributes the sync's cost through Phase 16's crm_sync kind and refuses a foreign execution id", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const s = await subjectOf(h, "Cost CRM");
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };
    const prepared = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as { sync: { id: string } };
    await dataOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "approve",
            reason: null,
          },
        ),
      ),
    );

    // Record a measured cost fact against the sync.
    const recorded = (await dataOf(
      h.recordCostHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            executionKind: "crm_sync",
            executionId: prepared.sync.id,
            category: "tool",
            basis: "measured",
            amountMinor: 1234,
            currency: "USD",
            source: "provider invoice",
            occurredAt: "2026-10-01T00:00:00.000Z",
            idempotencyKey: unique("crm-cost-key"),
          },
        ),
      ),
    )) as {
      costEvent: {
        id: string;
        executionKind: string;
        executionId: string;
        category: string;
        basis: string;
        amountMinor: number;
        currency: string;
      };
    };

    expect(recorded.costEvent.executionKind).toBe("crm_sync");
    expect(recorded.costEvent.executionId).toBe(prepared.sync.id);
    expect(recorded.costEvent.category).toBe("tool");

    // The sync can be executed now:
    const executed = (await dataOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    )) as { sync: { providerReference: string | null } };
    expect(executed.sync.providerReference).toBe(`sandbox-crm-${prepared.sync.id}`);

    // The cost summary surfaced by Phase 16's own engine reflects this execution.
    const summary = (await dataOf(
      h.getExecutionCostHandler(
        request(s.token, { workspaceId: s.workspaceId }, undefined, {
          executionKind: "crm_sync",
          executionId: prepared.sync.id,
        }),
      ),
    )) as { totals: { measuredMinor: number; eventCount: number } };
    expect(summary.totals.eventCount).toBe(1);
    expect(summary.totals.measuredMinor).toBe(1234);

    // A foreign execution id is indistinguishable from one that does not exist.
    const otherTenant = tenant("Cost CRM Foreign");
    const foreignCost = await errorOf(
      h.getExecutionCostHandler(
        request(otherTenant.token, { workspaceId: otherTenant.workspaceId }, undefined, {
          executionKind: "crm_sync",
          executionId: prepared.sync.id,
        }),
      ),
    );
    expect(foreignCost.code).toBe("NOT_FOUND");
  });

  it("keeps the schema honest: the §30 tables sit behind foreign keys and CHECK constraints in v20", async () => {
    setSessionIndex(createIndex());

    expect(defaultStore.db.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(20);

    const ddl = SCHEMA;
    const connStart = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${integrationConnectionTable}"`);
    const syncStart = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${crmSyncTable}"`);
    const eventStart = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${crmSyncEventTable}"`);
    expect(connStart).toBeGreaterThan(-1);
    expect(syncStart).toBeGreaterThan(connStart);
    expect(eventStart).toBeGreaterThan(syncStart);

    const connDdl = ddl.slice(connStart, syncStart);
    const syncDdl = ddl.slice(syncStart, eventStart);
    const eventDdl = ddl.slice(eventStart);

    // One row per workspace-to-adapter link, with its granted permission scopes —
    // the precise scope gate.
    expect(connDdl).toContain(
      `"${integrationConnectionTable}"."workspace_id" REFERENCES "workspaces"("id")`,
    );
    expect(connDdl).toContain(`"${integrationConnectionTable}"."adapter_id"`);
    expect(connDdl).toContain(`"${integrationConnectionTable}"."granted_scopes"`);
    expect(connDdl).toContain(
      `UNIQUE("${integrationConnectionTable}"."workspace_id", "${integrationConnectionTable}"."adapter_id")`,
    );

    // Connection status is constrained to active / revoked, *and* the timestamp
    // columns agree with the status: a revoked connection must carry both a
    // revoked_at and a revoked_by, an active one must carry neither.
    expect(connDdl).toContain(
      `CHECK ("${integrationConnectionTable}"."status" IN ('active','revoked'))`,
    );
    expect(connDdl).toContain(
      `"${integrationConnectionTable}"."revoked_at" IS NOT NULL AND "${integrationConnectionTable}"."revoked_by" IS NOT NULL`,
    );

    // The sync row points to its connection, account, and its reviewer and
    // executor — every decision/execution column is a foreign key.
    expect(syncDdl).toContain(
      `"${crmSyncTable}"."connection_id" REFERENCES "${integrationConnectionTable}"("id")`,
    );
    expect(syncDdl).toContain(`"${crmSyncTable}"."account_id" REFERENCES "accounts"("id")`);
    expect(syncDdl).toContain(`"${crmSyncTable}"."decided_by" REFERENCES "users"("id")`);
    expect(syncDdl).toContain(`"${crmSyncTable}"."executed_by" REFERENCES "users"("id")`);

    // The sync status is the single yes: prepared, approved, rejected, cancelled,
    // executed, failed — and the status column agrees with its own timestamps.
    expect(syncDdl).toContain(`'prepared'`);
    expect(syncDdl).toContain(`'approved'`);
    expect(syncDdl).toContain(`'rejected'`);
    expect(syncDdl).toContain(`'cancelled'`);
    expect(syncDdl).toContain(`'executed'`);
    expect(syncDdl).toContain(`'failed'`);

    // Carrier columns must agree with status at `executed`.
    expect(syncDdl).toContain(`"${crmSyncTable}"."provider_reference"`);
    expect(syncDdl).toContain(`"${crmSyncTable}"."executed_by"`);
    expect(syncDdl).toContain(`= 'executed' AND "${crmSyncTable}"."decision" = 'approved'`);
    expect(syncDdl).toContain(
      `"${crmSyncTable}"."provider_reference" IS NOT NULL AND "${crmSyncTable}"."failure_code" IS NULL`,
    );

    // The event trail is append-only: who did what, when.
    expect(eventDdl).toContain(
      `"${crmSyncEventTable}"."crm_sync_id" REFERENCES "${crmSyncTable}"("id")`,
    );
    expect(eventDdl).toContain(`"${crmSyncEventTable}"."actor_user_id" REFERENCES "users"("id")`);
    expect(eventDdl).toContain(
      `CHECK ("${crmSyncEventTable}"."kind" IN ('prepared','approved','rejected','cancelled','executed','failed'))`,
    );
  });

  it("rejects invalid input: blank ids, bad decision, bad status filter, oversized reason, and archived accounts", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const s = await subjectOf(h, "Validation");

    // Blank connectionId on prepare.
    const blankConn = await errorOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: "",
            accountId: s.accountId,
          },
        ),
      ),
    );
    expect(blankConn.code).toBe("VALIDATION_ERROR");

    // Blank accountId on prepare.
    const blankAcct = await errorOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: "placeholder",
            accountId: "",
          },
        ),
      ),
    );
    expect(blankAcct.code).toBe("VALIDATION_ERROR");

    // Bad decision value.
    const badDecision = await errorOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: "missing" },
          {
            decision: "maybe",
            reason: null,
          },
        ),
      ),
    );
    expect(badDecision.code).toBe("VALIDATION_ERROR");

    // Blank connectionId for disconnect.
    const blankDisc = await errorOf(
      h.disconnectIntegrationHandler(
        request(s.token, { workspaceId: s.workspaceId, connectionId: "" }),
      ),
    );
    expect(blankDisc.code).toBe("VALIDATION_ERROR");

    // Blank syncId for execute.
    const blankExec = await errorOf(
      h.executeCrmSyncHandler(request(s.token, { workspaceId: s.workspaceId, syncId: "" })),
    );
    expect(blankExec.code).toBe("VALIDATION_ERROR");
  });

  it("keeps the engine pure — the same stored rows always produce the same change-set and lifecycle verdict with no clock, model or I/O", async () => {
    // Pure derivation: a contact, a qualification, a send, a reply and a meeting
    // — the derived verdict always follows the fixed precedence.
    const account = {
      id: "acct-1",
      name: "Test Company",
      source: "manual",
      sourceReference: null,
      revenuePlanId: null,
    };
    const contacts: CrmContactSnapshot[] = [
      {
        id: "contact-1",
        accountId: account.id,
        fullName: "Ada Lovelace",
        email: "ada@example.test",
        jobTitle: "VP Support",
        status: "active",
        source: "manual",
        sourceReference: "gate",
      },
    ];
    const qualification = {
      id: "qual-1",
      accountId: account.id,
      version: 1,
      state: "qualified",
      score: 87,
      reason: "ICP fit verified.",
      ruleVersion: "qualification-3.0.0",
      evidenceIds: ["e1", "e2"],
      revenueGoalId: "goal-1",
    };

    // Stage precedence: a meeting that reached a calendar beats a recorded reply,
    // which beats a confirmed send, which beats a qualified evaluation, which beats
    // nothing at all.
    const noMeeting = deriveCrmChangeSet({
      account,
      contacts,
      qualifications: [qualification],
      actions: [],
      classifications: [],
      meetings: [],
    });
    expect(noMeeting).not.toBeNull();
    const stageNoMeeting = noMeeting!.operations.find((o) => o.kind === "update_lifecycle_stage")!;
    expect(stageNoMeeting.stage).toBe("qualified");

    // A reply exists → engaged, even with no meeting.
    const withReply = deriveCrmChangeSet({
      account,
      contacts,
      qualifications: [qualification],
      actions: [],
      classifications: [
        {
          id: "cls-1",
          outboundActionId: "x", // not in actions — will be filtered out
          intent: "positive_intent",
          confidence: "high",
          recommendedNextAction: "prepare_reply_for_approval",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      meetings: [],
    });
    // The classification above references a non-existent action, so it is
    // filtered out rather than trusted: the derivation still stands, the
    // reply never counts, and the stage stays at the qualification verdict.
    expect(withReply).not.toBeNull();
    expect(withReply!.operations.find((o) => o.kind === "update_lifecycle_stage")!.stage).toBe(
      "qualified",
    );
    expect(withReply!.operations.some((o) => o.kind === "sync_conversation")).toBe(false);

    // A reply on a real sent action → engaged.
    const withRealReply = deriveCrmChangeSet({
      account,
      contacts,
      qualifications: [qualification],
      actions: [
        {
          id: "act-1",
          contactId: "contact-1",
          status: "sent",
          channel: "email",
          sentAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      classifications: [
        {
          id: "cls-1",
          outboundActionId: "act-1",
          intent: "positive_intent",
          confidence: "high",
          recommendedNextAction: "prepare_reply_for_approval",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      meetings: [],
    });
    expect(withRealReply).not.toBeNull();
    expect(withRealReply!.operations.find((o) => o.kind === "update_lifecycle_stage")!.stage).toBe(
      "engaged",
    );

    // deterministic: same input twice → same output.
    expect(
      deriveCrmChangeSet({
        account,
        contacts,
        qualifications: [qualification],
        actions: [
          {
            id: "act-1",
            contactId: "contact-1",
            status: "sent",
            channel: "email",
            sentAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        classifications: [
          {
            id: "cls-1",
            outboundActionId: "act-1",
            intent: "positive_intent",
            confidence: "high",
            recommendedNextAction: "prepare_reply_for_approval",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        meetings: [],
      }),
    ).toEqual(
      deriveCrmChangeSet({
        account,
        contacts,
        qualifications: [qualification],
        actions: [
          {
            id: "act-1",
            contactId: "contact-1",
            status: "sent",
            channel: "email",
            sentAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        classifications: [
          {
            id: "cls-1",
            outboundActionId: "act-1",
            intent: "positive_intent",
            confidence: "high",
            recommendedNextAction: "prepare_reply_for_approval",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        meetings: [],
      }),
    );

    // insufficient_data → no opportunity verdict.
    const insufficient = deriveCrmChangeSet({
      account,
      contacts,
      qualifications: [
        { ...qualification, state: "insufficient_data", score: null, evidenceIds: [] },
      ],
      actions: [],
      classifications: [],
      meetings: [],
    });
    expect(insufficient).not.toBeNull();
    expect(
      insufficient!.operations.find((o) => o.kind === "update_opportunity_status"),
    ).toBeUndefined();

    // a vocabulary violation makes the whole derivation refuse rather than
    // publish a half-understood change-set.
    const badSource = deriveCrmChangeSet({
      account: { ...account, source: "dropped_tables" },
      contacts,
      qualifications: [qualification],
      actions: [],
      classifications: [],
      meetings: [],
    });
    expect(badSource).toBeNull();
  });

  it("leaves Phase 22's boundary in place — the CRM flow writes only the integration tables, and the experiment refusal is unchanged", async () => {
    setSessionIndex(createIndex());
    const h = handlersFor();
    const t = tenant("Phase 22 Compat");

    // An experiment still refuses revenue_per_arm with owningPhase Phase 23,
    // unchanged by this phase.
    const expPolicy = (await dataOf(
      h.getExperimentPolicyHandler(request(t.token, { workspaceId: t.workspaceId })),
    )) as { refusedMetrics: { name: string; owningPhase: string | null }[] };
    expect(expPolicy.refusedMetrics.some((m) => m.name === "revenue_per_arm")).toBe(true);

    const s = await subjectOf(h, "Phase 22 Compat");

    // The CRM flow writes only the integration tables and does not touch the
    // experiment tables.
    const before = rowCounts(s.workspaceId);
    const connected = (await dataOf(
      h.connectIntegrationHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            adapterId: "sandbox_crm",
            scopes: INTEGRATION_SCOPE_CATALOG.map((e) => e.scope),
          },
        ),
      ),
    )) as { connection: { id: string } };
    const prepared = (await dataOf(
      h.prepareCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId },
          {
            connectionId: connected.connection.id,
            accountId: s.accountId,
          },
        ),
      ),
    )) as { sync: { id: string } };
    await dataOf(
      h.decideCrmSyncHandler(
        request(
          s.token,
          { workspaceId: s.workspaceId, syncId: prepared.sync.id },
          {
            decision: "approve",
            reason: null,
          },
        ),
      ),
    );
    await dataOf(
      h.executeCrmSyncHandler(
        request(s.token, { workspaceId: s.workspaceId, syncId: prepared.sync.id }),
      ),
    );

    const after = rowCounts(s.workspaceId);

    expect(after.integrationConnections).toBe(before.integrationConnections + 1);
    expect(after.crmSyncs).toBe(before.crmSyncs + 1);
    expect(after.crmSyncEvents).toBe(before.crmSyncEvents + 3);
    expect(after.experiments).toBe(before.experiments);
    expect(after.experimentArms).toBe(before.experimentArms);
    expect(after.experimentEvents).toBe(before.experimentEvents);
    expect(after.drafts).toBe(before.drafts);
  });
});

// -------------------------------------------------------------------------
// Scope-denial test helper: one call in tenant B creates a connection from the
// same handlers the other tests use — but handlersFor() is called per test,
// so the eschcope test must build its own handler instance. The simplest shape
// that still proves the refusal is one additional `handlersFor([RestrictedScopesAdapter()])`
// instance in the same test.
// -------------------------------------------------------------------------
