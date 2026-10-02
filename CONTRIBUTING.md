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
| `bun run typecheck`    | Strict TypeScript check (`tsc -b --noEmit`) |
| `bun run test`         | Vitest (`vitest run`)                      |
| `bun run test:watch`   | Vitest in watch mode                       |
| `bun run build`        | Build all packages (`tsc -b`)              |
| `bun run check`        | All gates in CI order (`scripts/verify.sh`) |

### Environment configuration

- Real environment values live in `.env` / `.env.local` and are provided by
  the host environment; they are **never committed**.
- Required keys are documented as they are introduced; secrets are provisioned
  through the hosting environment's secret store, not the repository.
- Never hardcode secrets, API keys, or tokens in source, tests, or fixtures.

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
