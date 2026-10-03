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

Phase 1 needs no credential: passwords are hashed with scrypt and a per-user
salt, sessions are opaque random tokens, and the test suite runs without any
secret. Add new keys to this table in the same commit that introduces them.

Phases 1-7 add no further keys and require no LLM provider key: the Business
Brain, the Revenue Goal Engine, the Revenue Plan Compiler, the Account &
Prospect Input layer, the Research Engine and the Evidence System are
deterministic data layers. The Research Engine ships with one permitted provider
— the workspace's own account record — so no external source credential is
configured or read; registering an authorized API or a permitted public source
is an explicit deployment decision and its key must be documented here in the
same commit that introduces it. The Evidence System adds no key of its own: it
only cites sources the Research Engine already holds.

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
