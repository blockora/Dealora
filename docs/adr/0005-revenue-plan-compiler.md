# ADR 0005 — Revenue Plan Compiler: proposals with separated provenance

- Status: Accepted
- Date: 2026-10-03
- Phase: ROADMAP.md Phase 4 (Revenue Plan Compiler)

## Context

`DEALORA_BLUEPRINT.md` §8 states that the Goal Engine passes the goal to the
Revenue Plan Compiler, which produces a plan the user reads as *"here is the
plan I propose"*, and that the system asks for approval before activating
consequential workflows. `ROADMAP.md` §11 requires the compiler to identify
missing information, produce explicit assumptions, separate facts from
recommendations, produce measurable KPIs, and explain why a plan was proposed,
with the gate: *a revenue goal can be compiled into an inspectable revenue
plan*.

Phase 3 delivered a `RevenueGoal` that is complete, validated and
workspace-scoped, carrying its own provenance (`explicit` / `inferred` /
`assumption` / `unknown`). Phase 4 must not throw that discipline away: a plan
that reads confidently is useless if a user cannot tell which sentences are
things DEALORA knows and which are things DEALORA proposes.

Three constraints shaped the design:

1. **A plan is a proposal, never an execution.** Compiling must not send,
   schedule, write or contact anything.
2. **Recommendations must never wear the clothes of facts.** A user reading
   "prioritise accounts hiring support engineers" must be able to see that this
   is DEALORA's advice, not a finding about their market.
3. **Determinism.** The same goal, the same Business Brain and the same
   compiler version must yield the same plan, or plans cannot be audited,
   diffed across versions, or tested.

## Decision

### Package layout

A new `@dealora/plan` package, sitting below the API and above the goal domain:

```
@dealora/api   →   @dealora/plan   →   @dealora/goal   →   @dealora/db
 (transport)       (compiler,            (goal domain)      (persistence)
                    validation,
                    lifecycle)
                        ↓
                  @dealora/brain
            (canonical business context)
```

The service depends on three narrow interfaces — `PlanRepository`,
`GoalReader` and `PlanBrainReader` — never on `Store`, and on the
`RevenuePlanCompiler` interface rather than any concrete compiler.

### Structured sections, not a JSON blob

`RevenuePlan` carries an explicit `strategies` object with one typed section
per roadmap concept: `icp`, `buyer`, `sourcing`, `signal`, `qualification`,
`outreach`, `followUp`, `meeting`, `crm`, `measurement`, `optimization`. Each
section has structured fields plus its own classified `statements`. A plan
therefore answers "what do we do about signals?" with a typed list, not an
untyped string a later agent has to parse.

### Every statement is classified

The core safety property. Each statement carries:

```ts
{ kind: "fact" | "inference" | "assumption" | "recommendation" | "unknown";
  text: string;
  basis: "goal" | "brain:icp" | "compiler" | "none" | …;
  references?: string[] }
```

- **fact** — recorded verbatim from the goal or canonical Brain, with the
  record it came from.
- **inference** — derived by combining known facts; the derivation is stated.
- **assumption** — a rule the compiler applied (for example, defaulting to
  email when the goal states no channel), recorded so it can be challenged.
- **recommendation** — what DEALORA proposes. Never a statement of reality.
- **unknown** — not determinable; carries `basis: "none"`, and validation
  *rejects* an unknown that claims a basis.

The plan rolls every section's statements up into `facts`, `inferences`,
`assumptions`, `recommendations` and `unknowns` so a reviewer can read the
whole plan's epistemic status at once. Validation refuses any statement with a
missing or invalid kind: an unclassified statement is precisely the failure
this phase exists to prevent.

Claim safety from ADR 0003 carries forward. The compiler receives **only**
approved claims plus a *count* of the withheld ones, so it cannot quote an
unverified or restricted claim — it can only prove it excluded them.

### Goal preconditions

Compilation runs the full chain before the compiler is invoked:

```
authenticate → authorize workspace → load goal → goal belongs to this workspace
→ goal is not archived → goal is complete → load canonical Brain → compile
→ validate → persist
```

An **incomplete** goal is refused with a structured error listing exactly which
fields are missing (`VALIDATION_ERROR` with per-field details), never completed
by guessing. An **archived** goal is refused as a `CONFLICT`. The goal's
`workspaceId` is re-checked against the authorized workspace even though the
reader already authorized, so authorization never rests on one layer.

### Deterministic compiler behind a replaceable interface

```
RevenueGoal + PlanBrainSnapshot → RevenuePlanCompiler → RevenuePlanDraft
                               → validation → RevenuePlan
```

