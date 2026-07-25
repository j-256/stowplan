# Offline and server-outage behavior

Stowplan is local-first. IndexedDB contains the active workspace, preserved inactive workspaces, each workspace's ordered outbox, discovered server summaries, explicit server role and capabilities, and the timestamps and outcome of server-backup attempts. A permitted command changes the local snapshot and enters the outbox in one transaction. Opening a shared workspace never erases the one you were using; switch from the workspace home screen.

Network backup waits 1.8 seconds after the most recent command and flushes no later than 8 seconds during continuous work. Returning online, returning to the foreground, or a five-minute reconciliation interval retries every preserved workspace that has pending changes, even if a different workspace is open. The active workspace also performs an empty reconciliation so it can pull changes made by other devices. Retries are idempotent by command ID.

Status meanings:

- **Stored only on this device:** no authorized server copy is known.
- **Available from the server:** the signed-in account has access, but this device has not downloaded a replica.
- **Device and server are synchronized:** local and server revisions match and no commands are waiting.
- **Local changes are waiting to upload:** permitted work is durable on the device and the server copy is behind.
- **Backup refused one or more local changes:** a same-field conflict or rejected command is retained with its server error.
- **This device has newer work:** the local summary is ahead of the latest known server summary.
- **The server copy is newer:** reconciliation can pull authorized server changes into the local replica.
- **Server workspace unavailable while offline:** a discovered server-only workspace needs a connection for its first download.
- **Workspace access is unavailable:** membership ended, the server workspace was deleted, or access cannot be confirmed.

An empty outbox by itself is not described as "up to date" unless this device has recorded a successful server backup. A failed availability or authentication check does not erase the last successful timestamp; the latest error is shown separately.

The workspace home screen keeps discovered server summaries so a server-only card can remain visible offline. Its **Open when online** action is focusable and explains why opening is unavailable. A workspace that already has a local replica remains readable offline. Reconciliation does not erase pending or blocked commands, replace a newer local summary with an older one, or switch the active workspace without the user choosing it.

Known viewer access is read-only before a command reaches IndexedDB, so navigation, search, filters, details, plans, activity, and authorized export do not create an outbox entry. Owner and editor commands continue to use the transactional local snapshot and outbox write.

The device cannot learn about a role change while offline. It may preserve edits accepted under the last confirmed owner or editor role. On reconnect, the server role wins: a downgrade or membership removal updates the interface, unauthorized commands become blocked with their intended action and refusal reason, and the device does not report them as backed up. Export the full recovery bundle before deciding how to recover or reset that work.

On a shared browser, a cached server role belongs only to the account that received it. Switching to another signed-in account makes that workspace read-only until Stowplan confirms the new account's access. Pending changes from the first account remain on the device and are not sent as the second account.

Static application assets may be cached. API responses are never service-worker cached. The local replica, not an HTTP cache, enables offline work.

Before clearing site data or uninstalling the PWA, export a JSON recovery bundle if any commands remain pending.

See [Workspaces and collaboration](/guide/collaboration) for role and lifecycle behavior.
