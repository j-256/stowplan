import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  type D1DatabaseLike,
  D1SnapshotStore,
} from "../src/adapters/d1-snapshot-store";
import {
  createEmptyState,
  createItem,
  createLocation,
} from "../src/domain/factories";
import {
  deleteAdminWorkspace,
  inspectAdminWorkspace,
  takeAdminWorkspaceOwnership,
} from "../src/server/admin-workspace";
import { adminMutation } from "../src/server/admin";
import {
  claimWorkspace,
  createGuestLink,
  createOrLinkUser,
} from "../src/server/auth";
import { API_QUOTAS } from "../src/shared/api-quotas";
import {
  applySqlDirectory,
  numberedMigrationDatabase,
  sqliteD1Database,
} from "./helpers/sqlite-d1";
import { TEST_AUTH_ENV } from "./helpers/auth";

function sitesDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  applySqlDirectory(sqlite, new URL("../drizzle/", import.meta.url));
  return { database: sqliteD1Database(sqlite), sqlite };
}

function raceBeforeFirstBatch(
  database: D1DatabaseLike,
  race: () => void,
): D1DatabaseLike {
  let pending = true;
  return {
    prepare: database.prepare.bind(database),
    async batch(statements) {
      if (pending) {
        pending = false;
        race();
      }
      return database.batch(statements);
    },
  };
}

async function createAdmin(
  database: D1DatabaseLike,
  profile: Parameters<typeof createOrLinkUser>[2],
) {
  const user = await createOrLinkUser(
    database,
    TEST_AUTH_ENV,
    profile,
  );
  await database.prepare(
    `UPDATE users
     SET global_role='admin'
     WHERE user_id=?`,
  ).bind(user.userId).run();
  return { ...user, globalRole: "admin" as const };
}

async function fixture(
  schema: "numbered" | "sites" = "numbered",
) {
  const storage = schema === "sites"
    ? sitesDatabase()
    : numberedMigrationDatabase();
  const admin = await createAdmin(
    storage.database,
    {
      displayName: "Godmode administrator",
      email: "godmode-admin@example.test",
      provider: "test",
      subject: `godmode-admin-${schema}`,
    },
  );
  const owner = await createOrLinkUser(storage.database, TEST_AUTH_ENV, {
    displayName: "Workspace owner",
    email: "workspace-owner@example.test",
    provider: "test",
    subject: `workspace-owner-${schema}`,
  });
  const state = createEmptyState(
    "Inspected workspace",
    "2026-07-25T00:00:00.000Z",
  );
  const location = createLocation(
    {
      code: "SAFE",
      kind: "cabinet",
      name: "Private cabinet",
    },
    "2026-07-25T00:01:00.000Z",
  );
  location.description = "Operational improvement clue";
  const item = createItem(
    {
      category: "Records",
      locationId: location.id,
      name: "Private inventory item",
      quantity: 3,
    },
    "2026-07-25T00:02:00.000Z",
  );
  item.description = "Full content visible only after an audited inspection";
  state.locations.push(location);
  state.items.push(item);
  await new D1SnapshotStore(storage.database).initialize(state);
  await claimWorkspace(
    storage.database,
    owner.userId,
    state.workspace.id,
  );
  return {
    ...storage,
    admin,
    item,
    location,
    owner,
    state,
  };
}

