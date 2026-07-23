import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { D1SnapshotStore, type D1DatabaseLike } from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import { adminMutation, adminOverview } from "../src/server/admin";
import { claimWorkspace, createOrLinkUser } from "../src/server/auth";

function database(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const wrapped = (values: unknown[] = []) => ({
        bind(...next: unknown[]) { return wrapped(next); },
        first: async () => statement.get(...values as SQLInputValue[]) as never,
        all: async () => ({ results: statement.all(...values as SQLInputValue[]) as never[] }),
        run: async () => { const result = statement.run(...values as SQLInputValue[]); return { success: true, meta: { changes: Number(result.changes) } }; },
      });
      return wrapped() as ReturnType<D1DatabaseLike["prepare"]>;
    },
  };
}

describe("admin control plane", () => {
  it("lists and safely unlinks identities", async () => {
    const db = database();
    const env = { AUTH_ADMIN_EMAILS: "owner@example.com" };
    const owner = await createOrLinkUser(db, env, { provider: "google", subject: "google-owner", email: "owner@example.com", displayName: "Owner" });
    await createOrLinkUser(db, env, { provider: "github", subject: "github-owner", email: "owner@example.com", displayName: "Owner" });
    const first = await adminOverview(db);
    expect(first.identities).toHaveLength(2);
    await adminMutation(db, owner.userId, { action: "identity.unlink", targetId: String(first.identities[0].identity_id) });
    const remaining = (await adminOverview(db)).identities;
    expect(remaining).toHaveLength(1);
    await expect(adminMutation(db, owner.userId, { action: "identity.unlink", targetId: String(remaining[0].identity_id) })).rejects.toThrow(/retain at least one/);
  });

  it("protects the final active admin and final workspace owner", async () => {
    const db = database();
    const env = { AUTH_ADMIN_EMAILS: "owner@example.com" };
    const owner = await createOrLinkUser(db, env, { provider: "test", subject: "owner", email: "owner@example.com", displayName: "Owner" });
    await expect(adminMutation(db, owner.userId, { action: "user.role", targetId: owner.userId, value: "user" })).rejects.toThrow(/last active administrator/);
    const state = createEmptyState("Admin test");
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const target = `${state.workspace.id}::${owner.userId}`;
    await expect(adminMutation(db, owner.userId, { action: "member.role", targetId: target, value: "viewer" })).rejects.toThrow(/at least one owner/);
    await expect(adminMutation(db, owner.userId, { action: "member.remove", targetId: target })).rejects.toThrow(/at least one owner/);
  });

  it("cleans up only unclaimed initial snapshots after membership failure", async () => {
    const db = database();
    const store = new D1SnapshotStore(db);
    const unclaimed = createEmptyState("Unclaimed");
    await store.initialize(unclaimed);
    await expect(
      store.deleteIfUnclaimed(unclaimed.workspace.id, unclaimed.workspace.revision),
    ).resolves.toBe(true);
    await expect(store.load(unclaimed.workspace.id)).resolves.toBeNull();

    const claimed = createEmptyState("Claimed");
    await store.initialize(claimed);
    const owner = await createOrLinkUser(
      db,
      {},
      {
        provider: "test",
        subject: "cleanup-owner",
        email: "cleanup@example.com",
        displayName: "Cleanup owner",
      },
    );
    await claimWorkspace(db, owner.userId, claimed.workspace.id);
    await expect(
      store.deleteIfUnclaimed(claimed.workspace.id, claimed.workspace.revision),
    ).resolves.toBe(false);
    await expect(store.load(claimed.workspace.id)).resolves.not.toBeNull();
  });
});
