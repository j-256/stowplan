"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { applyCommand } from "../../src/domain/commands";
import { createEnvelope } from "../../src/domain/factories";
import { parseSnapshot, previewImport } from "../../src/domain/import";
import type { ImportPreview, WorkspaceState } from "../../src/domain/types";
import { readReplica, writeReplica, type LocalReplica, type OutboxEntry } from "../../src/client/local-replica";

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
function wasApplied(state: WorkspaceState, commandId: string) {
  return state.activities.some((activity) => activity.commandId === commandId) || state.audit.some((event) => event.id === `audit_${commandId}`);
}
function asRestoredCopy(source: WorkspaceState): WorkspaceState {
  const state = structuredClone(source);
  const previousId = state.workspace.id;
  const nextId = `ws_restore_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  state.workspace = { ...state.workspace, id: nextId, name: `${state.workspace.name} (restored copy)`, revision: 0, createdAt: timestamp, updatedAt: timestamp };
  state.activities = state.activities.map((activity) => ({
    ...activity,
    subjectIds: activity.subjectIds.map((id) => id === previousId ? nextId : id),
    patches: activity.patches.map((patch) => patch.target === "workspace" && patch.id === previousId ? { ...patch, id: nextId } : patch),
  }));
  return state;
}

export default function Recovery() {
  const [replica, setReplica] = useState<LocalReplica | null>(null);
  const [incoming, setIncoming] = useState<WorkspaceState | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [serverState, setServerState] = useState<WorkspaceState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const refresh = async () => setReplica(await readReplica());
  useEffect(() => { void readReplica().then(setReplica); }, []);

  const choose = async (file: File) => {
    try {
      const parsed = parseSnapshot(await file.text());
      setIncoming(parsed);
      setPreview(previewImport(replica?.state ?? parsed, parsed));
      setMessage("");
    } catch (error) {
      setIncoming(null);
      setPreview(null);
      setMessage(error instanceof Error ? error.message : "Invalid backup");
    }
  };
  const restoreServer = async () => {
    if (!incoming || !confirmed) return;
    try {
      const currentResponse = await fetch(`/api/snapshot?workspaceId=${encodeURIComponent(incoming.workspace.id)}`, { cache: "no-store" });
      const currentBody = await currentResponse.json() as { error?: string; state?: WorkspaceState };
      if (!currentResponse.ok || !currentBody.state) throw new Error(currentBody.error ?? "Could not load the server workspace");
      const response = await fetch("/api/snapshot", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: incoming.workspace.id, expectedRevision: currentBody.state.workspace.revision, snapshot: incoming }) });
      const body = await response.json() as { error?: string; state?: WorkspaceState };
      if (!response.ok || !body.state) throw new Error(body.error ?? "Could not restore the server workspace");
      await writeReplica({ state: body.state, outbox: [], updatedAt: new Date().toISOString() });
      await refresh();
      setMessage(`Server and device restored at revision ${body.state.workspace.revision}. The previous device workspace remains available in Settings.`);
    } catch (error) { setMessage(`Nothing was changed: ${error instanceof Error ? error.message : "restore failed"}`); }
  };
  const restoreCopy = async () => {
    if (!incoming || !confirmed) return;
    const state = asRestoredCopy(incoming);
    await writeReplica({ state, outbox: [], updatedAt: new Date().toISOString() });
    await refresh();
    setMessage("Backup opened as a separate local workspace. It can initialize its own server copy after you sign in; the previous workspace was preserved.");
  };
  const fetchServer = async () => {
    if (!replica) return;
    setMessage("Loading the authorized server copy…");
    try {
      const response = await fetch(`/api/snapshot?workspaceId=${encodeURIComponent(replica.state.workspace.id)}`, { cache: "no-store" });
      const body = await response.json() as { error?: string; state?: WorkspaceState };
      if (!response.ok || !body.state) throw new Error(body.error ?? "Could not load server copy");
      setServerState(body.state);
      setMessage(`Server copy loaded at revision ${body.state.workspace.revision}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load server copy"); }
  };
  const resetToServer = async () => {
    if (!serverState || confirmation !== "RESET") return;
    await writeReplica({ state: serverState, outbox: [], updatedAt: new Date().toISOString() });
    setConfirmation("");
    await refresh();
    setMessage("This device now matches the server copy. The local queue was cleared.");
  };
  const reapply = async () => {
    if (!replica || !serverState || confirmation !== "REAPPLY") return;
    try {
      let state = structuredClone(serverState);
      const outbox: OutboxEntry[] = [];
      for (const entry of replica.outbox.filter((candidate) => !wasApplied(serverState, candidate.envelope.id))) {
        const envelope = createEnvelope(state, entry.envelope.command, { actorId: entry.envelope.actorId, deviceId: entry.envelope.deviceId });
        state = applyCommand(state, envelope).state;
        outbox.push({ envelope, status: "pending" });
      }
      await writeReplica({ state, outbox, updatedAt: new Date().toISOString() });
      setConfirmation("");
      await refresh();
      setMessage(`${outbox.length} unresolved change(s) rebased as fresh commands. Return to Stowplan to review and back them up.`);
    } catch (error) {
      setMessage(`Nothing was changed: ${error instanceof Error ? error.message : "the queued work could not be reapplied"}`);
    }
  };

  return <main className="admin-page recovery-page"><header><div><p className="eyebrow">Inspect before changing anything</p><h1>Sync & recovery</h1></div><Link href="/">Back</Link></header>
    <section><h2>Device recovery bundle</h2><p className="muted">This export includes the current workspace plus pending or blocked commands and their errors. Export it before any reset.</p><button disabled={!replica} onClick={() => replica && download(`stowplan-recovery-${replica.state.workspace.id}.json`, { format: "stowplan-recovery-v1", exportedAt: new Date().toISOString(), replica })}>Export full recovery bundle</button></section>
    <section><h2>Device queue <small>{replica?.outbox.length ?? 0} changes</small></h2><div className="admin-table recovery-queue">{replica?.outbox.map((entry) => <div key={entry.envelope.id}><span><strong>{entry.envelope.command.type}</strong><small>{new Date(entry.envelope.timestamp).toLocaleString()} · {entry.envelope.id}</small>{entry.error && <em>{entry.error}</em>}</span><b data-status={entry.status}>{entry.status}</b></div>)}{replica && replica.outbox.length === 0 && <p className="muted">No local changes are waiting for backup or review.</p>}</div></section>
    <section><h2>Compare with the server</h2><p className="muted">Sign in first. Loading is read-only. Reset and reapply remain disabled until you export a bundle and type the exact confirmation.</p><button disabled={!replica} onClick={() => void fetchServer()}>Load authorized server copy</button>{serverState && replica && <><div className="preview-grid"><span><b>{replica.state.workspace.revision}</b>device revision</span><span><b>{serverState.workspace.revision}</b>server revision</span><span><b>{replica.outbox.length}</b>queued changes</span></div><label>Type <code>REAPPLY</code> to rebuild unresolved queued work on the server copy, or <code>RESET</code> to discard the device queue.<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><div className="recovery-actions"><button disabled={confirmation !== "REAPPLY"} onClick={() => void reapply()}>Reapply queued work on server copy</button><button className="danger" disabled={confirmation !== "RESET"} onClick={() => void resetToServer()}>Reset this device to server copy</button></div></>}</section>
    <section><h2>Restore a portable JSON backup</h2><p className="muted">Owner restore replaces the matching server workspace with compare-and-swap protection. A restored copy receives a new workspace id, works offline, and never erases the current local workspace.</p><label className="file">Choose JSON backup<input type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void choose(file); }} /></label>{preview && <div className="preview-grid"><span><b>{preview.replacing.locations} → {preview.incoming.locations}</b>locations</span><span><b>{preview.replacing.items} → {preview.incoming.items}</b>items</span><span><b>{preview.replacing.plans} → {preview.incoming.plans}</b>plans</span></div>}{preview?.issues.map((issue) => <p key={`${issue.code}-${issue.path}`} className={issue.severity}>{issue.path}: {issue.message}</p>)}{preview?.valid && <><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the validation report and these counts.</label><div className="recovery-actions"><button className="primary" disabled={!confirmed} onClick={() => void restoreServer()}>Restore matching server & device</button><button disabled={!confirmed} onClick={() => void restoreCopy()}>Open as separate local copy</button></div></>}</section>
    {message && <output>{message}</output>}
  </main>;
}
