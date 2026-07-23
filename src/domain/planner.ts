import { DEFAULT_ITEM_CATEGORY, newId, nowIso } from "./factories";
import type {
    ItemRecord,
    Location,
    MovePlan,
    PlanStep,
    PlanWeights,
    WorkspaceState,
} from "./types";

export const DEFAULT_PLAN_WEIGHTS: PlanWeights = {
    accessibility: 4,
    capacity: 3,
    grouping: 4,
    moveCost: 2,
    suitability: 5,
};

const frequencyValue: Record<ItemRecord["frequency"], number> = {
    daily: 4,
    monthly: 2,
    rarely: 1,
    weekly: 3,
};

interface CandidateScore {
    hardFailure: string | null;
    reasons: string[];
    score: number;
}

function normalizedGroupingValue(value: string | null): string | null {
    const normalized = value?.trim().toLowerCase() ?? "";
    return normalized ? normalized : null;
}

function explicitCategory(item: ItemRecord): string | null {
    const category = normalizedGroupingValue(item.category);
    return category === DEFAULT_ITEM_CATEGORY.toLowerCase() ? null : category;
}

function recordsAreRelated(item: ItemRecord, candidate: ItemRecord): boolean {
    const category = explicitCategory(item);
    const keepTogether = normalizedGroupingValue(item.constraints.keepTogether);
    return Boolean(
        (category && explicitCategory(candidate) === category) ||
        (
            keepTogether &&
            normalizedGroupingValue(candidate.constraints.keepTogether) === keepTogether
        ),
    );
}

function volume(dimensions: ItemRecord["dimensions"] | Location["dimensions"]): number | null {
    if (!dimensions) return null;
    const centimetersPerUnit = dimensions.unit === "in" ? 2.54 : 1;
    const result = (
        dimensions.depth *
        dimensions.height *
        dimensions.width *
        centimetersPerUnit ** 3
    );
    return Number.isFinite(result) ? result : null;
}

function itemVolume(item: ItemRecord): number | null {
    const perUnit = volume(item.dimensions);
    if (perUnit === null) return null;
    const result = perUnit * item.quantity;
    return Number.isFinite(result) ? result : null;
}

function locationDepth(state: WorkspaceState, locationId: string): number {
    let depth = 0;
    let current = state.locations.find((location) => location.id === locationId);
    const seen = new Set<string>();
    while (current?.parentId) {
        if (seen.has(current.id)) return 100;
        seen.add(current.id);
        depth += 1;
        current = state.locations.find((location) => location.id === current?.parentId);
    }
    return depth;
}

function ancestors(state: WorkspaceState, locationId: string): string[] {
    const result: string[] = [];
    let current = state.locations.find((location) => location.id === locationId);
    const seen = new Set<string>();
    while (current) {
        if (seen.has(current.id)) break;
        seen.add(current.id);
        result.push(current.id);
        current = current.parentId
            ? state.locations.find((location) => location.id === current?.parentId)
            : undefined;
    }
    return result;
}

function moveDistance(state: WorkspaceState, sourceId: string, destinationId: string): number {
    const source = ancestors(state, sourceId);
    const destination = ancestors(state, destinationId);
    const common = source.find((id) => destination.includes(id));
    if (!common) return source.length + destination.length;
    return source.indexOf(common) + destination.indexOf(common);
}

function usedVolume(state: WorkspaceState, locationId: string): number | null {
    const occupiedLocationIds = descendants(state, locationId);
    occupiedLocationIds.add(locationId);
    const volumes = state.items
        .filter((item) => !item.archivedAt && occupiedLocationIds.has(item.locationId))
        .map(itemVolume);
    if (volumes.some((candidate) => candidate === null)) return null;
    const total = volumes.reduce<number>((sum, candidate) => sum + (candidate ?? 0), 0);
    return Number.isFinite(total) ? total : null;
}

function isStorageLocation(location: Location): boolean {
    return (
        !location.archivedAt &&
        (location.captureStatus === "counted" ||
            location.captureStatus === "known_empty") &&
        location.kind !== "area" &&
        location.kind !== "room"
    );
}

function isMovableContainer(location: Location): boolean {
    return location.kind === "bin" || location.kind === "box" || location.kind === "container";
}

function hardFailure(item: ItemRecord, location: Location): string | null {
    if (item.constraints.avoidWarmth && location.conditions.temperature === "warm") {
        return "too warm";
    }
    if (item.constraints.avoidHumidity && location.conditions.humidity === "humid") {
        return "too humid";
    }
    if (item.constraints.foodOnly && !location.conditions.foodSafe) {
        return "not marked food-safe";
    }
    const missingTag = item.constraints.requiredTags.find((tag) => !location.tags.includes(tag));
    if (missingTag) return `missing required ${missingTag} tag`;
    return null;
}

