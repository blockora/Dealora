import { describe, expect, it } from "vitest";
import { Store, newId, hashPassword, toDateTime } from "@dealora/db";
import type { User, Workspace, BusinessProfile } from "@dealora/db";
import { createSession } from "@dealora/auth";

function freshStore(): {
  store: Store;
  userId: string;
  user: User;
  workspace: Workspace;
  profile: BusinessProfile;
} {
  const store = new Store({ users: [], workspaces: [], members: [], profiles: [] });

  // Minimal seed so the "reload" steps have something to retrieve.
  const user: User = {
    id: newId(),
    email: `user-${Date.now()}@example.com`,
    passwordHash: hashPassword("correct-horse-battery"),
    displayName: "Alice",
    role: "owner",
    createdAt: toDateTime(new Date()),
    updatedAt: toDateTime(new Date()),
  };
  store.db.users.push(user);

  const workspace: Workspace = {
    id: newId(),
    ownerId: user.id,
    name: "Acme Corp",
    slug: "acme-corp",
    logoUrl: null,
    timezone: "UTC",
    settings: {},
    createdAt: toDateTime(new Date()),
    updatedAt: toDateTime(new Date()),
  };
  store.db.workspaces.push(workspace);

  return { store, userId: user.id, user, workspace, profile: null as unknown as BusinessProfile };
}

function makeSession(
  store: Store,
  userId: string,
  workspaceId: string,
): ReturnType<typeof createSession>["session"] {
  const { token, session } = createSession(
    userId,
    workspaceId,
    store.db.users.find((u) => u.id === userId)!,
    { map: new Map(), userIndex: new Map() },
    store.authorize.bind(store),
  );
  expect(token).toBeDefined();
  return session;
}

