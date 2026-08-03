import {
    type Command,
    type CommandEnvelope,
    type Frequency,
    type ItemConstraints,
    type ItemRecord,
    type Location,
    type LocationConditions,
    type LocationKind,
    SCHEMA_VERSION,
    type WorkspaceState,
} from "./types";
import { expectationsForCommand } from "./expectations";

export const DEFAULT_ITEM_CATEGORY = "Uncategorized";
export const DEFAULT_ITEM_FREQUENCY: Frequency = "monthly";
export const DEFAULT_ITEM_QUANTITY = 1;
export const DEFAULT_ITEM_UNIT = "each";

export const DEFAULT_LOCATION_CONDITIONS: Readonly<LocationConditions> = {
    dark: false,
    dry: true,
    foodSafe: false,
    humidity: "normal",
    temperature: "normal",
};

export const DEFAULT_ITEM_CONSTRAINTS: Readonly<ItemConstraints> = {
    avoidHumidity: false,
    avoidWarmth: false,
    foodOnly: false,
    keepTogether: null,
    requiredTags: [],
};

function uuidV4(): string {
    const runtimeCrypto = globalThis.crypto;
    if (typeof runtimeCrypto?.randomUUID === "function") return runtimeCrypto.randomUUID();
    if (typeof runtimeCrypto?.getRandomValues !== "function") {
        throw new Error("Secure random number generation is unavailable");
    }

    const bytes = runtimeCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hexadecimal = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return [
        hexadecimal.slice(0, 4).join(""),
        hexadecimal.slice(4, 6).join(""),
        hexadecimal.slice(6, 8).join(""),
        hexadecimal.slice(8, 10).join(""),
        hexadecimal.slice(10, 16).join(""),
    ].join("-");
}

export function newId(prefix: string): string {
    return `${prefix}_${uuidV4()}`;
}

export function nowIso(): string {
    return new Date().toISOString();
}

export function createEmptyState(name = "My home", timestamp = nowIso()): WorkspaceState {
    const workspaceId = newId("ws");
    return {
        activities: [],
        audit: [],
        commandReceipts: [],
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
        conditions: { ...DEFAULT_LOCATION_CONDITIONS },
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
        description?: string;
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
        category: input.category?.trim() ?? DEFAULT_ITEM_CATEGORY,
        constraints: {
            ...DEFAULT_ITEM_CONSTRAINTS,
            requiredTags: [],
        },
        createdAt: timestamp,
        description: input.description?.trim() ?? "",
        dimensions: null,
        frequency: DEFAULT_ITEM_FREQUENCY,
        id: newId("item"),
        locationId: input.locationId,
        name: input.name.trim(),
        order: input.order ?? 0,
        quantity: input.quantity ?? DEFAULT_ITEM_QUANTITY,
        tags: [],
        unit: input.unit?.trim() || DEFAULT_ITEM_UNIT,
        updatedAt: timestamp,
        version: 1,
    };
}

export function createEnvelope<T extends Command>(
    state: WorkspaceState,
    command: T,
    options: Partial<Pick<
        CommandEnvelope<T>,
        "actorId" | "authorization" | "deviceId" | "id" | "timestamp"
    >> = {},
): CommandEnvelope<T> {
    return {
        actorId: options.actorId ?? "local-user",
        ...(options.authorization
            ? { authorization: { ...options.authorization } }
            : {}),
        baseRevision: state.workspace.revision,
        command,
        deviceId: options.deviceId ?? "local-device",
        expectations: expectationsForCommand(state, command),
        id: options.id ?? newId("cmd"),
        timestamp: options.timestamp ?? nowIso(),
        workspaceId: state.workspace.id,
    };
}
