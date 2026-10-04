# ADR 0011 — First Outbound Integration: one channel, behind an interface, behind a human

- Status: Accepted
- Date: 2026-10-04
- Phase: ROADMAP.md Phase 11 (First Outbound Integration)

## Context

`ROADMAP.md` §18 asks Phase 11 to *enable one real, controlled external
communication workflow*. It says: **choose exactly one initial channel.** The
integration must support `Draft → Approval → Send → Delivery state → Response`.
Its requirements: OAuth/credential handling, permission scopes, rate limits,
send controls, opt-out protection, audit logging, failure states, retry policies.

Its critical rule is unambiguous: **do not build mass outreach infrastructure.
The first integration exists to prove the revenue loop.** Its gate is one
sentence: *a real approved message can be sent and its state can be observed.*

`DEALORA_BLUEPRINT.md` §20 specifies the messaging layer — channel adapters,
delivery status, retry, opt-out, unsubscribe — and §21 places human approval
between personalization and action. §55 lists *Outbound execution* as an MVP
feature. `ROADMAP.md` §5 (Development Principle) forbids beginning with "complex
autonomous outreach", "multi-channel mass outreach" and "dozens of integrations".

Phases 9 and 10 delivered the two halves of the loop and were each explicit that
they were not this. Phase 9 produced `PersonalizedDraft`, documented as *a
document, not an action*, with "the draft lifecycle that leads to a send begins
in Phase 10 (approval) and Phase 11 (outbound)". Phase 10 produced
`ApprovalRequest`, "authorizes a send; the send is Phase 11 and re-verifies
these records independently before calling a provider" — and shipped **no
execute route**.

Five questions had to be answered before any code was written.

1. **Which channel?** Email. It is the channel `OutboundChannel = "email"`
   already declared in `packages/db`, it is the lowest-credential of the
   candidates, and it is the one the revenue loop's first proof needs.
2. **Where does the authorization check live?** In the send path, and it must be
   **independent of the code that issued the approval**. If Phase 11 asked the
   Approval service "is this approved?", then "approved" would only ever mean
   "the phase that wrote the row still agrees with itself". So Phase 11
   re-derives the answer from the stored rows, itself, on every send.
3. **What happens when the provider fails?** The action records a failure with a
   closed failure code and **no** `sentAt`. Nothing else is possible: the
   schema constrains `sent_at` to a `sent` action, and only one storage method
   can write `sent`.
4. **Is a retry automatic?** No. Explicit, human-initiated, and capped. An
   automatic retry is a loop the gate never sees, and a permanently failing
   destination would be hammered forever.
5. **What does "real" mean here, with no outbound credential configured?** It
   means the *boundary* is real, and the transport is honestly declared. The
   shipped provider performs no network I/O, because no credential exists in
   this repository and a provider that pretended to deliver would make the
   gate unverifiable.

## Decision

Add a `@dealora/outbound` domain, three additive tables (schema v11), and ten
thin API handlers.

### Architecture

```
API handlers (translation only)
      ↓
OutboundService (verify, stage, send, record, suppress)
      ↓
OutboundRepository + approval verifier + draft reader + contact reader
                                              ↓
                                      ProviderRegistry → OutboundProvider
```

The domain depends on interfaces, never on the store or on any provider SDK. The
readers are narrow to the point of being auditable: a draft's identity, version,
addresses and digest; a contact's identity, address and status; an approval's
status, reviewer and version. The boundary cannot see evidence, claims,
credentials or anything else.

### The provider interface

```ts
interface OutboundProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<OutboundProviderResult>;
}
```

That is the entire contract, and it is small on purpose:

- It receives a **prepared message** — idempotency key, recipient, subject, body
  — and nothing else. No approval record, no workspace id, no action id it could
  act on. A provider that could see an approval could be talked into skipping one.
- It must report `accepted: true` **only** when it confirmed submission, and must
  return a closed failure code for every refusal.
- It must not retry on its own, hold the message for later, or invent a provider
  reference it was not given.

