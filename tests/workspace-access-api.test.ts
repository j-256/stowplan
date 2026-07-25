import { describe, expect, it } from "vitest";
import {
  D1SnapshotStore,
  type D1DatabaseLike,
} from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import {
  changeWorkspaceMemberRole,
  createWorkspaceGuestLink,
  deleteServerWorkspace,
  getWorkspaceAccess,
  leaveWorkspace,
  listMemberWorkspaces,
  listWorkspaceGuestLinks,
  listWorkspaceMembers,
  removeWorkspaceMember,
  revokeWorkspaceGuestLink,
  transferWorkspaceOwnership,
  workspaceAccessErrorResponse,
} from "../src/server/workspace-access";
import {
  claimWorkspace,
  consumeGuestLink,
  createOrLinkUser,
  type SessionUser,
} from "../src/server/auth";
import { API_QUOTAS } from "../src/shared/api-quotas";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

type TestDatabase = ReturnType<typeof numberedMigrationDatabase>;

interface AccessRevisionRow {
  access_revision: number;
  membership_revision: number;
  revision: number;
  role: "owner" | "editor" | "viewer";
}

async function user(
  database: TestDatabase["database"],
  subject: string,
  options: {
    admin?: boolean;
    displayName?: string;
  } = {},
): Promise<SessionUser> {
  const email = `${subject}@example.test`;
  return createOrLinkUser(
    database,
    options.admin ? { AUTH_ADMIN_EMAILS: email } : {},
    {
      displayName: options.displayName ?? subject,
      email,
      provider: "test",
      subject,
    },
  );
}

async function workspace(
  database: TestDatabase["database"],
  owner: SessionUser,
  name: string,
  timestamp = "2026-07-25T00:00:00.000Z",
) {
  const state = createEmptyState(name, timestamp);
  await new D1SnapshotStore(database).initialize(state);
  await claimWorkspace(database, owner.userId, state.workspace.id);
  return state;
}

async function addMember(
  database: TestDatabase["database"],
  workspaceId: string,
  member: SessionUser,
  role: "owner" | "editor" | "viewer",
  createdAt = "2026-07-25T01:00:00.000Z",
) {
  await database.prepare(
    `INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
     VALUES(?,?,?,?)`,
  ).bind(workspaceId, member.userId, role, createdAt).run();
}

async function addOwnedWorkspaceFixtures(
  database: TestDatabase["database"],
  owner: SessionUser,
  count: number,
) {
  for (let index = 0; index < count; index += 1) {
    await workspace(
      database,
      owner,
      `Owned quota fixture ${index}`,
    );
  }
}

function revisions(
  sqlite: TestDatabase["sqlite"],
  workspaceId: string,
  userId: string,
): AccessRevisionRow {
  return sqlite.prepare(
    `SELECT snapshot.revision,snapshot.access_revision,
            member.role,user.membership_revision
     FROM workspace_snapshots snapshot
     JOIN workspace_members member
       ON member.workspace_id=snapshot.workspace_id
      AND member.user_id=?
     JOIN users user ON user.user_id=member.user_id
     WHERE snapshot.workspace_id=?`,
  ).get(userId, workspaceId) as unknown as AccessRevisionRow;
}

function raceAfterCommittedBatch(
  database: D1DatabaseLike,
  race: () => void,
): D1DatabaseLike {
  let pending = true;
  return {
    prepare: database.prepare.bind(database),
    async batch(statements) {
      const results = await database.batch(statements);
      if (pending) {
        pending = false;
        race();
      }
      return results;
    },
  };
}

