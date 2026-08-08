# Offline and backup

Stowplan saves accepted workspace changes in this browser first. You can keep capturing and organizing through weak service or an outage, then let online backup catch up later.

Local-first does not mean permanent by itself. Browser site data can be cleared, a device can fail, and an app can be uninstalled. Export important work or sign in for online backup before relying on the device as your only copy.

## What works without a connection

A workspace already opened on this device remains available for browsing and, when your last confirmed role permits it, editing. Capture, search, spaces, inventory, plans, and Activity use the saved device copy.

An online workspace that has never been downloaded to this device needs a connection once. Its card says **Open when online** until Stowplan can download and check the first local copy.

After an online app load installs offline support, the workspace hub, built-in quick guide, printable labels, Recovery, privacy page, and offline help remain available without separately visiting each page first. Account and administration pages require a connection and show the offline fallback instead. Workspace data comes from the saved device copy, not from a cached server response.

## Read the workspace status

| Status | What it means |
|---|---|
| Stored only on this device | Stowplan does not know of an authorized online copy |
| Available from the server | The signed-in account has access, but this device has not downloaded it |
| Device and server are synchronized | The known device and online copies match and nothing is waiting |
| Local changes are waiting to upload | The changes are saved here, but the online copy is behind |
| Backup refused one or more local changes | Stowplan preserved work that needs review |
| This device has newer work | The device summary is ahead of the latest online summary it knows |
| The server copy is newer | Another device or person changed the online copy |
| Server workspace unavailable while offline | This device needs a connection for the first download |
| Workspace access is unavailable | Membership ended, the workspace was deleted, or access cannot be confirmed |

A failed connection does not erase the last successful backup time. Stowplan shows the newer error separately.

## What happens when the connection returns

Stowplan retries waiting changes, including changes in local workspaces that are not open. It also checks the open workspace for changes from other devices. It does not switch workspaces on its own or discard refused work.

If your Stowplan session expires, **Remote backup paused** means local work remains on the device but cannot reach the account until you sign in again.

If another person changed a different field, both changes can usually be preserved. If the same field changed in incompatible ways, Stowplan keeps the device's intended action for review rather than silently choosing a winner.

## Shared workspaces offline

A known viewer stays read-only offline. A known owner or editor can continue making local changes.

The device cannot know that an owner changed your role or removed your membership while it was disconnected. After reconnecting, server access wins. Any newly unauthorized work stays visible as refused work and can be exported from Recovery.

On a shared browser, saved server permission belongs to the account that received it. Switching accounts makes that workspace read-only until Stowplan confirms the new account's access. Waiting changes from the first account are not uploaded as the second account.

## Before clearing browser data

Open **Settings → Backup & recovery → Review sync issues or restore a backup** if anything is waiting or refused, then export the full recovery bundle. For a clean workspace, **Settings → Backup & recovery → Export JSON backup** creates a portable snapshot.

Save the file somewhere outside this browser's site data. See [Backup and recovery](/guide/recovery) for restore choices.
