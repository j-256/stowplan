import { describe, expect, it } from "vitest";
import { applyCommand, createDemoState, createEnvelope, generatePlan, validateSnapshot } from "../src/domain";
import { emptyPlanSelection, planSelectionIssue, resolvePlanSelection, validPlanSelection } from "../src/domain/plan-selection";
import type { PlanSelection } from "../src/domain/types";

const selection = (changes: Partial<PlanSelection> = {}): PlanSelection => ({
    locationIds: null, pinnedItemIds: [], pinnedLocationIds: [], ...changes,
});

describe("scoped and pinned planning", () => {
    it("keeps a pinned item in place even when its physical container would move", () => {
        const state = createDemoState();
        const baseline = generatePlan(state);
        expect(baseline.steps.some((step) => step.locationId === "loc_bin")).toBe(true);
        const plan = generatePlan(state, { selection: selection({ pinnedItemIds: ["item_flour"] }) });
        expect(plan.steps.some((step) => step.locationId === "loc_bin" || step.itemId === "item_flour")).toBe(false);
        expect(plan.selection?.pinnedItemIds).toEqual(["item_flour"]);
    });

    it("never moves outside selected subtrees or moves a selected root", () => {
        const state = createDemoState();
        const plan = generatePlan(state, { selection: selection({ locationIds: ["loc_food", "loc_warm"] }) });
        expect(plan.steps.length).toBeGreaterThan(0);
        for (const step of plan.steps) {
            expect(["loc_food", "loc_warm"]).toContain(step.sourceId);
            expect(["loc_food", "loc_warm"]).toContain(step.destinationId);
            expect(step.type).toBe("item");
        }
        expect(generatePlan(state, { selection: selection({ locationIds: [] }) }).steps).toEqual([]);
    });

    it("rejects a forged move of pinned contents through the ordinary command path", () => {
        const state = createDemoState();
        const plan = generatePlan(state);
        plan.selection = selection({ pinnedLocationIds: ["loc_bin"] });
        expect(() => applyCommand(state, createEnvelope(state, { type: "plan.create", plan }))).toThrow(/pinned/i);
    });

    it("freezes pinned subtrees and their ancestors but keeps other items available", () => {
        const state = createDemoState();
        const resolved = resolvePlanSelection(state, selection({ pinnedLocationIds: ["loc_bin"] }));
        expect(resolved.canMoveItem("item_flour", "loc_bin")).toBe(false);
        expect(resolved.canReceive("loc_bin")).toBe(false);
        expect(resolved.canMoveLocation("loc_lower", "loc_right")).toBe(false);
        expect(resolved.canMoveItem("item_beans", "loc_lower")).toBe(true);
        const plan = generatePlan(state, { selection: selection({ pinnedLocationIds: ["loc_right"] }) });
        expect(plan.steps.every((step) => step.type === "item" && ["loc_food", "loc_warm", "loc_drawer"].includes(step.sourceId))).toBe(true);
        expect(plan.steps.every((step) => ["loc_food", "loc_warm", "loc_drawer"].includes(step.destinationId))).toBe(true);
    });

    it("treats overlapping area selections as a union and keeps only outer roots anchored", () => {
        const state = createDemoState();
        const resolved = resolvePlanSelection(state, selection({ locationIds: ["loc_kitchen", "loc_bin"] }));
        expect(resolved.locationIds.size).toBe(state.locations.length);
        expect(resolved.canMoveLocation("loc_bin", "loc_lower")).toBe(true);
        expect(resolved.canMoveLocation("loc_kitchen", null)).toBe(false);
    });

    it("retains default behavior and does not modify input or selection", () => {
        const state = createDemoState();
        const before = structuredClone(state);
        const options = emptyPlanSelection();
        const legacy = generatePlan(state);
        const current = generatePlan(state, { selection: options });
        const moves = (plan: typeof legacy) => plan.steps.map(({ itemId, locationId, sourceId, destinationId }) => ({ itemId, locationId, sourceId, destinationId }));
        expect(moves(current)).toEqual(moves(legacy));
        options.pinnedItemIds.push("item_pasta");
        expect(current.selection?.pinnedItemIds).toEqual([]);
        expect(state).toEqual(before);
    });

    it("validates malformed, duplicate, archived, and missing selections", () => {
        const state = createDemoState();
        for (const bad of [null, {}, { ...selection(), pinnedItemIds: ["a", "a"] }, { ...selection(), locationIds: [""] }, { ...selection(), extra: true }]) {
            expect(validPlanSelection(bad)).toBe(false);
            expect(() => generatePlan(state, { selection: bad as PlanSelection })).toThrow(/malformed/);
        }
        state.items[0]!.archivedAt = state.workspace.updatedAt;
        expect(planSelectionIssue(state, selection({ pinnedItemIds: [state.items[0]!.id] }))).toMatch(/unavailable/);
        expect(() => generatePlan(state, { selection: selection({ locationIds: ["missing"] }) })).toThrow(/unavailable/);
    });

    it("refuses boundary violations, stale creation, and imported active pin violations", () => {
        const state = createDemoState();
        const plan = generatePlan(state);
        plan.selection = selection({ locationIds: ["loc_food", "loc_warm"] });
        expect(() => applyCommand(state, createEnvelope(state, { type: "plan.create", plan }))).toThrow(/boundary/);
        const valid = generatePlan(state, { selection: selection({ pinnedItemIds: ["item_rice"] }) });
        const command = createEnvelope(state, { type: "plan.create", plan: valid });
        const changed = applyCommand(state, createEnvelope(state, { type: "workspace.rename", name: "New name" })).state;
        expect(() => applyCommand(changed, command)).toThrow(/conflict/);
        const imported = applyCommand(state, command).state;
        imported.plans[0]!.selection = selection({ pinnedLocationIds: ["loc_bin"] });
        expect(validateSnapshot(imported).some((issue) => issue.code === "PLAN_SELECTION")).toBe(true);
    });

    it("discards a plan when a selected or pinned record changes, and undo restores its selection", () => {
        let state = createDemoState();
        const plan = generatePlan(state, { selection: selection({ pinnedItemIds: ["item_rice"] }) });
        state = applyCommand(state, createEnvelope(state, { type: "plan.create", plan })).state;
        state = applyCommand(state, createEnvelope(state, { type: "capture.status", id: "loc_food", status: "in_progress" })).state;
        const result = applyCommand(state, createEnvelope(state, { type: "item.delete", id: "item_rice" }));
        expect(result.state.plans[0]?.status).toBe("discarded");
        expect(validateSnapshot(result.state).filter((issue) => issue.severity === "error")).toEqual([]);
        const undo = applyCommand(result.state, createEnvelope(result.state, { type: "history.undo", activityId: result.activity!.id }));
        expect(undo.state.plans[0]?.selection).toEqual(plan.selection);
        expect(validateSnapshot(undo.state).filter((issue) => issue.severity === "error")).toEqual([]);
    });

    it("does not let a restored or executing plan bypass pins", () => {
        let state = createDemoState();
        const plan = generatePlan(state);
        state = applyCommand(state, createEnvelope(state, { type: "plan.create", plan })).state;
        const active = state.plans[0]!;
        active.selection = selection({ pinnedLocationIds: ["loc_kitchen"] });
        expect(() => applyCommand(state, createEnvelope(state, { type: "plan.step.complete", planId: plan.id, stepId: active.steps[0]!.id }))).toThrow(/pinned/);
        active.status = "discarded";
        expect(() => applyCommand(state, createEnvelope(state, { type: "plan.status", planId: plan.id, status: "active" }))).toThrow(/pinned/);
    });
});
