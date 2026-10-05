# ADR 0019 — Agent Evaluation: thirteen measured metrics, and a production gate that reads them

- Status: Accepted
- Date: 2026-10-26
- Phase: ROADMAP.md Phase 19 (Agent Evaluation)

## Context

`ROADMAP.md` §26 is four sentences long:

> **Objective.** Prevent fluent but unreliable agents from entering production.
> **Measure.** task success, accuracy, relevance, hallucination rate,
> tool-call correctness, qualification accuracy, personalization quality,
> response classification accuracy, cost, latency, failure rate, human
> override rate, business outcome.
> **Gate.** Production agents require evaluation evidence.

`DEALORA_BLUEPRINT.md` §31 restates the same list and adds the sentence the
whole phase is built around: *"A model producing fluent text is not enough."*
§30 lists `Evaluation results` as a field every registry entry carries, §29
puts the governance layer around the registry, and §84 principle 16 says
*"Every production agent must be evaluated."*

Phase 18 closed by refusing the `approved → production` transition and naming
**Phase 19** as the phase that would own it. This phase therefore had to decide,
before writing code, six questions the roadmap leaves open.

1. **What is being evaluated — an agent's behaviour, or an agent's declaration?**
   Nothing in this repository runs an agent. `MEETABLE_AGENT_STATES` is empty,
   there is no runner, dispatcher, tool invoker or model client anywhere in
   Phases 0–18, and §27 (Phase 20) — not this phase — owns traces of runs. So
   what can honestly be evaluated is **the record of judgements a person made
   about work that already happened**, and this phase evaluates exactly that.
   The alternative — building an evaluation harness that runs agents — would
   have manufactured the very execution capability the roadmap schedules later
   and in order.

2. **Who produces the evidence?** §31's "a model producing fluent text is not
   enough" rules out a model judging itself. The only judge in the system is a
   person, so a judgement is a person's conclusion about one specific thing the
   agent did, and **the engine does the arithmetic**. That division — human
   judgement, deterministic measurement — is what makes the numbers trustworthy
   and is the reason this phase stores judgements rather than scores.

3. **What counts as evidence?** A **round**: one evaluation run against one
   `(workspace, agent, agentVersion)`. A round pins the version, because
   §25 requires every agent to declare one, and evidence recorded about
   `1.0.0` is not evidence about `1.1.0`. Rounds are numbered, and only the
   highest is live.

4. **What does Phase 19 unlock?** Exactly one transition — `approved →
   production` — and only when **every metric the agent's declaration names**
   is met. That is `AGENT_PROMOTION_RULE`'s own wording, written in Phase 18.

5. **What stays owned by Phase 20+?** Execution traces, token usage, tool-call
   trails, retries and approvals (`ROADMAP.md` §27). This phase writes none of
   them, and its own trail is asserted not to contain any.

6. **What must remain unavailable?** The ability to *make* an agent production
   ready. Passing the gate moves a governance state and nothing else;
   `MEETABLE_AGENT_STATES` stays empty, because a state nobody can run in is
   not a capability.

## Decision

### The four states that must not be collapsed

The design turns on keeping four things apart, which are easy to confuse:

| | What it is | How you get it |
|---|---|---|
| **Declared agent** | A row in Phase 18's rule table | Exists since `ROADMAP.md` §25 |
| **Evaluated agent** | A live round whose every declared metric is met | Recorded judgements + this phase's arithmetic |
| **Production-eligible agent** | `status: "production"` in this workspace's registry | A person moves it, only if evaluated |
| **Executing agent** | An agent that runs | **Does not exist in this repository** |

Only the third changed in this phase, and only conditionally.

### The metric rule table (`packages/evaluation/src/rules.ts`)

All thirteen metrics are published in one versioned table with, for each: the
description, the **kind** of measurement, the **direction**, the **threshold**,
the **minimum sample**, and a one-sentence rationale. Nothing in the table is a
default: there is no configuration path that loosens it, and no metric with too
little evidence is ever scored rather than refused.

