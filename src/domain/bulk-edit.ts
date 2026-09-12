import { applyCommand } from "./commands";
import { DomainError } from "./errors";
import { createEnvelope } from "./factories";
import type {
    Command,
    FieldExpectation,
    FieldPatch,
    Frequency,
    ItemBulkChanges,
    ItemConstraints,
    ItemRecord,
    Location,
    WorkspaceState,
} from "./types";

export type TagEditMode = "keep" | "add" | "remove" | "replace" | "clear";
export interface TagEdit { mode: TagEditMode; text: string }
export interface BulkEditDraft {
    category: string | null;
    constraints: Partial<Omit<ItemConstraints, "requiredTags">>;
    frequency: Frequency | null;
    requiredTags: TagEdit;
    tags: TagEdit;
}
export type BulkUpdateCommand = Extract<Command, { type: "item.bulkUpdate" }>;
export interface BulkEditPreview {
    command: BulkUpdateCommand | null;
    completedLocations: Location[];
    discardedPlanCount: number;
    expectations: FieldExpectation[];
    items: { item: ItemRecord; patches: FieldPatch[] }[];
    unchangedCount: number;
}

const PREVIEW_COMMAND_ID = "cmd_bulk_edit_preview";
const PREVIEW_TIMESTAMP = "2000-01-01T00:00:00.000Z";

export function emptyBulkEditDraft(): BulkEditDraft {
    return {
        category: null,
        constraints: {},
        frequency: null,
        requiredTags: { mode: "keep", text: "" },
        tags: { mode: "keep", text: "" },
    };
}

function editTags(current: string[], edit: TagEdit): string[] {
    if (edit.mode === "keep") return current;
    if (edit.mode === "clear") return [];
    const tags = [...new Set(edit.text.split(",").map((tag) => tag.trim()).filter(Boolean))];
    if (!tags.length) throw new DomainError("TAGS_REQUIRED", "Enter comma-separated tags, or choose Clear all tags");
    if (edit.mode === "add") return [...new Set([...current, ...tags])];
    if (edit.mode === "remove") return current.filter((tag) => !tags.includes(tag));
    if (edit.mode === "replace") return tags;
    throw new DomainError("INVALID_TAG_EDIT", "Choose how to change the tags");
}

export function planBulkEdit(
    state: WorkspaceState,
    itemIds: readonly string[],
    draft: BulkEditDraft,
): BulkEditPreview {
    if (!itemIds.length) throw new DomainError("EMPTY_BULK_UPDATE", "Select at least one item to edit");
    if (new Set(itemIds).size !== itemIds.length) throw new DomainError("DUPLICATE_ITEM_ID", "Edited item IDs must be unique");
    const category = draft.category?.trim();
    if (draft.category !== null && !category) throw new DomainError("CATEGORY_REQUIRED", "Enter a category or leave existing categories unchanged");
    const constraints = { ...draft.constraints };
    if (typeof constraints.keepTogether === "string") {
        constraints.keepTogether = constraints.keepTogether.trim();
        if (!constraints.keepTogether) throw new DomainError("GROUP_REQUIRED", "Enter a group or choose Clear group");
    }
    const byId = new Map(state.items.map((item) => [item.id, item]));
    const updates = itemIds.flatMap((id) => {
        const item = byId.get(id);
        const location = state.locations.find((candidate) => candidate.id === item?.locationId);
        if (!item || item.archivedAt || !location || location.archivedAt) {
            throw new DomainError("SELECTION_CHANGED", "A selected item or its space is no longer available. Close this editor and select the items again");
        }
        const changes: ItemBulkChanges = {};
        if (category !== undefined && category !== item.category) changes.category = category;
        if (draft.frequency !== null && draft.frequency !== item.frequency) changes.frequency = draft.frequency;
        const tags = editTags(item.tags, draft.tags);
        if (JSON.stringify(tags) !== JSON.stringify(item.tags)) changes.tags = tags;
        const nextConstraints: Partial<ItemConstraints> = Object.fromEntries(
            Object.entries(constraints).filter(([key, value]) => value !== item.constraints[key as keyof ItemConstraints]),
        );
        const requiredTags = editTags(item.constraints.requiredTags, draft.requiredTags);
        if (JSON.stringify(requiredTags) !== JSON.stringify(item.constraints.requiredTags)) nextConstraints.requiredTags = requiredTags;
        if (Object.keys(nextConstraints).length) changes.constraints = nextConstraints;
        return Object.keys(changes).length ? [{ id, changes }] : [];
    });
    if (!updates.length) return {
        command: null, completedLocations: [], discardedPlanCount: 0,
        expectations: [], items: [], unchangedCount: itemIds.length,
    };
    const locationIds = new Set(updates.map(({ id }) => byId.get(id)!.locationId));
    const completedLocations = state.locations.filter((location) =>
        locationIds.has(location.id) && (location.captureStatus === "counted" || location.captureStatus === "known_empty")
    );
    const command: BulkUpdateCommand = {
        type: "item.bulkUpdate", updates,
        ...(completedLocations.length ? { reopenCompletedParents: true } : {}),
    };
    const envelope = createEnvelope(state, command, { id: PREVIEW_COMMAND_ID, timestamp: PREVIEW_TIMESTAMP });
    const result = applyCommand(state, envelope);
    const patches = result.activity!.patches;
    return {
        command,
        completedLocations,
        discardedPlanCount: patches.filter((patch) => patch.target === "plan" && patch.path === "status").length,
        expectations: envelope.expectations,
        items: updates.map(({ id }) => ({
            item: byId.get(id)!,
            patches: patches.filter((patch) => patch.target === "item" && patch.id === id),
        })),
        unchangedCount: itemIds.length - updates.length,
    };
}
