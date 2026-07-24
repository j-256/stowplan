import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = resolve(
  process.env.STOWPLAN_SQLITE_PATH ?? "data/stowplan.sqlite",
);
mkdirSync(dirname(databasePath), { recursive: true });
const sqlite = new DatabaseSync(databasePath);
sqlite.exec("PRAGMA foreign_keys = ON");

const MigrationStream = Object.freeze({
  NUMBERED: "numbered",
  SITES: "sites",
});
const MIGRATION_STREAM_TABLE = "stowplan_migration_stream";
const NODE_MIGRATION_LEDGER_TABLE = "stowplan_node_migrations";
const WORKSPACE_SNAPSHOT_TABLE = "workspace_snapshots";
const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = readdirSync(migrationDirectory)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();

function tableMetadata(name) {
  return sqlite.prepare(
    `SELECT name, strict
     FROM pragma_table_list
     WHERE schema = 'main' AND type = 'table' AND name = ?`,
  ).get(name);
}

function refuseMigrationStream(message) {
  sqlite.close();
  throw new Error(message);
}

const streamTable = tableMetadata(MIGRATION_STREAM_TABLE);
let migrationStream = null;
if (streamTable) {
  const markers = sqlite.prepare(
    `SELECT id, stream
     FROM stowplan_migration_stream
     ORDER BY id`,
  ).all();
  if (markers.length !== 1 || markers[0].id !== 1) {
    refuseMigrationStream("The database migration stream marker is invalid");
  }
  migrationStream = markers[0].stream;
  if (migrationStream === MigrationStream.SITES) {
    refuseMigrationStream(
      "Refusing to use a Sites migration stream with the Node runtime",
    );
  }
  if (migrationStream !== MigrationStream.NUMBERED) {
    refuseMigrationStream(
      `The database migration stream is unsupported: ${migrationStream}`,
    );
  }
}

const nodeMigrationLedger = tableMetadata(NODE_MIGRATION_LEDGER_TABLE);
if (migrationStream === MigrationStream.NUMBERED && !nodeMigrationLedger) {
  refuseMigrationStream(
    "Refusing a numbered migration stream without the Node migration ledger",
  );
}

const initialSchema = tableMetadata(WORKSPACE_SNAPSHOT_TABLE);
if (!migrationStream && initialSchema && initialSchema.strict !== 1) {
  refuseMigrationStream(
    "Refusing an unmarked non-STRICT Stowplan database in the Node runtime",
  );
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS stowplan_node_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT
`);
const appliedMigrationNames = new Set(
  sqlite.prepare("SELECT name FROM stowplan_node_migrations")
    .all()
    .map((row) => row.name),
);
if (
  initialSchema &&
  !migrationStream &&
  migrationNames[0] &&
  !appliedMigrationNames.has(migrationNames[0])
) {
  sqlite.prepare(
    "INSERT INTO stowplan_node_migrations(name, applied_at) VALUES(?,?)",
  ).run(migrationNames[0], new Date().toISOString());
  appliedMigrationNames.add(migrationNames[0]);
}
for (const migrationName of migrationNames) {
  if (appliedMigrationNames.has(migrationName)) continue;
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(readFileSync(new URL(migrationName, migrationDirectory), "utf8"));
    sqlite.prepare(
      "INSERT INTO stowplan_node_migrations(name, applied_at) VALUES(?,?)",
    ).run(migrationName, new Date().toISOString());
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

const preparedStatements = new WeakMap();
const DB = {
  prepare(sql) {
    const statement = sqlite.prepare(sql);
    const wrap = (values = []) => {
      const wrapped = {
        bind(...nextValues) {
          return wrap(nextValues);
        },
        async first() {
          return statement.get(...values) ?? null;
        },
        async all() {
          return { results: statement.all(...values) };
        },
        async run() {
          const result = statement.run(...values);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          };
        },
      };
      preparedStatements.set(wrapped, { statement, values });
      return wrapped;
    };
    return wrap();
  },
  async batch(statements) {
    const results = [];
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        const prepared = preparedStatements.get(statement);
        if (!prepared) throw new Error("Batch statement belongs to another database");
        const result = prepared.statement.run(...prepared.values);
        results.push({
          success: true,
          meta: { changes: Number(result.changes) },
        });
      }
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
};
globalThis.__STOWPLAN_ENV = { ...process.env, DB };
process.env.HOSTNAME = process.env.HOST ?? "0.0.0.0";

const standalone = resolve(".next/standalone");
const standaloneStatic = resolve(standalone, ".next/static");
const standalonePublic = resolve(standalone, "public");
if (!existsSync(resolve(standalone, "server.js"))) {
  throw new Error("Run npm run build:next before start:node");
}
if (!existsSync(standaloneStatic)) {
  cpSync(resolve(".next/static"), standaloneStatic, { recursive: true });
}
if (!existsSync(standalonePublic)) {
  cpSync(resolve("public"), standalonePublic, { recursive: true });
}
await import(new URL("../.next/standalone/server.js", import.meta.url).href);
