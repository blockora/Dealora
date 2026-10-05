# ADR 0016 — Cost Engine: immutable facts, derived totals, and arithmetic that cannot lose a minor unit

- Status: Accepted
- Date: 2026-10-25
- Phase: ROADMAP.md Phase 16 (Cost Engine)

## Context

`ROADMAP.md` §23 asks Phase 16 to "understand the true economic cost of
automation". Track six categories — **LLM, search, data, tool,
infrastructure, execution** — and derive six metrics — **Cost / Prospect, Cost
/ Qualified Opportunity, Cost / Meeting, Cost / Customer, Revenue / AI Cost,
Revenue / Campaign**. Its gate is one sentence: *a workflow execution can show
estimated or measured cost.*

`DEALORA_BLUEPRINT.md` §33 says "every run should record" the same six
categories and that "cost visibility is required for sustainable SaaS
economics". MVP §56 wants the system to show "what it cost".

Six questions had to be answered before any code was written.

1. **Store facts, or store totals?** Totals could be maintained on every
   write. That design makes every aggregate a second copy of the facts,
   updated by every writer, stale the moment a write path is missed — and it
   invites the "just add it to the stored total" refactor that double counts.
   So only **facts** are stored (`cost_events`, schema v15) and every total,
   average and ratio is **derived on read**. A stale aggregate becomes
   structurally impossible rather than merely unlikely.
2. **Floats, or integers?** Monetary values are whole **minor units**
   (`amountMinor`, cents for USD). `money.ts` is the only place arithmetic
   touches money, and its division uses `BigInt`: near the safe-integer
   boundary `Math.floor(n / d)` can be off by one (a quotient just below an
   integer rounds up to it — `divideMinor(2^53-1, 8)` is the pinned example).
   The floored quotient always ships next to its remainder, so
   `average × denominator + remainder === numerator` reconstructs the exact
   rational value.
3. **Which executions exist?** There is no workflow engine until Phase 24, so
   the closed list is what this repository can actually run: `research_run`,
   `outbound_send`, `meeting_booking`. `workflow` is published in the policy
   as a **refusal naming Phase 24** — reachable vocabulary only, as ADR 0015
   taught.
4. **What if an estimate is later measured?** Naively summing every fact
   double counts the pair. The aggregation rule: within one
   `(execution, category)` pair, **measured facts supersede estimated ones**.
   The estimate is not deleted — it stays in the raw `estimatedMinor` sum and
   is disclosed in `supersededEstimateMinor` — but the combined total counts
   it once, as its measurement. The invariant
   `total = measured + (estimated − superseded)` is asserted directly.
5. **Which currency?** One per workspace, fixed by the first recorded fact;
   a second currency is `INVALID`. No exchange rates, no conversion, no
   mixed-currency total that would need one. The list (`USD/EUR/GBP/JPY`) is
   exactly the goal parser's, so costs and the revenue goal speak one money.
6. **Which metrics can honestly be derived?** Three — Cost / Prospect,
   Cost / Qualified Opportunity, Cost / Meeting — from rows Phases 5 and 13
   already store. The other three need customer rows (Phase 17/23) and
   realized-revenue rows (Phase 17), and `campaign` has no owning phase at
   all. They ship as **refusals with reasons and owning phases**, completing
   the six names §23 lists as a partition, exactly like ADR 0015's node
   kinds.

## Decision

### Facts are append-only rows; every aggregate is derived on read

`packages/db/src/schema.ts` adds `cost_events` (schema **v15**, additive
migration): a workspace foreign key, a `createdBy` foreign key, a closed
`executionKind/category/basis` vocabulary in CHECK constraints,
`amount_minor >= 0` (negatives and refunds are *unrepresentable* — this
phase has no reversal vocabulary, so a negative cost cannot be smuggled in),
a currency CHECK, and `UNIQUE (workspace_id, idempotency_key)`.

`deriveBreakdown` in `packages/cost/src/engine.ts` is a pure function over
the facts: no clock, no randomness, no store. It returns `null` — and the
service reports `UNAVAILABLE` — rather than a number when the input mixes
currencies, contains an amount outside the representable range, or would
overflow the safe integer. No total is better than an imprecise total.
Every response is stamped `ruleVersion = "cost-1.0.0"`.

### Identity and clocks are the server's

The record route reads nine fields from the body — execution, category,
basis, amount, currency, occurred-at, idempotency key, source — and nothing
else. `createdBy` is the session's user, `createdAt` the server's clock, the
workspace the caller was authorized against. The gate posts a body carrying
forged `createdBy`, `createdAt`, `workspaceId`, `totalMinor` and `id` and
asserts the stored row and the derived totals are untouched by all five.

### Idempotency is dedupe by key, not by content

A replayed `idempotencyKey` with an identical payload returns the same row
(no second write); the same key with a different payload is a `CONFLICT`
(the key was already spent — a retry may not quietly restate a cost); a
*different* key with identical content is a new fact, because two equal
amounts are two events and only the caller's key can claim otherwise.
Storage enforces `UNIQUE (workspace, key)`; the service re-checks the same
rules before the write.

