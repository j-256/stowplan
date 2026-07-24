import { ConflictError, DomainError } from "./errors";
import { isLegacyCompatibleIssue, validateSnapshot } from "./import";
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

const unsafePathKeys = new Set(["__proto__", "constructor", "prototype"]);
const locationChangeKeys = new Set([
    "code",
    "conditions",
    "description",
    "dimensions",
    "kind",
    "name",
    "order",
    "parentId",
    "tags",
]);
const itemChangeKeys = new Set([
    "category",
    "constraints",
    "dimensions",
    "frequency",
    "name",
    "notes",
    "quantity",
    "tags",
    "unit",
]);
const locationKinds = new Set([
    "area",
    "bin",
    "box",
    "cabinet",
    "container",
    "drawer",
    "room",
    "shelf",
    "zone",
]);
const captureStatuses = new Set(["counted", "in_progress", "known_empty", "uncounted"]);
const completeCaptureStatuses = new Set(["counted", "known_empty"]);
const frequencies = new Set(["daily", "weekly", "monthly", "rarely"]);
const planStatuses = new Set(["active", "completed", "discarded"]);
const CAPTURE_COMPLETE_ERROR = "CAPTURE_COMPLETE";
const NO_CHANGES_ERROR = "NO_CHANGES";
const captureContentActions = Object.freeze({
    addItem: "adding an item",
    addLocation: "adding a nested space",
    archiveLocation: "archiving a nested space",
    deleteItem: "deleting an item",
    deleteLocation: "deleting a nested space",
    moveItemIn: "moving an item into it",
    moveItemOut: "moving an item out of it",
    moveLocationIn: "moving a nested space into it",
    moveLocationOut: "moving a nested space out of it",
    reorderItems: "reordering its items",
    reorderLocations: "reordering its nested spaces",
    restoreLocation: "restoring a nested space",
    updateItem: "editing an item",
});

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pathKeys(path: string): string[] {
    const keys = path.split(".");
    if (
        !path ||
        keys.some((key) => !key || unsafePathKeys.has(key))
    ) {
        throw new DomainError("INVALID_PATCH", "A field patch contains an unsafe path");
    }
    return keys;
}

function assertAllowedChanges(
    changes: unknown,
    allowed: Set<string>,
    entity: "item" | "location",
): asserts changes is Record<string, unknown> {
    if (!isRecord(changes)) {
        throw new DomainError("INVALID_CHANGES", `${entity} changes must be an object`);
    }
    const unknown = Object.keys(changes).find(
        (key) => !allowed.has(key) || key.includes(".") || unsafePathKeys.has(key),
    );
    if (unknown) {
        throw new DomainError(
            "INVALID_CHANGES",
            `${unknown} cannot be changed through ${entity}.update`,
        );
    }
}

function validDimensions(value: unknown): boolean {
    return value === null ||
        (isRecord(value) &&
            ["depth", "height", "width"].every(
                (key) => Number.isFinite(value[key]) && Number(value[key]) > 0,
            ) &&
            (value.unit === "cm" || value.unit === "in"));
}

function validConditions(value: unknown): boolean {
    return isRecord(value) &&
        ["dark", "dry", "foodSafe"].every((key) => typeof value[key] === "boolean") &&
        ["dry", "normal", "humid"].includes(String(value.humidity)) &&
        ["cold", "cool", "normal", "warm"].includes(String(value.temperature));
}

function validConstraints(value: unknown): boolean {
    return isRecord(value) &&
        ["avoidHumidity", "avoidWarmth", "foodOnly"].every(
            (key) => typeof value[key] === "boolean",
        ) &&
        (value.keepTogether === null || typeof value.keepTogether === "string") &&
        Array.isArray(value.requiredTags) &&
        value.requiredTags.every((tag) => typeof tag === "string");
}

