import { store } from "@dealora/db";
import { authenticate, signup, verifySession } from "@dealora/auth";
import { getSessionIndex, createIndex } from "@dealora/auth";
import { createBusinessBrainService } from "@dealora/brain";

import { createHandlers } from "./handlers.js";
import type { HandlerDeps } from "./handlers.js";
import type { IdentityService } from "./types.js";

/**
 * Default wiring for local/server use.
 *
 * `sessionToken` values are resolved through the auth package's session
 * index. The resulting `userId` is the only identity any handler sees, so
 * client-supplied identity fields cannot influence authorization.
 */
export function createDefaultHandlers(): ReturnType<typeof createHandlers> {
  const identity: IdentityService = {
    signup,
    authenticate,
    listWorkspaces: (userId) => store.getWorkspaces(userId),
    getWorkspace: (id, userId) => store.authorize(id, userId),
    authorize: (workspaceId, userId) => store.authorize(workspaceId, userId),
    updateWorkspace: (id, userId, input) => {
      // Authorize before mutating: ownership is re-checked server-side.
      const auth = store.authorize(id, userId);
      if (!auth.ok) return auth;
      return store.updateWorkspace(id, input);
    },
    getUser: (id) => store.getUser(id),
  };

  const deps: HandlerDeps = {
    identity,
    brain: createBusinessBrainService(),
    resolveSession: (token) => {
      try {
        const verified = verifySession(token, getSessionIndex());
        return { userId: verified.userId };
      } catch {
        return null;
      }
    },
  };

  return createHandlers(deps);
}

export { createIndex };
