# ADR 0006 — Account & Prospect Input: storing what the user supplied

- Status: Accepted
- Date: 2026-10-03
- Phase: ROADMAP.md Phase 5 (Account & Prospect Input)

## Context

`DEALORA_BLUEPRINT.md` §8 makes `Account` and `Contact` first-class entities,
and the pipeline runs
`Business → Revenue Goal → ICP → Target Accounts → Research → Evidence → …`.
`ROADMAP.md` §12 requires workspace-isolated storage of target accounts and
their contacts, with manual creation, CSV import, retrieval, update,
archival, deduplication, validation, an optional `RevenuePlan` association and
audit-friendly source information, under the gate: *a user can import or
create target accounts and contacts.*

Phase 4 delivered the `RevenuePlan`, whose sourcing section states explicitly
that no accounts have been sourced and that account sourcing belongs to a
later phase. Phase 5 is that phase — and it is an **input** phase.

Four constraints shaped the design:

1. **Input is not evidence.** An account a user typed in, or a row from a
   spreadsheet, is unverified. Presenting it as researched fact would make
   DEALORA confidently wrong, which is the failure ADR 0003 and ADR 0004 exist
   to prevent. Verification belongs to the Research and Evidence phases.
2. **A name is not an identity.** "Initech" may be three companies. Merging on
   a name match would silently destroy or conflate user data, and a
   deterministic rule is required — no LLM, no fuzzy guessing.
3. **A bad spreadsheet row must not corrupt the good ones**, and must never be
   dropped silently either. A user uploading 2,000 rows needs to know which 3
   failed and why.
4. **Tenant isolation cannot rest on the client.** A workspace id, user id or
   account id in a request body is data, never proof of access.

## Decision

### Package layout

A new `@dealora/account` package holds the domain, below the API and above
persistence:

```
@dealora/api   →   @dealora/account   →   @dealora/db
 (transport)        (validation,           (persistence,
                     normalization,         migration)
                     duplicate policy,
                     CSV import)
```

`AccountService` depends on two narrow interfaces — `AccountRepository` and
`PlanLinkReader` — never on `Store`. `PlanLinkReader` exposes exactly one
thing about a plan: which workspace it belongs to. The account domain therefore
cannot compile, approve or execute a plan, and associating an account with a
plan can never make a plan run.

### Entities are input, and say so

```ts
type RecordSource = "manual" | "csv" | "approved_integration";
type AccountStatus = "active" | "archived";   // and ContactStatus, identical
```

