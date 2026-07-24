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

The initial authenticated sync may include a fully validated local snapshot; the server creates it and assigns owner membership. A colliding workspace ID never grants membership to the second creator. Subsequent syncs require membership, and only editors/owners may submit commands. An empty member batch is a low-frequency pull reconciliation. The response contains the authoritative snapshot plus a receipt per command: `applied`, `duplicate`, or `rejected` with structured conflicts.

Owner restore validates the backup again, requires the caller’s expected server revision, advances the restored revision, and uses the same persistence compare-and-swap as sync. A concurrent write returns `409` and leaves both versions unchanged.

Same-field stale edits reject. Unrelated stale edits can merge because expectations are field-specific. The client must retain rejected envelopes for user review and recovery export.

Browser mutations reject a mismatched `Origin`; non-browser clients that omit `Origin` still authenticate normally. Security headers apply a same-origin CSP, deny framing, restrict browser capabilities, and disable content-type sniffing. APIs with private state are never service-worker cached.
