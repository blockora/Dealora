# ADR 0012 — Conversation Engine: read the response, recommend the next step, change nothing else

- Status: Accepted
- Date: 2026-10-05
- Phase: ROADMAP.md Phase 12 (Conversation Engine)

## Context

`ROADMAP.md` §19 asks Phase 12 to *interpret inbound responses*. Its initial
classification is a closed list of ten states — Interested, Question, Pricing,
Objection, Not Now, Wrong Person, Unsubscribe, Positive Intent, Negative Intent,
Unknown. Its output is four things: **intent**, **confidence**,
**recommended next action**, and **whether human intervention is required**. Its
safety requirement is that a message indicating unsubscribe, negative intent, a
sensitive issue, uncertainty or an unusual request should stop or escalate
according to policy. Its gate is one sentence: *an inbound response can be
classified and converted into a next action.*

`DEALORA_BLUEPRINT.md` §18 (Conversation Agent) states the same ten states and
the same four outputs, and places this step in §6's core loop between
**TAKE APPROVED ACTION** and **UPDATE STATE**. `ROADMAP.md` §43 makes it an MVP
step: *Response Received → Response Classified*.

This is the first phase in the repository that ingests material DEALORA did not
author. Everything before it processed text DEALORA wrote (Phases 3–5), text a
permitted source returned (Phase 6), or a finding a human converted into
evidence (Phase 7). A prospect's reply is different in kind: it is a statement by
an **interested party** about a conversation in which they have an incentive to
be helpful to themselves.

Six questions had to be answered before any code was written.

1. **Where does an inbound message come from?** `ROADMAP.md` §19 asks for the
   *interpretation* of a response, not for the retrieval machinery. So a response
   is recorded by an authenticated user through the API. No webhook, no inbox
   poller, no OAuth flow: those are integration surface, they are not in this
   phase's scope, and inventing them would be building a later phase's
   speculative surface. The `InboundSource` vocabulary still admits
   `provider_ingest`, because a deployment may later wire an adapter across the
   Phase 11 provider boundary — but nothing in this repository can set it.
2. **Can a response become evidence?** No, and the storage layer is shaped so it
   cannot be made to. See "The boundaries this phase keeps" below.
3. **What is "the next action"?** A **recommendation**, and the strongest one in
   the vocabulary is `prepare_reply_for_approval` — a note to a person. No intent
   maps to "send a reply". Phase 10 is what makes a message leave the system and
   this phase does not get to skip it.
4. **Is the classification a model call?** No. Phases 3 to 11 are all
   deterministic, and a stored classification nobody can re-derive is worth very
   little when the question is "why did DEALORA read this as an objection". The
   classifier is rules, weights and closed vocabularies, and the rule version is
   stored on every record.
5. **What happens to an opt-out?** It is honoured immediately, without waiting for
   a human. Waiting for a human to honour an opt-out is how a workspace ends up
   mailing someone who asked it to stop. Every other outcome requires review.
6. **How is an opt-out enforced?** By writing to the **existing** Phase 11
   `outbound_suppressions` table, which the send path already checks before every
   provider call. There is no second mechanism that could drift from the first.

## Decision

A new domain package, `@dealora/conversation`, plus schema migration **v12**.

### Storage (schema v12, additive)

Three tables, none of which rewrites or re-states anything from Phases 1–11:

| Table                         | Holds                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| `inbound_messages`            | One response, stored **verbatim**, with its provenance.             |
| `conversation_classifications`| One immutable, versioned reading of one message.                    |
| `conversation_events`         | The append-only audit trail for that reading.                       |

`inbound_messages.outbound_action_id` is a hard foreign key, and the store
refuses to write a row unless that action is `sent`. A response to something
DEALORA never sent cannot exist. `contact_id` and `account_id` are **not**
caller-supplied: they are resolved server-side from the action, so a message can
never be filed against the wrong person.

Two safety invariants are CHECK-constrained in the schema *and* re-checked in the
store, so a bug in the classifier cannot quietly authorise contact:

- `human_intervention_required = false` is legal **only** for an `unsubscribe`.
- `suppressed = true` is legal **only** for an `unsubscribe`.

### The classifier

A pure function of the recorded text. No model, no randomness, no clock, no
storage, no network. Four properties, and how each is obtained:

1. **Safety wins.** `unsubscribe`, then `negative_intent`, then `wrong_person`
   outrank the scoring entirely. *"We are not interested, but what does it
   cost?"* reads as `negative_intent`, never as `pricing` — acting on the
   pricing reading would prepare a reply for approval to someone who just
   declined.
2. **Negation is handled.** `not interested` contains the phrase `interested`.
   Without a guard, the single most important sentence a prospect can send would
   be read as interest. Every phrase match is therefore checked for a negator in
   the two words before it, and a negated phrase does not fire. The reason
   string says so, because "you said `interested` and negated it" is
   materially different from "you never mentioned interest".