describe("member-scoped workspace catalog", () => {
  it("paginates deterministically and never grants global admins membership", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "catalog-owner");
    const admin = await user(database, "catalog-admin", { admin: true });
    const older = await workspace(
      database,
      owner,
      "Garage",
      "2026-07-24T00:00:00.000Z",
    );
    const newer = await workspace(
      database,
      owner,
      "Kitchen",
      "2026-07-25T00:00:00.000Z",
    );
    const adminOnly = await workspace(database, admin, "Admin only");
    sqlite.prepare(
      `UPDATE workspace_snapshots
       SET updated_at=?
       WHERE workspace_id=?`,
    ).run("2026-07-24T00:00:00.000Z", older.workspace.id);
    sqlite.prepare(
      `UPDATE workspace_snapshots
       SET updated_at=?
       WHERE workspace_id=?`,
    ).run("2026-07-25T00:00:00.000Z", newer.workspace.id);
    const orderedIds = [
      older.workspace.id,
      newer.workspace.id,
    ].sort();

    const first = await listMemberWorkspaces(
      database,
      owner.userId,
      new URLSearchParams({ limit: "1" }),
    );

    expect(first.workspaces.map(entry => entry.id)).toEqual([
      orderedIds[0],
    ]);
    expect(first.page).toMatchObject({
      hasMore: true,
      limit: 1,
      nextCursor: expect.any(String),
    });

    const second = await listMemberWorkspaces(
      database,
      owner.userId,
      new URLSearchParams({
        cursor: String(first.page.nextCursor),
        limit: "1",
      }),
    );
    expect(second.workspaces.map(entry => entry.id)).toEqual([
      orderedIds[1],
    ]);
    expect(second.page.hasMore).toBe(false);
    expect(first.membershipRevision).toBe(second.membershipRevision);

    await addMember(
      database,
      adminOnly.workspace.id,
      owner,
      "viewer",
      "2026-07-25T02:00:00.000Z",
    );
    await expect(listMemberWorkspaces(
      database,
      owner.userId,
      new URLSearchParams({
        cursor: String(first.page.nextCursor),
        limit: "1",
      }),
    )).rejects.toMatchObject({
      code: "ACCESS_STALE",
      status: 409,
    });

    const searched = await listMemberWorkspaces(
      database,
      owner.userId,
      new URLSearchParams({ q: "kit" }),
    );
    expect(searched.workspaces.map(entry => entry.name)).toEqual(["Kitchen"]);

    const adminCatalog = await listMemberWorkspaces(
      database,
      admin.userId,
      new URLSearchParams(),
    );
    expect(adminCatalog.workspaces.map(entry => entry.name)).toEqual([
      "Admin only",
    ]);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(newer.workspace.id, admin.userId)).toEqual({ count: 0 });
  });

  it("does not omit or duplicate workspaces updated between catalog pages", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "catalog-update-owner");
    const states = await Promise.all([
      workspace(database, owner, "Alpha"),
      workspace(database, owner, "Bravo"),
      workspace(database, owner, "Charlie"),
    ]);
    const orderedIds = states
      .map(state => state.workspace.id)
      .sort();
    const initialUpdates = [
      "2026-07-25T03:00:00.000Z",
      "2026-07-25T02:00:00.000Z",
      "2026-07-25T01:00:00.000Z",
    ];
    for (const [index, workspaceId] of orderedIds.entries()) {
      sqlite.prepare(
        `UPDATE workspace_snapshots
         SET updated_at=?
         WHERE workspace_id=?`,
      ).run(initialUpdates[index], workspaceId);
    }

    const first = await listMemberWorkspaces(
      database,
      owner.userId,
      new URLSearchParams({ limit: "1" }),
    );
    expect(first.workspaces.map(entry => entry.id)).toEqual([orderedIds[0]]);

    sqlite.prepare(
      `UPDATE workspace_snapshots
       SET updated_at=?
       WHERE workspace_id=?`,
    ).run("2026-07-25T04:00:00.000Z", orderedIds[1]);

    const seenIds = first.workspaces.map(entry => entry.id);
    let cursor = first.page.nextCursor;
    while (cursor) {
      const page = await listMemberWorkspaces(
        database,
        owner.userId,
        new URLSearchParams({ cursor, limit: "1" }),
      );
      seenIds.push(...page.workspaces.map(entry => entry.id));
      cursor = page.page.nextCursor;
    }

    expect(seenIds).toEqual(orderedIds);
    expect(new Set(seenIds).size).toBe(orderedIds.length);
  });

  it("returns role-derived capabilities and dynamic final-owner leave state", async () => {
    const { database } = numberedMigrationDatabase();
    const owner = await user(database, "capability-owner");
    const secondOwner = await user(database, "capability-second");
    const viewer = await user(database, "capability-viewer");
    const state = await workspace(database, owner, "Shared");
    await addMember(database, state.workspace.id, viewer, "viewer");

    const before = await getWorkspaceAccess(
      database,
      state.workspace.id,
      owner.userId,
    );
    expect(before.access).toMatchObject({
      capabilities: {
        delete: true,
        leave: false,
        manageAccess: true,
        read: true,
        write: true,
      },
      role: "owner",
    });

    await addMember(database, state.workspace.id, secondOwner, "owner");
    const after = await getWorkspaceAccess(
      database,
      state.workspace.id,
      owner.userId,
    );
    expect(after.access).toMatchObject({
      capabilities: { leave: true },
    });

    const viewerAccess = await getWorkspaceAccess(
      database,
      state.workspace.id,
      viewer.userId,
    );
    expect(viewerAccess).not.toHaveProperty("usage");
    expect(viewerAccess.access).toMatchObject({
      capabilities: {
        delete: false,
        leave: true,
        manageAccess: false,
        read: true,
        write: false,
      },
      role: "viewer",
    });
  });

  it("treats disabled owner memberships as inactive for leave guards", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "active-final-owner");
    const disabledOwner = await user(database, "disabled-owner");
    const state = await workspace(database, owner, "Active owner");
    await addMember(database, state.workspace.id, disabledOwner, "owner");
    sqlite.prepare(
      "UPDATE users SET status='disabled' WHERE user_id=?",
    ).run(disabledOwner.userId);
    const ownerBefore = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );

    const access = await getWorkspaceAccess(
      database,
      state.workspace.id,
      owner.userId,
    );
    expect(access.access).toMatchObject({
      capabilities: { leave: false },
      role: "owner",
    });
    const catalog = await listMemberWorkspaces(
      database,
      owner.userId,
      new URLSearchParams(),
    );
    expect(catalog.workspaces).toEqual([
      expect.objectContaining({
        capabilities: expect.objectContaining({ leave: false }),
        id: state.workspace.id,
      }),
    ]);
    await expect(changeWorkspaceMemberRole(
      database,
      state.workspace.id,
      owner.userId,
      owner.userId,
      {
        expectedAccessRevision: ownerBefore.access_revision,
        expectedMembershipRevision: ownerBefore.membership_revision,
        role: "editor",
      },
    )).rejects.toMatchObject({
      code: "FINAL_OWNER_REQUIRED",
      status: 409,
    });
    await expect(leaveWorkspace(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: ownerBefore.access_revision,
        expectedMembershipRevision: ownerBefore.membership_revision,
      },
    )).rejects.toMatchObject({
      code: "FINAL_OWNER_REQUIRED",
      status: 409,
    });

    const disabledBefore = revisions(
      sqlite,
      state.workspace.id,
      disabledOwner.userId,
    );
    await expect(removeWorkspaceMember(
      database,
      state.workspace.id,
      owner.userId,
      disabledOwner.userId,
      {
        expectedAccessRevision: disabledBefore.access_revision,
        expectedMembershipRevision: disabledBefore.membership_revision,
      },
    )).resolves.toMatchObject({
      removed: { userId: disabledOwner.userId },
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members member
       JOIN users member_user ON member_user.user_id=member.user_id
       WHERE member.workspace_id=?
         AND member.role='owner'
         AND member_user.status='active'`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
  });
});

describe("owner member management", () => {
  it("changes roles atomically, rejects no-ops, and emits no false audit", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "role-owner");
    const target = await user(database, "role-target");
    const state = await workspace(database, owner, "Roles");
    await addMember(database, state.workspace.id, target, "viewer");
    const before = revisions(sqlite, state.workspace.id, target.userId);

    const changed = await changeWorkspaceMemberRole(
      database,
      state.workspace.id,
      owner.userId,
      target.userId,
      {
        expectedAccessRevision: before.access_revision,
        expectedMembershipRevision: before.membership_revision,
        role: "editor",
      },
    );

    expect(changed.member).toMatchObject({
      membershipRevision: before.membership_revision + 1,
      role: "editor",
      userId: target.userId,
    });
    expect(changed.accessRevision).toBe(before.access_revision + 1);
    expect(sqlite.prepare(
      "SELECT action,target_id FROM auth_audit_events",
    ).all()).toEqual([{
      action: "member.role",
      target_id: `${state.workspace.id}::${target.userId}`,
    }]);

    await expect(changeWorkspaceMemberRole(
      database,
      state.workspace.id,
      owner.userId,
      target.userId,
      {
        expectedAccessRevision: changed.accessRevision,
        expectedMembershipRevision:
          changed.member.membershipRevision,
        role: "editor",
      },
    )).rejects.toMatchObject({
      code: "ROLE_UNCHANGED",
      status: 409,
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM auth_audit_events",
    ).get()).toEqual({ count: 1 });
  });

  it("rejects disabled ownership targets without an audit event", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "disabled-target-owner");
    const target = await user(database, "disabled-target");
    const state = await workspace(database, owner, "Disabled target");
    await addMember(database, state.workspace.id, target, "editor");
    sqlite.prepare(
      "UPDATE users SET status='disabled' WHERE user_id=?",
    ).run(target.userId);
    const actorBefore = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );
    const targetBefore = revisions(
      sqlite,
      state.workspace.id,
      target.userId,
    );

    await expect(changeWorkspaceMemberRole(
      database,
      state.workspace.id,
      owner.userId,
      target.userId,
      {
        expectedAccessRevision: targetBefore.access_revision,
        expectedMembershipRevision: targetBefore.membership_revision,
        role: "owner",
      },
    )).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      detail: {
        member: { userId: target.userId },
      },
      message: expect.stringMatching(/disabled account/),
      status: 409,
    });
    await expect(transferWorkspaceOwnership(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: actorBefore.access_revision,
        expectedActorMembershipRevision:
          actorBefore.membership_revision,
        expectedTargetMembershipRevision:
          targetBefore.membership_revision,
        targetUserId: target.userId,
      },
    )).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      detail: {
        member: { userId: target.userId },
      },
      message: expect.stringMatching(/disabled account/),
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT role FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, target.userId)).toEqual({ role: "editor" });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM auth_audit_events",
    ).get()).toEqual({ count: 0 });
  });

  it("transfers ownership explicitly and removes a non-owner", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "transfer-owner");
    const target = await user(database, "transfer-target");
    const removable = await user(database, "transfer-removable");
    const state = await workspace(database, owner, "Transfer");
    await addMember(database, state.workspace.id, target, "editor");
    await addMember(database, state.workspace.id, removable, "viewer");
    const actorBefore = revisions(sqlite, state.workspace.id, owner.userId);
    const targetBefore = revisions(sqlite, state.workspace.id, target.userId);

    const transferred = await transferWorkspaceOwnership(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: actorBefore.access_revision,
        expectedActorMembershipRevision:
          actorBefore.membership_revision,
        expectedTargetMembershipRevision:
          targetBefore.membership_revision,
        targetUserId: target.userId,
      },
    );

    expect(transferred.actor.role).toBe("editor");
    expect(transferred.target.role).toBe("owner");
    expect(transferred.accessRevision).toBe(
      actorBefore.access_revision + 2,
    );

    const removableBefore = revisions(
      sqlite,
      state.workspace.id,
      removable.userId,
    );
    const removed = await removeWorkspaceMember(
      database,
      state.workspace.id,
      target.userId,
      removable.userId,
      {
        expectedAccessRevision: removableBefore.access_revision,
        expectedMembershipRevision:
          removableBefore.membership_revision,
      },
    );
    expect(removed.removed).toMatchObject({ userId: removable.userId });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, removable.userId)).toEqual({ count: 0 });
  });

  it("returns committed member mutations if the actor loses access before the response", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const actor = await user(database, "truthful-member-actor");
    const otherOwner = await user(
      database,
      "truthful-member-other-owner",
    );
    const roleTarget = await user(
      database,
      "truthful-member-role-target",
    );
    const roleState = await workspace(
      database,
      actor,
      "Truthful role response",
    );
    await addMember(
      database,
      roleState.workspace.id,
      otherOwner,
      "owner",
    );
    await addMember(
      database,
      roleState.workspace.id,
      roleTarget,
      "viewer",
    );
    const roleBefore = revisions(
      sqlite,
      roleState.workspace.id,
      roleTarget.userId,
    );
    const changed = await changeWorkspaceMemberRole(
      raceAfterCommittedBatch(database, () => {
        sqlite.prepare(
          `DELETE FROM workspace_members
           WHERE workspace_id=? AND user_id=?`,
        ).run(roleState.workspace.id, actor.userId);
      }),
      roleState.workspace.id,
      actor.userId,
      roleTarget.userId,
      {
        expectedAccessRevision: roleBefore.access_revision,
        expectedMembershipRevision:
          roleBefore.membership_revision,
        role: "editor",
      },
    );
    expect(changed).toMatchObject({
      accessRevision: roleBefore.access_revision + 1,
      member: {
        role: "editor",
        userId: roleTarget.userId,
      },
    });

    const removalActor = await user(
      database,
      "truthful-removal-actor",
    );
    const removalOwner = await user(
      database,
      "truthful-removal-owner",
    );
    const removable = await user(
      database,
      "truthful-removal-target",
    );
    const removalState = await workspace(
      database,
      removalActor,
      "Truthful removal response",
    );
    await addMember(
      database,
      removalState.workspace.id,
      removalOwner,
      "owner",
    );
    await addMember(
      database,
      removalState.workspace.id,
      removable,
      "viewer",
    );
    const removalBefore = revisions(
      sqlite,
      removalState.workspace.id,
      removable.userId,
    );
    const removed = await removeWorkspaceMember(
      raceAfterCommittedBatch(database, () => {
        sqlite.prepare(
          `DELETE FROM workspace_members
           WHERE workspace_id=? AND user_id=?`,
        ).run(removalState.workspace.id, removalActor.userId);
      }),
      removalState.workspace.id,
      removalActor.userId,
      removable.userId,
      {
        expectedAccessRevision:
          removalBefore.access_revision,
        expectedMembershipRevision:
          removalBefore.membership_revision,
      },
    );
    expect(removed).toMatchObject({
      accessRevision: removalBefore.access_revision + 1,
      removed: { userId: removable.userId },
    });

    const transferActor = await user(
      database,
      "truthful-transfer-actor",
    );
    const successor = await user(
      database,
      "truthful-transfer-successor",
    );
    const transferState = await workspace(
      database,
      transferActor,
      "Truthful transfer response",
    );
    await addMember(
      database,
      transferState.workspace.id,
      successor,
      "editor",
    );
    const transferActorBefore = revisions(
      sqlite,
      transferState.workspace.id,
      transferActor.userId,
    );
    const successorBefore = revisions(
      sqlite,
      transferState.workspace.id,
      successor.userId,
    );
    const transferred = await transferWorkspaceOwnership(
      raceAfterCommittedBatch(database, () => {
        sqlite.prepare(
          `DELETE FROM workspace_members
           WHERE workspace_id=? AND user_id=?`,
        ).run(transferState.workspace.id, transferActor.userId);
      }),
      transferState.workspace.id,
      transferActor.userId,
      {
        expectedAccessRevision:
          transferActorBefore.access_revision,
        expectedActorMembershipRevision:
          transferActorBefore.membership_revision,
        expectedTargetMembershipRevision:
          successorBefore.membership_revision,
        targetUserId: successor.userId,
      },
    );
    expect(transferred).toMatchObject({
      accessRevision: transferActorBefore.access_revision + 2,
      actor: {
        role: "editor",
        userId: transferActor.userId,
      },
      target: {
        role: "owner",
        userId: successor.userId,
      },
    });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(transferState.workspace.id, successor.userId)).toEqual({
      role: "owner",
    });
  });

  it("protects final owners and denies member lists to editors", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "final-owner");
    const editor = await user(database, "final-editor");
    const state = await workspace(database, owner, "Final");
    await addMember(database, state.workspace.id, editor, "editor");
    const ownerState = revisions(sqlite, state.workspace.id, owner.userId);

    await expect(changeWorkspaceMemberRole(
      database,
      state.workspace.id,
      owner.userId,
      owner.userId,
      {
        expectedAccessRevision: ownerState.access_revision,
        expectedMembershipRevision: ownerState.membership_revision,
        role: "editor",
      },
    )).rejects.toMatchObject({
      code: "FINAL_OWNER_REQUIRED",
      status: 409,
    });

    await expect(leaveWorkspace(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: ownerState.access_revision,
        expectedMembershipRevision: ownerState.membership_revision,
      },
    )).rejects.toMatchObject({
      code: "FINAL_OWNER_REQUIRED",
      status: 409,
    });

    await expect(listWorkspaceMembers(
      database,
      state.workspace.id,
      editor.userId,
      new URLSearchParams(),
    )).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
      status: 403,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action IN ('member.role','member.leave')`,
    ).get()).toEqual({ count: 0 });
  });

  it("keeps an owner under concurrent demotions", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const first = await user(database, "concurrent-first");
    const second = await user(database, "concurrent-second");
    const state = await workspace(database, first, "Concurrent owners");
    await addMember(database, state.workspace.id, second, "owner");
    const firstBefore = revisions(sqlite, state.workspace.id, first.userId);
    const secondBefore = revisions(sqlite, state.workspace.id, second.userId);

    const results = await Promise.allSettled([
      changeWorkspaceMemberRole(
        database,
        state.workspace.id,
        first.userId,
        first.userId,
        {
          expectedAccessRevision: firstBefore.access_revision,
          expectedMembershipRevision: firstBefore.membership_revision,
          role: "editor",
        },
      ),
      changeWorkspaceMemberRole(
        database,
        state.workspace.id,
        second.userId,
        second.userId,
        {
          expectedAccessRevision: secondBefore.access_revision,
          expectedMembershipRevision: secondBefore.membership_revision,
          role: "editor",
        },
      ),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members
       WHERE workspace_id=? AND role='owner'`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
       WHERE action='member.role'`,
    ).get()).toEqual({ count: 1 });
  });

  it("enforces the owner quota during concurrent role promotions", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const target = await user(database, "promotion-quota-target");
    const firstOwner = await user(
      database,
      "promotion-quota-first-owner",
    );
    const secondOwner = await user(
      database,
      "promotion-quota-second-owner",
    );
    await addOwnedWorkspaceFixtures(
      database,
      target,
      API_QUOTAS.ownedWorkspacesPerUser - 1,
    );
    const first = await workspace(
      database,
      firstOwner,
      "First promotion candidate",
    );
    const second = await workspace(
      database,
      secondOwner,
      "Second promotion candidate",
    );
    await addMember(
      database,
      first.workspace.id,
      target,
      "editor",
    );
    await addMember(
      database,
      second.workspace.id,
      target,
      "editor",
    );
    const firstBefore = revisions(
      sqlite,
      first.workspace.id,
      target.userId,
    );
    const secondBefore = revisions(
      sqlite,
      second.workspace.id,
      target.userId,
    );

    const results = await Promise.allSettled([
      changeWorkspaceMemberRole(
        database,
        first.workspace.id,
        firstOwner.userId,
        target.userId,
        {
          expectedAccessRevision: firstBefore.access_revision,
          expectedMembershipRevision:
            firstBefore.membership_revision,
          role: "owner",
        },
      ),
      changeWorkspaceMemberRole(
        database,
        second.workspace.id,
        secondOwner.userId,
        target.userId,
        {
          expectedAccessRevision: secondBefore.access_revision,
          expectedMembershipRevision:
            secondBefore.membership_revision,
          role: "owner",
        },
      ),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find(
      result => result.status === "rejected",
    );
    expect(
      rejected?.status === "rejected"
        ? rejected.reason
        : null,
    ).toMatchObject({
      code: "QUOTA_EXCEEDED",
      quota: "ownedWorkspacesPerUser",
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE user_id=? AND role='owner'`,
    ).get(target.userId)).toEqual({
      count: API_QUOTAS.ownedWorkspacesPerUser,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='member.role'`,
    ).get()).toEqual({ count: 1 });
  });

  it("enforces the owner quota during concurrent ownership transfers", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const target = await user(database, "transfer-quota-target");
    const firstOwner = await user(
      database,
      "transfer-quota-first-owner",
    );
    const secondOwner = await user(
      database,
      "transfer-quota-second-owner",
    );
    await addOwnedWorkspaceFixtures(
      database,
      target,
      API_QUOTAS.ownedWorkspacesPerUser - 1,
    );
    const first = await workspace(
      database,
      firstOwner,
      "First transfer candidate",
    );
    const second = await workspace(
      database,
      secondOwner,
      "Second transfer candidate",
    );
    await addMember(
      database,
      first.workspace.id,
      target,
      "editor",
    );
    await addMember(
      database,
      second.workspace.id,
      target,
      "editor",
    );
    const firstActor = revisions(
      sqlite,
      first.workspace.id,
      firstOwner.userId,
    );
    const secondActor = revisions(
      sqlite,
      second.workspace.id,
      secondOwner.userId,
    );
    const firstTarget = revisions(
      sqlite,
      first.workspace.id,
      target.userId,
    );
    const secondTarget = revisions(
      sqlite,
      second.workspace.id,
      target.userId,
    );

    const results = await Promise.allSettled([
      transferWorkspaceOwnership(
        database,
        first.workspace.id,
        firstOwner.userId,
        {
          expectedAccessRevision: firstActor.access_revision,
          expectedActorMembershipRevision:
            firstActor.membership_revision,
          expectedTargetMembershipRevision:
            firstTarget.membership_revision,
          targetUserId: target.userId,
        },
      ),
      transferWorkspaceOwnership(
        database,
        second.workspace.id,
        secondOwner.userId,
        {
          expectedAccessRevision: secondActor.access_revision,
          expectedActorMembershipRevision:
            secondActor.membership_revision,
          expectedTargetMembershipRevision:
            secondTarget.membership_revision,
          targetUserId: target.userId,
        },
      ),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find(
      result => result.status === "rejected",
    );
    expect(
      rejected?.status === "rejected"
        ? rejected.reason
        : null,
    ).toMatchObject({
      code: "QUOTA_EXCEEDED",
      quota: "ownedWorkspacesPerUser",
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE user_id=? AND role='owner'`,
    ).get(target.userId)).toEqual({
      count: API_QUOTAS.ownedWorkspacesPerUser,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='ownership.transfer'`,
    ).get()).toEqual({ count: 1 });
  });

  it("returns no private data to another workspace owner or global admin", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "private-owner");
    const outsider = await user(database, "private-admin", { admin: true });
    const state = await workspace(database, owner, "Private workspace");
    await workspace(database, outsider, "Outsider workspace");
    const before = revisions(sqlite, state.workspace.id, owner.userId);

    await expect(getWorkspaceAccess(
      database,
      state.workspace.id,
      outsider.userId,
    )).rejects.toMatchObject({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      status: 404,
    });
    await expect(listWorkspaceMembers(
      database,
      state.workspace.id,
      outsider.userId,
      new URLSearchParams(),
    )).rejects.toMatchObject({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      status: 404,
    });
    await expect(deleteServerWorkspace(
      database,
      state.workspace.id,
      outsider.userId,
      {
        confirmationName: "Private workspace",
        expectedAccessRevision: before.access_revision,
        expectedMembershipRevision: before.membership_revision,
        expectedRevision: before.revision,
      },
    )).rejects.toMatchObject({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      status: 404,
    });
  });
});