function scoreCandidate(
    state: WorkspaceState,
    item: ItemRecord,
    location: Location,
    weights: PlanWeights,
): CandidateScore {
    const failure = hardFailure(item, location);
    if (failure) return { hardFailure: failure, reasons: [`Rejected: ${failure}`], score: -Infinity };

    const reasons: string[] = [];
    let score = weights.suitability * 2;

    if (item.constraints.foodOnly && location.conditions.foodSafe) {
        score += weights.suitability * 2;
        reasons.push("food-safe area");
    }
    if (item.constraints.avoidWarmth && location.conditions.temperature !== "warm") {
        score += weights.suitability;
        reasons.push("avoids warm storage");
    }
    if (item.constraints.avoidHumidity && location.conditions.humidity !== "humid") {
        score += weights.suitability;
        reasons.push("avoids humidity");
    }

    const nearbyPeers = state.items.filter(
        (candidate) =>
            candidate.id !== item.id &&
            !candidate.archivedAt &&
            candidate.locationId === location.id &&
            recordsAreRelated(item, candidate),
    ).length;
    if (nearbyPeers) {
        score += Math.min(nearbyPeers, 4) * weights.grouping;
        reasons.push(`groups with ${nearbyPeers} related record${nearbyPeers === 1 ? "" : "s"}`);
    }

    const depth = locationDepth(state, location.id);
    const accessNeed = frequencyValue[item.frequency];
    const accessScore = Math.max(0, 5 - depth) * accessNeed;
    score += accessScore * weights.accessibility * 0.25;
    if (item.frequency === "daily" || item.frequency === "weekly") {
        reasons.push(`${item.frequency} access at depth ${depth}`);
    }

    const capacity = volume(location.dimensions);
    if (capacity !== null) {
        const candidateVolume = itemVolume(item);
        const occupiedVolume = usedVolume(state, location.id);
        if (candidateVolume === null || occupiedVolume === null) {
            reasons.push("capacity cannot be verified because some item sizes are unmeasured");
        } else {
            const alreadyCounted = ancestors(state, item.locationId).includes(location.id)
                ? candidateVolume
                : 0;
            const remaining = capacity - occupiedVolume + alreadyCounted - candidateVolume;
            if (remaining < 0) {
                return {
                    hardFailure: "not enough measured capacity",
                    reasons: ["Rejected: not enough measured capacity"],
                    score: -Infinity,
                };
            }
            score += weights.capacity * Math.min(3, 1 + remaining / Math.max(capacity, 1));
            reasons.push("fits measured capacity");
        }
    } else {
        reasons.push("capacity is unmeasured");
    }

    const distance = moveDistance(state, item.locationId, location.id);
    score -= distance * weights.moveCost;
    if (distance <= 2) reasons.push("short physical move");

    if (location.id === item.locationId) score += weights.moveCost * 3;
    return Number.isFinite(score)
        ? { hardFailure: null, reasons, score }
        : {
              hardFailure: "numeric capacity or priority overflow",
              reasons: ["Rejected: numeric capacity or priority overflow"],
              score: -Infinity,
          };
}

function descendants(state: WorkspaceState, locationId: string): Set<string> {
    const result = new Set<string>();
    const queue = [locationId];
    while (queue.length) {
        const parent = queue.shift() as string;
        for (const child of state.locations.filter((location) => location.parentId === parent)) {
            if (child.id === locationId || result.has(child.id)) continue;
            result.add(child.id);
            queue.push(child.id);
        }
    }
    return result;
}

function containedItems(state: WorkspaceState, locationId: string): ItemRecord[] {
    const locationIds = descendants(state, locationId);
    locationIds.add(locationId);
    return state.items.filter((item) => !item.archivedAt && locationIds.has(item.locationId));
}

