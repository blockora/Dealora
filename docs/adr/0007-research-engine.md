# ADR 0007 — Research Engine: attributed observations, not evidence

- Status: Accepted
- Date: 2026-10-03
- Phase: ROADMAP.md Phase 6 (Research Engine)

## Context

`ROADMAP.md` §13 asks Phase 6 to generate structured account research where
each result supports **Claim, Source, Retrieved At, Confidence, Freshness,
Relevance and Reference**, lists the initial research categories, and gives one
critical rule: *never treat inference as fact* — every statement must carry an
explicit label (`FACT`, `INFERENCE`, `HYPOTHESIS`, `RECOMMENDATION`). Its gate
is that a target account can receive an account brief in which important claims
are traceable.

`DEALORA_BLUEPRINT.md` §43 sets the data-source rule that governs how the
research is obtained:

> DEALORA should use: user-provided data, authorized APIs, permitted
> public/business information, approved integrations. DEALORA must not depend
> on bypassing authentication, platform protections, API restrictions,
> robots/access controls or account limits.

§12.3 (Account Research Agent) asks for relevant facts, potential needs and an
evidence-backed account brief. §13 (Buying Signal Engine) describes signals with
source, timestamp, confidence and freshness. §20 insists that DEALORA never
silently pretends an action succeeded, and §73 names "scraper" as positioning to
avoid.

Phase 5 delivered exactly the input this phase consumes: workspace-isolated
`Account` records supplied by the user, carrying their own provenance
(`manual` / `csv` / `approved_integration`) and their source reference.

Two conflicts had to be resolved before any code was written.

1. The roadmap's gate says claims are traceable to *evidence*, but evidence is
   Phase 7 (`ROADMAP.md` §14). Following the source-of-truth hierarchy, the
   explicit requirement — research output is research data, not verified
   evidence — wins. Phase 6 makes every statement traceable to its **source**,
   and Phase 7 makes it traceable to a first-class `Evidence` record.
2. The roadmap lists research categories that overlap later phases (hiring,
   expansion, leadership changes, technology signals). They are implemented as
   **observation buckets only**. No signal is scored, ranked or turned into a
   buying intent; that is Phase 8.

## Decision

Add a `@dealora/research` domain, two additive tables (schema v6), six API
handlers, and one narrow provider interface.

### Architecture

```
API handlers (translation only)
      ↓
ResearchService (authorization, lifecycle, validation, persistence)
      ↓
ResearchRepository (interface)   ResearchProvider (interface)
      ↓                                    ↓
   JSON store (v6)              permitted, declared sources
```

The domain depends on interfaces, never on the store directly, exactly as the
account domain does. Nondeterminism lives at the provider boundary; everything
else — normalization, deduplication, freshness, lifecycle — is pure.

### Research request

