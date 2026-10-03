import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";
import type { Account } from "@dealora/db";

import { ResearchService } from "./service.js";
import { AccountRecordProvider, StaticResearchProvider } from "./provider.js";
import { RESEARCH_CATEGORIES, canTransition, freshnessFor } from "./validation.js";
import type { ResearchProvider, ResearchProviderResult, ResearchRepository } from "./types.js";
import { createProviderRegistry } from "./types.js";

/**
 * Research domain tests.
 *
 * Every provider here is a declared test double: the suite asserts on how the
 * domain treats provider output, never on any real external retrieval, because
 * this phase ships none and must not pretend otherwise.
 */

const FIXED_NOW = new Date("2026-10-03T12:00:00.000Z");
const fixedClock = (): Date => new Date(FIXED_NOW.getTime());

interface Harness {
  store: Store;
  service: ResearchService;
  owner: string;
  workspace: string;
  account: Account;
}

/** Two tenants on one store, with the `account_record` provider registered. */
function harness(providers?: readonly ResearchProvider[]): Harness {
  const store = new Store(emptyState());
  const ownerResult = store.createUser({
    email: "owner@example.com",
    password: "correct-horse-battery",
    displayName: "Owner",
  });
  if (!isOk(ownerResult)) throw new Error("seed user failed");
  const workspaceResult = store.createWorkspace({
    ownerId: ownerResult.value.id,
    name: "Research Co",
  });
  if (!isOk(workspaceResult)) throw new Error("seed workspace failed");

  const accountResult = store.createAccount({
    workspaceId: workspaceResult.value.id,
    createdBy: ownerResult.value.id,
    account: {
      name: "Northwind Trading",
      website: "https://northwind.example",
      domain: "northwind.example",
      industry: "Wholesale",
      companySize: "120",
      geography: "UK",
      description: null,
      source: "manual",
      sourceReference: "q1-list.csv",
      revenuePlanId: null,
      status: "active",
    },
  });
  if (!isOk(accountResult)) throw new Error("seed account failed");

  const service = new ResearchService(
    store as unknown as ResearchRepository,
    createProviderRegistry([new AccountRecordProvider(), ...(providers ?? [])]),
    fixedClock,
  );
  return {
    store,
    service,
    owner: ownerResult.value.id,
    workspace: workspaceResult.value.id,
    account: accountResult.value,
  };
}

const validObservation = {
  category: "company_overview",
  field: "products_services.summary",
  value: "The site lists three service tiers.",
  claimKind: "fact",
  sourceUrl: "https://northwind.example/services",
  sourceTitle: "Services page",
  observedAt: "2026-09-01T00:00:00.000Z",
  confidence: "medium",
  relevance: "high",
  note: null,
};

/** A provider that answers with exactly what it is given. */
function providerReturning(
  id: string,
  answer: ResearchProviderResult | (() => ResearchProviderResult),
  source: ResearchProvider["source"] = "public_web",
): ResearchProvider {
  return {
    id,
    source,
    research: () => (typeof answer === "function" ? answer() : answer),
  };
}

function createRequest(h: Harness, provider: string, extra?: Record<string, unknown>) {
  return h.service.createResearchRequest(h.workspace, h.owner, h.account.id, {
    provider,
    ...extra,
  });
}

const runWith = async (
  findings: unknown,
): Promise<{ h: Harness; run: Awaited<ReturnType<ResearchService["runResearchRequest"]>> }> => {
  const h = harness([providerReturning("public_site", { ok: true, findings } as never)]);
  const created = createRequest(h, "public_site");
  if (!isOk(created)) throw new Error("request creation failed");
  return { h, run: await h.service.runResearchRequest(created.value.id, h.owner) };
};

