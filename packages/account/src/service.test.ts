import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@dealora/core";
import { Store, emptyState } from "@dealora/db";

import { AccountService } from "./service.js";
import type { AccountRepository, PlanLinkReader } from "./service.js";
import { normalizeDomain, normalizeEmail, normalizeUrl, parseCsv } from "./service.js";

/**
 * Account & Prospect Input — domain coverage.
 *
 * The repository is the real persistence layer, so authorization, the archive
 * cascade and persistence are exercised exactly as production runs them.
 *
 * Nothing in this suite asserts that an account is qualified, researched or
 * ready to contact. Phase 5 stores what the user supplied and stops there.
 */

interface PlanRow {
  workspaceId: string;
  memberId: string;
}

/** A plan reader that only resolves a plan for a member of its own workspace. */
const planReader =
  (plans: Record<string, PlanRow>): PlanLinkReader =>
  (revenuePlanId, userId) => {
    const plan = plans[revenuePlanId];
    if (!plan) return { ok: false, error: { code: "NOT_FOUND" } };
    if (plan.memberId !== userId) return { ok: false, error: { code: "UNAUTHORIZED" } };
    return { ok: true, value: { workspaceId: plan.workspaceId } };
  };

const fixture = (): {
  service: AccountService;
  store: Store;
  userA: string;
  workspaceA: string;
  userB: string;
  workspaceB: string;
  plans: Record<string, PlanRow>;
} => {
  const store = new Store(emptyState());

  const userAResult = store.createUser({
    email: "accounting-owner-a@example.com",
    password: "correct-horse-battery",
    displayName: "Owner A",
  });
  const userBResult = store.createUser({
    email: "accounting-owner-b@example.com",
    password: "correct-horse-battery",
    displayName: "Owner B",
  });
  if (!isOk(userAResult) || !isOk(userBResult)) throw new Error("fixture users failed");

  const workspaceAResult = store.createWorkspace({
    ownerId: userAResult.value.id,
    name: "Acme Input",
  });
  const workspaceBResult = store.createWorkspace({
    ownerId: userBResult.value.id,
    name: "Globex Input",
  });
  if (!isOk(workspaceAResult) || !isOk(workspaceBResult)) {
    throw new Error("fixture workspaces failed");
  }

  const userA = userAResult.value.id;
  const workspaceA = workspaceAResult.value.id;
  const userB = userBResult.value.id;
  const workspaceB = workspaceBResult.value.id;

  const plans: Record<string, PlanRow> = {
    "plan-a": { workspaceId: workspaceA, memberId: userA },
    "plan-b": { workspaceId: workspaceB, memberId: userB },
    // A plan user A can read but that lives in another workspace: the service
    // must still refuse to associate it, rather than trusting the plan alone.
    "plan-foreign": { workspaceId: workspaceB, memberId: userA },
  };

  const service = new AccountService(store as unknown as AccountRepository, planReader(plans));
  return { service, store, userA, workspaceA, userB, workspaceB, plans };
};

const okValue = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

