# Dealora

Give Dealora a revenue goal. It finds the opportunity, builds the workflow, and helps move it to a deal.

**DEALORA is an AI Revenue Operating System.** It turns a business revenue goal
into an evidence-backed, permission-controlled, measurable and continuously
optimized revenue workflow:

```
Business → Revenue Goal → ICP → Target Accounts → Research → Evidence →
Qualification → Prioritization → Personalization → Human Approval →
Approved Action → Response → Meeting → Opportunity → Revenue → Learning
```

DEALORA is not a chatbot, a CRM, an email writer, or a lead scraper. It is the
intelligence and execution layer around the revenue stack.

## Repository status

The repository has completed **Phase 0 — Repository & Engineering Foundation**,
**Phase 1 — Application Foundation**, **Phase 2 — Business Brain**,
**Phase 3 — Revenue Goal Engine**, **Phase 4 — Revenue Plan Compiler**,
**Phase 5 — Account & Prospect Input**, **Phase 6 — Research Engine**,
**Phase 7 — Evidence System**, **Phase 8 — Qualification Engine**,
**Phase 9 — Personalization Engine**, **Phase 10 — Approval Engine**,
**Phase 11 — First Outbound Integration**, **Phase 12 — Conversation
Engine**, **Phase 13 — Meeting Workflow**, **Phase 14 — Next Best Action**,
**Phase 15 — Revenue Graph**, and **Phase 16 — Cost Engine**
(see [`ROADMAP.md`](./ROADMAP.md)).

Phase 1 delivers the minimum multi-tenant SaaS infrastructure: user identity
with scrypt-hashed credentials, opaque bearer sessions, workspaces as the
tenant boundary, business profiles, a tenant-isolated repository, an API layer,
and server-side authorization. The Phase 1 gate — sign up → create workspace →
create business profile → persist → reload → see the persisted workspace — is
covered by `tests/phase1-gate.test.ts`.

Phase 2 adds the canonical business-context layer: company, offers with
approved-gated pricing, ICP, personas, positioning, brand voice, and claims with
explicit approval status. Its gate — create and edit Brain data, then retrieve
it as structured context — is covered by `tests/phase2-gate.test.ts`.

Phase 3 adds the Revenue Goal Engine: a natural-language or structured revenue
objective becomes a validated, workspace-isolated `RevenueGoal` with an
explicit target, time window, economics, constraints, success metrics, approval
policy and lifecycle. Goals reference canonical Business Brain records instead
of copying them, every parsed field records whether it was stated, inferred,
assumed or unknown, and nothing is invented to fill a gap — an incomplete goal
is stored with its gaps rather than guessed at. Its gate — express a goal in
natural language → get a structured, validated, persisted RevenueGoal — is
covered by `tests/phase3-gate.test.ts`.

Phase 4 adds the Revenue Plan Compiler: a complete `RevenueGoal` becomes an
inspectable `RevenuePlan` covering ICP, buyer, sourcing, signal,
qualification, outreach, follow-up, meeting, CRM, measurement and optimization
strategy. Every statement in a plan is classified as a fact, inference,
assumption, recommendation or unknown, so advice is never presented as
something DEALORA knows; the plan references canonical Business Brain records
instead of copying them, records the Brain digest it was compiled against, and
never claims that approving it authorizes sending anything. Recompiling
produces a new version and never destroys the previous one. Its gate — compile a
goal into an inspectable plan — is covered by `tests/phase4-gate.test.ts`.

Phase 5 adds the input layer the Revenue Plan's sourcing section promised: a
workspace-isolated way to bring target accounts and the contacts at them into
DEALORA, by hand or from CSV. Accounts and contacts are stored as **user input,
never as research** — each record carries where it came from (`manual`, `csv`,
`approved_integration`) and its source reference, deduplication is
deterministic (a normalized domain for accounts, account plus normalized email
for contacts) and a shared name with a different domain is reported as
ambiguous and preserved rather than silently merged. CSV import validates every
row with the same rules as manual entry and reports each row's outcome, so a
bad row is never dropped and never corrupts its neighbours. Archiving is soft
and cascades from an account to its contacts. Nothing is researched, enriched,
scored, qualified or contacted. Its gate — import and create target accounts
and contacts, persist, reload and keep the relationship — is covered by
`tests/phase5-gate.test.ts`.

