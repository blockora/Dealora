# ADR 0001 — Development toolchain

- Status: Accepted
- Date: 2026-10-02
- Phase: ROADMAP.md Phase 0 (Repository & Engineering Foundation)

## Context

The repository contained only the source-of-truth documents. ROADMAP.md Phase 0
requires establishing a package manager, monorepo structure, TypeScript
configuration, linting, formatting, a test framework, a build system,
environment configuration, development scripts, and a CI baseline before any
core product development may begin.

## Decision

- **Package manager / monorepo:** Bun with Bun workspaces (`packages/*`).
  `bun.lock` is committed and CI installs with `--frozen-lockfile`.
- **Language:** TypeScript in strict mode via a shared `tsconfig.base.json`
  (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`), using project references with a solution-style root
  `tsconfig.json`. The 6.x line is pinned because `typescript-eslint` does not
  yet support the TypeScript 7 API (typescript-eslint#10940); revisit when
  support lands.
- **Build:** `tsc -b` emits each package to `packages/<pkg>/dist`.
- **Lint:** ESLint 9 flat config with `typescript-eslint` (recommended rules).
- **Format:** Prettier. Markdown is excluded because the source-of-truth
  documents are hand-maintained.
- **Tests:** Vitest, with unit tests colocated as `src/**/*.test.ts`.
- **CI:** GitHub Actions running install → lint → format check → typecheck →
  test → build on pushes and pull requests to `main`.
- **Local verification:** `sh ./scripts/verify.sh` (also `bun run check`).

## Alternatives considered

- **npm / pnpm:** work, but Bun is the established runtime and package manager
  for this project; using one tool keeps installs and scripts uniform.
- **Turborepo / Nx:** add caching and task-graph features that a single
  package does not need yet; revisited if the workspace grows significantly.
- **Jest:** slower to configure for ESM/TypeScript; Vitest runs TypeScript
  directly with no transform pipeline to maintain.
- **Single root tsconfig without project references:** simpler today, but
  blocks per-package builds and publishing (SDK/CLI, ROADMAP Phase 26).

## Consequences

- Every package builds independently with `tsc -b`; type errors anywhere fail
  `bun run typecheck` and CI.
- Markdown files are not auto-formatted; authors follow the existing
  hand-maintained style.
- New workspace packages must be added to the root `tsconfig.json`
  `references` array.
- The Phase 0 gate (builds, tests execute, linting, typechecking, CI) is
  enforced locally via `scripts/verify.sh` and remotely via `.github/workflows/ci.yml`.
