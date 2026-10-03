# ADR 0008 — Evidence System: first-class, traceable, and never auto-resolved

- Status: Accepted
- Date: 2026-10-03
- Phase: ROADMAP.md Phase 7 (Evidence System)

## Context

`ROADMAP.md` §14 asks Phase 7 to *make evidence a first-class system rather
than text hidden inside prompts*, and lists the entity it wants:

```
Evidence
├── id
├── source
├── source_type
├── source_url
├── claim
├── claim_type
├── confidence
├── freshness
├── retrieved_at
├── relevance
└── related_entity
```

The requirements it names are: **evidence storage, evidence retrieval, evidence
linking, confidence, freshness, source attribution, audit trail**. Its gate is
one sentence: *generated claims can be traced back to evidence*.

`DEALORA_BLUEPRINT.md` §10 (Evidence Graph) calls evidence "a major DEALORA
differentiator" and says every externally-derived business claim should be
represented with evidence. §12.3 asks the Account Research Agent for an
"evidence-backed account brief". §84 lists "evidence over hallucination" and
"every important action must be auditable" as non-negotiable principles, and
`ROADMAP.md` Rule 9 says **never fabricate evidence**.

Phase 6 delivered the input this phase consumes and was deliberately explicit
that it was *not* evidence: `ResearchFinding` records observations with
attribution, and its own documentation says verification, linking and audit are
Phase 7's job. Phase 5 delivered user-supplied `Account` records, which are
user input rather than research.

Four conflicts had to be resolved before any code was written.

1. **The roadmap names a `claim` field on Evidence, but a claim is what evidence
   supports.** Modelling the claim as a text column on the evidence row would
   make "trace a claim back to its evidence" impossible: two sources supporting
   one assertion could not both be listed without either duplicating or
   overwriting the claim text. So `AccountClaim` is its own entity and Evidence
   references it. `related_entity` resolves to `accountId`, the entity the claim
   is about.
2. **`ROADMAP.md` lists both `source` and `source_type`.** These are not two
   facts; the distinction Phase 6 already established is between *which kind of
   permitted source* and *which provider or record*. `source_type` maps to
   `source` (the kind, constrained to `DEALORA_BLUEPRINT.md` §43) and `source`
   maps to `sourceName` (the provider). Nothing was invented to fill the pair.
3. **Phase 2 already owns a `Claim`.** Those are the business's own marketing
   statements with an approval status (`approved` / `unverified` /
   `restricted`) — internally authored and internally cleared. Phase 7's claim
   is an assertion about a company DEALORA does not own, derived from a permitted
   external source. Merging them would invert the trust direction and let an
   external observation be presented as an approved internal statement. They
   stay separate: table `account_claims`, type `AccountClaim`.
4. **`ROADMAP.md` defines no contradiction or supersession rules, but
   `DEALORA_BLUEPRINT.md` §10 makes evidence a graph and the audit principle
   requires history.** The explicit requirements (storage, retrieval, linking,
   attribution, audit) are the binding part; contradiction and supersession are
   the minimum needed to satisfy "audit trail" without ever destroying history.

## Decision

Add a `@dealora/evidence` domain, two additive tables (schema v7), ten thin API
handlers, and one controlled conversion path.

### Architecture

```
API handlers (translation only)
      ↓
EvidenceService (authorization, validation, lifecycles, contradiction, persistence)
      ↓
EvidenceRepository (interface)
      ↓
JSON store (v7)
```

The domain depends on an interface, never on the store directly, exactly as the
research and account domains do. Normalization, lifecycles, contradiction
detection and supersession are pure functions; the clock is injected.

### The four concepts, kept distinct

| Concept              | What it is                                              | Phase |
| -------------------- | ------------------------------------------------------- | ----- |
| **Research finding** | something obtained or observed during research          | 6     |
| **Account claim**    | a structured assertion about an external account        | 7     |
| **Evidence**         | a traceable, source-backed support for a claim          | 7     |
| **Qualification**    | a decision about whether an account fits the ICP        | 8     |

