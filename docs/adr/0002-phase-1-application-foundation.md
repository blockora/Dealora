# ADR 0002 — Phase 1 application foundation

- Status: Accepted
- Date: 2026-10-03
- Phase: ROADMAP.md Phase 1 (Application Foundation)

## Context

ROADMAP.md Phase 1 requires the minimum infrastructure for a real multi-tenant
SaaS product: authentication, user identity, workspace, organization/business
profile, database, API layer, application configuration, secure secrets
handling, and basic authorization — with a schema that can evolve without
destructive redesign.

The gate is explicit: a user must be able to sign up → create a workspace →
create a business profile → persist data → reload the application → see the
persisted workspace.

Two constraints shaped the design:

1. `SECURITY.md` and `ROADMAP.md` §44/§45 make tenant isolation,
   server-side authorization, and least privilege non-negotiable. A handler
   must never decide authorization on its own.
2. The gate has to be provable in CI, so the foundation must be executable and
   testable without external infrastructure.

## Decision

### Package layout

Three new workspace packages on top of the Phase 0 `@dealora/core`
(`Result` types and cross-cutting helpers):

- `@dealora/db` — schema, repository, and persistence.
- `@dealora/auth` — identity, sessions, server-side authentication.
- `@dealora/api` — transport handlers and the application service.

Tests resolve `@dealora/*` to `packages/*/src` through `vitest.workspace.ts`
aliases, so suites run against source without a build step.

### Schema

Four tables, defined once in `packages/db/src/schema.ts` as both domain types
and PostgreSQL-compatible DDL (`SCHEMA`):

```
User 1 ── * Workspace
User 1 ── * WorkspaceMember
Workspace 1 ── 1 BusinessProfile
```

Every table uses an `id` primary key, UTC `created_at`/`updated_at` instants,
and a `deleted_at` tombstone, so soft deletes and later column additions do not
require a redesign. `workspace_id` is the tenant boundary:
`business_profiles.workspace_id` is `UNIQUE`, and both `workspace_members`
foreign keys cascade on delete.

The Phase 1 entity list in the roadmap is larger, but the roadmap explicitly
allows not implementing every entity in Phase 1. Only `User`, `Workspace`,
`WorkspaceMember`, and `BusinessProfile` are modelled; the remaining entities
are introduced by the phase that owns them.

### Persistence and repository

`packages/db/src/repository.ts` provides a `Store` class that writes atomically
(temporary file plus replace) to a JSON document under `DB_DIR`, defaulting to
a git-ignored `packages/db/src/data/dealora.json`. `Store` accepts a seed
object so tests get isolated instances without filesystem setup.

Every repository method returns `Result<T, StorageError>` with a typed code
(`NOT_FOUND`, `CONFLICT`, `UNAUTHORIZED`, `INVALID`, `UNAVAILABLE`), matching
the Phase 0 rule that expected failures are values, not thrown errors. IDs are
generated server-side (`newId`) and never accepted from input.

`Store.authorize(workspaceId, userId)` is the single authorization primitive: it
returns the workspace when the caller is the owner or an accepted member, and
`UNAUTHORIZED` otherwise. `resolveWorkspace`, `workspaceOwner`,
`isWorkspaceOwner`, and `workspaceIsMember` are thin wrappers over the same
data, so no access path can bypass it.

### Authentication and sessions

- Passwords are hashed with scrypt and a per-user random salt
  (`salt:derived-hex`) and compared with `timingSafeEqual`. Plaintext is never
  persisted or logged.
- Session tokens are 32 random bytes encoded as base64url, with no internal
  structure and no user data embedded; verification is a store lookup, not a
  decoded payload.
- Sessions live in an injectable `SessionIndex` (`map` + `userIndex`), so a
  test can create and revoke sessions in isolation. `invalidateSession` and
  `destroyAllSessionsForUser` keep both indexes consistent.
- `assertSignedIn` and `requireOwnership` are the application-level guards;
  both throw the typed `AuthError`, which handlers translate into an
  `UNAUTHENTICATED`/`UNAUTHORIZED` response.

### API layer

Handlers contain only parsing and translation. They delegate to an application
service that performs every authorization step against the store, and each
authenticated handler resolves the session and calls
`app.authorize(workspaceId, userId)` before any read or write. Responses use a
single envelope, `ApiResponse<T>` (`{ status: "ok", data }` or
`{ status: "error", error }`), with an `ApiError` union for
`UNAUTHENTICATED`, `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`,
and `SERVER_ERROR`. `toUserSafe` strips `passwordHash` from every serialized
user.

Handlers cover signup, authenticate, list/create/get/update workspace,
create/get/update business profile, authorize, and `me`.

### Secrets

No credential is required in Phase 1 and none is hardcoded. The only key is
`DB_DIR`, documented in `CONTRIBUTING.md`. `.env` / `.env.local` remain
git-ignored.

## Alternatives considered

- **PostgreSQL with a real driver:** the target production store, but it makes
  the Phase 1 gate depend on provisioned infrastructure. The repository
  interface is the seam: the driver replaces `Store` without changing schema,
  auth, or authorization.
- **JWT / signed stateless tokens:** avoids session storage, but a token cannot
  be revoked before expiry and embeds claims that go stale. Opaque tokens plus
  a session index give immediate revocation and server-side truth.
- **bcrypt/argon2 instead of scrypt:** both are viable and are the likely
  upgrade if the cost parameters need tuning; scrypt ships in Node's standard
  library, so Phase 1 adds no native dependency.
- **Authorization logic in the handlers:** rejected. It is the exact pattern
  that produces client-trusted tenant checks; the handlers only translate.
- **Modelling every Phase 1 entity up front:** rejected per the roadmap's own
  allowance. Empty tables would be unmigratable guesses, not evolvable schema.

## Consequences

- The Phase 1 gate is provable in CI: `tests/phase1-gate.test.ts` runs signup →
  authentication → workspace → business profile → persistence → reload →
  cross-workspace denial, and `packages/db/src/repository.test.ts` and
  `packages/auth/src/credentials.test.ts` cover the unit-level behavior
  including password hashing, duplicate email, and least-privilege denial.
- Tenant isolation is enforced in one place (`Store.authorize`), so adding a
  Phase 2 entity means granting access through the same primitive.
- `Store` is a single-process JSON document: concurrent writers are not safe
  and the session index is in-memory, so sessions do not survive a restart.
  Both are accepted for the foundation and are the reason the database driver
  and session backing store are explicit follow-up work before production.
- Package exports stay flat (`@dealora/db`, `@dealora/auth`, `@dealora/api`);
  as the workspace grows, re-exports must not recreate circular dependencies
  between packages.