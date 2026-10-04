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
**Phase 9 — Personalization Engine**, **Phase 10 — Approval Engine**, and
**Phase 11 — First Outbound Integration** (see [`ROADMAP.md`](./ROADMAP.md)).

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

Next is **Phase 12 — Conversation Engine**.

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
  api/          Transport handlers and application-service wiring
agents/         Specialized agent definitions (Phase 18+)
integrations/   External system adapters (Phase 12+)
workflows/      Revenue workflow definitions (Phase 24+)
skills/         Reusable skill modules
examples/       Developer examples
tests/          Cross-package integration tests (Phase 1-11 gates)
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
([0010](./docs/adr/0010-approval-engine.md)), and the First Outbound Integration
([0011](./docs/adr/0011-first-outbound-integration.md)).

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
git-ignored). Phases 1-11 need no credential: passwords are hashed with
scrypt, goal parsing, plan compilation, account deduplication, research
normalization, evidence conversion, qualification scoring, draft rendering and
approval decisions are deterministic and take no model provider, and no secret is
ever hardcoded or read at module scope. Phase 11 ships a **sandbox** outbound
provider that performs no network I/O; registering a real provider is an explicit
deployment decision whose keys must be documented here in the same commit that
introduces them.

## License

[MIT](./LICENSE) © blockora
