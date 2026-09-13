import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import { NodeSqliteSnapshotStore } from "../src/adapters/node-sqlite-snapshot-store";
import { applyCommand, createEmptyState, createEnvelope, createItem, createLocation, newId } from "../src/domain";
import { projectRecoveryReview, recoveryFieldKey } from "../src/client/conflict-review";
import { clearReplica, readReplica, reconcileReplica, writeReplica, writeReplicaIfUnchanged, type LocalReplica } from "../src/client/local-replica";
import { parseRecoveryUpload } from "../src/client/recovery-bundle";
import { synchronize } from "../src/server/sync-service";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

function fixture() {
  const state = createEmptyState("Recovery sync");
  const location = createLocation({ name: "Shelf", code: "S" });
  location.captureStatus = "in_progress";
  const item = createItem({ name: "Rice", category: "Food", locationId: location.id });
  state.locations = [location]; state.items = [item];
  const envelope = createEnvelope(state, { type: "item.update", id: item.id, changes: { category: "Grains", frequency: "daily" } });
  const replica: LocalReplica = { state: applyCommand(state, envelope).state, outbox: [{ envelope, status: "blocked", error: "Newer category" }], updatedAt: new Date().toISOString() };
  return { state, item, replica, envelope };
}

describe.each(["node", "d1"] as const)("reviewed recovery through %s", (adapter) => {
  beforeEach(async () => clearReplica());

  it("durably saves reviewed fields, deduplicates sync, and supports undo and backup", async () => {
    const node = adapter === "node" ? new NodeSqliteSnapshotStore(":memory:") : null;
    const d1 = adapter === "d1" ? numberedMigrationDatabase() : null;
    const store = node ?? new D1SnapshotStore(d1!.database);
    try {
      const { state, item, replica, envelope } = fixture();
      await store.initialize(state);
      const online = await synchronize(store, state.workspace.id, [createEnvelope(state, { type: "item.update", id: item.id, changes: { category: "Staples", description: "Shared note" } })]);
      await writeReplica(replica);
      const reviewed = projectRecoveryReview(replica, online.snapshot, [{ commandId: envelope.id, action: "apply", choices: { [recoveryFieldKey("item", item.id, "category")]: "server" } }], { createCommandId: () => newId("cmd") });
      const next = { ...replica, state: reviewed.state, outbox: reviewed.outbox, updatedAt: new Date().toISOString() };
      await writeReplicaIfUnchanged(next, replica);
      const saved = (await readReplica())!;
      expect(saved.state.items[0]).toMatchObject({ category: "Staples", frequency: "daily", description: "Shared note" });
      expect(parseRecoveryUpload(JSON.stringify({ format: "stowplan-recovery-v1", replica: saved })).bundle?.outbox).toEqual(saved.outbox);
      const response = await synchronize(store, state.workspace.id, saved.outbox.map((entry) => entry.envelope));
      expect(response.receipts[0].status).toBe("applied");
      expect((await synchronize(store, state.workspace.id, saved.outbox.map((entry) => entry.envelope))).receipts[0].status).toBe("duplicate");
      expect(reconcileReplica(saved, saved.outbox, response.snapshot, response.receipts).outbox).toEqual([]);
      const undo = await synchronize(store, state.workspace.id, [createEnvelope(response.snapshot, { type: "history.undo", activityId: `activity_${saved.outbox[0].envelope.id}` })]);
      expect(undo.snapshot.items[0]).toMatchObject({ category: "Staples", frequency: "monthly", description: "Shared note" });
    } finally { node?.close(); d1?.sqlite.close(); }
  });

  it("preserves both stale local work and a reviewed change refused by a later online edit", async () => {
    const node = adapter === "node" ? new NodeSqliteSnapshotStore(":memory:") : null;
    const d1 = adapter === "d1" ? numberedMigrationDatabase() : null;
    const store = node ?? new D1SnapshotStore(d1!.database);
    try {
      const { state, item, replica, envelope } = fixture();
      await store.initialize(state);
      const online = await synchronize(store, state.workspace.id, [createEnvelope(state, { type: "item.update", id: item.id, changes: { category: "Staples" } })]);
      const reviewed = projectRecoveryReview(replica, online.snapshot, [{ commandId: envelope.id, action: "apply", choices: { [recoveryFieldKey("item", item.id, "category")]: "device" } }], { createCommandId: () => newId("cmd") });
      const next = { ...replica, state: reviewed.state, outbox: reviewed.outbox, updatedAt: new Date().toISOString() };
      await writeReplica(replica);
      const concurrentEnvelope = createEnvelope(replica.state, { type: "workspace.rename", name: "Changed in another tab" });
      const concurrent = { ...replica, state: applyCommand(replica.state, concurrentEnvelope).state, outbox: [...replica.outbox, { envelope: concurrentEnvelope, status: "pending" as const }], updatedAt: "2026-09-13T23:00:00.000Z" };
      await writeReplica(concurrent);
      const retainedBeforeSave = await readReplica();
      await expect(writeReplicaIfUnchanged(next, replica)).rejects.toThrow(/changed after recovery/);
      expect(await readReplica()).toEqual(retainedBeforeSave);
      expect((await readReplica())?.outbox).toEqual(concurrent.outbox);
      const newer = await synchronize(store, state.workspace.id, [createEnvelope(online.snapshot, { type: "item.update", id: item.id, changes: { category: "Latest online" } })]);
      const refused = await synchronize(store, state.workspace.id, next.outbox.map((entry) => entry.envelope));
      expect(refused.receipts[0].status).toBe("rejected");
      const retained = reconcileReplica(next, next.outbox, refused.snapshot, refused.receipts);
      expect(retained.state.items[0].category).toBe("Grains");
      expect(retained.outbox[0].status).toBe("blocked");
      expect((await store.load(state.workspace.id))?.items[0].category).toBe(newer.snapshot.items[0].category);
    } finally { node?.close(); d1?.sqlite.close(); }
  });
});