function validateEnvelopeRuntime(envelope: CommandEnvelope): void {
    if (
        !isRecord(envelope) ||
        typeof envelope.id !== "string" ||
        !envelope.id.trim() ||
        typeof envelope.workspaceId !== "string" ||
        !envelope.workspaceId.trim() ||
        typeof envelope.actorId !== "string" ||
        !envelope.actorId.trim() ||
        typeof envelope.deviceId !== "string" ||
        !envelope.deviceId.trim() ||
        typeof envelope.timestamp !== "string" ||
        !Number.isFinite(Date.parse(envelope.timestamp)) ||
        !Number.isSafeInteger(envelope.baseRevision) ||
        envelope.baseRevision < 0 ||
        !isRecord(envelope.command) ||
        typeof envelope.command.type !== "string" ||
        !envelope.command.type.trim() ||
        !Array.isArray(envelope.expectations)
    ) {
        throw new DomainError("INVALID_COMMAND", "Command envelope is malformed");
    }
    for (const expectation of envelope.expectations) {
        if (
            !isRecord(expectation) ||
            !["item", "location", "plan", "workspace"].includes(
                String(expectation.target),
            ) ||
            typeof expectation.id !== "string" ||
            !expectation.id.trim() ||
            typeof expectation.path !== "string" ||
            !Object.hasOwn(expectation, "value")
        ) {
            throw new DomainError("INVALID_EXPECTATION", "Field expectation is malformed");
        }
        if (expectation.path) pathKeys(expectation.path);
    }
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
    return pathKeys(path).reduce<unknown>((value, key) => {
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
    const keys = pathKeys(path);
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

function requireActiveLocation(state: WorkspaceState, id: string): Location {
    const location = requireLocation(state, id);
    if (location.archivedAt) {
        throw new DomainError("LOCATION_ARCHIVED", `${location.name} is archived`);
    }
    return location;
}

function assertCaptureContentsEditable(
    state: WorkspaceState,
    changes: Array<{ action: string; locationId: string | null }>,
): void {
    const checked = new Set<string>();
    for (const change of changes) {
        if (!change.locationId || checked.has(change.locationId)) continue;
        checked.add(change.locationId);
        const location = requireLocation(state, change.locationId);
        if (
            !location.archivedAt &&
            completeCaptureStatuses.has(location.captureStatus)
        ) {
            throw new DomainError(
                CAPTURE_COMPLETE_ERROR,
                `Reopen ${location.name} before ${change.action}`,
            );
        }
    }
}

function requireItem(state: WorkspaceState, id: string): ItemRecord {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) throw new DomainError("ITEM_NOT_FOUND", `Item ${id} was not found`);
    return item;
}

function requireActiveItem(state: WorkspaceState, id: string): ItemRecord {
    const item = requireItem(state, id);
    if (item.archivedAt) {
        throw new DomainError("ITEM_ARCHIVED", `${item.name} is archived`);
    }
    return item;
}

function nextItemVersion(item: ItemRecord): number {
    if (!Number.isSafeInteger(item.version) || item.version >= Number.MAX_SAFE_INTEGER) {
        throw new DomainError(
            "ITEM_VERSION_EXHAUSTED",
            `${item.name} has an invalid or exhausted version counter`,
        );
    }
    return item.version + 1;
}

function requirePlan(state: WorkspaceState, id: string): MovePlan {
    const plan = state.plans.find((candidate) => candidate.id === id);
    if (!plan) throw new DomainError("PLAN_NOT_FOUND", `Plan ${id} was not found`);
    return plan;
}

function assertPlanCanActivate(state: WorkspaceState, plan: MovePlan): void {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        throw new DomainError("EMPTY_PLAN", "An active plan needs at least one move");
    }
    if (plan.steps.every((step) => step.completedAt)) {
        throw new DomainError("PLAN_COMPLETE", "A fully completed plan cannot be made active again");
    }
    for (const step of plan.steps.filter((candidate) => !candidate.completedAt)) {
        const source = requireActiveLocation(state, step.sourceId);
        const destination = requireActiveLocation(state, step.destinationId);
        if (source.id === destination.id) {
            throw new DomainError("PLAN_STEP_STALE", "A plan move needs a different destination");
        }
        if (step.type === "item" && step.itemId) {
            const item = requireItem(state, step.itemId);
            if (
                item.archivedAt ||
                item.locationId !== step.sourceId ||
                step.locationId !== null ||
                step.quantity !== item.quantity
            ) {
                throw new DomainError(
                    "PLAN_STEP_STALE",
                    `${item.name} no longer matches the planned move`,
                );
            }
        } else if (step.type === "location" && step.locationId) {
            const location = requireActiveLocation(state, step.locationId);
            if (
                step.itemId !== null ||
                step.quantity !== null ||
                location.parentId !== step.sourceId ||
                location.id === step.destinationId ||
                descendantsOf(state, location.id).some(
                    (candidate) => candidate.id === step.destinationId,
                )
            ) {
                throw new DomainError(
                    "PLAN_STEP_STALE",
                    `${location.name} no longer matches the planned move`,
                );
            }
        } else {
            throw new DomainError("INVALID_PLAN_STEP", "Plan step has no movable subject");
        }
    }
}

function descendantsOf(state: WorkspaceState, id: string): Location[] {
    const descendants: Location[] = [];
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
        const parentId = queue.shift() as string;
        for (const location of state.locations.filter((candidate) => candidate.parentId === parentId)) {
            if (seen.has(location.id)) continue;
            seen.add(location.id);
            descendants.push(location);
            queue.push(location.id);
        }
    }
    return descendants;
}

function validateLocation(state: WorkspaceState, location: Location, ignoreId?: string): void {
    if (!isRecord(location)) {
        throw new DomainError("INVALID_LOCATION", "Location must be an object");
    }
    if (typeof location.id !== "string" || !location.id.trim()) {
        throw new DomainError("INVALID_LOCATION", "Location ID is required");
    }
    if (!ignoreId && state.locations.some((candidate) => candidate.id === location.id)) {
        throw new DomainError("LOCATION_EXISTS", "A location with this ID already exists");
    }
    if (typeof location.name !== "string" || !location.name.trim()) {
        throw new DomainError("NAME_REQUIRED", "Location name is required");
    }
    if (typeof location.code !== "string" || !location.code.trim()) {
        throw new DomainError("CODE_REQUIRED", "Location code is required");
    }
    if (!Number.isFinite(location.order)) {
        throw new DomainError("INVALID_ORDER", "Location order must be a number");
    }
    if (!locationKinds.has(String(location.kind))) {
        throw new DomainError("INVALID_LOCATION", "Location type is invalid");
    }
    if (!captureStatuses.has(String(location.captureStatus))) {
        throw new DomainError("INVALID_LOCATION", "Capture status is invalid");
    }
    if (
        typeof location.description !== "string" ||
        !Array.isArray(location.tags) ||
        location.tags.some((tag) => typeof tag !== "string") ||
        !validDimensions(location.dimensions) ||
        !validConditions(location.conditions) ||
        (location.archivedAt !== null && typeof location.archivedAt !== "string") ||
        typeof location.createdAt !== "string" ||
        typeof location.updatedAt !== "string"
    ) {
        throw new DomainError("INVALID_LOCATION", "Location fields are malformed");
    }
    if (
        location.parentId !== null &&
        (typeof location.parentId !== "string" || !location.parentId.trim())
    ) {
        throw new DomainError("INVALID_PARENT", "A location parent must be a location ID or null");
    }
    if (location.parentId === location.id) {
        throw new DomainError("LOCATION_CYCLE", "A location cannot contain itself");
    }
    if (
        ignoreId &&
        location.parentId &&
        descendantsOf(state, ignoreId).some((candidate) => candidate.id === location.parentId)
    ) {
        throw new DomainError("LOCATION_CYCLE", "A location cannot move inside its descendant");
    }
    if (
        state.locations.some(
            (candidate) =>
                candidate.id !== ignoreId &&
                !candidate.archivedAt &&
                candidate.code.trim().toLocaleUpperCase() ===
                    location.code.trim().toLocaleUpperCase(),
        )
    ) {
        throw new DomainError("CODE_IN_USE", `Location code ${location.code} is already in use`);
    }
    if (location.parentId) {
        const parent = requireLocation(state, location.parentId);
        if (!location.archivedAt && parent.archivedAt) {
            throw new DomainError(
                "PARENT_ARCHIVED",
                `Restore ${parent.name} before placing an active space inside it`,
            );
        }
    }
}

