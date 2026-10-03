import { afterAll, describe, expect, it } from "vitest";
import { isOk } from "@dealora/core";
import type { Result } from "@dealora/core";
import { Store, store as defaultStore } from "@dealora/db";
import type { Account, Contact, RevenueGoal, RevenuePlan } from "@dealora/db";
import { AccountService } from "@dealora/account";
import type { AccountRepository, PlanLinkReader } from "@dealora/account";
import { createIndex, setSessionIndex, signup } from "@dealora/auth";
import { createDefaultHandlers } from "@dealora/api";
import type { ApiError, ApiResponse, RequestBody } from "@dealora/api";

/**
 * Phase 5 gate — ROADMAP.md §12.
 *
 * A user must be able to create or import target accounts and the contacts at
 * them, and the system must be able to answer where each record came from,
 * which workspace owns it and whether it is active or archived.
 *
 * The first test walks the whole path through the real signup/session layer,
 * the real default wiring and the real default store, then re-reads the records
 * from a service built over the persisted document to prove they were written,
 * not merely held in memory.
 *
 * Phase 5 stores what the user supplied. It does not research, score,
 * qualify or contact anyone, and the last test proves no such claim exists.
 */

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

interface ImportOutcome {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  results: { row: number; status: string; id?: string; reason?: string; field?: string }[];
}

/** A service over a reloaded copy of the persisted document. */
function reloadedAccountService(store: Store): AccountService {
  return new AccountService(
    store as unknown as AccountRepository,
    ((revenuePlanId, userId) =>
      store.getRevenuePlan(revenuePlanId, userId)) as unknown as PlanLinkReader,
  );
}

