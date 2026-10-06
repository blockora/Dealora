# ADR 0022 — Experiment Engine: a comparison that can only be read, never claimed

- Status: Accepted
- Date: 2026-10-06
- Phase: ROADMAP.md Phase 22 (Experiment Engine)

## Context

`ROADMAP.md` §29 asks the repository to "support controlled experiments" and
gives one example:

> **Experiment:** Message A vs Message B
>
> **Metric:** Positive Reply Rate
>
> **Population:** Qualified SaaS founders
>
> **Duration:** 14 days
>
> **Track:**
>
> - sample size
> - conversion
> - confidence
> - cost
> - revenue impact
>
> **Do not claim a winning experiment when evidence is insufficient.**

The example is one paragraph long, so almost everything that decides whether
this phase is honest is unspecified: how large a sample must be, how wide a
lead must be, what "positive" means, who belongs to the population, and what
happens when a workspace cancels a comparison halfway through. §29 gives no
numbers. `DEALORA_BLUEPRINT.md` §27 names experiments as part of the learning
loop but does not decide them either.

Phases 10–16 already run the loop the experiment wants to measure: a human
approval, a provider-confirmed send, a deterministic reply classification, a
meeting on a calendar, a recorded cost fact. Phase 21 derived what *worked*;
§29 asks which of two messages works *better* — a comparative question, and the
first question in the repository whose answer tempts a caller to treat noise
as a decision.

That leaves the central tension of this phase. A winning experiment is the
single most actionable claim DEALORA can produce — "send B" — and the entire
phase exists under a rule that forbids the cheapest way to produce it: running
the arithmetic and reading the sign. So the question this ADR answers is not
*how do we compare two messages* but:

> **How do we make "winner" a verdict the evidence forces, and nothing a
> caller, a threshold mood or a stale row can assert?**

Four decisions follow from that, and they shape everything else here.

## Decision

### 1. The declaration is stored; the answer is derived — every time

The package boundary is `@dealora/experiment`, and it is split along the same
declared/derived line as the cost engine before it. Storage holds exactly
three things: the **declaration** (which immutable drafts are compared, on
which metric, over how many days, in which lifecycle state), the **arms**
(two to four pinned `(position, draftId, label)` triples), and the
**append-only lifecycle trail** (`created`, `started`, `closed`,
`cancelled`).

Nothing else is stored. There is no column for a sample size, a rate, a
confidence, a total, a conversion or a winner — asserted against the DDL —
because every one of those numbers is recomputed on every read from rows
Phases 10–13 already wrote. A reply that arrives after a read changes the next
read instead of leaving a stale `insufficient_evidence` behind, and a winner
exists only inside an answer, never inside a row. `deriveComparison` is a pure
function of stored rows: no clock, no randomness, no model, no network, and
byte-identical output for identical input.

The honest consequence is that closing an experiment freezes the *window*
(see below), not the *answer* — a late-arriving reply inside the window still
counts after the close, because the window is the declared start plus the
declared duration capped by the close instant, and evidence inside the window
is the experiment's data regardless of when the read happens.

### 2. The critical rule is published as numbers, enforced as arithmetic

§29's critical rule — *do not claim a winning experiment when evidence is
insufficient* — is unenforceable as a mood, so the phase publishes the two
product judgements that make it decidable, the same way Phase 19 published its
latency ceiling rather than pretending the roadmap had chosen one:

- **`EXPERIMENT_MIN_SAMPLE_PER_ARM = 30`** — each compared arm needs at least
  thirty distinct exposed contacts before its rate is read at all.
- **`EXPERIMENT_MIN_LIFT_BASIS_POINTS = 200`** — the leader must lead the
  runner-up by at least two percentage points before it is called a winner.

Below the minimum sample the decision is `insufficient_evidence` — never a
winner, never a loser, and with the reason naming what is missing. Inside the
minimum lift it is `no_material_difference` — real data that is not a
decision. An **exact tie** is `no_material_difference` by definition, not a
coin flip. And a **cancelled** experiment can never crown anything, by the
first branch of the derivation, because a comparison its own workspace
withdrew must not acquire a verdict it never had.

The arithmetic is exact, in the same style as Phases 16 and 19: rates are
integer basis points (a floored quotient with the remainder in ten-thousandths
reported beside it, so `0/0` is `null` rather than a fabricated zero), and the
comparison between two arms is decided by **cross-multiplication**, never by
float division, so "exactly at the lift" is a decidable fact. Arm **position**
is the tiebreak; no p-value is computed anywhere in the package, and the
confidence band (`insufficient | low | medium | high`) describes how much data
the comparison rests on — it is not a probability and never presented as one.

All of it is published as data in one rule table (`experiment-1.0.0`), which
the policy route returns verbatim alongside the population, conversion, cost
and revenue-impact definitions — so a threshold cannot be advertised without
being enforced, and a workspace can read the bar before running the
experiment.

### 3. Every tracked dimension is read from the phase that owns it

§29's five tracked dimensions are each somebody else's fact, read through that
phase's own boundary:

- **Sample size** is distinct **exposed** contacts: an exposure is a Phase 11
  outbound action whose status is `sent` with a `sentAt` inside the window.
  Nothing stages, schedules or assigns anyone — exposure comes from a sent,
  human-approved message, so every subject was chosen by the workspace.
