import { describe, expect, it } from "vitest";
import {
    assessPlanReadiness,
    createDemoState,
    createEmptyState,
    createItem,
    createLocation,
} from "../src/domain";

describe("planning readiness", () => {
    it("identifies the minimum evidence needed before a plan can be useful", () => {
        const empty = createEmptyState();

        expect(assessPlanReadiness(empty)).toMatchObject({
            activeItemIds: [],
            canGenerateUsefulPlan: false,
            countedDestinationIds: [],
            level: "needs_inventory",
            primaryGap: "inventory",
        });

        const room = createLocation({
            code: "ROOM",
            kind: "room",
            name: "Room",
        });
        const source = createLocation({
            code: "SRC",
            kind: "shelf",
            name: "Source shelf",
            parentId: room.id,
        });
        source.captureStatus = "counted";
        empty.locations.push(room, source);
        empty.items.push(createItem({
            locationId: source.id,
            name: "Tea",
        }));

        expect(assessPlanReadiness(empty)).toMatchObject({
            canGenerateUsefulPlan: false,
            countedDestinationIds: [source.id],
            level: "needs_destinations",
            primaryGap: "destinations",
        });
    });

    it("separates required basics from confidence improvements", () => {
        const state = createDemoState();
        const readiness = assessPlanReadiness(state);

        expect(readiness.canGenerateUsefulPlan).toBe(true);
        expect(readiness.level).toBe("limited");
        expect(readiness.uncountedLocationIds).toEqual(
            expect.arrayContaining(["loc_unknown", "loc_box"]),
        );
        expect(readiness.uncategorizedItemIds).toEqual([]);
        expect(readiness.unmeasuredDestinationIds).toContain("loc_box");
        expect(readiness.unmeasuredItemIds).toContain("item_pasta");
        expect(readiness.primaryGap).toBe("count");
    });

    it("ignores archived records and recognizes explicit planning details", () => {
        const state = createDemoState();
        const item = createItem({
            locationId: "loc_food",
            name: "Archived placeholder",
        });
        item.archivedAt = "2026-07-23T12:00:00.000Z";
        state.items.push(item);
        const configured = state.items.find((candidate) => candidate.id === "item_spatula")!;
        configured.category = "Utensils";
        configured.frequency = "daily";

        const readiness = assessPlanReadiness(state);

        expect(readiness.activeItemIds).not.toContain(item.id);
        expect(readiness.quickDefaultItemIds).not.toContain(configured.id);
        expect(readiness.uncategorizedItemIds).not.toContain(item.id);
    });

    it("recognizes a fully reviewed workspace", () => {
        const state = createDemoState();
        for (const location of state.locations.filter((candidate) => !candidate.archivedAt)) {
            location.captureStatus = "counted";
            if (location.kind === "area" || location.kind === "room") continue;
            location.tags = ["reviewed"];
            location.dimensions = {
                depth: 24,
                height: 24,
                unit: "in",
                width: 24,
            };
        }
        for (const item of state.items.filter((candidate) => !candidate.archivedAt)) {
            item.dimensions = {
                depth: 4,
                height: 4,
                unit: "in",
                width: 4,
            };
        }

        expect(assessPlanReadiness(state)).toMatchObject({
            destinationsUsingDefaultsIds: [],
            level: "ready",
            primaryGap: "none",
            uncountedLocationIds: [],
            unmeasuredDestinationIds: [],
            unmeasuredItemIds: [],
        });
    });
});