A finding says *this source observed this*. A claim says *this is the assertion*.
Evidence says *here is the source, the reference and the timestamps that support
it*. None of the three decides anything, and Phase 7 decides nothing at all.

### Provenance chain

```
Evidence ──▶ AccountClaim ──▶ ResearchFinding ──▶ ResearchRequest ──▶ Account
```

Walkable in both directions: `listClaimEvidence` answers the gate's sentence,
and `Evidence.researchFindingId` answers "where did this come from".

When the workspace supplied the source itself there is no research request and
**none is invented**. The record's `provenance` is `user_supplied`,
`researchFindingId` is `null`, and the source kind is fixed to `account_record`
— see below for why that field is not a caller choice.

### Evidence fields

The roadmap mapping is exact and complete:

| Roadmap field    | Field                            |
| ---------------- | -------------------------------- |
| `id`             | `id`                             |
| `source`         | `sourceName` — which provider or record stated it |
| `source_type`    | `source` — which permitted source kind (§43) |
| `source_url`     | `sourceUrl` — `null` when the source supplied no reference |
| `claim`          | `accountClaimId` → `AccountClaim.value` |
| `claim_type`     | `accountClaimId` → `AccountClaim.claimKind` |
| `confidence`     | `confidence`                     |
| `freshness`      | `freshness`                      |
| `retrieved_at`   | `retrievedAt`                    |
| `relevance`      | `relevance`                      |
| `related_entity` | `accountId` — the entity the claim is about |

Plus the provenance that makes the record auditable: `researchFindingId`,
`provenance`, `sourceTitle`, `observedAt`, `status`, `note`, `createdAt`,
`updatedAt`.

### Controlled conversion from a research finding

`createEvidenceFromFinding(workspaceId, userId, researchFindingId)` is the only
way research output becomes evidence, and the **only input is the finding id**:

1. the finding is loaded from storage under the caller's identity, so its
   workspace and account are facts rather than request-body claims;
2. the account is re-authorized, so a finding can never be used to write
   evidence into another tenant;
3. the finding's source, reference, title, timestamps, confidence, freshness,
   relevance and note are copied **verbatim**;
4. the claim is resolved by `(accountId, category, field)`, so repeated runs
   accumulate evidence against one assertion instead of minting rival claims.

A client cannot describe a finding. It cannot name an account that differs from
the finding's own, supply a `sourceUrl` the finding does not have, or attach a
finding from another workspace. A finding belonging to another tenant is
reported `NOT_FOUND`, not `UNAUTHORIZED`, so its existence is not revealed.

### Confidence, freshness, relevance

The Phase 6 bands are **reused, not redefined**. A confidence that means one
thing in research and another in evidence would make the two phases impossible
to compare, and parallel vocabularies are where a score would hide.

- **Confidence** (`low` / `medium` / `high`) describes the strength of a
  source's support for this statement. It is not an ICP, need-fit, buying-intent
  or opportunity score, and nothing in this phase sums or ranks it.
- **Freshness** (`unknown` / `fresh` / `recent` / `stale`) is temporal metadata
  derived from the observation age at retrieval (≤30 days fresh, ≤180 days
  recent, beyond that stale). A source that reported no observation date is
  `unknown`, never `fresh`: DEALORA will not claim currency it cannot see.
  Freshness is never a function of confidence — a high-confidence record with no
  date is still `unknown`.
- **Relevance** (`low` / `medium` / `high`) describes how directly the record
  relates to the claim context. It is metadata, not a ranking, and accounts are
  never ordered by it.

### `fact` still means "this source states this"

`claimKind` is unchanged from Phase 6 (`fact` / `inference` / `hypothesis` /
`recommendation`). `fact` means the cited source stated it. Nothing in Phase 7
verifies anything, so a claim can never be marked `verified` — that status does
not exist in the vocabulary, and the API rejects it as a validation error rather
than storing an unknown string.

