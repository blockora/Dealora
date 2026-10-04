/**
 * The engine: stored rows in, one named revenue state out.
 *
 * This file is a **pure function of its input**. No clock, no randomness, no
 * model, no network, no store access. The same records always produce the same
 * state, on any machine, in any order the lists arrived in — which is what makes
 * "why did DEALORA recommend that?" a question the caller can answer by reading
 * the account's own rows rather than by re-running anything.
 *
 * It decides *where the account stands*. It does not decide what to do about it —
 * that is {@link NEXT_ACTION_RULES}, and keeping the two apart is what stops a
 * branch from quietly inventing a recommendation of its own.
 */

import { NEXT_ACTION_RULE_VERSION, RULE_BY_STATE, weakestConfidence } from "./rules.js";
import type {
  AccountClassificationSnapshot,
  AccountStateSnapshot,
  EntityId,
  NextActionRecommendation,
  NextBestActionState,
  ResearchConfidence,
} from "./types.js";

/**
 * Read the account's newest Phase 8 evaluation.
 *
 * The reader hands these over newest-first, matching the lineage Phase 8 stores:
 * re-evaluating inserts a new version, so "the newest" is the one a workspace
 * currently acts on.
 */
function latestQualification(state: AccountStateSnapshot) {
  return state.qualifications[0] ?? null;
}

/** The newest draft this account has, or `null`. */
function latestDraft(state: AccountStateSnapshot) {
  return state.drafts[0] ?? null;
}

/** The newest meeting, which is the one that governs. */
function latestMeeting(state: AccountStateSnapshot) {
  return state.meetings[0] ?? null;
}

/**
 * True when the Phase 11 send path is already blocked from contacting this
 * account.
 *
 * Reused rather than re-derived: a `failed` or `cancelled` outbound action is
 * **not** a suppression — those describe what happened to a send DEALORA was
 * allowed to make, and treating them as an opt-out would make the engine stop
 * recommending anything for an account whose messages merely bounced.
 */
function isSuppressed(state: AccountStateSnapshot): boolean {
  if (state.classifications.some((c) => c.suppressed)) return true;
  if (
    state.classifications.some((c) => c.intent === "unsubscribe" || c.intent === "negative_intent")
  ) {
    return true;
  }
  return false;
}

/** The newest classification, or `null`. */
function latestClassification(state: AccountStateSnapshot) {
  return state.classifications[0] ?? null;
}

/**
 * The account's positive response, if one exists.
 *
 * Only §18's `positive_intent` and `interested` count, and a suppressed
 * classification never does. This is the same pair Phase 13 uses for `MEETABLE_INTENTS`,
 * read here rather than re-declared, because "what counts as positive" must have
 * one answer: if the meeting engine and the recommendation engine disagreed about
 * it, DEALORA would propose meetings it will then refuse to create.
 */
function positiveClassification(state: AccountStateSnapshot): AccountClassificationSnapshot | null {
  const positive = state.classifications.find(
    (c) => (c.intent === "positive_intent" || c.intent === "interested") && !c.suppressed,
  );
  return positive ?? null;
}

/**
 * A response that is waiting on a person to read it.
 *
 * An objection, a deferral and a `wrong_person` routing all need a human; so does
 * a `question` or a `pricing` reply, because answering either means making a
 * commitment DEALORA is not authorized to make.
 *
 * Two intents are deliberately **absent**. `unknown` is excluded because DEALORA
 * could not say what the reply asked for, and recommending a reply to it would be
 * recommending a guess — Phase 12 already classifies it honestly, and Phase 14
 * does not paper over that. `negative_intent` is excluded because it never
 * reaches here: `isSuppressed` already caught it above, and listing it again
 * would be a clause the engine cannot execute.
 */
function needsReply(state: AccountStateSnapshot): boolean {
  return state.classifications.some(
    (c) =>
      !c.suppressed &&
      (c.intent === "question" ||
        c.intent === "pricing" ||
        c.intent === "objection" ||
        c.intent === "not_now" ||
        c.intent === "wrong_person"),
  );
}