describe("account creation", () => {
  it("stores exactly what the user supplied, normalized", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, {
        name: "  Northwind   Trading  ",
        website: "northwind.example/pricing",
        industry: "Wholesale",
        companySize: "120",
        geography: "UK",
        description: "Supplies the trade.",
        sourceReference: "q1-target-list.csv",
      }),
    );

    expect(account.name).toBe("Northwind Trading");
    expect(account.website).toBe("https://northwind.example/pricing");
    // The domain is derived from the supplied website, never invented.
    expect(account.domain).toBe("northwind.example");
    expect(account.source).toBe("manual");
    expect(account.sourceReference).toBe("q1-target-list.csv");
    expect(account.status).toBe("active");
    expect(account.workspaceId).toBe(workspaceA);
    // Input is not evidence: there is no verification or scoring field.
    expect(Object.keys(account)).not.toContain("score");
  });

  it("rejects a missing name, an invalid website and an oversized name", () => {
    const { service, workspaceA, userA } = fixture();

    const missingName = service.createAccount(workspaceA, userA, { name: "   " });
    expect(missingName.ok).toBe(false);
    if (!isErr(missingName)) throw new Error("expected a validation error");
    expect(missingName.error.code).toBe("VALIDATION_ERROR");

    const badUrl = service.createAccount(workspaceA, userA, {
      name: "Bad",
      website: "not a url",
    });
    expect(badUrl.ok).toBe(false);

    const huge = service.createAccount(workspaceA, userA, { name: "x".repeat(201) });
    expect(huge.ok).toBe(false);

    const badSource = service.createAccount(workspaceA, userA, {
      name: "Fine",
      source: "linkedin_scrape",
    });
    expect(badSource.ok).toBe(false);
  });

  it("refuses a second account with the same domain", () => {
    const { service, workspaceA, userA } = fixture();
    okValue(service.createAccount(workspaceA, userA, { name: "Acme One", domain: "acme.example" }));

    const duplicate = service.createAccount(workspaceA, userA, {
      name: "Acme Two",
      website: "https://www.acme.example",
    });
    expect(duplicate.ok).toBe(false);
    if (!isErr(duplicate)) throw new Error("expected a conflict");
    expect(duplicate.error.code).toBe("CONFLICT");

    expect(okValue(service.listAccounts(workspaceA, userA)).length).toBe(1);
  });
});

describe("account retrieval, update and archive", () => {
  it("retrieves, updates and archives", () => {
    const { service, workspaceA, userA } = fixture();
    const created = okValue(
      service.createAccount(workspaceA, userA, { name: "Initech", domain: "initech.example" }),
    );

    expect(okValue(service.getAccount(created.id, userA)).name).toBe("Initech");

    const updated = okValue(
      service.updateAccount(created.id, userA, { geography: "  US  ", industry: "Software" }),
    );
    expect(updated.geography).toBe("US");
    expect(updated.industry).toBe("Software");
    // A partial patch leaves untouched fields alone.
    expect(updated.name).toBe("Initech");

    const archived = okValue(service.archiveAccount(created.id, userA));
    expect(archived.status).toBe("archived");

    const again = service.archiveAccount(created.id, userA);
    expect(again.ok).toBe(false);
    if (!isErr(again)) throw new Error("expected a conflict");
    expect(again.error.code).toBe("CONFLICT");
  });

  it("refuses to edit an archived account and lists only what was asked for", () => {
    const { service, workspaceA, userA } = fixture();
    const kept = okValue(service.createAccount(workspaceA, userA, { name: "Kept" }));
    expect(kept.name).toBe("Kept");
    const archived = okValue(service.createAccount(workspaceA, userA, { name: "Archived" }));
    okValue(service.archiveAccount(archived.id, userA));

    const edit = service.updateAccount(archived.id, userA, { industry: "Retail" });
    expect(edit.ok).toBe(false);

    const active = okValue(service.listAccounts(workspaceA, userA, { status: "active" }));
    expect(active.map((a) => a.name)).toEqual(["Kept"]);
    const all = okValue(service.listAccounts(workspaceA, userA));
    expect(all.length).toBe(2);

    const badFilter = service.listAccounts(workspaceA, userA, {
      status: "disqualified" as never,
    });
    expect(badFilter.ok).toBe(false);

    expect(okValue(service.listAccountsForPlan("plan-a", userA))).toEqual([]);
  });

  it("returns the accounts a plan targeted", () => {
    const { service, workspaceA, userA } = fixture();
    okValue(
      service.createAccount(workspaceA, userA, {
        name: "Planned",
        domain: "planned.example",
        revenuePlanId: "plan-a",
      }),
    );
    okValue(
      service.createAccount(workspaceA, userA, { name: "Unplanned", domain: "other.example" }),
    );

    const targeted = okValue(service.listAccountsForPlan("plan-a", userA));
    expect(targeted.map((a) => a.name)).toEqual(["Planned"]);

    const byPlan = okValue(service.listAccounts(workspaceA, userA, { revenuePlanId: "plan-a" }));
    expect(byPlan.length).toBe(1);
  });

  it("reports an unknown account instead of inventing one", () => {
    const { service, userA } = fixture();
    const missing = service.getAccount("does-not-exist", userA);
    expect(missing.ok).toBe(false);
    if (!isErr(missing)) throw new Error("expected not found");
    expect(missing.error.code).toBe("NOT_FOUND");

    const blank = service.getAccount("", userA);
    expect(blank.ok).toBe(false);
  });
});