function captureProgressPatches(
    state: WorkspaceState,
    locationId: string,
    timestamp: string,
): FieldPatch[] {
    const location = requireActiveLocation(state, locationId);
    if (location.captureStatus !== "uncounted" && location.captureStatus !== "known_empty") {
        return [];
    }
    return [
        patch("location", location.id, "captureStatus", location.captureStatus, "in_progress"),
        patch("location", location.id, "updatedAt", location.updatedAt, timestamp),
    ];
}

function planCaptureProgressPatches(
    state: WorkspaceState,
    sourceId: string,
    destinationId: string,
    timestamp: string,
): FieldPatch[] {
    return [...new Set([sourceId, destinationId])].flatMap((locationId) => {
        const location = requireActiveLocation(state, locationId);
        const shouldProgress =
            completeCaptureStatuses.has(location.captureStatus) ||
            (
                locationId === destinationId &&
                location.captureStatus === "uncounted"
            );
        if (!shouldProgress) return [];
        return [
            patch(
                "location",
                location.id,
                "captureStatus",
                location.captureStatus,
                "in_progress",
            ),
            patch(
                "location",
                location.id,
                "updatedAt",
                location.updatedAt,
                timestamp,
            ),
        ];
    });
}

function planInvalidationPatches(
    state: WorkspaceState,
    itemIds: string[] = [],
    locationIds: string[] = [],
): FieldPatch[] {
    const affectedItems = new Set(itemIds);
    const affectedLocations = new Set<string>();
    for (const locationId of locationIds) {
        let current = state.locations.find((location) => location.id === locationId);
        const seen = new Set<string>();
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            affectedLocations.add(current.id);
            current = current.parentId
                ? state.locations.find((location) => location.id === current?.parentId)
                : undefined;
        }
    }
    return state.plans
        .filter(
            (plan) =>
                plan.status === "active" &&
                plan.steps.some(
                    (step) =>
                        !step.completedAt &&
                        ((step.itemId && affectedItems.has(step.itemId)) ||
                            (step.locationId && affectedLocations.has(step.locationId)) ||
                            affectedLocations.has(step.sourceId) ||
                            affectedLocations.has(step.destinationId)),
                ),
        )
        .map((plan) => patch("plan", plan.id, "status", plan.status, "discarded"));
}

