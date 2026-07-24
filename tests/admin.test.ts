import { describe, expect, it } from "vitest";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import { adminMutation, adminOverview } from "../src/server/admin";
import { claimWorkspace, createOrLinkUser } from "../src/server/auth";
import { QuotaExceededError } from "../src/server/quotas";
import { API_QUOTAS } from "../src/shared/api-quotas";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

function database() {
  return numberedMigrationDatabase().database;
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

  it("atomically retains an active admin during concurrent demotions", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const env = {
      AUTH_ADMIN_EMAILS: "first@example.com,second@example.com",
    };
    const first = await createOrLinkUser(db, env, {
      displayName: "First",
      email: "first@example.com",
      provider: "test",
      subject: "first",
    });
    const second = await createOrLinkUser(db, env, {
      displayName: "Second",
      email: "second@example.com",
      provider: "test",
      subject: "second",
    });

    const results = await Promise.allSettled([
      adminMutation(db, first.userId, {
        action: "user.role",
        targetId: first.userId,
        value: "user",
      }),
      adminMutation(db, second.userId, {
        action: "user.role",
        targetId: second.userId,
        value: "user",
      }),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM users
       WHERE global_role='admin' AND status='active'`,
    ).get()).toEqual({ count: 1 });
  });

  it("atomically retains a workspace owner during concurrent demotions", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const first = await createOrLinkUser(db, {}, {
      displayName: "First owner",
      email: "first-owner@example.com",
      provider: "test",
      subject: "first-owner",
    });
    const second = await createOrLinkUser(db, {}, {
      displayName: "Second owner",
      email: "second-owner@example.com",
      provider: "test",
      subject: "second-owner",
    });
    const state = createEmptyState("Concurrent owners");
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, first.userId, state.workspace.id);
    await claimWorkspace(db, second.userId, state.workspace.id);

    const results = await Promise.allSettled([
      adminMutation(db, first.userId, {
        action: "member.role",
        targetId: `${state.workspace.id}::${first.userId}`,
        value: "editor",
      }),
      adminMutation(db, second.userId, {
        action: "member.role",
        targetId: `${state.workspace.id}::${second.userId}`,
        value: "editor",
      }),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND role='owner'`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
  });

  it("atomically retains a sign-in identity during concurrent unlinks", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const user = await createOrLinkUser(db, {}, {
      displayName: "Linked user",
      email: "linked@example.com",
      provider: "google",
      subject: "linked-google",
    });
    await createOrLinkUser(db, {}, {
      displayName: "Linked user",
      email: "linked@example.com",
      provider: "github",
      subject: "linked-github",
    });
    const identities = sqlite.prepare(
      "SELECT identity_id FROM identities WHERE user_id=?",
    ).all(user.userId) as { identity_id: string }[];

    const results = await Promise.allSettled(identities.map(identity =>
      adminMutation(db, user.userId, {
        action: "identity.unlink",
        targetId: identity.identity_id,
      })
    ));

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toHaveLength(1);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM identities WHERE user_id=?",
    ).get(user.userId)).toEqual({ count: 1 });
  });

  it("refuses repeated and nonexistent mutations without auditing them", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const env = { AUTH_ADMIN_EMAILS: "owner@example.com" };
    const owner = await createOrLinkUser(db, env, {
      displayName: "Owner",
      email: "owner@example.com",
      provider: "test",
      subject: "owner-no-op",
    });
    const state = createEmptyState("No-op test");
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, owner.userId, state.workspace.id);

    await expect(adminMutation(db, owner.userId, {
      action: "user.role",
      targetId: owner.userId,
      value: "admin",
    })).rejects.toThrow(/already has the admin role/);
    await expect(adminMutation(db, owner.userId, {
      action: "member.role",
      targetId: `${state.workspace.id}::${owner.userId}`,
      value: "owner",
    })).rejects.toThrow(/already has the owner role/);
    await expect(adminMutation(db, owner.userId, {
      action: "session.revoke",
      targetId: "ses_missing",
    })).rejects.toThrow(/Session was not found/);

    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM auth_audit_events",
    ).get()).toEqual({ count: 0 });
  });

  it("rolls back an admin mutation when its audit insert fails", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const env = { AUTH_ADMIN_EMAILS: "owner@example.com" };
    const owner = await createOrLinkUser(db, env, {
      displayName: "Owner",
      email: "owner@example.com",
      provider: "test",
      subject: "owner-audit-rollback",
    });
    const target = await createOrLinkUser(db, env, {
      displayName: "Target",
      email: "target@example.com",
      provider: "test",
      subject: "target-audit-rollback",
    });
    sqlite.exec(
      `CREATE TRIGGER reject_admin_audit
       BEFORE INSERT ON auth_audit_events
       BEGIN
         SELECT RAISE(ABORT, 'injected audit failure');
       END`,
    );

    await expect(adminMutation(db, owner.userId, {
      action: "user.status",
      targetId: target.userId,
      value: "disabled",
    })).rejects.toThrow(/injected audit failure/);

    expect(sqlite.prepare(
      "SELECT status FROM users WHERE user_id=?",
    ).get(target.userId)).toEqual({ status: "active" });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM auth_audit_events",
    ).get()).toEqual({ count: 0 });
  });

  it("shows workspace names, capacity usage, and bounded search results", async () => {
    const db = database();
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Capacity owner",
      email: "capacity@example.com",
      provider: "test",
      subject: "capacity-owner",
    });
    const state = createEmptyState("Capacity workspace");
    state.activities = [{
      actorId: "user_capacity",
      commandId: "command_capacity",
      id: "activity_capacity",
      label: "Capacity activity",
      patches: [{}, {}, {}] as never,
      status: "applied",
      subjectIds: [],
      timestamp: "2026-07-24T00:00:00.000Z",
      undoneAt: null,
    }];
    state.audit = [{}, {}] as never;
    state.commandReceipts = [
      "command_compact_1",
      "command_compact_2",
      "command_compact_3",
      "command_compact_4",
    ];
    state.items = [{}, {}, {}] as never;
    state.locations = [{}, {}] as never;
    state.plans = [{ steps: [{}, {}] }] as never;
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, owner.userId, state.workspace.id);

    const overview = await adminOverview(db, {
      viewerUserId: owner.userId,
    });
    expect(overview.workspaces[0]).toMatchObject({
      active_guest_link_count: 0,
      activity_count: 1,
      activity_patch_count: 3,
      audit_event_count: 2,
      command_receipt_count: 4,
      item_count: 3,
      location_count: 2,
      member_count: 1,
      owner_count: 1,
      plan_count: 1,
      plan_step_count: 2,
      viewer_is_member: 1,
      workspace_id: state.workspace.id,
      workspace_name: "Capacity workspace",
    });
    expect(overview.memberships[0]).toMatchObject({
      workspace_name: "Capacity workspace",
    });
    expect(overview.limits).toEqual(API_QUOTAS);
    expect(overview.listInfo.workspaces).toEqual({
      hasMore: false,
      limit: 250,
    });

    const outsider = await createOrLinkUser(db, {}, {
      displayName: "Capacity outsider",
      email: "capacity-outsider@example.com",
      provider: "test",
      subject: "capacity-outsider",
    });
    const outsiderOverview = await adminOverview(db, {
      viewerUserId: outsider.userId,
    });
    expect(outsiderOverview.workspaces[0]).toMatchObject({
      viewer_is_member: 0,
    });

    const match = await adminOverview(db, { query: "capacity workspace" });
    expect(match.workspaces).toHaveLength(1);
    expect(match.memberships).toHaveLength(1);
    const noMatch = await adminOverview(db, { query: "not present" });
    expect(noMatch.workspaces).toHaveLength(0);
    expect(noMatch.memberships).toHaveLength(0);
    expect(noMatch.users).toHaveLength(0);
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

  it("does not bypass the owned workspace quota during role promotion", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const target = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "promotion-target",
      email: "promotion-target@example.com",
      displayName: "Promotion target",
    });
    const actor = await createOrLinkUser(db, {}, {
      provider: "test",
      subject: "promotion-actor",
      email: "promotion-actor@example.com",
      displayName: "Promotion actor",
    });
    for (
      let index = 0;
      index < API_QUOTAS.ownedWorkspacesPerUser;
      index += 1
    ) {
      const state = createEmptyState(`Owned ${index}`);
      await new D1SnapshotStore(db).initialize(state);
      await claimWorkspace(db, target.userId, state.workspace.id);
    }
    const extra = createEmptyState("Promotion overage");
    await new D1SnapshotStore(db).initialize(extra);
    await claimWorkspace(db, actor.userId, extra.workspace.id);
    sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id, user_id, role, created_at
       ) VALUES(?,?,'viewer',?)`,
    ).run(
      extra.workspace.id,
      target.userId,
      "2026-07-24T00:00:00.000Z",
    );

    await expect(adminMutation(db, actor.userId, {
      action: "member.role",
      targetId: `${extra.workspace.id}::${target.userId}`,
      value: "owner",
    })).rejects.toMatchObject({
      actual: API_QUOTAS.ownedWorkspacesPerUser + 1,
      code: "QUOTA_EXCEEDED",
      quota: "ownedWorkspacesPerUser",
    } satisfies Partial<QuotaExceededError>);
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id = ? AND user_id = ?`,
    ).get(extra.workspace.id, target.userId)).toEqual({ role: "viewer" });
  });
});