describe("contacts", () => {
  it("attaches a contact to an account and derives the display name", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, { name: "Umbrella", domain: "umbrella.example" }),
    );

    const contact = okValue(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Ada",
        lastName: "Wong",
        jobTitle: "VP Revenue",
        email: "  ADA@Umbrella.Example ",
        profileUrl: "linkedin.example/in/ada",
      }),
    );

    expect(contact.accountId).toBe(account.id);
    expect(contact.workspaceId).toBe(workspaceA);
    expect(contact.fullName).toBe("Ada Wong");
    expect(contact.email).toBe("ada@umbrella.example");
    expect(contact.source).toBe("manual");
    expect(contact.status).toBe("active");

    const listed = okValue(service.listContactsForAccount(account.id, userA));
    expect(listed.map((c) => c.id)).toEqual([contact.id]);
  });

  it("requires an account, a name or an email, and valid formats", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(service.createAccount(workspaceA, userA, { name: "Hooli" }));

    expect(service.createContact(workspaceA, userA, { firstName: "Sam" }).ok).toBe(false);
    expect(service.createContact(workspaceA, userA, { accountId: account.id }).ok).toBe(false);
    expect(
      service.createContact(workspaceA, userA, { accountId: account.id, email: "nope" }).ok,
    ).toBe(false);
    expect(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Sam",
        profileUrl: "not a url",
      }).ok,
    ).toBe(false);
    expect(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Sammy",
        source: "scraped",
      }).ok,
    ).toBe(false);
  });

  it("treats a duplicate email on the same account as a conflict", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(service.createAccount(workspaceA, userA, { name: "Tyrell" }));
    const other = okValue(service.createAccount(workspaceA, userA, { name: "Cyberdyne" }));

    okValue(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Ada",
        email: "ada@tyrell.example",
      }),
    );
    const duplicate = service.createContact(workspaceA, userA, {
      accountId: account.id,
      firstName: "Ada",
      email: "ADA@tyrell.example",
    });
    expect(duplicate.ok).toBe(false);
    if (!isErr(duplicate)) throw new Error("expected a conflict");
    expect(duplicate.error.code).toBe("CONFLICT");

    // The same address at a *different* account is a different person record.
    const elsewhere = okValue(
      service.createContact(workspaceA, userA, {
        accountId: other.id,
        firstName: "Ada",
        email: "ada@cyberdyne.example",
      }),
    );
    expect(elsewhere.accountId).toBe(other.id);
  });

  it("updates and archives a contact, and refuses further edits", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(service.createAccount(workspaceA, userA, { name: "Weyland" }));
    const contact = okValue(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Ada",
        email: "ada@weyland.example",
      }),
    );

    const updated = okValue(
      service.updateContact(contact.id, userA, { jobTitle: "CFO", lastName: "Wong" }),
    );
    expect(updated.jobTitle).toBe("CFO");
    expect(updated.fullName).toBe("Ada Wong");
    expect(updated.email).toBe("ada@weyland.example");

    expect(okValue(service.archiveContact(contact.id, userA)).status).toBe("archived");
    expect(service.archiveContact(contact.id, userA).ok).toBe(false);
    expect(service.updateContact(contact.id, userA, { jobTitle: "CEO" }).ok).toBe(false);
  });

  it("archives the contacts of an archived account with it", () => {
    const { service, store, workspaceA, userA } = fixture();
    const account = okValue(service.createAccount(workspaceA, userA, { name: "Soylent" }));
    const contact = okValue(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Ada",
        email: "ada@soylent.example",
      }),
    );

    okValue(service.archiveAccount(account.id, userA));

    // Soft archive: the rows are still there, just archived.
    expect(okValue(service.getContact(contact.id, userA)).status).toBe("archived");
    expect(okValue(service.listContacts(workspaceA, userA, { status: "active" }))).toEqual([]);
    expect(store.db.contacts?.length).toBe(1);
    expect(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Late",
        email: "late@soylent.example",
      }).ok,
    ).toBe(false);
  });
});

