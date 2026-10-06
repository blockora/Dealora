/** @dealora/optimization — deterministic, read-only optimization analysis.

 * `ROADMAP.md` §28 asks for five answers across eight dimensions. This service
 * answers them deterministically from the workspace's existing rows. It does not
 * run agents, send messages, schedule meetings, contact people, write cost rows
 * or change any state. It reports observations, defensible learnings, candidate
 * tests, and likely-impact hypotheses that Phase 22 can later turn into a
 * controlled experiment.
 *
 * Determinism: given the same read surface, two calls produce byte-identical
 * optimization results. No randomness, no clock inside the derivation, no
 * external call, no action surface of any kind.
 */

import type {
  OptimizationRepository,
  OptimizationResult,
  OptSource,
  OptFacet,
  OptObservation,
  OptLearning,
  OptQuestion,
  OptHypothesis,
  OptHeadline,
} from "./types.js";
import {
  OPTIMIZATION_RULE_VERSION,
  OPTIMIZATION_FACETS,
  OPTIMIZATION_DIMENSIONS,
  OPTIMIZATION_ANSWERS,
  OPTIMIZATION_ASPECTS,
} from "./rules.js";

/**
 * Build a source row from one stored item the optimizer may examine.
 *
 * `signature` is a stable derived key for the row. `perspective` names the
 * facet angle this row supports. We never serialize the whole row here; the
 * caller keeps the row for audit.
 */
function sourceRow(
  item: { id: string; workspaceId: string; createdAt: Date | string },
  dimension: string,
  perspective: string,
): OptSource {
  const createdAt = item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt;
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    signature: `${dimension}/${perspective}/${item.id}`,
    perspective,
    createdAt,
  };
}

/** Stable sort by confidence then by value desc. */
function sortObservations(items: OptObservation[]): OptObservation[] {
  return [...items].sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence < b.confidence ? 1 : -1;
    const aNum = typeof a.value === "number" ? a.value : 0;
    const bNum = typeof b.value === "number" ? b.value : 0;
    return bNum - aNum;
  });
}

/**
 * Derive eight facets from the workspace's existing rows, then answer the five
 * roadmap questions from those facets.
 */
