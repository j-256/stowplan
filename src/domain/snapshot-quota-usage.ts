export interface SnapshotQuotaUsage {
    activitiesPerSnapshot: number;
    activityPatchesPerSnapshot: number;
    auditEventsPerSnapshot: number;
    commandReceiptsPerSnapshot: number;
    itemsPerSnapshot: number;
    locationsPerSnapshot: number;
    plansPerSnapshot: number;
    planStepsPerSnapshot: number;
    storedSnapshotBytes: number;
}

export const SNAPSHOT_QUOTA_ORDER = Object.freeze([
    "locationsPerSnapshot",
    "itemsPerSnapshot",
    "plansPerSnapshot",
    "planStepsPerSnapshot",
    "activitiesPerSnapshot",
    "auditEventsPerSnapshot",
    "activityPatchesPerSnapshot",
    "commandReceiptsPerSnapshot",
    "storedSnapshotBytes",
] as const satisfies readonly (keyof SnapshotQuotaUsage)[]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" &&
        !Array.isArray(value);
}

function arrayLength(value: unknown, field: string): number {
    return isRecord(value) && Array.isArray(value[field])
        ? value[field].length
        : 0;
}

function nestedArrayCount(
    value: unknown,
    collection: string,
    field: string,
): number {
    if (!isRecord(value) || !Array.isArray(value[collection])) return 0;
    return value[collection].reduce(
        (total, entry) =>
            total + (
                isRecord(entry) && Array.isArray(entry[field])
                    ? entry[field].length
                    : 0
            ),
        0,
    );
}

export function serializedJsonBytes(value: unknown): number {
    const json = JSON.stringify(value);
    return json === undefined
        ? 0
        : new TextEncoder().encode(json).byteLength;
}

export function snapshotQuotaUsage(value: unknown): SnapshotQuotaUsage {
    return {
        activitiesPerSnapshot: arrayLength(value, "activities"),
        activityPatchesPerSnapshot: nestedArrayCount(
            value,
            "activities",
            "patches",
        ),
        auditEventsPerSnapshot: arrayLength(value, "audit"),
        commandReceiptsPerSnapshot: arrayLength(value, "commandReceipts"),
        itemsPerSnapshot: arrayLength(value, "items"),
        locationsPerSnapshot: arrayLength(value, "locations"),
        plansPerSnapshot: arrayLength(value, "plans"),
        planStepsPerSnapshot: nestedArrayCount(value, "plans", "steps"),
        storedSnapshotBytes: serializedJsonBytes(value),
    };
}
