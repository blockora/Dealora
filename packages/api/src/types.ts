import type { Result } from "@dealora/core";
import type { User, Workspace, BusinessProfile } from "@dealora/db";

/** Structured error exposed to API callers. */
export type ApiError =
  | { code: "UNAUTHENTICATED"; message: string }
  | { code: "UNAUTHORIZED"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "VALIDATION_ERROR"; message: string; details?: unknown[] }
  | { code: "CONFLICT"; message: string }
  | { code: "SERVER_ERROR"; message: string };

export type ApiSuccess<T> = { status: "ok"; data: T };

/** Response envelope for every JSON endpoint. */
export type ApiResponse<T> = ApiSuccess<T> | { status: "error"; error: ApiError };

export interface Pagination {
  cursor?: string;
  limit?: number;
}

/** Raw JSON body consumed by the handlers. */
export interface RequestBody {
  readonly body: unknown;
  readonly query: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
}

/** Handler shape. Returns a Result so handlers stay uniform. */
export type ApiHandler<T = unknown> = (
  req: RequestBody,
) => Promise<Result<ApiResponse<T>, ApiError>>;

/** Injection point for the DB store (enables pure tests). */
export interface DbStore {
  createUser: (input: {
    email: string;
    password: string;
    displayName: string;
  }) => Promise<Result<User, unknown>>;
  getUserByEmail: (email: string) => Promise<Result<User | null, unknown>>;
  getWorkspaces: (userId: string) => Promise<Result<Workspace[], unknown>>;
  createWorkspace: (input: {
    ownerId: string;
    name: string;
    timezone?: string;
  }) => Promise<Result<Workspace, unknown>>;
  getWorkspace: (id: string) => Promise<Result<Workspace, unknown>>;
  updateWorkspace: (
    id: string,
    input: { name?: string; timezone?: string },
  ) => Promise<Result<Workspace, unknown>>;
  authorize: (workspaceId: string, userId: string) => Promise<Result<Workspace, unknown>>;
  getBusinessProfile: (workspaceId: string) => Promise<Result<BusinessProfile | null, unknown>>;
  createBusinessProfile: (input: {
    workspaceId: string;
    ownerId: string;
    name: string;
    description: string;
    website?: string | null;
    type?: string | null;
    offer?: string | null;
    industry?: string | null;
    size?: string | null;
  }) => Promise<Result<BusinessProfile, unknown>>;
  updateBusinessProfile: (
    id: string,
    input: {
      workspaceId: string;
      name?: string;
      description?: string;
      website?: string | null;
      type?: string | null;
      offer?: string | null;
      industry?: string | null;
      size?: string | null;
    },
  ) => Promise<Result<BusinessProfile, unknown>>;
  destroy: () => void;
}
