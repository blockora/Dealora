import { describe, expect, it } from "vitest";
import { Store, hashPassword, verifyPassword, newId, toDateTime } from "./repository.js";
import { isOk, isErr } from "@dealora/core";
import type { User } from "./types.js";

function seed(): Store {
  return new Store({ users: [], workspaces: [], members: [], profiles: [] });
}

describe("repository", () => {
  it("generates unique ids", () => {
    expect(newId()).not.toBe(newId());
  });

  describe("hashPassword", () => {
    it("does not store plaintext", () => {
      const hashed = hashPassword("correct-horse-battery");
      expect(hashed).not.toBe("correct-horse-battery");
      expect(hashed).toContain(":");
    });

    it("verifies correct passwords", () => {
      const hashed = hashPassword("sup3r-secret!");
      expect(verifyPassword("sup3r-secret!", hashed)).toBe(true);
    });

    it("rejects wrong passwords", () => {
      const hashed = hashPassword("sup3r-secret!");
      expect(verifyPassword("wrong-password", hashed)).toBe(false);
    });
  });

  describe("signup + workspace + business profile", () => {
    it("creates a user and authenticates", () => {
      const s = seed();
      const created = s.createUser({
        email: "alice@example.com",
        password: "correct-horse-battery",
        displayName: "Alice",
      });
      expect(isOk(created)).toBe(true);
      const user = created.value;
      expect(user.email).toBe("alice@example.com");
      expect(user.passwordHash).not.toBe("correct-horse-battery");

      const byEmail = s.getUserByEmail("alice@example.com");
      expect(isOk(byEmail)).toBe(true);
      expect(byEmail.value).not.toBeNull();

      // Auth helpers mirror the api behaviour but run against the store.
      const authResult = s.getUserByEmail("alice@example.com");
      expect(isOk(authResult)).toBe(true);
      const found = authResult.value!;
      expect(found!.passwordHash).toContain(":");
    });

    it("rejects duplicate email", () => {
      const s = seed();
      const first = s.createUser({
        email: "alice@example.com",
        password: "correct-horse-battery",
        displayName: "Alice",
      });
      expect(isOk(first)).toBe(true);

      const second = s.createUser({
        email: "alice@example.com",
        password: "other-password",
        displayName: "Alice 2",
      });
      expect(isErr(second)).toBe(true);
      expect((second.error as { code: string }).code).toBe("CONFLICT");
    });

    it("creates a workspace owned by the user", () => {
      const s = seed();
      const owner: User = {
        id: "owner-placeholder",
        email: "owner@example.com",
        passwordHash: "salt:deadbeef",
        displayName: "Owner",
        role: "owner",
        createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
      };
      s.db.users.push(owner);
      const ws = s.createWorkspace({ ownerId: owner.id, name: "Acme Corp" });
      expect(isOk(ws)).toBe(true);
      const workspace = ws.value;
      expect(workspace.name).toBe("Acme Corp");
      expect(workspace.slug).toBe("acme-corp");
      expect(workspace.ownerId).toBe(owner.id);

      const list = s.getWorkspaces(owner.id);
      expect(isOk(list)).toBe(true);
      expect(list.value).toEqual([workspace]);
    });

    it("rejects workspace creation for unknown owner", () => {
      const s = seed();
      const ws = s.createWorkspace({ ownerId: "missing-id", name: "X" });
      expect(isErr(ws)).toBe(true);
      expect((ws.error as { code: string }).code).toBe("NOT_FOUND");
    });

    it("creates a business profile bound to a workspace", () => {
      const s = seed();
      const owner: User = {
        id: "owner-id",
        email: "owner@example.com",
        passwordHash: "salt:deadbeef",
        displayName: "Owner",
        role: "owner",
        createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
      };
      s.db.users.push(owner);
      const ws = s.createWorkspace({ ownerId: owner.id, name: "Acme" });
      const profile = s.createBusinessProfile({
        workspaceId: ws.value!.id,
        ownerId: owner.id,
        name: "Acme Corp",
        description: "Makes widgets",
        website: "https://acme.example",
      });
      expect(isOk(profile)).toBe(true);
      const p = profile.value;
      expect(p.name).toBe("Acme Corp");
      expect(p.website).toBe("https://acme.example");
      expect(p.workspaceId).toBe(ws.value!.id);

      const fetched = s.getBusinessProfile(ws.value!.id);
      expect(isOk(fetched)).toBe(true);
      expect(fetched.value).not.toBeNull();
    });

    it("denies cross-workspace access", () => {
      const s = seed();
      const ownerA: User = {
        id: "owner-a",
        email: "a@example.com",
        passwordHash: "salt:deadbeef",
        displayName: "Owner A",
        role: "owner",
        createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
      };
      s.db.users.push(ownerA);
      const ownerB: User = {
        id: "owner-b",
        email: "b@example.com",
        passwordHash: "salt:deadbeef",
        displayName: "Owner B",
        role: "owner",
        createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
      };
      s.db.users.push(ownerB);
      const wsA = s.createWorkspace({ ownerId: ownerA.id, name: "Workspace A" });
      const _wsB = s.createWorkspace({ ownerId: ownerB.id, name: "Workspace B" });

      const allowed = s.authorize(wsA.value!.id, ownerA.id);
      expect(isOk(allowed)).toBe(true);

      const denied = s.authorize(wsA.value!.id, ownerB.id);
      expect(isErr(denied)).toBe(true);
      expect((denied.error as { code: string }).code).toBe("UNAUTHORIZED");

      const notFound = s.authorize("missing-workspace", ownerA.id);
      expect(isErr(notFound)).toBe(true);
      expect((notFound.error as { code: string }).code).toBe("NOT_FOUND");
    });

    it("enforces least privilege: only owner/member can touch profile", () => {
      const s = seed();
      const alice: User = {
        id: "alice-id",
        email: "alice@example.com",
        passwordHash: "salt:deadbeef",
        displayName: "Alice",
        role: "owner",
        createdAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
        updatedAt: toDateTime(new Date("2026-01-01T00:00:00.000Z")),
      };
      s.db.users.push(alice);
      const ws = s.createWorkspace({ ownerId: alice.id, name: "Acme" });
      s.createBusinessProfile({
        workspaceId: ws.value!.id,
        ownerId: alice.id,
        name: "Acme",
        description: "Makes widgets",
      });

      // Non-owner reading the profile must be denied.
      const denied = s.authorize(ws.value!.id, "someone-else");
      expect(isErr(denied)).toBe(true);
      expect((denied.error as { code: string }).code).toBe("UNAUTHORIZED");

      // Owner can read.
      const allowed = s.authorize(ws.value!.id, alice.id);
      expect(isOk(allowed)).toBe(true);
      const fetched = s.getBusinessProfile(ws.value!.id);
      expect(isOk(fetched)).toBe(true);
      expect(fetched.value!.name).toBe("Acme");
    });
  });
});
