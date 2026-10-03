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

## Conventions

- Phase status and the next required slice are tracked in `ROADMAP.md`;
  update the roadmap when a phase gate is met.
- New environment keys are documented in `CONTRIBUTING.md` as they are
  introduced by the corresponding phase; secrets are never committed.
- Phase status is summarized in `README.md`; when a phase gate is met, update
  both so the roadmap and the overview agree.
- Public module interfaces carry doc comments; decisions that shape the
  architecture get an ADR.
