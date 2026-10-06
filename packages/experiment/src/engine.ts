/**
 * The pure derivations of the Experiment Engine — §29's five tracked
 * dimensions and its decision, computed from stored rows alone.
 *
 * The engine is a function of its input and nothing else: no clock, no
 * randomness, no storage, no session. The window is the declared start plus
 * the declared duration (capped by an early close), both read from stored
 * instants — the current time is never consulted, so the same rows and the
 * same declaration always produce byte-identical answers, which is what makes
 * every comparison checkable by re-deriving it.
 *
 * Arithmetic discipline, inherited from Phase 19: rates live in exact integer
 * basis points, comparisons cross-multiply instead of dividing, and a rate is
 * reported as quotient plus remainder rather than a float. A decision that
 * depended on floating-point rounding would not be reproducible, and §29's
 * critical rule needs a reproducible decision.
 *
 * Failure mode: any input that does not narrow (a send outside every arm, a
 * classification answering an unknown action) is **excluded from no arm
 * silently** — rows that belong to no arm are simply not experiment data, and
 * cross-arm contacts are counted and disclosed per arm rather than dropped.
 */

import type { CostEvent, ConversationClassification, Meeting, OutboundAction } from "@dealora/db";
import { deriveBreakdown } from "@dealora/cost";
import type { CostBreakdown } from "@dealora/cost";
import { MEETABLE_INTENTS } from "@dealora/meeting";

import {
  EXPERIMENT_HIGH_SAMPLE_MULTIPLIER,
  EXPERIMENT_MEDIUM_SAMPLE_MULTIPLIER,
  EXPERIMENT_METRIC,
  EXPERIMENT_MIN_LIFT_BASIS_POINTS,
  EXPERIMENT_MIN_SAMPLE_PER_ARM,
  EXPERIMENT_RULE_VERSION,
} from "./rules.js";
import type {
  ExperimentArmRow,
  ExperimentArmResult,
  ExperimentComparison,
  ExperimentConfidence,
  ExperimentDecision,
  ExperimentRow,
} from "./types.js";

const MS_PER_DAY = 86_400_000;

/** An exposure with its confirmed send instant, narrowed from a stored action. */
interface ExposureAction {
  readonly id: string;
  readonly draftId: string;
  readonly contactId: string;
  readonly sentAt: string;
}

function toExposure(action: OutboundAction): ExposureAction | null {
  if (action.status !== "sent" || action.sentAt === null) return null;
  return {
    id: action.id,
    draftId: action.draftId,
    contactId: action.contactId,
    sentAt: action.sentAt,
  };
}

/**
 * The analysis window, from stored instants alone.
 *
 * Opens at the experiment's declared start and closes at the declared start
 * plus the declared duration — capped by an early close. A running
 * experiment's window therefore ends in the future relative to "now" without
 * ever asking what time it is: rows after the window simply do not count yet.
 * Returns `null` for an experiment that never started, because a draft has no
 * window to derive over.
 */
export function experimentWindow(experiment: ExperimentRow): { start: number; end: number } | null {
  if (experiment.startedAt === null) return null;
  const start = Date.parse(experiment.startedAt);
  if (Number.isNaN(start)) return null;
  const declaredEnd = start + experiment.durationDays * MS_PER_DAY;
  if (experiment.closedAt !== null) {
    const closed = Date.parse(experiment.closedAt);
    if (!Number.isNaN(closed)) {
      return { start, end: Math.min(declaredEnd, Math.max(closed, start)) };
    }
  }
  return { start, end: declaredEnd };
}

/**
 * Derive the §29 comparison for one experiment over its stored rows.
 *
 * `qualifications` is the workspace's whole qualification history; the
 * population (accounts whose newest qualification is `qualified`) is
 * recomputed here on every read, so a qualification that moved invalidates
 * the next read instead of leaving a stale "qualified" behind.
 */
