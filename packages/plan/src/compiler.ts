import type { GoalMetricKind } from "@dealora/db";

import type {
  PlanBrainSnapshot,
  PlanCompileInput,
  PlanStatement,
  RevenuePlanDraft,
  RevenuePlanCompiler,
  RevenuePlanStrategies,
} from "./types.js";

/**
 * The deterministic Revenue Plan compiler.
 *
 * Given the same goal, the same canonical Business Brain state and the same
 * compiler version, this produces byte-identical strategic content: no clock,
 * no randomness, no network, no model. Reproducibility is what makes a plan
 * auditable and diffable across versions (ROADMAP.md §11).
 *
 * The compiler never asserts anything about the world that the goal or the
 * Business Brain does not support. Anything it proposes is a `recommendation`;
 * anything it cannot determine is an `unknown`.
 */

/** Bump when the strategy logic changes; stored on every plan. */
export const DETERMINISTIC_COMPILER_VERSION = "deterministic-1.0.0";

/** Signal categories the plan would watch for. Categories, never instances. */
const SIGNAL_CATEGORIES: { kind: string; description: string }[] = [
  {
    kind: "hiring",
    description:
      "Role postings showing the account is hiring for the capability the offer addresses.",
  },
  {
    kind: "expansion",
    description:
      "New markets, offices, or product lines indicating the account is scaling the problem.",
  },
  {
    kind: "funding",
    description: "A funding event suggesting budget is available for the problem.",
  },
  {
    kind: "product_launch",
    description: "A launch that creates a new operational burden the offer could reduce.",
  },
  {
    kind: "technology_change",
    description: "A stack change that raises or lowers the cost of the problem.",
  },
  {
    kind: "leadership_change",
    description: "A new decision-maker arriving with a mandate relevant to the offer.",
  },
];

/** Channels considered when the goal states no channel constraint. */
const DEFAULT_CHANNELS = ["email"];

function fact(text: string, basis: PlanStatement["basis"], references?: string[]): PlanStatement {
  return references ? { kind: "fact", text, basis, references } : { kind: "fact", text, basis };
}

function inference(
  text: string,
  basis: PlanStatement["basis"],
  references?: string[],
): PlanStatement {
  return references
    ? { kind: "inference", text, basis, references }
    : { kind: "inference", text, basis };
}

function assumption(text: string, basis: PlanStatement["basis"] = "compiler"): PlanStatement {
  return { kind: "assumption", text, basis };
}

function recommendation(
  text: string,
  basis: PlanStatement["basis"] = "compiler",
  references?: string[],
): PlanStatement {
  return references
    ? { kind: "recommendation", text, basis, references }
    : { kind: "recommendation", text, basis };
}

function unknown(text: string): PlanStatement {
  return { kind: "unknown", text, basis: "none" };
}

/**
 * Deterministic digest of the Business Brain state a plan was compiled
 * against.
 *
 * The plan must not copy the Brain, but a historical plan has to remain
 * interpretable, so it records which Brain state produced it. FNV-1a over a
 * canonical (key-sorted) serialization: no randomness, no crypto dependency,
 * stable across processes.
 */
export function brainSnapshotDigest(brain: PlanBrainSnapshot): string {
  const canonical = canonicalJson(brain);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

/** JSON with object keys sorted, so equal content always serializes equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** Collect every statement in the strategies tree, in a stable order. */
export function collectStatements(strategies: RevenuePlanStrategies): PlanStatement[] {
  const found: PlanStatement[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    // Sorted keys so the collection order never depends on construction order.
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (key === "statements" && Array.isArray(child)) {
        for (const entry of child) found.push(entry as PlanStatement);
        continue;
      }
      walk(child);
    }
  };
  walk(strategies);
  return found;
}

/** Split collected statements by provenance for the plan's roll-ups. */
function rollUp(
  all: PlanStatement[],
): Pick<RevenuePlanDraft, "facts" | "inferences" | "assumptions" | "recommendations" | "unknowns"> {
  return {
    facts: all.filter((s) => s.kind === "fact"),
    inferences: all.filter((s) => s.kind === "inference"),
    assumptions: all.filter((s) => s.kind === "assumption"),
    recommendations: all.filter((s) => s.kind === "recommendation"),
    unknowns: all.filter((s) => s.kind === "unknown"),
  };
}

