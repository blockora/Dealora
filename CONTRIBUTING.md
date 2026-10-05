# Contributing to DEALORA

Thanks for helping build DEALORA — an AI Revenue Operating System that turns a
revenue goal into an evidence-backed, permission-controlled, measurable and
continuously optimized revenue workflow.

## Before you start

1. Read [`DEALORA_BLUEPRINT.md`](./DEALORA_BLUEPRINT.md) — what DEALORA is.
2. Read [`ROADMAP.md`](./ROADMAP.md) — how it is implemented, in order.
3. Inspect the existing code before creating new abstractions; do not
   duplicate functionality.
4. Build only the next required slice for the current phase. Do not skip
   phases, and do not invent product behavior that the source-of-truth
   documents do not support.

## Development setup

Prerequisites: Bun ≥ 1.1, Node.js ≥ 22.

```sh
bun install     # install workspace dependencies
bun run check   # run every quality gate locally
```

### Scripts

| Command                | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| `bun run lint`         | ESLint (flat config, typescript-eslint)    |
| `bun run lint:fix`     | ESLint with autofix                        |
| `bun run format`       | Prettier write (code only)                 |
| `bun run format:check` | Prettier verification                      |
| `bun run typecheck`    | Strict TypeScript check of the whole workspace |
| `bun run test`         | Vitest (`vitest run -c vitest.workspace.ts`) |
| `bun run test:watch`   | Vitest in watch mode                       |
| `bun run build`        | Build all packages (`tsc -b`)              |
| `bun run check`        | All gates in CI order (`scripts/verify.sh`) |

`typecheck` and `build` both run `tsc -b tsconfig.json`. TypeScript 6 rejects
`--noEmit` in build mode when composite project references exist (TS6310), so
the typecheck gate uses build mode: `tsc` reports every type error and exits
non-zero. The second invocation in `verify.sh` is an incremental no-op thanks to
`.tsbuildinfo`.

Every workspace package must have a `tsconfig.json` **and** an entry in the root
`tsconfig.json` `references` array. A package missing from `references` is
silently skipped by both `tsc -b` and the typecheck gate.

### Environment configuration

- Real environment values live in `.env` / `.env.local` and are provided by
  the host environment; they are **never committed**.
- Required keys are documented as they are introduced; secrets are provisioned
  through the hosting environment's secret store, not the repository.
- Never hardcode secrets, API keys, or tokens in source, tests, or fixtures.

### Environment keys (Phase 1)

| Key      | Required | Purpose                                                                                          |
| -------- | -------- | ------------------------------------------------------------------------------------------------ |
| `DB_DIR` | No       | Directory the local store writes `dealora.json` into. Defaults to `packages/db/src/data` (git-ignored). |

Phases 2-11 add no keys. The table is intentionally short: see the phase notes
above for why the Personalization, Approval and Outbound engines all run
credential-free.

Phase 1 needs no credential: passwords are hashed with scrypt and a per-user
salt, sessions are opaque random tokens, and the test suite runs without any
secret. Add new keys to this table in the same commit that introduces them.

Phases 1-16 add no further keys and require no LLM provider key: the Business
Brain, the Revenue Goal Engine, the Revenue Plan Compiler, the Account &
Prospect Input layer, the Research Engine, the Evidence System, the
Qualification Engine, the Personalization Engine, the Approval Engine, the
Outbound Engine, the Conversation Engine, the Meeting Workflow, the Next Best
Action Engine and the Revenue Graph are deterministic data layers. The Meeting Workflow adds no key
either: it books through a **sandbox** calendar adapter that performs no network
I/O, and reuses the Phase 11 suppression list for its opt-out checks. The Next
Best Action Engine adds no key and no provider of any kind: it reads stored rows
and applies a fixed rule set, with no network I/O, so there is nothing to
configure. `ROADMAP.md` §30 places
live calendar and CRM integrations in Phase 23, so registering a real adapter is
an explicit deployment decision and its keys must be documented here in the same
commit that introduces them. The Research Engine ships
with one permitted provider — the workspace's own account record — so no
external source credential is configured or read; registering an authorized API
or a permitted public source is an explicit deployment decision and its key must
be documented here in the same commit that introduces it. The Evidence System
adds no key of its own: it only cites sources the Research Engine already holds.
The Qualification Engine adds no key either: it scores from the Business Brain
ICP, a Revenue Goal window and the evidence already stored, and calls no model
provider. The Personalization Engine renders deterministically from stored
records and calls nothing. The Approval Engine adds no key: a decision is
recorded from the session and the server's clock. The Conversation Engine adds no
key either: it classifies stored text with declared rules, calls nothing, and
writes to the suppression list that already exists.

