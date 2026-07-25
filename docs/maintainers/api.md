# API and sync protocol

All responses containing workspace or administrative data use `Cache-Control: no-store`. The service worker excludes `/api/`.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | none | Process/storage readiness |
| `/api/workspaces` | GET | active session | List only the caller's active workspace memberships |
| `/api/workspaces/:workspaceId/access` | GET | workspace member | Read the caller's role, capabilities, workspace summary, guest-link policy, and owner-only quota usage |
| `/api/workspaces/:workspaceId/members` | GET | workspace owner | List and search members |
| `/api/workspaces/:workspaceId/members/:userId` | PATCH, DELETE | workspace owner | Change a role or remove another member |
| `/api/workspaces/:workspaceId/ownership-transfers` | POST | workspace owner | Atomically transfer ownership to another member |
| `/api/workspaces/:workspaceId/membership` | DELETE | workspace member | Leave while keeping local-replica disposition separate |
| `/api/workspaces/:workspaceId/guest-links` | GET, POST | workspace owner | List links or create a viewer/editor link |
| `/api/workspaces/:workspaceId/guest-links/:guestLinkId` | DELETE | workspace owner | Revoke an active link |
| `/api/workspaces/:workspaceId` | DELETE | workspace owner | Immediately delete the server workspace after strong confirmation |
| `/api/sync` | POST | workspace member | Initialize/claim, replay editor/owner commands, or pull with an empty viewer batch |
| `/api/snapshot?workspaceId=…` | GET | workspace member | Read authorized server copy for conflict recovery |
| `/api/snapshot` | PUT | workspace owner | Validated compare-and-swap backup restore |
| `/api/auth/me` | GET | optional | Session and provider configuration state |
| `/api/auth/:provider/start` | GET | none | Begin Google/GitHub code + PKCE flow |
| `/api/auth/:provider/callback` | GET | OAuth state | Exchange code and issue app session |
| `/api/auth/access` | POST | Access assertion | Issue app session after JWT verification |
| `/guest/:token` | GET | single-use enrollment token | Show the confirmation page without consuming the link or losing its workspace return path |
| `/api/auth/guest/:token` | POST | active session + enrollment token | Atomically enroll the signed-in account and return to the validated workspace view |
| `/api/auth/logout` | POST | session | Revoke current session and clear cookie |
| `/api/admin/overview` | GET | global admin (+ optional matching Access assertion) | Read users, sessions, links, audit |
| `/api/admin/mutate` | POST | global admin (+ optional matching Access assertion) | Role/status/revocation operations |
| `/api/admin/guest-links` | POST | workspace owner | Legacy-compatible entry point that delegates to the owner-only guest-link policy |

## Workspace discovery

`GET /api/workspaces` is the member-scoped discovery contract. It never requires the caller to know a workspace ID and never treats global admin scope as membership. An active user receives only snapshots joined through that user's active memberships; a disabled user, revoked or missing session, missing membership, or deletion tombstone cannot broaden the result.

The query accepts `limit`, opaque `cursor`, `q`, and `role`. `limit` defaults to 25 and must be from 1 through 50. `q` is a case-insensitive workspace-name or stable-ID search of at most 120 characters. `role` is `owner`, `editor`, or `viewer`. Results are ordered by stable workspace ID so content edits between pages cannot move an unread record across the continuation boundary. Search and role filtering happen after membership scoping, so response differences cannot enumerate another user's workspaces.

```json
{
  "membershipRevision": 7,
  "workspaces": [
    {
      "id": "ws_example",
      "name": "Kitchen",
      "role": "editor",
      "capabilities": {
        "read": true,
        "write": true,
        "manageAccess": false,
        "leave": true,
        "delete": false
      },
      "revision": 12,
      "updatedAt": "2026-07-25T00:00:00.000Z",
      "membershipRevision": 7,
      "accessRevision": 9
    }
  ],
  "page": {
    "limit": 25,
    "hasMore": false,
    "nextCursor": null
  }
}
```

