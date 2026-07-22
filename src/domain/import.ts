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
    }
    for (const key of ["activities", "audit", "items", "locations", "plans"] as const) {
        if (!Array.isArray(value[key])) issue(issues, "ARRAY_REQUIRED", `${key} must be an array`, `$.${key}`);
    }
    if (issues.some((candidate) => candidate.severity === "error")) return issues;

    const state = value as unknown as WorkspaceState;
    const locationIds = new Set<string>();
    const activeCodes = new Set<string>();
    state.locations.forEach((location, index) => {
        const path = `$.locations[${index}]`;
        if (!location || typeof location.id !== "string") {
            issue(issues, "LOCATION_ID", "Location needs an id", `${path}.id`);
            return;
        }
        if (locationIds.has(location.id)) issue(issues, "DUPLICATE_ID", "Duplicate location id", `${path}.id`);
        locationIds.add(location.id);
        if (!location.name?.trim()) issue(issues, "LOCATION_NAME", "Location needs a name", `${path}.name`);
        if (!location.code?.trim()) issue(issues, "LOCATION_CODE", "Location needs a code", `${path}.code`);
        const normalizedCode = location.code?.trim().toLocaleUpperCase();
        if (!location.archivedAt && normalizedCode) {
            if (activeCodes.has(normalizedCode)) {
                issue(issues, "DUPLICATE_CODE", `Active code ${location.code} is duplicated`, `${path}.code`);
            }
            activeCodes.add(normalizedCode);
        }
    });

    state.locations.forEach((location, index) => {
        if (location.parentId && !locationIds.has(location.parentId)) {
            issue(
                issues,
                "DANGLING_PARENT",
                `Parent ${location.parentId} does not exist`,
                `$.locations[${index}].parentId`,
            );
        }
        const seen = new Set([location.id]);
        let parentId = location.parentId;
        while (parentId) {
            if (seen.has(parentId)) {
                issue(issues, "LOCATION_CYCLE", "Location hierarchy contains a cycle", `$.locations[${index}]`);
                break;
            }
            seen.add(parentId);
            parentId = state.locations.find((candidate) => candidate.id === parentId)?.parentId ?? null;
        }
    });

    const itemIds = new Set<string>();
    state.items.forEach((item, index) => {
        const path = `$.items[${index}]`;
        if (!item || typeof item.id !== "string") {
            issue(issues, "ITEM_ID", "Item needs an id", `${path}.id`);
            return;
        }
        if (itemIds.has(item.id)) issue(issues, "DUPLICATE_ID", "Duplicate item id", `${path}.id`);
        itemIds.add(item.id);
        if (!locationIds.has(item.locationId)) {
            issue(issues, "DANGLING_LOCATION", `Location ${item.locationId} does not exist`, `${path}.locationId`);
        }
        if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
            issue(issues, "ITEM_QUANTITY", "Quantity must be greater than zero", `${path}.quantity`);
        }
        if (!item.name?.trim()) issue(issues, "ITEM_NAME", "Item needs a name", `${path}.name`);
    });

    const planIds = new Set<string>();
    state.plans.forEach((plan, planIndex) => {
        if (planIds.has(plan.id)) {
            issue(issues, "DUPLICATE_ID", "Duplicate plan id", `$.plans[${planIndex}].id`);
        }
        planIds.add(plan.id);
        plan.steps.forEach((step, stepIndex) => {
            const path = `$.plans[${planIndex}].steps[${stepIndex}]`;
            if (!locationIds.has(step.sourceId)) {
                issue(issues, "PLAN_SOURCE", "Plan source no longer exists", `${path}.sourceId`);
            }
            if (!locationIds.has(step.destinationId)) {
                issue(issues, "PLAN_DESTINATION", "Plan destination no longer exists", `${path}.destinationId`);
            }
            if (step.itemId && !itemIds.has(step.itemId)) {
                issue(issues, "PLAN_ITEM", "Plan item no longer exists", `${path}.itemId`);
            }
            if (step.locationId && !locationIds.has(step.locationId)) {
                issue(issues, "PLAN_LOCATION", "Plan location no longer exists", `${path}.locationId`);
            }
        });
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
    return structuredClone(value) as WorkspaceState;
}
