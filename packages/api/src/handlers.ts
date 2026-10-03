import { store } from "@dealora/db";
import { verifySession, signup, authenticate, changePassword } from "@dealora/auth";
import type { RequestBody, ApiResponse, ApiError, ApiHandler, DbStore } from "./types.js";

/**
 * Transport layer.
 *
 * Handlers contain ONLY parsing and translation. All business rules,
 * authorization, and persistence live in the application/db layers. A handler
 * never orders a decision on its own — it asks a service or the store which
 * performs authorization server-side.
 */

const app = applicationService(store);

const bodyParser: ApiHandler = async (req) => {
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
};

function stringParam(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw { code: "VALIDATION_ERROR", message: `${field} must be a non-empty string` };
  }
  return value.trim();
}

function toUserSafe(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function serializeWorkspace(ws: Workspace): Record<string, unknown> {
  return {
    id: ws.id,
    ownerId: ws.ownerId,
    name: ws.name,
    slug: ws.slug,
    logoUrl: ws.logoUrl,
    timezone: ws.timezone,
    settings: ws.settings,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
  };
}

function serializeProfile(p: BusinessProfile): Record<string, unknown> {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    ownerId: p.ownerId,
    name: p.name,
    description: p.description,
    website: p.website,
    type: p.type,
    offer: p.offer,
    industry: p.industry,
    size: p.size,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Application service that owns business logic and authorization. */
function applicationService(s: DbStore) {
  return {
    signup: (email: string, password: string, displayName: string) => {
      const result = signup(email, password, displayName);
      return result;
    },
    authenticate: (email: string, password: string) => {
      const result = authenticate(email, password);
      return result;
    },
    getWorkspaces: (userId: string) => {
      return s.getWorkspaces(userId);
    },
    createWorkspace: (ownerId: string, name: string, timezone?: string) => {
      return s.createWorkspace({ ownerId, name, timezone });
    },
    getWorkspace: (id: string) => {
      return store.getWorkspace(id);
    },
    authorize: (workspaceId: string, userId: string) => {
      return s.authorize(workspaceId, userId);
    },
    getBusinessProfile: (workspaceId: string) => {
      return s.getBusinessProfile(workspaceId);
    },
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
    }) => {
      return s.createBusinessProfile(input);
    },
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
    ) => {
      return s.updateBusinessProfile(id, input);
    },
    changePassword: (userId: string, current: string, next: string) => {
      return changePassword(userId, current, next);
    },
    me: (userId: string) => {
      return s.getUser(userId);
    },
  };
}

import type { DbStore as _DbStore } from "./types.js";

function toErrorBody(err: unknown): ApiError {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: string }).code === "string"
  ) {
    const typed = err as ApiError;
    return typed;
  }
  return { code: "SERVER_ERROR", message: "unexpected failure" };
}

function withSession<T>(
  req: RequestBody,
  resolve: (ctx: { userId: string; token: string }) => Promise<Result<T, ApiError>>,
): Promise<Result<ApiResponse<T>, ApiError>> {
  const { sessionToken } = req.query as { sessionToken?: string };
  if (!sessionToken) {
    return Promise.resolve({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }
  return verifySession(sessionToken, { map: new Map(), userIndex: new Map() })
    .then((v) => resolve({ userId: v.userId, token: sessionToken }))
    .then((r) => r.map((data) => ({ status: "ok", data })))
    .catch((err: unknown) => {
      const apiErr = toErrorBody(err);
      return { ok: false, error: apiErr };
    });
}

export const signupHandler: ApiHandler = async (req) => {
  const body = await bodyParser(req);
  if (!body.ok) return body;
  const b = body.value as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email : "";
  const password = typeof b.password === "string" ? b.password : "";
  const displayName = typeof b.displayName === "string" ? b.displayName : "";

  if (!email || !password || !displayName) {
    return {
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "email, password and displayName are required" },
    };
  }
  const result = app.signup(email, password, displayName);
  if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
  return {
    ok: true,
    value: {
      status: "ok",
      data: { user: toUserSafe(result.value.user), token: result.value.token },
    },
  };
};

export const authenticateHandler: ApiHandler = async (req) => {
  const body = await bodyParser(req);
  if (!body.ok) return body;
  const b = body.value as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email : "";
  const password = typeof b.password === "string" ? b.password : "";

  if (!email || !password) {
    return {
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "email and password are required" },
    };
  }
  const result = app.authenticate(email, password);
  if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
  return {
    ok: true,
    value: {
      status: "ok",
      data: { user: toUserSafe(result.value.user), token: result.value.token },
    },
  };
};

export const createWorkspaceHandler: ApiHandler = async (req) => {
  const body = await bodyParser(req);
  if (!body.ok) return body;
  const b = body.value as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name : "";

  if (!name) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "name is required" } };
  }

  const result = app.createWorkspace(name, typeof b.timezone === "string" ? b.timezone : undefined);
  if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
  return {
    ok: true,
    value: { status: "ok", data: { workspace: serializeWorkspace(result.value) } },
  };
};