Every bounded list returns `page.limit`, `page.hasMore`, and an opaque `page.nextCursor`. A client must continue while `hasMore` is true and must not present a truncated page as complete. Catalog cursors bind the membership revision, search, role filter, ordering position, and cursor version. Member and guest-link cursors bind the workspace access revision and their filters. A changed counter returns `409 ACCESS_STALE`; discard that traversal and restart it rather than appending results from different authorization states.

`GET /api/workspaces/:workspaceId/access` returns the same canonical workspace summary plus an `access` object, the supported guest-link roles and expiry range, and owner-only member/link quota usage. The client persists the server role and capabilities explicitly; it does not derive authority from a local replica or global admin scope.

## Roles and capabilities

| Server role | Read | Write workspace data | Manage members and links | Leave | Delete server workspace |
|---|---:|---:|---:|---:|---:|
| `viewer` | yes | no | no | yes | no |
| `editor` | yes | yes | no | yes | no |
| `owner` | yes | yes | yes | only when another active owner remains | yes |

A device-only workspace may use a local owner-like role with read/write capability before it is claimed. That local state does not grant server management or deletion authority. Once server-backed, the server role is authoritative. Client capability checks prevent known viewers from creating local commands or outbox entries, but every server read and mutation still checks the active membership and role transactionally.

An offline client may retain commands accepted under its last known writable role. On reconnect, a downgrade or removal wins. Rejected commands remain available for inspection and recovery export and are never reported as backed up.

## Access mutations and concurrency

Authenticated workspace catalog, access, snapshot, and sync requests include `X-Stowplan-Account-Id` with the non-secret user ID from `/api/auth/me`. The server requires an exact match with the authenticated session before reading workspace data or mutating it and echoes the same header on a successful private response. A missing or mismatched binding returns `409 ACCOUNT_CONTEXT_CHANGED`. This prevents one tab from applying another tab's stale account state after the shared session cookie changes. The browser discards a response whose echoed account does not match the account that started the request. The first global-admin overview response bootstraps the same binding; later admin reads and every admin mutation require it. Invite confirmation instead posts the rendered `expectedAccountId` in its bounded form so an account switch cannot enroll a different signed-in account.

Workspace access mutations require `Content-Type: application/json`, a trusted mutation origin, an active session, the matching account binding, and a body no larger than 32 KiB. The request body carries the revisions read by the client:

| Operation | Required body fields |
|---|---|
| Change member role | `role`, `expectedAccessRevision`, `expectedMembershipRevision` |
| Remove member | `expectedAccessRevision`, `expectedMembershipRevision` |
| Transfer ownership | `targetUserId`, `expectedAccessRevision`, `expectedActorMembershipRevision`, `expectedTargetMembershipRevision` |
| Leave | `expectedAccessRevision`, `expectedMembershipRevision` |
| Create guest link | `role`, `expiresInHours`, `expectedAccessRevision`, optional `returnTo` |
| Revoke guest link | `expectedAccessRevision` |
| Delete server workspace | `confirmationName`, `expectedRevision`, `expectedAccessRevision`, `expectedMembershipRevision` |

Authorization has two monotonic concurrency counters in addition to the workspace data revision:

- `users.membership_revision` advances whenever any workspace membership for that user is inserted, removed, or changes role, and whenever the user's active or disabled status changes. Catalog traversal and user-specific mutation checks use it.
- `workspace_snapshots.access_revision` advances whenever a membership is inserted, removed, or changes role, whenever a member's active or disabled status changes, and whenever a guest link is inserted or removed or its role, expiry timestamp, consumed state, or revoked state changes. Access lists, derived capabilities such as whether an owner may leave, and workspace-scoped mutations use it.

Database triggers maintain both counters in the numbered Node/D1 migration stream and the packaged Drizzle stream. Application services do not increment them manually. The counters are non-negative, monotonic JavaScript-safe integers. Conditional SQL rechecks expected counters, roles, quotas, and final-owner state in the same transaction as the mutation and non-secret audit record. The service captures the committed response state inside that transaction, so a later role change cannot turn a completed operation into a false refusal or hide a newly created one-time token. A stale, no-op, missing-target, quota, or authorization refusal creates no success audit event.

