import type { Result } from "@dealora/core";
import type { User, Workspace } from "@dealora/db";

/**
 * Structured error exposed to API callers.
 *
 * The vocabulary is closed and safe to render: internal storage messages are
 * never passed through.
 */
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "SERVER_ERROR";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export type ApiSuccess<T> = { status: "ok"; data: T };

/** Response envelope for every JSON endpoint. */
export type ApiResponse<T> = ApiSuccess<T> | { status: "error"; error: ApiError };

export interface RequestBody {
  readonly body: unknown;
  readonly query: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Handler shape.
 *
 * Handlers translate transport into an application-service call and translate
 * the result back into a response. They contain no Business Brain logic and
 * make no authorization decisions of their own (ADR 0002/0003).
 */
export type ApiHandler<T = unknown> = (
  req: RequestBody,
) => Promise<Result<ApiResponse<T>, ApiError>>;

/** The authenticated caller, resolved server-side from the session token. */
export interface AuthenticatedActor {
  userId: string;
}

/**
 * Resolves a bearer token to an actor. Injected so the API layer never reads
 * the session index directly, and so a client-supplied user id can never be
 * mistaken for an authenticated identity.
 */
export type SessionResolver = (sessionToken: string) => AuthenticatedActor | null;

/** Minimal surface the Phase 1 workspace/identity handlers need. */
export interface IdentityService {
  signup(email: string, password: string, displayName: string): { user: User; token: string };
  authenticate(email: string, password: string): { user: User; token: string };
  listWorkspaces(userId: string): Result<Workspace[], { code: string }>;
  getWorkspace(id: string, userId: string): Result<Workspace, { code: string }>;
  authorize(workspaceId: string, userId: string): Result<Workspace, { code: string }>;
  updateWorkspace(
    id: string,
    userId: string,
    input: { name?: string; timezone?: string },
  ): Result<Workspace, { code: string }>;
  getUser(id: string): Result<User, { code: string }>;
}