Phase 6 adds the Research Engine: an existing account becomes a research
**request**, a permitted **provider** answers it, and the run produces structured
**research findings** that each carry their claim, source, reference, retrieval
time, confidence, freshness and relevance. Research runs only against permitted
sources — user-provided data, authorized APIs, permitted public/business
information and approved integrations — and the package contains no crawler, no
credential handling and no way around authentication, robots/access controls, API
restrictions or rate limits. Every statement is labelled `fact`, `inference`,
`hypothesis` or `recommendation`, so inference is never filed as fact; a
citation the source did not supply stays absent rather than being invented; and a
finding is **research data, not evidence** — verification, linking and audit are
Phase 7. Nothing here scores, qualifies, ranks, personalizes or contacts anyone,
and no external research source is configured or simulated: out of the box only
the workspace's own account record is researchable. Its gate — research an
account, persist attributed findings, reload and keep the provenance — is
covered by `tests/phase6-gate.test.ts`.

Phase 7 adds the Evidence System: a research finding becomes **evidence** only
through one controlled conversion, and evidence supports a structured **account
claim** whose source, reference, observation time, retrieval time, confidence,
freshness and relevance are all preserved verbatim from the source. Research
finding, evidence and claim stay three distinct things, and `AccountClaim`
stays distinct from the Business Brain's own marketing `Claim` — one is
externally sourced and unverified, the other internally authored and
approval-gated. Evidence is attributed, never invented: a source kind outside
`DEALORA_BLUEPRINT.md` §43 cannot be represented, a citation that was not
supplied stays absent, and a record the workspace supplied itself is always
attributed to the workspace's own account record rather than to an external
source. Conflicting evidence is **represented, never resolved** — two sources
that disagree about the same field both survive, both are marked
`contradicted`, and no timestamp is consulted, so a newer source never wins
automatically. Supersession is always caller-directed and names both sides;
nothing is ever deleted, so superseded, contradicted and rejected records stay
auditable. Nothing here scores, qualifies, ranks, personalizes or contacts
anyone: confidence and relevance describe a record's support and its directness
and are never summed, and a claim can never be marked verified — that status
does not exist. Its gate — an account's claims traced back through evidence to
the finding, request and account behind them — is covered by
`tests/phase7-gate.test.ts`.

Phase 8 adds the Qualification Engine: it answers whether an account satisfies
the criteria **the workspace itself defined**, by comparing Phase 7 evidence
against the canonical Business Brain ICP and the Revenue Goal's time window. The
five dimensions are exactly the roadmap's — ICP Fit, Need Fit, Buying Signal,
Timing, Company Fit — and the ten criteria are data you can read through the API
*before* an account is scored. Every score carries a reason, its evidence and a
confidence, which is the weakest band among the sources that produced it. The
result is a decision aid, never certainty, and it is deterministic: no model, no
randomness, no clock inside evaluation, and a rule version stored with every
record. Missing data is `insufficient_data` with **no score at all** — an
un-researched account is neither a pass nor a failure — and sources that disagree
produce a `contested` result with no score and a named list of the claims in
dispute, because qualification never resolves a conflict Phase 7 preserved.
Evaluations are immutable and versioned, so a score stays explainable after the
ICP or the rules change. Nothing here personalizes, contacts, approves,
prioritizes or books anything: a qualification is an input to those later phases,
never their output. Its gate — inspect why an account received a score, end to
end — is covered by `tests/phase8-gate.test.ts`.

Phase 9 adds the Personalization Engine: a qualified account becomes an
immutable, versioned **draft** whose every factual statement is an
evidence-backed observation quoted verbatim and attributed to its source, or an
approved Business Brain claim, or the offer's own description. Anything the
system could not honestly state — an unapproved price, a contested observation
— is recorded in `warnings` rather than smoothed over. The renderer is
deterministic, states its own version and its own refusals, and the whole layer
is a document: it carries no recipient, no channel, no provider and no send
state. Regenerating inserts a new version rather than rewriting one, because a
human may already have read it. Its gate is covered by
`tests/phase9-gate.test.ts`.