### The gate: per-execution summary, split by basis

`GET` execution cost resolves the referenced run **through storage with the
caller's identity** and requires its workspace to be the requesting one — a
foreign or unknown execution id is `NOT_FOUND` either way, so another
tenant's run ids stay undiscoverable. The summary reports `estimatedMinor`,
`measuredMinor`, `supersededEstimateMinor` and the double-count-safe
`totalMinor`, so a run can show estimated **or** measured cost. A real run
with no recorded facts answers zero with `currency: null` — an honest "nothing
recorded", distinct from `no_data` metrics, which never fabricate a zero.

### Metrics divide exactly, or say `no_data`

`cost_per_prospect` divides the effective total by the stored accounts;
`cost_per_qualified_opportunity` by the accounts whose **newest** qualification
is `qualified` (the same rule ADR 0015's opportunity node uses);
`cost_per_meeting` by the stored meetings. Each denominator's definition is
published in the policy route. An empty numerator or denominator yields
`status: "no_data"` with a reason, never a zero that would read as "free".

### One rule table, one partition

`packages/cost/src/rules.ts` declares the categories (with semantics), bases,
execution kinds + the `workflow` refusal, currencies, limits, the
aggregation-rule sentence, the denominator definitions, and
`METRIC_PARTITION` — three derived + three refused = §23's six names,
disjointly. The policy route prints these tables verbatim, so nothing can be
advertised that the validator does not enforce.

## Alternatives considered

**Storing running totals per execution and per workspace.** Rejected. Every
writer would have to update them, a missed path silently corrupts the number,
and the corruption would be invisible because nothing re-derives from facts.
Derived totals make the rows the single source of truth.

**Floating-point amounts with rounding at display time.** Rejected. Binary
fractions cannot represent 0.10, and the task's boundary tests would be
unanswerable. Integer minor units plus `BigInt` division are exact and
testable.

**Summing every fact into one total (estimates + measurements).** Rejected.
An estimate and its measurement are the same cost twice; §23's own
estimated/measured distinction exists precisely so the supersession rule can
apply. The raw sums are still reported in full, so nothing is hidden.

**Converting everything to one currency with an exchange rate.** Rejected.
A rate is a time-varying external fact this phase has no source for; inventing
one would be exactly the fabricated economics the roadmap warns against. One
currency per workspace instead.

**Refund/reversal rows.** Not implemented, deliberately: §23 does not require
them and negative amounts are CHECKed out of existence. When a later phase
needs them they arrive as new vocabulary with their own ADR, not as a minus
sign slipping past `amount_minor >= 0`.

**Publishing `workflow` executions with an empty summary.** Rejected. No
branch can create one until Phase 24; the policy refuses it by name with its
owning phase instead.

**Reporting Cost / Customer, Revenue / AI Cost, Revenue / Campaign as `0` or
`null` values.** Rejected. Missing rows are not zero cost or zero revenue;
the three names ship as refusals with reasons and owning phases
(Phase 17 / 23, Phase 17, and none for `campaign`).

## The boundaries this phase keeps

- **It never edits or deletes a fact.** Append-only rows; the gate
  byte-compares the cost rows across reads, replays and conflicts.
- **It never trusts a client total, attribution or timestamp.** Forged body
  fields are ignored; totals are recomputed from rows on every read.
- **It never mixes currencies** and never performs floating-point arithmetic
  on money.
- **It never schedules, queues or reaches the network.** No provider, no
  billing API, no credential; recording a cost is a local append.
- **It never derives a customer, revenue or campaign metric** — those names
  are refusals with owning phases, part of the published policy.
- **It never writes any table but `cost_events`.** The gate snapshots every
  table count around recording.

## Open requirements

These are **open**, not limitations of this phase:

- Cost / Customer and Revenue / AI Cost arrive with Phases 17 and 23 (rows
  for customers and realized revenue); Revenue / Campaign additionally waits
  on a campaign object that `ROADMAP.md` assigns to no phase yet.
- Workflow executions become costable when the Workflow Engine ships in
  Phase 24; the refusal is already published.
- Live usage/billing feeds that would record `measured` facts automatically
  are integrations like Phase 11's provider seam; this repository ships the
  recording boundary and a sandbox-free local append, no external source.

## Consequences

- The repository can now answer, in one call per execution: *what did this
  run cost, estimated and measured?* — and per workspace: *what did the loop
  cost overall, per prospect, per qualified opportunity, per meeting?*
- Because totals are derived, they cannot go stale and cannot double count:
  the supersession rule is one sentence in the policy and one function in the
  engine, and both are tested against the same rows.
- Money arithmetic is exact at the boundary: the gate pins
  `divideMinor(2^53-1, 8)` and refuses an overflowing total rather than
  rounding it.
- §23's six metrics are answered as a partition — three derived, three
  refused with owning phases — so Phase 17 has an explicit list of what to
  enable rather than a set of silently empty numbers.
