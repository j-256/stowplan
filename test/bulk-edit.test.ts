import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { emptyBulkEditDraft, planBulkEdit, type TagEditMode } from "../src/domain/bulk-edit";
import { createDemoState } from "../src/domain/demo";
import { createEnvelope } from "../src/domain/factories";
import { ConflictError } from "../src/domain/errors";
import { validateSnapshot } from "../src/domain/import";

describe("bulk edit preparation", () => {
    it("defaults to no changes and does not reopen completed spaces", () => {
        const state = createDemoState();
        const preview = planBulkEdit(state, [state.items[0]!.id], emptyBulkEditDraft());
        expect(preview.command).toBeNull();
        expect(preview.completedLocations).toEqual([]);
        expect(preview.unchangedCount).toBe(1);
    });

    it.each([
        ["add", ["existing", "camping", "dry"]],
        ["remove", ["existing"]],
        ["replace", ["camping", "dry"]],
        ["clear", []],
    ] as [TagEditMode, string[]][])("prepares %s tags independently for each selected item", (mode, expected) => {
        const state = createDemoState();
        const item = state.items[0]!;
        item.tags = ["existing", "camping"];
        item.constraints.requiredTags = ["existing", "camping"];
        const draft = emptyBulkEditDraft();
        draft.tags = { mode, text: " camping, dry, camping " };
        draft.requiredTags = draft.tags;
        const preview = planBulkEdit(state, [item.id], draft);
        expect(preview.command?.updates[0]?.changes.tags).toEqual(expected);
        expect(preview.command?.updates[0]?.changes.constraints?.requiredTags).toEqual(expected);
        const result = applyCommand(state, createEnvelope(state, preview.command!));
        expect(validateSnapshot(JSON.parse(JSON.stringify(result.state))).filter((issue) => issue.severity === "error")).toEqual([]);
    });

    it("previews exact changed leaves and skips matching records", () => {
        const state = createDemoState();
        const [first, second] = state.items;
        first!.category = "Camping";
        second!.category = "Other";
        const draft = { ...emptyBulkEditDraft(), category: " Camping " };
        const preview = planBulkEdit(state, [first!.id, second!.id], draft);
        expect(preview.unchangedCount).toBe(1);
        expect(preview.items.map(({ item }) => item.id)).toEqual([second!.id]);
        expect(preview.items[0]?.patches).toMatchObject([{ before: "Other", after: "Camping", path: "category" }]);
    });

    it("keeps reviewed expectations even when an envelope is built after a conflicting change", () => {
        const state = createDemoState();
        const item = state.items[0]!;
        const preview = planBulkEdit(state, [item.id], { ...emptyBulkEditDraft(), category: "Camping" });
        const remote = structuredClone(state);
        remote.items[0]!.category = "Remote";
        const command = createEnvelope(remote, preview.command!, { expectations: preview.expectations });
        preview.expectations.length = 0;
        expect(command.expectations.length).toBeGreaterThan(0);
        expect(() => applyCommand(remote, command)).toThrow(ConflictError);
    });

    it("rejects incomplete edits and stale selections without changing state", () => {
        const state = createDemoState();
        const before = structuredClone(state);
        const ids = [state.items[0]!.id];
        expect(() => planBulkEdit(state, ids, { ...emptyBulkEditDraft(), category: " " })).toThrow(/category/);
        expect(() => planBulkEdit(state, ids, { ...emptyBulkEditDraft(), tags: { mode: "add", text: ", " } })).toThrow(/tags/);
        expect(() => planBulkEdit(state, ids, { ...emptyBulkEditDraft(), constraints: { keepTogether: " " } })).toThrow(/group/);
        expect(() => planBulkEdit(state, ["missing"], emptyBulkEditDraft())).toThrow(/no longer available/);
        expect(() => planBulkEdit(state, [], emptyBulkEditDraft())).toThrow(/Select/);
        expect(() => planBulkEdit(state, [...ids, ...ids], emptyBulkEditDraft())).toThrow(/unique/);
        expect(state).toEqual(before);
    });
});
