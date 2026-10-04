# ADR 0010 — Approval Engine: a persisted human decision about one exact version

- Status: Accepted
- Date: 2026-10-04
- Phase: ROADMAP.md Phase 10 (Approval Engine)

## Context

`ROADMAP.md` §17 asks Phase 10 to *create human control before consequential
actions*. It defines four risk levels — Level 0 read, Level 1 draft, **Level 2
external action** (`send message`, `update CRM`, `schedule event`), Level 3
high-impact action — and then names eight requirements: approval request,
approval status, approver, timestamp, action preview, rejection, expiration,
audit trail.

Its gate is one sentence: **no Level 2 or Level 3 production action may execute
without an appropriate policy or explicit approval.**

`DEALORA_BLUEPRINT.md` §17 assigns approval to a *human approval gate between
personalization and action*, and §12.6 makes the Approval Agent responsible for
"human approval gate, draft approval, action approval, risk level checks,
escalation rules". §20 records delivery and failures as first-class, and §55
lists *Human-in-the-loop approval* as an MVP feature.

Phases 0–8 delivered everything leading here and were each explicit that they
were not it. Phase 4's compiled plan carries an `approval` section and states
that approving a plan **never** approves external actions. Phase 8's
qualification documentation says it "approves nothing". Phase 9 introduced
`PersonalizedDraft` and documented it as *a document, not an action*: it carries
no recipient address, no channel, no provider and no send state, because
"the draft lifecycle that leads to a send begins in Phase 10".

Five questions had to be answered before any code was written.

1. **What is being approved — a draft, or a version of a draft?** A draft, or a
   version of a draft. Phase 9 made drafts immutable and versioned *precisely so
   this could be answered*: an approval that binds to "the draft" would silently
   come to mean "whatever that draft says now", which is not what a human agreed
   to. So the binding is the pair `(draftId, draftVersion)`, plus a digest of
   the exact content the reviewer was shown.
2. **Who is the approver?** The authenticated caller, always, taken from the
   session at the moment of the decision. Never a body field. If a client could
   name its own approver, the audit trail would record a fiction.
3. **Can anything other than a human produce an approval?** No. Not a score, not
   a threshold, not a timer, not a model. This is the hardest constraint in the
   phase and it had to be made structural rather than a matter of discipline.
4. **What happens when the request expires?** It closes. It does not approve.
   A timeout is an absence of a decision, and treating silence as consent is the
   failure mode the whole phase exists to prevent.
5. **Does Phase 10 send anything?** No. It authorizes a send; the send is Phase
   11, which must re-verify these records on its own. Giving Phase 10 a send
   path would let it grade its own homework.

## Decision

Add a `@dealora/approval` domain, two additive tables (schema v10), and eight
thin API handlers.

### Architecture

```
API handlers (translation only)
      ↓
ApprovalService (authorize, bind, re-verify, decide, audit)
      ↓
ApprovalRepository (interface) + draft reader + injectable clock
      ↓
JSON store (v10)
```

The domain depends on interfaces, never on the store, exactly as the plan,
research, evidence, account, qualification and personalization domains do. The
draft reader is deliberately narrow: identity, workspace, version, subject,
body, warnings and the renderer's context digest — enough to show a reviewer
what they are approving and to re-derive the preview digest, and nothing else.
It never sees the evidence behind a draft, never re-renders anything, and never
touches a provider.

### The risk vocabulary

Exactly the four levels `ROADMAP.md` §17 names, as a closed type reusing the
same strings Phase 3's `RevenueGoalApprovalPolicy.maxRiskLevel` already carried.
Phase 10 issues exactly one action kind, `send_message`, at exactly one level,
`level_2_external_action`. The vocabulary is carried now so a Level 3 action has
somewhere to go later without inventing a parallel scheme.

### The state machine

| Status               | Meaning                                   | Authorizes a send? |
| -------------------- | ----------------------------------------- | ------------------ |
| `pending`            | requested, no human decision yet          | **no**             |
| `approved`           | an explicit human decision, attributed and timestamped | **yes** |
| `rejected`           | an explicit human refusal, with a reason  | **no**             |
| `changes_requested`  | the reviewer wants different text         | **no**             |
| `cancelled`          | the requester withdrew it                 | **no**             |
| `expired`            | the deadline passed with no decision      | **no**             |

