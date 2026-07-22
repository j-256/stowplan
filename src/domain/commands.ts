import { ConflictError, DomainError } from "./errors";
import type {
    ActivityRecord,
    AuditEvent,
    Command,
    CommandEnvelope,
    CommandResult,
    FieldExpectation,
    FieldPatch,
    ItemRecord,
    JsonValue,
    Location,
    MovePlan,
    PatchTarget,
    SyncConflict,
    WorkspaceState,
} from "./types";

type Entity = ItemRecord | Location | MovePlan | WorkspaceState["workspace"];

function clone<T>(value: T): T {
    return structuredClone(value);
}

function json(value: unknown): JsonValue | undefined {
    if (value === undefined) return undefined;
    return clone(value) as JsonValue;
}

function equal(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (typeof left !== typeof right || left === null || right === null) return false;
    if (Array.isArray(left)) {
        return Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => equal(value, right[index]));
    }
    if (typeof left === "object") {
        const leftObject = left as Record<string, unknown>;
        const rightObject = right as Record<string, unknown>;
        const leftKeys = Object.keys(leftObject).sort();
        const rightKeys = Object.keys(rightObject).sort();
        return equal(leftKeys, rightKeys) &&
            leftKeys.every((key) => equal(leftObject[key], rightObject[key]));
    }
    return false;
}

function collectionFor(state: WorkspaceState, target: Exclude<PatchTarget, "workspace">): Entity[] {
    if (target === "item") return state.items;
    if (target === "location") return state.locations;
    return state.plans;
}

function entityFor(state: WorkspaceState, target: PatchTarget, id: string): Entity | undefined {
    if (target === "workspace") return state.workspace.id === id ? state.workspace : undefined;
    return collectionFor(state, target).find((entity) => entity.id === id);
}

function readPath(entity: unknown, path: string): unknown {
    if (!path) return entity;
    return path.split(".").reduce<unknown>((value, key) => {
        if (!value || typeof value !== "object") return undefined;
        return (value as Record<string, unknown>)[key];
    }, entity);
}

export function readPatchValue(
    state: WorkspaceState,
    target: PatchTarget,
    id: string,
    path: string,
): JsonValue | undefined {
    return json(readPath(entityFor(state, target, id), path));
}

function writePath(entity: Entity, path: string, value: JsonValue | undefined): void {
    const keys = path.split(".");
    const last = keys.pop();
    if (!last) throw new DomainError("INVALID_PATCH", "A field patch needs a path");
    let cursor = entity as unknown as Record<string, unknown>;
    for (const key of keys) {
        const next = cursor[key];
        if (!next || typeof next !== "object") cursor[key] = {};
        cursor = cursor[key] as Record<string, unknown>;
    }
    if (value === undefined) delete cursor[last];
    else cursor[last] = clone(value);
}

export function applyFieldPatch(state: WorkspaceState, patch: FieldPatch): void {
    if (!patch.path) {
        if (patch.target === "workspace") {
            if (patch.after === undefined) {
                throw new DomainError("INVALID_PATCH", "The workspace cannot be removed");
            }
            state.workspace = clone(patch.after) as unknown as WorkspaceState["workspace"];
            return;
        }
        const collection = collectionFor(state, patch.target);
        const index = collection.findIndex((entity) => entity.id === patch.id);
        if (patch.after === undefined) {
            if (index >= 0) collection.splice(index, 1);
            return;
        }
        const next = clone(patch.after) as unknown as Entity;
        if (index >= 0) collection[index] = next;
        else collection.push(next);
        return;
    }

    const entity = entityFor(state, patch.target, patch.id);
    if (!entity) {
        throw new DomainError(
            "PATCH_TARGET_MISSING",
            `Cannot change ${patch.target} ${patch.id}; it no longer exists`,
        );
    }
    writePath(entity, patch.path, patch.after);
}

function applyPatches(state: WorkspaceState, patches: FieldPatch[]): void {
    for (const patch of patches) applyFieldPatch(state, patch);
}

function patch(
    target: PatchTarget,
    id: string,
    path: string,
    before: unknown,
    after: unknown,
): FieldPatch {
    return { after: json(after), before: json(before), id, path, target };
}

function requireLocation(state: WorkspaceState, id: string): Location {
    const location = state.locations.find((candidate) => candidate.id === id);
    if (!location) throw new DomainError("LOCATION_NOT_FOUND", `Location ${id} was not found`);
    return location;
}

