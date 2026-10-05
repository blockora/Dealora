# ADR 0020 — Agent Trace & Observability: a run that cannot lie about what it did

- Status: Accepted
- Date: 2026-10-27
- Phase: ROADMAP.md Phase 20 (Agent Trace & Observability)

## Context

`ROADMAP.md` §27 is short and has three parts:

> Every production workflow should expose:
> Agent ↓ Decision ↓ Tool Call ↓ Evidence ↓ Result ↓ Approval ↓ External Action
>
> Track:
>
> - execution time
> - model usage
> - token usage
> - tool calls
> - errors
> - retries
> - approvals
> - external actions
> - cost
>
> **Critical rule.** Never silently pretend an action succeeded.

`DEALORA_BLUEPRINT.md` §32 wants every production run traceable so that
*"users should be able to inspect why an action happened"*; §69 lists agent
traces, tool calls, execution time, token usage, cost, errors, retries,
approvals and external actions as observability that is *"essential for
debugging and enterprise trust"*; §70 adds that a tool failure leads to a
retry, then an alternative tool, then graceful degradation, then human
escalation, and that *"Never silently pretend a failed action succeeded."*
§59 lists `Execution` as a core entity and §33 owns cost.

Phase 19 closed having said all of this explicitly: **no agent runner exists,
no dispatcher, no model client, no tool execution** — and *"Phase 20 owns run
traces."*

That leaves the central tension of this phase. §27 asks for a trace of a run,
but there is no run. A phase that answered this by building a runner, a
dispatcher, a model client or a tool invoker would have shipped Phase 21's
work three phases early and turned an observability requirement into an
execution capability. So the question this ADR answers is not *how do we run
an agent* but:

> **How do we make a record of work that can be trusted, when this repository
> still performs none of that work?**

Four decisions follow from that, and they shape everything else here.

## Decision

### 1. A trace records what a recorder reported; it performs nothing

The package boundary is `@dealora/trace`, and it exports **no executor of any
kind**: no runner, no dispatcher, no loop, no scheduler, no queue, no worker,
no tool invoker, no model client and no network client. A `tool_call` step is a
record that a capability somebody else owns *was reported as invoked*. The tool
it may cite is read from `@dealora/agent`'s declared `AGENT_TOOLS` rather than
restated, so a trace cannot cite a capability no agent declaration grants — but
naming one still calls nothing, and the phase that owns the tool still runs its
own authorization when that tool is really used.

This is published, not merely intended. `TRACE_NEVER_DOES` states it in eleven
sentences and the policy route returns them, so a reader can check the negative
space without reading a derivation. The gate additionally proves it by
snapshotting every table: recording a seven-step chain including a tool call,
an approval and an external action adds exactly one run row and its step rows,
and moves **no** draft, approval, outbound action, meeting, evidence,
qualification or evaluation row.

The honest consequence is that a trace in this repository is, today, a record
of work done by something *outside* it. That is exactly what Phase 19's
operator-driven evaluation already needed, and it is the seam a future
executor will record through: a real agent runner will call these same routes
and their steps, and every structural guarantee here applies unchanged.

### 2. The critical rule is the shape of the types, not a convention

`ROADMAP.md` §27's one critical rule is the whole reason this phase exists, so
it is enforced structurally rather than by discipline:

- **`TraceRunStatus` has five members and no request can supply one.** The
  close route carries a run id and **does not read its body at all**. There is
  no `status`, no `succeeded` flag and no completion timestamp on the wire.
- **The status is derived in storage** from the outcomes the run's own steps
  carry: any `failed` → `failed`; else any `unknown` → `unknown`; else any
  `succeeded` → `succeeded`; else → `unverified`.
- **`unverified` is load-bearing.** Closing a run that recorded no outcome at
  all yields `unverified`, so an empty trace structurally cannot produce a
  success. Without that fifth value, "close it and see what happens" would be a
  way to assert `succeeded` for a run in which nothing was ever recorded.
- **`unknown` is a first-class outcome.** A provider that never answered has
  not failed — it has left the question open — and reporting that as either
  success or failure is precisely the dishonesty §27 and §70 forbid. §70's
  chain (failure → retry → alternative tool → degradation → escalation) is
  representable because each of those is a **separate step with its own
  outcome**, not a flag flipped on the first one.

The rule is duplicated on purpose. Storage derives the status when it writes the
row, and the domain re-derives it on every read. **A closed run whose stored
status and re-derived status disagree is refused with `UNAVAILABLE`** rather
than printed, because a reader shown a verdict its own evidence contradicts has
been handed a lie. (An `open` run is not cross-checked; its `derivedStatus`
reports what closing it *now* would produce, which is informative and is not a
claim about a run nobody has closed.)

### 3. Ordering is server-derived, because `recordedAt` cannot order a trace

Two steps recorded in the same millisecond are ordinary, not exceptional, so a
timestamp-only order is ambiguous between them and the ambiguity is exactly
where an audit trail matters most. Two counters are therefore allocated **in
storage** and are never accepted from a caller:

- **`sequence`** — monotonic within a run, `UNIQUE(run_id, sequence)`. It is
  the trail's only sort key; nothing orders by `recordedAt` or by id.
- **`attempt`** — the count of steps already recorded for a `stepId`, plus one.
  `UNIQUE(run_id, step_id, attempt)`.