Phase 10 adds the Approval Engine: the human control that Phase 4 and Phase 8
explicitly deferred. An approval binds one **exact** immutable draft version
plus a digest of the exact content the reviewer is shown, and that digest is
re-derived at decision time — so an approval can only ever mean "I read *this*
text". The reviewer identity and the instant are taken from the session in both
the service and the storage layer, so a client cannot name its own approver or
backdate a decision. Exactly one of six states is a yes; a score, a threshold, a
timer or silence reaches none of them, expiry closes a request rather than
approving it, and a rejection or change request must say why. Every state leaves
an append-only audit event naming who and when. The phase ships **no execute
route**: it makes a send possible and does not make one happen. Its gate is
covered by `tests/phase10-gate.test.ts`.

Phase 11 adds the first outbound integration — **exactly one channel, email** —
behind a narrow provider interface. Nothing leaves the system without a persisted
human approval of the exact draft version, and the send path **re-derives that
approval from stored rows itself** rather than asking the component that wrote
it, re-checking the whole chain on every send: ownership, the exact version, the
digest, the approval's validity, the deliverable destination resolved from the
contact record, the opt-out list, a configured provider, and an attempt budget.
`sent` is written from exactly one place, on a provider confirmation, and the
schema constrains `sent_at` to a `sent` action — so a refusal, a thrown call or a
malformed provider answer is recorded as a failure and can never be reported as a
delivery. One approval yields at most one message, enforced both by the system
and by the provider's idempotency key. Retries are explicit, human-initiated and
capped; there is no scheduler, no queue, no retry loop and no mass-outreach
surface. The shipped provider is a **sandbox** that performs no network I/O and
records what it accepted, because no outbound credential is configured in this
repository — every delivery claim in the tests means "the provider recorded it",
never "DEALORA asserted it". Two `ROADMAP.md` §18 requirements are **open and not
implemented**: OAuth/credential handling and provider permission scopes. Both
belong to the first real adapter, which does not exist here, and both are
recorded as open requirements rather than limitations in
[`docs/adr/0011-first-outbound-integration.md`](./docs/adr/0011-first-outbound-integration.md).
Its gate is covered by `tests/phase11-gate.test.ts`, and the three phases together
by `tests/phases9-11-integration.test.ts`.

Phase 12 adds the Conversation Engine: a response that was actually received is
recorded **verbatim** with its provenance and read by a deterministic
classifier into one of the ten states `DEALORA_BLUEPRINT.md` §18 names — plus a
confidence, a **recommended** next action, and an explicit "does a person have to
look at this" flag. The rules, not a model, decide: no model, no clock, no
randomness, a rule version stored on every record, and a `reasons` list naming
the phrases that decided it, so a workspace can always answer "why did DEALORA
read it that way" without re-running anything. Safety outranks everything else — an
opt-out and a refusal both beat a question asked in the same breath, and `not
interested` can never be read as interest — and `unknown` with no guess is a real
answer when nothing matched. An opt-out is honoured **immediately** by writing to
the same Phase 11 suppression list the send path already checks, so there is no
second mechanism that could disagree with it about who is blocked. Everything else
waits for a human.

The negative space is the design. The strongest possible recommendation is
`prepare_reply_for_approval`: this phase cannot send, cannot approve, cannot
schedule, and **cannot turn a reply into evidence**. A prospect's own words are an
interested party's claim, so nothing here writes to `accountClaims` or `evidence`,
and Phase 7 stays the only route from something a source said to something
DEALORA treats as a fact. A response can only be recorded against an outbound
action that actually went `sent`, and the contact and account it is filed under
are resolved server-side from that action. No provider-side inbound retrieval,
webhook or poller ships here, and an objection is classified and escalated rather
than answered — no objection library, no response pattern and no guarantee is
invented. Its gate is covered by `tests/phase12-gate.test.ts`, and Phases 9–12
together by `tests/phases9-12-integration.test.ts`.

Phase 13 adds the Meeting Workflow: a response the classifier read as positive
becomes a meeting record with a **measurable state** — `recommended`,
`awaiting_approval`, `approved`, `booked`, `held`, `no_show` or `cancelled` — and
`DEALORA_BLUEPRINT.md` §22's preparation brief is assembled from records the
workspace already has. The important word is *measurable*. A proposal nobody
approved says so, and it says so in the row: nothing here reports a meeting that
did not happen.

The phase's safety property is structural rather than procedural.
`DEALORA_BLUEPRINT.md` §17 classifies *schedule event* as a **Level 2 external
action**, so the transitions that would let the system book on its own initiative
— `recommended → booked`, `awaiting_approval → booked` — do not exist in the
state machine at all. A person approving a booking walks `awaiting_approval` on
the way, and the audit trail records the request and the answer separately. The
approval is bound to a digest of the exact booking the reviewer was shown and is
re-derived at decision time, so "I authorized *this*" stays checkable, and a
cancelled meeting is terminal — a replayed request cannot resurrect it.

