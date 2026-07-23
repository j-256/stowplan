import { applyCommand } from "../domain/commands";
import { normalizeWorkspaceState } from "../domain/import";
import type { CommandEnvelope, SyncReceipt, WorkspaceState } from "../domain/types";

const DATABASE = "stowplan-v1";
const STORE = "records";

export interface OutboxEntry {
  envelope: CommandEnvelope;
  status: "pending" | "blocked";
  error?: string;
}

export interface LocalReplica {
  lastSyncAttemptAt?: string | null;
  lastSyncError?: string | null;
  lastSyncedAt?: string | null;
  state: WorkspaceState;
  outbox: OutboxEntry[];
  updatedAt: string;
}

export interface QueuedChangeSummary {
  error: string | null;
  id: string;
  label: string;
  status: OutboxEntry["status"];
  timestamp: string;
}

export interface LocalWorkspaceSummary {
  blocked: number;
  changes: QueuedChangeSummary[];
  id: string;
  lastSyncAttemptAt: string | null;
  lastSyncError: string | null;
  lastSyncedAt: string | null;
  name: string;
  pending: number;
  updatedAt: string;
}

export interface ReconciliationTarget {
  allowEmpty: boolean;
  workspaceId: string;
}

const workspaceKey = (workspaceId: string) => `workspace:${workspaceId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLocalReplica(replica: LocalReplica): LocalReplica {
  normalizeWorkspaceState(replica.state);
  const itemById = new Map(replica.state.items.map((item) => [item.id, item]));
  const inferredItemOrders = new Map(
    replica.state.items.map((item) => [item.id, item.order]),
  );
  for (const entry of replica.outbox) {
    const command = entry.envelope.command as unknown;
    if (
      isRecord(command) &&
      command.type === "item.create" &&
      isRecord(command.item) &&
      typeof command.item.id === "string" &&
      typeof command.item.order === "number" &&
      Number.isFinite(command.item.order)
    ) {
      inferredItemOrders.set(command.item.id, command.item.order);
    }
    for (const expectation of entry.envelope.expectations) {
      const record = expectation.value as unknown;
      if (
        expectation.target === "item" &&
        expectation.path === "" &&
        isRecord(record) &&
        typeof record.order === "number" &&
        Number.isFinite(record.order)
      ) {
        inferredItemOrders.set(expectation.id, record.order);
      }
    }
  }
  for (const entry of replica.outbox) {
    const command = entry.envelope.command as unknown;
    if (
      isRecord(command) &&
      command.type === "item.create" &&
      isRecord(command.item) &&
      (typeof command.item.order !== "number" || !Number.isFinite(command.item.order))
    ) {
      const current = typeof command.item.id === "string"
        ? itemById.get(command.item.id)
        : undefined;
      const itemId = typeof command.item.id === "string"
        ? command.item.id
        : "";
      command.item.order =
        current?.order ??
        inferredItemOrders.get(itemId) ??
        0;
      if (itemId) inferredItemOrders.set(itemId, command.item.order as number);
    }
    for (const expectation of entry.envelope.expectations) {
      const record = expectation.value as unknown;
      if (
        expectation.target !== "item" ||
        expectation.path !== "" ||
        !isRecord(record) ||
        (typeof record.order === "number" && Number.isFinite(record.order))
      ) {
        continue;
      }
      const current = itemById.get(expectation.id);
      if (current) record.order = current.order;
    }
  }
  return replica;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function readReplica(): Promise<LocalReplica | null> {
  return readStoredReplica("active");
}

async function readStoredReplica(key: string): Promise<LocalReplica | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => {
      const replica=request.result as LocalReplica|undefined;
      if(replica)normalizeLocalReplica(replica);
      resolve(replica??null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function readWorkspaceReplica(workspaceId: string): Promise<LocalReplica | null> {
  return readStoredReplica(workspaceKey(workspaceId));
}

export async function listWorkspaceReplicas(): Promise<LocalWorkspaceSummary[]> {
  const db = await database();
  const replicas = await new Promise<LocalReplica[]>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as LocalReplica[]);
    request.onerror = () => reject(request.error);
  });
  const unique = new Map<string, LocalWorkspaceSummary>();
  for (const replica of replicas) {
    if (!replica?.state?.workspace) continue;
    normalizeLocalReplica(replica);
    const summary = {
      blocked: replica.outbox.filter((entry) => entry.status === "blocked").length,
      changes: replica.outbox.map((entry) => ({
        error: entry.error ?? null,
        id: entry.envelope.id,
        label: replica.state.activities.find((activity) => activity.commandId === entry.envelope.id)?.label ?? entry.envelope.command.type.replaceAll(".", " "),
        status: entry.status,
        timestamp: entry.envelope.timestamp,
      })),
      id: replica.state.workspace.id,
      lastSyncAttemptAt: replica.lastSyncAttemptAt ?? null,
      lastSyncError: replica.lastSyncError ?? null,
      lastSyncedAt: replica.lastSyncedAt ?? null,
      name: replica.state.workspace.name,
      pending: replica.outbox.filter((entry) => entry.status === "pending").length,
      updatedAt: replica.updatedAt,
    };
    const previous = unique.get(summary.id);
    if (!previous || previous.updatedAt < summary.updatedAt) unique.set(summary.id, summary);
  }
  return [...unique.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function reconciliationTargets(
  workspaces: LocalWorkspaceSummary[],
  activeWorkspaceId: string | undefined,
): ReconciliationTarget[] {
  const ids = new Set(
    workspaces
      .filter((workspace) => workspace.pending > 0)
      .map((workspace) => workspace.id),
  );
  if (activeWorkspaceId) ids.add(activeWorkspaceId);
  return [...ids].map((workspaceId) => ({
    allowEmpty: workspaceId === activeWorkspaceId,
    workspaceId,
  }));
}

export async function deleteWorkspaceReplica(
  workspaceId: string,
  expectedUpdatedAt?: string,
): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const workspaceRequest = store.get(workspaceKey(workspaceId));
    const activeRequest = store.get("active");
    let workspace: LocalReplica | undefined;
    let active: LocalReplica | undefined;
    let workspaceReady = false;
    let activeReady = false;
    let deletionError: Error | null = null;
    const remove = () => {
      if (!workspaceReady || !activeReady) return;
      if (
        expectedUpdatedAt &&
        workspace &&
        workspace.updatedAt !== expectedUpdatedAt
      ) {
        deletionError = new Error(
          "This workspace changed after removal was reviewed. Review its latest backup status and try again.",
        );
        transaction.abort();
        return;
      }
      store.delete(workspaceKey(workspaceId));
      if (active?.state?.workspace?.id === workspaceId) store.delete("active");
    };
    workspaceRequest.onsuccess = () => {
      workspace = workspaceRequest.result as LocalReplica | undefined;
      workspaceReady = true;
      remove();
    };
    activeRequest.onsuccess = () => {
      active = activeRequest.result as LocalReplica | undefined;
      activeReady = true;
      remove();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(deletionError ?? transaction.error);
    transaction.onabort = () => reject(
      deletionError ?? transaction.error ?? new Error("Could not remove the workspace"),
    );
  });
}

export async function writeReplica(replica: LocalReplica): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get("active");
    request.onsuccess = () => {
      const current = request.result as LocalReplica | undefined;
      if (current && current.state.workspace.id !== replica.state.workspace.id) {
        store.put(current, workspaceKey(current.state.workspace.id));
      }
      store.put(replica, "active");
      store.put(replica, workspaceKey(replica.state.workspace.id));
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function sameReplicaVersion(current: LocalReplica, expected: LocalReplica): boolean {
  return current.state.workspace.id === expected.state.workspace.id &&
    current.state.workspace.revision === expected.state.workspace.revision &&
    current.updatedAt === expected.updatedAt &&
    current.outbox.length === expected.outbox.length &&
    current.outbox.every(
      (entry, index) =>
        entry.envelope.id === expected.outbox[index]?.envelope.id &&
        entry.status === expected.outbox[index]?.status,
    );
}

export function replicaVersionMatches(
  current: LocalReplica | null,
  expected: LocalReplica | null,
): boolean {
  return current === null || expected === null
    ? current === expected
    : sameReplicaVersion(current, expected);
}

export async function writeReplicaIfUnchanged(
  replica: LocalReplica,
  expected: LocalReplica,
): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get("active");
    let versionError: Error | null = null;
    request.onsuccess = () => {
      const current = request.result as LocalReplica | undefined;
      if (!current || !sameReplicaVersion(current, expected)) {
        versionError = new Error(
          "This device workspace changed after recovery was reviewed. Export and review the latest queue before trying again.",
        );
        transaction.abort();
        return;
      }
      store.put(replica, "active");
      store.put(replica, workspaceKey(replica.state.workspace.id));
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(versionError ?? transaction.error);
    transaction.onabort = () => reject(
      versionError ?? transaction.error ?? new Error("Could not update the local workspace"),
    );
  });
}

export async function writeWorkspaceReplicaIfUnchanged(
  replica: LocalReplica,
  expectedTarget: LocalReplica | null,
  expectedActive: LocalReplica | null,
): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const targetRequest = store.get(workspaceKey(replica.state.workspace.id));
    const activeRequest = store.get("active");
    let target: LocalReplica | null = null;
    let active: LocalReplica | null = null;
    let targetReady = false;
    let activeReady = false;
    let versionError: Error | null = null;
    const replace = () => {
      if (!targetReady || !activeReady) return;
      const effectiveTarget = target ??
        (
          active?.state.workspace.id === replica.state.workspace.id
            ? active
            : null
        );
      if (
        !replicaVersionMatches(effectiveTarget, expectedTarget) ||
        !replicaVersionMatches(active, expectedActive)
      ) {
        versionError = new Error(
          "A device workspace changed after recovery was reviewed. Its latest data was preserved.",
        );
        transaction.abort();
        return;
      }
      if (
        active &&
        active.state.workspace.id !== replica.state.workspace.id
      ) {
        store.put(active, workspaceKey(active.state.workspace.id));
      }
      store.put(replica, workspaceKey(replica.state.workspace.id));
      store.put(replica, "active");
    };
    targetRequest.onsuccess = () => {
      target = targetRequest.result as LocalReplica | undefined ?? null;
      targetReady = true;
      replace();
    };
    activeRequest.onsuccess = () => {
      active = activeRequest.result as LocalReplica | undefined ?? null;
      activeReady = true;
      replace();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(versionError ?? transaction.error);
    transaction.onabort = () => reject(
      versionError ?? transaction.error ?? new Error("Could not restore the local workspace"),
    );
  });
}

export async function mutateReplica(
  update: (current: LocalReplica) => LocalReplica,
): Promise<LocalReplica | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get("active");
    let next: LocalReplica | null = null;
    let updateError: unknown;

    request.onsuccess = () => {
      const current = request.result as LocalReplica | undefined;
      if (!current) return;
      try {
        normalizeLocalReplica(current);
        next = update(current);
        store.put(next, "active");
        store.put(next, workspaceKey(next.state.workspace.id));
      } catch (error) {
        updateError = error;
        transaction.abort();
      }
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(next);
    transaction.onerror = () => reject(updateError ?? transaction.error);
    transaction.onabort = () => reject(
      updateError ?? transaction.error ?? new Error("Could not update the local workspace"),
    );
  });
}

export async function mutateWorkspaceReplica(
  workspaceId: string,
  update: (current: LocalReplica) => LocalReplica,
): Promise<LocalReplica | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const workspaceRequest = store.get(workspaceKey(workspaceId));
    const activeRequest = store.get("active");
    let workspace: LocalReplica | undefined;
    let active: LocalReplica | undefined;
    let workspaceReady = false;
    let activeReady = false;
    let next: LocalReplica | null = null;
    let updateError: unknown;

    const apply = () => {
      if (!workspaceReady || !activeReady) return;
      const current = workspace ??
        (active?.state.workspace.id === workspaceId ? active : undefined);
      if (!current) return;
      try {
        normalizeLocalReplica(current);
        next = update(current);
        store.put(next, workspaceKey(workspaceId));
        if (active?.state.workspace.id === workspaceId) store.put(next, "active");
      } catch (error) {
        updateError = error;
        transaction.abort();
      }
    };
    workspaceRequest.onsuccess = () => {
      workspace = workspaceRequest.result as LocalReplica | undefined;
      workspaceReady = true;
      apply();
    };
    activeRequest.onsuccess = () => {
      active = activeRequest.result as LocalReplica | undefined;
      activeReady = true;
      apply();
    };
    transaction.oncomplete = () => resolve(next);
    transaction.onerror = () => reject(updateError ?? transaction.error);
    transaction.onabort = () => reject(
      updateError ?? transaction.error ?? new Error("Could not update the local workspace"),
    );
  });
}

export async function activateWorkspaceReplica(workspaceId: string): Promise<LocalReplica | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(workspaceKey(workspaceId));
    let replica: LocalReplica | null = null;
    request.onsuccess = () => {
      replica = request.result as LocalReplica | undefined ?? null;
      if (!replica) return;
      normalizeLocalReplica(replica);
      store.put(replica, "active");
      store.put(replica, workspaceKey(workspaceId));
    };
    transaction.oncomplete = () => resolve(replica);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function activateOrInsertWorkspaceReplica(
  candidate: LocalReplica,
): Promise<LocalReplica> {
  const workspaceId = candidate.state.workspace.id;
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const workspaceRequest = store.get(workspaceKey(workspaceId));
    const activeRequest = store.get("active");
    let workspace: LocalReplica | null = null;
    let active: LocalReplica | null = null;
    let workspaceReady = false;
    let activeReady = false;
    let selected: LocalReplica | null = null;
    const activate = () => {
      if (!workspaceReady || !activeReady) return;
      selected = workspace ??
        (active?.state.workspace.id === workspaceId ? active : null) ??
        candidate;
      normalizeLocalReplica(selected);
      if (active && active.state.workspace.id !== workspaceId) {
        store.put(active, workspaceKey(active.state.workspace.id));
      }
      store.put(selected, workspaceKey(workspaceId));
      store.put(selected, "active");
    };
    workspaceRequest.onsuccess = () => {
      workspace = workspaceRequest.result as LocalReplica | undefined ?? null;
      workspaceReady = true;
      activate();
    };
    activeRequest.onsuccess = () => {
      active = activeRequest.result as LocalReplica | undefined ?? null;
      activeReady = true;
      activate();
    };
    transaction.oncomplete = () => resolve(selected ?? candidate);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(
      transaction.error ?? new Error("Could not open the workspace"),
    );
  });
}

export async function replaceReplica(replica: LocalReplica, previousWorkspaceId?: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.put(replica, "active");
    store.put(replica, workspaceKey(replica.state.workspace.id));
    if (previousWorkspaceId && previousWorkspaceId !== replica.state.workspace.id) {
      store.delete(workspaceKey(previousWorkspaceId));
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function replaceReplicaIfUnchanged(
  replica: LocalReplica,
  expected: LocalReplica,
): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get("active");
    let versionError: Error | null = null;
    request.onsuccess = () => {
      const current = request.result as LocalReplica | undefined;
      if (!current || !sameReplicaVersion(current, expected)) {
        versionError = new Error(
          "This workspace changed after reset was confirmed. Its latest data was preserved; review it and try again.",
        );
        transaction.abort();
        return;
      }
      store.put(replica, "active");
      store.put(replica, workspaceKey(replica.state.workspace.id));
      if (expected.state.workspace.id !== replica.state.workspace.id) {
        store.delete(workspaceKey(expected.state.workspace.id));
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(versionError ?? transaction.error);
    transaction.onabort = () => reject(
      versionError ?? transaction.error ?? new Error("Could not reset the workspace"),
    );
  });
}

export async function clearReplica(): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function commandWasApplied(state: WorkspaceState, commandId: string): boolean {
  return state.activities.some((activity) => activity.commandId === commandId) ||
    state.audit.some((event) => event.id === `audit_${commandId}`);
}

export function canRebaseQueuedCommand(
  state: WorkspaceState,
  baseRevision: number,
  priorCommandIds: Iterable<string>,
): boolean {
  const appliedPriorIds = new Set(
    [...priorCommandIds].filter((commandId) => commandWasApplied(state, commandId)),
  );
  return appliedPriorIds.size > 0 &&
    state.workspace.revision === baseRevision + appliedPriorIds.size;
}

export function reconcileReplica(latest:LocalReplica,sent:OutboxEntry[],serverState:WorkspaceState,receipts:SyncReceipt[]):LocalReplica{
  const sentIds=new Set(sent.map(entry=>entry.envelope.id)),byId=new Map(receipts.map(receipt=>[receipt.commandId,receipt]));
  const confirmedLocalRevision = latest.state.workspace.revision - latest.outbox.length;
  if (serverState.workspace.revision < confirmedLocalRevision) return latest;
  if (sent.length > 0 && !latest.outbox.some((entry) => sentIds.has(entry.envelope.id))) return latest;
  const outbox=latest.outbox.flatMap(entry=>{
    if(!sentIds.has(entry.envelope.id))return[entry];
    const receipt=byId.get(entry.envelope.id);
    if(receipt?.status==="applied"||receipt?.status==="duplicate")return[];
    const error=receipt
      ? receipt.message??receipt.conflicts?.map(conflict=>conflict.message).join("; ")??"Server rejected this change"
      : "The server did not acknowledge this change";
    return[{...entry,error,status:"blocked" as const}];
  });
  let state=normalizeWorkspaceState(structuredClone(serverState));
  if(outbox.some(entry=>entry.status==="blocked"))state=latest.state;
  else for(const entry of outbox)state=applyCommand(state,entry.envelope).state;
  return{state,outbox,updatedAt:latest.updatedAt};
}