/** Human label for a metric kind, used in plan prose. */
const METRIC_LABEL: Record<GoalMetricKind, string> = {
  revenue: "revenue",
  pipeline: "qualified pipeline",
  qualified_opportunity: "qualified opportunities",
  meeting: "meetings",
  customer: "new customers",
  conversion_rate: "conversion rate",
  time_to_target: "time to target",
};

export class DeterministicPlanCompiler implements RevenuePlanCompiler {
  readonly compilerVersion = DETERMINISTIC_COMPILER_VERSION;

  compile(input: PlanCompileInput): RevenuePlanDraft {
    const { goal, brain } = input;

    const strategies: RevenuePlanStrategies = {
      icp: this.compileIcp(goal, brain),
      buyer: this.compileBuyer(goal, brain),
      sourcing: this.compileSourcing(goal, brain),
      signal: this.compileSignal(brain),
      qualification: this.compileQualification(goal, brain),
      outreach: this.compileOutreach(goal, brain),
      followUp: this.compileFollowUp(),
      meeting: this.compileMeeting(goal, brain),
      crm: this.compileCrm(),
      measurement: this.compileMeasurement(goal),
      optimization: this.compileOptimization(),
    };

    const rollups = rollUp(collectStatements(strategies));

    return {
      revenueGoalId: goal.id,
      compilerVersion: this.compilerVersion,
      brainSnapshotDigest: brainSnapshotDigest(brain),
      references: {
        offerId: goal.offerId,
        icpId: goal.icpId,
        personaIds: [...goal.buyerPersonaIds],
      },
      strategies,
      ...rollups,
      approval: this.compileApproval(goal),
      rationale: this.compileRationale(goal, brain),
    };
  }

  // --- 1. ICP strategy ---------------------------------------------------

  private compileIcp(goal: PlanCompileInput["goal"], brain: PlanBrainSnapshot) {
    const statements: PlanStatement[] = [];
    const icp = brain.icp;

    // Goal constraints win; the canonical ICP fills the rest. Which one was
    // used is always stated, so a reader never has to guess.
    const industries =
      goal.constraints.industries.length > 0
        ? goal.constraints.industries
        : (icp?.industries ?? []);
    const companySizes =
      goal.constraints.companySizes.length > 0
        ? goal.constraints.companySizes
        : (icp?.companySizes ?? []);
    const geographies =
      goal.constraints.geographies.length > 0
        ? goal.constraints.geographies
        : (icp?.geographies ?? []);

    if (goal.constraints.industries.length > 0) {
      statements.push(
        fact(
          `The goal constrains the target industries to ${goal.constraints.industries.join(", ")}.`,
          "goal:constraints",
        ),
      );
    }
    if (goal.constraints.companySizes.length > 0) {
      statements.push(
        fact(
          `The goal constrains target company sizes to ${goal.constraints.companySizes.join(", ")}.`,
          "goal:constraints",
        ),
      );
    }
    if (goal.constraints.geographies.length > 0) {
      statements.push(
        fact(
          `The goal constrains target geographies to ${goal.constraints.geographies.join(", ")}.`,
          "goal:constraints",
        ),
      );
    }

    if (icp) {
      statements.push(
        fact(
          `The canonical Business Brain ICP defines industries: ${icp.industries.join(", ") || "none recorded"}, company sizes: ${icp.companySizes.join(", ") || "none recorded"}, geographies: ${icp.geographies.join(", ") || "none recorded"}.`,
          "brain:icp",
          [icp.id],
        ),
      );
      if (icp.characteristics.length > 0) {
        statements.push(
          fact(
            `The canonical ICP records the characteristics to look for: ${icp.characteristics.join("; ")}.`,
            "brain:icp",
            [icp.id],
          ),
        );
      }
      if (icp.disqualifiers.length > 0) {
        statements.push(
          fact(
            `The canonical ICP records the disqualifiers: ${icp.disqualifiers.join("; ")}.`,
            "brain:icp",
            [icp.id],
          ),
        );
      }
      statements.push(
        recommendation(
          "Screen every candidate account against the canonical ICP disqualifiers before any further work.",
          "brain:icp",
          [icp.id],
        ),
      );
    } else {
      statements.push(
        unknown(
          "No canonical ICP is recorded for this workspace, so the account profile cannot be stated as fact.",
        ),
      );
    }

    const targetMarket = goal.market ?? brain.company?.market ?? null;
    if (goal.market) {
      statements.push(fact(`The goal states the target market is "${goal.market}".`, "goal"));
    } else if (brain.company?.market) {
      statements.push(
        inference(
          `The goal does not name a market, so the canonical Business Brain company market "${brain.company.market}" is used.`,
          "brain:company",
        ),
      );
    } else {
      statements.push(
        unknown("No target market is stated in the goal or recorded in the Business Brain."),
      );
    }

    return {
      targetMarket,
      industries: [...industries],
      companySizes: [...companySizes],
      geographies: [...geographies],
      characteristics: [...(icp?.characteristics ?? [])],
      disqualifiers: [...(icp?.disqualifiers ?? [])],
      statements,
    };
  }

