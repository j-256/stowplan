# Account, privacy, and data

You can use Stowplan without an account. Signing in adds online backup and sharing, but it also sends workspace data to the installation's server. This page explains that choice in terms of what is stored, who can access it, and what removal actions do.

This describes the behavior built into Stowplan. The official hosted service publishes its [Privacy Policy](stowplan:privacy) and [Terms of Service](stowplan:terms). If you use an installation run by someone else, that operator also controls its infrastructure, backups, access policy, and published legal terms.

## Device-only and signed-in use

| | Without signing in | After signing in |
|---|---|---|
| Workspace storage | This browser's site data | This browser, plus an online copy after that workspace backs up successfully |
| Online backup | no | available for the open workspace and work waiting to upload |
| Sharing | no | viewer, editor, and owner memberships |
| Recovery | your exported files and device copy | device copy, exported files, and authorized server copy |

Device-only work is normal, but browser storage can be cleared and a device can fail. Anyone with access to the same browser profile may also be able to open the local workspace.

Signing in is not proof that every local workspace has an online copy. An untouched inactive workspace can remain only in the browser. Trust each workspace card's **Last successful backup** and status rather than account sign-in alone.

## What signing in sends

After sign-in, Stowplan attempts to create or update an online copy of the workspace you have open. It also attempts to send changes waiting in other local workspaces, even when those workspaces are not open. Local copies remain in the browser.

The online workspace contains the data needed to reproduce and collaborate on it, including workspace and location names, physical-label codes, hierarchy, item records and details, plans, Activity and undo history that is still retained, and synchronization records.

The account server also stores account and security information such as display name, email, linked sign-in identity identifiers, the accepted Terms version and time, app sessions, invite and membership records, coarse network information, browser or device descriptions, timestamps, and security audit events. Stowplan requests Google's `openid`, `email`, and `profile` scopes for Google sign-in.

Stowplan does not request Google offline access and does not keep Google access or refresh tokens after sign-in completes.

## Who can read an online workspace

Workspace viewers, editors, and owners can read the workspace. Their ability to change it depends on the role described in [Workspaces and sharing](/guide/collaboration).

A database-authorized global administrator can inspect and export the complete online workspace through the installation control panel without becoming a workspace member. That inspection is recorded in the installation's administrative audit data, but it does not appear as an ordinary workspace Activity entry. A global administrator can also delete an online workspace or explicitly take owner custody.

The hosting operator and people with infrastructure or backup access may have additional access outside Stowplan's ordinary workspace-role screens. Do not treat a server-backed workspace as end-to-end encrypted from the operator or global administrators.

## Sessions and account access

The Account page keeps its return action at the top. Before sign-in, the available sign-in controls appear before the expandable online-data and privacy explanation. After sign-in, workspace collaboration appears before session management and account deletion; opening Account from a workspace also provides a direct return to that workspace's access controls.

Google sign-in asks you to agree to the installation's Terms and acknowledge its Privacy Policy. A separate, optional **Keep me signed in after I close the browser** choice lets the secure session cookie remain beyond the browser session. Leave it unchecked when you want a browser-session cookie. In either case, the server session has a fixed expiry and can be revoked sooner.

Open **Account and sessions** from the user menu to review signed-in browsers and devices. A session record can show its browser or device description, coarse network, creation time, approximate last server activity, expiry, and revocation time.

Choose **Revoke session** to remove another session's server access, or **Sign out this session** for the current browser. Revoking a session does not erase workspace copies or waiting changes already stored on that device.

If a session ends while you are working, the local workspace remains available and **Remote backup paused** appears until you sign in again.

## Backups, Activity, and retained records

A portable JSON export contains workspace data but no app session or sign-in secret. A full recovery bundle also contains waiting or refused device changes and their errors. Both are readable files under your control, so store and share them as carefully as the inventory itself.

Activity and undo detail are bounded. Older changes can eventually lose their undo action as a workspace reaches its limits, while the current workspace state remains.

Expired or revoked session and invite records remain for a cleanup period so Stowplan can enforce and investigate account activity. Security audit events have no automatic expiry in the application. Account deletion redacts or removes personal references from retained records where the software's deletion flow specifies, but it does not erase the fact that an audited security or control action occurred.

An installation operator may also keep infrastructure backups according to a separate retention policy. Stowplan's user interface cannot promise when an operator's independent backup copy expires.

## Remove a device copy, workspace, or account

These actions are intentionally separate:

- **Remove from this device** erases only this browser's workspace copy. It does not change membership or the online copy.
- **Leave shared workspace** removes your membership. It does not delete the workspace for remaining members.
- **Delete server workspace** removes the live online contents, memberships, and invite records with no server undelete path. Stowplan retains non-secret deletion and administrative audit metadata, and operator-controlled infrastructure backups may follow a separate retention policy.
- **Delete server account** removes sign-in identities and safe workspace memberships, revokes sessions and unused invite links, and redacts retained security records. It does not delete shared workspace contents, which remain for other members. Device copies and waiting device work remain until removed separately.

Account deletion may be blocked while the account is a global administrator or the only eligible owner of a live workspace. Stowplan shows what must be transferred or changed before deletion can continue.

Export anything you need before a removal action. See [Backup and recovery](/guide/recovery).

## Remove Google consent

Deleting a Stowplan account cannot revoke Google consent because Stowplan does not retain a Google token that could do so. To remove that connection as well, remove Stowplan from the connections page in your Google Account.
