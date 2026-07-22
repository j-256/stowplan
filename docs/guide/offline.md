# Offline and server-outage behavior

Stowplan is local-first. IndexedDB contains the active workspace, preserved inactive workspaces, and each workspace’s ordered outbox. A command changes the local snapshot and enters the outbox in one transaction. Opening a shared workspace never erases the one you were using; switch back under **Settings → Workspaces on this device**.

Network backup waits 1.8 seconds after the most recent command and flushes no later than 8 seconds during continuous work. Returning online, returning to the foreground, or a five-minute reconciliation interval can retry sooner. Reconciliation also pulls changes made by other devices when the current device has nothing to send. Retries are idempotent by command ID.

Status meanings:

- **Saved on this device:** safe to keep working; server copy is behind.
- **Backing up:** a batched request is active.
- **Up to date:** the outbox is empty.
- **Working offline:** no current connection; local writes continue.
- **Blocked:** a same-field conflict or rejected command needs review.

Static application assets may be cached. API responses are never service-worker cached. The local replica, not an HTTP cache, enables offline work.

Before clearing site data or uninstalling the PWA, export a JSON recovery bundle if any commands remain pending.
