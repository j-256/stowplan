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
        command.type === "capture.status"
    ) {
        const location = state.locations.find((candidate) => candidate.id === command.id);
        if (!location) return [];
        if (command.type === "location.update") {
            return Object.keys(command.changes).map((path) =>
                locationExpectation(location, path as keyof Location),
            );
        }
        if (command.type === "location.move") {
            return [
                locationExpectation(location, "parentId"),
                locationExpectation(location, "order"),
            ];
        }
        if (command.type === "location.reorder") return [locationExpectation(location, "order")];
        if (command.type === "location.archive") return [locationExpectation(location, "archivedAt")];
        if (command.type === "capture.status") return [locationExpectation(location, "captureStatus")];
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

    if (command.type === "plan.step.complete" || command.type === "plan.status") {
        const plan = state.plans.find((candidate) => candidate.id === command.planId);
        if (!plan) return [];
        return command.type === "plan.status"
            ? [planExpectation(plan, "status")]
            : [planExpectation(plan, "steps")];
    }

    return [];
}
