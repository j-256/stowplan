import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  D1SnapshotStore,
} from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import {
  claimWorkspace,
  createOrLinkUser,
} from "../src/server/auth";
import { probeDatabaseSchema } from "../src/server/database-health";
import { getWorkspaceAccess } from "../src/server/workspace-access";
import { TEST_AUTH_ENV } from "./helpers/auth";
import {
  applySqlDirectory,
  numberedMigrationDatabase,
  sqliteD1Database,
} from "./helpers/sqlite-d1";

const MigrationStream = Object.freeze({
  NUMBERED: "numbered",
  SITES: "sites",
});

function sitesDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  applySqlDirectory(sqlite, new URL("../drizzle/", import.meta.url));
  return { database: sqliteD1Database(sqlite), sqlite };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function normalizedSqlDefinition(value: string): string {
  let normalized = "";
  let stringLiteral = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "'") {
      normalized += character;
      if (stringLiteral && value[index + 1] === "'") {
        normalized += "'";
        index += 1;
      } else {
        stringLiteral = !stringLiteral;
      }
      continue;
    }
    if (!stringLiteral && (character === "`" || /\s/u.test(character))) {
      continue;
    }
    normalized += character;
  }
  return normalized;
}

function triggerDefinitions(sqlite: DatabaseSync) {
  return (
    sqlite.prepare(
      `SELECT name, sql
       FROM sqlite_schema
       WHERE type = 'trigger'
       ORDER BY name`,
    ).all() as { name: string; sql: string }[]
  ).map(trigger => ({
    name: trigger.name,
    sql: normalizedSqlDefinition(trigger.sql),
  }));
}