A meeting must also point at something real: a Phase 12 classification read as
`positive_intent` or `interested`, and a Phase 8 qualification in the state
`qualified`. Both are re-derived in storage rather than trusted from a caller, and
one response yields at most one meeting. The opt-out list is consulted **three
times** — at proposal, at approval, and again at booking — because an unsubscribe
can arrive in the gap, and reusing the Phase 11 list is what makes it stop a
booking as reliably as it stops a send.

`ROADMAP.md` §30 places calendar and CRM integrations in Phase 23, "only after the
core revenue loop works", so the shipped calendar adapter is a **sandbox that
performs no network I/O** and `booked` is written from exactly one place: on a
provider confirmation. Every booking claim here means *the provider recorded an
event*. The brief is the other half of the honesty story — it references claims
and evidence by id rather than copying them, and writes every `§22` section it
has no record for into `gaps` instead of filling it in. Nothing in this phase
sends an invitation, schedules anything on a timer, or turns a meeting into a
fact. Its gate is covered by `tests/phase13-gate.test.ts`, and Phases 9–16
together by `tests/phases9-16-integration.test.ts`.

Phase 14 adds the Next Best Action Engine: it answers *what should happen next?*
for one account and for a whole workspace, reading stored rows and applying a
fixed rule set. All seven of `ROADMAP.md` §21's required fields — action, reason,
supporting state, evidence, confidence, expected outcome and approval requirement
— are **fields** on every recommendation rather than prose assembled at read
time, so an answer stays checkable after the rules move on.

Two decisions shape it. First, the live answer is **recomputed** on every read
and the stored row is only the *history of advice*: a stored answer goes stale
the moment an approval is declined, and a stale "send this now" is the most
dangerous wrong answer this system could give. Second, confidence is ADR 0009's
weakest **band** — `low | medium | high` — and never a percentage. The `93%`
printed in `DEALORA_BLUEPRINT.md` §25 is a display illustration; there is no
calibration data in this repository from which a number could mean anything, and
a fabricated one would look *more* trustworthy than a band while meaning less.

The safety properties are structural rather than procedural. Eighteen revenue
states are declared once as `[state, action]` pairs and every published
vocabulary is **derived** from that one table, so a state no branch can produce
is impossible to advertise. `suppressed` is the **first** branch, so an address
that asked to stop can never come back with a recommendation to contact it, and a
cancelled meeting is never re-proposed over the top of a person's decision.
`approval_required` is CHECK-constrained to agree with the §17 risk level and
re-checked in the store, so "does a person have to act first?" is a property of
the row rather than something a client may assert. `level_3_high_impact` is
deliberately absent: nothing here recommends a financial, contractual or
irreversible action.

The negative space is the point. **A recommendation is advice, never an action.**
There is no sender, no approver, no calendar, no scheduler, no queue and no
network I/O of any kind in this phase, and the strongest thing a caller can do
with a "send this now" recommendation is read it and then call Phase 11, which
re-derives its own approval, digest and suppression check first. The gate proves
it by snapshotting every row count: recording a Level 2 recommendation adds
exactly one advice row and touches no draft, approval, outbound action, meeting,
claim or evidence record. Nothing here writes to the Phase 7 evidence graph
either — a "next step" is DEALORA's own inference about the workspace's records,
not an attested fact about an account — and `evidenceIds` / `claimIds` are
reference lists, never copies. Its gate is covered by
`tests/phase14-gate.test.ts`.

Phase 15 adds the Revenue Graph: the twelve relationships `ROADMAP.md` §22
names, read back as one graph per account and one per workspace. The graph is
**derived, never stored** — every node and edge is recomputed from the rows
Phases 5–13 already wrote, so this phase adds no table, no schema version and
no migration, and a `contested` downgrade removes the opportunity and its edges
from the very next read instead of leaving a stale "qualified" claim behind.

The vocabulary is published as a **partition**: the seven node kinds the loop
can actually produce (company, person, signal, evidence, opportunity,
conversation, meeting) plus five explicit refusals — campaign, customer,
revenue, agent, workflow — equal §22's twelve core relationship names
disjointly, each refusal carrying its reason and its owning phase in the policy
route. The opportunity node *is* the account's newest `qualified`
qualification: its own id, never a new row, and absent the moment a newer
evaluation says otherwise.