A provider that returns neither a confirmation nor a known refusal code has
confirmed nothing, and the service reads that as a failure. **Only an explicit
confirmation can produce `sent`.**

### The shipped provider is a sandbox, and says so

`SandboxEmailProvider` performs **no network I/O at all**: it accepts a message
and records it. It is the default because no outbound credential is configured
in this repository, and pretending otherwise would make the gate's central claim
unverifiable.

What it *does* prove is everything on DEALORA's side: that a message reaches a
provider only after a human approved that exact draft version, that the text
delivered is the text that was reviewed, and that a confirmation is what moves an
action to `sent`. It also **de-duplicates on the idempotency key**, exactly as a
real provider should, so a retry returns the original reference instead of
accepting a second copy.

A deployment supplies its own provider through the same interface. The send
boundary does not change, and `createDefaultHandlers` accepts an explicit list —
including an empty one, because "nothing configured" is a real, reachable
refusal rather than an accident of the environment.

### The verification chain, on every send

Nothing is trusted from staging. Each of these has a specific way the boundary
could otherwise be crossed:

| # | Check                          | The accident it prevents                                  |
| - | ------------------------------ | --------------------------------------------------------- |
| 1 | authenticated user             | a client naming its own identity                           |
| 2 | workspace authorization       | reaching another tenant's action                            |
| 3 | draft in this workspace        | one workspace's approval authorizing another's draft        |
| 4 | contact in this workspace      | sending to a foreign contact                               |
| 5 | **exact** draft version        | a regenerated draft inheriting an older version's approval |
| 6 | draft digest unchanged         | content that moved after approval                           |
| 7 | persisted approval for it      | a client-injected or fabricated approval                    |
| 8 | approval `approved`, attributed | a status with no reviewer or no instant                     |
| 9 | approval not expired           | a lapsed permission still being acted on                    |
| 10 | not already sent or cancelled | a duplicate message for one approval                        |
| 11 | attempt budget                 | a permanently failing destination being hammered             |
| 12 | deliverable destination        | a malformed address from a thin contact record              |
| 13 | recipient unchanged            | a stale address staged before an edit                        |
| 14 | **opt-out suppression**        | contacting someone who asked not to be                       |
| 15 | configured provider            | a send with nothing to send it                              |
| 16 | message body read from the draft | sending text other than what was reviewed                  |

Checks 5–9 are the independent re-derivation: the approval is read from storage
by this phase, not asked of Phase 10.

### Lifecycle, and what "sent" requires

| Status      | Meaning                                            | Reachable by                       |
| ----------- | -------------------------------------------------- | ---------------------------------- |
| `ready`     | staged, nothing sent yet                            | `stageOutbound`                    |
| `sending`   | a provider call is in flight                        | `recordOutboundAttempt`            |
| `sent`      | **the provider confirmed submission**               | `confirmOutboundSent` only         |
| `failed`    | the provider refused, or a pre-flight check refused | `recordOutboundFailure`            |
| `cancelled` | withdrawn before any send. Terminal                 | `cancelOutbound`                   |

Three properties make "sent" trustworthy:

1. **One writer.** `confirmOutboundSent` requires the action to be `sending` and
   is the only path to `sent`. No input can create a `sent` action, and staging
   writes `provider: null`, `status: "ready"`, `attemptCount: 0`.
2. **Schema-enforced.** `sent_at` is CHECK-constrained to `status = 'sent'`, so a
   failed attempt cannot carry a delivery timestamp even if a caller passes one.
3. **Failures are first-class.** A provider refusal, a thrown call and a
   malformed provider answer all record `failed` with a closed code and the
   provider's own words. `sending` is marked **before** the provider is called, so
   a process that dies mid-call leaves `sending` behind rather than a `ready`
   action that looks unsent.

### A pre-flight refusal is not an attempt