describe("ResearchService", () => {
  describe("research requests", () => {
    it("creates a pending request against an existing account", () => {
      const h = harness();
      const created = createRequest(h, "account_record");
      if (!isOk(created)) throw new Error("request creation failed");

      expect(created.value.status).toBe("pending");
      expect(created.value.accountId).toBe(h.account.id);
      // The request's tenant is the account's tenant, always.
      expect(created.value.workspaceId).toBe(h.account.workspaceId);
      expect(created.value.requestedBy).toBe(h.owner);
      expect(created.value.provider).toBe("account_record");
      expect(created.value.categories).toEqual([...RESEARCH_CATEGORIES]);
      expect(created.value.findingCount).toBe(0);
      expect(created.value.failureCode).toBeNull();
      expect(created.value.startedAt).toBeNull();
      expect(created.value.completedAt).toBeNull();
    });

    it("records only the categories the caller asked for", () => {
      const h = harness();
      const created = createRequest(h, "account_record", { categories: ["industry"] });
      if (!isOk(created)) throw new Error("request creation failed");
      expect(created.value.categories).toEqual(["industry"]);
    });

    it("refuses an unregistered provider instead of falling back", () => {
      const h = harness();
      const refused = createRequest(h, "some_scraper");
      if (!isErr(refused)) throw new Error("an unregistered provider was accepted");
      expect(refused.error.code).toBe("UNSUPPORTED_PROVIDER");
      expect(h.store.db.researchRequests).toHaveLength(0);
    });

    it("rejects a missing provider and malformed categories", () => {
      const h = harness();
      const noProvider = createRequest(h, "");
      if (!isErr(noProvider)) throw new Error("a missing provider was accepted");
      expect(noProvider.error.code).toBe("VALIDATION_ERROR");

      const badCategories = createRequest(h, "account_record", { categories: ["buying_intent"] });
      if (!isErr(badCategories)) throw new Error("an unknown category was accepted");
      expect(badCategories.error.code).toBe("VALIDATION_ERROR");

      const notAnArray = createRequest(h, "account_record", { categories: "industry" });
      if (!isErr(notAnArray)) throw new Error("a non-array category list was accepted");
      expect(notAnArray.error.code).toBe("VALIDATION_ERROR");
    });

    it("will not research an archived account", () => {
      const h = harness();
      h.store.archiveAccount(h.account.id, h.owner);
      const refused = createRequest(h, "account_record");
      if (!isErr(refused)) throw new Error("an archived account was researched");
      expect(refused.error.code).toBe("CONFLICT");
    });

    it("lists a workspace's requests and filters by status", () => {
      const h = harness();
      createRequest(h, "account_record");
      const all = h.service.listResearchRequests(h.workspace, h.owner);
      if (!isOk(all)) throw new Error("listing failed");
      expect(all.value).toHaveLength(1);

      const pending = h.service.listResearchRequests(h.workspace, h.owner, { status: "pending" });
      if (!isOk(pending)) throw new Error("filtering failed");
      expect(pending.value).toHaveLength(1);

      const completed = h.service.listResearchRequests(h.workspace, h.owner, {
        status: "completed",
      });
      if (!isOk(completed)) throw new Error("filtering failed");
      expect(completed.value).toHaveLength(0);

      const bogus = h.service.listResearchRequests(h.workspace, h.owner, {
        status: "executing" as never,
      });
      if (!isErr(bogus)) throw new Error("an invalid status filter was accepted");
      expect(bogus.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("lifecycle", () => {
    it("allows only the documented transitions", () => {
      expect(canTransition("pending", "running")).toBe(true);
      expect(canTransition("pending", "cancelled")).toBe(true);
      expect(canTransition("running", "completed")).toBe(true);
      expect(canTransition("running", "failed")).toBe(true);
      expect(canTransition("failed", "running")).toBe(true);
      // Terminal states stay terminal.
      expect(canTransition("completed", "running")).toBe(false);
      expect(canTransition("completed", "cancelled")).toBe(false);
      expect(canTransition("cancelled", "running")).toBe(false);
      expect(canTransition("running", "running")).toBe(false);
      expect(canTransition("pending", "completed")).toBe(false);
    });

    it("runs a pending request to completion with attributed findings", async () => {
      const provider = providerReturning("public_site", {
        ok: true,
        findings: [validObservation],
      });
      const h = harness([provider]);
      const created = createRequest(h, "public_site");
      if (!isOk(created)) throw new Error("request creation failed");

      const run = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isOk(run)) throw new Error(`research run failed: ${run.error.code}`);
      expect(run.value.request.status).toBe("completed");
      expect(run.value.request.startedAt).toBe(FIXED_NOW.toISOString());
      expect(run.value.request.completedAt).toBe(FIXED_NOW.toISOString());
      expect(run.value.request.findingCount).toBe(1);
      expect(run.value.findings).toHaveLength(1);

      const finding = run.value.findings[0];
      // Every externally-derived finding keeps who said it, where, and when.
      expect(finding?.source).toBe("public_web");
      expect(finding?.sourceName).toBe("public_site");
      expect(finding?.sourceUrl).toBe("https://northwind.example/services");
      expect(finding?.sourceTitle).toBe("Services page");
      expect(finding?.retrievedAt).toBe(FIXED_NOW.toISOString());
      expect(finding?.observedAt).toBe("2026-09-01T00:00:00.000Z");
      // 32 days old: recorded as recent rather than fresh.
      expect(finding?.freshness).toBe("recent");
      expect(finding?.claimKind).toBe("fact");
      expect(finding?.accountId).toBe(h.account.id);
      expect(finding?.workspaceId).toBe(h.workspace);
    });

    it("rejects an illegal transition instead of re-running a finished request", async () => {
      const h = harness();
      const created = createRequest(h, "account_record");
      if (!isOk(created)) throw new Error("request creation failed");
      await h.service.runResearchRequest(created.value.id, h.owner);

      const again = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isErr(again)) throw new Error("a completed request was run twice");
      expect(again.error.code).toBe("INVALID_TRANSITION");

      const cancel = h.service.cancelResearchRequest(created.value.id, h.owner);
      if (!isErr(cancel)) throw new Error("a completed request was cancelled");
      expect(cancel.error.code).toBe("INVALID_TRANSITION");
    });

    it("cancels a pending request and stops it from being run", async () => {
      const h = harness();
      const created = createRequest(h, "account_record");
      if (!isOk(created)) throw new Error("request creation failed");

      const cancelled = h.service.cancelResearchRequest(created.value.id, h.owner);
      if (!isOk(cancelled)) throw new Error("cancellation failed");
      expect(cancelled.value.status).toBe("cancelled");

      const run = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isErr(run)) throw new Error("a cancelled request was run");
      expect(run.error.code).toBe("INVALID_TRANSITION");
    });
  });

  describe("provider output validation", () => {
    it("rejects a malformed observation and records why", async () => {
      const { h, run } = await runWith([{ ...validObservation, value: undefined }]);
      if (!isOk(run)) throw new Error("a malformed observation was accepted");
      expect(run.value.request.status).toBe("failed");
      expect(run.value.request.failureCode).toBe("invalid_provider_output");
      expect(run.value.findings).toEqual([]);
      // Nothing partial is persisted: a rejected observation leaves no row.
      expect(
        h.store.db.researchFindings.filter((f) => f.researchRequestId === run.value.request.id),
      ).toEqual([]);
    });

    it("rejects an unknown claim label, category and band", async () => {
      const badClaim = await runWith([{ ...validObservation, claimKind: "proven" }]);
      expect(badClaim.run.ok && badClaim.run.value.request.failureCode).toBe(
        "invalid_provider_output",
      );

      const badCategory = await runWith([{ ...validObservation, category: "technology_stack" }]);
      expect(badCategory.run.ok && badCategory.run.value.request.failureCode).toBe(
        "invalid_provider_output",
      );

      const badConfidence = await runWith([{ ...validObservation, confidence: 0.97 }]);
      expect(badConfidence.run.ok && badConfidence.run.value.request.failureCode).toBe(
        "invalid_provider_output",
      );
    });

    it("rejects an unsafe source reference rather than storing it", async () => {
      const { h, run } = await runWith([{ ...validObservation, sourceUrl: "javascript:alert(1)" }]);
      if (!isOk(run)) throw new Error("an unsafe source reference was accepted");
      expect(run.value.request.failureCode).toBe("invalid_provider_output");
      expect(run.value.findings).toEqual([]);
      expect(h.store.db.researchFindings).toEqual([]);
    });

    it("rejects a category the request did not ask for", async () => {
      const h = harness([
        new StaticResearchProvider("public_site", "public_web", [validObservation], {
          filterToScope: false,
        }),
      ]);
      const created = createRequest(h, "public_site", { categories: ["industry"] });
      if (!isOk(created)) throw new Error("request creation failed");
      const run = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isOk(run)) throw new Error("run failed");
      expect(run.value.request.failureCode).toBe("invalid_provider_output");
    });

    it("never invents a source reference the provider did not supply", async () => {
      const { run } = await runWith([
        {
          ...validObservation,
          sourceUrl: undefined,
          sourceTitle: undefined,
          observedAt: undefined,
        },
      ]);
      if (!isOk(run)) throw new Error("run failed");
      expect(run.value.request.status).toBe("completed");
      // The limitation is preserved rather than papered over with a made-up URL.
      expect(run.value.findings[0]?.sourceUrl).toBeNull();
      expect(run.value.findings[0]?.sourceTitle).toBeNull();
      // Attribution itself is still complete.
      expect(run.value.findings[0]?.source).toBe("public_web");
      expect(run.value.findings[0]?.sourceName).toBe("public_site");
      expect(run.value.findings[0]?.retrievedAt).toBe(FIXED_NOW.toISOString());
      // No observation date was given, so no currency is claimed.
      expect(run.value.findings[0]?.freshness).toBe("unknown");
    });

    it("refuses a provider that declares a source outside the permitted list", async () => {
      const h = harness([
        providerReturning(
          "rogue",
          { ok: true, findings: [validObservation] },
          "behind_auth" as never,
        ),
      ]);
      const created = createRequest(h, "rogue");
      if (!isOk(created)) throw new Error("request creation failed");
      const run = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isOk(run)) throw new Error("run failed");
      expect(run.value.request.status).toBe("failed");
      expect(run.value.request.failureCode).toBe("invalid_provider_output");
      expect(run.value.findings).toEqual([]);
    });

    it("collapses an identical repeat and refuses a contradictory one", async () => {
      const repeated = await runWith([validObservation, { ...validObservation }]);
      if (!isOk(repeated.run)) throw new Error("run failed");
      expect(repeated.run.value.findings).toHaveLength(1);

      const contradictory = await runWith([
        validObservation,
        { ...validObservation, value: "The site lists five service tiers." },
      ]);
      if (!isOk(contradictory.run)) throw new Error("run failed");
      expect(contradictory.run.value.request.failureCode).toBe("invalid_provider_output");
      expect(contradictory.run.value.findings).toEqual([]);
      expect(contradictory.h.store.db.researchFindings).toEqual([]);
    });

    it("records a provider that fails, is unavailable or throws", async () => {
      for (const [code, expected] of [
        ["unavailable", "provider_unavailable"],
        ["failed", "provider_failed"],
        ["invalid_output", "invalid_provider_output"],
      ] as const) {
        const h = harness([providerReturning("public_site", { ok: false, code })]);
        const created = createRequest(h, "public_site");
        if (!isOk(created)) throw new Error("request creation failed");
        const run = await h.service.runResearchRequest(created.value.id, h.owner);
        if (!isOk(run)) throw new Error("run failed");
        expect(run.value.request.status).toBe("failed");
        expect(run.value.request.failureCode).toBe(expected);
        expect(run.value.findings).toEqual([]);
        // The failure is an inspectable record, never an empty success.
        expect(run.value.request.failureMessage).toBeTruthy();
      }

      const throwing = harness([
        {
          id: "public_site",
          source: "public_web" as const,
          research: () => {
            throw new Error("provider exploded");
          },
        },
      ]);
      const created = createRequest(throwing, "public_site");
      if (!isOk(created)) throw new Error("request creation failed");
      const run = await throwing.service.runResearchRequest(created.value.id, throwing.owner);
      if (!isOk(run)) throw new Error("run failed");
      expect(run.value.request.failureCode).toBe("provider_failed");
      // The provider's own message never reaches the caller.
      expect(JSON.stringify(run.value)).not.toContain("provider exploded");
    });

    it("answers an empty run honestly rather than inventing findings", async () => {
      const { run } = await runWith([]);
      if (!isOk(run)) throw new Error("run failed");
      expect(run.value.request.status).toBe("completed");
      expect(run.value.request.findingCount).toBe(0);
      expect(run.value.findings).toEqual([]);
    });
  });

  describe("determinism", () => {
    it("produces identical findings for identical provider output", async () => {
      const normalize = async (): Promise<unknown> => {
        const h = harness([
          providerReturning("public_site", { ok: true, findings: [validObservation] }),
        ]);
        const created = createRequest(h, "public_site");
        if (!isOk(created)) throw new Error("request creation failed");
        const run = await h.service.runResearchRequest(created.value.id, h.owner);
        if (!isOk(run)) throw new Error("run failed");
        // Identifiers and row stamps are generated per run; everything the
        // domain decided must be identical.
        return run.value.findings.map((f) => ({
          category: f.category,
          field: f.field,
          value: f.value,
          claimKind: f.claimKind,
          source: f.source,
          sourceName: f.sourceName,
          sourceUrl: f.sourceUrl,
          sourceTitle: f.sourceTitle,
          observedAt: f.observedAt,
          retrievedAt: f.retrievedAt,
          confidence: f.confidence,
          freshness: f.freshness,
          relevance: f.relevance,
          note: f.note,
          status: f.status,
        }));
      };
      expect(await normalize()).toEqual(await normalize());
    });

    it("derives freshness from the observation age, not from the wall clock", () => {
      const now = new Date("2026-10-03T00:00:00.000Z");
      expect(freshnessFor("2026-10-01T00:00:00.000Z", now)).toBe("fresh");
      expect(freshnessFor("2026-08-01T00:00:00.000Z", now)).toBe("recent");
      expect(freshnessFor("2025-01-01T00:00:00.000Z", now)).toBe("stale");
      // No observation date means no currency claim at all.
      expect(freshnessFor(null, now)).toBe("unknown");
    });
  });

  describe("idempotency", () => {
    it("replays an identical key instead of starting a second request", () => {
      const h = harness();
      const first = createRequest(h, "account_record", { idempotencyKey: "q1-refresh" });
      if (!isOk(first)) throw new Error("request creation failed");
      const replay = createRequest(h, "account_record", { idempotencyKey: "q1-refresh" });
      if (!isOk(replay)) throw new Error("replay failed");
      expect(replay.value.id).toBe(first.value.id);
      expect(h.store.db.researchRequests).toHaveLength(1);
    });

    it("refuses a second active request for the same account and provider", async () => {
      const h = harness();
      const first = createRequest(h, "account_record");
      if (!isOk(first)) throw new Error("request creation failed");

      const duplicate = createRequest(h, "account_record");
      if (!isErr(duplicate)) throw new Error("a duplicate active request was created");
      expect(duplicate.error.code).toBe("CONFLICT");
      expect(h.store.db.researchRequests).toHaveLength(1);

      // Once it has finished, a later refresh is allowed.
      await h.service.runResearchRequest(first.value.id, h.owner);
      const refresh = createRequest(h, "account_record");
      if (!isOk(refresh)) throw new Error("a refresh request was refused");
      expect(refresh.value.id).not.toBe(first.value.id);
    });

    it("retries a failed request without duplicating its findings", async () => {
      let attempt = 0;
      const flaky = providerReturning("public_site", () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false as const, code: "unavailable" as const }
          : { ok: true as const, findings: [validObservation] };
      });
      const h = harness([flaky]);
      const created = createRequest(h, "public_site");
      if (!isOk(created)) throw new Error("request creation failed");

      const first = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isOk(first)) throw new Error("run failed");
      expect(first.value.request.failureCode).toBe("provider_unavailable");

      const retry = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isOk(retry)) throw new Error("retry failed");
      expect(retry.value.request.status).toBe("completed");
      expect(retry.value.findings).toHaveLength(1);

      // A third attempt is refused outright: a completed request is terminal,
      // so its findings can never accumulate.
      const third = await h.service.runResearchRequest(created.value.id, h.owner);
      expect(isErr(third) && third.error.code).toBe("INVALID_TRANSITION");
      expect(h.store.db.researchFindings).toHaveLength(1);
    });
  });

  describe("workspace authorization", () => {
    it("denies research of another workspace's account and request", async () => {
      const h = harness();
      const outsider = h.store.createUser({
        email: "outsider@example.com",
        password: "correct-horse-battery",
        displayName: "Outsider",
      });
      if (!isOk(outsider)) throw new Error("seed user failed");
      const theirWorkspace = h.store.createWorkspace({
        ownerId: outsider.value.id,
        name: "Outsider Co",
      });
      if (!isOk(theirWorkspace)) throw new Error("seed workspace failed");

      const foreignAccount = h.service.createResearchRequest(
        theirWorkspace.value.id,
        outsider.value.id,
        h.account.id,
        { provider: "account_record" },
      );
      if (!isErr(foreignAccount)) throw new Error("a foreign account was researched");
      expect(foreignAccount.error.code).toBe("NOT_FOUND");

      const ownRequest = createRequest(h, "account_record");
      if (!isOk(ownRequest)) throw new Error("request creation failed");

      const foreignRead = h.service.getResearchRequest(ownRequest.value.id, outsider.value.id);
      if (!isErr(foreignRead)) throw new Error("a foreign request was readable");
      expect(foreignRead.error.code).toBe("UNAUTHORIZED");

      const foreignFindings = h.service.listFindingsForRequest(
        ownRequest.value.id,
        outsider.value.id,
      );
      if (!isErr(foreignFindings)) throw new Error("foreign findings were readable");
      expect(foreignFindings.error.code).toBe("UNAUTHORIZED");

      const foreignRun = await h.service.runResearchRequest(ownRequest.value.id, outsider.value.id);
      if (!isErr(foreignRun)) throw new Error("a foreign request was run");
      expect(foreignRun.error.code).toBe("UNAUTHORIZED");

      const foreignList = h.service.listResearchRequests(
        theirWorkspace.value.id,
        outsider.value.id,
      );
      if (!isOk(foreignList)) throw new Error("listing failed");
      expect(foreignList.value).toEqual([]);
    });

    it("rejects a caller who is not authenticated for the workspace at all", () => {
      const h = harness();
      const refused = h.service.createResearchRequest(h.workspace, "", h.account.id, {
        provider: "account_record",
      });
      if (!isErr(refused)) throw new Error("an unauthenticated caller created a request");
      expect(refused.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("persistence", () => {
    it("keeps findings, provenance and timestamps across a reload", async () => {
      const h = harness([
        providerReturning("public_site", { ok: true, findings: [validObservation] }),
      ]);
      const created = createRequest(h, "public_site");
      if (!isOk(created)) throw new Error("request creation failed");
      const run = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isOk(run)) throw new Error("run failed");

      const reloaded = new Store(JSON.parse(JSON.stringify(h.store.db)) as never);
      const service = new ResearchService(
        reloaded as unknown as ResearchRepository,
        createProviderRegistry([new AccountRecordProvider()]),
        fixedClock,
      );
      const findings = service.listFindingsForRequest(created.value.id, h.owner);
      if (!isOk(findings)) throw new Error("reload read failed");
      expect(findings.value).toHaveLength(1);
      expect(findings.value[0]?.sourceUrl).toBe("https://northwind.example/services");
      expect(findings.value[0]?.observedAt).toBe("2026-09-01T00:00:00.000Z");
      expect(findings.value[0]?.retrievedAt).toBe(FIXED_NOW.toISOString());
      expect(findings.value[0]?.accountId).toBe(h.account.id);

      const request = service.getResearchRequest(created.value.id, h.owner);
      if (!isOk(request)) throw new Error("reload read failed");
      expect(request.value.status).toBe("completed");
      expect(request.value.findingCount).toBe(1);
    });

    it("answers every account-level question the phase must answer", async () => {
      const h = harness();
      const created = createRequest(h, "account_record");
      if (!isOk(created)) throw new Error("request creation failed");
      const run = await h.service.runResearchRequest(created.value.id, h.owner);
      if (!isOk(run)) throw new Error("run failed");

      // Which findings does this account have?
      const forAccount = h.service.listFindingsForAccount(h.workspace, h.owner, h.account.id);
      if (!isOk(forAccount)) throw new Error("listing failed");
      expect(forAccount.value.length).toBeGreaterThan(0);
      expect(forAccount.value.every((f) => f.accountId === h.account.id)).toBe(true);
      // Which permitted source produced each one?
      expect(new Set(forAccount.value.map((f) => f.source))).toEqual(new Set(["account_record"]));
      // When was each retrieved?
      expect(forAccount.value.every((f) => f.retrievedAt === FIXED_NOW.toISOString())).toBe(true);
      // The record provider reports only what the workspace supplied.
      const fields = forAccount.value.map((f) => f.field).sort();
      expect(fields).toEqual([
        "company_size",
        "domain",
        "geography",
        "industry",
        "name",
        "website",
      ]);
      expect(forAccount.value.every((f) => f.claimKind === "fact")).toBe(true);
      expect(forAccount.value.every((f) => f.freshness === "unknown")).toBe(true);
    });
  });

  describe("scope boundary", () => {
    it("stores observations, not scores, decisions or outreach", async () => {
      const h = harness([
        providerReturning("public_site", { ok: true, findings: [validObservation] }),
      ]);
      const created = createRequest(h, "public_site");
      if (!isOk(created)) throw new Error("request creation failed");
      await h.service.runResearchRequest(created.value.id, h.owner);

      const document = JSON.stringify({
        requests: h.store.db.researchRequests,
        findings: h.store.db.researchFindings,
      });
      // None of these concepts exists in the Phase 6 model, so none can be
      // reported from research output.
      for (const forbidden of [
        "score",
        "qualification",
        "qualified",
        "buyingIntent",
        "priority",
        "rank",
        "outreach",
        "message",
        "emailBody",
        "crmSync",
        "verified",
        "approved",
        "authoritative",
        "evidenceId",
      ]) {
        expect(document).not.toContain(forbidden);
      }
    });
  });
});
