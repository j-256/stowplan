import type { WorkspaceAccessStatus } from "../domain/workspace-access";

export const DEVICE_ONLY_BACKUP_ERROR =
  "Server backup is not configured for this deployment.";
export const SIGN_IN_BACKUP_ERROR =
  "Remote backup is paused until you sign in again.";

const LEGACY_SIGN_IN_BACKUP_ERROR =
  "Sign in to back up this workspace.";
const TERMINAL_BACKUP_LABELS: Readonly<
  Partial<Record<WorkspaceAccessStatus, string>>
> = Object.freeze({
  deleted: "Server copy deleted",
  left: "Membership left",
  revoked: "Access removed",
  unknown: "Server access unavailable",
});
// Statuses where the server relationship definitively ended, so no recovery
// action remains. "unknown" is excluded on purpose: access merely could not be
// confirmed (for example after the signed-in account changed), so a refused
// sync is still actionable and must stay visible
const ENDED_ACCESS_STATUSES: Readonly<
  Partial<Record<WorkspaceAccessStatus, true>>
> = Object.freeze({
  deleted: true,
  left: true,
  revoked: true,
});

export interface BackupPresentation {
  deviceOnly?: boolean;
  label: string;
  offline?: boolean;
  state: "blocked" | "local" | "pending" | "synced";
  terminal?: boolean;
}

export interface BackupPresentationOptions {
  accessStatus?: WorkspaceAccessStatus;
  authenticationReady: boolean;
  backupConfigured?: boolean | null;
  blocked: number;
  lastSyncError: string | null;
  lastSyncedAt: string | null;
  online?: boolean;
  pending: number;
  serverBacked: boolean;
  signedIn: boolean;
  syncing?: boolean;
}

export interface BackupNotice {
  action: "account" | "recovery";
  message: string;
  title: string;
}

export function isSignInBackupError(value: string | null | undefined): boolean {
  return value === SIGN_IN_BACKUP_ERROR ||
    value === LEGACY_SIGN_IN_BACKUP_ERROR;
}

export function remoteBackupPaused({
  accessStatus,
  authenticationReady,
  backupConfigured,
  serverBacked,
  signedIn,
}: BackupPresentationOptions): boolean {
  return authenticationReady &&
    backupConfigured === true &&
    serverBacked &&
    accessStatus === "active" &&
    !signedIn;
}

export function backupPresentation(
  options: BackupPresentationOptions,
): BackupPresentation {
  const {
    accessStatus,
    backupConfigured,
    blocked,
    lastSyncError,
    lastSyncedAt,
    online,
    pending,
    serverBacked,
    signedIn,
    syncing,
  } = options;
  const effectiveSyncError = isSignInBackupError(lastSyncError)
    ? null
    : lastSyncError;
  if (blocked) {
    return {
      label: `${blocked} change${blocked === 1 ? " needs" : "s need"} review`,
      state: "blocked",
    };
  }
  const terminalLabel = accessStatus
    ? TERMINAL_BACKUP_LABELS[accessStatus]
    : undefined;
  if (terminalLabel) {
    return {
      deviceOnly: true,
      label: terminalLabel,
      state: "local",
      terminal: true,
    };
  }
  const localWithoutOnlineAccount = !serverBacked && !signedIn;
  const deviceOnly = localWithoutOnlineAccount ||
    backupConfigured === false ||
    effectiveSyncError === DEVICE_ONLY_BACKUP_ERROR;
  if (deviceOnly) {
    return {
      deviceOnly: true,
      label: pending
        ? `${pending} change${pending === 1 ? "" : "s"} saved on this device`
        : "Device only",
      state: pending ? "pending" : "local",
    };
  }
  if (remoteBackupPaused(options)) {
    return {
      label: pending
        ? `${pending} change${pending === 1 ? "" : "s"} not backed up`
        : "Remote backup paused",
      state: "blocked",
    };
  }
  if (syncing) return { label: "Backing up...", state: "pending" };
  if (effectiveSyncError) {
    return {
      label: pending
        ? `${pending} change${pending === 1 ? "" : "s"} not backed up`
        : "Backup failed",
      state: "blocked",
    };
  }
  if (pending) {
    return {
      label: `${pending} change${pending === 1 ? "" : "s"} pending upload`,
      state: "pending",
    };
  }
  if (online === false) {
    return { label: "Working offline", offline: true, state: "local" };
  }
  if (lastSyncedAt) {
    return { label: "Backed up online", state: "synced" };
  }
  return { label: "Device only", state: "local" };
}

export function backupNotice(
  options: BackupPresentationOptions,
): BackupNotice | null {
  const terminalAccess = options.accessStatus
    ? Boolean(ENDED_ACCESS_STATUSES[options.accessStatus])
    : false;
  const genuineSyncError = options.lastSyncError &&
      options.lastSyncError !== DEVICE_ONLY_BACKUP_ERROR &&
      !isSignInBackupError(options.lastSyncError)
    ? options.lastSyncError
    : null;
  if (options.blocked > 0) {
    return {
      action: "recovery",
      message: genuineSyncError ??
        `${options.blocked} local change${
          options.blocked === 1 ? " needs" : "s need"
        } review before remote backup can continue.`,
      title: "Backup needs attention",
    };
  }
  if (genuineSyncError && !terminalAccess) {
    return {
      action: "recovery",
      message: genuineSyncError,
      title: "Backup needs attention",
    };
  }
  if (terminalAccess) return null;
  if (remoteBackupPaused(options)) {
    return {
      action: "account",
      message:
        "Your Stowplan session ended. Sign in again to resume remote backup and collaboration. Local work is still safe on this device.",
      title: "Remote backup paused",
    };
  }
  return null;
}