  // --- 2. Buyer persona strategy ----------------------------------------

  private compileBuyer(goal: PlanCompileInput["goal"], brain: PlanBrainSnapshot) {
    const statements: PlanStatement[] = [];
    const named = goal.buyerPersonaIds
      .map((id) => brain.personas.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);

    let personas = named;
    if (named.length === 0 && brain.personas.length > 0) {
      personas = brain.personas;
      statements.push(
        inference(
          "The goal does not name buyer personas, so the plan addresses every persona recorded in the canonical Business Brain.",
          "brain:persona",
        ),
      );
    }
    if (personas.length === 0) {
      statements.push(
        unknown("No buyer persona is named by the goal or recorded in the Business Brain."),
      );
    }

    const targets = personas.map((persona) => {
      const personaStatements: PlanStatement[] = [];
      personaStatements.push(
        fact(
          `The canonical Business Brain records the persona "${persona.title}".`,
          "brain:persona",
          [persona.id],
        ),
      );
      for (const pain of persona.painPoints) {
        personaStatements.push(
          fact(`The persona "${persona.title}" is recorded as facing: ${pain}.`, "brain:persona", [
            persona.id,
          ]),
        );
      }
      for (const personaGoal of persona.goals) {
        personaStatements.push(
          fact(
            `The persona "${persona.title}" is recorded as wanting: ${personaGoal}.`,
            "brain:persona",
            [persona.id],
          ),
        );
      }
      if (persona.buyingContext) {
        personaStatements.push(
          fact(
            `The persona "${persona.title}" buys in the context: ${persona.buyingContext}.`,
            "brain:persona",
            [persona.id],
          ),
        );
      }
      personaStatements.push(
        recommendation(
          `Address ${persona.title} first: their recorded pain points are the closest match to the offer outcome.`,
          "brain:persona",
          [persona.id],
        ),
      );
      return {
        personaId: persona.id,
        title: persona.title,
        buyerContext: persona.buyingContext,
        painPoints: [...persona.painPoints],
        goals: [...persona.goals],
        statements: personaStatements,
      };
    });

    return { personas: targets, statements };
  }

  // --- 3. Sourcing strategy ---------------------------------------------