function requireItem(state: WorkspaceState, id: string): ItemRecord {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) throw new DomainError("ITEM_NOT_FOUND", `Item ${id} was not found`);
    return item;
}

function requirePlan(state: WorkspaceState, id: string): MovePlan {
    const plan = state.plans.find((candidate) => candidate.id === id);
    if (!plan) throw new DomainError("PLAN_NOT_FOUND", `Plan ${id} was not found`);
    return plan;
}

function descendantsOf(state: WorkspaceState, id: string): Location[] {
    const descendants: Location[] = [];
    const queue = [id];
    while (queue.length) {
        const parentId = queue.shift() as string;
        for (const location of state.locations.filter((candidate) => candidate.parentId === parentId)) {
            descendants.push(location);
            queue.push(location.id);
        }
    }
    return descendants;
}

function validateLocation(state: WorkspaceState, location: Location, ignoreId?: string): void {
    if (!location.name.trim()) throw new DomainError("NAME_REQUIRED", "Location name is required");
    if (!location.code.trim()) throw new DomainError("CODE_REQUIRED", "Location code is required");
    if (
        state.locations.some(
            (candidate) =>
                candidate.id !== ignoreId &&
                !candidate.archivedAt &&
                candidate.code.toLocaleUpperCase() === location.code.toLocaleUpperCase(),
        )
    ) {
        throw new DomainError("CODE_IN_USE", `Location code ${location.code} is already in use`);
    }
    if (location.parentId) requireLocation(state, location.parentId);
}

function validateItem(state: WorkspaceState, item: ItemRecord): void {
    if (!item.name.trim()) throw new DomainError("NAME_REQUIRED", "Item name is required");
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        throw new DomainError("INVALID_QUANTITY", "Quantity must be greater than zero");
    }
    if (!item.unit.trim()) throw new DomainError("UNIT_REQUIRED", "Unit is required");
    if (!Number.isFinite(item.order)) throw new DomainError("INVALID_ORDER", "Item order must be a number");
    requireLocation(state, item.locationId);
}

function equivalent(left: ItemRecord, right: ItemRecord): boolean {
    const normalize = (value: string) => value.trim().toLocaleLowerCase();
    return normalize(left.name) === normalize(right.name) &&
        normalize(left.category) === normalize(right.category) &&
        normalize(left.unit) === normalize(right.unit) &&
        equal([...left.tags].sort(), [...right.tags].sort()) &&
        equal(left.constraints, right.constraints) &&
        equal(left.dimensions, right.dimensions) &&
        left.frequency === right.frequency &&
        left.notes === right.notes;
}

