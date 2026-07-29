import { applyCommand } from "../domain/commands";
import { normalizeWorkspaceState } from "../domain/import";
import type { CommandEnvelope, SyncReceipt, WorkspaceState } from "../domain/types";
import {
  compareServerWorkspaceSummaries,
  deviceOnlyWorkspaceAccess,
  normalizeServerWorkspaceSummary,
  normalizeWorkspaceAccessState,
  requireWorkspaceWriteAccess,
  shouldApplyWorkspaceAccess,
  workspaceAccountIdsMatch,
  workspaceAccessFromSummary,
  type ServerWorkspaceSummary,
  type WorkspaceAccessState,
} from "../domain/workspace-access";
import { API_QUOTAS } from "../shared/api-quotas";
import { isSignInBackupError } from "./backup-presentation";

const DATABASE = "stowplan-v1";
const STORE = "records";
const ACTIVE_KEY = "active";
const ACTIVE_CATALOG_ACCOUNT_KEY = "catalog-account:active";
const CATALOG_KEY_PREFIX = "catalog:";
const WORKSPACE_KEY_PREFIX = "workspace:";
const LEGACY_OUTBOX_ACCOUNT_ERROR =
  "This queued change predates account-scoped access. It was retained for recovery and must be reviewed before reapplying it.";
const WORKSPACE_CAPABILITY_KEYS = Object.freeze([
  "delete",
  "leave",
  "manageAccess",
  "read",
  "write",
] as const);

export interface OutboxEntry {
  accountId?: string | null;
  envelope: CommandEnvelope;
  status: "pending" | "blocked";
  error?: string;
}

export interface LocalReplica {
  authorization?: WorkspaceAccessState;
  lastSyncAttemptAt?: string | null;
  lastSyncError?: string | null;
  lastSyncedAt?: string | null;
  serverSummary?: ServerWorkspaceSummary | null;
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
  authorization?: WorkspaceAccessState;
  revision?: number;
  serverSummary?: ServerWorkspaceSummary | null;
  updatedAt: string;
}

export interface ServerWorkspaceCatalog {
  accountId: string;
  catalogRevision: number;
  complete: boolean;
  entries: ServerWorkspaceSummary[];
  fetchedAt: string;
  hasMore: boolean;
  membershipRevision: number;
  nextCursor: string | null;
}

export interface ServerWorkspaceCatalogPage {
  accountId: string;
  entries: ServerWorkspaceSummary[];
  fetchedAt: string;
  hasMore: boolean;
  membershipRevision: number;
  nextCursor: string | null;
}

export interface WorkspaceReplicaDeletionResult {
  catalog: ServerWorkspaceCatalog | null;
  catalogAccountId: string | null;
}

export interface ReconciliationTarget {
  allowEmpty: boolean;
  workspaceId: string;
}

// Attribution for a newly queued outbox entry. It follows the signed-in account
// whenever one exists, rather than whether the workspace authorization has
// resolved to server-kind: an edit queued during that settling window would
// otherwise be stored unattributed and later mistaken for another account's work.
export function outboxEntryAccountId(
  accountId: string | null | undefined,
): string | undefined {
  return typeof accountId === "string" && accountId.trim()
    ? accountId
    : undefined;
}

export function selectPendingSyncBatch(
  outbox: readonly OutboxEntry[],
  accountId?: string | null,
): OutboxEntry[] {
  const pending = outbox.filter((entry) => entry.status === "pending");
  const first = pending[0];
  if (!first) return [];
  if (
    accountId !== undefined &&
    !workspaceAccountIdsMatch(first.accountId, accountId)
  ) {
    return [];
  }
  const expected = first.envelope.authorization;
  const batch: OutboxEntry[] = [];
  for (const entry of pending) {
    if (
      accountId !== undefined &&
      !workspaceAccountIdsMatch(entry.accountId, accountId)
    ) {
      break;
    }
    const candidate = entry.envelope.authorization;
    const sameBasis = expected === undefined || candidate === undefined
      ? expected === candidate
      : expected.membershipRevision === candidate.membershipRevision &&
        expected.workspaceAccessRevision ===
          candidate.workspaceAccessRevision;
    if (!sameBasis) break;
    batch.push(entry);
    if (batch.length >= API_QUOTAS.commandsPerSyncRequest) break;
  }
  return batch;
}

