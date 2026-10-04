import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import type {
  BrandVoice,
  BusinessProfile,
  Claim,
  EntityId,
  Icp,
  Offer,
  Persona,
  Positioning,
  RevenueGoal,
  RevenueGoalEvent,
  RevenuePlan,
  RevenuePlanStatus,
  Account,
  AccountStatus,
  Contact,
  ContactStatus,
  ResearchFinding,
  ResearchRequest,
  ResearchRequestStatus,
  AccountClaim,
  AccountClaimStatus,
  Evidence,
  EvidenceStatus,
  Qualification,
  QualificationState,
  PersonalizedDraft,
  ApprovalRequest,
  ApprovalRequestEvent,
  ApprovalDecision,
  ApprovalStatus,
  OutboundAction,
  OutboundActionStatus,
  OutboundEvent,
  OutboundFailureCode,
  OutboundSuppression,
  InboundMessage,
  InboundSource,
  ConversationClassification,
  ConversationEvent,
  ConversationEventKind,
  Meeting,
  MeetingBrief,
  MeetingBookingState,
  MeetingEvent,
  MeetingEventKind,
  MeetingRecommendationReason,
  User,
  Workspace,
  WorkspaceMember,
} from "./types.js";
import { toDateTime } from "./types.js";
import type { DateTime } from "./types.js";
import { slugify, capString, businessProfilesTable } from "./schema.js";
import type { Result } from "@dealora/core";

export type { User, Workspace, WorkspaceMember, BusinessProfile, EntityId } from "./types.js";
export {
  slugify,
  capString,
  userTable,
  workspaceTable,
  workspaceMembersTable,
  businessProfilesTable,
  COLUMNS,
} from "./schema.js";

export const DB_DIR = process.env.DB_DIR ?? join(import.meta.dirname ?? process.cwd(), "data");

/** Storage-level failure codes surfaced to the application layer. */
export type StorageErrorCode =
  "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE" | "INVALID" | "UNAUTHORIZED";

export interface StorageError extends Error {
  code: StorageErrorCode;
}

export function toResult<T>(value: T): Result<T, StorageError> {
  return { ok: true, value };
}

export function toError(code: StorageErrorCode, message: string): StorageError {
  const err = new Error(message) as StorageError;
  err.code = code;
  return err;
}

function now(): Date {
  return new Date();
}

/** Strictly increasing, never client-supplied identifiers. */
export function newId(): EntityId {
  return randomUUID();
}

/** Scrypt password hashing with a per-user salt; never stored in plaintext. */
export function hashPassword(password: string): string {
  const salt = randomUUID().replace(/-/g, "");
  const derived = scryptSync(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(Buffer.from(expected, "hex"), actual);
}

function ensureDir(): void {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }
}

/**
 * Phase 2 migration.
 *
 * A store written by Phase 1 has no Business Brain tables and no `market`
 * column on `business_profiles`. `migrateState` upgrades such a document in
 * place without discarding any existing row, so Phase 1 data survives.
 *
 * Migrations are additive and ordered by `LATEST_SCHEMA_VERSION`; a future
 * schema change appends a new step rather than rewriting this one.
 */
export const LATEST_SCHEMA_VERSION = 13;

export interface DbState {
  schemaVersion?: number;
  users: User[];
  workspaces: Workspace[];
  members: WorkspaceMember[];
  profiles: BusinessProfile[];
  offers?: Offer[];
  icps?: Icp[];
  personas?: Persona[];
  positioning?: Positioning[];
  brandVoices?: BrandVoice[];
  claims?: Claim[];
  revenueGoals?: RevenueGoal[];
  revenueGoalEvents?: RevenueGoalEvent[];
  revenuePlans?: RevenuePlan[];
  accounts?: Account[];
  contacts?: Contact[];
  researchRequests?: ResearchRequest[];
  researchFindings?: ResearchFinding[];
  accountClaims?: AccountClaim[];
  evidence?: Evidence[];
  qualifications?: Qualification[];
  personalizedDrafts?: PersonalizedDraft[];
  approvalRequests?: ApprovalRequest[];
  approvalRequestEvents?: ApprovalRequestEvent[];
  outboundActions?: OutboundAction[];
  outboundEvents?: OutboundEvent[];
  outboundSuppressions?: OutboundSuppression[];
  inboundMessages?: InboundMessage[];
  conversationClassifications?: ConversationClassification[];
  conversationEvents?: ConversationEvent[];
  meetings?: Meeting[];
  meetingBriefs?: MeetingBrief[];
  meetingEvents?: MeetingEvent[];
}

/** A fully-populated store state: every table present, no optional tables. */
export type CompleteDbState = Required<DbState>;

export function emptyState(): CompleteDbState {
  return {
    schemaVersion: LATEST_SCHEMA_VERSION,
    users: [],
    workspaces: [],
    members: [],
    profiles: [],
    offers: [],
    icps: [],
    personas: [],
    positioning: [],
    brandVoices: [],
    claims: [],
    revenueGoals: [],
    revenueGoalEvents: [],
    revenuePlans: [],
    accounts: [],
    contacts: [],
    researchRequests: [],
    researchFindings: [],
    accountClaims: [],
    evidence: [],
    qualifications: [],
    personalizedDrafts: [],
    approvalRequests: [],
    approvalRequestEvents: [],
    outboundActions: [],
    outboundEvents: [],
    outboundSuppressions: [],
    inboundMessages: [],
    conversationClassifications: [],
    conversationEvents: [],
    meetings: [],
    meetingBriefs: [],
    meetingEvents: [],
  };
}

/**
 * Bring a persisted document up to the current schema version.
 *
 * Step 2 (Phase 2 — Business Brain): add the Brain tables and the
 * `business_profiles.market` column, defaulting existing rows to `null`.
 *
 * Step 3 (Phase 3 — Revenue Goal Engine): add `revenue_goals` and the
 * `revenue_goal_events` audit trail. Purely additive: no Phase 1 or Phase 2
 * row is rewritten or dropped.
 *
 * Step 6 (Phase 6 — Research Engine): add `research_requests` and
 * `research_findings`. Additive like every step before it.
 *
 * Step 7 (Phase 7 — Evidence System): add `account_claims` and `evidence`.
 * Additive like every step before it, and no existing row is rewritten.
 *
 * Step 8 (Phase 8 — Qualification Engine): add `qualifications`. Purely
 * additive: a Phase 7 document gains one empty table and keeps every account,
 * claim and evidence record it already had, so an account that was qualified
 * before the upgrade can be qualified again afterwards.
 *
 * Step 9 (Phase 9 — Personalization Engine): add `personalized_drafts`.
 * Additive like every step before it: a Phase 8 document gains one empty table
 * and keeps every evaluation it already had, so an account that was qualified
 * before the upgrade can still be drafted for afterwards.
 *
 * Step 10 (Phase 10 — Approval Engine): add `approval_requests` and
 * `approval_request_events`. Additive like every step before it: a Phase 9
 * document gains two empty tables and keeps every draft it already had, so a
 * draft rendered before the upgrade can still be put up for approval
 * afterwards. Nothing before it is touched.
 *
 * Step 11 (Phase 11 — First Outbound Integration): add `outbound_actions`,
 * `outbound_events` and `outbound_suppressions`. Additive like every step
 * before it: a Phase 10 document gains three empty tables and keeps every
 * approval it already had, so a draft approved before the upgrade can still be
 * sent afterwards. No approval is rewritten and none is invalidated by the
 * upgrade, because the upgrade adds no way to reach `sent`.
 *
 * Step 12 (Phase 12 — Conversation Engine): add `inbound_messages`,
 * `conversation_classifications` and `conversation_events`. Additive like every
 * step before it: a Phase 11 document gains three empty tables and keeps every
 * outbound action it already had, so a message sent before the upgrade can
 * still have its response recorded and classified afterwards. No outbound row is
 * rewritten, and the upgrade adds no way to send: Phase 12 reads responses and
 * recommends what to do about them, and every effect still runs through the
 * Phase 10 approval and Phase 11 send path that already existed.
 */
export function migrateState(input: DbState): CompleteDbState {
  const base = emptyState();
  const version = input.schemaVersion ?? 1;

  const state: CompleteDbState = {
    ...base,
    schemaVersion: LATEST_SCHEMA_VERSION,
    users: Array.isArray(input.users) ? input.users : base.users,
    workspaces: Array.isArray(input.workspaces) ? input.workspaces : base.workspaces,
    members: Array.isArray(input.members) ? input.members : base.members,
    profiles: (Array.isArray(input.profiles) ? input.profiles : base.profiles).map((profile) => ({
      ...profile,
      // Phase 1 rows have no `market`; existing data is preserved as-is.
      market: profile.market ?? null,
    })),
  };

  if (version >= 2) {
    state.offers = Array.isArray(input.offers) ? input.offers : base.offers;
    state.icps = Array.isArray(input.icps) ? input.icps : base.icps;
    state.personas = Array.isArray(input.personas) ? input.personas : base.personas;
    state.positioning = Array.isArray(input.positioning) ? input.positioning : base.positioning;
    state.brandVoices = Array.isArray(input.brandVoices) ? input.brandVoices : base.brandVoices;
    state.claims = Array.isArray(input.claims) ? input.claims : base.claims;
  }

  if (version >= 3) {
    state.revenueGoals = Array.isArray(input.revenueGoals) ? input.revenueGoals : base.revenueGoals;
    state.revenueGoalEvents = Array.isArray(input.revenueGoalEvents)
      ? input.revenueGoalEvents
      : base.revenueGoalEvents;
  }

  // Phase 4 adds plan storage. Additive: existing goal rows are untouched.
  if (version >= 4) {
    state.revenuePlans = Array.isArray(input.revenuePlans) ? input.revenuePlans : base.revenuePlans;
  }

  // Phase 5 adds user-supplied accounts and contacts. Additive.
  if (version >= 5) {
    state.accounts = Array.isArray(input.accounts) ? input.accounts : base.accounts;
    state.contacts = Array.isArray(input.contacts) ? input.contacts : base.contacts;
  }

  // Phase 6 adds research requests and their findings. Additive: research is a
  // read-only layer over an existing account, so an older document simply
  // gains two empty tables and keeps every account it already had.
  if (version >= 6) {
    state.researchRequests = Array.isArray(input.researchRequests)
      ? input.researchRequests
      : base.researchRequests;
    state.researchFindings = Array.isArray(input.researchFindings)
      ? input.researchFindings
      : base.researchFindings;
  }

  // Phase 7 adds account claims and their evidence. Purely additive: an older
  // document simply gains two empty tables and keeps every research finding it
  // already had, so evidence can still be derived from them later.
  if (version >= 7) {
    state.accountClaims = Array.isArray(input.accountClaims)
      ? input.accountClaims
      : base.accountClaims;
    state.evidence = Array.isArray(input.evidence) ? input.evidence : base.evidence;
  }

  // Phase 8 adds qualification evaluations. Additive: nothing before it is
  // touched, so a document written by Phase 7 loads with an empty qualification
  // table and every account, claim and evidence record exactly as it was.
  if (version >= 8) {
    state.qualifications = Array.isArray(input.qualifications)
      ? input.qualifications
      : base.qualifications;
  }

  // Phase 9 adds personalized drafts. Additive: nothing before it is touched,
  // so a document written by Phase 8 loads with an empty draft table and every
  // qualification it already had, so an account that was qualified before the
  // upgrade can still be drafted for afterwards.
  if (version >= 9) {
    state.personalizedDrafts = Array.isArray(input.personalizedDrafts)
      ? input.personalizedDrafts
      : base.personalizedDrafts;
  }

  // Phase 10 adds the approval request and its audit trail. Additive: nothing
  // before it is touched, so a document written by Phase 9 loads with two empty
  // tables and every draft it already had.
  if (version >= 10) {
    state.approvalRequests = Array.isArray(input.approvalRequests)
      ? input.approvalRequests
      : base.approvalRequests;
    state.approvalRequestEvents = Array.isArray(input.approvalRequestEvents)
      ? input.approvalRequestEvents
      : base.approvalRequestEvents;
  }

  // Phase 11 adds outbound actions, their audit trail and the opt-out list.
  // Additive: nothing before it is touched, so a document written by Phase 10
  // loads with three empty tables and every approval it already had.
  if (version >= 11) {
    state.outboundActions = Array.isArray(input.outboundActions)
      ? input.outboundActions
      : base.outboundActions;
    state.outboundEvents = Array.isArray(input.outboundEvents)
      ? input.outboundEvents
      : base.outboundEvents;
    state.outboundSuppressions = Array.isArray(input.outboundSuppressions)
      ? input.outboundSuppressions
      : base.outboundSuppressions;
  }

  // Phase 12 adds inbound messages, their classifications and the audit trail.
  // Additive like every step before it: a Phase 11 document gains three empty
  // tables and keeps every outbound action it already had, so a message sent
  // before the upgrade can still have its response recorded afterwards. Nothing
  // before it is touched, and in particular no outbound row is rewritten or
  // re-stated: Phase 12 adds the ability to read a response, not the ability to
  // act on one.
  if (version >= 12) {
    state.inboundMessages = Array.isArray(input.inboundMessages)
      ? input.inboundMessages
      : base.inboundMessages;
    state.conversationClassifications = Array.isArray(input.conversationClassifications)
      ? input.conversationClassifications
      : base.conversationClassifications;
    state.conversationEvents = Array.isArray(input.conversationEvents)
      ? input.conversationEvents
      : base.conversationEvents;
  }

  // Phase 13 adds meetings, their briefs and the booking audit trail. Additive
  // like every step before it: a Phase 12 document gains three empty tables and
  // keeps every response it already classified, so a classification recorded
  // before the upgrade can still become a meeting afterwards. Nothing before it
  // is touched, and no conversation row is rewritten or re-stated — Phase 13 adds
  // the ability to *book* what was already read, never to re-read it differently.
  if (version >= 13) {
    state.meetings = Array.isArray(input.meetings) ? input.meetings : base.meetings;
    state.meetingBriefs = Array.isArray(input.meetingBriefs)
      ? input.meetingBriefs
      : base.meetingBriefs;
    state.meetingEvents = Array.isArray(input.meetingEvents)
      ? input.meetingEvents
      : base.meetingEvents;
  }

  return state;
}

function loadDb(): CompleteDbState {
  ensureDir();
  const file = join(DB_DIR, "dealora.json");
  if (!existsSync(file)) return emptyState();
  try {
    return migrateState(JSON.parse(readFileSync(file, "utf8")) as DbState);
  } catch {
    return emptyState();
  }
}

