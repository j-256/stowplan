# Manual iPhone and iPad Safari smoke checklist

Use synthetic accounts and disposable workspaces for this checklist. Do not use production inventory or a workspace whose deletion would matter. Record the device model, iOS or iPadOS version, Safari version, browser or installed mode, orientation, and result with the release evidence.

## Prepare synthetic data

- [ ] Prepare owner, editor, and viewer accounts that are active members of a shared workspace
- [ ] Prepare another member who can receive role changes, ownership, and removal
- [ ] Prepare a server workspace that has never been opened on the test device
- [ ] Prepare a separate device-only workspace so a server download can prove that other local replicas remain intact
- [ ] Prepare a disposable shared workspace for leave and server-deletion checks
- [ ] Prepare a device replica with pending work and a safe way to produce an authorization rejection for recovery checks
- [ ] Keep a second signed-in browser available for role changes while the Safari device is offline

Run the visual and interaction checks in iPhone Safari portrait and landscape, iPad Safari portrait and landscape, and installed Home Screen mode where supported. Use an iPad hardware keyboard for keyboard-only checks. Repeat representative screens with light, dark, and system themes and with Reduce Motion enabled.

## Fresh-device discovery and IndexedDB

- [ ] Clear only the synthetic origin's Safari website data and confirm that no Stowplan replica remains
- [ ] Create or open the prepared device-only workspace, make a harmless edit, return to the workspace home screen, and note its local edit time
- [ ] Sign in without using a workspace deep link and confirm that the server-only workspace appears by name and role
- [ ] Confirm that the home card exposes state text, local edit time when present, last successful backup when present, pending count, and blocked count without relying on color
- [ ] Search the home screen and use **Load more** when pagination is available
- [ ] Choose **Download and open** and confirm that the authorized server workspace opens
- [ ] Return home and confirm that the earlier device-only workspace still exists with its newer local summary
- [ ] Reload Safari, close and reopen the tab, and relaunch installed mode; confirm that IndexedDB preserves both replicas and the intended active workspace
- [ ] Follow a readable workspace URL, then use back, forward, and reload to confirm that the same workspace and view return
- [ ] Use a synthetic route fixture that refuses or returns a malformed server download and confirm that the existing active workspace and local replicas remain unchanged while an actionable alert appears

## Roles and read-only behavior

- [ ] Open the shared workspace as a viewer and confirm that the role and read-only explanation appear near workspace status
- [ ] Navigate Capture, Spaces, Inventory, Plan, Activity, Settings, item details, and location details by touch and keyboard without encountering a mutation path
- [ ] Search and filter as the viewer, follow readable URLs, and export authorized data
- [ ] Try visible mutation entry points, drag and drop, keyboard shortcuts, bulk actions, dialogs, and destructive actions; confirm they are disabled, absent, or replaced with honest read-only text
- [ ] Return to the home card and confirm that the viewer attempt created no pending or blocked outbox entry
- [ ] Open as an editor, make an ordinary workspace change, and confirm that it enters the durable outbox and backs up when online
- [ ] Confirm that an editor cannot manage members, create or revoke invite links, transfer ownership, or delete the server workspace
- [ ] Open as an owner and confirm that ordinary editing and **Workspace access** are available

## Keyboard, focus, and responsive layout

- [ ] Use Tab and Shift-Tab through workspace cards, pagination, access controls, member role controls, link controls, and lifecycle actions in a predictable order
- [ ] Open each new dialog with the keyboard and confirm that focus moves inside it
- [ ] Confirm that the initial focus is on the safe or expected control, focus remains within the open dialog, and Escape closes it when cancellation is allowed
- [ ] Confirm that closing a dialog returns focus to the control that opened it
- [ ] Use Space or Enter to activate buttons, links, radio choices, and confirmations
- [ ] Use arrow keys inside text fields, number fields, selects, radio groups, and editable text; confirm that global navigation does not intercept native behavior
- [ ] Zoom text and use long workspace, member, and email names; confirm that no page scrolls horizontally and no control or status is clipped
- [ ] Confirm that dialogs remain on-screen and scroll internally when needed in every tested orientation
- [ ] Confirm that primary touch controls remain comfortably usable and that status meaning is available in text
- [ ] Confirm that reduced motion and each theme preserve readable focus, status, and destructive-action distinctions

## Owner member and invite-link management

