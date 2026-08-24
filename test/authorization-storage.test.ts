import { describe, expect, it } from "vitest";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import {
  applyCommand,
  createEmptyState,
  createEnvelope,
} from "../src/domain";
import type { WorkspaceState } from "../src/domain";
import {
  claimWorkspace,
  createOrLinkUser,
} from "../src/server/auth";
import { TEST_AUTH_ENV } from "./helpers/auth";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

function renamedState(
  state: WorkspaceState,
  name: string,
  id: string,
): WorkspaceState {
  return applyCommand(
    state,
    createEnvelope(
      state,
      { type: "workspace.rename", name },
      { id },
    ),
  ).state;
}

describe("authorization-aware D1 snapshot storage", () => {
  it("records server persistence time separately from client workspace time", async () => {
    const { database } = numberedMigrationDatabase();
    const store = new D1SnapshotStore(database);
    const clientTime = "2000-01-01T00:00:00.000Z";
    const initial = createEmptyState("Client clock", clientTime);

    expect(await store.initialize(initial)).toBe("created");

    const row = await database.prepare(
      `SELECT created_at, updated_at
       FROM workspace_snapshots
       WHERE workspace_id = ?`,
    ).bind(initial.workspace.id).first<{
      created_at: string;
      updated_at: string;
    }>();
    expect(row?.created_at).toBe(row?.updated_at);
    expect(row?.updated_at).not.toBe(clientTime);
    expect((await store.load(initial.workspace.id))?.workspace.updatedAt)
      .toBe(clientTime);
  });

  it("uses both authorization revisions to reject membership ABA", async () => {
    const { database } = numberedMigrationDatabase();
    const store = new D1SnapshotStore(database);
    const initial = createEmptyState("Authorization CAS");
    expect(await store.initialize(initial)).toBe("created");
    const owner = await createOrLinkUser(database, TEST_AUTH_ENV, {
      displayName: "Owner",
      email: "authorization-owner@example.test",
      provider: "test",
      subject: "authorization-owner",
    });
    await claimWorkspace(database, owner.userId, initial.workspace.id);
    expect(await store.loadAuthorization(
      initial.workspace.id,
      owner.userId,
    )).toEqual({
      accessRevision: 1,
      active: true,
      deleted: false,
      membershipRevision: 1,
      role: "owner",
    });

    const other = await createOrLinkUser(database, TEST_AUTH_ENV, {
      displayName: "Other member",
      email: "authorization-other@example.test",
      provider: "test",
      subject: "authorization-other",
    });
    await database.prepare(
      `INSERT INTO workspace_members(
         workspace_id, user_id, role, created_at
       ) VALUES(?,?,?,?)`,
    ).bind(
      initial.workspace.id,
      other.userId,
      "viewer",
      "2026-07-25T00:00:00.000Z",
    ).run();

    const afterOtherMember = renamedState(
      initial,
      "Other member did not stale the owner",
      "cmd_other_member",
    );
    expect(await store.compareAndSwapAuthorized(
      initial.workspace.id,
      initial.workspace.revision,
      afterOtherMember,
      {
        accessRevision: 1,
        membershipRevision: 1,
        requiredRole: "writer",
        userId: owner.userId,
      },
    )).toBe(true);

    const second = createEmptyState("Second authorization workspace");
    expect(await store.initialize(second)).toBe("created");
    await claimWorkspace(database, owner.userId, second.workspace.id);
    const afterOtherWorkspace = renamedState(
      afterOtherMember,
      "Other workspace did not stale this workspace",
      "cmd_other_workspace",
    );
    expect(await store.compareAndSwapAuthorized(
      initial.workspace.id,
      afterOtherMember.workspace.revision,
      afterOtherWorkspace,
      {
        accessRevision: 2,
        membershipRevision: 1,
        requiredRole: "writer",
        userId: owner.userId,
      },
    )).toBe(true);

    await database.prepare(
      `UPDATE workspace_members
       SET role = 'editor'
       WHERE workspace_id = ? AND user_id = ?`,
    ).bind(initial.workspace.id, owner.userId).run();
    const staleMembership = renamedState(
      afterOtherWorkspace,
      "Stale membership must not write",
      "cmd_stale_membership",
    );
    expect(await store.compareAndSwapAuthorized(
      initial.workspace.id,
      afterOtherWorkspace.workspace.revision,
      staleMembership,
      {
        accessRevision: 2,
        membershipRevision: 2,
        requiredRole: "writer",
        userId: owner.userId,
      },
    )).toBe(false);

    const authorization = await store.loadAuthorization(
      initial.workspace.id,
      owner.userId,
    );
    expect(authorization).toMatchObject({
      accessRevision: 3,
      membershipRevision: 3,
      role: "editor",
    });
    expect(await store.compareAndSwapAuthorized(
      initial.workspace.id,
      afterOtherWorkspace.workspace.revision,
      staleMembership,
      {
        accessRevision: authorization?.accessRevision ?? 0,
        membershipRevision: authorization?.membershipRevision ?? 0,
        requiredRole: "owner",
        userId: owner.userId,
      },
    )).toBe(false);
  });

  it("rejects viewers, disabled users, and tombstoned workspaces", async () => {
    const { database } = numberedMigrationDatabase();
    const store = new D1SnapshotStore(database);
    const initial = createEmptyState("Authorization denial");
    expect(await store.initialize(initial)).toBe("created");
    const member = await createOrLinkUser(database, TEST_AUTH_ENV, {
      displayName: "Member",
      email: "authorization-member@example.test",
      provider: "test",
      subject: "authorization-member",
    });
    await claimWorkspace(database, member.userId, initial.workspace.id);
    await database.prepare(
      `UPDATE workspace_members
       SET role = 'viewer'
       WHERE workspace_id = ? AND user_id = ?`,
    ).bind(initial.workspace.id, member.userId).run();
    expect(await store.loadAuthorized(
      initial.workspace.id,
      member.userId,
    )).toMatchObject({
      accessRevision: 2,
      membershipRevision: 2,
      role: "viewer",
      state: {
        workspace: {
          id: initial.workspace.id,
          name: initial.workspace.name,
        },
      },
    });
    const outsider = await createOrLinkUser(database, TEST_AUTH_ENV, {
      displayName: "Outsider",
      email: "authorization-outsider@example.test",
      provider: "test",
      subject: "authorization-outsider",
    });
    expect(await store.loadAuthorized(
      initial.workspace.id,
      outsider.userId,
    )).toBeNull();
    const authorization = await store.loadAuthorization(
      initial.workspace.id,
      member.userId,
    );
    const renamed = renamedState(
      initial,
      "Viewer write",
      "cmd_viewer_write",
    );
    expect(await store.compareAndSwapAuthorized(
      initial.workspace.id,
      initial.workspace.revision,
      renamed,
      {
        accessRevision: authorization?.accessRevision ?? 0,
        membershipRevision: authorization?.membershipRevision ?? 0,
        requiredRole: "writer",
        userId: member.userId,
      },
    )).toBe(false);

    await database.prepare(
      `UPDATE workspace_members
       SET role = 'editor'
       WHERE workspace_id = ? AND user_id = ?`,
    ).bind(initial.workspace.id, member.userId).run();
    await database.prepare(
      "UPDATE users SET status = 'disabled' WHERE user_id = ?",
    ).bind(member.userId).run();
    const disabledAuthorization = await store.loadAuthorization(
      initial.workspace.id,
      member.userId,
    );
    expect(disabledAuthorization?.active).toBe(false);
    expect(await store.loadAuthorized(
      initial.workspace.id,
      member.userId,
    )).toBeNull();
    expect(await store.compareAndSwapAuthorized(
      initial.workspace.id,
      initial.workspace.revision,
      renamed,
      {
        accessRevision: disabledAuthorization?.accessRevision ?? 0,
        membershipRevision:
          disabledAuthorization?.membershipRevision ?? 0,
        requiredRole: "writer",
        userId: member.userId,
      },
    )).toBe(false);

    await database.prepare(
      `INSERT INTO workspace_deletions(
         workspace_id, deletion_id, deleted_at, deleted_by_user_id,
         final_snapshot_revision, final_access_revision
       ) VALUES(?,?,?,?,?,?)`,
    ).bind(
      initial.workspace.id,
      "delete_authorization",
      "2026-07-25T00:00:00.000Z",
      member.userId,
      initial.workspace.revision,
      disabledAuthorization?.accessRevision ?? 0,
    ).run();
    await database.prepare(
      "UPDATE users SET status = 'active' WHERE user_id = ?",
    ).bind(member.userId).run();
    expect(await store.loadAuthorized(
      initial.workspace.id,
      member.userId,
    )).toBeNull();
    expect(await store.compareAndSwapAuthorized(
      initial.workspace.id,
      initial.workspace.revision,
      renamed,
      {
        accessRevision: disabledAuthorization?.accessRevision ?? 0,
        membershipRevision:
          disabledAuthorization?.membershipRevision ?? 0,
        requiredRole: "writer",
        userId: member.userId,
      },
    )).toBe(false);
  });

  it("returns batch SELECT rows and reports tombstoned initialization", async () => {
    const { database } = numberedMigrationDatabase();
    const selected = await database.batch([
      database.prepare("SELECT ? AS value").bind("batch-select"),
    ]);
    expect(selected).toEqual([
      {
        meta: { changes: 0 },
        results: [{ value: "batch-select" }],
        success: true,
      },
    ]);

    const store = new D1SnapshotStore(database);
    const deleted = createEmptyState("Deleted D1 workspace");
    await database.prepare(
      `INSERT INTO workspace_deletions(
         workspace_id, deletion_id, deleted_at, deleted_by_user_id,
         final_snapshot_revision, final_access_revision
       ) VALUES(?,?,?,?,?,?)`,
    ).bind(
      deleted.workspace.id,
      "delete_d1",
      "2026-07-25T00:00:00.000Z",
      null,
      deleted.workspace.revision,
      0,
    ).run();
    expect(await store.initialize(deleted)).toBe("deleted");
    expect(await store.load(deleted.workspace.id)).toBeNull();
  });
});