export function scopeOutboxForWorkspaceAccess(
  outbox: readonly OutboxEntry[],
  current: WorkspaceAccessState,
  candidate: WorkspaceAccessState,
): OutboxEntry[] {
  if (candidate.kind !== "server" || !candidate.accountId) {
    return [...outbox];
  }
  if (current.kind === "device-only") {
    return outbox.map((entry) =>
      entry.accountId === undefined
        ? { ...entry, accountId: candidate.accountId }
        : entry
    );
  }
  if (
    workspaceAccountIdsMatch(current.accountId, candidate.accountId)
  ) {
    return [...outbox];
  }
  if (current.accountId) {
    return outbox.map((entry) =>
      entry.accountId === undefined
        ? { ...entry, accountId: current.accountId }
        : entry
    );
  }
  return outbox.map((entry) =>
    entry.status === "pending" && entry.accountId === undefined
      ? {
          ...entry,
          accountId: null,
          error:
            `${entry.envelope.command.type.replaceAll(".", " ")}: ${LEGACY_OUTBOX_ACCOUNT_ERROR}`,
          status: "blocked",
        }
      : entry
  );
}

const workspaceKey = (workspaceId: string) =>
  `${WORKSPACE_KEY_PREFIX}${workspaceId}`;
const catalogKey = (accountId: string) =>
  `${CATALOG_KEY_PREFIX}${encodeURIComponent(accountId)}`;

function workspaceActivationCancelled(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(
        "Workspace opening was cancelled",
        "AbortError",
      );
}

function requireWorkspaceActivation(
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw workspaceActivationCancelled(signal);
}

