import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import {
  BusinessProfile,
  Workspace,
  WorkspaceMember,
  User,
  EntityId,
  toDateTime,
  slugify,
  capString,
} from "./schema.js";
import { Result } from "@dealora/core";

export type { User, Workspace, WorkspaceMember, BusinessProfile, EntityId } from "./schema.js";
export {
  toDateTime,
  slugify,
  capString,
  userTable,
  workspaceTable,
  workspaceMembersTable,
  businessProfilesTable,
  COLUMNS,
} from "./schema.js";

export const DB_DIR = process.env.DB_DIR ?? join(import.meta.dirname ?? process.cwd(), "data");

export interface StorageError extends Error {
  code: "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE" | "INVALID";
}

export function toResult<T>(value: T): Result<T, StorageError> {
  return { ok: true, value };
}

export function toError<E extends StorageError>(code: E["code"], message: string): E {
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

function loadDb(): unknown {
  ensureDir();
  const file = join(DB_DIR, "dealora.json");
  if (!existsSync(file)) return { users: [], workspaces: [], members: [], profiles: [] };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { users: [], workspaces: [], members: [], profiles: [] };
  }
}

function persistDb(db: unknown): void {
  ensureDir();
  const file = join(DB_DIR, "dealora.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  // Atomic replace keeps a concurrent reader from seeing a half-written file.
  writeFileSync(file, readFileSync(tmp), "utf8");
}

interface DbState {
  users: User[];
  workspaces: Workspace[];
  members: WorkspaceMember[];
  profiles: BusinessProfile[];
}

/** Unique in-memory store per process, seedable for tests. */
export class Store {
  private readonly db: DbState;

  constructor(seed?: DbState) {
    if (seed) {
      this.db = seed;
    } else {
      this.db = loadDb() as DbState;
    }
  }

  private mutate<T extends keyof DbState>(table: T, mutate: (rows: DbState[T]) => void): void {
    mutate(this.db[table]);
    persistDb(this.db);
  }

  private find<T extends keyof DbState>(table: T, id: EntityId): DbState[T] {
    const rows = this.db[table] as unknown[];
    if (!Array.isArray(rows)) throw toError("UNAVAILABLE", "store corrupted");
    return rows.find((r) => (r as { id: EntityId }).id === id) as DbState[T] | undefined;
  }

  private remove<T extends keyof DbState>(table: T, id: EntityId): void {
    const rows = this.db[table] as unknown[];
    if (!Array.isArray(rows)) throw toError("UNAVAILABLE", "store corrupted");
    this.db[table] = rows.filter((r) => (r as { id: EntityId }).id !== id);
    persistDb(this.db);
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
      return { ok: false, error: toError("INVALID", "email must contain @" + input.email) };
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
    const user = this.find("users", id);
    if (!user) return { ok: false, error: toError("NOT_FOUND", "user not found") };
    return { ok: true, value: user };
  }

  getUserByEmail(email: string): Result<User | null, StorageError> {
    const rows = this.db.users as unknown[];
    if (!Array.isArray(rows))
      return { ok: false, error: toError("UNAVAILABLE", "store corrupted") };
    const found = (rows as User[]).find((u) => u.email === email);
    return { ok: true, value: found ?? null };
  }

  listUsers(): Result<User[], StorageError> {
    return { ok: true, value: [...this.db.users] };
  }

  // --- Workspaces ---

  getWorkspaces(userId: EntityId): Result<Workspace[], StorageError> {
    const rows = this.db.workspaces as unknown[];
    if (!Array.isArray(rows))
      return { ok: false, error: toError("UNAVAILABLE", "store corrupted") };
    const owned = (rows as Workspace[]).filter((w) => w.ownerId === userId);
    const memberIds = new Set(
      (this.db.members as unknown[])
        .filter(
          (m) => (m as WorkspaceMember).userId === userId && (m as WorkspaceMember).acceptedAt,
        )
        .map((m) => (m as WorkspaceMember).workspaceId),
    );
    const joined = (rows as Workspace[]).filter((w) => memberIds.has(w.id)).map((w) => w);
    return { ok: true, value: owned.length ? owned : joined.length ? joined : [] };
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
    const workspace = this.find("users", input.ownerId) as User | undefined;
    if (!workspace) {
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
    const workspace = this.find("workspaces", id);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    return { ok: true, value: workspace };
  }

  updateWorkspace(
    id: EntityId,
    input: { name?: string; timezone?: string },
  ): Result<Workspace, StorageError> {
    const workspace = this.find("workspaces", id);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    if (input.name !== undefined) {
      workspace.name = capString(input.name.trim(), 128);
    }
    if (input.timezone !== undefined) {
      workspace.timezone = input.timezone;
    }
    workspace.updatedAt = toDateTime(now());
    persistDb(this.db);
    return { ok: true, value: workspace };
  }

  // --- Memberships / authorization ---

  /**
   * Authorize a user for a workspace. Returns the workspace when the user
   * is the owner or an accepted member. Never trusts client-supplied
   * ownership assertions.
   */
  authorize(workspaceId: EntityId, userId: EntityId): Result<Workspace, StorageError> {
    const workspace = this.find("workspaces", workspaceId);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    if (workspace.ownerId !== userId) {
      const member = this.db.members.find(
        (m) =>
          (m as WorkspaceMember).workspaceId === workspaceId &&
          (m as WorkspaceMember).userId === userId &&
          (m as WorkspaceMember).acceptedAt,
      );
      if (!member) {
        return {
          ok: false,
          error: toError("UNAUTHORIZED", "user is not a member of this workspace"),
        };
      }
    }
    return { ok: true, value: workspace };
  }

  /** Resolve and authorize in one step (used by handlers after login). */
  resolveWorkspace(workspaceId: EntityId, userId: EntityId): Result<Workspace, StorageError> {
    return this.authorize(workspaceId, userId);
  }

  workspaceOwner(workspaceId: EntityId): Result<User, StorageError> {
    const workspace = this.find("workspaces", workspaceId);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    const user = this.find("users", workspace.ownerId);
    if (!user) return { ok: false, error: toError("NOT_FOUND", "owner not found") };
    return { ok: true, value: user };
  }

  isWorkspaceOwner(workspaceId: EntityId, userId: EntityId): boolean {
    const workspace = this.find("workspaces", workspaceId);
    return workspace?.ownerId === userId;
  }

  workspaceIsMember(workspaceId: EntityId, userId: EntityId): boolean {
    const member = this.db.members.find(
      (m) =>
        (m as WorkspaceMember).workspaceId === workspaceId &&
        (m as WorkspaceMember).userId === userId &&
        (m as WorkspaceMember).acceptedAt,
    );
    return Boolean(member);
  }

  // --- Business profiles ---

  getBusinessProfile(workspaceId: EntityId): Result<BusinessProfile | null, StorageError> {
    const rows = this.db.profiles as unknown[];
    if (!Array.isArray(rows))
      return { ok: false, error: toError("UNAVAILABLE", "store corrupted") };
    const profile = (rows as BusinessProfile[]).find((p) => p.workspaceId === workspaceId) ?? null;
    return { ok: true, value: profile };
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
  }): Result<BusinessProfile, StorageError> {
    const workspace = this.find("workspaces", input.workspaceId);
    if (!workspace) return { ok: false, error: toError("NOT_FOUND", "workspace not found") };
    if (workspace.ownerId !== input.ownerId) {
      return { ok: false, error: toError("UNAUTHORIZED", "owner must own the workspace") };
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
    },
  ): Result<BusinessProfile, StorageError> {
    const profile = this.find("profiles", id);
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
    profile.updatedAt = toDateTime(now());
    persistDb(this.db);
    return { ok: true, value: profile };
  }

  deleteBusinessProfile(id: EntityId): Result<void, StorageError> {
    const profile = this.find("profiles", id);
    if (!profile) return { ok: false, error: toError("NOT_FOUND", "business profile not found") };
    this.remove("profiles", id);
    return { ok: true, value: undefined };
  }

  // --- Cleanup at process exit (so tests don't leave files behind) ---

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
  getWorkspaces: store.getWorkspaces.bind(store),
  createWorkspace: store.createWorkspace.bind(store),
  getWorkspace: store.getWorkspace.bind(store),
  updateWorkspace: store.updateWorkspace.bind(store),
  getBusinessProfile: store.getBusinessProfile.bind(store),
  createBusinessProfile: store.createBusinessProfile.bind(store),
  updateBusinessProfile: store.updateBusinessProfile.bind(store),
  deleteBusinessProfile: store.deleteBusinessProfile.bind(store),
  authorize: store.authorize.bind(store),
  resolveWorkspace: store.resolveWorkspace.bind(store),
  workspaceOwner: store.workspaceOwner.bind(store),
  isWorkspaceOwner: store.isWorkspaceOwner.bind(store),
  workspaceIsMember: store.workspaceIsMember.bind(store),
  destroy: store.destroy.bind(store),
};