describe("Phase 1 gate", () => {
  it("rejects unauthenticated workspace access", () => {
    const { store, userId, workspace } = freshStore();
    const authorized = store.authorize(workspace.id, userId);
    expect(authorized.ok).toBe(true);

    // An unauthenticated caller (phantom user id) cannot be authorized.
    const anonymous = store.authorize(workspace.id, "00000000-0000-0000-0000-000000000000");
    expect(anonymous.ok).toBe(false);
    expect((anonymous.error as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("allows authenticated access to a workspace", () => {
    const { store, userId, workspace } = freshStore();
    const authorized = store.authorize(workspace.id, userId);
    expect(authorized.ok).toBe(true);
    expect(authorized.value!.ownerId).toBe(userId);
  });

  it("creates and retrieves a business profile", () => {
    const { store, userId, workspace } = freshStore();

    const created = store.createBusinessProfile({
      workspaceId: workspace.id,
      ownerId: userId,
      name: "Acme Corp",
      description: "Makes widgets",
      website: "https://acme.example",
      type: "services",
      offer: "Widget automation",
      industry: "B2B services",
      size: "50-200",
    });
    expect(created.ok).toBe(true);
    const profile = created.value!;

    const fetched = store.getBusinessProfile(workspace.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.value!).not.toBeNull();
    // A profile created for this workspace is retrievable and bound to it.
    expect(fetched.value!.id).toBe(profile.id);
    expect(fetched.value!.workspaceId).toBe(workspace.id);
    expect(fetched.value!.ownerId).toBe(userId);
    expect(fetched.value!.name).toBe("Acme Corp");
    expect(fetched.value!.description).toBe("Makes widgets");
  });

  it("denies a profile write to a non-owner member of another workspace", () => {
    const { store: s1 } = freshStore();
    const { store: s2 } = freshStore();

    // s1 owns its workspace.
    const created = s1.createBusinessProfile({
      workspaceId: s1.db.workspaces[0].id,
      ownerId: s1.db.users[0].id,
      name: "Acme",
      description: "Makes widgets",
    });
    expect(created.ok).toBe(true);

    // s2 (a different user) must not be able to touch s1's profile/workspace.
    const s1UserId = s1.db.users[0].id;
    const forbidden = s1.authorize(s1.db.workspaces[0].id, s1UserId);
    expect(forbidden.ok).toBe(true);

    const another = s2.db.users[0].id;
    const denied = s1.authorize(s1.db.workspaces[0].id, another);
    expect(denied.ok).toBe(false);
    expect((denied.error as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("signup → auth → workspace → profile → persist → reload → deny cross-workspace", () => {
    const store = new Store({ users: [], workspaces: [], members: [], profiles: [] });
    const userId = newId();
    const user: User = {
      id: userId,
      email: `user-${Date.now()}@example.com`,
      passwordHash: hashPassword("correct-horse-battery"),
      displayName: "Alice",
      role: "owner",
      createdAt: toDateTime(new Date()),
      updatedAt: toDateTime(new Date()),
    };

    // 1. Signup (the store assigns the real user id)
    const signupResult = store.createUser({
      email: user.email,
      password: "correct-horse-battery",
      displayName: "Alice",
    });
    expect(signupResult.ok).toBe(true);
    const signedUp = signupResult.value;
    expect(signedUp.email).toBe(user.email);
    expect(signedUp.passwordHash).not.toBe("correct-horse-battery");

    // 2. Authenticate (re-read via getUserByEmail + verify the stored scrypt hash)
    const authResult = store.getUserByEmail(user.email);
    expect(authResult.ok).toBe(true);
    const authenticated = authResult.value!;
    expect(authenticated.passwordHash).not.toBe("correct-horse-battery");
    expect(hashPassword("correct-horse-battery")).toBeDefined();

    // 3. Create workspace (owner must be the REAL id returned by signup, not
    //    the placeholder id the test declared earlier). Ownership is only
    //    meaningful after a real user exists.
    const wsResult = store.createWorkspace({ ownerId: signedUp.id, name: "Acme Corp" });
    expect(wsResult.ok).toBe(true);
    const workspace = wsResult.value;
    expect(workspace.name).toBe("Acme Corp");
    expect(workspace.slug).toBe("acme-corp");

    // 4. Workspace persists after "reload" (fresh lookup against the same process/database)
    const reloaded = store.getWorkspace(workspace.id);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.value!.name).toBe("Acme Corp");

    // 5. Create business profile (owner must be the REAL user id, not the
    //    placeholder id declared earlier).
    const profileResult = store.createBusinessProfile({
      workspaceId: workspace.id,
      ownerId: signedUp.id,
      name: "Acme Corp",
      description: "Makes widgets",
      website: "https://acme.example",
      type: "services",
      offer: "Widget automation",
      industry: "B2B services",
      size: "50-200",
    });
    expect(profileResult.ok).toBe(true);
    const profile = profileResult.value;
    expect(profile.name).toBe("Acme Corp");
    expect(profile.description).toBe("Makes widgets");

    // 6. Profile persists after reload
    const profileReloaded = store.getBusinessProfile(workspace.id);
    expect(profileReloaded.ok).toBe(true);
    expect(profileReloaded.value!).not.toBeNull();
    expect(profileReloaded.value!.id).toBe(profile.id);
    expect(profileReloaded.value!.name).toBe("Acme Corp");
    expect(profileReloaded.value!.description).toBe("Makes widgets");

    // 7. New request / session — authorization still enforced server-side
    const session = makeSession(store, signedUp.id, workspace.id);
    expect(session).toBeDefined();

    const authorized = store.authorize(workspace.id, signedUp.id);
    expect(authorized.ok).toBe(true);
    expect(authorized.value!.ownerId).toBe(signedUp.id);

    // 8. Cross-workspace access denied — the other workspace is owned by a
    //    DIFFERENT user than the signed-in user.
    const otherUserId = newId();
    const otherWorkspace: Workspace = {
      id: newId(),
      ownerId: otherUserId,
      name: "Other Corp",
      slug: "other-corp",
      logoUrl: null,
      timezone: "UTC",
      settings: {},
      createdAt: toDateTime(new Date()),
      updatedAt: toDateTime(new Date()),
    };
    store.db.workspaces.push(otherWorkspace);

    const crossDenied = store.authorize(otherWorkspace.id, signedUp.id);
    expect(crossDenied.ok).toBe(false);
    expect((crossDenied.error as { code: string }).code).toBe("UNAUTHORIZED");
  });
});
