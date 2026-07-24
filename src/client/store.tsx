"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { applyCommand } from "../domain/commands";
import { createEnvelope } from "../domain/factories";
import type { Command, SyncReceipt, WorkspaceState } from "../domain/types";
import { activateOrInsertWorkspaceReplica, activateWorkspaceReplica, canRebaseQueuedCommand, deleteWorkspaceReplica, listWorkspaceReplicas, mutateReplica, mutateWorkspaceReplica, readReplica, readWorkspaceReplica, reconcileReplica, reconciliationTargets, replaceReplicaIfUnchanged, selectPendingSyncBatch, writeReplica, type LocalReplica } from "./local-replica";

export const DEVICE_ONLY_BACKUP_ERROR = "Server backup is not configured for this deployment.";

export class WorkspaceOpenError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkspaceOpenError";
    this.status = status;
  }
}

const BACKUP_UNAVAILABLE_API_ERROR = "Durable storage is not configured";
const BACKUP_UNAVAILABLE_SESSION_KEY = "stowplan-backup-unavailable-at";
const BACKUP_RETRY_INTERVAL_MS = 5 * 60 * 1_000;
const SIGN_IN_BACKUP_ERROR = "Sign in to back up this workspace.";

type BackupAccess = "available" | "checking" | "idle" | "signed-out" | "unavailable";

function backupRetryDelay(now = Date.now()): number {
  try {
    const unavailableAt = Number(sessionStorage.getItem(BACKUP_UNAVAILABLE_SESSION_KEY));
    if (!Number.isFinite(unavailableAt) || unavailableAt <= 0) return 0;
    return Math.min(
      BACKUP_RETRY_INTERVAL_MS,
      Math.max(0, unavailableAt + BACKUP_RETRY_INTERVAL_MS - now),
    );
  } catch {
    return 0;
  }
}

function rememberBackupUnavailable(): void {
  try {
    sessionStorage.setItem(BACKUP_UNAVAILABLE_SESSION_KEY, String(Date.now()));
  } catch {
    // Capability caching is optional
  }
}

function forgetBackupUnavailable(): void {
  try {
    sessionStorage.removeItem(BACKUP_UNAVAILABLE_SESSION_KEY);
  } catch {
    // Capability caching is optional
  }
}

interface StoreValue {
  backupConfigured: boolean | null;
  blocked: number;
  dispatch: (command: Command) => Promise<void>;
  initialize: (state: WorkspaceState) => Promise<void>;
  lastSyncAttemptAt: string | null;
  lastSyncError: string | null;
  lastSyncedAt: string | null;
  localUpdatedAt: string | null;
  online: boolean;
  openWorkspace: (workspaceId: string) => Promise<void>;
  pending: number;
  removeWorkspace: (workspaceId: string, expectedUpdatedAt?: string) => Promise<void>;
  replace: (state: WorkspaceState) => Promise<void>;
  state: WorkspaceState | null;
  syncing: boolean;
  workspaceStatusRevision: number;
}

const Store = createContext<StoreValue | null>(null);