describe("workspace isolation", () => {
  it("denies another workspace's account, contact and plan", () => {
    const { service, workspaceA, workspaceB, userA, userB } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, { name: "Private", domain: "private.example" }),
    );
    const contact = okValue(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Ada",
        email: "ada@private.example",
      }),
    );

    // B cannot even resolve A's records.
    const read = service.getAccount(account.id, userB);
    expect(read.ok).toBe(false);
    if (!isErr(read)) throw new Error("expected denial");
    expect(read.error.code).toBe("UNAUTHORIZED");

    expect(service.listAccounts(workspaceA, userB).ok).toBe(false);
    expect(service.listAccountsForPlan("plan-a", userB).ok).toBe(false);
    expect(service.getContact(contact.id, userB).ok).toBe(false);
    expect(service.updateAccount(account.id, userB, { industry: "Retail" }).ok).toBe(false);
    expect(service.archiveAccount(account.id, userB).ok).toBe(false);
    expect(service.archiveContact(contact.id, userB).ok).toBe(false);

    // B cannot attach a contact to A's account, in either workspace.
    const crossWorkspace = service.createContact(workspaceB, userB, {
      accountId: account.id,
      firstName: "Mallory",
      email: "mallory@private.example",
    });
    expect(crossWorkspace.ok).toBe(false);
    expect(
      service.createContact(workspaceA, userB, {
        accountId: account.id,
        firstName: "Mallory",
      }).ok,
    ).toBe(false);

    // An account in B stays invisible to A's listing.
    const own = okValue(service.createAccount(workspaceB, userB, { name: "Theirs" }));
    expect(okValue(service.listAccounts(workspaceA, userA)).map((a) => a.id)).toEqual([account.id]);
    expect(okValue(service.listContacts(workspaceB, userB)).map((c) => c.id)).toEqual([]);
    expect(own.workspaceId).toBe(workspaceB);
  });

  it("refuses to associate an account with another workspace's plan", () => {
    const { service, workspaceA, userA } = fixture();

    const otherWorkspace = service.createAccount(workspaceA, userA, {
      name: "Mismatch",
      revenuePlanId: "plan-b",
    });
    expect(otherWorkspace.ok).toBe(false);

    // Even a plan the caller *can* read is refused when its workspace differs.
    const foreign = service.createAccount(workspaceA, userA, {
      name: "Mismatch",
      revenuePlanId: "plan-foreign",
    });
    expect(foreign.ok).toBe(false);
    if (!isErr(foreign)) throw new Error("expected denial");
    expect(foreign.error.code).toBe("UNAUTHORIZED");

    const unknown = service.createAccount(workspaceA, userA, {
      name: "Mismatch",
      revenuePlanId: "no-such-plan",
    });
    expect(unknown.ok).toBe(false);

    // The optional association still works for the workspace's own plan.
    const linked = okValue(
      service.createAccount(workspaceA, userA, { name: "Linked", revenuePlanId: "plan-a" }),
    );
    expect(linked.revenuePlanId).toBe("plan-a");
  });

  it("requires an authenticated caller and a workspace", () => {
    const { service, workspaceA } = fixture();
    expect(service.createAccount(workspaceA, "", { name: "Anon" }).ok).toBe(false);
    expect(service.createAccount("", "someone", { name: "Nowhere" }).ok).toBe(false);
  });
});

