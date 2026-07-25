import {
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
} from "node:sqlite";
import type {
  D1DatabaseLike,
  D1ResultLike,
  D1StatementLike,
} from "../../src/adapters/d1-snapshot-store";

interface PreparedStatement {
  statement: ReturnType<DatabaseSync["prepare"]>;
  values: SQLInputValue[];
}

interface SqliteD1Options {
  triggerInclusiveChanges?: boolean;
}

function totalChanges(sqlite: DatabaseSync): number {
  const row = sqlite.prepare(
    "SELECT total_changes() AS count",
  ).get() as { count: number };
  return Number(row.count);
}

export function applySqlDirectory(
  sqlite: DatabaseSync,
  directory: URL,
): void {
  const migrationFiles = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    sqlite.exec(readFileSync(
      new URL(migrationFile, directory),
      "utf8",
    ).replaceAll("--> statement-breakpoint", ""));
  }
}

export function sqliteD1Database(
  sqlite: DatabaseSync,
  options: SqliteD1Options = {},
): D1DatabaseLike {
  const preparedStatements = new WeakMap<
    D1StatementLike,
    PreparedStatement
  >();
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      const wrapped = (
        values: SQLInputValue[] = [],
      ): D1StatementLike => {
        const result: D1StatementLike = {
          bind(...next: unknown[]) {
            return wrapped(next as SQLInputValue[]);
          },
          first: async <T>() =>
            statement.get(...values) as T | undefined ?? null,
          all: async <T>() => ({
            meta: { changes: 0 },
            results: statement.all(...values) as T[],
            success: true,
          }),
          run: async () => {
            const before = options.triggerInclusiveChanges
              ? totalChanges(sqlite)
              : 0;
            const execution = statement.run(...values);
            return {
              meta: {
                changes: options.triggerInclusiveChanges
                  ? totalChanges(sqlite) - before
                  : Number(execution.changes),
              },
              success: true,
            };
          },
        };
        preparedStatements.set(result, { statement, values });
        return result;
      };
      return wrapped();
    },
    async batch(statements: D1StatementLike[]) {
      const results: D1ResultLike[] = [];
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of statements) {
          const prepared = preparedStatements.get(statement);
          if (!prepared) {
            throw new Error("Batch statement belongs to another database");
          }
          if (prepared.statement.columns().length > 0) {
            results.push({
              meta: { changes: 0 },
              results: prepared.statement.all(...prepared.values),
              success: true,
            });
            continue;
          }
          const before = options.triggerInclusiveChanges
            ? totalChanges(sqlite)
            : 0;
          const execution = prepared.statement.run(...prepared.values);
          results.push({
            meta: {
              changes: options.triggerInclusiveChanges
                ? totalChanges(sqlite) - before
                : Number(execution.changes),
            },
            success: true,
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
}

export function numberedMigrationDatabase(
  options: SqliteD1Options = {},
): {
  database: D1DatabaseLike;
  sqlite: DatabaseSync;
} {
  const sqlite = new DatabaseSync(":memory:");
  applySqlDirectory(
    sqlite,
    new URL("../../migrations/", import.meta.url),
  );
  return { database: sqliteD1Database(sqlite, options), sqlite };
}
