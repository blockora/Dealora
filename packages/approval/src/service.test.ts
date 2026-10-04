import { describe, expect, it } from "vitest";
import { Store, emptyState } from "@dealora/db";
import type { PersonalizedDraft } from "@dealora/db";

import {
  ApprovalService,
  approvesNothing,
  createApprovalService,
  toApprovalDraftSnapshot,
} from "./index.js";

/**
 * Phase 10 package tests — ROADMAP.md §17.
 *
 * The properties under test are the ones the phase exists for: an approval is a
 * persisted human decision about one exact immutable draft version, the reviewer
 * and the instant are recorded from the server's side, and nothing — no score,
 * no timer, no client field — can produce an approval on its own.
 */

/** A fixed clock, so every timestamp the engine writes is reproducible. */
function clockAt(iso: string): () => Date {
  return () => new Date(iso);
}

function seeded(now = "2026-10-01T00:00:00.000Z") {
  const store = new Store(emptyState());
  const user = store.createUser({
    email: "owner@example.com",
    password: "correct-horse-battery",
    displayName: "Owner",
  });
  if (!user.ok) throw new Error("seed user failed");
  const workspace = store.createWorkspace({ ownerId: user.value.id, name: "Acme Agency" });
  if (!workspace.ok) throw new Error("seed workspace failed");
  const draft = seedDraft(store, workspace.value.id, user.value.id);
  const service = createApprovalService(
    store as never,
    {
      byId: (draftId, userId) => {
        const found = store.getDraft(draftId, userId);
        return found.ok ? toApprovalDraftSnapshot(found.value) : null;
      },
      latestVersion: (draftId, userId) => {
        const found = store.getDraft(draftId, userId);
        return found.ok ? toApprovalDraftSnapshot(found.value) : null;
      },
    },
    clockAt(now),
  );
  return { store, user, workspace, draft, service };
}

/** One qualified-and-drafted account: a draft with real, quotable content. */
function seedDraft(store: Store, workspaceId: string, userId: string): PersonalizedDraft {
  const account = store.createAccount({
    workspaceId,
    createdBy: userId,
    account: {
      name: "Northwind",
      website: null,
      domain: "northwind.example",
      industry: "SaaS",
      companySize: "50-200",
      geography: "Germany",
      description: null,
      source: "manual",
      sourceReference: null,
      revenuePlanId: null,
      status: "active",
    },
  });
  if (!account.ok) throw new Error("seed account failed");
  const created = store.createDraft({
    workspaceId,
    createdBy: userId,
    accountId: account.value.id,
    draft: {
      contactId: null,
      rendererVersion: "deterministic-1.0.0",
      contextDigest: "fnv1a-seed",
      qualificationId: null,
      offerId: null,
      subject: "Support Automation for Northwind",
      body: "Hi there,\n\nAbout Support Automation: We build support automation for SaaS teams.\n\nWould a short conversation be useful?",
      personalizationPoints: [],
      approvedClaimIds: [],
      warnings: ["The offer's pricing is not approved for external use, so no pricing is stated."],
    },
  });
  if (!created.ok) throw new Error("seed draft failed");
  return created.value;
}