describe("owner guest-link lifecycle", () => {
  it("validates expiry, returns raw material once, and refuses stale revocation", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "link-owner");
    const state = await workspace(database, owner, "Links");
    const before = revisions(sqlite, state.workspace.id, owner.userId);

    await expect(createWorkspaceGuestLink(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: before.access_revision,
        expiresInHours: 169,
        role: "viewer",
      },
    )).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });

    const created = await createWorkspaceGuestLink(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: before.access_revision,
        expiresInHours: 48,
        role: "editor",
      },
    );
    expect(created.raw).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(created.guestLink).toMatchObject({
      role: "editor",
      status: "active",
    });

    const listed = await listWorkspaceGuestLinks(
      database,
      state.workspace.id,
      owner.userId,
      new URLSearchParams(),
    );
    expect(listed.guestLinks).toEqual([created.guestLink]);
    expect(JSON.stringify(listed)).not.toContain(created.raw);
    expect(JSON.stringify(sqlite.prepare(
      "SELECT detail_json FROM auth_audit_events",
    ).all())).not.toContain(created.raw);

    const revoked = await revokeWorkspaceGuestLink(
      database,
      state.workspace.id,
      owner.userId,
      created.guestLink.guestLinkId,
      { expectedAccessRevision: created.accessRevision },
    );
    expect(revoked.guestLink.status).toBe("revoked");

    await expect(revokeWorkspaceGuestLink(
      database,
      state.workspace.id,
      owner.userId,
      created.guestLink.guestLinkId,
      { expectedAccessRevision: revoked.accessRevision },
    )).rejects.toMatchObject({
      code: "ACCESS_STALE",
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='guest.revoke'`,
    ).get()).toEqual({ count: 1 });
  });

  it("returns committed link results if the creator loses owner access before the response", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const creator = await user(database, "truthful-link-creator");
    const otherOwner = await user(database, "truthful-link-owner");
    const state = await workspace(
      database,
      creator,
      "Truthful link response",
    );
    await addMember(
      database,
      state.workspace.id,
      otherOwner,
      "owner",
    );
    const createBefore = revisions(
      sqlite,
      state.workspace.id,
      creator.userId,
    );
    const created = await createWorkspaceGuestLink(
      raceAfterCommittedBatch(database, () => {
        sqlite.prepare(
          `UPDATE workspace_members
           SET role='editor'
           WHERE workspace_id=? AND user_id=?`,
        ).run(state.workspace.id, creator.userId);
      }),
      state.workspace.id,
      creator.userId,
      {
        expectedAccessRevision: createBefore.access_revision,
        expiresInHours: 24,
        role: "viewer",
      },
    );
    expect(created).toMatchObject({
      accessRevision: createBefore.access_revision + 1,
      guestLink: {
        role: "viewer",
        status: "active",
      },
      raw: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
    });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, creator.userId)).toEqual({
      role: "editor",
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM guest_links
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ count: 1 });

    const revokeBefore = revisions(
      sqlite,
      state.workspace.id,
      otherOwner.userId,
    );
    const revoked = await revokeWorkspaceGuestLink(
      raceAfterCommittedBatch(database, () => {
        sqlite.prepare(
          `DELETE FROM workspace_members
           WHERE workspace_id=? AND user_id=?`,
        ).run(state.workspace.id, otherOwner.userId);
      }),
      state.workspace.id,
      otherOwner.userId,
      created.guestLink.guestLinkId,
      { expectedAccessRevision: revokeBefore.access_revision },
    );
    expect(revoked).toMatchObject({
      accessRevision: revokeBefore.access_revision + 1,
      guestLink: {
        guestLinkId: created.guestLink.guestLinkId,
        status: "revoked",
      },
    });
    expect(sqlite.prepare(
      `SELECT action
       FROM auth_audit_events
       WHERE target_id=? ORDER BY rowid`,
    ).all(created.guestLink.guestLinkId)).toEqual([
      { action: "guest.create" },
      { action: "guest.revoke" },
    ]);
  });

  it("enforces the active-link quota under concurrent creation", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "link-quota-owner");
    const state = await workspace(database, owner, "Link quota");
    for (
      let index = 0;
      index < API_QUOTAS.activeGuestLinksPerWorkspace - 1;
      index += 1
    ) {
      sqlite.prepare(
        `INSERT INTO guest_links(
           guest_link_id,workspace_id,created_by_user_id,token_hash,
           role,created_at,expires_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `guest_quota_${index}`,
        state.workspace.id,
        owner.userId,
        `hash_quota_${index}`,
        "viewer",
        "2026-07-25T00:00:00.000Z",
        "2099-07-25T00:00:00.000Z",
      );
    }
    const before = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );

    const results = await Promise.allSettled([
      createWorkspaceGuestLink(
        database,
        state.workspace.id,
        owner.userId,
        {
          expectedAccessRevision: before.access_revision,
          expiresInHours: 24,
          role: "viewer",
        },
      ),
      createWorkspaceGuestLink(
        database,
        state.workspace.id,
        owner.userId,
        {
          expectedAccessRevision: before.access_revision,
          expiresInHours: 24,
          role: "editor",
        },
      ),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find(
      result => result.status === "rejected",
    );
    expect(
      rejected?.status === "rejected"
        ? rejected.reason
        : null,
    ).toMatchObject({
      code: "QUOTA_EXCEEDED",
      quota: "activeGuestLinksPerWorkspace",
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM guest_links
       WHERE workspace_id=?
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at>?`,
    ).get(
      state.workspace.id,
      new Date().toISOString(),
    )).toEqual({
      count: API_QUOTAS.activeGuestLinksPerWorkspace,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='guest.create'`,
    ).get()).toEqual({ count: 1 });
  });

  it("enforces the retained-link quota under concurrent creation", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(
      database,
      "retained-link-quota-owner",
    );
    const state = await workspace(
      database,
      owner,
      "Retained link quota",
    );
    for (
      let index = 0;
      index < API_QUOTAS.retainedGuestLinksPerWorkspace - 1;
      index += 1
    ) {
      sqlite.prepare(
        `INSERT INTO guest_links(
           guest_link_id,workspace_id,created_by_user_id,token_hash,
           role,created_at,expires_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `guest_retained_quota_${index}`,
        state.workspace.id,
        owner.userId,
        `hash_retained_quota_${index}`,
        "viewer",
        "2020-07-25T00:00:00.000Z",
        "2020-07-26T00:00:00.000Z",
      );
    }
    const before = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );

    const results = await Promise.allSettled([
      createWorkspaceGuestLink(
        database,
        state.workspace.id,
        owner.userId,
        {
          expectedAccessRevision: before.access_revision,
          expiresInHours: 24,
          role: "viewer",
        },
      ),
      createWorkspaceGuestLink(
        database,
        state.workspace.id,
        owner.userId,
        {
          expectedAccessRevision: before.access_revision,
          expiresInHours: 24,
          role: "editor",
        },
      ),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find(
      result => result.status === "rejected",
    );
    expect(
      rejected?.status === "rejected"
        ? rejected.reason
        : null,
    ).toMatchObject({
      code: "QUOTA_EXCEEDED",
      quota: "retainedGuestLinksPerWorkspace",
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM guest_links
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({
      count: API_QUOTAS.retainedGuestLinksPerWorkspace,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='guest.create'`,
    ).get()).toEqual({ count: 1 });
  });

  it("does not let an editor create or list guest links", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "link-authority-owner");
    const editor = await user(database, "link-authority-editor");
    const state = await workspace(database, owner, "Link authority");
    await addMember(database, state.workspace.id, editor, "editor");
    const current = revisions(sqlite, state.workspace.id, editor.userId);

    await expect(createWorkspaceGuestLink(
      database,
      state.workspace.id,
      editor.userId,
      {
        expectedAccessRevision: current.access_revision,
        expiresInHours: 24,
        role: "viewer",
      },
    )).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
      status: 403,
    });
    await expect(listWorkspaceGuestLinks(
      database,
      state.workspace.id,
      editor.userId,
      new URLSearchParams(),
    )).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
      status: 403,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='guest.create'`,
    ).get()).toEqual({ count: 0 });
  });
});

describe("workspace lifecycle", () => {
  it("leaves the server membership while retaining explicit local disposition", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "leave-owner");
    const editor = await user(database, "leave-editor");
    const state = await workspace(database, owner, "Leave");
    await addMember(database, state.workspace.id, editor, "editor");
    const before = revisions(sqlite, state.workspace.id, editor.userId);

    const left = await leaveWorkspace(
      database,
      state.workspace.id,
      editor.userId,
      {
        expectedAccessRevision: before.access_revision,
        expectedMembershipRevision: before.membership_revision,
      },
    );

    expect(left).toMatchObject({
      left: true,
      localReplicaDispositionRequired: true,
      membershipRevision: before.membership_revision + 1,
      workspaceId: state.workspace.id,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, editor.userId)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
  });

  it("rejects a forged editor deletion without changing workspace data or auditing a deletion", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "forged-delete-owner");
    const editor = await user(database, "forged-delete-editor");
    const state = await workspace(
      database,
      owner,
      "Forged editor delete",
    );
    await addMember(database, state.workspace.id, editor, "editor");
    const before = revisions(
      sqlite,
      state.workspace.id,
      editor.userId,
    );
    const snapshotBefore = sqlite.prepare(
      `SELECT revision,state_json,access_revision,created_at,updated_at
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id);
    const membersBefore = sqlite.prepare(
      `SELECT user_id,role,created_at
       FROM workspace_members
       WHERE workspace_id=?
       ORDER BY user_id`,
    ).all(state.workspace.id);

    await expect(deleteServerWorkspace(
      database,
      state.workspace.id,
      editor.userId,
      {
        confirmationName: state.workspace.name,
        expectedAccessRevision: before.access_revision,
        expectedMembershipRevision: before.membership_revision,
        expectedRevision: before.revision,
      },
    )).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
      status: 403,
    });

    expect(sqlite.prepare(
      `SELECT revision,state_json,access_revision,created_at,updated_at
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual(snapshotBefore);
    expect(sqlite.prepare(
      `SELECT user_id,role,created_at
       FROM workspace_members
       WHERE workspace_id=?
       ORDER BY user_id`,
    ).all(state.workspace.id)).toEqual(membersBefore);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.delete'`,
    ).get()).toEqual({ count: 0 });
  });

  it("serializes deletion against concurrent access changes", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "delete-access-owner");
    const target = await user(database, "delete-access-target");
    const state = await workspace(
      database,
      owner,
      "Delete access race",
    );
    await addMember(
      database,
      state.workspace.id,
      target,
      "viewer",
    );
    const ownerBefore = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );
    const targetBefore = revisions(
      sqlite,
      state.workspace.id,
      target.userId,
    );

    const results = await Promise.allSettled([
      deleteServerWorkspace(
        database,
        state.workspace.id,
        owner.userId,
        {
          confirmationName: state.workspace.name,
          expectedAccessRevision:
            ownerBefore.access_revision,
          expectedMembershipRevision:
            ownerBefore.membership_revision,
          expectedRevision: ownerBefore.revision,
        },
      ),
      changeWorkspaceMemberRole(
        database,
        state.workspace.id,
        owner.userId,
        target.userId,
        {
          expectedAccessRevision:
            targetBefore.access_revision,
          expectedMembershipRevision:
            targetBefore.membership_revision,
          role: "editor",
        },
      ),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find(
      result => result.status === "rejected",
    );
    expect(
      rejected?.status === "rejected"
        ? rejected.reason
        : null,
    ).toMatchObject({
      code: expect.stringMatching(
        /^(ACCESS_STALE|WORKSPACE_DELETED)$/u,
      ),
      status: expect.any(Number),
    });
    const deletion = sqlite.prepare(
      `SELECT deletion_id
       FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(state.workspace.id);
    const auditActions = sqlite.prepare(
      `SELECT action
       FROM auth_audit_events
       WHERE action IN ('member.role','workspace.delete')`,
    ).all();
    expect(auditActions).toHaveLength(1);
    if (deletion) {
      expect(auditActions).toEqual([{ action: "workspace.delete" }]);
      expect(sqlite.prepare(
        `SELECT workspace_id
         FROM workspace_snapshots
         WHERE workspace_id=?`,
      ).get(state.workspace.id)).toBeUndefined();
    } else {
      expect(auditActions).toEqual([{ action: "member.role" }]);
      expect(sqlite.prepare(
        `SELECT role
         FROM workspace_members
         WHERE workspace_id=? AND user_id=?`,
      ).get(state.workspace.id, target.userId)).toEqual({
        role: "editor",
      });
    }
  });

  it("serializes deletion against guest-link redemption", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "delete-redemption-owner");
    const recipient = await user(database, "delete-redemption-recipient");
    const state = await workspace(
      database,
      owner,
      "Delete redemption race",
    );
    const linkBefore = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );
    const link = await createWorkspaceGuestLink(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: linkBefore.access_revision,
        expiresInHours: 24,
        role: "viewer",
      },
    );
    const deleteBefore = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );

    const results = await Promise.allSettled([
      deleteServerWorkspace(
        database,
        state.workspace.id,
        owner.userId,
        {
          confirmationName: state.workspace.name,
          expectedAccessRevision:
            deleteBefore.access_revision,
          expectedMembershipRevision:
            deleteBefore.membership_revision,
          expectedRevision: deleteBefore.revision,
        },
      ),
      consumeGuestLink(
        database,
        link.raw,
        recipient.userId,
      ),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    const deletion = sqlite.prepare(
      `SELECT deletion_id
       FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(state.workspace.id);
    const deleteResult = results[0];
    if (deletion) {
      expect(deleteResult.status).toBe("fulfilled");
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_members
         WHERE workspace_id=? AND user_id=?`,
      ).get(state.workspace.id, recipient.userId)).toEqual({ count: 0 });
    } else {
      expect(deleteResult.status).toBe("rejected");
      expect(
        deleteResult.status === "rejected"
          ? deleteResult.reason
          : null,
      ).toMatchObject({
        code: "ACCESS_STALE",
        status: 409,
      });
      expect(sqlite.prepare(
        `SELECT role
         FROM workspace_members
         WHERE workspace_id=? AND user_id=?`,
      ).get(state.workspace.id, recipient.userId)).toEqual({
        role: "viewer",
      });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_members
         WHERE workspace_id=?`,
      ).get(state.workspace.id)).toEqual({ count: 2 });
    }
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.delete'`,
    ).get()).toEqual({ count: deletion ? 1 : 0 });
  });

  it("serializes deletion against authorized snapshot writes", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "delete-sync-owner");
    const state = await workspace(
      database,
      owner,
      "Delete sync race",
    );
    const before = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );
    const updated = structuredClone(state);
    updated.workspace.name = "Synced before deletion";
    updated.workspace.revision += 1;
    updated.workspace.updatedAt = "2026-07-25T12:00:00.000Z";
    const store = new D1SnapshotStore(database);

    const results = await Promise.allSettled([
      deleteServerWorkspace(
        database,
        state.workspace.id,
        owner.userId,
        {
          confirmationName: state.workspace.name,
          expectedAccessRevision: before.access_revision,
          expectedMembershipRevision:
            before.membership_revision,
          expectedRevision: before.revision,
        },
      ),
      store.compareAndSwapAuthorized(
        state.workspace.id,
        state.workspace.revision,
        updated,
        {
          accessRevision: before.access_revision,
          membershipRevision: before.membership_revision,
          requiredRole: "writer",
          userId: owner.userId,
        },
      ),
    ]);

    const deleteSucceeded = results[0]?.status === "fulfilled";
    const syncSucceeded = results[1]?.status === "fulfilled" &&
      results[1].value;
    expect(Number(deleteSucceeded) + Number(syncSucceeded)).toBe(1);
    if (!deleteSucceeded) {
      const deleteResult = results[0];
      expect(
        deleteResult?.status === "rejected"
          ? deleteResult.reason
          : null,
      ).toMatchObject({
        code: "WORKSPACE_BUSY",
        status: 409,
      });
      expect(sqlite.prepare(
        `SELECT revision
         FROM workspace_snapshots
         WHERE workspace_id=?`,
      ).get(state.workspace.id)).toEqual({
        revision: updated.workspace.revision,
      });
    } else {
      expect(syncSucceeded).toBe(false);
      expect(sqlite.prepare(
        `SELECT workspace_id
         FROM workspace_snapshots
         WHERE workspace_id=?`,
      ).get(state.workspace.id)).toBeUndefined();
    }
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.delete'`,
    ).get()).toEqual({ count: deleteSucceeded ? 1 : 0 });
  });

  it("rolls back deletion when its audit cannot be recorded", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "delete-audit-owner");
    const state = await workspace(
      database,
      owner,
      "Delete audit rollback",
    );
    const before = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );
    sqlite.exec(`
      CREATE TRIGGER fail_workspace_delete_audit
      BEFORE INSERT ON auth_audit_events
      WHEN NEW.action='workspace.delete'
      BEGIN
        SELECT RAISE(ABORT, 'injected workspace delete audit failure');
      END
    `);

    const error = await deleteServerWorkspace(
      database,
      state.workspace.id,
      owner.userId,
      {
        confirmationName: state.workspace.name,
        expectedAccessRevision: before.access_revision,
        expectedMembershipRevision: before.membership_revision,
        expectedRevision: before.revision,
      },
    ).then(
      () => null,
      failure => failure,
    );
    const response = workspaceAccessErrorResponse(error);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "INTERNAL_ERROR",
      error: "The request could not be completed",
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_deletions
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.delete'`,
    ).get()).toEqual({ count: 0 });
  });

  it("revokes only an orphaned guest-only session during deletion", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "delete-session-owner");
    const accountMember = await user(
      database,
      "delete-session-account",
    );
    const orphanedGuest = await createOrLinkUser(database, {}, {
      displayName: "Orphaned guest",
      email: "delete-session-orphan@example.test",
      provider: "guest",
      subject: "delete-session-orphan",
    });
    const sharedGuest = await createOrLinkUser(database, {}, {
      displayName: "Shared guest",
      email: "delete-session-shared@example.test",
      provider: "guest",
      subject: "delete-session-shared",
    });
    const state = await workspace(
      database,
      owner,
      "Delete guest sessions",
    );
    const otherState = await workspace(
      database,
      owner,
      "Guest remains reachable",
    );
    await addMember(
      database,
      state.workspace.id,
      accountMember,
      "editor",
    );
    await addMember(
      database,
      state.workspace.id,
      orphanedGuest,
      "viewer",
    );
    await addMember(
      database,
      state.workspace.id,
      sharedGuest,
      "viewer",
    );
    await addMember(
      database,
      otherState.workspace.id,
      sharedGuest,
      "viewer",
    );
    const sessionCreatedAt = "2026-07-25T00:00:00.000Z";
    const sessionExpiresAt = "2100-01-01T00:00:00.000Z";
    for (const fixture of [
      {
        sessionId: "ses_delete_account",
        tokenHash: "hash_delete_account",
        userId: accountMember.userId,
      },
      {
        sessionId: "ses_delete_orphan_guest",
        tokenHash: "hash_delete_orphan_guest",
        userId: orphanedGuest.userId,
      },
      {
        sessionId: "ses_delete_shared_guest",
        tokenHash: "hash_delete_shared_guest",
        userId: sharedGuest.userId,
      },
    ]) {
      sqlite.prepare(
        `INSERT INTO sessions(
           session_id,user_id,token_hash,created_at,expires_at,last_seen_at
         ) VALUES(?,?,?,?,?,?)`,
      ).run(
        fixture.sessionId,
        fixture.userId,
        fixture.tokenHash,
        sessionCreatedAt,
        sessionExpiresAt,
        sessionCreatedAt,
      );
    }
    const before = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );

    const deleted = await deleteServerWorkspace(
      database,
      state.workspace.id,
      owner.userId,
      {
        confirmationName: state.workspace.name,
        expectedAccessRevision: before.access_revision,
        expectedMembershipRevision: before.membership_revision,
        expectedRevision: before.revision,
      },
    );

    expect(sqlite.prepare(
      `SELECT session_id,revoked_at
       FROM sessions
       WHERE session_id LIKE 'ses_delete_%'
       ORDER BY session_id`,
    ).all()).toEqual([
      {
        revoked_at: null,
        session_id: "ses_delete_account",
      },
      {
        revoked_at: deleted.deletedAt,
        session_id: "ses_delete_orphan_guest",
      },
      {
        revoked_at: null,
        session_id: "ses_delete_shared_guest",
      },
    ]);
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(otherState.workspace.id, sharedGuest.userId)).toEqual({
      role: "viewer",
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(otherState.workspace.id)).toEqual({ count: 1 });
  });

  it("deletes server data immediately and preserves only non-secret tombstone and audit state", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await user(database, "delete-owner");
    const editor = await user(database, "delete-editor");
    const outsider = await user(database, "delete-outsider", { admin: true });
    const state = await workspace(database, owner, "Delete exactly");
    await addMember(database, state.workspace.id, editor, "editor");
    const linkAccess = revisions(sqlite, state.workspace.id, owner.userId);
    const guestLink = await createWorkspaceGuestLink(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: linkAccess.access_revision,
        expiresInHours: 24,
        role: "viewer",
      },
    );
    const before = revisions(sqlite, state.workspace.id, owner.userId);

    await expect(deleteServerWorkspace(
      database,
      state.workspace.id,
      owner.userId,
      {
        confirmationName: "Wrong",
        expectedAccessRevision: before.access_revision,
        expectedMembershipRevision: before.membership_revision,
        expectedRevision: before.revision,
      },
    )).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.delete'`,
    ).get()).toEqual({ count: 0 });

    const deleted = await deleteServerWorkspace(
      database,
      state.workspace.id,
      owner.userId,
      {
        confirmationName: "Delete exactly",
        expectedAccessRevision: before.access_revision,
        expectedMembershipRevision: before.membership_revision,
        expectedRevision: before.revision,
      },
    );

    expect(deleted).toMatchObject({
      deleted: true,
      localReplicaDispositionRequired: true,
      recovery: "not_available",
      workspaceId: state.workspace.id,
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM workspace_snapshots WHERE workspace_id=?",
    ).get(state.workspace.id)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=?",
    ).get(state.workspace.id)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links WHERE workspace_id=?",
    ).get(state.workspace.id)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT workspace_id,deletion_id,deleted_at,deleted_by_user_id,
              final_snapshot_revision,final_access_revision
       FROM workspace_deletions WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({
      deleted_at: deleted.deletedAt,
      deleted_by_user_id: owner.userId,
      deletion_id: deleted.deletionId,
      final_access_revision: deleted.finalAccessRevision,
      final_snapshot_revision: before.revision,
      workspace_id: state.workspace.id,
    });
    const deletionAudit = sqlite.prepare(
      `SELECT actor_user_id,action,target_type,target_id,detail_json,
              created_at
       FROM auth_audit_events
       WHERE action='workspace.delete'`,
    ).get() as {
      actor_user_id: string;
      action: string;
      created_at: string;
      detail_json: string;
      target_id: string;
      target_type: string;
    };
    expect(deletionAudit).toMatchObject({
      action: "workspace.delete",
      actor_user_id: owner.userId,
      created_at: deleted.deletedAt,
      target_id: state.workspace.id,
      target_type: "workspace",
    });
    expect(JSON.parse(deletionAudit.detail_json)).toEqual({
      deletionId: deleted.deletionId,
      finalSnapshotRevision: before.revision,
      workspaceId: state.workspace.id,
    });
    expect(deletionAudit.detail_json).not.toContain(guestLink.raw);

    await expect(getWorkspaceAccess(
      database,
      state.workspace.id,
      owner.userId,
    )).rejects.toMatchObject({
      code: "WORKSPACE_DELETED",
      status: 410,
    });
    await expect(getWorkspaceAccess(
      database,
      state.workspace.id,
      outsider.userId,
    )).rejects.toMatchObject({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      status: 404,
    });
  });
});

