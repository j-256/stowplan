import { describe, expect, it } from "vitest";
import { createDemoState, createEnvelope } from "../src/domain";
import { MemorySnapshotStore, synchronize } from "../src/server";

describe("synchronization", () => {
    it("deduplicates retries by command id", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const command = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { quantity: 10 } },
            { id: "cmd_retry" },
        );
        const first = await synchronize(store, initial.workspace.id, [command]);
        const second = await synchronize(store, initial.workspace.id, [command]);
        expect(first.receipts[0].status).toBe("applied");
        expect(second.receipts[0].status).toBe("duplicate");
        expect(second.snapshot.workspace.revision).toBe(1);
    });

    it("merges stale edits to unrelated fields", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const remote = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { notes: "Remote note" } },
            { id: "cmd_remote" },
        );
        const local = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { quantity: 12 } },
            { id: "cmd_local" },
        );
        await synchronize(store, initial.workspace.id, [remote]);
        const result = await synchronize(store, initial.workspace.id, [local]);
        const pasta = result.snapshot.items.find((item) => item.id === "item_pasta");
        expect(result.receipts[0].status).toBe("applied");
        expect(pasta?.notes).toBe("Remote note");
        expect(pasta?.quantity).toBe(12);
    });

    it("pauses stale same-field edits for review", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const first = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { quantity: 7 } },
            { id: "cmd_first" },
        );
        const stale = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { quantity: 8 } },
            { id: "cmd_stale" },
        );
        await synchronize(store, initial.workspace.id, [first]);
        const result = await synchronize(store, initial.workspace.id, [stale]);
        expect(result.receipts[0].status).toBe("rejected");
        expect(result.receipts[0].conflicts?.[0].field).toBe("quantity");
        expect(result.snapshot.items.find((item) => item.id === "item_pasta")?.quantity).toBe(7);
    });

    it("serializes concurrent batches with optimistic retries", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const note = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { notes: "A" } },
            { id: "cmd_a" },
        );
        const quantity = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { quantity: 11 } },
            { id: "cmd_b" },
        );
        await Promise.all([
            synchronize(store, initial.workspace.id, [note]),
            synchronize(store, initial.workspace.id, [quantity]),
        ]);
        const final = await store.load(initial.workspace.id);
        expect(final?.workspace.revision).toBe(2);
        expect(final?.items.find((item) => item.id === "item_pasta")).toMatchObject({
            notes: "A",
            quantity: 11,
        });
    });
});