describe("deterministic normalization and duplicate keys", () => {
  it("normalizes domains, urls and emails the same way every time", () => {
    expect(normalizeDomain("  HTTPS://WWW.Northwind.Example:443/pricing?x=1 ")).toBe(
      "northwind.example",
    );
    expect(normalizeDomain("northwind.example")).toBe("northwind.example");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeUrl("northwind.example")).toBe("https://northwind.example");
    expect(normalizeUrl("https://northwind.example/")).toBe("https://northwind.example");
    expect(normalizeUrl("ftp://northwind.example")).toBeNull();
    expect(normalizeEmail(" ADA@Northwind.Example ")).toBe("ada@northwind.example");
    expect(normalizeEmail("ada@northwind")).toBeNull();
  });

  it("collapses internal whitespace without rewriting the name", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, { name: "  AT&T   Global  Trading  " }),
    );
    expect(account.name).toBe("AT&T Global Trading");
  });
});

describe("account CSV import", () => {
  const header = "name,website,industry,company_size,geography,description,source_reference";

  it("imports valid rows and records where each record came from", () => {
    const { service, workspaceA, userA } = fixture();
    const csv = [
      header,
      "Northwind,https://northwind.example,Wholesale,120,UK,Trade supplier,q1-list.csv",
      "Initech,https://initech.example,Software,9000,US,Enterprise software,q1-list.csv",
    ].join("\n");

    const result = okValue(service.importAccountsCsv(workspaceA, userA, csv));
    expect(result).toMatchObject({ total: 2, created: 2, updated: 0, skipped: 0, failed: 0 });

    const accounts = okValue(service.listAccounts(workspaceA, userA));
    expect(accounts.length).toBe(2);
    const northwind = accounts.find((a) => a.name === "Northwind");
    expect(northwind?.domain).toBe("northwind.example");
    expect(northwind?.source).toBe("csv");
    expect(northwind?.sourceReference).toBe("q1-list.csv");
    expect(northwind?.status).toBe("active");
  });

  it("reports an invalid row without touching its neighbours", () => {
    const { service, workspaceA, userA } = fixture();
    const csv = [
      header,
      "Good Co,https://good.example,Retail,10,US,ok,list.csv",
      ",https://nameless.example,Retail,10,US,no name,list.csv",
      "Bad URL,not-a-url,Retail,10,US,bad website,list.csv",
      "Also Good,https://alsogood.example,Retail,10,US,fine,list.csv",
    ].join("\n");

    const result = okValue(service.importAccountsCsv(workspaceA, userA, csv));
    expect(result.total).toBe(4);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(2);
    // Every row is accounted for: nothing is silently dropped.
    expect(result.created + result.updated + result.skipped + result.failed).toBe(result.total);
    expect(result.results.map((r) => r.row)).toEqual([2, 3, 4, 5]);
    expect(result.results[1]?.reason).toBe("invalid");

    const accounts = okValue(service.listAccounts(workspaceA, userA));
    expect(accounts.map((a) => a.name).sort()).toEqual(["Also Good", "Good Co"]);
  });

  it("updates a re-imported domain instead of duplicating it", () => {
    const { service, workspaceA, userA } = fixture();
    const first = okValue(
      service.importAccountsCsv(
        workspaceA,
        userA,
        [header, "Northwind,https://northwind.example,Wholesale,120,UK,One,list.csv"].join("\n"),
      ),
    );
    expect(first.created).toBe(1);

    const second = okValue(
      service.importAccountsCsv(
        workspaceA,
        userA,
        [header, "Northwind Ltd,https://www.northwind.example,Wholesale,150,UK,Two,list.csv"].join(
          "\n",
        ),
      ),
    );
    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);

    const accounts = okValue(service.listAccounts(workspaceA, userA));
    expect(accounts.length).toBe(1);
    expect(accounts[0]?.description).toBe("Two");
    expect(accounts[0]?.companySize).toBe("150");
  });

  it("skips a second row that repeats a domain inside one file", () => {
    const { service, workspaceA, userA } = fixture();
    const result = okValue(
      service.importAccountsCsv(
        workspaceA,
        userA,
        [
          header,
          "Northwind,https://northwind.example,Wholesale,120,UK,One,list.csv",
          "Northwind Copy,https://northwind.example,Wholesale,120,UK,Two,list.csv",
        ].join("\n"),
      ),
    );
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.results[1]?.reason).toBe("duplicate_in_file");
    expect(okValue(service.listAccounts(workspaceA, userA)).length).toBe(1);
  });

  it("preserves both records when only the name matches", () => {
    const { service, workspaceA, userA } = fixture();
    okValue(service.createAccount(workspaceA, userA, { name: "Signal", domain: "signal.example" }));

    const result = okValue(
      service.importAccountsCsv(
        workspaceA,
        userA,
        [
          header,
          "Signal,https://signal-labs.example,Research,20,US,different company,list.csv",
        ].join("\n"),
      ),
    );
    // Ambiguous: a shared name is never proof that two companies are the same.
    expect(result.skipped).toBe(1);
    expect(result.results[0]?.reason).toBe("ambiguous_name");

    const accounts = okValue(service.listAccounts(workspaceA, userA));
    expect(accounts.length).toBe(1);
    expect(accounts[0]?.domain).toBe("signal.example");
  });

  it("associates a plan and rejects a row pointing at another tenant's plan", () => {
    const { service, workspaceA, userB, userA } = fixture();
    const csv = [
      "name,domain,revenue_plan_id",
      "Linked,northwind.example,plan-a",
      "Rogue,rogue.example,plan-b",
    ].join("\n");

    const result = okValue(service.importAccountsCsv(workspaceA, userA, csv));
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[1]?.reason).toBe("invalid_plan_reference");

    const accounts = okValue(service.listAccounts(workspaceA, userA));
    expect(accounts[0]?.revenuePlanId).toBe("plan-a");
    // The other tenant cannot see them at all.
    expect(service.listAccounts(workspaceA, userB).ok).toBe(false);
  });

  it("rejects an unusable file and a file without a name column", () => {
    const { service, workspaceA, userA, userB } = fixture();
    expect(service.importAccountsCsv(workspaceA, userA, "").ok).toBe(false);
    expect(service.importAccountsCsv(workspaceA, userA, "website,industry\na.com,Retail").ok).toBe(
      false,
    );
    expect(service.importAccountsCsv(workspaceA, userB, "name\nX").ok).toBe(false);
  });

  it("reports a malformed row and still imports the rest", () => {
    const { service, workspaceA, userA } = fixture();
    const csv = [
      header,
      "Good Co,https://good.example,Retail,10,US,ok,list.csv",
      "Too,Many,Columns,Here,Now,Extra,Values,list.csv",
      "Another Good,https://another.example,Retail,10,US,fine,list.csv",
    ].join("\n");

    const result = okValue(service.importAccountsCsv(workspaceA, userA, csv));
    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.reason).toBe("malformed_row");
    expect(okValue(service.listAccounts(workspaceA, userA)).length).toBe(2);
  });

  it("reads quoted fields, embedded delimiters, CRLF and a BOM", () => {
    const { service, workspaceA, userA } = fixture();
    const csv =
      "﻿name,description\r\n" +
      '"Contoso, Ltd.","Sells ""widgets"", and gadgets"\r\n' +
      "Fabrikam,Plain description\r\n";

    const result = okValue(service.importAccountsCsv(workspaceA, userA, csv));
    expect(result.created).toBe(2);
    const accounts = okValue(service.listAccounts(workspaceA, userA));
    expect(accounts.map((a) => a.description).sort()).toEqual([
      "Plain description",
      'Sells "widgets", and gadgets',
    ]);
  });

  it("parses the CSV shape without a domain engine", () => {
    const parsed = parseCsv('a,b\n"1","2,3"\n');
    expect(parsed.header).toEqual(["a", "b"]);
    expect(parsed.rows[0]?.cells).toEqual({ a: "1", b: "2,3" });
    expect(parsed.malformed).toEqual([]);
  });
});

