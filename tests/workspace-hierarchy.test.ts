import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  createLocation,
} from "../src/domain/factories";
import type {
  Location,
  WorkspaceState,
} from "../src/domain/types";
import {
  flattenLocationTree,
  locationPath,
  locationPlacementForDrop,
} from "../src/client/workspace-hierarchy";
import {
  movedOrder,
  nextOrder,
  orderAfter,
  orderBefore,
} from "../src/client/workspace-view-helpers";

function location(
  id: string,
  name: string,
  parentId: string | null,
  order: number,
): Location {
  return {
    ...createLocation({
      code: id,
      name,
      order,
      parentId,
    }, "2026-08-16T00:00:00.000Z"),
    id,
  };
}

function hierarchyState(): WorkspaceState {
  const state = createEmptyState(
    "Hierarchy",
    "2026-08-16T00:00:00.000Z",
  );
  state.locations = [
    location("root_a", "Root A", null, 0),
    location("root_b", "Root B", null, 10),
    location("child", "Child", "root_a", 0),
    location("grandchild", "Grandchild", "child", 0),
  ];
  return state;
}

describe("workspace hierarchy view model", () => {
  it("flattens valid, orphaned, and cyclic records once", () => {
    const locations = [
      location("root", "Root", null, 0),
      location("child", "Child", "root", 0),
      location("orphan", "Orphan", "missing", 0),
      location("cycle_a", "Cycle A", "cycle_b", 0),
      location("cycle_b", "Cycle B", "cycle_a", 0),
    ];

    expect(flattenLocationTree(locations).map((entry) => [
      entry.location.id,
      entry.depth,
    ])).toEqual([
      ["root", 0],
      ["child", 1],
      ["orphan", 0],
      ["cycle_a", 0],
      ["cycle_b", 1],
    ]);
    expect(locationPath(locations, "child").map((entry) => entry.id))
      .toEqual(["root", "child"]);
    expect(locationPath(locations, "cycle_a").map((entry) => entry.id))
      .toEqual(["cycle_b", "cycle_a"]);
  });

  it("calculates sibling ordering without mutating input", () => {
    const records = [
      { id: "a", order: 0 },
      { id: "b", order: 10 },
      { id: "c", order: 20 },
    ];

    expect(nextOrder(records)).toBe(21);
    expect(movedOrder(records, "b", -1)).toBe(-1);
    expect(movedOrder(records, "b", 1)).toBe(21);
    expect(orderBefore(records, "c", "b")).toBe(5);
    expect(orderAfter(records, "a", "b")).toBe(15);
    expect(records).toEqual([
      { id: "a", order: 0 },
      { id: "b", order: 10 },
      { id: "c", order: 20 },
    ]);
  });

  it("plans reorders and reparenting while refusing cycles", () => {
    const state = hierarchyState();

    expect(locationPlacementForDrop(state, "root_b", {
      id: "root_a",
      intent: "before",
      kind: "location",
    })).toEqual({
      command: {
        id: "root_b",
        order: -1,
        type: "location.reorder",
      },
      destinationParentId: null,
    });
    expect(locationPlacementForDrop(state, "child", {
      id: "root_b",
      intent: "inside",
      kind: "location",
    })).toEqual({
      command: {
        id: "child",
        order: 0,
        parentId: "root_b",
        type: "location.move",
      },
      destinationParentId: "root_b",
    });
    expect(locationPlacementForDrop(state, "root_a", {
      id: "grandchild",
      intent: "inside",
      kind: "location",
    })).toEqual({
      error: "Root A cannot be moved inside itself",
    });
    expect(locationPlacementForDrop(state, "root_a", {
      id: null,
      intent: "inside",
      kind: "root",
    })).toEqual({
      error: "Root A is already at the top level",
    });
  });
});
