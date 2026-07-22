import {
    type Command,
    type CommandEnvelope,
    type ItemConstraints,
    type ItemRecord,
    type Location,
    type LocationConditions,
    type LocationKind,
    SCHEMA_VERSION,
    type WorkspaceState,
} from "./types";
import { expectationsForCommand } from "./expectations";

const defaultConditions: LocationConditions = {
    dark: false,
    dry: true,
    foodSafe: false,
    humidity: "normal",
    temperature: "normal",
};

const defaultConstraints: ItemConstraints = {
    avoidHumidity: false,
    avoidWarmth: false,
    foodOnly: false,
    keepTogether: null,
    requiredTags: [],
};

export function newId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
    return new Date().toISOString();
}

export function createEmptyState(name = "My home", timestamp = nowIso()): WorkspaceState {
    const workspaceId = newId("ws");
    return {
        activities: [],
        audit: [],
        items: [],
        locations: [],
        plans: [],
        schemaVersion: SCHEMA_VERSION,
        workspace: {
            createdAt: timestamp,
            id: workspaceId,
            name,
            revision: 0,
            updatedAt: timestamp,
        },
    };
}

export function createLocation(
    input: {
        code: string;
        kind?: LocationKind;
        name: string;
        order?: number;
        parentId?: string | null;
    },
    timestamp = nowIso(),
): Location {
    return {
        archivedAt: null,
        captureStatus: "uncounted",
        code: input.code.trim().toUpperCase(),
        conditions: { ...defaultConditions },
        createdAt: timestamp,
        description: "",
        dimensions: null,
        id: newId("loc"),
        kind: input.kind ?? "container",
        name: input.name.trim(),
        order: input.order ?? 0,
        parentId: input.parentId ?? null,
        tags: [],
        updatedAt: timestamp,
    };
}

export function createItem(
    input: {
        category?: string;
        locationId: string;
        name: string;
        order?: number;
        quantity?: number;
        unit?: string;
    },
    timestamp = nowIso(),
): ItemRecord {
    return {
        archivedAt: null,
        category: input.category?.trim() ?? "Uncategorized",
        constraints: { ...defaultConstraints },
        createdAt: timestamp,
        dimensions: null,
        frequency: "monthly",
        id: newId("item"),
        locationId: input.locationId,
        name: input.name.trim(),
        notes: "",
        order: input.order ?? 0,
        quantity: input.quantity ?? 1,
        tags: [],
        unit: input.unit?.trim() || "each",
        updatedAt: timestamp,
        version: 1,
    };
}

export function createEnvelope<T extends Command>(
    state: WorkspaceState,
    command: T,
    options: Partial<Pick<CommandEnvelope<T>, "actorId" | "deviceId" | "id" | "timestamp">> = {},
): CommandEnvelope<T> {
    return {
        actorId: options.actorId ?? "local-user",
        baseRevision: state.workspace.revision,
        command,
        deviceId: options.deviceId ?? "local-device",
        expectations: expectationsForCommand(state, command),
        id: options.id ?? newId("cmd"),
        timestamp: options.timestamp ?? nowIso(),
        workspaceId: state.workspace.id,
    };
}
