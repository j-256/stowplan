import { describe, expect, it } from "vitest";
import {
    applyCommand,
    ConflictError,
    createDemoState,
    createEmptyState,
    createEnvelope,
    createItem,
    createLocation,
    DomainError,
    generatePlan,
    previewImport,
    type Command,
    type WorkspaceState,
    validateSnapshot,
} from "../src/domain";

function makeLocationsEditable(
    state: WorkspaceState,
    ...locationIds: string[]
): WorkspaceState {
    for (const locationId of locationIds) {
        const location = state.locations.find((candidate) => candidate.id === locationId);
        if (!location) throw new Error(`Missing test location ${locationId}`);
        location.captureStatus = "in_progress";
    }
    return state;
}

function expectDomainRefusal(
    state: WorkspaceState,
    command: Command,
    code: string,
    message: RegExp,
): void {
    try {
        applyCommand(state, createEnvelope(state, command));
        throw new Error(`Expected ${command.type} to be refused`);
    } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe(code);
        expect((error as Error).message).toMatch(message);
    }
}

describe("organizer command engine", () => {
    it("records an item and distinctly marks the container counted", () => {
        let state = createDemoState();
        const newItem = createItem(
            { locationId: "loc_corner", name: "Tea towels", quantity: 6, unit: "each" },
            "2026-07-22T12:01:00.000Z",
        );
        state = applyCommand(
            state,
            createEnvelope(state, { type: "item.create", item: newItem }, { id: "cmd_record" }),
        ).state;
        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "capture.status", id: "loc_corner", status: "counted" },
                { id: "cmd_counted" },
            ),
        ).state;

        expect(state.items.find((item) => item.id === newItem.id)?.quantity).toBe(6);
        expect(state.locations.find((location) => location.id === "loc_corner")?.captureStatus).toBe(
            "counted",
        );
        expect(state.workspace.revision).toBe(2);
    });

    it("empties a reviewed container and restores its contents with one undo", () => {
        let state = createDemoState();
        const originalItems = state.items
            .filter((item) => item.locationId === "loc_bin")
            .map((item) => item.id)
            .sort();
        const emptied = applyCommand(
            state,
            createEnvelope(
                state,
                {
                    type: "capture.empty",
                    id: "loc_bin",
                    itemIds: originalItems,
                },
                { id: "cmd_empty_bin" },
            ),
        );
        state = emptied.state;

        expect(state.items.some((item) => item.locationId === "loc_bin")).toBe(false);
        expect(state.locations.find((location) => location.id === "loc_bin")?.captureStatus)
            .toBe("known_empty");
        expect(emptied.activity?.label).toMatch(/Emptied Baking bin/);

        state = applyCommand(
            state,
            createEnvelope(state, {
                type: "history.undo",
                activityId: emptied.activity?.id as string,
            }),
        ).state;
        expect(state.items
            .filter((item) => item.locationId === "loc_bin")
            .map((item) => item.id)
            .sort()).toEqual(originalItems);
        expect(state.locations.find((location) => location.id === "loc_bin")?.captureStatus)
            .toBe("counted");
    });

    it("rejects stale empty-container review and allows counted status to be unset", () => {
        let state = createDemoState();
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "capture.empty",
                    id: "loc_bin",
                    itemIds: ["item_flour"],
                }),
            ),
        ).toThrow(/Contents changed/);

        state = applyCommand(
            state,
            createEnvelope(state, {
                type: "capture.status",
                id: "loc_bin",
                status: "in_progress",
            }),
        ).state;
        expect(state.locations.find((location) => location.id === "loc_bin")?.captureStatus)
            .toBe("in_progress");
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "capture.status",
                    id: "loc_bin",
                    status: "in_progress",
                }),
            ),
        ).toThrow(/already marked/);
    });

    it("prevents moving a container inside its descendant", () => {
        const state = createDemoState();
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.move",
                    id: "loc_right",
                    parentId: "loc_box",
                }),
            ),
        ).toThrow(/descendant/);
    });

    it("rejects a runtime location move with no parent placement", () => {
        const state = createDemoState();
        const envelope = createEnvelope(state, {
            type: "location.move",
            id: "loc_box",
            parentId: null,
        });
        const malformedCommand = envelope.command as { parentId?: string | null };
        delete malformedCommand.parentId;

        expect(() => applyCommand(state, envelope)).toThrow(/parent ID or top-level/);
        malformedCommand.parentId = "";
        expect(() => applyCommand(state, envelope)).toThrow(/parent ID or top-level/);
    });

    it("splits a partial quantity and merges equivalent destination records", () => {
        let state = makeLocationsEditable(createDemoState(), "loc_warm", "loc_food");
        const destinationPasta = {
            ...structuredClone(state.items.find((item) => item.id === "item_pasta")!),
            id: "item_pasta_food",
            locationId: "loc_food",
            quantity: 2,
        };
        state.items.push(destinationPasta);
        state = applyCommand(
            state,
            createEnvelope(
                state,
                {
                    type: "item.move",
                    destinationId: "loc_food",
                    id: "item_pasta",
                    quantity: 3,
                },
                { id: "cmd_split" },
            ),
        ).state;

        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(3);
        expect(state.items.find((item) => item.id === "item_pasta_food")?.quantity).toBe(5);
        expect(state.items.filter((item) => item.name === "Pasta")).toHaveLength(2);
    });

    it("refuses a partial move whose deterministic split ID already exists", () => {
        const state = createDemoState();
        const collision = createItem({
            locationId: "loc_food",
            name: "Collision marker",
        });
        collision.id = "item_split_cmd_collision";
        state.items.push(collision);

        expect(() =>
            applyCommand(
                state,
                createEnvelope(
                    state,
                    {
                        type: "item.move",
                        destinationId: "loc_food",
                        id: "item_pasta",
                        quantity: 1,
                    },
                    { id: "cmd_collision" },
                ),
            ),
        ).toThrow(/reuse an existing item record ID/);
    });

    it("rejects direct and bulk moves of archived legacy item records", () => {
        const state = createDemoState();
        state.items.find((item) => item.id === "item_pasta")!.archivedAt =
            "2026-07-22T13:00:00.000Z";

        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "item.move",
                    destinationId: "loc_food",
                    id: "item_pasta",
                    quantity: 1,
                }),
            ),
        ).toThrow(/archived/);
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "item.bulkMove",
                    destinationId: "loc_food",
                    itemIds: ["item_pasta"],
                }),
            ),
        ).toThrow(/archived/);
    });

    it("prevents equivalent-item merges from overflowing quantity", () => {
        const state = createDemoState();
        const source = state.items.find((item) => item.id === "item_pasta")!;
        source.quantity = 1e308;
        const destination = {
            ...structuredClone(source),
            id: "item_pasta_overflow_destination",
            locationId: "loc_food",
            quantity: 1e308,
        };
        state.items.push(destination);

        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "item.move",
                    destinationId: destination.locationId,
                    id: source.id,
                    quantity: source.quantity,
                }),
            ),
        ).toThrow(/supported quantity range/);
    });

    it("moves several records atomically", () => {
        const state = makeLocationsEditable(
            createDemoState(),
            "loc_lower",
            "loc_warm",
            "loc_food",
        );
        const result = applyCommand(
            state,
            createEnvelope(
                state,
                {
                    type: "item.bulkMove",
                    destinationId: "loc_food",
                    itemIds: ["item_beans", "item_pasta"],
                },
                { id: "cmd_bulk" },
            ),
        ).state;

        expect(result.items.find((item) => item.id === "item_beans")?.locationId).toBe("loc_food");
        expect(result.items.find((item) => item.id === "item_pasta")?.locationId).toBe("loc_food");
        expect(result.activities.at(-1)?.label).toContain("2 item records");
    });

    it("leaves already placed records while bulk moving the rest", () => {
        const state = makeLocationsEditable(createDemoState(), "loc_warm", "loc_food");
        const result = applyCommand(
            state,
            createEnvelope(
                state,
                {
                    type: "item.bulkMove",
                    destinationId: "loc_food",
                    itemIds: ["item_rice", "item_pasta"],
                },
                { id: "cmd_bulk_mixed" },
            ),
        ).state;

        expect(result.items.find((item) => item.id === "item_rice")?.locationId).toBe("loc_food");
        expect(result.items.find((item) => item.id === "item_pasta")?.locationId).toBe("loc_food");
        expect(result.activities.at(-1)?.label).toBe("Moved 1 of 2 item records");
    });

    it("reorders item records without changing their container", () => {
        const state = makeLocationsEditable(createDemoState(), "loc_bin");
        const result = applyCommand(
            state,
            createEnvelope(state, { type: "item.reorder", id: "item_sugar", order: -1 }),
        ).state;

        expect(result.items.find((item) => item.id === "item_sugar")?.order).toBe(-1);
        expect(result.items.find((item) => item.id === "item_sugar")?.locationId).toBe("loc_bin");
        expect(result.activities.at(-1)?.label).toBe("Reordered Brown sugar");
    });

    it("requires a fresh subtree review before destructive deletion", () => {
        const state = createDemoState();
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.delete",
                    descendantIds: [],
                    id: "loc_corner",
                    itemIds: [],
                }),
            ),
        ).toThrow(/review/);
    });

    it("rejects structural cycles sent through location updates", () => {
        const state = createDemoState();
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.update",
                    id: "loc_right",
                    changes: { parentId: "loc_box" },
                }),
            ),
        ).toThrow(/descendant/);
    });

    it("normalizes a short ID and saves a parent change atomically", () => {
        const state = makeLocationsEditable(createDemoState(), "loc_lower");
        const result = applyCommand(
            state,
            createEnvelope(state, {
                type: "location.update",
                id: "loc_box",
                changes: {
                    code: " bx-10 ",
                    name: "  Spare parts  ",
                    parentId: "loc_lower",
                },
            }),
        ).state;
        const updated = result.locations.find((location) => location.id === "loc_box");

        expect(updated).toMatchObject({
            code: "BX-10",
            name: "Spare parts",
            parentId: "loc_lower",
        });
        expect(result.activities).toHaveLength(1);
    });

    it("refuses unchanged item and location saves without changing history or plans", () => {
        const state = createDemoState();
        state.plans.push(generatePlan(state, { name: "No-op preservation" }));
        const item = state.items.find((candidate) => candidate.id === "item_pasta")!;
        const location = state.locations.find((candidate) => candidate.id === "loc_bin")!;
        const before = structuredClone(state);

        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "item.update",
                    id: item.id,
                    changes: {
                        category: item.category,
                        constraints: item.constraints,
                        dimensions: item.dimensions,
                        frequency: item.frequency,
                        name: ` ${item.name} `,
                        notes: item.notes,
                        quantity: item.quantity,
                        tags: item.tags,
                        unit: ` ${item.unit} `,
                    },
                }),
            ),
        ).toThrow(/No changes to save/);
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.update",
                    id: location.id,
                    changes: {
                        code: ` ${location.code.toLocaleLowerCase()} `,
                        conditions: location.conditions,
                        description: location.description,
                        dimensions: location.dimensions,
                        kind: location.kind,
                        name: ` ${location.name} `,
                        parentId: location.parentId,
                        tags: location.tags,
                    },
                }),
            ),
        ).toThrow(/No changes to save/);
        expect(state).toEqual(before);
    });

    it("requires reopening completed spaces before direct item content changes", () => {
        const state = createDemoState();
        const before = structuredClone(state);
        const newItem = createItem({
            locationId: "loc_bin",
            name: "Baking paper",
        });

        expectDomainRefusal(
            state,
            { type: "item.create", item: newItem },
            "CAPTURE_COMPLETE",
            /Reopen Baking bin before adding an item/,
        );
        expectDomainRefusal(
            state,
            {
                type: "item.update",
                id: "item_flour",
                changes: { notes: "Nearly empty" },
            },
            "CAPTURE_COMPLETE",
            /Reopen Baking bin before editing an item/,
        );
        expectDomainRefusal(
            state,
            { type: "item.reorder", id: "item_sugar", order: -1 },
            "CAPTURE_COMPLETE",
            /Reopen Baking bin before reordering its items/,
        );
        expectDomainRefusal(
            state,
            { type: "item.delete", id: "item_flour" },
            "CAPTURE_COMPLETE",
            /Reopen Baking bin before deleting an item/,
        );
        expectDomainRefusal(
            state,
            {
                type: "item.move",
                destinationId: "loc_corner",
                id: "item_flour",
                quantity: 1,
            },
            "CAPTURE_COMPLETE",
            /Reopen Baking bin before moving an item out of it/,
        );
        expectDomainRefusal(
            state,
            {
                type: "item.move",
                destinationId: "loc_food",
                id: "item_lids",
                quantity: 1,
            },
            "CAPTURE_COMPLETE",
            /Reopen Food cabinet before moving an item into it/,
        );
        expectDomainRefusal(
            state,
            {
                type: "item.bulkMove",
                destinationId: "loc_food",
                itemIds: ["item_lids", "item_manuals"],
            },
            "CAPTURE_COMPLETE",
            /Reopen Food cabinet before moving an item into it/,
        );
        expectDomainRefusal(
            state,
            {
                type: "item.update",
                id: "item_flour",
                changes: { archivedAt: "2026-07-22T13:00:00.000Z" },
            },
            "INVALID_CHANGES",
            /archivedAt cannot be changed/,
        );
        expect(state).toEqual(before);
    });

    it("requires reopening completed parents before nested-space content changes", () => {
        const state = createDemoState();
        const before = structuredClone(state);
        const nested = createLocation({
            code: "BIN-NEW",
            kind: "bin",
            name: "New baking bin",
            parentId: "loc_bin",
        });

        expectDomainRefusal(
            state,
            { type: "location.create", location: nested },
            "CAPTURE_COMPLETE",
            /Reopen Baking bin before adding a nested space/,
        );
        expectDomainRefusal(
            state,
            {
                type: "location.update",
                id: "loc_box",
                changes: { parentId: "loc_bin" },
            },
            "CAPTURE_COMPLETE",
            /Reopen Baking bin before moving a nested space into it/,
        );
        expectDomainRefusal(
            state,
            {
                type: "location.move",
                id: "loc_food",
                parentId: "loc_corner",
            },
            "CAPTURE_COMPLETE",
            /Reopen Left side before moving a nested space out of it/,
        );
        expectDomainRefusal(
            state,
            { type: "location.reorder", id: "loc_food", order: -1 },
            "CAPTURE_COMPLETE",
            /Reopen Left side before reordering its nested spaces/,
        );
        expectDomainRefusal(
            state,
            { type: "location.archive", id: "loc_counter", archived: true },
            "CAPTURE_COMPLETE",
            /Reopen Right side before archiving a nested space/,
        );
        expectDomainRefusal(
            state,
            {
                type: "location.delete",
                descendantIds: [],
                id: "loc_counter",
                itemIds: [],
            },
            "CAPTURE_COMPLETE",
            /Reopen Right side before deleting a nested space/,
        );

        const metadataEdit = applyCommand(
            state,
            createEnvelope(state, {
                type: "location.update",
                id: "loc_bin",
                changes: { description: "Keep sealed" },
            }),
        ).state;
        expect(metadataEdit.locations.find((location) => location.id === "loc_bin")?.description)
            .toBe("Keep sealed");
        expect(state).toEqual(before);
    });

    it("refuses unchanged reorder and placement commands without changing state", () => {
        const state = createDemoState();
        state.plans.push(generatePlan(state, { name: "No-op ordering" }));
        const before = structuredClone(state);

        expectDomainRefusal(
            state,
            { type: "workspace.rename", name: ` ${state.workspace.name} ` },
            "NO_CHANGES",
            /Workspace is already named Kitchen reset/,
        );
        expectDomainRefusal(
            state,
            { type: "location.archive", id: "loc_box", archived: false },
            "NO_CHANGES",
            /Appliance parts is already available/,
        );
        expectDomainRefusal(
            state,
            {
                type: "plan.status",
                planId: state.plans[0]!.id,
                status: "active",
            },
            "NO_CHANGES",
            /No-op ordering is already marked active/,
        );
        for (const command of [
            { type: "item.reorder", id: "item_sugar", order: 1 },
            { type: "location.reorder", id: "loc_food", order: 0 },
            { type: "location.move", id: "loc_food", parentId: "loc_left" },
            { type: "location.move", id: "loc_food", parentId: "loc_left", order: 0 },
        ] satisfies Command[]) {
            expectDomainRefusal(
                state,
                command,
                "NO_CHANGES",
                /already in that position/,
            );
        }

        expect(state).toEqual(before);
    });

    it("rejects runtime-only structural and unsafe update keys", () => {
        const state = createDemoState();
        const locationCommand = {
            type: "location.update",
            id: "loc_box",
            changes: { id: "loc_replaced" },
        } as const;
        const itemCommand = {
            type: "item.update",
            id: "item_pasta",
            changes: Object.fromEntries([["constructor", { polluted: true }]]),
        } as const;
        const unsafeEnvelope = {
            ...createEnvelope(
                state,
                { type: "item.update", id: "item_pasta", changes: { notes: "safe" } },
            ),
            command: itemCommand,
            expectations: [],
        };

        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, locationCommand as never),
            ),
        ).toThrow(/cannot be changed/);
        expect(() =>
            applyCommand(
                state,
                unsafeEnvelope as never,
            ),
        ).toThrow(/cannot be changed/);
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.update",
                    id: "loc_box",
                    changes: { name: null },
                } as never),
            ),
        ).toThrow(/must be strings/);
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "item.update",
                    id: "item_pasta",
                    changes: { unit: null },
                } as never),
            ),
        ).toThrow(/must be strings/);
    });

    it("validates active-code uniqueness when restoring an archived space", () => {
        let state = createEmptyState("Restore test");
        const archived = createLocation({
            code: "BIN-01",
            kind: "bin",
            name: "Original bin",
        });
        state = applyCommand(
            state,
            createEnvelope(state, { type: "location.create", location: archived }),
        ).state;
        state = applyCommand(
            state,
            createEnvelope(state, {
                type: "location.archive",
                id: archived.id,
                archived: true,
            }),
        ).state;
        const replacement = createLocation({
            code: "BIN-01",
            kind: "bin",
            name: "Replacement bin",
        });
        state = applyCommand(
            state,
            createEnvelope(state, { type: "location.create", location: replacement }),
        ).state;

        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.archive",
                    id: archived.id,
                    archived: false,
                }),
            ),
        ).toThrow(/already in use/);
    });

    it("does not restore a space beneath an archived parent", () => {
        const state = createDemoState();
        const parent = state.locations.find((location) => location.id === "loc_right")!;
        const child = state.locations.find((location) => location.id === "loc_corner")!;
        parent.archivedAt = "2026-07-22T12:00:00.000Z";
        child.archivedAt = "2026-07-22T12:00:00.000Z";

        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.archive",
                    id: child.id,
                    archived: false,
                }),
            ),
        ).toThrow(/Restore Right side/);
    });

    it("does not archive a space while live contents would be stranded", () => {
        const state = createDemoState();
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.archive",
                    id: "loc_bin",
                    archived: true,
                }),
            ),
        ).toThrow(/contents/);
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "location.archive",
                    id: "loc_corner",
                    archived: true,
                }),
            ),
        ).toThrow(/nested/);
    });

    it("marks a space in progress when its first item is recorded", () => {
        let state = createDemoState();
        const newItem = createItem({
            locationId: "loc_box",
            name: "Power adapter",
        });
        state = applyCommand(
            state,
            createEnvelope(state, { type: "item.create", item: newItem }),
        ).state;
        expect(state.locations.find((location) => location.id === "loc_box")?.captureStatus).toBe(
            "in_progress",
        );
    });

    it("does not mark a space with a live nested container as known empty", () => {
        const state = createDemoState();
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "capture.status",
                    id: "loc_corner",
                    status: "known_empty",
                }),
            ),
        ).toThrow(/nested/);
    });
});