The Outbound Engine is where a credential would first appear, and it is
deliberately not there yet. It ships **one** provider, `sandbox_email`, which
performs no network I/O and records what it accepted — so no outbound credential
is configured, read or required, and the test suite runs without any secret.
Registering a real provider is an explicit deployment decision: pass it to
`createDefaultHandlers({ outboundProviders: [...] })`, implement the narrow
`OutboundProvider` interface, and **document its keys in this table in the same
commit that introduces it**. The send boundary does not change when a provider is
substituted, and no provider may ever be given an approval record, a workspace
id or anything else that would let it skip a human decision.

## Quality gates

A change is not complete because the happy path works. Before opening a PR,
run `bun run check`, and confirm for non-trivial work:

- **Functional test** — unit tests for the new logic, including failure paths
  (invalid input, missing data, timeout, retry, duplicate execution, malformed
  model output, external API failure).
- **Permission test** — authorization and workspace isolation still enforced
  server-side.
- **Security check** — no secrets in the diff; least-privilege scopes; no
  platform restriction bypass.
- **Documentation** — update docs/ADRs when architecture or behavior changes.
  Never document functionality that does not exist.

### Boundaries that later phases must not cross

Phases 9-11 established a chain whose whole value is that each link is
verifiable. If you extend it, these properties have to keep holding, and a test
has to say so:

- **A draft is a document, not an action.** Generating content never authorizes
  content, and creating an approval creates no outbound action.
- **An approval is a permission, never a trigger.** Only an explicit, in-date
  human decision about one exact immutable draft version authorizes anything —
  never a score, a threshold, a timer or silence.
- **The consumer re-derives authorization, it does not ask the writer.** Phase 11
  reads the persisted approval rows itself. A new consumer must do the same
  rather than calling Phase 10 and believing it.
- **A failure is never a delivery.** Any new state that means "it went out" must
  be reachable from exactly one place, on a real confirmation, and the schema
  should constrain the timestamp so a failure cannot be mistaken for a success.
- **No client field describes the outcome.** Identity, provider, status, recipient
  and provider results are server-derived. If a new route accepts one of them in
  a body, it is a defect.
- **No mass surface.** One channel, no scheduler, no queue, no retry loop, no
  campaign or bulk concept. If a change adds one, it needs a new ADR.
- **A report is derived, never stored, and never estimates.** Phases 15 and 17
  read rows other phases wrote instead of keeping their own copy. A new
  reporting surface must do the same, and a metric with no backing row reports
  `no_data` with its owning phase rather than a zero — "nothing records this
  yet" and "this is worth nothing" are different claims, and only the first one
  is true here.
- **One owner per word.** If a later phase needs a number or an advice another
  phase already computes, it embeds that phase's answer whole instead of
  re-deriving it. Two definitions of a cost or a next step is how a product
  starts disagreeing with itself.
- **A declared capability is not an executed one.** Phase 18's twelve agents
  declare what they are and which phase owns each capability; none of them runs
  anything. If you add a runner, dispatcher, tool invoker or model client, you
  have crossed a boundary this repository has deliberately held — and an agent
  holding a tool grant has still earned nothing, because the tool's own phase
  re-derives authorization.
- **A lifecycle state is a decision, not a capability.** `approved → production`
  is gated on Phase 19's evaluation evidence, so no code may write `production`
  to reach a feature faster, and passing the gate still grants nothing an agent
  can *do* — `usableStates` stays empty until a later phase ships a runner. If a
  change needs that state, it needs the evidence Phase 19 exists to produce.
- **A governance event is not a trace.** The registry's event trail records who
  moved an agent and when. Runs, latency and tool calls belong to `ROADMAP.md`
  §27 (Phase 20); writing them here would duplicate that phase.
- **An observation is not an evaluation outcome.** A caller contributes a
  subject and either a judgement or a measured quantity. The rate, the total,
  the threshold comparison, the pass and the agent version are all derived from
  stored rows, and no column may be added that holds one of them. Absence is
  reported as `insufficient_evidence` with **no value** — never zero.
- **Declining to judge is not a pass.** `unobserved` stays in the denominator so
  an evaluator cannot raise a metric by not looking. If a new metric type needs
  a different treatment, say so in its rule-table rationale and test the
  boundary.
- **Staleness is expressed by supersession, not by a clock.** A fresh evaluation
  round supersedes the previous one. If a derivation starts reading
  `Date.now()`, the same stored rows will answer differently at different
  instants, which is the nondeterminism this repository has kept out since
  Phase 14.

## Phase 19 implementation and testing expectations

Agent evaluation is real production code over two real tables, so it is held to
the same bar as the phases before it. Specifically:

- **Thresholds live in one versioned table.** Every metric's kind, direction,
  threshold, minimum sample and rationale belong in `EVALUATION_METRICS`. If a
  bar moves, bump `EVALUATION_RULE_VERSION` in the same commit so a stored
  report keeps the version that judged it.
- **Rates are exact integers, not floats.** Basis points and cross-multiplication
  are what make "exactly at the threshold" a decidable fact. Do not reintroduce
  a division or an epsilon; a test at, one under and one over the threshold is
  the guard.
