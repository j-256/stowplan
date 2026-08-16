import { describe, expect, it } from "vitest";
import {
    applyCommand,
    ConflictError,
    createEmptyState,
    createEnvelope,
    createItem,
    createLocation,
    type Command,
    type ItemRecord,
    type WorkspaceState,
} from "../src/domain";

const IMPORTED_AT = "2026-08-16T12:00:00.000Z";

function importState(): WorkspaceState {
    const state = createEmptyState("CSV import", IMPORTED_AT);
    const pantry = createLocation(
        { code: "PAN", kind: "room", name: "Pantry" },
        IMPORTED_AT,
    );
    pantry.captureStatus = "uncounted";
    const shelf = createLocation(
        {
            code: "PAN-1",
            kind: "shelf",
            name: "Top shelf",
            parentId: pantry.id,
        },
        IMPORTED_AT,
    );
    shelf.captureStatus = "counted";
    state.locations = [pantry, shelf];
    return state;
}

function importedItem(
    locationId: string,
    id: string,
    name: string,
): ItemRecord {
    const item = createItem({ locationId, name }, IMPORTED_AT);
    item.id = id;
    return item;
}

function bulkCreate(
    items: ItemRecord[],
    reopenCompletedParents?: boolean,
): Extract<Command, { type: "item.bulkCreate" }> {
    return {
        type: "item.bulkCreate",
        items,
        ...(reopenCompletedParents === undefined
            ? {}
            : { reopenCompletedParents }),
    };
}

describe("bulk item creation", () => {
    it("imports several records as one undoable activity", () => {
        const state = importState();
        const pantry = state.locations[0]!;
        const items = [
            importedItem(pantry.id, "item_csv_rice", "Rice"),
            importedItem(pantry.id, "item_csv_beans", "Beans"),
        ];
        const envelope = createEnvelope(
            state,
            bulkCreate(items),
            { id: "cmd_csv_import", timestamp: IMPORTED_AT },
        );

        expect(envelope.expectations).toEqual([{
            id: pantry.id,
            path: "captureStatus",
            target: "location",
            value: "uncounted",
        }]);

        const imported = applyCommand(state, envelope);
        expect(state.items).toEqual([]);
        expect(imported.state.items.map((item) => item.id)).toEqual([
            "item_csv_rice",
            "item_csv_beans",
        ]);
        expect(imported.state.locations[0]?.captureStatus).toBe("in_progress");
        expect(imported.activity?.label).toBe("Imported 2 item records");
        expect(imported.state.activities).toHaveLength(1);

        const undone = applyCommand(
            imported.state,
            createEnvelope(
                imported.state,
                {
                    type: "history.undo",
                    activityId: imported.activity!.id,
                },
                { id: "cmd_csv_undo" },
            ),
        );
        expect(undone.state.items).toEqual([]);
        expect(undone.state.locations[0]?.captureStatus).toBe("uncounted");

        const reapplied = applyCommand(
            undone.state,
            createEnvelope(
                undone.state,
                {
                    type: "history.reapply",
                    activityId: imported.activity!.id,
                },
                { id: "cmd_csv_reapply" },
            ),
        );
        expect(reapplied.state.items.map((item) => item.id)).toEqual([
            "item_csv_rice",
            "item_csv_beans",
        ]);
        expect(reapplied.state.locations[0]?.captureStatus).toBe("in_progress");
    });

    it("reopens every completed destination atomically", () => {
        const state = importState();
        const pantry = state.locations[0]!;
        const shelf = state.locations[1]!;
        pantry.captureStatus = "known_empty";
        const command = bulkCreate([
            importedItem(pantry.id, "item_csv_flour", "Flour"),
            importedItem(shelf.id, "item_csv_sugar", "Sugar"),
        ], true);
        const envelope = createEnvelope(
            state,
            command,
            { id: "cmd_csv_reopen", timestamp: IMPORTED_AT },
        );

        expect(envelope.expectations.map((expectation) => [
            expectation.id,
            expectation.value,
        ])).toEqual([
            [pantry.id, "known_empty"],
            [shelf.id, "counted"],
        ]);

        const result = applyCommand(state, envelope);
        expect(result.state.locations.map((location) =>
            location.captureStatus
        )).toEqual(["in_progress", "in_progress"]);
        expect(result.activity?.label).toBe(
            "Imported 2 item records and reopened affected spaces",
        );
    });

    it("refuses a completed destination without confirmation", () => {
        const state = importState();
        const shelf = state.locations[1]!;
        const command = bulkCreate([
            importedItem(shelf.id, "item_csv_tea", "Tea"),
        ]);

        expect(() => applyCommand(
            state,
            createEnvelope(state, command, { id: "cmd_csv_locked" }),
        )).toThrow(/Reopen Top shelf before adding an item/);
        expect(state.items).toEqual([]);
        expect(shelf.captureStatus).toBe("counted");
    });

    it("rejects an invalid later row without importing an earlier row", () => {
        const state = importState();
        const pantry = state.locations[0]!;
        const valid = importedItem(
            pantry.id,
            "item_csv_valid",
            "Valid item",
        );
        const invalid = importedItem(
            pantry.id,
            "item_csv_invalid",
            "Invalid item",
        );
        invalid.quantity = 0;

        expect(() => applyCommand(
            state,
            createEnvelope(
                state,
                bulkCreate([valid, invalid]),
                { id: "cmd_csv_invalid" },
            ),
        )).toThrow(/Quantity must be greater than zero/);
        expect(state.items).toEqual([]);
        expect(state.activities).toEqual([]);
    });

    it("rejects duplicate and existing item IDs", () => {
        const state = importState();
        const pantry = state.locations[0]!;
        const first = importedItem(
            pantry.id,
            "item_csv_duplicate",
            "First",
        );
        const duplicate = importedItem(
            pantry.id,
            "item_csv_duplicate",
            "Second",
        );

        expect(() => applyCommand(
            state,
            createEnvelope(
                state,
                bulkCreate([first, duplicate]),
                { id: "cmd_csv_duplicate" },
            ),
        )).toThrow(/Imported item IDs must be unique/);

        state.items.push(first);
        expect(() => applyCommand(
            state,
            createEnvelope(
                state,
                bulkCreate([first]),
                { id: "cmd_csv_collision" },
            ),
        )).toThrow(/imported item ID already exists/);
    });

    it("conflicts when a destination changed after review", () => {
        const state = importState();
        const pantry = state.locations[0]!;
        const envelope = createEnvelope(
            state,
            bulkCreate([
                importedItem(pantry.id, "item_csv_stale", "Stale review"),
            ]),
            { id: "cmd_csv_stale" },
        );
        const changed = structuredClone(state);
        changed.locations[0]!.captureStatus = "counted";

        expect(() => applyCommand(changed, envelope)).toThrow(ConflictError);
        expect(changed.items).toEqual([]);
    });

    it("rejects malformed command confirmation at runtime", () => {
        const state = importState();
        const pantry = state.locations[0]!;
        const command = bulkCreate([
            importedItem(pantry.id, "item_csv_malformed", "Malformed"),
        ]);
        (
            command as unknown as { reopenCompletedParents: unknown }
        ).reopenCompletedParents = "yes";

        expect(() => applyCommand(
            state,
            createEnvelope(state, command, { id: "cmd_csv_malformed" }),
        )).toThrow(/Completed-space confirmation must be true or false/);
    });
});
