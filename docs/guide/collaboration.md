# Workspaces and collaboration

Stowplan keeps a durable replica on each device while the server controls who may read, edit, or manage a shared workspace. The workspace home screen brings those two sources together without treating either one as disposable.

## Find and open a workspace

Choose the house icon from an open workspace, or choose **Settings → Workspaces and backup status**. After sign-in, the home screen lists every active server membership the account may use as well as every workspace stored on the device. A fresh browser can therefore find a shared workspace without a saved link or known workspace ID.

Device and server records with the same stable workspace ID appear as one card. Search matches workspace names, roles, and state text. If more authorized server results exist, **Load more** makes the incomplete list explicit.

Each card names the workspace and server role when applicable. It also shows the last local edit, last successful backup, pending command count, blocked command count, and a state that does not rely on color:

| Card state | Meaning |
|---|---|
| Stored only on this device | No authorized server copy is known |
| Available from the server | The account has access, but this device has no replica |
| Device and server are synchronized | The local and server revisions match and no commands are waiting |
| Local changes are waiting to upload | Pending commands remain durable on this device |
| Backup refused one or more local changes | Blocked commands need review or recovery |
| This device has newer work | The device summary is ahead of the known server summary |
| The server copy is newer | The server summary is ahead of the local revision |
| Server workspace unavailable while offline | A discovered server-only workspace needs a connection before its first local download |
| Workspace access is unavailable | Membership ended, the workspace was deleted, or access cannot be confirmed |

Choose **Download and open** for a server-only workspace. Stowplan downloads the authorized snapshot, validates and normalizes it, creates the local replica, and then activates it. Other local workspaces remain intact. If the download or validation fails, the existing replicas and active workspace remain unchanged and an alert explains what to try next.

A discovered server-only card remains visible while offline, but **Open when online** explains why it cannot open yet. Any workspace that already has a local replica remains available offline.

Workspace links continue to use readable names plus stable IDs. Reload, browser back and forward, and an authorized invitation return path restore the intended workspace and view.

Share the ordinary browser URL when the other person is already a workspace member. If needed, Stowplan asks them to sign in and then returns them to that exact workspace and view. The ordinary URL does not grant access by itself. An owner uses an invite link only to enroll a new viewer or editor; after enrollment, both people use the ordinary workspace URL.

## Understand roles

A server-backed workspace shows the signed-in account's current role near its backup state and on **Workspace access**.

| Role | Browse, search, and inspect | Change workspace data | Manage members and invite links | Leave | Delete server workspace |
|---|---:|---:|---:|---:|---:|
| Viewer | yes | no | no | yes | no |
| Editor | yes | yes | no | yes | no |
| Owner | yes | yes | yes | only when another active owner remains | yes |

A device-only workspace behaves as locally owned so capture can continue before it is claimed by an account. That local behavior does not grant server access-management or deletion authority. Once the workspace is server-backed, the server role is authoritative.

Known viewers receive an explicit read-only explanation and cannot create a local workspace command or outbox entry. They can still navigate, search, filter, inspect items and locations, view plans and activity, follow readable links, and export authorized data. Editors can make ordinary workspace changes but cannot manage access, transfer ownership, or delete the server workspace. Owners can edit and manage access within the final-owner and quota safeguards.

Only an active workspace membership makes the server workspace discoverable through ordinary workspace screens. A separate global administrator role does not implicitly add membership or ordinary workspace access.

The interface prevents actions that the known role cannot perform, and the server checks every request again. A stale device role never grants server authority.

## Manage members

Owners can open **Workspace access** from a server-backed home card or from **Settings**. The member list shows the available display identity, email, role, and join time. Search and **Load more members** keep a long list bounded without presenting a partial result as complete.

An owner can change another active member to viewer, editor, or owner. The visible role changes only after the server confirms it. **Transfer ownership** is a separate confirmation: the active target becomes an owner and the transferring owner becomes an editor atomically. A disabled account cannot receive ownership or satisfy the final-owner safeguard. A final active owner cannot be demoted, removed, disabled, or leave. Add or transfer another active owner first, or delete the server workspace.

