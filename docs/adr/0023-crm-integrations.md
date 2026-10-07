# ADR 0023 — CRM Integrations: a sync a person decided, through an interface no vendor owns

- Status: Accepted
- Date: 2026-10-07
- Phase: ROADMAP.md Phase 23 (CRM Integrations)

## Context

`ROADMAP.md` §30 in full:

> Only after the core revenue loop works.
>
> Potential systems:
>
> - CRM
> - calendar
> - email
> - Slack
> - GitHub
> - approved data providers
>
> Integration architecture must use clear permission scopes and standardized
> adapter interfaces.
>
> Do not hard-code the entire product around one vendor.

Two structural rules, one timing rule, one list — and nothing about what a
sync *is*, what it may carry, who decides, or what stands between a decision
and an execution. By Phase 22 the timing condition holds: the loop runs end
to end through goals, research, evidence, qualification, drafts, approvals,
sends, replies, meetings, cost facts, agents, traces, optimization and
experiments, and Phases 11 and 13 ship sandbox providers precisely because
§30 was still owed. `DEALORA_BLUEPRINT.md` §17 classifies *update CRM* as a
**Level 2 external action**, and §44 requires explicit permission scopes for
every external tool.

A CRM sync is also the first moment workspace data is destined to leave the
system, which invites every shortcut the rest of this repository refused:
sync more than was approved (including money), execute without a person, or
bend the product around one vendor's field names. So the question this ADR
answers is not *how do we integrate a CRM* but:

> **How does workspace data reach an external system only as a scoped,
> digest-bound, human-decided change-set — through an interface no vendor
> owns?**

Four decisions follow from that, and they shape everything else here.

## Decision

### 1. Scopes, systems and refusals are published data

The package boundary is `@dealora/integration`, and the two §30
requirements live in `rules.ts` as data with `INTEGRATION_RULE_VERSION`
(`integration-1.0.0`) riding on every derived result:

- **Clear permission scopes.** `INTEGRATION_SCOPE_CATALOG` is a closed
  catalog of exactly seven scopes (`contacts:read`, `contacts:write`,
  `activities:write`, `lifecycle:write`, `opportunities:write`,
  `notes:write`, `conversations:write`); a name outside it cannot be
  requested, granted or checked anywhere. `CRM_OPERATION_SCOPE` maps each
  of the six CRM operations (`upsert_contact`, `create_activity`,
  `update_lifecycle_stage`, `update_opportunity_status`, `attach_note`,
  `sync_conversation`) to exactly one scope, so the scope set a change-set
  needs is *computable* rather than asserted — a connection granting fewer
  scopes is refused before any adapter is resolved, and checked again at
  execution, because a grant can be revoked in between.
- **The six potential systems.** `INTEGRATION_SYSTEMS` publishes §30's
  list in the roadmap's own order — crm, calendar, email, slack, github,
  data_provider — whether or not this deployment has an adapter for one.
  A system with no adapter answers "not configured"; it never silently
  defaults to anything.
- **Refusals as data.** `INTEGRATION_REFUSALS` states the phase's negative
  space so a reader can check it without reading the implementation:
  `credentials` (no token, secret or OAuth artifact is stored anywhere —
  §18's OAuth requirement stays open for the first real adapter, per ADR
  0011), `opportunity_value` (no operation carries an amount or value
  field), `unapproved_sync` (Level 2: no change-set reaches an adapter
  without an explicit human decision, and no score, threshold or timer can
  approve one), `archived_accounts` (soft-deleted data is never
  synchronized), and `vendor_hard_coding` (resolution is by id only, see
  below).

One route publishes the whole policy through `describeIntegrationPolicy`,
so the catalog a test reads is the catalog the service enforces.

### 2. One standardized adapter interface, resolved by id only

`IntegrationAdapter` / `CrmChangeSetAdapter` is the standardized interface
§30 asks for. `createIntegrationRegistry` accepts any list of adapters,
and product code resolves an adapter **only by its id**: an unknown id
fails closed with "not configured" instead of falling back to a default
vendor, which is what makes the no-hard-coding rule structural rather than
aspirational. Registering an adapter is a deployment decision through the
wiring's `integrationAdapters` option — adding a real vendor is
configuration, not a code change.

