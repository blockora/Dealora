import { afterAll, describe, expect, it } from "vitest";
import { isErr, isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { Store, store as defaultStore } from "@dealora/db";
import type { RevenueGoal } from "@dealora/db";
import { RevenueGoalService, deterministicGoalParser } from "@dealora/goal";
import type { GoalBusinessContext, GoalRepository } from "@dealora/goal";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";

/**
 * Phase 3 gate — ROADMAP.md §10.
 *
 * A user must be able to express a revenue objective in natural language and
 * get back a validated, persistent, workspace-scoped RevenueGoal that
 * references canonical Business Brain records.
 *
 * The first test walks the whole path through the real signup/session layer,
 * the real default wiring and the real default store, then re-reads the goal
 * from a service built over the persisted document to prove it was written,
 * not merely held in memory.
 */

function request(token: string, params: Record<string, string>, body?: unknown): RequestBody {
  return { body, query: { sessionToken: token }, params };
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
  if (resolved.ok) throw new Error("expected the handler to fail");
  return resolved.error;
}

describe("Phase 3 gate", () => {
  // The auth layer and the default wiring are bound to the default store
  // singleton, so the end-to-end path must use it too. Clean the generated
  // document up afterwards.
  afterAll(() => {
    defaultStore.destroy();
  });

  it("authenticated user → workspace → Brain → natural-language goal → structured, validated, persistent RevenueGoal", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const handlers = createDefaultHandlers();

    // 1. Authenticate for real: signup issues a session token.
    const signedUp = signup("gate-goal@example.com", "correct-horse-battery", "Owner A");
    expect(signedUp.token).toBeTruthy();
    const token = signedUp.token;
    const userId = signedUp.user.id;

    // 2. Workspace as the tenant boundary.
    const workspace = store.createWorkspace({ ownerId: userId, name: "Gate Co" });
    expect(isOk(workspace)).toBe(true);
    if (!isOk(workspace)) return;
    const workspaceId = workspace.value.id;

    // 3. Canonical Business Brain: company, offer, ICP, persona.
    await dataOf(
      handlers.upsertCompanyHandler(
        request(
          token,
          { workspaceId },
          {
            name: "Gate Corp",
            description: "Revenue operations agency",
            market: "B2B SaaS",
            industry: "Software",
          },
        ),
      ),
    );
    const offer = (await dataOf(
      handlers.createOfferHandler(
        request(
          token,
          { workspaceId },
          {
            name: "AI automation",
            description: "Automates the inbound revenue motion",
          },
        ),
      ),
    )) as { offer: { id: string; name: string } };
    await dataOf(
      handlers.upsertIcpHandler(
        request(token, { workspaceId }, { industries: ["SaaS"], companySizes: ["50-500"] }),
      ),
    );
    const persona = (await dataOf(
      handlers.createPersonaHandler(request(token, { workspaceId }, { title: "Head of Revenue" })),
    )) as { persona: { id: string; title: string } };

    // 4. Natural-language revenue goal → structured draft with provenance,
    //    and nothing persisted yet.
    const stated =
      "Generate $100,000 of qualified pipeline from mid-market SaaS companies " +
      "in the next 90 days, targeting Head of Revenue, using our AI automation offer.";
    const parsed = (await dataOf(
      handlers.parseRevenueGoalInputHandler(request(token, { workspaceId }, { input: stated })),
    )) as { draft: { fields: Record<string, { value: unknown; origin: string } | undefined> } };

    expect(parsed.draft.fields.targetMetric?.value).toBe("qualified_opportunity");
    expect(parsed.draft.fields.targetValue?.value).toBe(100000);
    expect(parsed.draft.fields.targetValue?.origin).toBe("explicit");
    // "$" is interpreted, not stated: an assumption, recorded as one.
    expect(parsed.draft.fields.currency?.origin).toBe("assumption");
    // References resolve to the canonical Business Brain records.
    expect(parsed.draft.fields.offerId?.value).toBe(offer.offer.id);
    expect(parsed.draft.fields.offerId?.origin).toBe("inferred");
    expect(parsed.draft.fields.icpId?.value).not.toBeNull();
    expect(parsed.draft.fields.buyerPersonaIds?.value).toEqual([persona.persona.id]);

    // 5. Structured RevenueGoal, persisted for the workspace owner.
    const goal = (await dataOf(
      handlers.createRevenueGoalFromTextHandler(request(token, { workspaceId }, { input: stated })),
    )) as { goal: RevenueGoal };

    expect(goal.goal.objective).toBe(stated);
    expect(goal.goal.workspaceId).toBe(workspaceId);
    expect(goal.goal.createdBy).toBe(userId);
    expect(goal.goal.targetMetric).toBe("qualified_opportunity");
    expect(goal.goal.targetValue).toBe(100000);
    expect(goal.goal.currency).toBe("USD");
    expect(goal.goal.offerId).toBe(offer.offer.id);
    expect(goal.goal.icpId).toBeTruthy();
    expect(goal.goal.buyerPersonaIds).toEqual([persona.persona.id]);
    expect(goal.goal.status).toBe("draft");
    expect(goal.goal.market).toBe("mid-market SaaS companies");
    expect(goal.goal.timeWindow.start < goal.goal.timeWindow.end).toBe(true);
    // The approval model is carried on the goal for later phases to honour.
    expect(goal.goal.approvalPolicy.externalActionsRequireApproval).toBe(true);
    expect(goal.goal.approvalPolicy.maxRiskLevel).toBe("level_2_external_action");
    // Measurable success criteria are attached, ready for later phases to
    // record actual performance against.
    expect(goal.goal.successMetrics[0]).toMatchObject({
      kind: "qualified_opportunity",
      target: 100000,
    });
    expect(goal.goal.completeness).toBe("complete");
    // Provenance is stored, not discarded.
    expect(goal.goal.assumptions.some((a) => a.startsWith("currency:"))).toBe(true);

    // 6. The goal references canonical Brain records rather than copying them.
    expect(JSON.stringify(goal.goal)).not.toContain("Automates the inbound revenue motion");

    // 7. Retrieval through the API, scoped by session identity alone.
    const fetched = (await dataOf(
      handlers.getRevenueGoalHandler(request(token, { id: goal.goal.id })),
    )) as { goal: RevenueGoal };
    expect(fetched.goal.objective).toBe(stated);
    expect(fetched.goal.targetValue).toBe(100000);

    // 8. Persistence: a service over the reloaded document sees the goal.
    const reloadedStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const reloaded = new RevenueGoalService(
      reloadedStore as unknown as GoalRepository,
      deterministicGoalParser,
    );
    const afterReload = reloaded.getRevenueGoal(goal.goal.id, userId);
    expect(isOk(afterReload)).toBe(true);
    if (!isOk(afterReload)) return;
    expect(afterReload.value.objective).toBe(stated);
    expect(afterReload.value.targetValue).toBe(100000);
    expect(afterReload.value.offerId).toBe(offer.offer.id);
    expect(afterReload.value.successMetrics[0]?.target).toBe(100000);
    expect(afterReload.value.approvalPolicy.externalActionsRequireApproval).toBe(true);

    // 9. Editing a goal.
    const edited = (await dataOf(
      handlers.updateRevenueGoalHandler(
        request(
          token,
          { id: goal.goal.id, workspaceId },
          {
            objective: "Generate $120,000 of qualified pipeline from mid-market SaaS companies",
            targetValue: 120000,
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    expect(edited.goal.targetValue).toBe(120000);
    expect(edited.goal.objective).toContain("120,000");
    expect(edited.goal.offerId).toBe(offer.offer.id);

    // 10. Status and metrics.
    const activated = (await dataOf(
      handlers.changeRevenueGoalStatusHandler(
        request(token, { id: goal.goal.id }, { status: "active" }),
      ),
    )) as { goal: RevenueGoal };
    expect(activated.goal.status).toBe("active");

    const withMetrics = (await dataOf(
      handlers.updateRevenueGoalHandler(
        request(
          token,
          { id: goal.goal.id, workspaceId },
          {
            successMetrics: [
              { kind: "qualified_opportunity", target: 120000, unit: "currency" },
              { kind: "meeting", target: 12, unit: "count" },
            ],
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    expect(withMetrics.goal.successMetrics).toHaveLength(2);
    expect(withMetrics.goal.successMetrics[1]).toMatchObject({ kind: "meeting", target: 12 });

    const completed = (await dataOf(
      handlers.changeRevenueGoalStatusHandler(
        request(token, { id: goal.goal.id }, { status: "completed" }),
      ),
    )) as { goal: RevenueGoal };
    expect(completed.goal.status).toBe("completed");

    const archived = (await dataOf(
      handlers.archiveRevenueGoalHandler(request(token, { id: goal.goal.id })),
    )) as { goal: RevenueGoal };
    expect(archived.goal.status).toBe("archived");

    // Goal history is auditable.
    const history = (await dataOf(
      handlers.revenueGoalHistoryHandler(request(token, { id: goal.goal.id })),
    )) as { history: { kind: string; toStatus: string }[] };
    // Field edits are audited separately from status transitions.
    expect(history.history.some((e) => e.kind === "updated")).toBe(true);
    expect(history.history.filter((e) => e.kind !== "updated").map((e) => e.toStatus)).toEqual([
      "draft",
      "active",
      "completed",
      "archived",
    ]);

    // 11. Every question the phase gate asks is answerable from the goal,
    //     read back from a store rebuilt after the lifecycle changes.
    const afterLifecycleStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const afterLifecycle = new RevenueGoalService(
      afterLifecycleStore as unknown as GoalRepository,
      deterministicGoalParser,
    );
    const final = afterLifecycle.getRevenueGoal(goal.goal.id, userId);
    expect(isOk(final)).toBe(true);
    if (!isOk(final)) return;
    const record = final.value;
    expect(record.objective.length).toBeGreaterThan(0); // what outcome
    expect(record.timeWindow.end).toBeTruthy(); // by when
    expect(record.market).toBeTruthy(); // for which market
    expect(record.icpId).toBeTruthy(); // for which ICP
    expect(record.buyerPersonaIds).toContain(persona.persona.id); // for which buyer
    expect(record.offerId).toBe(offer.offer.id); // using which offer
    expect(record.economics.currency).toBe("USD"); // what economics matter
    expect(record.constraints).toBeTruthy(); // what constraints apply
    expect(record.successMetrics.length).toBeGreaterThan(0); // how success is measured
    expect(record.status).toBe("archived"); // current status
  });

  it("rejects invalid goals, invalid references and invalid transitions", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers();
    const signedUp = signup("gate-invalid@example.com", "correct-horse-battery", "Owner");
    const token = signedUp.token;
    const workspace = defaultStore.createWorkspace({
      ownerId: signedUp.user.id,
      name: "Invalid Co",
    });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;

    // A goal with no objective is invalid, not merely incomplete.
    const noObjective = await errorOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          { targetMetric: "revenue", targetValue: 1000, currency: "USD" },
        ),
      ),
    );
    expect(noObjective.code).toBe("VALIDATION_ERROR");

    // A non-positive target and a malformed currency are rejected.
    const badTarget = await errorOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Book revenue",
            targetMetric: "revenue",
            targetValue: -5,
            currency: "USD",
          },
        ),
      ),
    );
    expect(badTarget.code).toBe("VALIDATION_ERROR");

    const badCurrency = await errorOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Book revenue",
            targetMetric: "revenue",
            targetValue: 1000,
            currency: "dollars",
          },
        ),
      ),
    );
    expect(badCurrency.code).toBe("VALIDATION_ERROR");

    // A reversed time window is rejected.
    const reversed = await errorOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Book revenue",
            targetMetric: "revenue",
            targetValue: 1000,
            currency: "USD",
            timeWindow: { start: "2026-06-01", end: "2026-03-01" },
          },
        ),
      ),
    );
    expect(reversed.code).toBe("VALIDATION_ERROR");

    // An offer that does not exist in this workspace is refused.
    const ghostOffer = await errorOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Book revenue",
            targetMetric: "revenue",
            targetValue: 1000,
            currency: "USD",
            offerId: "offer-that-does-not-exist",
          },
        ),
      ),
    );
    expect(ghostOffer.code).toBe("VALIDATION_ERROR");

    const created = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Book $1,000 of revenue this quarter",
            targetMetric: "revenue",
            targetValue: 1000,
            currency: "USD",
          },
        ),
      ),
    )) as { goal: RevenueGoal };

    // draft → completed skips the active phase and is refused.
    const skipped = await errorOf(
      handlers.changeRevenueGoalStatusHandler(
        request(token, { id: created.goal.id }, { status: "completed" }),
      ),
    );
    expect(skipped.code).toBe("CONFLICT");

    // A status is never settable through a field update either.
    const viaPatch = (await dataOf(
      handlers.updateRevenueGoalHandler(
        request(token, { id: created.goal.id, workspaceId }, { status: "active" }),
      ),
    )) as { goal: RevenueGoal };
    expect(viaPatch.goal.status).toBe("draft");
  });

  it("denies a second tenant access to the first tenant's revenue goals", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers();

    const ownerA = signup("gate-a@example.com", "correct-horse-battery", "Owner A");
    const ownerB = signup("gate-b@example.com", "correct-horse-battery", "Owner B");
    const wsA = defaultStore.createWorkspace({ ownerId: ownerA.user.id, name: "Acme" });
    const wsB = defaultStore.createWorkspace({ ownerId: ownerB.user.id, name: "Globex" });
    if (!isOk(wsA) || !isOk(wsB)) throw new Error("fixture workspaces failed");

    const offerB = (await dataOf(
      handlers.createOfferHandler(
        request(
          ownerB.token,
          { workspaceId: wsB.value.id },
          {
            name: "Globex offer",
            description: "Globex only",
          },
        ),
      ),
    )) as { offer: { id: string } };

    const created = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id },
          {
            objective: "Acme private target",
            targetMetric: "revenue",
            targetValue: 5000,
            currency: "USD",
            market: "B2B SaaS",
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    const goalId = created.goal.id;

    // User A + Workspace A + Goal A = allowed.
    const own = await dataOf(handlers.getRevenueGoalHandler(request(ownerA.token, { id: goalId })));
    expect(JSON.stringify(own)).toContain("Acme private target");
    const ownList = await dataOf(
      handlers.listRevenueGoalsHandler(request(ownerA.token, { workspaceId: wsA.value.id })),
    );
    expect(JSON.stringify(ownList)).toContain("Acme private target");

    // User B + Workspace A + Goal A = denied, on every entry point.
    const denials = await Promise.all([
      errorOf(handlers.getRevenueGoalHandler(request(ownerB.token, { id: goalId }))),
      errorOf(
        handlers.listRevenueGoalsHandler(request(ownerB.token, { workspaceId: wsA.value.id })),
      ),
      errorOf(
        handlers.updateRevenueGoalHandler(
          request(
            ownerB.token,
            { id: goalId, workspaceId: wsA.value.id },
            { objective: "Hijacked" },
          ),
        ),
      ),
      errorOf(
        handlers.changeRevenueGoalStatusHandler(
          request(ownerB.token, { id: goalId }, { status: "active" }),
        ),
      ),
      errorOf(handlers.revenueGoalHistoryHandler(request(ownerB.token, { id: goalId }))),
      errorOf(handlers.archiveRevenueGoalHandler(request(ownerB.token, { id: goalId }))),
      errorOf(
        handlers.createRevenueGoalHandler(
          request(
            ownerB.token,
            { workspaceId: wsA.value.id },
            {
              objective: "Intruder goal",
              targetMetric: "revenue",
              targetValue: 1,
              currency: "USD",
            },
          ),
        ),
      ),
    ]);
    for (const denial of denials) {
      expect(denial.code).toBe("UNAUTHORIZED");
      expect(JSON.stringify(denial)).not.toContain("Acme private target");
      expect(JSON.stringify(denial)).not.toContain("Hijacked");
    }

    // A workspace-A goal cannot reference a workspace-B offer.
    const crossReference = await errorOf(
      handlers.createRevenueGoalHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id },
          {
            objective: "Cross-tenant reference attempt",
            targetMetric: "revenue",
            targetValue: 1000,
            currency: "USD",
            offerId: offerB.offer.id,
          },
        ),
      ),
    );
    expect(crossReference.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(crossReference)).not.toContain("Globex offer");
  });

  it("records gaps instead of inventing business facts, and parses deterministically", () => {
    setSessionIndex(createIndex());
    // An isolated, empty store: this workspace has no Business Brain at all.
    const store = new Store(JSON.parse(JSON.stringify(defaultStore.db)) as never);
    const user = store.createUser({
      email: "gate-gap@example.com",
      password: "correct-horse-battery",
      displayName: "Owner",
    });
    if (!isOk(user)) throw new Error("fixture user failed");
    const ws = store.createWorkspace({ ownerId: user.value.id, name: "Gap Co" });
    if (!isOk(ws)) throw new Error("fixture workspace failed");

    const context: GoalBusinessContext = {
      workspaceId: ws.value.id,
      company: null,
      offers: [],
      icp: null,
      personas: [],
    };
    const service = new RevenueGoalService(
      store as unknown as GoalRepository,
      deterministicGoalParser,
    );
    const now = new Date("2026-03-01T00:00:00.000Z");

    // Determinism: identical input, Brain state and instant → identical draft.
    const input = "20 qualified meetings in the next 30 days using our Unicorn Retainer offer";
    const first = service.parseRevenueGoalInput(input, context, now);
    const second = service.parseRevenueGoalInput(input, context, now);
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
    expect(first.value.fields.timeWindow.value).toEqual({
      start: "2026-03-01",
      end: "2026-03-31",
    });

    // The unknown offer is a recorded gap, not a fabricated reference.
    const goal = service.createFromNaturalLanguage(ws.value.id, user.value.id, input, context, now);
    expect(isOk(goal)).toBe(true);
    if (!isOk(goal)) return;
    expect(goal.value.offerId).toBeNull();
    expect(goal.value.completeness).toBe("incomplete");
    expect(goal.value.unknowns.some((u) => u.field === "offerId")).toBe(true);
    expect(goal.value.unknowns.some((u) => u.field === "icpId")).toBe(true);
    // What was measurable is still measured.
    expect(goal.value.successMetrics[0]).toMatchObject({ kind: "meeting", target: 20 });

    // A goal with no measurable outcome is invalid rather than incomplete.
    const vague = service.createFromNaturalLanguage(
      ws.value.id,
      user.value.id,
      "do more revenue somehow",
      context,
      now,
    );
    expect(isErr(vague)).toBe(true);
    if (isErr(vague)) expect(vague.error.code).toBe("VALIDATION_ERROR");
  });

  it("defines a goal without executing any external action", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers();
    const owner = signup("gate-inert@example.com", "correct-horse-battery", "Owner");
    const ws = defaultStore.createWorkspace({ ownerId: owner.user.id, name: "Inert Co" });
    if (!isOk(ws)) throw new Error("fixture workspace failed");
    const workspaceId = ws.value.id;

    await dataOf(
      handlers.createOfferHandler(
        request(
          owner.token,
          { workspaceId },
          {
            name: "AI automation",
            description: "Automates revenue",
          },
        ),
      ),
    );
    await dataOf(
      handlers.createRevenueGoalFromTextHandler(
        request(owner.token, { workspaceId }, { input: "$50,000 pipeline in the next 30 days" }),
      ),
    );

    // Phase 3 defines and validates a goal. The goal carries the approval
    // policy later phases will honour, and nothing was actioned: no outreach,
    // no calendar, no CRM write.
    const goals = (defaultStore.db.revenueGoals ?? []).filter((g) => g.workspaceId === workspaceId);
    expect(goals).toHaveLength(1);
    expect(goals[0]?.approvalPolicy.externalActionsRequireApproval).toBe(true);

    const workspaceData = JSON.stringify(defaultStore.db).slice(
      JSON.stringify(defaultStore.db).indexOf(workspaceId),
    );
    for (const forbidden of ["sentAt", "deliveredAt", "outreach", "calendarEvent", "crmWrite"]) {
      expect(workspaceData).not.toContain(forbidden);
    }
  });
});