/**
 * Which meeting state governs this account, if one does.
 *
 * Terminal states (`held`, `no_show`, `cancelled`) resolve to `meeting_closed`
 * rather than falling through to the sourcing loop. A person already decided how
 * that meeting went, and re-proposing over the top of their decision is not
 * DEALORA's call — the honest recommendation is to wait for a person to decide
 * whether to re-engage at all. It also makes `meeting_closed` a state the engine
 * can genuinely reach, rather than a name with no branch behind it.
 *
 * Every Phase 13 booking state is named, with no `default`: adding a state to
 * Phase 13 without deciding what it means here is a compile error, not a silent
 * guess.
 */
function meetingState(state: AccountStateSnapshot): NextBestActionState | null {
  const meeting = latestMeeting(state);
  if (meeting === null) return null;
  switch (meeting.state) {
    case "held":
    case "no_show":
    case "cancelled":
      return "meeting_closed";
    case "approved":
      return "meeting_approved";
    case "booked":
      return (state.meetingBriefCounts.get(meeting.id) ?? 0) > 0
        ? "meeting_booked"
        : "meeting_booked_without_brief";
    case "recommended":
      return "meeting_recommended";
    case "awaiting_approval":
      return "meeting_awaiting_approval";
  }
}

/**
 * The sourcing-loop state, walked in the order the loop actually runs.
 *
 * Kept separate from {@link meetingState} and the safety check so the precedence
 * is readable: safety, then whatever a person is already handling, then the loop.
 */
function loopState(state: AccountStateSnapshot): NextBestActionState {
  // A positive response is the strongest signal the system has, and it is the one
  // §25's own example turns on. It outranks the loop because an account that has
  // already answered cannot usefully be sent back to research.
  const positive = positiveClassification(state);
  if (positive !== null && state.meetings.length === 0) {
    return "positive_response_without_meeting";
  }

  if (state.researchRequests.length === 0) return "no_research";
  if (state.findings.length > 0 && state.evidence.length === 0) {
    return "researched_without_evidence";
  }

  const qualification = latestQualification(state);
  if (qualification === null) {
    // Evidence is the only thing that can be evaluated. An account with none has
    // nothing to qualify against, so the loop says so rather than pretending a
    // research failure was a decision.
    return "evidenced_without_qualification";
  }
  if (qualification.state !== "qualified") return "not_qualified";

  const draft = latestDraft(state);
  if (draft === null) return "qualified_without_draft";

  const approvalsForDraft = state.approvals.filter((a) => a.draftId === draft.id);
  if (approvalsForDraft.length === 0) return "drafted_without_approval";
  if (approvalsForDraft.some((a) => a.status === "pending")) return "approval_pending";

  const approved = approvalsForDraft.find((a) => a.status === "approved");
  if (approved !== undefined) {
    const sent = state.outboundActions.some((o) => o.draftId === draft.id && o.status === "sent");
    if (!sent) return "approved_without_send";
    // Something went out under this approval. Whether a response has come back
    // is the next question, and only the response itself can answer it.
    return needsReply(state) ? "response_needing_reply" : "awaiting_response";
  }

  // Every approval raised for the draft was rejected, changed, cancelled or
  // expired. None of those is a yes, so the draft is waiting on a person to look
  // at it again — and DEALORA must not answer that question for them.
  return "approval_pending";
}

/**
 * Decide which revenue state an account is in.
 *
 * Three steps, always in this order:
 *
 * 1. **Safety.** A suppression outranks everything, including an account that
 *    would otherwise be mid-loop and attractive. This mirrors Phase 12, where an
 *    opt-out beats a question asked in the same breath.
 * 2. **A meeting in flight.** A live Phase 13 booking governs the account until
 *    it reaches a terminal state.
 * 3. **The sourcing loop**, from a positive response down to waiting on a reply.
 *
 * Exactly one of the eighteen states comes back, and every one of them is a
 * condition this file can actually observe.
 */
