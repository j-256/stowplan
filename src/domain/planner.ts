import { newId, nowIso } from "./factories";
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

function volume(dimensions: ItemRecord["dimensions"] | Location["dimensions"]): number | null {
    if (!dimensions) return null;
    return dimensions.depth * dimensions.height * dimensions.width;
}

function itemVolume(item: ItemRecord): number {
    return (volume(item.dimensions) ?? 1) * item.quantity;
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

function usedVolume(state: WorkspaceState, locationId: string): number {
    return state.items
        .filter((item) => !item.archivedAt && item.locationId === locationId)
        .reduce((total, item) => total + itemVolume(item), 0);
}

function isStorageLocation(location: Location): boolean {
    return !location.archivedAt && location.kind !== "area" && location.kind !== "room";
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
    const capacity = volume(location.dimensions);
    if (capacity !== null && usedVolumeForCandidate(item, location) > capacity) {
        return "not enough measured capacity";
    }
    return null;
}

function usedVolumeForCandidate(item: ItemRecord, location: Location): number {
    return itemVolume(item) + (location.dimensions ? 0 : 0);
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
            (candidate.category === item.category ||
                (item.constraints.keepTogether &&
                    candidate.constraints.keepTogether === item.constraints.keepTogether)),
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
        const alreadyCounted = item.locationId === location.id ? itemVolume(item) : 0;
        const remaining = capacity - usedVolume(state, location.id) + alreadyCounted - itemVolume(item);
        if (remaining >= 0) {
            score += weights.capacity * Math.min(3, 1 + remaining / Math.max(capacity, 1));
            reasons.push("fits measured capacity");
        } else {
            return {
                hardFailure: "not enough measured capacity",
                reasons: ["Rejected: not enough measured capacity"],
                score: -Infinity,
            };
        }
    } else {
        reasons.push("capacity is unmeasured");
    }

    const distance = moveDistance(state, item.locationId, location.id);
    score -= distance * weights.moveCost;
    if (distance <= 2) reasons.push("short physical move");

    if (location.id === item.locationId) score += weights.moveCost * 3;
    return { hardFailure: null, reasons, score };
}

function descendants(state: WorkspaceState, locationId: string): Set<string> {
    const result = new Set<string>();
    const queue = [locationId];
    while (queue.length) {
        const parent = queue.shift() as string;
        for (const child of state.locations.filter((location) => location.parentId === parent)) {
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
        const scores = items.map((item) => scoreCandidate(state, item, destination, weights));
        if (scores.some((candidate) => candidate.hardFailure)) continue;
        const average = scores.reduce((sum, candidate) => sum + candidate.score, 0) / scores.length;
        const savedMoves = (items.length - 1) * weights.moveCost * 2;
        const combined = average + savedMoves;
        if (!best || combined > best.score) {
            best = {
                destination,
                reasons: [
                    `moves ${items.length} item records as one physical container`,
                    ...scores.flatMap((candidate) => candidate.reasons).slice(0, 2),
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
    const candidates = state.locations.filter(isStorageLocation);
    const steps: PlanStep[] = [];
    const coveredItems = new Set<string>();

    const containers = state.locations
        .filter((location) => isMovableContainer(location) && location.parentId && !location.archivedAt)
        .sort((left, right) => containedItems(state, right.id).length - containedItems(state, left.id).length);
    for (const container of containers) {
        const suggestion = containerStep(state, container, candidates, weights);
        if (!suggestion || suggestion.covered.some((id) => coveredItems.has(id))) continue;
        suggestion.covered.forEach((id) => coveredItems.add(id));
        steps.push(suggestion.step);
    }

    for (const item of state.items.filter((candidate) => !candidate.archivedAt)) {
        if (coveredItems.has(item.id)) continue;
        const current = scoreCandidate(
            state,
            item,
            state.locations.find((location) => location.id === item.locationId) as Location,
            weights,
        );
        const ranked = candidates
            .filter((location) => location.id !== item.locationId)
            .map((location) => ({ location, result: scoreCandidate(state, item, location, weights) }))
            .filter((candidate) => !candidate.result.hardFailure)
            .sort((left, right) => right.result.score - left.result.score);
        const best = ranked[0];
        if (!best || best.result.score <= current.score + weights.moveCost) continue;
        steps.push({
            completedAt: null,
            destinationId: best.location.id,
            explanation: best.result.reasons,
            id: newId("step"),
            itemId: item.id,
            locationId: null,
            quantity: item.quantity,
            score: Math.round(best.result.score * 10) / 10,
            sourceId: item.locationId,
            type: "item",
        });
    }

    steps.sort((left, right) => right.score - left.score);
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
