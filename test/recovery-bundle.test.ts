import { describe, expect, it } from "vitest";
import { parseRecoveryUpload } from "../src/client/recovery-bundle";
import { applyCommand } from "../src/domain/commands";
import { createDemoState } from "../src/domain/demo";
import { createEmptyState, createEnvelope } from "../src/domain/factories";

describe("recovery bundle", () => {
  it("round-trips the exported full-replica shape and preserves queued state", () => {
    const initial = createEmptyState("Recovery source");
    const envelope = createEnvelope(
      initial,
      { type: "workspace.rename", name: "Queued recovery state" },
      { id: "cmd_recovery_round_trip" },
    );
    const state = applyCommand(initial, envelope).state;
    const replica = {
      state,
      outbox: [{ envelope, status: "pending" as const }],
      updatedAt: envelope.timestamp,
    };

    const parsed = parseRecoveryUpload(JSON.stringify({
      format: "stowplan-recovery-v1",
      exportedAt: "2026-07-23T00:00:00.000Z",
      replica,
    }));

    expect(parsed.state.workspace.name).toBe("Queued recovery state");
    expect(parsed.bundle?.outbox[0]?.envelope.id).toBe("cmd_recovery_round_trip");
  });

  it("upgrades legacy item descriptions and queued edits together", () => {
    const initial = createDemoState();
    const item = initial.items[0]!;
    const location = initial.locations.find((candidate) =>
      candidate.id === item.locationId
    )!;
    location.captureStatus = "in_progress";
    const description = "Recovered legacy description";
    const envelope = createEnvelope(initial, {
      type: "item.update",
      id: item.id,
      changes: { description },
    });
    const state = applyCommand(initial, envelope).state;
    const legacyState = state as unknown as Record<string, unknown>;
    const legacyItem = state.items.find((candidate) =>
      candidate.id === item.id
    ) as unknown as Record<string, unknown>;
    legacyState.schemaVersion = 1;
    legacyItem.notes = legacyItem.description;
    delete legacyItem.description;
    if (envelope.command.type !== "item.update") {
      throw new Error("Expected an item update fixture");
    }
    const legacyChanges = envelope.command.changes as unknown as Record<
      string,
      unknown
    >;
    legacyChanges.notes = legacyChanges.description;
    delete legacyChanges.description;
    for (const expectation of envelope.expectations) {
      if (expectation.target === "item" && expectation.path === "description") {
        expectation.path = "notes";
      }
    }

    const parsed = parseRecoveryUpload(JSON.stringify({
      format: "stowplan-recovery-v1",
      exportedAt: "2026-07-23T00:00:00.000Z",
      replica: {
        state,
        outbox: [{ envelope, status: "pending" }],
        updatedAt: envelope.timestamp,
      },
    }));

    expect(parsed.state.items.find((candidate) => candidate.id === item.id)
      ?.description).toBe(description);
    expect(parsed.bundle?.outbox[0]?.envelope.command).toMatchObject({
      changes: { description },
      type: "item.update",
    });
    expect(parsed.bundle?.outbox[0]?.envelope.expectations).toContainEqual(
      expect.objectContaining({ path: "description", target: "item" }),
    );
  });

  it("continues to accept portable snapshot JSON", () => {
    const state = createEmptyState("Portable snapshot");
    const parsed = parseRecoveryUpload(JSON.stringify(state));
    expect(parsed.bundle).toBeNull();
    expect(parsed.state.workspace.name).toBe("Portable snapshot");
  });

  it("rejects malformed full-recovery wrappers", () => {
    expect(() =>
      parseRecoveryUpload(JSON.stringify({
        format: "stowplan-recovery-v1",
        replica: { state: createEmptyState(), outbox: "not-an-array" },
      })),
    ).toThrow(/malformed/);
  });

  it("rejects a queued command whose effect is absent from the saved state", () => {
    const state = createEmptyState("Unapplied queue");
    const envelope = createEnvelope(
      state,
      { type: "workspace.rename", name: "This rename was never applied" },
      { id: "cmd_unapplied_recovery" },
    );

    expect(() =>
      parseRecoveryUpload(JSON.stringify({
        format: "stowplan-recovery-v1",
        exportedAt: "2026-07-23T00:00:00.000Z",
        replica: {
          state,
          outbox: [{ envelope, status: "pending" }],
          updatedAt: envelope.timestamp,
        },
      })),
    ).toThrow(/not represented/);
  });
});
