/**
 * Phase 1 + Phase 2 schema.
 *
 * The goal is a schema that can evolve without destructive redesign: every
 * table uses an `id` primary key, UTC `created_at`/`updated_at` instants, and
 * a `deleted_at` tombstone. Deleted rows stay isolated by `workspace_id` and
 * are never returned by default queries.
 *
 * Relations (Phase 1):
 *   User 1 -- * Workspace
 *   User 1 -- * WorkspaceMember (membership)
 *   Workspace 1 -- 1 BusinessProfile  (the company section of the Brain)
 *
 * Relations (Phase 2 — Business Brain, DEALORA_BLUEPRINT.md §9):
 *   Workspace 1 -- * Offer
 *   Workspace 1 -- 1 Icp
 *   Workspace 1 -- * Persona
 *   Workspace 1 -- 1 Positioning
 *   Workspace 1 -- 1 BrandVoice
 *   Workspace 1 -- * Claim
 *
 * Sections that hold a single record per workspace (Icp, Positioning,
 * BrandVoice, BusinessProfile) are keyed by a UNIQUE `workspace_id` so the
 * Business Brain stays a single canonical source of truth rather than a
 * competing set of records.
 *
 * Relations (Phase 6 — Research Engine, ROADMAP.md §13):
 *   Account 1 -- * ResearchRequest
 *   ResearchRequest 1 -- * ResearchFinding
 *
 * Relations (Phase 8 — Qualification Engine, ROADMAP.md §15):
 *   Account 1 -- * Qualification
 *
 * Relations (Phase 9 — Personalization Engine, ROADMAP.md §16):
 *   Account 1 -- * PersonalizedDraft
 *
 * A draft references the qualification, contact and offer it was rendered
 * from with `ON DELETE SET NULL`: a deleted reference must not delete a
 * draft a user may already have reviewed, and the draft stays readable with
 * its own rendered text intact.
 *
 * A qualification row references the plan, goal and ICP it was measured
 * against with `ON DELETE SET NULL`: a deleted plan or goal must not delete a
 * decision a user already made, and a qualification whose goal row is gone
 * still carries the digest and criterion results that explain it.
 *
 * No other tables exist yet: ROADMAP.md §8 explicitly says "Not every entity
 * needs full functionality in Phase 1", and §9 lists further Business Brain
 * concepts (case studies, FAQs, competitors, playbooks) that the phases that
 * consume them introduce.
 */

export const COLUMNS = {
  id: "id",
  tenantId: "tenant_id",
  userId: "user_id",
  workspaceId: "workspace_id",
  ownerId: "owner_id",
  email: "email",
  passwordHash: "password_hash",
  displayName: "display_name",
  role: "role",
  name: "name",
  slug: "slug",
  logoUrl: "logo_url",
  timezone: "timezone",
  settings: "settings",
  description: "description",
  website: "website",
  type: "type",
  offer: "offer",
  industry: "industry",
  size: "size",
  market: "market",
  createdAt: "created_at",
  updatedAt: "updated_at",
  deletedAt: "deleted_at",
  invitedAt: "invited_at",
  acceptedAt: "accepted_at",
  targetCustomer: "target_customer",
  problemSolved: "problem_solved",
  outcome: "outcome",
  pricing: "pricing",
  deliveryModel: "delivery_model",
  status: "status",
  title: "title",
  responsibilities: "responsibilities",
  painPoints: "pain_points",
  goals: "goals",
  buyingContext: "buying_context",
  industries: "industries",
  companySizes: "company_sizes",
  geographies: "geographies",
  businessModels: "business_models",
  characteristics: "characteristics",
  disqualifiers: "disqualifiers",
  notes: "notes",
  statement: "statement",
  differentiators: "differentiators",
  approvedValuePropositions: "approved_value_propositions",
  competitorContext: "competitor_context",
  tone: "tone",
  style: "style",
  terminology: "terminology",
  constraints: "constraints",
  text: "text",
  category: "category",
  sourceNote: "source_note",
  approvedBy: "approved_by",
  approvedAt: "approved_at",
  objective: "objective",
  targetMetric: "target_metric",
  targetValue: "target_value",
  currency: "currency",
  timeWindow: "time_window",
  icpId: "icp_id",
  buyerPersonaIds: "buyer_persona_ids",
  offerId: "offer_id",
  economics: "economics",
  approvalPolicy: "approval_policy",
  successMetrics: "success_metrics",
  completeness: "completeness",
  unknowns: "unknowns",
  assumptions: "assumptions",
  recommendations: "recommendations",
  accountId: "account_id",
  domain: "domain",
  geography: "geography",
  companySize: "company_size",
  source: "source",
  sourceReference: "source_reference",
  firstName: "first_name",
  lastName: "last_name",
  fullName: "full_name",
  jobTitle: "job_title",
  phone: "phone",
  profileUrl: "profile_url",
  goalId: "goal_id",
  actorUserId: "actor_user_id",
  kind: "kind",
  fromStatus: "from_status",
  toStatus: "to_status",
  revenueGoalId: "revenue_goal_id",
  revenuePlanId: "revenue_plan_id",
  planVersion: "plan_version",
  compilerVersion: "compiler_version",
  brainSnapshotDigest: "brain_snapshot_digest",
  references: "references",
  strategies: "strategies",
  facts: "facts",
  inferences: "inferences",
  approval: "approval",
  rationale: "rationale",
  provider: "provider",
  idempotencyKey: "idempotency_key",
  categories: "categories",
  findingCount: "finding_count",
  failureCode: "failure_code",
  failureMessage: "failure_message",
  startedAt: "started_at",
  completedAt: "completed_at",
  researchRequestId: "research_request_id",
  field: "field",
  value: "value",
  claimKind: "claim_kind",
  sourceName: "source_name",
  sourceUrl: "source_url",
  sourceTitle: "source_title",
  observedAt: "observed_at",
  retrievedAt: "retrieved_at",
  confidence: "confidence",
  freshness: "freshness",
  relevance: "relevance",
  note: "note",
  accountClaimId: "account_claim_id",
  researchFindingId: "research_finding_id",
  provenance: "provenance",
  version: "version",
  ruleVersion: "rule_version",
  contextDigest: "context_digest",
  state: "state",
  score: "score",
  reason: "reason",
  evidenceIds: "evidence_ids",
  claimIds: "claim_ids",
  conflictedClaimIds: "conflicted_claim_ids",
  dimensions: "dimensions",
  evaluatedAt: "evaluated_at",
  contactId: "contact_id",
  qualificationId: "qualification_id",
  rendererVersion: "renderer_version",
  subject: "subject",
  body: "body",
  personalizationPoints: "personalization_points",
  approvedClaimIds: "approved_claim_ids",
  warnings: "warnings",

  // Phase 10 — Approval Engine
  createdBy: "created_by",
  draftId: "draft_id",
  actionKind: "action_kind",
  riskLevel: "risk_level",
  draftVersion: "draft_version",
  previewSubject: "preview_subject",
  previewDigest: "preview_digest",
  decision: "decision",
  decidedBy: "decided_by",
  decidedAt: "decided_at",
  decisionReason: "decision_reason",
  expiresAt: "expires_at",
  approvalId: "approval_id",
  detail: "detail",

  // Phase 11 — First Outbound Integration
  channel: "channel",
  draftDigest: "draft_digest",
  recipientEmail: "recipient_email",
  attemptCount: "attempt_count",
  providerReference: "provider_reference",
  attemptedAt: "attempted_at",
  sentAt: "sent_at",
  actionId: "action_id",
  // `email` and `reason` are already declared above and are reused here: the
  // suppression list's address and reason are the same concepts Phase 1's user
  // email and Phase 3's decision reason already named.

  // Phase 12 — Conversation Engine
  outboundActionId: "outbound_action_id",
  fromAddress: "from_address",
  providerMessageId: "provider_message_id",
  receivedAt: "received_at",
  inboundMessageId: "inbound_message_id",
  classifierVersion: "classifier_version",
  intent: "intent",
  reasons: "reasons",
  signals: "signals",
  recommendedNextAction: "recommended_next_action",
  humanInterventionRequired: "human_intervention_required",
  suppressed: "suppressed",
  classificationId: "classification_id",
  // `source`, `subject`, `body`, `contactId`, `accountId`, `confidence`,
  // `createdBy`, `kind`, `detail` and `version` are already declared above and
  // are reused: they are the same concepts Phase 5's contact provenance,
  // Phase 9's draft text, Phase 8's confidence band and Phase 10's audit row
  // already named, and inventing parallel columns for them would make two
  // vocabularies for one idea.
} as const;