An opt-out is found *before* the provider is resolved. `recordOutboundFailure`
therefore also accepts a `ready` or `failed` action, and in that case leaves
`attempt_count` and `attempted_at` untouched — so the record continues to say
truthfully that no provider was ever called, and the attempt budget is not spent
on a send that never left the system. It does update the code and message,
because `failureCode` answers "why is this action not sent" and the newest reason
is the true one; the earlier provider failure is preserved in the append-only
event trail.

### Idempotency, at two levels

- **System level.** `findOutboundActionByApproval` returns the action already
  raised for an approval. Staging the same approval twice returns *that* action
  rather than creating a second one, and a `sent` action refuses a further send.
- **Provider level.** The idempotency key is derived from the action id, so it is
  stable across retries of the same send and different for every distinct action.
  The sandbox de-duplicates on it. This is what makes a retry safe even if the
  process crashes between the provider's confirmation and the local write.

### Retry policy

Explicit, human-initiated, capped at five attempts per action. A failed action is
`sendable`, so a retry is legitimate — but there is no automatic retry, no
background loop and no scheduler, so a retry can never become a run. Reaching the
cap refuses the send before the provider is reached at all.

### Opt-out protection

`OutboundSuppression` is permanent, attributed (`created_by`) and explained
(`reason`, which is required). Addresses are normalized to lower case and matched
that way, because an opt-out is a statement about a person, not about the casing
someone typed it in. Adding the same address twice returns the one record, so a
list that can grow two rows for one address is a list nobody can audit.

The list is **per workspace**: one tenant's opt-out never silences another's
sends, and neither tenant can read the other's list.

### Storage

Schema v11 adds `outbound_actions`, `outbound_events` and
`outbound_suppressions`. An action **references** the immutable draft version
(`draft_id` + `draft_version` + `draft_digest`) and the approval rather than
copying the text, so there is exactly one text of record and an action cannot
claim content a reviewer never saw. `approval_id` is a hard foreign key: an
action cannot exist without pointing at a persisted approval.

The migration is additive like every step before it — a Phase 10 document gains
three empty tables and keeps every approval it already had, so a draft approved
before the upgrade can still be sent afterwards. The upgrade adds no way to reach
`sent`, so it invalidates no approval.

### Audit trail

Append-only, and a failure is as durable as a success: `created`,
`send_attempted`, `sent`, `failed`, `cancelled`, each naming an `actorUserId` and
a server `createdAt`. "It says sent but nothing arrived" is exactly the question
this table exists to answer.

### API surface

Ten handlers, translation only:

| Handler                      | Requirement it serves   |
| ---------------------------- | ----------------------- |
| `createOutboundAction`       | send controls           |
| `sendOutboundAction`         | the gate: send          |
| `cancelOutboundAction`       | send controls           |
| `getOutboundAction`          | delivery state          |
| `listOutboundActions`        | audit logging           |
| `outboundActionHistory`      | audit logging           |
| `createOutboundSuppression`  | opt-out protection      |
| `listOutboundSuppressions`   | opt-out protection      |
| `getOutboundPolicy`          | rate limits and refusals, as data |

**`sendOutboundAction` takes no body at all.** There is no field through which a
client could supply an approval, a status, a provider, a recipient or a provider
result. The recipient is resolved from the contact record, the provider is the
one this deployment configured, and `sent` is written only from a provider
confirmation.

`fromOutboundError` maps every domain code **explicitly**, never by assertion.
The refusals with no code of their own in the Phase 1 vocabulary — `UNAPPROVED`,
`SUPPRESSED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_FAILED` — become `CONFLICT`, and
`UNAVAILABLE` becomes `SERVER_ERROR`. They stay distinguishable through their
messages and details, because "a human has not approved this" and "this person
must not be contacted" call for completely different actions; collapsing them
into one opaque conflict would make the second look like an ordinary retry.

### Rate limits

Rate limiting is **delegated to the provider**, and the boundary says so. A
`rate_limited` refusal is recorded as its own failure code with a capped attempt
budget, so a workspace that exhausts its budget is stopped by DEALORA rather than
by the provider's own backoff. No DEALORA-side rate limiter was built: it would
be a second, weaker mechanism in front of one that already exists, and it would
be mass-outreach infrastructure — the one thing §18's critical rule forbids.

