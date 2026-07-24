import { describe, expect, it } from "vitest";
import {
    applyCommand,
    createDemoState,
    createEnvelope,
    generatePlan,
} from "../src/domain";
import { MemorySnapshotStore, synchronize } from "../src/server";

function editableDemoState() {
    const state = createDemoState();
    state.locations.find((location) => location.id === "loc_warm")!.captureStatus =
        "in_progress";
    return state;
}

describe("synchronization", () => {
    it("deduplicates retries by command id", async () => {
        const initial = editableDemoState();
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

    it("rejects a malformed command envelope without failing the sync batch", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const malformed = {
            ...createEnvelope(
                initial,
                { type: "workspace.rename", name: "Should not apply" },
                { id: "cmd_malformed" },
            ),
            expectations: null,
        };

        const result = await synchronize(
            store,
            initial.workspace.id,
            [malformed as never],
        );

        expect(result.receipts[0]).toMatchObject({
            commandId: "cmd_malformed",
            status: "rejected",
        });
        expect(result.receipts[0]?.message).toContain("INVALID_COMMAND");
        expect(result.snapshot.workspace.name).toBe("Kitchen reset");
    });

    it("rejects an empty command identity without applying it on retries", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const malformed = createEnvelope(
            initial,
            { type: "workspace.rename", name: "Must not apply" },
            { id: "temporary" },
        );
        malformed.id = "";
        malformed.expectations = [];

        const first = await synchronize(store, initial.workspace.id, [malformed]);
        const second = await synchronize(store, initial.workspace.id, [malformed]);

        expect(first.receipts[0]).toMatchObject({
            commandId: "invalid-command-1",
            status: "rejected",
        });
        expect(second.snapshot.workspace.revision).toBe(initial.workspace.revision);
        expect(second.snapshot.workspace.name).toBe(initial.workspace.name);
        expect(second.snapshot.activities.filter((activity) => activity.commandId === "")).toEqual([]);
    });

    it("merges stale edits to unrelated fields", async () => {
        const initial = editableDemoState();
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
        const initial = editableDemoState();
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

    it("requires a fresh subtree review when a contained item changes before deletion", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const deletion = createEnvelope(
            initial,
            {
                type: "location.delete",
                descendantIds: [],
                id: "loc_box",
                itemIds: ["item_lids", "item_manuals"],
            },
            { id: "cmd_stale_subtree_delete" },
        );
        const remote = createEnvelope(
            initial,
            {
                type: "item.update",
                id: "item_lids",
                changes: { notes: "Edited on another device" },
            },
            { id: "cmd_remote_nested_edit" },
        );
        await synchronize(store, initial.workspace.id, [remote]);

        const result = await synchronize(store, initial.workspace.id, [deletion]);

        expect(result.receipts[0]?.status).toBe("rejected");
        expect(result.receipts[0]?.conflicts?.some(
            (conflict) => conflict.id === "item_lids",
        )).toBe(true);
        expect(result.snapshot.locations.some((location) => location.id === "loc_box")).toBe(true);
    });

    it("does not let a later command in a divergent batch bypass field expectations", async () => {
        const initial = editableDemoState();
        const store = new MemorySnapshotStore([initial]);
        const remote = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { quantity: 9 } },
            { id: "cmd_remote_quantity" },
        );
        const firstOffline = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { quantity: 7 } },
            { id: "cmd_offline_first" },
        );
        const afterFirstOffline = applyCommand(initial, firstOffline).state;
        const secondOffline = createEnvelope(
            afterFirstOffline,
            { type: "item.update", id: "item_pasta", changes: { quantity: 8 } },
            { id: "cmd_offline_second" },
        );

        await synchronize(store, initial.workspace.id, [remote]);
        const result = await synchronize(
            store,
            initial.workspace.id,
            [firstOffline, secondOffline],
        );

        expect(result.receipts.map((receipt) => receipt.status)).toEqual([
            "rejected",
            "rejected",
        ]);
        expect(result.snapshot.items.find((item) => item.id === "item_pasta")?.quantity).toBe(9);
    });

    it("applies an independent queued command after an earlier optimistic command is rejected", async () => {
        const initial = editableDemoState();
        const store = new MemorySnapshotStore([initial]);
        const rejected = createEnvelope(
            initial,
            { type: "item.update", id: "item_pasta", changes: { quantity: 7 } },
            { id: "cmd_rejected_head" },
        );
        rejected.expectations[0]!.value = 999;
        const optimistic = applyCommand(initial, {
            ...rejected,
            expectations: createEnvelope(
                initial,
                { type: "item.update", id: "item_pasta", changes: { quantity: 7 } },
            ).expectations,
        }).state;
        const independent = createEnvelope(
            optimistic,
            { type: "item.update", id: "item_pasta", changes: { notes: "Offline note" } },
            { id: "cmd_independent_tail" },
        );

        const result = await synchronize(
            store,
            initial.workspace.id,
            [rejected, independent],
        );

        expect(result.receipts.map((receipt) => receipt.status)).toEqual([
            "rejected",
            "applied",
        ]);
        expect(result.snapshot.items.find((item) => item.id === "item_pasta")).toMatchObject({
            notes: "Offline note",
            quantity: 6,
        });
    });

    it("allows only one concurrently generated active plan", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const first = generatePlan(initial, { name: "First device plan" });
        const second = generatePlan(initial, { name: "Second device plan" });
        const firstCommand = createEnvelope(
            initial,
            { type: "plan.create", plan: first },
            { id: "cmd_first_plan" },
        );
        const secondCommand = createEnvelope(
            initial,
            { type: "plan.create", plan: second },
            { id: "cmd_second_plan" },
        );

        await synchronize(store, initial.workspace.id, [firstCommand]);
        const result = await synchronize(store, initial.workspace.id, [secondCommand]);

        expect(result.receipts[0]?.status).toBe("rejected");
        expect(result.snapshot.plans.filter((plan) => plan.status === "active")).toHaveLength(1);
        expect(result.snapshot.plans.find((plan) => plan.id === first.id)?.status).toBe("active");
    });

    it("rejects completion from another device after a plan is discarded", async () => {
        const initial = createDemoState();
        const store = new MemorySnapshotStore([initial]);
        const plan = generatePlan(initial, { name: "Shared plan" });
        const created = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                initial,
                { type: "plan.create", plan },
                { id: "cmd_create_shared_plan" },
            ),
        ]);
        const itemStep = plan.steps.find((step) => step.type === "item");
        expect(itemStep?.itemId).toBeTruthy();
        const completion = createEnvelope(
            created.snapshot,
            {
                type: "plan.step.complete",
                planId: plan.id,
                stepId: itemStep!.id,
            },
            { id: "cmd_stale_completion" },
        );
        const discard = createEnvelope(
            created.snapshot,
            { type: "plan.status", planId: plan.id, status: "discarded" },
            { id: "cmd_discard_shared_plan" },
        );
        const before = created.snapshot.items.find((item) => item.id === itemStep!.itemId)?.locationId;

        await synchronize(store, initial.workspace.id, [discard]);
        const result = await synchronize(store, initial.workspace.id, [completion]);

        expect(result.receipts[0].status).toBe("rejected");
        expect(result.snapshot.items.find((item) => item.id === itemStep!.itemId)?.locationId).toBe(before);
    });

    it("serializes concurrent batches with optimistic retries", async () => {
        const initial = editableDemoState();
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