export function deriveComparison(input: {
  readonly experiment: ExperimentRow;
  readonly arms: readonly ExperimentArmRow[];
  readonly accounts: readonly { id: string; status: string }[];
  readonly contacts: readonly { id: string; accountId: string; status: string }[];
  readonly qualifications: readonly { accountId: string; version: number; state: string }[];
  readonly actions: readonly OutboundAction[];
  readonly classifications: readonly ConversationClassification[];
  readonly meetings: readonly Meeting[];
  readonly costEvents: readonly CostEvent[];
}): ExperimentComparison {
  const notes: string[] = [];
  const window = experimentWindow(input.experiment);
  const arms = [...input.arms].sort((a, b) => a.position - b.position);

  // A draft has no window, and a comparison with fewer than two declared arms
  // is not a comparison: both refuse with the honest reason rather than
  // deriving over nothing.
  if (window === null) {
    notes.push("this experiment has not been started, so it has no window to measure over");
  }
  if (arms.length < 2) {
    notes.push(
      `this experiment has ${arms.length} declared arm${arms.length === 1 ? "" : "s"}; a comparison needs at least two`,
    );
  }

  // Population: newest qualification per account, highest version wins.
  const newest = new Map<string, { version: number; state: string }>();
  for (const row of input.qualifications) {
    const current = newest.get(row.accountId);
    if (current === undefined || row.version > current.version) {
      newest.set(row.accountId, { version: row.version, state: row.state });
    }
  }
  const population = new Set<string>();
  for (const [accountId, entry] of newest) {
    if (entry.state === "qualified") population.add(accountId);
  }

  // Live, non-archived contacts at population accounts.
  const activeContactAccount = new Map<string, string>();
  for (const contact of input.contacts) {
    if (contact.status === "archived") continue;
    if (!population.has(contact.accountId)) continue;
    activeContactAccount.set(contact.id, contact.accountId);
  }

  // In-window sends of this workspace, grouped by arm draft. Exposure is a
  // confirmed send inside the window; nothing else counts.
  const inWindow: ExposureAction[] = [];
  if (window !== null) {
    for (const action of input.actions) {
      if (action.workspaceId !== input.experiment.workspaceId) continue;
      const exposure = toExposure(action);
      if (exposure === null) continue;
      const sent = Date.parse(exposure.sentAt);
      if (Number.isNaN(sent)) continue;
      if (sent >= window.start && sent < window.end) inWindow.push(exposure);
    }
  }

  const actionsByArm = new Map<number, ExposureAction[]>();
  for (const arm of arms) {
    actionsByArm.set(
      arm.position,
      inWindow.filter((action) => action.draftId === arm.draftId),
    );
  }

  // Arms must not overlap on a contact: a contact reached by two arms inside
  // the window contaminates both, and is excluded from both — disclosed, not
  // silently averaged.
  const contactArmCounts = new Map<string, Set<number>>();
  for (const [position, actions] of actionsByArm) {
    for (const action of actions) {
      if (!activeContactAccount.has(action.contactId)) continue;
      const seen = contactArmCounts.get(action.contactId) ?? new Set<number>();
      seen.add(position);
      contactArmCounts.set(action.contactId, seen);
    }
  }
  const contaminated = new Set<string>();
  for (const [contactId, seen] of contactArmCounts) {
    if (seen.size > 1) contaminated.add(contactId);
  }

  // Conversions: any in-window classification of a counted send that Phase 12
  // read as one of the meeting engine's positive intents. A reply that
  // arrived outside the window is not this experiment's data.
  const convertedContacts = new Set<string>();
  if (window !== null) {
    for (const classification of input.classifications) {
      if (classification.workspaceId !== input.experiment.workspaceId) continue;
      const created = Date.parse(classification.createdAt);
      if (Number.isNaN(created) || created < window.start || created >= window.end) continue;
      if (!(MEETABLE_INTENTS as readonly string[]).includes(classification.intent)) continue;
      convertedContacts.add(classification.outboundActionId);
    }
  }

  // Cost: Phase 16's own facts, narrowed to outbound sends and grouped by the
  // execution id — the action that cost them. The totals are the Cost
  // Engine's own derivation, never a second arithmetic.
  const sendCosts = input.costEvents.filter((event) => event.executionKind === "outbound_send");
  const costsByAction = new Map<string, CostEvent[]>();
  for (const event of sendCosts) {
    const list = costsByAction.get(event.executionId) ?? [];
    list.push(event);
    costsByAction.set(event.executionId, list);
  }

  // Meetings: revenue-adjacent outcome actually recorded (booked or held),
  // attributed through the send that started the conversation.
  const calendarMeetings = new Set<string>(
    input.meetings
      .filter((meeting) => meeting.state === "booked" || meeting.state === "held")
      .map((meeting) => meeting.outboundActionId),
  );

  const armResults: ExperimentArmResult[] = arms.map((arm) => {
    const actions = actionsByArm.get(arm.position) ?? [];
    const countedContacts = new Set<string>();
    let crossArm = 0;
    for (const action of actions) {
      if (!activeContactAccount.has(action.contactId)) continue;
      if (contaminated.has(action.contactId)) {
        crossArm += 1;
        continue;
      }
      countedContacts.add(action.contactId);
    }

    const sampleSize = countedContacts.size;
    let conversions = 0;
    for (const action of actions) {
      if (!countedContacts.has(action.contactId)) continue;
      if (convertedContacts.has(action.id)) conversions += 1;
    }

    const rate = rateBasisPoints(conversions, sampleSize);
    const armCost = deriveBreakdown(
      actions.flatMap((action) => costsByAction.get(action.id) ?? []),
    );
    const cost: CostBreakdown =
      armCost ??
      ({
        currency: null,
        eventCount: 0,
        totalMinor: 0,
        estimatedMinor: 0,
        measuredMinor: 0,
        supersededEstimateMinor: 0,
        byCategory: [],
      } satisfies CostBreakdown);

    const meetingsOnCalendar = actions.reduce(
      (count, action) => count + (calendarMeetings.has(action.id) ? 1 : 0),
      0,
    );

    return {
      position: arm.position,
      draftId: arm.draftId,
      label: arm.label,
      sampleSize,
      conversions,
      conversionRateBasisPoints: rate.quotient,
      conversionRateRemainderTenThousandths: rate.remainder,
      cost,
      meetingsOnCalendar,
      revenueImpactMinor: null,
      revenueImpactReason:
        "no phase through 22 records realized revenue; the monetary figure is refused with Phase 23 as its owner, and the reported revenue-adjacent outcome is meetings on a calendar",
      exposures: actions.length,
      excludedCrossArmContacts: crossArm,
    } satisfies ExperimentArmResult;
  });

  const decision = deriveDecision(input.experiment, armResults);
  const confidence = deriveConfidence(armResults);

  if (input.experiment.cancelledAt !== null) {
    notes.push(
      "this experiment was cancelled; its rows are retained for audit and no winner may be claimed from a cancelled comparison",
    );
  }

  return {
    ruleVersion: EXPERIMENT_RULE_VERSION,
    metric: EXPERIMENT_METRIC.name,
    decision,
    confidence,
    windowStart: input.experiment.startedAt,
    windowEnd:
      input.experiment.status === "closed" && input.experiment.closedAt !== null
        ? input.experiment.closedAt
        : window === null
          ? null
          : new Date(window.end).toISOString(),
    arms: armResults,
    populationAccounts: population.size,
    notes,
  };
}

