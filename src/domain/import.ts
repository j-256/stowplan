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
    const nextOrder = new Map<string, number>();
    for (const item of state.items) {
        if (!Number.isFinite(item.order)) item.order = nextOrder.get(item.locationId) ?? 0;
        nextOrder.set(item.locationId, Math.max(nextOrder.get(item.locationId) ?? 0, item.order + 1));
    }
    return state;
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
    if (!isRecord(value.workspace) || typeof value.workspace.id !== "string") {
        issue(issues, "WORKSPACE_REQUIRED", "Backup needs a workspace", "$.workspace");
    } else {
        requireString(value.workspace, "name", "$.workspace", issues);
        requireString(value.workspace, "createdAt", "$.workspace", issues);
        requireString(value.workspace, "updatedAt", "$.workspace", issues);
        if (!Number.isInteger(value.workspace.revision) || Number(value.workspace.revision) < 0) {
            issue(issues, "WORKSPACE_REVISION", "Revision must be a non-negative integer", "$.workspace.revision");
        }
    }
    for (const key of ["activities", "audit", "items", "locations", "plans"] as const) {
        if (!Array.isArray(value[key])) issue(issues, "ARRAY_REQUIRED", `${key} must be an array`, `$.${key}`);
    }
    if (issues.some((candidate) => candidate.severity === "error")) return issues;

    const locations = value.locations as unknown[];
    const items = value.items as unknown[];
    const plans = value.plans as unknown[];
    const activities = value.activities as unknown[];
    const audit = value.audit as unknown[];
    const locationIds = new Set<string>();
    const activeCodes = new Set<string>();
    locations.forEach((candidate, index) => {
        const path = `$.locations[${index}]`;
        if (!isRecord(candidate) || typeof candidate.id !== "string") {
            issue(issues, "LOCATION_ID", "Location needs an id", `${path}.id`);
            return;
        }
        if (locationIds.has(candidate.id)) issue(issues, "DUPLICATE_ID", "Duplicate location id", `${path}.id`);
        locationIds.add(candidate.id);
        if (typeof candidate.name !== "string" || !candidate.name.trim()) issue(issues, "LOCATION_NAME", "Location needs a name", `${path}.name`);
        if (typeof candidate.code !== "string" || !candidate.code.trim()) issue(issues, "LOCATION_CODE", "Location needs a code", `${path}.code`);
        if (!Number.isFinite(candidate.order)) issue(issues, "LOCATION_ORDER", "Location order must be a number", `${path}.order`);
        if (candidate.parentId !== null && typeof candidate.parentId !== "string") issue(issues, "LOCATION_PARENT", "Parent must be a location id or null", `${path}.parentId`);
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
        if (!isRecord(candidate) || typeof candidate.id !== "string") {
            issue(issues, "ITEM_ID", "Item needs an id", `${path}.id`);
            return;
        }
        if (itemIds.has(candidate.id)) issue(issues, "DUPLICATE_ID", "Duplicate item id", `${path}.id`);
        itemIds.add(candidate.id);
        if (typeof candidate.locationId !== "string" || !locationIds.has(candidate.locationId)) {
            issue(issues, "DANGLING_LOCATION", `Location ${String(candidate.locationId)} does not exist`, `${path}.locationId`);
        }
        if (!Number.isFinite(candidate.quantity) || Number(candidate.quantity) <= 0) {
            issue(issues, "ITEM_QUANTITY", "Quantity must be greater than zero", `${path}.quantity`);
        }
        if (candidate.order !== undefined && !Number.isFinite(candidate.order)) {
            issue(issues, "ITEM_ORDER", "Item order must be a number", `${path}.order`);
        }
        if (!Number.isInteger(candidate.version) || Number(candidate.version) < 1) issue(issues, "ITEM_VERSION", "Item version must be a positive integer", `${path}.version`);
        if (typeof candidate.name !== "string" || !candidate.name.trim()) issue(issues, "ITEM_NAME", "Item needs a name", `${path}.name`);
        for (const field of ["unit", "category", "notes", "createdAt", "updatedAt"] as const) requireString(candidate, field, path, issues);
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

    const planIds = new Set<string>();
    plans.forEach((candidate, planIndex) => {
        const planPath = `$.plans[${planIndex}]`;
        if (!isRecord(candidate) || typeof candidate.id !== "string") {
            issue(issues, "PLAN_ID", "Plan needs an id", `${planPath}.id`);
            return;
        }
        if (planIds.has(candidate.id)) {
            issue(issues, "DUPLICATE_ID", "Duplicate plan id", `$.plans[${planIndex}].id`);
        }
        planIds.add(candidate.id);
        requireString(candidate, "name", planPath, issues);
        requireString(candidate, "createdAt", planPath, issues);
        if (!["active", "completed", "discarded"].includes(String(candidate.status))) issue(issues, "PLAN_STATUS", "Invalid plan status", `${planPath}.status`);
        const weights = candidate.weights;
        if (!isRecord(weights)) issue(issues, "PLAN_WEIGHTS", "Plan weights must be an object", `${planPath}.weights`);
        else if (["accessibility", "capacity", "grouping", "moveCost", "suitability"].some((field) => !Number.isFinite(weights[field]))) issue(issues, "PLAN_WEIGHTS", "Every plan weight must be numeric", `${planPath}.weights`);
        if (!Array.isArray(candidate.steps)) { issue(issues, "PLAN_STEPS", "Plan steps must be an array", `${planPath}.steps`); return; }
        candidate.steps.forEach((stepCandidate, stepIndex) => {
            const path = `$.plans[${planIndex}].steps[${stepIndex}]`;
            if (!isRecord(stepCandidate)) { issue(issues, "PLAN_STEP", "Plan step must be an object", path); return; }
            requireString(stepCandidate, "id", path, issues);
            if (typeof stepCandidate.sourceId !== "string" || !locationIds.has(stepCandidate.sourceId)) {
                issue(issues, "PLAN_SOURCE", "Plan source no longer exists", `${path}.sourceId`);
            }
            if (typeof stepCandidate.destinationId !== "string" || !locationIds.has(stepCandidate.destinationId)) {
                issue(issues, "PLAN_DESTINATION", "Plan destination no longer exists", `${path}.destinationId`);
            }
            if (stepCandidate.itemId && (typeof stepCandidate.itemId !== "string" || !itemIds.has(stepCandidate.itemId))) {
                issue(issues, "PLAN_ITEM", "Plan item no longer exists", `${path}.itemId`);
            }
            if (stepCandidate.locationId && (typeof stepCandidate.locationId !== "string" || !locationIds.has(stepCandidate.locationId))) {
                issue(issues, "PLAN_LOCATION", "Plan location no longer exists", `${path}.locationId`);
            }
            if (stepCandidate.type !== "item" && stepCandidate.type !== "location") issue(issues, "PLAN_STEP", "Invalid plan step type", `${path}.type`);
            if (!Array.isArray(stepCandidate.explanation) || !stepCandidate.explanation.every((reason) => typeof reason === "string")) issue(issues, "PLAN_STEP", "Explanations must be strings", `${path}.explanation`);
            if (!Number.isFinite(stepCandidate.score)) issue(issues, "PLAN_STEP", "Score must be numeric", `${path}.score`);
        });
    });

    activities.forEach((candidate, index) => {
        const path = `$.activities[${index}]`;
        if (!isRecord(candidate)) { issue(issues, "ACTIVITY", "Activity must be an object", path); return; }
        for (const field of ["id", "actorId", "commandId", "label", "timestamp"] as const) requireString(candidate, field, path, issues);
        if (candidate.status !== "applied" && candidate.status !== "undone") issue(issues, "ACTIVITY", "Invalid activity status", `${path}.status`);
        if (!isStringArray(candidate.subjectIds)) issue(issues, "ACTIVITY", "Subject ids must be strings", `${path}.subjectIds`);
        if (!Array.isArray(candidate.patches)) { issue(issues, "ACTIVITY", "Patches must be an array", `${path}.patches`); return; }
        candidate.patches.forEach((patchCandidate, patchIndex) => {
            const patchPath = `${path}.patches[${patchIndex}]`;
            if (!isRecord(patchCandidate)) { issue(issues, "PATCH", "Patch must be an object", patchPath); return; }
            for (const field of ["id", "path"] as const) requireString(patchCandidate, field, patchPath, issues);
            if (!["item", "location", "plan", "workspace"].includes(String(patchCandidate.target))) issue(issues, "PATCH", "Invalid patch target", `${patchPath}.target`);
        });
    });

    audit.forEach((candidate, index) => {
        const path = `$.audit[${index}]`;
        if (!isRecord(candidate)) { issue(issues, "AUDIT", "Audit event must be an object", path); return; }
        for (const field of ["id", "actorId", "label", "timestamp"] as const) requireString(candidate, field, path, issues);
        if (!["batch_redo", "batch_undo", "reapply", "undo"].includes(String(candidate.type))) issue(issues, "AUDIT", "Invalid audit event type", `${path}.type`);
        if (!isStringArray(candidate.targetActivityIds)) issue(issues, "AUDIT", "Target activity ids must be strings", `${path}.targetActivityIds`);
    });
    return issues;
}

export function previewImport(current: WorkspaceState, input: unknown): ImportPreview {
    const issues = validateSnapshot(input);
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
    const issues = validateSnapshot(value);
    const errors = issues.filter((candidate) => candidate.severity === "error");
    if (errors.length) {
        throw new Error(errors.map((candidate) => `${candidate.path}: ${candidate.message}`).join("\n"));
    }
    return normalizeWorkspaceState(structuredClone(value) as WorkspaceState);
}