function containerStep(
    state: WorkspaceState,
    container: Location,
    candidates: Location[],
    weights: PlanWeights,
): { covered: string[]; step: PlanStep } | null {
    if (!container.parentId) return null;
    const items = containedItems(state, container.id);
    if (items.length < 2) return null;
    const blocked = descendants(state, container.id);
    blocked.add(container.id);

    const currentScores = items.map((item) => scoreCandidate(state, item, container, weights).score);
    const currentAverage = currentScores.reduce((sum, value) => sum + value, 0) / items.length;
    let best: { destination: Location; reasons: string[]; score: number } | null = null;

    for (const destination of candidates) {
        if (blocked.has(destination.id) || destination.id === container.parentId) continue;
        const destinationCapacity = volume(destination.dimensions);
        const destinationLocations = descendants(state, destination.id);
        destinationLocations.add(destination.id);
        const incomingVolumes = items
            .filter((item) => !destinationLocations.has(item.locationId))
            .map(itemVolume);
        const occupiedVolume = destinationCapacity === null
            ? null
            : usedVolume(state, destination.id);
        const capacityIsUncertain = destinationCapacity !== null &&
            (
                occupiedVolume === null ||
                incomingVolumes.some((candidate) => candidate === null)
            );
        if (destinationCapacity !== null) {
            if (
                occupiedVolume !== null &&
                !incomingVolumes.some((candidate) => candidate === null) &&
                occupiedVolume +
                    incomingVolumes.reduce<number>(
                        (total, candidate) => total + (candidate ?? 0),
                        0,
                    ) >
                    destinationCapacity
            ) {
                continue;
            }
        }
        const scores = items.map((item) => scoreCandidate(state, item, destination, weights));
        if (scores.some((candidate) => candidate.hardFailure)) continue;
        if (
            scores.some(
                (candidate, index) => candidate.score < (currentScores[index] ?? -Infinity),
            )
        ) {
            continue;
        }
        const average = scores.reduce((sum, candidate) => sum + candidate.score, 0) / scores.length;
        if (!Number.isFinite(average) || average <= currentAverage) continue;
        const savedMoves = (items.length - 1) * weights.moveCost * 2;
        const combined = average + savedMoves;
        if (!Number.isFinite(combined)) continue;
        if (!best || combined > best.score) {
            const reasons = [...new Set(scores.flatMap((candidate) => candidate.reasons))];
            best = {
                destination,
                reasons: [
                    `moves ${items.length} item records as one physical container`,
                    ...(capacityIsUncertain
                        ? ["capacity cannot be verified because some item sizes are unmeasured"]
                        : []),
                    ...reasons.filter(
                        (reason) =>
                            !capacityIsUncertain ||
                            reason !== "capacity cannot be verified because some item sizes are unmeasured",
                    ).slice(0, 2),
                ],
                score: combined,
            };
        }
    }

    if (!best || best.score <= currentAverage + weights.moveCost * 2) return null;
    return {
        covered: items.map((item) => item.id),
        step: {
            completedAt: null,
            destinationId: best.destination.id,
            explanation: best.reasons,
            id: newId("step"),
            itemId: null,
            locationId: container.id,
            quantity: null,
            score: Math.round(best.score * 10) / 10,
            sourceId: container.parentId,
            type: "location",
        },
    };
}

export function generatePlan(
    state: WorkspaceState,
    options: { name?: string; weights?: PlanWeights } = {},
): MovePlan {
    const weights = options.weights ?? DEFAULT_PLAN_WEIGHTS;
    const projected = structuredClone(state);
    const steps: PlanStep[] = [];
    const coveredItems = new Set<string>();
    const plannedItems = new Set<string>();

    const containers = projected.locations
        .filter(
            (location) =>
                isMovableContainer(location) &&
                location.captureStatus === "counted" &&
                location.parentId &&
                !location.archivedAt,
        )
        .sort(
            (left, right) =>
                containedItems(projected, right.id).length -
                containedItems(projected, left.id).length,
        );
    for (const container of containers) {
        const suggestion = containerStep(
            projected,
            container,
            projected.locations.filter(isStorageLocation),
            weights,
        );
        if (!suggestion || suggestion.covered.some((id) => coveredItems.has(id))) continue;
        suggestion.covered.forEach((id) => coveredItems.add(id));
        steps.push(suggestion.step);
        container.parentId = suggestion.step.destinationId;
    }

    let plannedInPass = true;
    while (plannedInPass) {
        plannedInPass = false;
        for (const item of projected.items.filter((candidate) => !candidate.archivedAt)) {
            if (coveredItems.has(item.id) || plannedItems.has(item.id)) continue;
            const currentLocation = projected.locations.find(
                (location) => location.id === item.locationId,
            );
            if (!currentLocation) continue;
            const current = scoreCandidate(
                projected,
                item,
                currentLocation,
                weights,
            );
            const ranked = projected.locations
                .filter(isStorageLocation)
                .filter((location) => location.id !== item.locationId)
                .map((location) => ({
                    location,
                    result: scoreCandidate(projected, item, location, weights),
                }))
                .filter((candidate) => !candidate.result.hardFailure)
                .sort((left, right) => right.result.score - left.result.score);
            const best = ranked[0];
            if (!best || best.result.score <= current.score + weights.moveCost) continue;
            const sourceId = item.locationId;
            steps.push({
                completedAt: null,
                destinationId: best.location.id,
                explanation: best.result.reasons,
                id: newId("step"),
                itemId: item.id,
                locationId: null,
                quantity: item.quantity,
                score: Math.round(best.result.score * 10) / 10,
                sourceId,
                type: "item",
            });
            plannedItems.add(item.id);
            plannedInPass = true;
            item.locationId = best.location.id;
        }
    }

    const timestamp = nowIso();
    return {
        createdAt: timestamp,
        id: newId("plan"),
        name: options.name?.trim() || `Organization plan · ${new Date(timestamp).toLocaleDateString()}`,
        status: "active",
        steps,
        weights: { ...weights },
    };
}