Rates are stored and compared as **basis points** — good outcomes per 10,000 —
and compared by integer cross-multiplication, never by dividing a float. `4/5`
is therefore exactly `8000`, it meets an `8000` threshold, and `3/5` is `6000`
and does not, decided the same way on every run with no epsilon. The twelve
thresholds were chosen by this phase, because §26 names the metrics and sets no
numbers, and the ADR says so rather than presenting them as roadmap constants:

| metric | kind | bar | min sample |
| --- | --- | --- | --- |
| task success | rate | at least 8000 bp | 5 |
| accuracy | rate | at least 9500 bp | 5 |
| relevance | rate | at least 9000 bp | 5 |
| hallucination rate | rate | at most 500 bp | 5 |
| tool-call correctness | rate | at least 9500 bp | 5 |
| qualification accuracy | rate | at least 9000 bp | 5 |
| personalization quality | rate | at least 8500 bp | 5 |
| response classification accuracy | rate | at least 9000 bp | 5 |
| cost | spend | at most the agent's declared ceiling | 1 |
| latency | duration | at most 5000 ms | 1 |
| failure rate | rate | at most 1000 bp | 5 |
| human override rate | rate | at most 2500 bp | 5 |
| business outcome | rate | at least 5000 bp | 5 |

Two bars are **not** Phase 19's, and that is the important part:

- **`cost` has no Phase 19 number.** Its ceiling is the agent's own
  `costLimits.maxSpendMinor` and `maxPerExecutionMinor`, read from
  `@dealora/agent`'s declaration table, because §25 already requires every agent
  to declare them and *one number should have one owner*. Both are checked, so
  an agent can sit under its total and still blow a single execution.
- **`latency` has no declared ceiling to read**, so this phase publishes one:
  `LATENCY_CEILING_MS = 5000`, the outer edge of a reply a person is still
  waiting on. The metric is the **slowest** recorded run, not an average,
  because a single run somebody waited on is the one they remember and an
  average would let it disappear.

A rate needs five judgements before it is judged at all; an absolute limit needs
one, because a ceiling is exceeded by a single run. That asymmetry is the rule,
not a per-metric preference.

### The evidence model

Two append-only tables, schema v17, both additive:

- **`agent_evaluation_runs`** — one row per round: `(workspace, agent,
  version, run_number)`, with `created_by`/`created_at` from the server.
  `run_number` is *derived* in storage as one past the highest already recorded,
  so a caller cannot open "round 1" twice or renumber history. `version` is
  copied from the declaration table when the round is opened, never from a
  request.
- **`agent_evaluation_observations`** — one row per judged subject:
  `(run, metric, subject, verdict | amount | duration, note, created_by,
  created_at)`. UNIQUE(workspace, run, metric, subject) means a retried request
  returns the same row rather than adding a second vote, and a reused subject
  with a different judgement is a `CONFLICT`.

Exactly **one** of three row shapes is representable, and the schema `CHECK`s
it: `cost` carries whole minor units, `latency` carries whole milliseconds,
and every other metric carries one of three verdicts — `met`, `unmet`,
`unobserved`. A row cannot carry both a measurement and a verdict, and a row for
`cost` that carried a verdict is unrepresentable in DDL and refused in the store.

**There is deliberately no column for a rate, a threshold comparison, a pass, an
agent status or a computed verdict.** The gate test asserts this against the
DDL. Everything the report prints is derived from these rows on read, so it
cannot go stale and there is nothing a client could submit *as* an outcome.

### The three judgements

`met`, `unmet`, `unobserved` — a deliberately small vocabulary, because the
judgement is a human conclusion about one thing and the arithmetic is the
engine's job. `unobserved` is the honest "this could not be judged", and it
stays **in the denominator**. An unjudgeable subject therefore counts *against*
an agent, never for it: otherwise an evaluator could raise any rate simply by
declining to look, which would make the whole gate a measure of diligence.

### Absence is reported, never filled in

A metric with fewer than `minimumSample` observations is
`insufficient_evidence` with `measured: null`. `null` is not zero and is not any
number a measurement could take: a zero would read as a perfect
`hallucination_rate` and a total failure for `task_success`. An agent nobody has
measured still returns every metric it declares, because a metric that is
silently missing and a metric that is honestly unmeasured are different claims.
The gate reads the **status**, never the value, so an unmeasured metric cannot
quietly pass.