describe("Phase 5 gate", () => {
  // The auth layer and the default wiring are bound to the default store
  // singleton, so the end-to-end path must use it too.
  afterAll(() => {
    defaultStore.destroy();
  });

  it("authenticated user → workspace → revenue plan → import accounts → import contacts → persisted → reload → relationship preserved", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const handlers = createDefaultHandlers();

    // 1. Authenticate for real.
    const owner = signup("gate-account@example.com", "correct-horse-battery", "Owner A");
    const token = owner.token;
    expect(token).toBeTruthy();

    // 2. Workspace as the tenant boundary.
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Gate Account Co" });
    expect(isOk(workspace)).toBe(true);
    if (!isOk(workspace)) return;
    const workspaceId = workspace.value.id;

    // 3. A RevenuePlan, so the accounts have a plan to be associated with.
    await dataOf(
      handlers.upsertCompanyHandler(
        request(
          token,
          { workspaceId },
          { name: "Gate Account Corp", description: "Revenue operations", market: "B2B SaaS" },
        ),
      ),
    );
    const offer = (await dataOf(
      handlers.createOfferHandler(
        request(
          token,
          { workspaceId },
          { name: "AI automation", description: "Automates revenue" },
        ),
      ),
    )) as { offer: { id: string } };
    const icp = (await dataOf(
      handlers.upsertIcpHandler(
        request(token, { workspaceId }, { industries: ["SaaS"], disqualifiers: ["Pre-revenue"] }),
      ),
    )) as { icp: { id: string } };
    const persona = (await dataOf(
      handlers.createPersonaHandler(request(token, { workspaceId }, { title: "Head of Revenue" })),
    )) as { persona: { id: string } };
    const goal = (await dataOf(
      handlers.createRevenueGoalHandler(
        request(
          token,
          { workspaceId },
          {
            objective: "Generate $100,000 of pipeline from mid-market SaaS companies",
            targetMetric: "pipeline",
            targetValue: 100000,
            currency: "USD",
            timeWindow: { start: "2026-03-01", end: "2026-06-01" },
            market: "B2B SaaS",
            offerId: offer.offer.id,
            icpId: icp.icp.id,
            buyerPersonaIds: [persona.persona.id],
            successMetrics: [{ kind: "pipeline", target: 100000, unit: "USD" }],
          },
        ),
      ),
    )) as { goal: RevenueGoal };
    const plan = (await dataOf(
      handlers.compileRevenuePlanHandler(
        request(token, { workspaceId }, { revenueGoalId: goal.goal.id }),
      ),
    )) as { plan: RevenuePlan };

    // 4. Import target accounts. The file is user-supplied input; the plan says
    //    nothing has been sourced, and Phase 5 does not change that.
    const accountsCsv = [
      "name,website,industry,company_size,geography,source_reference",
      "Northwind Trading,https://northwind.example,Wholesale,120,UK,q1-target-list.csv",
      "Initech,https://www.initech.example,Software,9000,US,q1-target-list.csv",
      ",https://nameless.example,Retail,5,US,q1-target-list.csv",
      "Bad Website,not-a-url,Retail,5,US,q1-target-list.csv",
    ].join("\n");
    const imported = (await dataOf(
      handlers.importAccountsHandler(
        request(token, { workspaceId }, { csv: accountsCsv, revenuePlanId: plan.plan.id }),
      ),
    )) as ImportOutcome;

    // Every row is accounted for; the two bad rows are reported, not dropped.
    expect(imported.total).toBe(4);
    expect(imported.created).toBe(2);
    expect(imported.updated).toBe(0);
    expect(imported.skipped).toBe(0);
    expect(imported.failed).toBe(2);
    expect(imported.created + imported.updated + imported.skipped + imported.failed).toBe(
      imported.total,
    );
    expect(imported.results.filter((r) => r.status === "failed").map((r) => r.row)).toEqual([4, 5]);
    for (const failed of imported.results.filter((r) => r.status === "failed")) {
      expect(failed.reason).toBe("invalid");
      expect(failed.field).toBeTruthy();
    }

    // 5. The user can also create one by hand, in the same workspace.
    const manual = (await dataOf(
      handlers.createAccountHandler(
        request(
          token,
          { workspaceId },
          {
            name: "Contoso",
            website: "contoso.example",
            geography: "  DE  ",
            sourceReference: "sales-conversation",
          },
        ),
      ),
    )) as { account: Account };
    expect(manual.account.source).toBe("manual");
    expect(manual.account.status).toBe("active");
    expect(manual.account.workspaceId).toBe(workspaceId);

    // 6. Import contacts against those accounts.
    const listed = (await dataOf(
      handlers.listAccountsHandler(request(token, { workspaceId })),
    )) as { accounts: Account[] };
    expect(listed.accounts).toHaveLength(3);
    const northwind = listed.accounts.find((a) => a.name === "Northwind Trading");
    expect(northwind?.domain).toBe("northwind.example");
    // The domain is normalized deterministically from the supplied website.
    expect(listed.accounts.find((a) => a.name === "Initech")?.domain).toBe("initech.example");
    // Provenance is recorded, never claimed as verification.
    expect(northwind?.source).toBe("csv");
    expect(northwind?.sourceReference).toBe("q1-target-list.csv");
    // The optional plan association is stored and validated.
    expect(northwind?.revenuePlanId).toBe(plan.plan.id);
    // The manual record is normalized, not rewritten.
    expect(listed.accounts.find((a) => a.name === "Contoso")?.geography).toBe("DE");

    const contactsCsv = [
      "account,first_name,last_name,job_title,email,source_reference",
      `${northwind?.id ?? ""},Ada,Wong,VP Revenue,ada@northwind.example,contacts-q1.csv`,
      "Initech,Grace,Hopper,CTO,grace@initech.example,contacts-q1.csv",
      ",Nobody,Here,Analyst,nobody@nowhere.example,contacts-q1.csv",
      "Contoso,Katherine,Johnson,COO,,contacts-q1.csv",
    ].join("\n");
    const contactsImported = (await dataOf(
      handlers.importContactsHandler(
        request(token, { workspaceId }, { csv: contactsCsv, sourceReference: "contacts-q1.csv" }),
      ),
    )) as ImportOutcome;
    expect(contactsImported.total).toBe(4);
    expect(contactsImported.created).toBe(3);
    expect(contactsImported.failed).toBe(1);
    expect(contactsImported.results[2]?.reason).toBe("missing_account_reference");

    // 7. Every question the phase must answer can be answered.
    const allContacts = (await dataOf(
      handlers.listContactsHandler(request(token, { workspaceId })),
    )) as { contacts: Contact[] };
    expect(allContacts.contacts).toHaveLength(3);
    expect(allContacts.contacts.every((c) => c.workspaceId === workspaceId)).toBe(true);

    const atNorthwind = (await dataOf(
      handlers.listAccountContactsHandler(request(token, { accountId: northwind?.id ?? "" })),
    )) as { contacts: Contact[] };
    // Which contacts belong to each account?
    expect(atNorthwind.contacts.map((c) => c.fullName)).toEqual(["Ada Wong"]);

    // Where did each record come from?
    expect(allContacts.contacts.map((c) => c.source)).toEqual(["csv", "csv", "csv"]);
    expect(allContacts.contacts.every((c) => c.sourceReference === "contacts-q1.csv")).toBe(true);

    // Which records are active or archived?
    const archived = (await dataOf(
      handlers.archiveAccountHandler(request(token, { id: manual.account.id })),
    )) as { account: Account };
    expect(archived.account.status).toBe("archived");
    const active = (await dataOf(
      handlers.listAccountsHandler(
        request(token, { workspaceId }, undefined, { status: "active" }),
      ),
    )) as { accounts: Account[] };
    expect(active.accounts).toHaveLength(2);

    // 8. Persistence: a service over the reloaded document sees everything.
    const reloadedStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const reloaded = reloadedAccountService(reloadedStore);
    const reloadedAccount = reloaded.getAccount(northwind?.id ?? "", owner.user.id);
    expect(isOk(reloadedAccount)).toBe(true);
    if (!isOk(reloadedAccount)) return;
    expect(reloadedAccount.value.domain).toBe("northwind.example");
    expect(reloadedAccount.value.sourceReference).toBe("q1-target-list.csv");
    expect(reloadedAccount.value.revenuePlanId).toBe(plan.plan.id);

    const reloadedContacts = reloaded.listContactsForAccount(northwind?.id ?? "", owner.user.id);
    expect(isOk(reloadedContacts)).toBe(true);
    if (!isOk(reloadedContacts)) return;
    expect(reloadedContacts.value).toHaveLength(1);
    // The account/contact relationship survives the round trip.
    expect(reloadedContacts.value[0]?.accountId).toBe(northwind?.id);
    expect(reloadedContacts.value[0]?.email).toBe("ada@northwind.example");

    // The plan's accounts are still answerable after a reload.
    const planAccounts = reloaded.listAccountsForPlan(plan.plan.id, owner.user.id);
    expect(isOk(planAccounts)).toBe(true);
    if (!isOk(planAccounts)) return;
    expect(planAccounts.value.map((a) => a.name).sort()).toEqual(["Initech", "Northwind Trading"]);

    // 9. Duplicate handling: the same file again updates, it does not double.
    const again = (await dataOf(
      handlers.importAccountsHandler(
        request(token, { workspaceId }, { csv: accountsCsv, revenuePlanId: plan.plan.id }),
      ),
    )) as ImportOutcome;
    expect(again.updated).toBe(2);
    expect(again.created).toBe(0);
    expect(again.failed).toBe(2);
    const afterRepeat = (await dataOf(
      handlers.listAccountsHandler(request(token, { workspaceId })),
    )) as { accounts: Account[] };
    expect(afterRepeat.accounts).toHaveLength(3);

    // An ambiguous name is reported and preserved, never silently merged. A shared
    // name with a different domain is not proof that two companies are one.
    const ambiguous = (await dataOf(
      handlers.importAccountsHandler(
        request(token, { workspaceId }, { csv: "name,domain\nInitech,initech-labs.example" }),
      ),
    )) as ImportOutcome;
    expect(ambiguous.skipped).toBe(1);
    expect(ambiguous.results[0]?.reason).toBe("ambiguous_name");

    // A repeated contact email refreshes the person rather than duplicating.
    const repeatContact = (await dataOf(
      handlers.importContactsHandler(
        request(
          token,
          { workspaceId },
          {
            csv: [
              "account,first_name,last_name,job_title,email",
              `${northwind?.id ?? ""},Ada,Wong,Chief Revenue Officer,ADA@northwind.example`,
            ].join("\n"),
          },
        ),
      ),
    )) as ImportOutcome;
    expect(repeatContact.updated).toBe(1);
    expect(repeatContact.created).toBe(0);
  });

  it("enforces workspace authorization on every account and contact entry point", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers();

    const ownerA = signup("gate-account-a@example.com", "correct-horse-battery", "Owner A");
    const ownerB = signup("gate-account-b@example.com", "correct-horse-battery", "Owner B");
    // The default store is one shared document: workspace slugs must not
    // collide with any other gate suite.
    const wsA = defaultStore.createWorkspace({ ownerId: ownerA.user.id, name: "Account Acme" });
    const wsB = defaultStore.createWorkspace({ ownerId: ownerB.user.id, name: "Account Globex" });
    if (!isOk(wsA) || !isOk(wsB)) throw new Error("fixture workspaces failed");

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id },
          {
            name: "Acme Private",
            website: "https://private.example",
            sourceReference: "confidential",
          },
        ),
      ),
    )) as { account: Account };
    const contact = (await dataOf(
      handlers.createContactHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id, accountId: account.account.id },
          { firstName: "Ada", email: "ada@private.example" },
        ),
      ),
    )) as { contact: Contact };

    // User A + Workspace A + Account A = allowed.
    const own = await dataOf(
      handlers.getAccountHandler(request(ownerA.token, { id: account.account.id })),
    );
    expect(JSON.stringify(own)).toContain("private.example");

    // User B + Workspace A + Account A = denied on every entry point.
    const denials = await Promise.all([
      errorOf(handlers.getAccountHandler(request(ownerB.token, { id: account.account.id }))),
      errorOf(
        handlers.updateAccountHandler(
          request(ownerB.token, { id: account.account.id }, { industry: "Retail" }),
        ),
      ),
      errorOf(handlers.archiveAccountHandler(request(ownerB.token, { id: account.account.id }))),
      errorOf(handlers.listAccountsHandler(request(ownerB.token, { workspaceId: wsA.value.id }))),
      errorOf(
        handlers.listAccountContactsHandler(
          request(ownerB.token, { accountId: account.account.id }),
        ),
      ),
      errorOf(handlers.getContactHandler(request(ownerB.token, { id: contact.contact.id }))),
      errorOf(
        handlers.updateContactHandler(
          request(ownerB.token, { id: contact.contact.id }, { jobTitle: "CEO" }),
        ),
      ),
      errorOf(handlers.archiveContactHandler(request(ownerB.token, { id: contact.contact.id }))),
    ]);
    for (const denial of denials) {
      expect(denial.code).toBe("UNAUTHORIZED");
      // A denial discloses nothing about the other tenant's data.
      expect(JSON.stringify(denial)).not.toContain("private.example");
      expect(JSON.stringify(denial)).not.toContain("confidential");
    }

    // A contact may not be attached to another workspace's account, from
    // either side.
    const foreignAttach = await errorOf(
      handlers.createContactHandler(
        request(
          ownerB.token,
          { workspaceId: wsB.value.id },
          { accountId: account.account.id, firstName: "Mallory", email: "m@evil.example" },
        ),
      ),
    );
    expect(foreignAttach.code).toBe("NOT_FOUND");

    // A client-supplied workspaceId or userId in the body is ignored: the
    // contact lands in the route's workspace, owned by the token's user.
    const ignoredBodyIdentity = (await dataOf(
      handlers.createContactHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id },
          {
            accountId: account.account.id,
            firstName: "Grace",
            lastName: "Hopper",
            workspaceId: wsB.value.id,
            userId: ownerB.user.id,
          },
        ),
      ),
    )) as { contact: Contact };
    expect(ignoredBodyIdentity.contact.workspaceId).toBe(wsA.value.id);
    expect(ignoredBodyIdentity.contact.createdBy).toBe(ownerA.user.id);
    const inB = (await dataOf(
      handlers.listContactsHandler(request(ownerB.token, { workspaceId: wsB.value.id })),
    )) as { contacts: Contact[] };
    expect(inB.contacts).toEqual([]);

    // An account may not be associated with another workspace's plan.
    const foreignPlan = await errorOf(
      handlers.createAccountHandler(
        request(
          ownerA.token,
          { workspaceId: wsA.value.id },
          { name: "Mismatch", revenuePlanId: "not-my-plan" },
        ),
      ),
    );
    expect(foreignPlan.code).toBe("NOT_FOUND");

    // Tenant B's own workspace is empty.
    const ownWorkspace = (await dataOf(
      handlers.listAccountsHandler(request(ownerB.token, { workspaceId: wsB.value.id })),
    )) as { accounts: Account[] };
    expect(ownWorkspace.accounts).toEqual([]);
  });

  it("archives an account with its contacts and never hard-deletes", async () => {
    setSessionIndex(createIndex());
    const handlers = createDefaultHandlers();
    const owner = signup("gate-account-archive@example.com", "correct-horse-battery", "Owner");
    const workspace = defaultStore.createWorkspace({
      ownerId: owner.user.id,
      name: "Account Archive",
    });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;

    const account = (await dataOf(
      handlers.createAccountHandler(
        request(owner.token, { workspaceId }, { name: "Soylent", website: "soylent.example" }),
      ),
    )) as { account: Account };
    const contact = (await dataOf(
      handlers.createContactHandler(
        request(
          owner.token,
          { workspaceId },
          { accountId: account.account.id, firstName: "Ada", email: "ada@soylent.example" },
        ),
      ),
    )) as { contact: Contact };

    await dataOf(handlers.archiveAccountHandler(request(owner.token, { id: account.account.id })));

    // Soft archive: both rows are still readable, in archived state.
    const archivedAccount = (await dataOf(
      handlers.getAccountHandler(request(owner.token, { id: account.account.id })),
    )) as { account: Account };
    expect(archivedAccount.account.status).toBe("archived");
    const archivedContact = (await dataOf(
      handlers.getContactHandler(request(owner.token, { id: contact.contact.id })),
    )) as { contact: Contact };
    expect(archivedContact.contact.status).toBe("archived");
    // No orphan: the contact still points at its account.
    expect(archivedContact.contact.accountId).toBe(account.account.id);

    const activeContacts = (await dataOf(
      handlers.listContactsHandler(
        request(owner.token, { workspaceId }, undefined, {
          status: "active",
        }),
      ),
    )) as { contacts: Contact[] };
    expect(activeContacts.contacts).toEqual([]);

    // An archived account takes no new contacts.
    const refused = await errorOf(
      handlers.createContactHandler(
        request(
          owner.token,
          { workspaceId },
          { accountId: account.account.id, firstName: "Late", email: "late@soylent.example" },
        ),
      ),
    );
    expect(refused.code).toBe("CONFLICT");
  });

  it("stores user input only: no research, scoring or qualification is claimed", async () => {
    setSessionIndex(createIndex());
    const store = defaultStore;
    const handlers = createDefaultHandlers();
    const owner = signup("gate-account-claims@example.com", "correct-horse-battery", "Owner");
    const workspace = store.createWorkspace({ ownerId: owner.user.id, name: "Account Claims" });
    if (!isOk(workspace)) throw new Error("fixture workspace failed");
    const workspaceId = workspace.value.id;

    const imported = (await dataOf(
      handlers.importAccountsHandler(
        request(
          owner.token,
          { workspaceId },
          {
            csv: "name,website\nClaims Co,https://claims.example",
            sourceReference: "user-list.csv",
          },
        ),
      ),
    )) as ImportOutcome;
    expect(imported.created).toBe(1);

    // The persisted Phase 5 state holds input fields only. None of these
    // concepts exists in the account or contact schema, so none can be
    // reported from it.
    const document = JSON.stringify({
      accounts: store.db.accounts,
      contacts: store.db.contacts,
    });
    for (const forbidden of [
      "score",
      "priority",
      "buyingIntent",
      "qualified",
      "qualification",
      "enriched",
      "crawled",
      "scraped",
      "verifiedAt",
      "evidence",
      "outreach",
      "emailSent",
      "lastContacted",
    ]) {
      expect(document).not.toContain(forbidden);
    }

    // The only source vocabulary is the user's own provenance.
    const account = (await dataOf(
      handlers.listAccountsHandler(request(owner.token, { workspaceId })),
    )) as { accounts: Account[] };
    expect(account.accounts[0]?.source).toBe("csv");
    expect(account.accounts[0]?.sourceReference).toBe("user-list.csv");
    expect(Object.keys(account.accounts[0] ?? {}).sort()).toEqual([
      "companySize",
      "createdAt",
      "createdBy",
      "description",
      "domain",
      "geography",
      "id",
      "industry",
      "name",
      "revenuePlanId",
      "source",
      "sourceReference",
      "status",
      "updatedAt",
      "website",
      "workspaceId",
    ]);

    // An unknown source is refused rather than stored, so provenance cannot be
    // forged into something DEALORA did not receive.
    const forged = await errorOf(
      handlers.createAccountHandler(
        request(owner.token, { workspaceId }, { name: "Forged", source: "linkedin_scrape" }),
      ),
    );
    expect(forged.code).toBe("VALIDATION_ERROR");
  });
});