/**
 * The exact conversion rate in integer basis points: quotient floored, with
 * the remainder in ten-thousandths so the exact value is always
 * `quotient + remainder / 10000`. `null` at zero sample — 0/0 is not a rate,
 * and reporting 0% would read as measured.
 */
function rateBasisPoints(
  conversions: number,
  sampleSize: number,
): { quotient: number | null; remainder: number } {
  if (sampleSize <= 0) return { quotient: null, remainder: 0 };
  const numerator = conversions * 10_000;
  return {
    quotient: Math.floor(numerator / sampleSize),
    remainder: numerator % sampleSize,
  };
}

/**
 * §29's decision, derived from the arm results and nothing else.
 *
 * Order is the rule: a cancelled experiment can never crown; fewer than two
 * compared arms cannot; any arm below the minimum sample cannot; and only
 * then does the cross-multiplied comparison speak — a lead of at least the
 * published lift is a winner, anything smaller is no material difference.
 * Ties are exactly equal rates, which is `no_material_difference` by
 * definition, not a coin flip.
 */
function deriveDecision(
  experiment: ExperimentRow,
  arms: readonly ExperimentArmResult[],
): ExperimentDecision {
  const compared = arms.filter((arm) => arm.sampleSize > 0);

  const refusal = (reason: string): ExperimentDecision => ({
    status: "insufficient_evidence",
    winnerPosition: null,
    winnerDraftId: null,
    reason,
  });

  if (experiment.cancelledAt !== null) {
    return refusal(
      "the experiment was cancelled, and §29 forbids claiming a winner from a cancelled comparison",
    );
  }
  if (experiment.startedAt === null) {
    return refusal("the experiment has not started, so no exposure has been measured");
  }
  if (compared.length < 2) {
    return refusal(
      `only ${compared.length} arm${compared.length === 1 ? "" : "s"} hold any exposed contacts in the window; a comparison needs at least two`,
    );
  }
  const underMin = compared.filter((arm) => arm.sampleSize < EXPERIMENT_MIN_SAMPLE_PER_ARM);
  if (underMin.length > 0) {
    return refusal(
      `arm${underMin.length === 1 ? "" : "s"} ${underMin
        .map((arm) => `${arm.label} (${arm.sampleSize})`)
        .join(
          ", ",
        )} are below the published minimum of ${EXPERIMENT_MIN_SAMPLE_PER_ARM} exposed contacts per arm`,
    );
  }

  // Exact ordering by cross-multiplication: a > b iff a.conversions * b.sample
  // > b.conversions * a.sample. No division, no float, no rounding.
  const sorted = [...compared].sort((a, b) => {
    const left = a.conversions * b.sampleSize;
    const right = b.conversions * a.sampleSize;
    if (left !== right) return left > right ? -1 : 1;
    return a.position - b.position;
  });
  const leader = sorted[0];
  const runnerUp = sorted[1];
  if (leader === undefined || runnerUp === undefined) {
    return refusal("the comparison could not be ordered from the recorded rows");
  }

  // Exact lift in basis points: (cA/nA - cB/nB) * 10000, computed as
  // (cA * nB - cB * nA) * 10000 / (nA * nB), floored — the same
  // quotient-plus-remainder discipline as the per-arm rates.
  const liftNumerator =
    (leader.conversions * runnerUp.sampleSize - runnerUp.conversions * leader.sampleSize) * 10_000;
  const denominator = leader.sampleSize * runnerUp.sampleSize;
  const liftBasisPoints = Math.floor(liftNumerator / denominator);
  const liftRemainder = Math.abs(liftNumerator % denominator);

  if (liftBasisPoints >= EXPERIMENT_MIN_LIFT_BASIS_POINTS) {
    return {
      status: "winner",
      winnerPosition: leader.position,
      winnerDraftId: leader.draftId,
      reason: `${leader.label} leads by ${liftBasisPoints} basis points${
        liftRemainder > 0 ? ` (+${liftRemainder}/(n1·n2))` : ""
      } with ${leader.sampleSize} and ${runnerUp.sampleSize} exposed contacts per arm, at or above the published minimum lift of ${EXPERIMENT_MIN_LIFT_BASIS_POINTS}`,
    };
  }
  if (liftBasisPoints === 0) {
    return {
      status: "no_material_difference",
      winnerPosition: null,
      winnerDraftId: null,
      reason: `the arms' conversion rates are exactly equal (${leader.conversions}/${leader.sampleSize} each), which is a tie, not a winner`,
    };
  }
  return {
    status: "no_material_difference",
    winnerPosition: null,
    winnerDraftId: null,
    reason: `${leader.label} leads by only ${liftBasisPoints} basis points with both arms at or above the minimum sample, below the published minimum lift of ${EXPERIMENT_MIN_LIFT_BASIS_POINTS} — reading more into it would claim a winner §29 forbids`,
  };
}

/**
 * §29 "confidence": how much data the comparison rests on, as a band. The
 * band is published policy, not a probability — no p-value is computed and
 * none is implied anywhere in this package.
 */
function deriveConfidence(arms: readonly ExperimentArmResult[]): ExperimentConfidence {
  const compared = arms.filter((arm) => arm.sampleSize > 0);
  if (compared.length < 2) return "insufficient";
  const min = Math.min(...compared.map((arm) => arm.sampleSize));
  if (min < EXPERIMENT_MIN_SAMPLE_PER_ARM) return "insufficient";
  if (min >= EXPERIMENT_MIN_SAMPLE_PER_ARM * EXPERIMENT_HIGH_SAMPLE_MULTIPLIER) return "high";
  if (min >= EXPERIMENT_MIN_SAMPLE_PER_ARM * EXPERIMENT_MEDIUM_SAMPLE_MULTIPLIER) return "medium";
  return "low";
}