Ownership transfer is a distinct two-member operation: the active target becomes owner and the transferring owner becomes editor in one transaction. A role patch can add another active owner but is not labeled as a transfer. A disabled account cannot receive ownership and does not satisfy the final-owner safeguard. The final active owner cannot be demoted, removed, disabled, or leave. Editors and viewers cannot manage access or delete the server workspace.

Global administration is a separate control plane. A global admin can perform explicit operator actions through `/api/admin/*`, where final-owner, quota, audit, and revision triggers still apply. Global admin scope alone never lists, opens, syncs, restores, manages, leaves, or deletes a workspace through ordinary member APIs.

## Guest-link lifecycle

Owners can create `viewer` or `editor` guest links with an integer expiry from 1 through 168 hours. Active-link and retained-link quotas are checked in the same conditional write as creation. Guest redemption also reserves the final member slot transactionally.

Creation returns the raw token and normalized URL once. Only its hash is stored. Lists expose the non-secret link ID, role, creation time, expiry, and `active`, `used`, `expired`, or `revoked` status, never the raw token. `GET /guest/:token` only renders the confirmation page; only the trusted confirmation `POST` consumes the token, attaches the durable membership to the signed-in account, writes the non-secret acceptance audit record, and marks the link used in one transaction. It does not create or replace a session. This keeps previews and scanners from claiming access. Link expiry controls whether enrollment may occur; it does not expire the resulting membership. The membership persists until that member leaves, an owner removes it, or the workspace is deleted.

Only an active link can be revoked. A repeated or stale revocation returns a visible conflict rather than false success. Used, expired, and revoked records count toward the retained-link quota until cleanup becomes eligible after the retention period. Cleanup and server deletion remove records without exposing token hashes in audit details.

## Server workspace deletion

Server deletion is owner-only and immediate. The caller must provide the exact current workspace name plus the expected snapshot, access, and membership revisions. One transaction writes a non-secret tombstone and audit record, revokes any affected legacy guest-only sessions, deletes guest links and memberships, and deletes the server snapshot. Concurrent sync, invitation redemption, role changes, and repeated deletion either complete before that transaction or fail against the tombstone and cannot resurrect the workspace ID.

The response reports `recovery: "not_available"` and requires a separate local-replica disposition. Stowplan stores no recoverable server snapshot for this operation. Export the portable workspace backup first, and export the full recovery bundle when pending or blocked commands exist. Those files preserve user-held data; they do not turn the deletion endpoint into an undelete service. Removing a replica from one device and leaving a membership are separate operations and never imply server deletion.

## Request, response, and error policy

Every response containing private workspace, membership, link, session, or administrative state sets `Cache-Control: no-store` and receives the normal application security headers. The service worker excludes `/api/`, and a successful background refresh does not need a user-facing toast.

Workspace access errors use a structured body with at least `code` and `error`; safe current access, member, quota, or confirmation details may be added when they help the caller recover. Malformed input returns `400 INVALID_REQUEST`, missing authentication returns `401 AUTHENTICATION_REQUIRED`, insufficient role returns `403`, and an inaccessible workspace or cross-workspace target returns a generic `404 NOT_FOUND_OR_INACCESSIBLE` without private data. Stale counters, no-ops, final-owner refusals, and quota conflicts return `409`; a caller-visible deletion tombstone returns `410 WORKSPACE_DELETED`; oversized bodies return `413 BODY_TOO_LARGE`; a non-JSON access mutation returns `415`; and missing storage returns `503 STORAGE_UNAVAILABLE`. Unexpected failures return a generic `500 INTERNAL_ERROR` without SQL, assertions, tokens, or another workspace's data.

Browser mutations require a trusted `Origin`, reject cross-site Fetch Metadata, and reject browser-shaped requests that omit `Origin`; non-browser clients without Fetch Metadata may omit `Origin` and still authenticate normally. Security headers apply a same-origin CSP, deny framing, restrict browser capabilities, and disable content-type sniffing. JSON bodies are streamed through a byte-counting parser rather than buffered without a limit. Workspace access mutations accept at most 32 KiB, sync and snapshot restore accept at most 8 MiB, and development sign-in plus remaining administrative control mutations accept at most 256 KiB. An oversized body returns before any state mutation.

## Sync body

