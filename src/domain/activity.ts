import type { FieldPatch } from "./types";

const ITEM_BOOKKEEPING_PATHS = new Set(["updatedAt", "version"]);
const LOCATION_BOOKKEEPING_PATHS = new Set(["updatedAt"]);

export function isActivityBookkeepingPatch(fieldPatch: FieldPatch): boolean {
    if (!fieldPatch.path) return false;
    if (fieldPatch.target === "item") {
        return ITEM_BOOKKEEPING_PATHS.has(fieldPatch.path);
    }
    return fieldPatch.target === "location" &&
        LOCATION_BOOKKEEPING_PATHS.has(fieldPatch.path);
}

export function meaningfulActivityPatches(
    patches: readonly FieldPatch[],
): FieldPatch[] {
    return patches.filter((fieldPatch) =>
        !isActivityBookkeepingPatch(fieldPatch)
    );
}