Replay and retry are then distinguished honestly, and both are real:

- re-sending the **identical** latest attempt returns the original row, so a
  retried network call does not double-count;
- sending **different content for the same `stepId`** becomes the *next*
  attempt. Refusing it would have refused the very behaviour §27 asks to be
  traced — §27 tracks *retries*, and a retry is by definition a second attempt
  at the same step.

A run listing is ordered by `(agentId, id)`, both stable, so the same stored
rows always print the same JSON. Nothing in a derivation consults a clock, a
randomness source, object key order or storage row order.

`slowestStepMs` is a **maximum**, never a sum or an average: steps within one
run may overlap, and summing them would invent a duration the run never had.

### 4. Cost is Phase 16's, and a trace is not Phase 19's evidence

§27 requires cost, so a run is attributed cost through Phase 16's existing
immutable `cost_events` rows under **one new execution kind, `agent_run`**.
There is no second cost table and no second total: the figure comes from
`@dealora/cost`'s published `deriveBreakdown`, and it is `null` — never `0`,
which would read as "this run was free" — when no fact exists.

Phase 19's boundary is untouched. A trace **writes no evaluation judgement**:
Phase 19 owns judgements, a trace is not evidence, and a run is never converted
into one. The relationship is preserved rather than collapsed — a trace is
something a future phase may *cross-check* an operator's judgement against,
which is the seam ADR 0019 named, but Phase 20 does not perform that
cross-check and does not claim to.

### Provenance, version pinning and the production gate

A run stores the **exact agent version** it traces, read from Phase 18's
registry at the moment the run opens — never from the request — so a later
version cannot rewrite what a historical trace means. A body containing
`version`, `status`, `workspaceId`, `actorUserId`, `openedAt`, `sequence`,
`attempt` or `recordedAt` is ignored in full, and the gate asserts this by
sending all of them forged and checking the stored row.

A run may be opened **only** for an agent this workspace has actually put in
`production`, and that state is re-read live from the registry rather than
supplied. This is Phase 19's gate, unchanged and not bypassed: `draft` and
`approved` both refuse, the refusal names the state the registry holds and
cites the phase that owns reaching `production`, and nothing is written. §27
scopes traces to *production* workflows, and this repository is honest about
what that means — the runs being traced today are external to it.

### The persistence model (schema v18)

Two new tables, an additive migration, and nothing rewritten:

- **`agent_trace_runs`** — workspace FK, the pinned agent id and version, the
  derived status, and server-derived `openedBy`/`openedAt`/`closedBy`/
  `closedAt`.
- **`agent_trace_events`** — workspace FK, run FK (`ON DELETE CASCADE`), the
  two counters, the stage and outcome, and the optional facts (detail, tool,
  reference, error code, duration, model provider/name, token counts).

`CHECK` constraints make the invariants unwriteable rather than merely
discouraged: the stage and outcome vocabularies, `sequence > 0`, `attempt > 0`,
a non-empty `stepId`, a pinned semver version, non-negative durations and token
counts, `model_name` null unless tokens are present, a `tool` only on a
`tool_call`, an `error_code` only on a `failed` step, and an open run agreeing
with its null closing fields while a closed run has both. The vocabularies are
duplicated in the db layer with the same rationale as Phases 18 and 19: storage
must not trust a caller, and a `CHECK` cannot import from another package.

### The API

Seven workspace-scoped, session-authenticated routes: open a run, record a
step, close a run, read one trace, list one run's steps, list a workspace's
runs (optionally narrowed to one agent), and read the published policy. There
is no update or delete route, because runs and steps are append-only; there is
no generic "write anything" surface, and no repository object is exposed. A
closed run accepts no further step and re-closing does not rewrite the verdict
it already reached. Errors map exhaustively; `UNAVAILABLE` becomes a generic
`SERVER_ERROR` that leaks no internals.

## Consequences

- **A trace cannot make a run look successful, and cannot make an agent run.**
  Both halves of §27 are structural: the status is derived and unreachable from
  a request, and the package exports nothing that executes.
- **A real executor can be added later without touching this design.** The
  recording boundary is deliberately usable by one: it validates what a
  recorder reports, allocates the ordering, derives the verdict and attributes
  cost — and does none of the work. Phase 21 owns optimization and is not
  started here; an agent *runner* is not Phase 21 either, and this phase does
  not presume to know which later phase owns it.
- **Traces are readable while an operator's judgement is still the only input
  to evaluation.** A failed step is visible next to a `met` verdict, which is
  the cross-check ADR 0019 predicted and did not perform.
- **Retries are visible as attempts, not as edits.** A run that failed and then
  worked reads as `failed` with `retryCount: 1`, because the failure is still
  what happened. Overwriting it would be the dishonesty §27 forbids.
- **The registry still grants no capability.** `usableStates` stays `[]` and
  `usable` stays `false` for an agent in `production`. Phase 20 opens the
  ability to *trace* production runs; it opens no ability to produce one.
- **The honest limitation:** every trace in this repository today records work
  performed outside it. The trace's own assertions are about the recording, and
  the cost of a run is only as real as the Phase 16 fact someone recorded
  against it. A future phase that owns execution must write the steps; this one
  only makes the writing checkable.