function cancelTransactionOnAbort(
  transaction: IDBTransaction,
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => undefined;
  const cancel = () => {
    try {
      transaction.abort();
    } catch {
      // The transaction already completed
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  return () => signal.removeEventListener("abort", cancel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeLocalReplica(replica: LocalReplica): LocalReplica {
  normalizeWorkspaceState(replica.state);
  replica.serverSummary = replica.serverSummary === undefined
    ? null
    : normalizeServerWorkspaceSummary(replica.serverSummary);
  replica.authorization = replica.authorization === undefined &&
      replica.serverSummary
    ? workspaceAccessFromSummary(
        replica.serverSummary,
        replica.lastSyncAttemptAt ??
          replica.lastSyncedAt ??
          replica.serverSummary.updatedAt,
      )
    : normalizeWorkspaceAccessState(replica.authorization);
  if (
    replica.authorization.kind === "device-only" &&
    isSignInBackupError(replica.lastSyncError)
  ) {
    replica.lastSyncError = null;
  }
  const itemById = new Map(replica.state.items.map((item) => [item.id, item]));
  const inferredItemOrders = new Map(
    replica.state.items.map((item) => [item.id, item.order]),
  );
  for (const entry of replica.outbox) {
    if (entry.accountId !== undefined) {
      entry.accountId = typeof entry.accountId === "string" &&
          entry.accountId.trim()
        ? entry.accountId.trim()
        : null;
    }
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
  return readStoredReplica(ACTIVE_KEY);
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
    const request = db.transaction(STORE).objectStore(STORE).openCursor();
    const scoped = new Map<string, LocalReplica>();
    let active: LocalReplica | null = null;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        if (
          active?.state?.workspace?.id &&
          !scoped.has(active.state.workspace.id)
        ) {
          scoped.set(active.state.workspace.id, active);
        }
        resolve([...scoped.values()]);
        return;
      }
      const key = typeof cursor.key === "string" ? cursor.key : "";
      const value = cursor.value as LocalReplica | undefined;
      if (key === ACTIVE_KEY && value?.state?.workspace) {
        active = value;
      } else if (
        key.startsWith(WORKSPACE_KEY_PREFIX) &&
        value?.state?.workspace
      ) {
        scoped.set(value.state.workspace.id, value);
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const summaries: LocalWorkspaceSummary[] = [];
  for (const replica of replicas) {
    if (!replica?.state?.workspace) continue;
    normalizeLocalReplica(replica);
    summaries.push({
      authorization: replica.authorization,
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
      revision: replica.state.workspace.revision,
      serverSummary: replica.serverSummary ?? null,
      updatedAt: replica.updatedAt,
    });
  }
  return summaries.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeServerWorkspaceCatalog(
  value: unknown,
  accountId: string,
): ServerWorkspaceCatalog | null {
  if (
    !isRecord(value) ||
    value.accountId !== accountId ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  const entries = value.entries.flatMap((entry) => {
    const normalized = normalizeServerWorkspaceSummary(entry);
    return normalized ? [{ ...normalized, accountId }] : [];
  });
  return {
    accountId,
    catalogRevision:
      typeof value.catalogRevision === "number" &&
        Number.isSafeInteger(value.catalogRevision) &&
        value.catalogRevision >= 0
        ? value.catalogRevision
        : 0,
    complete: value.complete === true,
    entries,
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : "",
    hasMore: value.hasMore === true,
    membershipRevision:
      typeof value.membershipRevision === "number" &&
        Number.isSafeInteger(value.membershipRevision) &&
        value.membershipRevision >= 0
        ? value.membershipRevision
        : 0,
    nextCursor: typeof value.nextCursor === "string"
      ? value.nextCursor
      : null,
  };
}

export function mergeServerWorkspaceCatalog(
  current: ServerWorkspaceCatalog | null,
  page: ServerWorkspaceCatalogPage,
  replace = false,
): ServerWorkspaceCatalog {
  if (current && current.accountId !== page.accountId) {
    throw new Error("Cannot merge workspace catalogs from different accounts");
  }
  if (
    !Number.isSafeInteger(page.membershipRevision) ||
    page.membershipRevision < 0
  ) {
    throw new Error("Invalid workspace catalog membership revision");
  }
  if (
    current &&
    page.membershipRevision < current.membershipRevision
  ) {
    return current;
  }
  const entries = new Map<string, ServerWorkspaceSummary>();
  const previousEntries = new Map(
    current?.entries.map((entry) => [entry.id, entry]) ?? [],
  );
  if (!replace) {
    for (const entry of current?.entries ?? []) entries.set(entry.id, entry);
  }
  for (const entry of page.entries) {
    const normalized = normalizeServerWorkspaceSummary(entry);
    if (!normalized) continue;
    const scoped = {
      ...normalized,
      accountId: page.accountId,
    };
    const previous = entries.get(scoped.id) ??
      previousEntries.get(scoped.id);
    if (
      !previous ||
      !workspaceAccountIdsMatch(previous.accountId, scoped.accountId) ||
      compareServerWorkspaceSummaries(scoped, previous) >= 0
    ) {
      entries.set(scoped.id, scoped);
    } else if (replace) {
      entries.set(previous.id, previous);
    }
  }
  return {
    accountId: page.accountId,
    catalogRevision: (current?.catalogRevision ?? 0) + 1,
    complete: !page.hasMore,
    entries: [...entries.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
    ),
    fetchedAt: page.fetchedAt,
    hasMore: page.hasMore,
    membershipRevision: page.membershipRevision,
    nextCursor: page.nextCursor,
  };
}

export async function readServerWorkspaceCatalog(
  accountId: string,
): Promise<ServerWorkspaceCatalog | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE)
      .objectStore(STORE)
      .get(catalogKey(accountId));
    request.onsuccess = () => resolve(
      normalizeServerWorkspaceCatalog(request.result, accountId),
    );
    request.onerror = () => reject(request.error);
  });
}

function normalizeActiveCatalogAccount(value: unknown): string | null {
  const accountId = typeof value === "string"
    ? value
    : isRecord(value) && typeof value.accountId === "string"
      ? value.accountId
      : "";
  return accountId.trim() ? accountId.trim() : null;
}

export async function readActiveServerWorkspaceCatalogAccount(): Promise<
  string | null
> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE)
      .objectStore(STORE)
      .get(ACTIVE_CATALOG_ACCOUNT_KEY);
    request.onsuccess = () => resolve(
      normalizeActiveCatalogAccount(request.result),
    );
    request.onerror = () => reject(request.error);
  });
}