### Staleness without a clock

Nothing in a derivation consults the current time. A fresh round **supersedes**
the previous one, so identical stored rows always produce an identical report —
the same discipline Phase 14's live-answer rule and Phase 18's stable trail
sort used. `created_at` orders the provenance trail but is never a decision
input. This is also why "evidence for the wrong version" is a structural
property rather than a policy: `deriveEvaluationReport` discards any round whose
version is not the declaration's, and the service only ever asks storage for
the declared version.

### The gate

`createProductionGate` returns the `ProductionGateResolver` that
`@dealora/agent` consumes. It is a **function**, not a boolean, asked fresh with
the caller's own workspace, session, agent and the version the registry already
resolved. Its answer is derived from stored rows on every call, and a storage
failure resolves to `satisfied: false` — an outage denies promotion rather than
admitting an unmeasured agent.

In `packages/agent`, `AGENT_REFUSED_TRANSITIONS` was replaced by
`AGENT_GATED_TRANSITIONS`. Ownership of a refusal becoming a *condition* is the
whole change: the edge is still published in `AGENT_TRANSITIONS`, and
`decideTransition` is **fail-closed** — with no gate supplied, which is the case
for any caller not wired to `@dealora/evaluation`, the answer is the Phase 18
refusal verbatim, naming Phase 19. A satisfied gate does not skip the
transition table either, so a gate can never introduce an edge the lifecycle
does not have.

### The API

Five workspace-scoped routes, all authenticated, all authorizing the caller's
own session against the workspace: open a round, record a judgement, read the
report, read the provenance trail, read the published bar.

The write route's body is deliberately small — a metric, a subject, and either
a verdict or a measured quantity. It has no field for a workspace, an actor, a
timestamp, a version, a rate, a total, a threshold, a pass or an agent status,
because none of those is read. The gate test sends all of them forged and
asserts a byte-identical response and unchanged stored attribution.

### The negative space

- **No runner, dispatcher, loop, scheduler or tool invoker.** A judgement
  describes work done elsewhere; recording one performs nothing.
- **No model, provider or network.** Every number comes from stored rows.
- **No trace of a run.** §27 (Phase 20) owns execution traces, token usage and
  tool-call trails. The trail asserts this about its own output.
- **No capability granted.** The gate permits one lifecycle transition;
  `usableStates` stays `[]`.
- **Nothing editable or deletable.** A changed opinion opens a new round, so the
  old evidence stays exactly as recorded and simply stops being current.
- **No cross-workspace, cross-agent or cross-version read.** Every method is
  workspace-scoped in storage *and* in the service, and evidence is keyed by
  `(workspace, agent, version)`.

## Consequences

- `MEETABLE_AGENT_STATES` is still empty and `usable` is still `false` for an
  agent in `production`. Promoting an agent is now **possible** and **still
  useless for execution**, which is the honest state of the product at Phase 19
  and the clearest possible statement that production is a governance decision,
  not a capability.
- `ROADMAP.md` §26's gate is now a real, testable rule rather than a refusal.
  Every way to fail it is covered: no round, insufficient coverage, a failing
  metric, a superseded round, another version's evidence, another workspace's
  evidence, and an unreadable store.
- The thresholds are this phase's opinion, published and versioned
  (`evaluation-1.0.0`) so a later phase can move them deliberately and a stored
  report keeps the version that judged it. Only `cost`'s bar is owned by another
  package, and that is deliberate.
- Evaluation is **operator-driven**, not automatic. That is honest for a product
  with no agent execution, and it is the thing Phase 20 changes: once runs are
  traced, an operator's judgement can be cross-checked against recorded
  executions instead of being the only input.
- The thirteen metrics do not all apply to every agent, and the registry already
  says which apply: each declaration names its own `evaluationMetrics`, and a
  judgement for a metric an agent does not declare is refused rather than
  stored — because the gate would never read it.
- `business_outcome` is held to a deliberately modest `at least 5000 bp`,
  because a revenue outcome has many causes besides the agent and this phase
  refuses to hold any agent to a number it could not control.