export function StowplanProvider({ children }: { children: React.ReactNode }) {
  const [replica, setReplica] = useState<LocalReplica | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [syncingWorkspaceIds, setSyncingWorkspaceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [workspaceStatusRevision, setWorkspaceStatusRevision] = useState(0);
  const [backupConfigured, setBackupConfigured] = useState<boolean | null>(null);
  const [backupAccess, setBackupAccess] = useState<BackupAccess>("idle");
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const queuedCommandIds = useRef(new Set<string>());
  const flushPromises = useRef(new Map<string, Promise<void>>());
  const followUpFlushes = useRef(new Map<string, boolean>());
  const flushWorkspaceRef = useRef<(workspaceId: string, allowEmpty?: boolean) => Promise<void>>(
    () => Promise.resolve(),
  );
  const syncTimers = useRef(new Map<string, {
    idle: ReturnType<typeof setTimeout> | null;
    maximum: ReturnType<typeof setTimeout> | null;
  }>());

  useEffect(() => {
    void mutateReplica((current) => current).then(value => {
      if (backupRetryDelay() > 0) {
        setBackupConfigured(false);
        setBackupAccess("unavailable");
      } else {
        setBackupAccess("checking");
      }
      setReplica(value);
      setLoaded(true);
    }).catch((error) => {
      setLoadError(error instanceof Error ? error.message : "On-device storage is unavailable");
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (backupAccess !== "checking") return;
    let active = true;
    void fetch("/api/auth/me", { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as {
        configured?: boolean;
        user?: unknown;
      };
      if (!response.ok) throw new Error("Could not check server backup access");
      if (!active) return;
      if (!body.configured) {
        rememberBackupUnavailable();
        setBackupConfigured(false);
        setBackupAccess("unavailable");
        return;
      }
      forgetBackupUnavailable();
      setBackupConfigured(true);
      setBackupAccess(body.user ? "available" : "signed-out");
    }).catch(() => {
      if (!active) return;
      setBackupConfigured(null);
      setBackupAccess("available");
    });
    return () => { active = false; };
  }, [backupAccess]);
  useEffect(() => {
    if (backupAccess !== "unavailable") return;
    const retry = setTimeout(
      () => {
        setBackupConfigured(null);
        setBackupAccess("checking");
      },
      backupRetryDelay() || BACKUP_RETRY_INTERVAL_MS,
    );
    return () => clearTimeout(retry);
  }, [backupAccess]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, []);

  const clearSchedule = useCallback((workspaceId?: string) => {
    const entries = workspaceId
      ? [[workspaceId, syncTimers.current.get(workspaceId)] as const]
      : [...syncTimers.current.entries()];
    for (const [id, entry] of entries) {
      if (entry?.idle) clearTimeout(entry.idle);
      if (entry?.maximum) clearTimeout(entry.maximum);
      syncTimers.current.delete(id);
    }
  }, []);

  const recordSyncAttempt = useCallback(async (workspaceId: string, error: string | null, syncedAt?: string) => {
    const attemptedAt = new Date().toISOString();
    const next = await mutateWorkspaceReplica(workspaceId, (latest) => ({
      ...latest,
      lastSyncAttemptAt: attemptedAt,
      lastSyncError: error,
      lastSyncedAt: syncedAt ?? latest.lastSyncedAt ?? null,
    }));
    if (next) {
      setWorkspaceStatusRevision((current) => current + 1);
      setReplica((current) => current?.state.workspace.id === workspaceId ? next : current);
    }
  }, []);

  const flushWorkspace = useCallback((workspaceId: string, allowEmpty = false): Promise<void> => {
    const existing = flushPromises.current.get(workspaceId);
    if (existing) {
      followUpFlushes.current.set(
        workspaceId,
        allowEmpty || followUpFlushes.current.get(workspaceId) === true,
      );
      return existing;
    }
    const operation = (async () => {
      let attemptedWorkspaceId: string | null = null;
      let countedAsSyncing = false;
      try {
        if (
          backupAccess === "checking" ||
          backupAccess === "idle" ||
          backupAccess === "unavailable" ||
          backupConfigured === false
        ) return;
        if (backupAccess === "signed-out") {
          await recordSyncAttempt(workspaceId, SIGN_IN_BACKUP_ERROR);
          return;
        }
        const value = await readWorkspaceReplica(workspaceId);
        if (!value || !navigator.onLine) return;
        attemptedWorkspaceId = value.state.workspace.id;
        const pendingCount = value.outbox.filter(
          (entry) => entry.status === "pending",
        ).length;
        const batch = selectPendingSyncBatch(value.outbox);
        if (!allowEmpty && batch.length === 0) return;
        countedAsSyncing = true;
        setSyncingWorkspaceIds((current) => {
          const next = new Set(current);
          next.add(workspaceId);
          return next;
        });
        const response = await fetch("/api/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commands: batch.map(entry => entry.envelope), snapshot: value.state, workspaceId: value.state.workspace.id }),
        });
        if (response.status === 503) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          if (body?.error === BACKUP_UNAVAILABLE_API_ERROR) {
            rememberBackupUnavailable();
            setBackupConfigured(false);
            setBackupAccess("unavailable");
            await recordSyncAttempt(value.state.workspace.id, DEVICE_ONLY_BACKUP_ERROR);
            return;
          }
          throw new Error(body?.error ?? "Server backup is temporarily unavailable.");
        }
        forgetBackupUnavailable();
        if (response.status === 401) {
          setBackupConfigured(true);
          setBackupAccess("signed-out");
          await recordSyncAttempt(value.state.workspace.id, SIGN_IN_BACKUP_ERROR);
          return;
        }
        if (response.status === 404) {
          setBackupConfigured(true);
          await recordSyncAttempt(value.state.workspace.id, "The server workspace was not found.");
          return;
        }
        if (response.status === 403 && batch.length) {
          setBackupConfigured(true);
          const denied = new Set(batch.map(entry => entry.envelope.id));
          const next = await mutateWorkspaceReplica(value.state.workspace.id, (latest) => ({
            ...latest,
            lastSyncAttemptAt: new Date().toISOString(),
            lastSyncError: "This account has read-only or no access to the workspace.",
            outbox: latest.outbox.map(entry => denied.has(entry.envelope.id) ? { ...entry, status: "blocked" as const, error: "This account has read-only or no access to the workspace" } : entry),
          }));
          if (next) {
            setWorkspaceStatusRevision((current) => current + 1);
            setReplica((current) => current?.state.workspace.id === value.state.workspace.id ? next : current);
          }
          return;
        }
        if (response.status === 403) {
          setBackupConfigured(true);
          await recordSyncAttempt(value.state.workspace.id, "This account has read-only or no access to the workspace.");
          return;
        }
        if (!response.ok) {
          const body = await response.json().catch(() => null) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? `Sync failed (${response.status})`);
        }
        setBackupConfigured(true);
        setBackupAccess("available");
        const body = await response.json() as { receipts: SyncReceipt[]; state: WorkspaceState };
        const syncedAt = new Date().toISOString();
        const next = await mutateWorkspaceReplica(value.state.workspace.id, (latest) => ({
          ...reconcileReplica(latest, batch, body.state, body.receipts),
          lastSyncAttemptAt: syncedAt,
          lastSyncError: null,
          lastSyncedAt: syncedAt,
        }));
        if (next) {
          setWorkspaceStatusRevision((current) => current + 1);
          setReplica((current) => current?.state.workspace.id === value.state.workspace.id ? next : current);
          if (pendingCount > batch.length) {
            followUpFlushes.current.set(workspaceId, false);
          }
        }
      } catch (error) {
        // Local state stays authoritative; visibility/manual/online events retry
        if (attemptedWorkspaceId) await recordSyncAttempt(attemptedWorkspaceId, error instanceof Error ? error.message : "Server backup is temporarily unavailable.");
      } finally {
        if (countedAsSyncing) {
          setSyncingWorkspaceIds((current) => {
            const next = new Set(current);
            next.delete(workspaceId);
            return next;
          });
        }
      }
    })();
    flushPromises.current.set(workspaceId, operation);
    void operation.finally(() => {
      if (flushPromises.current.get(workspaceId) === operation) {
        flushPromises.current.delete(workspaceId);
      }
      if (followUpFlushes.current.has(workspaceId)) {
        const followUpAllowsEmpty = followUpFlushes.current.get(workspaceId) === true;
        followUpFlushes.current.delete(workspaceId);
        queueMicrotask(() => void flushWorkspaceRef.current(workspaceId, followUpAllowsEmpty));
      }
    });
    return operation;
  }, [backupAccess, backupConfigured, recordSyncAttempt]);
  useEffect(() => {
    flushWorkspaceRef.current = flushWorkspace;
  }, [flushWorkspace]);

  const schedule = useCallback((workspaceId: string) => {
    const current = syncTimers.current.get(workspaceId) ?? {
      idle: null,
      maximum: null,
    };
    if (current.idle) clearTimeout(current.idle);
    current.idle = setTimeout(() => {
      clearSchedule(workspaceId);
      void flushWorkspace(workspaceId, false);
    }, 1_800);
    if (!current.maximum) {
      current.maximum = setTimeout(() => {
        clearSchedule(workspaceId);
        void flushWorkspace(workspaceId, false);
      }, 8_000);
    }
    syncTimers.current.set(workspaceId, current);
  }, [clearSchedule, flushWorkspace]);

  const activeWorkspaceId = replica?.state.workspace.id;
  const syncing = Boolean(
    activeWorkspaceId && syncingWorkspaceIds.has(activeWorkspaceId),
  );
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const reconcile = async () => {
      const workspaces = await listWorkspaceReplicas().catch(() => []);
      const targets = reconciliationTargets(workspaces, activeWorkspaceId);
      for (const target of targets) clearSchedule(target.workspaceId);
      await Promise.all(
        targets.map((target) =>
          flushWorkspace(target.workspaceId, target.allowEmpty)
        ),
      );
    };
    const immediate = () => void reconcile();
    immediate();
    const visible = () => {
      if (document.visibilityState === "visible") immediate();
    };
    addEventListener("online", immediate);
    document.addEventListener("visibilitychange", visible);
    const reconciliation = setInterval(immediate, 300_000);
    return () => {
      removeEventListener("online", immediate);
      document.removeEventListener("visibilitychange", visible);
      clearInterval(reconciliation);
    };
  }, [activeWorkspaceId, clearSchedule, flushWorkspace]);
  useEffect(() => () => clearSchedule(), [clearSchedule]);

  const dispatch = useCallback((command: Command) => {
    const visibleState = replica?.state;
    if (!visibleState) return Promise.resolve();
    const workspaceId = visibleState.workspace.id;
    const envelope = createEnvelope(visibleState, command);
    const priorCommandIds = [...queuedCommandIds.current];
    queuedCommandIds.current.add(envelope.id);
    const operation = mutationQueue.current.then(async () => {
      let next: LocalReplica | null;
      try {
        next = await mutateWorkspaceReplica(workspaceId, (current) => {
          const effectiveEnvelope = canRebaseQueuedCommand(
            current.state,
            envelope.baseRevision,
            priorCommandIds,
          )
            ? createEnvelope(current.state, command, {
                actorId: envelope.actorId,
                deviceId: envelope.deviceId,
                id: envelope.id,
                timestamp: envelope.timestamp,
              })
            : envelope;
          return {
            ...current,
            state: applyCommand(current.state, effectiveEnvelope).state,
            outbox: [...current.outbox, { envelope: effectiveEnvelope, status: "pending" }],
            updatedAt: new Date().toISOString(),
          };
        });
        if (!next) {
          throw new Error("This workspace was removed from this device. Reopen it before saving.");
        }
      } catch (error) {
        const latest = await readWorkspaceReplica(workspaceId).catch(() => null) ??
          await readReplica().catch(() => null);
        setReplica((current) =>
          current?.state.workspace.id === workspaceId ? latest : current
        );
        throw error;
      }
      setReplica((current) =>
        current?.state.workspace.id === workspaceId ? next : current
      );
      schedule(workspaceId);
    });
    mutationQueue.current = operation.then(
      () => { queuedCommandIds.current.delete(envelope.id); },
      () => { queuedCommandIds.current.delete(envelope.id); },
    );
    return operation;
  }, [replica?.state, schedule]);

  const initialize = useCallback((state: WorkspaceState) => {
    const operation = mutationQueue.current.then(async () => {
      const next = { lastSyncAttemptAt: null, lastSyncError: null, lastSyncedAt: null, state, outbox: [], updatedAt: new Date().toISOString() } satisfies LocalReplica;
      await writeReplica(next);
      setReplica(next);
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, []);

  const openWorkspace = useCallback((workspaceId: string) => {
    const operation = mutationQueue.current.then(async () => {
      let next = await activateWorkspaceReplica(workspaceId);
      if (!next) {
        const response = await fetch(`/api/snapshot?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
        const body = await response.json() as { error?: string; state?: WorkspaceState };
        if (!response.ok || !body.state) {
          throw new WorkspaceOpenError(
            body.error ?? "Could not open that workspace",
            response.status,
          );
        }
        const syncedAt = new Date().toISOString();
        next = await activateOrInsertWorkspaceReplica({
          lastSyncAttemptAt: syncedAt,
          lastSyncError: null,
          lastSyncedAt: syncedAt,
          state: body.state,
          outbox: [],
          updatedAt: syncedAt,
        });
      }
      setReplica(next);
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, []);

  const replace = useCallback((state: WorkspaceState) => {
    const operation = mutationQueue.current.then(async () => {
      const currentWorkspaceId = replica?.state.workspace.id;
      if (!replica) throw new Error("The workspace is no longer open on this device.");
      const next = { lastSyncAttemptAt: null, lastSyncError: null, lastSyncedAt: null, state, outbox: [], updatedAt: new Date().toISOString() } satisfies LocalReplica;
      await replaceReplicaIfUnchanged(next, replica);
      if (currentWorkspaceId) clearSchedule(currentWorkspaceId);
      setReplica(next);
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [clearSchedule, replica]);

  const removeWorkspace = useCallback((workspaceId: string, expectedUpdatedAt?: string) => {
    const operation = mutationQueue.current.then(async () => {
      await deleteWorkspaceReplica(workspaceId, expectedUpdatedAt);
      clearSchedule(workspaceId);
      let next = await readReplica();
      if (!next) {
        const nextSummary = (await listWorkspaceReplicas())[0];
        next = nextSummary ? await activateWorkspaceReplica(nextSummary.id) : null;
      }
      setReplica(next);
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [clearSchedule]);
  const value = useMemo(() => ({
    backupConfigured,
    blocked: replica?.outbox.filter(entry => entry.status === "blocked").length ?? 0,
    dispatch,
    initialize,
    lastSyncAttemptAt: replica?.lastSyncAttemptAt ?? null,
    lastSyncError: replica?.lastSyncError ?? null,
    lastSyncedAt: replica?.lastSyncedAt ?? null,
    localUpdatedAt: replica?.updatedAt ?? null,
    online,
    openWorkspace,
    pending: replica?.outbox.filter(entry => entry.status === "pending").length ?? 0,
    removeWorkspace,
    replace,
    state: replica?.state ?? null,
    syncing,
    workspaceStatusRevision,
  }), [backupConfigured, dispatch, initialize, online, openWorkspace, removeWorkspace, replace, replica, syncing, workspaceStatusRevision]);
  if (!loaded) return <div className="loading">Opening your local workspace…</div>;
  if (loadError) return <main className="storage-error" role="alert"><h1>On-device storage could not be opened</h1><p>Stowplan has not changed your inventory. Check this browser&apos;s storage or private-browsing settings, then reload.</p><small>{loadError}</small><button onClick={() => location.reload()}>Reload Stowplan</button></main>;
  return <Store.Provider value={value}>{children}</Store.Provider>;
}

export function useStowplan() {
  const value = useContext(Store);
  if (!value) throw new Error("useStowplan requires StowplanProvider");
  return value;
}
