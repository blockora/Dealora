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

import type {
  ApiError,
  ApiHandler,
  ApiResponse,
  AuthenticatedActor,
  IdentityService,
  RequestBody,
  SessionResolver,
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