`DeterministicPlanCompiler` is a pure function of its input: no clock, no
randomness, no network, no model. The reference instant never enters the
compiler, so compiling the same goal twice yields byte-identical strategic
content; only identity, version and timestamps differ. Phase 4 adds **no LLM
dependency** — an LLM compiler, if one is ever added, implements the same
interface and the domain is never wired to a provider.

Plans record a `brainSnapshotDigest` (FNV-1a over a key-sorted canonical
serialization of the Brain snapshot). The plan does not copy the Brain, but a
historical plan must stay interpretable, so it records *which* Brain state
produced it.

### Versioning

Recompiling a goal **inserts a new row**, it never overwrites. `version` is
1-based per goal lineage and never reused; `compilerVersion` and
`createdAt` travel with each version. A plan's *history* is every version
compiled from the same goal, oldest first, so a superseded plan stays fully
inspectable.

### Lifecycle

```
draft → proposed → approved
            ↘         ↘
             archived ←┘   (archived is terminal)
```

Minimal by design. `approved` records that a human accepted the *proposal*; it
does **not** authorize an external action. That separation is enforced in the
type system: `RevenuePlanApproval.approvesExternalActions` is typed as the
literal `false`, and validation rejects any plan that claims otherwise. Status
transitions are validated server-side against the stored status, and an illegal
transition is a `CONFLICT`.

### Zero external execution

The plan *states* its own inertness rather than merely asserting it in a test:
each section that would later act carries an explicit `unknown` — "nothing has
been sent", "no accounts have been sourced", "no signal has been observed",
"no CRM record is created by Phase 4", "no performance data exists yet". The
sourcing strategy names scraping and purchased lead databases as **excluded
sources**, and the approval section states that approving the plan authorizes
no send, CRM write or calendar action.

### Schema and migration

One new table, `revenue_plans`, following the established conventions (`id`,
`workspace_id`, `created_at`, `updated_at`, `deleted_at`), with one typed
column per strategy section plus the provenance roll-ups, a
`CHECK (plan_version > 0)` and a closed `CHECK` on status. The goal reference
carries a foreign key with `ON DELETE CASCADE`.

`migrateState()` step 4 adds the table as an empty array, gated on
`version >= 4` (`LATEST_SCHEMA_VERSION = 4`), so Phase 1–3 documents load
unchanged. Existing goal rows are preserved and re-running the migration is
idempotent — covered by v3→v4 preservation and v4 idempotency tests.

## Alternatives considered

- **One `plan` JSON blob:** rejected — it would make the plan unqueryable and
  force every later agent to parse prose to answer a question.
- **Copying the Business Brain into the plan for reproducibility:** rejected —
  it duplicates the canonical context and lets the two drift. A digest plus
  record references gives traceability without duplication.
- **An LLM compiler now:** rejected — it makes plan generation
  non-deterministic and unverifiable, and would introduce a model dependency
  before the domain can constrain one. The interface exists so it can be added
  later without touching the domain.
- **Compiling incomplete goals and marking the plan incomplete:** rejected —
  the roadmap explicitly requires the compiler to identify missing
  information. Filling gaps with guesses would produce a confident plan built
  on invented strategy.
- **Overwriting a plan on recompile:** rejected — it destroys the audit trail
  that versioning exists to provide.
- **Letting `approved` imply execution approval:** rejected — that conflates
  "I accept this proposal" with "you may contact people", which is the exact
  confusion the Blueprint's risk levels exist to prevent.
- **A second `revenue_plan_events` audit table:** rejected as unnecessary — the
  version lineage already answers "what did the plan say when?", and the
  roadmap asks for a minimal database.

## Consequences

- Phase 4's gate is provable in CI: `tests/phase4-gate.test.ts` runs
  authentication → workspace → Business Brain → complete goal → compiled plan
  → separated provenance → persistence → reload → versioning → workspace
  authorization, and asserts the absence of any execution artifact.
- Phases 1–3 gates remain green; the schema change is additive and covered by
  migration tests.
- Phase 5 can consume a `RevenuePlan` and source real accounts against it
  without re-deriving business context or re-deciding strategy.
- Determinism is a maintained property: a non-deterministic compiler would be a
  breaking change, and the interface exists to make that trade-off explicit.
- The compiler's strategy content is rule-based, so its recommendations are
  generic by construction. That is the honest position at this phase — an
  opinionated compiler would be a tuning problem, not a correctness one.
- `Store` remains a single-process JSON document with no concurrency safety,
  and sessions remain in-memory. Both are inherited from ADR 0002.