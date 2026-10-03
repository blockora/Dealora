# ADR 0004 — Revenue Goal Engine: structured goals and field provenance

- Status: Accepted
- Date: 2026-10-03
- Phase: ROADMAP.md Phase 3 (Revenue Goal Engine)

## Context

`DEALORA_BLUEPRINT.md` §7 defines the `RevenueGoal` as the object every later
phase executes against, and §17 defines the risk levels — Level 0 read,
Level 1 draft, Level 2 external action, Level 3 high impact — that constrain
it. `ROADMAP.md` §10 requires goal creation, editing, validation, a structured
representation, goal status, success metrics and goal history, and sets the
gate: *a user can create a measurable revenue goal and view its structured
representation.*

The user-facing input is a sentence, not a schema:

> Generate $100,000 of qualified pipeline from mid-market SaaS companies over
> the next 90 days using our AI automation offer.

Three constraints shaped the design:

1. **A goal is not a text field.** Phase 4 will compile it into an executable
   plan, so it must be queryable structure, not one unvalidated JSON blob.
2. **The parser must never invent business facts.** A missing target, market or
   offer is information the system does not have. Filling it in with a guess
   would make every downstream plan confidently wrong.
3. **A goal references the canonical Business Brain** (ADR 0003). Copying
   offer and ICP data into the goal would create a second source of business
   truth — the exact failure mode ADR 0003 forbids.

## Decision

### Package layout

A new `@dealora/goal` package holds the domain, sitting below the API and above
persistence, depending on the Business Brain context:

```
@dealora/api   →   @dealora/goal   →   @dealora/db
 (transport)        (domain, validation,      (persistence)
                     lifecycle, parsing)
                            ↓
                     @dealora/brain
                  (canonical business context)
```

The service depends on a `GoalRepository` interface, not on `Store`
concretely, exactly as `@dealora/brain` depends on `BrainRepository`.

### The goal is structured fields, not a blob

`RevenueGoal` carries explicit typed columns for the concepts the roadmap
names: `objective`, `targetMetric`, `targetValue`, `currency`, `timeWindow`,
`market`, `icpId`, `buyerPersonaIds`, `offerId`, `economics`, `constraints`,
`approvalPolicy`, `successMetrics`, `status`, `completeness`, `unknowns`,
`assumptions`, plus `workspaceId`, `createdBy` and timestamps.

`economics` and `constraints` are structured sub-objects (deal value,
contract floor, customer target / geographies, industries, company sizes,
channels, budget, capacity), never a free-form string, so Phase 4 can reason
about them. Constraints remain distinct from the objective: an input never
becomes a constraint by reinterpretation.

### Validation distinguishes three states

The engine separates outcomes that are easy to conflate:

- **INVALID** — cannot be stored. Missing objective, non-positive or
  non-numeric target, unknown metric kind, non-ISO currency, malformed dates
  (`2026-02-31` is rejected), reversed windows, a Business Brain reference
  that does not exist in the caller's workspace.
- **INCOMPLETE** — storable and useful, but a field could not be determined.
  The gaps are persisted on the goal as `unknowns`.
- **VALID** — everything needed to measure the outcome is present.

The engine deliberately does not over-constrain: a goal can be incomplete
without being corrupt, which is why completeness is data on the goal rather
than a rejection.

### Provenance: explicit, inferred, assumption, unknown

Every field the parser produces is tagged with its origin, and that provenance
survives into the persisted goal:

| Origin      | Meaning                                          | Persisted as     |
| ----------- | ------------------------------------------------ | ---------------- |
| `explicit`  | stated by the user                               | the value        |
| `inferred`  | derived from canonical Business Brain           | the value        |
| `assumption`| an interpretation the system made (e.g. `$` → USD) | `assumptions` |
| `unknown`   | could not be determined                          | `unknowns` + `incomplete` |

The parser returns a `GoalDraft` carrying that provenance; nothing is created
or guessed to close a gap. An offer phrase that matches no canonical record
becomes an unresolved reference recorded as a gap, never a new offer.

A goal whose objective, metric and target value cannot all be determined is
**invalid**, not incomplete: there is no measurable outcome to store.

### Deterministic parsing behind a replaceable interface

Natural-language structuring sits behind the `GoalParser` interface:

```
natural-language input → GoalParser → GoalDraft → validation → RevenueGoal
```

`parse(input, context, now)` is a pure function of the input, the canonical
Business Brain snapshot and the reference instant. `DeterministicGoalParser`
implements it with pattern matching and records which pattern matched in the
field's note. Identical inputs always produce identical output, which makes
goals auditable, reproducible and testable.

Phase 3 adds **no LLM dependency**. An LLM parser, when it arrives, is an
alternative implementation of the same interface — the domain is never wired
to a specific model provider.

### Business Brain references

A goal stores `offerId`, `icpId` and `buyerPersonaIds` — canonical ids, never
copies. They are validated against the workspace-scoped context before the goal
is stored or updated, so a workspace-A goal can never point at a workspace-B
offer, ICP or persona. The agent-facing `BusinessContext` from ADR 0003
deliberately omits record ids, so the API resolves the tenant-scoped ids
through the store after authorizing.