export async function setActiveServerWorkspaceCatalogAccount(
  accountId: string,
): Promise<void> {
  const normalized = normalizeActiveCatalogAccount(accountId);
  if (!normalized) throw new Error("A signed-in account is required");
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(
      normalized,
      ACTIVE_CATALOG_ACCOUNT_KEY,
    );
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function clearActiveServerWorkspaceCatalogAccount(): Promise<
  void
> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(ACTIVE_CATALOG_ACCOUNT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function writeServerWorkspaceCatalog(
  catalog: ServerWorkspaceCatalog,
): Promise<void> {
  const normalized = normalizeServerWorkspaceCatalog(
    catalog,
    catalog.accountId,
  );
  if (!normalized) throw new Error("Invalid server workspace catalog");
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(
      normalized,
      catalogKey(normalized.accountId),
    );
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class WorkspaceCatalogConflictError extends Error {
  readonly code = "WORKSPACE_CATALOG_CHANGED";

  constructor() {
    super("The server workspace list changed while it was being refreshed.");
    this.name = "WorkspaceCatalogConflictError";
  }
}

function sameCatalogVersion(
  current: ServerWorkspaceCatalog | null,
  expected: ServerWorkspaceCatalog | null,
): boolean {
  return current === null || expected === null
    ? current === expected
    : current.accountId === expected.accountId &&
      current.catalogRevision === expected.catalogRevision;
}

export async function writeServerWorkspaceCatalogIfUnchanged(
  catalog: ServerWorkspaceCatalog,
  expected: ServerWorkspaceCatalog | null,
): Promise<void> {
  const normalized = normalizeServerWorkspaceCatalog(
    catalog,
    catalog.accountId,
  );
  if (!normalized) throw new Error("Invalid server workspace catalog");
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(catalogKey(normalized.accountId));
    let conflict: WorkspaceCatalogConflictError | null = null;
    request.onsuccess = () => {
      const current = normalizeServerWorkspaceCatalog(
        request.result,
        normalized.accountId,
      );
      if (!sameCatalogVersion(current, expected)) {
        conflict = new WorkspaceCatalogConflictError();
        transaction.abort();
        return;
      }
      store.put(normalized, catalogKey(normalized.accountId));
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(conflict ?? transaction.error);
    transaction.onabort = () => reject(
      conflict ?? transaction.error ??
        new Error("Could not update the server workspace list"),
    );
  });
}

export async function deleteServerWorkspaceCatalog(
  accountId: string,
): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(catalogKey(accountId));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
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
): Promise<WorkspaceReplicaDeletionResult> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const workspaceRequest = store.get(workspaceKey(workspaceId));
    const activeRequest = store.get(ACTIVE_KEY);
    let workspace: LocalReplica | undefined;
    let active: LocalReplica | undefined;
    let catalog: ServerWorkspaceCatalog | null = null;
    let catalogAccountId: string | null = null;
    let catalogMembershipRevision = 0;
    let workspaceReady = false;
    let activeReady = false;
    let catalogReady = false;
    let catalogRequested = false;
    let removed = false;
    let deletionError: unknown;
    let deletionResult: WorkspaceReplicaDeletionResult = {
      catalog: null,
      catalogAccountId: null,
    };
    const remove = () => {
      if (
        removed ||
        !workspaceReady ||
        !activeReady ||
        !catalogReady
      ) {
        return;
      }
      const target = workspace ??
        (active?.state?.workspace?.id === workspaceId ? active : undefined);
      if (
        expectedUpdatedAt &&
        target &&
        target.updatedAt !== expectedUpdatedAt
      ) {
        deletionError = new Error(
          "This workspace changed after removal was reviewed. Review its latest backup status and try again.",
        );
        transaction.abort();
        return;
      }
      removed = true;
      store.delete(workspaceKey(workspaceId));
      if (active?.state?.workspace?.id === workspaceId) store.delete(ACTIVE_KEY);
      if (catalogAccountId) {
        const shouldPrune = !catalog ||
          catalog.membershipRevision <= catalogMembershipRevision;
        const hasWorkspace = catalog?.entries.some(
          entry => entry.id === workspaceId,
        ) ?? false;
        const needsRevisionFloor = !catalog ||
          catalog.membershipRevision < catalogMembershipRevision;
        if (shouldPrune && (hasWorkspace || needsRevisionFloor || !catalog)) {
          catalog = {
            accountId: catalogAccountId,
            catalogRevision: (catalog?.catalogRevision ?? 0) + 1,
            complete: catalog?.complete ?? false,
            entries: (catalog?.entries ?? []).filter(
              entry => entry.id !== workspaceId,
            ),
            fetchedAt: catalog?.fetchedAt ?? "",
            hasMore: catalog?.hasMore ?? false,
            membershipRevision: Math.max(
              catalog?.membershipRevision ?? 0,
              catalogMembershipRevision,
            ),
            nextCursor: catalog?.nextCursor ?? null,
          };
          store.put(catalog, catalogKey(catalogAccountId));
        }
        deletionResult = {
          catalog,
          catalogAccountId,
        };
      }
    };
    const prepareCatalog = () => {
      if (
        catalogRequested ||
        !workspaceReady ||
        !activeReady
      ) {
        return;
      }
      catalogRequested = true;
      const target = workspace ??
        (active?.state?.workspace?.id === workspaceId ? active : undefined);
      const authorization = target
        ? normalizeLocalReplica(target).authorization
        : undefined;
      if (
        authorization?.kind === "server" &&
        authorization.status !== "active" &&
        authorization.accountId
      ) {
        catalogAccountId = authorization.accountId;
        catalogMembershipRevision = authorization.membershipRevision;
        const requestedAccountId = authorization.accountId;
        const catalogRequest = store.get(catalogKey(requestedAccountId));
        catalogRequest.onsuccess = () => {
          catalog = normalizeServerWorkspaceCatalog(
            catalogRequest.result,
            requestedAccountId,
          );
          catalogReady = true;
          remove();
        };
        return;
      }
      catalogReady = true;
      remove();
    };
    workspaceRequest.onsuccess = () => {
      try {
        workspace = workspaceRequest.result as LocalReplica | undefined;
        workspaceReady = true;
        prepareCatalog();
      } catch (error) {
        deletionError = error;
        transaction.abort();
      }
    };
    activeRequest.onsuccess = () => {
      active = activeRequest.result as LocalReplica | undefined;
      activeReady = true;
      prepareCatalog();
    };
    transaction.oncomplete = () => resolve(deletionResult);
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
    const request = store.get(ACTIVE_KEY);
    request.onsuccess = () => {
      const current = request.result as LocalReplica | undefined;
      if (current && current.state.workspace.id !== replica.state.workspace.id) {
        store.put(current, workspaceKey(current.state.workspace.id));
      }
      store.put(replica, ACTIVE_KEY);
      store.put(replica, workspaceKey(replica.state.workspace.id));
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function sameReplicaVersion(current: LocalReplica, expected: LocalReplica): boolean {
  const currentAccess = normalizeWorkspaceAccessState(current.authorization);
  const expectedAccess = normalizeWorkspaceAccessState(expected.authorization);
  const currentServer = current.serverSummary
    ? normalizeServerWorkspaceSummary(current.serverSummary)
    : null;
  const expectedServer = expected.serverSummary
    ? normalizeServerWorkspaceSummary(expected.serverSummary)
    : null;
  return current.state.workspace.id === expected.state.workspace.id &&
    current.state.workspace.revision === expected.state.workspace.revision &&
    current.updatedAt === expected.updatedAt &&
    workspaceAccessVersionsMatch(currentAccess, expectedAccess) &&
    (
      currentServer === null || expectedServer === null
        ? currentServer === expectedServer
        : workspaceAccountIdsMatch(
            currentServer.accountId,
            expectedServer.accountId,
          ) &&
          compareServerWorkspaceSummaries(currentServer, expectedServer) === 0
    ) &&
    current.outbox.length === expected.outbox.length &&
    current.outbox.every(
      (entry, index) =>
        entry.envelope.id === expected.outbox[index]?.envelope.id &&
        workspaceAccountIdsMatch(
          entry.accountId,
          expected.outbox[index]?.accountId,
        ) &&
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

export function workspaceAccessVersionsMatch(
  current: WorkspaceAccessState,
  expected: WorkspaceAccessState,
): boolean {
  return current.kind === expected.kind &&
    workspaceAccountIdsMatch(current.accountId, expected.accountId) &&
    current.membershipRevision === expected.membershipRevision &&
    current.accessRevision === expected.accessRevision &&
    current.status === expected.status &&
    current.role === expected.role;
}

export async function writeReplicaIfUnchanged(
  replica: LocalReplica,
  expected: LocalReplica,
): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(ACTIVE_KEY);
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
      store.put(replica, ACTIVE_KEY);
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
    const activeRequest = store.get(ACTIVE_KEY);
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
      store.put(replica, ACTIVE_KEY);
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
    const request = store.get(ACTIVE_KEY);
    let next: LocalReplica | null = null;
    let updateError: unknown;

    request.onsuccess = () => {
      const current = request.result as LocalReplica | undefined;
      if (!current) return;
      try {
        normalizeLocalReplica(current);
        next = update(current);
        store.put(next, ACTIVE_KEY);
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
    const activeRequest = store.get(ACTIVE_KEY);
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
        if (active?.state.workspace.id === workspaceId) {
          store.put(next, ACTIVE_KEY);
        }
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

export async function mutateWorkspaceReplicaIfWritable(
  workspaceId: string,
  update: (current: LocalReplica) => LocalReplica,
): Promise<LocalReplica | null> {
  return mutateWorkspaceReplica(workspaceId, (current) => {
    requireWorkspaceWriteAccess(
      normalizeWorkspaceAccessState(current.authorization),
    );
    return update(current);
  });
}

export class WorkspaceAuthorizationConflictError extends Error {
  readonly code = "WORKSPACE_AUTHORIZATION_CHANGED";

  constructor() {
    super("Workspace access changed while it was being refreshed.");
    this.name = "WorkspaceAuthorizationConflictError";
  }
}

export async function writeWorkspaceAuthorizationIfUnchanged(
  workspaceId: string,
  authorization: WorkspaceAccessState,
  expected: WorkspaceAccessState,
  serverSummary?: ServerWorkspaceSummary | null,
): Promise<LocalReplica | null> {
  const candidate = normalizeWorkspaceAccessState(authorization);
  const expectedAccess = normalizeWorkspaceAccessState(expected);
  const normalizedServer = serverSummary === undefined || serverSummary === null
    ? serverSummary
    : normalizeServerWorkspaceSummary(serverSummary);
  if (serverSummary && !normalizedServer) {
    throw new Error("Invalid server workspace summary");
  }
  if (normalizedServer && normalizedServer.id !== workspaceId) {
    throw new Error("Server workspace summary does not match the local replica");
  }
  return mutateWorkspaceReplica(workspaceId, (current) => {
    const currentAccess = normalizeWorkspaceAccessState(
      current.authorization,
    );
    if (!workspaceAccessVersionsMatch(currentAccess, expectedAccess)) {
      throw new WorkspaceAuthorizationConflictError();
    }
    if (!shouldApplyWorkspaceAccess(currentAccess, candidate)) {
      throw new WorkspaceAuthorizationConflictError();
    }
    const currentServer = current.serverSummary
      ? normalizeServerWorkspaceSummary(current.serverSummary)
      : null;
    const nextServer = normalizedServer === undefined
      ? currentServer
      : normalizedServer === null
        ? null
        : !currentServer ||
            !workspaceAccountIdsMatch(
              normalizedServer.accountId,
              currentServer.accountId,
            ) ||
            compareServerWorkspaceSummaries(
              normalizedServer,
              currentServer,
            ) >= 0
          ? normalizedServer
          : currentServer;
    return {
      ...current,
      authorization: candidate,
      outbox: scopeOutboxForWorkspaceAccess(
        current.outbox,
        currentAccess,
        candidate,
      ),
      serverSummary: nextServer,
    };
  });
}

export async function activateWorkspaceReplica(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<LocalReplica | null> {
  requireWorkspaceActivation(signal);
  const db = await database();
  requireWorkspaceActivation(signal);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const stopWatching = cancelTransactionOnAbort(
      transaction,
      signal,
    );
    const store = transaction.objectStore(STORE);
    const request = store.get(workspaceKey(workspaceId));
    let replica: LocalReplica | null = null;
    let activationError: unknown;
    request.onsuccess = () => {
      try {
        requireWorkspaceActivation(signal);
        replica = request.result as LocalReplica | undefined ?? null;
        if (!replica) return;
        normalizeLocalReplica(replica);
        store.put(replica, ACTIVE_KEY);
        store.put(replica, workspaceKey(workspaceId));
      } catch (error) {
        activationError = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => {
      stopWatching();
      resolve(replica);
    };
    transaction.onerror = () => {
      stopWatching();
      reject(activationError ?? transaction.error);
    };
    transaction.onabort = () => {
      stopWatching();
      reject(
        activationError ?? (signal?.aborted
          ? workspaceActivationCancelled(signal)
          : transaction.error),
      );
    };
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
    const activeRequest = store.get(ACTIVE_KEY);
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
      store.put(selected, ACTIVE_KEY);
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

export async function activateOrInsertServerWorkspaceReplica(
  candidate: LocalReplica,
  signal?: AbortSignal,
): Promise<LocalReplica> {
  requireWorkspaceActivation(signal);
  const prepared = normalizeLocalReplica(structuredClone(candidate));
  const workspaceId = prepared.state.workspace.id;
  const authorization = prepared.authorization;
  const summary = prepared.serverSummary;
  if (
    authorization?.kind !== "server" ||
    authorization.status !== "active" ||
    !authorization.role ||
    !authorization.capabilities.read ||
    !summary ||
    summary.id !== workspaceId ||
    summary.name !== prepared.state.workspace.name ||
    summary.revision !== prepared.state.workspace.revision ||
    summary.role !== authorization.role ||
    summary.membershipRevision !==
      authorization.membershipRevision ||
    summary.accessRevision !== authorization.accessRevision ||
    !workspaceAccountIdsMatch(
      summary.accountId,
      authorization.accountId,
    ) ||
    !WORKSPACE_CAPABILITY_KEYS.every(
      capability =>
        summary.capabilities[capability] ===
          authorization.capabilities[capability],
    )
  ) {
    throw new Error(
      "The downloaded workspace is missing matching server authorization metadata",
    );
  }
  const db = await database();
  requireWorkspaceActivation(signal);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const stopWatching = cancelTransactionOnAbort(
      transaction,
      signal,
    );
    const store = transaction.objectStore(STORE);
    const workspaceRequest = store.get(workspaceKey(workspaceId));
    const activeRequest = store.get(ACTIVE_KEY);
    let workspace: LocalReplica | null = null;
    let active: LocalReplica | null = null;
    let workspaceReady = false;
    let activeReady = false;
    let selected: LocalReplica | null = null;
    let updateError: unknown;
    const activate = () => {
      if (!workspaceReady || !activeReady) return;
      try {
        requireWorkspaceActivation(signal);
        const existing = workspace ??
          (active?.state.workspace.id === workspaceId ? active : null);
        if (existing) {
          normalizeLocalReplica(existing);
          const existingAuthorization = existing.authorization ??
            deviceOnlyWorkspaceAccess();
          const authorization = shouldApplyWorkspaceAccess(
              existingAuthorization,
              prepared.authorization!,
            )
            ? prepared.authorization
            : existing.authorization;
          const serverSummary = !existing.serverSummary ||
              !workspaceAccountIdsMatch(
                prepared.serverSummary!.accountId,
                existing.serverSummary.accountId,
              ) ||
              compareServerWorkspaceSummaries(
                prepared.serverSummary!,
                existing.serverSummary,
              ) >= 0
            ? prepared.serverSummary
            : existing.serverSummary;
          selected = {
            ...existing,
            authorization,
            outbox: scopeOutboxForWorkspaceAccess(
              existing.outbox,
              existingAuthorization,
              prepared.authorization!,
            ),
            serverSummary,
          };
        } else {
          selected = prepared;
        }
        if (active && active.state.workspace.id !== workspaceId) {
          store.put(active, workspaceKey(active.state.workspace.id));
        }
        store.put(selected, workspaceKey(workspaceId));
        store.put(selected, ACTIVE_KEY);
      } catch (error) {
        updateError = error;
        transaction.abort();
      }
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
    transaction.oncomplete = () => {
      stopWatching();
      resolve(selected ?? prepared);
    };
    transaction.onerror = () => {
      stopWatching();
      reject(updateError ?? transaction.error);
    };
    transaction.onabort = () => {
      stopWatching();
      reject(
        updateError ??
          (
            signal?.aborted
              ? workspaceActivationCancelled(signal)
              : transaction.error
          ) ??
          new Error("Could not open the server workspace"),
      );
    };
  });
}

export async function replaceReplica(replica: LocalReplica, previousWorkspaceId?: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.put(replica, ACTIVE_KEY);
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
    const request = store.get(ACTIVE_KEY);
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
      store.put(replica, ACTIVE_KEY);
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
  return state.commandReceipts?.includes(commandId) ||
    state.activities.some((activity) => activity.commandId === commandId) ||
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
  return{...latest,state,outbox};
}
