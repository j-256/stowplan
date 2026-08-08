# Backup and recovery

Use backups for device loss, browser cleanup, major workspace changes, and refused online work. Activity is better for an ordinary recent mistake.

## Choose the right export

**Settings → Backup & recovery → Export JSON backup** saves a portable workspace snapshot, including its spaces, items, plans, and available history. It does not contain an app session or sign-in secret.

**Settings → Backup & recovery → Review sync issues or restore a backup → Export full recovery bundle** also includes changes waiting for upload, refused changes, and their errors. Use this version whenever the device and online copy disagree.

Save either file somewhere outside the browser or device whose data you are protecting.

## Recover refused or conflicting changes

Open **Settings → Backup & recovery → Review sync issues or restore a backup**. The screen lists waiting and refused changes with the time and server message.

If the browser refuses to open site storage, Recovery shows a blocking alert and does not offer export, reset, or restore actions. Do not clear site data as a troubleshooting step. Correct the browser or private-browsing restriction and reload Recovery so Stowplan can read the device copy before offering any action.

Before changing anything, choose **Export full recovery bundle** and confirm that you saved the file. If your account can still read the online workspace, choose **Load authorized server copy** to compare without changing either copy.

If your role permits edits, choose one of these guarded paths:

- Type `REAPPLY` and choose **Reapply queued work on server copy** to rebuild unresolved device changes against the latest online copy. Work already accepted online is skipped.
- Type `RESET` and choose **Reset this device to server copy** to discard the device queue and use the online version.

Use `REAPPLY` when the local intent is still correct and authorized. Use `RESET` only when the online copy is the result you want and you have saved the recovery bundle.

If your role is now viewer or your membership ended, reset and reapply remain disabled. Keep the full recovery bundle, then either ask an owner to restore editor access or send a new invitation, or import the bundle and choose **Open as separate local copy** to preserve the device result as an independent workspace.

If validation, access, or a replayed change fails, Stowplan leaves the existing device copy in place and reports that nothing was changed.

## Make routine backups

Export before:

- clearing site data or uninstalling the app
- removing a device copy that may be the only copy
- leaving a shared workspace
- deleting an online workspace
- importing or restoring a different snapshot
- attempting recovery of refused changes

An exported file is a copy you control. It is not a server undelete service and does not preserve former memberships or invite links.

## Open a backup without replacing anything

1. Open **Settings → Backup & recovery → Review sync issues or restore a backup**.
2. Choose the JSON file.
3. Review the validation report and the incoming workspace summary.
4. Choose **Open as separate local copy**.

This option gives the imported workspace a new identity, works offline, and leaves every existing device workspace unchanged. Use it to inspect a backup or recover its contents without replacing a shared workspace.

## If this installation goes away

Keep a portable JSON backup or full recovery bundle somewhere you control. Open **Recovery** on another trusted Stowplan installation, choose the file, review it, and choose **Open as separate local copy**.

The imported copy receives a new workspace identity. Former memberships, invite links, and online backup do not move with it. Sign in to the new installation only after reviewing that installation's operator and data practices.

## Restore a matching online workspace

**Restore matching server & device** is available only to a signed-in owner. It replaces the matching online workspace and its matching device copy, so Stowplan requires several safeguards:

1. Review the incoming and existing workspace summaries.
2. Export the online workspace that would be replaced and confirm that you saved it.
3. If a matching device copy exists, export its full recovery bundle too.
4. Confirm the validation report.
5. Choose **Restore matching server & device**.

Immediately before replacement, Stowplan checks the online workspace again. If someone changed it during your review, the restore stops and refreshes the comparison instead of overwriting their work.

Viewers and editors can inspect and export data they are allowed to read, but they cannot replace the matching online workspace.

## After leaving or deletion

Leaving a shared workspace or deleting its online copy does not silently erase the device copy. Stowplan offers to keep it read-only, export it, or remove it.

Server workspace deletion is immediate and has no server undelete path. Read [Workspaces and sharing](/guide/collaboration) before choosing among the lifecycle actions.
