import { SCHEMA_VERSION, type ImportPreview, type ValidationIssue, type WorkspaceState } from "./types";

function issue(
    issues: ValidationIssue[],
    code: string,
    message: string,
    path: string,
    severity: ValidationIssue["severity"] = "error",
): void {
    issues.push({ code, message, path, severity });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const patchPaths: Record<string, Set<string>> = {
    item: new Set([
        "",
        "archivedAt",
        "category",
        "constraints",
        "dimensions",
        "frequency",
        "locationId",
        "name",
        "notes",
        "order",
        "quantity",
        "tags",
        "unit",
        "updatedAt",
        "version",
    ]),
    location: new Set([
        "",
        "archivedAt",
        "captureStatus",
        "code",
        "conditions",
        "description",
        "dimensions",
        "kind",
        "name",
        "order",
        "parentId",
        "tags",
        "updatedAt",
    ]),
    plan: new Set(["", "status", "steps"]),
    workspace: new Set(["name"]),
};

function validDimensions(value: unknown): boolean {
    return (
        value === null ||
        (isRecord(value) &&
            ["width", "height", "depth"].every(
                (field) => Number.isFinite(value[field]) && Number(value[field]) > 0,
            ) &&
            (value.unit === "cm" || value.unit === "in"))
    );
}

function validConditions(value: unknown): boolean {
    return (
        isRecord(value) &&
        ["dark", "dry", "foodSafe"].every((field) => typeof value[field] === "boolean") &&
        ["dry", "normal", "humid"].includes(String(value.humidity)) &&
        ["cold", "cool", "normal", "warm"].includes(String(value.temperature))
    );
}

function validConstraints(value: unknown): boolean {
    return (
        isRecord(value) &&
        ["avoidHumidity", "avoidWarmth", "foodOnly"].every(
            (field) => typeof value[field] === "boolean",
        ) &&
        (value.keepTogether === null || typeof value.keepTogether === "string") &&
        isStringArray(value.requiredTags)
    );
}

function validPlanSteps(value: unknown): boolean {
    return (
        Array.isArray(value) &&
        value.every(
            (step) =>
                isRecord(step) &&
                typeof step.id === "string" &&
                Boolean(step.id.trim()) &&
                typeof step.sourceId === "string" &&
                Boolean(step.sourceId.trim()) &&
                typeof step.destinationId === "string" &&
                Boolean(step.destinationId.trim()) &&
                (step.completedAt === null || typeof step.completedAt === "string") &&
                Array.isArray(step.explanation) &&
                step.explanation.every((reason) => typeof reason === "string") &&
                Number.isFinite(step.score) &&
                ((step.type === "item" &&
                    typeof step.itemId === "string" &&
                    Boolean(step.itemId.trim()) &&
                    step.locationId === null &&
                    Number.isFinite(step.quantity) &&
                    Number(step.quantity) > 0) ||
                    (step.type === "location" &&
                        typeof step.locationId === "string" &&
                        Boolean(step.locationId.trim()) &&
                        step.itemId === null &&
                        step.quantity === null)),
        )
    );
}

function validFullPatchRecord(target: string, value: unknown, id: string): boolean {
    if (!isRecord(value) || value.id !== id) return false;
    if (target === "location") {
        return (
            typeof value.name === "string" &&
            Boolean(value.name.trim()) &&
            typeof value.code === "string" &&
            Boolean(value.code.trim()) &&
            typeof value.description === "string" &&
            typeof value.createdAt === "string" &&
            typeof value.updatedAt === "string" &&
            (value.archivedAt === null || typeof value.archivedAt === "string") &&
            (value.parentId === null || typeof value.parentId === "string") &&
            Number.isFinite(value.order) &&
            isStringArray(value.tags) &&
            ["counted", "in_progress", "known_empty", "uncounted"].includes(
                String(value.captureStatus),
            ) &&
            ["area", "bin", "box", "cabinet", "container", "drawer", "room", "shelf", "zone"].includes(
                String(value.kind),
            ) &&
            validDimensions(value.dimensions) &&
            validConditions(value.conditions)
        );
    }
    if (target === "item") {
        return (
            typeof value.name === "string" &&
            Boolean(value.name.trim()) &&
            typeof value.unit === "string" &&
            Boolean(value.unit.trim()) &&
            typeof value.locationId === "string" &&
            typeof value.category === "string" &&
            typeof value.notes === "string" &&
            typeof value.createdAt === "string" &&
            typeof value.updatedAt === "string" &&
            (value.archivedAt === null || typeof value.archivedAt === "string") &&
            Number.isFinite(value.quantity) &&
            Number(value.quantity) > 0 &&
            (value.order === undefined || Number.isFinite(value.order)) &&
            Number.isSafeInteger(value.version) &&
            Number(value.version) > 0 &&
            isStringArray(value.tags) &&
            ["daily", "weekly", "monthly", "rarely"].includes(String(value.frequency)) &&
            validDimensions(value.dimensions) &&
            validConstraints(value.constraints)
        );
    }
    if (target === "plan") {
        return (
            typeof value.name === "string" &&
            Boolean(value.name.trim()) &&
            typeof value.createdAt === "string" &&
            ["active", "completed", "discarded"].includes(String(value.status)) &&
            isRecord(value.weights) &&
            ["accessibility", "capacity", "grouping", "moveCost", "suitability"].every(
                (field) => Number.isFinite((value.weights as Record<string, unknown>)[field]),
            ) &&
            validPlanSteps(value.steps)
        );
    }
    return false;
}

function validPatchValue(target: string, path: string, value: unknown, id: string): boolean {
    if (value === undefined) return true;
    if (!path) return validFullPatchRecord(target, value, id);
    if (["name", "code", "description", "category", "notes", "unit", "updatedAt"].includes(path)) {
        return typeof value === "string" &&
            (!["name", "code", "unit"].includes(path) || Boolean(value.trim()));
    }
    if (path === "locationId") return typeof value === "string";
    if (path === "parentId" || path === "archivedAt") {
        return value === null || typeof value === "string";
    }
    if (path === "order") return Number.isFinite(value);
    if (path === "quantity") return Number.isFinite(value) && Number(value) > 0;
    if (path === "version") return Number.isSafeInteger(value) && Number(value) > 0;
    if (path === "tags") return isStringArray(value);
    if (path === "dimensions") return validDimensions(value);
    if (path === "conditions") return validConditions(value);
    if (path === "constraints") return validConstraints(value);
    if (path === "frequency") {
        return ["daily", "weekly", "monthly", "rarely"].includes(String(value));
    }
    if (path === "kind") {
        return ["area", "bin", "box", "cabinet", "container", "drawer", "room", "shelf", "zone"].includes(
            String(value),
        );
    }
    if (path === "captureStatus") {
        return ["counted", "in_progress", "known_empty", "uncounted"].includes(String(value));
    }
    if (path === "status") return ["active", "completed", "discarded"].includes(String(value));
    if (path === "steps") return validPlanSteps(value);
    return false;
}

function validateDimensions(value: unknown, path: string, issues: ValidationIssue[]): void {
    if (value === null) return;
    if (!isRecord(value)) {
        issue(issues, "DIMENSIONS", "Dimensions must be null or an object", path);
        return;
    }
    for (const field of ["width", "height", "depth"] as const) {
        if (!Number.isFinite(value[field]) || Number(value[field]) <= 0) {
            issue(issues, "DIMENSIONS", `${field} must be greater than zero`, `${path}.${field}`);
        }
    }
    if (value.unit !== "cm" && value.unit !== "in") issue(issues, "DIMENSIONS", "Unit must be cm or in", `${path}.unit`);
}

function requireString(record: Record<string, unknown>, field: string, path: string, issues: ValidationIssue[]): void {
    if (typeof record[field] !== "string") issue(issues, "STRING_REQUIRED", `${field} must be a string`, `${path}.${field}`);
}

export function normalizeWorkspaceState(state: WorkspaceState): WorkspaceState {
    if (!Array.isArray(state.commandReceipts)) state.commandReceipts = [];
    else state.commandReceipts = [...new Set(state.commandReceipts)];
    if (!Array.isArray(state.items)) return state;
    const nextOrder = new Map<string, number>();
    const orderByItemId = new Map<string, number>();
    for (const item of state.items) {
        if (!isRecord(item) || typeof item.locationId !== "string") continue;
        if (!Number.isFinite(item.order)) item.order = nextOrder.get(item.locationId) ?? 0;
        if (Number.isFinite(item.order)) {
            if (typeof item.id === "string") orderByItemId.set(item.id, Number(item.order));
            nextOrder.set(
                item.locationId,
                Math.max(nextOrder.get(item.locationId) ?? 0, Number(item.order) + 1),
            );
        }
    }
    if (Array.isArray(state.activities)) {
        for (const activity of state.activities) {
            if (!isRecord(activity) || !Array.isArray(activity.patches)) continue;
            for (const fieldPatch of activity.patches) {
                if (
                    !isRecord(fieldPatch) ||
                    fieldPatch.target !== "item" ||
                    fieldPatch.path !== ""
                ) {
                    continue;
                }
                for (const side of ["before", "after"] as const) {
                    const record = fieldPatch[side];
                    if (
                        !isRecord(record) ||
                        typeof record.id !== "string" ||
                        typeof record.locationId !== "string"
                    ) {
                        continue;
                    }
                    if (!Number.isFinite(record.order)) {
                        const assigned = orderByItemId.get(record.id) ??
                            nextOrder.get(record.locationId) ??
                            0;
                        record.order = assigned;
                        orderByItemId.set(record.id, assigned);
                        nextOrder.set(
                            record.locationId,
                            Math.max(nextOrder.get(record.locationId) ?? 0, assigned + 1),
                        );
                    }
                }
            }
        }
    }
    return state;
}

const legacyInvariantCodes = new Set([
    "ARCHIVED_LOCATION",
    "MULTIPLE_ACTIVE_PLANS",
    "NOT_EMPTY",
    "PARENT_ARCHIVED",
    "PLAN_DESTINATION",
    "PLAN_ITEM",
    "PLAN_LOCATION",
    "PLAN_SOURCE",
    "PLAN_STEP_STALE",
]);

export function isLegacyCompatibleIssue(candidate: ValidationIssue): boolean {
    if (candidate.code === "PLAN_STATUS") {
        return candidate.message !== "Invalid plan status";
    }
    if (candidate.code === "PLAN_DESTINATION") {
        return candidate.message === "Plan destination is missing or archived";
    }
    return legacyInvariantCodes.has(candidate.code);
}

export function validateImportSnapshot(value: unknown): ValidationIssue[] {
    return validateSnapshot(value).map((candidate) =>
        candidate.severity === "error" && isLegacyCompatibleIssue(candidate)
            ? {
                ...candidate,
                message: `Compatible v1 state is preserved: ${candidate.message}`,
                severity: "warning" as const,
            }
            : candidate
    );
}

export function validateSnapshot(value: unknown): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!isRecord(value)) {
        issue(issues, "NOT_OBJECT", "Backup must be a JSON object", "$", "error");
        return issues;
    }
    if (value.schemaVersion !== SCHEMA_VERSION) {
        issue(
            issues,
            "SCHEMA_VERSION",
            `Expected schema version ${SCHEMA_VERSION}`,
            "$.schemaVersion",
        );
    }
    if (
        !isRecord(value.workspace) ||
        typeof value.workspace.id !== "string" ||
        !value.workspace.id.trim()
    ) {
        issue(issues, "WORKSPACE_REQUIRED", "Backup needs a workspace", "$.workspace");
    } else {
        requireString(value.workspace, "name", "$.workspace", issues);
        if (typeof value.workspace.name === "string" && !value.workspace.name.trim()) {
            issue(issues, "WORKSPACE_NAME", "Workspace name cannot be blank", "$.workspace.name");
        }
        requireString(value.workspace, "createdAt", "$.workspace", issues);
        requireString(value.workspace, "updatedAt", "$.workspace", issues);
        if (!Number.isSafeInteger(value.workspace.revision) || Number(value.workspace.revision) < 0) {
            issue(issues, "WORKSPACE_REVISION", "Revision must be a non-negative safe integer", "$.workspace.revision");
        }
    }
    for (const key of ["activities", "audit", "items", "locations", "plans"] as const) {
        if (!Array.isArray(value[key])) issue(issues, "ARRAY_REQUIRED", `${key} must be an array`, `$.${key}`);
    }
    if (issues.some((candidate) => candidate.code === "ARRAY_REQUIRED")) return issues;

    const locations = value.locations as unknown[];
    const items = value.items as unknown[];
    const plans = value.plans as unknown[];
    const activities = value.activities as unknown[];
    const audit = value.audit as unknown[];
    if (value.commandReceipts !== undefined) {
        if (!isStringArray(value.commandReceipts)) {
            issue(
                issues,
                "COMMAND_RECEIPTS",
                "Command receipts must be strings",
                "$.commandReceipts",
            );
        } else {
            const receiptIds = new Set<string>();
            value.commandReceipts.forEach((commandId, index) => {
                if (!commandId.trim()) {
                    issue(
                        issues,
                        "COMMAND_RECEIPTS",
                        "Command receipt IDs cannot be blank",
                        `$.commandReceipts[${index}]`,
                    );
                } else if (receiptIds.has(commandId)) {
                    issue(
                        issues,
                        "DUPLICATE_ID",
                        "Duplicate command receipt ID",
                        `$.commandReceipts[${index}]`,
                    );
                }
                receiptIds.add(commandId);
            });
        }
    }
    const locationIds = new Set<string>();
    const activeCodes = new Set<string>();
    locations.forEach((candidate, index) => {
        const path = `$.locations[${index}]`;
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== "string" ||
            !candidate.id.trim()
        ) {
            issue(issues, "LOCATION_ID", "Location needs an id", `${path}.id`);
            return;
        }
        if (locationIds.has(candidate.id)) issue(issues, "DUPLICATE_ID", "Duplicate location id", `${path}.id`);
        locationIds.add(candidate.id);
        if (typeof candidate.name !== "string" || !candidate.name.trim()) issue(issues, "LOCATION_NAME", "Location needs a name", `${path}.name`);
        if (typeof candidate.code !== "string" || !candidate.code.trim()) issue(issues, "LOCATION_CODE", "Location needs a code", `${path}.code`);
        if (!Number.isFinite(candidate.order)) issue(issues, "LOCATION_ORDER", "Location order must be a number", `${path}.order`);
        if (candidate.archivedAt !== null && typeof candidate.archivedAt !== "string") {
            issue(issues, "LOCATION_ARCHIVED", "Archived timestamp must be a string or null", `${path}.archivedAt`);
        }
        if (
            candidate.parentId !== null &&
            (typeof candidate.parentId !== "string" || !candidate.parentId.trim())
        ) issue(issues, "LOCATION_PARENT", "Parent must be a location id or null", `${path}.parentId`);
        if (!isStringArray(candidate.tags)) issue(issues, "LOCATION_TAGS", "Tags must be strings", `${path}.tags`);
        if (!["counted", "in_progress", "known_empty", "uncounted"].includes(String(candidate.captureStatus))) issue(issues, "CAPTURE_STATUS", "Invalid capture status", `${path}.captureStatus`);
        if (!["area", "bin", "box", "cabinet", "container", "drawer", "room", "shelf", "zone"].includes(String(candidate.kind))) issue(issues, "LOCATION_KIND", "Invalid location kind", `${path}.kind`);
        requireString(candidate, "createdAt", path, issues);
        requireString(candidate, "updatedAt", path, issues);
        requireString(candidate, "description", path, issues);
        validateDimensions(candidate.dimensions, `${path}.dimensions`, issues);
        if (!isRecord(candidate.conditions)) issue(issues, "LOCATION_CONDITIONS", "Conditions must be an object", `${path}.conditions`);
        else {
            for (const field of ["dark", "dry", "foodSafe"] as const) if (typeof candidate.conditions[field] !== "boolean") issue(issues, "LOCATION_CONDITIONS", `${field} must be boolean`, `${path}.conditions.${field}`);
            if (!["dry", "normal", "humid"].includes(String(candidate.conditions.humidity))) issue(issues, "LOCATION_CONDITIONS", "Invalid humidity", `${path}.conditions.humidity`);
            if (!["cold", "cool", "normal", "warm"].includes(String(candidate.conditions.temperature))) issue(issues, "LOCATION_CONDITIONS", "Invalid temperature", `${path}.conditions.temperature`);
        }
        const normalizedCode = typeof candidate.code === "string" ? candidate.code.trim().toLocaleUpperCase() : "";
        if (!candidate.archivedAt && normalizedCode) {
            if (activeCodes.has(normalizedCode)) {
                issue(issues, "DUPLICATE_CODE", `Active code ${candidate.code} is duplicated`, `${path}.code`);
            }
            activeCodes.add(normalizedCode);
        }
    });

    const locationById = new Map(
        locations
            .filter((candidate): candidate is Record<string, unknown> => isRecord(candidate) && typeof candidate.id === "string")
            .map((candidate) => [candidate.id as string, candidate]),
    );
    locations.forEach((candidate, index) => {
        if (!isRecord(candidate) || typeof candidate.id !== "string") return;
        const parentId = typeof candidate.parentId === "string" ? candidate.parentId : null;
        if (parentId && !locationIds.has(parentId)) {
            issue(
                issues,
                "DANGLING_PARENT",
                `Parent ${parentId} does not exist`,
                `$.locations[${index}].parentId`,
            );
        }
        const parent = parentId ? locationById.get(parentId) : undefined;
        if (!candidate.archivedAt && parent?.archivedAt) {
            issue(
                issues,
                "PARENT_ARCHIVED",
                "An active location cannot be inside an archived parent",
                `$.locations[${index}].parentId`,
            );
        }
        const seen = new Set([candidate.id]);
        let cursor = parentId;
        while (cursor) {
            if (seen.has(cursor)) {
                issue(issues, "LOCATION_CYCLE", "Location hierarchy contains a cycle", `$.locations[${index}]`);
                break;
            }
            seen.add(cursor);
            const parent = locations.find((location) => isRecord(location) && location.id === cursor);
            cursor = isRecord(parent) && typeof parent.parentId === "string" ? parent.parentId : null;
        }
    });

    const itemIds = new Set<string>();
    items.forEach((candidate, index) => {
        const path = `$.items[${index}]`;
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== "string" ||
            !candidate.id.trim()
        ) {
            issue(issues, "ITEM_ID", "Item needs an id", `${path}.id`);
            return;
        }
        if (itemIds.has(candidate.id)) issue(issues, "DUPLICATE_ID", "Duplicate item id", `${path}.id`);
        itemIds.add(candidate.id);
        if (typeof candidate.locationId !== "string" || !locationIds.has(candidate.locationId)) {
            issue(issues, "DANGLING_LOCATION", `Location ${String(candidate.locationId)} does not exist`, `${path}.locationId`);
        } else if (
            !candidate.archivedAt &&
            locationById.get(candidate.locationId)?.archivedAt
        ) {
            issue(
                issues,
                "ARCHIVED_LOCATION",
                "An active item cannot be stored in an archived location",
                `${path}.locationId`,
            );
        }
        if (candidate.archivedAt !== null && typeof candidate.archivedAt !== "string") {
            issue(issues, "ITEM_ARCHIVED", "Archived timestamp must be a string or null", `${path}.archivedAt`);
        }
        if (!Number.isFinite(candidate.quantity) || Number(candidate.quantity) <= 0) {
            issue(issues, "ITEM_QUANTITY", "Quantity must be greater than zero", `${path}.quantity`);
        }
        if (candidate.order !== undefined && !Number.isFinite(candidate.order)) {
            issue(issues, "ITEM_ORDER", "Item order must be a number", `${path}.order`);
        }
        if (!Number.isSafeInteger(candidate.version) || Number(candidate.version) < 1) issue(issues, "ITEM_VERSION", "Item version must be a positive safe integer", `${path}.version`);
        if (typeof candidate.name !== "string" || !candidate.name.trim()) issue(issues, "ITEM_NAME", "Item needs a name", `${path}.name`);
        for (const field of ["unit", "category", "notes", "createdAt", "updatedAt"] as const) requireString(candidate, field, path, issues);
        if (typeof candidate.unit === "string" && !candidate.unit.trim()) {
            issue(issues, "ITEM_UNIT", "Item unit cannot be blank", `${path}.unit`);
        }
        if (!isStringArray(candidate.tags)) issue(issues, "ITEM_TAGS", "Tags must be strings", `${path}.tags`);
        if (!["daily", "weekly", "monthly", "rarely"].includes(String(candidate.frequency))) issue(issues, "ITEM_FREQUENCY", "Invalid frequency", `${path}.frequency`);
        validateDimensions(candidate.dimensions, `${path}.dimensions`, issues);
        if (!isRecord(candidate.constraints)) issue(issues, "ITEM_CONSTRAINTS", "Constraints must be an object", `${path}.constraints`);
        else {
            for (const field of ["avoidHumidity", "avoidWarmth", "foodOnly"] as const) if (typeof candidate.constraints[field] !== "boolean") issue(issues, "ITEM_CONSTRAINTS", `${field} must be boolean`, `${path}.constraints.${field}`);
            if (candidate.constraints.keepTogether !== null && typeof candidate.constraints.keepTogether !== "string") issue(issues, "ITEM_CONSTRAINTS", "keepTogether must be a string or null", `${path}.constraints.keepTogether`);
            if (!isStringArray(candidate.constraints.requiredTags)) issue(issues, "ITEM_CONSTRAINTS", "Required tags must be strings", `${path}.constraints.requiredTags`);
        }
    });

    const itemById = new Map(
        items
            .filter((candidate): candidate is Record<string, unknown> => isRecord(candidate) && typeof candidate.id === "string")
            .map((candidate) => [candidate.id as string, candidate]),
    );
    locations.forEach((candidate, index) => {
        if (!isRecord(candidate) || candidate.captureStatus !== "known_empty") return;
        const hasLiveItem = items.some(
            (item) =>
                isRecord(item) &&
                !item.archivedAt &&
                item.locationId === candidate.id,
        );
        const hasLiveChild = locations.some(
            (location) =>
                isRecord(location) &&
                !location.archivedAt &&
                location.parentId === candidate.id,
        );
        if (hasLiveItem || hasLiveChild) {
            issue(
                issues,
                "NOT_EMPTY",
                "A known-empty location cannot contain live records or nested spaces",
                `$.locations[${index}].captureStatus`,
            );
        }
    });
    const planIds = new Set<string>();
    let activePlanCount = 0;
    plans.forEach((candidate, planIndex) => {
        const planPath = `$.plans[${planIndex}]`;
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== "string" ||
            !candidate.id.trim()
        ) {
            issue(issues, "PLAN_ID", "Plan needs an id", `${planPath}.id`);
            return;
        }
        if (planIds.has(candidate.id)) {
            issue(issues, "DUPLICATE_ID", "Duplicate plan id", `$.plans[${planIndex}].id`);
        }
        planIds.add(candidate.id);
        requireString(candidate, "name", planPath, issues);
        if (typeof candidate.name === "string" && !candidate.name.trim()) {
            issue(issues, "PLAN_NAME", "Plan name cannot be blank", `${planPath}.name`);
        }
        requireString(candidate, "createdAt", planPath, issues);
        if (!["active", "completed", "discarded"].includes(String(candidate.status))) issue(issues, "PLAN_STATUS", "Invalid plan status", `${planPath}.status`);
        if (candidate.status === "active") activePlanCount += 1;
        const weights = candidate.weights;
        if (!isRecord(weights)) issue(issues, "PLAN_WEIGHTS", "Plan weights must be an object", `${planPath}.weights`);
        else if (["accessibility", "capacity", "grouping", "moveCost", "suitability"].some((field) => !Number.isFinite(weights[field]))) issue(issues, "PLAN_WEIGHTS", "Every plan weight must be numeric", `${planPath}.weights`);
        if (!Array.isArray(candidate.steps)) { issue(issues, "PLAN_STEPS", "Plan steps must be an array", `${planPath}.steps`); return; }
        if (candidate.status === "active" && candidate.steps.length === 0) {
            issue(issues, "PLAN_STEPS", "An active plan needs at least one move", `${planPath}.steps`);
        }
        const stepIds = new Set<string>();
        candidate.steps.forEach((stepCandidate, stepIndex) => {
            const path = `$.plans[${planIndex}].steps[${stepIndex}]`;
            if (!isRecord(stepCandidate)) { issue(issues, "PLAN_STEP", "Plan step must be an object", path); return; }
            requireString(stepCandidate, "id", path, issues);
            if (typeof stepCandidate.id === "string" && !stepCandidate.id.trim()) {
                issue(issues, "PLAN_STEP", "Plan step ID cannot be blank", `${path}.id`);
            }
            if (typeof stepCandidate.id === "string" && stepCandidate.id.trim()) {
                if (stepIds.has(stepCandidate.id)) {
                    issue(issues, "DUPLICATE_ID", "Duplicate plan step id", `${path}.id`);
                }
                stepIds.add(stepCandidate.id);
            }
            if (
                stepCandidate.completedAt !== null &&
                typeof stepCandidate.completedAt !== "string"
            ) {
                issue(
                    issues,
                    "PLAN_STEP",
                    "completedAt must be a timestamp or null",
                    `${path}.completedAt`,
                );
            }
            const executable = candidate.status === "active" && !stepCandidate.completedAt;
            const source = typeof stepCandidate.sourceId === "string"
                ? locationById.get(stepCandidate.sourceId)
                : undefined;
            const destination = typeof stepCandidate.destinationId === "string"
                ? locationById.get(stepCandidate.destinationId)
                : undefined;
            if (typeof stepCandidate.sourceId !== "string" || !stepCandidate.sourceId.trim()) {
                issue(issues, "PLAN_STEP", "Plan source ID is required", `${path}.sourceId`);
            } else if (executable && (!source || Boolean(source.archivedAt))) {
                issue(issues, "PLAN_SOURCE", "Plan source is missing or archived", `${path}.sourceId`);
            }
            if (
                typeof stepCandidate.destinationId !== "string" ||
                !stepCandidate.destinationId.trim()
            ) {
                issue(
                    issues,
                    "PLAN_STEP",
                    "Plan destination ID is required",
                    `${path}.destinationId`,
                );
            } else if (executable && (!destination || Boolean(destination.archivedAt))) {
                issue(issues, "PLAN_DESTINATION", "Plan destination is missing or archived", `${path}.destinationId`);
            }
            if (
                executable &&
                typeof stepCandidate.sourceId === "string" &&
                stepCandidate.sourceId === stepCandidate.destinationId
            ) {
                issue(issues, "PLAN_DESTINATION", "Plan destination must differ from its source", `${path}.destinationId`);
            }
            if (stepCandidate.type === "item") {
                const item = typeof stepCandidate.itemId === "string"
                    ? itemById.get(stepCandidate.itemId)
                    : undefined;
                if (
                    typeof stepCandidate.itemId !== "string" ||
                    !stepCandidate.itemId.trim()
                ) {
                    issue(
                        issues,
                        "PLAN_STEP",
                        "Item step subject ID is required",
                        `${path}.itemId`,
                    );
                } else if (executable && (!item || Boolean(item.archivedAt))) {
                    issue(issues, "PLAN_ITEM", "Executable item step needs a live item", `${path}.itemId`);
                }
                if (stepCandidate.locationId !== null) {
                    issue(issues, "PLAN_STEP", "Item steps cannot name a container subject", `${path}.locationId`);
                }
                if (!Number.isFinite(stepCandidate.quantity) || Number(stepCandidate.quantity) <= 0) {
                    issue(issues, "PLAN_STEP", "Item move quantity must be greater than zero", `${path}.quantity`);
                }
                if (
                    executable &&
                    item &&
                    (item.locationId !== stepCandidate.sourceId ||
                        item.quantity !== stepCandidate.quantity)
                ) {
                    issue(
                        issues,
                        "PLAN_STEP_STALE",
                        "Executable item step does not match the item's current location and quantity",
                        path,
                    );
                }
            } else if (stepCandidate.type === "location") {
                const location = typeof stepCandidate.locationId === "string"
                    ? locationById.get(stepCandidate.locationId)
                    : undefined;
                if (
                    typeof stepCandidate.locationId !== "string" ||
                    !stepCandidate.locationId.trim()
                ) {
                    issue(
                        issues,
                        "PLAN_STEP",
                        "Container step subject ID is required",
                        `${path}.locationId`,
                    );
                } else if (executable && (!location || Boolean(location.archivedAt))) {
                    issue(issues, "PLAN_LOCATION", "Executable container step needs a live location", `${path}.locationId`);
                }
                if (stepCandidate.itemId !== null || stepCandidate.quantity !== null) {
                    issue(issues, "PLAN_STEP", "Container steps cannot name an item or quantity", path);
                }
                if (
                    executable &&
                    location &&
                    location.parentId !== stepCandidate.sourceId
                ) {
                    issue(
                        issues,
                        "PLAN_STEP_STALE",
                        "Executable container step does not match its current parent",
                        path,
                    );
                }
                if (executable && location && destination) {
                    const seen = new Set<string>();
                    let cursor: Record<string, unknown> | undefined = destination;
                    while (cursor && typeof cursor.id === "string" && !seen.has(cursor.id)) {
                        if (cursor.id === location.id) {
                            issue(
                                issues,
                                "LOCATION_CYCLE",
                                "Executable container step would create a hierarchy cycle",
                                `${path}.destinationId`,
                            );
                            break;
                        }
                        seen.add(cursor.id);
                        cursor = typeof cursor.parentId === "string"
                            ? locationById.get(cursor.parentId)
                            : undefined;
                    }
                }
            } else {
                issue(issues, "PLAN_STEP", "Invalid plan step type", `${path}.type`);
            }
            if (!Array.isArray(stepCandidate.explanation) || !stepCandidate.explanation.every((reason) => typeof reason === "string")) issue(issues, "PLAN_STEP", "Explanations must be strings", `${path}.explanation`);
            if (!Number.isFinite(stepCandidate.score)) issue(issues, "PLAN_STEP", "Score must be numeric", `${path}.score`);
        });
        if (
            candidate.status === "completed" &&
            candidate.steps.some(
                (step) => !isRecord(step) || typeof step.completedAt !== "string",
            )
        ) {
            issue(
                issues,
                "PLAN_STATUS",
                "A completed plan cannot contain unfinished moves",
                `${planPath}.status`,
            );
        }
        if (
            candidate.status === "active" &&
            candidate.steps.length > 0 &&
            candidate.steps.every(
                (step) => isRecord(step) && typeof step.completedAt === "string",
            )
        ) {
            issue(
                issues,
                "PLAN_STATUS",
                "A plan with every move completed must be marked completed",
                `${planPath}.status`,
            );
        }
    });
    if (activePlanCount > 1) {
        issue(issues, "MULTIPLE_ACTIVE_PLANS", "A workspace can have only one active plan", "$.plans");
    }

    const activityIds = new Set<string>();
    activities.forEach((candidate, index) => {
        const path = `$.activities[${index}]`;
        if (!isRecord(candidate)) { issue(issues, "ACTIVITY", "Activity must be an object", path); return; }
        for (const field of ["id", "actorId", "commandId", "label", "timestamp"] as const) requireString(candidate, field, path, issues);
        for (const field of ["id", "actorId", "commandId"] as const) {
            if (typeof candidate[field] === "string" && !candidate[field].trim()) {
                issue(issues, "ACTIVITY", `${field} cannot be blank`, `${path}.${field}`);
            }
        }
        if (typeof candidate.id === "string" && candidate.id.trim()) {
            if (activityIds.has(candidate.id)) {
                issue(issues, "DUPLICATE_ID", "Duplicate activity id", `${path}.id`);
            }
            activityIds.add(candidate.id);
        }
        if (candidate.status !== "applied" && candidate.status !== "undone") issue(issues, "ACTIVITY", "Invalid activity status", `${path}.status`);
        if (candidate.undoneAt !== null && typeof candidate.undoneAt !== "string") {
            issue(issues, "ACTIVITY", "Undone timestamp must be a string or null", `${path}.undoneAt`);
        }
        if (!isStringArray(candidate.subjectIds)) issue(issues, "ACTIVITY", "Subject ids must be strings", `${path}.subjectIds`);
        if (!Array.isArray(candidate.patches)) { issue(issues, "ACTIVITY", "Patches must be an array", `${path}.patches`); return; }
        candidate.patches.forEach((patchCandidate, patchIndex) => {
            const patchPath = `${path}.patches[${patchIndex}]`;
            if (!isRecord(patchCandidate)) { issue(issues, "PATCH", "Patch must be an object", patchPath); return; }
            for (const field of ["id", "path"] as const) requireString(patchCandidate, field, patchPath, issues);
            const target = String(patchCandidate.target);
            const fieldPath = typeof patchCandidate.path === "string"
                ? patchCandidate.path
                : "";
            const id = typeof patchCandidate.id === "string" ? patchCandidate.id : "";
            if (!patchPaths[target]) {
                issue(issues, "PATCH", "Invalid patch target", `${patchPath}.target`);
                return;
            }
            if (!id.trim()) issue(issues, "PATCH", "Patch target ID is required", `${patchPath}.id`);
            if (!patchPaths[target].has(fieldPath)) {
                issue(
                    issues,
                    "PATCH_PATH",
                    "Backup history contains an unsupported or unsafe field path",
                    `${patchPath}.path`,
                );
            }
            if (
                target === "workspace" &&
                isRecord(value.workspace) &&
                id !== value.workspace.id
            ) {
                issue(issues, "PATCH_TARGET", "Workspace patch targets another workspace", `${patchPath}.id`);
            }
            for (const side of ["before", "after"] as const) {
                if (
                    Object.hasOwn(patchCandidate, side) &&
                    !validPatchValue(target, fieldPath, patchCandidate[side], id)
                ) {
                    issue(
                        issues,
                        "PATCH_VALUE",
                        `Backup history has an invalid ${side} value`,
                        `${patchPath}.${side}`,
                    );
                }
            }
        });
    });

    const auditIds = new Set<string>();
    audit.forEach((candidate, index) => {
        const path = `$.audit[${index}]`;
        if (!isRecord(candidate)) { issue(issues, "AUDIT", "Audit event must be an object", path); return; }
        for (const field of ["id", "actorId", "label", "timestamp"] as const) requireString(candidate, field, path, issues);
        for (const field of ["id", "actorId"] as const) {
            if (typeof candidate[field] === "string" && !candidate[field].trim()) {
                issue(issues, "AUDIT", `${field} cannot be blank`, `${path}.${field}`);
            }
        }
        if (typeof candidate.id === "string" && candidate.id.trim()) {
            if (auditIds.has(candidate.id)) {
                issue(issues, "DUPLICATE_ID", "Duplicate audit id", `${path}.id`);
            }
            auditIds.add(candidate.id);
        }
        if (!["batch_redo", "batch_undo", "reapply", "undo"].includes(String(candidate.type))) issue(issues, "AUDIT", "Invalid audit event type", `${path}.type`);
        if (!isStringArray(candidate.targetActivityIds)) {
            issue(issues, "AUDIT", "Target activity ids must be strings", `${path}.targetActivityIds`);
        } else if (candidate.targetActivityIds.some((id) => !activityIds.has(id))) {
            issue(issues, "AUDIT", "Audit event references a missing activity", `${path}.targetActivityIds`);
        }
    });
    return issues;
}

export function previewImport(current: WorkspaceState, input: unknown): ImportPreview {
    const issues = validateImportSnapshot(input);
    const incoming = isRecord(input) ? input : {};
    return {
        incoming: {
            items: Array.isArray(incoming.items) ? incoming.items.length : 0,
            locations: Array.isArray(incoming.locations) ? incoming.locations.length : 0,
            plans: Array.isArray(incoming.plans) ? incoming.plans.length : 0,
        },
        issues,
        replacing: {
            items: current.items.length,
            locations: current.locations.length,
            plans: current.plans.length,
        },
        valid: !issues.some((candidate) => candidate.severity === "error"),
    };
}

export function parseSnapshot(input: string): WorkspaceState {
    const value = JSON.parse(input) as unknown;
    const issues = validateImportSnapshot(value);
    const errors = issues.filter((candidate) => candidate.severity === "error");
    if (errors.length) {
        throw new Error(errors.map((candidate) => `${candidate.path}: ${candidate.message}`).join("\n"));
    }
    return normalizeWorkspaceState(structuredClone(value) as WorkspaceState);
}
