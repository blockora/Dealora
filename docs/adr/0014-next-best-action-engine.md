# ADR 0014 — Next Best Action Engine: a recommendation with its reasons attached, and a boundary that cannot act on it

- Status: Accepted
- Date: 2026-10-22
- Phase: ROADMAP.md Phase 14 (Next Best Action)

## Context

`ROADMAP.md` §21 asks Phase 14 to answer one question — *what should happen
next?* — with the example:

```
Account:            Acme
Current State:      Positive reply received
Recommended Action: Offer meeting
Reason:             High intent + strong ICP fit + explicit request
Confidence:         93%
```

and lists seven things every recommendation must include: **action, reason,
supporting state, evidence, confidence, expected outcome, approval requirement**.
Its gate is one sentence: *users can see the next recommended action for
meaningful revenue states.*

`DEALORA_BLUEPRINT.md` §25 says the same thing and adds the framing: DEALORA
"should constantly answer" the question. Phase 13 closed with an explicit note
that §22's "recommended next step" was *deferred to Phase 14*, so this phase is
the one that has to answer.

Six questions had to be answered before any code was written.

1. **What does "recommend" mean here — and what must it never mean?**
   `ROADMAP.md` §21's gate says *users can see* the recommendation. Nothing in
   the requirements says DEALORA may act on one. So the recommendation is advice,
   full stop: there is no sender, no approver, no calendar, no scheduler and no
   queue anywhere in `packages/nextaction`. The strongest thing a caller can do
   with a "send this now" recommendation is read it, and then call Phase 11 —
   which re-derives its own approval, digest and suppression check before it acts.
2. **Is "93%" something this repository can honestly produce?** No, and it is
   worth being explicit about why. [ADR 0009](./0009-qualification-engine.md)
   already settled that DEALORA's confidence is the **weakest band** among the
   records that produced it, because there is no calibration data here from which
   a number could mean anything. Summing, averaging or rescaling a band into a
   percentage would manufacture precision that does not exist. The blueprint's
   figure is read as a display illustration of the *shape* of the answer;
   `low | medium | high` is what ships, and a test asserts no percentage is ever
   emitted.
3. **How many states, and how do we know they are all reachable?** Eighteen,
   declared once in `NEXT_ACTION_RULES` as `[state, action]` pairs, with
   `NEXT_ACTION_STATES`, `NEXT_BEST_ACTION_KINDS` and `NEXT_ACTION_RISK_LEVELS`
   *derived* from that table rather than declared beside it. A published state no
   branch can emit is dead vocabulary, and Phase 13 was corrected for exactly
   that in commit `88f1f02`. Deriving the lists makes the drift impossible, and
   the schema's CHECK constraint lists the same eighteen strings for the same
   reason.
4. **Where does "approval requirement" come from?**
   `DEALORA_BLUEPRINT.md` §17. The level of an action is a property of the
   action, not of the recommendation, so `RISK_BY_ACTION` states it once and
   `approvalRequired` is **derived** as `riskLevel === "level_2_external_action"`
   — never decided separately. The schema CHECK-constrains the two to agree and
   `createNextBestAction` re-checks it on write, because a bug that labelled a
   Level 2 action as needing no approval is precisely the mistake that turns
   advice into an unattended outbound action.
   `level_3_high_impact` is **absent**: no branch recommends a financial
   commitment, a contract action or an irreversible change, and listing it would
   advertise a capability the engine does not have.
5. **Should the stored row be the answer?** No. `next_best_actions` is a
   **history of advice**: what DEALORA advised, and on what evidence, at which
   rule version. The *live* answer is recomputed from current rows on every read,
   so a workspace can never be shown a stale suggestion — and both questions stay
   answerable, because they are genuinely different questions.
