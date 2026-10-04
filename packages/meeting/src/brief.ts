/**
 * The meeting preparation brief — DEALORA_BLUEPRINT.md §22.
 *
 * §22 lists what DEALORA produces before a meeting: an account overview, the
 * decision maker, relevant signals, known needs, conversation history, potential
 * objections, suggested questions and a recommended next step. This renderer
 * builds that **from records the workspace already has** and references rather
 * than copies the ones it quotes.
 *
 * The design rule that matters most here is what it refuses to do:
 *
 * **It never fills a gap.** Every section §22 names is checked against the
 * records actually available, and whatever is missing is written into `gaps`
 * rather than inferred. A brief that quietly invented a "relevant signal" would
 * be indistinguishable from one that read it from a source — and the difference
 * is the whole value of the document. Storing the absence is what lets a reader
 * tell "we know nothing about their decision process" apart from "we did not
 * look".
 *
 * It is also deterministic: no model, no clock, no randomness. The same inputs
 * produce the same brief, and `rendererVersion` is stored so a brief stays
 * explainable after the rules move on.
 *
 * **This is not the next-best-action engine.** ROADMAP.md §21 scores, ranks and
 * predicts what should happen next, and that is a later phase. The brief reports
 * what is known, names what is not, and stops there.
 */

import type {
  ConversationClassification,
  MeetingBrief,
  MeetingRecommendationReason,
} from "./types.js";
import { MEETING_BRIEF_RENDERER_VERSION } from "./rules.js";

/** What the renderer was given. Everything it needs, and nothing more. */
export interface MeetingBriefInput {
  meetingId: string;
  accountId: string;
  contactId: string;
  /** The qualification this brief is grounded in. */
  qualificationId: string;
  qualificationScore: number | null;
  qualificationState: string;
  /** The Phase 12 classification this meeting came from. */
  classificationId: string;
  intent: MeetingClassificationLike["intent"];
  /** The response text, quoted verbatim. */
  conversationExcerpt: string;
  /** The claim and evidence ids the qualification read, for traceability. */
  claimIds: string[];
  evidenceIds: string[];
  contactName: string;
  contactJobTitle: string | null;
  accountName: string;
  recommendationReason: MeetingRecommendationReason;
}

/** The narrow shape of a classification this renderer needs. */
interface MeetingClassificationLike {
  intent: MeetingBrief["intent"];
}

export interface MeetingBriefDraft {
  rendererVersion: string;
  accountId: string;
  contactId: string;
  qualificationId: string;
  qualificationScore: number | null;
  classificationId: string;
  intent: MeetingBrief["intent"];
  claimIds: string[];
  evidenceIds: string[];
  conversationExcerpt: string;
  gaps: string[];
}

/**
 * Render one brief.
 *
 * Deterministic and total: it returns a draft for every input rather than
 * refusing, because a meeting whose brief cannot be produced is still a meeting
 * — and the honest output for "we have nothing" is a brief that says so.
 */
export function renderMeetingBrief(input: MeetingBriefInput): MeetingBriefDraft {
  const gaps: string[] = [];

  // §22's sections, checked one by one against what the workspace actually holds.
  // A section that cannot be filled is recorded as a gap and left out of the
  // claim/evidence reference lists rather than approximated.

  if (input.accountName.trim() === "")
    gaps.push("No account record is available for this meeting.");
  if (input.contactJobTitle === null) {
    gaps.push(
      "No job title is recorded for the contact, so the decision maker is not established.",
    );
  } else if (!isDecisionMakerTitle(input.contactJobTitle)) {
    gaps.push(
      `The contact's recorded title ("${input.contactJobTitle}") does not establish them as a decision maker.`,
    );
  }
  if (input.evidenceIds.length === 0) {
    gaps.push("No evidence backs this account, so no relevant signal can be cited.");
  }
  if (input.qualificationScore === null) {
    gaps.push(
      "The qualification resolved no score, so this meeting has no measured fit behind it.",
    );
  }
  if (input.claimIds.length === 0 && input.evidenceIds.length > 0) {
    gaps.push("No account claim has been supported, so known needs cannot be stated.");
  }
  if (input.conversationExcerpt.trim() === "") {
    gaps.push(
      "The originating response text is not available, so the conversation history is empty.",
    );
  }

  return {
    rendererVersion: MEETING_BRIEF_RENDERER_VERSION,
    accountId: input.accountId,
    contactId: input.contactId,
    qualificationId: input.qualificationId,
    qualificationScore: input.qualificationScore,
    classificationId: input.classificationId,
    intent: input.intent,
    // Reference lists are passed through, never expanded: the brief names the
    // records it rests on so a reader can trace them, and it does not become a
    // second copy of the evidence graph.
    claimIds: [...input.claimIds],
    evidenceIds: [...input.evidenceIds],
    conversationExcerpt: input.conversationExcerpt.slice(0, 2000),
    gaps,
  };
}

/**
 * Whether a recorded title establishes someone as a decision maker.
 *
 * A conservative reading of §22's "Decision maker": it reports that the title is
 * *not* establishing, so the brief names it as a gap. It never reports that a
 * title **is** a decision maker on its own — that judgement belongs to the person
 * reading the brief, and inferring authority from a job title is exactly the kind
 * of unsupported claim the whole system refuses elsewhere.
 */
function isDecisionMakerTitle(title: string): boolean {
  const normalized = title.toLowerCase();
  const establishing = [
    "chief",
    "ceo",
    "cfo",
    "cto",
    "coo",
    "cmo",
    "founder",
    "owner",
    "president",
    "partner",
    "vp",
    "vice president",
    "head of",
    "director",
  ];
  return establishing.some((marker) => normalized.includes(marker));
}

/**
 * The one-line summary a user sees before the full brief.
 *
 * Kept as a function rather than a stored column so it can never drift from the
 * fields it describes: there is no denormalized copy of "what state is this
 * meeting in" that could disagree with the meeting row itself.
 */
export function describeBooking(input: {
  state: string;
  accountName: string;
  contactName: string;
  startsAt: string;
  recommendationReason: string;
}): string {
  return `${input.state}: ${input.accountName} with ${input.contactName} at ${input.startsAt}, recommended because of ${input.recommendationReason.replace(/_/g, " ")}.`;
}

export type { ConversationClassification };