```json
{
  "workspaceId": "ws_…",
  "snapshot": { "schemaVersion": 1, "workspace": {} },
  "commands": [{ "id": "cmd_…", "baseRevision": 12, "expectations": [], "command": {} }]
}
```

The initial authenticated sync may include a fully validated local snapshot; the server creates it and assigns owner membership. A colliding workspace ID never grants membership to the second creator. Subsequent syncs require membership, and only editors/owners may submit commands. An empty member batch is a low-frequency pull reconciliation. Before replay, the server replaces every command envelope's `actorId` with the authenticated user ID while preserving command IDs and order, so client-supplied attribution is never authoritative. The response contains the authoritative snapshot plus a receipt per command: `applied`, `duplicate`, or `rejected` with structured conflicts.

Owner restore validates the backup again, requires the caller's expected server revision, advances the restored revision, and uses the same persistence compare-and-swap as sync. A concurrent write returns `409` and leaves both versions unchanged.

Same-field stale edits reject. Unrelated stale edits can merge because expectations are field-specific. The client must retain rejected envelopes for user review and recovery export.

## Application quotas

`src/shared/quotas.js` is the commented source of truth for these deliberately generous application limits and the guest-link expiry policy. Transport security ceilings, pagination and query bounds, retry timing, and presentation limits stay beside their enforcement because they are not application quotas:

| Resource | Limit |
|---|---:|
| Owned workspaces per user | 50 |
| Members per workspace | 100 |
| Active guest links per workspace | 100 |
| Retained guest links per workspace | 2,000 |
| Commands per sync request | 100 |
| Compacted command receipts per snapshot | 20,000 |
| Serialized workspace snapshot | 1,800,000 UTF-8 bytes |
| Locations per snapshot | 1,000 |
| Items per snapshot | 4,000 |
| Plans per snapshot | 250 |
| Plan steps per snapshot | 5,000 |
| Activities per snapshot | 10,000 |
| Activity patches per snapshot | 50,000 |
| Audit events per snapshot | 10,000 |

The snapshot byte limit leaves headroom beneath [D1's 2,000,000-byte maximum value and row size](https://developers.cloudflare.com/d1/platform/limits/) because a workspace is stored as one JSON value. Initial sync and owner restore reject an oversized snapshot before persistence. During replay, a command that would cross a live-record limit receives a rejected receipt while earlier valid commands in the batch may still commit. A snapshot that already exceeds a newly introduced limit may stay level or shrink, but no command may increase an over-limit live-record dimension.

Activity, patch, audit, receipt, and byte limits use deterministic bounded retention instead of refusing an otherwise valid command merely because the command records history. Stowplan protects the activity or audit event created by the accepted command, removes the oldest audit detail before the oldest undoable activities when bytes are tight, and records pruned command IDs in a compact receipt ledger. That ledger retains the newest 20,000 pruned IDs in addition to IDs still represented by full activity and audit records, so retries across the normal replay window remain idempotent. A full receipt ledger expires its oldest ID first. Byte pressure removes the oldest compact receipts only after removable full history has been compacted, and always preserves the newest compact receipt. Once a full activity ages out, that change is no longer available for undo or reapply. An extreme snapshot whose live records alone consume the byte ceiling can still reject a mutation whose protected current undo record cannot fit; initial sync and restore surface the byte quota before that state is persisted.

Workspace ownership, guest-link creation, and guest redemption enforce their limits inside conditional SQL writes. That keeps concurrent attempts from both taking the final slot. A failed initial owner claim also removes the newly created unclaimed snapshot.

Device-only workspaces do not consume server ownership quota. If an authenticated user creates more local workspaces than the server will accept, those replicas remain available on that device and surface the quota response instead of being silently deleted or partially claimed.

Hard quota responses use:

```json
{
  "error": "This workspace has reached its member limit",
  "code": "QUOTA_EXCEEDED",
  "quota": "membersPerWorkspace",
  "limit": 100,
  "actual": 101
}
```

State and account quotas return `409`; oversized request batches and snapshots return `413`. Command-produced snapshot overages stay inside the normal `200` sync response as a rejected receipt carrying the same `code`, `quota`, `limit`, and `actual` fields. Hard quotas do not use `429`, which is reserved for rate limiting.