describe("D1 trigger-inclusive change metadata", () => {
  it("uses guarded audit cardinality for every access mutation", async () => {
    const { database, sqlite } = numberedMigrationDatabase({
      triggerInclusiveChanges: true,
    });
    const owner = await user(database, "d1-owner");
    const successor = await user(database, "d1-successor");
    const member = await user(database, "d1-member");
    const state = await workspace(database, owner, "D1 parity");
    await addMember(database, state.workspace.id, successor, "editor");
    await addMember(database, state.workspace.id, member, "viewer");

    const memberBeforeRole = revisions(
      sqlite,
      state.workspace.id,
      member.userId,
    );
    await changeWorkspaceMemberRole(
      database,
      state.workspace.id,
      owner.userId,
      member.userId,
      {
        expectedAccessRevision: memberBeforeRole.access_revision,
        expectedMembershipRevision:
          memberBeforeRole.membership_revision,
        role: "editor",
      },
    );

    const beforeLink = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );
    const link = await createWorkspaceGuestLink(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: beforeLink.access_revision,
        expiresInHours: 24,
        role: "viewer",
      },
    );
    await revokeWorkspaceGuestLink(
      database,
      state.workspace.id,
      owner.userId,
      link.guestLink.guestLinkId,
      { expectedAccessRevision: link.accessRevision },
    );

    const ownerBeforeTransfer = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );
    const successorBeforeTransfer = revisions(
      sqlite,
      state.workspace.id,
      successor.userId,
    );
    await transferWorkspaceOwnership(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision:
          ownerBeforeTransfer.access_revision,
        expectedActorMembershipRevision:
          ownerBeforeTransfer.membership_revision,
        expectedTargetMembershipRevision:
          successorBeforeTransfer.membership_revision,
        targetUserId: successor.userId,
      },
    );

    const memberBeforeRemoval = revisions(
      sqlite,
      state.workspace.id,
      member.userId,
    );
    await removeWorkspaceMember(
      database,
      state.workspace.id,
      successor.userId,
      member.userId,
      {
        expectedAccessRevision:
          memberBeforeRemoval.access_revision,
        expectedMembershipRevision:
          memberBeforeRemoval.membership_revision,
      },
    );

    const ownerBeforeLeave = revisions(
      sqlite,
      state.workspace.id,
      owner.userId,
    );
    await leaveWorkspace(
      database,
      state.workspace.id,
      owner.userId,
      {
        expectedAccessRevision: ownerBeforeLeave.access_revision,
        expectedMembershipRevision:
          ownerBeforeLeave.membership_revision,
      },
    );

    expect(sqlite.prepare(
      `SELECT action
       FROM auth_audit_events
       ORDER BY rowid`,
    ).all()).toEqual([
      { action: "member.role" },
      { action: "guest.create" },
      { action: "guest.revoke" },
      { action: "ownership.transfer" },
      { action: "member.remove" },
      { action: "member.leave" },
    ]);
  });
});