- **Conversion** is Phase 12's own classification: a contact is converted when
  any in-window reply of theirs was classified `positive_intent` or
  `interested` — **Phase 13's** `MEETABLE_INTENTS` imported, not re-declared,
  so "positive" means the same thing in an experiment as it does in a meeting
  recommendation, and the two cannot drift.
- **Confidence** is the band the published multipliers produce
  (`medium` at 3× the minimum sample, `high` at 10×).
- **Cost** is Phase 16's own `deriveBreakdown` over the `outbound_send`
  `cost_events` of the arm's in-window actions — no second cost table, no
  second total, and a zero is a fact rather than an estimate.
- **Revenue impact** is **refused**. No phase through 22 records realized
  revenue, so `revenue_per_arm` is refused by name with **Phase 23** as its
  owner (the cost engine's move), `revenueImpactMinor` is `null` — never `0`,
  which would read as measured — with a reason string beside it, and the
  revenue-adjacent outcome this system actually records is reported instead:
  meetings from the arm's sends that reached a calendar (`booked` or `held`).

The **population** is the accounts whose **newest** qualification — highest
version, versions never reused — is `qualified`: exactly Phase 15's opportunity
rule and Phase 16's denominator rule, so "qualified" means one thing across
every phase and is re-derived on every read, so a contested downgrade removes
the account from the very next comparison. Exposure runs over live
non-archived contacts at population accounts.

One contamination rule sits above all of it: a contact reached by **two arms**
inside the window is excluded from **both**, with the count disclosed in
`excludedCrossArmContacts` rather than silently averaged — a controlled
experiment whose arms overlap is not controlled, and averaging contamination
in would be quieter and wrong.

### 4. The lifecycle is small, CHECK-constrained and immune to its caller

An experiment walks `draft → running → closed`, with `cancelled` reachable
from anything not yet closed. Storage refuses to start with fewer than two
arms, refuses a second start, refuses closing or cancelling before a start,
refuses a terminal reopen, and freezes the arms at start — after that, an arm
cannot be added to a running comparison, because changing the arms mid-flight
would change what the earlier sends meant. Every write records **who** and
**when** from the session and the store's own clock; the request bodies carry
no `status`, no timestamp, no identity, no position and no metric reading, and
the gate sends every one of those forged and asserts the stored row ignores
them.

The `draftId` on an arm deliberately carries **no foreign key**: the arm pins
the draft version the comparison was declared against, and that comparison is
history — a draft the workspace later archives must not cascade away an
experiment's meaning. `UNIQUE(experiment, position)` and
`UNIQUE(experiment, draftId)` make two arms pointing at one message, and two
arms wearing one position, unrepresentable. Schema v19 adds the three tables
with workspace and user foreign keys `ON DELETE CASCADE`, the status,
metric-kind and event-kind vocabularies as `CHECK` constraints, non-positive
names/labels/durations refused, and **status↔timestamp agreement pairs** — a
`running` row must have `startedBy`/`startedAt` and null closing fields, a
`closed` row must have both close fields, and a `draft` row must have none of
them — so a row whose lifecycle fields disagree with its status cannot be
written at all.

### The API

Nine workspace-scoped, session-authenticated routes: declare an experiment,
read one complete (declaration, arms, trail and derived comparison), list a
workspace's experiments, pin an arm, start, close, cancel, read the trail, and
read the published policy. Reads derive; writes transition. There is no update
route (the declaration is not editable after creation — regenerate a
comparison by declaring a new experiment), no delete, and no route that
accepts a metric reading, because none exists to accept: nothing here writes
an outcome, only a declaration and its lifecycle.

## Consequences

- **A winner is derived or it does not exist.** No request can supply one, no
  row can hold one, and the derivation refuses to produce one below the
  published sample, inside the published lift, or after a cancellation. §29's
  critical rule is a shape of the data, not a reviewer's discipline.
- **The experiment measures the loop and cannot drive it.** The package
  exports no sender, no approver, no scheduler, no assigner and no network
  client; the strongest thing a caller can do with a `winner` is read it and
  then prefer that draft in the next Phase 10 approval they happen to grant.
  The gate proves the boundary by snapshotting every table: reading and
  closing an experiment writes nothing beyond the lifecycle event a close is.
- **Nothing goes stale.** Because every number is derived, a qualification
  that moves, a reply that arrives or a cost fact recorded late changes the
  next read instead of contradicting a stored one — the same property Phases
  15, 16 and 17 bought by deriving, bought again for the comparison.
- **The thresholds are honest product judgements, and they are published.**
  30 and 200 bp are not statistics; they are the bar this product has chosen,
  stated in the policy route so nobody mistakes them for facts §29 supplied.
  Changing them bumps `EXPERIMENT_RULE_VERSION` in the same commit.
- **The negative space is the design.** No automatic assignment, no monetary
  revenue figure, no clock inside a derivation, no client-chosen arm, no
  cross-arm averaging, no second definition of "positive", "qualified" or
  "cost" — every one of these is a refusal named in `EXPERIMENT_NEVER_DO` and
  returned by the policy route, so the boundary is readable without reading a
  derivation.
- **The honest limitation:** every conversion this phase counts is Phase 12's
  reading of a reply, and every cost figure is a Phase 16 fact someone
  recorded; the experiment is exactly as real as the loop it measures. And
  the population tracks *accounts*, per the shared qualification rule, even
  where their contact records have been archived — an experiment's
  population is the workspace's qualified book of business, not its live
  address book.
