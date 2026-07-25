# Backup, import, and recovery

Use **Settings → Export JSON backup** regularly and before migrations, bulk imports, or device cleanup. The file contains the complete workspace state, history, plans, and schema version; secrets and server sessions are excluded.

## Before a workspace lifecycle action

Export before removing a replica from a device, leaving a shared workspace, or deleting its server copy. An ordinary JSON backup is a portable snapshot of the workspace. When pending or blocked commands exist, export the full recovery bundle from **Review sync issues or restore a backup** because it also contains the durable device queue and server refusal context.

Removing a replica from one device leaves the server workspace and membership unchanged. Leaving removes only the caller's membership and leaves the server workspace available to remaining members. Server deletion is owner-only, immediate, and not recoverable; it removes the server snapshot, memberships, and invite records. Leaving or deleting does not silently remove the device replica. The user can keep that replica read-only, export recovery data, or remove it as a separate choice.

An exported file is a user-held copy, not a server undelete service. Keep it somewhere outside the site data that the lifecycle action or browser cleanup will remove. See [Workspaces and collaboration](/guide/collaboration) for the guarded paths and final-owner rules.

An import should be previewed before replacement. Validation checks the complete nested schema, IDs, quantities, conditions, constraints, duplicate codes, missing parents, parent cycles, item locations, plan references, history patches, and audit records. Treat warnings as review items and errors as blockers.

**Restore matching server & device** requires a signed-in workspace owner. After you choose a backup, Stowplan loads the matching authorized server workspace and shows that server revision's counts beside the incoming counts. Owner restore stays disabled if that comparison cannot be loaded. You must download the current server snapshot and explicitly confirm that you saved it before replacement unlocks. Immediately before committing, Stowplan reloads the server again; if its revision changed, the counts refresh, the saved-backup acknowledgment expires, and confirmation is cleared. The final write uses compare-and-swap so a concurrent edit stops the restore instead of being overwritten. The restored snapshot and its non-secret administrative audit record commit atomically; if the audit cannot be recorded, the restore does not commit.

The recovery screen uses the role and capabilities returned with the authorized server snapshot, even when that workspace has no replica on the device. A matching ID, an older local role, or the absence of a local replica never implies owner access. Server restore remains disabled while the signed-in account or its current owner capability is unknown. Editors and viewers can inspect and export an authorized comparison, but only an owner can replace the matching server workspace.

If the matching workspace already exists on this device, its separate counts and queued-change total are shown. Owner restore also requires an export of that exact device workspace plus an acknowledgment that the download was saved. A backup of some other currently open workspace does not unlock replacement. Both the matching workspace and the active workspace are checked again in the same IndexedDB transaction before local data changes.

**Open as separate local copy** works offline, assigns a fresh workspace id, preserves the currently active workspace, and initializes an independent server copy after a later sign-in. Use it for inspection or when you do not intend to replace the shared server workspace.

## A blocked sync change

Open **Settings → Review sync issues or restore a backup**. The recovery screen exposes every pending or blocked command with its timestamp and server error. Before changing anything, export the full recovery bundle; unlike the ordinary workspace export, it contains the durable device queue too.

The recovery uploader accepts either a portable workspace JSON export or a full `stowplan-recovery-v1` bundle. A full bundle's snapshot already includes the optimistic effects of its queued commands; the uploader verifies each queued command belongs to the workspace and is represented in activity or audit history before it allows recovery. It never silently replays that queue on top of the saved state.

After signing in, **Load authorized server copy** is read-only. Download the full recovery bundle and confirm that you saved the file; starting a browser download alone does not unlock either destructive action. You then have two explicit choices:

- Type `REAPPLY` to rebuild only unresolved device commands with fresh field expectations on the current server copy. Commands already visible in server activity are skipped, so a lost response cannot duplicate them.
- Type `RESET` to replace this device with the server copy and clear the local queue. Use this only after exporting the recovery bundle.

Neither operation silently discards the current replica if validation or command replay fails.

## Restore drill

1. Export production data and record its revision.
2. Start an isolated local instance.
3. Import and inspect the count comparison.
4. Confirm several deeply nested locations, searches, plan steps, and activity records.
5. Export again and compare structural counts.

For D1, also use platform backups/time travel before remote migration. See the [Cloudflare runbook](/deploy/cloudflare#backup-restore-and-rollback).