Exactly one state is a yes. `changes_requested` is terminal *for that version*
— a changed draft is a **new draft version**, and needs its own request. That is
the whole reason Phase 9 versions drafts immutably.

`cancelled` and `expired` are closures, not decisions: they carry no `decision`
and no `decidedBy`. `expired` shares its storage path with `cancelled` precisely
so neither can produce `approved`.

### Identity is server-derived, structurally

- `requestApproval` takes `draftId`, and optionally `draftVersion` and
  `expiresInDays`. There is no `approved`, `status`, `decision`, `decidedBy` or
  `decidedAt` option to pass.
- `recordDecision` takes `decision` and `reason` and nothing else. The reviewer
  is the session's user; the instant is the injected clock.
- Storage independently refuses to create a request that already carries a
  decision: `createApprovalRequest` writes `status: "pending"`, `decision: null`,
  `decidedBy: null`, `decidedAt: null` regardless of its input, and its input
  type `Omit`s those fields entirely.
- `decideApproval` and `closeApproval` both require `status === "pending"`, so
  no decision can be rewritten and no second decision can be recorded.

Two independent layers, because either alone would be a convention rather than a
guarantee.

### The preview digest, and why the decision re-derives it

`previewDigest` is an FNV-1a fingerprint over a canonical, key-sorted JSON of
`{draftId, draftVersion, subject, body}` — the same construction Phase 8 used
for `contextDigest`. It is recorded when the request is made, and **re-derived
at decision time**. A mismatch is refused as `PREVIEW_MISMATCH`.

This is what makes an approval mean *"I read this text"*. Without it, an
approval is a signature on a promise that the text stayed put. The digests are
the same construction on purpose: the Phase 11 send path re-derives the same
digest from the draft it is about to send, so "the text that was approved" and
"the text that was sent" are comparable by a value rather than by an assumption.

### Expiration is a deadline, not a decision

`expiresInDays` is an upper bound the caller may request (1–30). An expired
request is closed as `expired`, with an audit event recording *why* the closure
happened, and the caller is told to request approval again. There is no code path
from `expired` to `approved`, and the `describeApprovalPolicy` view states this
in data before any request exists.

### Rejection must say why

`rejected` and `changes_requested` require a non-empty reason. A refusal with no
stated reason is not auditable later, and it is the refusal most likely to be
disputed.

### What a reviewer sees

`previewApproval` returns the request plus the exact `subject`, `body` and
`warnings` of the bound version. `warnings` travels deliberately: what the
renderer *declined* to state — an unapproved price, a contested observation — is
part of what is being approved, and an approval that hid the warnings would not
be an informed one.

### Storage

Schema v10 adds `approval_requests` and `approval_request_events`. The request
binds `draft_id` + `draft_version` with a `draft_version > 0` CHECK, and
`preview_digest` is the fingerprint of the content. Identity columns
(`created_by`, `decided_by`, `decided_at`) are written by the server from the
session; there is no column a client can supply to name its own approver. Status,
decision, action kind and risk level are all CHECK-constrained to the closed
vocabularies above.

Events are **append-only**: there is no update or delete path, so the history of
a decision survives whatever happens to the request row. The migration is
additive like every step before it — a Phase 9 document gains two empty tables
and keeps every draft it already had, so a draft rendered before the upgrade can
still be put up for approval.

### Audit trail

Every state a request passes through writes one event: `requested`, `approved`,
`rejected`, `changes_requested`, `cancelled`, `expired`. Each names an
`actorUserId` and a `createdAt` from the server. `approvalHistory` returns them
oldest first.

The Phase 9 gate's expectation that "a claim can never be marked verified"
carries forward: there is no status on an event a client can write, no free-form
kind, and no path that records a decision the service did not take.

### API surface

Eight handlers, translation only:

| Handler                | Requirement it serves         |
| ---------------------- | ----------------------------- |
| `createApprovalRequest` | approval request              |
| `decideApprovalRequest` | approver, timestamp, rejection |
| `cancelApprovalRequest` | withdrawal                    |
| `getApprovalRequest`    | approval status               |
| `previewApprovalRequest`| action preview                |
| `listApprovalRequests`  | audit trail, filterable       |
| `approvalHistory`       | audit trail, per request      |
| `getApprovalPolicy`     | the refusals, as data         |