- [ ] Search members, paginate when available, and confirm that identity, email when available, role, and join time remain readable
- [ ] Change a member between viewer and editor and confirm that the displayed role changes only after the server succeeds
- [ ] Promote a member to owner, then use the explicit ownership transfer flow and confirm the actor becomes editor only after server confirmation
- [ ] Remove a non-owner and confirm that the member disappears only after server confirmation
- [ ] Attempt to demote, remove, or leave as the final owner and confirm a visible refusal with no misleading activity entry
- [ ] Create a viewer invite link with a valid enrollment expiry and confirm that the raw URL appears once
- [ ] Create an editor invite link with a different valid enrollment expiry and confirm that the chosen expiry is preserved
- [ ] Redeem an invite and confirm that the resulting membership remains after the enrollment link has been consumed
- [ ] Confirm that active, used, expired, and revoked records show role, creation time, expiry, and non-secret status without revealing a stored raw token
- [ ] Revoke an active link, repeat the stale revocation request, and confirm that the repeat is visibly refused
- [ ] Open a raw invite URL in a separate Safari context and confirm that viewing the confirmation page does not consume it before confirmation

## Clipboard and share fallbacks

- [ ] Use **Copy URL**, paste into a synthetic note, and confirm that the complete one-time URL was copied
- [ ] Use **Share**, select a safe destination, and confirm that the shared URL is complete
- [ ] Open the share sheet again and cancel it; confirm that cancellation produces no toast or alert
- [ ] Deny or make clipboard access unavailable where the device permits, then confirm that the raw URL remains selectable for manual copy and that the error does not close the one-time dialog
- [ ] Exercise a context without Web Share support where available and confirm that copy or manual selection remains usable
- [ ] Close the one-time dialog and confirm that the stored invite record does not reveal the raw token

## Installed and offline behavior

- [ ] Load the app online, add it to the Home Screen, launch it once, and confirm that the intended workspace and view restore
- [ ] Take the device offline and relaunch installed mode
- [ ] Confirm that application assets load and every workspace with a local replica can open
- [ ] Confirm that an already discovered server-only card remains visible and presents the keyboard-accessible **Open when online** action
- [ ] While signed out, edit a device-only workspace and confirm that the compact status says the change is saved on this device without showing a backup-failure alert
- [ ] End the Stowplan session for an active server-backed workspace and confirm that **Remote backup paused** remains prominent, explains that local work is safe, and offers **Sign in again**
- [ ] Show backup and workspace-access notices together, dismiss each independently, and confirm that the compact backup status remains after the large backup notice closes
- [ ] Make an offline editor change and confirm that it remains durable across reload without being called backed up
- [ ] Restore connectivity and confirm that reconciliation preserves pending and blocked commands, does not regress a newer local summary, and does not switch the active workspace
- [ ] Confirm that API data does not appear as a stale service-worker response after role or membership changes

## Offline role downgrade and recovery

- [ ] Start as an editor on Safari, take the device offline, and make a synthetic edit under the last confirmed writable role
- [ ] From the second browser, downgrade the Safari account to viewer or remove its membership
- [ ] Bring Safari online and confirm that the server rejects unauthorized work, the role or access state updates visibly, and the workspace becomes read-only
- [ ] Confirm that the rejected command remains visible with its intended action and refusal reason
- [ ] Confirm that the card never describes the rejected command as backed up
- [ ] Export the full recovery bundle and confirm that the blocked command remains available for review or authorized recovery

## Three separate lifecycle paths

### Remove from this device

- [ ] Open the removal confirmation and confirm that it names pending and blocked work
- [ ] For a device-only workspace, confirm that it warns when the device holds the only known copy
- [ ] Export the appropriate backup, remove the local replica, and confirm that no other local workspace is removed
- [ ] On a fresh signed-in browser, confirm that a server-backed workspace remains discoverable and downloadable because membership was unchanged

### Leave shared workspace

- [ ] Leave as a non-final owner, editor, or viewer and confirm that only the caller's server membership ends
- [ ] Confirm that other members can still open the server workspace
- [ ] Confirm that the local replica remains until the user chooses to keep it read-only, export recovery data, or remove it
- [ ] Confirm that keeping the replica never resumes server backup and that removing it is a separate action

### Delete server workspace

- [ ] Open deletion as an owner and confirm that the dialog states deletion is immediate and not recoverable
- [ ] Confirm that the destructive button remains unavailable until the exact workspace name is entered
- [ ] Export the appropriate backup, delete the disposable server workspace, and confirm that the local replica remains until a separate device-copy choice
- [ ] From another member session, confirm that the workspace cannot be listed or opened
- [ ] Confirm that an unused invite link cannot redeem the deleted workspace
- [ ] Repeat the deletion or race it with a role change and confirm a safe refusal without workspace resurrection

## Completion evidence

- [ ] Save screenshots of the workspace home, viewer explanation, owner access screen, one-time link dialog with its raw URL field redacted, offline server-only state, stale-role refusal, and each lifecycle confirmation
- [ ] Record any browser-specific limitation, fallback used, and unresolved issue without including account secrets, invite URLs, session tokens, or inventory content
- [ ] Confirm that all synthetic raw invite URLs and disposable data are revoked or removed according to the test environment's cleanup policy
