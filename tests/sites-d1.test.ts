import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  D1SnapshotStore,
  type D1DatabaseLike,
} from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import {
  claimWorkspace,
  createOrLinkUser,
} from "../src/server/auth";

function sitesDatabase(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationFiles = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    sqlite.exec(readFileSync(
      new URL(migrationFile, migrationDirectory),
      "utf8",
    ).replaceAll("--> statement-breakpoint", ""));
  }
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      const wrapped = (values: unknown[] = []) => ({
        bind(...next: unknown[]) {
          return wrapped(next);
        },
        first: async () =>
          statement.get(...values as SQLInputValue[]) as never,
        run: async () => {
          const result = statement.run(...values as SQLInputValue[]);
          return {
            meta: { changes: Number(result.changes) },
            success: true,
          };
        },
      });
      return wrapped();
    },
  };
}

describe("Sites D1 packaging", () => {
  it("declares DB and migrates the persistence and collaboration schema", async () => {
    const hosting = JSON.parse(readFileSync(
      new URL("../.openai/hosting.json", import.meta.url),
      "utf8",
    )) as { d1?: string };
    expect(hosting.d1).toBe("DB");

    const database = sitesDatabase();
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
  });
});