function moveItemPatches(
    state: WorkspaceState,
    item: ItemRecord,
    destinationId: string,
    quantity: number,
    envelope: CommandEnvelope,
): FieldPatch[] {
    requireLocation(state, destinationId);
    if (item.locationId === destinationId) {
        throw new DomainError("ALREADY_THERE", `${item.name} is already in that location`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > item.quantity) {
        throw new DomainError(
            "INVALID_QUANTITY",
            `Move quantity must be between 0 and ${item.quantity}`,
        );
    }

    const matching = state.items.find(
        (candidate) =>
            candidate.id !== item.id &&
            !candidate.archivedAt &&
            candidate.locationId === destinationId &&
            equivalent(candidate, item),
    );
    const patches: FieldPatch[] = [];
    const remaining = item.quantity - quantity;
    const destinationOrder = state.items
        .filter((candidate) => candidate.locationId === destinationId && !candidate.archivedAt)
        .reduce((maximum, candidate) => Math.max(maximum, candidate.order ?? 0), -1) + 1;

    if (matching) {
        patches.push(
            patch("item", matching.id, "quantity", matching.quantity, matching.quantity + quantity),
            patch("item", matching.id, "updatedAt", matching.updatedAt, envelope.timestamp),
            patch("item", matching.id, "version", matching.version, matching.version + 1),
        );
        if (remaining === 0) patches.push(patch("item", item.id, "", item, undefined));
        else {
            patches.push(
                patch("item", item.id, "quantity", item.quantity, remaining),
                patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
                patch("item", item.id, "version", item.version, item.version + 1),
            );
        }
        return patches;
    }

    if (remaining === 0) {
        patches.push(
            patch("item", item.id, "locationId", item.locationId, destinationId),
            patch("item", item.id, "order", item.order, destinationOrder),
            patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
            patch("item", item.id, "version", item.version, item.version + 1),
        );
        return patches;
    }

    const split: ItemRecord = {
        ...clone(item),
        createdAt: envelope.timestamp,
        id: `item_split_${envelope.id}`,
        locationId: destinationId,
        order: destinationOrder,
        quantity,
        updatedAt: envelope.timestamp,
        version: 1,
    };
    patches.push(
        patch("item", item.id, "quantity", item.quantity, remaining),
        patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
        patch("item", item.id, "version", item.version, item.version + 1),
        patch("item", split.id, "", undefined, split),
    );
    return patches;
}

function normalPatches(
    state: WorkspaceState,
    envelope: CommandEnvelope,
): { label: string; patches: FieldPatch[]; subjectIds: string[] } {
    const command = envelope.command;

    if (command.type === "workspace.rename") {
        const name = command.name.trim();
        if (!name) throw new DomainError("NAME_REQUIRED", "Workspace name is required");
        return {
            label: `Renamed workspace to ${name}`,
            patches: [patch("workspace", state.workspace.id, "name", state.workspace.name, name)],
            subjectIds: [state.workspace.id],
        };
    }

    if (command.type === "location.create") {
        validateLocation(state, command.location);
        return {
            label: `Created ${command.location.name}`,
            patches: [patch("location", command.location.id, "", undefined, command.location)],
            subjectIds: [command.location.id],
        };
    }

    if (command.type === "location.update") {
        const location = requireLocation(state, command.id);
        const next = { ...clone(location), ...clone(command.changes), updatedAt: envelope.timestamp };
        next.code = next.code.trim().toUpperCase();
        validateLocation(state, next, location.id);
        const patches = Object.entries(command.changes).map(([path, value]) =>
            patch("location", location.id, path, readPath(location, path), value),
        );
        patches.push(patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp));
        return { label: `Updated ${location.name}`, patches, subjectIds: [location.id] };
    }

    if (command.type === "location.move") {
        const location = requireLocation(state, command.id);
        if (command.parentId === location.id) {
            throw new DomainError("LOCATION_CYCLE", "A location cannot contain itself");
        }
        if (command.parentId) {
            requireLocation(state, command.parentId);
            if (descendantsOf(state, location.id).some((candidate) => candidate.id === command.parentId)) {
                throw new DomainError("LOCATION_CYCLE", "A location cannot move inside its descendant");
            }
        }
        const patches = [
            patch("location", location.id, "parentId", location.parentId, command.parentId),
            patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
        ];
        if (command.order !== undefined) {
            patches.push(patch("location", location.id, "order", location.order, command.order));
        }
        return { label: `Moved ${location.name}`, patches, subjectIds: [location.id] };
    }

    if (command.type === "location.reorder") {
        const location = requireLocation(state, command.id);
        return {
            label: `Reordered ${location.name}`,
            patches: [
                patch("location", location.id, "order", location.order, command.order),
                patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
            ],
            subjectIds: [location.id],
        };
    }

    if (command.type === "location.archive") {
        const location = requireLocation(state, command.id);
        const archivedAt = command.archived ? envelope.timestamp : null;
        return {
            label: `${command.archived ? "Archived" : "Restored"} ${location.name}`,
            patches: [
                patch("location", location.id, "archivedAt", location.archivedAt, archivedAt),
                patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
            ],
            subjectIds: [location.id],
        };
    }

    if (command.type === "location.delete") {
        const location = requireLocation(state, command.id);
        const descendants = descendantsOf(state, location.id);
        const locationIds = [location.id, ...descendants.map((candidate) => candidate.id)];
        const itemIds = state.items
            .filter((item) => locationIds.includes(item.locationId))
            .map((item) => item.id);
        const expectedDescendants = [...command.descendantIds].sort();
        const actualDescendants = descendants.map((candidate) => candidate.id).sort();
        if (!equal(expectedDescendants, actualDescendants) || !equal([...command.itemIds].sort(), itemIds.sort())) {
            throw new DomainError(
                "DELETE_REVIEW_STALE",
                "Contents changed after deletion review; review the subtree again",
            );
        }
        const patches: FieldPatch[] = [];
        for (const itemId of itemIds) {
            const item = requireItem(state, itemId);
            patches.push(patch("item", item.id, "", item, undefined));
        }
        for (const child of [...descendants].reverse()) {
            patches.push(patch("location", child.id, "", child, undefined));
        }
        patches.push(patch("location", location.id, "", location, undefined));
        return {
            label: `Deleted ${location.name} and its reviewed contents`,
            patches,
            subjectIds: [...locationIds, ...itemIds],
        };
    }

    if (command.type === "capture.status") {
        const location = requireLocation(state, command.id);
        if (
            command.status === "known_empty" &&
            state.items.some((item) => item.locationId === location.id && !item.archivedAt)
        ) {
            throw new DomainError("NOT_EMPTY", "A location with recorded items cannot be known empty");
        }
        return {
            label: `Marked ${location.name} ${command.status.replace("_", " ")}`,
            patches: [
                patch("location", location.id, "captureStatus", location.captureStatus, command.status),
                patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
            ],
            subjectIds: [location.id],
        };
    }

    if (command.type === "item.create") {
        validateItem(state, command.item);
        return {
            label: `Recorded ${command.item.quantity} ${command.item.unit} ${command.item.name}`,
            patches: [patch("item", command.item.id, "", undefined, command.item)],
            subjectIds: [command.item.id, command.item.locationId],
        };
    }

    if (command.type === "item.update") {
        const item = requireItem(state, command.id);
        const next = {
            ...clone(item),
            ...clone(command.changes),
            updatedAt: envelope.timestamp,
            version: item.version + 1,
        };
        validateItem(state, next);
        const patches = Object.entries(command.changes).map(([path, value]) =>
            patch("item", item.id, path, readPath(item, path), value),
        );
        patches.push(
            patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
            patch("item", item.id, "version", item.version, item.version + 1),
        );
        return { label: `Updated ${item.name}`, patches, subjectIds: [item.id] };
    }

    if (command.type === "item.reorder") {
        const item = requireItem(state, command.id);
        if (!Number.isFinite(command.order)) {
            throw new DomainError("INVALID_ORDER", "Item order must be a number");
        }
        return {
            label: `Reordered ${item.name}`,
            patches: [
                patch("item", item.id, "order", item.order, command.order),
                patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
                patch("item", item.id, "version", item.version, item.version + 1),
            ],
            subjectIds: [item.id, item.locationId],
        };
    }

    if (command.type === "item.delete") {
        const item = requireItem(state, command.id);
        return {
            label: `Deleted ${item.name}`,
            patches: [patch("item", item.id, "", item, undefined)],
            subjectIds: [item.id, item.locationId],
        };
    }

    if (command.type === "item.move") {
        const item = requireItem(state, command.id);
        return {
            label: `Moved ${command.quantity} ${item.unit} ${item.name}`,
            patches: moveItemPatches(state, item, command.destinationId, command.quantity, envelope),
            subjectIds: [item.id, item.locationId, command.destinationId],
        };
    }

    if (command.type === "item.bulkMove") {
        if (!command.itemIds.length) throw new DomainError("EMPTY_SELECTION", "Select at least one item");
        requireLocation(state, command.destinationId);
        const working = clone(state);
        const patches: FieldPatch[] = [];
        for (const id of [...new Set(command.itemIds)]) {
            const item = requireItem(working, id);
            const itemPatches = moveItemPatches(
                working,
                item,
                command.destinationId,
                item.quantity,
                { ...envelope, id: `${envelope.id}_${id}` },
            );
            applyPatches(working, itemPatches);
            patches.push(...itemPatches);
        }
        return {
            label: `Moved ${command.itemIds.length} item records`,
            patches,
            subjectIds: [...new Set([...command.itemIds, command.destinationId])],
        };
    }

    if (command.type === "plan.create") {
        if (!command.plan.steps.length) throw new DomainError("EMPTY_PLAN", "The plan has no moves");
        return {
            label: `Created plan ${command.plan.name}`,
            patches: [patch("plan", command.plan.id, "", undefined, command.plan)],
            subjectIds: [command.plan.id],
        };
    }

    if (command.type === "plan.status") {
        const plan = requirePlan(state, command.planId);
        return {
            label: `Marked ${plan.name} ${command.status}`,
            patches: [patch("plan", plan.id, "status", plan.status, command.status)],
            subjectIds: [plan.id],
        };
    }

    if (command.type === "plan.step.complete") {
        const plan = requirePlan(state, command.planId);
        const step = plan.steps.find((candidate) => candidate.id === command.stepId);
        if (!step) throw new DomainError("PLAN_STEP_NOT_FOUND", "Plan step was not found");
        if (step.completedAt) throw new DomainError("PLAN_STEP_COMPLETE", "Plan step is already complete");
        const physicalPatches: FieldPatch[] = [];
        if (step.type === "item" && step.itemId) {
            const item = requireItem(state, step.itemId);
            if (item.locationId !== step.sourceId) {
                throw new DomainError("PLAN_STEP_STALE", `${item.name} is no longer at the planned source`);
            }
            physicalPatches.push(
                ...moveItemPatches(
                    state,
                    item,
                    step.destinationId,
                    step.quantity ?? item.quantity,
                    envelope,
                ),
            );
        } else if (step.type === "location" && step.locationId) {
            const location = requireLocation(state, step.locationId);
            if (location.parentId !== step.sourceId) {
                throw new DomainError(
                    "PLAN_STEP_STALE",
                    `${location.name} is no longer at the planned source`,
                );
            }
            if (descendantsOf(state, location.id).some((child) => child.id === step.destinationId)) {
                throw new DomainError("LOCATION_CYCLE", "The planned container move would create a cycle");
            }
            requireLocation(state, step.destinationId);
            physicalPatches.push(
                patch("location", location.id, "parentId", location.parentId, step.destinationId),
                patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
            );
        } else {
            throw new DomainError("INVALID_PLAN_STEP", "Plan step has no movable subject");
        }
        const nextSteps = clone(plan.steps);
        const nextStep = nextSteps.find((candidate) => candidate.id === step.id) as typeof step;
        nextStep.completedAt = envelope.timestamp;
        const nextStatus = nextSteps.every((candidate) => candidate.completedAt)
            ? "completed"
            : plan.status;
        physicalPatches.push(
            patch("plan", plan.id, "steps", plan.steps, nextSteps),
            patch("plan", plan.id, "status", plan.status, nextStatus),
        );
        return {
            label: `Completed plan step: ${step.explanation[0] ?? "move"}`,
            patches: physicalPatches,
            subjectIds: [plan.id, step.itemId ?? step.locationId ?? ""].filter(Boolean),
        };
    }

    throw new DomainError("UNSUPPORTED_COMMAND", `Unsupported command ${(command as Command).type}`);
}

