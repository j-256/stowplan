# Workspaces and sharing

Online backup and sharing are optional. A workspace can remain on one device without an account, or it can have an online copy with viewers, editors, and owners.

## Accept an invitation

If someone sent you an invite link:

1. Open the link in the browser where you want to use Stowplan.
2. Review whether the invitation offers viewer or editor access.
3. Sign in if Stowplan asks you to.
4. Stowplan returns you to the invitation in the same tab. Verify the displayed account and choose **Accept invitation**.
5. Stowplan opens the shared workspace.

Opening or previewing the link does not accept it. Acceptance is an explicit action, and each invite link can enroll one account before its expiry. After acceptance, your membership remains until you leave, an owner removes you, or the server workspace is deleted.

Workspace owners can see the display name and email of the account you use to accept.

Later, use the house icon to find the workspace again. On a different device, sign in and choose **Download and open** the first time.

An ordinary workspace URL is useful for people who are already members, but it does not grant access.

## Find your workspaces

Choose the house icon from an open workspace, or open **Settings → Workspaces and backup status**. After sign-in, this screen combines workspaces stored in this browser with online workspaces the account may use.

If an online workspace is not yet on this device, choose **Download and open**. Stowplan checks the download before saving it and leaves your other local workspaces intact. The card remains visible offline, but its action changes to **Open when online** until the first download succeeds.

## Understand roles

| Role | Browse and search | Change workspace content | Manage people and invites | Delete the online workspace |
|---|---:|---:|---:|---:|
| Viewer | yes | no | no | no |
| Editor | yes | yes | no | no |
| Owner | yes | yes | yes | yes |

Viewers can browse, search, inspect plans and Activity, follow workspace links, and export data they are allowed to read. Editors can also capture, organize, move, plan, and undo. Owners manage roles, invitation links, ownership, and server deletion.

The final active owner cannot leave, be removed, or become a lower role. Transfer ownership or add another active owner first.

## Invite someone

An owner opens **Workspace access**, chooses viewer or editor access, sets an expiry, and chooses **Create invite link**.

The full invite URL appears only in the creation dialog. Copy or share it before choosing **Done**. A link preview or scanner may open the page safely; only **Accept invitation** enrolls the signed-in person.

Revoking an unused invite prevents future acceptance. It does not remove someone who already accepted it. Remove that person's membership separately if needed.

## Change access

Owners can change another member's role, remove a member, or transfer ownership. Stowplan waits for server confirmation before showing a role change as complete.

Any member can choose **Leave shared workspace** when another active owner remains. The final active owner must add or transfer ownership first. Leaving removes only that person's server membership. Stowplan then asks whether to keep the device copy read-only, export it, or remove it.

## Choose the right removal action

| Action | Online workspace | Your membership | This device's copy |
|---|---|---|---|
| **Remove from this device** | unchanged | unchanged | removed from this browser |
| **Leave shared workspace** | kept for remaining members | removed | kept read-only until you choose what to do |
| **Delete server workspace** | immediately and permanently deleted | all memberships removed | kept read-only until you choose what to do |

**Remove from this device** is appropriate when another usable copy exists. If the workspace was never backed up, the confirmation warns that this browser may hold the only copy.

**Delete server workspace** is owner-only, requires the exact workspace name, and has no server undelete path. Export first. An exported file remains a user-held copy, but it does not restore the deleted online workspace with its former identity or memberships.

## If access changes while you are offline

Stowplan cannot learn about a role change until it reaches the server. It may accept edits using the last confirmed owner or editor role and keep them on the device.

On reconnect, the server's role wins. Work no longer authorized is retained as a refused change rather than reported as backed up. Export a full recovery bundle before doing anything else.

If you still have editor or owner access, Recovery can help reapply authorized work or reset to the online copy. If your role is now viewer or your membership ended, those write actions stay disabled. Ask an owner to restore editor access or send a new invitation, or import the exported bundle with **Open as separate local copy** to keep the device result as an independent workspace. See [Offline and backup](/guide/offline) and [Backup and recovery](/guide/recovery).
