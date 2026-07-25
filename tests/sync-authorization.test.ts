import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  type WorkspaceState,
} from "../src/domain";
import { createOrLinkUser } from "../src/server/auth";
import {
  initializeOwnedWorkspace,
  restoreOwnedWorkspace,
} from "../src/server/workspace-initialization";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

async function testUser(
  database: Parameters<typeof createOrLinkUser>[0],
  subject: string,
) {
  return createOrLinkUser(database, {}, {
    displayName: subject,
    email: `${subject}@example.test`,
    provider: "test",
    subject,
  });
}

function restoredState(
  current: WorkspaceState,
  name: string,
): WorkspaceState {
  const restored = structuredClone(current);
  restored.workspace.name = name;
  restored.workspace.revision += 1;
  restored.workspace.updatedAt = "2026-07-25T12:00:00.000Z";
  return restored;
}

describe("atomic workspace synchronization authorization", () => {
  it("creates snapshot, owner membership, and audit together", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await testUser(database, "atomic-owner");
    const state = createEmptyState("Atomic initialization");

    const initialized = await initializeOwnedWorkspace(
      database,
      owner.userId,
      state,
    );

    expect(initialized).toMatchObject({
      accessRevision: 1,
      membershipRevision: 1,
      ownerCount: 1,
      status: "created",
    });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id = ? AND user_id = ?`,
    ).get(state.workspace.id, owner.userId)).toEqual({
      role: "owner",
    });
    expect(sqlite.prepare(
      `SELECT action, actor_user_id, target_id
       FROM auth_audit_events
       WHERE action = 'workspace.claim'`,
    ).get()).toEqual({
      action: "workspace.claim",
      actor_user_id: owner.userId,
      target_id: state.workspace.id,
    });
  });

  it("recognizes initialization with D1 trigger-inclusive change metadata", async () => {
    const { database, sqlite } = numberedMigrationDatabase({
      triggerInclusiveChanges: true,
    });
    const owner = await testUser(database, "trigger-initialization-owner");
    const state = createEmptyState("Trigger initialization");

    await expect(initializeOwnedWorkspace(
      database,
      owner.userId,
      state,
    )).resolves.toMatchObject({
      accessRevision: 1,
      membershipRevision: 1,
      ownerCount: 1,
      status: "created",
    });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, owner.userId)).toEqual({
      role: "owner",
    });
  });

  it("does not claim an existing or tombstoned workspace", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const first = await testUser(database, "first-owner");
    const second = await testUser(database, "second-owner");
    const state = createEmptyState("Existing workspace");
    expect((await initializeOwnedWorkspace(
      database,
      first.userId,
      state,
    )).status).toBe("created");

    const existing = await initializeOwnedWorkspace(
      database,
      second.userId,
      state,
    );
    expect(existing.status).toBe("exists");
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id = ?`,
    ).get(state.workspace.id)).toEqual({ count: 1 });

    const deleted = createEmptyState("Deleted workspace");
    sqlite.prepare(
      `INSERT INTO workspace_deletions(
         workspace_id, deletion_id, deleted_at, deleted_by_user_id,
         final_snapshot_revision, final_access_revision
       ) VALUES(?,?,?,?,?,?)`,
    ).run(
      deleted.workspace.id,
      "delete_atomic_initialization",
      "2026-07-25T00:00:00.000Z",
      null,
      deleted.workspace.revision,
      0,
    );
    expect((await initializeOwnedWorkspace(
      database,
      second.userId,
      deleted,
    )).status).toBe("deleted");
    expect(sqlite.prepare(
      `SELECT workspace_id
       FROM workspace_snapshots
       WHERE workspace_id = ?`,
    ).get(deleted.workspace.id)).toBeUndefined();
  });

  it("restores snapshot and records its audit in one batch", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await testUser(database, "restore-owner");
    const current = createEmptyState("Before restore");
    const initialized = await initializeOwnedWorkspace(
      database,
      owner.userId,
      current,
    );
    const restored = restoredState(current, "After restore");

    const result = await restoreOwnedWorkspace(
      database,
      owner.userId,
      current.workspace.revision,
      {
        membershipRevision: initialized.membershipRevision ?? 0,
        workspaceAccessRevision: initialized.accessRevision ?? 0,
      },
      restored,
      9,
    );

    expect(result).toMatchObject({
      revision: restored.workspace.revision,
      role: "owner",
      status: "restored",
    });
    expect(JSON.parse(sqlite.prepare(
      `SELECT state_json
       FROM workspace_snapshots
       WHERE workspace_id = ?`,
    ).get(current.workspace.id)!.state_json as string)).toMatchObject({
      workspace: {
        name: "After restore",
        revision: restored.workspace.revision,
      },
    });
    const audit = sqlite.prepare(
      `SELECT action, detail_json
       FROM auth_audit_events
       WHERE action = 'snapshot.restore'`,
    ).get() as {
      action: string;
      detail_json: string;
    };
    expect(audit.action).toBe("snapshot.restore");
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      fromRevision: 9,
      toRevision: restored.workspace.revision,
    });
  });

  it("reports only active owners in restored snapshot authorization", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await testUser(database, "active-restore-owner");
    const disabledOwner = await testUser(
      database,
      "disabled-restore-owner",
    );
    const current = createEmptyState("Active restore owners");
    const initialized = await initializeOwnedWorkspace(
      database,
      owner.userId,
      current,
    );
    sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,'owner',?)`,
    ).run(
      current.workspace.id,
      disabledOwner.userId,
      "2026-07-25T01:00:00.000Z",
    );
    sqlite.prepare(
      "UPDATE users SET status='disabled' WHERE user_id=?",
    ).run(disabledOwner.userId);
    const restored = restoredState(current, "Active owner restored");

    const result = await restoreOwnedWorkspace(
      database,
      owner.userId,
      current.workspace.revision,
      {
        membershipRevision: initialized.membershipRevision ?? 0,
        workspaceAccessRevision: initialized.accessRevision ?? 0,
      },
      restored,
      current.workspace.revision,
    );

    expect(result).toMatchObject({
      ownerCount: 1,
      role: "owner",
      status: "restored",
    });
  });

  it("refuses stale authorization or a lost owner role without an audit", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await testUser(database, "stale-restore-owner");
    const current = createEmptyState("Protected restore");
    const initialized = await initializeOwnedWorkspace(
      database,
      owner.userId,
      current,
    );
    const restored = restoredState(current, "Must not restore");
    sqlite.prepare(
      `UPDATE workspace_members
       SET role = 'editor'
       WHERE workspace_id = ? AND user_id = ?`,
    ).run(current.workspace.id, owner.userId);

    const result = await restoreOwnedWorkspace(
      database,
      owner.userId,
      current.workspace.revision,
      {
        membershipRevision: initialized.membershipRevision ?? 0,
        workspaceAccessRevision: initialized.accessRevision ?? 0,
      },
      restored,
      current.workspace.revision,
    );

    expect(result).toMatchObject({
      role: "editor",
      status: "owner-required",
    });
    expect(sqlite.prepare(
      `SELECT revision
       FROM workspace_snapshots
       WHERE workspace_id = ?`,
    ).get(current.workspace.id)).toEqual({
      revision: current.workspace.revision,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action = 'snapshot.restore'`,
    ).get()).toEqual({ count: 0 });
  });
});