function validateItem(state: WorkspaceState, item: ItemRecord): void {
    if (!isRecord(item)) throw new DomainError("INVALID_ITEM", "Item must be an object");
    if (typeof item.id !== "string" || !item.id.trim()) {
        throw new DomainError("INVALID_ITEM", "Item ID is required");
    }
    if (typeof item.locationId !== "string" || !item.locationId.trim()) {
        throw new DomainError("INVALID_LOCATION", "Item location is required");
    }
    if (typeof item.name !== "string" || !item.name.trim()) {
        throw new DomainError("NAME_REQUIRED", "Item name is required");
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        throw new DomainError("INVALID_QUANTITY", "Quantity must be greater than zero");
    }
    if (typeof item.unit !== "string" || !item.unit.trim()) {
        throw new DomainError("UNIT_REQUIRED", "Unit is required");
    }
    if (!Number.isFinite(item.order)) throw new DomainError("INVALID_ORDER", "Item order must be a number");
    if (
        typeof item.category !== "string" ||
        typeof item.notes !== "string" ||
        !Array.isArray(item.tags) ||
        item.tags.some((tag) => typeof tag !== "string") ||
        !frequencies.has(String(item.frequency)) ||
        !validDimensions(item.dimensions) ||
        !validConstraints(item.constraints) ||
        !Number.isSafeInteger(item.version) ||
        item.version < 1 ||
        (item.archivedAt !== null && typeof item.archivedAt !== "string") ||
        typeof item.createdAt !== "string" ||
        typeof item.updatedAt !== "string"
    ) {
        throw new DomainError("INVALID_ITEM", "Item fields are malformed");
    }
    if (!item.archivedAt) requireActiveLocation(state, item.locationId);
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
    requireActiveLocation(state, destinationId);
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
        const mergedQuantity = matching.quantity + quantity;
        if (!Number.isFinite(mergedQuantity)) {
            throw new DomainError(
                "QUANTITY_OVERFLOW",
                `Moving ${item.name} would exceed the supported quantity range`,
            );
        }
        patches.push(
            patch("item", matching.id, "quantity", matching.quantity, mergedQuantity),
            patch("item", matching.id, "updatedAt", matching.updatedAt, envelope.timestamp),
            patch("item", matching.id, "version", matching.version, nextItemVersion(matching)),
        );
        if (remaining === 0) patches.push(patch("item", item.id, "", item, undefined));
        else {
            patches.push(
                patch("item", item.id, "quantity", item.quantity, remaining),
                patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
                patch("item", item.id, "version", item.version, nextItemVersion(item)),
            );
        }
        return patches;
    }

    if (remaining === 0) {
        patches.push(
            patch("item", item.id, "locationId", item.locationId, destinationId),
            patch("item", item.id, "order", item.order, destinationOrder),
            patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
            patch("item", item.id, "version", item.version, nextItemVersion(item)),
        );
        return patches;
    }

    const splitId = `item_split_${envelope.id}`;
    if (state.items.some((candidate) => candidate.id === splitId)) {
        throw new DomainError(
            "ITEM_EXISTS",
            "The partial move would reuse an existing item record ID",
        );
    }
    const split: ItemRecord = {
        ...clone(item),
        createdAt: envelope.timestamp,
        id: splitId,
        locationId: destinationId,
        order: destinationOrder,
        quantity,
        updatedAt: envelope.timestamp,
        version: 1,
    };
    patches.push(
        patch("item", item.id, "quantity", item.quantity, remaining),
        patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
        patch("item", item.id, "version", item.version, nextItemVersion(item)),
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
        if (typeof command.name !== "string") {
            throw new DomainError("NAME_REQUIRED", "Workspace name is required");
        }
        const name = command.name.trim();
        if (!name) throw new DomainError("NAME_REQUIRED", "Workspace name is required");
        if (name === state.workspace.name) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `Workspace is already named ${name}`,
            );
        }
        return {
            label: `Renamed workspace to ${name}`,
            patches: [patch("workspace", state.workspace.id, "name", state.workspace.name, name)],
            subjectIds: [state.workspace.id],
        };
    }

    if (command.type === "location.create") {
        validateLocation(state, command.location);
        if (!command.location.archivedAt && command.location.parentId) {
            assertCaptureContentsEditable(state, [{
                action: captureContentActions.addLocation,
                locationId: command.location.parentId,
            }]);
        }
        return {
            label: `Created ${command.location.name}`,
            patches: [
                ...(command.location.parentId
                    ? planInvalidationPatches(state, [], [command.location.parentId])
                    : []),
                patch("location", command.location.id, "", undefined, command.location),
                ...(command.location.parentId
                    ? captureProgressPatches(
                          state,
                          command.location.parentId,
                          envelope.timestamp,
                      )
                    : []),
            ],
            subjectIds: [command.location.id],
        };
    }

    if (command.type === "location.update") {
        const location = requireActiveLocation(state, command.id);
        assertAllowedChanges(command.changes, locationChangeKeys, "location");
        const changesParent =
            "parentId" in command.changes &&
            command.changes.parentId !== location.parentId;
        if (
            "archivedAt" in command.changes ||
            "captureStatus" in command.changes ||
            ("order" in command.changes && !changesParent) ||
            "updatedAt" in command.changes
        ) {
            throw new DomainError(
                "STRUCTURAL_LOCATION_UPDATE",
                "Use the dedicated archive or capture-status action for this change",
            );
        }
        const next = { ...clone(location), ...clone(command.changes), updatedAt: envelope.timestamp };
        if (typeof next.code !== "string" || typeof next.name !== "string") {
            throw new DomainError(
                "INVALID_LOCATION",
                "Location name and code must be strings",
            );
        }
        next.code = next.code.trim().toUpperCase();
        next.name = next.name.trim();
        validateLocation(state, next, location.id);
        const normalizedChanges = {
            ...command.changes,
            ...("code" in command.changes ? { code: next.code } : {}),
            ...("name" in command.changes ? { name: next.name } : {}),
        };
        const changedEntries = Object.entries(normalizedChanges).filter(
            ([path, value]) => !equal(readPath(location, path), value),
        );
        if (!changedEntries.length) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `No changes to save for ${location.name}`,
            );
        }
        if (next.parentId !== location.parentId) {
            assertCaptureContentsEditable(state, [
                {
                    action: captureContentActions.moveLocationOut,
                    locationId: location.parentId,
                },
                {
                    action: captureContentActions.moveLocationIn,
                    locationId: next.parentId,
                },
            ]);
        }
        const patches = changedEntries.map(([path, value]) =>
            patch("location", location.id, path, readPath(location, path), value),
        );
        patches.push(patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp));
        if (
            ["conditions", "dimensions", "kind", "parentId", "tags"].some(
                (field) => changedEntries.some(([path]) => path === field),
            )
        ) {
            patches.push(
                ...planInvalidationPatches(
                    state,
                    [],
                    [location.id, next.parentId].filter(
                        (id): id is string => id !== null,
                    ),
                ),
            );
        }
        if (next.parentId !== location.parentId) {
            if (next.parentId) {
                patches.push(...captureProgressPatches(state, next.parentId, envelope.timestamp));
            }
        }
        return { label: `Updated ${location.name}`, patches, subjectIds: [location.id] };
    }

    if (command.type === "location.move") {
        const location = requireActiveLocation(state, command.id);
        if (
            command.parentId !== null &&
            (typeof command.parentId !== "string" || !command.parentId.trim())
        ) {
            throw new DomainError(
                "INVALID_PARENT",
                "A moved location needs a parent ID or top-level placement",
            );
        }
        if (command.order !== undefined && !Number.isFinite(command.order)) {
            throw new DomainError("INVALID_ORDER", "Location order must be a number");
        }
        if (command.parentId === location.id) {
            throw new DomainError("LOCATION_CYCLE", "A location cannot contain itself");
        }
        if (command.parentId) {
            requireActiveLocation(state, command.parentId);
            if (descendantsOf(state, location.id).some((candidate) => candidate.id === command.parentId)) {
                throw new DomainError("LOCATION_CYCLE", "A location cannot move inside its descendant");
            }
        }
        const nextOrder = command.order ?? location.order;
        const changesParent = command.parentId !== location.parentId;
        const changesOrder = nextOrder !== location.order;
        if (!changesParent && !changesOrder) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `${location.name} is already in that position`,
            );
        }
        assertCaptureContentsEditable(
            state,
            changesParent
                ? [
                      {
                          action: captureContentActions.moveLocationOut,
                          locationId: location.parentId,
                      },
                      {
                          action: captureContentActions.moveLocationIn,
                          locationId: command.parentId,
                      },
                  ]
                : [{
                      action: captureContentActions.reorderLocations,
                      locationId: location.parentId,
                  }],
        );
        const patches = [
            patch("location", location.id, "parentId", location.parentId, command.parentId),
            patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
            ...planInvalidationPatches(
                state,
                [],
                [location.id, command.parentId].filter(
                    (id): id is string => id !== null,
                ),
            ),
        ];
        if (command.order !== undefined) {
            patches.push(patch("location", location.id, "order", location.order, command.order));
        }
        if (command.parentId) {
            patches.push(...captureProgressPatches(state, command.parentId, envelope.timestamp));
        }
        return { label: `Moved ${location.name}`, patches, subjectIds: [location.id] };
    }

    if (command.type === "location.reorder") {
        const location = requireActiveLocation(state, command.id);
        if (!Number.isFinite(command.order)) {
            throw new DomainError("INVALID_ORDER", "Location order must be a number");
        }
        if (command.order === location.order) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `${location.name} is already in that position`,
            );
        }
        assertCaptureContentsEditable(state, [{
            action: captureContentActions.reorderLocations,
            locationId: location.parentId,
        }]);
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
        if (typeof command.archived !== "boolean") {
            throw new DomainError("INVALID_ARCHIVE", "Archive state must be true or false");
        }
        if (Boolean(location.archivedAt) === command.archived) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `${location.name} is already ${command.archived ? "archived" : "available"}`,
            );
        }
        const archivedAt = command.archived ? envelope.timestamp : null;
        if (command.archived) {
            const liveDescendants = descendantsOf(state, location.id).filter(
                (candidate) => !candidate.archivedAt,
            );
            if (liveDescendants.length) {
                throw new DomainError(
                    "ARCHIVE_HAS_DESCENDANTS",
                    `${location.name} has live nested spaces; move or archive them first`,
                );
            }
            if (
                state.items.some(
                    (item) => item.locationId === location.id && !item.archivedAt,
                )
            ) {
                throw new DomainError(
                    "ARCHIVE_HAS_CONTENTS",
                    `${location.name} has item contents; move or delete them first`,
                );
            }
        } else {
            validateLocation(state, { ...location, archivedAt: null }, location.id);
        }
        if (
            location.parentId &&
            Boolean(location.archivedAt) !== command.archived
        ) {
            assertCaptureContentsEditable(state, [{
                action: command.archived
                    ? captureContentActions.archiveLocation
                    : captureContentActions.restoreLocation,
                locationId: location.parentId,
            }]);
        }
        return {
            label: `${command.archived ? "Archived" : "Restored"} ${location.name}`,
            patches: [
                patch("location", location.id, "archivedAt", location.archivedAt, archivedAt),
                patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
                ...planInvalidationPatches(
                    state,
                    [],
                    [location.id, location.parentId].filter(
                        (id): id is string => id !== null,
                    ),
                ),
                ...(!command.archived && location.parentId
                    ? captureProgressPatches(
                          state,
                          location.parentId,
                          envelope.timestamp,
                      )
                    : []),
            ],
            subjectIds: [location.id],
        };
    }

    if (command.type === "location.delete") {
        const location = requireLocation(state, command.id);
        if (!Array.isArray(command.descendantIds) || !Array.isArray(command.itemIds)) {
            throw new DomainError("DELETE_REVIEW_STALE", "Deletion review is malformed");
        }
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
        assertCaptureContentsEditable(state, [
            ...[location, ...descendants]
                .filter((candidate) => !candidate.archivedAt && candidate.parentId)
                .map((candidate) => ({
                    action: captureContentActions.deleteLocation,
                    locationId: candidate.parentId,
                })),
            ...itemIds
                .map((itemId) => requireItem(state, itemId))
                .filter((item) => !item.archivedAt)
                .map((item) => ({
                    action: captureContentActions.deleteItem,
                    locationId: item.locationId,
                })),
        ]);
        const patches: FieldPatch[] = [];
        patches.push(...planInvalidationPatches(state, itemIds, locationIds));
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

    if (command.type === "capture.empty") {
        const location = requireActiveLocation(state, command.id);
        if (!Array.isArray(command.itemIds) || command.itemIds.length === 0) {
            throw new DomainError(
                "EMPTY_REVIEW_STALE",
                "Choose an occupied container before emptying it",
            );
        }
        if (
            state.locations.some(
                (candidate) =>
                    candidate.parentId === location.id && !candidate.archivedAt,
            )
        ) {
            throw new DomainError(
                "NOT_EMPTY",
                "Move or remove nested spaces before marking this container known empty",
            );
        }
        const directItems = state.items.filter(
            (item) => item.locationId === location.id && !item.archivedAt,
        );
        const reviewedIds = [...command.itemIds].sort();
        const directIds = directItems.map((item) => item.id).sort();
        if (!equal(reviewedIds, directIds)) {
            throw new DomainError(
                "EMPTY_REVIEW_STALE",
                "Contents changed after confirmation; review the container again",
            );
        }
        return {
            label: `Emptied ${location.name} and marked it known empty`,
            patches: [
                ...planInvalidationPatches(state, directIds, [location.id]),
                ...directItems.map((item) =>
                    patch("item", item.id, "", item, undefined)
                ),
                patch(
                    "location",
                    location.id,
                    "captureStatus",
                    location.captureStatus,
                    "known_empty",
                ),
                patch(
                    "location",
                    location.id,
                    "updatedAt",
                    location.updatedAt,
                    envelope.timestamp,
                ),
            ],
            subjectIds: [location.id, ...directIds],
        };
    }

    if (command.type === "capture.status") {
        const location = requireActiveLocation(state, command.id);
        if (!captureStatuses.has(String(command.status))) {
            throw new DomainError("INVALID_CAPTURE_STATUS", "Capture status is invalid");
        }
        if (location.captureStatus === command.status) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `${location.name} is already marked ${command.status.replace("_", " ")}`,
            );
        }
        if (
            command.status === "known_empty" &&
            state.items.some((item) => item.locationId === location.id && !item.archivedAt)
        ) {
            throw new DomainError("NOT_EMPTY", "A location with recorded items cannot be known empty");
        }
        if (
            command.status === "known_empty" &&
            state.locations.some(
                (candidate) =>
                    candidate.parentId === location.id && !candidate.archivedAt,
            )
        ) {
            throw new DomainError(
                "NOT_EMPTY",
                "A location with a live nested space cannot be known empty",
            );
        }
        return {
            label: `Marked ${location.name} ${command.status.replace("_", " ")}`,
            patches: [
                ...planInvalidationPatches(state, [], [location.id]),
                patch("location", location.id, "captureStatus", location.captureStatus, command.status),
                patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
            ],
            subjectIds: [location.id],
        };
    }

    if (command.type === "item.create") {
        validateItem(state, command.item);
        if (state.items.some((item) => item.id === command.item.id)) {
            throw new DomainError("ITEM_EXISTS", "An item with this ID already exists");
        }
        if (!command.item.archivedAt) {
            assertCaptureContentsEditable(state, [{
                action: captureContentActions.addItem,
                locationId: command.item.locationId,
            }]);
        }
        return {
            label: `Recorded ${command.item.quantity} ${command.item.unit} ${command.item.name}`,
            patches: [
                ...planInvalidationPatches(state, [], [command.item.locationId]),
                patch("item", command.item.id, "", undefined, command.item),
                ...captureProgressPatches(
                    state,
                    command.item.locationId,
                    envelope.timestamp,
                ),
            ],
            subjectIds: [command.item.id, command.item.locationId],
        };
    }

    if (command.type === "item.update") {
        const item = requireItem(state, command.id);
        assertAllowedChanges(command.changes, itemChangeKeys, "item");
        if (
            "locationId" in command.changes ||
            "archivedAt" in command.changes ||
            "order" in command.changes ||
            "updatedAt" in command.changes ||
            "version" in command.changes
        ) {
            throw new DomainError(
                "STRUCTURAL_ITEM_UPDATE",
                "Use the dedicated move, reorder, or archive action for this change",
            );
        }
        const next = {
            ...clone(item),
            ...clone(command.changes),
            updatedAt: envelope.timestamp,
            version: nextItemVersion(item),
        };
        if (typeof next.name !== "string" || typeof next.unit !== "string") {
            throw new DomainError(
                "INVALID_ITEM",
                "Item name and unit must be strings",
            );
        }
        next.name = next.name.trim();
        next.unit = next.unit.trim();
        validateItem(state, next);
        const normalizedChanges = {
            ...command.changes,
            ...("name" in command.changes ? { name: next.name } : {}),
            ...("unit" in command.changes ? { unit: next.unit } : {}),
        };
        const changedEntries = Object.entries(normalizedChanges).filter(
            ([path, value]) => !equal(readPath(item, path), value),
        );
        if (!changedEntries.length) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `No changes to save for ${item.name}`,
            );
        }
        if (!item.archivedAt) {
            assertCaptureContentsEditable(state, [{
                action: captureContentActions.updateItem,
                locationId: item.locationId,
            }]);
        }
        const patches = changedEntries.map(([path, value]) =>
            patch("item", item.id, path, readPath(item, path), value),
        );
        if (
            ["category", "constraints", "dimensions", "frequency", "quantity", "tags", "unit"].some(
                (field) => changedEntries.some(([path]) => path === field),
            )
        ) {
            patches.unshift(
                ...planInvalidationPatches(state, [item.id], [item.locationId]),
            );
        }
        patches.push(
            patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
            patch("item", item.id, "version", item.version, nextItemVersion(item)),
        );
        return { label: `Updated ${item.name}`, patches, subjectIds: [item.id] };
    }

    if (command.type === "item.reorder") {
        const item = requireItem(state, command.id);
        if (!Number.isFinite(command.order)) {
            throw new DomainError("INVALID_ORDER", "Item order must be a number");
        }
        if (command.order === item.order) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `${item.name} is already in that position`,
            );
        }
        if (!item.archivedAt) {
            assertCaptureContentsEditable(state, [{
                action: captureContentActions.reorderItems,
                locationId: item.locationId,
            }]);
        }
        return {
            label: `Reordered ${item.name}`,
            patches: [
                patch("item", item.id, "order", item.order, command.order),
                patch("item", item.id, "updatedAt", item.updatedAt, envelope.timestamp),
                patch("item", item.id, "version", item.version, nextItemVersion(item)),
            ],
            subjectIds: [item.id, item.locationId],
        };
    }

    if (command.type === "item.delete") {
        const item = requireItem(state, command.id);
        if (!item.archivedAt) {
            assertCaptureContentsEditable(state, [{
                action: captureContentActions.deleteItem,
                locationId: item.locationId,
            }]);
        }
        return {
            label: `Deleted ${item.name}`,
            patches: [
                ...planInvalidationPatches(state, [item.id], [item.locationId]),
                patch("item", item.id, "", item, undefined),
            ],
            subjectIds: [item.id, item.locationId],
        };
    }

    if (command.type === "item.move") {
        const item = requireActiveItem(state, command.id);
        const patches = moveItemPatches(
            state,
            item,
            command.destinationId,
            command.quantity,
            envelope,
        );
        assertCaptureContentsEditable(state, [
            {
                action: captureContentActions.moveItemOut,
                locationId: item.locationId,
            },
            {
                action: captureContentActions.moveItemIn,
                locationId: command.destinationId,
            },
        ]);
        return {
            label: `Moved ${command.quantity} ${item.unit} ${item.name}`,
            patches: [
                ...planInvalidationPatches(
                    state,
                    [item.id],
                    [item.locationId, command.destinationId],
                ),
                ...patches,
                ...captureProgressPatches(
                    state,
                    command.destinationId,
                    envelope.timestamp,
                ),
            ],
            subjectIds: [item.id, item.locationId, command.destinationId],
        };
    }

    if (command.type === "item.bulkMove") {
        if (!Array.isArray(command.itemIds) || !command.itemIds.length) {
            throw new DomainError("EMPTY_SELECTION", "Select at least one item");
        }
        requireActiveLocation(state, command.destinationId);
        const working = clone(state);
        const patches: FieldPatch[] = [];
        const itemIds = [...new Set(command.itemIds)];
        const movableIds = itemIds.filter(
            (id) => requireActiveItem(working, id).locationId !== command.destinationId,
        );
        if (!movableIds.length) {
            throw new DomainError("ALREADY_THERE", "Selected items are already in that location");
        }
        for (const id of movableIds) {
            const item = requireActiveItem(working, id);
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
        assertCaptureContentsEditable(state, [
            ...movableIds.map((id) => ({
                action: captureContentActions.moveItemOut,
                locationId: requireItem(state, id).locationId,
            })),
            {
                action: captureContentActions.moveItemIn,
                locationId: command.destinationId,
            },
        ]);
        return {
            label: movableIds.length === itemIds.length
                ? `Moved ${movableIds.length} item record${movableIds.length === 1 ? "" : "s"}`
                : `Moved ${movableIds.length} of ${itemIds.length} item records`,
            patches: [
                ...planInvalidationPatches(
                    state,
                    movableIds,
                    [
                        ...new Set(
                            movableIds.flatMap((id) => [
                                requireItem(state, id).locationId,
                                command.destinationId,
                            ]),
                        ),
                    ],
                ),
                ...patches,
                ...captureProgressPatches(
                    state,
                    command.destinationId,
                    envelope.timestamp,
                ),
            ],
            subjectIds: [...new Set([...movableIds, command.destinationId])],
        };
    }

    if (command.type === "plan.create") {
        if (
            !isRecord(command.plan) ||
            typeof command.plan.id !== "string" ||
            !command.plan.id.trim() ||
            typeof command.plan.name !== "string" ||
            !command.plan.name.trim() ||
            typeof command.plan.createdAt !== "string" ||
            !isRecord(command.plan.weights) ||
            ["accessibility", "capacity", "grouping", "moveCost", "suitability"].some(
                (key) =>
                    !Number.isFinite(
                        (command.plan.weights as unknown as Record<string, unknown>)[key],
                    ),
            ) ||
            !Array.isArray(command.plan.steps)
        ) {
            throw new DomainError("INVALID_PLAN", "The new plan is malformed");
        }
        if (!command.plan.steps.length) throw new DomainError("EMPTY_PLAN", "The plan has no moves");
        if (command.plan.status !== "active") {
            throw new DomainError("INVALID_PLAN", "A new plan must start active");
        }
        if (state.plans.some((plan) => plan.id === command.plan.id)) {
            throw new DomainError("PLAN_EXISTS", "A plan with this ID already exists");
        }
        const stepIds = new Set<string>();
        for (const step of command.plan.steps) {
            if (
                !isRecord(step) ||
                typeof step.id !== "string" ||
                !step.id.trim() ||
                typeof step.sourceId !== "string" ||
                typeof step.destinationId !== "string" ||
                !Array.isArray(step.explanation) ||
                step.explanation.some((reason) => typeof reason !== "string") ||
                !Number.isFinite(step.score) ||
                (step.completedAt !== null && typeof step.completedAt !== "string")
            ) {
                throw new DomainError("INVALID_PLAN_STEP", "A plan step is malformed");
            }
            if (stepIds.has(step.id)) {
                throw new DomainError("DUPLICATE_PLAN_STEP", "Plan step IDs must be unique");
            }
            stepIds.add(step.id);
            if (step.completedAt) {
                throw new DomainError("INVALID_PLAN_STEP", "A new plan cannot contain completed steps");
            }
            const source = requireActiveLocation(state, step.sourceId);
            const destination = requireActiveLocation(state, step.destinationId);
            if (source.id === destination.id) {
                throw new DomainError("INVALID_PLAN_STEP", "A plan move needs a different destination");
            }
            if (step.type === "item" && step.itemId) {
                const item = requireItem(state, step.itemId);
                if (item.archivedAt) {
                    throw new DomainError(
                        "PLAN_STEP_STALE",
                        `${item.name} was archived after this plan was generated`,
                    );
                }
                if (
                    step.locationId !== null ||
                    item.locationId !== step.sourceId ||
                    step.quantity !== item.quantity
                ) {
                    throw new DomainError(
                        "PLAN_STEP_STALE",
                        `${item.name} no longer matches the planned move`,
                    );
                }
            } else if (step.type === "location" && step.locationId) {
                const location = requireActiveLocation(state, step.locationId);
                if (
                    step.itemId !== null ||
                    step.quantity !== null ||
                    location.parentId !== step.sourceId
                ) {
                    throw new DomainError(
                        "PLAN_STEP_STALE",
                        `${location.name} no longer matches the planned move`,
                    );
                }
                if (
                    location.id === step.destinationId ||
                    descendantsOf(state, location.id).some(
                        (candidate) => candidate.id === step.destinationId,
                    )
                ) {
                    throw new DomainError(
                        "LOCATION_CYCLE",
                        "The planned container move would create a cycle",
                    );
                }
            } else {
                throw new DomainError("INVALID_PLAN_STEP", "Plan step has no movable subject");
            }
        }
        return {
            label: `Created plan ${command.plan.name}`,
            patches: [
                ...state.plans
                    .filter((plan) => plan.status === "active")
                    .map((plan) => patch("plan", plan.id, "status", plan.status, "discarded")),
                patch("plan", command.plan.id, "", undefined, command.plan),
            ],
            subjectIds: [command.plan.id],
        };
    }

    if (command.type === "plan.status") {
        const plan = requirePlan(state, command.planId);
        if (!planStatuses.has(String(command.status))) {
            throw new DomainError("INVALID_PLAN_STATUS", "Plan status is invalid");
        }
        if (plan.status === command.status) {
            throw new DomainError(
                NO_CHANGES_ERROR,
                `${plan.name} is already marked ${command.status}`,
            );
        }
        if (
            command.status === "active" &&
            state.plans.some(
                (candidate) => candidate.id !== plan.id && candidate.status === "active",
            )
        ) {
            throw new DomainError("ACTIVE_PLAN_EXISTS", "Discard the current active plan first");
        }
        if (command.status === "active") assertPlanCanActivate(state, plan);
        if (
            command.status === "completed" &&
            plan.steps.some((step) => !step.completedAt)
        ) {
            throw new DomainError(
                "PLAN_INCOMPLETE",
                "Complete every move before marking the plan completed",
            );
        }
        if (
            command.status === "active" &&
            plan.steps.length > 0 &&
            plan.steps.every((step) => step.completedAt)
        ) {
            throw new DomainError(
                "PLAN_COMPLETE",
                "A fully completed plan cannot be made active again",
            );
        }
        return {
            label: `Marked ${plan.name} ${command.status}`,
            patches: [patch("plan", plan.id, "status", plan.status, command.status)],
            subjectIds: [plan.id],
        };
    }

    if (command.type === "plan.step.complete") {
        const plan = requirePlan(state, command.planId);
        if (plan.status !== "active") {
            throw new DomainError(
                "PLAN_NOT_ACTIVE",
                "Only an active plan can execute a move",
            );
        }
        if (state.plans.filter((candidate) => candidate.status === "active").length > 1) {
            throw new DomainError(
                "MULTIPLE_ACTIVE_PLANS",
                "Replace or discard plans until only one active plan remains",
            );
        }
        const step = plan.steps.find((candidate) => candidate.id === command.stepId);
        if (!step) throw new DomainError("PLAN_STEP_NOT_FOUND", "Plan step was not found");
        if (step.completedAt) throw new DomainError("PLAN_STEP_COMPLETE", "Plan step is already complete");
        const stepIndex = plan.steps.findIndex((candidate) => candidate.id === step.id);
        if (plan.steps.slice(0, stepIndex).some((candidate) => !candidate.completedAt)) {
            throw new DomainError(
                "PLAN_OUT_OF_ORDER",
                "Complete earlier plan moves before this one",
            );
        }
        const physicalPatches: FieldPatch[] = [];
        if (step.type === "item" && step.itemId) {
            const item = requireItem(state, step.itemId);
            requireActiveLocation(state, step.sourceId);
            requireActiveLocation(state, step.destinationId);
            if (
                item.archivedAt ||
                item.locationId !== step.sourceId ||
                step.quantity !== item.quantity
            ) {
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
                ...planCaptureProgressPatches(
                    state,
                    step.sourceId,
                    step.destinationId,
                    envelope.timestamp,
                ),
            );
        } else if (step.type === "location" && step.locationId) {
            const location = requireActiveLocation(state, step.locationId);
            if (location.parentId !== step.sourceId) {
                throw new DomainError(
                    "PLAN_STEP_STALE",
                    `${location.name} is no longer at the planned source`,
                );
            }
            if (
                location.id === step.destinationId ||
                descendantsOf(state, location.id).some(
                    (child) => child.id === step.destinationId,
                )
            ) {
                throw new DomainError("LOCATION_CYCLE", "The planned container move would create a cycle");
            }
            requireActiveLocation(state, step.destinationId);
            physicalPatches.push(
                patch("location", location.id, "parentId", location.parentId, step.destinationId),
                patch("location", location.id, "updatedAt", location.updatedAt, envelope.timestamp),
                ...planCaptureProgressPatches(
                    state,
                    step.sourceId,
                    step.destinationId,
                    envelope.timestamp,
                ),
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
        let matches = equal(current, expectation.value);
        if (
            !matches &&
            expectation.target === "item" &&
            expectation.path === "" &&
            isRecord(current) &&
            isRecord(expectation.value) &&
            !Object.hasOwn(expectation.value, "order")
        ) {
            const currentWithoutOrder = clone(current);
            delete currentWithoutOrder.order;
            matches = equal(currentWithoutOrder, expectation.value);
        }
        if (!matches) {
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
    const working = clone(state);
    const patches = direction === "undo"
        ? reversePatches(activity.patches)
        : activity.patches;
    for (const fieldPatch of patches) {
        const current = readPatchValue(
            working,
            fieldPatch.target,
            fieldPatch.id,
            fieldPatch.path,
        );
        const expected = fieldPatch.before;
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
            continue;
        }
        applyFieldPatch(working, fieldPatch);
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
    const compatibleBaseline = new Map<string, number>();
    for (const candidate of validateSnapshot(state)) {
        if (candidate.severity !== "error" || !isLegacyCompatibleIssue(candidate)) continue;
        const key = `${candidate.code}:${candidate.message}`;
        compatibleBaseline.set(key, (compatibleBaseline.get(key) ?? 0) + 1);
    }
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
    const invalid = validateSnapshot(working).find((candidate) => {
        if (candidate.severity !== "error") return false;
        if (!isLegacyCompatibleIssue(candidate)) return true;
        const key = `${candidate.code}:${candidate.message}`;
        const remaining = compatibleBaseline.get(key) ?? 0;
        if (remaining < 1) return true;
        compatibleBaseline.set(key, remaining - 1);
        return false;
    });
    if (invalid) {
        throw new DomainError(
            "HISTORY_INVALID",
            `Cannot ${direction}; it would make the workspace invalid (${invalid.message})`,
        );
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
            .map((activity, index) => ({ activity, index }))
            .filter(({ activity }) => activity.status === "applied")
            .sort((left, right) => right.index - left.index)
            .slice(0, command.count);
        if (activities.length !== command.count) {
            throw new DomainError("HISTORY_RANGE", "There are not that many applied changes");
        }
        return applyHistoryAction(
            state,
            envelope,
            "batch_undo",
            activities.map(({ activity }) => activity),
        );
    }

    if (command.type === "history.batchRedo") {
        if (!Number.isInteger(command.count) || command.count < 1) {
            throw new DomainError("INVALID_COUNT", "Redo count must be a positive integer");
        }
        const undone = new Map(
            state.activities
                .filter((activity) => activity.status === "undone")
                .map((activity) => [activity.id, activity]),
        );
        const activities: ActivityRecord[] = [];
        const selected = new Set<string>();
        for (const audit of [...state.audit].reverse()) {
            if (audit.type !== "undo" && audit.type !== "batch_undo") continue;
            for (const activityId of [...audit.targetActivityIds].reverse()) {
                const activity = undone.get(activityId);
                if (!activity || selected.has(activityId)) continue;
                selected.add(activityId);
                activities.push(activity);
            }
        }
        for (const activity of state.activities) {
            if (activity.status !== "undone" || selected.has(activity.id)) continue;
            activities.push(activity);
        }
        activities.splice(command.count);
        if (activities.length !== command.count) {
            throw new DomainError("HISTORY_RANGE", "There are not that many undone changes");
        }
        return applyHistoryAction(
            state,
            envelope,
            "batch_redo",
            activities,
        );
    }

    throw new DomainError("UNSUPPORTED_HISTORY", "Unsupported history command");
}

export function applyCommand(
    current: WorkspaceState,
    envelope: CommandEnvelope,
): CommandResult {
    validateEnvelopeRuntime(envelope);
    if (envelope.workspaceId !== current.workspace.id) {
        throw new DomainError("WRONG_WORKSPACE", "Command belongs to another workspace");
    }
    if (
        !Number.isSafeInteger(current.workspace.revision) ||
        current.workspace.revision >= Number.MAX_SAFE_INTEGER
    ) {
        throw new DomainError(
            "REVISION_EXHAUSTED",
            "The workspace revision counter is invalid or exhausted",
        );
    }
    if (envelope.baseRevision > current.workspace.revision) {
        throw new DomainError(
            "REVISION_AHEAD",
            "Command was created from a future workspace revision",
        );
    }
    const conflicts = expectationConflicts(current, envelope.expectations, envelope.id);
    if (conflicts.length) {
        throw new ConflictError("The command conflicts with a newer change", conflicts);
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
