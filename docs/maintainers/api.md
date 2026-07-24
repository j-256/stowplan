# API and sync protocol

All responses containing workspace or administrative data use `Cache-Control: no-store`. The service worker excludes `/api/`.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | none | Process/storage readiness |
| `/api/sync` | POST | workspace member | Initialize/claim, replay editor/owner commands, or pull with an empty viewer batch |
| `/api/snapshot?workspaceId=…` | GET | workspace member | Read authorized server copy for conflict recovery |
| `/api/snapshot` | PUT | workspace owner | Validated compare-and-swap backup restore |
| `/api/auth/me` | GET | optional | Session and provider configuration state |
| `/api/auth/:provider/start` | GET | none | Begin Google/GitHub code + PKCE flow |
| `/api/auth/:provider/callback` | GET | OAuth state | Exchange code and issue app session |
| `/api/auth/access` | POST | Access assertion | Issue app session after JWT verification |
| `/guest/:token` | GET | one-time token | Show the confirmation page without consuming the link or losing its workspace return path |
| `/api/auth/guest/:token` | POST | one-time token | Atomically consume the link, issue a short guest session, and return to the validated workspace view |
| `/api/auth/logout` | POST | session | Revoke current session and clear cookie |
| `/api/admin/overview` | GET | global admin (+ optional matching Access assertion) | Read users, sessions, links, audit |
| `/api/admin/mutate` | POST | global admin (+ optional matching Access assertion) | Role/status/revocation operations |
| `/api/admin/guest-links` | POST | workspace editor/admin | Create a one-time short link with an optional return path scoped to that workspace |

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

Browser mutations reject a mismatched `Origin`; non-browser clients that omit `Origin` still authenticate normally. Security headers apply a same-origin CSP, deny framing, restrict browser capabilities, and disable content-type sniffing. APIs with private state are never service-worker cached.

JSON bodies are streamed through a byte-counting parser rather than buffered without a limit. Sync and snapshot restore accept at most 8 MiB so a valid workspace can fit, while development sign-in and administrative control mutations accept at most 256 KiB. An oversized body returns `413` before any state mutation.

## Application quotas

`src/shared/api-quotas.ts` is the source of truth for these deliberately generous application limits:

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
