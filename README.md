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
**Phase 3 — Revenue Goal Engine**, and **Phase 4 — Revenue Plan Compiler**
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

Next is **Phase 5 — Account & Prospect Input**.

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
  db/           Schema, repository, tenant-isolated persistence (Phases 1-4)
  auth/         Identity, sessions, server-side authentication (Phase 1)
  brain/        Business Brain domain, claim safety, agent context (Phase 2)
  goal/         Revenue Goal domain, validation, lifecycle, goal parsing (Phase 3)
  plan/         Revenue Plan compiler, provenance, validation, lifecycle (Phase 4)
  api/          Transport handlers and application-service wiring
agents/         Specialized agent definitions (Phase 18+)
integrations/   External system adapters (Phase 11+)
workflows/      Revenue workflow definitions (Phase 24+)
skills/         Reusable skill modules
examples/       Developer examples
tests/          Cross-package integration tests (Phase 1-4 gates)
docs/           Documentation and ADRs
scripts/        Development scripts
cli/            Developer CLI (Phase 26+)
```

Architecture decisions are recorded in [`docs/adr/`](./docs/adr/): the
toolchain ([0001](./docs/adr/0001-development-toolchain.md)), the Phase 1
foundation ([0002](./docs/adr/0002-phase-1-application-foundation.md)), the
Business Brain ([0003](./docs/adr/0003-business-brain.md)), the Revenue Goal
Engine ([0004](./docs/adr/0004-revenue-goal-engine.md)), and the Revenue Plan
Compiler ([0005](./docs/adr/0005-revenue-plan-compiler.md)).

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
git-ignored). Phases 1-4 need no credential: passwords are hashed with
scrypt, goal parsing and plan compilation are deterministic and take no model
provider, and no secret is ever hardcoded or read at module scope.

## License

[MIT](./LICENSE) © blockora