## Alternatives considered

- **Integrate a real provider (SES, Postmark, SendGrid).** Rejected *for this
  commit*: no credential is configured in this repository, and a provider that
  pretended to deliver would make the gate's central claim unverifiable. The
  interface is the deliverable; a deployment supplies the adapter. A fabricated
  "delivery" would be worse than an honestly declared sandbox.
- **Ask the Approval service whether the approval is valid.** Rejected: that
  makes "approved" a self-assessment by the component that wrote it. Phase 11
  re-derives the answer from stored rows, independently.
- **Send directly at approval time.** Rejected: an approval would become a
  trigger rather than a permission, and the review would be pointless — the
  message would already be gone.
- **Add a queue and an automatic retry loop.** Rejected: autonomous sending is
  exactly what `ROADMAP.md` §18's critical rule forbids, and a retry loop is
  mass-outreach infrastructure wearing a reliability hat.
- **Copy the message body onto the action.** Rejected: a second copy of the text
  is a second thing to keep in sync. The action references the immutable version
  and carries its digest.
- **Let a failed send retry without a cap.** Rejected: a permanently invalid
  address would be retried forever. The cap stops it, and the refusal names the
  cause.
- **Check the opt-out list after calling the provider.** Rejected: opt-out
  protection that runs after a message leaves is not protection.
- **Build a DEALORA-side rate limiter.** Rejected: see above — a second, weaker
  mechanism in front of the provider's, and mass-outreach infrastructure.
- **Add more channels now (SMS, LinkedIn, WhatsApp).** Rejected: §18 says
  *exactly one initial channel*, and §5 forbids multi-channel mass outreach.
- **Let the caller supply the recipient.** Rejected: the recipient is a decision
  with real-world consequences, and it belongs to the contact record the workspace
  curated.

## Consequences

- A real approved message can be sent and its state observed — the gate,
  satisfied — with the delivered text asserted byte-for-byte against the text a
  human reviewed.
- Nothing leaves the system without a persisted human approval of that exact
  draft version, re-verified by a different component than the one that recorded
  it.
- "Sent" means the provider confirmed. A refusal, a thrown call or a malformed
  provider answer can never be recorded as a delivery, and the schema enforces it
  independently of the service.
- One approval yields at most one message, at both the system and the provider
  level, and a retry cannot become a second copy.
- Opt-outs are permanent, attributed, explained and checked before the provider
  is resolved.
- There is no scheduler, no queue, no worker and no retry loop, so no message can
  leave without an authenticated request asking for it.
- The transport is honestly declared: the shipped provider records what it
  accepted and performs no network I/O, and every delivery claim in the test
  suite means "the provider recorded it", never "DEALORA asserted it".

## Limitations

- **No real transport.** The shipped provider is a sandbox. A deployment must
  supply an adapter to actually deliver mail; nothing here has been proven
  against a live API.
- **No OAuth or credential handling yet.** §18 lists it as a requirement, and it
  is deliberately unimplemented here: credential handling belongs with the
  specific provider adapter, and inventing a generic OAuth layer for one channel
  would be building for a second one before the first works.
- **Rate limiting is the provider's**, with DEALORA's attempt cap as the only
  backstop (§18 lists it as a requirement; the honest implementation for one
  channel is the provider's own limiter plus a cap).
- **`Response` is out of scope.** §18's loop names it, and it is Phase 12
  (Conversation Engine). This phase ends at delivery state.
- **Single-process storage only**, as in every prior phase. A send is synchronous
  with the provider call; a process that dies mid-call leaves `sending` behind,
  which is visible and recoverable but not automatically cleaned up.
- **Address validation is conservative, not RFC 5322.** It guards against a
  malformed record; the provider remains the authority on deliverability, and its
  refusal is recorded as `invalid_recipient` rather than argued with.