- **One number, one owner.** `cost`'s ceiling is the agent's declared
  `costLimits`, read from `@dealora/agent`. Do not restate it in
  `@dealora/evaluation` — a second copy is exactly the drift ADR 0017 warned
  about.
- **The gate fails closed everywhere.** No round, insufficient coverage, a
  failing metric, a superseded round, another version's evidence, another
  workspace's evidence and an unreadable store must all refuse, and each
  refusal should name what is missing. A storage failure must never resolve to
  *allowed*.
- **Judgements are append-only.** A changed opinion opens a new round. There is
  no update and no delete in the repository, and a test should fail if one
  appears.
- **The negative space is tested, not asserted in prose.** No runner, no model
  client, no network, no scheduler, no trace of a run, no usable state — the
  package test and the gate both check these, because a future change that
  quietly made an agent executable, or that stored a computed outcome in a
  column, would otherwise be invisible until it mattered.

The agent registry is real production code with a real table, so it is held to
the same bar as the phases before it. Specifically:

- **A declaration is versioned code.** Never store a declaration, and never add
  a stored field that restates one — a workspace stores only the lifecycle state
  it decided. A test should fail if a row starts describing what an agent *is*.
- **Vocabulary is closed at both layers.** The twelve ids and seven states are
  `CHECK` constraints in the schema as well as types in the domain. If you add
  an agent or a state, change the rule table, the DDL and the drift test in the
  same commit.
- **Total ordering, with the tiebreak chosen deliberately.** The registry prints
  in `AGENT_IDS` order. The event trail sorts newest first with a *stable* sort
  and no id tiebreak, because ids are generated and same-millisecond decisions
  would otherwise print in a different order on every run. Do not reintroduce
  an id tiebreak without a reason the tests can state.
- **Every read and write is workspace-scoped with the session's identity.** A
  test must cover the same-workspace success, the cross-workspace denial, a
  forged workspace id, and a forged attribution field in a body — and the
  forged-body case is asserted against the stored row, not against the
  response alone.
- **A refused transition writes nothing.** When the lifecycle refuses a move, no
  row and no event may be created, and the agent's prior state must be
  unchanged. Assert the full row-count snapshot, as Phase 17's dashboard tests
  do.
- **The negative space is tested, not asserted in prose.** No runner, no model
  client, no network, no scheduler, no memory read, and `usableStates` empty:
  the package test and the gate both check these over the real API, because a
  future change that quietly adds an execution path would otherwise be invisible
  until it ran.

## Phase 18 implementation and testing expectations

The agent registry is real production code with a real table, so it is held to
the same bar as the phases before it. Specifically:

- **A declaration is versioned code.** Never store a declaration, and never add
  a stored field that restates one — a workspace stores only the lifecycle state
  it decided. A test should fail if a row starts describing what an agent *is*.
- **Vocabulary is closed at both layers.** The twelve ids and seven states are
  `CHECK` constraints in the schema as well as types in the domain. If you add
  an agent or a state, change the rule table, the DDL and the drift test in the
  same commit.
- **Total ordering, with the tiebreak chosen deliberately.** The registry prints
  in `AGENT_IDS` order. The event trail sorts newest first with a *stable* sort
  and no id tiebreak, because ids are generated and same-millisecond decisions
  would otherwise print in a different order on every run. Do not reintroduce
  an id tiebreak without a reason the tests can state.
- **Every read and write is workspace-scoped with the session's identity.** A
  test must cover the same-workspace success, the cross-workspace denial, a
  forged workspace id, and a forged attribution field in a body — and the
  forged-body case is asserted against the stored row, not against the
  response alone.
- **A refused transition writes nothing.** When the lifecycle refuses a move, no
  row and no event may be created, and the agent's prior state must be
  unchanged. Assert the full row-count snapshot, as Phase 17's dashboard tests
  do.
- **The negative space is tested, not asserted in prose.** No runner, no model
  client, no network, no scheduler, no memory read, and `usableStates` empty:
  the package test and the gate both check these over the real API, because a
  future change that quietly adds an execution path would otherwise be invisible
  until it ran.

## Commit conventions

Small, focused commits (`ROADMAP.md` §48):

```
feat: add workspace foundation
feat: implement revenue goal model
feat: add evidence service
test: add approval policy coverage
fix: enforce workspace authorization
docs: update implementation notes
```

Avoid vague messages such as `update`, `changes`, or `misc`.
Never commit secrets, `.env` credentials, private keys, or generated sensitive
data.

## Branching

Use focused branches for substantial work and keep `main` buildable
(`ROADMAP.md` §49):

```
main
├── feat/foundation
├── feat/business-brain
├── feat/revenue-goal
└── …
```

## Pull requests

Use the pull request template. It enforces the quality gates, the security
review, failure handling, and documentation updates. CI
(`.github/workflows/ci.yml`) must pass: install → lint → format check →
typecheck → test → build.

## Definition of done

A phase slice is done only when it is implemented, tested, observable, secure
for its scope, documented, integrated into the product loop, and validated
against the phase gate (`ROADMAP.md` §56).
