import { describe, expect, it } from "vitest";
import {
    applyCommand,
    ConflictError,
    createEmptyState,
    createEnvelope,
    createItem,
    createLocation,
    type Command,
    type ItemBulkChanges,
    type WorkspaceState,
} from "../src/domain";

const CAPTURED_AT = "2026-09-01T12:00:00.000Z";
const EDITED_AT = "2026-09-12T12:00:00.000Z";

function fixture(): WorkspaceState {
    const state = createEmptyState("Bulk editing", CAPTURED_AT);
    state.locations = ["Shelf", "Box"].map((name, index) => {
        const location = createLocation({ code: name, name }, CAPTURED_AT);
        location.id = `loc_${index}`;
        location.captureStatus = "in_progress";
        return location;
    });
    state.items = state.locations.map((location, index) => {
        const item = createItem({ name: `Item ${index}`, locationId: location.id }, CAPTURED_AT);
        item.id = `item_${index}`;
        item.tags = [index === 0 ? "tools" : "travel"];
        item.constraints.keepTogether = `group_${index}`;
        return item;
    });
    return state;
}

function bulk(changes: ItemBulkChanges = { category: "Camping" }): Extract<Command, { type: "item.bulkUpdate" }> {
    return {
        type: "item.bulkUpdate",
        updates: ["item_0", "item_1"].map((id) => ({ id, changes })),
    };
}

function apply(state: WorkspaceState, command: Command, id = "cmd_bulk") {
    return applyCommand(state, createEnvelope(state, command, { id, timestamp: EDITED_AT }));
}

