# ADR 0018 — Agent System: a registry of declarations, and a promotion that waits for evidence

- Status: Accepted
- Date: 2026-10-26
- Phase: ROADMAP.md Phase 18 (Agent System)

## Context

`ROADMAP.md` §25 introduces the specialized agent layer. It names **twelve
agents** — Strategy, Market Intelligence, Account Research, Prospect Discovery,
Qualification, Personalization, Conversation, Follow-up, Meeting, CRM,
Analytics, Optimization — requires that *every production agent* declare
twelve fields (Agent ID, Version, Purpose, Inputs, Outputs, Tools, Permissions,
Memory Access, Approval Requirements, Cost Limits, Evaluation Metrics, Status),
and defines **seven** lifecycle states: Draft, Testing, Approved, Production,
Paused, Disabled, Archived.

`DEALORA_BLUEPRINT.md` §30 adds `owner` and `model` to that list, and §29
requires the governance layer around them. The gap between §25 and §26 is what
shaped this phase: §25 defines `Production` as a state, and §26 gates it —
*"Production agents require evaluation evidence"* — which Phase 19 produces.

Five questions had to be answered before any code was written.

1. **What does Phase 18 build — agents, or a registry of agents?** §25 says
   "Only after the core deterministic workflow works should the specialized
   agent layer expand". Every capability the twelve name is *already
   implemented* by Phases 3–16 as a deterministic engine. Building a second,
   agent-shaped implementation of any of them would create a second source of
   truth about qualification, personalization, replies or meetings. So each
   declaration carries an **`owner`** naming the phase that does that work, and
   a declaration *grants* a tool without *performing* it.
2. **Can an agent reach `production` in Phase 18?** No, and the refusal is the
   point. §26 makes production conditional on evidence that does not exist
   until Phase 19. So `production` is published vocabulary and an
   **unreachable transition**: the edge is listed so the machine is legible,
   and the engine refuses it by name. `usableStates` is empty, so **no agent
   can be used in any state** — the strongest statement this phase can make.
3. **Store the declarations, or version them as code?** Storing them would make
   the table a second copy of what an agent is, free to drift from the code
   that defines it. So the **only** stored state is
   `(workspace, agent) → lifecycle state`, plus an append-only governance trail.
   A declaration is versioned in `rules.ts`; the row cannot contradict it.
4. **A tool grant — is that a permission?** No. `AGENT_TOOLS` maps a grant name
   to the **phase that executes it**. An agent holding `send_message` has still
   sent nothing: Phase 10's approval and Phase 11's suppression decide. The
   `write_external` permission is published and granted to nobody, so a reviewer
   can see that it was withheld rather than infer it.
5. **Governance events, or run traces?** The event trail answers *"who moved
   this agent, when, and from what state to what"*. `ROADMAP.md` §27 (Phase 20)
   owns traces of agent behaviour, so **no run is recorded here** and there is
   no latency, token or tool-call field to record one.

## Decision

**A `@dealora/agent` domain that declares twelve agents and records what each
workspace has decided about them. It executes nothing.**

### The rule table (`rules.ts`)

Twelve declarations, each carrying **eleven** of §25's twelve fields — the
twelfth, `Status`, is per-workspace and lives in the registry row rather than
in the code — plus §30's `owner` and `model`. Closed vocabularies everywhere:

- **12 agent ids** in `AGENT_IDS`, which is also the registry's **total order** —
  every listing prints in roadmap order, so there is never a question about
  what "sorted by id" meant and no dependence on object key order.
- **7 states** in `AGENT_STATE_ORDER`.
- **A published transition table**, covering `draft → testing → approved`, the
  refused `approved → production`, the operational brake, and retirement into
  a terminal `archived`. Absent pairs are absences of permission: there is no
  `draft → production` shortcut, no transition into `draft`, and nothing leaves
  `archived`.
- **18 tools**, each naming the phase that executes it, and the exact three for
  which `approvalImplied` is true (`request_approval`, `send_message`,
  `book_meeting`). `write_evidence` is deliberately **not** one of them:
  evidence needs *provenance*, which Phase 7 enforces on every row, and
  conflating the two would claim an internal record needs a human sign-off when
  it needs a citable source.