The only CRM adapter shipped here is `SandboxCrmAdapter` (`sandbox_crm`,
`sandbox = true`), following the honest-default convention ADR 0011 and
ADR 0013 established: it performs **no network I/O** — it accepts a
change-set and records what it accepted. It de-duplicates on the
idempotency key (a re-applied key returns the original provider reference
rather than accepting a second copy, which is what makes a retry after a
failure safe) and offers an explicit test-driven `refuseNext()` so the
failure path runs against a real adapter rather than a weakened service.

### 3. The change-set is derived from stored rows and bound by a digest

`prepareCrmSync` derives the change-set from stored workspace rows under
published caps (`INTEGRATION_LIMITS`) — never from caller-supplied values —
skips archived accounts, and carries no monetary field of any kind. The
exact change-set plus its connection id is fingerprinted by
`changeSetDigest`: FNV-1a over key-sorted canonical JSON, the same
construction as Phase 10's preview digest and Phase 13's booking digest,
so it is a comparison fingerprint (not a security primitive) that is
stable across processes and recomputable by a reader.

That digest is re-derived at decision time — so "I approved *this* sync"
stays checkable, and forged `status`, digest, identity or timestamp fields
in a body are ignored — and re-derived again immediately before execution,
along with a fresh check of the connection's revocation state and scopes.
The lifecycle is the published `CRM_SYNC_STATUSES` order: `prepared →
approved | rejected | cancelled → executed | failed`. Only the adapter's
confirmation writes `executed`; an adapter refusal writes `failed` with one
of three closed failure codes and a safe idempotent retry. Storage is
schema **v20**: `integration_connections`, `crm_sync_requests` and an
append-only `crm_sync_events` trail — no update or delete of history.

### 4. Twelve workspace-scoped routes, cost attribution, and the boundary held

Twelve session-authenticated, workspace-scoped routes carry the flow —
policy and adapter publication, connect/disconnect, then prepare, read,
decide, execute, cancel and history for a sync — with identity and
instants derived from the session, never read from the body. Execution
writes its cost through **Phase 16's own** `cost_events` under one new
execution kind, `crm_sync`: no second cost table, no second total.

The boundary with Phase 22 is deliberately unchanged. Phase 23 ships **no
revenue and no opportunity-value recording** (`opportunity_value` is a
published refusal), so `revenue_per_arm` remains refused in the experiment
rules and `revenueImpactMinor` stays `null` — an integration phase is not
an excuse to invent a number the loop never recorded.

## Consequences

- **Scope is enforced twice, structurally.** A change-set whose derived
  scope set exceeds the connection's grants is refused before an adapter is
  resolved, and scopes and revocation are re-checked immediately before
  execution — a revoked grant stops a sync even after approval.
- **Every sync is attributable and replayable.** The approval is bound to
  the digest of the exact change-set the reviewer was shown, the trail is
  append-only, identity and instants are server-derived, and forged body
  fields are ignored — all asserted by the gate.
- **Determinism is checked, not claimed.** Deriving a change-set twice
  over the same rows is byte-identical, workspace isolation holds (a
  foreign workspace's rows never appear), and the gate snapshots the three
  integration tables to prove only integration rows are written by a sync.
- **The vendor seam is real.** Six systems are published today; one
  sandbox adapter exists; an unknown id fails closed; no product code
  contains a vendor's field vocabulary.
- **The honest limitation:** the shipped adapter performs no network I/O
  and no credential is stored anywhere, so "executed" here means *an
  approved change-set reached the registered adapter and its confirmation
  is what wrote `executed`* — never "DEALORA synced a real CRM". Five of
  the six systems have no adapter and answer "not configured", §18's
  OAuth/credential handling remains open for the first real adapter, and
  no amount of money is ever synchronized. Today's consumers are the gate
  (`tests/phase23-gate.test.ts`, sixteen tests) and the twelve wired API
  routes.
