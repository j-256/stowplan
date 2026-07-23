"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { applyCommand } from "../domain/commands";
import { createEnvelope } from "../domain/factories";
import type { Command, SyncReceipt, WorkspaceState } from "../domain/types";
import { activateOrInsertWorkspaceReplica, activateWorkspaceReplica, canRebaseQueuedCommand, deleteWorkspaceReplica, listWorkspaceReplicas, mutateReplica, mutateWorkspaceReplica, readReplica, readWorkspaceReplica, reconcileReplica, reconciliationTargets, replaceReplicaIfUnchanged, writeReplica, type LocalReplica } from "./local-replica";

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
}

const Store = createContext<StoreValue | null>(null);

export function StowplanProvider({ children }: { children: React.ReactNode }) {
  const [replica, setReplica] = useState<LocalReplica | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [backupConfigured, setBackupConfigured] = useState<boolean | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const queuedCommandIds = useRef(new Set<string>());
  const flushPromises = useRef(new Map<string, Promise<void>>());
  const followUpFlushes = useRef(new Map<string, boolean>());
  const flushWorkspaceRef = useRef<(workspaceId: string, allowEmpty?: boolean) => Promise<void>>(
    () => Promise.resolve(),
  );
  const syncingOperations = useRef(0);
  const syncTimers = useRef(new Map<string, {
    idle: ReturnType<typeof setTimeout> | null;
    maximum: ReturnType<typeof setTimeout> | null;
  }>());

  useEffect(() => {
    void mutateReplica((current) => current).then(value => {
      setReplica(value);
      setLoaded(true);
    }).catch((error) => {
      setLoadError(error instanceof Error ? error.message : "On-device storage is unavailable");
      setLoaded(true);
    });
  }, []);
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
        if (backupConfigured === false) return;
        const value = await readWorkspaceReplica(workspaceId);
        if (!value || !navigator.onLine) return;
        attemptedWorkspaceId = value.state.workspace.id;
        const batch = value.outbox.filter(entry => entry.status === "pending");
        if (!allowEmpty && batch.length === 0) return;
        syncingOperations.current += 1;
        countedAsSyncing = true;
        setSyncing(true);
        const response = await fetch("/api/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commands: batch.map(entry => entry.envelope), snapshot: value.state, workspaceId: value.state.workspace.id }),
        });
        if (response.status === 503) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          if (body?.error === "Durable storage is not configured") {
            setBackupConfigured(false);
            await recordSyncAttempt(value.state.workspace.id, "Server backup is not configured for this deployment.");
            return;
          }
          throw new Error(body?.error ?? "Server backup is temporarily unavailable.");
        }
        if (response.status === 401) {
          setBackupConfigured(true);
          await recordSyncAttempt(value.state.workspace.id, "Sign in to back up this workspace.");
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
            setReplica((current) => current?.state.workspace.id === value.state.workspace.id ? next : current);
          }
          return;
        }
        if (response.status === 403) {
          setBackupConfigured(true);
          await recordSyncAttempt(value.state.workspace.id, "This account has read-only or no access to the workspace.");
          return;
        }
        if (!response.ok) throw new Error(`Sync failed (${response.status})`);
        setBackupConfigured(true);
        const body = await response.json() as { receipts: SyncReceipt[]; state: WorkspaceState };
        const syncedAt = new Date().toISOString();
        const next = await mutateWorkspaceReplica(value.state.workspace.id, (latest) => ({
          ...reconcileReplica(latest, batch, body.state, body.receipts),
          lastSyncAttemptAt: syncedAt,
          lastSyncError: null,
          lastSyncedAt: syncedAt,
        }));
        if (next) {
          setReplica((current) => current?.state.workspace.id === value.state.workspace.id ? next : current);
        }
      } catch (error) {
        // Local state stays authoritative; visibility/manual/online events retry.
        if (attemptedWorkspaceId) await recordSyncAttempt(attemptedWorkspaceId, error instanceof Error ? error.message : "Server backup is temporarily unavailable.");
      } finally {
        if (countedAsSyncing) {
          syncingOperations.current -= 1;
          setSyncing(syncingOperations.current > 0);
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
  }, [backupConfigured, recordSyncAttempt]);
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
        if (!response.ok || !body.state) throw new Error(body.error ?? "Could not open that workspace");
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
  }), [backupConfigured, dispatch, initialize, online, openWorkspace, removeWorkspace, replace, replica, syncing]);
  if (!loaded) return <div className="loading">Opening your local workspace…</div>;
  if (loadError) return <main className="storage-error" role="alert"><h1>On-device storage could not be opened</h1><p>Stowplan has not changed your inventory. Check this browser’s storage or private-browsing settings, then reload.</p><small>{loadError}</small><button onClick={() => location.reload()}>Reload Stowplan</button></main>;
  return <Store.Provider value={value}>{children}</Store.Provider>;
}

export function useStowplan() {
  const value = useContext(Store);
  if (!value) throw new Error("useStowplan requires StowplanProvider");
  return value;
}