  private compileSourcing(goal: PlanCompileInput["goal"], brain: PlanBrainSnapshot) {
    const statements: PlanStatement[] = [];
    const icp = brain.icp;
    const profileParts = [
      goal.market ?? brain.company?.market ?? "the goal's market",
      icp?.industries.length ? `${icp.industries.join(", ")} industries` : null,
      icp?.companySizes.length ? `${icp.companySizes.join(", ")} employees` : null,
      icp?.geographies.length ? icp.geographies.join(", ") : null,
    ].filter((part): part is string => part !== null);

    if (brain.personas.length > 0 && icp) {
      statements.push(
        inference(
          `Accounts matching the canonical ICP, approached through ${brain.personas.map((p) => p.title).join(", ")}, are the intended starting set.`,
          "brain:icp",
          [icp.id, ...brain.personas.map((p) => p.id)],
        ),
      );
    }

    const constraints: string[] = [];
    if (goal.constraints.budget) {
      constraints.push(`Budget: ${goal.constraints.budget}`);
      statements.push(
        fact(
          `The goal states the sourcing budget is ${goal.constraints.budget}.`,
          "goal:constraints",
        ),
      );
    }
    if (goal.constraints.maxOutreachPerDay !== null) {
      constraints.push(`Maximum outreach per day: ${goal.constraints.maxOutreachPerDay}`);
    }
    if (goal.constraints.channels.length > 0) {
      constraints.push(`Permitted channels: ${goal.constraints.channels.join(", ")}`);
      statements.push(
        fact(
          `The goal permits only these channels: ${goal.constraints.channels.join(", ")}.`,
          "goal:constraints",
        ),
      );
    }
    if (goal.constraints.notes) {
      constraints.push(`Notes: ${goal.constraints.notes}`);
    }
    if (constraints.length === 0) {
      statements.push(
        assumption(
          "The goal states no sourcing constraints, so none are assumed beyond the ICP itself.",
        ),
      );
    }

    statements.push(
      recommendation("Source accounts through referral, partner and inbound routes first."),
      recommendation(
        "Do not use automated scraping or purchased lead databases; both are out of scope and neither is permitted by this plan.",
      ),
    );
    statements.push(
      unknown(
        "No accounts have been sourced. Phase 4 produces a plan, and account sourcing is delivered by a later phase.",
      ),
    );

    return {
      accountProfile: `Accounts in ${profileParts.join("; ")}.`,
      approach: [
        "Referral and partner introductions to the target account profile.",
        "Inbound demand capture using the approved positioning.",
        "Direct outreach to accounts matching the canonical ICP.",
        "Expansion within existing customer accounts.",
      ],
      constraints,
      statements,
    };
  }

  // --- 4. Signal strategy -----------------------------------------------

  private compileSignal(brain: PlanBrainSnapshot) {
    const statements: PlanStatement[] = [];
    const signals = SIGNAL_CATEGORIES.map((category) => ({
      kind: category.kind,
      description: category.description,
      statements: [
        recommendation(`Watch for ${category.kind.replace(/_/g, " ")}: ${category.description}`),
      ] as PlanStatement[],
    }));

    // ICP characteristics become candidate signals tied to the canonical record.
    if (brain.icp && brain.icp.characteristics.length > 0) {
      for (const characteristic of brain.icp.characteristics) {
        signals.push({
          kind: "icp_characteristic",
          description: `Accounts exhibiting "${characteristic}".`,
          statements: [
            inference(
              `"${characteristic}" is a recorded ICP characteristic, so it is treated as a candidate signal for this plan.`,
              "brain:icp",
              [brain.icp.id],
            ),
          ],
        });
      }
    }

    statements.push(
      recommendation(
        "Treat a signal as a prompt to research the account, never as evidence that the account intends to buy.",
      ),
    );
    statements.push(
      unknown(
        "No signal has been observed for any specific account. Phase 4 does not monitor or detect signals.",
      ),
    );

    return {
      signals,
      excludedSources: [
        "Automated scraping of company sites or job boards.",
        "Purchased lead databases and brokered contact lists.",
        "Any source that cannot be inspected for how the data was obtained.",
      ],
      statements,
    };
  }

  // --- 5. Qualification strategy ----------------------------------------

