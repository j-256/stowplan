import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import { NodeSqliteSnapshotStore } from "../src/adapters/node-sqlite-snapshot-store";
import { applyCommand, createDemoState, createEnvelope, generatePlan, validateSnapshot } from "../src/domain";
import { clearReplica, readReplica, reconcileReplica, writeReplica } from "../src/client/local-replica";
import { synchronize } from "../src/server/sync-service";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

describe.each(["node", "d1"] as const)("scoped plan %s offline replay", (adapter) => {
    beforeEach(async () => clearReplica());

    it("persists selected areas and pins, executes once, and undoes a move", async () => {
        const node = adapter === "node" ? new NodeSqliteSnapshotStore(":memory:") : null;
        const d1 = adapter === "d1" ? numberedMigrationDatabase() : null;
        const store = node ?? new D1SnapshotStore(d1!.database);
        try {
            const initial = createDemoState();
            await store.initialize(initial);
            const plan = generatePlan(initial, { selection: { locationIds: ["loc_left"], pinnedItemIds: ["item_rice"], pinnedLocationIds: [] } });
            const envelope = createEnvelope(initial, { type: "plan.create", plan });
            const local = applyCommand(initial, envelope).state;
            await writeReplica({ state: local, outbox: [{ envelope, status: "pending" }], updatedAt: local.workspace.updatedAt });
            const replica = (await readReplica())!;
            expect(replica.state.plans[0]?.selection).toEqual(plan.selection);
            const response = await synchronize(store, initial.workspace.id, replica.outbox.map((entry) => entry.envelope));
            expect(response.receipts[0]?.status).toBe("applied");
            expect(reconcileReplica(replica, replica.outbox, response.snapshot, response.receipts).outbox).toEqual([]);
            const step = plan.steps[0]!;
            const move = createEnvelope(response.snapshot, { type: "plan.step.complete", planId: plan.id, stepId: step.id });
            const moved = await synchronize(store, initial.workspace.id, [move]);
            expect(moved.receipts[0]?.status).toBe("applied");
            expect((await synchronize(store, initial.workspace.id, [move])).receipts[0]?.status).toBe("duplicate");
            const loaded = (await store.load(initial.workspace.id))!;
            const undo = createEnvelope(loaded, { type: "history.undo", activityId: `activity_${move.id}` });
            const undone = await synchronize(store, initial.workspace.id, [undo]);
            expect(undone.receipts[0]?.status).toBe("applied");
            expect(undone.snapshot.items.find((item) => item.id === step.itemId)?.locationId).toBe(step.sourceId);
            expect(undone.snapshot.plans[0]?.selection).toEqual(plan.selection);
            expect(validateSnapshot(undone.snapshot).filter((issue) => issue.severity === "error")).toEqual([]);
        } finally { node?.close(); d1?.sqlite.close(); }
    });
});
