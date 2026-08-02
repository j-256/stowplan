import { describe, expect, it } from "vitest";
import {
    applyCommand,
    createDemoState,
    createEnvelope,
    generatePlan,
    type ActivityRecord,
    type AuditEvent,
} from "../src/domain";
import type {
    SnapshotAuthorizationExpectation,
    WorkspaceAuthorizationState,
} from "../src/adapters/d1-snapshot-store";
import type { WorkspaceRole } from "../src/domain/workspace-access";
import type { WorkspaceState } from "../src/domain/types";
import {
    MemorySnapshotStore,
    synchronize,
    WorkspaceSyncAuthorizationError,
} from "../src/server";
import { serializedJsonBytes } from "../src/server/quotas";
import { API_QUOTAS } from "../src/shared/api-quotas";

class AuthorizedMemorySnapshotStore extends MemorySnapshotStore {
    authorization: WorkspaceAuthorizationState;
    beforeAuthorizedSwap?: () => void;

    constructor(
        state: WorkspaceState,
        role: WorkspaceRole | null = "editor",
    ) {
        super([state]);
        this.authorization = {
            accessRevision: 7,
            active: true,
            deleted: false,
            membershipRevision: 11,
            role,
        };
    }

    async loadAuthorization() {
        return structuredClone(this.authorization);
    }

    async loadAuthorized(workspaceId: string) {
        const state = await this.load(workspaceId);
        const authorization = this.authorization;
        if (
            !state ||
            !authorization.active ||
            authorization.deleted ||
            !authorization.role ||
            authorization.accessRevision === null
        ) {
            return null;
        }
        return {
            accessRevision: authorization.accessRevision,
            membershipRevision: authorization.membershipRevision,
            role: authorization.role,
            state,
        };
    }

    async compareAndSwapAuthorized(
        workspaceId: string,
        expectedRevision: number,
        state: WorkspaceState,
        expected: SnapshotAuthorizationExpectation,
    ) {
        const beforeSwap = this.beforeAuthorizedSwap;
        this.beforeAuthorizedSwap = undefined;
        beforeSwap?.();
        const authorization = this.authorization;
        const roleAccepted = expected.requiredRole === "owner"
            ? authorization.role === "owner"
            : authorization.role === "owner" ||
                authorization.role === "editor";
        const basisAccepted =
            authorization.membershipRevision ===
                expected.membershipRevision ||
            authorization.accessRevision === expected.accessRevision;
        if (
            !authorization.active ||
            authorization.deleted ||
            !roleAccepted ||
            !basisAccepted
        ) {
            return false;
        }
        return this.compareAndSwap(
            workspaceId,
            expectedRevision,
            state,
        );
    }
}

function editableDemoState() {
    const state = createDemoState();
    state.locations.find((location) => location.id === "loc_warm")!.captureStatus =
        "in_progress";
    return state;
}

function retainedActivity(index: number): ActivityRecord {
    return {
        actorId: "u",
        commandId: `c${index}`,
        id: `a${index}`,
        label: "",
        patches: [],
        status: "applied",
        subjectIds: [],
        timestamp: "t",
        undoneAt: null,
    };
}

function retainedAudit(index: number, activityId: string): AuditEvent {
    return {
        actorId: "u",
        id: `audit_h${index}`,
        label: "Undid 1 change",
        targetActivityIds: [activityId],
        timestamp: "t",
        type: "undo",
    };
}