function runtimeCompatibilitySignature(sqlite: DatabaseSync) {
  const tables = sqlite.prepare(
    `SELECT name
     FROM sqlite_schema
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all() as { name: string }[];
  return tables.map(({ name }) => {
    const identifier = quoteIdentifier(name);
    const columns = sqlite.prepare(`PRAGMA table_info(${identifier})`)
      .all()
      .map((column) => ({
        default: column.dflt_value,
        name: column.name,
        notNull: column.notnull,
        primaryKey: column.pk,
        type: String(column.type).toLowerCase(),
      }));
    const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list(${identifier})`)
      .all()
      .map((foreignKey) => ({
        from: foreignKey.from,
        onDelete: foreignKey.on_delete,
        onUpdate: foreignKey.on_update,
        table: foreignKey.table,
        to: foreignKey.to,
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
    const indexes = (
      sqlite.prepare(`PRAGMA index_list(${identifier})`).all() as {
        name: string;
        origin: string;
        unique: number;
      }[]
    )
      .filter((index) => index.origin === "c")
      .map((index) => ({
        columns: sqlite.prepare(
          `PRAGMA index_xinfo(${quoteIdentifier(index.name)})`,
        ).all()
          .filter((column) => column.key === 1)
          .map((column) => ({
            collation: column.coll,
            descending: column.desc,
            name: column.name,
          })),
        name: index.name,
        unique: index.unique,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return { columns, foreignKeys, indexes, name };
  });
}

describe("Sites D1 packaging", () => {
  it("declares DB and migrates the persistence and collaboration schema", async () => {
    const hosting = JSON.parse(readFileSync(
      new URL("../.openai/hosting.json", import.meta.url),
      "utf8",
    )) as { d1?: string };
    expect(hosting.d1).toBe("DB");

    const { database } = sitesDatabase();
    const store = new D1SnapshotStore(database);
    const state = createEmptyState("Sites D1");
    expect(await store.initialize(state)).toBe("created");
    expect((await store.load(state.workspace.id))?.workspace.name)
      .toBe("Sites D1");

    const owner = await createOrLinkUser(database, TEST_AUTH_ENV, {
      displayName: "Sites owner",
      email: "sites-owner@example.test",
      provider: "test",
      subject: "sites-owner",
    });
    await expect(claimWorkspace(
      database,
      owner.userId,
      state.workspace.id,
    )).resolves.toBeUndefined();
    await expect(probeDatabaseSchema(database)).resolves.toBeUndefined();
  });

  it("counts only active owners in authorized snapshots across both streams", async () => {
    const streams = [
      numberedMigrationDatabase(),
      sitesDatabase(),
    ];

    for (const [index, { database }] of streams.entries()) {
      const state = createEmptyState(`Active owner stream ${index}`);
      const store = new D1SnapshotStore(database);
      await store.initialize(state);
      const owner = await createOrLinkUser(database, TEST_AUTH_ENV, {
        displayName: `Active owner ${index}`,
        email: `active-owner-${index}@example.test`,
        provider: "test",
        subject: `active-owner-${index}`,
      });
      const disabledOwner = await createOrLinkUser(database, TEST_AUTH_ENV, {
        displayName: `Disabled owner ${index}`,
        email: `disabled-owner-${index}@example.test`,
        provider: "test",
        subject: `disabled-owner-${index}`,
      });
      await claimWorkspace(database, owner.userId, state.workspace.id);
      await claimWorkspace(
        database,
        disabledOwner.userId,
        state.workspace.id,
      );
      await expect(getWorkspaceAccess(
        database,
        state.workspace.id,
        owner.userId,
      )).resolves.toMatchObject({
        access: {
          accessRevision: 2,
          capabilities: { leave: true },
        },
      });
      await database.prepare(
        "UPDATE users SET status='disabled' WHERE user_id=?",
      ).bind(disabledOwner.userId).run();

      await expect(store.loadAuthorized(
        state.workspace.id,
        owner.userId,
      )).resolves.toMatchObject({
        ownerCount: 1,
        role: "owner",
      });
      await expect(store.loadAuthorized(
        state.workspace.id,
        disabledOwner.userId,
      )).resolves.toBeNull();
      await expect(getWorkspaceAccess(
        database,
        state.workspace.id,
        owner.userId,
      )).resolves.toMatchObject({
        access: {
          accessRevision: 3,
          capabilities: { leave: false },
        },
      });
      await expect(database.prepare(
        `SELECT membership_revision
         FROM users
         WHERE user_id=?`,
      ).bind(disabledOwner.userId).first()).resolves.toEqual({
        membership_revision: 2,
      });

      await database.prepare(
        "UPDATE users SET status='active' WHERE user_id=?",
      ).bind(disabledOwner.userId).run();
      await expect(getWorkspaceAccess(
        database,
        state.workspace.id,
        owner.userId,
      )).resolves.toMatchObject({
        access: {
          accessRevision: 4,
          capabilities: { leave: true },
        },
      });
      await expect(database.prepare(
        `SELECT membership_revision
         FROM users
         WHERE user_id=?`,
      ).bind(disabledOwner.userId).first()).resolves.toEqual({
        membership_revision: 3,
      });
    }
  });

  it("keeps numbered and Sites schemas runtime-compatible", () => {
    const numbered = numberedMigrationDatabase();
    const sites = sitesDatabase();
    expect(runtimeCompatibilitySignature(numbered.sqlite)).toEqual(
      runtimeCompatibilitySignature(sites.sqlite),
    );
    expect(triggerDefinitions(numbered.sqlite)).toEqual(
      triggerDefinitions(sites.sqlite),
    );
  });

  it("advances and guards authorization revisions in both streams", async () => {
    const streams = [
      numberedMigrationDatabase(),
      sitesDatabase(),
    ];

    for (const [index, { database }] of streams.entries()) {
      const state = createEmptyState(`Revision stream ${index}`);
      const store = new D1SnapshotStore(database);
      expect(await store.initialize(state)).toBe("created");
      const owner = await createOrLinkUser(database, TEST_AUTH_ENV, {
        displayName: `Revision owner ${index}`,
        email: `revision-owner-${index}@example.test`,
        provider: "test",
        subject: `revision-owner-${index}`,
      });
      await claimWorkspace(database, owner.userId, state.workspace.id);
      const revisions = async () => database.prepare(
        `SELECT
           snapshots.access_revision,
           users.membership_revision
         FROM workspace_snapshots snapshots
         JOIN workspace_members members
           ON members.workspace_id = snapshots.workspace_id
         JOIN users
           ON users.user_id = members.user_id
         WHERE snapshots.workspace_id = ? AND users.user_id = ?`,
      ).bind(state.workspace.id, owner.userId).first();
      expect(await revisions()).toEqual({
        access_revision: 1,
        membership_revision: 1,
      });

      await database.prepare(
        `UPDATE workspace_members
         SET role = 'owner'
         WHERE workspace_id = ? AND user_id = ?`,
      ).bind(state.workspace.id, owner.userId).run();
      expect(await revisions()).toEqual({
        access_revision: 1,
        membership_revision: 1,
      });

      const coOwner = await createOrLinkUser(
        database,
        TEST_AUTH_ENV,
        {
          displayName: `Revision co-owner ${index}`,
          email: `revision-co-owner-${index}@example.test`,
          provider: "test",
          subject: `revision-co-owner-${index}`,
        },
      );
      await database.prepare(
        `INSERT INTO workspace_members(
           workspace_id,user_id,role,created_at
         ) VALUES(?,?,?,?)`,
      ).bind(
        state.workspace.id,
        coOwner.userId,
        "owner",
        "2026-07-25T00:00:00.000Z",
      ).run();

      await database.prepare(
        `UPDATE workspace_members
         SET role = 'editor'
         WHERE workspace_id = ? AND user_id = ?`,
      ).bind(state.workspace.id, owner.userId).run();
      expect(await revisions()).toEqual({
        access_revision: 3,
        membership_revision: 2,
      });

      await database.prepare(
        `INSERT INTO guest_links(
           guest_link_id, workspace_id, created_by_user_id, token_hash, role,
           created_at, expires_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).bind(
        `guest_revision_${index}`,
        state.workspace.id,
        owner.userId,
        `token_revision_${index}`,
        "viewer",
        "2026-07-25T00:00:00.000Z",
        "2026-07-26T00:00:00.000Z",
      ).run();
      await database.prepare(
        `UPDATE guest_links
         SET revoked_at = ?
         WHERE guest_link_id = ?`,
      ).bind(
        "2026-07-25T01:00:00.000Z",
        `guest_revision_${index}`,
      ).run();
      expect(await revisions()).toEqual({
        access_revision: 5,
        membership_revision: 2,
      });

      await database.prepare(
        "DELETE FROM guest_links WHERE guest_link_id = ?",
      ).bind(`guest_revision_${index}`).run();
      await database.prepare(
        `DELETE FROM workspace_members
         WHERE workspace_id = ? AND user_id = ?`,
      ).bind(state.workspace.id, owner.userId).run();
      expect(await database.prepare(
        `SELECT access_revision
         FROM workspace_snapshots
         WHERE workspace_id = ?`,
      ).bind(state.workspace.id).first()).toEqual({
        access_revision: 7,
      });
      expect(await database.prepare(
        `SELECT membership_revision
         FROM users
         WHERE user_id = ?`,
      ).bind(owner.userId).first()).toEqual({
        membership_revision: 3,
      });

      await expect(database.prepare(
        `UPDATE workspace_snapshots
         SET access_revision = ?
         WHERE workspace_id = ?`,
      ).bind(5, state.workspace.id).run()).rejects.toThrow(/monotonic/);
      await expect(database.prepare(
        `UPDATE users
         SET membership_revision = ?
         WHERE user_id = ?`,
      ).bind(2, owner.userId).run()).rejects.toThrow(/monotonic/);
      await database.prepare(
        `UPDATE users
         SET membership_revision = ?
         WHERE user_id = ?`,
      ).bind(Number.MAX_SAFE_INTEGER, owner.userId).run();
      await expect(database.prepare(
        `INSERT INTO workspace_members(
           workspace_id, user_id, role, created_at
         ) VALUES(?,?,?,?)`,
      ).bind(
        state.workspace.id,
        owner.userId,
        "viewer",
        "2026-07-25T01:30:00.000Z",
      ).run()).rejects.toThrow(/JavaScript-safe/);
      expect(await database.prepare(
        `SELECT access_revision
         FROM workspace_snapshots
         WHERE workspace_id = ?`,
      ).bind(state.workspace.id).first()).toEqual({
        access_revision: 7,
      });
      await database.prepare(
        `UPDATE workspace_snapshots
         SET access_revision = ?
         WHERE workspace_id = ?`,
      ).bind(Number.MAX_SAFE_INTEGER, state.workspace.id).run();
      const nextMember = await createOrLinkUser(database, TEST_AUTH_ENV, {
        displayName: `Revision next member ${index}`,
        email: `revision-next-${index}@example.test`,
        provider: "test",
        subject: `revision-next-${index}`,
      });
      await expect(database.prepare(
        `INSERT INTO workspace_members(
           workspace_id, user_id, role, created_at
         ) VALUES(?,?,?,?)`,
      ).bind(
        state.workspace.id,
        nextMember.userId,
        "viewer",
        "2026-07-25T02:00:00.000Z",
      ).run()).rejects.toThrow(/JavaScript-safe/);
      expect(await database.prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_members
         WHERE workspace_id = ? AND user_id = ?`,
      ).bind(state.workspace.id, nextMember.userId).first()).toEqual({
        count: 0,
      });
      expect(await database.prepare(
        `SELECT membership_revision
         FROM users
         WHERE user_id = ?`,
      ).bind(nextMember.userId).first()).toEqual({
        membership_revision: 0,
      });
    }
  });

  it("marks streams distinctly and exposes intentional SQLite representation differences", () => {
    const numbered = numberedMigrationDatabase().sqlite;
    const sites = sitesDatabase().sqlite;
    const markerQuery =
      "SELECT id, stream FROM stowplan_migration_stream ORDER BY id";

    expect(numbered.prepare(markerQuery).all()).toEqual([
      { id: 1, stream: MigrationStream.NUMBERED },
    ]);
    expect(sites.prepare(markerQuery).all()).toEqual([
      { id: 1, stream: MigrationStream.SITES },
    ]);
    const markerDefinitionQuery =
      `SELECT sql
       FROM sqlite_schema
       WHERE type = 'table' AND name = 'stowplan_migration_stream'`;
    expect(numbered.prepare(markerDefinitionQuery).get()).toEqual(
      sites.prepare(markerDefinitionQuery).get(),
    );

    const tableRepresentation = (sqlite: DatabaseSync, table: string) =>
      sqlite.prepare(
        `SELECT strict
         FROM pragma_table_list
         WHERE schema = 'main' AND type = 'table' AND name = ?`,
      ).get(table);
    expect(tableRepresentation(numbered, "workspace_snapshots")).toEqual({
      strict: 1,
    });
    expect(tableRepresentation(sites, "workspace_snapshots")).toEqual({
      strict: 0,
    });
    expect(tableRepresentation(numbered, "stowplan_migration_stream"))
      .toEqual({ strict: 0 });
    expect(tableRepresentation(sites, "stowplan_migration_stream"))
      .toEqual({ strict: 0 });

    const usersDefinition = (sqlite: DatabaseSync) =>
      sqlite.prepare(
        `SELECT sql
         FROM sqlite_schema
         WHERE type = 'table' AND name = 'users'`,
      ).get() as { sql: string };
    expect(usersDefinition(numbered).sql).toMatch(/COLLATE NOCASE UNIQUE/);
    expect(usersDefinition(sites).sql).not.toMatch(/COLLATE NOCASE UNIQUE/);
    expect(
      (numbered.prepare("PRAGMA index_list('users')").all() as {
        origin: string;
      }[]).filter((index) => index.origin === "u"),
    ).not.toHaveLength(0);
    expect(
      (sites.prepare("PRAGMA index_list('users')").all() as {
        origin: string;
      }[]).filter((index) => index.origin === "u"),
    ).toHaveLength(0);
  });

  it("scrubs legacy IP metadata in both migration streams", () => {
    const streams = [
      {
        beforePrivacy: [
          new URL("../migrations/0001_initial.sql", import.meta.url),
          new URL(
            "../migrations/0002_atomic_guest_redemption.sql",
            import.meta.url,
          ),
        ],
        privacy: new URL(
          "../migrations/0003_scrub_legacy_ip_metadata.sql",
          import.meta.url,
        ),
      },
      {
        beforePrivacy: [
          new URL(
            "../drizzle/0000_natural_leper_queen.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0001_wakeful_unus.sql",
            import.meta.url,
          ),
        ],
        privacy: new URL(
          "../drizzle/0002_scrub_legacy_ip_metadata.sql",
          import.meta.url,
        ),
      },
    ];

    for (const stream of streams) {
      const sqlite = new DatabaseSync(":memory:");
      for (const migration of stream.beforePrivacy) {
        sqlite.exec(readFileSync(migration, "utf8")
          .replaceAll("--> statement-breakpoint", ""));
      }
      sqlite.prepare(
        `INSERT INTO users(
           user_id, email, display_name, global_role, status, created_at,
           updated_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        "usr_legacy_ip",
        "legacy-ip@example.test",
        "Legacy IP",
        "user",
        "active",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      sqlite.prepare(
        `INSERT INTO sessions(
           session_id, user_id, token_hash, created_at, expires_at,
           last_seen_at, ip_prefix
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        "ses_legacy_ip",
        "usr_legacy_ip",
        "legacy-token-hash",
        "2026-01-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2001:db8:1234:5678::42",
      );
      sqlite.prepare(
        `INSERT INTO auth_audit_events(
           event_id, action, target_type, detail_json, created_at, ip_prefix
         ) VALUES(?,?,?,?,?,?)`,
      ).run(
        "audit_legacy_ip",
        "legacy.test",
        "session",
        "{}",
        "2026-01-01T00:00:00.000Z",
        "2001:db8:1234:5678::42",
      );

      sqlite.exec(readFileSync(stream.privacy, "utf8")
        .replaceAll("--> statement-breakpoint", ""));
      expect(sqlite.prepare(
        "SELECT ip_prefix FROM sessions WHERE session_id = ?",
      ).get("ses_legacy_ip")).toEqual({ ip_prefix: null });
      expect(sqlite.prepare(
        "SELECT ip_prefix FROM auth_audit_events WHERE event_id = ?",
      ).get("audit_legacy_ip")).toEqual({ ip_prefix: null });
    }
  });

  it("upgrades existing memberships without changing domain snapshots", () => {
    const streams = [
      {
        beforeAccess: [
          new URL("../migrations/0001_initial.sql", import.meta.url),
          new URL(
            "../migrations/0002_atomic_guest_redemption.sql",
            import.meta.url,
          ),
          new URL(
            "../migrations/0003_scrub_legacy_ip_metadata.sql",
            import.meta.url,
          ),
          new URL(
            "../migrations/0004_mark_numbered_stream.sql",
            import.meta.url,
          ),
        ],
        access: new URL(
          "../migrations/0005_workspace_access_revisions.sql",
          import.meta.url,
        ),
      },
      {
        beforeAccess: [
          new URL(
            "../drizzle/0000_natural_leper_queen.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0001_wakeful_unus.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0002_scrub_legacy_ip_metadata.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0003_light_iron_monger.sql",
            import.meta.url,
          ),
        ],
        access: new URL(
          "../drizzle/0004_overrated_lila_cheney.sql",
          import.meta.url,
        ),
      },
    ];

    for (const [index, stream] of streams.entries()) {
      const sqlite = new DatabaseSync(":memory:");
      for (const migration of stream.beforeAccess) {
        sqlite.exec(readFileSync(migration, "utf8")
          .replaceAll("--> statement-breakpoint", ""));
      }
      const state = createEmptyState(`Upgrade stream ${index}`);
      sqlite.prepare(
        `INSERT INTO workspace_snapshots(
           workspace_id, revision, state_json, created_at, updated_at
         ) VALUES(?,?,?,?,?)`,
      ).run(
        state.workspace.id,
        state.workspace.revision,
        JSON.stringify(state),
        state.workspace.createdAt,
        state.workspace.updatedAt,
      );
      sqlite.prepare(
        `INSERT INTO users(
           user_id, email, display_name, global_role, status, created_at,
           updated_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `usr_upgrade_${index}`,
        `upgrade-${index}@example.test`,
        `Upgrade user ${index}`,
        "user",
        "active",
        "2026-07-25T00:00:00.000Z",
        "2026-07-25T00:00:00.000Z",
      );
      sqlite.prepare(
        `INSERT INTO workspace_members(
           workspace_id, user_id, role, created_at
         ) VALUES(?,?,?,?)`,
      ).run(
        state.workspace.id,
        `usr_upgrade_${index}`,
        "owner",
        "2026-07-25T00:00:00.000Z",
      );

      sqlite.exec(readFileSync(stream.access, "utf8")
        .replaceAll("--> statement-breakpoint", ""));
      expect(sqlite.prepare(
        `SELECT
           snapshots.access_revision,
           snapshots.state_json,
           users.membership_revision
         FROM workspace_snapshots snapshots
         JOIN workspace_members members
           ON members.workspace_id = snapshots.workspace_id
         JOIN users
           ON users.user_id = members.user_id
         WHERE snapshots.workspace_id = ?`,
      ).get(state.workspace.id)).toEqual({
        access_revision: 0,
        membership_revision: 0,
        state_json: JSON.stringify(state),
      });

      sqlite.prepare(
        `UPDATE workspace_members
         SET role = 'editor'
         WHERE workspace_id = ? AND user_id = ?`,
      ).run(state.workspace.id, `usr_upgrade_${index}`);
      expect(sqlite.prepare(
        `SELECT
           snapshots.access_revision,
           users.membership_revision
         FROM workspace_snapshots snapshots
         JOIN workspace_members members
           ON members.workspace_id = snapshots.workspace_id
         JOIN users
           ON users.user_id = members.user_id
         WHERE snapshots.workspace_id = ?`,
      ).get(state.workspace.id)).toEqual({
        access_revision: 1,
        membership_revision: 1,
      });
    }
  });

  it("preserves populated authorization data through governance upgrades", () => {
    const streams = [
      {
        beforeGovernance: [
          new URL("../migrations/0001_initial.sql", import.meta.url),
          new URL(
            "../migrations/0002_atomic_guest_redemption.sql",
            import.meta.url,
          ),
          new URL(
            "../migrations/0003_scrub_legacy_ip_metadata.sql",
            import.meta.url,
          ),
          new URL(
            "../migrations/0004_mark_numbered_stream.sql",
            import.meta.url,
          ),
          new URL(
            "../migrations/0005_workspace_access_revisions.sql",
            import.meta.url,
          ),
        ],
        governance: [
          new URL(
            "../migrations/0006_public_account_governance.sql",
            import.meta.url,
          ),
        ],
      },
      {
        beforeGovernance: [
          new URL(
            "../drizzle/0000_natural_leper_queen.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0001_wakeful_unus.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0002_scrub_legacy_ip_metadata.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0003_light_iron_monger.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0004_overrated_lila_cheney.sql",
            import.meta.url,
          ),
        ],
        governance: [
          new URL(
            "../drizzle/0005_worried_invaders.sql",
            import.meta.url,
          ),
          new URL(
            "../drizzle/0006_aberrant_the_fury.sql",
            import.meta.url,
          ),
        ],
      },
    ];

    for (const [index, stream] of streams.entries()) {
      const sqlite = new DatabaseSync(":memory:");
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const migration of stream.beforeGovernance) {
        sqlite.exec(readFileSync(migration, "utf8")
          .replaceAll("--> statement-breakpoint", ""));
      }
      const suffix = String(index);
      const state = createEmptyState(`Governance upgrade ${suffix}`);
      const userId = `usr_governance_upgrade_${suffix}`;
      const workspaceId = state.workspace.id;
      const stateJson = JSON.stringify(state);
      sqlite.prepare(
        `INSERT INTO users(
           user_id,email,display_name,global_role,status,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        userId,
        `governance-upgrade-${suffix}@example.test`,
        `Governance upgrade ${suffix}`,
        "admin",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      );
      sqlite.prepare(
        `INSERT INTO workspace_snapshots(
           workspace_id,revision,state_json,created_at,updated_at
         ) VALUES(?,?,?,?,?)`,
      ).run(
        workspaceId,
        state.workspace.revision,
        stateJson,
        state.workspace.createdAt,
        state.workspace.updatedAt,
      );
      sqlite.prepare(
        `INSERT INTO workspace_members(
           workspace_id,user_id,role,created_at
         ) VALUES(?,?,?,?)`,
      ).run(
        workspaceId,
        userId,
        "owner",
        "2026-07-01T00:00:00.000Z",
      );
      sqlite.prepare(
        `INSERT INTO identities(
           identity_id,user_id,provider,provider_subject,email,created_at,
           last_used_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `idt_governance_upgrade_${suffix}`,
        userId,
        "google",
        `subject-governance-upgrade-${suffix}`,
        `governance-upgrade-${suffix}@example.test`,
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      );
      sqlite.prepare(
        `INSERT INTO sessions(
           session_id,user_id,token_hash,created_at,expires_at,last_seen_at
         ) VALUES(?,?,?,?,?,?)`,
      ).run(
        `ses_governance_upgrade_${suffix}`,
        userId,
        `session-governance-upgrade-${suffix}`,
        "2026-07-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      );
      sqlite.prepare(
        `INSERT INTO guest_links(
           guest_link_id,workspace_id,created_by_user_id,token_hash,role,
           created_at,expires_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `gst_governance_upgrade_${suffix}`,
        workspaceId,
        userId,
        `guest-governance-upgrade-${suffix}`,
        "viewer",
        "2026-07-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
      sqlite.prepare(
        `INSERT INTO auth_audit_events(
           event_id,actor_user_id,action,target_type,target_id,detail_json,
           created_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `aud_governance_upgrade_${suffix}`,
        userId,
        "test.upgrade",
        "user",
        userId,
        "{}",
        "2026-07-01T00:00:00.000Z",
      );

      for (const migration of stream.governance) {
        sqlite.exec(readFileSync(migration, "utf8")
          .replaceAll("--> statement-breakpoint", ""));
      }

      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(sqlite.prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users_count,
           (SELECT COUNT(*) FROM identities) AS identities_count,
           (SELECT COUNT(*) FROM sessions) AS sessions_count,
           (SELECT COUNT(*) FROM workspace_members) AS memberships_count,
           (SELECT COUNT(*) FROM guest_links) AS guest_links_count,
           (SELECT COUNT(*) FROM auth_audit_events) AS audit_count,
           (SELECT COUNT(*) FROM workspace_custody) AS custody_count`,
      ).get()).toEqual({
        audit_count: 1,
        custody_count: 1,
        guest_links_count: 1,
        identities_count: 1,
        memberships_count: 1,
        sessions_count: 1,
        users_count: 1,
      });
      expect(sqlite.prepare(
        `SELECT
           snapshots.state_json,
           snapshots.stored_bytes,
           users.global_role,
           users.status,
           sessions.replaced_by_session_id,
           sessions.reauthenticated_at,
           sessions.authentication_provider
         FROM workspace_snapshots snapshots
         JOIN workspace_members members
           ON members.workspace_id = snapshots.workspace_id
         JOIN users ON users.user_id = members.user_id
         JOIN sessions ON sessions.user_id = users.user_id
         WHERE snapshots.workspace_id = ?`,
      ).get(workspaceId)).toEqual({
        authentication_provider: null,
        global_role: "admin",
        reauthenticated_at: null,
        replaced_by_session_id: null,
        state_json: stateJson,
        status: "active",
        stored_bytes: Buffer.byteLength(stateJson),
      });
      expect(sqlite.prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type='table' AND name LIKE '%governance%backup%'`,
      ).all()).toEqual([]);
    }
  });

  it("does not report a pre-redemption schema as ready", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ));
    await expect(
      probeDatabaseSchema(sqliteD1Database(sqlite)),
    ).rejects.toThrow(/redemption_id|workspace_deletions/);
  });
});