export type ColumnName = (typeof COLUMNS)[keyof typeof COLUMNS];

/** Table: users. */
export const userTable = "users" as const;

/** Table: workspaces (the tenant boundary). */
export const workspaceTable = "workspaces" as const;

/** Table: workspace members (membership + ownership). */
export const workspaceMembersTable = "workspace_members" as const;

/** Table: business profiles — the company section of the Business Brain. */
export const businessProfilesTable = "business_profiles" as const;

/** Table: commercial offers (Phase 2). */
export const offerTable = "offers" as const;

/** Table: ideal customer profile, one per workspace (Phase 2). */
export const icpTable = "icps" as const;

/** Table: buyer personas (Phase 2). */
export const personaTable = "personas" as const;

/** Table: positioning, one per workspace (Phase 2). */
export const positioningTable = "positioning" as const;

/** Table: brand voice, one per workspace (Phase 2). */
export const brandVoiceTable = "brand_voice" as const;

/** Table: business claims with explicit approval status (Phase 2). */
export const claimTable = "claims" as const;

/** Table: structured revenue goals (Phase 3). */
export const revenueGoalTable = "revenue_goals" as const;

/** Table: auditable revenue-goal status transitions (Phase 3). */
export const revenueGoalEventTable = "revenue_goal_events" as const;

/**
 * Table: compiled revenue plans (Phase 4).
 *
 * One row per compiled plan version. Recompiling a goal inserts a new version
 * rather than overwriting, so historical plans stay inspectable.
 */
export const revenuePlanTable = "revenue_plans" as const;

/** Table: target accounts supplied by the user (Phase 5). */
export const accountTable = "accounts" as const;

/** Table: contacts at a target account, supplied by the user (Phase 5). */
export const contactTable = "contacts" as const;

/**
 * Table: research requests (Phase 6).
 *
 * One row per research job against an account. Holds what was asked and which
 * permitted provider answers it — not the findings themselves.
 */
export const researchRequestTable = "research_requests" as const;

/**
 * Table: research findings (Phase 6).
 *
 * Structured, attributed observations. Not evidence: verification and linking
 * are Phase 7, so nothing here carries a verification state.
 */
export const researchFindingTable = "research_findings" as const;

/**
 * Table: structured claims about an external account (Phase 7).
 *
 * Not the Phase 2 `claims` table. Those are the business's own statements
 * with an approval status; these are assertions about a company DEALORA does
 * not own, derived from a permitted source. Keeping them apart is what stops
 * a source-backed observation being presented as an approved internal claim.
 */
export const accountClaimTable = "account_claims" as const;

/**
 * Table: evidence (Phase 7).
 *
 * One row per traceable, source-backed support for an `account_claims` row.
 * Records are never deleted: `superseded`, `contradicted` and `rejected` are
 * statuses, so the audit trail is preserved by construction.
 */
export const evidenceTable = "evidence" as const;

/**
 * Table: qualification evaluations (Phase 8).
 *
 * One row per evaluation of one account. Re-evaluating inserts a new
 * `version` instead of overwriting, so the score a user acted on stays
 * explainable after the rule set moves on.
 *
 * `dimensions` holds the per-criterion results as one document column, exactly
 * as `revenue_plans.strategies` does: the criteria are only ever read as part
 * of the evaluation that produced them, and splitting them into a child table
 * would invite a criterion row to outlive the decision that explains it.
 *
 * There is no `status` column. A qualification is not a workflow object: it has
 * no draft state to approve and nothing to action, so a lifecycle here would
 * only import Phase 10's semantics.
 */
export const qualificationTable = "qualifications" as const;

/**
 * Table: personalized outreach drafts (Phase 9).
 *
 * One row per generated draft. Regenerating inserts a new `version` instead of
 * overwriting, so an approval (Phase 10) can bind to exactly one immutable
 * draft version. There is no `status` column: a draft is a document, not an
 * action — the lifecycle that leads to a send begins in Phase 10.
 */
export const personalizedDraftTable = "personalized_drafts" as const;

/**
 * Table: approval requests (Phase 10).
 *
 * One row per request for a human decision about one exact draft version. The
 * request binds to `draft_id` + `draft_version` together, so "which version was
 * approved?" is a stored pair rather than a reconstruction: a draft that is
 * regenerated produces a new version, and the old approval keeps pointing at
 * the text the reviewer actually read.
 *
 * `preview_digest` fingerprints the exact content the reviewer was shown and is
 * verified again at decision time, so an approval can never be recorded against
 * content that moved underneath the decision.
 *
 * Identity columns (`created_by`, `decided_by`, `decided_at`) are written by the
 * server from the session only. There is no column a client can supply to name
 * its own approver.
 */
export const approvalRequestTable = "approval_requests" as const;

/**
 * Table: the append-only approval audit trail (Phase 10).
 *
 * Every state a request passes through leaves one row here, so the history of a
 * decision — what was approved, which version, who, when and why — survives any
 * later change. Rows are never edited or deleted, which is the whole point: a
 * trail that can be rewritten is not a trail.
 */
export const approvalRequestEventTable = "approval_request_events" as const;

/**
 * Table: outbound actions (Phase 11).
 *
 * One row per controlled external communication. An action is not the message:
 * it is the system's memory of one send attempt, so it **references** the
 * immutable draft version (`draft_id` + `draft_version` + `draft_digest`) and
 * the approval that authorized it, rather than copying the text. There is
 * therefore exactly one text of record, and an action cannot claim content the
 * reviewer never saw.
 *
 * `approval_id` is a hard foreign key: an action cannot exist without pointing
 * at a persisted approval record. Combined with the service's independent
 * re-verification at send time, that is what stops a message from leaving the
 * system on anything but a human decision.
 *
 * Every provider-owned column (`provider`, `provider_reference`, `status`,
 * `attempt_count`, `failure_*`, `attempted_at`, `sent_at`) is written by the
 * server from the provider's response only. `status` is CHECK-constrained, and
 * `sent` is reachable only from a recorded provider confirmation.
 */
export const outboundActionTable = "outbound_actions" as const;

/**
 * Table: the append-only outbound audit trail (Phase 11).
 *
 * Every step an action takes — created, attempted, sent, failed, cancelled —
 * leaves one row here, written by the server. A failure is as durable as a
 * success: "it says sent but nothing arrived" is exactly the question this
 * table exists to answer.
 */
export const outboundEventTable = "outbound_events" as const;

/**
 * Table: opt-out suppression list (Phase 11).
 *
 * One row per address a workspace has opted out of contacting. Checked before
 * every provider call, never after. Suppression is permanent and attributed —
 * `created_by` records who added it and `reason` records why — because an
 * opt-out that cannot be explained is one a workspace cannot be asked to trust.
 */
export const outboundSuppressionTable = "outbound_suppressions" as const;

/**
 * Table: inbound messages (Phase 12).
 *
 * One row per response a workspace received, stored verbatim.
 *
 * This table is deliberately **not** part of the Phase 7 evidence graph. Nothing
 * here carries a confidence, a freshness or a claim status, and nothing here can
 * become evidence without going through the Phase 7 conversion a human
 * performs: a prospect's own words are an interested party's claim, not an
 * attested fact about their company. Storing them apart is what keeps that
 * distinction from eroding.
 *
 * `outbound_action_id` is a hard foreign key, so a response to something
 * DEALORA never sent cannot exist, and `contact_id`/`account_id` are resolved
 * server-side from that action rather than accepted from a caller — a message
 * cannot be filed against the wrong person.
 */