3. **Silence is not a signal.** Text matching nothing is `unknown`, with no
   score and no recommendation but holding it. Never a guess.
4. **Uncertainty escalates.** A safety signal can only *lower* confidence, never
   raise it, and every outcome except an opt-out sets
   `humanInterventionRequired`.

Ties are broken by declaration order over a closed, fixed list — never by array
position, for the reason Phase 8 learned the hard way: storage order is not a
property of the evidence.

### The boundaries this phase keeps

These are the negative space, and they are the design:

- **It cannot send.** There is no sender, provider, queue or timer in the package.
- **It cannot approve.** No method creates or decides an approval.
- **It cannot become evidence.** Nothing in the package writes to
  `accountClaims` or `evidence`. A prospect's own words are an interested
  party's claim; Phase 7 remains the only route, and it stays human-driven. The
  `inbound_messages` table deliberately carries no confidence, freshness or claim
  status, so there is no column in which "this is a verified fact" could be
  written by accident.
- **It cannot schedule.** Recording a response happens because an authenticated
  request asked for it.
- **It cannot act without a request.** The only effect it takes by itself is the
  opt-out suppression, and only for a response that said to stop.

### Classification is single-shot

One message is read once. A second classification for the same message is refused
with `CONFLICT` at the storage layer. Attaching two answers to one response is
precisely how an audit trail stops meaning anything.

## Alternatives considered

**A model-based classifier.** Rejected. It would be non-deterministic, so a
stored reading could not be re-derived later; it would introduce a credential and
an inference cost into a phase whose value is that its output is inspectable; and
`ROADMAP.md` Rule 9 forbids fabricating evidence while Rule 12 demands evaluation
criteria for every agent. A rules classifier with a stored version is auditable
in a way a model output is not.

**Automatic polling or a webhook for inbound mail.** Rejected as speculative
surface. `ROADMAP.md` §19 does not ask for it, and it would require an OAuth
flow and credential handling that are explicitly still **open** requirements from
Phase 11 (see ADR 0011). Recording the response through an authenticated route
keeps the phase testable without inventing an integration.

**Promoting a response to evidence automatically.** Rejected, and this is the
most important rejection in the ADR. "We just raised a Series B and now have 400
employees" is exactly the sentence that would make an automatic promotion
attractive, and exactly the sentence that must not become a fact: it is an
unverified assertion by a counterparty about their own company. Phase 7's
conversion path stays the only route, and it stays human-driven.

**Honouring every safety signal automatically, including negative intent.**
Rejected. Only an opt-out is automatic, because it is the one instruction that
becomes *more* urgent with delay. A negative response is escalated to a person,
not acted on — DEALORA does not get to decide that a prospect is unreachable.

**A second suppression list owned by this phase.** Rejected. The Phase 11 list is
already checked before every provider call; a second one would be a mechanism
that could disagree with the send path about who is blocked.

## Consequences

- The core loop now closes through **OBSERVE RESPONSE** (`DEALORA_BLUEPRINT.md`
  §6 step 7) and reaches **UPDATE STATE** (step 8) as a *recommendation*. Steps 9
  to 11 — measure, optimize, repeat — remain Phase 14 and later.
- The revenue loop is inspectable end to end: `tests/phases9-12-integration.test.ts`
  walks document → decision → delivery → response and asserts that reading a
  response creates no draft, no approval and no send.
- An opt-out recorded through this phase is enforced by the Phase 11 send path
  with no change to how sending behaves, and is visible in that phase's own
  `outbound_suppressions` table.
- A workspace that reads a reply can always answer "why did DEALORA read it that
  way" from the stored `reasons` and `signals`, without re-running anything.

## Open requirements — not implemented here

Recorded as open rather than as limitations, because an unimplemented requirement
that is filed as an accepted limitation is how an open item quietly becomes a
closed one (the lesson ADR 0011 had to learn about its own §18 items).

- **ROADMAP §18 OAuth / credential handling and provider permission scopes**
  remain open from Phase 11. They belong to the first real adapter, which does
  not exist in this repository, and Phase 12 does not need either.
- **Provider-side inbound retrieval.** No adapter fetches replies. A deployment
  that wires one records what it fetched and sets `source: "provider_ingest"`.
- **Objection Intelligence** (`DEALORA_BLUEPRINT.md` §19) is a later phase. An
  objection is classified and escalated here; no objection library, response
  pattern or guarantee is produced, and none is invented.
- **Follow-up decisions** (`DEALORA_BLUEPRINT.md` §20 — whether, when, what
  context, when to stop, when to escalate) are a later phase. Phase 12
  recommends a disposition and sets a flag; it schedules nothing.
- **Meeting workflow** (`ROADMAP.md` §13) is the next phase. A `positive_intent`
  is exactly the input it will need, and Phase 12 hands it over as a
  recommendation rather than acting on it.
