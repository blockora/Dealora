# ADR 0017 — Revenue Dashboard: derived on read, and a refusal where no row exists

- Status: Accepted
- Date: 2026-10-26
- Phase: ROADMAP.md Phase 17 (Revenue Dashboard)

## Context

`ROADMAP.md` §24 asks Phase 17 to "make business outcomes visible". The initial
dashboard names twelve tiles — **Revenue Goal, Direct Revenue, Pipeline
Created, Qualified Prospects, Positive Conversations, Meetings, Opportunities,
Customers, Agent Activity, Approvals Required, Workflow Failures, Cost** — and
requires the dashboard to answer four questions: *Where are we? What is
working? What needs attention? What should happen next?* Its gate is one
sentence: *a user can see the revenue workflow as business outcomes, not just
technical activity.*

`DEALORA_BLUEPRINT.md` §35 puts those same four questions on the home screen,
which is why two tiles beyond the roadmap's twelve are needed: what needs
attention needs a **hot conversations** count, and what should happen next needs
the **next best action** Phase 14 already computes.

Six questions had to be answered before any code was written.

1. **Store the dashboard, or derive it?** A stored dashboard is a second copy
   of facts other phases already store, and it goes stale the moment any of
   them moves. So the phase adds **no table, no schema version and no
   migration**: every tile is recomputed from stored rows on read. The
   dashboard can disagree with the loop only if a row changed, and a row change
   is the thing that should change the dashboard.
2. **What does a tile answer when no row can produce it?** This is the whole
   question. A dashboard that reported **$0 pipeline** would be claiming the
   workspace has no pipeline, when the truth is that nothing records pipeline
   value yet. Those are different claims and only one of them is honest. So a
   tile with no backing row type reports `status: "no_data"`, a reason, and
   the phase that owns it — never a fabricated zero, estimate or forecast.
3. **Which three tiles cannot be fed?** **Direct Revenue** (no phase through 17
   records a realized-revenue row), **Pipeline Created** (qualifications and
   meetings carry no money, so pricing the pipeline would need an average deal
   value this phase does not have) and **Customers** (no phase through 17
   records a customer). All three name **Phase 23** as their owner, which is
   where `ROADMAP.md` §30 puts CRM integrations.
4. **What is an "outcome" versus "activity"?** §24 names both, and the
   distinction has to be mechanical. **Qualified Prospects** counts accounts
   whose **newest** qualification is `qualified` — the same rule ADR 0015's
   opportunity node and ADR 0016's denominator already use, so "qualified"
   means one thing across three phases. **Opportunities** additionally requires
   that the account's loop reached a calendar, because `BLUEPRINT.md` §11 places
   Opportunity after Meeting: a meeting that never reached a calendar is a
   recommendation, not an outcome. **Agent Activity** then reports the *work*
   — accounts researched, prospects ever qualified, drafts rendered, replies
   classified — so the two never agree by accident and the gap between them is
   the honest signal.
5. **Which words are borrowed rather than re-declared?** "Positive
   conversation" is read from Phase 13's `MEETABLE_INTENTS` rather than copied,
   and the meeting states, the cost picture and the next-action board all come
   from the phases that own them. A dashboard that re-derived cost would be a
   second definition of every cost number; one that re-derived advice would be
   a second opinion on what to do next.
6. **Which goal is "the" goal?** The newest goal with status `active`, by
   `createdAt` descending with `id` as the stable tiebreaker. A draft, paused,
   completed or archived goal is deliberately **not** promoted: the dashboard
   answers `no_data` rather than guessing which stored goal the workspace is
   working toward.

## Decision

### Derived, never stored

`packages/dashboard/src/engine.ts` is pure functions over row slices — no
clock, no randomness, no store, no client input. `deriveDashboard` assembles
the snapshot; the same rows always print byte-identical JSON. `service.ts`
authorizes with the caller's server-side identity, reads the workspace's rows
through workspace-scoped lookups, and writes **nothing**: the repository
surface it uses is `authorize` and nine `list*` methods, and its only public
methods are the two reads `snapshot` and `policy` (the third member, `guard`,
is the private authorization helper).

### Three tile shapes, chosen by what a row can support

- **derived** — a row type exists, so a zero is a fact (qualified prospects,
  meetings, opportunities, approvals, failures, activity).
- **conditional** — a row type exists but its premise may be false; the Revenue
  Goal needs an *active* goal, so an empty list answers `no_data`, not
  "goal: none".
- **no_data with an owning phase** — no Phase 0–17 row can feed the tile
  (Direct Revenue, Pipeline Created, Customers).

Double counting is impossible by construction: every account-based count is
over a `Set`, so an account appears at most once however many versions,
meetings or classifications it has.

### One rule table, one partition

`packages/dashboard/src/rules.ts` declares the fourteen keys (the roadmap's
twelve plus the two Blueprint legs), each label, each availability, each
derivation, the three refusals, `GOAL_SELECTION_RULE`, `OPPORTUNITY_RULE`, the
four activity counters, the three failure sources, `DASHBOARD_QUESTIONS` and
`NEVER_DO`. The questions are a **partition**: every key answers exactly one of
the four questions, asserted directly, so no tile is orphaned and none is
claimed twice. The engine stamps every tile with its own published derivation,
so a tile can never narrate something other than what the policy says.