export const inboundMessageTable = "inbound_messages" as const;

/**
 * Table: conversation classifications (Phase 12).
 *
 * One immutable, versioned classification per inbound message, with the phrases
 * that decided it and the safety signals that fired stored alongside. `intent`,
 * `confidence` and `recommended_next_action` are CHECK-constrained to the closed
 * vocabularies `DEALORA_BLUEPRINT.md` §18 and `ROADMAP.md` §19 name, so a
 * classification can never carry a state the system does not define.
 *
 * `human_intervention_required` is constrained to be true for everything except
 * an opt-out, which is the single outcome that must be honoured without waiting
 * for a person.
 */
export const conversationClassificationTable = "conversation_classifications" as const;

/**
 * Table: the append-only conversation audit trail (Phase 12).
 *
 * Every step a classification takes — recorded, classified, suppressed,
 * escalated, held — leaves one row written by the server. A suppression in
 * particular must be explainable: a workspace that stops contacting someone
 * because of one message needs to be able to show which message and which rule
 * caused it.
 */
export const conversationEventTable = "conversation_events" as const;

/** All tables, in creation order — the canonical table list. */
export const tables = [
  userTable,
  workspaceTable,
  workspaceMembersTable,
  businessProfilesTable,
  offerTable,
  icpTable,
  personaTable,
  positioningTable,
  brandVoiceTable,
  claimTable,
  revenueGoalTable,
  revenueGoalEventTable,
  revenuePlanTable,
  accountTable,
  contactTable,
  researchRequestTable,
  researchFindingTable,
  accountClaimTable,
  evidenceTable,
  qualificationTable,
  personalizedDraftTable,
  approvalRequestTable,
  approvalRequestEventTable,
  outboundActionTable,
  outboundEventTable,
  outboundSuppressionTable,
  inboundMessageTable,
  conversationClassificationTable,
  conversationEventTable,
] as const;

function COLUMN(table: string, column: string): string {
  return `"${table}"."${column}"`;
}

/** Uniqueness keys: email must be unique, workspace slug unique. */
export const indexes = {
  users: [`${COLUMNS.email} UNIQUE NOT NULL`],
  workspaces: [`${COLUMNS.id} PRIMARY KEY`, `${COLUMNS.slug} UNIQUE NOT NULL`],
  workspaceMembers: [
    `${COLUMNS.workspaceId} NOT NULL`,
    `${COLUMN(workspaceMembersTable, "user_id")} NOT NULL`,
    `${COLUMN(workspaceMembersTable, "invited_at")} NOT NULL`,
  ],
  businessProfiles: [
    `${COLUMN(businessProfilesTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(businessProfilesTable, COLUMNS.workspaceId)} UNIQUE NOT NULL`,
  ],
  offers: [
    `${COLUMN(offerTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(offerTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(offerTable, COLUMNS.name)} NOT NULL`,
  ],
  icps: [
    `${COLUMN(icpTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(icpTable, COLUMNS.workspaceId)} UNIQUE NOT NULL`,
  ],
  personas: [
    `${COLUMN(personaTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(personaTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(personaTable, COLUMNS.title)} NOT NULL`,
  ],
  positioning: [
    `${COLUMN(positioningTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(positioningTable, COLUMNS.workspaceId)} UNIQUE NOT NULL`,
  ],
  brandVoice: [
    `${COLUMN(brandVoiceTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(brandVoiceTable, COLUMNS.workspaceId)} UNIQUE NOT NULL`,
  ],
  claims: [
    `${COLUMN(claimTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(claimTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(claimTable, COLUMNS.status)} NOT NULL`,
  ],
  revenueGoals: [
    `${COLUMN(revenueGoalTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(revenueGoalTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(revenueGoalTable, COLUMNS.status)} NOT NULL`,
  ],
  revenuePlans: [
    `${COLUMN(revenuePlanTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(revenuePlanTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(revenuePlanTable, COLUMNS.status)} NOT NULL`,
    `${COLUMN(revenuePlanTable, COLUMNS.planVersion)} NOT NULL`,
  ],
  accounts: [
    `${COLUMN(accountTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(accountTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(accountTable, COLUMNS.name)} NOT NULL`,
    `${COLUMN(accountTable, COLUMNS.status)} NOT NULL`,
  ],
  contacts: [
    `${COLUMN(contactTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(contactTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(contactTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(contactTable, COLUMNS.fullName)} NOT NULL`,
    `${COLUMN(contactTable, COLUMNS.status)} NOT NULL`,
  ],
  revenueGoalEvents: [
    `${COLUMN(revenueGoalEventTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(revenueGoalEventTable, COLUMNS.goalId)} NOT NULL`,
  ],
  researchRequests: [
    `${COLUMN(researchRequestTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(researchRequestTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(researchRequestTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(researchRequestTable, COLUMNS.status)} NOT NULL`,
  ],
  researchFindings: [
    `${COLUMN(researchFindingTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(researchFindingTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(researchFindingTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(researchFindingTable, COLUMNS.researchRequestId)} NOT NULL`,
  ],
  accountClaims: [
    `${COLUMN(accountClaimTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(accountClaimTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(accountClaimTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(accountClaimTable, COLUMNS.status)} NOT NULL`,
  ],
  evidence: [
    `${COLUMN(evidenceTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(evidenceTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(evidenceTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(evidenceTable, COLUMNS.accountClaimId)} NOT NULL`,
    `${COLUMN(evidenceTable, COLUMNS.status)} NOT NULL`,
  ],
  qualifications: [
    `${COLUMN(qualificationTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(qualificationTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(qualificationTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(qualificationTable, COLUMNS.version)} NOT NULL`,
    `${COLUMN(qualificationTable, COLUMNS.state)} NOT NULL`,
  ],
  personalizedDrafts: [
    `${COLUMN(personalizedDraftTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(personalizedDraftTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(personalizedDraftTable, COLUMNS.accountId)} NOT NULL`,
    `${COLUMN(personalizedDraftTable, COLUMNS.version)} NOT NULL`,
    `${COLUMN(personalizedDraftTable, COLUMNS.rendererVersion)} NOT NULL`,
  ],
  approvalRequests: [
    `${COLUMN(approvalRequestTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(approvalRequestTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(approvalRequestTable, COLUMNS.draftId)} NOT NULL`,
    `${COLUMN(approvalRequestTable, COLUMNS.draftVersion)} NOT NULL`,
    `${COLUMN(approvalRequestTable, COLUMNS.status)} NOT NULL`,
  ],
  approvalRequestEvents: [
    `${COLUMN(approvalRequestEventTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(approvalRequestEventTable, COLUMNS.approvalId)} NOT NULL`,
    `${COLUMN(approvalRequestEventTable, COLUMNS.workspaceId)} NOT NULL`,
  ],
  outboundActions: [
    `${COLUMN(outboundActionTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(outboundActionTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(outboundActionTable, COLUMNS.draftId)} NOT NULL`,
    `${COLUMN(outboundActionTable, COLUMNS.approvalId)} NOT NULL`,
    `${COLUMN(outboundActionTable, COLUMNS.contactId)} NOT NULL`,
    `${COLUMN(outboundActionTable, COLUMNS.status)} NOT NULL`,
  ],
  outboundEvents: [
    `${COLUMN(outboundEventTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(outboundEventTable, COLUMNS.actionId)} NOT NULL`,
    `${COLUMN(outboundEventTable, COLUMNS.workspaceId)} NOT NULL`,
  ],
  outboundSuppressions: [
    `${COLUMN(outboundSuppressionTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(outboundSuppressionTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(outboundSuppressionTable, COLUMNS.email)} NOT NULL`,
  ],
  inboundMessages: [
    `${COLUMN(inboundMessageTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(inboundMessageTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(inboundMessageTable, COLUMNS.outboundActionId)} NOT NULL`,
    `${COLUMN(inboundMessageTable, COLUMNS.body)} NOT NULL`,
  ],
  conversationClassifications: [
    `${COLUMN(conversationClassificationTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(conversationClassificationTable, COLUMNS.workspaceId)} NOT NULL`,
    `${COLUMN(conversationClassificationTable, COLUMNS.inboundMessageId)} NOT NULL`,
    `${COLUMN(conversationClassificationTable, COLUMNS.intent)} NOT NULL`,
  ],
  conversationEvents: [
    `${COLUMN(conversationEventTable, COLUMNS.id)} PRIMARY KEY`,
    `${COLUMN(conversationEventTable, COLUMNS.classificationId)} NOT NULL`,
    `${COLUMN(conversationEventTable, COLUMNS.workspaceId)} NOT NULL`,
  ],
};

