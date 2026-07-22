import { afterEach, describe, expect, it } from "vitest";
import { createDemoState, createEnvelope } from "../src/domain";
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
});
