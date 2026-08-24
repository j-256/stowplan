import { describe, expect, it } from "vitest";
import {
  normalizeCommandEnvelope,
  parseSnapshot,
  validateSnapshot,
} from "../src/domain/import";
import { applyCommand, createDemoState, createEnvelope } from "../src/domain";
import { MemorySnapshotStore } from "../src/server";
import {
  SCHEMA_VERSION,
  type CommandEnvelope,
  type WorkspaceState,
} from "../src/domain/types";

function legacyItemRecord(
  item: Record<string, unknown>,
  notes: string,
): Record<string, unknown> {
  const legacy = structuredClone(item);
  delete legacy.description;
  legacy.notes = notes;
  return legacy;
}

describe("item description migration", () => {
  it("upgrades version 1 items and retained history from notes", () => {
    const legacy = createDemoState() as unknown as Record<string, unknown>;
    const items = legacy.items as Record<string, unknown>[];
    const item = items[0] as Record<string, unknown>;
    const description = "Legacy free-text detail";
    const legacyItem = legacyItemRecord(item, description);
    items[0] = legacyItem;
    legacy.schemaVersion = 1;
    legacy.activities = [{
      actorId: "legacy-user",
      commandId: "legacy-command",
      id: "legacy-activity",
      label: "Updated legacy item",
      patches: [
        {
          after: description,
          before: "",
          id: legacyItem.id,
          path: "notes",
          target: "item",
        },
        {
          after: legacyItem,
          id: legacyItem.id,
          path: "",
          target: "item",
        },
      ],
      status: "applied",
      subjectIds: [legacyItem.id],
      timestamp: "2026-07-01T12:00:00.000Z",
      undoneAt: null,
    }];

    const parsed = parseSnapshot(JSON.stringify(legacy));
    const parsedItem = parsed.items[0] as unknown as Record<string, unknown>;
    const patches = parsed.activities[0]?.patches ?? [];
    const fullRecord = patches.find((patch) => patch.path === "")
      ?.after as Record<string, unknown>;

    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsedItem.description).toBe(description);
    expect(parsedItem).not.toHaveProperty("notes");
    expect(patches.map((patch) => patch.path)).toContain("description");
    expect(patches.map((patch) => patch.path)).not.toContain("notes");
    expect(fullRecord.description).toBe(description);
    expect(fullRecord).not.toHaveProperty("notes");
    expect(validateSnapshot(parsed).filter((issue) =>
      issue.severity === "error"
    )).toEqual([]);
  });

  it("upgrades version 1 states loaded through the snapshot-store port", async () => {
    const legacy = createDemoState() as unknown as Record<string, unknown>;
    const items = legacy.items as Record<string, unknown>[];
    const description = "Persisted adapter detail";
    items[0] = legacyItemRecord(items[0] as Record<string, unknown>, description);
    legacy.schemaVersion = 1;

    const store = new MemorySnapshotStore([legacy as unknown as WorkspaceState]);
    const loaded = await store.load(String(
      (legacy.workspace as Record<string, unknown>).id,
    ));
    const item = loaded?.items[0] as unknown as Record<string, unknown>;

    expect(loaded?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(item.description).toBe(description);
    expect(item).not.toHaveProperty("notes");
  });

  it("upgrades legacy queued item commands and expectations", () => {
    const state = createDemoState();
    const item = state.items[0]!;
    const location = state.locations.find((candidate) =>
      candidate.id === item.locationId
    )!;
    location.captureStatus = "in_progress";
    const description = "Queued offline detail";
    const envelope = createEnvelope(state, {
      type: "item.update",
      id: item.id,
      changes: { notes: description },
    } as never) as unknown as CommandEnvelope;
    envelope.expectations = [{
      id: item.id,
      path: "notes",
      target: "item",
      value: "",
    }];

    const normalized = normalizeCommandEnvelope(envelope) as unknown as {
      command: { changes: Record<string, unknown> };
      expectations: { path: string }[];
    };
    const applied = applyCommand(state, envelope);

    expect(normalized.command.changes).toEqual({ description });
    expect(normalized.expectations).toEqual([
      expect.objectContaining({ path: "description" }),
    ]);
    expect(applied.state.items.find((candidate) => candidate.id === item.id)
      ?.description).toBe(description);
  });

  it("upgrades every legacy item in a queued bulk import", () => {
    const state = createDemoState();
    const location = state.locations.find((candidate) =>
      candidate.id === "loc_corner"
    )!;
    location.captureStatus = "in_progress";
    const first = legacyItemRecord({
      ...state.items[0],
      id: "item_legacy_bulk_first",
      locationId: location.id,
    }, "First imported description");
    const second = legacyItemRecord({
      ...state.items[1],
      id: "item_legacy_bulk_second",
      locationId: location.id,
    }, "Second imported description");
    const envelope = createEnvelope(state, {
      type: "item.bulkCreate",
      items: [first, second],
    } as never);

    const applied = applyCommand(state, envelope);
    expect(applied.state.items.find((item) =>
      item.id === "item_legacy_bulk_first"
    )?.description).toBe("First imported description");
    expect(applied.state.items.find((item) =>
      item.id === "item_legacy_bulk_second"
    )?.description).toBe("Second imported description");
  });
});
