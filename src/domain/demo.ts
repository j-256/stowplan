import { SCHEMA_VERSION, type ItemRecord, type Location, type WorkspaceState } from "./types";

const timestamp = "2026-07-22T12:00:00.000Z";

function conditions(
    overrides: Partial<Location["conditions"]> = {},
): Location["conditions"] {
    return {
        dark: false,
        dry: true,
        foodSafe: false,
        humidity: "normal",
        temperature: "normal",
        ...overrides,
    };
}

function location(
    id: string,
    code: string,
    name: string,
    kind: Location["kind"],
    parentId: string | null,
    order: number,
    overrides: Partial<Location> = {},
): Location {
    return {
        archivedAt: null,
        captureStatus: "counted",
        code,
        conditions: conditions(),
        createdAt: timestamp,
        description: "",
        dimensions: null,
        id,
        kind,
        name,
        order,
        parentId,
        tags: [],
        updatedAt: timestamp,
        ...overrides,
    };
}

function item(
    id: string,
    name: string,
    quantity: number,
    unit: string,
    category: string,
    locationId: string,
    order: number,
    overrides: Partial<ItemRecord> = {},
): ItemRecord {
    return {
        archivedAt: null,
        category,
        constraints: {
            avoidHumidity: false,
            avoidWarmth: false,
            foodOnly: false,
            keepTogether: null,
            requiredTags: [],
        },
        createdAt: timestamp,
        dimensions: null,
        frequency: "monthly",
        id,
        locationId,
        name,
        notes: "",
        order,
        quantity,
        tags: [],
        unit,
        updatedAt: timestamp,
        version: 1,
        ...overrides,
    };
}

export function createDemoState(workspaceId = "ws_demo"): WorkspaceState {
    const locations: Location[] = [
        location("loc_kitchen", "KIT", "Kitchen", "room", null, 0),
        location("loc_left", "KIT-L", "Left side", "zone", "loc_kitchen", 0),
        location("loc_right", "KIT-R", "Right side", "zone", "loc_kitchen", 1),
        location("loc_food", "C-01", "Food cabinet", "cabinet", "loc_left", 0, {
            conditions: conditions({ dark: true, foodSafe: true }),
            dimensions: { depth: 14, height: 28, unit: "in", width: 30 },
            tags: ["food", "easy-reach"],
        }),
        location("loc_warm", "C-02", "Cabinet above oven", "cabinet", "loc_left", 1, {
            conditions: conditions({ dark: true, foodSafe: true, temperature: "warm" }),
            dimensions: { depth: 12, height: 22, unit: "in", width: 28 },
            tags: ["food"],
        }),
        location("loc_drawer", "D-01", "Prep drawer", "drawer", "loc_left", 2, {
            dimensions: { depth: 18, height: 4, unit: "in", width: 24 },
            tags: ["easy-reach"],
        }),
        location("loc_lower", "C-03", "Lower cabinet", "cabinet", "loc_right", 0, {
            conditions: conditions({ dark: true }),
            dimensions: { depth: 20, height: 30, unit: "in", width: 32 },
        }),
        location("loc_bin", "B-17", "Baking bin", "bin", "loc_lower", 0, {
            dimensions: { depth: 15, height: 8, unit: "in", width: 11 },
            tags: ["baking"],
        }),
        location("loc_counter", "CTR", "Counter", "area", "loc_right", 1, {
            conditions: conditions({ foodSafe: true }),
        }),
        location("loc_corner", "C-04", "Corner cabinet", "cabinet", "loc_right", 2, {
            captureStatus: "in_progress",
            conditions: conditions({ dark: true, foodSafe: true }),
        }),
        location("loc_box", "BX-09", "Appliance parts", "box", "loc_corner", 0, {
            captureStatus: "uncounted",
        }),
    ];

    const items: ItemRecord[] = [
        item("item_pasta", "Pasta", 6, "boxes", "Food", "loc_warm", 0, {
            constraints: {
                avoidHumidity: true,
                avoidWarmth: true,
                foodOnly: true,
                keepTogether: "dry-goods",
                requiredTags: [],
            },
            frequency: "weekly",
            tags: ["dry goods"],
        }),
        item("item_rice", "Rice", 2, "bags", "Food", "loc_food", 0, {
            constraints: {
                avoidHumidity: true,
                avoidWarmth: true,
                foodOnly: true,
                keepTogether: "dry-goods",
                requiredTags: [],
            },
            frequency: "weekly",
            tags: ["dry goods"],
        }),
        item("item_beans", "Canned beans", 8, "cans", "Food", "loc_lower", 0, {
            constraints: {
                avoidHumidity: false,
                avoidWarmth: true,
                foodOnly: true,
                keepTogether: "meal-staples",
                requiredTags: [],
            },
            frequency: "weekly",
        }),
        item("item_flour", "All-purpose flour", 1, "bag", "Baking", "loc_bin", 0, {
            constraints: {
                avoidHumidity: true,
                avoidWarmth: true,
                foodOnly: true,
                keepTogether: "baking",
                requiredTags: [],
            },
            frequency: "monthly",
            tags: ["baking"],
        }),
        item("item_sugar", "Brown sugar", 2, "bags", "Baking", "loc_bin", 1, {
            constraints: {
                avoidHumidity: true,
                avoidWarmth: true,
                foodOnly: true,
                keepTogether: "baking",
                requiredTags: [],
            },
            tags: ["baking"],
        }),
        item("item_spatula", "Silicone spatulas", 4, "each", "Utensils", "loc_drawer", 0, {
            frequency: "daily",
        }),
        item("item_lids", "Replacement blender lids", 3, "each", "Appliance parts", "loc_box", 0, {
            frequency: "rarely",
        }),
        item("item_manuals", "Appliance manuals", 5, "each", "Documents", "loc_box", 1, {
            constraints: {
                avoidHumidity: true,
                avoidWarmth: false,
                foodOnly: false,
                keepTogether: "appliance-parts",
                requiredTags: [],
            },
            frequency: "rarely",
        }),
    ];

    return {
        activities: [],
        audit: [],
        commandReceipts: [],
        items,
        locations,
        plans: [],
        schemaVersion: SCHEMA_VERSION,
        workspace: {
            createdAt: timestamp,
            id: workspaceId,
            name: "Kitchen reset",
            revision: 0,
            updatedAt: timestamp,
        },
    };
}