### Lifecycle

```
draft ──→ active ──→ completed ──→ archived
  │         ↕ ↘         ↗
  │      paused       archived
  └────────→ archived
```

`archived` is terminal. A goal cannot jump from `draft` to `completed`, because
that would skip the phase in which the workflow runs. Transitions are validated
server-side against the **stored** status: a client can request a new status but
can never assert the current one, and `status` is stripped from the generic
field-update route so it cannot be mutated as a side effect. An illegal
transition is a `CONFLICT`, not a validation error.

Every creation, edit and transition appends an event
(`created` / `updated` / `status_changed`) to `revenue_goal_events`, which is
the roadmap's goal history.

### Metrics and approval policy

`successMetrics` is a list of `{ kind, target, unit }` where `kind` is a closed
enum (`revenue`, `pipeline`, `qualified_opportunity`, `meeting`, `customer`,
`conversion_rate`, `time_to_target`). Not every goal has every metric, so the
list is optional in shape but never empty in practice: when a goal states no
explicit metrics, the headline `targetMetric`/`targetValue` pair becomes the
first criterion. That is a restatement of what the caller already said, not an
invention. Recording actual performance against these criteria is a later
phase's job.

Each goal carries the approval context later workflows must honour
(`maxRiskLevel`, `externalActionsRequireApproval`, optional `approverUserId`),
defaulting to a Level 2 ceiling with external actions requiring approval. A
goal can define policy context but **cannot execute** anything: Phase 3 defines
and validates goals only.

### Schema and migration

Two new tables follow the established conventions (`id`, `created_at`,
`updated_at`, `deleted_at`, `workspace_id`):

| Table                   | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `revenue_goals`         | the goal, with `CHECK (target_value > 0)` and a closed status `CHECK` |
| `revenue_goal_events`   | append-only audit history (`kind`, `from_status`, `to_status`, `actor_user_id`) |

`migrateState()` step 3 adds both as empty arrays and is gated on
`version >= 3`, so Phase 1 and Phase 2 documents load unchanged
(`LATEST_SCHEMA_VERSION = 3`). Existing rows, ids and timestamps are preserved
and re-running the migration is idempotent.

### Authorization

Every service method calls `guard(workspaceId, userId)` first; the `userId`
always comes from `resolveSession(token)` in the API layer, never from a
request body. Repository methods re-check authorization internally as defence
in depth. API handlers authorize the workspace before reading the Brain
context, so a cross-tenant caller receives `UNAUTHORIZED` rather than a
misleading internal error.

### Error safety

Storage codes are translated into a closed domain vocabulary (`NOT_FOUND`,
`CONFLICT`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `INVALID_TRANSITION`,
`UNAVAILABLE`). `UNAVAILABLE` becomes a generic `SERVER_ERROR` /
`"unexpected failure"` at the API edge; `INVALID_TRANSITION` becomes
`CONFLICT`. No internal storage message reaches a client.

## Alternatives considered

- **One JSON `details` column on the goal:** rejected — it would make the goal
  unqueryable and unvalidatable field-by-field, and Phase 4 could not reason
  about economics or constraints.
- **Copying offer/ICP data into the goal:** rejected — it duplicates the
  canonical Business Brain and lets the two drift.
- **An LLM to structure the goal immediately:** rejected for Phase 3 — it makes
  goal creation non-deterministic and unverifiable, and would introduce a model
  dependency before the domain can constrain one. The `GoalParser` interface
  exists so an LLM can be added later without touching the domain.
- **Rejecting goals with any missing field:** rejected — that would make an
  incomplete-but-honest goal impossible to record, pushing users to invent
  values. Incompleteness is data, not corruption.
- **Deriving a time window from the current date inside the service:** rejected —
  it would make stored goals non-reproducible. The reference instant is an
  explicit parameter.
- **Exposing a generic `status` setter on the update route:** rejected — status
  has its own transition-validated route.

## Consequences

- Phase 3's gate is provable in CI: `tests/phase3-gate.test.ts` runs
  authentication → workspace → Business Brain → natural-language goal →
  structured goal → validation → reference validation → persistence → reload →
  status/metrics → workspace authorization, and asserts that an incomplete goal
  records gaps instead of inventing facts.
- The Phase 1 and Phase 2 gates remain green; the Phase 3 schema change is
  additive and covered by v2→v3 migration and idempotency tests.
- Phase 4 can consume a `RevenueGoal` and compile a `RevenuePlan` from it
  without reaching into storage or re-deriving business context.
- Determinism is a maintained property: adding a non-deterministic parser would
  be a breaking change to the guarantee, and the interface exists to make that
  trade-off explicit.
- `Store` remains a single-process JSON document with no concurrency safety,
  and sessions remain in-memory. Both are inherited from ADR 0002 and remain
  pre-production work.