**There is no execute route.** An approval authorizes a send; the send is Phase
11, and it re-verifies these records independently before calling a provider.

The workspace always comes from the route and the identity always from the
session. `fromApprovalError` maps every domain code **explicitly**, never by
assertion: the four refusals that all mean "not decidable any more"
(`EXPIRED`, `PREVIEW_MISMATCH`, `INVALID_TRANSITION`, an already-`CONFLICT`ed
request) share `CONFLICT` and stay distinguishable through their messages and
details, because "you cannot decide this any more" and "the text you were shown
has changed" call for different fixes. `UNAVAILABLE` becomes `SERVER_ERROR` and
is never surfaced verbatim.

## Alternatives considered

- **Approve the draft, not the version.** Rejected: "the draft" would come to
  mean "whatever that draft says at the moment of the send", and a regenerated
  draft would inherit a human's yes for text they never read.
- **Store the approved text on the approval.** Rejected: a second copy of the
  message is a second thing to keep in sync. A digest plus an immutable
  reference keeps one text of record and still makes drift detectable.
- **Auto-approve above a confidence or qualification threshold.** Rejected
  outright: `ROADMAP.md` §17's gate is *explicit approval*, and Phase 8's own
  documentation says a score is a decision aid, not certainty. A threshold that
  approves is a threshold that can be tuned into approving anything.
- **Treat expiry as approval-by-default.** Rejected: silence is not consent, and
  the failure is invisible — it looks like a working feature.
- **Let the requester decide.** Rejected: separation of duties is the point of a
  gate. Phase 10 records *who* decided; it does not judge whether that was the
  right person, because no document in this repository defines that, and
  inventing it would be inventing policy.
- **Let a client name the approver or backdate the decision.** Rejected: the
  audit trail would record a fiction, which is worse than having none.
- **Add a workflow or escalation engine.** Rejected: `DEALORA_BLUEPRINT.md`
  §12.6 names escalation rules, but `ROADMAP.md` §17 does not, and inventing an
  escalation chain here would be building Phase 24's workflow early.
- **Have Phase 10 send.** Rejected: then Phase 10 would authorize its own action,
  and the independent re-verification Phase 11 depends on would not exist.
- **Let the decision be overwritten.** Rejected: a decision that can be rewritten
  is not a decision. `decideApproval` requires `pending` and returns `CONFLICT`
  otherwise.

## Consequences

- No Level 2 action can execute without a persisted, attributed, timestamped
  human decision about one exact version of the text to be sent — the gate,
  satisfied.
- "Who approved this, and when?" is answered from stored fields, not from a
  reconstruction, and the answer survives any later change because the trail is
  append-only.
- The preview digest means an approval cannot be recorded against content that
  moved underneath the decision.
- Expiry, cancellation, rejection and a change request all close the door without
  opening another one.
- A changed draft requires a new version and a new request, so review cannot be
  skipped by regenerating.
- Workspace isolation is enforced in the service and again in storage; a
  non-member is refused with `UNAUTHORIZED` at the tenant boundary, and a
  foreign request inside their own workspace is refused at the same boundary
  rather than confirmed to exist.
- Nothing is sent. Phase 10 makes a send *possible* and does not make one
  happen, which is why the Phase 9 and Phase 10 gates assert that recording an
  approval creates no outbound action at all.

## Limitations

- A send route does not exist here. An approval is a permission with no consumer
  until Phase 11, by design.
- Expiry is evaluated against an injected clock at decision time; there is no
  background job that closes a request the moment it lapses. A lapsed request is
  therefore still `pending` in storage until someone reads it — the *decision*
  is what refuses, so nothing is ever wrongly authorized, but the stored status
  can lag.
- "Should this reviewer be allowed to approve this?" is not modelled. The
  decision is recorded faithfully; no policy evaluates the reviewer's standing.
- `previewSubject` is a bounded one-line summary for listings. The full content a
  reviewer approves is the bound draft version, read through `previewApproval`.
- Single-process storage only, as in every prior phase. No queue, worker or
  coordination service was added.