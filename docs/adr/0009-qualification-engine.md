# ADR 0009 — Qualification Engine: deterministic, evidence-backed, and never auto-resolved

- Status: Accepted
- Date: 2026-10-03
- Phase: ROADMAP.md Phase 8 (Qualification Engine)

## Context

`ROADMAP.md` §15 asks Phase 8 to *determine whether an account fits the user's
target*. It names five initial scoring dimensions — **ICP Fit, Need Fit, Buying
Signal, Timing, Company Fit** — and shows a worked example:

```
ICP Fit          95
Need Fit         89
Buying Signal    91
Timing            78
Company Fit       94
--------------------
Dealora Score     90
```

Its requirements are short and specific: **every score must have a score, a
reason, evidence and a confidence**; *the score is a decision aid, it is not
certainty*; and the gate is one sentence — *a user can inspect why an account
received a score*.

`DEALORA_BLUEPRINT.md` §12.5 assigns the same five responsibilities to the
Qualification Agent ("evaluate ICP fit, evaluate need, evaluate company fit,
evaluate potential timing, evaluate buying signals, generate an explainable
score") and repeats the same table, adding the same caveat: *the score is a
decision aid, not a claim of certainty*. §32 logs the expected output as
"Qualification Agent scored account 91". §55 lists both *Qualification agent*
and *Scoring* as MVP features, and Milestone B requires an *evidence-backed
score*.

Phases 0–7 delivered everything this phase consumes and were each explicit that
they were not it:

- Phase 2 owns the canonical `Icp` record — industries, company sizes,
  geographies, business models, characteristics and **disqualifiers**, the last
  documented as "explicit exclusions so qualification can reject a fit".
- Phase 4's compiler emits a **signal strategy** whose signal kinds are
  explicitly framed for "the later Qualification Engine", and a **qualification
  policy** section of named criteria.
- Phase 5 owns `Account` records that are *user input, not verified facts*.
- Phase 6 owns attributed `ResearchFinding` observations, explicitly *not*
  evidence.
- Phase 7 owns `AccountClaim` and `Evidence`, and its own documentation states
  that it makes "no qualification decision, computes no score, ranks nothing".

Five questions had to be answered before any code was written.

1. **Is a numeric score required?** Yes. `ROADMAP.md` §15 names "Initial scoring
   dimensions", shows a `Dealora Score`, and `DEALORA_BLUEPRINT.md` §55 lists
   *Scoring* as an MVP feature. This is not an invention to be refused — but the
   worked example's numbers (95/89/91/78/94 → 90) are **not reproducible from
   any stated rule**: the arithmetic mean of those five numbers is 89.4, not 90.
   The example is illustrative of *shape*, not a formula. So the engine defines
   its own formula, states it in full, stores the rule version with every result,
   and treats the roadmap's numbers as an illustration rather than a target to
   reverse-engineer. Inventing a formula that happens to produce 90 from those
   inputs would be exactly the hidden heuristic this phase forbids.
2. **Where do the criteria come from?** From the source-of-truth model, never
   from a heuristic DEALORA wrote. Every criterion reads either the canonical
   `Icp` or the Revenue Plan's own signal taxonomy — never a hardcoded threshold
   such as "more than 100 employees is good".
3. **What happens when the evidence is missing?** It must not become a pass, and
   it must not become a failure. Both are wrong: the first flatters an
   un-researched account, the second penalises it for silence.
4. **What happens when two sources disagree?** The conflict must stay visible and
   unresolved. Phase 7 already made the *storage* decision (`contested` claim,
   `contradicted` evidence, no winner). Phase 8 had to decide what a
   qualification does with it.
5. **Does a qualification have a lifecycle?** `ROADMAP.md` §15 does not ask for
   one, and importing one would smuggle in Phase 10 (Approval) and Phase 14
   (Next Best Action) semantics.

## Decision

Add a `@dealora/qualification` domain, one additive table (schema v8), and five
thin API handlers.

### Architecture

```
API handlers (translation only)
      ↓
QualificationService (authorization, context resolution, evaluation, persistence)
      ↓
QualificationRepository (interface)  + ICP reader + goal reader + plan reader
      ↓
JSON store (v8)
```

The domain depends on interfaces, never on the store, exactly as the plan,
research, evidence and account domains do. The three readers are deliberately
narrow: the ICP's target terms, one goal's time window, one plan's provenance.
The engine never sees a whole Business Brain, a goal's economics, or a plan's
outreach strategy.

### The five dimensions

Exactly the five `ROADMAP.md` §15 names, in that order, as a closed vocabulary:
`icp_fit`, `need_fit`, `buying_signal`, `timing`, `company_fit`.

### The ten criteria

Every criterion is data in one file, readable through the API *before* any
account is evaluated. Each is traceable to the source-of-truth model:

| Dimension       | Criterion            | Reads                                                                  |
| --------------- | -------------------- | ---------------------------------------------------------------------- |
| ICP Fit         | `industry_match`     | claim `industry.industry` vs `Icp.industries`                          |
| ICP Fit         | `geography_match`    | claim `company_overview.geography` vs `Icp.geographies`                 |
| ICP Fit         | `no_disqualifier`    | every eligible claim vs `Icp.disqualifiers`                             |
| Need Fit        | `hiring_signal`      | any claim in `hiring`                                                   |
| Need Fit        | `technology_signal`  | any claim in `technology_signals`                                        |
| Buying Signal   | `leadership_change`  | any claim in `leadership_changes`                                       |
| Buying Signal   | `expansion_signal`   | any claim in `expansion`                                                |
| Timing          | `activity_in_window` | an observation dated inside the Revenue Goal's window                   |
| Company Fit     | `company_size`       | `company_overview.company_size` / `employee_count` vs `Icp.companySizes` |
| Company Fit     | `business_model`     | claim `business_model.model` vs `Icp.businessModels`                    |

The four signal criteria use the Phase 6 research categories that can carry the
Phase 4 compiler's own signal definitions — "role postings showing the account is
hiring for the capability the offer addresses", "a stack change that raises or
lowers the cost of the problem", "a new decision-maker arriving with a mandate
relevant to the offer", "new markets, offices, or product lines indicating the
account is scaling the problem". Nothing here was invented to fill a dimension.

**Deliberately absent:** any criterion about a contact, persona, title, price or
conversation. `DEALORA_BLUEPRINT.md` §12.4 keeps contact selection a separate
responsibility, and Phase 8 must not become a persona matcher in disguise.

### ICP integration: reference, never copy

There is no second ICP model. The record stores `icpId` plus a `contextDigest` —
an FNV-1a fingerprint of the exact `{icp, goal, ruleVersion}` used — so a
historical score stays interpretable without embedding the Business Brain inside
every evaluation. The same pattern Phase 4 uses with `brainSnapshotDigest`.

An incomplete ICP is a first-class state, not a silent pass: if the workspace
states no industries, `industry_match` is `unknown` with a reason saying the ICP
states none of them, because there is nothing to match and therefore nothing to
conclude. **A missing ICP is an error, not a default**: there are no criteria of
last resort.

### Revenue Goal integration: the window, and never an inferred one

Only `timing` reads the goal. The goal is resolved from the account's plan
lineage, or from an explicit `revenueGoalId` the caller names — validated to
belong to the workspace. A goal is **never inferred** from a market name or a
date range. When no goal is available the criterion is `unknown` with the reason
"No revenue goal is linked to this account, so the window is unknown and none is
inferred", and the evaluation is `insufficient_data` with **no score**.

`activity_in_window` passes when at least one supporting evidence record carries
an `observedAt` inside `[timeWindow.start, timeWindow.end]`. It fails when
observations exist but all sit outside the window — that is a real answer. An
observation with **no date** is not an answer in either direction, so it stays
`unknown`.

### Revenue Plan integration: provenance only

The plan establishes which goal an account was sourced for, and nothing else.
No plan strategy is ever a criterion, and storage rejects a qualification that
points at another workspace's plan.

### Evidence integration: only what is still recorded

A claim is read only when it is `asserted` **and** carries at least one
`recorded` evidence record. Rejected and superseded records support nothing, and
their absence is not a contradiction, so it never becomes a failure. Retracted
claims are invisible in both directions. Source and provenance metadata are
carried into the result by reference (`evidenceIds`, `claimIds`), never copied —
the full records are joined on read by the explanation endpoint.

There is no path from a research provider to a criterion result.

### Missing data: `unknown`, and never a zero

| Situation                                   | Criterion | Score |
| ------------------------------------------- | --------- | ----- |
| Evidence present and matches the criteria   | `pass`    | yes   |
| Evidence present and contradicts them       | `fail`    | yes   |
| Nothing researched, or nothing readable     | `unknown` | **null** |
| Sources disagree                            | `unknown` | **null** |
| ICP states no terms to match                | `unknown` | **null** |
| No revenue goal for the window              | `unknown` | **null** |

A `null` score is not a zero. A dimension that is `unknown` carries no number at
all, and the overall Dealora Score is issued **only when all five dimensions
resolved**. An average over a partly-researched account is exactly how a missing
fact reads as a fit, so the score is deliberately all-or-nothing.

### Conflict: represented, never resolved

A `contested` claim, or one with `contradicted` evidence on record, leaves every
criterion that reads it `unknown`, with `observed: null` — reporting the claim's
stored side as "observed" would read as if DEALORA had picked a winner. The
reason names the disagreement, both evidence records stay referenced, and the
evaluation's state is `contested`.

The newest source does not win. The most confident source does not win. A
contested claim never falls through to a different claim field to escape the
conflict. Resolution remains Phase 7's named supersession, and only then does a
re-evaluation see a resolved claim.

### States

| State                | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `qualified`          | every dimension resolved, every criterion passed                        |
| `unqualified`        | every dimension resolved, at least one criterion failed                 |
| `insufficient_data`  | at least one criterion unresolved — no verdict is issued                 |
| `contested`          | at least one criterion unresolved *because sources disagree* (checked first) |

`contested` outranks `insufficient_data` because a disagreement is stronger
information than an absence, and `conflictedClaimIds` on the record makes it
machine-readable rather than only prose. There is no `approved`, `picked`,
`contacted` or `prioritised` member.

### No lifecycle: immutable, versioned evaluations

`QUALIFICATIONS_ARE_IMMUTABLE` is the whole model. There is no
`canTransitionQualification`, no status column and no update handler. Re-evaluating
an account inserts a new `version` within its lineage; the previous record is
never rewritten, so a score a user acted on stays explainable after the rules
change. Adding a lifecycle would import Phase 10's approval semantics and give a
qualification a shape it must not have.

### Scoring

Explicit, deterministic, and stored with every result:

- **Criterion**: `pass` / `fail` when evidence answers the question;
  `unknown` when nothing does.
- **Dimension**: `fail` if any criterion failed — a proven mismatch is a proven
  mismatch even beside an unresolved sibling; `pass` only if every criterion
  passed; `unknown` otherwise. Score is `null` unless the dimension resolved,
  and otherwise the equally-weighted share of its resolved criteria that passed.
- **Score**: the arithmetic mean of the five dimension scores, rounded half-up,
  and `null` unless all five resolved.
- **Confidence**: the **weakest** confidence band among the supporting evidence
  — the Phase 6 `low`/`medium`/`high` bands, reused unchanged, never summed or
  re-scaled. The weakest link is chosen so that adding a weak source beside a
  strong one can never make a criterion look better supported than its worst
  citation.

Equal weights per criterion, and no other weighting, because DEALORA has no
calibration data. The scores are consequently coarse: with ten criteria across
five dimensions, an ICP Fit of 67 means "two of three criteria passed". That
quantization is the honest consequence of not inventing precision — Phase 6 made
the same argument when it chose bands over percentages.

`ruleVersion` (`deterministic-1.0.0`) is stored on every record, and
`SUPPORTED_RULE_VERSIONS` is the only set a caller may ask for. A caller may name
a goal or a rule version; it may never name a criterion, a weight, a score, a
state or a confidence, because the service reads none of those from a request.

### Storage

Schema v8 adds one table, `qualifications`, with the per-criterion results held
as a single `dimensions` document column — exactly as `revenue_plans.strategies`
does. Splitting criterion rows into a child table would invite a criterion to
outlive the decision that explains it. The migration is additive like every step
before it; migrations 1–7 are untouched and a v7 document gains one empty table
while keeping every account, claim and evidence record it already had. Plan,
goal and ICP references use `ON DELETE SET NULL`: deleting a goal must not delete
a decision a user already made.

### API surface

Five handlers, translation only:

| Handler                            | Requirement it serves                     |
| ---------------------------------- | ----------------------------------------- |
| `createQualification`              | evaluate and persist, as a new version    |
| `getQualificationCriteria`         | inspect the rules before any evaluation    |
| `getQualification`                 | inspect one result                         |
| `listQualifications`               | audit trail, newest first, filterable      |
| `getQualificationExplanation`      | the gate: the score joined to its sources  |

`getQualificationExplanation` is the phase's gate in one read: the evaluation plus
every claim and evidence record a criterion actually referenced, filtered to the
ones the decision read so the view cannot imply evidence the decision did not
rest on.

The workspace always comes from the route and the identity always from the
session. `UNAVAILABLE` becomes `SERVER_ERROR`, `UNSUPPORTED_RULE_VERSION` becomes
`VALIDATION_ERROR`, and a foreign account, goal or evaluation is reported as
`NOT_FOUND` so another tenant's existence is never revealed.

## Alternatives considered

- **Skip scoring and return structured states only.** Rejected: `ROADMAP.md` §15
  shows a Dealora Score, `DEALORA_BLUEPRINT.md` §55 lists *Scoring* as an MVP
  feature, and Milestone B requires an evidence-backed score.
- **Reverse-engineer the §15 example's arithmetic.** Rejected: 95/89/91/78/94
  averages to 89.4, not 90, so no stated rule produces 90. A formula fitted to an
  illustration would be a hidden heuristic wearing a derivation's clothes.
- **Let an LLM judge fit.** Rejected outright: no hidden AI scoring, no model
  opinion. It would be unreproducible, unauditable, and unanswerable to the gate.
- **Weight dimensions by importance (ICP more than Timing).** Rejected: any
  weight would be invented. Equal weights are stated, stored and explainable.
- **Average only the dimensions that resolved.** Rejected: it would let a
  partly-researched account produce a flattering number, which is the failure
  mode this phase exists to prevent.
- **Let "no evidence" fail the criterion.** Rejected: it penalises an account for
  not having been researched, and would make "research everything, then qualify"
  strictly better than "qualify honestly".
- **Resolve a contested claim by freshness or confidence.** Rejected: Phase 7
  already refused this at the storage layer; doing it at the decision layer would
  be the same rule one layer too late.
- **Copy the Business Brain into the qualification.** Rejected: a snapshot of the
  whole Brain per evaluation is a second source of truth that drifts. A digest
  plus a reference keeps the historical record interpretable and the Brain
  canonical.
- **Add a qualification lifecycle (`draft` → `proposed` → `approved`).**
  Rejected: `ROADMAP.md` §15 does not ask for one, and "approved" is Phase 10's
  vocabulary. An immutable versioned record expresses everything this phase owes.
- **Add a `priority` or `rank` field for ordering accounts.** Rejected: that is
  Phase 14 (Next Best Action), and `DEALORA_BLUEPRINT.md` §32's trace example
  shows the score being *logged*, not used to sort a queue.
- **Parse "10-200" into a numeric range.** Rejected: the ICP's size terms are the
  business's own wording, and deciding that a bigger number is a better account
  is a rule only the business can state. Sizes are matched as terms.

## Consequences

- A user can inspect why an account received a score, down to the claim value
  and the source record behind each criterion — the gate, satisfied.
- The same account, claims, evidence, ICP, goal and rule version always produce
  the same score, so a result can be re-derived to prove it was never changed.
- Missing evidence is a first-class, inspectable outcome with no score, rather
  than a pass or a failure.
- Contradictory sources produce a `contested` evaluation with no score and a
  named list of the claims in dispute; nothing is resolved on the user's behalf.
- The score is coarse and quantized, and its confidence is its weakest citation.
  Both are consequences of having no calibration data, and both are stated in
  every record rather than smoothed over.
- A Dealora Score exists only for a fully-evidenced account. Most accounts will
  sit at `insufficient_data` early on, which is the honest reading of the data
  rather than a product defect.
- Workspace isolation is enforced in the service and again in storage, and a
  foreign account, goal or evaluation is reported as not found.
- The rule set is data in one file. Changing a criterion, weight or threshold is a
  `ruleVersion` bump, not a code path that can drift from what old records claim.

## Limitations

- Term matching, not semantic matching. "B2B SaaS" satisfies the ICP term "saas";
  "saasware" does not, because there the term is not a word of its own.
- Company size is matched as the term the workspace wrote. There is no numeric
  range parsing and no size threshold DEALORA invented.
- Timing is binary per observation: inside the goal window or not. There is no
  model of how close to the window an account is.
- Confidence is the declared Phase 6 band, not a calibrated probability, and the
  weakest-link rule is a conservative choice rather than a measured one.
- Criteria are limited to the ten above. Anything about contacts, personas,
  pricing, conversation history or competitive position is out of scope by
  design.
- Single-process storage only, as in every prior phase. No queue, worker or
  coordination service was added.