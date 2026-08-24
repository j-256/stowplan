import { describe, expect, it } from "vitest";
import { captureReorderOrder, nextCaptureLocation } from "../src/client/capture-order";
import { createDemoState } from "../src/domain";
import { createLocation } from "../src/domain/factories";

describe("Capture ordering", () => {
    it("advances through visible hierarchy order and wraps past completed spaces", () => {
        const state = createDemoState();
        const current = state.locations.find((location) => location.id === "loc_kitchen")!;
        const older = state.locations.find((location) => location.id === "loc_corner")!;
        const prioritized = createLocation({
            code: "NEW",
            name: "Priority bin",
            order: 1.5,
            parentId: "loc_right",
        });
        const completed = state.locations.find((location) => location.id === "loc_counter")!;
        const entries = [
            { location: current },
            { location: completed },
            { location: prioritized },
            { location: older },
        ];

        expect(nextCaptureLocation(entries, current.id)?.id).toBe(prioritized.id);
        expect(nextCaptureLocation(entries, older.id)?.id).toBe(prioritized.id);
    });

    it("reorders only siblings and uses the drop side", () => {
        const state = createDemoState();
        const beforeCounter = captureReorderOrder(state.locations, "loc_corner", "loc_counter", "inside");
        const afterUnknown = captureReorderOrder(state.locations, "loc_counter", "loc_corner", "inside");

        expect(beforeCounter).toBeGreaterThan(0);
        expect(beforeCounter).toBeLessThan(1);
        expect(afterUnknown).toBeGreaterThan(2);
        expect(captureReorderOrder(state.locations, "loc_corner", "loc_food", "before")).toBeNull();
    });
});