function expectationConflicts(
    state: WorkspaceState,
    expectations: FieldExpectation[],
    commandId: string,
): SyncConflict[] {
    const conflicts: SyncConflict[] = [];
    for (const expectation of expectations) {
        const current = readPatchValue(state, expectation.target, expectation.id, expectation.path);
        if (!equal(current, expectation.value)) {
            conflicts.push({
                commandId,
                current,
                expected: expectation.value,
                field: expectation.path || "(entire record)",
                id: expectation.id,
                message: "This field changed on another device",
                target: expectation.target,
            });
        }
    }
    return conflicts;
}

function historyConflicts(
    state: WorkspaceState,
    activity: ActivityRecord,
    direction: "reapply" | "undo",
    commandId: string,
): SyncConflict[] {
    const conflicts: SyncConflict[] = [];
    for (const fieldPatch of activity.patches) {
        const current = readPatchValue(
            state,
            fieldPatch.target,
            fieldPatch.id,
            fieldPatch.path,
        );
        const expected = direction === "undo" ? fieldPatch.after : fieldPatch.before;
        if (!equal(current, expected)) {
            conflicts.push({
                commandId,
                current,
                expected,
                field: fieldPatch.path || "(entire record)",
                id: fieldPatch.id,
                message: `Cannot ${direction}; the affected value changed later`,
                target: fieldPatch.target,
            });
        }
    }
    return conflicts;
}

