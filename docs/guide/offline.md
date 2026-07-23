# Offline and server-outage behavior

Stowplan is local-first. IndexedDB contains the active workspace, preserved inactive workspaces, each workspace’s ordered outbox, and the timestamps and outcome of server-backup attempts. A command changes the local snapshot and enters the outbox in one transaction. Opening a shared workspace never erases the one you were using; switch from the workspace home screen.

Network backup waits 1.8 seconds after the most recent command and flushes no later than 8 seconds during continuous work. Returning online, returning to the foreground, or a five-minute reconciliation interval retries every preserved workspace that has pending changes, even if a different workspace is open. The active workspace also performs an empty reconciliation so it can pull changes made by other devices. Retries are idempotent by command ID.

Status meanings:

- **Device only:** no successful server backup is recorded for this workspace.
- **Saved on this device / pending upload:** safe to keep working; the server copy is behind. The home card lists each waiting change.
- **Backing up:** a batched request is active.
- **Backed up online:** the outbox is empty and the card shows when the last server backup succeeded.
- **Working offline:** no current connection; local writes continue.
- **Needs review:** a same-field conflict or rejected command is retained with its server error.

An empty outbox by itself is not described as “up to date” unless this device has recorded a successful server backup. A failed availability or authentication check does not erase the last successful timestamp; the latest error is shown separately.

Static application assets may be cached. API responses are never service-worker cached. The local replica, not an HTTP cache, enables offline work.

Before clearing site data or uninstalling the PWA, export a JSON recovery bundle if any commands remain pending.