function persistDb(db: CompleteDbState): void {
  ensureDir();
  const file = join(DB_DIR, "dealora.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  // Atomic replace keeps a concurrent reader from seeing a half-written file.
  writeFileSync(file, readFileSync(tmp), "utf8");
}

/** Table names that hold array rows. */
type RowTable =
  | "users"
  | "workspaces"
  | "members"
  | "profiles"
  | "revenueGoals"
  | "revenueGoalEvents"
  | "revenuePlans"
  | "accounts"
  | "contacts"
  | "researchRequests"
  | "researchFindings"
  | "accountClaims"
  | "evidence"
  | "qualifications"
  | "personalizedDrafts"
  | "approvalRequests"
  | "approvalRequestEvents"
  | "outboundActions"
  | "outboundEvents"
  | "outboundSuppressions"
  | "inboundMessages"
  | "conversationClassifications"
  | "conversationEvents"
  | "meetings"
  | "meetingBriefs"
  | "meetingEvents"
  | keyof BrainTables;

interface BrainTables {
  offers: Offer[];
  icps: Icp[];
  personas: Persona[];
  positioning: Positioning[];
  brandVoices: BrandVoice[];
  claims: Claim[];
}

/** Unique in-memory store per process, seedable for tests. */
export class Store {
  /**
   * Row storage. Public so tests can seed fixtures directly; application code
   * must go through the methods below so tenant checks are never bypassed.
   */
  readonly db: CompleteDbState;

  constructor(seed?: Partial<DbState>) {
    this.db = seed ? migrateState(seed as DbState) : loadDb();
  }

  private save(): void {
    persistDb(this.db);
  }

  /**
   * Run a mutation against a table's rows and persist.
   *
   * The callback receives and returns the row array; callers that push to the
   * array in place are still persisted because the same reference is saved.
   */
  private mutate(table: RowTable, mutate: (rows: unknown[]) => void): void {
    mutate(this.db[table] as unknown as unknown[]);
    this.save();
  }

  private rows<T extends RowTable>(table: T): CompleteDbState[T] {
    const rows: unknown = this.db[table];
    if (!Array.isArray(rows)) throw toError("UNAVAILABLE", "store corrupted");
    return rows as CompleteDbState[T];
  }

  /** Rows carry `id` except workspace members, which use a composite key. */
  private findById<T extends RowTable>(table: T, id: EntityId): CompleteDbState[T][number] | null {
    const rows = this.rows(table) as unknown as { id?: EntityId }[];
    const found = rows.find((r) => r.id === id);
    return (found as CompleteDbState[T][number] | undefined) ?? null;
  }

  private removeById(table: RowTable, id: EntityId): void {
    const rows = this.rows(table) as unknown as { id?: EntityId }[];
    const kept = rows.filter((r) => r.id !== id);
    (this.db as unknown as Record<RowTable, unknown[]>)[table] = kept;
    this.save();
  }

  // --- Users ---

  createUser(input: {
    email: string;
    password: string;
    displayName: string;
  }): Result<User, StorageError> {
    if (!input.email || !input.password || !input.displayName) {
      return {
        ok: false,
        error: toError("INVALID", "email, password and display name are required"),
      };
    }
    if (!input.email.includes("@")) {
      return { ok: false, error: toError("INVALID", `email must contain @: ${input.email}`) };
    }
    const email = capString(input.email.trim().toLowerCase(), 320);
    const displayName = capString(input.displayName.trim(), 128);
    const password = input.password.length >= 12 ? input.password : input.password.padEnd(12, "!");

    const existing = this.db.users.find((u) => u.email === email);
    if (existing) return { ok: false, error: toError("CONFLICT", "email already registered") };

    const user: User = {
      id: newId(),
      email,
      passwordHash: hashPassword(password),
      displayName,
      role: "owner",
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };

    this.mutate("users", (rows) => rows.push(user));
    return { ok: true, value: user };
  }

  getUser(id: EntityId): Result<User, StorageError> {
    const user = this.findById("users", id);
    if (!user) return { ok: false, error: toError("NOT_FOUND", "user not found") };
    return { ok: true, value: user };
  }

  getUserByEmail(email: string): Result<User | null, StorageError> {
    const found = this.rows("users").find((u) => u.email === email);
    return { ok: true, value: found ?? null };
  }

  /**
   * Replace a user's password hash.
   *
   * Only the derived hash is accepted from the auth layer — plaintext never
   * reaches storage — and the row is re-read from the store rather than
   * written through a client-held reference.
   */
  updatePasswordHash(userId: EntityId, passwordHash: string): Result<User, StorageError> {
    if (!passwordHash.includes(":")) {
      return { ok: false, error: toError("INVALID", "password hash format is invalid") };
    }
    const user = this.findById("users", userId);
    if (!user) return { ok: false, error: toError("NOT_FOUND", "user not found") };
    user.passwordHash = passwordHash;
    user.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: { ...user } };
  }

  listUsers(): Result<User[], StorageError> {
    return { ok: true, value: [...this.db.users] };
  }

  // --- Workspaces ---

  getWorkspaces(userId: EntityId): Result<Workspace[], StorageError> {
    const workspaces = this.rows("workspaces");
    const memberIds = new Set(
      this.rows("members")
        .filter((m) => m.userId === userId && m.acceptedAt)
        .map((m) => m.workspaceId),
    );
    return {
      ok: true,
      value: workspaces.filter((w) => w.ownerId === userId || memberIds.has(w.id)),
    };
  }

  createWorkspace(input: {
    ownerId: EntityId;
    name: string;
    timezone?: string;
  }): Result<Workspace, StorageError> {
    if (!input.name) {
      return { ok: false, error: toError("INVALID", "workspace name is required") };
    }
    const name = capString(input.name.trim(), 128);
    if (!input.ownerId) {
      return { ok: false, error: toError("UNAUTHORIZED", "owner must exist") };
    }
    const owner = this.findById("users", input.ownerId);
    if (!owner) {
      return { ok: false, error: toError("NOT_FOUND", "owner user not found") };
    }

    const slug = slugify(name) || "workspace";
    const existing = this.db.workspaces.find((w) => w.slug === slug);
    if (existing) return { ok: false, error: toError("CONFLICT", "workspace slug already exists") };

    const record: Workspace = {
      id: newId(),
      ownerId: input.ownerId,
      name,
      slug,
      logoUrl: null,
      timezone: input.timezone ?? "UTC",
      settings: {},
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };

    this.mutate("workspaces", (rows) => rows.push(record));
    // Ownership recorded via workspace_members so every access path uses
    // authorize() below rather than trusting the client.
    this.mutate("members", (rows) =>
      rows.push({
        workspaceId: record.id,
        userId: record.ownerId,
        role: "owner",
        invitedAt: toDateTime(now()),
        acceptedAt: toDateTime(now()),
      }),
    );

    return { ok: true, value: record };
  }

  getWorkspace(id: EntityId): Result<Workspace, StorageError> {
    const workspace = this.findById("workspaces", id);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    return { ok: true, value: workspace };
  }

  updateWorkspace(
    id: EntityId,
    input: { name?: string; timezone?: string },
  ): Result<Workspace, StorageError> {
    const workspace = this.findById("workspaces", id);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    if (input.name !== undefined) {
      workspace.name = capString(input.name.trim(), 128);
    }
    if (input.timezone !== undefined) {
      workspace.timezone = input.timezone;
    }
    workspace.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: workspace };
  }

  // --- Memberships / authorization ---

  /**
   * Authorize a user for a workspace. Returns the workspace when the user
   * is the owner or an accepted member. Never trusts client-supplied
   * ownership assertions.
   */
  authorize(workspaceId: EntityId, userId: EntityId): Result<Workspace, StorageError> {
    const workspace = this.findById("workspaces", workspaceId);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    if (workspace.ownerId !== userId && !this.workspaceIsMember(workspaceId, userId)) {
      return {
        ok: false,
        error: toError("UNAUTHORIZED", "user is not a member of this workspace"),
      };
    }
    return { ok: true, value: workspace };
  }

  /** Resolve and authorize in one step (used by handlers after login). */
  resolveWorkspace(workspaceId: EntityId, userId: EntityId): Result<Workspace, StorageError> {
    return this.authorize(workspaceId, userId);
  }

  workspaceOwner(workspaceId: EntityId): Result<User, StorageError> {
    const workspace = this.findById("workspaces", workspaceId);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    const user = this.findById("users", workspace.ownerId);
    if (!user) return { ok: false, error: toError("NOT_FOUND", "owner not found") };
    return { ok: true, value: user };
  }

  isWorkspaceOwner(workspaceId: EntityId, userId: EntityId): boolean {
    const workspace = this.findById("workspaces", workspaceId);
    return workspace?.ownerId === userId;
  }

  workspaceIsMember(workspaceId: EntityId, userId: EntityId): boolean {
    return this.rows("members").some(
      (m) => m.workspaceId === workspaceId && m.userId === userId && Boolean(m.acceptedAt),
    );
  }

  /**
   * Tenant guard for workspace-scoped collections.
   *
   * Every Brain read and write funnels through here, so a caller can never
   * reach another workspace's rows by passing a foreign `workspaceId`.
   */
  private requireWorkspace(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<Workspace, StorageError> {
    if (!workspaceId || typeof workspaceId !== "string") {
      return { ok: false, error: toError("INVALID", "workspace id is required") };
    }
    return this.authorize(workspaceId, userId);
  }

  // --- Business profile (company section of the Business Brain) ---

  getBusinessProfile(workspaceId: EntityId): Result<BusinessProfile | null, StorageError> {
    const profile = this.rows("profiles").find((p) => p.workspaceId === workspaceId) ?? null;
    return { ok: true, value: profile };
  }

  /** Authorized read of the company section. */
  getBusinessProfileFor(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<BusinessProfile | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    return this.getBusinessProfile(workspaceId);
  }

  createBusinessProfile(input: {
    workspaceId: EntityId;
    ownerId: EntityId;
    name: string;
    description: string;
    website?: string | null;
    type?: string | null;
    offer?: string | null;
    industry?: string | null;
    size?: string | null;
    market?: string | null;
  }): Result<BusinessProfile, StorageError> {
    const workspace = this.findById("workspaces", input.workspaceId);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    if (workspace.ownerId !== input.ownerId) {
      return { ok: false, error: toError("UNAUTHORIZED", "owner must own the workspace") };
    }
    if (this.rows("profiles").some((p) => p.workspaceId === input.workspaceId)) {
      return {
        ok: false,
        error: toError("CONFLICT", `business profile already exists for ${businessProfilesTable}`),
      };
    }

    const profile: BusinessProfile = {
      id: newId(),
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      name: capString(input.name.trim(), 200),
      description: capString(input.description.trim(), 2000),
      website: input.website ?? null,
      type: input.type ?? null,
      offer: input.offer ?? null,
      industry: input.industry ?? null,
      size: input.size ?? null,
      market: input.market ?? null,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };

    this.mutate("profiles", (rows) => rows.push(profile));
    return { ok: true, value: profile };
  }

  updateBusinessProfile(
    id: EntityId,
    input: {
      workspaceId: EntityId;
      name?: string;
      description?: string;
      website?: string | null;
      type?: string | null;
      offer?: string | null;
      industry?: string | null;
      size?: string | null;
      market?: string | null;
    },
  ): Result<BusinessProfile, StorageError> {
    const profile = this.findById("profiles", id);
    if (!profile) return { ok: false, error: toError("NOT_FOUND", "business profile not found") };
    if (profile.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("UNAUTHORIZED", "profile does not belong to this workspace"),
      };
    }
    if (input.name !== undefined) profile.name = capString(input.name.trim(), 200);
    if (input.description !== undefined)
      profile.description = capString(input.description.trim(), 2000);
    if (input.website !== undefined) profile.website = input.website ?? null;
    if (input.type !== undefined) profile.type = input.type ?? null;
    if (input.offer !== undefined) profile.offer = input.offer ?? null;
    if (input.industry !== undefined) profile.industry = input.industry ?? null;
    if (input.size !== undefined) profile.size = input.size ?? null;
    if (input.market !== undefined) profile.market = input.market ?? null;
    profile.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: profile };
  }

  deleteBusinessProfile(id: EntityId): Result<void, StorageError> {
    if (!this.findById("profiles", id)) {
      return { ok: false, error: toError("NOT_FOUND", "business profile not found") };
    }
    this.removeById("profiles", id);
    return { ok: true, value: undefined };
  }

  // --- Offers ---

  createOffer(input: {
    workspaceId: EntityId;
    userId: EntityId;
    name: string;
    description: string;
    targetCustomer?: string | null;
    problemSolved?: string | null;
    outcome?: string | null;
    pricing?: Offer["pricing"];
    deliveryModel?: string | null;
    status?: Offer["status"];
  }): Result<Offer, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.userId);
    if (!auth.ok) return auth;

    const offer: Offer = {
      id: newId(),
      workspaceId: input.workspaceId,
      name: capString(input.name.trim(), 200),
      description: capString(input.description.trim(), 2000),
      targetCustomer: input.targetCustomer ?? null,
      problemSolved: input.problemSolved ?? null,
      outcome: input.outcome ?? null,
      pricing: input.pricing ?? null,
      deliveryModel: input.deliveryModel ?? null,
      status: input.status ?? "draft",
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };

    this.mutate("offers", (rows) => rows.push(offer));
    return { ok: true, value: offer };
  }

  listOffers(workspaceId: EntityId, userId: EntityId): Result<Offer[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: this.rows("offers").filter((o) => o.workspaceId === workspaceId) };
  }

  getOffer(id: EntityId, userId: EntityId): Result<Offer, StorageError> {
    const offer = this.findById("offers", id);
    if (!offer) return { ok: false, error: toError("NOT_FOUND", "offer not found") };
    const auth = this.requireWorkspace(offer.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: offer };
  }

  updateOffer(
    id: EntityId,
    input: { userId: EntityId } & Partial<Omit<Offer, "id" | "workspaceId" | "createdAt">>,
  ): Result<Offer, StorageError> {
    const offer = this.findById("offers", id);
    if (!offer) return { ok: false, error: toError("NOT_FOUND", "offer not found") };
    const auth = this.requireWorkspace(offer.workspaceId, input.userId);
    if (!auth.ok) return auth;

    if (input.name !== undefined) offer.name = capString(input.name.trim(), 200);
    if (input.description !== undefined)
      offer.description = capString(input.description.trim(), 2000);
    if (input.targetCustomer !== undefined) offer.targetCustomer = input.targetCustomer ?? null;
    if (input.problemSolved !== undefined) offer.problemSolved = input.problemSolved ?? null;
    if (input.outcome !== undefined) offer.outcome = input.outcome ?? null;
    if (input.pricing !== undefined) offer.pricing = input.pricing ?? null;
    if (input.deliveryModel !== undefined) offer.deliveryModel = input.deliveryModel ?? null;
    if (input.status !== undefined) offer.status = input.status;
    offer.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: offer };
  }

  deleteOffer(id: EntityId, userId: EntityId): Result<void, StorageError> {
    const offer = this.findById("offers", id);
    if (!offer) return { ok: false, error: toError("NOT_FOUND", "offer not found") };
    const auth = this.requireWorkspace(offer.workspaceId, userId);
    if (!auth.ok) return auth;
    this.removeById("offers", id);
    return { ok: true, value: undefined };
  }

  // --- ICP (single record per workspace) ---

  upsertIcp(
    workspaceId: EntityId,
    userId: EntityId,
    input: {
      industries?: string[];
      companySizes?: string[];
      geographies?: string[];
      businessModels?: string[];
      characteristics?: string[];
      disqualifiers?: string[];
      notes?: string | null;
    },
  ): Result<Icp, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;

    const existing = this.rows("icps").find((i) => i.workspaceId === workspaceId);
    if (existing) {
      if (input.industries !== undefined) existing.industries = input.industries;
      if (input.companySizes !== undefined) existing.companySizes = input.companySizes;
      if (input.geographies !== undefined) existing.geographies = input.geographies;
      if (input.businessModels !== undefined) existing.businessModels = input.businessModels;
      if (input.characteristics !== undefined) existing.characteristics = input.characteristics;
      if (input.disqualifiers !== undefined) existing.disqualifiers = input.disqualifiers;
      if (input.notes !== undefined) existing.notes = input.notes ?? null;
      existing.updatedAt = toDateTime(now());
      this.save();
      return { ok: true, value: existing };
    }

    const icp: Icp = {
      id: newId(),
      workspaceId,
      industries: input.industries ?? [],
      companySizes: input.companySizes ?? [],
      geographies: input.geographies ?? [],
      businessModels: input.businessModels ?? [],
      characteristics: input.characteristics ?? [],
      disqualifiers: input.disqualifiers ?? [],
      notes: input.notes ?? null,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("icps", (rows) => rows.push(icp));
    return { ok: true, value: icp };
  }

  getIcp(workspaceId: EntityId, userId: EntityId): Result<Icp | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const icp = this.rows("icps").find((i) => i.workspaceId === workspaceId) ?? null;
    return { ok: true, value: icp };
  }

  // --- Personas ---

  createPersona(
    workspaceId: EntityId,
    userId: EntityId,
    input: {
      title: string;
      responsibilities?: string[];
      painPoints?: string[];
      goals?: string[];
      buyingContext?: string | null;
    },
  ): Result<Persona, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;

    const persona: Persona = {
      id: newId(),
      workspaceId,
      title: capString(input.title.trim(), 200),
      responsibilities: input.responsibilities ?? [],
      painPoints: input.painPoints ?? [],
      goals: input.goals ?? [],
      buyingContext: input.buyingContext ?? null,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("personas", (rows) => rows.push(persona));
    return { ok: true, value: persona };
  }

  listPersonas(workspaceId: EntityId, userId: EntityId): Result<Persona[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    return {
      ok: true,
      value: this.rows("personas").filter((p) => p.workspaceId === workspaceId),
    };
  }

  getPersona(id: EntityId, userId: EntityId): Result<Persona, StorageError> {
    const persona = this.findById("personas", id);
    if (!persona) return { ok: false, error: toError("NOT_FOUND", "persona not found") };
    const auth = this.requireWorkspace(persona.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: persona };
  }

  updatePersona(
    id: EntityId,
    input: { userId: EntityId } & Partial<Omit<Persona, "id" | "workspaceId" | "createdAt">>,
  ): Result<Persona, StorageError> {
    const persona = this.findById("personas", id);
    if (!persona) return { ok: false, error: toError("NOT_FOUND", "persona not found") };
    const auth = this.requireWorkspace(persona.workspaceId, input.userId);
    if (!auth.ok) return auth;

    if (input.title !== undefined) persona.title = capString(input.title.trim(), 200);
    if (input.responsibilities !== undefined) persona.responsibilities = input.responsibilities;
    if (input.painPoints !== undefined) persona.painPoints = input.painPoints;
    if (input.goals !== undefined) persona.goals = input.goals;
    if (input.buyingContext !== undefined) persona.buyingContext = input.buyingContext ?? null;
    persona.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: persona };
  }

  deletePersona(id: EntityId, userId: EntityId): Result<void, StorageError> {
    const persona = this.findById("personas", id);
    if (!persona) return { ok: false, error: toError("NOT_FOUND", "persona not found") };
    const auth = this.requireWorkspace(persona.workspaceId, userId);
    if (!auth.ok) return auth;
    this.removeById("personas", id);
    return { ok: true, value: undefined };
  }

  // --- Positioning (single record per workspace) ---

  upsertPositioning(
    workspaceId: EntityId,
    userId: EntityId,
    input: {
      statement: string;
      differentiators?: string[];
      approvedValuePropositions?: string[];
      competitorContext?: string[];
    },
  ): Result<Positioning, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;

    const existing = this.rows("positioning").find((p) => p.workspaceId === workspaceId);
    if (existing) {
      existing.statement = capString(input.statement.trim(), 2000);
      if (input.differentiators !== undefined) existing.differentiators = input.differentiators;
      if (input.approvedValuePropositions !== undefined)
        existing.approvedValuePropositions = input.approvedValuePropositions;
      if (input.competitorContext !== undefined)
        existing.competitorContext = input.competitorContext;
      existing.updatedAt = toDateTime(now());
      this.save();
      return { ok: true, value: existing };
    }

    const positioning: Positioning = {
      id: newId(),
      workspaceId,
      statement: capString(input.statement.trim(), 2000),
      differentiators: input.differentiators ?? [],
      approvedValuePropositions: input.approvedValuePropositions ?? [],
      competitorContext: input.competitorContext ?? [],
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("positioning", (rows) => rows.push(positioning));
    return { ok: true, value: positioning };
  }

  getPositioning(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<Positioning | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const found = this.rows("positioning").find((p) => p.workspaceId === workspaceId) ?? null;
    return { ok: true, value: found };
  }

  // --- Brand voice (single record per workspace) ---

  upsertBrandVoice(
    workspaceId: EntityId,
    userId: EntityId,
    input: {
      tone: string[];
      style?: string | null;
      terminology?: string[];
      constraints?: string[];
    },
  ): Result<BrandVoice, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;

    const existing = this.rows("brandVoices").find((b) => b.workspaceId === workspaceId);
    if (existing) {
      existing.tone = input.tone;
      if (input.style !== undefined) existing.style = input.style ?? null;
      if (input.terminology !== undefined) existing.terminology = input.terminology;
      if (input.constraints !== undefined) existing.constraints = input.constraints;
      existing.updatedAt = toDateTime(now());
      this.save();
      return { ok: true, value: existing };
    }

    const brandVoice: BrandVoice = {
      id: newId(),
      workspaceId,
      tone: input.tone,
      style: input.style ?? null,
      terminology: input.terminology ?? [],
      constraints: input.constraints ?? [],
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("brandVoices", (rows) => rows.push(brandVoice));
    return { ok: true, value: brandVoice };
  }

  getBrandVoice(workspaceId: EntityId, userId: EntityId): Result<BrandVoice | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const found = this.rows("brandVoices").find((b) => b.workspaceId === workspaceId) ?? null;
    return { ok: true, value: found };
  }

  // --- Claims ---

  /**
   * Create a claim. A claim can never be created as `approved`: approval is a
   * separate, attributed action (`approveClaim`), so user-entered text is
   * never treated as verified evidence.
   */
  createClaim(input: {
    workspaceId: EntityId;
    userId: EntityId;
    text: string;
    category: Claim["category"];
    status?: Claim["status"];
    sourceNote?: string | null;
  }): Result<Claim, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.userId);
    if (!auth.ok) return auth;

    const status = input.status ?? "unverified";
    const claim: Claim = {
      id: newId(),
      workspaceId: input.workspaceId,
      text: capString(input.text.trim(), 1000),
      category: input.category,
      status: status === "approved" ? "unverified" : status,
      sourceNote: input.sourceNote ?? null,
      approvedBy: null,
      approvedAt: null,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("claims", (rows) => rows.push(claim));
    return { ok: true, value: claim };
  }

  listClaims(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: Claim["status"] },
  ): Result<Claim[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("claims").filter((c) => c.workspaceId === workspaceId);
    return {
      ok: true,
      value: filter?.status ? scoped.filter((c) => c.status === filter.status) : scoped,
    };
  }

  getClaim(id: EntityId, userId: EntityId): Result<Claim, StorageError> {
    const claim = this.findById("claims", id);
    if (!claim) return { ok: false, error: toError("NOT_FOUND", "claim not found") };
    const auth = this.requireWorkspace(claim.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: claim };
  }

  updateClaim(
    id: EntityId,
    input: { userId: EntityId } & Partial<Omit<Claim, "id" | "workspaceId" | "createdAt">>,
  ): Result<Claim, StorageError> {
    const claim = this.findById("claims", id);
    if (!claim) return { ok: false, error: toError("NOT_FOUND", "claim not found") };
    const auth = this.requireWorkspace(claim.workspaceId, input.userId);
    if (!auth.ok) return auth;

    if (input.text !== undefined) {
      const nextText = capString(input.text.trim(), 1000);
      if (nextText !== claim.text) {
        // Changing the wording of an approved claim invalidates the
        // approval: the new text has not been reviewed.
        claim.status = "unverified";
        claim.approvedBy = null;
        claim.approvedAt = null;
      }
      claim.text = nextText;
    }
    if (input.category !== undefined) claim.category = input.category;
    if (input.sourceNote !== undefined) claim.sourceNote = input.sourceNote ?? null;
    // Approval is deliberately not settable through a generic update: it must
    // go through `approveClaim`, which attributes the decision to a user.
    if (input.status !== undefined && input.status !== "approved") {
      claim.status = input.status;
      claim.approvedBy = null;
      claim.approvedAt = null;
    }
    claim.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: claim };
  }

  /**
   * Record an explicit approval. This is the only path to `approved`, and it
   * attributes the decision to a real user id resolved server-side.
   */
  approveClaim(id: EntityId, userId: EntityId): Result<Claim, StorageError> {
    const claim = this.findById("claims", id);
    if (!claim) return { ok: false, error: toError("NOT_FOUND", "claim not found") };
    const auth = this.requireWorkspace(claim.workspaceId, userId);
    if (!auth.ok) return auth;
    claim.status = "approved";
    claim.approvedBy = userId;
    claim.approvedAt = toDateTime(now());
    claim.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: claim };
  }

  deleteClaim(id: EntityId, userId: EntityId): Result<void, StorageError> {
    const claim = this.findById("claims", id);
    if (!claim) return { ok: false, error: toError("NOT_FOUND", "claim not found") };
    const auth = this.requireWorkspace(claim.workspaceId, userId);
    if (!auth.ok) return auth;
    this.removeById("claims", id);
    return { ok: true, value: undefined };
  }

  // --- Revenue goals (Phase 3) ---

  createRevenueGoal(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    goal: Omit<RevenueGoal, "id" | "workspaceId" | "createdBy" | "createdAt" | "updatedAt">;
  }): Result<RevenueGoal, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;

    const goal: RevenueGoal = {
      ...input.goal,
      id: newId(),
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("revenueGoals", (rows) => rows.push(goal));
    this.recordGoalEvent(input.workspaceId, goal.id, input.createdBy, "created", null, goal.status);
    return { ok: true, value: goal };
  }

  /** Authorized list of a workspace's goals, newest first. */
  listRevenueGoals(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: RevenueGoal["status"] },
  ): Result<RevenueGoal[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("revenueGoals").filter((g) => g.workspaceId === workspaceId);
    const filtered = filter?.status ? scoped.filter((g) => g.status === filter.status) : scoped;
    // Deterministic ordering: newest first, id as a stable tiebreaker.
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id),
      ),
    };
  }

  getRevenueGoal(id: EntityId, userId: EntityId): Result<RevenueGoal, StorageError> {
    const goal = this.findById("revenueGoals", id);
    if (!goal) return { ok: false, error: toError("NOT_FOUND", "revenue goal not found") };
    const auth = this.requireWorkspace(goal.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: goal };
  }

  updateRevenueGoal(
    id: EntityId,
    input: {
      userId: EntityId;
      patch: Partial<Omit<RevenueGoal, "id" | "workspaceId" | "createdBy" | "createdAt">>;
    },
  ): Result<RevenueGoal, StorageError> {
    const goal = this.findById("revenueGoals", id);
    if (!goal) return { ok: false, error: toError("NOT_FOUND", "revenue goal not found") };
    const auth = this.requireWorkspace(goal.workspaceId, input.userId);
    if (!auth.ok) return auth;
    const before = goal.status;
    Object.assign(goal, input.patch);
    goal.updatedAt = toDateTime(now());
    this.save();
    if (goal.status !== before) {
      this.recordGoalEvent(
        goal.workspaceId,
        goal.id,
        input.userId,
        "status_changed",
        before,
        goal.status,
      );
    } else {
      this.recordGoalEvent(goal.workspaceId, goal.id, input.userId, "updated", before, goal.status);
    }
    return { ok: true, value: goal };
  }

  /**
   * Apply a status transition and append an audit event.
   *
   * The domain layer validates the transition; the store only persists it.
   */
  setRevenueGoalStatus(
    id: EntityId,
    userId: EntityId,
    status: RevenueGoal["status"],
  ): Result<RevenueGoal, StorageError> {
    const goal = this.findById("revenueGoals", id);
    if (!goal) return { ok: false, error: toError("NOT_FOUND", "revenue goal not found") };
    const auth = this.requireWorkspace(goal.workspaceId, userId);
    if (!auth.ok) return auth;
    const before = goal.status;
    goal.status = status;
    goal.updatedAt = toDateTime(now());
    this.save();
    this.recordGoalEvent(goal.workspaceId, goal.id, userId, "status_changed", before, status);
    return { ok: true, value: goal };
  }

  /** Auditable history for one goal. */
  listRevenueGoalEvents(
    goalId: EntityId,
    userId: EntityId,
  ): Result<RevenueGoalEvent[], StorageError> {
    const goal = this.findById("revenueGoals", goalId);
    if (!goal) return { ok: false, error: toError("NOT_FOUND", "revenue goal not found") };
    const auth = this.requireWorkspace(goal.workspaceId, userId);
    if (!auth.ok) return auth;
    // Chronological order is the whole point of an audit log. Timestamps have
    // millisecond resolution, so events written in the same millisecond tie;
    // breaking that tie by `id` would order them randomly, because ids are
    // random. Fall back to insertion order, which the stored array preserves,
    // so the same persisted document always yields the same history.
    const events = this.rows("revenueGoalEvents")
      .map((event, index) => ({ event, index }))
      .filter((entry) => entry.event.goalId === goalId)
      .sort((a, b) => {
        if (a.event.createdAt !== b.event.createdAt) {
          return a.event.createdAt < b.event.createdAt ? -1 : 1;
        }
        return a.index - b.index;
      })
      .map((entry) => entry.event);
    return { ok: true, value: events };
  }

  private recordGoalEvent(
    workspaceId: EntityId,
    goalId: EntityId,
    actorUserId: EntityId,
    kind: RevenueGoalEvent["kind"],
    fromStatus: RevenueGoal["status"] | null,
    toStatus: RevenueGoal["status"],
  ): void {
    const event: RevenueGoalEvent = {
      id: newId(),
      goalId,
      workspaceId,
      actorUserId,
      kind,
      fromStatus,
      toStatus,
      createdAt: toDateTime(now()),
    };
    (this.db.revenueGoalEvents as unknown[]).push(event);
    this.save();
  }

  // --- Revenue plans (Phase 4) ---

  /**
   * The next version number for a goal's plan lineage.
   *
   * Versions are 1-based and never reused, so recompiling a goal produces a
   * new version instead of overwriting the previous plan.
   */
  nextRevenuePlanVersion(revenueGoalId: EntityId): Result<number, StorageError> {
    const versions = this.rows("revenuePlans")
      .filter((p) => p.revenueGoalId === revenueGoalId)
      .map((p) => p.version);
    return { ok: true, value: versions.length === 0 ? 1 : Math.max(...versions) + 1 };
  }

  createRevenuePlan(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    plan: Omit<
      RevenuePlan,
      "id" | "workspaceId" | "createdBy" | "version" | "createdAt" | "updatedAt"
    >;
  }): Result<RevenuePlan, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    // The plan may only reference a goal in its own workspace.
    const goal = this.findById("revenueGoals", input.plan.revenueGoalId);
    if (!goal || goal.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "revenue goal not found") };
    }
    const next = this.nextRevenuePlanVersion(input.plan.revenueGoalId);
    if (!next.ok) return next;

    const plan: RevenuePlan = {
      ...input.plan,
      id: newId(),
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      version: next.value,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("revenuePlans", (rows) => rows.push(plan));
    return { ok: true, value: plan };
  }

  /** Authorized list of a workspace's plans, newest first. */
  listRevenuePlans(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { revenueGoalId?: EntityId; status?: RevenuePlanStatus },
  ): Result<RevenuePlan[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("revenuePlans").filter((p) => p.workspaceId === workspaceId);
    const filtered = scoped.filter((p) => {
      if (filter?.revenueGoalId && p.revenueGoalId !== filter.revenueGoalId) return false;
      if (filter?.status && p.status !== filter.status) return false;
      return true;
    });
    // Deterministic ordering: newest first, id as a stable tiebreaker.
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id),
      ),
    };
  }

  getRevenuePlan(id: EntityId, userId: EntityId): Result<RevenuePlan, StorageError> {
    const plan = this.findById("revenuePlans", id);
    if (!plan) return { ok: false, error: toError("NOT_FOUND", "revenue plan not found") };
    const auth = this.requireWorkspace(plan.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: plan };
  }

  /**
   * Every version compiled from one goal, oldest first.
   *
   * This is the plan history: recompiling never destroys a previous version,
   * so the lineage stays inspectable.
   */
  listRevenuePlansForGoal(
    revenueGoalId: EntityId,
    userId: EntityId,
  ): Result<RevenuePlan[], StorageError> {
    const goal = this.findById("revenueGoals", revenueGoalId);
    if (!goal) return { ok: false, error: toError("NOT_FOUND", "revenue goal not found") };
    const auth = this.requireWorkspace(goal.workspaceId, userId);
    if (!auth.ok) return auth;
    const plans = this.rows("revenuePlans").filter((p) => p.revenueGoalId === revenueGoalId);
    return {
      ok: true,
      value: [...plans].sort((a, b) =>
        a.version < b.version ? -1 : a.version > b.version ? 1 : a.id.localeCompare(b.id),
      ),
    };
  }

  updateRevenuePlan(
    id: EntityId,
    input: {
      userId: EntityId;
      patch: Partial<
        Omit<RevenuePlan, "id" | "workspaceId" | "createdBy" | "version" | "createdAt">
      >;
    },
  ): Result<RevenuePlan, StorageError> {
    const plan = this.findById("revenuePlans", id);
    if (!plan) return { ok: false, error: toError("NOT_FOUND", "revenue plan not found") };
    const auth = this.requireWorkspace(plan.workspaceId, input.userId);
    if (!auth.ok) return auth;
    Object.assign(plan, input.patch);
    plan.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: plan };
  }

  setRevenuePlanStatus(
    id: EntityId,
    userId: EntityId,
    status: RevenuePlanStatus,
  ): Result<RevenuePlan, StorageError> {
    const plan = this.findById("revenuePlans", id);
    if (!plan) return { ok: false, error: toError("NOT_FOUND", "revenue plan not found") };
    const auth = this.requireWorkspace(plan.workspaceId, userId);
    if (!auth.ok) return auth;
    plan.status = status;
    plan.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: plan };
  }

  // --- Accounts and contacts (Phase 5) ---

  /**
   * Create a target account.
   *
   * Storage performs no business deduplication: the domain decides what counts
   * as a duplicate and owns the conflict policy. This method only enforces the
   * tenant boundary.
   */
  createAccount(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    account: Omit<Account, "id" | "workspaceId" | "createdBy" | "createdAt" | "updatedAt">;
  }): Result<Account, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    const account: Account = {
      ...input.account,
      id: newId(),
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("accounts", (rows) => rows.push(account));
    return { ok: true, value: account };
  }

  /** Authorized list of a workspace's accounts, newest first. */
  listAccounts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: AccountStatus; revenuePlanId?: EntityId },
  ): Result<Account[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("accounts").filter((a) => a.workspaceId === workspaceId);
    const filtered = scoped.filter((a) => {
      if (filter?.status && a.status !== filter.status) return false;
      if (filter?.revenuePlanId && a.revenuePlanId !== filter.revenuePlanId) return false;
      return true;
    });
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id),
      ),
    };
  }

  getAccount(id: EntityId, userId: EntityId): Result<Account, StorageError> {
    const account = this.findById("accounts", id);
    if (!account) return { ok: false, error: toError("NOT_FOUND", "account not found") };
    const auth = this.requireWorkspace(account.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: account };
  }

  /**
   * Accounts a plan targeted.
   *
   * Filtering by plan happens through {@link listAccounts}, which authorizes
   * the workspace first; the plan itself is resolved and authorized by the
   * Account domain, so there is a single authorization path for plan-linked
   * accounts.
   */

  updateAccount(
    id: EntityId,
    input: {
      userId: EntityId;
      patch: Partial<Omit<Account, "id" | "workspaceId" | "createdBy" | "createdAt">>;
    },
  ): Result<Account, StorageError> {
    const account = this.findById("accounts", id);
    if (!account) return { ok: false, error: toError("NOT_FOUND", "account not found") };
    const auth = this.requireWorkspace(account.workspaceId, input.userId);
    if (!auth.ok) return auth;
    Object.assign(account, input.patch);
    account.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: account };
  }

  /**
   * Archive an account and, with it, its contacts.
   *
   * The cascade is explicit rather than accidental: an archived account must
   * not keep active contacts attached, and nothing is ever hard-deleted here —
   * both rows stay for audit and can be inspected in archived state.
   */
  archiveAccount(id: EntityId, userId: EntityId): Result<Account, StorageError> {
    const account = this.findById("accounts", id);
    if (!account) return { ok: false, error: toError("NOT_FOUND", "account not found") };
    const auth = this.requireWorkspace(account.workspaceId, userId);
    if (!auth.ok) return auth;
    const stamp = toDateTime(now());
    account.status = "archived";
    account.updatedAt = stamp;
    for (const contact of this.rows("contacts")) {
      if (contact.accountId === account.id && contact.status === "active") {
        contact.status = "archived";
        contact.updatedAt = stamp;
      }
    }
    this.save();
    return { ok: true, value: account };
  }

  /** Deterministic duplicate lookup: same workspace, same normalized domain. */
  findAccountByDomain(
    workspaceId: EntityId,
    userId: EntityId,
    domain: string,
  ): Result<Account | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const found = this.rows("accounts").find(
      (a) => a.workspaceId === workspaceId && a.domain === domain,
    );
    return { ok: true, value: found ?? null };
  }

  /**
   * Name-only lookup, used to report an ambiguous match.
   *
   * A shared name is never treated as proof that two records are the same
   * company; the domain surfaces it as ambiguity rather than merging.
   */
  findAccountByName(
    workspaceId: EntityId,
    userId: EntityId,
    name: string,
  ): Result<Account[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const found = this.rows("accounts").filter(
      (a) => a.workspaceId === workspaceId && a.name.toLowerCase() === name.toLowerCase(),
    );
    return { ok: true, value: found };
  }

  createContact(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    contact: Omit<Contact, "id" | "workspaceId" | "createdBy" | "createdAt" | "updatedAt">;
  }): Result<Contact, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    // A contact may only attach to an account in the same workspace.
    const account = this.findById("accounts", input.contact.accountId);
    if (!account || account.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("INVALID", "account does not exist in this workspace") };
    }
    const contact: Contact = {
      ...input.contact,
      id: newId(),
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("contacts", (rows) => rows.push(contact));
    return { ok: true, value: contact };
  }

  /** Contacts at an account, or the whole workspace when no account is given. */
  listContacts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId; status?: ContactStatus },
  ): Result<Contact[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("contacts").filter((c) => c.workspaceId === workspaceId);
    const filtered = scoped.filter((c) => {
      if (filter?.accountId && c.accountId !== filter.accountId) return false;
      if (filter?.status && c.status !== filter.status) return false;
      return true;
    });
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id),
      ),
    };
  }

  getContact(id: EntityId, userId: EntityId): Result<Contact, StorageError> {
    const contact = this.findById("contacts", id);
    if (!contact) return { ok: false, error: toError("NOT_FOUND", "contact not found") };
    const auth = this.requireWorkspace(contact.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: contact };
  }

  updateContact(
    id: EntityId,
    input: {
      userId: EntityId;
      patch: Partial<Omit<Contact, "id" | "workspaceId" | "createdBy" | "createdAt">>;
    },
  ): Result<Contact, StorageError> {
    const contact = this.findById("contacts", id);
    if (!contact) return { ok: false, error: toError("NOT_FOUND", "contact not found") };
    const auth = this.requireWorkspace(contact.workspaceId, input.userId);
    if (!auth.ok) return auth;
    Object.assign(contact, input.patch);
    contact.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: contact };
  }

  archiveContact(id: EntityId, userId: EntityId): Result<Contact, StorageError> {
    const contact = this.findById("contacts", id);
    if (!contact) return { ok: false, error: toError("NOT_FOUND", "contact not found") };
    const auth = this.requireWorkspace(contact.workspaceId, userId);
    if (!auth.ok) return auth;
    contact.status = "archived";
    contact.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: contact };
  }

  /** Deterministic duplicate lookup: same account, same normalized email. */
  findContactByEmail(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    email: string,
  ): Result<Contact | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const found = this.rows("contacts").find(
      (c) => c.workspaceId === workspaceId && c.accountId === accountId && c.email === email,
    );
    return { ok: true, value: found ?? null };
  }

  // --- Research (Phase 6) ---

  /**
   * Create a research request.
   *
   * The account must live in the same workspace as the request, so the
   * invariant `ResearchRequest.workspaceId === Account.workspaceId` is
   * enforced at write time and not only by the caller.
   */
  createResearchRequest(input: {
    workspaceId: EntityId;
    requestedBy: EntityId;
    accountId: EntityId;
    provider: string;
    categories: ResearchRequest["categories"];
    idempotencyKey?: string | null;
  }): Result<ResearchRequest, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.requestedBy);
    if (!auth.ok) return auth;
    const account = this.findById("accounts", input.accountId);
    if (!account || account.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "account does not exist in this workspace"),
      };
    }
    const stamp = toDateTime(now());
    const request: ResearchRequest = {
      id: newId(),
      workspaceId: input.workspaceId,
      accountId: account.id,
      requestedBy: input.requestedBy,
      provider: input.provider,
      status: "pending",
      categories: input.categories,
      idempotencyKey: input.idempotencyKey ?? null,
      findingCount: 0,
      failureCode: null,
      failureMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("researchRequests", (rows) => rows.push(request));
    return { ok: true, value: request };
  }

  getResearchRequest(id: EntityId, userId: EntityId): Result<ResearchRequest, StorageError> {
    const request = this.findById("researchRequests", id);
    if (!request) return { ok: false, error: toError("NOT_FOUND", "research request not found") };
    const auth = this.requireWorkspace(request.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: request };
  }

  /** A workspace's research requests, newest first, optionally narrowed. */
  listResearchRequests(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      status?: ResearchRequestStatus;
      provider?: string;
    },
  ): Result<ResearchRequest[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("researchRequests").filter((r) => r.workspaceId === workspaceId);
    const filtered = scoped.filter((r) => {
      if (filter?.accountId && r.accountId !== filter.accountId) return false;
      if (filter?.status && r.status !== filter.status) return false;
      if (filter?.provider && r.provider !== filter.provider) return false;
      return true;
    });
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id),
      ),
    };
  }

  /**
   * An in-flight request for the same account and provider.
   *
   * `pending` and `running` are the only non-terminal states, so this is the
   * guard that stops a repeated request from creating a second active job.
   */
  findActiveResearchRequest(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    provider: string,
  ): Result<ResearchRequest | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const found = this.rows("researchRequests").find(
      (r) =>
        r.workspaceId === workspaceId &&
        r.accountId === accountId &&
        r.provider === provider &&
        (r.status === "pending" || r.status === "running"),
    );
    return { ok: true, value: found ?? null };
  }

  /** Replay lookup for a caller-supplied idempotency key. */
  findResearchRequestByIdempotencyKey(
    workspaceId: EntityId,
    userId: EntityId,
    idempotencyKey: string,
  ): Result<ResearchRequest | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const found = this.rows("researchRequests").find(
      (r) => r.workspaceId === workspaceId && r.idempotencyKey === idempotencyKey,
    );
    return { ok: true, value: found ?? null };
  }

  /**
   * Move a request along its lifecycle.
   *
   * Storage records the transition the domain decided; it does not decide
   * whether the transition is legal — that rule lives in the domain, so there
   * is exactly one place to audit.
   */
  updateResearchRequest(
    id: EntityId,
    input: {
      userId: EntityId;
      status: ResearchRequestStatus;
      startedAt?: string | null;
      completedAt?: string | null;
      failureCode?: ResearchRequest["failureCode"];
      failureMessage?: string | null;
      findingCount?: number;
    },
  ): Result<ResearchRequest, StorageError> {
    const request = this.findById("researchRequests", id);
    if (!request) return { ok: false, error: toError("NOT_FOUND", "research request not found") };
    const auth = this.requireWorkspace(request.workspaceId, input.userId);
    if (!auth.ok) return auth;
    request.status = input.status;
    if (input.startedAt !== undefined) request.startedAt = input.startedAt;
    if (input.completedAt !== undefined) request.completedAt = input.completedAt;
    if (input.failureCode !== undefined) request.failureCode = input.failureCode;
    if (input.failureMessage !== undefined) request.failureMessage = input.failureMessage;
    if (input.findingCount !== undefined) request.findingCount = input.findingCount;
    request.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: request };
  }

  /**
   * Record one finding.
   *
   * The finding inherits the request's workspace and account: a provider can
   * never attach a finding to a different account or another tenant's request.
   */
  createResearchFinding(input: {
    researchRequestId: EntityId;
    createdBy: EntityId;
    finding: Omit<
      ResearchFinding,
      "id" | "workspaceId" | "accountId" | "researchRequestId" | "createdAt" | "updatedAt"
    >;
  }): Result<ResearchFinding, StorageError> {
    const request = this.findById("researchRequests", input.researchRequestId);
    if (!request) {
      return { ok: false, error: toError("NOT_FOUND", "research request not found") };
    }
    const auth = this.requireWorkspace(request.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    const finding: ResearchFinding = {
      ...input.finding,
      id: newId(),
      workspaceId: request.workspaceId,
      accountId: request.accountId,
      researchRequestId: request.id,
      createdAt: toDateTime(now()),
      updatedAt: toDateTime(now()),
    };
    this.mutate("researchFindings", (rows) => rows.push(finding));
    return { ok: true, value: finding };
  }

  /**
   * One finding, resolved through the caller's own authorization.
   *
   * Phase 7 needs this to convert a finding into evidence without trusting a
   * caller-supplied account id: the finding itself carries the workspace and
   * account it belongs to. Another tenant's finding is not found.
   */
  getResearchFinding(id: EntityId, userId: EntityId): Result<ResearchFinding, StorageError> {
    const finding = this.findById("researchFindings", id);
    if (!finding) return { ok: false, error: toError("NOT_FOUND", "research finding not found") };
    const auth = this.requireWorkspace(finding.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: finding };
  }

  /** A workspace's findings, newest first, optionally narrowed. */
  listResearchFindings(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      researchRequestId?: EntityId;
      accountId?: EntityId;
      category?: ResearchFinding["category"];
    },
  ): Result<ResearchFinding[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("researchFindings").filter((f) => f.workspaceId === workspaceId);
    const filtered = scoped.filter((f) => {
      if (filter?.researchRequestId && f.researchRequestId !== filter.researchRequestId)
        return false;
      if (filter?.accountId && f.accountId !== filter.accountId) return false;
      if (filter?.category && f.category !== filter.category) return false;
      return true;
    });
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.retrievedAt < b.retrievedAt
          ? 1
          : a.retrievedAt > b.retrievedAt
            ? -1
            : a.id.localeCompare(b.id),
      ),
    };
  }

  /** Findings already recorded for one request: the basis of retry dedup. */
  countResearchFindings(
    researchRequestId: EntityId,
    userId: EntityId,
  ): Result<number, StorageError> {
    const request = this.findById("researchRequests", researchRequestId);
    if (!request) return { ok: false, error: toError("NOT_FOUND", "research request not found") };
    const auth = this.requireWorkspace(request.workspaceId, userId);
    if (!auth.ok) return auth;
    return {
      ok: true,
      value: this.rows("researchFindings").filter((f) => f.researchRequestId === request.id).length,
    };
  }

  // --- Evidence (Phase 7) ---

  /**
   * Record a structured claim about an account.
   *
   * The account must live in the same workspace as the claim, so the
   * invariant `AccountClaim.workspaceId === Account.workspaceId` is enforced at
   * write time and not only by the caller.
   */
  createAccountClaim(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    accountId: EntityId;
    category: AccountClaim["category"];
    field: string;
    value: string;
    claimKind: AccountClaim["claimKind"];
  }): Result<AccountClaim, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    const account = this.findById("accounts", input.accountId);
    if (!account || account.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "account does not exist in this workspace"),
      };
    }
    const stamp = toDateTime(now());
    const claim: AccountClaim = {
      id: newId(),
      workspaceId: input.workspaceId,
      accountId: account.id,
      category: input.category,
      field: input.field,
      value: input.value,
      claimKind: input.claimKind,
      status: "asserted",
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("accountClaims", (rows) => rows.push(claim));
    return { ok: true, value: claim };
  }

  getAccountClaim(id: EntityId, userId: EntityId): Result<AccountClaim, StorageError> {
    const claim = this.findById("accountClaims", id);
    if (!claim) return { ok: false, error: toError("NOT_FOUND", "claim not found") };
    const auth = this.requireWorkspace(claim.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: claim };
  }

  /**
   * One claim for one account field.
   *
   * The lookup a controlled evidence conversion needs: the same field on the
   * same account always resolves to the same claim, so repeated research runs
   * accumulate evidence against one assertion instead of minting a new claim
   * per run.
   */
  findAccountClaimByField(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    category: AccountClaim["category"],
    field: string,
  ): Result<AccountClaim | null, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const found =
      this.rows("accountClaims").find(
        (c) =>
          c.workspaceId === workspaceId &&
          c.accountId === accountId &&
          c.category === category &&
          c.field === field,
      ) ?? null;
    return { ok: true, value: found };
  }

  /** A workspace's claims, newest first, optionally narrowed. */
  listAccountClaims(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      category?: AccountClaim["category"];
      status?: AccountClaimStatus;
    },
  ): Result<AccountClaim[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("accountClaims").filter((c) => c.workspaceId === workspaceId);
    const filtered = scoped.filter((c) => {
      if (filter?.accountId && c.accountId !== filter.accountId) return false;
      if (filter?.category && c.category !== filter.category) return false;
      if (filter?.status && c.status !== filter.status) return false;
      return true;
    });
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id),
      ),
    };
  }

  /**
   * Move a claim along its lifecycle.
   *
   * Storage records the transition the domain decided; it does not decide
   * whether the transition is legal — that rule lives in the domain, so there
   * is exactly one place to audit.
   */
  updateAccountClaim(
    id: EntityId,
    input: { userId: EntityId; status: AccountClaimStatus },
  ): Result<AccountClaim, StorageError> {
    const claim = this.findById("accountClaims", id);
    if (!claim) return { ok: false, error: toError("NOT_FOUND", "claim not found") };
    const auth = this.requireWorkspace(claim.workspaceId, input.userId);
    if (!auth.ok) return auth;
    claim.status = input.status;
    claim.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: claim };
  }

  /**
   * Record one evidence record.
   *
   * The evidence inherits its workspace and account from the claim it
   * supports: a caller cannot cite a claim in another account or tenant and
   * have it accepted.
   */
  createEvidence(input: {
    workspaceId: EntityId;
    accountClaimId: EntityId;
    evidence: Omit<
      Evidence,
      "id" | "workspaceId" | "accountId" | "accountClaimId" | "createdAt" | "updatedAt"
    >;
  }): Result<Evidence, StorageError> {
    const claim = this.findById("accountClaims", input.accountClaimId);
    if (!claim) return { ok: false, error: toError("NOT_FOUND", "claim not found") };
    if (claim.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("INVALID", "claim does not exist in this workspace") };
    }
    const stamp = toDateTime(now());
    const evidence: Evidence = {
      ...input.evidence,
      id: newId(),
      workspaceId: claim.workspaceId,
      accountId: claim.accountId,
      accountClaimId: claim.id,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("evidence", (rows) => rows.push(evidence));
    return { ok: true, value: evidence };
  }

  getEvidence(id: EntityId, userId: EntityId): Result<Evidence, StorageError> {
    const record = this.findById("evidence", id);
    if (!record) return { ok: false, error: toError("NOT_FOUND", "evidence not found") };
    const auth = this.requireWorkspace(record.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: record };
  }

  /**
   * A workspace's evidence, newest retrieval first, optionally narrowed.
   *
   * Nothing is filtered out by default: `superseded`, `contradicted` and
   * `rejected` records stay listable, because an audit trail that hides the
   * discarded half is not an audit trail.
   */
  listEvidence(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      accountClaimId?: EntityId;
      researchFindingId?: EntityId;
      status?: EvidenceStatus;
    },
  ): Result<Evidence[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("evidence").filter((e) => e.workspaceId === workspaceId);
    const filtered = scoped.filter((e) => {
      if (filter?.accountId && e.accountId !== filter.accountId) return false;
      if (filter?.accountClaimId && e.accountClaimId !== filter.accountClaimId) return false;
      if (filter?.researchFindingId && e.researchFindingId !== filter.researchFindingId)
        return false;
      if (filter?.status && e.status !== filter.status) return false;
      return true;
    });
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.retrievedAt < b.retrievedAt
          ? 1
          : a.retrievedAt > b.retrievedAt
            ? -1
            : a.id.localeCompare(b.id),
      ),
    };
  }

  /**
   * Move an evidence record along its lifecycle.
   *
   * Status only — never a field mutation. An evidence record's source, value,
   * timestamps and confidence are what the source said, and rewriting them
   * would destroy the provenance the record exists to preserve.
   */
  updateEvidence(
    id: EntityId,
    input: { userId: EntityId; status: EvidenceStatus },
  ): Result<Evidence, StorageError> {
    const record = this.findById("evidence", id);
    if (!record) return { ok: false, error: toError("NOT_FOUND", "evidence not found") };
    const auth = this.requireWorkspace(record.workspaceId, input.userId);
    if (!auth.ok) return auth;
    record.status = input.status;
    record.updatedAt = toDateTime(now());
    this.save();
    return { ok: true, value: record };
  }

  // -------------------------------------------------------------------------
  // Phase 8 — Qualification Engine
  // -------------------------------------------------------------------------

  /**
   * The next 1-based version within an account's qualification lineage.
   *
   * Counted from stored rows rather than from a counter, so a restored backup
   * cannot reissue a version that a user has already seen.
   */
  nextQualificationVersion(accountId: EntityId): Result<number, StorageError> {
    const versions = this.rows("qualifications")
      .filter((q) => q.accountId === accountId)
      .map((q) => q.version);
    return { ok: true, value: versions.length === 0 ? 1 : Math.max(...versions) + 1 };
  }

  /**
   * Record one qualification evaluation.
   *
   * The account must live in the same workspace as the evaluation, so the
   * invariant `Qualification.workspaceId === Account.workspaceId` holds at
   * write time rather than resting on the caller. The plan and goal references
   * must belong to that same workspace too: a qualification can never point at
   * another tenant's plan or goal, which would let one workspace's target be
   * measured against another's business context.
   *
   * The version is computed here rather than accepted, so two concurrent
   * evaluations cannot claim the same slot in the account's history.
   */
  createQualification(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    accountId: EntityId;
    qualification: Omit<
      Qualification,
      "id" | "workspaceId" | "accountId" | "createdBy" | "version" | "createdAt" | "updatedAt"
    >;
  }): Result<Qualification, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    const account = this.findById("accounts", input.accountId);
    if (!account || account.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "account does not exist in this workspace"),
      };
    }
    if (input.qualification.revenuePlanId !== null) {
      const plan = this.findById("revenuePlans", input.qualification.revenuePlanId);
      if (!plan || plan.workspaceId !== input.workspaceId) {
        return {
          ok: false,
          error: toError("INVALID", "revenue plan does not exist in this workspace"),
        };
      }
    }
    if (input.qualification.revenueGoalId !== null) {
      const goal = this.findById("revenueGoals", input.qualification.revenueGoalId);
      if (!goal || goal.workspaceId !== input.workspaceId) {
        return {
          ok: false,
          error: toError("INVALID", "revenue goal does not exist in this workspace"),
        };
      }
    }
    if (input.qualification.icpId !== null) {
      const icp = this.findById("icps", input.qualification.icpId);
      if (!icp || icp.workspaceId !== input.workspaceId) {
        return {
          ok: false,
          error: toError("INVALID", "icp does not exist in this workspace"),
        };
      }
    }

    const next = this.nextQualificationVersion(account.id);
    if (!next.ok) return next;
    const stamp = toDateTime(now());
    const qualification: Qualification = {
      ...input.qualification,
      id: newId(),
      workspaceId: input.workspaceId,
      accountId: account.id,
      createdBy: input.createdBy,
      version: next.value,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("qualifications", (rows) => rows.push(qualification));
    return { ok: true, value: qualification };
  }

  getQualification(id: EntityId, userId: EntityId): Result<Qualification, StorageError> {
    const qualification = this.findById("qualifications", id);
    if (!qualification)
      return { ok: false, error: toError("NOT_FOUND", "qualification not found") };
    const auth = this.requireWorkspace(qualification.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: qualification };
  }

  /**
   * A workspace's qualifications, newest first, optionally narrowed.
   *
   * Nothing is filtered out by default: every past version of every account
   * stays listable, because a record that can be superseded into invisibility
   * is not an audit trail.
   */
  listQualifications(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      state?: QualificationState;
      ruleVersion?: string;
    },
  ): Result<Qualification[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("qualifications").filter((q) => q.workspaceId === workspaceId);
    const filtered = scoped.filter((q) => {
      if (filter?.accountId && q.accountId !== filter.accountId) return false;
      if (filter?.state && q.state !== filter.state) return false;
      if (filter?.ruleVersion && q.ruleVersion !== filter.ruleVersion) return false;
      return true;
    });
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.evaluatedAt < b.evaluatedAt
          ? 1
          : a.evaluatedAt > b.evaluatedAt
            ? -1
            : b.version - a.version,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Phase 9 — Personalization Engine
  // -------------------------------------------------------------------------

  /**
   * The next 1-based version within an account's draft lineage.
   *
   * Counted from stored rows rather than from a counter, so a restored backup
   * cannot reissue a version an approval may already be bound to.
   */
  nextDraftVersion(accountId: EntityId): Result<number, StorageError> {
    const versions = this.rows("personalizedDrafts")
      .filter((d) => d.accountId === accountId)
      .map((d) => d.version);
    return { ok: true, value: versions.length === 0 ? 1 : Math.max(...versions) + 1 };
  }

  /**
   * Record one personalized draft.
   *
   * Every reference the draft carries must live in the same workspace, so a
   * draft can never point at another tenant's account, contact, qualification
   * or offer — which would let one workspace's outreach quote another's
   * evidence. The version is computed here rather than accepted, so two
   * concurrent renders cannot claim the same slot in the account's history.
   */
  createDraft(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    accountId: EntityId;
    draft: Omit<
      PersonalizedDraft,
      "id" | "workspaceId" | "accountId" | "createdBy" | "version" | "createdAt" | "updatedAt"
    >;
  }): Result<PersonalizedDraft, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    const account = this.findById("accounts", input.accountId);
    if (!account || account.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "account does not exist in this workspace"),
      };
    }
    if (input.draft.contactId !== null) {
      const contact = this.findById("contacts", input.draft.contactId);
      if (!contact || contact.workspaceId !== input.workspaceId) {
        return { ok: false, error: toError("INVALID", "contact does not exist in this workspace") };
      }
      if (contact.accountId !== account.id) {
        return {
          ok: false,
          error: toError("INVALID", "contact does not belong to this account"),
        };
      }
    }
    if (input.draft.qualificationId !== null) {
      const qualification = this.findById("qualifications", input.draft.qualificationId);
      if (!qualification || qualification.workspaceId !== input.workspaceId) {
        return {
          ok: false,
          error: toError("INVALID", "qualification does not exist in this workspace"),
        };
      }
    }
    if (input.draft.offerId !== null) {
      const offer = this.findById("offers", input.draft.offerId);
      if (!offer || offer.workspaceId !== input.workspaceId) {
        return { ok: false, error: toError("INVALID", "offer does not exist in this workspace") };
      }
    }

    const next = this.nextDraftVersion(account.id);
    if (!next.ok) return next;
    const stamp = toDateTime(now());
    const draft: PersonalizedDraft = {
      ...input.draft,
      id: newId(),
      workspaceId: input.workspaceId,
      accountId: account.id,
      createdBy: input.createdBy,
      version: next.value,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("personalizedDrafts", (rows) => rows.push(draft));
    return { ok: true, value: draft };
  }

  getDraft(id: EntityId, userId: EntityId): Result<PersonalizedDraft, StorageError> {
    const draft = this.findById("personalizedDrafts", id);
    if (!draft) return { ok: false, error: toError("NOT_FOUND", "draft not found") };
    const auth = this.requireWorkspace(draft.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: draft };
  }

  /**
   * A workspace's drafts, newest first, optionally narrowed to one account.
   *
   * Nothing is filtered out by default: every version of every draft stays
   * listable, because an approval may be bound to any of them and a record that
   * disappears from a listing is a record a reviewer cannot re-check.
   */
  listDrafts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId },
  ): Result<PersonalizedDraft[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("personalizedDrafts").filter((d) => d.workspaceId === workspaceId);
    const filtered = filter?.accountId
      ? scoped.filter((d) => d.accountId === filter.accountId)
      : scoped;
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.version - a.version,
      ),
    };
  }

  /**
   * The workspace's Phase 2 claims whose status is `approved`.
   *
   * A dedicated read rather than a `listClaims({ status })` filter, because this
   * is a *quotable* set with a safety meaning: Phase 9's renderer may quote
   * these verbatim in an external draft and nothing else. An `unverified` claim
   * is context and a `restricted` claim must never leave the workspace
   * (DEALORA_BLUEPRINT.md §9), so a caller that needs one of those must ask
   * `listClaims` for it explicitly.
   */
  listApprovedClaims(workspaceId: EntityId, userId: EntityId): Result<Claim[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("claims").filter(
      (c) => c.workspaceId === workspaceId && c.status === "approved",
    );
    return { ok: true, value: scoped };
  }

  // -------------------------------------------------------------------------
  // Phase 10 — Approval Engine
  // -------------------------------------------------------------------------

  /**
   * Record one request for a human decision.
   *
   * Every field except the decision itself is resolved server-side by the
   * caller: `createdBy` is the authenticated user, and the request binds to a
   * draft that must live in this same workspace at the named version. The
   * decision columns are written as `null`/`pending` here and are only ever
   * moved by `decideApproval`, so there is no storage path that can create an
   * already-approved request.
   */
  createApprovalRequest(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    approval: Omit<
      ApprovalRequest,
      | "id"
      | "workspaceId"
      | "createdBy"
      | "status"
      | "decision"
      | "decidedBy"
      | "decidedAt"
      | "decisionReason"
      | "createdAt"
      | "updatedAt"
    >;
  }): Result<ApprovalRequest, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    // The draft must exist here: an approval for another tenant's draft, or for
    // a draft id that does not exist, would authorize nothing and mislead
    // everyone who read it.
    const draft = this.findById("personalizedDrafts", input.approval.draftId);
    if (!draft || draft.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "draft does not exist in this workspace"),
      };
    }
    // The version must be one the draft lineage actually has: binding to a
    // version that was never rendered is how an approval ends up authorizing
    // text nobody read.
    const hasVersion = this.rows("personalizedDrafts").some(
      (row) => row.id === input.approval.draftId && row.version === input.approval.draftVersion,
    );
    if (!hasVersion) {
      return {
        ok: false,
        error: toError("INVALID", "that draft version does not exist"),
      };
    }
    const stamp = toDateTime(now());
    const request: ApprovalRequest = {
      ...input.approval,
      id: newId(),
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      status: "pending",
      decision: null,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("approvalRequests", (rows) => rows.push(request));
    return { ok: true, value: request };
  }

  /**
   * Record one state a request passed through.
   *
   * Append-only: there is no update or delete, so the history of a decision
   * survives whatever happens to the request row afterwards.
   */
  createApprovalRequestEvent(input: {
    workspaceId: EntityId;
    actorUserId: EntityId;
    event: Omit<ApprovalRequestEvent, "id" | "workspaceId" | "actorUserId" | "createdAt">;
  }): Result<ApprovalRequestEvent, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.actorUserId);
    if (!auth.ok) return auth;
    const approval = this.findById("approvalRequests", input.event.approvalId);
    if (!approval || approval.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "approval request does not exist in this workspace"),
      };
    }
    const event: ApprovalRequestEvent = {
      ...input.event,
      id: newId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      createdAt: toDateTime(now()),
    };
    this.mutate("approvalRequestEvents", (rows) => rows.push(event));
    return { ok: true, value: event };
  }

  /**
   * Move a request to a decided state.
   *
   * Only ever reached from `decideApproval`/`cancelApproval` in the domain, and
   * always with the reviewer taken from the authenticated identity. `pending` is
   * the only legal starting state: a second decision on an already-decided
   * request is refused rather than overwriting the first, because a decision
   * that can be rewritten is not a decision.
   */
  decideApproval(input: {
    id: EntityId;
    userId: EntityId;
    decision: ApprovalDecision;
    reason: string | null;
    decidedAt: DateTime;
  }): Result<ApprovalRequest, StorageError> {
    const request = this.findById("approvalRequests", input.id);
    if (!request) return { ok: false, error: toError("NOT_FOUND", "approval request not found") };
    const auth = this.requireWorkspace(request.workspaceId, input.userId);
    if (!auth.ok) return auth;
    if (request.status !== "pending") {
      return {
        ok: false,
        error: toError("CONFLICT", `this request is already ${request.status}`),
      };
    }
    const decided: ApprovalRequest = {
      ...request,
      status: input.decision,
      decision: input.decision,
      decidedBy: input.userId,
      decidedAt: input.decidedAt,
      decisionReason: input.reason,
      updatedAt: input.decidedAt,
    };
    this.mutate("approvalRequests", (rows) => {
      const typed = rows as ApprovalRequest[];
      const index = typed.findIndex((row) => row.id === input.id);
      if (index === -1) return;
      typed[index] = decided;
    });
    return { ok: true, value: decided };
  }

  /**
   * Close a pending request without a decision: cancelled by the requester, or
   * expired by its own deadline.
   *
   * A timeout closes the door and never opens one — `expired` is not a decision
   * and cannot authorize anything, which is why it shares this method with
   * `cancelled` and neither path can produce `approved`.
   */
  closeApproval(input: {
    id: EntityId;
    userId: EntityId;
    status: Extract<ApprovalStatus, "cancelled" | "expired">;
    reason: string | null;
    decidedAt: DateTime;
  }): Result<ApprovalRequest, StorageError> {
    const request = this.findById("approvalRequests", input.id);
    if (!request) return { ok: false, error: toError("NOT_FOUND", "approval request not found") };
    const auth = this.requireWorkspace(request.workspaceId, input.userId);
    if (!auth.ok) return auth;
    if (request.status !== "pending") {
      return {
        ok: false,
        error: toError("CONFLICT", `this request is already ${request.status}`),
      };
    }
    const closed: ApprovalRequest = {
      ...request,
      status: input.status,
      decision: null,
      decidedBy: null,
      decidedAt: input.decidedAt,
      decisionReason: input.reason,
      updatedAt: input.decidedAt,
    };
    this.mutate("approvalRequests", (rows) => {
      const typed = rows as ApprovalRequest[];
      const index = typed.findIndex((row) => row.id === input.id);
      if (index === -1) return;
      typed[index] = closed;
    });
    return { ok: true, value: closed };
  }

  getApprovalRequest(id: EntityId, userId: EntityId): Result<ApprovalRequest, StorageError> {
    const request = this.findById("approvalRequests", id);
    if (!request) return { ok: false, error: toError("NOT_FOUND", "approval request not found") };
    const auth = this.requireWorkspace(request.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: request };
  }

  /**
   * A workspace's approval requests, newest first.
   *
   * Nothing is filtered out by default. A rejected or expired request stays
   * listable because it is the record of a human saying no, and that record is
   * exactly what a later reader needs to see.
   */
  listApprovalRequests(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      draftId?: EntityId;
      status?: ApprovalStatus;
      decidedBy?: EntityId;
    },
  ): Result<ApprovalRequest[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    let scoped = this.rows("approvalRequests").filter((r) => r.workspaceId === workspaceId);
    if (filter?.draftId) scoped = scoped.filter((r) => r.draftId === filter.draftId);
    if (filter?.status) scoped = scoped.filter((r) => r.status === filter.status);
    if (filter?.decidedBy) scoped = scoped.filter((r) => r.decidedBy === filter.decidedBy);
    return {
      ok: true,
      value: [...scoped].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      ),
    };
  }

  /** One request's audit trail, oldest first. Never empty for a real request. */
  listApprovalRequestEvents(
    approvalId: EntityId,
    userId: EntityId,
  ): Result<ApprovalRequestEvent[], StorageError> {
    const request = this.findById("approvalRequests", approvalId);
    if (!request) return { ok: false, error: toError("NOT_FOUND", "approval request not found") };
    const auth = this.requireWorkspace(request.workspaceId, userId);
    if (!auth.ok) return auth;
    const events = this.rows("approvalRequestEvents").filter((e) => e.approvalId === approvalId);
    return { ok: true, value: [...events].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)) };
  }

  // -------------------------------------------------------------------------
  // Phase 11 — First Outbound Integration
  // -------------------------------------------------------------------------

  /**
   * Stage one controlled external communication.
   *
   * An action is created only once every precondition already holds: the caller
   * is a member of the workspace, the referenced draft version exists **in this
   * workspace**, the approval record exists **in this workspace and is bound to
   * that same draft version**, the contact exists here too, and **no action has
   * already been raised for that approval**.
   *
   * That last check is the storage half of an invariant the send path depends on
   * entirely: *one approval authorizes at most one message*. The service already
   * returns the existing action instead of creating a second one, but an
   * invariant that only one caller respects is a convention, not a guarantee —
   * exactly the reasoning `createApprovalRequest` and `decideApproval` already
   * apply. Enforcing it here means a second action for the same approval cannot
   * exist at all, so duplicate-send protection cannot be bypassed by any path.
   *
   * The approval's `status` is deliberately *not* checked here — deciding whether
   * an approval currently authorizes a send is the service's question, re-asked
   * independently at send time, and duplicating the rule here would give one
   * answer in two places.
   *
   * Everything the provider will later own — `provider`, `status`,
   * `attemptCount`, `providerReference`, `failure*`, `attemptedAt`, `sentAt` —
   * is written as `null`/`ready` here. There is no input that can create a
   * `sent` action, so a send can only ever come from `recordOutboundAttempt`.
   */
  createOutboundAction(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    action: Omit<
      OutboundAction,
      | "id"
      | "workspaceId"
      | "createdBy"
      | "provider"
      | "status"
      | "attemptCount"
      | "providerReference"
      | "failureCode"
      | "failureMessage"
      | "attemptedAt"
      | "sentAt"
      | "completedAt"
      | "createdAt"
      | "updatedAt"
    >;
  }): Result<OutboundAction, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;

    // One approval, one action. Refused rather than silently deduplicated: the
    // caller asked for a new action, and the honest answer is that the approval
    // has already been spent on one.
    const existingForApproval = this.rows("outboundActions").find(
      (row) => row.approvalId === input.action.approvalId,
    );
    if (existingForApproval) {
      return {
        ok: false,
        error: toError("CONFLICT", "this approval already has an outbound action"),
      };
    }

    const draft = this.findById("personalizedDrafts", input.action.draftId);
    if (!draft || draft.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "draft does not exist in this workspace"),
      };
    }
    if (draft.version !== input.action.draftVersion) {
      return {
        ok: false,
        error: toError("INVALID", "that draft version does not exist"),
      };
    }

    // The approval must belong to this workspace **and** cover exactly the
    // version being sent. An approval for another version authorizes nothing.
    const approval = this.findById("approvalRequests", input.action.approvalId);
    if (!approval || approval.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "approval request does not exist in this workspace"),
      };
    }
    if (
      approval.draftId !== input.action.draftId ||
      approval.draftVersion !== input.action.draftVersion
    ) {
      return {
        ok: false,
        error: toError("INVALID", "this approval does not cover that draft version"),
      };
    }

    const contact = this.findById("contacts", input.action.contactId);
    if (!contact || contact.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "contact does not exist in this workspace"),
      };
    }

    const stamp = toDateTime(now());
    const action: OutboundAction = {
      ...input.action,
      id: newId(),
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      provider: null,
      status: "ready",
      attemptCount: 0,
      providerReference: null,
      failureCode: null,
      failureMessage: null,
      attemptedAt: null,
      sentAt: null,
      completedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("outboundActions", (rows) => rows.push(action));
    return { ok: true, value: action };
  }

  /**
   * Record one provider attempt.
   *
   * Append-only in the sense that matters: `attemptCount` only ever increases
   * and `attemptedAt` only ever moves forward, so "how many times did this try,
   * and when" is a stored fact rather than a reconstruction. `sentAt` is written
   * **only** on a confirmed submission; a failure never carries one, and the
   * caller cannot pass one on the failure path at all.
   *
   * Only `ready` and `failed` may be attempted, which is what stops a second
   * provider call for an action already confirmed `sent`.
   */
  recordOutboundAttempt(input: {
    id: EntityId;
    userId: EntityId;
    provider: string;
    attemptedAt: DateTime;
  }): Result<OutboundAction, StorageError> {
    const action = this.requireOutboundAction(input.id, input.userId);
    if (!action.ok) return action;
    const current = action.value;
    if (current.status !== "ready" && current.status !== "failed") {
      return {
        ok: false,
        error: toError("CONFLICT", `this action is already ${current.status}`),
      };
    }
    return this.writeOutboundAction(current.id, (row) => ({
      ...row,
      provider: input.provider,
      status: "sending",
      attemptCount: row.attemptCount + 1,
      attemptedAt: input.attemptedAt,
      updatedAt: input.attemptedAt,
    }));
  }

  /**
   * Record the provider's confirmation.
   *
   * This is the only path to `sent`. The provider reference and the instant are
   * the provider's and the server's, taken from its response — a client cannot
   * supply either one, and there is no input here that could mark an attempt
   * sent without a confirmation.
   */
  confirmOutboundSent(input: {
    id: EntityId;
    userId: EntityId;
    provider: string;
    providerReference: string | null;
    sentAt: DateTime;
  }): Result<OutboundAction, StorageError> {
    const action = this.requireOutboundAction(input.id, input.userId);
    if (!action.ok) return action;
    const current = action.value;
    if (current.status !== "sending") {
      return {
        ok: false,
        error: toError("CONFLICT", `this action is ${current.status}, not in flight`),
      };
    }
    return this.writeOutboundAction(current.id, (row) => ({
      ...row,
      provider: input.provider,
      status: "sent",
      providerReference: input.providerReference,
      failureCode: null,
      failureMessage: null,
      sentAt: input.sentAt,
      completedAt: input.sentAt,
      updatedAt: input.sentAt,
    }));
  }

  /**
   * Record a failed send.
   *
   * Two honest cases reach this method, and both must be representable:
   *
   * - **After an attempt** (`sending`): the provider refused or errored. The
   *   provider name and the `attemptCount` recorded by `recordOutboundAttempt`
   *   are kept, because a provider was genuinely called.
   * - **Before any attempt** (`ready` or `failed`): a pre-flight refusal, such as
   *   an opt-out suppression found by the send path. `attemptCount` and
   *   `attemptedAt` are deliberately left untouched, so the record continues to
   *   say truthfully that no provider was ever called on this occasion — and the
   *   attempt budget is not spent on a send that never left the system.
   *
   * A pre-flight refusal on an already-`failed` action **updates** the code and
   * message rather than leaving the previous one: `failureCode` answers "why is
   * this action not sent", and the newest reason is the true one. The earlier
   * provider failure is not lost — it is in the append-only event trail, which is
   * what that trail exists for.
   *
   * In every case a failure is stored with its closed-vocabulary code and the
   * message as given, and **never** with a `sentAt`: the schema constrains
   * `sent_at` to a `sent` action, so a failed send cannot be mistaken for a
   * delivery even if a caller passes the wrong timestamp.
   */
  recordOutboundFailure(input: {
    id: EntityId;
    userId: EntityId;
    provider: string;
    failureCode: OutboundFailureCode;
    failureMessage: string;
    failedAt: DateTime;
  }): Result<OutboundAction, StorageError> {
    const action = this.requireOutboundAction(input.id, input.userId);
    if (!action.ok) return action;
    const current = action.value;
    const inFlight = current.status === "sending";
    if (!inFlight && current.status !== "ready" && current.status !== "failed") {
      return {
        ok: false,
        error: toError("CONFLICT", `this action is ${current.status}, not in flight or retryable`),
      };
    }
    return this.writeOutboundAction(current.id, (row) => ({
      ...row,
      // A pre-flight refusal names no provider, because none handled the message
      // on this occasion; an in-flight failure keeps the provider that did.
      ...(inFlight ? { provider: input.provider } : {}),
      status: "failed",
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      sentAt: null,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    }));
  }

  /** Withdraw a staged action before any provider call. Terminal. */
  cancelOutboundAction(
    id: EntityId,
    userId: EntityId,
    reason: string | null,
    cancelledAt: DateTime,
  ): Result<OutboundAction, StorageError> {
    const action = this.requireOutboundAction(id, userId);
    if (!action.ok) return action;
    const current = action.value;
    if (current.status !== "ready" && current.status !== "failed") {
      return {
        ok: false,
        error: toError("CONFLICT", `this action is already ${current.status}`),
      };
    }
    return this.writeOutboundAction(current.id, (row) => ({
      ...row,
      status: "cancelled",
      completedAt: cancelledAt,
      updatedAt: cancelledAt,
      ...(reason === null ? {} : { failureMessage: reason }),
    }));
  }

  /** Record one step an action took. Append-only; never edited or deleted. */
  createOutboundEvent(input: {
    workspaceId: EntityId;
    actorUserId: EntityId;
    event: Omit<OutboundEvent, "id" | "workspaceId" | "actorUserId" | "createdAt">;
  }): Result<OutboundEvent, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.actorUserId);
    if (!auth.ok) return auth;
    const action = this.findById("outboundActions", input.event.actionId);
    if (!action || action.workspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: toError("INVALID", "outbound action does not exist in this workspace"),
      };
    }
    const event: OutboundEvent = {
      ...input.event,
      id: newId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      createdAt: toDateTime(now()),
    };
    this.mutate("outboundEvents", (rows) => rows.push(event));
    return { ok: true, value: event };
  }

  getOutboundAction(id: EntityId, userId: EntityId): Result<OutboundAction, StorageError> {
    return this.requireOutboundAction(id, userId);
  }

  /** A workspace's outbound actions, newest first. */
  listOutboundActions(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      draftId?: EntityId;
      approvalId?: EntityId;
      contactId?: EntityId;
      status?: OutboundActionStatus;
    },
  ): Result<OutboundAction[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    let scoped = this.rows("outboundActions").filter((a) => a.workspaceId === workspaceId);
    if (filter?.draftId) scoped = scoped.filter((a) => a.draftId === filter.draftId);
    if (filter?.approvalId) scoped = scoped.filter((a) => a.approvalId === filter.approvalId);
    if (filter?.contactId) scoped = scoped.filter((a) => a.contactId === filter.contactId);
    if (filter?.status) scoped = scoped.filter((a) => a.status === filter.status);
    return {
      ok: true,
      value: [...scoped].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      ),
    };
  }

  /**
   * Actions for one approval.
   *
   * This is the idempotency check a send depends on: a second send of the same
   * approval is refused by finding the action that already carries it.
   */
  findOutboundActionByApproval(
    approvalId: EntityId,
    userId: EntityId,
  ): Result<OutboundAction | null, StorageError> {
    const approval = this.findById("approvalRequests", approvalId);
    if (!approval) return { ok: false, error: toError("NOT_FOUND", "approval request not found") };
    const auth = this.requireWorkspace(approval.workspaceId, userId);
    if (!auth.ok) return auth;
    const found = this.rows("outboundActions").find((a) => a.approvalId === approvalId);
    return { ok: true, value: found ?? null };
  }

  /** One action's audit trail, oldest first. */
  listOutboundEvents(actionId: EntityId, userId: EntityId): Result<OutboundEvent[], StorageError> {
    const action = this.findById("outboundActions", actionId);
    if (!action) return { ok: false, error: toError("NOT_FOUND", "outbound action not found") };
    const auth = this.requireWorkspace(action.workspaceId, userId);
    if (!auth.ok) return auth;
    const events = this.rows("outboundEvents").filter((e) => e.actionId === actionId);
    return { ok: true, value: [...events].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)) };
  }

  /**
   * Add an address to the workspace's opt-out list.
   *
   * Idempotent by address: adding the same address twice returns the existing
   * record rather than a duplicate, because a suppression list that can grow
   * two rows for one address is a list nobody can audit.
   */
  createOutboundSuppression(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    suppression: { email: string; reason: string };
  }): Result<OutboundSuppression, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;
    const email = input.suppression.email.toLowerCase();
    const existing = this.rows("outboundSuppressions").find(
      (s) => s.workspaceId === input.workspaceId && s.email === email,
    );
    if (existing) return { ok: true, value: existing };

    const stamp = toDateTime(now());
    const suppression: OutboundSuppression = {
      id: newId(),
      workspaceId: input.workspaceId,
      email,
      reason: input.suppression.reason,
      createdBy: input.createdBy,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("outboundSuppressions", (rows) => rows.push(suppression));
    return { ok: true, value: suppression };
  }

  /**
   * Is this address suppressed in this workspace?
   *
   * Matched case-insensitively on the lower-cased address, because an opt-out
   * is a statement about a person, not about the casing someone typed it in.
   */
  isSuppressed(
    workspaceId: EntityId,
    userId: EntityId,
    email: string,
  ): Result<boolean, StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const needle = email.toLowerCase();
    return {
      ok: true,
      value: this.rows("outboundSuppressions").some(
        (s) => s.workspaceId === workspaceId && s.email === needle,
      ),
    };
  }

  listOutboundSuppressions(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<OutboundSuppression[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const scoped = this.rows("outboundSuppressions").filter((s) => s.workspaceId === workspaceId);
    return {
      ok: true,
      value: [...scoped].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      ),
    };
  }

  /** Resolve one action for reading or writing, authorized against its tenant. */
  private requireOutboundAction(
    id: EntityId,
    userId: EntityId,
  ): Result<OutboundAction, StorageError> {
    const action = this.findById("outboundActions", id);
    if (!action) return { ok: false, error: toError("NOT_FOUND", "outbound action not found") };
    const auth = this.requireWorkspace(action.workspaceId, userId);
    if (!auth.ok) return auth;
    return { ok: true, value: action };
  }

  /** Replace one action row through the store's single mutation path. */
  private writeOutboundAction(
    id: EntityId,
    write: (row: OutboundAction) => OutboundAction,
  ): Result<OutboundAction, StorageError> {
    let written: OutboundAction | null = null;
    this.mutate("outboundActions", (rows) => {
      const typed = rows as OutboundAction[];
      const index = typed.findIndex((row) => row.id === id);
      if (index === -1) return;
      const next = write(typed[index] as OutboundAction);
      typed[index] = next;
      written = next;
    });
    if (written === null) {
      return { ok: false, error: toError("NOT_FOUND", "outbound action not found") };
    }
    return { ok: true, value: written };
  }

  /** Cleanup helper so tests and local runs do not leave files behind. */
  destroy(): void {
    try {
      rmSync(DB_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Conversation (Phase 12)
  //
  // Inbound responses and their classifications. Nothing in this section can
  // send a message, create an approval, or write to the Phase 7 evidence graph:
  // it records what arrived, what it read as, and what DEALORA recommends doing
  // about it. Every effect still runs through the Phase 10 approval and Phase 11
  // send path that already existed.
  // -------------------------------------------------------------------------

  /**
   * Record one inbound response, verbatim.
   *
   * Three preconditions are enforced here rather than in the service, because
   * they are properties of the data and must hold for any caller:
   *
   * - the outbound action exists **in this workspace**;
   * - that action actually went out — a response to a message that was never
   *   sent is not a response, and accepting one would let a workspace
   *   manufacture a conversation with a prospect it never contacted;
   * - the action is terminal (`sent`), so a response cannot be filed against a
   *   send still in flight.
   *
   * `contactId` and `accountId` are **not** accepted from the caller at all.
   * They are resolved here from the action, so a message can never be filed
   * against the wrong person.
   */
  createInboundMessage(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    message: {
      outboundActionId: EntityId;
      source: InboundSource;
      fromAddress: string | null;
      subject: string | null;
      body: string;
      providerMessageId: string | null;
      receivedAt: DateTime;
    };
  }): Result<InboundMessage, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;

    const action = this.findById("outboundActions", input.message.outboundActionId);
    if (!action || action.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "outbound action not found") };
    }
    if (action.status !== "sent") {
      return {
        ok: false,
        error: toError(
          "CONFLICT",
          `this action is ${action.status}, so no response can be recorded against it`,
        ),
      };
    }

    const contact = this.findById("contacts", action.contactId);
    if (!contact || contact.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "contact not found") };
    }

    const stamp = toDateTime(now());
    const message: InboundMessage = {
      id: newId(),
      workspaceId: input.workspaceId,
      recordedBy: input.createdBy,
      outboundActionId: action.id,
      contactId: contact.id,
      accountId: contact.accountId,
      source: input.message.source,
      fromAddress: input.message.fromAddress,
      subject: input.message.subject,
      body: input.message.body,
      providerMessageId: input.message.providerMessageId,
      receivedAt: input.message.receivedAt,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.mutate("inboundMessages", (rows) => rows.push(message));
    return { ok: true, value: message };
  }

  /**
   * Resolve one inbound message for reading, authorized against its tenant.
   *
   * A message the caller may not read is reported as **not found**, never as
   * unauthorized: an unauthorized answer would confirm that the id refers to
   * something real in someone else's workspace, which is exactly the existence
   * leak the tenant boundary exists to prevent. This is the same rule the
   * Qualification and Approval engines apply, and the caller cannot tell the
   * two cases apart.
   */
  private requireInboundMessage(
    id: EntityId,
    userId: EntityId,
  ): Result<InboundMessage, StorageError> {
    const message = this.findById("inboundMessages", id);
    if (!message) return { ok: false, error: toError("NOT_FOUND", "inbound message not found") };
    const auth = this.requireWorkspace(message.workspaceId, userId);
    if (!auth.ok) return { ok: false, error: toError("NOT_FOUND", "inbound message not found") };
    return { ok: true, value: message };
  }

  getInboundMessage(id: EntityId, userId: EntityId): Result<InboundMessage, StorageError> {
    return this.requireInboundMessage(id, userId);
  }

  /** A workspace's responses, newest first, optionally narrowed. */
  listInboundMessages(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { outboundActionId?: EntityId; contactId?: EntityId },
  ): Result<InboundMessage[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const filtered = this.rows("inboundMessages").filter(
      (m) =>
        m.workspaceId === workspaceId &&
        (filter?.outboundActionId === undefined ||
          m.outboundActionId === filter.outboundActionId) &&
        (filter?.contactId === undefined || m.contactId === filter.contactId),
    );
    // Newest first. The tiebreaker is the stored array position rather than the
    // id, exactly as `listRevenueGoalEvents` does it: ids are random, so
    // breaking equal timestamps by id would order two copies of the same
    // document differently for no reason a reader could reconstruct.
    return {
      ok: true,
      value: filtered
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          if (a.row.receivedAt !== b.row.receivedAt) {
            return a.row.receivedAt < b.row.receivedAt ? 1 : -1;
          }
          return a.index - b.index;
        })
        .map((entry) => entry.row),
    };
  }

  /**
   * The classification already made for one message, if any.
   *
   * This is the idempotency check: one message is read once. Re-classifying the
   * same text could otherwise let a second, different answer be attached to one
   * response, which is precisely how an audit trail stops meaning anything.
   */
  findConversationClassificationByMessage(
    inboundMessageId: EntityId,
    userId: EntityId,
  ): Result<ConversationClassification | null, StorageError> {
    const message = this.requireInboundMessage(inboundMessageId, userId);
    if (!message.ok) return message;
    const found =
      this.rows("conversationClassifications").find(
        (c) => c.inboundMessageId === inboundMessageId,
      ) ?? null;
    return { ok: true, value: found };
  }

  /**
   * Persist one classification.
   *
   * The caller supplies the *result*, never the safety decision: the intent,
   * confidence, recommended action and `humanInterventionRequired` are all
   * written by the domain's classifier. Storage re-checks the two invariants the
   * schema cannot express on its own — that a suppression was only ever recorded
   * for an opt-out, and that anything other than an opt-out demands a human —
   * so a bug in the classifier cannot quietly authorise contact.
   */
  createConversationClassification(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    classification: {
      inboundMessageId: EntityId;
      outboundActionId: EntityId;
      classifierVersion: string;
      intent: ConversationClassification["intent"];
      confidence: ConversationClassification["confidence"];
      reasons: string[];
      signals: ConversationClassification["signals"];
      recommendedNextAction: ConversationClassification["recommendedNextAction"];
      humanInterventionRequired: boolean;
      suppressed: boolean;
    };
  }): Result<ConversationClassification, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;

    const message = this.findById("inboundMessages", input.classification.inboundMessageId);
    if (!message || message.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "inbound message not found") };
    }
    const existing = this.rows("conversationClassifications").find(
      (c) => c.inboundMessageId === input.classification.inboundMessageId,
    );
    if (existing) {
      return {
        ok: false,
        error: toError("CONFLICT", "this response has already been classified"),
      };
    }
    if (input.classification.suppressed && input.classification.intent !== "unsubscribe") {
      return {
        ok: false,
        error: toError("INVALID", "only an opt-out may suppress an address"),
      };
    }
    if (
      !input.classification.humanInterventionRequired &&
      input.classification.intent !== "unsubscribe"
    ) {
      return {
        ok: false,
        error: toError("INVALID", "only an opt-out may proceed without human review"),
      };
    }

    const classification: ConversationClassification = {
      id: newId(),
      workspaceId: input.workspaceId,
      inboundMessageId: input.classification.inboundMessageId,
      outboundActionId: input.classification.outboundActionId,
      classifierVersion: input.classification.classifierVersion,
      intent: input.classification.intent,
      confidence: input.classification.confidence,
      reasons: input.classification.reasons,
      signals: input.classification.signals,
      recommendedNextAction: input.classification.recommendedNextAction,
      humanInterventionRequired: input.classification.humanInterventionRequired,
      suppressed: input.classification.suppressed,
      createdBy: input.createdBy,
      createdAt: toDateTime(now()),
    };
    this.mutate("conversationClassifications", (rows) => rows.push(classification));
    return { ok: true, value: classification };
  }

  /** Resolve one classification for reading, authorized against its tenant. */
  private requireConversationClassification(
    id: EntityId,
    userId: EntityId,
  ): Result<ConversationClassification, StorageError> {
    const classification = this.findById("conversationClassifications", id);
    if (!classification) {
      return { ok: false, error: toError("NOT_FOUND", "conversation classification not found") };
    }
    const auth = this.requireWorkspace(classification.workspaceId, userId);
    // Reported as not found rather than unauthorized, so a foreign id is
    // indistinguishable from one that was never issued.
    if (!auth.ok) {
      return { ok: false, error: toError("NOT_FOUND", "conversation classification not found") };
    }
    return { ok: true, value: classification };
  }

  getConversationClassification(
    id: EntityId,
    userId: EntityId,
  ): Result<ConversationClassification, StorageError> {
    return this.requireConversationClassification(id, userId);
  }

  /** A workspace's classifications, newest first, optionally narrowed. */
  listConversationClassifications(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      intent?: ConversationClassification["intent"];
      outboundActionId?: EntityId;
    },
  ): Result<ConversationClassification[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const filtered = this.rows("conversationClassifications").filter(
      (c) =>
        c.workspaceId === workspaceId &&
        (filter?.intent === undefined || c.intent === filter.intent) &&
        (filter?.outboundActionId === undefined || c.outboundActionId === filter.outboundActionId),
    );
    return {
      ok: true,
      value: [...filtered].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      ),
    };
  }

  /** One append-only audit row for a classification. */
  createConversationEvent(input: {
    workspaceId: EntityId;
    actorUserId: EntityId;
    event: {
      classificationId: EntityId;
      inboundMessageId: EntityId;
      kind: ConversationEventKind;
      detail: string | null;
    };
  }): Result<ConversationEvent, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.actorUserId);
    if (!auth.ok) return auth;
    const classification = this.findById(
      "conversationClassifications",
      input.event.classificationId,
    );
    if (!classification || classification.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "conversation classification not found") };
    }
    const event: ConversationEvent = {
      id: newId(),
      classificationId: input.event.classificationId,
      inboundMessageId: input.event.inboundMessageId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      kind: input.event.kind,
      detail: input.event.detail,
      createdAt: toDateTime(now()),
    };
    this.mutate("conversationEvents", (rows) => rows.push(event));
    return { ok: true, value: event };
  }

  /** One classification's audit trail, oldest first. */
  listConversationEvents(
    classificationId: EntityId,
    userId: EntityId,
  ): Result<ConversationEvent[], StorageError> {
    const classification = this.requireConversationClassification(classificationId, userId);
    if (!classification.ok) return classification;
    const events = this.rows("conversationEvents").filter(
      (e) => e.classificationId === classificationId,
    );
    // Chronological, with insertion order breaking millisecond ties — ids are
    // random, so an id tiebreaker would scramble equal-timestamp events.
    return {
      ok: true,
      value: events
        .map((row, index) => ({ row, index }))
        .sort((a, b) =>
          a.row.createdAt !== b.row.createdAt
            ? a.row.createdAt < b.row.createdAt
              ? -1
              : 1
            : a.index - b.index,
        )
        .map((entry) => entry.row),
    };
  }

  // -------------------------------------------------------------------------
  // Phase 13 — Meeting Workflow
  // -------------------------------------------------------------------------

  /**
   * Persist one proposed meeting.
   *
   * The booking record is created in `recommended` and nothing else: a positive
   * response is an *input* to a meeting, not a booking. Every prerequisite is
   * re-derived here from stored rows rather than trusted from the caller — the
   * classification must exist in this workspace and read as positive intent, and
   * the qualification must exist and read as `qualified` — so a bug in the
   * domain service cannot propose a meeting out of nothing.
   *
   * `bookingDigest` is mandatory from the first row. It is the digest of the
   * exact booking that a reviewer will be shown, and it is what an approval will
   * later be checked against; storing it up front is what makes "I authorized
   * *this*" checkable later.
   */
  createMeeting(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    meeting: {
      accountId: EntityId;
      contactId: EntityId;
      classificationId: EntityId;
      inboundMessageId: EntityId;
      outboundActionId: EntityId;
      qualificationId: EntityId;
      state: MeetingBookingState;
      recommendationReason: MeetingRecommendationReason;
      policyVersion: string;
      bookingDigest: string;
      title: string;
      startsAt: DateTime;
      endsAt: DateTime;
      timezone: string;
      durationMinutes: number;
      channel: Meeting["channel"];
      externalEventId?: string | null;
      suppressionCheckedAt?: DateTime | null;
      approvedBy?: EntityId | null;
      approvedAt?: DateTime | null;
      bookedAt?: DateTime | null;
      cancelledAt?: DateTime | null;
      decisionReason?: string | null;
    };
  }): Result<Meeting, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;

    const classification = this.findById(
      "conversationClassifications",
      input.meeting.classificationId,
    );
    if (!classification || classification.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "conversation classification not found") };
    }
    const qualification = this.findById("qualifications", input.meeting.qualificationId);
    if (!qualification || qualification.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "qualification not found") };
    }
    // The prerequisites are re-checked at the storage boundary, so "a meeting
    // without a positive response" and "a meeting for an account that did not
    // qualify" are not representable, whichever layer asks.
    if (classification.intent !== "positive_intent" && classification.intent !== "interested") {
      return {
        ok: false,
        error: toError("INVALID", "a meeting requires a positive or interested response"),
      };
    }
    if (qualification.state !== "qualified") {
      return {
        ok: false,
        error: toError("INVALID", "a meeting requires a qualified account"),
      };
    }
    // One meeting per response. A response is a single occurrence of interest;
    // letting it become two meetings would be two calendar entries for one
    // conversation.
    const existing = this.rows("meetings").find(
      (m) => m.classificationId === input.meeting.classificationId,
    );
    if (existing) {
      return { ok: false, error: toError("CONFLICT", "this response already has a meeting") };
    }

    const createdAt = toDateTime(now());
    const meeting: Meeting = {
      id: newId(),
      workspaceId: input.workspaceId,
      accountId: input.meeting.accountId,
      contactId: input.meeting.contactId,
      classificationId: input.meeting.classificationId,
      inboundMessageId: input.meeting.inboundMessageId,
      outboundActionId: input.meeting.outboundActionId,
      qualificationId: input.meeting.qualificationId,
      state: input.meeting.state,
      recommendationReason: input.meeting.recommendationReason,
      policyVersion: input.meeting.policyVersion,
      bookingDigest: input.meeting.bookingDigest,
      title: input.meeting.title,
      startsAt: input.meeting.startsAt,
      endsAt: input.meeting.endsAt,
      timezone: input.meeting.timezone,
      durationMinutes: input.meeting.durationMinutes,
      channel: input.meeting.channel,
      externalEventId: input.meeting.externalEventId ?? null,
      suppressionCheckedAt: input.meeting.suppressionCheckedAt ?? null,
      approvedBy: input.meeting.approvedBy ?? null,
      approvedAt: input.meeting.approvedAt ?? null,
      bookedAt: input.meeting.bookedAt ?? null,
      cancelledAt: input.meeting.cancelledAt ?? null,
      decisionReason: input.meeting.decisionReason ?? null,
      createdBy: input.createdBy,
      createdAt,
      updatedAt: createdAt,
    };
    this.mutate("meetings", (rows) => rows.push(meeting));
    return { ok: true, value: meeting };
  }

  /** Resolve one meeting for reading, authorized against its tenant. */
  private requireMeeting(id: EntityId, userId: EntityId): Result<Meeting, StorageError> {
    const meeting = this.findById("meetings", id);
    if (!meeting) return { ok: false, error: toError("NOT_FOUND", "meeting not found") };
    const auth = this.requireWorkspace(meeting.workspaceId, userId);
    // Reported as not found rather than unauthorized, so a foreign id is
    // indistinguishable from one that was never issued.
    if (!auth.ok) return { ok: false, error: toError("NOT_FOUND", "meeting not found") };
    return { ok: true, value: meeting };
  }

  getMeeting(id: EntityId, userId: EntityId): Result<Meeting, StorageError> {
    return this.requireMeeting(id, userId);
  }

  /** A workspace's meetings, newest first, optionally narrowed. */
  listMeetings(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { state?: MeetingBookingState; accountId?: EntityId; contactId?: EntityId },
  ): Result<Meeting[], StorageError> {
    const auth = this.requireWorkspace(workspaceId, userId);
    if (!auth.ok) return auth;
    const filtered = this.rows("meetings").filter(
      (m) =>
        m.workspaceId === workspaceId &&
        (filter?.state === undefined || m.state === filter.state) &&
        (filter?.accountId === undefined || m.accountId === filter.accountId) &&
        (filter?.contactId === undefined || m.contactId === filter.contactId),
    );
    return {
      ok: true,
      value: [...filtered].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    };
  }

  /**
   * Move one meeting to a new booking state.
   *
   * Two invariants are enforced here that no caller should be trusted to hold:
   *
   * - **A booking is never un-booked into an approved state.** Re-deriving the
   *   approval at decision time is the service's job, but storage refuses the
   *   transition that would matter most — going back to `approved` after
   *   `booked` — so a replayed or reordered call cannot resurrect a booking.
   * - **A cancelled meeting keeps its cancellation instant**, and a state that
   *   claims an approval or a provider reference must carry the matching
   *   timestamp. These are the same CHECKs the schema declares, re-checked at
   *   the point of writing, because a document store does not enforce its own
   *   declared DDL.
   */
  updateMeetingState(input: {
    meetingId: EntityId;
    actorUserId: EntityId;
    state: MeetingBookingState;
    approvedBy?: EntityId | null;
    approvedAt?: DateTime | null;
    bookedAt?: DateTime | null;
    cancelledAt?: DateTime | null;
    externalEventId?: string | null;
    suppressionCheckedAt?: DateTime | null;
    decisionReason?: string | null;
  }): Result<Meeting, StorageError> {
    const current = this.requireMeeting(input.meetingId, input.actorUserId);
    if (!current.ok) return current;

    const next = input.state;
    if (next === "approved" && current.value.state === "booked") {
      return {
        ok: false,
        error: toError("CONFLICT", "a booked meeting cannot return to approved"),
      };
    }
    const approvedBy = input.approvedBy === undefined ? current.value.approvedBy : input.approvedBy;
    const approvedAt = input.approvedAt === undefined ? current.value.approvedAt : input.approvedAt;
    const bookedAt = input.bookedAt === undefined ? current.value.bookedAt : input.bookedAt;
    const cancelledAt =
      input.cancelledAt === undefined ? current.value.cancelledAt : input.cancelledAt;
    const externalEventId =
      input.externalEventId === undefined ? current.value.externalEventId : input.externalEventId;
    const suppressionCheckedAt =
      input.suppressionCheckedAt === undefined
        ? current.value.suppressionCheckedAt
        : input.suppressionCheckedAt;
    const decisionReason =
      input.decisionReason === undefined ? current.value.decisionReason : input.decisionReason;

    // Mirrors the schema CHECKs: a state that claims an approval, a booking or a
    // provider reference must carry the matching evidence, and a cancellation
    // must say when and why.
    if (next !== "cancelled" && cancelledAt !== null) {
      return {
        ok: false,
        error: toError("INVALID", "only a cancelled meeting may carry a cancellation instant"),
      };
    }
    if (next === "cancelled" && cancelledAt === null) {
      return {
        ok: false,
        error: toError("INVALID", "a cancellation must record when it happened"),
      };
    }
    if (next === "cancelled" && decisionReason === null) {
      return {
        ok: false,
        error: toError("INVALID", "a cancellation must say why"),
      };
    }
    const approving = next === "approved";
    const booked = next === "booked" || next === "held" || next === "no_show";
    if (approving && (approvedBy === null || approvedAt === null)) {
      return {
        ok: false,
        error: toError("INVALID", "an approval must record who decided and when"),
      };
    }
    if (booked && bookedAt === null) {
      return {
        ok: false,
        error: toError("INVALID", "a booked meeting must record when it was booked"),
      };
    }
    // A booked, held or missed meeting is a meeting somebody authorized, so the
    // approval has to already exist on the row. This is the storage-level half of
    // "no calendar event without a person behind it".
    if (booked && current.value.approvedAt === null) {
      return {
        ok: false,
        error: toError("INVALID", "a meeting cannot be booked without an approval"),
      };
    }

    const updated: Meeting = {
      ...current.value,
      state: next,
      approvedBy,
      approvedAt,
      bookedAt,
      cancelledAt,
      externalEventId,
      suppressionCheckedAt,
      decisionReason,
      updatedAt: toDateTime(now()),
    };
    this.mutate("meetings", (rows) => {
      const index = (rows as Meeting[]).findIndex((m) => m.id === input.meetingId);
      if (index >= 0) rows[index] = updated;
    });
    return { ok: true, value: updated };
  }

  /**
   * Persist one meeting brief.
   *
   * Versioned rather than replaced: a person may have read the brief before the
   * meeting, and rewriting it in place would leave them acting on text that no
   * longer exists. Regenerating inserts the next version.
   */
  createMeetingBrief(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    brief: {
      meetingId: EntityId;
      rendererVersion: string;
      accountId: EntityId;
      contactId: EntityId;
      qualificationId: EntityId;
      qualificationScore: number | null;
      classificationId: EntityId;
      intent: MeetingBrief["intent"];
      claimIds: EntityId[];
      evidenceIds: EntityId[];
      conversationExcerpt: string;
      gaps: string[];
    };
  }): Result<MeetingBrief, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.createdBy);
    if (!auth.ok) return auth;

    const meeting = this.findById("meetings", input.brief.meetingId);
    if (!meeting || meeting.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "meeting not found") };
    }
    // The next version in the meeting's lineage. A brief is never rewritten.
    const latest = this.rows("meetingBriefs")
      .filter((b) => b.meetingId === input.brief.meetingId)
      .reduce((max, b) => (b.version > max ? b.version : max), 0);

    const brief: MeetingBrief = {
      id: newId(),
      workspaceId: input.workspaceId,
      meetingId: input.brief.meetingId,
      version: latest + 1,
      rendererVersion: input.brief.rendererVersion,
      accountId: input.brief.accountId,
      contactId: input.brief.contactId,
      qualificationId: input.brief.qualificationId,
      qualificationScore: input.brief.qualificationScore,
      classificationId: input.brief.classificationId,
      intent: input.brief.intent,
      claimIds: input.brief.claimIds,
      evidenceIds: input.brief.evidenceIds,
      conversationExcerpt: input.brief.conversationExcerpt,
      gaps: input.brief.gaps,
      createdBy: input.createdBy,
      createdAt: toDateTime(now()),
    };
    this.mutate("meetingBriefs", (rows) => rows.push(brief));
    return { ok: true, value: brief };
  }

  getMeetingBrief(id: EntityId, userId: EntityId): Result<MeetingBrief, StorageError> {
    const brief = this.findById("meetingBriefs", id);
    if (!brief) return { ok: false, error: toError("NOT_FOUND", "meeting brief not found") };
    const auth = this.requireWorkspace(brief.workspaceId, userId);
    if (!auth.ok) return { ok: false, error: toError("NOT_FOUND", "meeting brief not found") };
    return { ok: true, value: brief };
  }

  /** One meeting's briefs, newest first. */
  listMeetingBriefs(meetingId: EntityId, userId: EntityId): Result<MeetingBrief[], StorageError> {
    const meeting = this.requireMeeting(meetingId, userId);
    if (!meeting.ok) return meeting;
    const briefs = this.rows("meetingBriefs").filter((b) => b.meetingId === meetingId);
    return {
      ok: true,
      value: [...briefs].sort((a, b) => (a.version > b.version ? -1 : 1)),
    };
  }

  /** One append-only audit row for a meeting. */
  createMeetingEvent(input: {
    workspaceId: EntityId;
    actorUserId: EntityId;
    event: {
      meetingId: EntityId;
      kind: MeetingEventKind;
      detail: string | null;
    };
  }): Result<MeetingEvent, StorageError> {
    const auth = this.requireWorkspace(input.workspaceId, input.actorUserId);
    if (!auth.ok) return auth;
    const meeting = this.findById("meetings", input.event.meetingId);
    if (!meeting || meeting.workspaceId !== input.workspaceId) {
      return { ok: false, error: toError("NOT_FOUND", "meeting not found") };
    }
    const event: MeetingEvent = {
      id: newId(),
      meetingId: input.event.meetingId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      kind: input.event.kind,
      detail: input.event.detail,
      createdAt: toDateTime(now()),
    };
    this.mutate("meetingEvents", (rows) => rows.push(event));
    return { ok: true, value: event };
  }

  /** One meeting's audit trail, oldest first. */
  listMeetingEvents(meetingId: EntityId, userId: EntityId): Result<MeetingEvent[], StorageError> {
    const meeting = this.requireMeeting(meetingId, userId);
    if (!meeting.ok) return meeting;
    const events = this.rows("meetingEvents").filter((e) => e.meetingId === meetingId);
    return {
      ok: true,
      value: events
        .map((row, index) => ({ row, index }))
        .sort((a, b) =>
          a.row.createdAt !== b.row.createdAt
            ? a.row.createdAt < b.row.createdAt
              ? -1
              : 1
            : a.index - b.index,
        )
        .map((entry) => entry.row),
    };
  }
}

