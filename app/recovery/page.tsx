"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { applyCommand } from "../../src/domain/commands";
import { createEnvelope } from "../../src/domain/factories";
import { previewImport } from "../../src/domain/import";
import type { ImportPreview, WorkspaceState } from "../../src/domain/types";
import { parseRecoveryUpload } from "../../src/client/recovery-bundle";
import {
  readReplica,
  readWorkspaceReplica,
  replicaVersionMatches,
  writeReplica,
  writeReplicaIfUnchanged,
  writeWorkspaceReplicaIfUnchanged,
  type LocalReplica,
  type OutboxEntry,
} from "../../src/client/local-replica";

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
function replicaVersion(replica: LocalReplica): string {
  return [
    replica.state.workspace.id,
    replica.state.workspace.revision,
    replica.updatedAt,
    ...replica.outbox.map((entry) => `${entry.envelope.id}:${entry.status}`),
  ].join("|");
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
  const [incomingBundle, setIncomingBundle] = useState<LocalReplica | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [serverState, setServerState] = useState<WorkspaceState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [exportedVersion, setExportedVersion] = useState<string | null>(null);
  const [exportAcknowledged, setExportAcknowledged] = useState(false);
  const [restoreActive, setRestoreActive] = useState<LocalReplica | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<LocalReplica | null>(null);
  const [restoreServerBaseline, setRestoreServerBaseline] =
    useState<WorkspaceState | null>(null);
  const [serverExportedRevision, setServerExportedRevision] =
    useState<number | null>(null);
  const [serverExportAcknowledged, setServerExportAcknowledged] =
    useState(false);
  const [targetExportedVersion, setTargetExportedVersion] = useState<string | null>(null);
  const [targetExportAcknowledged, setTargetExportAcknowledged] =
    useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = async () => setReplica(await readReplica());
  useEffect(() => {
    void readReplica()
      .then(setReplica)
      .catch((error) => setMessage(
        error instanceof Error ? error.message : "On-device storage is unavailable",
      ));
  }, []);

  const loadServerState = async (workspaceId: string): Promise<WorkspaceState> => {
    const response = await fetch(
      `/api/snapshot?workspaceId=${encodeURIComponent(workspaceId)}`,
      { cache: "no-store" },
    );
    const body = await response.json() as { error?: string; state?: WorkspaceState };
    if (!response.ok || !body.state) {
      throw new Error(body.error ?? "Could not load the server workspace");
    }
    return body.state;
  };

  const choose = async (file: File) => {
    setConfirmed(false);
    setTargetExportedVersion(null);
    setTargetExportAcknowledged(false);
    setRestoreServerBaseline(null);
    setServerExportedRevision(null);
    setServerExportAcknowledged(false);
    setMessage("Validating the backup and loading its matching server workspace…");
    setBusy(true);
    try {
      const upload = parseRecoveryUpload(await file.text());
      const parsed = upload.state;
      const [active, target] = await Promise.all([
        readReplica(),
        readWorkspaceReplica(parsed.workspace.id),
      ]);
      const matchingTarget = target ??
        (
          active?.state.workspace.id === parsed.workspace.id
            ? active
            : null
        );
      let reviewedServer: WorkspaceState | null = null;
      let serverLoadError = "";
      try {
        reviewedServer = await loadServerState(parsed.workspace.id);
      } catch (error) {
        serverLoadError = error instanceof Error
          ? error.message
          : "Could not load the server workspace";
      }
      setReplica(active);
      setRestoreActive(active);
      setRestoreTarget(matchingTarget);
      setRestoreServerBaseline(reviewedServer);
      setIncoming(parsed);
      setIncomingBundle(upload.bundle);
      setPreview(previewImport(reviewedServer ?? parsed, parsed));
      setMessage(
        reviewedServer
          ? `Authorized server copy loaded at revision ${reviewedServer.workspace.revision}.`
          : `Backup validated, but the matching server comparison is unavailable. Owner restore stays disabled: ${serverLoadError}`,
      );
    } catch (error) {
      setIncoming(null);
      setIncomingBundle(null);
      setPreview(null);
      setRestoreActive(null);
      setRestoreTarget(null);
      setRestoreServerBaseline(null);
      setMessage(error instanceof Error ? error.message : "Invalid backup");
    } finally {
      setBusy(false);
    }
  };
  const restoreServer = async () => {
    if (
      !incoming ||
      !restoreServerBaseline ||
      serverExportedRevision !== restoreServerBaseline.workspace.revision ||
      !serverExportAcknowledged ||
      !confirmed ||
      busy ||
      (
        restoreTarget &&
        (
          targetExportedVersion !== replicaVersion(restoreTarget) ||
          !targetExportAcknowledged
        )
      )
    ) return;
    let serverRestoredRevision: number | null = null;
    let restoreOutcomeUnknown = false;
    setBusy(true);
    try {
      const [latestActive, latestTarget] = await Promise.all([
        readReplica(),
        readWorkspaceReplica(incoming.workspace.id),
      ]);
      const effectiveLatestTarget = latestTarget ??
        (
          latestActive?.state.workspace.id === incoming.workspace.id
            ? latestActive
            : null
        );
      if (
        !replicaVersionMatches(latestActive, restoreActive) ||
        !replicaVersionMatches(effectiveLatestTarget, restoreTarget)
      ) {
        throw new Error(
          "A device workspace changed after this restore was reviewed. Review the latest queue and backup again.",
        );
      }
      const currentState = await loadServerState(incoming.workspace.id);
      if (
        currentState.workspace.revision !==
        restoreServerBaseline.workspace.revision
      ) {
        setRestoreServerBaseline(currentState);
        setPreview(previewImport(currentState, incoming));
        setServerExportedRevision(null);
        setServerExportAcknowledged(false);
        setConfirmed(false);
        setMessage(
          `The server changed to revision ${currentState.workspace.revision}. Review the refreshed replacement counts before restoring.`,
        );
        return;
      }
      restoreOutcomeUnknown = true;
      const response = await fetch("/api/snapshot", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: incoming.workspace.id, expectedRevision: currentState.workspace.revision, snapshot: incoming }) });
      const body = await response.json() as {
        auditRecorded?: boolean;
        error?: string;
        state?: WorkspaceState;
      };
      if (!response.ok) {
        restoreOutcomeUnknown = false;
        throw new Error(body.error ?? "Could not restore the server workspace");
      }
      if (!body.state) {
        throw new Error("The server returned an incomplete restore response");
      }
      serverRestoredRevision = body.state.workspace.revision;
      restoreOutcomeUnknown = false;
      const next = { state: body.state, outbox: [], updatedAt: new Date().toISOString() };
      await writeWorkspaceReplicaIfUnchanged(next, restoreTarget, restoreActive);
      setReplica(next);
      const previousWasDifferent = restoreActive &&
        restoreActive.state.workspace.id !== body.state.workspace.id;
      setRestoreActive(next);
      setRestoreTarget(next);
      setRestoreServerBaseline(body.state);
      setPreview(previewImport(body.state, incoming));
      setServerExportedRevision(null);
      setServerExportAcknowledged(false);
      setTargetExportedVersion(null);
      setTargetExportAcknowledged(false);
      const auditNote = body.auditRecorded === false
        ? " The restore committed, but its administrative audit entry could not be recorded."
        : "";
      setMessage(
        previousWasDifferent
          ? `Server and matching device workspace restored at revision ${body.state.workspace.revision}. The previously open workspace remains available in Settings.${auditNote}`
          : `Server and device restored at revision ${body.state.workspace.revision}. The reviewed matching device copy was replaced.${auditNote}`,
      );
    } catch (error) {
      setConfirmed(false);
      setTargetExportedVersion(null);
      setTargetExportAcknowledged(false);
      await refresh().catch(() => undefined);
      const detail = error instanceof Error ? error.message : "restore failed";
      setMessage(
        serverRestoredRevision !== null
          ? `Server restore succeeded at revision ${serverRestoredRevision}, but this device changed during restore and was not overwritten. Review the latest device queue before syncing. ${detail}`
          : restoreOutcomeUnknown
            ? `The server restore outcome could not be confirmed because its response was lost or incomplete. Reload the authorized server comparison and review it before retrying. ${detail}`
            : `Nothing was changed: ${detail}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const restoreCopy = async () => {
    if (!incoming || !confirmed || busy) return;
    setBusy(true);
    try {
      const state = asRestoredCopy(incoming);
      const next = { state, outbox: [], updatedAt: new Date().toISOString() };
      await writeReplica(next);
      setReplica(next);
      setMessage("Backup opened as a separate local workspace. It can initialize its own server copy after you sign in; the previous workspace was preserved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the restored copy");
    } finally {
      setBusy(false);
    }
  };
  const fetchServer = async () => {
    if (!replica || busy) return;
    setBusy(true);
    setMessage("Loading the authorized server copy…");
    try {
      const state = await loadServerState(replica.state.workspace.id);
      setServerState(state);
      setMessage(`Server copy loaded at revision ${state.workspace.revision}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load server copy");
    } finally {
      setBusy(false);
    }
  };
  const resetToServer = async () => {
    if (
      !replica ||
      !serverState ||
      confirmation !== "RESET" ||
      exportedVersion !== replicaVersion(replica) ||
      !exportAcknowledged ||
      busy
    ) return;
    setBusy(true);
    try {
      const latestServer = await loadServerState(replica.state.workspace.id);
      if (latestServer.workspace.revision !== serverState.workspace.revision) {
        setServerState(latestServer);
        setConfirmation("");
        setMessage(`The server changed to revision ${latestServer.workspace.revision}. Review the refreshed comparison before resetting this device.`);
        return;
      }
      const next = {
        state: latestServer,
        outbox: [],
        updatedAt: new Date().toISOString(),
      };
      await writeReplicaIfUnchanged(next, replica);
      setReplica(next);
      setConfirmation("");
      setExportedVersion(null);
      setExportAcknowledged(false);
      setMessage("This device now matches the server copy. The reviewed local queue was cleared.");
    } catch (error) {
      setConfirmation("");
      setExportedVersion(null);
      setExportAcknowledged(false);
      await refresh().catch(() => undefined);
      setMessage(`Nothing was changed: ${error instanceof Error ? error.message : "reset failed"}`);
    } finally {
      setBusy(false);
    }
  };
  const reapply = async () => {
    if (
      !replica ||
      !serverState ||
      confirmation !== "REAPPLY" ||
      exportedVersion !== replicaVersion(replica) ||
      !exportAcknowledged ||
      busy
    ) return;
    setBusy(true);
    try {
      const latestServer = await loadServerState(replica.state.workspace.id);
      if (latestServer.workspace.revision !== serverState.workspace.revision) {
        setServerState(latestServer);
        setConfirmation("");
        setMessage(`The server changed to revision ${latestServer.workspace.revision}. Review the refreshed comparison before reapplying queued work.`);
        return;
      }
      let state = structuredClone(latestServer);
      const outbox: OutboxEntry[] = [];
      for (const entry of replica.outbox.filter((candidate) => !wasApplied(latestServer, candidate.envelope.id))) {
        const envelope = createEnvelope(state, entry.envelope.command, { actorId: entry.envelope.actorId, deviceId: entry.envelope.deviceId });
        state = applyCommand(state, envelope).state;
        outbox.push({ envelope, status: "pending" });
      }
      const next = { state, outbox, updatedAt: new Date().toISOString() };
      await writeReplicaIfUnchanged(next, replica);
      setReplica(next);
      setConfirmation("");
      setExportedVersion(null);
      setExportAcknowledged(false);
      setMessage(`${outbox.length} unresolved change(s) rebased as fresh commands. Return to Stowplan to review and back them up.`);
    } catch (error) {
      setConfirmation("");
      setExportedVersion(null);
      setExportAcknowledged(false);
      await refresh().catch(() => undefined);
      setMessage(`Nothing was changed: ${error instanceof Error ? error.message : "the queued work could not be reapplied"}`);
    } finally {
      setBusy(false);
    }
  };
  const targetNeedsExport = restoreTarget !== null;
  const matchingRestoreReady = confirmed &&
    !busy &&
    restoreServerBaseline !== null &&
    serverExportedRevision === restoreServerBaseline.workspace.revision &&
    serverExportAcknowledged &&
    (
      !targetNeedsExport ||
      (
        restoreTarget !== null &&
        targetExportedVersion === replicaVersion(restoreTarget) &&
        targetExportAcknowledged
      )
    );

  return <main aria-busy={busy} className="admin-page recovery-page"><header><div><p className="eyebrow">Inspect before changing anything</p><h1>Sync & recovery</h1></div><Link href="/">Back</Link></header>
    <section><h2>Device recovery bundle</h2><p className="muted">This export includes the current workspace plus pending or blocked commands and their errors. Export it before any reset.</p><button disabled={!replica || busy} onClick={() => { if (!replica) return; download(`stowplan-recovery-${replica.state.workspace.id}.json`, { format: "stowplan-recovery-v1", exportedAt: new Date().toISOString(), replica }); setExportedVersion(replicaVersion(replica)); setExportAcknowledged(false); }}>Export full recovery bundle</button>{replica && exportedVersion === replicaVersion(replica) && <label><input disabled={busy} type="checkbox" checked={exportAcknowledged} onChange={(event) => setExportAcknowledged(event.target.checked)} /> I saved this recovery file somewhere I can reopen it.</label>}</section>
    <section><h2>Device queue <small>{replica?.outbox.length ?? 0} changes</small></h2><div className="admin-table recovery-queue">{replica?.outbox.map((entry) => <div key={entry.envelope.id}><span><strong>{entry.envelope.command.type}</strong><small>{new Date(entry.envelope.timestamp).toLocaleString()} · {entry.envelope.id}</small>{entry.error && <em>{entry.error}</em>}</span><b data-status={entry.status}>{entry.status}</b></div>)}{replica && replica.outbox.length === 0 && <p className="muted">No local changes are waiting for backup or review.</p>}</div></section>
    <section><h2>Compare with the server</h2><p className="muted">Sign in first. Loading is read-only. Reset and reapply remain disabled until you export the current bundle, confirm that you saved it, and type the exact confirmation. Stowplan rechecks the server revision before either action.</p><button disabled={!replica || busy} onClick={() => void fetchServer()}>Load authorized server copy</button>{serverState && replica && <><div className="preview-grid"><span><b>{replica.state.workspace.revision}</b>device revision</span><span><b>{serverState.workspace.revision}</b>server revision</span><span><b>{replica.outbox.length}</b>queued changes</span></div><label>Type <code>REAPPLY</code> to rebuild unresolved queued work on the server copy, or <code>RESET</code> to discard the device queue.<input disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><div className="recovery-actions"><button disabled={busy || exportedVersion !== replicaVersion(replica) || !exportAcknowledged || confirmation !== "REAPPLY"} onClick={() => void reapply()}>Reapply queued work on server copy</button><button className="danger" disabled={busy || exportedVersion !== replicaVersion(replica) || !exportAcknowledged || confirmation !== "RESET"} onClick={() => void resetToServer()}>Reset this device to server copy</button></div></>}</section>
    <section><h2>Restore a portable JSON backup</h2><p className="muted">Owner restore replaces the matching server workspace with compare-and-swap protection. A restored copy receives a new workspace id, works offline, and never erases the current local workspace.</p><label className="file">Choose JSON backup<input disabled={busy} type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void choose(file); }} /></label>{preview && restoreServerBaseline && <><p className="muted">Authorized server revision {restoreServerBaseline.workspace.revision} → incoming backup</p><div className="preview-grid"><span><b>{preview.replacing.locations} → {preview.incoming.locations}</b>locations</span><span><b>{preview.replacing.items} → {preview.incoming.items}</b>items</span><span><b>{preview.replacing.plans} → {preview.incoming.plans}</b>plans</span></div><button disabled={busy} onClick={() => { download(`stowplan-before-restore-${restoreServerBaseline.workspace.id}.json`, restoreServerBaseline); setServerExportedRevision(restoreServerBaseline.workspace.revision); setServerExportAcknowledged(false); }}>Export current server backup</button>{serverExportedRevision === restoreServerBaseline.workspace.revision && <label><input disabled={busy} type="checkbox" checked={serverExportAcknowledged} onChange={(event) => setServerExportAcknowledged(event.target.checked)} /> I saved the current server backup somewhere I can reopen it.</label>}</>}{preview && !restoreServerBaseline && <><p className="warning">The matching server workspace could not be loaded, so owner restore is unavailable. The counts below describe only the incoming backup; opening a separate local copy remains available.</p><div className="preview-grid"><span><b>{preview.incoming.locations}</b>incoming locations</span><span><b>{preview.incoming.items}</b>incoming items</span><span><b>{preview.incoming.plans}</b>incoming plans</span></div></>}{incomingBundle && <p className="muted">Full recovery bundle recognized with {incomingBundle.outbox.length} queued change(s). Their already-applied device state is included in the snapshot; restoring commits that reviewed state without replaying commands.</p>}{restoreTarget && <p className="warning">Matching device workspace to be replaced: {restoreTarget.state.locations.length} locations, {restoreTarget.state.items.length} items, {restoreTarget.state.plans.length} plans, and {restoreTarget.outbox.length} queued change(s). Export this exact matching-device bundle before replacing it.</p>}{restoreTarget && targetNeedsExport && <><button disabled={busy} onClick={() => { download(`stowplan-recovery-${restoreTarget.state.workspace.id}.json`, { format: "stowplan-recovery-v1", exportedAt: new Date().toISOString(), replica: restoreTarget }); setTargetExportedVersion(replicaVersion(restoreTarget)); setTargetExportAcknowledged(false); }}>Export matching-device recovery bundle</button>{targetExportedVersion === replicaVersion(restoreTarget) && <label><input disabled={busy} type="checkbox" checked={targetExportAcknowledged} onChange={(event) => setTargetExportAcknowledged(event.target.checked)} /> I saved this matching-device recovery file somewhere I can reopen it.</label>}</>}{preview?.issues.map((issue) => <p key={`${issue.code}-${issue.path}`} className={issue.severity}><strong>{issue.severity === "error" ? "Error" : "Warning"}:</strong> {issue.path}: {issue.message}</p>)}{preview?.valid && <><label><input disabled={busy} type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the validation report and these counts.</label><div className="recovery-actions"><button className="primary" disabled={!matchingRestoreReady} onClick={() => void restoreServer()}>Restore matching server & device</button><button disabled={!confirmed || busy} onClick={() => void restoreCopy()}>Open as separate local copy</button></div></>}</section>
    {message && <output aria-live="polite">{message}</output>}
  </main>;
}