describe("contact CSV import", () => {
  const header = "account,first_name,last_name,job_title,email,phone,source_reference";

  it("imports contacts against an account id or a unique account name", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, { name: "Northwind", domain: "northwind.example" }),
    );

    const result = okValue(
      service.importContactsCsv(
        workspaceA,
        userA,
        [
          header,
          `${account.id},Ada,Wong,VP Revenue,ada@northwind.example,+1 555,people.csv`,
          "Northwind,Grace,Hopper,CTO,grace@northwind.example,,people.csv",
        ].join("\n"),
      ),
    );
    expect(result).toMatchObject({ total: 2, created: 2, updated: 0, skipped: 0, failed: 0 });

    const contacts = okValue(service.listContactsForAccount(account.id, userA));
    expect(contacts.map((c) => c.fullName).sort()).toEqual(["Ada Wong", "Grace Hopper"]);
    expect(contacts.every((c) => c.source === "csv")).toBe(true);
  });

  it("fails a row with no account or an unknown account, and keeps the rest", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, { name: "Northwind", domain: "northwind.example" }),
    );

    const result = okValue(
      service.importContactsCsv(
        workspaceA,
        userA,
        [
          header,
          ",Nobody,Here,VP,nobody@nowhere.example,,people.csv",
          "Nowhere Inc,Ada,Wong,VP,ada@nowhere.example,,people.csv",
          `${account.id},Grace,Hopper,CTO,grace@northwind.example,,people.csv`,
        ].join("\n"),
      ),
    );
    expect(result.created).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.results[0]?.reason).toBe("missing_account_reference");
    expect(result.results[1]?.reason).toBe("unknown_account");
    expect(okValue(service.listContacts(workspaceA, userA)).length).toBe(1);
  });

  it("never resolves an account reference in another workspace", () => {
    const { service, workspaceA, workspaceB, userA, userB } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, { name: "Northwind", domain: "northwind.example" }),
    );

    const result = okValue(
      service.importContactsCsv(
        workspaceB,
        userB,
        [header, `${account.id},Mallory,Malice,Boss,mallory@evil.example,,evil.csv`].join("\n"),
      ),
    );
    expect(result.failed).toBe(1);
    expect(result.results[0]?.reason).toBe("unknown_account");
    expect(okValue(service.listContacts(workspaceB, userB))).toEqual([]);
    expect(okValue(service.listContacts(workspaceA, userA))).toEqual([]);
  });

  it("refreshes an existing contact instead of duplicating the person", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, { name: "Northwind", domain: "northwind.example" }),
    );

    const first = okValue(
      service.importContactsCsv(
        workspaceA,
        userA,
        [header, `${account.id},Ada,,Analyst,ada@northwind.example,,people.csv`].join("\n"),
      ),
    );
    expect(first.created).toBe(1);

    const second = okValue(
      service.importContactsCsv(
        workspaceA,
        userA,
        [header, `${account.id},Ada,Wong,VP Revenue,ADA@northwind.example,,people.csv`].join("\n"),
      ),
    );
    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);

    const contacts = okValue(service.listContactsForAccount(account.id, userA));
    expect(contacts.length).toBe(1);
    expect(contacts[0]?.fullName).toBe("Ada Wong");
    expect(contacts[0]?.jobTitle).toBe("VP Revenue");
  });

  it("skips a repeated row inside one file and refuses an archived account", () => {
    const { service, workspaceA, userA } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, { name: "Northwind", domain: "northwind.example" }),
    );

    const repeated = okValue(
      service.importContactsCsv(
        workspaceA,
        userA,
        [
          header,
          `${account.id},Ada,Wong,VP,ada@northwind.example,,people.csv`,
          `${account.id},Ada,Wong,VP,ada@northwind.example,,people.csv`,
        ].join("\n"),
      ),
    );
    expect(repeated.created).toBe(1);
    expect(repeated.skipped).toBe(1);
    expect(repeated.results[1]?.reason).toBe("duplicate_in_file");

    okValue(service.archiveAccount(account.id, userA));
    const archived = okValue(
      service.importContactsCsv(
        workspaceA,
        userA,
        [header, `${account.id},Grace,Hopper,CTO,grace@northwind.example,,people.csv`].join("\n"),
      ),
    );
    expect(archived.skipped).toBe(1);
    expect(archived.results[0]?.reason).toBe("archived_account");
  });

  it("rejects a file without an account column", () => {
    const { service, workspaceA, userA } = fixture();
    expect(service.importContactsCsv(workspaceA, userA, "first_name,email\nAda,a@b.co").ok).toBe(
      false,
    );
  });
});