describe("global admin workspace control", () => {
  it("returns a validated full snapshot with an audit in both schemas", async () => {
    for (const schema of ["numbered", "sites"] as const) {
      const current = await fixture(schema);
      const inspection = await inspectAdminWorkspace(
        current.database,
        current.admin.userId,
        current.state.workspace.id,
      );

      expect(inspection).toMatchObject({
        accessRevision: expect.any(Number),
        operatorRole: null,
        snapshotBytes: expect.any(Number),
        state: {
          items: [{
            name: current.item.name,
            description: current.item.description,
          }],
          locations: [{
            description: current.location.description,
            name: current.location.name,
          }],
          workspace: {
            id: current.state.workspace.id,
            name: current.state.workspace.name,
          },
        },
        workspaceId: current.state.workspace.id,
      });
      expect(current.sqlite.prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_members
         WHERE workspace_id=? AND user_id=?`,
      ).get(
        current.state.workspace.id,
        current.admin.userId,
      )).toEqual({ count: 0 });
      const audit = current.sqlite.prepare(
        `SELECT detail_json
         FROM auth_audit_events
         WHERE action='workspace.inspect'
           AND actor_user_id=?
           AND target_id=?`,
      ).get(
        current.admin.userId,
        current.state.workspace.id,
      ) as { detail_json: string };
      expect(JSON.parse(audit.detail_json)).toMatchObject({
        accessRevision: expect.any(Number),
        itemCount: 1,
        locationCount: 1,
        snapshotRevision: current.state.workspace.revision,
        workspaceId: current.state.workspace.id,
      });
      expect(audit.detail_json).not.toContain(current.item.name);
      expect(audit.detail_json).not.toContain(current.item.description);
      current.sqlite.close();
    }
  });

  it("rejects a forged non-admin inspection at the service boundary", async () => {
    const current = await fixture();

    await expect(inspectAdminWorkspace(
      current.database,
      current.owner.userId,
      current.state.workspace.id,
    )).rejects.toMatchObject({
      code: "ADMIN_REQUIRED",
      status: 403,
    });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.inspect'`,
    ).get()).toEqual({ count: 0 });
  });

  it("withholds an inspection when its audit record cannot be written", async () => {
    const current = await fixture();
    current.sqlite.exec(
      `CREATE TRIGGER reject_admin_workspace_inspection_audit
       BEFORE INSERT ON auth_audit_events
       WHEN NEW.action='workspace.inspect'
       BEGIN
         SELECT RAISE(
           ABORT,
           'injected admin workspace inspection audit failure'
         );
       END`,
    );

    await expect(inspectAdminWorkspace(
      current.database,
      current.admin.userId,
      current.state.workspace.id,
    )).rejects.toThrow(
      /injected admin workspace inspection audit failure/,
    );
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.inspect'`,
    ).get()).toEqual({ count: 0 });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(current.state.workspace.id)).toEqual({ count: 1 });
  });

  it("rechecks active admin authority while recording an inspection", async () => {
    const current = await fixture();
    await createAdmin(
      current.database,
      {
        displayName: "Backup inspection administrator",
        email: "backup-inspection-admin@example.test",
        provider: "test",
        subject: "backup-inspection-admin",
      },
    );
    let raced = false;
    const racingDatabase: D1DatabaseLike = {
      batch: current.database.batch.bind(current.database),
      prepare(query) {
        if (
          !raced &&
          query.includes("INSERT INTO auth_audit_events")
        ) {
          raced = true;
          current.sqlite.prepare(
            `UPDATE users
             SET global_role='user'
             WHERE user_id=?`,
          ).run(current.admin.userId);
        }
        return current.database.prepare(query);
      },
    };

    await expect(inspectAdminWorkspace(
      racingDatabase,
      current.admin.userId,
      current.state.workspace.id,
    )).rejects.toMatchObject({
      code: "ADMIN_REQUIRED",
      status: 403,
    });
    expect(raced).toBe(true);
    expect(current.sqlite.prepare(
      `SELECT global_role
       FROM users
       WHERE user_id=?`,
    ).get(current.admin.userId)).toEqual({ global_role: "user" });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.inspect'`,
    ).get()).toEqual({ count: 0 });
  });

  it.each(["numbered", "sites"] as const)(
    "takes audited custody in the %s schema so an abusive final owner can be disabled",
    async (schema) => {
    const current = await fixture(schema);
    const before = current.sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(current.state.workspace.id) as { access_revision: number };

    const custody = await takeAdminWorkspaceOwnership(
      current.database,
      current.admin.userId,
      current.state.workspace.id,
      {
        action: "takeOwnership",
        expectedAccessRevision: before.access_revision,
      },
    );

    expect(custody).toMatchObject({
      accessRevision: before.access_revision + 1,
      operatorRole: "owner",
      workspaceId: current.state.workspace.id,
    });
    expect(current.sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      current.state.workspace.id,
      current.admin.userId,
    )).toEqual({ role: "owner" });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.custody'
         AND actor_user_id=?
         AND target_id=?`,
    ).get(
      current.admin.userId,
      current.state.workspace.id,
    )).toEqual({ count: 1 });
    const ownerAccount = current.sqlite.prepare(
      `SELECT account_revision
       FROM users
       WHERE user_id=?`,
    ).get(current.owner.userId) as { account_revision: number };
    await expect(adminMutation(
      current.database,
      current.admin.userId,
      {
        action: "user.status",
        expectedAccountRevision: ownerAccount.account_revision,
        targetId: current.owner.userId,
        value: "disabled",
      },
    )).resolves.toMatchObject({
      message: "User disabled",
    });
    expect(current.sqlite.prepare(
      "SELECT status FROM users WHERE user_id=?",
    ).get(current.owner.userId)).toEqual({ status: "disabled" });
    const refreshed = current.sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(current.state.workspace.id) as { access_revision: number };
    await expect(takeAdminWorkspaceOwnership(
      current.database,
      current.admin.userId,
      current.state.workspace.id,
      {
        action: "takeOwnership",
        expectedAccessRevision: refreshed.access_revision,
      },
    )).rejects.toMatchObject({
      code: "ROLE_UNCHANGED",
      status: 409,
    });
    current.sqlite.close();
  });

  it("refuses custody when access changes after its preflight", async () => {
    const current = await fixture();
    const racingMember = await createOrLinkUser(
      current.database,
      TEST_AUTH_ENV,
      {
      displayName: "Racing workspace member",
      email: "racing-workspace-member@example.test",
      provider: "test",
      subject: "racing-workspace-member",
      },
    );
    const before = current.sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(current.state.workspace.id) as { access_revision: number };
    const racingDatabase = raceBeforeFirstBatch(
      current.database,
      () => {
        current.sqlite.prepare(
          `INSERT INTO workspace_members(
             workspace_id,user_id,role,created_at
           ) VALUES(?,?,'viewer',?)`,
        ).run(
          current.state.workspace.id,
          racingMember.userId,
          "2026-07-25T00:04:00.000Z",
        );
      },
    );

    await expect(takeAdminWorkspaceOwnership(
      racingDatabase,
      current.admin.userId,
      current.state.workspace.id,
      {
        action: "takeOwnership",
        expectedAccessRevision: before.access_revision,
      },
    )).rejects.toMatchObject({
      code: "ACCESS_STALE",
      detail: {
        accessRevision: before.access_revision + 1,
      },
      status: 409,
    });
    expect(current.sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      current.state.workspace.id,
      racingMember.userId,
    )).toEqual({ role: "viewer" });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      current.state.workspace.id,
      current.admin.userId,
    )).toEqual({ count: 0 });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.custody'`,
    ).get()).toEqual({ count: 0 });
  });

  it("enforces the workspace member quota during custody", async () => {
    const current = await fixture();
    const createdAt = "2026-07-25T00:04:00.000Z";
    const insertUser = current.sqlite.prepare(
      `INSERT INTO users(
         user_id,email,display_name,global_role,status,created_at,
         updated_at,last_seen_at
       ) VALUES(?,?,?,'user','active',?,?,?)`,
    );
    const insertMember = current.sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,'viewer',?)`,
    );
    for (
      let index = 1;
      index < API_QUOTAS.membersPerWorkspace;
      index += 1
    ) {
      const userId = `usr_custody_member_${index}`;
      insertUser.run(
        userId,
        `custody-member-${index}@example.test`,
        `Custody member ${index}`,
        createdAt,
        createdAt,
        createdAt,
      );
      insertMember.run(
        current.state.workspace.id,
        userId,
        createdAt,
      );
    }
    const before = current.sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(current.state.workspace.id) as { access_revision: number };

    await expect(takeAdminWorkspaceOwnership(
      current.database,
      current.admin.userId,
      current.state.workspace.id,
      {
        action: "takeOwnership",
        expectedAccessRevision: before.access_revision,
      },
    )).rejects.toMatchObject({
      actual: API_QUOTAS.membersPerWorkspace + 1,
      code: "QUOTA_EXCEEDED",
      quota: "membersPerWorkspace",
      status: 409,
    });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=?`,
    ).get(current.state.workspace.id)).toEqual({
      count: API_QUOTAS.membersPerWorkspace,
    });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      current.state.workspace.id,
      current.admin.userId,
    )).toEqual({ count: 0 });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.custody'`,
    ).get()).toEqual({ count: 0 });
  });

  it("enforces the owned workspace quota during custody", async () => {
    const current = await fixture();
    for (
      let index = 0;
      index < API_QUOTAS.ownedWorkspacesPerUser;
      index += 1
    ) {
      const state = createEmptyState(
        `Administrator owned workspace ${index}`,
        "2026-07-25T00:04:00.000Z",
      );
      await new D1SnapshotStore(current.database).initialize(state);
      await claimWorkspace(
        current.database,
        current.admin.userId,
        state.workspace.id,
      );
    }
    const before = current.sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(current.state.workspace.id) as { access_revision: number };

    await expect(takeAdminWorkspaceOwnership(
      current.database,
      current.admin.userId,
      current.state.workspace.id,
      {
        action: "takeOwnership",
        expectedAccessRevision: before.access_revision,
      },
    )).rejects.toMatchObject({
      actual: API_QUOTAS.ownedWorkspacesPerUser + 1,
      code: "QUOTA_EXCEEDED",
      quota: "ownedWorkspacesPerUser",
      status: 409,
    });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE user_id=? AND role='owner'`,
    ).get(current.admin.userId)).toEqual({
      count: API_QUOTAS.ownedWorkspacesPerUser,
    });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      current.state.workspace.id,
      current.admin.userId,
    )).toEqual({ count: 0 });
    expect(current.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.custody'`,
    ).get()).toEqual({ count: 0 });
  });

  it.each(["numbered", "sites"] as const)(
    "deletes an unjoined workspace transactionally in the %s schema",
    async (schema) => {
    const current = await fixture(schema);
    const member = await createOrLinkUser(
      current.database,
      TEST_AUTH_ENV,
      {
      displayName: "Workspace member",
      email: "workspace-member@example.test",
      provider: "test",
      subject: "workspace-member",
      },
    );
    await current.database.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,'viewer',?)`,
    ).bind(
      current.state.workspace.id,
      member.userId,
      "2026-07-25T00:03:00.000Z",
    ).run();
    const guest = await createGuestLink(
      current.database,
      current.state.workspace.id,
      current.owner.userId,
      "viewer",
      24,
    );
    const revisions = current.sqlite.prepare(
      `SELECT revision,access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(current.state.workspace.id) as {
      access_revision: number;
      revision: number;
    };
    const input = {
      confirmationName: current.state.workspace.name,
      expectedAccessRevision: revisions.access_revision,
      expectedRevision: revisions.revision,
    };

    await expect(deleteAdminWorkspace(
      current.database,
      current.admin.userId,
      current.state.workspace.id,
      input,
    )).resolves.toMatchObject({
      deleted: true,
      recovery: "not_available",
      workspaceId: current.state.workspace.id,
    });
    expect(current.sqlite.prepare(
      `SELECT
         (SELECT COUNT(*) FROM workspace_snapshots
          WHERE workspace_id=?) AS snapshots,
         (SELECT COUNT(*) FROM workspace_members
          WHERE workspace_id=?) AS members,
         (SELECT COUNT(*) FROM guest_links
          WHERE workspace_id=?) AS links,
         (SELECT COUNT(*) FROM workspace_deletions
          WHERE workspace_id=?) AS tombstones`,
    ).get(
      current.state.workspace.id,
      current.state.workspace.id,
      current.state.workspace.id,
      current.state.workspace.id,
    )).toEqual({
      links: 0,
      members: 0,
      snapshots: 0,
      tombstones: 1,
    });
    const audit = current.sqlite.prepare(
      `SELECT detail_json
       FROM auth_audit_events
       WHERE action='workspace.delete' AND target_id=?`,
    ).get(current.state.workspace.id) as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      source: "global-admin",
      workspaceId: current.state.workspace.id,
    });
    expect(audit.detail_json).not.toContain(guest.raw);
    await expect(deleteAdminWorkspace(
      current.database,
      current.admin.userId,
      current.state.workspace.id,
      input,
    )).rejects.toMatchObject({
      code: "WORKSPACE_DELETED",
      status: 410,
    });
    expect(current.sqlite.prepare(
      `SELECT
         (SELECT COUNT(*) FROM workspace_deletions
          WHERE workspace_id=?) AS tombstones,
         (SELECT COUNT(*) FROM auth_audit_events
          WHERE action='workspace.delete' AND target_id=?) AS audits`,
    ).get(
      current.state.workspace.id,
      current.state.workspace.id,
    )).toEqual({
      audits: 1,
      tombstones: 1,
    });
    current.sqlite.close();
  });

  it.each(["snapshot", "access"] as const)(
    "preserves every server record when the %s revision changes after delete preflight",
    async (revisionKind) => {
      const current = await fixture();
      const racingMember = revisionKind === "access"
        ? await createOrLinkUser(
            current.database,
            TEST_AUTH_ENV,
            {
              displayName: "Deletion race member",
              email: "deletion-race-member@example.test",
              provider: "test",
              subject: "deletion-race-member",
            },
          )
        : null;
      await createGuestLink(
        current.database,
        current.state.workspace.id,
        current.owner.userId,
        "viewer",
        24,
      );
      const before = current.sqlite.prepare(
        `SELECT revision,access_revision
         FROM workspace_snapshots
         WHERE workspace_id=?`,
      ).get(current.state.workspace.id) as {
        access_revision: number;
        revision: number;
      };
      const racingDatabase = raceBeforeFirstBatch(
        current.database,
        () => {
          if (revisionKind === "snapshot") {
            const state = structuredClone(current.state);
            state.workspace.revision = before.revision + 1;
            state.workspace.updatedAt = "2026-07-25T00:05:00.000Z";
            current.sqlite.prepare(
              `UPDATE workspace_snapshots
               SET revision=?,state_json=?,updated_at=?
               WHERE workspace_id=?`,
            ).run(
              state.workspace.revision,
              JSON.stringify(state),
              state.workspace.updatedAt,
              state.workspace.id,
            );
            return;
          }
          if (!racingMember) {
            throw new Error("The access race member was not created");
          }
          current.sqlite.prepare(
            `INSERT INTO workspace_members(
               workspace_id,user_id,role,created_at
             ) VALUES(?,?,'viewer',?)`,
          ).run(
            current.state.workspace.id,
            racingMember.userId,
            "2026-07-25T00:05:00.000Z",
          );
        },
      );

      await expect(deleteAdminWorkspace(
        racingDatabase,
        current.admin.userId,
        current.state.workspace.id,
        {
          confirmationName: current.state.workspace.name,
          expectedAccessRevision: before.access_revision,
          expectedRevision: before.revision,
        },
      )).rejects.toMatchObject({
        code: "WORKSPACE_BUSY",
        detail: {
          currentAccessRevision: revisionKind === "access"
            ? before.access_revision + 1
            : before.access_revision,
          currentRevision: revisionKind === "snapshot"
            ? before.revision + 1
            : before.revision,
        },
        status: 409,
      });
      expect(current.sqlite.prepare(
        `SELECT revision,access_revision
         FROM workspace_snapshots
         WHERE workspace_id=?`,
      ).get(current.state.workspace.id)).toEqual({
        access_revision: revisionKind === "access"
          ? before.access_revision + 1
          : before.access_revision,
        revision: revisionKind === "snapshot"
          ? before.revision + 1
          : before.revision,
      });
      expect(current.sqlite.prepare(
        `SELECT
           (SELECT COUNT(*) FROM workspace_members
            WHERE workspace_id=?) AS members,
           (SELECT COUNT(*) FROM guest_links
            WHERE workspace_id=?) AS links,
           (SELECT COUNT(*) FROM workspace_deletions
            WHERE workspace_id=?) AS tombstones,
           (SELECT COUNT(*) FROM auth_audit_events
            WHERE action='workspace.delete' AND target_id=?) AS audits`,
      ).get(
        current.state.workspace.id,
        current.state.workspace.id,
        current.state.workspace.id,
        current.state.workspace.id,
      )).toEqual({
        audits: 0,
        links: 1,
        members: revisionKind === "access" ? 2 : 1,
        tombstones: 0,
      });
    },
  );

  it("allows only one racing deletion and rolls back an unaudited deletion", async () => {
    const racing = await fixture();
    const revisions = racing.sqlite.prepare(
      `SELECT revision,access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(racing.state.workspace.id) as {
      access_revision: number;
      revision: number;
    };
    const input = {
      confirmationName: racing.state.workspace.name,
      expectedAccessRevision: revisions.access_revision,
      expectedRevision: revisions.revision,
    };
    const results = await Promise.allSettled([
      deleteAdminWorkspace(
        racing.database,
        racing.admin.userId,
        racing.state.workspace.id,
        input,
      ),
      deleteAdminWorkspace(
        racing.database,
        racing.admin.userId,
        racing.state.workspace.id,
        input,
      ),
    ]);
    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toHaveLength(1);
    expect(racing.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='workspace.delete'`,
    ).get()).toEqual({ count: 1 });

    const rollback = await fixture();
    const rollbackRevisions = rollback.sqlite.prepare(
      `SELECT revision,access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(rollback.state.workspace.id) as {
      access_revision: number;
      revision: number;
    };
    rollback.sqlite.exec(
      `CREATE TRIGGER reject_admin_workspace_delete_audit
       BEFORE INSERT ON auth_audit_events
       WHEN NEW.action='workspace.delete'
       BEGIN
         SELECT RAISE(
           ABORT,
           'injected admin workspace delete audit failure'
         );
       END`,
    );

    await expect(deleteAdminWorkspace(
      rollback.database,
      rollback.admin.userId,
      rollback.state.workspace.id,
      {
        confirmationName: rollback.state.workspace.name,
        expectedAccessRevision: rollbackRevisions.access_revision,
        expectedRevision: rollbackRevisions.revision,
      },
    )).rejects.toThrow(
      /injected admin workspace delete audit failure/,
    );
    expect(rollback.sqlite.prepare(
      `SELECT
         (SELECT COUNT(*) FROM workspace_snapshots
          WHERE workspace_id=?) AS snapshots,
         (SELECT COUNT(*) FROM workspace_deletions
          WHERE workspace_id=?) AS tombstones`,
    ).get(
      rollback.state.workspace.id,
      rollback.state.workspace.id,
    )).toEqual({
      snapshots: 1,
      tombstones: 0,
    });
  });
});
