import type { PlanSelection, PlanStep, WorkspaceState } from "./types";

export function emptyPlanSelection(): PlanSelection {
    return { locationIds: null, pinnedItemIds: [], pinnedLocationIds: [] };
}

export function validPlanSelection(value: unknown): value is PlanSelection | undefined {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const selection = value as Record<string, unknown>;
    const ids = (list: unknown) => Array.isArray(list) &&
        list.every((id) => typeof id === "string" && Boolean(id.trim())) &&
        new Set(list).size === list.length;
    return Object.keys(selection).every((key) =>
        ["locationIds", "pinnedItemIds", "pinnedLocationIds"].includes(key)
    ) && (selection.locationIds === null || ids(selection.locationIds)) &&
        ids(selection.pinnedItemIds) && ids(selection.pinnedLocationIds);
}

export function planSelectionIssue(state: WorkspaceState, selection: unknown): string | null {
    if (!validPlanSelection(selection)) return "Plan areas and pins are malformed";
    if (!selection) return null;
    const locations = new Set(state.locations.filter((location) => !location.archivedAt).map((location) => location.id));
    const items = new Set(state.items.filter((item) => !item.archivedAt).map((item) => item.id));
    if ([...(selection.locationIds ?? []), ...selection.pinnedLocationIds].some((id) => !locations.has(id))) {
        return "A selected or pinned space is unavailable. Review areas and pins";
    }
    if (selection.pinnedItemIds.some((id) => !items.has(id))) {
        return "A pinned item is unavailable. Review pins";
    }
    return null;
}

export function resolvePlanSelection(state: WorkspaceState, selection?: PlanSelection) {
    const options = selection ?? emptyPlanSelection();
    const locations = state.locations.filter((location) => !location.archivedAt);
    const byId = new Map(locations.map((location) => [location.id, location]));
    const ancestry = (id: string): string[] => {
        const result: string[] = [];
        const seen = new Set<string>();
        let current = byId.get(id);
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            result.push(current.id);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return result;
    };
    const roots = new Set(options.locationIds);
    const pinnedRoots = new Set(options.pinnedLocationIds);
    const paths = new Map(locations.map((location) => [location.id, ancestry(location.id)]));
    const locationIds = new Set(locations.filter((location) => options.locationIds === null ||
        paths.get(location.id)!.some((id) => roots.has(id))
    ).map((location) => location.id));
    const pinnedLocationIds = new Set(locations.filter((location) =>
        paths.get(location.id)!.some((id) => pinnedRoots.has(id))
    ).map((location) => location.id));
    const pinnedItemIds = new Set(options.pinnedItemIds);
    for (const item of state.items) {
        if (pinnedLocationIds.has(item.locationId)) pinnedItemIds.add(item.id);
    }
    const fixedLocationIds = new Set(pinnedLocationIds);
    for (const item of state.items.filter((item) => !item.archivedAt && pinnedItemIds.has(item.id))) {
        ancestry(item.locationId).forEach((id) => fixedLocationIds.add(id));
    }
    for (const id of pinnedRoots) ancestry(id).forEach((ancestor) => fixedLocationIds.add(ancestor));
    for (const root of roots) {
        const path = ancestry(root);
        if (!path.slice(1).some((id) => roots.has(id))) {
            path.forEach((id) => fixedLocationIds.add(id));
        }
    }
    return {
        fixedLocationIds,
        locationIds,
        pinnedItemIds,
        pinnedLocationIds,
        canMoveItem: (id: string, locationId: string) => locationIds.has(locationId) && !pinnedItemIds.has(id),
        canMoveLocation: (id: string, parentId: string | null) => Boolean(parentId &&
            locationIds.has(id) && locationIds.has(parentId) && !fixedLocationIds.has(id)),
        canReceive: (id: string) => locationIds.has(id) && !pinnedLocationIds.has(id),
    };
}

export function planSelectionStepIssue(state: WorkspaceState, selection: PlanSelection | undefined, step: PlanStep): string | null {
    if (!selection) return null;
    const resolved = resolvePlanSelection(state, selection);
    if (!resolved.locationIds.has(step.sourceId) || !resolved.locationIds.has(step.destinationId)) {
        return "A planned move crosses the selected area boundary";
    }
    if (!resolved.canReceive(step.destinationId)) return "A planned move would change a pinned space";
    if (step.type === "item" && step.itemId && !resolved.canMoveItem(step.itemId, step.sourceId)) {
        return "A planned move would change a pinned item placement";
    }
    if (step.type === "location" && step.locationId && !resolved.canMoveLocation(step.locationId, step.sourceId)) {
        return "A planned move would carry a pinned placement or move a selected area root";
    }
    return null;
}