- **13 evaluation metrics**, every one owned by **Phase 19**. Declared, never
  measured — which is what makes the promotion refusal checkable instead of
  aspirational.
- **8 memory layers**, declared and never opened.

Every declaration's `model` is `{ provider: null, model: null, temperature:
null }`, because every capability named here is owned by a deterministic engine
that uses no model. Naming a provider without calling one would be a
declaration the registry could not honour.

### The refusals, stated as rules

`AGENT_NEVER_DOES` is published in the policy route, so a reviewer reads the
negative space rather than inferring it: never executes, never calls a model or
reaches the network, never sends anything, never fabricates a capability, an
evaluation result or a trace, never promotes without Phase 19 evidence, never
crosses a workspace, never touches agent memory, never schedules itself.

### Persistence (schema v16, additive)

Two tables, both append-only in intent:

- `agent_registry` — one row per `(workspace, agent)` with
  `UNIQUE(workspace_id, agent_id)`, so the registry holds **decisions, not a
  log**. `CHECK` constraints pin `agent_id` to the twelve and `status` to the
  seven, so a row the service would refuse is unrepresentable in DDL too.
- `agent_registry_events` — the governance trail, with a CHECK over
  `registered | state_changed | archived`.

Migration v16 adds two empty tables and rewrites nothing: a Phase 16 document
gains them and keeps every cost event, account and user it already had.

The vocabularies are duplicated in `packages/db` on purpose — the database
package must not depend on a domain package — and the duplication is **caught
rather than prevented**: the agent package's test asserts every published id
and state appears in the DDL, so the two cannot diverge silently.

### Ordering

The registry is printed in `AGENT_IDS` order, so the ordering is a total order
over a constant table of unique ids.

The governance trail is sorted **newest first with a stable sort and no id
tiebreak**. Several decisions can land in the same millisecond — the store's
clock has millisecond resolution — and an id tiebreak would order them by a
*randomly generated* identifier, so the same decisions could print in different
orders on different runs. Ties keep the order storage returned them, which is
the order they were made.

### The API

Five routes, all workspace-scoped, all authorized against the session:

| Route | Behaviour |
|---|---|
| `GET /workspaces/:workspaceId/agents` | the whole registry — twelve entries, roadmap order |
| `GET /workspaces/:workspaceId/agents/:agentId` | one declaration and its current state |
| `POST /workspaces/:workspaceId/agents/:agentId/status` | record a lifecycle decision |
| `GET /workspaces/:workspaceId/agents/events` | the governance trail, optionally `?agentId=` |
| `GET /workspaces/:workspaceId/agents/policy` | the whole published rule set |

`fromAgentError` maps the domain vocabulary exhaustively; `UNAVAILABLE` — the
only code meaning an internal condition — becomes a generic `SERVER_ERROR`, so
storage internals never reach a client. `CONFLICT` keeps its meaning: an
unpublished transition is a conflict with the current state, not a bad request.

The status route is the only writer, and **the target state is the only value a
client supplies**. The prior state is read from the workspace's own row, the
actor is the authenticated caller, and both timestamps are the server's. A
forged `updatedBy`, `createdAt`, `workspaceId`, `actorUserId` or `kind` in the
body is ignored — proven in the handler tests by asserting the stored row
carries the session's identity and a server timestamp.

## Consequences

- An agent can be registered, reviewed and governed today, and **nothing can run
  today**. Promotion to `production` is refused with Phase 19 named as its
  owner, so this phase cannot admit an unmeasured agent to production.
- No agent is reachable from another phase's code: no runner, dispatcher, tool
  invoker or model client is exported. The API surface is `registry`,
  `describe`, `changeStatus`, `events` and `policy` — the last four of which are
  governance, and the first two of which read only registry rows.
- A workspace that decides nothing still gets a complete registry: twelve
  entries at `draft`, with no updater. "Nothing has been decided" is a state,
  not a gap.
- Phase 19 will add `"production"` to `MEETABLE_AGENT_STATES` when it has the
  evidence to justify it, and remove the `approved → production` refusal with
  its own ADR.
- The `crm` and `optimization` agents name **Phase 23** and **Phase 21** as
  their owners. They are declared because §25 names them; neither is
  implemented, and declaring one grants it nothing.