An owner can remove a member when the final-owner safeguard allows it. A stale request, missing member, no-op, quota refusal, or authorization failure produces an alert instead of a misleading success message.

## Create and revoke invite links

Invite links are owner-only. Choose viewer or editor access and enter a whole-number expiry from 1 through 168 hours. Stowplan validates the selected expiry against the policy reported by the server. The expiry controls when the invitation can be redeemed, not how long the resulting membership lasts.

The raw invite URL appears once after creation. Copy or share it before closing the dialog because stored link records never reveal the token again. New links use the fixed `/guest` page and keep the single-use token after `#` in the URL fragment. Browsers do not send that fragment in HTTP request paths, query strings, or `Referer` headers, so ordinary server access logs do not receive the credential. Canceling the device share sheet is a routine cancellation and does not show an error.

The confirmation page is safe for link previews and scanners to open. The recipient signs in when needed, returns to that page in the same browser tab, and explicitly accepts. Stowplan retains the fragment only in that tab while sign-in is in progress and sends the token to the fixed confirmation endpoint only in the bounded same-origin request body after acceptance. Only that action consumes the link. Legacy links with a token in the path remain accepted and are converted to the fragment form before the browser checks authentication.

Confirmation attaches a normal viewer or editor membership to the signed-in account without replacing its session. That membership remains until the member leaves, an owner removes the member, or the workspace is deleted. Revoking an unused link prevents enrollment; it does not remove a membership created by an already-used link.

The access screen lists active, used, expired, and revoked links with role, creation time, expiry, and non-secret status. Only an active link can be revoked. Repeated or stale revocation is refused visibly rather than reported as success. Active-link, retained-link, and member quotas can also refuse creation or redemption without consuming the link.

## Choose the right lifecycle action

**Remove from this device**, **Leave shared workspace**, and **Delete server workspace** have different consequences:

| Action | Server workspace | Membership | Device replica |
|---|---|---|---|
| Remove from this device | unchanged | unchanged | removed from this device |
| Leave shared workspace | unchanged for remaining members | caller's membership removed | retained until the caller chooses to keep, export, or remove it |
| Delete server workspace | content and access records immediately and permanently deleted; non-secret tombstone and audit metadata retained | all memberships removed | retained until the caller chooses to keep, export, or remove it |

**Remove from this device** names the pending and blocked command counts. If no server copy exists, it also warns that the device holds the only known copy. Removing a server-backed replica does not leave the workspace, so an authorized account can download it again on this or another device.

**Leave shared workspace** removes only the caller's membership. A non-final owner, editor, or viewer can leave. The final active owner must transfer ownership to another active member or delete the server workspace. After leaving, a retained local replica is read-only and no longer backed up. Stowplan asks whether to keep it, export a recovery copy, or remove it.

**Delete server workspace** is owner-only and requires the exact workspace name. Deletion is immediate and not recoverable: it removes the server snapshot, memberships, and invite records. The server retains only non-secret deletion tombstone and audit metadata, including the workspace ID, deletion actor and time, and final revision counters, for integrity and accountability. It does not retain the workspace contents, membership records, invite URLs, or invite token material. A retained local replica becomes read-only, and Stowplan separately asks whether to keep, export, or remove it. There is no server undelete path.

Export before any lifecycle action that could remove the only useful copy. Use the ordinary JSON backup for a portable workspace snapshot. If pending or blocked commands exist, use the full recovery export so the durable command queue is included. See [Backup, import, and recovery](/guide/recovery).

## Handle offline role changes

Stowplan cannot learn about a server role change while the device is offline. It may accept edits under the last confirmed writable role. Those edits remain durable on the device.

On reconnect, the server applies the authoritative role. A downgrade or membership removal updates the interface and refuses unauthorized commands. Stowplan marks those commands for review, preserves their human-readable intent and server refusal, and does not call them backed up. Export a recovery bundle before deciding whether to reapply authorized work or reset the device copy. See [Offline and server-outage behavior](/guide/offline).
