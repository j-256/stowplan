import type {
    Command,
    FieldExpectation,
    ItemRecord,
    JsonValue,
    Location,
    MovePlan,
    WorkspaceState,
} from "./types";

function json(value: unknown): JsonValue {
    return structuredClone(value) as JsonValue;
}

function locationExpectation(
    location: Location,
    path: keyof Location | "",
): FieldExpectation {
    return {
        id: location.id,
        path,
        target: "location",
        value: path ? json(location[path]) : json(location),
    };
}

function itemExpectation(item: ItemRecord, path: keyof ItemRecord | ""): FieldExpectation {
    return {
        id: item.id,
        path,
        target: "item",
        value: path ? json(item[path]) : json(item),
    };
}

function planExpectation(plan: MovePlan, path: keyof MovePlan | ""): FieldExpectation {
    return {
        id: plan.id,
        path,
        target: "plan",
        value: path ? json(plan[path]) : json(plan),
    };
}

function hierarchyParentExpectations(
    state: WorkspaceState,
    location: Location,
    parentId: string | null | undefined,
): FieldExpectation[] {
    if (parentId === undefined || parentId === location.parentId) return [];
    const parentIds = new Set(
        [location.parentId, parentId].filter(
            (candidate): candidate is string => candidate !== null,
        ),
    );
    return state.locations
        .filter((candidate) => parentIds.has(candidate.id))
        .map((candidate) => locationExpectation(candidate, "captureStatus"));
}

export function expectationsForCommand(
    state: WorkspaceState,
    command: Command,
): FieldExpectation[] {
    if (command.type === "workspace.rename") {
        return [{ id: state.workspace.id, path: "name", target: "workspace", value: state.workspace.name }];
    }

    if (
        command.type === "location.update" ||
        command.type === "location.move" ||
        command.type === "location.reorder" ||
        command.type === "location.archive" ||
        command.type === "location.delete" ||
        command.type === "capture.empty" ||
        command.type === "capture.status"
    ) {
        const location = state.locations.find((candidate) => candidate.id === command.id);
        if (!location) return [];
        if (command.type === "location.update") {
            return [
                ...Object.keys(command.changes).map((path) =>
                    locationExpectation(location, path as keyof Location)
                ),
                ...hierarchyParentExpectations(
                    state,
                    location,
                    command.changes.parentId,
                ),
            ];
        }
        if (command.type === "location.move") {
            return [
                locationExpectation(location, "parentId"),
                locationExpectation(location, "order"),
                ...hierarchyParentExpectations(
                    state,
                    location,
                    command.parentId,
                ),
            ];
        }
        if (command.type === "location.reorder") {
            return [
                locationExpectation(location, "parentId"),
                locationExpectation(location, "order"),
            ];
        }
        if (command.type === "location.archive") return [locationExpectation(location, "archivedAt")];
        if (command.type === "capture.empty") {
            return [
                locationExpectation(location, "captureStatus"),
                ...state.items
                    .filter((candidate) => command.itemIds.includes(candidate.id))
                    .map((candidate) => itemExpectation(candidate, "")),
            ];
        }
        if (command.type === "capture.status") return [locationExpectation(location, "captureStatus")];
        if (command.type === "location.delete") {
            const locationIds = new Set([command.id, ...command.descendantIds]);
            return [
                ...state.locations
                    .filter((candidate) => locationIds.has(candidate.id))
                    .map((candidate) => locationExpectation(candidate, "")),
                ...state.items
                    .filter((candidate) => command.itemIds.includes(candidate.id))
                    .map((candidate) => itemExpectation(candidate, "")),
            ];
        }
        return [locationExpectation(location, "")];
    }

    if (
        command.type === "item.update" ||
        command.type === "item.reorder" ||
        command.type === "item.delete" ||
        command.type === "item.move"
    ) {
        const item = state.items.find((candidate) => candidate.id === command.id);
        if (!item) return [];
        if (command.type === "item.update") {
            return Object.keys(command.changes).map((path) =>
                itemExpectation(item, path as keyof ItemRecord),
            );
        }
        if (command.type === "item.reorder") {
            return [itemExpectation(item, "order"), itemExpectation(item, "version")];
        }
        if (command.type === "item.move") {
            return [
                itemExpectation(item, "locationId"),
                itemExpectation(item, "quantity"),
                itemExpectation(item, "version"),
            ];
        }
        return [itemExpectation(item, "")];
    }

    if (command.type === "item.bulkMove") {
        return command.itemIds.flatMap((id) => {
            const item = state.items.find((candidate) => candidate.id === id);
            return item
                ? [itemExpectation(item, "locationId"), itemExpectation(item, "version")]
                : [];
        });
    }

    if (command.type === "plan.create") {
        return [{
            id: state.workspace.id,
            path: "revision",
            target: "workspace",
            value: state.workspace.revision,
        }];
    }

    if (command.type === "plan.step.complete" || command.type === "plan.status") {
        const plan = state.plans.find((candidate) => candidate.id === command.planId);
        if (!plan) return [];
        return command.type === "plan.status"
            ? [planExpectation(plan, "status")]
            : [
                  planExpectation(plan, "status"),
                  planExpectation(plan, "steps"),
              ];
    }

    return [];
}