Every edge carries `derivedFrom` naming the exact rows the rule read, target
row last, so any relationship can be checked against storage without trusting
the graph itself; ordering is a total order (occurredAt, stage rank, id), so
identical rows always print the identical graph, pinned to
`revenue-graph-1.0.0`. The caller sends an account id and nothing else —
forged nodes, edges, an opportunity, a frontier and a rule version in the
request body are ignored — a workspace above 100 accounts is **refused rather
than truncated**, and the repository surface is `authorize` alone: no writer,
no actor, no recommender anywhere in the package. Its gate — trace one
opportunity's lifecycle through every stage of the revenue loop — is covered
by `tests/phase15-gate.test.ts`.

Phase 16 adds the Cost Engine: what each run cost, recorded as immutable
**cost facts** and read back as derived totals. `ROADMAP.md` §23's six
categories — llm, search, data, tool, infrastructure, execution — are a closed
vocabulary on an append-only `cost_events` row (schema v15), attributed
server-side to the session and to a **real execution of the same workspace**,
and every total, average and ratio is **derived on read**: there is no stored
aggregate anywhere, so a stale number cannot be served and a fact is never
rewritten to simplify a sum.

Money is whole minor units — never a float — divided with exact integer
arithmetic reported next to its remainder, one currency per workspace fixed by
the first fact, and a total that would leave the safe-integer range refuses
the answer instead of rounding it. An estimate that was later measured is
superseded per (execution, category), disclosed in full rather than counted
twice. A replayed idempotency key returns the same fact and a reused key
conflicts, while forged `createdBy`, `workspaceId` or `totalMinor` fields in
the request are ignored in favour of the session and the stored rows. The six
metrics of §23 are published as a **partition**: Cost / Prospect, Cost /
Qualified Opportunity and Cost / Meeting derive from rows Phases 5 and 13
already store, and Cost / Customer, Revenue / AI Cost and Revenue / Campaign
are refused with their reasons and owning phases. Its gate — an execution can
show estimated or measured cost, for every run kind this repository can
perform, with `workflow` refused by name until Phase 24 — is covered by
`tests/phase16-gate.test.ts`.

Next is **Phase 17 — Revenue Dashboard**.

| Source of truth | Purpose                        |
| --------------- | ------------------------------ |
| [`DEALORA_BLUEPRINT.md`](./DEALORA_BLUEPRINT.md) | Product architecture |
| [`ROADMAP.md`](./ROADMAP.md)                     | Implementation phases & gates |
| [`docs/`](./docs/)                               | Architecture decisions & docs index |

## Repository layout

```
apps/           Web / API applications (Phase 2+)
packages/       Shared TypeScript packages (built with project references)
  core/         Result types and cross-cutting helpers
  db/           Schema, repository, tenant-isolated persistence (Phases 1-8)
  auth/         Identity, sessions, server-side authentication (Phase 1)
  brain/        Business Brain domain, claim safety, agent context (Phase 2)
  goal/         Revenue Goal domain, validation, lifecycle, goal parsing (Phase 3)
  plan/         Revenue Plan compiler, provenance, validation, lifecycle (Phase 4)
  account/      Account & contact input, validation, dedup, CSV import (Phase 5)
  research/     Research requests, permitted-source providers, attributed findings (Phase 6)
  evidence/     Evidence, account claims, provenance, contradiction, supersession (Phase 7)
  qualification/ Qualification criteria, deterministic scoring, explainable results (Phase 8)
  personalization/ Evidence-backed draft rendering, warnings, determinism (Phase 9)
  approval/      Human approval of one exact draft version, audit trail (Phase 10)
  outbound/      One email channel behind a provider interface, opt-outs, delivery state (Phase 11)
  conversation/  Deterministic classification of inbound responses into an intent and a next action (Phase 12)
  meeting/       Booking state machine, calendar adapter boundary, preparation brief (Phase 13)
  nextaction/    Deterministic next-best-action engine over the whole revenue loop (Phase 14)
  revenuegraph/  Derived revenue graph: nodes, edges, lifecycle, policy (Phase 15)
  cost/          Immutable cost facts, derived totals and metrics, exact money (Phase 16)
  api/          Transport handlers and application-service wiring
agents/         Specialized agent definitions (Phase 18+)
integrations/   External system adapters (Phase 12+)
workflows/      Revenue workflow definitions (Phase 24+)
skills/         Reusable skill modules
examples/       Developer examples
tests/          Cross-package integration tests (Phase 1-16 gates)
docs/           Documentation and ADRs
scripts/        Development scripts
cli/            Developer CLI (Phase 26+)
```

