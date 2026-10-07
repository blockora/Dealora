# ADR 0021 — Optimization Engine: answers only from rows the loop already wrote

- Status: Accepted
- Date: 2026-10-06
- Phase: ROADMAP.md Phase 21 (Optimization Engine)

## Context

`ROADMAP.md` §28 is one short block:

> After sufficient real workflow data exists, implement optimization.
>
> Compare:
>
> - audiences
> - messages
> - signals
> - channels
> - timing
> - qualification rules
> - follow-up sequences
> - offers
>
> The system should answer:
>
> What worked?
> What failed?
> Where is conversion dropping?
> What should be tested?
> What is the likely impact?
>
> Optimization must be:
>
> - measurable
> - reversible
> - auditable

By Phase 20 the repository has the "sufficient real workflow data" §28
asks for: goals, plans, accounts, research, evidence, qualifications,
drafts, approvals, sends, replies, meetings, cost facts, agent governance
and traces — every one of them stored, workspace-scoped and auditable.

What it does not have is anything §28 leaves unspecified: no definition of
an "answer", no statistical engine, no model, and — deliberately — no
capability that could act on one. Optimization is also the most
speculative temptation in the roadmap so far: it invites invented
percentages, confident claims from tiny samples, and advice that quietly
hardens into an instruction. A phase that answered "what worked?" by
asserting a number no stored row supports would spend the honesty every
earlier phase bought.

So the question this ADR answers is not *how do we optimize* but:

> **How do we answer §28's five questions without inventing a single fact
> the loop did not produce, and without turning advice into action?**

Four decisions follow from that, and they shape everything else here.

## Decision

### 1. Eighteen declared facets over §28's eight dimensions; every number is a read

The package boundary is `@dealora/optimization`, and the comparison
surface is declared once in `rules.ts` as data: `OPTIMIZATION_ASPECTS`
pins **eighteen facets** (`OPT-01`…`OPT-18`), each assigned to one of
§28's eight dimensions — audiences, messages, signals, channels, timing,
qualification rules, follow-up sequences, offers — with a name and the
question it exists to answer, and `OPTIMIZATION_RULE_VERSION`
(`optimization-1.0.0`) rides on every result. The eight dimensions and
the five answers (`worked`, `failed`, `dropping`, `test`, `impact`) are
published from the same file, so a facet no branch can produce is
impossible to advertise.

Nothing is computed from nothing: a facet reads the workspace's existing
rows through `OptimizationRepository` — `authorize` plus fourteen
`list*` methods, every one taking `(workspaceId, userId)` — and every
observation it emits is a measurement of those rows (a count, a ratio of
stored states, a cadence between stored timestamps), with the counts
behind it restated beside it as `evidence` and each source row named by
its id in the facet's `sources`. Where the data cannot support a claim,
the facet reports what it actually has or stays empty; confidence is a
two-value **band** (`high` | `low`), the same weakest-band convention
ADR 0009 and ADR 0014 established — §28 supplies no calibration data
from which a percentage could mean anything.

### 2. Read-only by construction: no table, no migration, no route, no action surface

`deriveOptimization` returns an `OptimizationResult` and writes nothing.
The package exports no runner, no dispatcher, no sender, no scheduler, no
approver, no evaluator, no cost writer, no model client and no network
client: its entire import surface is `@dealora/db` **types** plus its own
rules, and the service factory's only gate before deriving is
`repo.authorize(workspaceId, userId)`. The phase therefore adds **no
table, no migration and no route** — the schema stays at v18.

This is the phase's reading of "reversible": §28 requires optimization to
be reversible, and the most reversible analysis is one that changes no
state at all — it can be discarded by not reading it. It also continues
Phase 20's negative space: an observation is advice, and the strongest
thing a caller can do with a headline is read it (and perhaps declare a
Phase 22 experiment from the `test` question it surfaced).

### 3. Determinism and auditability are properties of the derivation

§28's other two adjectives are enforced structurally:

- **Deterministic.** Given the same read surface, two calls produce
  byte-identical results: no clock, no randomness, no model, no network,
  and every ordering a total one — observations sort by confidence then
  value descending, headlines by the declared answer rank, and the
  deduplicating set operations run over facets in their declared order.
  Nothing consults storage row order.
- **Auditable.** Every result carries an `audit` tuple: the rule version,
  the facet and dimension counts, and a count of every surface read —
  sources, accounts, contacts, offers, drafts, outbound actions, events,
  classifications, meetings, qualifications, findings, costs and trace
  runs. A reader can check that the analysis saw exactly the workspace
  the caller asked for, and each observation repeats the counts that
  produced it in `evidence`.

### 4. The five answers are synthesis over facets, and `test` hands off to Phase 22

The five §28 questions are answered as `headlines` — one defensible pick
per answer kind, in §28's own order — synthesized from facets that
actually qualify (a `worked` headline needs an observation trending up,
`failed` and `dropping` one trending down, `test` a candidate question,
`impact` a hypothesis), each carrying the evidence behind the pick.
`learnings`, `questions` and `hypotheses` aggregate across all eighteen
facets without duplication.

The handoff is deliberate: every `question` carries a `candidateTest`,
which is exactly the input §29's Experiment Engine consumes. Phase 21
ranks *what is worth testing*; Phase 22 — not this phase — runs the
controlled comparison and decides whether evidence is sufficient. Nothing
here claims an impact: a `hypothesis` states its expected impact and its
basis, and the facet-level band says how much data it rests on.

## Consequences

- **Every answer traces to stored rows.** Measurable means measured from
  what the loop recorded; a facet with no data reports no data rather
  than a guess, and §28's five questions are answered or left honestly
  unanswered.
- **The analysis is disposable.** No table, no migration, no route and no
  writes: reversibility is bought by construction, and the gate proves it
  by snapshotting row counts around a full analysis — only the workspace
  seeded is reflected, and no draft, approval, outbound action, meeting,
  evaluation or cost row moves.
- **Determinism is checked, not claimed.** The gate runs the derivation
  twice over the same store and asserts byte-identical output, asserts
  workspace isolation (a foreign workspace's rows never appear), asserts
  the authorization refusal before any derivation happens, and asserts
  the analysis does not depend on Phase 20's trace table for its
  existence.
- **Optimization cannot drive the loop.** The package exports nothing that
  executes; a "what worked" headline reaches a human, and any action it
  inspires still walks Phase 10's approval and Phase 11's own
  re-derivation.
- **The honest limitation:** every facet reads what earlier phases chose
  to store, so the analysis is exactly as good as the loop's data; counts
  are not rates unless a facet derives one, nothing here is a statistical
  test, and with no route the phase's consumers today are its gate
  (`tests/phase21-gate.test.ts`), the Phases 9–22 integration journey,
  and whatever later phase wires the domain service into a surface.