### Claim lifecycle

```
asserted ──▶ contested    (a source-backed contradiction was recorded)
   └───────▶ retracted    (the workspace withdrew it — terminal)
```

`contested ──▶ asserted` is **deliberately absent**. A claim that has been
contradicted does not quietly become uncontested because a later source agreed
with it: resolving that is a judgement about which source to believe, and this
phase does not make judgements. The path forward is a fresh claim carrying its
own evidence.

### Evidence lifecycle

```
recorded ──▶ superseded     (the workspace named a replacement)
   ├───────▶ contradicted ──▶ superseded
   └───────▶ rejected            (the workspace rejected it as support)
```

`superseded` and `rejected` are terminal, and no record is ever deleted — a
status change is the whole mechanism, so the audit trail is preserved by
construction. `contradicted ──▶ recorded` does not exist: a contested record
cannot be un-contested by fiat with nothing to point at.

### Contradiction: represent, never resolve

Two records for the same account + category + field with **different values**
are a contradiction. Detection is automatic; resolution is not.

- Both records are marked `contradicted`. The arriving record is created already
  marked, so it never reads as an unopposed observation.
- The claim is marked `contested`. The claim's own `value` is **not** rewritten:
  the disagreement is recorded on the evidence, not resolved by editing the
  assertion.
- Each side keeps its own source, reference and timestamps. Nothing is
  overwritten and no winner is declared.
- **No timestamp is consulted.** A much newer observation contradicting an old
  one is a contradiction, not a supersession: "the newer source wins" is a rule
  this phase refuses to apply.

### Supersession: caller-directed, always named

`supersedeEvidence(oldId, userId, newId)` requires the workspace to name both
sides and requires them to support the **same claim**. It never compares
timestamps and never judges a value. The old record keeps its own value, source,
reference and timestamps, and stays readable — a superseded observation is
history, not a deletion. Setting `superseded` through the generic status
operation is refused, because that would record a supersession with nothing to
supersede it.

This is also the only edge out of `contradicted`. Resolving a conflict requires
naming a real replacement, which leaves both sides auditable.

### Source handling: no invented sources

- A source kind outside `DEALORA_BLUEPRINT.md` §43
  (`account_record` / `approved_api` / `public_web`) cannot be represented. There
  is no "unauthorized source" member to fall back to, and a finding carrying one
  is refused at conversion with `UNSUPPORTED_SOURCE`.
- A citation the source did not supply stays `null`. A reference that was
  supplied but is not a valid `http(s)` URL fails the record rather than being
  stored as something unusable. No URL is ever constructed from an account's
  domain.
- A `user_supplied` record's source kind is **fixed** to `account_record`. It
  cannot be stamped `approved_api` or `public_web`, because that would let any
  workspace manufacture evidence carrying the appearance of a source DEALORA has
  not read.

### Storage

Schema v7 adds `account_claims` and `evidence`, plus a `research_finding_id`
foreign key with `ON DELETE SET NULL` so a research record can never be the
reason an evidence record disappears. The migration is additive like every step
before it; migrations 1–6 are untouched, and a v6 document gains two empty
tables while keeping every research finding it already had.

Index/constraint notes: the canonical `indexes` block records only what the
query paths actually need (id, workspace, account, claim, status). The SQL
`CHECK` constraints pin the closed vocabularies at the storage layer too.

### API surface

Ten handlers, translation only:

| Handler                          | Requirement it serves          |
| -------------------------------- | ----------------------------- |
| `createEvidenceFromFinding`      | evidence storage + linking   |
| `recordUserEvidence`             | evidence storage (no research request) |
| `getEvidence`                    | evidence retrieval           |
| `listEvidence`                   | evidence retrieval + audit   |
| `changeEvidenceStatus`           | evidence status              |
| `supersedeEvidence`              | supersession                 |
| `getAccountClaim`                | claim retrieval              |
| `listAccountClaims`              | claim retrieval              |
| `listClaimEvidence`              | evidence linking (the gate)  |
| `changeAccountClaimStatus`       | claim lifecycle              |

