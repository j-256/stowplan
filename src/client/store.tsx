"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { applyCommand } from "../domain/commands";
import { createEnvelope } from "../domain/factories";
import type { Command, WorkspaceState } from "../domain/types";
import { readReplica, writeReplica, type LocalReplica } from "./local-replica";

interface StoreValue {
  dispatch: (command: Command) => Promise<void>;
  initialize: (state: WorkspaceState) => Promise<void>;
  online: boolean;
  pending: number;
  replace: (state: WorkspaceState) => Promise<void>;
  state: WorkspaceState | null;
  syncing: boolean;
}

const Store = createContext<StoreValue | null>(null);

export function StowplanProvider({ children }: { children: React.ReactNode }) {
  const [replica, setReplica] = useState<LocalReplica | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { readReplica().then(value => { setReplica(value); setLoaded(true); }); }, []);
  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    addEventListener("online", update); addEventListener("offline", update);
    return () => { removeEventListener("online", update); removeEventListener("offline", update); };
  }, []);

  const flush = useCallback(async (value: LocalReplica) => {
    if (!navigator.onLine || value.outbox.length === 0) return;
    setSyncing(true);
    try {
      const response = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commands: value.outbox.map(x => x.envelope), workspaceId: value.state.workspace.id }) });
      if (response.status === 401 || response.status === 404) return;
      if (!response.ok) throw new Error(`Sync failed (${response.status})`);
      const body = await response.json() as { state: WorkspaceState };
      const next = { state: body.state, outbox: [], updatedAt: new Date().toISOString() };
      await writeReplica(next); setReplica(next);
    } catch { /* Local state stays authoritative; visibility/manual/online events retry. */ }
    finally { setSyncing(false); }
  }, []);

  const schedule = useCallback((value: LocalReplica) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(value), 1800);
    if (!maxTimer.current) maxTimer.current = setTimeout(() => { maxTimer.current = null; void flush(value); }, 8000);
  }, [flush]);

  useEffect(() => {
    if (!replica) return;
    const immediate = () => void flush(replica);
    const visible = () => { if (document.visibilityState === "visible") immediate(); };
    addEventListener("online", immediate); document.addEventListener("visibilitychange", visible);
    const reconciliation = setInterval(immediate, 300_000);
    return () => { removeEventListener("online", immediate); document.removeEventListener("visibilitychange", visible); clearInterval(reconciliation); };
  }, [flush, replica]);

  const dispatch = useCallback(async (command: Command) => {
    if (!replica) return;
    const envelope = createEnvelope(replica.state, command);
    const next: LocalReplica = { state: applyCommand(replica.state, envelope).state, outbox: [...replica.outbox, { envelope, status: "pending" }], updatedAt: new Date().toISOString() };
    await writeReplica(next); setReplica(next); schedule(next);
  }, [replica, schedule]);
  const initialize = useCallback(async (state: WorkspaceState) => { const next={state,outbox:[],updatedAt:new Date().toISOString()} satisfies LocalReplica; await writeReplica(next); setReplica(next); }, []);
  const replace = initialize;
  const value = useMemo(() => ({ dispatch, initialize, online, pending: replica?.outbox.length ?? 0, replace, state: replica?.state ?? null, syncing }), [dispatch, initialize, online, replace, replica, syncing]);
  if (!loaded) return <div className="loading">Opening your local workspace…</div>;
  return <Store.Provider value={value}>{children}</Store.Provider>;
}

export function useStowplan() { const value=useContext(Store); if(!value) throw new Error("useStowplan requires StowplanProvider"); return value; }
