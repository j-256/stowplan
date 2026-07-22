"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { applyCommand } from "../domain/commands";
import { createEnvelope } from "../domain/factories";
import type { Command, SyncReceipt, WorkspaceState } from "../domain/types";
import { readReplica, readWorkspaceReplica, reconcileReplica, replaceReplica, writeReplica, type LocalReplica } from "./local-replica";

interface StoreValue {
  blocked: number;
  dispatch: (command: Command) => Promise<void>;
  initialize: (state: WorkspaceState) => Promise<void>;
  online: boolean;
  openWorkspace: (workspaceId: string) => Promise<void>;
  pending: number;
  replace: (state: WorkspaceState) => Promise<void>;
  state: WorkspaceState | null;
  syncing: boolean;
}

const Store = createContext<StoreValue | null>(null);

export function StowplanProvider({ children }: { children: React.ReactNode }) {
  const [replica, setReplica] = useState<LocalReplica | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const flushPromise = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void readReplica().then(async value => {
      if (value) await writeReplica(value); // Backfill the per-workspace key for pre-v1 replicas.
      setReplica(value);
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

  const clearSchedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (maxTimer.current) clearTimeout(maxTimer.current);
    timer.current = null;
    maxTimer.current = null;
  }, []);

  const flush = useCallback((allowEmpty = false): Promise<void> => {
    if (flushPromise.current) return flushPromise.current;
    const operation = (async () => {
      try {
        const value = await readReplica();
        if (!value || !navigator.onLine) return;
        const batch = value.outbox.filter(entry => entry.status === "pending");
        if (!allowEmpty && batch.length === 0) return;
        setSyncing(true);
        const response = await fetch("/api/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commands: batch.map(entry => entry.envelope), snapshot: value.state, workspaceId: value.state.workspace.id }),
        });
        if (response.status === 401 || response.status === 404) return;
        if (response.status === 403 && batch.length) {
          const latest = await readReplica();
          if (!latest || latest.state.workspace.id !== value.state.workspace.id) return;
          const denied = new Set(batch.map(entry => entry.envelope.id));
          const next = {
            ...latest,
            outbox: latest.outbox.map(entry => denied.has(entry.envelope.id) ? { ...entry, status: "blocked" as const, error: "This account has read-only or no access to the workspace" } : entry),
            updatedAt: new Date().toISOString(),
          };
          await writeReplica(next);
          setReplica(next);
          return;
        }
        if (!response.ok) throw new Error(`Sync failed (${response.status})`);
        const body = await response.json() as { receipts: SyncReceipt[]; state: WorkspaceState };
        const latest = await readReplica();
        if (!latest || latest.state.workspace.id !== value.state.workspace.id) return;
        const next = reconcileReplica(latest, batch, body.state, body.receipts);
        await writeReplica(next);
        setReplica(next);
      } catch {
        // Local state stays authoritative; visibility/manual/online events retry.
      } finally {
        setSyncing(false);
      }
    })();
    flushPromise.current = operation;
    void operation.finally(() => {
      if (flushPromise.current === operation) flushPromise.current = null;
    });
    return operation;
  }, []);

  const flushNow = useCallback((allowEmpty = false) => {
    clearSchedule();
    return flush(allowEmpty);
  }, [clearSchedule, flush]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flushNow(false), 1_800);
    if (!maxTimer.current) maxTimer.current = setTimeout(() => void flushNow(false), 8_000);
  }, [flushNow]);

  const activeWorkspaceId = replica?.state.workspace.id;
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const immediate = () => void flushNow(true);
    const visible = () => { if (document.visibilityState === "visible") immediate(); };
    addEventListener("online", immediate);
    document.addEventListener("visibilitychange", visible);
    const reconciliation = setInterval(immediate, 300_000);
    return () => {
      removeEventListener("online", immediate);
      document.removeEventListener("visibilitychange", visible);
      clearInterval(reconciliation);
    };
  }, [activeWorkspaceId, flushNow]);
  useEffect(() => clearSchedule, [clearSchedule]);

  const dispatch = useCallback((command: Command) => {
    const operation = mutationQueue.current.then(async () => {
      const current = await readReplica();
      if (!current) return;
      const envelope = createEnvelope(current.state, command);
      const next: LocalReplica = {
        state: applyCommand(current.state, envelope).state,
        outbox: [...current.outbox, { envelope, status: "pending" }],
        updatedAt: new Date().toISOString(),
      };
      await writeReplica(next);
      setReplica(next);
      schedule();
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [schedule]);

  const initialize = useCallback(async (state: WorkspaceState) => {
    const next = { state, outbox: [], updatedAt: new Date().toISOString() } satisfies LocalReplica;
    await writeReplica(next);
    setReplica(next);
  }, []);

  const openWorkspace = useCallback((workspaceId: string) => {
    const operation = mutationQueue.current.then(async () => {
      const active = await readReplica();
      if (active?.state.workspace.id === workspaceId) return;
      let next = await readWorkspaceReplica(workspaceId);
      if (!next) {
        const response = await fetch(`/api/snapshot?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
        const body = await response.json() as { error?: string; state?: WorkspaceState };
        if (!response.ok || !body.state) throw new Error(body.error ?? "Could not open that workspace");
        next = { state: body.state, outbox: [], updatedAt: new Date().toISOString() };
      }
      await writeReplica(next);
      setReplica(next);
      if (next.outbox.some(entry => entry.status === "pending")) schedule();
      else void flushNow(true);
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [flushNow, schedule]);

  const replace = useCallback((state: WorkspaceState) => {
    const operation = mutationQueue.current.then(async () => {
      clearSchedule();
      const current = await readReplica();
      const next = { state, outbox: [], updatedAt: new Date().toISOString() } satisfies LocalReplica;
      await replaceReplica(next, current?.state.workspace.id);
      setReplica(next);
    });
    mutationQueue.current = operation.catch(() => undefined);
    return operation;
  }, [clearSchedule]);
  const value = useMemo(() => ({
    blocked: replica?.outbox.filter(entry => entry.status === "blocked").length ?? 0,
    dispatch,
    initialize,
    online,
    openWorkspace,
    pending: replica?.outbox.filter(entry => entry.status === "pending").length ?? 0,
    replace,
    state: replica?.state ?? null,
    syncing,
  }), [dispatch, initialize, online, openWorkspace, replace, replica, syncing]);
  if (!loaded) return <div className="loading">Opening your local workspace…</div>;
  return <Store.Provider value={value}>{children}</Store.Provider>;
}

export function useStowplan() {
  const value = useContext(Store);
  if (!value) throw new Error("useStowplan requires StowplanProvider");
  return value;
}
