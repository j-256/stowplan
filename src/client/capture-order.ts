import type { Location } from "../domain/types";

export type CaptureDropIntent = "after" | "before" | "inside";

export function nextCaptureLocation<T extends { location: Location }>(
    entries: readonly T[],
    currentId: string,
): Location | undefined {
    const currentIndex = entries.findIndex((entry) => entry.location.id === currentId);
    const ordered = currentIndex < 0
        ? [...entries]
        : [...entries.slice(currentIndex + 1), ...entries.slice(0, currentIndex)];
    return ordered
        .map((entry) => entry.location)
        .find((location) => location.captureStatus !== "counted" && location.captureStatus !== "known_empty");
}

export function captureReorderOrder(
    locations: readonly Location[],
    sourceId: string,
    targetId: string,
    intent: CaptureDropIntent,
): number | null {
    if (sourceId === targetId) return null;
    const source = locations.find((location) => location.id === sourceId);
    const target = locations.find((location) => location.id === targetId);
    if (!source || !target || source.parentId !== target.parentId) return null;

    const siblings = locations
        .filter((location) => location.parentId === source.parentId)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    const sourceIndex = siblings.findIndex((location) => location.id === source.id);
    const targetIndex = siblings.findIndex((location) => location.id === target.id);
    if (sourceIndex < 0 || targetIndex < 0) return null;

    const placeAfter = intent === "after" || (intent === "inside" && sourceIndex < targetIndex);
    const candidates = siblings.filter((location) => location.id !== source.id);
    const destinationIndex = candidates.findIndex((location) => location.id === target.id);
    if (placeAfter) {
        const after = candidates[destinationIndex + 1];
        return after ? (target.order + after.order) / 2 : target.order + 1;
    }
    const before = candidates[destinationIndex - 1];
    return before ? (before.order + target.order) / 2 : target.order - 1;
}
