import type {
  BrandVoice,
  BusinessProfile,
  Claim,
  Icp,
  Offer,
  Persona,
  Positioning,
} from "@dealora/db";
import type { BrainError, BusinessBrainService } from "@dealora/brain";
import { GOAL_STATUSES } from "@dealora/goal";
import type { GoalError, RevenueGoalService } from "@dealora/goal";
import { PLAN_STATUSES } from "@dealora/plan";
import type { PlanBrainReader, PlanError, RevenuePlanService } from "@dealora/plan";
import type { RevenueGoalStatus as GoalStatus } from "@dealora/db";
import type { RevenuePlanStatus as PlanStatus } from "@dealora/db";

import type {
  ApiError,
  ApiErrorCode,
  ApiHandler,
  ApiResponse,
  AuthenticatedActor,
  BrainContextReader,
  IdentityService,
  RequestBody,
  SessionResolver,
  WorkspaceBrainContext,
} from "./types.js";
import type { Result } from "@dealora/core";

/**
 * Transport layer.
 *
 * Handlers do four things and nothing else:
 *   1. parse the request body,
 *   2. resolve the authenticated actor from the session token,
 *   3. call an application service,
 *   4. translate the result into an `ApiResponse`.
 *
 * Authorization is always performed inside the application service against the
 * server-side identity, so a handler can never grant access a client asked
 * for (ADR 0003).
 */

