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
  User,
  Workspace,
  WorkspaceMember,
} from "./types.js";
import { toDateTime } from "./types.js";
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
export const LATEST_SCHEMA_VERSION = 3;

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

  /** Cleanup helper so tests and local runs do not leave files behind. */
  destroy(): void {
    try {
      rmSync(DB_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
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
  authorize: store.authorize.bind(store),
  resolveWorkspace: store.resolveWorkspace.bind(store),
  workspaceOwner: store.workspaceOwner.bind(store),
  isWorkspaceOwner: store.isWorkspaceOwner.bind(store),
  workspaceIsMember: store.workspaceIsMember.bind(store),
  destroy: store.destroy.bind(store),
};
