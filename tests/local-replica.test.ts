import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { createDemoState } from "../src/domain/demo";
import { createEmptyState, createEnvelope, createItem } from "../src/domain/factories";
import {
  activateOrInsertWorkspaceReplica,
  activateWorkspaceReplica,
  canRebaseQueuedCommand,
  clearReplica,
  deleteWorkspaceReplica,
  listWorkspaceReplicas,
  mutateReplica,
  mutateWorkspaceReplica,
  readReplica,
  readWorkspaceReplica,
  reconcileReplica,
  reconciliationTargets,
  replicaVersionMatches,
  replaceReplica,
  replaceReplicaIfUnchanged,
  selectPendingSyncBatch,
  writeReplica,
  writeWorkspaceReplicaIfUnchanged,
} from "../src/client/local-replica";

function reopenFixtureLocation(
  state: ReturnType<typeof createDemoState>,
  locationId: string,
): void {
  const location = state.locations.find(
    (candidate) => candidate.id === locationId,
  );
  if (!location) throw new Error(`Missing fixture location ${locationId}`);
  location.captureStatus = "in_progress";
}

describe("local replica", () => {
  beforeEach(async () => clearReplica());
  it("atomically preserves the workspace and durable outbox", async () => {
    const state = createEmptyState("Offline home", "2026-07-22T00:00:00.000Z");
    await writeReplica({ state, outbox: [], updatedAt: state.workspace.updatedAt });
    expect((await readReplica())?.state.workspace.name).toBe("Offline home");
    expect((await readWorkspaceReplica(state.workspace.id))?.state.workspace.name).toBe("Offline home");
  });
  it("selects pending sync work in bounded original-order batches", () => {
    const state = createEmptyState("Batching");
    const outbox = Array.from({ length: 102 }, (_, index) => ({
      envelope: createEnvelope(state, {
        type: "workspace.rename" as const,
        name: `Name ${index}`,
      }, { id: `cmd_${String(index).padStart(3, "0")}` }),
      status: index === 50 ? "blocked" as const : "pending" as const,
    }));

    const batch = selectPendingSyncBatch(outbox);

    expect(batch).toHaveLength(100);
    expect(batch[0]?.envelope.id).toBe("cmd_000");
    expect(batch.at(-1)?.envelope.id).toBe("cmd_100");
    expect(batch.some((entry) => entry.status === "blocked")).toBe(false);
  });
  it("keeps inactive local workspaces available for switching",async()=>{const first=createEmptyState("First"),second=createEmptyState("Second");await writeReplica({state:first,outbox:[],updatedAt:"2026-07-22T00:00:00.000Z"});await writeReplica({state:second,outbox:[],updatedAt:"2026-07-22T01:00:00.000Z"});expect((await readReplica())?.state.workspace.id).toBe(second.workspace.id);expect((await readWorkspaceReplica(first.workspace.id))?.state.workspace.name).toBe("First");expect((await listWorkspaceReplicas()).map(workspace=>workspace.name)).toEqual(["Second","First"])});
  it("reconciles inactive workspaces that still have pending changes", () => {
    const targets = reconciliationTargets([
      {
        blocked: 0,
        changes: [],
        id: "ws_inactive_pending",
        lastSyncAttemptAt: null,
        lastSyncError: null,
        lastSyncedAt: null,
        name: "Pending",
        pending: 1,
        updatedAt: "2026-07-23T00:00:00.000Z",
      },
      {
        blocked: 0,
        changes: [],
        id: "ws_active",
        lastSyncAttemptAt: null,
        lastSyncError: null,
        lastSyncedAt: null,
        name: "Active",
        pending: 0,
        updatedAt: "2026-07-23T00:00:01.000Z",
      },
      {
        blocked: 1,
        changes: [],
        id: "ws_blocked_only",
        lastSyncAttemptAt: null,
        lastSyncError: "Review required",
        lastSyncedAt: null,
        name: "Blocked",
        pending: 0,
        updatedAt: "2026-07-23T00:00:02.000Z",
      },
    ], "ws_active");

    expect(targets).toEqual([
      { allowEmpty: false, workspaceId: "ws_inactive_pending" },
      { allowEmpty: true, workspaceId: "ws_active" },
    ]);
  });
  it("summarizes server backup state and removes only the selected local replica", async () => {
    const first = createEmptyState("First");
    const second = createEmptyState("Second");
    const envelope = createEnvelope(first, { type: "workspace.rename", name: "First renamed" });
    const firstChanged = applyCommand(first, envelope).state;
    await writeReplica({ state: firstChanged, outbox: [{ envelope, status: "pending" }], lastSyncedAt: "2026-07-22T01:00:00.000Z", updatedAt: "2026-07-22T02:00:00.000Z" });
    await writeReplica({ state: second, outbox: [], updatedAt: "2026-07-22T03:00:00.000Z" });
    const summary = (await listWorkspaceReplicas()).find((workspace) => workspace.id === first.workspace.id);
    expect(summary).toMatchObject({ blocked: 0, lastSyncedAt: "2026-07-22T01:00:00.000Z", pending: 1 });
    expect(summary?.changes[0]).toMatchObject({ label: "Renamed workspace to First renamed", status: "pending" });
    await deleteWorkspaceReplica(first.workspace.id);
    expect(await readWorkspaceReplica(first.workspace.id)).toBeNull();
    expect((await readReplica())?.state.workspace.id).toBe(second.workspace.id);
  });
  it("refuses removal when the workspace changed after the warning was reviewed", async () => {
    const state = createEmptyState("Changing workspace");
    await writeReplica({ state, outbox: [], updatedAt: "before-review" });
    await mutateWorkspaceReplica(state.workspace.id, (current) => ({
      ...current,
      updatedAt: "after-review",
    }));

    await expect(
      deleteWorkspaceReplica(state.workspace.id, "before-review"),
    ).rejects.toThrow(/changed after removal was reviewed/);
    expect(await readWorkspaceReplica(state.workspace.id)).not.toBeNull();
  });
  it("resets only the active workspace and preserves every other local workspace", async () => {
    const personal = createEmptyState("Personal");
    const demo = createEmptyState("Kitchen demo");
    await writeReplica({ state: personal, outbox: [], updatedAt: "2026-07-22T00:00:00.000Z" });
    await writeReplica({ state: demo, outbox: [], updatedAt: "2026-07-22T01:00:00.000Z" });
    const freshDemo = createEmptyState("Fresh kitchen demo");
    await replaceReplica({ state: freshDemo, outbox: [], updatedAt: "2026-07-22T02:00:00.000Z" }, demo.workspace.id);
    expect((await readReplica())?.state.workspace.id).toBe(freshDemo.workspace.id);
    expect(await readWorkspaceReplica(demo.workspace.id)).toBeNull();
    expect((await readWorkspaceReplica(personal.workspace.id))?.state.workspace.name).toBe("Personal");
  });
  it("does not erase a command queued while an earlier batch is in flight",()=>{const initial=createEmptyState("Initial"),first=createEnvelope(initial,{type:"workspace.rename",name:"Server accepted"}),afterFirst=applyCommand(initial,first).state,second=createEnvelope(afterFirst,{type:"workspace.rename",name:"Queued later"}),latest={state:applyCommand(afterFirst,second).state,outbox:[{envelope:first,status:"pending" as const},{envelope:second,status:"pending" as const}],updatedAt:"now"};const reconciled=reconcileReplica(latest,[latest.outbox[0]],afterFirst,[{commandId:first.id,revision:afterFirst.workspace.revision,status:"applied"}]);expect(reconciled.state.workspace.name).toBe("Queued later");expect(reconciled.outbox.map(entry=>entry.envelope.id)).toEqual([second.id])});
  it("keeps rejected local work visible and marks it blocked",()=>{const initial=createEmptyState("Initial"),command=createEnvelope(initial,{type:"workspace.rename",name:"Local edit"}),latest={state:applyCommand(initial,command).state,outbox:[{envelope:command,status:"pending" as const}],updatedAt:"now"};const reconciled=reconcileReplica(latest,latest.outbox,initial,[{commandId:command.id,revision:initial.workspace.revision,status:"rejected",message:"Same field changed remotely"}]);expect(reconciled.state.workspace.name).toBe("Local edit");expect(reconciled.outbox[0]).toMatchObject({status:"blocked",error:"Same field changed remotely"})});
  it("retains a sent command when the server omits its receipt", () => {
    const initial = createEmptyState("Initial");
    const command = createEnvelope(initial, { type: "workspace.rename", name: "Local edit" });
    const latest = {
      state: applyCommand(initial, command).state,
      outbox: [{ envelope: command, status: "pending" as const }],
      updatedAt: "now",
    };
    const reconciled = reconcileReplica(latest, latest.outbox, initial, []);
    expect(reconciled.state.workspace.name).toBe("Local edit");
    expect(reconciled.outbox[0]).toMatchObject({
      status: "blocked",
      error: "The server did not acknowledge this change",
    });
  });
  it("serializes concurrent local mutations without losing an outbox envelope", async () => {
    const initial = createEmptyState("Initial");
    await writeReplica({ state: initial, outbox: [], updatedAt: initial.workspace.updatedAt });
    const update = (name: string, id: string) => mutateReplica((current) => {
      const envelope = createEnvelope(
        current.state,
        { type: "workspace.rename", name },
        { id },
      );
      return {
        ...current,
        state: applyCommand(current.state, envelope).state,
        outbox: [...current.outbox, { envelope, status: "pending" as const }],
        updatedAt: envelope.timestamp,
      };
    });

    await Promise.all([
      update("First concurrent edit", "cmd_concurrent_first"),
      update("Second concurrent edit", "cmd_concurrent_second"),
    ]);

    const result = await readReplica();
    expect(result?.outbox.map((entry) => entry.envelope.id)).toEqual([
      "cmd_concurrent_first",
      "cmd_concurrent_second",
    ]);
    expect(result?.state.workspace.revision).toBe(2);
  });

  it("rebases only commands queued behind known same-tab changes", () => {
    const initial = createEmptyState("Initial");
    const first = createEnvelope(
      initial,
      { type: "workspace.rename", name: "First local edit" },
      { id: "cmd_first_local" },
    );
    const afterFirst = applyCommand(initial, first).state;
    const external = createEnvelope(
      afterFirst,
      { type: "workspace.rename", name: "External edit" },
      { id: "cmd_external" },
    );
    const afterExternal = applyCommand(afterFirst, external).state;

    expect(
      canRebaseQueuedCommand(afterFirst, initial.workspace.revision, [first.id]),
    ).toBe(true);
    expect(
      canRebaseQueuedCommand(afterExternal, initial.workspace.revision, [first.id]),
    ).toBe(false);
    expect(canRebaseQueuedCommand(afterFirst, initial.workspace.revision, [])).toBe(false);
  });

  it("updates an inactive workspace without changing the active workspace", async () => {
    const first = createEmptyState("First");
    const second = createEmptyState("Second");
    await writeReplica({ state: first, outbox: [], updatedAt: first.workspace.updatedAt });
    await writeReplica({ state: second, outbox: [], updatedAt: second.workspace.updatedAt });

    await mutateWorkspaceReplica(first.workspace.id, (current) => ({
      ...current,
      state: {
        ...current.state,
        workspace: { ...current.state.workspace, name: "First updated" },
      },
    }));

    expect((await readReplica())?.state.workspace.id).toBe(second.workspace.id);
    expect((await readWorkspaceReplica(first.workspace.id))?.state.workspace.name).toBe(
      "First updated",
    );
  });

  it("activates the latest workspace-scoped replica atomically", async () => {
    const first = createEmptyState("First");
    const second = createEmptyState("Second");
    await writeReplica({ state: first, outbox: [], updatedAt: first.workspace.updatedAt });
    await writeReplica({ state: second, outbox: [], updatedAt: second.workspace.updatedAt });
    await mutateWorkspaceReplica(first.workspace.id, (current) => ({
      ...current,
      lastSyncError: "Latest workspace metadata",
    }));

    const activated = await activateWorkspaceReplica(first.workspace.id);

    expect(activated?.lastSyncError).toBe("Latest workspace metadata");
    expect((await readReplica())?.state.workspace.id).toBe(first.workspace.id);
  });

  it("ignores an obsolete sync response after its sent batch was already reconciled", () => {
    const initial = createEmptyState("Initial");
    const first = createEnvelope(initial, { type: "workspace.rename", name: "First" });
    const afterFirst = applyCommand(initial, first).state;
    const second = createEnvelope(afterFirst, { type: "workspace.rename", name: "Latest" });
    const latest = {
      state: applyCommand(afterFirst, second).state,
      outbox: [],
      updatedAt: "latest",
    };

    const reconciled = reconcileReplica(
      latest,
      [{ envelope: first, status: "pending" }],
      afterFirst,
      [{ commandId: first.id, revision: 1, status: "applied" }],
    );

    expect(reconciled).toBe(latest);
    expect(reconciled.state.workspace.name).toBe("Latest");
  });

  it("accepts a newer empty-pull snapshot without overwriting confirmed newer local state", () => {
    const initial = createEmptyState("Initial");
    const first = createEnvelope(initial, { type: "workspace.rename", name: "Confirmed local" });
    const latest = {
      state: applyCommand(initial, first).state,
      outbox: [],
      updatedAt: "latest",
    };
    const older = structuredClone(initial);
    const newer = structuredClone(latest.state);
    newer.workspace.revision += 1;
    newer.workspace.name = "Newer server";

    expect(reconcileReplica(latest, [], older, [])).toBe(latest);
    expect(reconcileReplica(latest, [], newer, []).state.workspace.name).toBe(
      "Newer server",
    );
  });
  it("preserves local-change time and compatible legacy state on an empty pull", () => {
    const rawServer = createEmptyState("Legacy server");
    // Build records through factories so every serialized field remains valid.
    const room = {
      archivedAt: "2026-07-22T00:00:00.000Z",
      captureStatus: "counted" as const,
      code: "ROOM",
      conditions: {
        dark: false,
        dry: true,
        foodSafe: false,
        humidity: "normal" as const,
        temperature: "normal" as const,
      },
      createdAt: "2026-07-22T00:00:00.000Z",
      description: "",
      dimensions: null,
      id: "legacy_room",
      kind: "room" as const,
      name: "Legacy room",
      order: 0,
      parentId: null,
      tags: [],
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    const child = { ...room, archivedAt: null, code: "SHELF", id: "legacy_shelf", kind: "shelf" as const, name: "Live shelf", parentId: room.id };
    rawServer.locations.push(room, child);
    const latest = {
      state: structuredClone(rawServer),
      outbox: [],
      updatedAt: "last-real-local-change",
    };

    const reconciled = reconcileReplica(latest, [], rawServer, []);
    expect(reconciled.updatedAt).toBe("last-real-local-change");
    expect(reconciled.state.locations.find((location) => location.id === room.id)?.archivedAt).toBe(room.archivedAt);
  });

  it("normalizes missing v1 item order in a pending create command", async () => {
    const initial = createDemoState();
    reopenFixtureLocation(initial, "loc_food");
    const item = createItem({
      locationId: "loc_food",
      name: "Legacy queued item",
      order: 7,
    });
    const envelope = createEnvelope(initial, { type: "item.create", item });
    const state = applyCommand(initial, envelope).state;
    delete (envelope.command.item as Partial<typeof item>).order;
    await writeReplica({
      state,
      outbox: [{ envelope, status: "pending" }],
      updatedAt: envelope.timestamp,
    });

    const restored = await readReplica();
    expect(
      restored?.outbox[0]?.envelope.command.type === "item.create" &&
      restored.outbox[0].envelope.command.item.order,
    ).toBe(7);
    expect(() =>
      applyCommand(initial, restored!.outbox[0]!.envelope),
    ).not.toThrow();
  });

  it("normalizes an orderless v1 create after a later queued delete removed the item", async () => {
    const initial = createDemoState();
    reopenFixtureLocation(initial, "loc_food");
    const item = createItem({
      locationId: "loc_food",
      name: "Legacy create then delete",
      order: 7,
    });
    const create = createEnvelope(initial, {
      type: "item.create",
      item,
    });
    const afterCreate = applyCommand(initial, create).state;
    const remove = createEnvelope(afterCreate, {
      type: "item.delete",
      id: item.id,
    });
    const finalState = applyCommand(afterCreate, remove).state;
    delete (create.command.item as Partial<typeof item>).order;
    const deleteExpectation = remove.expectations.find(
      (expectation) =>
        expectation.target === "item" &&
        expectation.id === item.id &&
        expectation.path === "",
    );
    delete (
      deleteExpectation?.value as unknown as Record<string, unknown>
    )?.order;
    await writeReplica({
      state: finalState,
      outbox: [
        { envelope: create, status: "pending" },
        { envelope: remove, status: "pending" },
      ],
      updatedAt: remove.timestamp,
    });

    const restored = await readReplica();
    expect(
      restored?.outbox[0]?.envelope.command.type === "item.create" &&
      restored.outbox[0].envelope.command.item.order,
    ).toBe(0);
    let serverState = initial;
    for (const entry of restored!.outbox) {
      serverState = applyCommand(serverState, entry.envelope).state;
    }
    expect(serverState.items.some((candidate) => candidate.id === item.id)).toBe(false);
  });

  it("accepts a legacy pending delete expectation with no item order", async () => {
    const initial = createDemoState();
    reopenFixtureLocation(initial, "loc_warm");
    const envelope = createEnvelope(initial, {
      type: "item.delete",
      id: "item_pasta",
    });
    const wholeItem = envelope.expectations[0]!.value as unknown as Record<string, unknown>;
    delete wholeItem.order;
    const state = applyCommand(initial, envelope).state;
    await writeReplica({
      state,
      outbox: [{ envelope, status: "pending" }],
      updatedAt: envelope.timestamp,
    });

    const restored = await readReplica();
    expect(() =>
      applyCommand(initial, restored!.outbox[0]!.envelope),
    ).not.toThrow();
  });

  it("guards the exact recovery target and preserves the previously active workspace", async () => {
    const target = createEmptyState("Recovery target");
    const previousActive = createEmptyState("Previously active");
    await writeReplica({ state: target, outbox: [], updatedAt: "target-reviewed" });
    const reviewedTarget = await readWorkspaceReplica(target.workspace.id);
    await writeReplica({ state: previousActive, outbox: [], updatedAt: "active-reviewed" });
    const reviewedActive = await readReplica();
    expect(replicaVersionMatches(reviewedActive, reviewedActive)).toBe(true);

    await mutateWorkspaceReplica(target.workspace.id, (current) => ({
      ...current,
      updatedAt: "target-changed",
    }));
    const restoredTarget = {
      state: { ...target, workspace: { ...target.workspace, name: "Restored target" } },
      outbox: [],
      updatedAt: "restored",
    };
    await expect(
      writeWorkspaceReplicaIfUnchanged(
        restoredTarget,
        reviewedTarget,
        reviewedActive,
      ),
    ).rejects.toThrow(/latest data was preserved/);
    expect((await readReplica())?.state.workspace.id).toBe(previousActive.workspace.id);

    const latestTarget = await readWorkspaceReplica(target.workspace.id);
    await writeWorkspaceReplicaIfUnchanged(
      restoredTarget,
      latestTarget,
      reviewedActive,
    );
    expect((await readReplica())?.state.workspace.name).toBe("Restored target");
    expect(
      (await readWorkspaceReplica(previousActive.workspace.id))?.state.workspace.name,
    ).toBe("Previously active");
  });

  it("atomically prefers a concurrently created local workspace over a fetched server copy", async () => {
    const server = createEmptyState("Fetched server");
    const local = structuredClone(server);
    local.workspace.name = "Concurrent local";
    const queued = createEnvelope(local, {
      type: "workspace.rename",
      name: "Concurrent local queued",
    });
    const localState = applyCommand(local, queued).state;
    await writeReplica({
      state: localState,
      outbox: [{ envelope: queued, status: "pending" }],
      updatedAt: "local-newer",
    });

    const activated = await activateOrInsertWorkspaceReplica({
      state: server,
      outbox: [],
      updatedAt: "server-older",
    });

    expect(activated.state.workspace.name).toBe("Concurrent local queued");
    expect(activated.outbox.map((entry) => entry.envelope.id)).toEqual([queued.id]);
  });

  it("aborts a reset when another tab changes the reviewed workspace", async () => {
    const demo = createDemoState();
    await writeReplica({ state: demo, outbox: [], updatedAt: "reviewed" });
    const reviewed = await readReplica();
    await mutateReplica((current) => ({ ...current, updatedAt: "changed-later" }));
    const fresh = createDemoState("ws_fresh_demo");

    await expect(
      replaceReplicaIfUnchanged(
        { state: fresh, outbox: [], updatedAt: "fresh" },
        reviewed!,
      ),
    ).rejects.toThrow(/latest data was preserved/);
    expect((await readReplica())?.updatedAt).toBe("changed-later");
  });
});
