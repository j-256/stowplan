import { describe, expect, it } from "vitest";
import {
    applyCommand,
    ConflictError,
    createDemoState,
    createEnvelope,
    createItem,
    createLocation,
    generatePlan,
    previewImport,
} from "../src/domain";

describe("organizer command engine", () => {
    it("records an item and distinctly marks the container counted", () => {
        let state = createDemoState();
        const newItem = createItem(
            { locationId: "loc_unknown", name: "Tea towels", quantity: 6, unit: "each" },
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
                { type: "capture.status", id: "loc_unknown", status: "counted" },
                { id: "cmd_counted" },
            ),
        ).state;

        expect(state.items.find((item) => item.id === newItem.id)?.quantity).toBe(6);
        expect(state.locations.find((location) => location.id === "loc_unknown")?.captureStatus).toBe(
            "counted",
        );
        expect(state.workspace.revision).toBe(2);
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

    it("splits a partial quantity and merges equivalent destination records", () => {
        let state = createDemoState();
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

    it("moves several records atomically", () => {
        const state = createDemoState();
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
        const state = createDemoState();
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
        const state = createDemoState();
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
                    id: "loc_unknown",
                    itemIds: [],
                }),
            ),
        ).toThrow(/review/);
    });
});

describe("field-aware history", () => {
    it("plucks one change for undo and safely reapplies it", () => {
        let state = createDemoState();
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
        let state = createDemoState();
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

    it("refuses an undo that would overwrite a later same-field edit", () => {
        let state = createDemoState();
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

    it("creates cycle-safe new locations", () => {
        const state = createDemoState();
        const next = createLocation({ code: "B-18", name: "Cleaning bin", parentId: "loc_lower" });
        const result = applyCommand(
            state,
            createEnvelope(state, { type: "location.create", location: next }),
        ).state;
        expect(result.locations.find((location) => location.id === next.id)?.parentId).toBe("loc_lower");
    });
});