6. **Can a recommendation become evidence?** No. A "next step" is DEALORA's own
   inference about the workspace's own records, not an attested fact about an
   account. Nothing in this phase writes `evidence` or `accountClaims`, and
   `evidenceIds` / `claimIds` are **reference lists** rather than copies, so a
   Phase 7 supersession recorded afterwards stays visible from the
   recommendation instead of being frozen into a duplicate of the evidence graph.

## Decision

### One rule table, and the order is the safety policy

`NEXT_ACTION_RULES` in `packages/nextaction/src/rules.ts` is the whole engine's
vocabulary and its precedence in one declaration. Evaluation is **first match
wins**, and the order is the design:

1. **`suppressed` → `stop_contacting`.** Safety first, unconditionally. An opt-out
   outranks every other consideration about that account, however attractive it
   looks. This mirrors Phase 12, where an opt-out beats a question asked in the
   same breath.
2. **A live meeting governs the account** — `meeting_approved` → `book_meeting`,
   `meeting_booked_without_brief` → `prepare_meeting_brief`, and
   `meeting_recommended` / `meeting_awaiting_approval` / `meeting_booked` /
   `meeting_closed` → `hold`. A meeting a person is already handling outranks
   anything DEALORA could suggest about the same account.
3. **`positive_response_without_meeting` → `propose_meeting`.** §25's own example.
   The strongest signal in the system, and it outranks the sourcing loop because
   an account that has already answered cannot usefully be sent back to research.
4. **The sourcing loop**, in the order it actually runs: research →
   `convert_findings_to_evidence` → `qualify_account` → `hold` if it did not
   qualify → `personalize_outreach` → `request_approval` → `hold` while a reviewer
   decides → `send_approved_message` → `hold` while a reply is outstanding →
   `prepare_reply_for_approval`.

`meeting_closed` is worth a note: a cancelled, held or missed meeting is a
decision a person already made, so DEALORA does **not** re-propose over the top
of it. That is why the state is reachable and why it resolves to `hold` rather
than falling through to the loop.

### The engine is a pure function

`decideNextActionState` and `recommendNextAction` in
`packages/nextaction/src/engine.ts` take one `AccountStateSnapshot` and return
one decision. No clock, no randomness, no model, no network, no store access. The
same rows always produce the same recommendation on any machine, in any order the
lists arrived in — which is what makes *"why did DEALORA recommend that?"* a
question the caller answers by reading the account's own rows.

The `switch` over Phase 13's `MeetingBookingState` in `meetingState` names every
state with **no `default`**, so adding a booking state to Phase 13 without
deciding what it means here is a compile error rather than a silent guess.

### Confidence: the weakest band, or a stored fact

Two cases, kept apart on purpose.

- When the branch rests on records that **carry** a band — the Phase 12
  classifier, the Phase 8 evaluation — the answer is the **weakest** of them, per
  ADR 0009. A strong classification resting on one `low` source is still resting
  on that source.
- When it rests on the **presence or absence of a stored record**, there is no
  inference to be weak about: "no approval exists" is a fact about the
  workspace's own storage, not a claim about an account. Those branches report
  `high` and say so in `confidenceReasons`.

### One narrow reader, resolved server-side

The engine's only collaborator is `AccountStateReader`, a single method that
answers "where does this account stand?". One method means the tenant boundary is
enforced in exactly one place.

The part worth being strict about is lineage. **Classifications do not carry an
account id**: they point at the outbound action that was answered, that action
points at a contact, and the contact points at the account. `createAccountStateReader`
walks classification → outbound action → contact → account and keeps only the
classifications that really belong to this account. Resolving it any other way
would let one account's reply look like another's, and a recommendation built on
that would be advice about the wrong company.

A read that *fails* returns `null` — never an empty account. Otherwise a storage
blip would make the engine recommend "research this" for an account that was
researched an hour ago.

### What a client may send

An account id. That is the entire input surface.

There is deliberately no `action`, `reason`, `confidence`, `riskLevel`,
`approvalRequired` or `expectedOutcome` on any input type: all six are §21's
*output*. Leaving them off is what makes it impossible for a handler to pass one
in by accident, and `tests/phase14-gate.test.ts` proves it by sending every one of
them and asserting that none of them changed the answer.