function reversePatches(patches: FieldPatch[]): FieldPatch[] {
    return [...patches].reverse().map((fieldPatch) => ({
        ...fieldPatch,
        after: clone(fieldPatch.before),
        before: clone(fieldPatch.after),
    }));
}

function applyHistoryAction(
    state: WorkspaceState,
    envelope: CommandEnvelope,
    type: AuditEvent["type"],
    activities: ActivityRecord[],
): CommandResult {
    const direction = type === "undo" || type === "batch_undo" ? "undo" : "reapply";
    const working = clone(state);
    for (const activity of activities) {
        const expectedStatus = direction === "undo" ? "applied" : "undone";
        if (activity.status !== expectedStatus) {
            throw new DomainError(
                "HISTORY_STATUS",
                `${activity.label} is already ${activity.status}`,
            );
        }
        const conflicts = historyConflicts(working, activity, direction, envelope.id);
        if (conflicts.length) {
            throw new ConflictError(`Cannot ${direction} ${activity.label}`, conflicts);
        }
        const patches = direction === "undo" ? reversePatches(activity.patches) : activity.patches;
        applyPatches(working, patches);
        const stored = working.activities.find((candidate) => candidate.id === activity.id) as ActivityRecord;
        stored.status = direction === "undo" ? "undone" : "applied";
        stored.undoneAt = direction === "undo" ? envelope.timestamp : null;
    }

    const audit: AuditEvent = {
        actorId: envelope.actorId,
        id: `audit_${envelope.id}`,
        label: `${direction === "undo" ? "Undid" : "Reapplied"} ${activities.length} change${activities.length === 1 ? "" : "s"}`,
        targetActivityIds: activities.map((activity) => activity.id),
        timestamp: envelope.timestamp,
        type,
    };
    working.audit.push(audit);
    working.workspace.revision += 1;
    working.workspace.updatedAt = envelope.timestamp;
    return { activity: null, audit, state: working };
}