/** Default single-process store for local runs. */
export const store = new Store();
export const db = {
  createUser: store.createUser.bind(store),
  getUser: store.getUser.bind(store),
  getUserByEmail: store.getUserByEmail.bind(store),
  listUsers: store.listUsers.bind(store),
  updatePasswordHash: store.updatePasswordHash.bind(store),
  getWorkspaces: store.getWorkspaces.bind(store),
  createWorkspace: store.createWorkspace.bind(store),
  getWorkspace: store.getWorkspace.bind(store),
  updateWorkspace: store.updateWorkspace.bind(store),
  getBusinessProfile: store.getBusinessProfile.bind(store),
  getBusinessProfileFor: store.getBusinessProfileFor.bind(store),
  createBusinessProfile: store.createBusinessProfile.bind(store),
  updateBusinessProfile: store.updateBusinessProfile.bind(store),
  deleteBusinessProfile: store.deleteBusinessProfile.bind(store),
  createOffer: store.createOffer.bind(store),
  listOffers: store.listOffers.bind(store),
  getOffer: store.getOffer.bind(store),
  updateOffer: store.updateOffer.bind(store),
  deleteOffer: store.deleteOffer.bind(store),
  upsertIcp: store.upsertIcp.bind(store),
  getIcp: store.getIcp.bind(store),
  createPersona: store.createPersona.bind(store),
  listPersonas: store.listPersonas.bind(store),
  getPersona: store.getPersona.bind(store),
  updatePersona: store.updatePersona.bind(store),
  deletePersona: store.deletePersona.bind(store),
  upsertPositioning: store.upsertPositioning.bind(store),
  getPositioning: store.getPositioning.bind(store),
  upsertBrandVoice: store.upsertBrandVoice.bind(store),
  getBrandVoice: store.getBrandVoice.bind(store),
  createClaim: store.createClaim.bind(store),
  listClaims: store.listClaims.bind(store),
  listApprovedClaims: store.listApprovedClaims.bind(store),
  getClaim: store.getClaim.bind(store),
  updateClaim: store.updateClaim.bind(store),
  approveClaim: store.approveClaim.bind(store),
  deleteClaim: store.deleteClaim.bind(store),
  createRevenueGoal: store.createRevenueGoal.bind(store),
  listRevenueGoals: store.listRevenueGoals.bind(store),
  getRevenueGoal: store.getRevenueGoal.bind(store),
  updateRevenueGoal: store.updateRevenueGoal.bind(store),
  setRevenueGoalStatus: store.setRevenueGoalStatus.bind(store),
  listRevenueGoalEvents: store.listRevenueGoalEvents.bind(store),

  nextRevenuePlanVersion: store.nextRevenuePlanVersion.bind(store),
  createRevenuePlan: store.createRevenuePlan.bind(store),
  listRevenuePlans: store.listRevenuePlans.bind(store),
  getRevenuePlan: store.getRevenuePlan.bind(store),
  listRevenuePlansForGoal: store.listRevenuePlansForGoal.bind(store),
  updateRevenuePlan: store.updateRevenuePlan.bind(store),
  setRevenuePlanStatus: store.setRevenuePlanStatus.bind(store),

  createAccount: store.createAccount.bind(store),
  listAccounts: store.listAccounts.bind(store),
  getAccount: store.getAccount.bind(store),
  updateAccount: store.updateAccount.bind(store),
  archiveAccount: store.archiveAccount.bind(store),
  findAccountByDomain: store.findAccountByDomain.bind(store),
  findAccountByName: store.findAccountByName.bind(store),

  createContact: store.createContact.bind(store),
  listContacts: store.listContacts.bind(store),
  getContact: store.getContact.bind(store),
  updateContact: store.updateContact.bind(store),
  archiveContact: store.archiveContact.bind(store),
  findContactByEmail: store.findContactByEmail.bind(store),

  createResearchRequest: store.createResearchRequest.bind(store),
  getResearchRequest: store.getResearchRequest.bind(store),
  listResearchRequests: store.listResearchRequests.bind(store),
  findActiveResearchRequest: store.findActiveResearchRequest.bind(store),
  findResearchRequestByIdempotencyKey: store.findResearchRequestByIdempotencyKey.bind(store),
  updateResearchRequest: store.updateResearchRequest.bind(store),
  createResearchFinding: store.createResearchFinding.bind(store),
  getResearchFinding: store.getResearchFinding.bind(store),
  listResearchFindings: store.listResearchFindings.bind(store),
  countResearchFindings: store.countResearchFindings.bind(store),

  createAccountClaim: store.createAccountClaim.bind(store),
  getAccountClaim: store.getAccountClaim.bind(store),
  findAccountClaimByField: store.findAccountClaimByField.bind(store),
  listAccountClaims: store.listAccountClaims.bind(store),
  updateAccountClaim: store.updateAccountClaim.bind(store),
  createEvidence: store.createEvidence.bind(store),
  getEvidence: store.getEvidence.bind(store),
  listEvidence: store.listEvidence.bind(store),
  updateEvidence: store.updateEvidence.bind(store),
  nextQualificationVersion: store.nextQualificationVersion.bind(store),
  createQualification: store.createQualification.bind(store),
  getQualification: store.getQualification.bind(store),
  listQualifications: store.listQualifications.bind(store),

  nextDraftVersion: store.nextDraftVersion.bind(store),
  createDraft: store.createDraft.bind(store),
  getDraft: store.getDraft.bind(store),
  listDrafts: store.listDrafts.bind(store),

  createApprovalRequest: store.createApprovalRequest.bind(store),
  createApprovalRequestEvent: store.createApprovalRequestEvent.bind(store),
  decideApproval: store.decideApproval.bind(store),
  closeApproval: store.closeApproval.bind(store),
  getApprovalRequest: store.getApprovalRequest.bind(store),
  listApprovalRequests: store.listApprovalRequests.bind(store),
  listApprovalRequestEvents: store.listApprovalRequestEvents.bind(store),
  createOutboundAction: store.createOutboundAction.bind(store),
  recordOutboundAttempt: store.recordOutboundAttempt.bind(store),
  confirmOutboundSent: store.confirmOutboundSent.bind(store),
  recordOutboundFailure: store.recordOutboundFailure.bind(store),
  cancelOutboundAction: store.cancelOutboundAction.bind(store),
  createOutboundEvent: store.createOutboundEvent.bind(store),
  getOutboundAction: store.getOutboundAction.bind(store),
  listOutboundActions: store.listOutboundActions.bind(store),
  findOutboundActionByApproval: store.findOutboundActionByApproval.bind(store),
  listOutboundEvents: store.listOutboundEvents.bind(store),
  createOutboundSuppression: store.createOutboundSuppression.bind(store),
  isSuppressed: store.isSuppressed.bind(store),
  listOutboundSuppressions: store.listOutboundSuppressions.bind(store),

  createInboundMessage: store.createInboundMessage.bind(store),
  getInboundMessage: store.getInboundMessage.bind(store),
  listInboundMessages: store.listInboundMessages.bind(store),
  createConversationClassification: store.createConversationClassification.bind(store),
  getConversationClassification: store.getConversationClassification.bind(store),
  listConversationClassifications: store.listConversationClassifications.bind(store),
  findConversationClassificationByMessage:
    store.findConversationClassificationByMessage.bind(store),
  createConversationEvent: store.createConversationEvent.bind(store),
  listConversationEvents: store.listConversationEvents.bind(store),

  createMeeting: store.createMeeting.bind(store),
  getMeeting: store.getMeeting.bind(store),
  listMeetings: store.listMeetings.bind(store),
  updateMeetingState: store.updateMeetingState.bind(store),
  createMeetingBrief: store.createMeetingBrief.bind(store),
  getMeetingBrief: store.getMeetingBrief.bind(store),
  listMeetingBriefs: store.listMeetingBriefs.bind(store),
  createMeetingEvent: store.createMeetingEvent.bind(store),
  listMeetingEvents: store.listMeetingEvents.bind(store),

  authorize: store.authorize.bind(store),
  resolveWorkspace: store.resolveWorkspace.bind(store),
  workspaceOwner: store.workspaceOwner.bind(store),
  isWorkspaceOwner: store.isWorkspaceOwner.bind(store),
  workspaceIsMember: store.workspaceIsMember.bind(store),
  destroy: store.destroy.bind(store),
};