## Alternatives considered

**Let the engine act on a Level 2 recommendation.** Rejected, and it is the
obvious temptation: DEALORA knows the message is approved, so why not just send
it? Because "approved" was a decision about *one exact draft version*, recorded
before this recommendation existed; the engine has no way to know the draft has
not been superseded since, and Phase 11's send path already re-derives all of
that itself. Re-deriving it twice would create two places to disagree.

**Produce a confidence percentage.** Rejected on the same grounds as ADR 0009.
There is no calibration data in this repository, so `93%` would be a number with
no meaning attached — and it would look *more* trustworthy than a band, which is
strictly worse.

**Store the recommendation and serve it back.** Rejected. A stored answer goes
stale the moment an approval is declined or a reply arrives, and a stale "send
this now" is the most dangerous kind of wrong answer this system could give. The
stored row is kept as history; the live answer is recomputed.

**Make `level_3_high_impact` available.** Rejected. Nothing in the revenue loop
is a financial commitment or an irreversible change. A level nothing can reach is
advertising a capability that does not exist — the same mistake Phase 13's policy
was corrected for in `88f1f02`.

**Cite the account's evidence on every recommendation.** Rejected. A
recommendation grounded in a conversation rests on that conversation, not on the
account's fit profile. Citing evidence there would imply the records support a
statement about a reply they never saw. Branches with nothing to cite cite
nothing, and the integration test asserts exactly that for `propose_meeting`.

**Silently truncate a workspace-wide board.** Rejected. A caller handed 100 of
137 accounts would read the list as complete, and would be wrong about the set
that decides what gets worked on. Over the published cap the route **refuses**
and names the number.

## The boundaries this phase keeps

- **It never acts on a recommendation.** No sender, approver, calendar, scheduler
  or queue; no network I/O of any kind and no provider seam.
- **It never sends a message or schedules an event on its own.** Both are §17
  Level 2 external actions; they are named, never performed.
- **It never writes to the Phase 7 evidence graph.**
- **It never produces a confidence percentage.**
- **It never recommends contact for a suppressed address.**
- **It never invents a signal, a need, a decision maker or a next step.** Every
  clause of every reason names something the engine actually read, so the
  account's own rows are the check.
- **It never resolves a conflict** between sources or between classifications.

## Open requirements

These are **open**, not limitations of this phase:

- `DEALORA_BLUEPRINT.md` §26's **Optimization Engine** compares outcomes and
  learns from them. Nothing in Phase 14 consumes its own history; recording it is
  the seam a later phase will use.
- `ROADMAP.md` §22's **Revenue Graph** is Phase 15. This phase reads a
  per-account pipeline position and does not model cross-account dependencies,
  which is the honest scope for "what should happen next".
- `ROADMAP.md` §30's calendar and CRM integrations are Phase 23, and
  [ADR 0011](./0011-first-outbound-integration.md)'s OAuth and provider-scope
  requirements remain open for email and calendar alike.

## Consequences

- The repository can now answer, from stored rows and in one call: *what should
  happen next for this account, and why* — with the action, the reason, the
  supporting state, the evidence, the confidence band, the expected outcome and
  the approval requirement all as fields rather than prose.
- A workspace can ask the same question about every account it holds, and is
  **refused** rather than silently truncated when the answer would be too large.
- `ROADMAP.md` §21's seven required fields are enforced by a test at **every**
  state, not once at the end, because a field that appears only when convenient
  is not a contract.
- "What did DEALORA advise, and on what evidence?" stays answerable after the
  rules move on, because the advice history is immutable and carries its
  `ruleVersion`.
- The action surface is provably zero: recording a "send this now" recommendation
  adds exactly one advice row and touches no draft, approval, outbound action,
  meeting, claim or evidence record — asserted by a row-count delta in the gate.