  private compileQualification(goal: PlanCompileInput["goal"], brain: PlanBrainSnapshot) {
    const statements: PlanStatement[] = [];
    const criteria = [
      {
        name: "icp_fit",
        description: "The account matches the canonical ICP industries, sizes and geographies.",
        statements: brain.icp
          ? [
              fact("ICP fit is judged against the canonical ICP record.", "brain:icp", [
                brain.icp.id,
              ]),
            ]
          : [unknown("ICP fit cannot be judged: no canonical ICP is recorded.")],
      },
      {
        name: "need_fit",
        description:
          "The account shows the problem the offer solves, evidenced rather than assumed.",
        statements: [
          recommendation(
            "Require evidence of the problem before an account is qualified; do not infer need from company size alone.",
          ),
        ],
      },
      {
        name: "buying_signal",
        description: "A relevant signal is present and attributable to the account.",
        statements: [
          unknown("No buying signal can be evaluated for any account until accounts are sourced."),
        ],
      },
      {
        name: "timing",
        description: "The account is plausibly able to decide inside the goal's time window.",
        statements: [
          inference(
            `The goal's time window ends ${goal.timeWindow.end}, so qualification must respect that horizon.`,
            "goal",
          ),
        ],
      },
      {
        name: "company_fit",
        description:
          "The account can buy and use the offer, including any floor the business has set.",
        statements:
          goal.economics.minimumContractValue !== null
            ? [
                fact(
                  `The goal sets a minimum contract value of ${goal.economics.minimumContractValue}${goal.economics.currency ? ` ${goal.economics.currency}` : ""}.`,
                  "goal:economics",
                ),
              ]
            : [
                unknown(
                  "No minimum contract value is recorded, so deal-size fit cannot be judged.",
                ),
              ],
      },
    ];

    statements.push(
      recommendation(
        "Qualification produces a judgement with recorded evidence; it never auto-advances an account to outreach.",
      ),
    );

    return { criteria, statements };
  }

  // --- 6. Outreach strategy ---------------------------------------------

  private compileOutreach(goal: PlanCompileInput["goal"], brain: PlanBrainSnapshot) {
    const statements: PlanStatement[] = [];
    const channels =
      goal.constraints.channels.length > 0 ? [...goal.constraints.channels] : [...DEFAULT_CHANNELS];

    if (goal.constraints.channels.length > 0) {
      statements.push(
        fact(
          `The goal permits outreach only via ${goal.constraints.channels.join(", ")}.`,
          "goal:constraints",
        ),
      );
    } else {
      statements.push(
        assumption(
          `The goal states no channel, so ${DEFAULT_CHANNELS.join(", ")} is proposed as the starting channel.`,
        ),
      );
    }

    const messagingAngles: string[] = [];
    const positioning = brain.positioning;
    if (positioning) {
      for (const differentiator of positioning.differentiators) {
        messagingAngles.push(differentiator);
        statements.push(
          fact(
            `The approved differentiator "${differentiator}" may be used externally.`,
            "brain:positioning",
          ),
        );
      }
      for (const valueProposition of positioning.approvedValuePropositions) {
        messagingAngles.push(valueProposition);
        statements.push(
          fact(
            `The approved value proposition "${valueProposition}" may be used externally.`,
            "brain:positioning",
          ),
        );
      }
    } else {
      statements.push(
        unknown("No positioning is recorded, so no messaging angle can be stated as fact."),
      );
    }

    if (brain.withheldClaims.unverified > 0 || brain.withheldClaims.restricted > 0) {
      statements.push(
        fact(
          `The Business Brain holds ${brain.withheldClaims.unverified} unverified and ${brain.withheldClaims.restricted} restricted claim(s); none may be used externally.`,
          "brain:claims",
        ),
      );
    }
    if (brain.approvedClaims.length > 0) {
      statements.push(
        fact(
          `${brain.approvedClaims.length} claim(s) are approved for external use.`,
          "brain:claims",
          brain.approvedClaims.map((c) => c.id),
        ),
      );
    }

    const frequencyCap =
      goal.constraints.maxOutreachPerDay !== null
        ? `No more than ${goal.constraints.maxOutreachPerDay} touches per account per day.`
        : null;
    if (frequencyCap) {
      statements.push(
        fact(
          `The goal caps outreach at ${goal.constraints.maxOutreachPerDay} per day.`,
          "goal:constraints",
        ),
      );
    } else {
      statements.push(
        unknown(
          "The goal sets no outreach volume limit, so no frequency cap can be stated as fact.",
        ),
      );
    }

    statements.push(
      recommendation(
        "Personalise on evidence about the specific account. Never present an unverified claim as fact.",
      ),
      recommendation(
        "Every external send is a Level 2 external action and requires approval before it happens.",
      ),
      unknown("Nothing has been sent. Phase 4 performs no outreach of any kind."),
    );

    return {
      channels,
      messagingAngles,
      valueProposition: positioning?.statement ?? null,
      personalizationPrinciple:
        "Personalise on evidence relevant to that account, drawn from approved claims and canonical Brain context only.",
      frequencyCap,
      stopPrinciples: [
        "Stop immediately when the recipient asks to stop.",
        "Stop when the account is disqualified by the canonical ICP.",
        "Stop when the account shows no response within the agreed number of touches.",
        "Stop if any message would require an unapproved or restricted claim.",
      ],
      approvalRequired: goal.approvalPolicy.externalActionsRequireApproval,
      statements,
    };
  }

