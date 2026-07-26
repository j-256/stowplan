import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { createDemoState } from "../src/domain/demo";
import { createEmptyState, createEnvelope, createItem } from "../src/domain/factories";
import {
  activateOrInsertServerWorkspaceReplica,
  activateOrInsertWorkspaceReplica,
  activateWorkspaceReplica,
  canRebaseQueuedCommand,
  clearReplica,
  clearActiveServerWorkspaceCatalogAccount,
  deleteServerWorkspaceCatalog,
  deleteWorkspaceReplica,
  listWorkspaceReplicas,
  mergeServerWorkspaceCatalog,
  mutateReplica,
  mutateWorkspaceReplica,
  mutateWorkspaceReplicaIfWritable,
  normalizeLocalReplica,
  readActiveServerWorkspaceCatalogAccount,
  readReplica,
  readServerWorkspaceCatalog,
  readWorkspaceReplica,
  reconcileReplica,
  reconciliationTargets,
  replicaVersionMatches,
  replaceReplica,
  replaceReplicaIfUnchanged,
  selectPendingSyncBatch,
  setActiveServerWorkspaceCatalogAccount,
  writeReplica,
  writeServerWorkspaceCatalog,
  writeServerWorkspaceCatalogIfUnchanged,
  writeWorkspaceAuthorizationIfUnchanged,
  writeWorkspaceReplicaIfUnchanged,
} from "../src/client/local-replica";
import {
  capabilitiesForWorkspaceRole,
  serverWorkspaceAccess,
  type ServerWorkspaceSummary,
  type WorkspaceRole,
} from "../src/domain/workspace-access";

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

function serverSummary(
  state: ReturnType<typeof createEmptyState>,
  role: WorkspaceRole = "editor",
  options: Partial<ServerWorkspaceSummary> = {},
): ServerWorkspaceSummary {
  return {
    accessRevision: 2,
    capabilities: capabilitiesForWorkspaceRole(role, true),
    id: state.workspace.id,
    membershipRevision: 4,
    name: state.workspace.name,
    revision: state.workspace.revision,
    role,
    updatedAt: state.workspace.updatedAt,
    ...options,
  };
}