A `ResearchRequest` is a first-class job: `workspaceId`, `accountId`,
`requestedBy` (always the session's user), `provider`, `status`, `categories`,
optional `idempotencyKey`, `findingCount`, `failureCode`/`failureMessage`, and
`startedAt`/`completedAt`. It answers "what was asked, by whom, against which
account, by which permitted source, and how did it end".

The invariant `ResearchRequest.workspaceId === Account.workspaceId` is enforced
in the service *and* again in storage, so a request can never be written across
tenants even by a caller that skips the service.

### Lifecycle

```
pending ──▶ running ──▶ completed
   │            ├──────▶ failed ──▶ running   (retry)
   │            └──────▶ cancelled
   └───────────────────▶ cancelled
```

Six states, no workflow engine. `completed` and `cancelled` are terminal;
`failed` is retryable. Illegal transitions are rejected with
`INVALID_TRANSITION`, which the API surfaces as `CONFLICT`.

### Provider boundary

```ts
interface ResearchProvider {
  readonly id: string;
  readonly source: "account_record" | "approved_api" | "public_web";
  research(query: ResearchQuery): Promise<ResearchProviderResult> | ResearchProviderResult;
}
```

- The provider receives a `ResearchQuery` containing the account's own public
  identity and the requested categories — **no workspace id, no user id, no
  other accounts, no contacts, no plan, no Brain data**. A provider cannot
  widen its own access.
- `RawProviderFinding` types every field as `unknown`. Provider output is
  external input; it is validated field by field before anything is persisted.
- `source` and `sourceName` are absent from the provider payload and stamped
  from the provider itself, so a provider cannot attribute its output to a
  source it does not hold.
- A provider that declares a source outside the closed list is refused before
  its output is read.

### Permitted sources actually shipped

Only one: **`account_record`**, the workspace's own account record —
*user-provided data*, the permitted source that needs no external access. It
reports only fields the user actually supplied, attributed to the record, with
`confidence: "medium"` because provenance strength is not verification.

**No external source is configured and none is simulated.** There is no HTTP
client, no crawler, no credential handling and no bypass of authentication,
robots/access controls, API restrictions or rate limits anywhere in the package.
`createDefaultHandlers({ researchProviders })` takes the permitted provider set
as an argument, so registering an authorized API or a permitted public source is
an explicit deployment decision that carries its own terms and attribution.
Tests use `StaticResearchProvider`, a declared double that returns exactly the
observations it was given and performs no retrieval.

### Research finding

`ResearchFinding` carries the seven things the roadmap asks a research result to
support:

| Roadmap field   | Field                                          |
| --------------- | ---------------------------------------------- |
| Claim           | `value` + `claimKind` (`fact`/`inference`/`hypothesis`/`recommendation`) |
| Source          | `source` (kind) + `sourceName` (provider)      |
| Reference       | `sourceUrl` + `sourceTitle`                    |
| Retrieved At    | `retrievedAt`                                  |
| Confidence      | `confidence` (`low`/`medium`/`high`)          |
| Freshness       | `freshness` (`unknown`/`fresh`/`recent`/`stale`) |
| Relevance       | `relevance` (`low`/`medium`/`high`)            |

Plus `category`, `field`, `observedAt`, `note` and `status`.

Three rules matter:

- **`fact` means "this source states this".** It is not a verification claim.
  Nothing in Phase 6 verifies anything.
- **A citation is never invented.** `sourceUrl` is stored exactly as the
  provider returned it and is `null` when the provider supplied none; a
  reference that is not a valid `http(s)` URL fails the observation rather than
  being stored as something unusable.
- **Freshness is a coarse band derived from the observation age at retrieval**
  (≤30 days fresh, ≤180 days recent, beyond that stale). A source that reported
  no observation date is `unknown`, not `fresh`: DEALORA will not claim currency
  it cannot see.

### Validation and failure

Provider output passes through a pure `normalizeProviderFindings` before any
write, and the write is all-or-nothing: a rejected observation leaves no partial
brief behind. Failures are recorded, not swallowed — a provider that is
unavailable, fails, throws, declares a forbidden source, or answers with
something unusable leaves the request in `failed` state with a
`failureCode`, and the API returns that failed request rather than an empty
success.

Duplicates follow the Phase 5 convention: an identical repeat of a
`category`/`field` collapses, while two *different* values for the same field
are a contradiction DEALORA refuses to resolve on the user's behalf.

### Idempotency and concurrency

- An optional caller-supplied `idempotencyKey` makes a replay return the
  original request instead of starting a second one.
- A `pending` or `running` request for the same account and provider is refused
  with `CONFLICT`, so there is at most one active research job per account and
  provider.
- A retry re-runs the same request and skips fields an earlier attempt already
  recorded, so it converges instead of accumulating.

The store is a single-process JSON document. Phase 6 makes no claim of
distributed execution: two processes would not see each other's in-flight
requests, and the single-active-request guarantee holds per store only. No
queue, worker or coordination service was added — `ROADMAP.md` does not ask for
one, and the workflow engine is Phase 24.

### API surface

Six handlers, translation only: `createResearchRequest`,
`getResearchRequest`, `listResearchRequests`, `runResearchRequest`,
`getResearchFindings`, `cancelResearchRequest`. The workspace always comes from
the route and the user always from the session; a `workspaceId` or `userId` in
the body is ignored. `UNAVAILABLE` becomes `SERVER_ERROR`, `UNSUPPORTED_PROVIDER`
becomes `VALIDATION_ERROR` and `INVALID_TRANSITION` becomes `CONFLICT`.

## Alternatives considered

- **Let research create accounts from external data.** Rejected: it collapses the
  Phase 5 input boundary and turns a research run into prospect discovery.
- **Ship a live public-web provider.** Rejected: no external source is available
  or authorized here, and simulating one would mean claiming research that never
  happened. The interface is the deliverable; the provider is a deployment
  decision.
- **Reuse one generic "entity" table for requests and findings.** Rejected: the
  two have different lifecycles, and a shared table would let a finding outlive
  the request that produced it.
- **Store a confidence percentage.** Rejected: DEALORA has no calibration data in
  this phase, so a number would be invented precision. Bands are honest.
- **Add a job queue.** Rejected: out of scope, and unnecessary for one
  single-process execution.

## Consequences

- A workspace can produce an attributable account brief from an account it
  already supplied, and can tell "researched, nothing found" apart from "could
  not research".
- Every externally-derived statement keeps who said it, where and when; a
  statement with no citation is visibly uncited rather than quietly invented.
- Research findings remain **research data**. Promotion to evidence is Phase 7's
  job and happens through an explicit, separate step.
- The permitted provider set is deployment configuration. Out of the box, only
  the workspace's own record is researchable — deliberately less than a demo
  would like, and honest about it.
- Single-process execution only; no cross-process coordination exists.

## Gate

`tests/phase6-gate.test.ts` walks authenticate → workspace → revenue plan →
account → research request → permitted provider → findings → reload, and asserts
that attribution and timestamps survive persistence, that workspace isolation
holds on every entry point, that unpermitted sources and malformed provider
output are refused, and that the persisted document contains no score,
qualification, outreach or evidence concept.