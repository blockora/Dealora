# DEALORA documentation

Documentation index for the DEALORA repository. Keep documentation aligned with
the actual code — never document functionality that does not exist.

## Source of truth

| Document                       | Purpose                                              |
| ------------------------------ | ---------------------------------------------------- |
| `../DEALORA_BLUEPRINT.md`      | What DEALORA is (product architecture).              |
| `../ROADMAP.md`                | How DEALORA is implemented (phases and gates).       |
| `../README.md`                 | Repository overview and getting started.             |
| `../CONTRIBUTING.md`           | Development workflow and quality gates.              |
| `../SECURITY.md`               | Security constraints and vulnerability reporting.    |
| [csv-import.md](./csv-import.md) | Supported CSV columns, validation, duplicate policy and import results. |

## Architecture decisions

Important technical decisions are recorded as lightweight ADRs in
[`adr/`](./adr/). Each entry documents the problem, the decision, the
alternatives considered, and the consequences.

| ADR                                      | Decision                                |
| ---------------------------------------- | --------------------------------------- |
| [0001 — Development toolchain](./adr/0001-development-toolchain.md) | Bun workspaces, strict TypeScript, ESLint + Prettier, Vitest, GitHub Actions CI. |
| [0002 — Phase 1 application foundation](./adr/0002-phase-1-application-foundation.md) | `db` / `auth` / `api` packages, evolvable schema, scrypt credentials, opaque sessions, server-side workspace authorization. |
| [0003 — Business Brain](./adr/0003-business-brain.md) | `@dealora/brain` domain, single canonical company record, six workspace-scoped tables, additive migration, claim-approval safety, agent-facing `getBusinessContext`. |
| [0004 — Revenue Goal Engine](./adr/0004-revenue-goal-engine.md) | `@dealora/goal` domain, structured goal fields, provenance (explicit/inferred/assumption/unknown), deterministic replaceable `GoalParser`, validated lifecycle transitions, Business Brain references, goal history. |
| [0005 — Revenue Plan Compiler](./adr/0005-revenue-plan-compiler.md) | `@dealora/plan` domain, eleven typed strategy sections, statement provenance (fact/inference/assumption/recommendation/unknown), deterministic replaceable compiler, goal preconditions, per-goal versioning, plan approval separated from action approval. |
| [0006 — Account & Prospect Input](./adr/0006-account-prospect-input.md) | `@dealora/account` domain, input-not-evidence provenance (`manual`/`csv`/`approved_integration`), deterministic deduplication (normalized domain; account + normalized email), ambiguity preserved rather than merged, row-level CSV import with a per-row result, soft archive cascading to contacts, optional validated plan association. |
| [0007 — Research Engine](./adr/0007-research-engine.md) | `@dealora/research` domain, research requests over existing accounts, minimal `pending`/`running`/`completed`/`failed`/`cancelled` lifecycle, `ResearchProvider` boundary restricted to permitted sources (no scraping bypass), research findings that are **not** evidence, explicit `fact`/`inference`/`hypothesis`/`recommendation` labels, provenance and freshness bands, idempotent creation and retry, failures recorded rather than swallowed. |

## Conventions

- Phase status and the next required slice are tracked in `ROADMAP.md`;
  update the roadmap when a phase gate is met.
- New environment keys are documented in `CONTRIBUTING.md` as they are
  introduced by the corresponding phase; secrets are never committed.
- Phase status is summarized in `README.md`; when a phase gate is met, update
  both so the roadmap and the overview agree.
- Public module interfaces carry doc comments; decisions that shape the
  architecture get an ADR.