/** SQL DDL for a single table (PostgreSQL-compatible dialect). */
export function createTableSql(
  table: string,
  columns: readonly string[],
  primaryKey: string,
): string {
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (${primaryKey},`,
    ...columns.map((c) => `  ${c}`),
    `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),`,
    `     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),`,
    `     deleted_at TIMESTAMPTZ)`,
    `;`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_deleted ON "${table}"("deleted_at") WHERE "deleted_at" IS NULL;`,
  ].join("\n");
}

export const SCHEMA = [
  createTableSql(
    userTable,
    [
      COLUMN(userTable, COLUMNS.id),
      COLUMN(userTable, COLUMNS.email),
      COLUMN(userTable, COLUMNS.passwordHash),
      COLUMN(userTable, COLUMNS.displayName),
      COLUMN(userTable, COLUMNS.role),
    ],
    `${COLUMN(userTable, COLUMNS.id)} PRIMARY KEY`,
  ),
  createTableSql(
    workspaceTable,
    [
      COLUMN(workspaceTable, COLUMNS.id),
      COLUMN(workspaceTable, COLUMNS.ownerId),
      COLUMN(workspaceTable, COLUMNS.name),
      COLUMN(workspaceTable, COLUMNS.slug),
      COLUMN(workspaceTable, COLUMNS.logoUrl),
      COLUMN(workspaceTable, COLUMNS.timezone),
      COLUMN(workspaceTable, COLUMNS.settings),
    ],
    `${COLUMN(workspaceTable, COLUMNS.id)} PRIMARY KEY`,
  ),
  createTableSql(
    workspaceMembersTable,
    [
      COLUMN(workspaceMembersTable, COLUMNS.workspaceId),
      COLUMN(workspaceMembersTable, COLUMNS.userId),
      COLUMN(workspaceMembersTable, COLUMNS.role),
      COLUMN(workspaceMembersTable, COLUMNS.invitedAt),
      COLUMN(workspaceMembersTable, COLUMNS.acceptedAt),
    ],
    `${COLUMN(workspaceMembersTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(workspaceMembersTable, COLUMNS.userId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
PRIMARY KEY ("${COLUMNS.workspaceId}", "${COLUMNS.userId}")`,
  ),
  createTableSql(
    businessProfilesTable,
    [
      COLUMN(businessProfilesTable, COLUMNS.id),
      COLUMN(businessProfilesTable, COLUMNS.workspaceId),
      COLUMN(businessProfilesTable, COLUMNS.ownerId),
      COLUMN(businessProfilesTable, COLUMNS.name),
      COLUMN(businessProfilesTable, COLUMNS.description),
      COLUMN(businessProfilesTable, COLUMNS.website),
      COLUMN(businessProfilesTable, COLUMNS.type),
      COLUMN(businessProfilesTable, COLUMNS.offer),
      COLUMN(businessProfilesTable, COLUMNS.industry),
      COLUMN(businessProfilesTable, COLUMNS.size),
      COLUMN(businessProfilesTable, COLUMNS.market),
    ],
    `${COLUMN(businessProfilesTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(businessProfilesTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(businessProfilesTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
UNIQUE("${COLUMNS.workspaceId}")`,
  ),
  createTableSql(
    offerTable,
    [
      COLUMN(offerTable, COLUMNS.id),
      COLUMN(offerTable, COLUMNS.workspaceId),
      COLUMN(offerTable, COLUMNS.name),
      COLUMN(offerTable, COLUMNS.description),
      COLUMN(offerTable, COLUMNS.targetCustomer),
      COLUMN(offerTable, COLUMNS.problemSolved),
      COLUMN(offerTable, COLUMNS.outcome),
      COLUMN(offerTable, COLUMNS.pricing),
      COLUMN(offerTable, COLUMNS.deliveryModel),
      COLUMN(offerTable, COLUMNS.status),
    ],
    `${COLUMN(offerTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(offerTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE`,
  ),
  createTableSql(
    icpTable,
    [
      COLUMN(icpTable, COLUMNS.id),
      COLUMN(icpTable, COLUMNS.workspaceId),
      COLUMN(icpTable, COLUMNS.industries),
      COLUMN(icpTable, COLUMNS.companySizes),
      COLUMN(icpTable, COLUMNS.geographies),
      COLUMN(icpTable, COLUMNS.businessModels),
      COLUMN(icpTable, COLUMNS.characteristics),
      COLUMN(icpTable, COLUMNS.disqualifiers),
      COLUMN(icpTable, COLUMNS.notes),
    ],
    `${COLUMN(icpTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(icpTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
UNIQUE("${COLUMNS.workspaceId}")`,
  ),
  createTableSql(
    personaTable,
    [
      COLUMN(personaTable, COLUMNS.id),
      COLUMN(personaTable, COLUMNS.workspaceId),
      COLUMN(personaTable, COLUMNS.title),
      COLUMN(personaTable, COLUMNS.responsibilities),
      COLUMN(personaTable, COLUMNS.painPoints),
      COLUMN(personaTable, COLUMNS.goals),
      COLUMN(personaTable, COLUMNS.buyingContext),
    ],
    `${COLUMN(personaTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(personaTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE`,
  ),
  createTableSql(
    positioningTable,
    [
      COLUMN(positioningTable, COLUMNS.id),
      COLUMN(positioningTable, COLUMNS.workspaceId),
      COLUMN(positioningTable, COLUMNS.statement),
      COLUMN(positioningTable, COLUMNS.differentiators),
      COLUMN(positioningTable, COLUMNS.approvedValuePropositions),
      COLUMN(positioningTable, COLUMNS.competitorContext),
    ],
    `${COLUMN(positioningTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(positioningTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
UNIQUE("${COLUMNS.workspaceId}")`,
  ),
  createTableSql(
    brandVoiceTable,
    [
      COLUMN(brandVoiceTable, COLUMNS.id),
      COLUMN(brandVoiceTable, COLUMNS.workspaceId),
      COLUMN(brandVoiceTable, COLUMNS.tone),
      COLUMN(brandVoiceTable, COLUMNS.style),
      COLUMN(brandVoiceTable, COLUMNS.terminology),
      COLUMN(brandVoiceTable, COLUMNS.constraints),
    ],
    `${COLUMN(brandVoiceTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(brandVoiceTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
UNIQUE("${COLUMNS.workspaceId}")`,
  ),
  createTableSql(
    claimTable,
    [
      COLUMN(claimTable, COLUMNS.id),
      COLUMN(claimTable, COLUMNS.workspaceId),
      COLUMN(claimTable, COLUMNS.text),
      COLUMN(claimTable, COLUMNS.category),
      COLUMN(claimTable, COLUMNS.status),
      COLUMN(claimTable, COLUMNS.sourceNote),
      COLUMN(claimTable, COLUMNS.approvedBy),
      COLUMN(claimTable, COLUMNS.approvedAt),
    ],
    `${COLUMN(claimTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(claimTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(claimTable, COLUMNS.status)} CHECK (${COLUMN(claimTable, COLUMNS.status)} IN ('approved','unverified','restricted'))`,
  ),
  createTableSql(
    revenueGoalTable,
    [
      COLUMN(revenueGoalTable, COLUMNS.id),
      COLUMN(revenueGoalTable, COLUMNS.workspaceId),
      COLUMN(revenueGoalTable, COLUMNS.ownerId),
      COLUMN(revenueGoalTable, COLUMNS.objective),
      COLUMN(revenueGoalTable, COLUMNS.targetMetric),
      COLUMN(revenueGoalTable, COLUMNS.targetValue),
      COLUMN(revenueGoalTable, COLUMNS.currency),
      COLUMN(revenueGoalTable, COLUMNS.timeWindow),
      COLUMN(revenueGoalTable, COLUMNS.market),
      COLUMN(revenueGoalTable, COLUMNS.icpId),
      COLUMN(revenueGoalTable, COLUMNS.buyerPersonaIds),
      COLUMN(revenueGoalTable, COLUMNS.offerId),
      COLUMN(revenueGoalTable, COLUMNS.economics),
      COLUMN(revenueGoalTable, COLUMNS.constraints),
      COLUMN(revenueGoalTable, COLUMNS.approvalPolicy),
      COLUMN(revenueGoalTable, COLUMNS.successMetrics),
      COLUMN(revenueGoalTable, COLUMNS.status),
      COLUMN(revenueGoalTable, COLUMNS.completeness),
      COLUMN(revenueGoalTable, COLUMNS.unknowns),
      COLUMN(revenueGoalTable, COLUMNS.assumptions),
    ],
    `${COLUMN(revenueGoalTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(revenueGoalTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenueGoalTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenueGoalTable, COLUMNS.targetValue)} CHECK (${COLUMN(revenueGoalTable, COLUMNS.targetValue)} > 0),
${COLUMN(revenueGoalTable, COLUMNS.status)} CHECK (${COLUMN(revenueGoalTable, COLUMNS.status)} IN ('draft','active','paused','completed','archived'))`,
  ),
  createTableSql(
    revenueGoalEventTable,
    [
      COLUMN(revenueGoalEventTable, COLUMNS.id),
      COLUMN(revenueGoalEventTable, COLUMNS.goalId),
      COLUMN(revenueGoalEventTable, COLUMNS.workspaceId),
      COLUMN(revenueGoalEventTable, COLUMNS.actorUserId),
      COLUMN(revenueGoalEventTable, COLUMNS.kind),
      COLUMN(revenueGoalEventTable, COLUMNS.fromStatus),
      COLUMN(revenueGoalEventTable, COLUMNS.toStatus),
    ],
    `${COLUMN(revenueGoalEventTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(revenueGoalEventTable, COLUMNS.goalId)} REFERENCES "${revenueGoalTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenueGoalEventTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE`,
  ),
  createTableSql(
    revenuePlanTable,
    [
      COLUMN(revenuePlanTable, COLUMNS.id),
      COLUMN(revenuePlanTable, COLUMNS.workspaceId),
      COLUMN(revenuePlanTable, COLUMNS.ownerId),
      COLUMN(revenuePlanTable, COLUMNS.revenueGoalId),
      COLUMN(revenuePlanTable, COLUMNS.planVersion),
      COLUMN(revenuePlanTable, COLUMNS.compilerVersion),
      COLUMN(revenuePlanTable, COLUMNS.brainSnapshotDigest),
      COLUMN(revenuePlanTable, COLUMNS.references),
      COLUMN(revenuePlanTable, COLUMNS.strategies),
      COLUMN(revenuePlanTable, COLUMNS.facts),
      COLUMN(revenuePlanTable, COLUMNS.inferences),
      COLUMN(revenuePlanTable, COLUMNS.assumptions),
      COLUMN(revenuePlanTable, COLUMNS.recommendations),
      COLUMN(revenuePlanTable, COLUMNS.unknowns),
      COLUMN(revenuePlanTable, COLUMNS.approval),
      COLUMN(revenuePlanTable, COLUMNS.rationale),
      COLUMN(revenuePlanTable, COLUMNS.status),
    ],
    `${COLUMN(revenuePlanTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(revenuePlanTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenuePlanTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenuePlanTable, COLUMNS.revenueGoalId)} REFERENCES "${revenueGoalTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(revenuePlanTable, COLUMNS.planVersion)} CHECK (${COLUMN(revenuePlanTable, COLUMNS.planVersion)} > 0),
${COLUMN(revenuePlanTable, COLUMNS.status)} CHECK (${COLUMN(revenuePlanTable, COLUMNS.status)} IN ('draft','proposed','approved','archived'))`,
  ),
  createTableSql(
    accountTable,
    [
      COLUMN(accountTable, COLUMNS.id),
      COLUMN(accountTable, COLUMNS.workspaceId),
      COLUMN(accountTable, COLUMNS.ownerId),
      COLUMN(accountTable, COLUMNS.name),
      COLUMN(accountTable, COLUMNS.website),
      COLUMN(accountTable, COLUMNS.domain),
      COLUMN(accountTable, COLUMNS.industry),
      COLUMN(accountTable, COLUMNS.companySize),
      COLUMN(accountTable, COLUMNS.geography),
      COLUMN(accountTable, COLUMNS.description),
      COLUMN(accountTable, COLUMNS.source),
      COLUMN(accountTable, COLUMNS.sourceReference),
      COLUMN(accountTable, COLUMNS.revenuePlanId),
      COLUMN(accountTable, COLUMNS.status),
    ],
    `${COLUMN(accountTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(accountTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(accountTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(accountTable, COLUMNS.name)} NOT NULL,
${COLUMN(accountTable, COLUMNS.source)} CHECK (${COLUMN(accountTable, COLUMNS.source)} IN ('manual','csv','approved_integration')),
${COLUMN(accountTable, COLUMNS.status)} CHECK (${COLUMN(accountTable, COLUMNS.status)} IN ('active','archived'))`,
  ),
  createTableSql(
    contactTable,
    [
      COLUMN(contactTable, COLUMNS.id),
      COLUMN(contactTable, COLUMNS.workspaceId),
      COLUMN(contactTable, COLUMNS.accountId),
      COLUMN(contactTable, COLUMNS.ownerId),
      COLUMN(contactTable, COLUMNS.firstName),
      COLUMN(contactTable, COLUMNS.lastName),
      COLUMN(contactTable, COLUMNS.fullName),
      COLUMN(contactTable, COLUMNS.jobTitle),
      COLUMN(contactTable, COLUMNS.email),
      COLUMN(contactTable, COLUMNS.phone),
      COLUMN(contactTable, COLUMNS.profileUrl),
      COLUMN(contactTable, COLUMNS.source),
      COLUMN(contactTable, COLUMNS.sourceReference),
      COLUMN(contactTable, COLUMNS.status),
    ],
    `${COLUMN(contactTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(contactTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(contactTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(contactTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(contactTable, COLUMNS.source)} CHECK (${COLUMN(contactTable, COLUMNS.source)} IN ('manual','csv','approved_integration')),
${COLUMN(contactTable, COLUMNS.status)} CHECK (${COLUMN(contactTable, COLUMNS.status)} IN ('active','archived'))`,
  ),
  createTableSql(
    researchRequestTable,
    [
      COLUMN(researchRequestTable, COLUMNS.id),
      COLUMN(researchRequestTable, COLUMNS.workspaceId),
      COLUMN(researchRequestTable, COLUMNS.accountId),
      COLUMN(researchRequestTable, COLUMNS.ownerId),
      COLUMN(researchRequestTable, COLUMNS.provider),
      COLUMN(researchRequestTable, COLUMNS.status),
      COLUMN(researchRequestTable, COLUMNS.categories),
      COLUMN(researchRequestTable, COLUMNS.idempotencyKey),
      COLUMN(researchRequestTable, COLUMNS.findingCount),
      COLUMN(researchRequestTable, COLUMNS.failureCode),
      COLUMN(researchRequestTable, COLUMNS.failureMessage),
      COLUMN(researchRequestTable, COLUMNS.startedAt),
      COLUMN(researchRequestTable, COLUMNS.completedAt),
    ],
    `${COLUMN(researchRequestTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(researchRequestTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchRequestTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchRequestTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchRequestTable, COLUMNS.status)} CHECK (${COLUMN(researchRequestTable, COLUMNS.status)} IN ('pending','running','completed','failed','cancelled'))`,
  ),
  createTableSql(
    researchFindingTable,
    [
      COLUMN(researchFindingTable, COLUMNS.id),
      COLUMN(researchFindingTable, COLUMNS.workspaceId),
      COLUMN(researchFindingTable, COLUMNS.researchRequestId),
      COLUMN(researchFindingTable, COLUMNS.accountId),
      COLUMN(researchFindingTable, COLUMNS.category),
      COLUMN(researchFindingTable, COLUMNS.field),
      COLUMN(researchFindingTable, COLUMNS.value),
      COLUMN(researchFindingTable, COLUMNS.claimKind),
      COLUMN(researchFindingTable, COLUMNS.source),
      COLUMN(researchFindingTable, COLUMNS.sourceName),
      COLUMN(researchFindingTable, COLUMNS.sourceUrl),
      COLUMN(researchFindingTable, COLUMNS.sourceTitle),
      COLUMN(researchFindingTable, COLUMNS.observedAt),
      COLUMN(researchFindingTable, COLUMNS.retrievedAt),
      COLUMN(researchFindingTable, COLUMNS.confidence),
      COLUMN(researchFindingTable, COLUMNS.freshness),
      COLUMN(researchFindingTable, COLUMNS.relevance),
      COLUMN(researchFindingTable, COLUMNS.note),
      COLUMN(researchFindingTable, COLUMNS.status),
    ],
    `${COLUMN(researchFindingTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(researchFindingTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchFindingTable, COLUMNS.researchRequestId)} REFERENCES "${researchRequestTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchFindingTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(researchFindingTable, COLUMNS.source)} CHECK (${COLUMN(researchFindingTable, COLUMNS.source)} IN ('account_record','approved_api','public_web')),
${COLUMN(researchFindingTable, COLUMNS.claimKind)} CHECK (${COLUMN(researchFindingTable, COLUMNS.claimKind)} IN ('fact','inference','hypothesis','recommendation')),
${COLUMN(researchFindingTable, COLUMNS.status)} CHECK (${COLUMN(researchFindingTable, COLUMNS.status)} IN ('recorded'))`,
  ),
  createTableSql(
    accountClaimTable,
    [
      COLUMN(accountClaimTable, COLUMNS.id),
      COLUMN(accountClaimTable, COLUMNS.workspaceId),
      COLUMN(accountClaimTable, COLUMNS.accountId),
      COLUMN(accountClaimTable, COLUMNS.category),
      COLUMN(accountClaimTable, COLUMNS.field),
      COLUMN(accountClaimTable, COLUMNS.value),
      COLUMN(accountClaimTable, COLUMNS.claimKind),
      COLUMN(accountClaimTable, COLUMNS.status),
    ],
    `${COLUMN(accountClaimTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(accountClaimTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(accountClaimTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(accountClaimTable, COLUMNS.claimKind)} CHECK (${COLUMN(accountClaimTable, COLUMNS.claimKind)} IN ('fact','inference','hypothesis','recommendation')),
${COLUMN(accountClaimTable, COLUMNS.status)} CHECK (${COLUMN(accountClaimTable, COLUMNS.status)} IN ('asserted','contested','retracted'))`,
  ),
  createTableSql(
    evidenceTable,
    [
      COLUMN(evidenceTable, COLUMNS.id),
      COLUMN(evidenceTable, COLUMNS.workspaceId),
      COLUMN(evidenceTable, COLUMNS.accountId),
      COLUMN(evidenceTable, COLUMNS.accountClaimId),
      COLUMN(evidenceTable, COLUMNS.researchFindingId),
      COLUMN(evidenceTable, COLUMNS.provenance),
      COLUMN(evidenceTable, COLUMNS.source),
      COLUMN(evidenceTable, COLUMNS.sourceName),
      COLUMN(evidenceTable, COLUMNS.sourceUrl),
      COLUMN(evidenceTable, COLUMNS.sourceTitle),
      COLUMN(evidenceTable, COLUMNS.observedAt),
      COLUMN(evidenceTable, COLUMNS.retrievedAt),
      COLUMN(evidenceTable, COLUMNS.confidence),
      COLUMN(evidenceTable, COLUMNS.freshness),
      COLUMN(evidenceTable, COLUMNS.relevance),
      COLUMN(evidenceTable, COLUMNS.note),
      COLUMN(evidenceTable, COLUMNS.status),
    ],
    `${COLUMN(evidenceTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(evidenceTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(evidenceTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(evidenceTable, COLUMNS.accountClaimId)} REFERENCES "${accountClaimTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(evidenceTable, COLUMNS.researchFindingId)} REFERENCES "${researchFindingTable}"("${COLUMNS.id}") ON DELETE SET NULL,
${COLUMN(evidenceTable, COLUMNS.provenance)} CHECK (${COLUMN(evidenceTable, COLUMNS.provenance)} IN ('research_finding','user_supplied')),
${COLUMN(evidenceTable, COLUMNS.source)} CHECK (${COLUMN(evidenceTable, COLUMNS.source)} IN ('account_record','approved_api','public_web')),
${COLUMN(evidenceTable, COLUMNS.status)} CHECK (${COLUMN(evidenceTable, COLUMNS.status)} IN ('recorded','superseded','contradicted','rejected'))`,
  ),
  createTableSql(
    qualificationTable,
    [
      COLUMN(qualificationTable, COLUMNS.id),
      COLUMN(qualificationTable, COLUMNS.workspaceId),
      COLUMN(qualificationTable, COLUMNS.accountId),
      COLUMN(qualificationTable, COLUMNS.ownerId),
      COLUMN(qualificationTable, COLUMNS.version),
      COLUMN(qualificationTable, COLUMNS.ruleVersion),
      COLUMN(qualificationTable, COLUMNS.revenuePlanId),
      COLUMN(qualificationTable, COLUMNS.revenueGoalId),
      COLUMN(qualificationTable, COLUMNS.icpId),
      COLUMN(qualificationTable, COLUMNS.contextDigest),
      COLUMN(qualificationTable, COLUMNS.state),
      COLUMN(qualificationTable, COLUMNS.score),
      COLUMN(qualificationTable, COLUMNS.confidence),
      COLUMN(qualificationTable, COLUMNS.reason),
      COLUMN(qualificationTable, COLUMNS.evidenceIds),
      COLUMN(qualificationTable, COLUMNS.claimIds),
      COLUMN(qualificationTable, COLUMNS.conflictedClaimIds),
      COLUMN(qualificationTable, COLUMNS.dimensions),
      COLUMN(qualificationTable, COLUMNS.evaluatedAt),
    ],
    `${COLUMN(qualificationTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(qualificationTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(qualificationTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(qualificationTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(qualificationTable, COLUMNS.revenuePlanId)} REFERENCES "${revenuePlanTable}"("${COLUMNS.id}") ON DELETE SET NULL,
${COLUMN(qualificationTable, COLUMNS.revenueGoalId)} REFERENCES "${revenueGoalTable}"("${COLUMNS.id}") ON DELETE SET NULL,
${COLUMN(qualificationTable, COLUMNS.icpId)} REFERENCES "${icpTable}"("${COLUMNS.id}") ON DELETE SET NULL,
${COLUMN(qualificationTable, COLUMNS.version)} CHECK (${COLUMN(qualificationTable, COLUMNS.version)} > 0),
${COLUMN(qualificationTable, COLUMNS.score)} CHECK (${COLUMN(qualificationTable, COLUMNS.score)} IS NULL OR (${COLUMN(qualificationTable, COLUMNS.score)} >= 0 AND ${COLUMN(qualificationTable, COLUMNS.score)} <= 100)),
${COLUMN(qualificationTable, COLUMNS.state)} CHECK (${COLUMN(qualificationTable, COLUMNS.state)} IN ('qualified','unqualified','insufficient_data','contested'))`,
  ),
  createTableSql(
    personalizedDraftTable,
    [
      COLUMN(personalizedDraftTable, COLUMNS.id),
      COLUMN(personalizedDraftTable, COLUMNS.workspaceId),
      COLUMN(personalizedDraftTable, COLUMNS.accountId),
      COLUMN(personalizedDraftTable, COLUMNS.contactId),
      COLUMN(personalizedDraftTable, COLUMNS.ownerId),
      COLUMN(personalizedDraftTable, COLUMNS.version),
      COLUMN(personalizedDraftTable, COLUMNS.rendererVersion),
      COLUMN(personalizedDraftTable, COLUMNS.contextDigest),
      COLUMN(personalizedDraftTable, COLUMNS.qualificationId),
      COLUMN(personalizedDraftTable, COLUMNS.offerId),
      COLUMN(personalizedDraftTable, COLUMNS.subject),
      COLUMN(personalizedDraftTable, COLUMNS.body),
      COLUMN(personalizedDraftTable, COLUMNS.personalizationPoints),
      COLUMN(personalizedDraftTable, COLUMNS.approvedClaimIds),
      COLUMN(personalizedDraftTable, COLUMNS.warnings),
    ],
    `${COLUMN(personalizedDraftTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(personalizedDraftTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(personalizedDraftTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(personalizedDraftTable, COLUMNS.contactId)} REFERENCES "${contactTable}"("${COLUMNS.id}") ON DELETE SET NULL,
${COLUMN(personalizedDraftTable, COLUMNS.ownerId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(personalizedDraftTable, COLUMNS.qualificationId)} REFERENCES "${qualificationTable}"("${COLUMNS.id}") ON DELETE SET NULL,
${COLUMN(personalizedDraftTable, COLUMNS.offerId)} REFERENCES "${offerTable}"("${COLUMNS.id}") ON DELETE SET NULL,
${COLUMN(personalizedDraftTable, COLUMNS.version)} CHECK (${COLUMN(personalizedDraftTable, COLUMNS.version)} > 0)`,
  ),
  createTableSql(
    approvalRequestTable,
    [
      COLUMN(approvalRequestTable, COLUMNS.id),
      COLUMN(approvalRequestTable, COLUMNS.workspaceId),
      COLUMN(approvalRequestTable, COLUMNS.userId),
      COLUMN(approvalRequestTable, COLUMNS.actionKind),
      COLUMN(approvalRequestTable, COLUMNS.riskLevel),
      COLUMN(approvalRequestTable, COLUMNS.draftId),
      COLUMN(approvalRequestTable, COLUMNS.draftVersion),
      COLUMN(approvalRequestTable, COLUMNS.previewSubject),
      COLUMN(approvalRequestTable, COLUMNS.previewDigest),
      COLUMN(approvalRequestTable, COLUMNS.status),
      COLUMN(approvalRequestTable, COLUMNS.decision),
      COLUMN(approvalRequestTable, COLUMNS.decidedBy),
      COLUMN(approvalRequestTable, COLUMNS.decidedAt),
      COLUMN(approvalRequestTable, COLUMNS.decisionReason),
      COLUMN(approvalRequestTable, COLUMNS.expiresAt),
    ],
    `${COLUMN(approvalRequestTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(approvalRequestTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(approvalRequestTable, COLUMNS.userId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(approvalRequestTable, COLUMNS.id)} REFERENCES "${personalizedDraftTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(approvalRequestTable, COLUMNS.draftVersion)} CHECK (${COLUMN(approvalRequestTable, COLUMNS.draftVersion)} > 0),
${COLUMN(approvalRequestTable, COLUMNS.actionKind)} CHECK (${COLUMN(approvalRequestTable, COLUMNS.actionKind)} IN ('send_message')),
${COLUMN(approvalRequestTable, COLUMNS.riskLevel)} CHECK (${COLUMN(approvalRequestTable, COLUMNS.riskLevel)} IN ('level_0_read','level_1_draft','level_2_external_action','level_3_high_impact')),
${COLUMN(approvalRequestTable, COLUMNS.status)} CHECK (${COLUMN(approvalRequestTable, COLUMNS.status)} IN ('pending','approved','rejected','changes_requested','cancelled','expired')),
${COLUMN(approvalRequestTable, COLUMNS.decision)} CHECK (${COLUMN(approvalRequestTable, COLUMNS.decision)} IS NULL OR ${COLUMN(approvalRequestTable, COLUMNS.decision)} IN ('approved','rejected','changes_requested'))`,
  ),
  createTableSql(
    approvalRequestEventTable,
    [
      COLUMN(approvalRequestEventTable, COLUMNS.id),
      COLUMN(approvalRequestEventTable, COLUMNS.approvalId),
      COLUMN(approvalRequestEventTable, COLUMNS.workspaceId),
      COLUMN(approvalRequestEventTable, COLUMNS.actorUserId),
      COLUMN(approvalRequestEventTable, COLUMNS.kind),
      COLUMN(approvalRequestEventTable, COLUMNS.detail),
    ],
    `${COLUMN(approvalRequestEventTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(approvalRequestEventTable, COLUMNS.approvalId)} REFERENCES "${approvalRequestTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(approvalRequestEventTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(approvalRequestEventTable, COLUMNS.actorUserId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(approvalRequestEventTable, COLUMNS.kind)} CHECK (${COLUMN(approvalRequestEventTable, COLUMNS.kind)} IN ('requested','approved','rejected','changes_requested','cancelled','expired'))`,
  ),
  createTableSql(
    outboundActionTable,
    [
      COLUMN(outboundActionTable, COLUMNS.id),
      COLUMN(outboundActionTable, COLUMNS.workspaceId),
      COLUMN(outboundActionTable, COLUMNS.createdBy),
      COLUMN(outboundActionTable, COLUMNS.channel),
      COLUMN(outboundActionTable, COLUMNS.draftId),
      COLUMN(outboundActionTable, COLUMNS.draftVersion),
      COLUMN(outboundActionTable, COLUMNS.draftDigest),
      COLUMN(outboundActionTable, COLUMNS.approvalId),
      COLUMN(outboundActionTable, COLUMNS.contactId),
      COLUMN(outboundActionTable, COLUMNS.recipientEmail),
      COLUMN(outboundActionTable, COLUMNS.provider),
      COLUMN(outboundActionTable, COLUMNS.status),
      COLUMN(outboundActionTable, COLUMNS.attemptCount),
      COLUMN(outboundActionTable, COLUMNS.providerReference),
      COLUMN(outboundActionTable, COLUMNS.failureCode),
      COLUMN(outboundActionTable, COLUMNS.failureMessage),
      COLUMN(outboundActionTable, COLUMNS.attemptedAt),
      COLUMN(outboundActionTable, COLUMNS.sentAt),
      COLUMN(outboundActionTable, COLUMNS.completedAt),
    ],
    `${COLUMN(outboundActionTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(outboundActionTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundActionTable, COLUMNS.createdBy)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundActionTable, COLUMNS.draftId)} REFERENCES "${personalizedDraftTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundActionTable, COLUMNS.approvalId)} REFERENCES "${approvalRequestTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundActionTable, COLUMNS.contactId)} REFERENCES "${contactTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundActionTable, COLUMNS.draftVersion)} CHECK (${COLUMN(outboundActionTable, COLUMNS.draftVersion)} > 0),
${COLUMN(outboundActionTable, COLUMNS.channel)} CHECK (${COLUMN(outboundActionTable, COLUMNS.channel)} IN ('email')),
${COLUMN(outboundActionTable, COLUMNS.status)} CHECK (${COLUMN(outboundActionTable, COLUMNS.status)} IN ('ready','sending','sent','failed','cancelled')),
${COLUMN(outboundActionTable, COLUMNS.attemptCount)} CHECK (${COLUMN(outboundActionTable, COLUMNS.attemptCount)} >= 0),
${COLUMN(outboundActionTable, COLUMNS.failureCode)} CHECK (${COLUMN(outboundActionTable, COLUMNS.failureCode)} IS NULL OR ${COLUMN(outboundActionTable, COLUMNS.failureCode)} IN ('invalid_recipient','provider_rejected','rate_limited','suppressed','provider_unavailable')),
${COLUMN(outboundActionTable, COLUMNS.sentAt)} CHECK (${COLUMN(outboundActionTable, COLUMNS.sentAt)} IS NULL OR ${COLUMN(outboundActionTable, COLUMNS.status)} = 'sent')`,
  ),
  createTableSql(
    outboundEventTable,
    [
      COLUMN(outboundEventTable, COLUMNS.id),
      COLUMN(outboundEventTable, COLUMNS.actionId),
      COLUMN(outboundEventTable, COLUMNS.workspaceId),
      COLUMN(outboundEventTable, COLUMNS.actorUserId),
      COLUMN(outboundEventTable, COLUMNS.kind),
      COLUMN(outboundEventTable, COLUMNS.detail),
    ],
    `${COLUMN(outboundEventTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(outboundEventTable, COLUMNS.actionId)} REFERENCES "${outboundActionTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundEventTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundEventTable, COLUMNS.actorUserId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundEventTable, COLUMNS.kind)} CHECK (${COLUMN(outboundEventTable, COLUMNS.kind)} IN ('created','send_attempted','sent','failed','cancelled'))`,
  ),
  createTableSql(
    outboundSuppressionTable,
    [
      COLUMN(outboundSuppressionTable, COLUMNS.id),
      COLUMN(outboundSuppressionTable, COLUMNS.workspaceId),
      COLUMN(outboundSuppressionTable, COLUMNS.email),
      COLUMN(outboundSuppressionTable, COLUMNS.reason),
      COLUMN(outboundSuppressionTable, COLUMNS.createdBy),
    ],
    `${COLUMN(outboundSuppressionTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(outboundSuppressionTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundSuppressionTable, COLUMNS.createdBy)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(outboundSuppressionTable, COLUMNS.email)} CHECK (${COLUMN(outboundSuppressionTable, COLUMNS.email)} = lower(${COLUMN(outboundSuppressionTable, COLUMNS.email)}))`,
  ),
  createTableSql(
    inboundMessageTable,
    [
      COLUMN(inboundMessageTable, COLUMNS.id),
      COLUMN(inboundMessageTable, COLUMNS.workspaceId),
      COLUMN(inboundMessageTable, COLUMNS.createdBy),
      COLUMN(inboundMessageTable, COLUMNS.outboundActionId),
      COLUMN(inboundMessageTable, COLUMNS.contactId),
      COLUMN(inboundMessageTable, COLUMNS.accountId),
      COLUMN(inboundMessageTable, COLUMNS.source),
      COLUMN(inboundMessageTable, COLUMNS.fromAddress),
      COLUMN(inboundMessageTable, COLUMNS.subject),
      COLUMN(inboundMessageTable, COLUMNS.body),
      COLUMN(inboundMessageTable, COLUMNS.providerMessageId),
      COLUMN(inboundMessageTable, COLUMNS.receivedAt),
    ],
    `${COLUMN(inboundMessageTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(inboundMessageTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(inboundMessageTable, COLUMNS.createdBy)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(inboundMessageTable, COLUMNS.outboundActionId)} REFERENCES "${outboundActionTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(inboundMessageTable, COLUMNS.contactId)} REFERENCES "${contactTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(inboundMessageTable, COLUMNS.accountId)} REFERENCES "${accountTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(inboundMessageTable, COLUMNS.source)} CHECK (${COLUMN(inboundMessageTable, COLUMNS.source)} IN ('manual','provider_ingest')),
${COLUMN(inboundMessageTable, COLUMNS.body)} CHECK (length(${COLUMN(inboundMessageTable, COLUMNS.body)}) > 0)`,
  ),
  createTableSql(
    conversationClassificationTable,
    [
      COLUMN(conversationClassificationTable, COLUMNS.id),
      COLUMN(conversationClassificationTable, COLUMNS.workspaceId),
      COLUMN(conversationClassificationTable, COLUMNS.inboundMessageId),
      COLUMN(conversationClassificationTable, COLUMNS.outboundActionId),
      COLUMN(conversationClassificationTable, COLUMNS.classifierVersion),
      COLUMN(conversationClassificationTable, COLUMNS.intent),
      COLUMN(conversationClassificationTable, COLUMNS.confidence),
      COLUMN(conversationClassificationTable, COLUMNS.reasons),
      COLUMN(conversationClassificationTable, COLUMNS.signals),
      COLUMN(conversationClassificationTable, COLUMNS.recommendedNextAction),
      COLUMN(conversationClassificationTable, COLUMNS.humanInterventionRequired),
      COLUMN(conversationClassificationTable, COLUMNS.suppressed),
      COLUMN(conversationClassificationTable, COLUMNS.createdBy),
    ],
    `${COLUMN(conversationClassificationTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(conversationClassificationTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(conversationClassificationTable, COLUMNS.inboundMessageId)} REFERENCES "${inboundMessageTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(conversationClassificationTable, COLUMNS.outboundActionId)} REFERENCES "${outboundActionTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(conversationClassificationTable, COLUMNS.createdBy)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(conversationClassificationTable, COLUMNS.intent)} CHECK (${COLUMN(conversationClassificationTable, COLUMNS.intent)} IN ('interested','question','pricing','objection','not_now','wrong_person','unsubscribe','positive_intent','negative_intent','unknown')),
${COLUMN(conversationClassificationTable, COLUMNS.confidence)} CHECK (${COLUMN(conversationClassificationTable, COLUMNS.confidence)} IN ('low','medium','high')),
${COLUMN(conversationClassificationTable, COLUMNS.recommendedNextAction)} CHECK (${COLUMN(conversationClassificationTable, COLUMNS.recommendedNextAction)} IN ('stop_contacting','prepare_reply_for_approval','request_human_review','record_and_hold')),
${COLUMN(conversationClassificationTable, COLUMNS.humanInterventionRequired)} CHECK (${COLUMN(conversationClassificationTable, COLUMNS.humanInterventionRequired)} = true OR ${COLUMN(conversationClassificationTable, COLUMNS.intent)} = 'unsubscribe'),
${COLUMN(conversationClassificationTable, COLUMNS.suppressed)} CHECK (${COLUMN(conversationClassificationTable, COLUMNS.suppressed)} = false OR ${COLUMN(conversationClassificationTable, COLUMNS.intent)} = 'unsubscribe')`,
  ),
  createTableSql(
    conversationEventTable,
    [
      COLUMN(conversationEventTable, COLUMNS.id),
      COLUMN(conversationEventTable, COLUMNS.classificationId),
      COLUMN(conversationEventTable, COLUMNS.inboundMessageId),
      COLUMN(conversationEventTable, COLUMNS.workspaceId),
      COLUMN(conversationEventTable, COLUMNS.actorUserId),
      COLUMN(conversationEventTable, COLUMNS.kind),
      COLUMN(conversationEventTable, COLUMNS.detail),
    ],
    `${COLUMN(conversationEventTable, COLUMNS.id)} PRIMARY KEY,
${COLUMN(conversationEventTable, COLUMNS.classificationId)} REFERENCES "${conversationClassificationTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(conversationEventTable, COLUMNS.inboundMessageId)} REFERENCES "${inboundMessageTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(conversationEventTable, COLUMNS.workspaceId)} REFERENCES "${workspaceTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(conversationEventTable, COLUMNS.actorUserId)} REFERENCES "${userTable}"("${COLUMNS.id}") ON DELETE CASCADE,
${COLUMN(conversationEventTable, COLUMNS.kind)} CHECK (${COLUMN(conversationEventTable, COLUMNS.kind)} IN ('recorded','classified','suppressed','escalated','held'))`,
  ),
].join("\n\n");

/** Normalize a workspace slug from a display name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Validate a scalar against a hard length cap so oversized input fails fast. */
export function capString(value: string, max: number): string {
  if (value.length > max) {
    throw new Error(`must be at most ${max} characters`);
  }
  return value;
}
