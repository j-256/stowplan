import { afterEach, describe, expect, it } from "vitest";
import { createDemoState, createEmptyState, createEnvelope } from "../src/domain";
import { NodeSqliteSnapshotStore } from "../src/adapters/node-sqlite-snapshot-store";
import { synchronize } from "../src/server";

describe("Node SQLite adapter conformance", () => {
    let store: NodeSqliteSnapshotStore | null = null;

    afterEach(() => {
        store?.close();
        store = null;
    });

    it("initializes, loads, and compare-and-swaps the same protocol as D1", async () => {
        const initial = createDemoState();
        store = new NodeSqliteSnapshotStore(":memory:");
        expect(await store.initialize(initial)).toBe("created");
        expect(await store.initialize(initial)).toBe("exists");

        const result = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                initial,
                { type: "workspace.rename", name: "SQLite home" },
                { id: "cmd_sqlite" },
            ),
        ]);
        expect(result.snapshot.workspace.name).toBe("SQLite home");
        expect((await store.load(initial.workspace.id))?.workspace.revision).toBe(1);
    });

    it("records server persistence time separately from client workspace time", async () => {
        const clientTime = "2000-01-01T00:00:00.000Z";
        const initial = createEmptyState("Client clock", clientTime);
        store = new NodeSqliteSnapshotStore(":memory:");

        expect(await store.initialize(initial)).toBe("created");

        const row = store.database.prepare(
            `SELECT created_at, updated_at
             FROM workspace_snapshots
             WHERE workspace_id = ?`,
        ).get(initial.workspace.id) as {
            created_at: string;
            updated_at: string;
        };
        expect(row.created_at).toBe(row.updated_at);
        expect(row.updated_at).not.toBe(clientTime);
        expect((await store.load(initial.workspace.id))?.workspace.updatedAt)
            .toBe(clientTime);
    });

    it("refuses to recreate a permanently deleted workspace", async () => {
        const initial = createDemoState();
        store = new NodeSqliteSnapshotStore(":memory:");
        store.database.prepare(
            `INSERT INTO workspace_deletions(
               workspace_id, deletion_id, deleted_at, deleted_by_user_id,
               final_snapshot_revision, final_access_revision
             ) VALUES(?,?,?,?,?,?)`,
        ).run(
            initial.workspace.id,
            "delete_sqlite",
            "2026-07-25T00:00:00.000Z",
            null,
            initial.workspace.revision,
            0,
        );

        expect(await store.initialize(initial)).toBe("deleted");
        expect(await store.load(initial.workspace.id)).toBeNull();
    });

    it("guards workspace access revisions at JavaScript's safe limit", async () => {
        const initial = createDemoState();
        store = new NodeSqliteSnapshotStore(":memory:");
        expect(await store.initialize(initial)).toBe("created");

        store.database.prepare(
            `UPDATE workspace_snapshots
             SET access_revision = 1
             WHERE workspace_id = ?`,
        ).run(initial.workspace.id);
        expect(() => store?.database.prepare(
            `UPDATE workspace_snapshots
             SET access_revision = 0
             WHERE workspace_id = ?`,
        ).run(initial.workspace.id)).toThrow(/monotonic/);
        expect(() => store?.database.prepare(
            `UPDATE workspace_snapshots
             SET access_revision = ?
             WHERE workspace_id = ?`,
        ).run(Number.MAX_SAFE_INTEGER + 1, initial.workspace.id))
            .toThrow(/JavaScript-safe/);
        expect(store.database.prepare(
            `SELECT access_revision
             FROM workspace_snapshots
             WHERE workspace_id = ?`,
        ).get(initial.workspace.id)).toEqual({ access_revision: 1 });
    });
});