  // --- 7. Follow-up strategy --------------------------------------------

  private compileFollowUp() {
    return {
      principles: [
        "One follow-up per interaction, each adding new information rather than repeating the last.",
        "Follow up within the goal's time window only.",
        "Every follow-up is subject to the same approval rules as first contact.",
      ],
      responseStates: ["no_response", "interested", "not_now", "disqualified", "referral_intro"],
      stopConditions: [
        "The recipient asks to stop.",
        "The account is disqualified by the canonical ICP.",
        "The agreed number of touches is exhausted with no response.",
      ],
      escalationConditions: [
        "A second stakeholder engages.",
        "The recipient asks for pricing that has not been approved for external use.",
        "The opportunity exceeds the stated minimum contract value.",
      ],
      statements: [
        recommendation(
          "A follow-up engine decides when to send; Phase 4 only records the principles it will follow.",
        ),
        unknown("No follow-up has been scheduled or sent."),
      ],
    };
  }

  // --- 8. Meeting strategy ----------------------------------------------

  private compileMeeting(goal: PlanCompileInput["goal"], brain: PlanBrainSnapshot) {
    const statements: PlanStatement[] = [];
    statements.push(
      inference(
        `The meeting should establish whether the ${METRIC_LABEL[goal.targetMetric]} the goal targets are reachable with this account.`,
        "goal",
      ),
    );
    if (brain.company?.name) {
      statements.push(
        fact(`Meetings are held on behalf of ${brain.company.name}.`, "brain:company"),
      );
    }

    return {
      objective: `Qualify ${METRIC_LABEL[goal.targetMetric]} against the goal target of ${goal.targetValue}${goal.currency ? ` ${goal.currency}` : ""}.`,
      qualificationPurpose:
        "Confirm the account's problem, the decision path, and whether the offer's outcome is the outcome they want.",
      preparation: [
        "Bring only claims the Business Brain has approved for external use.",
        "Bring the account's recorded qualification evidence, not assumptions.",
        "Confirm the account matches the canonical ICP before discussing scope.",
      ],
      statements,
    };
  }

  // --- 9. CRM policy -----------------------------------------------------

  private compileCrm() {
    return {
      recordFields: [
        "Account identity and canonical record references.",
        "Persona and role engaged.",
        "Qualification evidence with its source.",
        "Plan and goal version the interaction belongs to.",
        "Interaction timestamp and channel.",
        "Approval reference for any external action taken.",
      ],
      prohibitedWrites: [
        "No CRM record is created, updated, merged or closed by Phase 4.",
        "No opportunity value may be written without a human-confirmed figure.",
      ],
      statements: [
        fact("Phase 4 writes no CRM record of any kind.", "compiler"),
        recommendation(
          "Record the goal and plan version with every future interaction so performance can be attributed later.",
        ),
      ],
    };
  }

  // --- 10. Measurement plan ---------------------------------------------

