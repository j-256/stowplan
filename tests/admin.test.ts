import { describe, expect, it } from "vitest";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import { adminMutation, adminOverview } from "../src/server/admin";
import {
  claimWorkspace,
  createGuestLink,
  createOrLinkUser,
} from "../src/server/auth";
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

  it("keeps final active workspace owners enabled and rejects disabled owner promotion", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const admin = await createOrLinkUser(
      db,
      { AUTH_ADMIN_EMAILS: "active-owner-admin@example.com" },
      {
        displayName: "Active owner admin",
        email: "active-owner-admin@example.com",
        provider: "test",
        subject: "active-owner-admin",
      },
    );
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Active owner",
      email: "active-owner@example.com",
      provider: "test",
      subject: "active-owner",
    });
    const disabledOwner = await createOrLinkUser(db, {}, {
      displayName: "Disabled owner",
      email: "disabled-owner@example.com",
      provider: "test",
      subject: "disabled-owner",
    });
    const state = createEmptyState("Active owner invariant");
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, owner.userId, state.workspace.id);
    await claimWorkspace(db, disabledOwner.userId, state.workspace.id);

    await expect(adminMutation(db, admin.userId, {
      action: "user.status",
      targetId: disabledOwner.userId,
      value: "disabled",
    })).resolves.toEqual({ message: "User disabled" });
    await expect(adminMutation(db, admin.userId, {
      action: "user.status",
      targetId: owner.userId,
      value: "disabled",
    })).rejects.toThrow(/final active workspace owner/);
    await expect(adminMutation(db, admin.userId, {
      action: "member.role",
      targetId: `${state.workspace.id}::${disabledOwner.userId}`,
      value: "editor",
    })).resolves.toEqual({ message: "Workspace role changed to editor" });
    await expect(adminMutation(db, admin.userId, {
      action: "member.role",
      targetId: `${state.workspace.id}::${disabledOwner.userId}`,
      value: "owner",
    })).rejects.toThrow(/disabled account/);

    expect(sqlite.prepare(
      "SELECT status FROM users WHERE user_id=?",
    ).get(owner.userId)).toEqual({ status: "active" });
    expect(sqlite.prepare(
      `SELECT member.role,member_user.status
       FROM workspace_members member
       JOIN users member_user ON member_user.user_id=member.user_id
       WHERE member.workspace_id=? AND member.user_id=?`,
    ).get(state.workspace.id, disabledOwner.userId)).toEqual({
      role: "editor",
      status: "disabled",
    });
  });

  it("advances revisions for global control-plane access changes", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const globalAdmin = await createOrLinkUser(
      db,
      { AUTH_ADMIN_EMAILS: "control-admin@example.com" },
      {
        displayName: "Control admin",
        email: "control-admin@example.com",
        provider: "test",
        subject: "control-admin",
      },
    );
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Owner",
      email: "control-owner@example.com",
      provider: "test",
      subject: "control-owner",
    });
    const member = await createOrLinkUser(db, {}, {
      displayName: "Member",
      email: "control-member@example.com",
      provider: "test",
      subject: "control-member",
    });
    const state = createEmptyState("Control revisions");
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, owner.userId, state.workspace.id);
    sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,'viewer',?)`,
    ).run(
      state.workspace.id,
      member.userId,
      "2026-07-24T00:00:00.000Z",
    );

    await adminMutation(db, globalAdmin.userId, {
      action: "member.role",
      targetId: `${state.workspace.id}::${member.userId}`,
      value: "editor",
    });
    expect(sqlite.prepare(
      `SELECT snapshot.access_revision,target_user.membership_revision
       FROM workspace_snapshots snapshot
       JOIN users target_user ON target_user.user_id=?
       WHERE snapshot.workspace_id=?`,
    ).get(member.userId, state.workspace.id)).toEqual({
      access_revision: 3,
      membership_revision: 2,
    });

    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    await adminMutation(db, globalAdmin.userId, {
      action: "guest.revoke",
      targetId: link.id,
    });
    await adminMutation(db, globalAdmin.userId, {
      action: "member.remove",
      targetId: `${state.workspace.id}::${member.userId}`,
    });
    expect(sqlite.prepare(
      `SELECT snapshot.access_revision,target_user.membership_revision
       FROM workspace_snapshots snapshot
       JOIN users target_user ON target_user.user_id=?
       WHERE snapshot.workspace_id=?`,
    ).get(member.userId, state.workspace.id)).toEqual({
      access_revision: 6,
      membership_revision: 3,
    });
    expect(sqlite.prepare(
      `SELECT action
       FROM auth_audit_events
       WHERE action IN ('member.role','guest.revoke','member.remove')
       ORDER BY action`,
    ).all()).toEqual([
      { action: "guest.revoke" },
      { action: "member.remove" },
      { action: "member.role" },
    ]);
  });

  it("records triggered access mutations with D1 change metadata", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase({
      triggerInclusiveChanges: true,
    });
    const admin = await createOrLinkUser(
      db,
      { AUTH_ADMIN_EMAILS: "trigger-admin@example.com" },
      {
        displayName: "Trigger admin",
        email: "trigger-admin@example.com",
        provider: "test",
        subject: "trigger-admin",
      },
    );
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Trigger owner",
      email: "trigger-owner@example.com",
      provider: "test",
      subject: "trigger-owner",
    });
    const roleTarget = await createOrLinkUser(db, {}, {
      displayName: "Role target",
      email: "trigger-role@example.com",
      provider: "test",
      subject: "trigger-role",
    });
    const removalTarget = await createOrLinkUser(db, {}, {
      displayName: "Removal target",
      email: "trigger-remove@example.com",
      provider: "test",
      subject: "trigger-remove",
    });
    const state = createEmptyState("Trigger metadata");
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const createdAt = "2026-07-25T00:00:00.000Z";
    sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,'viewer',?),(?,?,'viewer',?)`,
    ).run(
      state.workspace.id,
      roleTarget.userId,
      createdAt,
      state.workspace.id,
      removalTarget.userId,
      createdAt,
    );
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );

    await expect(adminMutation(db, admin.userId, {
      action: "member.role",
      targetId: `${state.workspace.id}::${roleTarget.userId}`,
      value: "editor",
    })).resolves.toEqual({ message: "Workspace role changed to editor" });
    await expect(adminMutation(db, admin.userId, {
      action: "member.remove",
      targetId: `${state.workspace.id}::${removalTarget.userId}`,
    })).resolves.toEqual({ message: "Workspace member removed" });
    await expect(adminMutation(db, admin.userId, {
      action: "guest.revoke",
      targetId: link.id,
    })).resolves.toEqual({ message: "Guest link revoked" });

    expect(sqlite.prepare(
      `SELECT action
       FROM auth_audit_events
       WHERE action IN ('member.role','member.remove','guest.revoke')
       ORDER BY action`,
    ).all()).toEqual([
      { action: "guest.revoke" },
      { action: "member.remove" },
      { action: "member.role" },
    ]);
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

  it("atomically retains an active owner during concurrent account disables", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const admin = await createOrLinkUser(
      db,
      { AUTH_ADMIN_EMAILS: "disable-race-admin@example.com" },
      {
        displayName: "Disable race admin",
        email: "disable-race-admin@example.com",
        provider: "test",
        subject: "disable-race-admin",
      },
    );
    const first = await createOrLinkUser(db, {}, {
      displayName: "First active owner",
      email: "first-disable-owner@example.com",
      provider: "test",
      subject: "first-disable-owner",
    });
    const second = await createOrLinkUser(db, {}, {
      displayName: "Second active owner",
      email: "second-disable-owner@example.com",
      provider: "test",
      subject: "second-disable-owner",
    });
    const state = createEmptyState("Concurrent owner disables");
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, first.userId, state.workspace.id);
    await claimWorkspace(db, second.userId, state.workspace.id);

    const results = await Promise.allSettled([
      adminMutation(db, admin.userId, {
        action: "user.status",
        targetId: first.userId,
        value: "disabled",
      }),
      adminMutation(db, admin.userId, {
        action: "user.status",
        targetId: second.userId,
        value: "disabled",
      }),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members owner
       JOIN users owner_user ON owner_user.user_id=owner.user_id
       WHERE owner.workspace_id=?
         AND owner.role='owner'
         AND owner_user.status='active'`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='user.status'`,
    ).get()).toEqual({ count: 1 });
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

  it("reports complete database inventory without exposing durable secrets or workspace contents", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const privateItemName = "Inventory content must stay private";
    const privateSessionHash = "session_hash_must_stay_private";
    const privateInviteHash = "invite_hash_must_stay_private";
    const privateStateHash = "oauth_state_hash_must_stay_private";
    const privateVerifier = "oauth_verifier_must_stay_private";
    const privateAuditDetail = "audit_detail_must_stay_private";
    const operator = await createOrLinkUser(
      db,
      { AUTH_ADMIN_EMAILS: "inventory-admin@example.com" },
      {
        displayName: "Inventory administrator",
        email: "inventory-admin@example.com",
        provider: "test",
        subject: "inventory-admin-private-subject",
      },
    );
    const owner = await createOrLinkUser(db, {}, {
      displayName: "Inventory owner",
      email: "inventory-owner@example.com",
      provider: "test",
      subject: "inventory-owner-private-subject",
    });
    const state = createEmptyState("Inventory workspace");
    state.items = [{
      id: "item_private",
      name: privateItemName,
    }] as never;
    await new D1SnapshotStore(db).initialize(state);
    await claimWorkspace(db, owner.userId, state.workspace.id);

    sqlite.prepare(
      `INSERT INTO workspace_deletions(
         workspace_id,deletion_id,deleted_at,deleted_by_user_id,
         final_snapshot_revision,final_access_revision
       ) VALUES(?,?,?,?,?,?)`,
    ).run(
      "ws_deleted_private",
      "deletion_private",
      "2026-07-01T00:00:00.000Z",
      owner.userId,
      7,
      9,
    );
    sqlite.prepare(
      `INSERT INTO sessions(
         session_id,user_id,token_hash,created_at,expires_at,last_seen_at,
         revoked_at,user_agent,ip_prefix
       ) VALUES
         (?,?,?,?,?,?,?,?,?),
         (?,?,?,?,?,?,?,?,?),
         (?,?,?,?,?,?,?,?,?)`,
    ).run(
      "session_active",
      operator.userId,
      privateSessionHash,
      "2026-07-01T00:00:00.000Z",
      "2099-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      null,
      "private user agent",
      "private ip prefix",
      "session_expired",
      operator.userId,
      "expired_session_hash",
      "2026-06-01T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
      "2026-06-01T12:00:00.000Z",
      null,
      null,
      null,
      "session_revoked",
      operator.userId,
      "revoked_session_hash",
      "2026-07-01T00:00:00.000Z",
      "2099-07-01T00:00:00.000Z",
      "2026-07-01T12:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      null,
      null,
    );
    sqlite.prepare(
      `INSERT INTO guest_links(
         guest_link_id,workspace_id,created_by_user_id,token_hash,role,
         created_at,expires_at,consumed_at,revoked_at
       ) VALUES
         (?,?,?,?,?,?,?,?,?),
         (?,?,?,?,?,?,?,?,?),
         (?,?,?,?,?,?,?,?,?),
         (?,?,?,?,?,?,?,?,?)`,
    ).run(
      "invite_active",
      state.workspace.id,
      owner.userId,
      privateInviteHash,
      "viewer",
      "2026-07-01T00:00:00.000Z",
      "2099-07-01T00:00:00.000Z",
      null,
      null,
      "invite_used",
      state.workspace.id,
      owner.userId,
      "used_invite_hash",
      "editor",
      "2026-07-01T00:00:00.000Z",
      "2099-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      null,
      "invite_expired",
      state.workspace.id,
      owner.userId,
      "expired_invite_hash",
      "viewer",
      "2026-06-01T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
      null,
      null,
      "invite_revoked",
      state.workspace.id,
      owner.userId,
      "revoked_invite_hash",
      "viewer",
      "2026-07-01T00:00:00.000Z",
      "2099-07-01T00:00:00.000Z",
      null,
      "2026-07-02T00:00:00.000Z",
    );
    sqlite.prepare(
      `INSERT INTO oauth_states(
         state_hash,provider,verifier_ciphertext,return_to,created_at,
         expires_at,consumed_at
       ) VALUES
         (?,?,?,?,?,?,?),
         (?,?,?,?,?,?,?),
         (?,?,?,?,?,?,?)`,
    ).run(
      privateStateHash,
      "private-provider",
      privateVerifier,
      "/private-return",
      "2026-07-01T00:00:00.000Z",
      "2099-07-01T00:00:00.000Z",
      null,
      "consumed_state_hash",
      "private-provider",
      "consumed_verifier",
      "/private-consumed-return",
      "2026-07-01T00:00:00.000Z",
      "2099-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "expired_state_hash",
      "private-provider",
      "expired_verifier",
      "/private-expired-return",
      "2026-06-01T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
      null,
    );
    sqlite.prepare(
      `INSERT INTO auth_audit_events(
         event_id,actor_user_id,action,target_type,target_id,detail_json,
         created_at,ip_prefix
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      "audit_private",
      operator.userId,
      "inventory.test",
      "private",
      "private_target",
      JSON.stringify({ privateAuditDetail }),
      "2026-07-03T00:00:00.000Z",
      "private audit ip",
    );
    sqlite.exec(
      `CREATE TABLE stowplan_node_migrations (
         name TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       ) STRICT`,
    );
    sqlite.prepare(
      `INSERT INTO stowplan_node_migrations(name,applied_at)
       VALUES(?,?),(?,?)`,
    ).run(
      "0001_private_filename.sql",
      "2026-07-01T00:00:00.000Z",
      "0002_private_filename.sql",
      "2026-07-02T00:00:00.000Z",
    );

    const overview = await adminOverview(db, {
      query: "no ordinary rows match",
      viewerUserId: operator.userId,
    });
    expect(overview.workspaces).toHaveLength(0);
    const entries = overview.databaseInventory.entries;
    expect(entries.map(entry => entry.table)).toEqual([
      "workspace_snapshots",
      "workspace_deletions",
      "users",
      "identities",
      "workspace_members",
      "sessions",
      "guest_links",
      "oauth_states",
      "auth_audit_events",
      "stowplan_migration_stream",
      "stowplan_node_migrations",
    ]);
    const entry = (table: string) => {
      const match = entries.find(candidate => candidate.table === table);
      expect(match).toBeDefined();
      return match!;
    };
    const metrics = (table: string) => Object.fromEntries(
      entry(table).metrics.map(item => [item.label, item.value]),
    );
    expect(entry("workspace_snapshots").rowCount).toBe(1);
    expect(metrics("workspace_snapshots")).toMatchObject({
      "highest access revision": 5,
      "stored size": expect.any(Number),
    });
    expect(entry("workspace_deletions").rowCount).toBe(1);
    expect(entry("users").rowCount).toBe(2);
    expect(entry("identities").rowCount).toBe(2);
    expect(entry("workspace_members").rowCount).toBe(1);
    expect(entry("sessions").rowCount).toBe(3);
    expect(metrics("sessions")).toMatchObject({
      active: 1,
      expired: 1,
      revoked: 1,
    });
    expect(entry("guest_links").rowCount).toBe(4);
    expect(metrics("guest_links")).toMatchObject({
      active: 1,
      expired: 1,
      revoked: 1,
      used: 1,
    });
    expect(entry("oauth_states").rowCount).toBe(3);
    expect(metrics("oauth_states")).toMatchObject({
      active: 1,
      consumed: 1,
      expired: 1,
    });
    expect(entry("auth_audit_events").rowCount).toBeGreaterThan(0);
    expect(entry("stowplan_migration_stream")).toMatchObject({
      rowCount: 1,
    });
    expect(metrics("stowplan_migration_stream")).toMatchObject({
      "active stream": "numbered",
    });
    expect(entry("stowplan_node_migrations").rowCount).toBe(2);

    const serialized = JSON.stringify(overview.databaseInventory);
    for (const sensitive of [
      privateItemName,
      privateSessionHash,
      privateInviteHash,
      privateStateHash,
      privateVerifier,
      privateAuditDetail,
      "inventory-admin@example.com",
      "inventory-owner@example.com",
      "inventory-admin-private-subject",
      "0001_private_filename.sql",
      "private user agent",
      "private audit ip",
      "private-return",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
    for (const sensitiveField of [
      "detail_json",
      "ip_prefix",
      "provider_subject",
      "state_hash",
      "state_json",
      "token_hash",
      "user_agent",
      "verifier_ciphertext",
      "workspace_id",
    ]) {
      expect(serialized).not.toContain(sensitiveField);
    }
  });

  it.each([
    {
      create: `CREATE TABLE d1_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      insert: `INSERT INTO d1_migrations(id,applied_at)
        VALUES(1,'2026-07-01T00:00:00.000Z')`,
      table: "d1_migrations",
    },
    {
      create: `CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`,
      insert: `INSERT INTO __drizzle_migrations(id,created_at)
        VALUES(1,1782864000000)`,
      table: "__drizzle_migrations",
    },
  ])("reports the $table runtime ledger with the shared aggregate shape", async ({
    create,
    insert,
    table,
  }) => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    sqlite.exec(create);
    sqlite.exec(insert);

    const overview = await adminOverview(db);
    expect(overview.databaseInventory.entries).toContainEqual({
      key: `migration-ledger:${table}`,
      label: "Migration ledger",
      metrics: [{
        kind: "date",
        label: "oldest application",
        value: "2026-07-01T00:00:00.000Z",
      }, {
        kind: "date",
        label: "latest application",
        value: "2026-07-01T00:00:00.000Z",
      }],
      rowCount: 1,
      table,
    });
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