function applyHistoryCommand(
    state: WorkspaceState,
    envelope: CommandEnvelope,
): CommandResult {
    const command = envelope.command;
    if (command.type === "history.undo" || command.type === "history.reapply") {
        const activity = state.activities.find((candidate) => candidate.id === command.activityId);
        if (!activity) throw new DomainError("ACTIVITY_NOT_FOUND", "Activity was not found");
        return applyHistoryAction(
            state,
            envelope,
            command.type === "history.undo" ? "undo" : "reapply",
            [activity],
        );
    }

    if (command.type === "history.batchUndo") {
        if (!Number.isInteger(command.count) || command.count < 1) {
            throw new DomainError("INVALID_COUNT", "Undo count must be a positive integer");
        }
        const activities = state.activities
            .filter((activity) => activity.status === "applied")
            .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
            .slice(0, command.count);
        if (activities.length !== command.count) {
            throw new DomainError("HISTORY_RANGE", "There are not that many applied changes");
        }
        return applyHistoryAction(state, envelope, "batch_undo", activities);
    }

    if (command.type === "history.batchRedo") {
        if (!Number.isInteger(command.count) || command.count < 1) {
            throw new DomainError("INVALID_COUNT", "Redo count must be a positive integer");
        }
        const activities = state.activities
            .filter((activity) => activity.status === "undone")
            .sort((left, right) => (right.undoneAt ?? "").localeCompare(left.undoneAt ?? ""))
            .slice(0, command.count);
        if (activities.length !== command.count) {
            throw new DomainError("HISTORY_RANGE", "There are not that many undone changes");
        }
        return applyHistoryAction(state, envelope, "batch_redo", activities);
    }

    throw new DomainError("UNSUPPORTED_HISTORY", "Unsupported history command");
}

export function applyCommand(
    current: WorkspaceState,
    envelope: CommandEnvelope,
): CommandResult {
    if (envelope.workspaceId !== current.workspace.id) {
        throw new DomainError("WRONG_WORKSPACE", "Command belongs to another workspace");
    }
    if (envelope.baseRevision > current.workspace.revision) {
        throw new DomainError("REVISION_AHEAD", "Command revision is newer than the server");
    }
    if (envelope.baseRevision < current.workspace.revision) {
        const conflicts = expectationConflicts(current, envelope.expectations, envelope.id);
        if (conflicts.length) {
            throw new ConflictError("The command conflicts with a newer change", conflicts);
        }
    }

    if (envelope.command.type.startsWith("history.")) {
        return applyHistoryCommand(current, envelope);
    }

    const state = clone(current);
    const change = normalPatches(state, envelope);
    applyPatches(state, change.patches);
    const activity: ActivityRecord = {
        actorId: envelope.actorId,
        commandId: envelope.id,
        id: `activity_${envelope.id}`,
        label: change.label,
        patches: change.patches,
        status: "applied",
        subjectIds: [...new Set(change.subjectIds)],
        timestamp: envelope.timestamp,
        undoneAt: null,
    };
    state.activities.push(activity);
    state.workspace.revision += 1;
    state.workspace.updatedAt = envelope.timestamp;
    return { activity, audit: null, state };
}
