# ADR 0015 — Revenue Graph: a graph derived from the rows it claims, and a vocabulary that refuses what it cannot produce

- Status: Accepted
- Date: 2026-10-24
- Phase: ROADMAP.md Phase 15 (Revenue Graph)

## Context

`ROADMAP.md` §22 asks Phase 15 to "create relationships between revenue
entities" and names twelve of them: **Company, Person, Signal, Evidence,
Campaign, Conversation, Meeting, Opportunity, Customer, Revenue, Agent,
Workflow** — with the example chain:

```
Company → Signal → Prospect → Campaign → Conversation → Meeting →
Opportunity → Customer → Revenue
```

Its gate is one sentence: *the system can trace the lifecycle of an
opportunity.*

`DEALORA_BLUEPRINT.md` §11 lists the same relationships (plus Product/Offer)
and frames the graph as the foundation the later analytics, attribution and
optimization phases will read. Phases 0–14 have produced all of the rows the
chain needs except the ones whose owning phases do not exist yet, so this phase
is mostly a question of *what to publish and what to refuse*.

Five questions had to be answered before any code was written.

1. **Store the graph, or derive it?** The obvious design is a `revenue_graph`
   table written alongside every phase. That table would duplicate the facts it
   represents, and the duplication would rot: `tests/phase15-gate.test.ts`
   shows a newer qualification flipping an account to `contested`, after which a
   stored opportunity node would be a stale claim that the account is qualified
   right now. Every earlier phase already learned this — Phase 14's stored row
   is only a *history of advice* — and a graph of facts has an even stronger
   version of the same argument. So the graph is **derived on read** from the
   rows Phases 5–13 already store, and this phase adds **no table, no schema
   version and no migration**: `LATEST_SCHEMA_VERSION` stays 14.
2. **Which of the twelve names can this repository honestly publish?** Seven,
   and the test asserts the split as a *partition*: the seven published node
   kinds plus five explicit refusals equal §22's twelve names, disjointly.
   `campaign` has no owning phase at all (the Blueprint defines the object;
   the roadmap assigns it to none), `customer` and `revenue` belong to Phases
   16/17/23, `agent` to Phase 18 and `workflow` to Phase 24. Advertising a kind
   nothing can produce is the same mistake Phase 13 was corrected for in
   commit `88f1f02` — a vocabulary no branch can reach is a lie printed as a
   type — so each refusal ships with its reason and its owning phase in the
   policy route.
3. **What is an "opportunity" node?** There is no opportunity row in the
   schema, and this phase is not going to invent one. The node **is** the
   account's newest qualification when that qualification is `qualified` —
   max version (versions are never reused in an account's lineage), ties
   broken by newest instant then id — carrying the qualification's own id and
   the state word `qualified`. It appears the moment a `qualified` evaluation
   exists and disappears the moment a newer one says otherwise, because the
   graph is recomputed rather than replayed.
4. **What happens when a row disagrees with its own vocabulary?** A published
   status outside its closed list (account, contact, evidence, conversation,
   meeting) makes the whole derivation return `null`: the service reports the
   graph unavailable rather than publishing a half-understood picture of an
   account. The one deliberate exception is a qualification state outside the
   vocabulary: an unreadable state can never *raise* an opportunity, so that
   account simply gets no opportunity node — the gate pins both behaviours,
   because "a state we cannot read qualified this account" is exactly the
   sentence this system must never print.
5. **What may a client send?** An account id. That is the entire input
   surface. Nodes, edges, an opportunity, a frontier and a rule version are
   all *outputs*; the forgery test posts every one of them and asserts the
   answer is byte-for-byte what the rows produce.

## Decision

### The graph is derived, never stored

`deriveAccountGraph` in `packages/revenuegraph/src/engine.ts` is a pure
function over one account's narrowed snapshot: no clock, no randomness, no
model, no network, no store access. Every edge carries `derivedFrom` — the
exact rows the rule read, target row last — so any relationship can be checked
against storage without trusting the graph itself, and the gate audits every
cited id against the database. An edge whose rows are missing is not emitted.

One rule table publishes the vocabulary: `NODE_KINDS` (seven declarations of
kind, source table and semantics), `EDGE_KINDS` (twelve declarations of
endpoints, semantics and the stored field that proves them) and `REFUSED`
(five names with reasons and owning phases) in
`packages/revenuegraph/src/rules.ts`. The policy route prints these tables
verbatim, so a kind cannot exist in the API without semantics, and semantics
cannot exist without a kind. The tests assert
`NODE_KINDS ∪ REFUSED == ROADMAP.md §22's twelve names`, disjointly.

The twelve edges: `company_has_person`, `company_has_signal`,
`company_has_evidence`, `company_has_opportunity`, `company_has_conversation`,
`company_has_meeting`, `signal_became_evidence`,
`evidence_supports_opportunity`, `person_had_conversation`,
`opportunity_led_to_conversation`, `conversation_led_to_meeting`,
`person_joined_meeting`. The approval that authorized the send rides in
`opportunity_led_to_conversation`'s `derivedFrom`, so the human decision behind
a reply's outbound message stays checkable from the edge.

### A total order with no clock

Identical rows always print identical graphs: nodes order by (occurredAt,
stage rank, id), edges by (occurredAt, kind, from, to) with an edge's
occurredAt being its target node's, undated instants sort last, and edges
deduplicate by `(kind|from|to)`. The lifecycle is the non-empty stages of
`REVENUE_GRAPH_STAGES` in loop order, the frontier being the furthest stage
actually reached — so "where does this account stand?" is a field, not a
narrative. The workspace graph merges account graphs by concatenation,
deduplication and the same re-sort, which is exactly what a single derivation
over the union would print. Every response pins
`ruleVersion = "revenue-graph-1.0.0"`.

### One narrow input, one narrow surface

The handler passes `body.accountId` and nothing else. The service resolves the
workspace with the caller's identity first (a foreign workspace reads
`UNAUTHORIZED`), then the account inside it (a foreign id reads `NOT_FOUND`, so
a workspace cannot discover ids by watching which error comes back), then
checks lineage: a classification whose inbound message is not in the account's
own history breaks the derivation and refuses the read.