describe("local replica", () => {
  beforeEach(async () => clearReplica());
  it("atomically preserves the workspace and durable outbox", async () => {
    const state = createEmptyState("Offline home", "2026-07-22T00:00:00.000Z");
    await writeReplica({ state, outbox: [], updatedAt: state.workspace.updatedAt });
    expect((await readReplica())?.state.workspace.name).toBe("Offline home");
    expect((await readWorkspaceReplica(state.workspace.id))?.state.workspace.name).toBe("Offline home");
  });
  it("normalizes legacy replicas without changing snapshot version 1", async () => {
    const state = createEmptyState("Legacy local");
    await writeReplica({
      state,
      outbox: [],
      updatedAt: state.workspace.updatedAt,
    });

    const restored = await readReplica();

    expect(restored?.authorization).toMatchObject({
      kind: "device-only",
      role: "owner",
      status: "active",
    });
    expect(restored?.authorization?.capabilities.write).toBe(true);
    expect(restored?.serverSummary).toBeNull();
    expect(restored?.state.schemaVersion).toBe(1);
  });
  it("clears a legacy sign-in failure from device-only replicas", () => {
    const state = createEmptyState("Local workspace");
    const replica = normalizeLocalReplica({
      lastSyncError: "Sign in to back up this workspace.",
      outbox: [],
      state,
      updatedAt: state.workspace.updatedAt,
    });

    expect(replica.lastSyncError).toBeNull();
    expect(replica.authorization?.kind).toBe("device-only");
  });
  it("enumerates workspace records once and ignores a stale active alias", async () => {
    const canonical = createEmptyState("Canonical");
    await writeReplica({
      state: canonical,
      outbox: [],
      updatedAt: "canonical",
    });
    const stale = structuredClone(canonical);
    stale.workspace.name = "Stale active alias";
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("stowplan-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      transaction.objectStore("records").put({
        state: stale,
        outbox: [],
        updatedAt: "stale",
      }, "active");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();

    const summaries = await listWorkspaceReplicas();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBe("Canonical");
  });
  it("stores bounded server catalogs by account without polluting replicas", async () => {
    const first = createEmptyState("First remote");
    const second = createEmptyState("Second remote");
    const firstPage = mergeServerWorkspaceCatalog(null, {
      accountId: "user_first",
      entries: [serverSummary(first)],
      fetchedAt: "2026-07-25T00:00:00.000Z",
      hasMore: true,
      membershipRevision: 4,
      nextCursor: "next-page",
    }, true);
    const complete = mergeServerWorkspaceCatalog(firstPage, {
      accountId: "user_first",
      entries: [serverSummary(second)],
      fetchedAt: "2026-07-25T00:01:00.000Z",
      hasMore: false,
      membershipRevision: 4,
      nextCursor: null,
    });
    const otherAccount = mergeServerWorkspaceCatalog(null, {
      accountId: "user_second",
      entries: [serverSummary(second)],
      fetchedAt: "2026-07-25T00:02:00.000Z",
      hasMore: false,
      membershipRevision: 4,
      nextCursor: null,
    }, true);
    await writeServerWorkspaceCatalog(complete);
    await writeServerWorkspaceCatalog(otherAccount);

    const firstCatalog = await readServerWorkspaceCatalog("user_first");
    expect(firstCatalog).toMatchObject({
      complete: true,
      hasMore: false,
      nextCursor: null,
    });
    expect(firstCatalog?.entries.map((entry) => entry.id).sort()).toEqual(
      [first.workspace.id, second.workspace.id].sort(),
    );
    expect(await readServerWorkspaceCatalog("user_second")).toMatchObject({
      entries: [{ id: second.workspace.id }],
    });
    expect(await listWorkspaceReplicas()).toEqual([]);

    await deleteServerWorkspaceCatalog("user_first");
    expect(await readServerWorkspaceCatalog("user_first")).toBeNull();
    expect(await readServerWorkspaceCatalog("user_second")).not.toBeNull();
  });
  it("refuses a stale catalog compare-and-swap", async () => {
    const state = createEmptyState("Catalog workspace");
    const initial = mergeServerWorkspaceCatalog(null, {
      accountId: "user_catalog",
      entries: [serverSummary(state)],
      fetchedAt: "2026-07-25T00:00:00.000Z",
      hasMore: false,
      membershipRevision: 4,
      nextCursor: null,
    }, true);
    await writeServerWorkspaceCatalog(initial);
    const reviewed = await readServerWorkspaceCatalog("user_catalog");
    const concurrent = mergeServerWorkspaceCatalog(reviewed, {
      accountId: "user_catalog",
      entries: [serverSummary(state, "viewer", {
        accessRevision: 3,
        membershipRevision: 5,
      })],
      fetchedAt: "2026-07-25T00:01:00.000Z",
      hasMore: false,
      membershipRevision: 5,
      nextCursor: null,
    }, true);
    await writeServerWorkspaceCatalog(concurrent);
    const stale = mergeServerWorkspaceCatalog(reviewed, {
      accountId: "user_catalog",
      entries: [],
      fetchedAt: "2026-07-25T00:02:00.000Z",
      hasMore: false,
      membershipRevision: 4,
      nextCursor: null,
    }, true);

    await expect(
      writeServerWorkspaceCatalogIfUnchanged(stale, reviewed),
    ).rejects.toThrow(/changed while it was being refreshed/);
    expect(
      (await readServerWorkspaceCatalog("user_catalog"))?.entries[0]?.role,
    ).toBe("viewer");
  });
  it("does not regress a catalog entry during a replacement refresh", () => {
    const state = createEmptyState("Catalog revision");
    const current = mergeServerWorkspaceCatalog(null, {
      accountId: "user_catalog",
      entries: [serverSummary(state, "viewer", {
        accessRevision: 5,
        membershipRevision: 7,
        revision: 9,
      })],
      fetchedAt: "2026-07-25T00:02:00.000Z",
      hasMore: false,
      membershipRevision: 7,
      nextCursor: null,
    }, true);

    const replaced = mergeServerWorkspaceCatalog(current, {
      accountId: "user_catalog",
      entries: [serverSummary(state, "editor", {
        accessRevision: 4,
        membershipRevision: 6,
        revision: 8,
      })],
      fetchedAt: "2026-07-25T00:01:00.000Z",
      hasMore: false,
      membershipRevision: 6,
      nextCursor: null,
    }, true);

    expect(replaced.entries[0]).toMatchObject({
      accessRevision: 5,
      membershipRevision: 7,
      revision: 9,
      role: "viewer",
    });
  });
  it("accepts authoritative capability changes at the same catalog version", () => {
    const state = createEmptyState("Catalog capabilities");
    const current = mergeServerWorkspaceCatalog(null, {
      accountId: "user_catalog",
      entries: [serverSummary(state, "owner", {
        capabilities: capabilitiesForWorkspaceRole("owner", true),
      })],
      fetchedAt: "2026-07-25T00:00:00.000Z",
      hasMore: false,
      membershipRevision: 4,
      nextCursor: null,
    }, true);
    const capabilities = capabilitiesForWorkspaceRole("owner", false);
    const refreshed = mergeServerWorkspaceCatalog(current, {
      accountId: "user_catalog",
      entries: [serverSummary(state, "owner", { capabilities })],
      fetchedAt: "2026-07-25T00:01:00.000Z",
      hasMore: false,
      membershipRevision: 4,
      nextCursor: null,
    }, true);

    expect(refreshed.entries[0]?.capabilities).toEqual(capabilities);
  });
  it("clears the active catalog account without deleting cached catalogs", async () => {
    const state = createEmptyState("Cached after sign out");
    const catalog = mergeServerWorkspaceCatalog(null, {
      accountId: "user_cached",
      entries: [serverSummary(state)],
      fetchedAt: "2026-07-25T00:00:00.000Z",
      hasMore: false,
      membershipRevision: 4,
      nextCursor: null,
    }, true);
    await writeServerWorkspaceCatalog(catalog);
    await setActiveServerWorkspaceCatalogAccount(" user_cached ");

    expect(await readActiveServerWorkspaceCatalogAccount()).toBe(
      "user_cached",
    );

    await clearActiveServerWorkspaceCatalogAccount();

    expect(await readActiveServerWorkspaceCatalogAccount()).toBeNull();
    expect(await readServerWorkspaceCatalog("user_cached")).toMatchObject({
      entries: [{ id: state.workspace.id }],
    });
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
  it("never sends pending work under another signed-in account", () => {
    const state = createEmptyState("Account batches");
    const queued = {
      accountId: "user_a",
      envelope: createEnvelope(state, {
        type: "workspace.rename",
        name: "Account A change",
      }),
      status: "pending" as const,
    };

    expect(selectPendingSyncBatch([queued], "user_a")).toEqual([
      queued,
    ]);
    expect(selectPendingSyncBatch([queued], "user_b")).toEqual([]);
    expect(selectPendingSyncBatch([
      { envelope: queued.envelope, status: "pending" },
    ], "user_b")).toEqual([]);
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
  it("atomically prunes a stale catalog entry when removing a former member's copy", async () => {
    const state = createEmptyState("Former shared workspace");
    const accountId = "user_former_member";
    const summary = serverSummary(state, "editor", {
      accountId,
      membershipRevision: 7,
    });
    const catalog = mergeServerWorkspaceCatalog(null, {
      accountId,
      entries: [summary],
      fetchedAt: "2026-07-25T00:00:00.000Z",
      hasMore: false,
      membershipRevision: 7,
      nextCursor: null,
    }, true);
    await writeServerWorkspaceCatalog(catalog);
    await writeReplica({
      authorization: serverWorkspaceAccess("editor", {
        accountId,
        accessRevision: summary.accessRevision + 1,
        membershipRevision: 8,
        status: "left",
      }),
      outbox: [],
      serverSummary: summary,
      state,
      updatedAt: state.workspace.updatedAt,
    });

    const deletion = await deleteWorkspaceReplica(state.workspace.id);

    expect(deletion).toMatchObject({
      catalog: {
        entries: [],
        membershipRevision: 8,
      },
      catalogAccountId: accountId,
    });
    expect(await readWorkspaceReplica(state.workspace.id)).toBeNull();
    const persisted = await readServerWorkspaceCatalog(accountId);
    expect(persisted?.entries).toEqual([]);
    const stale = mergeServerWorkspaceCatalog(persisted, {
      accountId,
      entries: [summary],
      fetchedAt: "2026-07-25T00:01:00.000Z",
      hasMore: false,
      membershipRevision: 7,
      nextCursor: null,
    }, true);
    expect(stale.entries).toEqual([]);
    expect(stale.membershipRevision).toBe(8);
  });
  it("keeps an active membership discoverable after device removal", async () => {
    const state = createEmptyState("Still shared workspace");
    const accountId = "user_active_member";
    const summary = serverSummary(state, "editor", {
      accountId,
      membershipRevision: 7,
    });
    const catalog = mergeServerWorkspaceCatalog(null, {
      accountId,
      entries: [summary],
      fetchedAt: "2026-07-25T00:00:00.000Z",
      hasMore: false,
      membershipRevision: 7,
      nextCursor: null,
    }, true);
    await writeServerWorkspaceCatalog(catalog);
    await writeReplica({
      authorization: serverWorkspaceAccess("editor", {
        accountId,
        accessRevision: summary.accessRevision,
        membershipRevision: summary.membershipRevision,
      }),
      outbox: [],
      serverSummary: summary,
      state,
      updatedAt: state.workspace.updatedAt,
    });

    const deletion = await deleteWorkspaceReplica(state.workspace.id);

    expect(deletion).toEqual({
      catalog: null,
      catalogAccountId: null,
    });
    expect(
      (await readServerWorkspaceCatalog(accountId))?.entries,
    ).toMatchObject([{ id: state.workspace.id }]);
  });
  it("persists a catalog revision floor for a removed deep-linked former membership", async () => {
    const state = createEmptyState("Former deep link");
    const accountId = "user_deep_link";
    const summary = serverSummary(state, "viewer", {
      accountId,
      membershipRevision: 11,
    });
    await writeReplica({
      authorization: serverWorkspaceAccess("viewer", {
        accountId,
        accessRevision: summary.accessRevision + 1,
        membershipRevision: 12,
        status: "revoked",
      }),
      outbox: [],
      serverSummary: summary,
      state,
      updatedAt: state.workspace.updatedAt,
    });

    await deleteWorkspaceReplica(state.workspace.id);

    expect(await readServerWorkspaceCatalog(accountId)).toMatchObject({
      complete: false,
      entries: [],
      membershipRevision: 12,
    });
  });
  it("uses a legacy active-only replica when guarding local removal", async () => {
    const state = createEmptyState("Legacy former membership");
    const accountId = "user_legacy_former_member";
    const summary = serverSummary(state, "viewer", {
      accountId,
      membershipRevision: 14,
    });
    const replica = {
      authorization: serverWorkspaceAccess("viewer", {
        accountId,
        accessRevision: summary.accessRevision + 1,
        membershipRevision: 15,
        status: "revoked",
      }),
      outbox: [],
      serverSummary: summary,
      state,
      updatedAt: "legacy-reviewed",
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("stowplan-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const records = transaction.objectStore("records");
      records.put(replica, "active");
      records.delete(`workspace:${state.workspace.id}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();

    await expect(
      deleteWorkspaceReplica(state.workspace.id, "stale-review"),
    ).rejects.toThrow(/changed after removal was reviewed/);
    expect((await readReplica())?.state.workspace.id).toBe(
      state.workspace.id,
    );

    const deletion = await deleteWorkspaceReplica(
      state.workspace.id,
      "legacy-reviewed",
    );

    expect(deletion).toMatchObject({
      catalog: {
        entries: [],
        membershipRevision: 15,
      },
      catalogAccountId: accountId,
    });
    expect(await readReplica()).toBeNull();
    expect(await readServerWorkspaceCatalog(accountId)).toMatchObject({
      complete: false,
      entries: [],
      membershipRevision: 15,
    });
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

  it("refuses viewer mutation inside the replica transaction", async () => {
    const initial = createEmptyState("Viewer copy");
    const summary = serverSummary(initial, "viewer");
    await writeReplica({
      authorization: serverWorkspaceAccess("viewer", {
        accessRevision: summary.accessRevision,
        membershipRevision: summary.membershipRevision,
      }),
      serverSummary: summary,
      state: initial,
      outbox: [],
      updatedAt: initial.workspace.updatedAt,
    });
    let updateCalled = false;

    await expect(
      mutateWorkspaceReplicaIfWritable(initial.workspace.id, (current) => {
        updateCalled = true;
        return {
          ...current,
          updatedAt: "should-not-be-written",
        };
      }),
    ).rejects.toThrow(/Viewer access/);

    expect(updateCalled).toBe(false);
    expect(await readWorkspaceReplica(initial.workspace.id)).toMatchObject({
      outbox: [],
      updatedAt: initial.workspace.updatedAt,
    });
  });

  it("allows device owners and server editors through the write primitive", async () => {
    const device = createEmptyState("Device owner");
    await writeReplica({
      state: device,
      outbox: [],
      updatedAt: device.workspace.updatedAt,
    });
    await mutateWorkspaceReplicaIfWritable(device.workspace.id, (current) => ({
      ...current,
      updatedAt: "device-written",
    }));
    expect((await readReplica())?.updatedAt).toBe("device-written");

    const editor = createEmptyState("Server editor");
    const summary = serverSummary(editor);
    await writeReplica({
      authorization: serverWorkspaceAccess("editor", {
        accessRevision: summary.accessRevision,
        membershipRevision: summary.membershipRevision,
      }),
      serverSummary: summary,
      state: editor,
      outbox: [],
      updatedAt: editor.workspace.updatedAt,
    });
    await mutateWorkspaceReplicaIfWritable(editor.workspace.id, (current) => ({
      ...current,
      updatedAt: "editor-written",
    }));
    expect((await readReplica())?.updatedAt).toBe("editor-written");
  });

  it("applies authorization by revision and refuses stale responses", async () => {
    const state = createEmptyState("Role changes");
    const initialSummary = serverSummary(state, "editor");
    const initialAccess = serverWorkspaceAccess("editor", {
      accessRevision: initialSummary.accessRevision,
      membershipRevision: initialSummary.membershipRevision,
    });
    await writeReplica({
      authorization: initialAccess,
      serverSummary: initialSummary,
      state,
      outbox: [],
      updatedAt: state.workspace.updatedAt,
    });
    const viewerSummary = serverSummary(state, "viewer", {
      accessRevision: 3,
      membershipRevision: 5,
    });
    const viewerAccess = serverWorkspaceAccess("viewer", {
      accessRevision: viewerSummary.accessRevision,
      membershipRevision: viewerSummary.membershipRevision,
    });
    await writeWorkspaceAuthorizationIfUnchanged(
      state.workspace.id,
      viewerAccess,
      initialAccess,
      viewerSummary,
    );

    await expect(
      writeWorkspaceAuthorizationIfUnchanged(
        state.workspace.id,
        serverWorkspaceAccess("owner", {
          accessRevision: 4,
          membershipRevision: 6,
        }),
        initialAccess,
        serverSummary(state, "owner", {
          accessRevision: 4,
          membershipRevision: 6,
        }),
      ),
    ).rejects.toThrow(/access changed/);
    expect(await readReplica()).toMatchObject({
      authorization: {
        accessRevision: 3,
        membershipRevision: 5,
        role: "viewer",
      },
      serverSummary: {
        role: "viewer",
      },
    });
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
  it("preserves access and backup metadata while reconciling", () => {
    const initial = createEmptyState("Metadata");
    const summary = serverSummary(initial, "editor");
    const authorization = serverWorkspaceAccess("editor", {
      accessRevision: summary.accessRevision,
      checkedAt: "2026-07-25T00:00:00.000Z",
      membershipRevision: summary.membershipRevision,
    });
    const latest = {
      authorization,
      lastSyncAttemptAt: "2026-07-25T00:01:00.000Z",
      lastSyncError: "Previous failure",
      lastSyncedAt: "2026-07-25T00:00:00.000Z",
      outbox: [],
      serverSummary: summary,
      state: initial,
      updatedAt: "last-real-local-change",
    };

    const reconciled = reconcileReplica(latest, [], initial, []);

    expect(reconciled).toMatchObject({
      authorization,
      lastSyncAttemptAt: "2026-07-25T00:01:00.000Z",
      lastSyncError: "Previous failure",
      lastSyncedAt: "2026-07-25T00:00:00.000Z",
      serverSummary: summary,
    });
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

  it("opens a server-only workspace without deleting another local workspace", async () => {
    const local = createEmptyState("Device-only workspace");
    await writeReplica({
      state: local,
      outbox: [],
      updatedAt: local.workspace.updatedAt,
    });
    const remote = createEmptyState("Discovered server workspace");
    const summary = serverSummary(remote, "viewer");
    const candidate = {
      authorization: serverWorkspaceAccess("viewer", {
        accessRevision: summary.accessRevision,
        membershipRevision: summary.membershipRevision,
      }),
      outbox: [],
      serverSummary: summary,
      state: remote,
      updatedAt: remote.workspace.updatedAt,
    };

    const activated = await activateOrInsertServerWorkspaceReplica(candidate);

    expect(activated).toMatchObject({
      authorization: {
        kind: "server",
        role: "viewer",
      },
      state: {
        workspace: {
          id: remote.workspace.id,
        },
      },
    });
    expect((await readReplica())?.state.workspace.id).toBe(
      remote.workspace.id,
    );
    expect(
      (await readWorkspaceReplica(local.workspace.id))?.state.workspace.name,
    ).toBe("Device-only workspace");
    expect(await listWorkspaceReplicas()).toHaveLength(2);
  });

  it("leaves the active workspace unchanged when a server download is invalid", async () => {
    const local = createEmptyState("Unchanged active");
    await writeReplica({
      state: local,
      outbox: [],
      updatedAt: local.workspace.updatedAt,
    });
    const remote = createEmptyState("Invalid server download");

    await expect(
      activateOrInsertServerWorkspaceReplica({
        authorization: serverWorkspaceAccess("editor", {
          accessRevision: 2,
          membershipRevision: 4,
        }),
        outbox: [],
        serverSummary: null,
        state: remote,
        updatedAt: remote.workspace.updatedAt,
      }),
    ).rejects.toThrow(/missing matching server authorization metadata/);

    expect((await readReplica())?.state.workspace.id).toBe(
      local.workspace.id,
    );
    expect(await readWorkspaceReplica(remote.workspace.id)).toBeNull();
  });

  it("rejects inconsistent server metadata before persisting a download", async () => {
    const local = createEmptyState("Metadata guard active");
    await writeReplica({
      state: local,
      outbox: [],
      updatedAt: local.workspace.updatedAt,
    });
    const remote = createEmptyState("Metadata guard remote");
    const summary = serverSummary(remote, "editor", {
      name: "Mismatched server summary",
    });

    await expect(
      activateOrInsertServerWorkspaceReplica({
        authorization: serverWorkspaceAccess("editor", {
          accessRevision: summary.accessRevision,
          membershipRevision: summary.membershipRevision,
        }),
        outbox: [],
        serverSummary: summary,
        state: remote,
        updatedAt: remote.workspace.updatedAt,
      }),
    ).rejects.toThrow(/matching server authorization metadata/);

    expect((await readReplica())?.state.workspace.id).toBe(
      local.workspace.id,
    );
    expect(await readWorkspaceReplica(remote.workspace.id)).toBeNull();
  });

  it("does not activate or persist an abandoned server workspace open", async () => {
    const local = createEmptyState("Still active");
    await writeReplica({
      state: local,
      outbox: [],
      updatedAt: local.workspace.updatedAt,
    });
    const remote = createEmptyState("Cancelled server workspace");
    const summary = serverSummary(remote, "viewer");
    const controller = new AbortController();

    const opening = activateOrInsertServerWorkspaceReplica({
      authorization: serverWorkspaceAccess("viewer", {
        accessRevision: summary.accessRevision,
        membershipRevision: summary.membershipRevision,
      }),
      outbox: [],
      serverSummary: summary,
      state: remote,
      updatedAt: remote.workspace.updatedAt,
    }, controller.signal);
    controller.abort();

    await expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    expect((await readReplica())?.state.workspace.id).toBe(
      local.workspace.id,
    );
    expect(await readWorkspaceReplica(remote.workspace.id)).toBeNull();
  });

  it("preserves same-workspace local work while applying newer server access", async () => {
    const server = createEmptyState("Fetched server");
    const queued = createEnvelope(server, {
      type: "workspace.rename",
      name: "Queued local rename",
    });
    const localState = applyCommand(server, queued).state;
    const editorSummary = serverSummary(server, "editor");
    await writeReplica({
      authorization: serverWorkspaceAccess("editor", {
        accessRevision: editorSummary.accessRevision,
        membershipRevision: editorSummary.membershipRevision,
      }),
      outbox: [{ envelope: queued, status: "pending" }],
      serverSummary: editorSummary,
      state: localState,
      updatedAt: queued.timestamp,
    });
    const viewerSummary = serverSummary(server, "viewer", {
      accessRevision: 3,
      membershipRevision: 5,
    });

    const activated = await activateOrInsertServerWorkspaceReplica({
      authorization: serverWorkspaceAccess("viewer", {
        accessRevision: viewerSummary.accessRevision,
        membershipRevision: viewerSummary.membershipRevision,
      }),
      outbox: [],
      serverSummary: viewerSummary,
      state: server,
      updatedAt: server.workspace.updatedAt,
    });

    expect(activated.state.workspace.name).toBe("Queued local rename");
    expect(activated.outbox.map((entry) => entry.envelope.id)).toEqual([
      queued.id,
    ]);
    expect(activated.authorization).toMatchObject({
      accessRevision: 3,
      membershipRevision: 5,
      role: "viewer",
    });
  });

  it("replaces another account's role without losing its pending work", async () => {
    const state = createEmptyState("Shared account switch");
    const queued = createEnvelope(state, {
      type: "workspace.rename",
      name: "Account A pending",
    });
    const localState = applyCommand(state, queued).state;
    const firstSummary = serverSummary(state, "owner", {
      accountId: "user_a",
      accessRevision: 8,
      membershipRevision: 12,
    });
    const firstAccess = serverWorkspaceAccess("owner", {
      accountId: "user_a",
      accessRevision: 8,
      membershipRevision: 12,
    });
    await writeReplica({
      authorization: firstAccess,
      outbox: [{ envelope: queued, status: "pending" }],
      serverSummary: firstSummary,
      state: localState,
      updatedAt: queued.timestamp,
    });
    const secondSummary = serverSummary(state, "viewer", {
      accountId: "user_b",
      accessRevision: 1,
      membershipRevision: 2,
    });

    const updated = await writeWorkspaceAuthorizationIfUnchanged(
      state.workspace.id,
      serverWorkspaceAccess("viewer", {
        accountId: "user_b",
        accessRevision: 1,
        membershipRevision: 2,
      }),
      firstAccess,
      secondSummary,
    );

    expect(updated?.authorization).toMatchObject({
      accountId: "user_b",
      role: "viewer",
    });
    expect(updated?.serverSummary).toMatchObject({
      accountId: "user_b",
      role: "viewer",
    });
    expect(updated?.outbox).toEqual([
      {
        accountId: "user_a",
        envelope: queued,
        status: "pending",
      },
    ]);
    expect(updated?.state.workspace.name).toBe("Account A pending");
    expect(selectPendingSyncBatch(updated?.outbox ?? [], "user_b"))
      .toEqual([]);
  });

  it("quarantines legacy unscoped work when account access is bound", async () => {
    const state = createEmptyState("Legacy account scope");
    const queued = createEnvelope(state, {
      type: "workspace.rename",
      name: "Legacy pending",
    });
    const localState = applyCommand(state, queued).state;
    const legacySummary = serverSummary(state, "editor");
    const legacyAccess = serverWorkspaceAccess("editor", {
      accessRevision: legacySummary.accessRevision,
      membershipRevision: legacySummary.membershipRevision,
    });
    await writeReplica({
      authorization: legacyAccess,
      outbox: [{ envelope: queued, status: "pending" }],
      serverSummary: legacySummary,
      state: localState,
      updatedAt: queued.timestamp,
    });
    const scopedSummary = {
      ...legacySummary,
      accountId: "user_b",
    };

    const updated = await writeWorkspaceAuthorizationIfUnchanged(
      state.workspace.id,
      serverWorkspaceAccess("editor", {
        accountId: "user_b",
        accessRevision: legacySummary.accessRevision,
        membershipRevision: legacySummary.membershipRevision,
      }),
      legacyAccess,
      scopedSummary,
    );

    expect(updated?.authorization?.accountId).toBe("user_b");
    expect(updated?.outbox).toEqual([
      expect.objectContaining({
        accountId: null,
        error: expect.stringMatching(/retained for recovery/),
        status: "blocked",
      }),
    ]);
    expect(updated?.state.workspace.name).toBe("Legacy pending");
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

  it("invalidates a reviewed recovery target when authorization changes", async () => {
    const state = createEmptyState("Authorization recovery");
    const summary = serverSummary(state, "editor");
    const editorAccess = serverWorkspaceAccess("editor", {
      accessRevision: summary.accessRevision,
      membershipRevision: summary.membershipRevision,
    });
    await writeReplica({
      authorization: editorAccess,
      outbox: [],
      serverSummary: summary,
      state,
      updatedAt: state.workspace.updatedAt,
    });
    const reviewed = await readReplica();
    const viewerSummary = serverSummary(state, "viewer", {
      accessRevision: 3,
      membershipRevision: 5,
    });
    await writeWorkspaceAuthorizationIfUnchanged(
      state.workspace.id,
      serverWorkspaceAccess("viewer", {
        accessRevision: viewerSummary.accessRevision,
        membershipRevision: viewerSummary.membershipRevision,
      }),
      editorAccess,
      viewerSummary,
    );

    await expect(
      replaceReplicaIfUnchanged(reviewed!, reviewed!),
    ).rejects.toThrow(/latest data was preserved/);
    expect((await readReplica())?.authorization?.role).toBe("viewer");
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