export function decideNextActionState(state: AccountStateSnapshot): NextBestActionState {
  if (isSuppressed(state)) return "suppressed";
  const meeting = meetingState(state);
  if (meeting !== null) return meeting;
  return loopState(state);
}

/**
 * The clause that explains *why* a state applies.
 *
 * Every clause names something the engine read — a count, a status, an intent —
 * so a reason can be checked against the account's own rows. None of them asserts
 * anything about the account that the workspace's records do not support.
 */
function reasonFor(
  supportingState: NextBestActionState,
  state: AccountStateSnapshot,
): { reason: string; confidenceReasons: string[] } {
  const qualification = latestQualification(state);
  const meeting = latestMeeting(state);
  const classification = latestClassification(state);

  switch (supportingState) {
    case "suppressed": {
      const optedOut = state.classifications.find((c) => c.suppressed);
      const refused = state.classifications.find(
        (c) => !c.suppressed && (c.intent === "unsubscribe" || c.intent === "negative_intent"),
      );
      const reason =
        optedOut !== undefined
          ? `a Phase 12 classification already put this account's address on the Phase 11 opt-out list, so nothing may be sent to it`
          : refused !== undefined
            ? `the newest classified response was read as ${refused.intent}, which DEALORA treats as a stop signal, so nothing may be sent`
            : "the account's address is on the suppression list, so nothing may be sent to it";
      return {
        reason,
        confidenceReasons: [
          "the opt-out is a stored record rather than an inference, so the band is high",
        ],
      };
    }
    case "meeting_approved":
      return {
        reason: `a person approved the booking "${meeting === null ? "" : meeting.id}" and it has not reached a calendar; scheduling is a Level 2 external action, so it still waits`,
        confidenceReasons: [
          "the approval is a stored Phase 10 decision",
          "the booking state is a stored Phase 13 record",
        ],
      };
    case "meeting_booked_without_brief":
      return {
        reason: `the booking is on the calendar and no Phase 13 preparation brief exists for it, so §22's brief has nothing assembled yet`,
        confidenceReasons: [
          "the booking is a stored Phase 13 record",
          "the absence of a brief is a fact about storage",
        ],
      };
    case "meeting_recommended":
      return {
        reason: `a meeting has been proposed and is still in the state "recommended", which means no one has requested an approval for it`,
        confidenceReasons: ["the proposal is a stored Phase 13 record"],
      };
    case "meeting_awaiting_approval":
      return {
        reason: `the booking is waiting on a person's approval decision, and DEALORA does not answer that question for them`,
        confidenceReasons: ["the booking state is a stored Phase 13 record"],
      };
    case "meeting_booked":
      return {
        reason: `the meeting is booked and briefed, so every step DEALORA can take about it has been taken and the rest belongs to a person`,
        confidenceReasons: [
          "the booking is a stored Phase 13 record",
          "the brief is a stored Phase 13 record",
        ],
      };
    case "meeting_closed":
      return {
        reason: `the newest booking reached a terminal state and a person already decided how it went, so nothing is proposed again over the top of that decision`,
        confidenceReasons: ["the terminal booking state is a stored Phase 13 record"],
      };
    case "positive_response_without_meeting": {
      const intent = classification === null ? "positive" : classification.intent;
      return {
        reason: `a response was read as ${intent} and no meeting has ever been proposed for this account`,
        confidenceReasons: [
          `the Phase 12 classifier read the response as ${intent} with ${classification === null ? "no" : classification.confidence} confidence`,
          qualification === null
            ? "no Phase 8 evaluation qualifies this account yet"
            : `the Phase 8 evaluation is ${qualification.state} with ${qualification.confidence ?? "no"} confidence`,
        ],
      };
    }
    case "no_research":
      return {
        reason:
          "no Phase 6 research request has ever been raised for this account, so nothing downstream can be honest about it",
        confidenceReasons: [
          "the absence of a research request is a fact about storage, not an inference",
        ],
      };
    case "researched_without_evidence":
      return {
        reason: `${count(state.findings.length, "research finding")} exist but none has been converted into Phase 7 evidence, and Phase 7 is the only route from something a source said to something DEALORA treats as a fact`,
        confidenceReasons: ["the findings are stored Phase 6 records"],
      };
    case "evidenced_without_qualification":
      return {
        reason: `${count(state.evidence.length, "evidence record")} exist but the account has never been evaluated against the Business Brain ICP, so its fit is unknown rather than good or bad`,
        confidenceReasons: ["the evidence is stored Phase 7 records"],
      };
    case "not_qualified":
      return {
        reason: `the newest Phase 8 evaluation is ${qualification === null ? "unknown" : qualification.state} and scoring it again without new evidence would not change that, so no outreach is proposed`,
        confidenceReasons: [
          `the evaluation is a stored Phase 8 record with ${qualification === null ? "no" : (qualification.confidence ?? "no")} confidence`,
        ],
      };
    case "qualified_without_draft":
      return {
        reason: `the account qualified${qualification === null || qualification.score === null ? "" : ` with a score of ${qualification.score}`} and no Phase 9 draft has been rendered for it yet`,
        confidenceReasons: [
          `the evaluation is a stored Phase 8 record with ${qualification === null ? "no" : (qualification.confidence ?? "no")} confidence`,
        ],
      };
    case "drafted_without_approval": {
      const draft = latestDraft(state);
      return {
        reason: `a draft exists${draft === null ? "" : ` at version ${draft.version}`} and no approval has ever been requested for it, so nothing may be sent to it`,
        confidenceReasons: ["the draft is a stored Phase 9 record"],
      };
    }
    case "approval_pending":
      return {
        reason:
          "an approval request is waiting on a reviewer, and DEALORA does not approve on anyone's behalf or read silence as a yes",
        confidenceReasons: ["the pending request is a stored Phase 10 record"],
      };
    case "approved_without_send":
      return {
        reason:
          "a person approved this exact draft version and nothing has gone out under that approval yet; sending a message is a Level 2 external action, so it is named here and never performed",
        confidenceReasons: [
          "the approval is a stored Phase 10 decision",
          "the absence of a send is a fact about storage",
        ],
      };
    case "awaiting_response":
      return {
        reason:
          "a message went out and no response has been classified, so there is nothing to decide until a person or an inbound reply supplies one",
        confidenceReasons: ["the send is a stored Phase 11 record"],
      };
    case "response_needing_reply":
      return {
        reason: `a response was classified as ${classification === null ? "needing a reply" : classification.intent} and DEALORA cannot answer it on its own: a reply is a draft a person has to approve before anything is sent`,
        confidenceReasons: [
          classification === null
            ? "a stored Phase 12 classification needs a reply"
            : `the Phase 12 classifier read the response as ${classification.intent} with ${classification.confidence} confidence`,
        ],
      };
  }
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/**
 * The confidence band for a recommendation.
 *
 * Two cases, kept apart on purpose.
 *
 * When the branch rests on records that **carry** a band — the Phase 12
 * classifier, the Phase 8 evaluation — the answer is the *weakest* of them, per
 * ADR 0009. A strong classification resting on one `low` source is still resting
 * on that source.
 *
 * When it rests on the **absence or presence of a stored record**, there is no
 * inference to be weak about: "no approval exists" is a fact about the
 * workspace's own storage, not a claim about an account, and grading it `low`
 * would suggest DEALORA doubts its own database. Those branches report `high` and
 * say in `confidenceReasons` that the band came from a stored fact.
 */
function confidenceFor(
  supportingState: NextBestActionState,
  state: AccountStateSnapshot,
): ResearchConfidence {
  const qualification = latestQualification(state);
  const classification = latestClassification(state);

  switch (supportingState) {
    case "positive_response_without_meeting": {
      const weakest = weakestConfidence([
        classification === null ? null : classification.confidence,
        qualification === null ? null : qualification.confidence,
      ]);
      return weakest ?? "high";
    }
    case "response_needing_reply":
      return classification === null ? "high" : classification.confidence;
    case "not_qualified":
    case "qualified_without_draft":
      return qualification === null ? "high" : (qualification.confidence ?? "high");
    default:
      // Every remaining branch rests on the presence or absence of a stored
      // record, which is a fact about the workspace's own storage. There is no
      // inference here to be weak about, and `reasonFor` says so in the row.
      return "high";
  }
}

/**
 * The evidence and claims a recommendation rests on.
 *
 * References, never copies: the ids point at the live Phase 7 records, so a
 * supersession recorded after the fact stays visible from the recommendation
 * instead of being frozen into a duplicate of the evidence graph.
 *
 * The set depends on what the branch actually read. A recommendation about
 * outreach cites the evidence that justified the outreach; one about sourcing
 * cites nothing, because there is nothing to cite yet — and claiming otherwise
 * would be inventing a support.
 */
function referencesFor(
  supportingState: NextBestActionState,
  state: AccountStateSnapshot,
): { evidenceIds: EntityId[]; claimIds: EntityId[] } {
  const qualification = latestQualification(state);
  const sourcingStates: NextBestActionState[] = [
    "no_research",
    "researched_without_evidence",
    "evidenced_without_qualification",
    "not_qualified",
    "qualified_without_draft",
    "drafted_without_approval",
    "approval_pending",
    "approved_without_send",
    "awaiting_response",
  ];

  if (!sourcingStates.includes(supportingState)) {
    // Meeting and response recommendations are grounded in what DEALORA and the
    // prospect actually exchanged, not in the account's fit profile. Citing
    // evidence there would imply the record supports a statement about a
    // conversation it has never seen.
    return { evidenceIds: [], claimIds: [] };
  }

  const evidenceIds = new Set<EntityId>();
  const claimIds = new Set<EntityId>();
  for (const item of state.evidence) {
    // Only a `recorded` record unambiguously supports a recommendation.
    // `rejected` was refused by a person, `superseded` has been replaced by
    // something else, and `contradicted` is Phase 7 preserving a disagreement
    // between two sources — none of which is support, and citing any of them
    // without saying so would overstate what the workspace's records say.
    if (item.status !== "recorded") continue;
    evidenceIds.add(item.id);
    claimIds.add(item.accountClaimId);
  }
  for (const id of qualification?.evidenceIds ?? []) evidenceIds.add(id);
  for (const id of qualification?.claimIds ?? []) claimIds.add(id);
  return { evidenceIds: [...evidenceIds], claimIds: [...claimIds] };
}

/**
 * Produce the complete recommendation for one account.
 *
 * Everything `ROADMAP.md` §21 requires is filled in here: the action and its
 * expected outcome come from the rule table, the reason and supporting state from
 * the engine, the evidence from the live Phase 7 records, the confidence from
 * the weakest band among them, and the approval requirement from the §17 level.
 *
 * Deterministic end to end. There is no clock, no randomness and no model, so the
 * same rows always produce the same recommendation and `ruleVersion` says which
 * rule set did it.
 */
export function recommendNextAction(state: AccountStateSnapshot): NextActionRecommendation {
  const supportingState = decideNextActionState(state);
  const rule = RULE_BY_STATE[supportingState];
  const { reason, confidenceReasons } = reasonFor(supportingState, state);
  const { evidenceIds, claimIds } = referencesFor(supportingState, state);
  return {
    accountId: state.id,
    accountName: state.name,
    action: rule.action,
    supportingState,
    reason,
    confidenceReasons,
    confidence: confidenceFor(supportingState, state),
    riskLevel: rule.riskLevel,
    // Derived from the level rather than decided separately, so "this needs a
    // person" can never drift from what §17 says the action is.
    approvalRequired: rule.approvalRequired,
    expectedOutcome: rule.expectedOutcome,
    evidenceIds,
    claimIds,
    ruleVersion: NEXT_ACTION_RULE_VERSION,
  };
}