export const getWorkspaceHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const result = app.authorize(req.params.id as string, userId);
    if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
    return { ok: true, value: { workspace: serializeWorkspace(result.value) } };
  });
};

export const updateWorkspaceHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const { name, timezone } = req.body as { name?: string; timezone?: string };
    const authResult = app.authorize(req.params.id as string, userId);
    if (!authResult.ok) return { ok: false, error: toErrorBody(authResult.error) };

    const update: { name?: string; timezone?: string } = {};
    if (typeof name === "string" && name.trim() !== "") update.name = name.trim();
    if (typeof timezone === "string") update.timezone = timezone;

    const updated = app.updateWorkspace(req.params.id as string, update);
    if (!updated.ok) return { ok: false, error: toErrorBody(updated.error) };
    return { ok: true, value: { workspace: serializeWorkspace(updated.value) } };
  });
};

export const listWorkspacesHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const result = app.getWorkspaces(userId);
    if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
    return { ok: true, value: { workspaces: result.value.map(serializeWorkspace) } };
  });
};

export const createBusinessProfileHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const body = req.body as Record<string, unknown>;

    const authResult = app.authorize(req.params.id as string, userId);
    if (!authResult.ok) return { ok: false, error: toErrorBody(authResult.error) };

    if (!body.name || !body.description) {
      return {
        ok: false,
        error: { code: "VALIDATION_ERROR", message: "name and description are required" },
      };
    }

    const name = stringParam(body.name, "name");
    const description = stringParam(body.description, "description");

    const result = app.createBusinessProfile({
      workspaceId: req.params.id as string,
      ownerId: userId,
      name,
      description,
      website: body.website ?? null,
      type: body.type ?? null,
      offer: body.offer ?? null,
      industry: body.industry ?? null,
      size: body.size ?? null,
    });
    if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
    return { ok: true, value: { profile: serializeProfile(result.value) } };
  });
};

export const getBusinessProfileHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const authResult = app.authorize(req.params.id as string, userId);
    if (!authResult.ok) return { ok: false, error: toErrorBody(authResult.error) };

    const result = app.getBusinessProfile(req.params.id as string);
    if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
    const profile = result.value;
    if (!profile)
      return { ok: false, error: { code: "NOT_FOUND", message: "business profile not found" } };
    return { ok: true, value: { profile: serializeProfile(profile) } };
  });
};

export const updateBusinessProfileHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const body = req.body as Record<string, unknown>;

    const authResult = app.authorize(req.params.id as string, userId);
    if (!authResult.ok) return { ok: false, error: toErrorBody(authResult.error) };

    const result = app.getBusinessProfile(req.params.id as string);
    if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
    const profile = result.value;
    if (!profile)
      return { ok: false, error: { code: "NOT_FOUND", message: "business profile not found" } };

    const update: {
      name?: string;
      description?: string;
      website?: string | null;
      type?: string | null;
      offer?: string | null;
      industry?: string | null;
      size?: string | null;
    } = {};
    if (typeof body.name === "string" && body.name.trim() !== "") update.name = body.name.trim();
    if (typeof body.description === "string" && body.description.trim() !== "")
      update.description = body.description.trim();
    if (body.website !== undefined) update.website = body.website ?? null;
    if (body.type !== undefined) update.type = body.type ?? null;
    if (body.offer !== undefined) update.offer = body.offer ?? null;
    if (body.industry !== undefined) update.industry = body.industry ?? null;
    if (body.size !== undefined) update.size = body.size ?? null;

    const updated = app.updateBusinessProfile(req.params.id as string, {
      workspaceId: req.params.id as string,
      ...update,
    });
    if (!updated.ok) return { ok: false, error: toErrorBody(updated.error) };
    return { ok: true, value: { profile: serializeProfile(updated.value) } };
  });
};

export const listBusinessProfilesHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const authResult = app.authorize(req.params.id as string, userId);
    if (!authResult.ok) return { ok: false, error: toErrorBody(authResult.error) };

    const result = app.getBusinessProfile(req.params.id as string);
    if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
    const profile = result.value;
    if (!profile)
      return { ok: false, error: { code: "NOT_FOUND", message: "business profile not found" } };
    return { ok: true, value: { profile: serializeProfile(profile) } };
  });
};

export const authorizeHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const result = app.authorize(req.params.id as string, userId);
    if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
    return { ok: true, value: { authorized: true, workspace: serializeWorkspace(result.value) } };
  });
};

export const meHandler: ApiHandler = async (req) => {
  return withSession(req, async ({ userId }) => {
    const result = app.me(userId);
    if (!result.ok) return { ok: false, error: toErrorBody(result.error) };
    return { ok: true, value: { user: toUserSafe(result.value) } };
  });
};