describe("synchronization", () => {
    it("rejects viewer commands before applying workspace state", async () => {
        const initial = editableDemoState();
        const store = new AuthorizedMemorySnapshotStore(
            initial,
            "viewer",
        );
        const command = createEnvelope(
            initial,
            {
                changes: { quantity: 10 },
                id: "item_pasta",
                type: "item.update",
            },
            { id: "cmd_viewer_write" },
        );

        let refusal: WorkspaceSyncAuthorizationError | null = null;
        try {
            await synchronize(
                store,
                initial.workspace.id,
                [command],
                {
                    authorization: {
                        basis: {
                            membershipRevision: 11,
                            workspaceAccessRevision: 7,
                        },
                        userId: "usr_viewer",
                    },
                },
            );
        } catch (error) {
            if (error instanceof WorkspaceSyncAuthorizationError) {
                refusal = error;
            } else {
                throw error;
            }
        }

        expect(refusal).toMatchObject({
            authorization: {
                role: "viewer",
            },
            failure: "write",
            receipts: [{
                commandId: "cmd_viewer_write",
                status: "rejected",
            }],
        });
        expect(
            (await store.load(initial.workspace.id))?.items.find(
                item => item.id === "item_pasta",
            )?.quantity,
        ).toBe(6);
    });

    it("rechecks a role downgrade at the final authorized swap", async () => {
        const initial = editableDemoState();
        const store = new AuthorizedMemorySnapshotStore(initial);
        const command = createEnvelope(
            initial,
            {
                changes: { quantity: 10 },
                id: "item_pasta",
                type: "item.update",
            },
            { id: "cmd_downgrade_race" },
        );
        store.beforeAuthorizedSwap = () => {
            store.authorization = {
                accessRevision: 8,
                active: true,
                deleted: false,
                membershipRevision: 12,
                role: "viewer",
            };
        };

        let refusal: WorkspaceSyncAuthorizationError | null = null;
        try {
            await synchronize(
                store,
                initial.workspace.id,
                [command],
                {
                    authorization: {
                        basis: {
                            membershipRevision: 11,
                            workspaceAccessRevision: 7,
                        },
                        userId: "usr_editor",
                    },
                },
            );
        } catch (error) {
            if (error instanceof WorkspaceSyncAuthorizationError) {
                refusal = error;
            } else {
                throw error;
            }
        }

        expect(refusal).toMatchObject({
            authorization: {
                accessRevision: 8,
                membershipRevision: 12,
                role: "viewer",
            },
            failure: "write",
            receipts: [{
                commandId: "cmd_downgrade_race",
                message: expect.stringContaining("Viewer"),
                revision: initial.workspace.revision,
                status: "rejected",
            }],
        });
        expect(
            (await store.load(initial.workspace.id))?.items.find(
                item => item.id === "item_pasta",
            )?.quantity,
        ).toBe(6);
    });

    it("accepts authorization when either paired counter still matches", async () => {
        const membershipChanged = editableDemoState();
        const membershipStore = new AuthorizedMemorySnapshotStore(
            membershipChanged,
        );
        membershipStore.authorization.membershipRevision = 12;
        const membershipResult = await synchronize(
            membershipStore,
            membershipChanged.workspace.id,
            [
                createEnvelope(
                    membershipChanged,
                    {
                        changes: { notes: "Membership counter changed" },
                        id: "item_pasta",
                        type: "item.update",
                    },
                    { id: "cmd_membership_counter" },
                ),
            ],
            {
                authorization: {
                    basis: {
                        membershipRevision: 11,
                        workspaceAccessRevision: 7,
                    },
                    userId: "usr_editor",
                },
            },
        );
        expect(membershipResult.receipts[0]?.status).toBe("applied");

        const accessChanged = editableDemoState();
        const accessStore = new AuthorizedMemorySnapshotStore(
            accessChanged,
        );
        accessStore.authorization.accessRevision = 8;
        const accessResult = await synchronize(
            accessStore,
            accessChanged.workspace.id,
            [
                createEnvelope(
                    accessChanged,
                    {
                        changes: { notes: "Access counter changed" },
                        id: "item_pasta",
                        type: "item.update",
                    },
                    { id: "cmd_access_counter" },
                ),
            ],
            {
                authorization: {
                    basis: {
                        membershipRevision: 11,
                        workspaceAccessRevision: 7,
                    },
                    userId: "usr_editor",
                },
            },
        );
        expect(accessResult.receipts[0]?.status).toBe("applied");
    });

    it("rejects stale commands when both paired counters changed", async () => {
        const initial = editableDemoState();
        const store = new AuthorizedMemorySnapshotStore(initial);
        store.authorization.accessRevision = 8;
        store.authorization.membershipRevision = 12;
        const command = createEnvelope(
            initial,
            {
                changes: { notes: "Stale edit" },
                id: "item_pasta",
                type: "item.update",
            },
            { id: "cmd_stale_access" },
        );

        await expect(synchronize(
            store,
            initial.workspace.id,
            [command],
            {
                authorization: {
                    basis: {
                        membershipRevision: 11,
                        workspaceAccessRevision: 7,
                    },
                    userId: "usr_editor",
                },
            },
        )).rejects.toMatchObject({
            failure: "stale",
            receipts: [{
                commandId: "cmd_stale_access",
                status: "rejected",
            }],
        });
        expect(
            (await store.load(initial.workspace.id))?.items.find(
                item => item.id === "item_pasta",
            )?.notes,
        ).toBe("");
    });

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

    it("accepts a stale undo after an unrelated remote edit to the same item", async () => {
        const initial = editableDemoState();
        const store = new MemorySnapshotStore([initial]);
        const changed = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                initial,
                {
                    type: "item.update",
                    id: "item_pasta",
                    changes: { quantity: 7 },
                },
                { id: "cmd_history_sync_quantity" },
            ),
        ]);
        const activityId = changed.snapshot.activities.at(-1)!.id;
        const staleUndo = createEnvelope(
            changed.snapshot,
            { type: "history.undo", activityId },
            { id: "cmd_history_sync_undo", actorId: "user_undo" },
        );
        const remoteNotes = createEnvelope(
            changed.snapshot,
            {
                type: "item.update",
                id: "item_pasta",
                changes: { notes: "Remote note after quantity" },
            },
            { id: "cmd_history_sync_notes", actorId: "user_remote" },
        );
        const remotelyChanged = await synchronize(
            store,
            initial.workspace.id,
            [remoteNotes],
        );
        const versionBeforeUndo = remotelyChanged.snapshot.items.find(
            (item) => item.id === "item_pasta",
        )!.version;

        const undone = await synchronize(
            store,
            initial.workspace.id,
            [staleUndo],
        );
        expect(undone.receipts[0]).toMatchObject({ status: "applied" });
        expect(undone.snapshot.items.find((item) => item.id === "item_pasta"))
            .toMatchObject({
                notes: "Remote note after quantity",
                quantity: 6,
                version: versionBeforeUndo + 1,
            });
        expect(undone.snapshot.audit.at(-1)).toMatchObject({
            actorId: "user_undo",
            targetActivityIds: [activityId],
            type: "undo",
        });
    });

    it("rejects a stale undo after a remote edit to the same meaningful field", async () => {
        const initial = editableDemoState();
        const store = new MemorySnapshotStore([initial]);
        const changed = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                initial,
                {
                    type: "item.update",
                    id: "item_pasta",
                    changes: { quantity: 7 },
                },
                { id: "cmd_history_sync_first_quantity" },
            ),
        ]);
        const activityId = changed.snapshot.activities.at(-1)!.id;
        const staleUndo = createEnvelope(
            changed.snapshot,
            { type: "history.undo", activityId },
            { id: "cmd_history_sync_conflicting_undo" },
        );
        const remoteQuantity = createEnvelope(
            changed.snapshot,
            {
                type: "item.update",
                id: "item_pasta",
                changes: { quantity: 8 },
            },
            { id: "cmd_history_sync_second_quantity" },
        );
        await synchronize(store, initial.workspace.id, [remoteQuantity]);

        const rejected = await synchronize(
            store,
            initial.workspace.id,
            [staleUndo],
        );
        expect(rejected.receipts[0]).toMatchObject({
            conflicts: [expect.objectContaining({ field: "quantity" })],
            status: "rejected",
        });
        expect(rejected.snapshot.items.find((item) => item.id === "item_pasta")?.quantity)
            .toBe(8);
        expect(rejected.snapshot.activities.find(
            (activity) => activity.id === activityId,
        )?.status).toBe("applied");
        expect(rejected.snapshot.audit).toEqual([]);
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

    it("applies commands through the snapshot limit and rejects the overage", async () => {
        const initial = createDemoState();
        const template = initial.items[0]!;
        initial.locations.find(
            (location) => location.id === template.locationId,
        )!.captureStatus = "in_progress";
        initial.items = Array.from(
            { length: API_QUOTAS.itemsPerSnapshot - 1 },
            (_, index) => ({
                ...template,
                constraints: {
                    ...template.constraints,
                    requiredTags: [],
                },
                id: `item_quota_${index}`,
                name: "Stored item",
                notes: "",
                tags: [],
            }),
        );
        initial.activities = [];
        initial.audit = [];
        initial.plans = [];
        const first = {
            ...template,
            id: "item_quota_first",
            name: "First item",
        };
        const overage = {
            ...template,
            id: "item_quota_overage",
            name: "Overage item",
        };
        const store = new MemorySnapshotStore([initial]);

        const result = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                initial,
                { type: "item.create", item: first },
                { id: "cmd_quota_first" },
            ),
            createEnvelope(
                initial,
                { type: "item.create", item: overage },
                { id: "cmd_quota_overage" },
            ),
        ]);

        expect(result.receipts).toEqual([
            {
                commandId: "cmd_quota_first",
                revision: initial.workspace.revision + 1,
                status: "applied",
            },
            {
                actual: API_QUOTAS.itemsPerSnapshot + 1,
                code: "QUOTA_EXCEEDED",
                commandId: "cmd_quota_overage",
                limit: API_QUOTAS.itemsPerSnapshot,
                message: "This workspace has reached its item record limit",
                quota: "itemsPerSnapshot",
                revision: initial.workspace.revision + 1,
                status: "rejected",
            },
        ]);
        expect(result.snapshot.items).toHaveLength(
            API_QUOTAS.itemsPerSnapshot,
        );
        expect(result.snapshot.items.some(
            (item) => item.id === "item_quota_first",
        )).toBe(true);
        expect(result.snapshot.items.some(
            (item) => item.id === "item_quota_overage",
        )).toBe(false);
    });

    it("retires old activities at the cap while keeping cleanup undoable", async () => {
        const initial = editableDemoState();
        initial.activities = Array.from(
            { length: API_QUOTAS.activitiesPerSnapshot },
            (_, index) => retainedActivity(index),
        );
        const store = new MemorySnapshotStore([initial]);
        const deleted = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                initial,
                { type: "item.delete", id: "item_pasta" },
                { id: "command_retained_delete" },
            ),
        ]);

        expect(deleted.receipts[0]).toMatchObject({ status: "applied" });
        expect(deleted.snapshot.items.some(
            (item) => item.id === "item_pasta",
        )).toBe(false);
        expect(deleted.snapshot.activities).toHaveLength(
            API_QUOTAS.activitiesPerSnapshot,
        );
        expect(deleted.snapshot.activities.some(
            (activity) => activity.id === "a0",
        )).toBe(false);
        expect(deleted.snapshot.commandReceipts).toContain("c0");
        const deletion = deleted.snapshot.activities.find(
            (activity) => activity.commandId === "command_retained_delete",
        );
        expect(deletion).toBeDefined();

        const restored = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                deleted.snapshot,
                { type: "history.undo", activityId: deletion!.id },
                { id: "command_retained_undo" },
            ),
        ]);

        expect(restored.receipts[0]).toMatchObject({ status: "applied" });
        expect(restored.snapshot.items.some(
            (item) => item.id === "item_pasta",
        )).toBe(true);

        const replayed = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                restored.snapshot,
                { type: "workspace.rename", name: "Must not replay" },
                { id: "c0" },
            ),
        ]);
        expect(replayed.receipts[0]).toMatchObject({ status: "duplicate" });
        expect(replayed.snapshot.workspace.name).toBe(initial.workspace.name);
    });

    it("retires old audit events while retaining the current history action", async () => {
        const initial = createDemoState();
        const renamed = applyCommand(
            initial,
            createEnvelope(
                initial,
                { type: "workspace.rename", name: "Retained workspace" },
                { id: "command_audited_rename" },
            ),
        ).state;
        const activityId = renamed.activities[0]!.id;
        renamed.audit = Array.from(
            { length: API_QUOTAS.auditEventsPerSnapshot },
            (_, index) => retainedAudit(index, activityId),
        );
        const store = new MemorySnapshotStore([renamed]);

        const undone = await synchronize(store, renamed.workspace.id, [
            createEnvelope(
                renamed,
                { type: "history.undo", activityId },
                { id: "command_retained_audit" },
            ),
        ]);

        expect(undone.receipts[0]).toMatchObject({ status: "applied" });
        expect(undone.snapshot.workspace.name).toBe("Kitchen reset");
        expect(undone.snapshot.audit).toHaveLength(
            API_QUOTAS.auditEventsPerSnapshot,
        );
        expect(undone.snapshot.audit.some(
            (event) => event.id === "audit_h0",
        )).toBe(false);
        expect(undone.snapshot.commandReceipts).toContain("h0");
        expect(undone.snapshot.audit.some(
            (event) => event.id === "audit_command_retained_audit",
        )).toBe(true);
    });

    it("compacts old history at the byte cap while keeping cleanup undoable", async () => {
        const initial = editableDemoState();
        const oldActivity = retainedActivity(0);
        initial.activities = [oldActivity];
        const padding =
            API_QUOTAS.storedSnapshotBytes - serializedJsonBytes(initial);
        expect(padding).toBeGreaterThan(0);
        oldActivity.label = "x".repeat(padding);
        expect(serializedJsonBytes(initial)).toBe(
            API_QUOTAS.storedSnapshotBytes,
        );
        const store = new MemorySnapshotStore([initial]);

        const deleted = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                initial,
                { type: "item.delete", id: "item_pasta" },
                { id: "command_byte_cleanup" },
            ),
        ]);

        expect(deleted.receipts[0]).toMatchObject({ status: "applied" });
        expect(serializedJsonBytes(deleted.snapshot)).toBeLessThanOrEqual(
            API_QUOTAS.storedSnapshotBytes,
        );
        expect(deleted.snapshot.activities.some(
            (activity) => activity.id === oldActivity.id,
        )).toBe(false);
        expect(deleted.snapshot.commandReceipts).toContain(
            oldActivity.commandId,
        );
        const deletion = deleted.snapshot.activities.find(
            (activity) => activity.commandId === "command_byte_cleanup",
        );
        expect(deletion).toBeDefined();

        const restored = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                deleted.snapshot,
                { type: "history.undo", activityId: deletion!.id },
                { id: "command_byte_cleanup_undo" },
            ),
        ]);
        expect(restored.receipts[0]).toMatchObject({ status: "applied" });
        expect(restored.snapshot.items.some(
            (item) => item.id === "item_pasta",
        )).toBe(true);
    });

    it("rejects legacy overage growth before and after an accepted shrink", async () => {
        const initial = createDemoState();
        const template = initial.items[0]!;
        initial.locations.find(
            (location) => location.id === template.locationId,
        )!.captureStatus = "in_progress";
        initial.items = Array.from(
            { length: API_QUOTAS.itemsPerSnapshot + 1 },
            (_, index) => ({
                ...template,
                constraints: {
                    ...template.constraints,
                    requiredTags: [],
                },
                id: `item_legacy_${index}`,
                name: "Stored item",
                notes: "",
                tags: [],
            }),
        );
        initial.activities = [];
        initial.audit = [];
        initial.plans = [];
        const store = new MemorySnapshotStore([initial]);
        const rejectedGrowth = {
            ...template,
            id: "item_legacy_growth",
            name: "Rejected growth",
        };
        const rejectedRegrowth = {
            ...template,
            id: "item_legacy_regrowth",
            name: "Rejected regrowth",
        };

        const result = await synchronize(store, initial.workspace.id, [
            createEnvelope(
                initial,
                { type: "item.create", item: rejectedGrowth },
                { id: "cmd_legacy_growth" },
            ),
            createEnvelope(
                initial,
                { type: "item.delete", id: "item_legacy_0" },
                { id: "cmd_legacy_shrink" },
            ),
            createEnvelope(
                initial,
                { type: "item.create", item: rejectedRegrowth },
                { id: "cmd_legacy_regrowth" },
            ),
        ]);

        expect(result.receipts).toMatchObject([
            {
                actual: API_QUOTAS.itemsPerSnapshot + 2,
                commandId: "cmd_legacy_growth",
                quota: "itemsPerSnapshot",
                revision: initial.workspace.revision,
                status: "rejected",
            },
            {
                commandId: "cmd_legacy_shrink",
                revision: initial.workspace.revision + 1,
                status: "applied",
            },
            {
                actual: API_QUOTAS.itemsPerSnapshot + 1,
                commandId: "cmd_legacy_regrowth",
                quota: "itemsPerSnapshot",
                revision: initial.workspace.revision + 1,
                status: "rejected",
            },
        ]);
        expect(result.snapshot.items).toHaveLength(
            API_QUOTAS.itemsPerSnapshot,
        );
        expect(result.snapshot.items.some(
            (item) => item.id === "item_legacy_0",
        )).toBe(false);
        expect(result.snapshot.items.some(
            (item) => item.id === rejectedGrowth.id ||
                item.id === rejectedRegrowth.id,
        )).toBe(false);
    });
});