/** Translate a service/identity error code into the safe API vocabulary. */
function toApiError(code: string, message: string): ApiError {
  switch (code) {
    case "UNAUTHENTICATED":
      return { code: "UNAUTHENTICATED", message: "authentication required" };
    case "UNAUTHORIZED":
      return { code: "UNAUTHORIZED", message: "workspace access denied" };
    case "NOT_FOUND":
      return { code: "NOT_FOUND", message };
    case "VALIDATION_ERROR":
      return { code: "VALIDATION_ERROR", message };
    case "CONFLICT":
      return { code: "CONFLICT", message };
    default:
      // Never surface an internal storage message.
      return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
}

/** Translate a domain `BrainError` into the safe API error envelope. */
function fromBrainError(error: BrainError): ApiError {
  // `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const mapped: ApiError = { code: error.code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `GoalError` into the safe API error envelope.
 *
 * `INVALID_TRANSITION` surfaces as a CONFLICT because the caller's request
 * conflicts with the goal's current state; `UNAVAILABLE` is never exposed.
 */
function fromGoalError(error: GoalError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const code: ApiErrorCode =
    error.code === "INVALID_TRANSITION" ? "CONFLICT" : (error.code as ApiErrorCode);
  const mapped: ApiError = { code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `PlanError` into the safe API error envelope.
 *
 * Same contract as {@link fromGoalError}: an illegal transition is a CONFLICT
 * and an internal condition is never surfaced verbatim.
 */
function fromPlanError(error: PlanError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const code: ApiErrorCode =
    error.code === "INVALID_TRANSITION" ? "CONFLICT" : (error.code as ApiErrorCode);
  const mapped: ApiError = { code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/** Parse a JSON body, tolerating already-parsed objects. */
async function parseBody(req: RequestBody): Promise<Record<string, unknown> | ApiError> {
  const raw = req.body;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return { code: "VALIDATION_ERROR", message: "invalid JSON body" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { code: "VALIDATION_ERROR", message: "invalid JSON body" };
    }
    return parsed as Record<string, unknown>;
  } catch {
    return { code: "VALIDATION_ERROR", message: "invalid JSON body" };
  }
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

export interface HandlerDeps {
  identity: IdentityService;
  brain: BusinessBrainService;
  goal: RevenueGoalService;
  brainContext: BrainContextReader;
  plan: RevenuePlanService;
  planContext: PlanBrainReader;
  resolveSession: SessionResolver;
}

/**
 * Resolve the authenticated actor from the bearer token.
 *
 * The user id always comes from the session. A `workspaceId` in the body or
 * query is never treated as proof of access — the application service
 * re-authorizes every call against this identity.
 */
function actorFrom(req: RequestBody, deps: HandlerDeps): AuthenticatedActor | null {
  const token = req.query.sessionToken;
  if (typeof token !== "string" || token === "") return null;
  return deps.resolveSession(token);
}

function ok<T>(data: T): ApiResponse<T> {
  return { status: "ok", data };
}

/** Wrap a handler body that requires an authenticated actor. */
function authenticated<T>(
  req: RequestBody,
  deps: HandlerDeps,
  run: (actor: AuthenticatedActor) => Promise<Result<ApiResponse<T>, ApiError>>,
): Promise<Result<ApiResponse<T>, ApiError>> {
  const actor = actorFrom(req, deps);
  if (!actor) {
    return Promise.resolve({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }
  return run(actor).catch((err: unknown) => ({
    ok: false,
    error: toApiError(
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "SERVER_ERROR",
      "unexpected failure",
    ),
  }));
}

/** Read a required route parameter. */
function param(req: RequestBody, name: string): string | ApiError {
  const value = req.params[name];
  if (typeof value !== "string" || value.trim() === "") {
    return { code: "VALIDATION_ERROR", message: `${name} is required` };
  }
  return value;
}

// ---------------------------------------------------------------------------
// Phase 1 — identity and workspaces
// ---------------------------------------------------------------------------

export function createHandlers(deps: HandlerDeps) {
  const signupHandler: ApiHandler = async (req) => {
    const body = await parseBody(req);
    if (isApiError(body)) return { ok: false, error: body };

    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName : "";
    if (!email || !password || !displayName) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "email, password and displayName are required",
        },
      };
    }
    try {
      const created = deps.identity.signup(email, password, displayName);
      return { ok: true, value: ok({ user: publicUser(created.user), token: created.token }) };
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "SERVER_ERROR";
      return { ok: false, error: toApiError(code, "signup failed") };
    }
  };

  const authenticateHandler: ApiHandler = async (req) => {
    const body = await parseBody(req);
    if (isApiError(body)) return { ok: false, error: body };

    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return {
        ok: false,
        error: { code: "VALIDATION_ERROR", message: "email and password are required" },
      };
    }
    try {
      const found = deps.identity.authenticate(email, password);
      return { ok: true, value: ok({ user: publicUser(found.user), token: found.token }) };
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "SERVER_ERROR";
      return { ok: false, error: toApiError(code, "invalid credentials") };
    }
  };

  const listWorkspacesHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const result = deps.identity.listWorkspaces(actor.userId);
      if (!result.ok) {
        return Promise.resolve({
          ok: false,
          error: toApiError(result.error.code, "workspaces unavailable"),
        });
      }
      return Promise.resolve({ ok: true, value: ok({ workspaces: result.value }) });
    });

  const getWorkspaceHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.identity.getWorkspace(id, actor.userId);
      if (!result.ok) {
        return Promise.resolve({
          ok: false,
          error: toApiError(result.error.code, "workspace not found"),
        });
      }
      return Promise.resolve({ ok: true, value: ok({ workspace: result.value }) });
    });

  const updateWorkspaceHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const input: { name?: string; timezone?: string } = {};
      if (typeof body.name === "string" && body.name.trim() !== "") input.name = body.name.trim();
      if (typeof body.timezone === "string" && body.timezone.trim() !== "")
        input.timezone = body.timezone.trim();

      const result = deps.identity.updateWorkspace(id, actor.userId, input);
      if (!result.ok) {
        return { ok: false, error: toApiError(result.error.code, "workspace not found") };
      }
      return { ok: true, value: ok({ workspace: result.value }) };
    });

  const meHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const result = deps.identity.getUser(actor.userId);
      if (!result.ok) {
        return Promise.resolve({
          ok: false,
          error: toApiError(result.error.code, "user not found"),
        });
      }
      return Promise.resolve({ ok: true, value: ok({ user: publicUser(result.value) }) });
    });

  // -------------------------------------------------------------------------
  // Phase 2 — Business Brain
  //
  // The workspace id always comes from the route; the acting user always comes
  // from the session. The service authorizes that pair server-side, so a
  // handler never decides access itself.
  // -------------------------------------------------------------------------

  /** Company section (Phase 1 business profile, canonical for the Brain). */
  const getCompanyHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getCompany(workspaceId, actor.userId);
      if (!result.ok) {
        return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      }
      return Promise.resolve({ ok: true, value: ok({ company: result.value }) });
    });

  const upsertCompanyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.upsertCompany(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ company: result.value }) };
    });

  const createOfferHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.createOffer(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ offer: result.value }) };
    });

  const listOffersHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.listOffers(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ offers: result.value }) });
    });

  const updateOfferHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = deps.brain.updateOffer(id, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ offer: result.value }) };
    });

  const deleteOfferHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.brain.deleteOffer(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ deleted: true }) });
    });

  const upsertIcpHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.upsertIcp(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ icp: result.value }) };
    });

  const getIcpHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getIcp(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ icp: result.value }) });
    });

  const createPersonaHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.createPersona(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ persona: result.value }) };
    });

  const listPersonasHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.listPersonas(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ personas: result.value }) });
    });

  const upsertPositioningHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.upsertPositioning(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ positioning: result.value }) };
    });

  const getPositioningHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getPositioning(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ positioning: result.value }) });
    });

  const upsertBrandVoiceHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.upsertBrandVoice(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ brandVoice: result.value }) };
    });

  const getBrandVoiceHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getBrandVoice(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ brandVoice: result.value }) });
    });

  const createClaimHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.createClaim(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ claim: result.value }) };
    });

  const listClaimsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: "approved" | "unverified" | "restricted" | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!["approved", "unverified", "restricted"].includes(rawStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" } as ApiError,
          });
        }
        status = rawStatus as "approved" | "unverified" | "restricted";
      }
      const result = deps.brain.listClaims(
        workspaceId,
        actor.userId,
        status ? { status } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ claims: result.value }) });
    });

  const approveClaimHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.brain.approveClaim(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ claim: result.value }) });
    });

  const updateClaimHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = deps.brain.updateClaim(id, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ claim: result.value }) };
    });

  // -------------------------------------------------------------------------
  // Phase 3 — Revenue Goal Engine
  //
  // Handlers stay translation-only: the workspace id comes from the route, the
  // acting user from the session, and every rule (validation, reference
  // checking, lifecycle) is enforced by the goal service.
  // -------------------------------------------------------------------------

  /**
   * Read the canonical workspace context used for goal references.
   *
   * Authorization runs first, against the session identity, so a caller from
   * another tenant is denied with `UNAUTHORIZED` rather than being reported as
   * an internal failure when the reader refuses the read.
   */
  async function workspaceContext(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceBrainContext | ApiError> {
    const auth = deps.identity.authorize(workspaceId, userId);
    if (!auth.ok) return toApiError(auth.error.code, "workspace not found");
    try {
      return await deps.brainContext(workspaceId, userId);
    } catch {
      return { code: "SERVER_ERROR", message: "unexpected failure" };
    }
  }

  const createRevenueGoalHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const context = await workspaceContext(workspaceId, actor.userId);
      if (isApiError(context)) return { ok: false, error: context };

      const result = deps.goal.createRevenueGoal(workspaceId, actor.userId, body, context);
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ goal: result.value }) };
    });

  const listRevenueGoalsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: GoalStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!GOAL_STATUSES.includes(rawStatus as GoalStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" },
          });
        }
        status = rawStatus as GoalStatus;
      }
      const result = deps.goal.listRevenueGoals(
        workspaceId,
        actor.userId,
        status ? { status } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromGoalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ goals: result.value }) });
    });

  const getRevenueGoalHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.goal.getRevenueGoal(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromGoalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ goal: result.value }) });
    });

  const updateRevenueGoalHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const context = await workspaceContext(workspaceId, actor.userId);
      if (isApiError(context)) return { ok: false, error: context };

      // Status is never accepted through a field update: it has its own
      // transition-validated route.
      const { status: _status, ...patch } = body as Record<string, unknown> & { status?: unknown };
      void _status;

      const result = deps.goal.updateRevenueGoal(id, actor.userId, patch, context);
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ goal: result.value }) };
    });

  const changeRevenueGoalStatusHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.goal.changeRevenueGoalStatus(id, actor.userId, body.status);
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ goal: result.value }) };
    });

  const archiveRevenueGoalHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.goal.archiveRevenueGoal(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromGoalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ goal: result.value }) });
    });

  const revenueGoalHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.goal.goalHistory(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromGoalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ history: result.value }) });
    });

  /**
   * Parse a natural-language goal without persisting anything.
   *
   * The response includes the provenance of every field so a caller can see
   * what was stated, what was inferred, and what is still unknown.
   */
  const parseRevenueGoalInputHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const context = await workspaceContext(workspaceId, actor.userId);
      if (isApiError(context)) return { ok: false, error: context };

      const input = typeof body.input === "string" ? body.input : "";
      // The reference instant is injected so parsing is deterministic.
      const now = new Date();
      const result = deps.goal.parseRevenueGoalInput(input, context, now);
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ draft: result.value }) };
    });

  /** Create a goal directly from natural language. */
  const createRevenueGoalFromTextHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const context = await workspaceContext(workspaceId, actor.userId);
      if (isApiError(context)) return { ok: false, error: context };

      const input = typeof body.input === "string" ? body.input : "";
      const now = new Date();
      const result = deps.goal.createFromNaturalLanguage(
        workspaceId,
        actor.userId,
        input,
        context,
        now,
      );
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ goal: result.value }) };
    });

  // -------------------------------------------------------------------------
  // Phase 4 — Revenue Plan Compiler
  //
  // Compilation produces a proposal only. No handler here performs, schedules
  // or records an external action of any kind.
  // -------------------------------------------------------------------------

  /**
   * Compile a RevenueGoal into a new RevenuePlan version.
   *
   * The workspace is authorized here before the compiler runs, so a caller
   * from another tenant is denied rather than being allowed to compile against
   * a goal they cannot read.
   */
  const compileRevenuePlanHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const auth = deps.identity.authorize(workspaceId, actor.userId);
      if (!auth.ok) return { ok: false, error: toApiError(auth.error.code, "workspace not found") };

      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const revenueGoalId = body.revenueGoalId;

      const result = deps.plan.compileRevenuePlan(workspaceId, actor.userId, revenueGoalId);
      if (!result.ok) return { ok: false, error: fromPlanError(result.error) };
      return { ok: true, value: ok({ plan: result.value }) };
    });

  const listRevenuePlansHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: PlanStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!PLAN_STATUSES.includes(rawStatus as PlanStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" },
          });
        }
        status = rawStatus as PlanStatus;
      }
      const revenueGoalId =
        typeof req.query.revenueGoalId === "string" && req.query.revenueGoalId !== ""
          ? req.query.revenueGoalId
          : undefined;

      const result = deps.plan.listRevenuePlans(
        workspaceId,
        actor.userId,
        status ? { status } : revenueGoalId ? { revenueGoalId } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromPlanError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ plans: result.value }) });
    });

  const getRevenuePlanHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.plan.getRevenuePlan(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromPlanError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ plan: result.value }) });
    });

  /** Every version compiled from the same goal, oldest first. */
  const getRevenuePlanHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.plan.planHistory(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromPlanError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ history: result.value }) });
    });

  const changeRevenuePlanStatusHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.plan.changeRevenuePlanStatus(id, actor.userId, body.status);
      if (!result.ok) return { ok: false, error: fromPlanError(result.error) };
      return { ok: true, value: ok({ plan: result.value }) };
    });

  const archiveRevenuePlanHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.plan.archiveRevenuePlan(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromPlanError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ plan: result.value }) });
    });

  /**
   * The agent-facing Business Brain context.
   *
   * Returns the structured snapshot; pricing is included only when approved.
   */
  const getBusinessContextHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getBusinessContext(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ context: result.value }) });
    });

  return {
    signupHandler,
    authenticateHandler,
    listWorkspacesHandler,
    getWorkspaceHandler,
    updateWorkspaceHandler,
    meHandler,
    getCompanyHandler,
    upsertCompanyHandler,
    createOfferHandler,
    listOffersHandler,
    updateOfferHandler,
    deleteOfferHandler,
    upsertIcpHandler,
    getIcpHandler,
    createPersonaHandler,
    listPersonasHandler,
    upsertPositioningHandler,
    getPositioningHandler,
    upsertBrandVoiceHandler,
    getBrandVoiceHandler,
    createClaimHandler,
    listClaimsHandler,
    updateClaimHandler,
    approveClaimHandler,
    getBusinessContextHandler,
    createRevenueGoalHandler,
    listRevenueGoalsHandler,
    getRevenueGoalHandler,
    updateRevenueGoalHandler,
    changeRevenueGoalStatusHandler,
    archiveRevenueGoalHandler,
    revenueGoalHistoryHandler,
    parseRevenueGoalInputHandler,
    createRevenueGoalFromTextHandler,
    compileRevenuePlanHandler,
    listRevenuePlansHandler,
    getRevenuePlanHandler,
    getRevenuePlanHistoryHandler,
    changeRevenuePlanStatusHandler,
    archiveRevenuePlanHandler,
  };
}

/** Strip the password hash from any user leaving the API boundary. */
export function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export type { BrandVoice, BusinessProfile, Claim, Icp, Offer, Persona, Positioning };
