"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { applyCommand } from "../../src/domain/commands";
import { createEnvelope } from "../../src/domain/factories";
import { previewImport } from "../../src/domain/import";
import { workspacePath } from "../../src/domain/app-url";
import type {
  CommandAuthorizationBasis,
  ImportPreview,
  WorkspaceState,
} from "../../src/domain/types";
import {
  workspaceAccessForAccount,
  workspaceReadOnlyReason,
} from "../../src/domain/workspace-access";
import { parseRecoveryUpload } from "../../src/client/recovery-bundle";
import {
  canUseLocalRecoveryWrite,
  canUseRecoveryCapability,
  parseAuthorizedRecoverySnapshot,
  recoveryCommandLabel,
  type AuthorizedRecoverySnapshot,
} from "../../src/client/recovery-permissions";
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
import {
  accountContextHeaders,
  responseMatchesAccount,
} from "../../src/shared/account-context";

function download(name: string, value: unknown) {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(
      new Blob(
        [JSON.stringify(value, null, 2)],
        { type: "application/json" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
function wasApplied(state: WorkspaceState, commandId: string) {
  return state.activities.some((activity) => activity.commandId === commandId) || state.audit.some((event) => event.id === `audit_${commandId}`);
}
function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
function replicaVersion(replica: LocalReplica): string {
  return [
    replica.state.workspace.id,
    replica.state.workspace.revision,
    replica.updatedAt,
    ...replica.outbox.map((entry) => `${entry.envelope.id}:${entry.status}`),
  ].join("|");
}
function commandAuthorization(
  snapshot: AuthorizedRecoverySnapshot,
): CommandAuthorizationBasis | undefined {
  return {
    membershipRevision: snapshot.authorization.membershipRevision,
    workspaceAccessRevision: snapshot.authorization.accessRevision,
  };
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
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountReady, setAccountReady] = useState(false);
  const [incoming, setIncoming] = useState<WorkspaceState | null>(null);
  const [incomingBundle, setIncomingBundle] = useState<LocalReplica | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [serverSnapshot, setServerSnapshot] =
    useState<AuthorizedRecoverySnapshot | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [exportedVersion, setExportedVersion] = useState<string | null>(null);
  const [exportAcknowledged, setExportAcknowledged] = useState(false);
  const [restoreActive, setRestoreActive] = useState<LocalReplica | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<LocalReplica | null>(null);
  const [restoreServerBaseline, setRestoreServerBaseline] =
    useState<AuthorizedRecoverySnapshot | null>(null);
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
  const saveExport = (
    name: string,
    value: unknown,
    onStarted: () => void,
  ) => {
    setMessage("");
    try {
      download(name, value);
      onStarted();
      setMessage(`Download started: ${name}`);
    } catch (error) {
      setMessage(
        `Could not start the download: ${
          error instanceof Error ? error.message : "browser download failed"
        }`,
      );
    }
  };
  useEffect(() => {
    void readReplica()
      .then(setReplica)
      .catch((error) => setMessage(
        error instanceof Error ? error.message : "On-device storage is unavailable",
      ));
  }, []);
  useEffect(() => {
    let active = true;
    void fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as {
          user?: { userId?: string } | null;
        };
        if (!response.ok) throw new Error("Could not confirm account");
        if (active) setAccountId(body.user?.userId ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setAccountReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const loadServerSnapshot = async (
    workspaceId: string,
  ): Promise<AuthorizedRecoverySnapshot> => {
    if (!accountReady || !accountId) {
      throw new Error("Sign in before loading a server workspace");
    }
    const response = await fetch(
      `/api/snapshot?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        cache: "no-store",
        headers: accountContextHeaders(accountId),
      },
    );
    const body = await response.json() as unknown;
    if (!response.ok) {
      const error = body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
        ? body.error
        : "Could not load the server workspace";
      throw new Error(error);
    }
    if (!responseMatchesAccount(response, accountId)) {
      throw new Error(
        "The signed-in account changed while loading the workspace",
      );
    }
    return parseAuthorizedRecoverySnapshot(
      body,
      workspaceId,
      accountId,
    );
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
      let reviewedServer: AuthorizedRecoverySnapshot | null = null;
      let serverLoadError = "";
      try {
        reviewedServer = await loadServerSnapshot(parsed.workspace.id);
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
      setPreview(previewImport(reviewedServer?.state ?? parsed, parsed));
      setMessage(
        reviewedServer
          ? `Authorized server copy loaded at revision ${reviewedServer.state.workspace.revision}.`
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
      !canUseRecoveryCapability(
        restoreServerBaseline,
        accountId,
        accountReady,
        "manageAccess",
      ) ||
      !accountId ||
      serverExportedRevision !==
        restoreServerBaseline.state.workspace.revision ||
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
    const restoreAccountId = accountId;
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
      const currentSnapshot = await loadServerSnapshot(
        incoming.workspace.id,
      );
      if (
        !canUseRecoveryCapability(
          currentSnapshot,
          accountId,
          accountReady,
          "manageAccess",
        )
      ) {
        setRestoreServerBaseline(currentSnapshot);
        setPreview(previewImport(currentSnapshot.state, incoming));
        setServerExportedRevision(null);
        setServerExportAcknowledged(false);
        setConfirmed(false);
        setMessage(
          "Owner access is no longer confirmed. Nothing was changed; review the updated workspace access before restoring.",
        );
        return;
      }
      if (
        currentSnapshot.state.workspace.revision !==
        restoreServerBaseline.state.workspace.revision
      ) {
        setRestoreServerBaseline(currentSnapshot);
        setPreview(previewImport(currentSnapshot.state, incoming));
        setServerExportedRevision(null);
        setServerExportAcknowledged(false);
        setConfirmed(false);
        setMessage(
          `The server changed to revision ${currentSnapshot.state.workspace.revision}. Review the refreshed replacement counts before restoring.`,
        );
        return;
      }
      restoreOutcomeUnknown = true;
      const response = await fetch("/api/snapshot", {
        method: "PUT",
        headers: accountContextHeaders(restoreAccountId, {
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          authorization: commandAuthorization(currentSnapshot),
          expectedRevision: currentSnapshot.state.workspace.revision,
          snapshot: incoming,
          workspaceId: incoming.workspace.id,
        }),
      });
      const body = await response.json() as unknown;
      if (!response.ok) {
        restoreOutcomeUnknown = false;
        const error = body &&
            typeof body === "object" &&
            "error" in body &&
            typeof body.error === "string"
          ? body.error
          : "Could not restore the server workspace";
        throw new Error(error);
      }
      if (!responseMatchesAccount(response, restoreAccountId)) {
        throw new Error(
          "The signed-in account changed before the restore completed",
        );
      }
      const restoredSnapshot = parseAuthorizedRecoverySnapshot(
        body,
        incoming.workspace.id,
        restoreAccountId,
      );
      serverRestoredRevision =
        restoredSnapshot.state.workspace.revision;
      restoreOutcomeUnknown = false;
      const next = {
        authorization: restoredSnapshot.authorization,
        lastSyncAttemptAt: new Date().toISOString(),
        lastSyncError: null,
        lastSyncedAt: new Date().toISOString(),
        outbox: [],
        serverSummary: restoredSnapshot.workspace,
        state: restoredSnapshot.state,
        updatedAt: new Date().toISOString(),
      };
      await writeWorkspaceReplicaIfUnchanged(next, restoreTarget, restoreActive);
      setReplica(next);
      const previousWasDifferent = restoreActive &&
        restoreActive.state.workspace.id !==
          restoredSnapshot.state.workspace.id;
      setRestoreActive(next);
      setRestoreTarget(next);
      setRestoreServerBaseline(restoredSnapshot);
      setPreview(previewImport(restoredSnapshot.state, incoming));
      setServerExportedRevision(null);
      setServerExportAcknowledged(false);
      setTargetExportedVersion(null);
      setTargetExportAcknowledged(false);
      const auditRecorded = body &&
          typeof body === "object" &&
          "auditRecorded" in body
        ? body.auditRecorded
        : undefined;
      const auditNote = auditRecorded === false
        ? " The restore committed, but its administrative audit entry could not be recorded."
        : "";
      setMessage(
        previousWasDifferent
          ? `Server and matching device workspace restored at revision ${restoredSnapshot.state.workspace.revision}. The previously open workspace remains available in Settings.${auditNote}`
          : `Server and device restored at revision ${restoredSnapshot.state.workspace.revision}. The reviewed matching device copy was replaced.${auditNote}`,
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
      const firstLocation = state.locations.find(
        (candidate) => !candidate.archivedAt,
      );
      location.assign(workspacePath({
        locationId: firstLocation?.id,
        locationLabel: firstLocation
          ? `${firstLocation.code} ${firstLocation.name}`
          : undefined,
        view: "capture",
        workspaceId: state.workspace.id,
        workspaceLabel: state.workspace.name,
      }));
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
      const snapshot = await loadServerSnapshot(
        replica.state.workspace.id,
      );
      setServerSnapshot(snapshot);
      setMessage(
        `Server copy loaded at revision ${snapshot.state.workspace.revision}.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load server copy");
    } finally {
      setBusy(false);
    }
  };
  const resetToServer = async () => {
    if (
      !replica ||
      !canUseRecoveryCapability(
        serverSnapshot,
        accountId,
        accountReady,
        "write",
      ) ||
      !canUseLocalRecoveryWrite(
        replica,
        accountId,
        accountReady,
      ) ||
      !serverSnapshot ||
      confirmation !== "RESET" ||
      exportedVersion !== replicaVersion(replica) ||
      !exportAcknowledged ||
      busy
    ) return;
    setBusy(true);
    try {
      const latestServer = await loadServerSnapshot(
        replica.state.workspace.id,
      );
      if (
        !canUseRecoveryCapability(
          latestServer,
          accountId,
          accountReady,
          "write",
        )
      ) {
        setServerSnapshot(latestServer);
        setConfirmation("");
        setMessage(
          "Write access is no longer confirmed. The device queue was retained for review.",
        );
        return;
      }
      if (
        latestServer.state.workspace.revision !==
        serverSnapshot.state.workspace.revision
      ) {
        setServerSnapshot(latestServer);
        setConfirmation("");
        setMessage(`The server changed to revision ${latestServer.state.workspace.revision}. Review the refreshed comparison before resetting this device.`);
        return;
      }
      const next = {
        authorization: latestServer.authorization,
        lastSyncAttemptAt: replica.lastSyncAttemptAt,
        lastSyncError: null,
        lastSyncedAt: new Date().toISOString(),
        serverSummary: latestServer.workspace,
        state: latestServer.state,
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
      !canUseRecoveryCapability(
        serverSnapshot,
        accountId,
        accountReady,
        "write",
      ) ||
      !canUseLocalRecoveryWrite(
        replica,
        accountId,
        accountReady,
      ) ||
      !serverSnapshot ||
      confirmation !== "REAPPLY" ||
      exportedVersion !== replicaVersion(replica) ||
      !exportAcknowledged ||
      busy
    ) return;
    setBusy(true);
    try {
      const latestServer = await loadServerSnapshot(
        replica.state.workspace.id,
      );
      if (
        !canUseRecoveryCapability(
          latestServer,
          accountId,
          accountReady,
          "write",
        )
      ) {
        setServerSnapshot(latestServer);
        setConfirmation("");
        setMessage(
          "Write access is no longer confirmed. The queued work remains inspectable and exportable.",
        );
        return;
      }
      if (
        latestServer.state.workspace.revision !==
        serverSnapshot.state.workspace.revision
      ) {
        setServerSnapshot(latestServer);
        setConfirmation("");
        setMessage(`The server changed to revision ${latestServer.state.workspace.revision}. Review the refreshed comparison before reapplying queued work.`);
        return;
      }
      let state = structuredClone(latestServer.state);
      const outbox: OutboxEntry[] = [];
      for (const entry of replica.outbox.filter((candidate) => !wasApplied(latestServer.state, candidate.envelope.id))) {
        const envelope = createEnvelope(state, entry.envelope.command, {
          actorId: entry.envelope.actorId,
          authorization: commandAuthorization(latestServer),
          deviceId: entry.envelope.deviceId,
        });
        state = applyCommand(state, envelope).state;
        outbox.push({
          accountId: latestServer.authorization.accountId,
          envelope,
          status: "pending",
        });
      }
      const next = {
        authorization: latestServer.authorization,
        lastSyncAttemptAt: replica.lastSyncAttemptAt,
        lastSyncError: null,
        lastSyncedAt: replica.lastSyncedAt,
        outbox,
        serverSummary: latestServer.workspace,
        state,
        updatedAt: new Date().toISOString(),
      };
      await writeReplicaIfUnchanged(next, replica);
      setReplica(next);
      setConfirmation("");
      setExportedVersion(null);
      setExportAcknowledged(false);
      setMessage(`${countLabel(outbox.length, "unresolved change")} rebased as fresh commands. Return to Stowplan to review and back them up.`);
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
    canUseRecoveryCapability(
      restoreServerBaseline,
      accountId,
      accountReady,
      "manageAccess",
    ) &&
    restoreServerBaseline !== null &&
    serverExportedRevision ===
      restoreServerBaseline.state.workspace.revision &&
    serverExportAcknowledged &&
    (
      !targetNeedsExport ||
      (
        restoreTarget !== null &&
        targetExportedVersion === replicaVersion(restoreTarget) &&
        targetExportAcknowledged
      )
    );

  const readOnlyAuthorization =
    serverSnapshot?.authorization ?? replica?.authorization;
  const readOnlyReason = readOnlyAuthorization
    ? !accountReady && readOnlyAuthorization.kind === "server"
      ? "Workspace access is being confirmed."
      : workspaceReadOnlyReason(
          workspaceAccessForAccount(
            readOnlyAuthorization,
            accountId,
          ),
        )
    : null;
  const serverWriteAllowed = canUseRecoveryCapability(
    serverSnapshot,
    accountId,
    accountReady,
    "write",
  ) && canUseLocalRecoveryWrite(
    replica,
    accountId,
    accountReady,
  );
  const matchingRestoreAllowed = canUseRecoveryCapability(
    restoreServerBaseline,
    accountId,
    accountReady,
    "manageAccess",
  );

  return <main aria-busy={busy} className="admin-page recovery-page">
    <header>
      <div>
        <p className="eyebrow">Inspect before changing anything</p>
        <h1>Sync & recovery</h1>
      </div>
      <Link href="/">Back</Link>
    </header>
    {readOnlyReason && <section role="status">
      <h2>Read-only workspace</h2>
      <p>{readOnlyReason} Inspection and export remain available, but reset, reapply, and matching-workspace restore are disabled.</p>
    </section>}
    <section>
      <h2>Device recovery bundle</h2>
      <p className="muted">This export includes the current workspace plus pending or blocked commands and their errors. Export it before any reset.</p>
      <button disabled={!replica || busy} onClick={() => {
        if (!replica) return;
        saveExport(
          `stowplan-recovery-${replica.state.workspace.id}.json`,
          {
            exportedAt: new Date().toISOString(),
            format: "stowplan-recovery-v1",
            replica,
          },
          () => {
            setExportedVersion(replicaVersion(replica));
            setExportAcknowledged(false);
          },
        );
      }}>Export full recovery bundle</button>
      {replica && exportedVersion === replicaVersion(replica) && <label>
        <input disabled={busy} type="checkbox" checked={exportAcknowledged} onChange={(event) => setExportAcknowledged(event.target.checked)} /> I saved this recovery file somewhere I can reopen it.
      </label>}
    </section>
    <section>
      <h2>Device queue <small>{replica?.outbox.length ?? 0} changes</small></h2>
      <div className="admin-table recovery-queue">
        {replica?.outbox.map((entry) => <div key={entry.envelope.id}>
          <span>
            <strong>{recoveryCommandLabel(replica, entry)}</strong>
            <small>Command: {entry.envelope.command.type} · {new Date(entry.envelope.timestamp).toLocaleString()} · {entry.envelope.id}</small>
            {entry.error && <em>Backup refusal: {entry.error}</em>}
          </span>
          <b data-status={entry.status}>{entry.status}</b>
        </div>)}
        {replica && replica.outbox.length === 0 && <p className="muted">No local changes are waiting for backup or review.</p>}
      </div>
    </section>
    <section>
      <h2>Compare with the server</h2>
      <p className="muted">Loading a server copy is read-only. Reset and reapply remain disabled until you export the current bundle, confirm that you saved it, and type the exact confirmation. Stowplan rechecks server access and revision before either action.</p>
      {!accountReady && <p role="status">Confirming the signed-in account. Server recovery actions remain disabled.</p>}
      {accountReady && !accountId && <p className="warning" role="status">Sign in to compare with or change the server copy. Device inspection and export remain available.</p>}
      <button disabled={!replica || !accountReady || !accountId || busy} onClick={() => void fetchServer()}>Load authorized server copy</button>
      {serverSnapshot && replica && <>
        <p className="muted">Server role: <strong>{serverSnapshot.authorization.role}</strong></p>
        {!serverWriteAllowed && <p className="warning" role="status">This server role does not allow reset or reapply. The device queue remains inspectable and exportable.</p>}
        <div className="preview-grid">
          <span><b>{replica.state.workspace.revision}</b>device revision</span>
          <span><b>{serverSnapshot.state.workspace.revision}</b>server revision</span>
          <span><b>{replica.outbox.length}</b>queued changes</span>
        </div>
        <label>Type <code>REAPPLY</code> to rebuild unresolved queued work on the server copy, or <code>RESET</code> to discard the device queue.
          <input disabled={busy || !serverWriteAllowed} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        <div className="recovery-actions">
          <button disabled={!serverWriteAllowed || replica.outbox.length === 0 || busy || exportedVersion !== replicaVersion(replica) || !exportAcknowledged || confirmation !== "REAPPLY"} onClick={() => void reapply()}>Reapply queued work on server copy</button>
          <button className="danger" disabled={!serverWriteAllowed || busy || exportedVersion !== replicaVersion(replica) || !exportAcknowledged || confirmation !== "RESET"} onClick={() => void resetToServer()}>Reset this device to server copy</button>
        </div>
      </>}
    </section>
    <section>
      <h2>Restore a portable JSON backup</h2>
      <p className="muted">Restoring the matching server workspace is owner-only and uses compare-and-swap protection. Opening a separate local copy creates a new workspace ID, works offline, and never erases another device workspace.</p>
      <label className="file">Choose JSON backup
        <input disabled={busy} type="file" accept="application/json" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void choose(file);
        }} />
      </label>
      {preview && restoreServerBaseline && <>
        <p className="muted">Authorized server revision {restoreServerBaseline.state.workspace.revision} → incoming backup · Server role: <strong>{restoreServerBaseline.authorization.role}</strong></p>
        {!matchingRestoreAllowed && <p className="warning" role="status">Matching-workspace restore requires owner access. This comparison remains read-only, and opening a separate local copy remains available.</p>}
        <div className="preview-grid">
          <span><b>{preview.replacing.locations} → {preview.incoming.locations}</b>locations</span>
          <span><b>{preview.replacing.items} → {preview.incoming.items}</b>items</span>
          <span><b>{preview.replacing.plans} → {preview.incoming.plans}</b>plans</span>
        </div>
        <button disabled={busy} onClick={() => {
          saveExport(
            `stowplan-before-restore-${restoreServerBaseline.state.workspace.id}.json`,
            restoreServerBaseline.state,
            () => {
              setServerExportedRevision(
                restoreServerBaseline.state.workspace.revision,
              );
              setServerExportAcknowledged(false);
            },
          );
        }}>Export current server backup</button>
        {serverExportedRevision === restoreServerBaseline.state.workspace.revision && <label>
          <input disabled={busy} type="checkbox" checked={serverExportAcknowledged} onChange={(event) => setServerExportAcknowledged(event.target.checked)} /> I saved the current server backup somewhere I can reopen it.
        </label>}
      </>}
      {preview && !restoreServerBaseline && <>
        <p className="warning">The matching server workspace could not be loaded, so owner restore is unavailable. The counts below describe only the incoming backup; opening a separate local copy remains available.</p>
        <div className="preview-grid">
          <span><b>{preview.incoming.locations}</b>incoming locations</span>
          <span><b>{preview.incoming.items}</b>incoming items</span>
          <span><b>{preview.incoming.plans}</b>incoming plans</span>
        </div>
      </>}
      {incomingBundle && <p className="muted">Full recovery bundle recognized with {countLabel(incomingBundle.outbox.length, "queued change")}. Their already-applied device state is included in the snapshot; restoring commits that reviewed state without replaying commands.</p>}
      {restoreTarget && <p className="warning">Matching device workspace to be replaced: {countLabel(restoreTarget.state.locations.length, "location")}, {countLabel(restoreTarget.state.items.length, "item")}, {countLabel(restoreTarget.state.plans.length, "plan")}, and {countLabel(restoreTarget.outbox.length, "queued change")}. Export this exact matching-device bundle before replacing it.</p>}
      {restoreTarget && targetNeedsExport && <>
        <button disabled={busy} onClick={() => {
          saveExport(
            `stowplan-recovery-${restoreTarget.state.workspace.id}.json`,
            {
              exportedAt: new Date().toISOString(),
              format: "stowplan-recovery-v1",
              replica: restoreTarget,
            },
            () => {
              setTargetExportedVersion(replicaVersion(restoreTarget));
              setTargetExportAcknowledged(false);
            },
          );
        }}>Export matching-device recovery bundle</button>
        {targetExportedVersion === replicaVersion(restoreTarget) && <label>
          <input disabled={busy} type="checkbox" checked={targetExportAcknowledged} onChange={(event) => setTargetExportAcknowledged(event.target.checked)} /> I saved this matching-device recovery file somewhere I can reopen it.
        </label>}
      </>}
      {preview?.issues.map((issue) => <p key={`${issue.code}-${issue.path}`} className={issue.severity}><strong>{issue.severity === "error" ? "Error" : "Warning"}:</strong> {issue.path}: {issue.message}</p>)}
      {preview?.valid && <>
        <label>
          <input disabled={busy} type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the validation report and these counts.
        </label>
        <div className="recovery-actions">
          <button className="primary" disabled={!matchingRestoreReady} onClick={() => void restoreServer()}>Restore matching server & device</button>
          <button disabled={!confirmed || busy} onClick={() => void restoreCopy()}>Open as separate local copy</button>
        </div>
      </>}
    </section>
    {message && <output aria-live="polite">{message}</output>}
  </main>;
}