describe("persistence and failure handling", () => {
  it("survives a reload from the persisted document", () => {
    const { service, store, workspaceA, userA } = fixture();
    const account = okValue(
      service.createAccount(workspaceA, userA, {
        name: "Northwind",
        website: "https://northwind.example",
        revenuePlanId: "plan-a",
      }),
    );
    const contact = okValue(
      service.createContact(workspaceA, userA, {
        accountId: account.id,
        firstName: "Ada",
        lastName: "Wong",
        email: "ada@northwind.example",
        sourceReference: "people.csv",
      }),
    );

    const reloadedStore = new Store(JSON.parse(JSON.stringify(store.db)) as never);
    const reloaded = new AccountService(
      reloadedStore as unknown as AccountRepository,
      planReader({ "plan-a": { workspaceId: workspaceA, memberId: userA } }),
    );

    const reloadedAccount = okValue(reloaded.getAccount(account.id, userA));
    expect(reloadedAccount.domain).toBe("northwind.example");
    expect(reloadedAccount.revenuePlanId).toBe("plan-a");

    const reloadedContact = okValue(reloaded.getContact(contact.id, userA));
    expect(reloadedContact.accountId).toBe(account.id);
    expect(reloadedContact.fullName).toBe("Ada Wong");
    expect(reloadedContact.sourceReference).toBe("people.csv");
    expect(okValue(reloaded.listContactsForAccount(account.id, userA)).length).toBe(1);
  });

  it("maps a storage failure to a closed UNAVAILABLE error", () => {
    const { store, workspaceA, userA } = fixture();
    const failing: AccountRepository = {
      ...(store as unknown as AccountRepository),
      authorize: () => ({ ok: true, value: true }),
      listAccounts: () => ({ ok: false, error: { code: "UNAVAILABLE" } }),
      createAccount: () => ({ ok: false, error: { code: "UNAVAILABLE" } }),
    } as unknown as AccountRepository;
    const broken = new AccountService(failing, planReader({}));

    const created = broken.createAccount(workspaceA, userA, { name: "Northwind" });
    expect(created.ok).toBe(false);
    if (!isErr(created)) throw new Error("expected a failure");
    expect(created.error.code).toBe("UNAVAILABLE");
    // The internal storage reason is never surfaced.
    expect(created.error.message).toBe("storage unavailable");

    const listed = broken.listAccounts(workspaceA, userA);
    expect(listed.ok).toBe(false);
    if (!isErr(listed)) throw new Error("expected a failure");
    expect(listed.error.code).toBe("UNAVAILABLE");
  });

  it("denies a caller that is not a workspace member", () => {
    const { service, workspaceA, userA, userB } = fixture();
    okValue(service.createAccount(workspaceA, userA, { name: "Northwind" }));
    expect(service.listAccounts(workspaceA, userB).ok).toBe(false);
  });
});