describe("ApprovalService", () => {
  it("creates a request bound to one exact draft version, in `pending`", () => {
    const { service, user, workspace, draft } = seeded();

    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const request = requested.value;
    expect(request.status).toBe("pending");
    expect(request.decision).toBeNull();
    expect(request.decidedBy).toBeNull();
    expect(request.decidedAt).toBeNull();
    // Bound to the exact version, not just the draft.
    expect(request.draftId).toBe(draft.id);
    expect(request.draftVersion).toBe(draft.version);
    // A send is a Level 2 external action.
    expect(request.actionKind).toBe("send_message");
    expect(request.riskLevel).toBe("level_2_external_action");
    expect(request.previewDigest).not.toBe("");
    // The requester is the authenticated caller, never a body field.
    expect(request.createdBy).toBe(user.value.id);
  });

  it("refuses to create a request that already carries a decision", () => {
    const { service, user, workspace, draft } = seeded();

    // There is no API for this: the options carry only a version and an expiry.
    // A caller asking for an approved request gets the same pending request.
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id, {
      // An attempt to smuggle a decision through the options.
      ...({ approved: true, status: "approved", decidedBy: "someone-else" } as Record<
        string,
        unknown
      >),
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.value.status).toBe("pending");
    expect(requested.value.decidedBy).toBeNull();
  });

  it("records an explicit human decision with reviewer identity and timestamp", () => {
    const { service, user, workspace, draft } = seeded("2026-10-01T00:00:00.000Z");
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const decided = service.recordDecision(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "approved",
      null,
    );
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;

    expect(decided.value.request.status).toBe("approved");
    expect(decided.value.request.decision).toBe("approved");
    // Both come from the server: the reviewer is the session, the instant the
    // injected clock.
    expect(decided.value.request.decidedBy).toBe(user.value.id);
    expect(decided.value.request.decidedAt).toBe("2026-10-01T00:00:00.000Z");
    // And the audit trail records the same facts, append-only.
    expect(decided.value.event.kind).toBe("approved");
    expect(decided.value.event.actorUserId).toBe(user.value.id);
  });

  it("never approves without an authenticated human identity", () => {
    const { service, user, workspace, draft } = seeded();
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    // No identity at all: refused before anything is read.
    const anonymous = service.recordDecision(
      workspace.value.id,
      "",
      requested.value.id,
      "approved",
      null,
    );
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) return;
    expect(anonymous.error.code).toBe("UNAUTHORIZED");

    // Another tenant's session: refused, and the request is untouched.
    const other = service.recordDecision(
      "ws-other",
      user.value.id,
      requested.value.id,
      "approved",
      null,
    );
    expect(other.ok).toBe(false);

    const reread = service.getApprovalRequest(requested.value.id, user.value.id);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.status).toBe("pending");
    expect(reread.value.decidedBy).toBeNull();
  });

  it("requires a reason for a rejection, and never approves by score or silence", () => {
    const { service, user, workspace, draft } = seeded();
    const first = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const silentRejection = service.recordDecision(
      workspace.value.id,
      user.value.id,
      first.value.id,
      "rejected",
      null,
    );
    expect(silentRejection.ok).toBe(false);
    if (silentRejection.ok) return;
    expect(silentRejection.error.code).toBe("VALIDATION_ERROR");

    const reasoned = service.recordDecision(
      workspace.value.id,
      user.value.id,
      first.value.id,
      "rejected",
      "The subject names our product before the account does.",
    );
    expect(reasoned.ok).toBe(true);
    if (!reasoned.ok) return;
    expect(reasoned.value.request.status).toBe("rejected");
    expect(reasoned.value.request.decisionReason).toContain("subject");
  });

  it("refuses a second decision on a decided request", () => {
    const { service, user, workspace, draft } = seeded();
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const first = service.recordDecision(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "approved",
      null,
    );
    expect(first.ok).toBe(true);

    // A second decision cannot overwrite the first: a decision that can be
    // rewritten is not a decision.
    const second = service.recordDecision(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "rejected",
      "changed my mind",
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("INVALID_TRANSITION");

    const reread = service.getApprovalRequest(requested.value.id, user.value.id);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.status).toBe("approved");
  });

  it("treats changes_requested as terminal for this version", () => {
    const { service, user, workspace, draft } = seeded();
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const decided = service.recordDecision(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "changes_requested",
      "Lead with the expansion, not the offer.",
    );
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.value.request.status).toBe("changes_requested");
    // It authorizes nothing: a changed draft is a new version needing a new request.
    const verified = service.verifyApproval(requested.value.id, user.value.id);
    expect(verified.ok).toBe(false);
  });

  it("closes a request at its own expiry, and a timeout approves nothing", () => {
    let now = new Date("2026-10-01T00:00:00.000Z");
    const store = new Store(emptyState());
    const user = store.createUser({
      email: "owner@example.com",
      password: "correct-horse-battery",
      displayName: "Owner",
    });
    if (!user.ok) throw new Error("seed user failed");
    const workspace = store.createWorkspace({ ownerId: user.value.id, name: "Acme Agency" });
    if (!workspace.ok) throw new Error("seed workspace failed");
    const draft = seedDraft(store, workspace.value.id, user.value.id);
    const service = new ApprovalService(
      store as never,
      {
        byId: (draftId, userId) => {
          const found = store.getDraft(draftId, userId);
          return found.ok ? toApprovalDraftSnapshot(found.value) : null;
        },
        latestVersion: (draftId, userId) => {
          const found = store.getDraft(draftId, userId);
          return found.ok ? toApprovalDraftSnapshot(found.value) : null;
        },
      },
      () => now,
    );

    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id, {
      expiresInDays: 1,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.value.expiresAt).not.toBeNull();

    // Before the deadline the request is decidable.
    const early = service.recordDecision(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "approved",
      null,
    );
    expect(early.ok).toBe(true);

    // A second request, decided after its deadline instead.
    const second = service.requestApproval(workspace.value.id, user.value.id, draft.id, {
      expiresInDays: 1,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    now = new Date("2026-10-05T00:00:00.000Z");
    const late = service.recordDecision(
      workspace.value.id,
      user.value.id,
      second.value.id,
      "approved",
      null,
    );
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error.code).toBe("EXPIRED");

    // The closure is persisted as `expired`, which authorizes nothing.
    const reread = service.getApprovalRequest(second.value.id, user.value.id);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.status).toBe("expired");
    expect(reread.value.decidedBy).toBeNull();

    const verified = service.verifyApproval(second.value.id, user.value.id);
    expect(verified.ok).toBe(false);
  });

  it("refuses a decision when the previewed content has moved", () => {
    const { store, service, user, workspace, draft } = seeded();
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    // Simulate the text moving underneath the request. The draft record is
    // immutable through the service, so the tampering is done on the stored row
    // — exactly the case the digest exists to catch.
    const row = store.db.personalizedDrafts.find((entry) => entry.id === draft.id);
    if (row === undefined) throw new Error("draft row missing");
    row.body = `${row.body}\n\nPS: we already spoke last week.`;

    const decided = service.recordDecision(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "approved",
      null,
    );
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.error.code).toBe("PREVIEW_MISMATCH");
  });

  it("cancels a pending request, and a cancellation is not a decision", () => {
    const { service, user, workspace, draft } = seeded();
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const cancelled = service.cancelApproval(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "no longer needed",
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.status).toBe("cancelled");
    expect(cancelled.value.decision).toBeNull();

    const verified = service.verifyApproval(requested.value.id, user.value.id);
    expect(verified.ok).toBe(false);
  });

  it("authorizes only an explicit, in-date approval", () => {
    const { service, user, workspace, draft } = seeded();
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    // Pending authorizes nothing.
    expect(service.verifyApproval(requested.value.id, user.value.id).ok).toBe(false);
    expect(approvesNothing(requested.value)).toBe(true);

    const decided = service.recordDecision(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "approved",
      null,
    );
    expect(decided.ok).toBe(true);

    const verified = service.verifyApproval(requested.value.id, user.value.id);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.status).toBe("approved");
    expect(verified.value.decidedBy).toBe(user.value.id);
    expect(approvesNothing(verified.value)).toBe(false);
  });

  it("binds a request to the named version and refuses a version that never existed", () => {
    const { service, user, workspace, draft } = seeded();

    const wrongVersion = service.requestApproval(workspace.value.id, user.value.id, draft.id, {
      draftVersion: 99,
    });
    expect(wrongVersion.ok).toBe(false);
    if (wrongVersion.ok) return;
    expect(wrongVersion.error.code).toBe("NOT_FOUND");

    const named = service.requestApproval(workspace.value.id, user.value.id, draft.id, {
      draftVersion: draft.version,
    });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.value.draftVersion).toBe(draft.version);
  });

  it("never reveals another tenant's draft or request", () => {
    const { store, service, user, workspace, draft } = seeded();

    // A real second tenant, so the refusals below are authorization decisions
    // rather than lookups of workspaces that simply do not exist.
    const otherUser = store.createUser({
      email: "intruder@example.com",
      password: "correct-horse-battery",
      displayName: "Intruder",
    });
    expect(otherUser.ok).toBe(true);
    if (!otherUser.ok) return;
    const otherWorkspace = store.createWorkspace({
      ownerId: otherUser.value.id,
      name: "Globex",
    });
    expect(otherWorkspace.ok).toBe(true);
    if (!otherWorkspace.ok) return;

    const foreign = service.requestApproval(
      workspace.value.id,
      user.value.id,
      "draft-does-not-exist",
    );
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe("NOT_FOUND");

    // A workspace nobody belongs to is absent, which is the one distinction the
    // refusals below deliberately preserve.
    const missing = service.requestApproval("ws-does-not-exist", user.value.id, draft.id);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("NOT_FOUND");

    // The intruder is not a member of the seeded workspace, so this is refused
    // at the tenant boundary as UNAUTHORIZED rather than NOT_FOUND: a non-member
    // must not be able to tell "this workspace exists" from "it does not" by
    // reading the error code.
    const denied = service.requestApproval(workspace.value.id, otherUser.value.id, draft.id);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("UNAUTHORIZED");

    // Inside their own workspace the intruder is a legitimate member, so the
    // only thing left to refuse is the foreign draft — and it is reported as
    // absent rather than confirmed to exist.
    const hidden = service.requestApproval(otherWorkspace.value.id, otherUser.value.id, draft.id);
    expect(hidden.ok).toBe(false);
    if (hidden.ok) return;
    expect(hidden.error.code).toBe("NOT_FOUND");

    // And the seeded tenant's own requests are still readable afterwards: the
    // refusals above changed nothing.
    const stillThere = service.listApprovals(workspace.value.id, user.value.id);
    expect(stillThere.ok).toBe(true);
    if (!stillThere.ok) return;
    expect(stillThere.value).toHaveLength(0);
  });

  it("keeps the whole audit trail, oldest first", () => {
    const { service, user, workspace, draft } = seeded();
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const decided = service.recordDecision(
      workspace.value.id,
      user.value.id,
      requested.value.id,
      "approved",
      null,
    );
    expect(decided.ok).toBe(true);

    const history = service.approvalHistory(requested.value.id, user.value.id);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.map((event) => event.kind)).toEqual(["requested", "approved"]);
    // Every event names who and when.
    for (const event of history.value) {
      expect(event.actorUserId).toBe(user.value.id);
      expect(event.createdAt).not.toBe("");
    }
  });

  it("shows a reviewer exactly what they are approving, warnings included", () => {
    const { service, user, workspace, draft } = seeded();
    const requested = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const preview = service.previewApproval(requested.value.id, user.value.id);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.subject).toBe(draft.subject);
    expect(preview.value.body).toBe(draft.body);
    // What the renderer declined to state is part of what is being approved.
    expect(preview.value.warnings.join(" ")).toContain("pricing is not approved");
  });

  it("describes what it will never do, before any request exists", () => {
    const { service, user, workspace } = seeded();
    const policy = service.describeApprovalPolicy(workspace.value.id, user.value.id);
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    expect(policy.value.riskLevel).toBe("level_2_external_action");
    expect(policy.value.neverDoes.join(" ")).toContain(
      "approve anything without an authenticated human",
    );
    expect(policy.value.neverDoes.join(" ")).toContain("score, a threshold, a timer");
    expect(policy.value.reviewerSees.join(" ")).toContain("warnings");
  });

  it("lists decided and undecided requests alike", () => {
    const { service, user, workspace, draft } = seeded();
    const first = service.requestApproval(workspace.value.id, user.value.id, draft.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    service.recordDecision(workspace.value.id, user.value.id, first.value.id, "approved", null);
    service.requestApproval(workspace.value.id, user.value.id, draft.id);

    const all = service.listApprovals(workspace.value.id, user.value.id);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(2);

    const approvedOnly = service.listApprovals(workspace.value.id, user.value.id, {
      status: "approved",
    });
    expect(approvedOnly.ok).toBe(true);
    if (!approvedOnly.ok) return;
    expect(approvedOnly.value).toHaveLength(1);
    expect(approvedOnly.value[0]?.decidedBy).toBe(user.value.id);
  });

  it("exposes no method that approves without a human decision", () => {
    const { service } = seeded();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(service) as object).map(
      (name) => name.toLowerCase(),
    );

    // There is no `approve`, no `autoapprove` and no `execute`: the only way to
    // reach `approved` is `recorddecision`, which requires an identity.
    for (const forbidden of ["autoapprove", "autoapproveaction", "execute", "send", "dispatch"]) {
      expect(surface.some((name) => name === forbidden)).toBe(false);
    }
    expect(surface).toContain("recorddecision");
  });
});
