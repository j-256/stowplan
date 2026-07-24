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

    const owner = await createOrLinkUser(database, {}, {
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

  it("keeps numbered and Sites schemas runtime-compatible", () => {
    const numbered = numberedMigrationDatabase();
    const sites = sitesDatabase();
    expect(runtimeCompatibilitySignature(numbered.sqlite)).toEqual(
      runtimeCompatibilitySignature(sites.sqlite),
    );
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

  it("does not report a pre-redemption schema as ready", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ));
    await expect(
      probeDatabaseSchema(sqliteD1Database(sqlite)),
    ).rejects.toThrow(/redemption_id/);
  });
});