A workspace above `GRAPH_ACCOUNT_LIMIT = 100` accounts is **refused** rather
than truncated — a graph that quietly stopped would be read as complete, the
same discipline as Phase 14's board cap. The count is checked before any
account is read.

The repository surface is `authorize` alone, and the service's entire method
list is constructor, guard, policy, `traceOpportunity` and `workspaceGraph`.
There is no create, update, delete, send, schedule, approve, book or
recommend verb anywhere in `packages/revenuegraph`, and a test asserts the
prototype has exactly those names.

### Refusal, not fabrication

An unreadable published vocabulary maps to the domain error `UNAVAILABLE`,
which the HTTP layer reports as a server error — never as an empty graph. An
empty graph means "this workspace holds nothing"; a refusal means "the store
disagreed with itself", and conflating the two would let a data defect look
like an account with no history.

## Alternatives considered

**A `revenue_graph` table maintained by every writer.** Rejected. It would
double every fact, need a migration, and drift the first time a qualification
is downgraded — the gate's recomputation test exists precisely because a
stored opportunity must not survive its own contradiction.

**Publishing all twelve relationships now, with empty or placeholder nodes for
campaign, customer, revenue, agent and workflow.** Rejected. Nothing in Phases
0–15 produces those rows, so the policy would advertise five kinds that always
come back empty — visible vocabulary with no semantics behind it. Each name is
refused *with its reason and owning phase* instead, which documents the roadmap
honestly without pretending to implement it.

**Letting the caller post nodes and edges (a graph-builder API).** Rejected.
The graph's only claim is that it corresponds to stored rows; accepting a
client's own nodes would make the answer a function of the request rather than
of the account. The forgery test posts a complete fake graph and asserts the
response is unchanged.

**Newest-timestamp wins for the opportunity.** Rejected. Phase 8 versions are
immutable and never reused within an account's lineage, so the **highest
version** governs; instant and id only break ties. Timestamp-wins would let a
slower-writing older evaluation resurrect an outdated state.

**Truncating the workspace graph over the cap.** Rejected, for the same reason
as Phase 14's board: a caller handed 100 of 137 accounts would read the answer
as the workspace. The route refuses and names the number.

## The boundaries this phase keeps

- **It never writes a row.** No table, no migration, no schema version; the
  gate snapshots every row count before and after graph reads.
- **It never acts.** No sender, approver, scheduler, queue, CRM sync, calendar
  sync or provider of any kind in the package.
- **It never recommends.** Phase 14 owns advice; the graph reports what
  happened, never what should happen next.
- **It never infers a node or an edge.** A node appears only when its row
  exists; an edge only when the stored linkage proves it, and `derivedFrom`
  names the rows every time.
- **It never advertises vocabulary nothing can produce.** The five refusals are
  part of the published policy.
- **It never resolves a conflict.** A contested evaluation removes the
  opportunity; the contradicting evidence itself survives, exactly as Phase 7
  left it.
- **It never truncates silently**, never crosses a workspace, and never reads
  time as a fact — `occurredAt` drives ordering only.

## Open requirements

These are **open**, not limitations of this phase:

- `DEALORA_BLUEPRINT.md` §11's analytics, attribution and optimization
  consumers of the graph belong to the later phases (Phase 16's cost metrics,
  Phase 17's dashboard, Phase 21's optimization engine); this phase ships the
  foundation and reads nothing from it itself.
- The refused relationships arrive with their owning phases: `revenue` and
  `customer` (Phases 16/17/23), `agent` (Phase 18), `workflow` (Phase 24), and
  `campaign`, which `ROADMAP.md` currently assigns to no phase at all.
- `ROADMAP.md` §30's calendar and CRM integrations remain Phase 23, and
  [ADR 0011](./0011-first-outbound-integration.md)'s OAuth and provider-scope
  requirements stay open for email and calendar alike.

## Consequences

- The repository can now answer, in one call per account and one per
  workspace: *where did this opportunity come from, and what did it touch?* —
  company → person → signal → evidence → opportunity → conversation →
  meeting, with every hop naming the rows that prove it.
- Because the graph is derived, it cannot go stale: a `contested` downgrade
  removes the opportunity and its edges from the next read, and a superseded
  evidence status shows as it is now, not as it was when a graph was written.
- `ROADMAP.md` §22's twelve names are answered as a **partition** — seven
  published, five refused with reasons — so a later phase that grows a
  `customer` row has an explicit list of what to add rather than a set of
  silently empty kinds.
- The lifecycle is data: stages, frontier and the opportunity id are fields on
  every trace, asserted at every stage of the gate rather than once at the end.
- The action surface is provably zero: the full gate and the Phases 9–16
  integration test (renamed when Phase 16 joined it) both prove a graph read
  adds no row to any table, and the service exposes no verb that could.
