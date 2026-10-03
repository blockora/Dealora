import { describe, expect, it } from "vitest";
import { Store, newId, hashPassword, toDateTime } from "@dealora/db";
import { createSession, invalidateSession, getSession } from "@dealora/auth";
import type { User, Workspace } from "@dealora/db";

function makeUser(email = "alice@example.com", displayName = "Alice"): { id: string; user: User } {
  const id = newId();
  return {
    id,
    user: {
      id,
      email,
      passwordHash: hashPassword("correct-horse-battery"),
      displayName,
      role: "owner",
      createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
      updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
    },
  };
}

function makeWorkspace(ownerId: string, name = "Acme"): { id: string; workspace: Workspace } {
  // A fresh user is their own workspace owner, so the workspace id equals
  // the owner id. This mirrors the production single-workspace-per-user
  // ownership path and lets the repo's ownership authorizer pass.
  return {
    id: ownerId,
    workspace: {
      id: ownerId,
      ownerId,
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      logoUrl: null,
      timezone: "UTC",
      settings: {},
      createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
      updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
    },
  };
}

describe("auth service", () => {
  describe("session index", () => {
    it("issues and revokes sessions", () => {
      const store = new Store({ users: [], workspaces: [], members: [], profiles: [] });
      const { id: userId } = makeUser();
      store.db.users.push({ ...makeUser().user, id: userId });
      const { id: wsId, workspace } = makeWorkspace(userId);
      store.db.workspaces.push(workspace);

      const sessions = createSession;
      const sessionIndex = { map: new Map(), userIndex: new Map() };
      const { token } = sessions(
        userId,
        wsId,
        store.db.users.find((u) => u.id === userId)!,
        sessionIndex,
        (wsId, uId) => wsId === uId,
      );

      expect(token).toBeDefined();
      expect(getSession(token, sessionIndex)).not.toBeNull();

      const invalidated = invalidateSession(token, sessionIndex);
      expect(invalidated).toBe(true);
      expect(getSession(token, sessionIndex)).toBeNull();
    });

    it("lists sessions", () => {
      const store = new Store({ users: [], workspaces: [], members: [], profiles: [] });
      const { id: userId } = makeUser();
      store.db.users.push({ ...makeUser().user, id: userId });
      const { id: wsId, workspace } = makeWorkspace(userId);
      store.db.workspaces.push(workspace);

      const sessions = createSession;
      const s1 = sessions(
        userId,
        wsId,
        store.db.users.find((u) => u.id === userId)!,
        { map: new Map(), userIndex: new Map() },
        (wsId, uId) => wsId === uId,
      );
      const s2 = sessions(
        userId,
        wsId,
        store.db.users.find((u) => u.id === userId)!,
        { map: new Map(), userIndex: new Map() },
        (wsId, uId) => wsId === uId,
      );
      expect(s1.token).toBeDefined();
      expect(s2.token).toBeDefined();
      expect(s1.token).not.toBe(s2.token);
    });
  });
});