export function deriveOptimization(
  repo: OptimizationRepository,
  workspaceId: string,
  userId: string,
): OptimizationResult {
  const accounts = repo.listAccounts(workspaceId, userId);
  const contacts = repo.listContacts(workspaceId, userId);
  const offers = repo.listOffers(workspaceId, userId);
  const drafts = repo.listDrafts(workspaceId, userId);
  const actions = repo.listOutboundActions(workspaceId, userId);
  const events = repo.listOutboundEvents(workspaceId, userId);
  const classifications = repo.listConversationClassifications(workspaceId, userId);
  const meetings = repo.listMeetings(workspaceId, userId);
  const qualifications = repo.listQualifications(workspaceId, userId);
  const findings = repo.listResearchFindings(workspaceId, userId);
  const costs = repo.listCostEvents(workspaceId, userId, { executionKind: "outbound_send" });
  const traceRuns = repo.listAgentTraceRuns(workspaceId, userId, { agentId: "optimization" });
  const sources: OptSource[] = [
    ...accounts.map((a) => sourceRow(a, "accounts", "qualified at highest rate")),
    ...drafts.map((d) => sourceRow(d, "messages", "approved draft that produced replies")),
    ...classifications.map((c) => sourceRow(c, "signals", "reply intent distribution")),
    ...actions.map((a) => sourceRow(a, "channels", "push channel that sent")),
    ...events.map((e) => sourceRow(e, "timing", "outbound event timing")),
    ...qualifications.map((q) => sourceRow(q, "qualification_rules", "qualification rule version")),
    ...findings.map((f) => sourceRow(f, "signals", "research finding source")),
    ...costs.map((c) => sourceRow(c, "timing", "cost-per-touch")),
    ...meetings.map((m) => sourceRow(m, "follow_up_sequences", "meeting outcome")),
    ...offers.map((o) => sourceRow(o, "offers", "offer variant")),
  ];

  // Deterministic facet derivation for all eighteen facets / eight dimensions.
  const facets: readonly OptFacet[] = OPTIMIZATION_FACETS.map((facetId) => {
    const facetMeta = (() => {
      const found = OPTIMIZATION_ASPECTS.find((meta) => meta.id === facetId);
      if (!found) throw new Error(`no metadata for facet ${facetId}`);
      return found;
    })();

    const dimension = facetMeta.dimension;

    // Deterministic, audited observations per facet — values only when a row
    // can produce them; null otherwise, with a reason.
    const observations: OptObservation[] = [];
    if (dimension === "audiences") {
      const qualified = qualifications.filter((q) => q.state === "qualified").length;
      const researched = accounts.length;
      observations.push({
        label: "qualified accounts vs researched accounts",
        value: researched ? Math.round((qualified / researched) * 100) : null,
        unit: "percent",
        direction: qualified > researched / 2 ? "up" : qualified === 0 ? "flat" : "down",
        confidence: qualified >= 3 ? "high" : "low",
        evidence: [`${qualified} qualified / ${researched} researched`],
      });
      observations.push({
        label: "suppressed accounts vs active accounts",
        value: contacts.length,
        unit: "count",
        direction: "unknown",
        confidence: "low",
        evidence: [`${contacts.length} contacts`, `${qualifications.length} qualifications`],
      });
    } else if (dimension === "messages") {
      const sent = actions.filter((a) => a.status === "sent").length;
      const replied = classifications.length;
      observations.push({
        label: "replies per sent message",
        value: sent ? replied / sent : null,
        unit: "ratio",
        direction: replied >= sent / 2 ? "up" : "down",
        confidence: sent >= 5 ? "high" : "low",
        evidence: [`${replied} replies / ${sent} sent`],
      });
    } else if (dimension === "signals") {
      const intents = classifications.reduce(
        (acc, c) => {
          acc[c.intent] = (acc[c.intent] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      const positive = intents["positive_intent"] || 0;
      const negative = intents["negative_intent"] || 0;
      const objected = intents["objection"] || 0;
      observations.push({
        label: "intent distribution",
        value: `positive ${positive} / negative ${negative} / objection ${objected}`,
        unit: "count",
        direction: positive > negative + objected ? "up" : "down",
        confidence: classifications.length >= 10 ? "high" : "low",
        evidence: [`${classifications.length} classifications`],
      });
    } else if (dimension === "channels") {
      const sentByChannel = actions.reduce(
        (acc, a) => {
          const current = acc[a.channel] ?? 0;
          acc[a.channel] = a.status === "sent" ? current + 1 : current;
          return acc;
        },
        {} as Record<string, number>,
      );
      observations.push({
        label: "send outcomes by channel",
        value: Object.entries(sentByChannel)
          .map(([c, s]) => `${c} ${s}`)
          .join("; "),
        unit: "text",
        direction: "unknown",
        confidence: "low",
        evidence: Object.entries(sentByChannel).map(([c, s]) => `${s} sent on ${c}`),
      });
    } else if (dimension === "timing") {
      const costPerTouch =
        costs.length && actions.filter((a) => a.status === "sent").length
          ? costs.reduce((s, c) => s + (c.amountMinor ?? 0), 0) /
            actions.filter((a) => a.status === "sent").length
          : null;
      observations.push({
        label: "cost per sent touch",
        value: costPerTouch,
        unit: "costMinor",
        direction: costPerTouch === null ? "unknown" : costPerTouch < 1000 ? "down" : "up",
        confidence: costs.length >= 5 ? "high" : "low",
        evidence: [
          `${costs.length} cost events`,
          `${actions.filter((a) => a.status === "sent").length} sent`,
        ],
      });
    } else if (dimension === "qualification_rules") {
      const qualified = qualifications.filter((q) => q.state === "qualified").length;
      const contested = qualifications.filter((q) => q.state === "contested").length;
      const insufficient = qualifications.filter((q) => q.state === "insufficient_data").length;
      qualifications.reduce(
        (acc, q) => {
          const entry = (acc[q.ruleVersion] ??= { qualified: 0, total: 0 });
          entry.total += 1;
          if (q.state === "qualified") entry.qualified += 1;
          return acc;
        },
        {} as Record<string, { qualified: number; total: number }>,
      );
      observations.push({
        label: "qualification outcome distribution",
        value: `${qualified} qualified / ${contested} contested / ${insufficient} insufficient`,
        unit: "text",
        direction: qualified > contested + insufficient ? "up" : "down",
        confidence: qualifications.length >= 5 ? "high" : "low",
        evidence: [`${qualifications.length} qualifications`],
      });
    } else if (dimension === "follow_up_sequences") {
      const meetingsByState = meetings.reduce(
        (acc, m) => {
          acc[m.state] = (acc[m.state] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      const booked = meetingsByState["booked"] || 0;
      const held = meetingsByState["held"] || 0;
      const cancelled = meetingsByState["cancelled"] || 0;
      const noShow = meetingsByState["no_show"] || 0;
      observations.push({
        label: "meeting outcome distribution",
        value: `${booked} booked / ${held} held / ${cancelled} cancelled / ${noShow} no_show`,
        unit: "text",
        direction: booked > cancelled + noShow ? "up" : "down",
        confidence: meetings.length >= 5 ? "high" : "low",
        evidence: [`${meetings.length} meetings`],
      });
    } else if (dimension === "offers") {
      const sentPerOffer: Record<string, { drafted: number; sent: number }> = actions.reduce(
        (acc, a) => {
          const offerId = a.draftId;
          if (!acc[offerId]) acc[offerId] = { drafted: 0, sent: 0 };
          acc[offerId].drafted += 1;
          if (a.status === "sent") acc[offerId].sent += 1;
          return acc;
        },
        {} as Record<string, { drafted: number; sent: number }>,
      );
      observations.push({
        label: "drafts vs sent by draft",
        value: Object.entries(sentPerOffer)
          .map(([k, v]) => `${k} drafted ${v.drafted} sent ${v.sent}`)
          .join("; "),
        unit: "text",
        direction: "unknown",
        confidence: "low",
        evidence: Object.entries(sentPerOffer).map(
          ([k, v]) => `${v.drafted} drafted, ${v.sent} sent for draft ${k}`,
        ),
      });
    }

    // Deterministic learnings: pick top-3 by weight derived from observation strength.
    const learnings: OptLearning[] = observations
      .map((o) => ({
        title: `Optimization facet ${facetId}: ${o.label}`,
        weight: o.confidence === "high" ? 3 : o.confidence === "low" ? 1 : 2,
        reason: `${o.label}; ${o.unit} ${o.value}; confidence ${o.confidence}`,
        evidence: o.evidence,
      }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((l) => ({ ...l }));

    // Deterministic candidate tests (Phase 22 input), one per answer type where defensible.
    const questions: OptQuestion[] = [];
    if (dimension === "messages" && observations.length) {
      questions.push({
        question: "Which approved draft variant should we test head to head?",
        candidateTest:
          "Send two approved drafts to a matched split of qualified accounts and compare positive reply rate.",
        rationale: `Current best observation: ${observations[0]?.label} = ${observations[0]?.value}`,
      });
    }
    if (dimension === "timing" && observations.length) {
      questions.push({
        question: "What send timing should we test next?",
        candidateTest: "Split sends across two cadences and compare reply rate and cost per reply.",
        rationale: `Current cost-per-touch observation: ${observations.find((o) => o.label.startsWith("cost per") || o.label.startsWith("cost-per"))?.value ?? "not yet measurable"}`,
      });
    }
    if (dimension === "follow_up_sequences" && observations.length) {
      questions.push({
        question: "Which follow-up pattern should be A/B tested for meeting holds?",
        candidateTest:
          "Compare hold rate between a shorter and a longer follow-up sequence for the same positive-intent cohorts.",
        rationale: `Current meeting outcome observation: ${observations.find((o) => o.label.startsWith("meeting outcome"))?.value ?? "not yet measurable"}`,
      });
    }
    if (dimension === "offers" && observations.length) {
      questions.push({
        question: "Which offer variant should be tested for higher conversion to meeting?",
        candidateTest:
          "Split sends across two offer variants and compare downstream meeting hold rate.",
        rationale: `Current offer observation: ${observations.find((o) => o.label.startsWith("drafts vs sent"))?.value ?? "not yet measurable"}`,
      });
    }

    // One likely-impact hypothesis per facet where defensible.
    const hypotheses: OptHypothesis[] = [];
    if (observations.length) {
      const strongest = observations[0];
      if (strongest) {
        hypotheses.push({
          hypothesis: `${facetId} facet: ${strongest.label} is the most actionable signal in this workspace.`,
          expectedImpact: `Test the candidate change and expect a measurable effect on ${strongest.label}.`,
          basis: strongest.evidence,
          confidence: strongest.confidence,
        });
      }
    }

    return {
      facet: facetId,
      dimension,
      sources: sources.filter(
        (s) =>
          s.perspective.includes(facetId) ||
          sources.some((s) => s.perspective.includes("qualified") && dimension === "audiences") ||
          sources.some((s) => s.perspective.includes("reply") && dimension === "messages"),
      ),
      observations: sortObservations(observations),
      learnings,
      questions,
      hypotheses,
    };
  });

  // Deterministic headline synthesis from facet observations — one headline per
  // answer type where defensible.
  const headlines: OptHeadline[] = [];
  for (const answer of OPTIMIZATION_ANSWERS) {
    const relevant = facets.filter((f) => {
      if (answer === "worked")
        return f.observations.some((o) => o.direction === "up" && o.value !== null);
      if (answer === "failed")
        return f.observations.some((o) => o.direction === "down" && o.value !== null);
      if (answer === "dropping") return f.observations.some((o) => o.direction === "down");
      if (answer === "test") return f.questions.length > 0;
      return f.hypotheses.length > 0;
    });
    if (relevant.length) {
      let pick: OptObservation | OptQuestion | OptHypothesis | undefined;
      if (answer === "test") {
        for (const f of relevant) {
          if (f.questions.length) {
            pick = f.questions[0];
            break;
          }
        }
      } else if (answer === "impact") {
        for (const f of relevant) {
          if (f.hypotheses.length) {
            pick = f.hypotheses[0];
            break;
          }
        }
      } else {
        for (const f of relevant) {
          if (f.observations.length) {
            pick = f.observations[0];
            break;
          }
        }
      }
      if (pick) {
        if (answer === "test") {
          const q = pick as OptQuestion;
          headlines.push({
            kind: answer,
            text: q.question,
            evidence: [],
            confidence: "high",
          });
        } else if (answer === "impact") {
          const h = pick as OptHypothesis;
          headlines.push({
            kind: answer,
            text: h.hypothesis,
            evidence: h.basis,
            confidence: "high",
          });
        } else {
          const o = pick as OptObservation;
          headlines.push({
            kind: answer,
            text: o.label,
            evidence: o.evidence,
            confidence: "high",
          });
        }
      }
    }
  }

  return {
    workspaceId,
    ruleVersion: OPTIMIZATION_RULE_VERSION,
    facets,
    headlines: [...headlines].sort((a, b) => {
      const rank: Record<string, number> = {
        worked: 0,
        failed: 1,
        dropping: 2,
        test: 3,
        impact: 4,
      };
      return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
    }),
    learnings: [...new Set(facets.flatMap((f) => f.learnings))],
    questions: [...new Set(facets.flatMap((f) => f.questions))],
    hypotheses: [...new Set(facets.flatMap((f) => f.hypotheses))],
    audit: [
      `ruleVersion=${OPTIMIZATION_RULE_VERSION}`,
      `facets=${OPTIMIZATION_FACETS.length}`,
      `dimensions=${OPTIMIZATION_DIMENSIONS.length}`,
      `sources=${sources.length}`,
      `accounts=${accounts.length}`,
      `contacts=${contacts.length}`,
      `offers=${offers.length}`,
      `drafts=${drafts.length}`,
      `actions=${actions.length}`,
      `events=${events.length}`,
      `classifications=${classifications.length}`,
      `meetings=${meetings.length}`,
      `qualifications=${qualifications.length}`,
      `findings=${findings.length}`,
      `costs=${costs.length}`,
      `traceRuns=${traceRuns.length}`,
    ],
  };
}