describe("bulk item updates", () => {
    it("changes shared fields as one atomic activity with leaf patches", () => {
        const state = fixture();
        const original = structuredClone(state);
        const result = apply(state, bulk({
            category: "Camping",
            frequency: "rarely",
            constraints: { avoidHumidity: true },
        }));
        expect(state).toEqual(original);
        expect(result.state.activities).toHaveLength(1);
        expect(result.activity?.label).toBe("Updated 2 item records");
        for (const item of result.state.items) {
            expect(item.category).toBe("Camping");
            expect(item.frequency).toBe("rarely");
            expect(item.constraints.avoidHumidity).toBe(true);
            expect(item.constraints.keepTogether).toBe(original.items.find((candidate) => candidate.id === item.id)!.constraints.keepTogether);
            expect(item.updatedAt).toBe(EDITED_AT);
            expect(item.version).toBe(2);
        }
        expect(result.activity?.patches.some((patch) => patch.path === "constraints.avoidHumidity")).toBe(true);
        expect(result.activity?.patches.some((patch) => patch.path === "constraints")).toBe(false);
    });

    it("requires explicit reopening and reverses edits and statuses together", () => {
        const state = fixture();
        state.locations.forEach((location) => { location.captureStatus = "counted"; });
        expect(() => apply(state, bulk())).toThrow(/Reopen Shelf before editing/);
        const result = apply(state, { ...bulk(), reopenCompletedParents: true });
        expect(result.state.locations.map((location) => location.captureStatus)).toEqual(["in_progress", "in_progress"]);
        expect(result.activity?.label).toBe("Updated 2 item records and reopened affected spaces");
        const undone = apply(result.state, { type: "history.undo", activityId: result.activity!.id }, "cmd_undo");
        expect(undone.state.items.map((item) => item.category)).toEqual(state.items.map((item) => item.category));
        expect(undone.state.locations.map((location) => location.captureStatus)).toEqual(["counted", "counted"]);
        const reapplied = apply(undone.state, { type: "history.reapply", activityId: result.activity!.id }, "cmd_reapply");
        expect(reapplied.state.items.map((item) => item.category)).toEqual(["Camping", "Camping"]);
        expect(reapplied.state.locations.map((location) => location.captureStatus)).toEqual(["in_progress", "in_progress"]);
    });

    it("skips unchanged records without reopening their spaces or touching versions", () => {
        const state = fixture();
        state.items[0]!.category = "Camping";
        state.locations[0]!.captureStatus = "counted";
        const result = apply(state, bulk());
        expect(result.state.items[0]).toEqual(state.items[0]);
        expect(result.state.locations[0]).toEqual(state.locations[0]);
        expect(result.activity?.label).toBe("Updated 1 item record");
        expect(result.activity?.subjectIds).not.toContain("item_0");
        expect(() => apply(result.state, bulk(), "cmd_noop")).toThrow(/No changes/);
    });

    it("invalidates plans affected by an edited item or its containing space", () => {
        const state = fixture();
        state.plans.push({
            id: "plan_existing", name: "Move", createdAt: CAPTURED_AT, status: "active",
            weights: { accessibility: 1, capacity: 1, grouping: 1, moveCost: 1, suitability: 1 },
            steps: [{ id: "step", completedAt: null, destinationId: "loc_1", sourceId: "loc_0", itemId: "item_0", locationId: null, type: "item", quantity: 1, score: 1, explanation: [] }],
        });
        const result = apply(state, bulk());
        expect(result.state.plans[0]?.status).toBe("discarded");
        const undone = apply(result.state, { type: "history.undo", activityId: result.activity!.id }, "cmd_undo_plan");
        expect(undone.state.plans[0]?.status).toBe("active");
    });

    it.each(["category", "constraints.avoidHumidity", "locationId", "archivedAt", "captureStatus", "locationArchive"])("refuses the whole batch after a reviewed %s change", (field) => {
        const state = fixture();
        const envelope = createEnvelope(state, bulk({ category: "Camping", constraints: { avoidHumidity: true } }));
        const changed = structuredClone(state);
        const item = changed.items[1]!;
        if (field === "category") item.category = "Remote";
        if (field === "constraints.avoidHumidity") item.constraints.avoidHumidity = true;
        if (field === "locationId") item.locationId = "loc_0";
        if (field === "archivedAt") item.archivedAt = EDITED_AT;
        if (field === "captureStatus") changed.locations[1]!.captureStatus = "counted";
        if (field === "locationArchive") changed.locations[1]!.archivedAt = EDITED_AT;
        const before = structuredClone(changed);
        expect(() => applyCommand(changed, envelope)).toThrow(ConflictError);
        expect(changed).toEqual(before);
    });

    it("preserves unrelated remote edits and selective undo does not overwrite them", () => {
        const state = fixture();
        const envelope = createEnvelope(state, bulk({ constraints: { avoidHumidity: true } }));
        const remote = apply(state, {
            type: "item.update", id: "item_0",
            changes: { description: "Remote description", constraints: { ...state.items[0]!.constraints, avoidWarmth: true } },
        }, "cmd_remote").state;
        const result = applyCommand(remote, envelope);
        expect(result.state.items[0]?.description).toBe("Remote description");
        expect(result.state.items[0]?.constraints.avoidWarmth).toBe(true);
        const undone = apply(result.state, { type: "history.undo", activityId: result.activity!.id }, "cmd_undo_leaves");
        expect(undone.state.items[0]?.constraints).toEqual(remote.items[0]?.constraints);
        expect(undone.state.items[0]?.description).toBe("Remote description");
    });

    it("refuses undo when a later edit changes the same leaf", () => {
        const result = apply(fixture(), bulk());
        const remote = apply(result.state, { type: "item.update", id: "item_1", changes: { category: "Remote" } }, "cmd_later").state;
        expect(() => apply(remote, { type: "history.undo", activityId: result.activity!.id }, "cmd_conflicting_undo")).toThrow(ConflictError);
    });

    it.each([
        ["empty batch", { updates: [] }],
        ["missing target", { updates: [{ id: "item_0", changes: { category: "Camping" } }, { id: "missing", changes: { category: "Camping" } }] }],
        ["duplicate target", { updates: [{ id: "item_0", changes: { category: "Camping" } }, { id: "item_0", changes: { frequency: "daily" } }] }],
        ["invalid frequency", { updates: [{ id: "item_0", changes: { category: "Camping" } }, { id: "item_1", changes: { frequency: "sometimes" } }] }],
        ["invalid tags", { updates: [{ id: "item_0", changes: { tags: [true] } }] }],
        ["structural change", { updates: [{ id: "item_0", changes: { locationId: "loc_1" } }] }],
        ["unsupported leaf", { updates: [{ id: "item_0", changes: { constraints: { mystery: true } } }] }],
        ["invalid leaf", { updates: [{ id: "item_0", changes: { constraints: { avoidHumidity: "yes" } } }] }],
        ["invalid confirmation", { reopenCompletedParents: "yes" }],
        ["null changes", { updates: [{ id: "item_0", changes: null }] }],
        ["null constraints", { updates: [{ id: "item_0", changes: { constraints: null } }] }],
    ])("rejects %s without partial application", (_label, changes) => {
        const state = fixture();
        const original = structuredClone(state);
        const command = { ...bulk(), ...changes } as unknown as Command;
        const envelope = { ...createEnvelope(state, bulk()), command, expectations: [] };
        expect(() => applyCommand(state, envelope)).toThrow();
        expect(state).toEqual(original);
    });

    it.each(["item", "location"])("refuses an archived %s even with reopening approval", (target) => {
        const state = fixture();
        if (target === "item") state.items[1]!.archivedAt = EDITED_AT;
        else state.locations[1]!.archivedAt = EDITED_AT;
        expect(() => apply(state, { ...bulk(), reopenCompletedParents: true })).toThrow(/archived/i);
    });
});
