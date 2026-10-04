# ADR 0013 — Meeting Workflow: a measurable booking state, and a person in the loop before anything is scheduled

- Status: Accepted
- Date: 2026-10-20
- Phase: ROADMAP.md Phase 13 (Meeting Workflow)

## Context

`ROADMAP.md` §20 asks Phase 13 to *convert positive intent into a meeting
workflow*. The flow it names is:

```
Positive Intent → Qualification → Meeting Recommendation → Approval / Policy
              → Calendar Action → CRM Update → Meeting Brief
```

and its requirements are five words long: scheduling integration, meeting
recommendation, booking state, meeting metadata, meeting preparation. Its gate is
one sentence: *a qualified positive response can result in a measurable meeting
state.*

`DEALORA_BLUEPRINT.md` §21 (Meeting Agent) gives the same flow with one
difference — **Approved booking workflow** where the Roadmap says
**Approval / Policy**. §22 then lists what a brief contains before a meeting:
account overview, decision maker, relevant signals, known needs, conversation
history, potential objections, suggested questions, recommended next step.

Two words in that gate do the real work, and both are load-bearing:

- **qualified** — the response must have been read as positive, and the account
  must have passed Phase 8. Neither is something a caller may assert.
- **measurable** — a meeting is a record with a **state**, not an intention. A
  proposal nobody approved is not a meeting that happened.

Seven questions had to be answered before any code was written.

1. **What makes scheduling legal here?** `DEALORA_BLUEPRINT.md` §17 classifies
   actions by risk, and lists *schedule event* as a **Level 2 external action**:
   it "requires configurable approval or policy authorization". That single line
   decided the whole phase. A meeting cannot be booked by the system, by a
   schedule, or by a positive-sounding reply. It passes through a person's
   decision first, every time.
2. **Is the Phase 10 approval enough?** No. Phase 10's approval is bound to one
   exact *message draft* and its digest. A meeting is a different artifact with
   different content, so it needs its own authorization — but it reuses Phase 10's
   discipline exactly: a digest of the exact booking the reviewer was shown,
   re-derived at decision time, with the identity and the instant taken from the
   session in both the service and the storage layer.
3. **Where do bookings live?** A closed state machine with seven states, one
   table, and CHECK constraints that make the unsafe states unrepresentable. The
   two edges that would make booking autonomous — `recommended → booked` and
   `awaiting_approval → booked` — do not exist in the transition table at all.
4. **What is a scheduling integration, then?** `ROADMAP.md` §30 puts "CRM,
   calendar, email, Slack" integrations in **Phase 23**, explicitly "only after
   the core revenue loop works". So Phase 13 defines the `MeetingCalendarProvider`
   interface a real adapter will implement, and ships a **sandbox that performs
   no network I/O**, exactly as Phase 11 shipped a sandbox email provider. Every
   booking claim in this repository means *the provider recorded an event* —
   never *DEALORA asserted it*. The CRM update in the flow is Phase 23 too: the
   record exists, the connection does not.
5. **What goes in the brief?** Only records the workspace already has, quoted
   verbatim or referenced by id. **It never fills a gap.** Every §22 section
   without a record behind it is written into `gaps` rather than inferred, so a
   reader can tell "we know nothing about their decision process" apart from "we
   did not look". Storing the absence is the point.
6. **Can a meeting become evidence?** No. Nothing in this package writes
   `evidence` or `accountClaims`. A booked meeting is exactly what its owner
   supplied, not an attested fact about an account. Phase 7 stays the only route.
7. **Does booking send an invitation?** No. There is no mailer in this package.
   Phase 10's approval and Phase 11's send path still govern every message that
   leaves the system. A booked meeting is not an email.

## Decision

### The booking state machine

`MEETING_TRANSITIONS` in `packages/meeting/src/rules.ts` is the whole safety
property of this phase, stated once:

| From            | May become                        |
| --------------- | --------------------------------- |
| `recommended`   | `awaiting_approval`, `cancelled`  |
| `awaiting_approval` | `approved`, `cancelled`       |
| `approved`      | `booked`, `cancelled`             |
| `booked`        | `held`, `no_show`, `cancelled`    |
| `held`          | — terminal                        |
| `no_show`       | — terminal                        |
| `cancelled`     | — terminal                        |

Three consequences worth naming:

- **No single call reaches `approved` from `recommended`.** A person deciding to
  approve walks `awaiting_approval` on the way, and the audit trail records both
  the request and the answer. The state machine stays strict while the API stays
  usable.
- **`cancelled` is terminal.** A replayed approval cannot resurrect a meeting a
  person deliberately withdrew.
- **`held` and `no_show` are only reachable from `booked`.** A meeting that was
  never booked cannot be reported as having been held or missed.

### What storage re-checks

`packages/db/src/repository.ts` re-derives what the caller claims, so the domain
service is not the only thing standing between a conversation and a calendar:

- a meeting must point at a classification that read as `positive_intent` or
  `interested`, in the same workspace;
- it must point at a qualification in the state `qualified`;
- one response yields at most one meeting;
- a `booked`, `held` or `no_show` meeting must already carry an approval;
- a booked meeting cannot return to `approved`;
- a cancellation must record when **and** why.

The same invariants are CHECK-constrained in `SCHEMA`, so the declared DDL and
the write path agree — the document store does not enforce its own DDL, which is
exactly why the checks are written down in both places.

### What a client may send

A `classificationId`, the booking's own title and times, and a decision. That is
all. The account, contact, qualification, recommendation reason, state, approver,
approval instant, booked instant and provider reference are **all** derived
server-side or taken from the session. There is no route that accepts them, and
`tests/phase13-gate.test.ts` proves it by sending every one of them and asserting
that none of them changed.

### Where the opt-out is re-checked

Three times: when a meeting is proposed, when a person approves it, and again
when it is booked — always against the **existing Phase 11
`outbound_suppressions` list**. The second and third checks exist because an
opt-out can arrive in the gap between a proposal and a booking, and honouring it
late is the failure mode that matters. Reusing the same list rather than keeping
a second one is what makes an unsubscribe stop a booking as reliably as it stops
a send.

## Alternatives considered

**Reuse the Phase 10 approval table for bookings.** Rejected. Phase 10 binds an
approval to a message `draftId` and its digest. Forcing a calendar event through
that shape would mean either inventing a fake draft or loosening the invariant
that made Phase 10's approval mean "I read *this* text". A separate artifact
deserves a separate authorization with the same discipline.

**Let a positive response book the meeting.** Rejected, and it is the obvious
temptation: the prospect said yes, so why ask again? Because `DEALORA_BLUEPRINT.md`
§17 classifies scheduling as a Level 2 external action, and because a booking
reaches a real person's real calendar. Asking is the cheap failure; an unwanted
calendar entry is the expensive one.

**Build a live calendar integration now.** Rejected on scope, not effort.
`ROADMAP.md` §30 defers calendar and CRM integrations to Phase 23, and no
calendar credential exists in this repository. Inventing an OAuth flow would mean
inventing scopes we have no permission to grant — and the same open requirement
Phase 11 already recorded for email.

**Have the meeting send its own invitation.** Rejected. It would create a second
route to a person's inbox that did not pass Phase 10's approval and Phase 11's
send path. The booking is not the message.

**Let the brief fill empty sections with model-generated guesses.** Rejected. A
brief that invented a "relevant signal" would be indistinguishable from one that
read it from a source, and that difference is the entire value of the document.

**Add a "next best action" score to the brief.** Rejected as Phase 14. ROADMAP.md
§21 answers "what should happen next?" with a scored, evidence-backed
recommendation. Phase 13's brief reports what is known, names what is missing,
and stops.

## The boundaries this phase keeps

- **It never books on its own initiative.** There is no scheduler, no queue, no
  timer, no retry loop and no cron anywhere in the package.
- **It never sends.** No mailer, no invitation, no reminder.
- **It never contacts a suppressed address.** Checked three times, against the
  Phase 11 list.
- **It never turns a meeting, a brief or a response into evidence or a claim.**
- **It never connects to a live calendar or a CRM.** The shipped adapter is a
  sandbox with no network I/O.
- **It never invents a fact.** The brief reports and names its gaps.
- **It never resolves a conflict** between sources or between classifications.

## Open requirements

These are **open**, not limitations of this phase, and they are recorded here so
they are not mistaken for something this phase already does:

- `DEALORA_BLUEPRINT.md` §18's **OAuth and credential handling** and **provider
  permission scopes** remain unimplemented, carried forward from
  [ADR 0011](./0011-first-outbound-integration.md). Both belong to the first real
  adapter, which does not exist for email or for calendar.
- **`ROADMAP.md` §30's calendar and CRM integrations** are Phase 23. The
  interface is ready; the connection is not.
- **`DEALORA_BLUEPRINT.md` §22's "potential objections", "suggested questions"
  and "recommended next step"** are carried as named gaps rather than generated.
  Objection Intelligence is §19 (a later phase) and Next Best Action is §21.

## Consequences

- The repository can now answer, from stored rows: *why is this meeting on
  someone's calendar?* — which response proposed it, which account qualified it,
  who authorized it, and whether a provider confirmed it.
- `ROADMAP.md` §43's MVP chain advances to **Meeting Recommended → Meeting
  Recorded**, with the states recorded rather than asserted.
- The next phase (`ROADMAP.md` §21, Next Best Action) has a real booking state to
  reason about, and the gaps a brief reports are a natural starting inventory for
  it.
- A real calendar adapter becomes a drop-in registration against an interface
  that already exists, with no change to the booking boundary.