  private compileMeasurement(goal: PlanCompileInput["goal"]) {
    const statements: PlanStatement[] = [];
    const kpis = goal.successMetrics.map((metric) => ({
      name: METRIC_LABEL[metric.kind],
      metricKind: metric.kind,
      target: metric.target,
      unit: metric.unit,
      statements: [
        fact(
          `The goal requires ${metric.target} ${METRIC_LABEL[metric.kind]} (${metric.unit}) as a success criterion.`,
          "goal:success_metrics",
        ),
      ] as PlanStatement[],
    }));

    if (kpis.length === 0) {
      statements.push(
        unknown("The goal records no success metrics, so no KPI can be derived for this plan."),
      );
    } else {
      statements.push(
        recommendation(
          `Review progress against these KPIs before ${goal.timeWindow.end}, the end of the goal window.`,
          "goal",
        ),
      );
    }
    statements.push(
      unknown(
        "No performance data exists yet. Measurement collection is delivered by a later phase; this plan only defines what will be measured.",
      ),
    );

    return {
      kpis,
      reviewCadence: `Review weekly against the goal window ending ${goal.timeWindow.end}.`,
      statements,
    };
  }

  // --- 11. Optimization plan --------------------------------------------

  private compileOptimization() {
    return {
      levers: [
        {
          name: "audience",
          description: "Which account profile converts best.",
          requiresData: true,
          statements: [] as PlanStatement[],
        },
        {
          name: "message",
          description: "Which approved angle resonates.",
          requiresData: true,
          statements: [] as PlanStatement[],
        },
        {
          name: "signal",
          description: "Which signal predicts a real opportunity.",
          requiresData: true,
          statements: [] as PlanStatement[],
        },
        {
          name: "channel",
          description: "Which channel earns a response.",
          requiresData: true,
          statements: [] as PlanStatement[],
        },
        {
          name: "timing",
          description: "When a message is most likely to land.",
          requiresData: true,
          statements: [] as PlanStatement[],
        },
        {
          name: "qualification",
          description: "Which qualification criteria predict a close.",
          requiresData: true,
          statements: [] as PlanStatement[],
        },
        {
          name: "follow_up",
          description: "Which follow-up cadence converts.",
          requiresData: true,
          statements: [] as PlanStatement[],
        },
      ],
      guardrails: [
        "Never optimize the approval policy or the risk level.",
        "Never optimize toward a restricted or unapproved claim.",
        "Never optimize against accounts the ICP disqualifies.",
        "Every optimization stays a proposal until a human approves it.",
      ],
      statements: [
        unknown(
          "No lever can be optimized yet: the measurement data these levers depend on does not exist in this phase.",
        ),
        recommendation("Optimize only levers that have recorded performance data behind them."),
      ],
    };
  }

  // --- Approval ----------------------------------------------------------

  private compileApproval(goal: PlanCompileInput["goal"]) {
    return {
      // Typed as the literal `false`: plan approval is not action approval.
      approvesExternalActions: false as const,
      requiredFor: [goal.approvalPolicy.maxRiskLevel],
      statements: [
        fact(
          `The goal requires approval for external actions up to ${goal.approvalPolicy.maxRiskLevel}.`,
          "goal:approval_policy",
        ),
        recommendation(
          "Approving this plan does not authorize sending messages, writing to a CRM, or creating calendar events.",
        ),
        fact("This plan has produced no external action of any kind.", "compiler"),
      ],
    };
  }

  private compileRationale(goal: PlanCompileInput["goal"], brain: PlanBrainSnapshot): string {
    const parts = [
      `The goal targets ${goal.targetValue}${goal.currency ? ` ${goal.currency}` : ""} of ${METRIC_LABEL[goal.targetMetric]} by ${goal.timeWindow.end}`,
    ];
    if (goal.market ?? brain.company?.market) {
      parts.push(`in the ${goal.market ?? brain.company?.market} market`);
    }
    if (brain.icp) parts.push("against the canonical ICP");
    if (brain.personas.length > 0) {
      parts.push(`addressing ${brain.personas.map((p) => p.title).join(", ")}`);
    }
    if (brain.positioning) parts.push("using the approved positioning");
    return `${parts.join(", ")}.`;
  }
}

/** Default compiler instance used by the service factory. */
export const deterministicPlanCompiler = new DeterministicPlanCompiler();