Architecture decisions are recorded in [`docs/adr/`](./docs/adr/): the
toolchain ([0001](./docs/adr/0001-development-toolchain.md)), the Phase 1
foundation ([0002](./docs/adr/0002-phase-1-application-foundation.md)), the
Business Brain ([0003](./docs/adr/0003-business-brain.md)), the Revenue Goal
Engine ([0004](./docs/adr/0004-revenue-goal-engine.md)), and the Revenue Plan
Compiler ([0005](./docs/adr/0005-revenue-plan-compiler.md)), the Account
& Prospect Input layer
([0006](./docs/adr/0006-account-prospect-input.md)), the Research Engine
([0007](./docs/adr/0007-research-engine.md)), the Evidence System
([0008](./docs/adr/0008-evidence-system.md)), the Qualification Engine
([0009](./docs/adr/0009-qualification-engine.md)), the Approval Engine
([0010](./docs/adr/0010-approval-engine.md)), the First Outbound Integration
([0011](./docs/adr/0011-first-outbound-integration.md)), and the Conversation
Engine ([0012](./docs/adr/0012-conversation-engine.md)), the Meeting Workflow
([0013](./docs/adr/0013-meeting-workflow.md)), the Next Best Action Engine
([0014](./docs/adr/0014-next-best-action-engine.md)), and the Revenue Graph
([0015](./docs/adr/0015-revenue-graph.md)), and the Cost Engine
([0016](./docs/adr/0016-cost-engine.md)).

## Getting started

Prerequisites: [Bun](https://bun.sh) ≥ 1.1 and Node.js ≥ 22.

```sh
bun install        # install workspace dependencies
bun run check      # run every quality gate (lint, format, typecheck, test, build)
```

### Scripts

| Script                  | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `bun run lint`          | ESLint over the repository               |
| `bun run format`        | Prettier write (code only; markdown is hand-maintained) |
| `bun run format:check`  | Prettier verification                    |
| `bun run typecheck`     | Strict TypeScript project-reference check |
| `bun run test`          | Vitest test suite                        |
| `bun run test:watch`    | Vitest in watch mode                     |
| `bun run build`         | Build all packages (`tsc -b`)            |
| `bun run check`         | All gates, in CI order (`scripts/verify.sh`) |

## Contributing & security

- Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a pull request.
- Security policy and baseline constraints: [`SECURITY.md`](./SECURITY.md).
- Every push and pull request to `main` runs CI
  (install → lint → format check → typecheck → test → build).

## Environment configuration

Real environment values live in `.env` / `.env.local` and are **never
committed**; secrets are provisioned through the hosting environment. The
convention and the currently supported keys are documented in
[`CONTRIBUTING.md`](./CONTRIBUTING.md#environment-configuration).

The only key is `DB_DIR` — the directory the local store writes
`dealora.json` into (defaults to `packages/db/src/data`, which is
git-ignored). Phases 1-16 need no credential: passwords are hashed with
scrypt, goal parsing, plan compilation, account deduplication, research
normalization, evidence conversion, qualification scoring, draft rendering,
approval decisions and response classification are deterministic and take no
model provider, and no secret is
ever hardcoded or read at module scope. Phase 11 ships a **sandbox** outbound
provider that performs no network I/O; registering a real provider is an explicit
deployment decision whose keys must be documented here in the same commit that
introduces them. Phase 12 adds no key either: it classifies stored text with
declared rules and writes to the Phase 11 suppression list that already exists.
Phase 13 adds no key as well: it books through a sandbox calendar adapter that
performs no network I/O and reuses the Phase 11 suppression list for its opt-out
checks. Phase 14 adds no key and no provider: it reads stored rows and applies a
fixed rule set. Phase 15 adds none either: the graph is derived on read from
rows the earlier phases already store. Phase 16 adds no key and no provider:
recording a cost is a local append to the workspace's own store, and every
total is derived from those rows without touching the network.

## License

[MIT](./LICENSE) © blockora