describe("field-aware history", () => {
    it("plucks one change for undo and safely reapplies it", () => {
        let state = makeLocationsEditable(createDemoState(), "loc_warm");
        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "item.update", id: "item_pasta", changes: { quantity: 9 } },
                { id: "cmd_quantity" },
            ),
        ).state;
        const activityId = state.activities.at(-1)!.id;
        state = applyCommand(
            state,
            createEnvelope(state, { type: "history.undo", activityId }, { id: "cmd_undo" }),
        ).state;
        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(6);
        expect(state.activities.find((activity) => activity.id === activityId)?.status).toBe("undone");

        state = applyCommand(
            state,
            createEnvelope(state, { type: "history.reapply", activityId }, { id: "cmd_redo" }),
        ).state;
        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(9);
    });

    it("supports undo N and redo N in dependency-safe order", () => {
        let state = makeLocationsEditable(createDemoState(), "loc_warm");
        for (const [id, quantity] of [["cmd_a", 7], ["cmd_b", 8], ["cmd_c", 9]] as const) {
            state = applyCommand(
                state,
                createEnvelope(
                    state,
                    { type: "item.update", id: "item_pasta", changes: { quantity } },
                    { id, timestamp: `2026-07-22T12:0${quantity}:00.000Z` },
                ),
            ).state;
        }
        state = applyCommand(
            state,
            createEnvelope(state, { type: "history.batchUndo", count: 2 }, { id: "cmd_undo_two" }),
        ).state;
        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(7);
        state = applyCommand(
            state,
            createEnvelope(state, { type: "history.batchRedo", count: 2 }, { id: "cmd_redo_two" }),
        ).state;
        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(9);
    });

    it("undoes and reapplies a bulk move that repeatedly merges one destination", () => {
        const state = makeLocationsEditable(createDemoState(), "loc_warm", "loc_food");
        const first = state.items.find((item) => item.id === "item_pasta")!;
        const second = {
            ...structuredClone(first),
            id: "item_pasta_second_source",
            locationId: "loc_corner",
            quantity: 2,
        };
        const destination = {
            ...structuredClone(first),
            id: "item_pasta_destination",
            locationId: "loc_food",
            quantity: 1,
        };
        state.items.push(second, destination);
        const moved = applyCommand(
            state,
            createEnvelope(
                state,
                {
                    type: "item.bulkMove",
                    destinationId: destination.locationId,
                    itemIds: [first.id, second.id],
                },
                { id: "cmd_bulk_merge_history" },
            ),
        ).state;

        const undone = applyCommand(
            moved,
            createEnvelope(moved, {
                type: "history.undo",
                activityId: moved.activities.at(-1)!.id,
            }),
        ).state;
        expect(undone.items.find((item) => item.id === destination.id)?.quantity).toBe(1);
        expect(undone.items.find((item) => item.id === first.id)?.quantity).toBe(6);
        expect(undone.items.find((item) => item.id === second.id)?.quantity).toBe(2);

        const reapplied = applyCommand(
            undone,
            createEnvelope(undone, {
                type: "history.reapply",
                activityId: undone.activities.find(
                    (activity) => activity.commandId === "cmd_bulk_merge_history",
                )!.id,
            }),
        ).state;
        expect(reapplied.items.find((item) => item.id === destination.id)?.quantity).toBe(9);
        expect(reapplied.items.some((item) => item.id === first.id)).toBe(false);
        expect(reapplied.items.some((item) => item.id === second.id)).toBe(false);
    });

    it("refuses an undo that would overwrite a later same-field edit", () => {
        let state = makeLocationsEditable(createDemoState(), "loc_warm");
        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "item.update", id: "item_pasta", changes: { quantity: 7 } },
                { id: "cmd_first" },
            ),
        ).state;
        const first = state.activities.at(-1)!.id;
        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "item.update", id: "item_pasta", changes: { quantity: 8 } },
                { id: "cmd_second" },
            ),
        ).state;
        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, { type: "history.undo", activityId: first }),
            ),
        ).toThrow(ConflictError);
    });

    it("refuses an undo that would violate a cross-record invariant", () => {
        let state = createEmptyState("History invariants");
        const original = createLocation({
            code: "BOX-1",
            kind: "box",
            name: "Original box",
        });
        state = applyCommand(
            state,
            createEnvelope(state, { type: "location.create", location: original }),
        ).state;
        state = applyCommand(
            state,
            createEnvelope(state, {
                type: "location.delete",
                descendantIds: [],
                id: original.id,
                itemIds: [],
            }),
        ).state;
        const deletion = state.activities.at(-1)!.id;
        const replacement = createLocation({
            code: "BOX-1",
            kind: "box",
            name: "Replacement box",
        });
        state = applyCommand(
            state,
            createEnvelope(state, { type: "location.create", location: replacement }),
        ).state;

        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "history.undo",
                    activityId: deletion,
                }),
            ),
        ).toThrow(/make the workspace invalid/);
    });

    it("undoes and reapplies same-millisecond changes in dependency order", () => {
        let state = makeLocationsEditable(createDemoState(), "loc_warm");
        const timestamp = "2026-07-22T12:10:00.000Z";
        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "item.update", id: "item_pasta", changes: { quantity: 7 } },
                { id: "cmd_tied_first", timestamp },
            ),
        ).state;
        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "item.update", id: "item_pasta", changes: { quantity: 8 } },
                { id: "cmd_tied_second", timestamp },
            ),
        ).state;

        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "history.batchUndo", count: 2 },
                { id: "cmd_tied_undo" },
            ),
        ).state;
        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(6);

        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "history.batchRedo", count: 2 },
                { id: "cmd_tied_redo" },
            ),
        ).state;
        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(8);
    });

    it("uses applied order when client clocks are skewed", () => {
        let state = makeLocationsEditable(createDemoState(), "loc_warm");
        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "item.update", id: "item_pasta", changes: { quantity: 7 } },
                { id: "cmd_clock_first", timestamp: "2026-07-22T13:00:00.000Z" },
            ),
        ).state;
        state = applyCommand(
            state,
            createEnvelope(
                state,
                { type: "item.update", id: "item_pasta", changes: { quantity: 8 } },
                { id: "cmd_clock_second", timestamp: "2026-07-22T11:00:00.000Z" },
            ),
        ).state;

        state = applyCommand(
            state,
            createEnvelope(state, { type: "history.batchUndo", count: 2 }),
        ).state;
        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(6);

        state = applyCommand(
            state,
            createEnvelope(state, { type: "history.batchRedo", count: 2 }),
        ).state;
        expect(state.items.find((item) => item.id === "item_pasta")?.quantity).toBe(8);
    });
});