### The cost tile and the next-step tile are embedded whole

`cost` is Phase 16's `WorkspaceCostMetrics` read through `CostService.metrics`,
and `nextBestActions` is Phase 14's `NextActionBoard` read through
`NextActionService.recommendForWorkspace`. Neither is re-derived. The cost
engine therefore keeps exactly one definition of every cost number, and the
dashboard cannot advise differently from the recommendation engine.
`hot_conversations` counts board recommendations whose supporting state is
`response_needing_reply` — a reply a person must approve.

### Identity and scope are the server's

Every read is workspace-scoped inside the repository with the caller's own
identity. The workspace is a route parameter and the caller is the session; the
service re-authorizes that pair before a single row is seen, and a foreign
workspace reads as denied. The gate posts a body asserting every tile's number,
`userId` and `workspaceId`, and asserts the response is byte-identical to the
one produced with no body at all.

## Alternatives considered

**Storing a dashboard row per workspace.** Rejected. It would be a second copy
of facts owned by eight other phases, updated by every writer, and stale the
moment a path is missed — with nothing re-deriving from the rows to catch it.
Phase 15 and Phase 16 made the same call for the same reason.

**Reporting unfed tiles as `0`.** Rejected, and it is the most consequential
choice in this phase. `$0 pipeline` is a financial claim about the workspace;
the truth is that no phase records pipeline value. One of those can be acted on
and the other can be sued for. The tiles refuse, name the owning phase, and
stay refused until Phase 23 supplies the rows.

**Estimating pipeline from the goal's target value or an assumed deal size.**
Rejected. It is precisely the fabricated financial fact the roadmap warns
against, and it would look *more* trustworthy than a refusal while meaning
less.

**Counting qualifications rather than accounts for Qualified Prospects.**
Rejected. `ROADMAP.md` §24 asks for *prospects*, and a single account that
reached version 4 must not read as four prospects.

**Counting every qualification version ever marked `qualified`.** Rejected for
the outcome tile — a regressed account is not a current outcome — but kept for
the `prospects_qualified` **activity** counter, where the work genuinely
happened. The two tiles reading different sources is the point: one is what is,
the other is what was done.

**Treating a recommended-but-unbooked meeting as an opportunity.** Rejected.
`BLUEPRINT.md` §11 places Opportunity after Meeting, and a meeting that never
reached a calendar is a recommendation. `OPPORTUNITY_MEETING_STATES` is
`booked`, `held`, `no_show` — the three states that were on a calendar — and
`approved` and `awaiting_approval` deliberately are not.

**Re-deriving cost or next actions inside the dashboard.** Rejected. Two
definitions of a cost number, or of what to do next, is how a product starts
disagreeing with itself. Both are embedded whole from their owning phase.

**Promoting the newest goal regardless of status.** Rejected. A draft goal is
not what a workspace is working toward, and the dashboard should say it does
not know rather than pick for the user.

## The boundaries this phase keeps

- **It never writes.** No table, no migration, no schema version. The gate
  snapshots every table count around reading the dashboard.
- **It never acts.** No sender, approver, scheduler, provider, agent or
  network; `ROADMAP.md` §25 puts the agent system in Phase 18.
- **It never recommends.** Phase 14 owns advice; this phase reads its board.
- **It never fabricates.** A tile with no backing row reports `no_data` with
  its owning phase — never a zero, an estimate or a forecast.
- **It never trusts a client total.** Every number is recomputed from the
  workspace's own rows on each request.
- **It never does float money arithmetic.** The only money tiles it owns are
  refusals; the cost tile is Phase 16's engine, read whole.
- **It never crosses a workspace.** Every read is workspace-scoped with the
  caller's own identity, and a foreign workspace reads as denied.

## Open requirements

These are **open**, not limitations of this phase:

- Direct Revenue and Customers arrive with Phase 23's CRM integrations, which
  sync realized revenue and customer records. The refusals are already
  published.
- Pipeline Created additionally needs stored opportunity values; Phase 23's CRM
  sync would carry them. Until then there is no honest way to price a pipeline.
- `hot_conversations` inherits Phase 14's board cap. A workspace with more
  actionable accounts than the board holds will have that many hot
  conversations counted, not more — the cap is Phase 14's decision and is
  visible in its own policy.

## Consequences

- The repository can now answer, in one read: *where are we, what is working,
  what needs attention, and what should happen next?* — every tile traceable to
  a stored row or an explicit refusal.
- Because nothing is stored, the dashboard cannot go stale and cannot drift
  from the loop. A `contested` downgrade removes the opportunity from the very
  next read.
- Outcome tiles and activity tiles are computed from different sources on
  purpose, so the distance between "what we did" and "what it produced" is
  visible rather than averaged away.
- The three refusals give Phase 23 an explicit, testable list of what to enable
  instead of three silently empty numbers.
- Cost and next actions have exactly one definition each in the product, and
  this phase cannot introduce a second.