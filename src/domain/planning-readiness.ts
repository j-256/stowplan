import {
    DEFAULT_ITEM_CATEGORY,
    DEFAULT_LOCATION_CONDITIONS,
} from "./factories";
import type {
    ItemRecord,
    Location,
    WorkspaceState,
} from "./types";

export type PlanReadinessGap =
    | "capacity"
    | "count"
    | "destination_details"
    | "destinations"
    | "inventory"
    | "item_details"
    | "none";

export type PlanReadinessLevel =
    | "limited"
    | "needs_destinations"
    | "needs_inventory"
    | "ready";

export interface PlanReadiness {
    activeItemIds: string[];
    canGenerateUsefulPlan: boolean;
    countedDestinationIds: string[];
    destinationsUsingDefaultsIds: string[];
    level: PlanReadinessLevel;
    primaryGap: PlanReadinessGap;
    quickDefaultItemIds: string[];
    uncategorizedItemIds: string[];
    uncountedLocationIds: string[];
    unmeasuredDestinationIds: string[];
    unmeasuredItemIds: string[];
}

function isStorageLocation(location: Location): boolean {
    return (
        !location.archivedAt &&
        location.kind !== "area" &&
        location.kind !== "room"
    );
}

function isCounted(location: Location): boolean {
    return (
        location.captureStatus === "counted" ||
        location.captureStatus === "known_empty"
    );
}

function hasExplicitCategory(item: ItemRecord): boolean {
    const category = item.category.trim().toLocaleLowerCase();
    return Boolean(
        category &&
        category !== DEFAULT_ITEM_CATEGORY.toLocaleLowerCase(),
    );
}

function hasPlacementRules(item: ItemRecord): boolean {
    return Boolean(
        item.constraints.avoidHumidity ||
        item.constraints.avoidWarmth ||
        item.constraints.foodOnly ||
        item.constraints.keepTogether?.trim() ||
        item.constraints.requiredTags.length,
    );
}

function usesOnlyDefaultDestinationDetails(location: Location): boolean {
    return (
        location.tags.length === 0 &&
        location.conditions.dark === DEFAULT_LOCATION_CONDITIONS.dark &&
        location.conditions.dry === DEFAULT_LOCATION_CONDITIONS.dry &&
        location.conditions.foodSafe === DEFAULT_LOCATION_CONDITIONS.foodSafe &&
        location.conditions.humidity === DEFAULT_LOCATION_CONDITIONS.humidity &&
        location.conditions.temperature === DEFAULT_LOCATION_CONDITIONS.temperature
    );
}

export function assessPlanReadiness(state: WorkspaceState): PlanReadiness {
    const activeItems = state.items.filter((item) => !item.archivedAt);
    const activeLocations = state.locations.filter((location) => !location.archivedAt);
    const storageLocations = activeLocations.filter(isStorageLocation);
    const countedDestinations = storageLocations.filter(isCounted);
    const uncategorizedItems = activeItems.filter(
        (item) => !hasExplicitCategory(item),
    );
    const quickDefaultItems = activeItems.filter(
        (item) =>
            !hasExplicitCategory(item) &&
            item.frequency === "monthly" &&
            !hasPlacementRules(item),
    );
    const uncountedLocations = activeLocations.filter(
        (location) => !isCounted(location),
    );
    const destinationsUsingDefaults = countedDestinations.filter(
        usesOnlyDefaultDestinationDetails,
    );
    const unmeasuredDestinations = storageLocations.filter(
        (location) => location.dimensions === null,
    );
    const unmeasuredItems = activeItems.filter(
        (item) => item.dimensions === null,
    );
    const canGenerateUsefulPlan = (
        activeItems.length > 0 &&
        countedDestinations.length >= 2
    );

    let primaryGap: PlanReadinessGap = "none";
    if (activeItems.length === 0) primaryGap = "inventory";
    else if (countedDestinations.length < 2) primaryGap = "destinations";
    else if (uncountedLocations.length > 0) primaryGap = "count";
    else if (uncategorizedItems.length > 0) primaryGap = "item_details";
    else if (destinationsUsingDefaults.length > 0) {
        primaryGap = "destination_details";
    } else if (
        unmeasuredDestinations.length > 0 ||
        unmeasuredItems.length > 0
    ) {
        primaryGap = "capacity";
    }

    const level: PlanReadinessLevel = activeItems.length === 0
        ? "needs_inventory"
        : countedDestinations.length < 2
            ? "needs_destinations"
            : primaryGap === "none"
                ? "ready"
                : "limited";

    return {
        activeItemIds: activeItems.map((item) => item.id),
        canGenerateUsefulPlan,
        countedDestinationIds: countedDestinations.map(
            (location) => location.id,
        ),
        destinationsUsingDefaultsIds: destinationsUsingDefaults.map(
            (location) => location.id,
        ),
        level,
        primaryGap,
        quickDefaultItemIds: quickDefaultItems.map((item) => item.id),
        uncategorizedItemIds: uncategorizedItems.map((item) => item.id),
        uncountedLocationIds: uncountedLocations.map(
            (location) => location.id,
        ),
        unmeasuredDestinationIds: unmeasuredDestinations.map(
            (location) => location.id,
        ),
        unmeasuredItemIds: unmeasuredItems.map((item) => item.id),
    };
}
