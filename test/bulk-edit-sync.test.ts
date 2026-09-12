import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import { NodeSqliteSnapshotStore } from "../src/adapters/node-sqlite-snapshot-store";
import { applyCommand } from "../src/domain/commands";
import { emptyBulkEditDraft, planBulkEdit } from "../src/domain/bulk-edit";
import { createDemoState } from "../src/domain/demo";
import { createEnvelope } from "../src/domain/factories";
import { validateSnapshot } from "../src/domain/import";
import { clearReplica, readReplica, reconcileReplica, writeReplica } from "../src/client/local-replica";
import { synchronize } from "../src/server/sync-service";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

describe.each(["node", "d1"] as const)("bulk edit %s persistence and offline replay", (adapter) => {
    beforeEach(async () => clearReplica());

    it("retains one offline command, merges unrelated remote work, deduplicates retries, and restores history", async () => {
        const node = adapter === "node" ? new NodeSqliteSnapshotStore(":memory:") : null;
        const d1 = adapter === "d1" ? numberedMigrationDatabase() : null;
        const store = node ?? new D1SnapshotStore(d1!.database);
        try {
            const initial = createDemoState();
            initial.locations.forEach((location) => { location.captureStatus = "in_progress"; });
            await store.initialize(initial);
            const ids = initial.items.slice(0, 2).map((item) => item.id);
            const preview = planBulkEdit(initial, ids, {
                ...emptyBulkEditDraft(), category: "Camping", constraints: { avoidHumidity: true },
            });
            const envelope = createEnvelope(initial, preview.command!, { id: "cmd_offline_bulk", expectations: preview.expectations });
            const local = applyCommand(initial, envelope).state;
            await writeReplica({ state: local, outbox: [{ envelope, status: "pending" }], updatedAt: local.workspace.updatedAt });
            const saved = await readReplica();
            expect(saved?.outbox).toHaveLength(1);
            expect(saved?.outbox[0]?.envelope).toEqual(envelope);
            expect(validateSnapshot(JSON.parse(JSON.stringify(saved!.state))).filter((issue) => issue.severity === "error")).toEqual([]);

            const remote = createEnvelope(initial, { type: "item.update", id: ids[0]!, changes: { description: "Written on another device" } });
            await synchronize(store, initial.workspace.id, [remote]);
            const response = await synchronize(store, initial.workspace.id, saved!.outbox.map((entry) => entry.envelope));
            expect(response.receipts[0]?.status).toBe("applied");
            const duplicate = await synchronize(store, initial.workspace.id, [envelope]);
            expect(duplicate.receipts[0]?.status).toBe("duplicate");
            const reconciled = reconcileReplica(saved!, saved!.outbox, response.snapshot, response.receipts);
            expect(reconciled.outbox).toEqual([]);
            expect(reconciled.state.items[0]?.description).toBe("Written on another device");
            expect(reconciled.state.items.slice(0, 2).every((item) => item.category === "Camping")).toBe(true);
            const persisted = (await store.load(initial.workspace.id))!;
            const undo = createEnvelope(persisted, { type: "history.undo", activityId: `activity_${envelope.id}` });
            const undone = await synchronize(store, initial.workspace.id, [undo]);
            expect(undone.receipts[0]?.status).toBe("applied");
            expect(undone.snapshot.items[0]?.description).toBe("Written on another device");
            expect(undone.snapshot.items.slice(0, 2).map((item) => item.category)).toEqual(initial.items.slice(0, 2).map((item) => item.category));
        } finally {
            node?.close();
            d1?.sqlite.close();
        }
    });

    it("preserves the whole refused batch in the outbox after a same-field remote edit", async () => {
        const node = adapter === "node" ? new NodeSqliteSnapshotStore(":memory:") : null;
        const d1 = adapter === "d1" ? numberedMigrationDatabase() : null;
        const store = node ?? new D1SnapshotStore(d1!.database);
        try {
            const initial = createDemoState();
            initial.locations.forEach((location) => { location.captureStatus = "in_progress"; });
            await store.initialize(initial);
            const ids = initial.items.slice(0, 2).map((item) => item.id);
            const preview = planBulkEdit(initial, ids, { ...emptyBulkEditDraft(), category: "Camping" });
            const envelope = createEnvelope(initial, preview.command!);
            const local = applyCommand(initial, envelope).state;
            await writeReplica({ state: local, outbox: [{ envelope, status: "pending" }], updatedAt: local.workspace.updatedAt });
            const remote = createEnvelope(initial, { type: "item.update", id: ids[1]!, changes: { category: "Remote" } });
            await synchronize(store, initial.workspace.id, [remote]);
            const saved = (await readReplica())!;
            const response = await synchronize(store, initial.workspace.id, [envelope]);
            expect(response.receipts[0]?.status).toBe("rejected");
            expect(response.snapshot.items[0]?.category).toBe(initial.items[0]?.category);
            expect(response.snapshot.items[1]?.category).toBe("Remote");
            const reconciled = reconcileReplica(saved, saved.outbox, response.snapshot, response.receipts);
            expect(reconciled.outbox).toMatchObject([{ status: "blocked", envelope }]);
            expect(reconciled.state).toEqual(local);
        } finally {
            node?.close();
            d1?.sqlite.close();
        }
    });
});