describe("planner and backup validation", () => {
    it("prefers a whole-container move when that replaces several item moves", () => {
        const plan = generatePlan(createDemoState(), { name: "Kitchen plan" });
        const containerMove = plan.steps.find(
            (step) => step.type === "location" && step.locationId === "loc_bin",
        );
        expect(containerMove).toBeDefined();
        expect(containerMove?.explanation.join(" ")).toContain("one physical container");
    });

    it("does not use the placeholder category as grouping evidence", () => {
        const state = createEmptyState("Explicit grouping");
        const root = createLocation({ code: "ROOM", kind: "room", name: "Room" });
        root.captureStatus = "counted";
        const source = createLocation({
            code: "SOURCE",
            kind: "shelf",
            name: "Source",
            parentId: root.id,
        });
        source.captureStatus = "counted";
        const destination = createLocation({
            code: "DEST",
            kind: "shelf",
            name: "Destination",
            parentId: root.id,
        });
        destination.captureStatus = "known_empty";
        destination.tags = ["preferred"];
        const moving = createItem({ locationId: source.id, name: "Moving record" });
        moving.constraints.requiredTags = ["preferred"];
        const firstPeer = createItem({ locationId: destination.id, name: "First peer" });
        const secondPeer = createItem({ locationId: destination.id, name: "Second peer" });
        state.locations.push(root, source, destination);
        state.items.push(moving, firstPeer, secondPeer);

        const step = generatePlan(state).steps.find(
            (candidate) => candidate.itemId === moving.id,
        );

        expect(step).toBeDefined();
        expect(step?.explanation.join(" ")).not.toContain("groups with");
    });

    it("does not let saved handling effort justify a worse whole-container destination", () => {
        const state = createEmptyState("Container purpose");
        const root = createLocation({ code: "APT", kind: "room", name: "Apartment" });
        root.captureStatus = "counted";
        const hall = createLocation({
            code: "HALL",
            kind: "area",
            name: "Hall",
            parentId: root.id,
        });
        hall.captureStatus = "counted";
        const upper = createLocation({
            code: "UPPER",
            kind: "shelf",
            name: "Upper shelf",
            parentId: hall.id,
        });
        upper.captureStatus = "counted";
        const backstock = createLocation({
            code: "BACK",
            kind: "bin",
            name: "Household backstock",
            parentId: upper.id,
        });
        backstock.captureStatus = "counted";
        const kitchen = createLocation({
            code: "KIT",
            kind: "area",
            name: "Kitchen",
            parentId: root.id,
        });
        kitchen.captureStatus = "counted";
        const cabinet = createLocation({
            code: "CAB",
            kind: "area",
            name: "Prep cabinet",
            parentId: kitchen.id,
        });
        cabinet.captureStatus = "counted";
        const dailyFood = createLocation({
            code: "FOOD",
            kind: "shelf",
            name: "Daily food",
            parentId: cabinet.id,
        });
        dailyFood.captureStatus = "counted";
        state.locations.push(root, hall, upper, backstock, kitchen, cabinet, dailyFood);
        for (let index = 0; index < 6; index += 1) {
            state.items.push(createItem({
                locationId: backstock.id,
                name: `Household record ${index + 1}`,
            }));
        }

        const plan = generatePlan(state, {
            weights: {
                accessibility: 2,
                capacity: 1,
                grouping: 2,
                moveCost: 1,
                suitability: 5,
            },
        });

        expect(
            plan.steps.some(
                (step) => step.type === "location" && step.locationId === backstock.id,
            ),
        ).toBe(false);
    });

    it("requires numbered plan moves to execute in order", () => {
        const initial = createDemoState();
        const plan = generatePlan(initial, { name: "Ordered execution" });
        expect(plan.steps.length).toBeGreaterThan(1);
        const created = applyCommand(
            initial,
            createEnvelope(initial, { type: "plan.create", plan }),
        ).state;

        expect(() =>
            applyCommand(
                created,
                createEnvelope(created, {
                    type: "plan.step.complete",
                    planId: plan.id,
                    stepId: plan.steps[1]!.id,
                }),
            ),
        ).toThrow(/earlier plan moves/);
    });

    it("reopens counted and known-empty spaces when a plan moves an item", () => {
        const initial = createDemoState();
        const generated = generatePlan(initial, { name: "Item capture execution" });
        const sourceStep = generated.steps.find((step) => step.type === "item")!;
        const destination = initial.locations.find((location) => location.id === "loc_counter")!;
        destination.captureStatus = "known_empty";
        const step = {
            ...sourceStep,
            destinationId: destination.id,
            id: "step_item_capture_execution",
        };
        const plan = {
            ...generated,
            id: "plan_item_capture_execution",
            steps: [step],
        };
        expect(
            initial.locations.find((location) => location.id === step.sourceId)?.captureStatus,
        ).toBe("counted");
        expect(destination.captureStatus).toBe("known_empty");
        expectDomainRefusal(
            initial,
            {
                type: "item.move",
                destinationId: destination.id,
                id: "item_lids",
                quantity: 1,
            },
            "CAPTURE_COMPLETE",
            /Reopen Counter before moving an item into it/,
        );
        const created = applyCommand(
            initial,
            createEnvelope(initial, { type: "plan.create", plan }),
        ).state;

        const result = applyCommand(
            created,
            createEnvelope(created, {
                type: "plan.step.complete",
                planId: plan.id,
                stepId: step.id,
            }),
        );
        const affectedLocationIds = [step.sourceId, step.destinationId].sort();

        expect(
            result.state.locations
                .filter((location) => affectedLocationIds.includes(location.id))
                .map((location) => location.captureStatus),
        ).toEqual(["in_progress", "in_progress"]);
        expect(
            result.state.plans
                .find((candidate) => candidate.id === plan.id)
                ?.steps.find((candidate) => candidate.id === step.id)
                ?.completedAt,
        ).toBeTruthy();
        expect(
            result.activity?.patches
                .filter((candidate) => candidate.path === "captureStatus")
                .map((candidate) => candidate.id)
                .sort(),
        ).toEqual(affectedLocationIds);
    });

    it("reopens counted and known-empty parents when a plan moves a nested space", () => {
        const initial = createDemoState();
        const generated = generatePlan(initial, { name: "Nested capture execution" });
        const sourceStep = generated.steps.find((step) => step.type === "location")!;
        const destination = initial.locations.find((location) => location.id === "loc_counter")!;
        destination.captureStatus = "known_empty";
        const step = {
            ...sourceStep,
            destinationId: destination.id,
            id: "step_location_capture_execution",
        };
        const plan = {
            ...generated,
            id: "plan_location_capture_execution",
            steps: [step],
        };
        expect(
            initial.locations.find((location) => location.id === step.sourceId)?.captureStatus,
        ).toBe("counted");
        expect(destination.captureStatus).toBe("known_empty");
        expectDomainRefusal(
            initial,
            {
                type: "location.move",
                id: step.locationId as string,
                parentId: destination.id,
            },
            "CAPTURE_COMPLETE",
            /Reopen Lower cabinet before moving a nested space out of it/,
        );
        const created = applyCommand(
            initial,
            createEnvelope(initial, { type: "plan.create", plan }),
        ).state;

        const result = applyCommand(
            created,
            createEnvelope(created, {
                type: "plan.step.complete",
                planId: plan.id,
                stepId: step.id,
            }),
        );
        const affectedLocationIds = [step.sourceId, step.destinationId].sort();

        expect(
            result.state.locations
                .filter((location) => affectedLocationIds.includes(location.id))
                .map((location) => location.captureStatus),
        ).toEqual(["in_progress", "in_progress"]);
        expect(
            result.state.locations.find((location) => location.id === step.locationId)?.parentId,
        ).toBe(destination.id);
        expect(
            result.activity?.patches
                .filter((candidate) => candidate.path === "captureStatus")
                .map((candidate) => candidate.id)
                .sort(),
        ).toEqual(affectedLocationIds);
    });

    it("blocks execution until compatible legacy active plans are resolved", () => {
        const state = createDemoState();
        const first = generatePlan(state, { name: "Legacy first" });
        const second = {
            ...structuredClone(first),
            id: "plan_legacy_second",
            name: "Legacy second",
        };
        state.plans.push(first, second);

        expect(() =>
            applyCommand(
                state,
                createEnvelope(state, {
                    type: "plan.step.complete",
                    planId: first.id,
                    stepId: first.steps[0]!.id,
                }),
            ),
        ).toThrow(/only one active plan/);
    });

    it("detects cycles and dangling references before replacement", () => {
        const current = createDemoState();
        const incoming = structuredClone(current);
        incoming.locations.find((location) => location.id === "loc_kitchen")!.parentId = "loc_box";
        const preview = previewImport(current, incoming);
        expect(preview.valid).toBe(false);
        expect(preview.issues.some((candidate) => candidate.code === "LOCATION_CYCLE")).toBe(true);
    });

    it("rejects malformed nested backup records without throwing", () => {
        const current = createDemoState();
        const incoming = structuredClone(current) as unknown as { items: Record<string, unknown>[]; activities: unknown[] };
        incoming.items[0].constraints = null;
        incoming.activities = [{}];
        expect(() => previewImport(current, incoming)).not.toThrow();
        const preview = previewImport(current, incoming);
        expect(preview.valid).toBe(false);
        expect(preview.issues.map((candidate) => candidate.code)).toEqual(expect.arrayContaining(["ITEM_CONSTRAINTS", "STRING_REQUIRED"]));
    });

    it("rejects unsafe revision and item version counters", () => {
        const incoming = createDemoState();
        incoming.workspace.revision = Number.MAX_SAFE_INTEGER + 1;
        incoming.items[0]!.version = Number.MAX_SAFE_INTEGER + 1;
        expect(validateSnapshot(incoming).map((issue) => issue.code)).toEqual(
            expect.arrayContaining(["WORKSPACE_REVISION", "ITEM_VERSION"]),
        );

        const current = createDemoState();
        const envelope = createEnvelope(current, {
            type: "workspace.rename",
            name: "Unsafe counter",
        });
        envelope.baseRevision = Number.MAX_SAFE_INTEGER + 1;
        expect(() => applyCommand(current, envelope)).toThrow(/malformed/);
        const future = createEnvelope(current, {
            type: "workspace.rename",
            name: "Future counter",
        });
        future.baseRevision = current.workspace.revision + 1;
        expect(() => applyCommand(current, future)).toThrow(/future workspace revision/);
        current.workspace.revision = Number.MAX_SAFE_INTEGER;
        expect(() =>
            applyCommand(
                current,
                createEnvelope(current, {
                    type: "workspace.rename",
                    name: "Exhausted counter",
                }),
            ),
        ).toThrow(/revision counter/);
    });

    it("rejects blank entity and history identities in backups", () => {
        const initial = createDemoState();
        const current = applyCommand(
            initial,
            createEnvelope(initial, { type: "workspace.rename", name: "Identity fixture" }),
        ).state;
        const incoming = structuredClone(current);
        incoming.locations[0]!.id = "";
        incoming.items[0]!.id = "";
        const plan = generatePlan(current);
        plan.id = "";
        const planWithBlankStep = generatePlan(current);
        planWithBlankStep.id = "plan_with_blank_step";
        planWithBlankStep.steps[0]!.id = "";
        incoming.plans.push(plan, planWithBlankStep);
        incoming.activities[0]!.id = "";
        incoming.audit.push({
            actorId: "",
            id: "",
            label: "Invalid audit identity",
            targetActivityIds: [],
            timestamp: "2026-07-22T12:00:00.000Z",
            type: "undo",
        });

        const issues = validateSnapshot(incoming);
        expect(issues.map((candidate) => candidate.code)).toEqual(
            expect.arrayContaining([
                "LOCATION_ID",
                "ITEM_ID",
                "PLAN_ID",
                "PLAN_STEP",
                "ACTIVITY",
                "AUDIT",
            ]),
        );
    });

    it("rejects backup history that could undo into an invalid state", () => {
        const current = createEmptyState("Safe workspace");
        const incoming = structuredClone(current);
        incoming.activities.push({
            actorId: "imported-user",
            commandId: "cmd_malicious",
            id: "activity_malicious",
            label: "Unsafe rename",
            patches: [{
                after: "Safe workspace",
                before: "",
                id: incoming.workspace.id,
                path: "name",
                target: "workspace",
            }],
            status: "applied",
            subjectIds: [incoming.workspace.id],
            timestamp: "2026-07-22T12:00:00.000Z",
            undoneAt: null,
        });

        const preview = previewImport(current, incoming);
        expect(preview.valid).toBe(false);
        expect(preview.issues.some((candidate) => candidate.code === "PATCH_VALUE")).toBe(true);
    });

    it("rejects stale or archived executable plan steps in backups", () => {
        const state = createDemoState();
        const plan = generatePlan(state, { name: "Imported active plan" });
        const step = plan.steps[0]!;
        state.plans.push(plan);
        state.locations.find((location) => location.id === step.destinationId)!.archivedAt =
            "2026-07-22T12:00:00.000Z";

        const issues = validateSnapshot(state);
        expect(issues.some((candidate) => candidate.code === "PLAN_DESTINATION")).toBe(true);
    });

    it("rejects a new plan whose item was archived after generation", () => {
        const state = createDemoState();
        const plan = generatePlan(state, { name: "Now stale" });
        const itemId = plan.steps.find((step) => step.itemId)?.itemId;
        expect(itemId).toBeTruthy();
        state.items.find((item) => item.id === itemId)!.archivedAt =
            "2026-07-22T12:00:00.000Z";

        expect(() =>
            applyCommand(state, createEnvelope(state, { type: "plan.create", plan })),
        ).toThrow(/archived/);
    });

    it("rejects multiple active plans in a backup", () => {
        const state = createDemoState();
        const first = generatePlan(state, { name: "First plan" });
        const second = structuredClone(first);
        second.id = "plan_second";
        second.name = "Second plan";
        second.steps = second.steps.map((step, index) => ({
            ...step,
            id: `second_step_${index}`,
        }));
        state.plans.push(first, second);

        expect(
            validateSnapshot(state).some(
                (candidate) => candidate.code === "MULTIPLE_ACTIVE_PLANS",
            ),
        ).toBe(true);
    });

    it("keeps its own export valid after deleting a planned subject", () => {
        let state = createDemoState();
        const plan = generatePlan(state);
        const plannedItemId = plan.steps.find((step) => step.itemId)?.itemId;
        expect(plannedItemId).toBeTruthy();
        makeLocationsEditable(
            state,
            state.items.find((item) => item.id === plannedItemId)!.locationId,
        );
        state = applyCommand(
            state,
            createEnvelope(state, { type: "plan.create", plan }),
        ).state;
        state = applyCommand(
            state,
            createEnvelope(state, { type: "item.delete", id: plannedItemId as string }),
        ).state;

        expect(state.plans.find((candidate) => candidate.id === plan.id)?.status).toBe("discarded");
        expect(validateSnapshot(state).filter((issue) => issue.severity === "error")).toEqual([]);
    });

    it("creates cycle-safe new locations", () => {
        const state = makeLocationsEditable(createDemoState(), "loc_lower");
        const next = createLocation({ code: "B-18", name: "Cleaning bin", parentId: "loc_lower" });
        const result = applyCommand(
            state,
            createEnvelope(state, { type: "location.create", location: next }),
        ).state;
        expect(result.locations.find((location) => location.id === next.id)?.parentId).toBe("loc_lower");
    });

    it("does not recommend unchecked storage as a destination", () => {
        const state = createDemoState();
        const unchecked = createLocation({
            code: "NEW-01",
            kind: "cabinet",
            name: "Unchecked cabinet",
            parentId: "loc_kitchen",
        });
        unchecked.tags = ["special"];
        unchecked.conditions.foodSafe = true;
        state.locations.push(unchecked);
        state.items.find((item) => item.id === "item_pasta")!.constraints.requiredTags = ["special"];

        const beforeCount = generatePlan(state).steps.filter(
            (step) => step.destinationId === unchecked.id,
        ).length;
        unchecked.captureStatus = "known_empty";
        const afterCount = generatePlan(state).steps.filter(
            (step) => step.destinationId === unchecked.id,
        ).length;

        expect(beforeCount).toBe(0);
        expect(afterCount).toBeGreaterThan(0);
    });

    it("does not plan a whole-container move before that container is counted", () => {
        const state = createDemoState();
        state.locations.find((location) => location.id === "loc_bin")!.captureStatus =
            "in_progress";

        expect(
            generatePlan(state).steps.some(
                (step) => step.type === "location" && step.locationId === "loc_bin",
            ),
        ).toBe(false);
    });

    it("converts inches and centimeters before comparing measured capacity", () => {
        const state = createEmptyState("Mixed units");
        const root = createLocation({ code: "ROOM", kind: "room", name: "Room" });
        root.captureStatus = "counted";
        const source = createLocation({
            code: "SOURCE",
            kind: "shelf",
            name: "Source",
            parentId: root.id,
        });
        source.captureStatus = "counted";
        const destination = createLocation({
            code: "DEST",
            kind: "cabinet",
            name: "Tiny metric destination",
            parentId: root.id,
        });
        destination.captureStatus = "known_empty";
        destination.dimensions = { depth: 1, height: 1, unit: "cm", width: 10 };
        destination.tags = ["required"];
        const item = createItem({ locationId: source.id, name: "One-inch cube" });
        item.dimensions = { depth: 1, height: 1, unit: "in", width: 1 };
        item.constraints.requiredTags = ["required"];
        state.locations.push(root, source, destination);
        state.items.push(item);

        expect(
            generatePlan(state).steps.some((step) => step.destinationId === destination.id),
        ).toBe(false);
    });

    it("does not claim measured fit when item sizes are unknown", () => {
        const state = createEmptyState("Unknown item size");
        const root = createLocation({ code: "ROOM", kind: "room", name: "Room" });
        root.captureStatus = "counted";
        const source = createLocation({
            code: "SOURCE",
            kind: "shelf",
            name: "Source",
            parentId: root.id,
        });
        source.captureStatus = "counted";
        const destination = createLocation({
            code: "DEST",
            kind: "cabinet",
            name: "Tiny measured destination",
            parentId: root.id,
        });
        destination.captureStatus = "known_empty";
        destination.dimensions = { depth: 1, height: 1, unit: "cm", width: 1 };
        destination.tags = ["required"];
        const item = createItem({ locationId: source.id, name: "Unmeasured item" });
        item.constraints.requiredTags = ["required"];
        state.locations.push(root, source, destination);
        state.items.push(item);

        const step = generatePlan(state).steps.find(
            (candidate) => candidate.itemId === item.id,
        );
        expect(step?.explanation.join(" ")).toContain("capacity cannot be verified");
        expect(step?.explanation.join(" ")).not.toContain("fits measured capacity");
    });

    it("keeps capacity-freeing moves ahead of dependent inbound moves", () => {
        const state = createEmptyState("Sequenced capacity");
        const root = createLocation({ code: "ROOM", kind: "room", name: "Room" });
        root.captureStatus = "counted";
        const measured = createLocation({
            code: "D",
            kind: "cabinet",
            name: "Measured destination",
            parentId: root.id,
        });
        measured.captureStatus = "counted";
        measured.dimensions = { depth: 1, height: 1, unit: "cm", width: 10 };
        measured.tags = ["destination-d"];
        const alternate = createLocation({
            code: "E",
            kind: "cabinet",
            name: "Alternate destination",
            parentId: root.id,
        });
        alternate.captureStatus = "known_empty";
        alternate.dimensions = { depth: 1, height: 1, unit: "cm", width: 20 };
        alternate.tags = ["destination-e"];
        const source = createLocation({
            code: "SOURCE",
            kind: "shelf",
            name: "Source",
            parentId: root.id,
        });
        source.captureStatus = "counted";
        const outbound = createItem({ locationId: measured.id, name: "Move out first" });
        outbound.dimensions = { depth: 1, height: 1, unit: "cm", width: 6 };
        outbound.frequency = "rarely";
        outbound.constraints.requiredTags = ["destination-e"];
        const inbound = createItem({ locationId: source.id, name: "Move in second" });
        inbound.dimensions = { depth: 1, height: 1, unit: "cm", width: 6 };
        inbound.frequency = "daily";
        inbound.constraints.requiredTags = ["destination-d"];
        state.locations.push(root, measured, alternate, source);
        state.items.push(inbound, outbound);

        const steps = generatePlan(state).steps;
        expect(steps.findIndex((step) => step.itemId === outbound.id)).toBeLessThan(
            steps.findIndex((step) => step.itemId === inbound.id),
        );
    });

    it("never emits non-finite scores when finite dimensions overflow derived volume", () => {
        const state = createEmptyState("Numeric planner");
        const root = createLocation({ code: "ROOM", kind: "room", name: "Room" });
        root.captureStatus = "counted";
        const source = createLocation({
            code: "SOURCE",
            kind: "shelf",
            name: "Source",
            parentId: root.id,
        });
        source.captureStatus = "counted";
        const destination = createLocation({
            code: "DEST",
            kind: "cabinet",
            name: "Destination",
            parentId: root.id,
        });
        destination.captureStatus = "known_empty";
        destination.tags = ["preferred"];
        destination.dimensions = { depth: 1e200, height: 1e200, unit: "cm", width: 1e200 };
        const item = createItem({ locationId: source.id, name: "Large numeric item" });
        item.constraints.requiredTags = ["preferred"];
        item.dimensions = { depth: 1e200, height: 1e200, unit: "cm", width: 1e200 };
        state.locations.push(root, source, destination);
        state.items.push(item);

        const plan = generatePlan(state);
        expect(plan.steps.length).toBeGreaterThan(0);
        expect(plan.steps.every((step) => Number.isFinite(step.score))).toBe(true);
    });

    it("reserves measured capacity across generated plan steps", () => {
        const state = createEmptyState("Capacity plan");
        const root = createLocation({
            code: "ROOM",
            kind: "room",
            name: "Room",
        });
        root.captureStatus = "counted";
        const sourceA = createLocation({
            code: "SRC-A",
            kind: "shelf",
            name: "Source A",
            parentId: root.id,
        });
        sourceA.captureStatus = "counted";
        const sourceB = createLocation({
            code: "SRC-B",
            kind: "shelf",
            name: "Source B",
            parentId: root.id,
        });
        sourceB.captureStatus = "counted";
        const destination = createLocation({
            code: "DEST",
            kind: "cabinet",
            name: "Measured destination",
            parentId: root.id,
        });
        destination.captureStatus = "known_empty";
        destination.dimensions = { depth: 1, height: 1, unit: "in", width: 10 };
        destination.tags = ["required"];
        const first = createItem({
            locationId: sourceA.id,
            name: "First measured item",
        });
        first.dimensions = { depth: 1, height: 1, unit: "in", width: 6 };
        first.constraints.requiredTags = ["required"];
        const second = createItem({
            locationId: sourceB.id,
            name: "Second measured item",
        });
        second.dimensions = { depth: 1, height: 1, unit: "in", width: 6 };
        second.constraints.requiredTags = ["required"];
        state.locations.push(root, sourceA, sourceB, destination);
        state.items.push(first, second);

        const movesIntoDestination = generatePlan(state).steps.filter(
            (step) => step.destinationId === destination.id,
        );

        expect(movesIntoDestination).toHaveLength(1);
    });

    it("does not overfill a measured destination with a whole container", () => {
        const state = createEmptyState("Container capacity plan");
        const root = createLocation({ code: "ROOM", kind: "room", name: "Room" });
        root.captureStatus = "counted";
        const source = createLocation({
            code: "SOURCE",
            kind: "cabinet",
            name: "Source",
            parentId: root.id,
        });
        source.captureStatus = "counted";
        const box = createLocation({
            code: "BOX",
            kind: "box",
            name: "Filled box",
            parentId: source.id,
        });
        box.captureStatus = "counted";
        const destination = createLocation({
            code: "DEST",
            kind: "cabinet",
            name: "Measured destination",
            parentId: root.id,
        });
        destination.captureStatus = "known_empty";
        destination.dimensions = { depth: 1, height: 1, unit: "in", width: 10 };
        destination.tags = ["required"];
        const first = createItem({ locationId: box.id, name: "First box item" });
        first.dimensions = { depth: 1, height: 1, unit: "in", width: 6 };
        first.constraints.requiredTags = ["required"];
        const second = createItem({ locationId: box.id, name: "Second box item" });
        second.dimensions = { depth: 1, height: 1, unit: "in", width: 6 };
        second.constraints.requiredTags = ["required"];
        state.locations.push(root, source, box, destination);
        state.items.push(first, second);

        const movesIntoDestination = generatePlan(state).steps.filter(
            (step) => step.destinationId === destination.id,
        );

        expect(movesIntoDestination.filter((step) => step.type === "location")).toHaveLength(0);
        expect(movesIntoDestination).toHaveLength(1);
    });

    it("reserves measured capacity after planning a whole-container move", () => {
        const state = createEmptyState("Multiple container capacity plan");
        const root = createLocation({ code: "ROOM", kind: "room", name: "Room" });
        root.captureStatus = "counted";
        const source = createLocation({
            code: "SOURCE",
            kind: "cabinet",
            name: "Source",
            parentId: root.id,
        });
        source.captureStatus = "counted";
        const destination = createLocation({
            code: "DEST",
            kind: "cabinet",
            name: "Measured destination",
            parentId: root.id,
        });
        destination.captureStatus = "known_empty";
        destination.dimensions = { depth: 1, height: 1, unit: "in", width: 10 };
        destination.tags = ["required"];
        const firstBox = createLocation({
            code: "BOX-A",
            kind: "box",
            name: "First filled box",
            parentId: source.id,
        });
        firstBox.captureStatus = "counted";
        const secondBox = createLocation({
            code: "BOX-B",
            kind: "box",
            name: "Second filled box",
            parentId: source.id,
        });
        secondBox.captureStatus = "counted";
        const items = [
            createItem({ locationId: firstBox.id, name: "A one" }),
            createItem({ locationId: firstBox.id, name: "A two" }),
            createItem({ locationId: secondBox.id, name: "B one" }),
            createItem({ locationId: secondBox.id, name: "B two" }),
        ];
        for (const item of items) {
            item.dimensions = { depth: 1, height: 1, unit: "in", width: 3 };
            item.constraints.requiredTags = ["required"];
        }
        state.locations.push(root, source, destination, firstBox, secondBox);
        state.items.push(...items);

        const containerMoves = generatePlan(state).steps.filter(
            (step) => step.type === "location" && step.destinationId === destination.id,
        );

        expect(containerMoves).toHaveLength(1);
    });
});
