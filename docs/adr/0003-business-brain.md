# ADR 0003 — Business Brain: canonical business context

- Status: Accepted
- Date: 2026-10-03
- Phase: ROADMAP.md Phase 2 (Business Brain)

## Context

`DEALORA_BLUEPRINT.md` §9 defines the Business Brain as the canonical context
source for agents, with agents forbidden from inventing capabilities, customer
results, case studies, pricing, or product facts. `ROADMAP.md` §9 requires the
Brain to support company description, offers, pricing, ICP, buyer personas,
differentiators, positioning, brand voice, policies, and approved claims, and
sets the gate: *a user can create and edit Business Brain data, and an agent can
retrieve it as structured context*.

Phase 1 shipped a single `business_profiles` row per workspace. Left alone,
Phase 2 could have added a second "company" table beside it and produced two
competing sources of business truth — the exact failure mode the roadmap
forbids.

Two constraints shaped the design:

1. Every Brain operation is workspace-scoped, and authorization must be resolved
   from the authenticated server-side identity, never from a client-supplied
   workspace id.
2. User-entered text is not evidence. A claim must never become "approved"
   because someone typed it.

## Decision

### Package layout

A new `@dealora/brain` package holds the domain and application service, sitting
between the API and persistence:

```
@dealora/api   →   @dealora/brain   →   @dealora/db
 (transport)        (domain, validation,   (persistence)
                     claim safety, context)
```

The service depends on a `BrainRepository` interface, not on `Store`
concretely, so the domain is decoupled from storage and testable against an
isolated store.

### Single canonical company record

The Phase 1 `business_profiles` table **is** the Brain's company section. No
second company table was added. `getCompany`/`upsertCompany` read and update
that one row; `upsert` semantics mean an edit never creates a competing record.

### Schema

Six new tables, all following the Phase 1 conventions (`id` primary key,
`created_at`/`updated_at`, `deleted_at` tombstone, `workspace_id` tenant
boundary):

| Table            | Cardinality per workspace | Notes                                        |
| ---------------- | ------------------------- | -------------------------------------------- |
| `offers`         | many                      | name, description, target customer, problem, outcome, pricing, delivery, status |
| `icps`           | one (`UNIQUE`)            | industries, company sizes, geographies, business models, characteristics, disqualifiers |
| `personas`       | many                      | title, responsibilities, pain points, goals, buying context |
| `positioning`    | one (`UNIQUE`)            | statement, differentiators, approved value propositions, competitor context |
| `brand_voice`    | one (`UNIQUE`)            | tone, style, terminology, constraints          |
| `claims`         | many                      | text, category, status, source note, approved by/at |

`business_profiles` gained one additive column, `market`. Single-record tables
use a `UNIQUE workspace_id` so the Brain cannot accumulate duplicates.

### Migration

`migrateState()` upgrades a persisted Phase 1 document in place: it adds the six
Brain tables as empty arrays and defaults `business_profiles.market` to `null`.
Existing rows, ids, and timestamps are preserved, and a second migration run is
idempotent. Migrations are additive and version-stamped
(`LATEST_SCHEMA_VERSION = 2`); future changes append a step rather than
rewriting this one.

### Claim safety

Three rules, enforced in both the repository and the service:

1. **A claim cannot be created as `approved`.** Creation defaults to
   `unverified`; even an explicit `status: "approved"` on create is rejected.
2. **Approval is an attributed act.** Only `approveClaim(id, userId)` sets
   `approved`, recording `approvedBy` and `approvedAt`. A generic update cannot
   set `approved`.
3. **Editing approved text revokes approval.** Changing the wording of an
   approved claim returns it to `unverified` and clears the approver, because
   the new text has not been reviewed. Updating only metadata keeps approval.

Statuses are `approved` (may be stated externally), `unverified` (context only,
never presented as fact), and `restricted` (must never be used externally).
Categories (`capability`, `pricing`, `result`, `case_study`, `testimonial`,
`certification`, `partnership`, `guarantee`, `other`) are closed enums.

Pricing carries its own `approved` flag. `getBusinessContext` **withholds**
pricing that has not been approved, so an agent cannot state a price the
business has not cleared.

### Agent-facing interface

`BusinessBrainService.getBusinessContext(workspaceId, userId)` returns a
deterministic `BusinessContext`: company, offers, icp, personas, positioning,
brandVoice, and claims grouped by approval status. It depends only on the
`BrainRepository` interface, so future agents never touch storage. Identical
input yields byte-identical output, asserted by tests.

### Authorization

Every service method calls `guard(workspaceId, userId)` first, which resolves
membership through `store.authorize`. The `userId` always originates from the
resolved session — API handlers read it from `resolveSession(token)` and never
from the request body. Repository methods for Brain entities re-check
authorization internally as defence in depth.

### Validation and error safety

Input is validated at the application boundary with a collector that reports
all field errors at once. Coverage: required and optional strings, length caps,
string lists, enum membership, `http`/`https`-only URLs, non-negative amounts,
currency codes, and inverted price ranges. Storage codes are translated into a
closed domain vocabulary (`VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`,
`CONFLICT`, `UNAVAILABLE`); `UNAVAILABLE` becomes a generic
`SERVER_ERROR`/`unexpected failure` at the API edge so internal messages never
reach a client.

### No LLM

Phase 2 adds no model dependency. The Brain is a deterministic data layer;
agents consume it in later phases.

## Alternatives considered

- **A separate `companies` table for the Brain:** rejected — it would give the
  workspace two competing sources of business truth.
- **One JSON blob per workspace for all Brain data:** rejected as an
  unstructured dumping ground; it cannot express per-section validation,
  uniqueness, or tenant-safe querying.
- **Auto-approving claims on entry:** rejected — that is precisely "treat
  arbitrary user-entered text as verified evidence".
- **Letting an update set `approved`:** rejected — approval would become an
  incidental side effect rather than an attributed decision.
- **Reusing the Phase 1 business-profile fields for offers/positioning:**
  rejected — offers and positioning are multi-valued and need their own
  validated shape.
- **An LLM to structure free-text Brain input:** deferred. Useful later, but it
  would make the canonical context non-deterministic and unverifiable.

## Consequences

- Phase 2's gate is provable in CI: `tests/phase2-gate.test.ts` runs signup →
  authentication → workspace → full Brain → context retrieval → persistence →
  reload, plus cross-tenant denial and single-source-of-truth checks.
- The Phase 1 gate (`tests/phase1-gate.test.ts`) remains green; the Phase 1
  schema change is additive and covered by migration tests.
- Roadmap Brain concepts not implemented here — case studies, testimonials,
  FAQs, objections, competitors as entities, policies, sales playbooks — are
  deliberately absent. They belong to the phase that consumes them, and the
  table conventions above let them be added without redesign.
- `Store` remains a single-process JSON document with no concurrency safety,
  and sessions remain in-memory. Both are inherited from ADR 0002 and are
  pre-production work.