No update/delete CRUD: an evidence record's source, value and timestamps are
what the source said, and rewriting them would destroy the provenance the record
exists to preserve. Only status changes are exposed.

The workspace always comes from the route and the identity always from the
session. A `workspaceId`, `userId`, `accountId` or `source` in a body is ignored.
`UNAVAILABLE` becomes `SERVER_ERROR`, `UNSUPPORTED_SOURCE` becomes
`VALIDATION_ERROR`, and `INVALID_TRANSITION` becomes `CONFLICT`.

## Alternatives considered

- **Store the claim as a text column on the evidence row.** Rejected: it makes
  "trace a claim back to its evidence" impossible without duplicating or
  overwriting the claim text.
- **Reuse the Phase 2 `claims` table.** Rejected: opposite trust direction —
  internally authored and approved versus externally sourced and unverified.
- **Add a first-class `Source` entity.** Rejected: `ROADMAP.md` §14 defines
  `source_type`/`source_url` as evidence fields, not as a separate entity. A
  source subsystem would be an invention, and the provenance the phase needs
  already travels with the evidence record.
- **Add a numeric confidence.** Rejected: DEALORA has no calibration data in this
  phase, so a number would be invented precision. The Phase 6 bands are reused
  verbatim.
- **Let a newer source win automatically.** Rejected outright: `DEALORA_BLUEPRINT.md`
  §84's "evidence over hallucination" and `ROADMAP.md`'s "never fabricate
  evidence" both require that a conflict stay visible. Automatic resolution
  would hide exactly what an audit trail exists to reveal.
- **Resolve contradictions with a model.** Rejected: no LLM truth resolution, no
  semantic search, no vector database. That is a different product decision and
  `ROADMAP.md` does not ask for it.
- **Let a caller supply the finding's source metadata.** Rejected: it would let
  any caller cite a URL the source never produced.
- **Delete superseded or rejected records.** Rejected: it would make the audit
  trail a fiction. Status changes only.

## Consequences

- A generated claim can be traced to its evidence, and that evidence to the
  research finding, request and account behind it — the gate, satisfied.
- Two sources that disagree are both preserved, both marked, and neither is
  declared true. The user can see the conflict and decide.
- History survives: superseded, contradicted and rejected records stay listable
  with their own sources and timestamps.
- Confidence, freshness and relevance are bands copied from Phase 6, not new
  scoring axes. There is no number anywhere in this phase to rank accounts with.
- The permitted-source question is settled once: only `account_record` can be
  self-attributed, and an external provider must be registered as in Phase 6.
- Workspace isolation is enforced in the service and again in storage, and
  another tenant's finding is reported as not found rather than unauthorized.
- Contradiction detection is keyed on `(accountId, category, field)`. A workspace
  that wants a different granularity — say, per-URL rather than per-field — would
  need a deliberate change to `claimKey`, which is deliberately a single function.
- Single-process storage only, as in every prior phase. No queue, worker or
  coordination service was added.

## Limitations

- The permitted evidence sources are exactly the Phase 6 permitted sources. Out
  of the box only the workspace's own account record is self-attributable.
- Contradiction detection is structural (same field, different value). It cannot
  detect a disagreement that lives inside one free-text value.
- `contested` claims stay contested. Re-asserting a value means creating a new
  claim, which is deliberate but does mean a workspace will accumulate claim
  rows over time.
- Confidence is a declared band, not a calibrated probability. Nothing measures
  how well these bands predict anything.
- No dedup beyond `(accountId, category, field)`: two genuinely different
  observations of the same field both land on one claim and are distinguished by
  status, not by separate claims.