Every account and contact carries `source` and an optional `sourceReference`
(the user's own words for where it came from: a filename, a list name). There
is deliberately **no** `verifiedAt`, no `confidence` and no `sourceUrl`
asserting external confirmation, because nothing in this phase verifies
anything. An unknown source value is rejected by validation rather than stored,
so provenance cannot be forged into something DEALORA did not receive.

The `status` vocabulary is two states. Opportunity stages, ICP fit and buying
signals belong to later phases; adding them here would let a later phase read a
field that was never populated by anything real.

### Normalization: deterministic and lossless

Only transformations that cannot change meaning are applied:

- whitespace trimmed and internal runs collapsed (a company **name** is never
  otherwise rewritten — "AT&T Global Trading" stays that);
- domains lower-cased with scheme, path, port, credentials and a leading
  `www.` stripped, so `HTTPS://WWW.Northwind.Example:443/pricing` and
  `northwind.example` are one key;
- URLs normalized to an absolute `http(s)` URL with a bare origin's trailing
  slash removed;
- emails lower-cased and trimmed.

A value that cannot be normalized is **reported as invalid**, never silently
dropped. There is no guessing: a missing field stays `null`.

### Deduplication: one strong key per entity

| Entity      | Strong key                        | Name-only collision |
| ----------- | --------------------------------- | ------------------- |
| `Account`   | workspace + normalized domain      | reported as `ambiguous_name`, **both records preserved** |
| `Contact`   | account id + normalized email      | n/a                 |

The rules that matter:

- The **domain** is the strong account key. Re-importing the same domain
  *updates* the existing record and touches only the fields the file supplied,
  so re-uploading a list is safe and idempotent.
- A **name** is never a strong key. When an imported row's name matches an
  existing account that has a different (or no) domain, the row is reported as
  `skipped` with reason `ambiguous_name` and **both records are kept**. A user
  can then merge them deliberately.
- Manual creation reports a duplicate domain as a `CONFLICT` rather than
  silently updating: a deliberate create should not quietly mutate a different
  record.
- Contacts dedupe within an account only. The same address at two accounts is
  two distinct people records, not a duplicate.

No LLM, no embedding, no probabilistic matching.

### CSV import: row-level partial success

The documented policy is **row-level partial success**:

```
parse → for each row: validate → resolve duplicate → create | update | skip
     → report the row's outcome
```

- Every row is validated with **the same** validators as manual entry. An
  import is not a weaker path.
- A failing row is reported (`failed` + `reason` + `field` + `message`) and
  never affects the rows around it. A malformed row (wrong column count) and a
  file that ends inside a quoted field are reported the same way.
- The result is structured and always balances:
  `total === created + updated + skipped + failed`, with a per-row
  `results[]` carrying the 1-based source line.
- Guards bound the work: at most 5,000 rows, bounded cell sizes, quoted
  fields, embedded delimiters, CRLF and a BOM are handled; nothing else is
  attempted. It is not a general-purpose CSV engine.
- A contact row names its account by **id, or by a name that is unique in this
  workspace**. An unresolvable reference fails that row only and can never
  reach another tenant.

Supported columns are documented in [`../csv-import.md`](../csv-import.md).

### Archive cascades, nothing is deleted

Archiving an account archives its **active** contacts with it, explicitly rather
than accidentally: an archived account must not keep live contacts attached.
It is a soft archive — both rows remain readable in `archived` state for audit,
and an archived account takes no new contacts. No table has a hard delete in
this phase.

### Optional, validated plan association

`Account.revenuePlanId` is optional. When supplied it is resolved through the
caller's own `PlanLinkReader` **and** the plan's `workspaceId` is compared with
the account's, so a plan id from another tenant cannot be attached even by a
caller who can read it. `listAccountsForPlan` uses the same reader, so listing
and associating can never disagree about who may see a plan.

### Zero research, zero qualification

Phase 5 performs no lookup of any kind: no crawling, no employee lookup, no
funding or hiring detection, no enrichment, no scoring, no ranking, no
outreach, no CRM write. There is no field in which such a claim could be
stored — `tests/phase5-gate.test.ts` asserts the absence of `score`,
`priority`, `buyingIntent`, `qualified`, `evidence`, `enriched`, `crawled`,
`verifiedAt`, `outreach`, `emailSent` and `lastContacted` from the persisted
account and contact state.

### Schema and migration

Two new tables, `accounts` and `contacts`, following the established
conventions (`id`, `workspace_id`, `created_at`, `updated_at`, `deleted_at`)
with closed `CHECK` constraints on `source` and `status`, indexes on workspace,
status, domain, account and email, and foreign keys to the workspace and user
(`ON DELETE CASCADE`) plus `contacts.account_id → accounts.id`
(`ON DELETE CASCADE`).

`migrateState()` step 5 adds both tables as empty arrays, gated on
`version >= 5` (`LATEST_SCHEMA_VERSION = 5`), so Phase 1–4 documents load
unchanged. Existing rows are preserved and re-running the migration is
idempotent — covered by v4→v5 preservation and v5 idempotency tests.

## Alternatives considered

- **Atomic import (all rows or none):** rejected — one typo in a 2,000-row
  file would discard 1,999 good records, and the user would learn nothing
  about the typo. Row-level reporting is strictly more useful and equally safe,
  because a row is validated and persisted independently.
- **Merging on a name match:** rejected — it silently conflates unrelated
  companies and destroys user data. Reporting ambiguity preserves the user's
  decision where it belongs.
- **Fuzzy or LLM deduplication:** rejected — non-deterministic, unexplainable
  merges of business records, and it introduces a model dependency before any
  phase needs one.
- **Storing raw values without normalization:** rejected — duplicate detection
  would fail on `WWW.Example.com` vs `example.com` and re-imports would
  multiply records.
- **An `imports` audit table:** rejected as unnecessary — the per-row result
  plus `source`/`sourceReference` on each record already answers "where did
  this come from", and the roadmap asks for a minimal schema.
- **Making the plan association mandatory:** rejected — most users supply
  accounts before a plan exists.
- **A real CSV library:** rejected — the parser is ~90 lines of deterministic
  code covering what spreadsheet exports actually produce, with no new
  dependency.

## Consequences

- Phase 5's gate is provable in CI: `tests/phase5-gate.test.ts` runs
  authentication → workspace → revenue plan → import accounts → import
  contacts → persist → reload → relationship preserved → workspace
  authorization → duplicate handling → invalid rows reported safely, and
  asserts that no research or qualification claim exists.
- Phases 1–4 gates remain green; the schema change is additive and covered by
  migration tests.
- The Research and Evidence phases can consume these records as *claims to
  verify*, with the original provenance attached, instead of starting from a
  blank sheet of scraped data.
- Deduplication is deliberately conservative: a user with several real
  companies behind one name resolves the ambiguity by hand. That is a small
  cost paid for never destroying their data.
- Normalization is irreversible for display purposes: `https://x.com` and
  `https://x.com/` both store as `https://x.com`. The user's original spelling
  is not preserved, which is acceptable for the fields involved but would need
  revisiting if a raw-payload column is ever added.
- `Store` remains a single-process JSON document with no concurrency safety,
  and sessions remain in-memory. Both are inherited from ADR 0002.