# Backup, import, and recovery

Use **Settings → Export JSON backup** regularly and before migrations, bulk imports, or device cleanup. The file contains the complete workspace state, history, plans, and schema version; secrets and server sessions are excluded.

An import should be previewed before replacement. Validation checks the complete nested schema, IDs, quantities, conditions, constraints, duplicate codes, missing parents, parent cycles, item locations, plan references, history patches, and audit records. Treat warnings as review items and errors as blockers.

**Restore matching server & device** requires a signed-in workspace owner. Stowplan reloads the server revision, validates again, then uses compare-and-swap so a concurrent edit stops the restore instead of being overwritten. The restore is recorded in the server auth audit.

**Open as separate local copy** works offline, assigns a fresh workspace id, preserves the currently active workspace, and initializes an independent server copy after a later sign-in. Use it for inspection or when you do not intend to replace the shared server workspace.

## A blocked sync change

Open **Settings → Review sync issues or restore a backup**. The recovery screen exposes every pending or blocked command with its timestamp and server error. Before changing anything, export the full recovery bundle; unlike the ordinary workspace export, it contains the durable device queue too.

After signing in, **Load authorized server copy** is read-only. You then have two explicit choices:

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
