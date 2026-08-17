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
| `/api/live/capability?workspaceId=…&connectionId=…` | GET | workspace member | Return an account-bound SSE endpoint, a short-lived signed WebSocket capability, or an unavailable result |
| `/api/live/events?workspaceId=…&connectionId=…` | GET | workspace member on the Node adapter | Hold one server-sent event stream for revision-only live hints |
| `/api/sync` | POST | workspace member | Initialize/claim, replay editor/owner commands, or pull with an empty viewer batch |
| `/api/snapshot?workspaceId=…` | GET | workspace member | Read authorized server copy for conflict recovery |
| `/api/snapshot` | PUT | workspace owner | Validated compare-and-swap backup restore |
| `/api/auth/me` | GET | optional | Session and provider configuration state |
| `/api/auth/sessions` | GET | active session | List every retained session belonging to the caller |
| `/api/auth/sessions/:sessionId` | DELETE | active session | Revoke one active session belonging to the caller |
| `/api/auth/google/start` | POST | Turnstile; active session for link/reauth intents | Begin a Google code + PKCE flow after same-origin browser verification |
| `/api/auth/google/callback` | GET | OAuth state + browser binding | Validate Google OIDC and complete sign-in, link, or reauthentication |
| `/api/auth/access` | POST | Access assertion + existing linked identity | Issue a two-hour, provenance-marked migration session only while the migration flag is enabled |
| `/api/auth/dev` | POST | isolated development mode | Issue a session for a synthetic `@example.test` persona; unavailable on the production hostname |
| `/guest#token=…&returnTo=…` | GET | none; fragment remains client-side | Show the fixed confirmation page without transmitting or consuming the enrollment token |
| `/api/auth/guest` | POST | active session + token in JSON body | Atomically enroll the signed-in account and return to the validated workspace view |
| `/guest/:token` | GET | legacy token path | Canonicalize a legacy invitation to the fixed fragment form before checking authentication |
| `/api/auth/guest/:token` | GET, POST | legacy token path | Redirect legacy previews and signed-out confirmations to the fragment form while preserving signed-in POST compatibility |
| `/api/auth/logout` | POST | session | Revoke current session and clear cookie |
| `/api/account/deletion` | GET, POST | active session; recent Google proof for POST | Review account-deletion blockers, then execute guarded deletion |
| `/api/admin/overview` | GET | global admin + Access when configured | Read bounded operational records and database drill-downs |
| `/api/admin/mutate` | POST | global admin + Access when configured | Role, status, access, revocation, and guest-record deletion operations |
| `/api/admin/recovery` | POST | active session + temporary recovery token (+ Access assertion when required) | Bootstrap or recover database global-admin authority while retaining the exact recovery session |
| `/api/admin/workspaces/:workspaceId` | POST, DELETE | global admin + Access when configured | Audit full-state inspection, take owner custody, or immediately delete a server workspace |

## Ordinary authentication and public signup

`GET /api/auth/me` returns `configured`, the active `user` or `null`, the ordinary provider IDs advertised to this request, the public Turnstile site key when Google is fully configured, and booleans describing the Access migration exchange, admin Access requirement, and whether the active account has a linked Google identity. The link-state boolean comes from a fixed account-scoped existence query and does not expose identity IDs, subjects, linked emails, or counts. Production provider discovery advertises only `google`. The isolated development provider appears only when `AUTH_DEV_ENABLED=true`, identity enforcement is configured, and every request and configured-base hostname passes the development guard.

`POST /api/auth/google/start` requires a trusted same-origin mutation, `Content-Type: application/x-www-form-urlencoded`, and a body no larger than 4 KiB. The body contains `cf-turnstile-response` and an `intent` of `sign-in`, `link`, or `reauthenticate`; `returnTo` remains a bounded query parameter. A sign-in request must contain exactly one `termsAccepted=true` and one `sessionPersistence` of `browser-session` or `persistent`. Link and reauthentication requests reject those sign-in-only fields. Every production intent requires a fresh Turnstile result whose expected action is `oauth_start` and whose hostname matches `AUTH_BASE_URL`. A complete pair of Cloudflare's official test credentials may return a placeholder hostname or omit the action only when both the request origin and configured base pass the isolated-host guard; Siteverify success and challenge freshness remain mandatory, and any known test credential disables Google on a public host. The server validates sign-in fields and performs Siteverify before allocating OAuth state, then returns a JSON `authorizationUrl` and installs a narrow browser-binding cookie. The client validates the returned Google origin before navigating.

The callback claims the state once, validates its browser binding, exchanges the code with an eight-second provider timeout, and validates Google's OIDC signature, issuer, audience, token time, nonce, stable subject, and verified-email claim. A sign-in issues an app session. A link intent requires the exact active app user and session plus recent proof from that account's existing sign-in method. If a first-link attempt lacks recent proof, the response tells the user to refresh that existing method; only an account with Google already linked is offered Google reauthentication before linking another. A reauthentication intent must use a Google subject already linked to that exact user and updates only that exact session's recent-proof timestamp. Neither linking nor reauthentication issues another app session.

Public signup has no email allowlist and no invitation admission requirement. A previously unseen Google subject can create an ordinary active account only when its verified email is not already assigned to another account and the installation-wide new-account circuit and daily allowance are open. The new account receives global role `user` and no workspace membership. Google email, Cloudflare Access, and successful Turnstile verification never grant global-admin or workspace authority.

Google OAuth is the only supported ordinary-account provider. Provider discovery and the OAuth exchange type are Google-only, so other dynamic provider routes return `404` before state allocation, token exchange, or profile retrieval. Stored provider-domain identity and OAuth lifecycle fields remain generic so historical rows stay readable and governable. `POST /api/auth/access` is a bounded migration path, not ongoing crossover authentication: it returns `404` unless `AUTH_ACCESS_MIGRATION_ENABLED=true`, accepts only a verified Access subject already linked to an existing account, cannot create or link an account by email, and fixes the resulting session lifetime at two hours. Session rows record `google`, `development`, or `cloudflare-access` provenance for newly issued sessions; rows predating provenance remain `null`. Disable the exchange after affected accounts have linked and verified Google, bulk-revoke the active pre-Google scope containing both `cloudflare-access` and legacy `null` sessions, and verify the admin inventory's `active pre-Google` count is zero before removing Access from ordinary account routes. The Access assertion protecting `/admin*` and `/api/admin/*` remains an independent gate.

## Account sessions

`GET /api/auth/sessions` returns the caller's active current session separately from a page of other retained sessions. The page limit defaults to 25 and accepts integers from 1 through 50. Other sessions are ordered by creation time and stable session ID, newest first. The opaque cursor is bound to the authenticated user, so it cannot continue another account's traversal. The response exposes each non-secret session ID, active, expired, or revoked status, current-session flag, creation, expiry, revocation and approximate last-seen times, a sanitized browser user agent, and an anonymized IPv4 `/24` or IPv6 `/48` network prefix when available. It never exposes the cookie value or stored token hash.

The request requires `X-Stowplan-Account-Id` to match the active app session. `DELETE /api/auth/sessions/:sessionId` also requires a trusted mutation origin and accepts no body. Its conditional write can affect only a session owned by the caller. Another account's session uses the generic `404 NOT_FOUND_OR_INACCESSIBLE` response, while a repeated, expired, or otherwise inactive target returns a visible `409` refusal. Revoking the current session clears its cookie; `POST /api/auth/logout` remains an idempotent current-session revoke and cookie clear. Revoking another session does not delete that device's IndexedDB replicas or queued work.

Issuing a session, revoking it through Account, and signing out create non-secret authentication audit records only when the corresponding state change commits. Successful authenticated requests refresh session and user `last_seen_at` values no more often than approximately once every five minutes. That write throttle makes the timestamp useful for operational review without turning every request into a database write; it does not measure offline or device-only use.

## Account deletion

`GET /api/account/deletion` requires the active session and matching `X-Stowplan-Account-Id`. It returns the exact `accountRevision` and `membershipRevision`, status and global role, membership count, any custody transfers that can safely preserve shared workspaces, and typed blockers. A global admin must be demoted before deletion. The final active global admin, an inactive account, a final workspace owner, or custody that cannot be transferred within the recipient's workspace and storage limits blocks execution.

`POST /api/account/deletion` requires the same account binding, trusted mutation origin, JSON body, and a body within the control-request limit. The body must contain exactly `confirmation: "DELETE"`, `expectedAccountRevision`, and `expectedMembershipRevision`. The active session must carry sign-in or explicit Google reauthentication proof no more than ten minutes old. A stale review returns `409 ACCESS_STALE`; unresolved authority or custody returns `409 ACCOUNT_DELETION_BLOCKED`; missing recent proof returns `403 REAUTHENTICATION_REQUIRED`.

The deletion transaction rechecks every blocker and revision, transfers safe workspace custody, revokes active sessions and unused links, removes direct sign-in identities and memberships, scrubs the profile and retained session metadata, pseudonymizes exact and workspace-qualified audit references, and writes a minimal keyed deletion receipt. It clears the current session cookie. Device replicas, pending commands, blocked commands, and exported backups remain separate local-first data; the user must export, keep read-only, or remove each device copy explicitly.

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

## Global administration

Global-admin authority comes only from the database `users.global_role` field. When `AUTH_ADMIN_REQUIRE_ACCESS=true`, every normal admin request additionally requires a verified Access assertion whose email matches one of the signed-in account's linked verified Google identities whenever any are linked. Only a legacy account with no linked Google identity may fall back to its canonical email. A Cloudflare Access identity row is not a direct sign-in identity and does not satisfy that match. Passing Access, authenticating with Google, and holding a workspace role never promote an account.

`GET /api/admin/overview` returns a fixed database inventory plus bounded, searchable detail arrays for every durable record family: workspace snapshots, deletion tombstones, users, linked identities, workspace memberships, sessions, guest links, OAuth states, authentication audit events, and the migration stream and ledgers present in the active adapter. Each list has an independent `listInfo` entry with its `limit`, `offset`, `hasMore`, and `nextOffset`. A continuation request names exactly one `resource` and its non-negative `offset`; every query has deterministic tie-breakers, and the UI exposes **Load more** for an incomplete section. Search remains inside this global-admin control plane.

Workspace overview rows expose the name and stable ID, snapshot and access revisions, timestamps, serialized size, quota-relevant record counts, member and owner counts, and retained and active link counts. Other detail rows expose operational IDs, display identity and email, roles and status, membership revisions, lifecycle timestamps, session authentication-provider provenance, user agents and anonymized network prefixes, link creation and redemption references, OAuth provider and lifecycle status, non-secret audit details, and migration records. A used guest-link row includes the accepting user's ID, display name, email, and acceptance time by correlating one deterministic `member.invite.accept` audit event whose action-aware detail allowlist contains the stable `guestLinkId`. Admin search covers that ID and accepting account, while raw tokens and token hashes remain excluded. Linked provider subjects may be returned as account-linking identifiers, but provider assertions are never returned.

`POST /api/admin/workspaces/:workspaceId` is an origin-protected, account-bound, body-limited control action. `{ "action": "inspect" }` reads the exact stored snapshot, validates and normalizes it with the runtime-neutral snapshot parser, rechecks active global-admin authority and the snapshot and access revisions before writing `workspace.inspect`, and then returns the complete state plus revision, timestamp, size, and operator-membership metadata. The audit contains only counts and revisions, never a second copy of the content. Inspection creates neither a membership nor an IndexedDB replica and does not change the active workspace. A failed validation, concurrent change, or audit failure returns no snapshot.

`{ "action": "takeOwnership", "expectedAccessRevision": n }` adds or promotes the administrator to a durable owner membership. It preserves every existing owner, enforces member and owned-workspace quotas, refuses a stale revision or no-op, advances normal access and membership counters through triggers, and writes `workspace.custody` atomically. Custody is the only control-plane bridge to workspace content mutation. Later edits use ordinary member routes, deterministic commands, field expectations, history, outbox durability, and sync authorization rather than raw snapshot replacement.

`DELETE /api/admin/workspaces/:workspaceId` accepts `confirmationName`, `expectedRevision`, and `expectedAccessRevision`. It lets an active global admin delete without first taking custody, but it rechecks all confirmation state and active admin authority in the deletion transaction. The response and retention semantics match owner deletion.

`POST /api/admin/mutate` supports explicit user role and status changes, identity unlinking, workspace role repair and member removal, individual session revocation, bulk pre-Google session revocation, guest-link revocation, and global-admin-only `guest.delete`. The `session.revoke-pre-google` action accepts only target ID `pre-google`, then revokes every active `cloudflare-access` migration session and every active legacy session whose provenance is `null`. It writes one audit event only when at least one session changes and reports and clears the operator's current cookie when that session was included. Disabling an active user, revoking all of that user's active sessions, and revoking every active unused guest link created by that user commit atomically; enabling the user does not revive any session or link. A lifted ban leaves its permanently redacted account disabled and non-enableable while permitting the external identity to register anew; re-banning that retained account reactivates every retained keyed identity digest. Revoking the administrator's current session also clears the installed cookie before the client returns to Account. `guest.delete` permanently removes one retained guest-link record and writes a non-secret audit record. When the link is active, the same conditional operation invalidates it before deletion. Deleting a used link record does not remove the membership created by redemption. Repeated and missing targets return a visible refusal rather than false success.

`POST /api/admin/recovery` is the bootstrap and lockout-recovery exception. It accepts no body, requires the exact account binding and a 43 through 256 character temporary secret in `X-Stowplan-Admin-Recovery`, and never discloses whether the server secret is configured. It requires an active app session. When `AUTH_ADMIN_REQUIRE_ACCESS=true`, it also requires a verified Access assertion but deliberately permits the Access and app emails to differ for this recovery request. A successful transaction promotes only the signed-in active account, retains that exact session, revokes every other active session for every database global admin, and writes `admin.recover` with a keyed principal digest and non-secret recovery mode. The environment token remains reusable until an operator removes or replaces it, so verify normal admin access and the audit event and then remove it immediately.

Permanent operator deletion covers retained guest-link records and live server workspaces. Sessions are revocable but remain available for review until cleanup, OAuth state rows are diagnostic, and deletion tombstones remain durable. Session rows become cleanup-eligible when their original expiry is at least 30 days old. OAuth PKCE verifiers and return paths are cleared when a state is claimed or when bounded authentication maintenance observes its expiry, and the remaining lifecycle row becomes eligible 24 hours after expiry. Guest-link rows become eligible 30 days after expiry unless a global admin deletes one earlier. Cleanup runs in bounded batches. Authentication audit events have no automatic expiry and remain indefinitely; orphan guest-account cleanup may null an actor reference without deleting the event.

Admin responses and audit details categorically exclude raw session credentials and hashes, raw guest credentials or URLs and hashes, OAuth state values and hashes, PKCE verifier material, OAuth return paths, OAuth codes and tokens, and provider or Cloudflare Access assertions. Audit writes preserve only the typed operational fields allowlisted for the specific action, and overview reads reapply the same action-aware allowlist to historical detail JSON. Unknown fields are counted but withheld, and malformed, scalar, array, or unknown-action details are never rendered verbatim. Operational IDs, account and workspace metadata, creator and redemption linkage, and provider subjects remain visible where the action schema permits them. The audited inspector exposes full workspace content through the control plane, while member-scoped endpoints continue to require an ordinary active membership.

## Guest-link lifecycle

Owners can create `viewer` or `editor` guest links with an integer expiry from 1 through 168 hours. Active-link and retained-link quotas are checked in the same conditional write as creation. Guest redemption also reserves the final member slot transactionally.

Creation returns the raw token and normalized URL once. Only its hash is stored. New URLs use `/guest#token=…&returnTo=…`; the browser fragment is absent from the HTTP request path, query string, `Referer`, and ordinary access logs. The fixed `/guest` client validates and normalizes the fragment, retains it only in same-tab session storage while Google sign-in is in progress, and gives OAuth only the credential-free `/account?resume=invitation` continuation. The fragment return path is bounded to 2,048 characters.

Only an explicit confirmation sends the token, in the JSON body of the origin-protected and 4 KiB-bounded `POST /api/auth/guest`. The request carries the expected account in both its body and `X-Stowplan-Account-Id`; authenticated errors retain that account context. The endpoint atomically attaches the durable membership to the signed-in account, writes the non-secret acceptance audit record, marks the link used, and returns a validated workspace route without creating or replacing a session. The browser uses replacement navigation when leaving for sign-in, returning to the invitation, and opening the accepted workspace so Back does not reveal a consumed credential.

Legacy `/guest/:token` pages canonicalize to `/guest#token=…` before making the authentication request. `GET /api/auth/guest/:token` and an unauthenticated legacy `POST` redirect to that fragment form, avoiding a second token-bearing request. An authenticated legacy form `POST` remains accepted for compatibility. Lists expose the non-secret link ID, role, creation time, expiry, and `active`, `used`, `expired`, or `revoked` status, never the raw token. The global-admin list also attributes a used link to the accepting account and time through the allowlisted acceptance audit detail; duplicate historical acceptance events cannot duplicate the guest-link row because correlation selects one event with deterministic ordering. Link expiry controls whether enrollment may occur; it does not expire the resulting membership. The membership persists until that member leaves, an owner removes it, or the workspace is deleted.

Only an active link can be revoked. A repeated or stale revocation returns a visible conflict rather than false success. Used, expired, and revoked records count toward the retained-link quota until cleanup becomes eligible after the retention period. Cleanup and server deletion remove records without exposing token hashes in audit details.

## Server workspace deletion

Server deletion is immediate. An ordinary caller must be an owner and provide the exact current workspace name plus the expected snapshot, access, and membership revisions. A global-admin control request provides the exact name plus snapshot and access revisions and rechecks active admin authority transactionally. Both paths write a non-secret tombstone and audit record, revoke any affected legacy guest-only sessions, delete guest links and memberships, and delete the server snapshot in one transaction. Concurrent sync, invitation redemption, role changes, and repeated deletion either complete before that transaction or fail against the tombstone and cannot resurrect the workspace ID.

The response reports `recovery: "not_available"` and requires a separate local-replica disposition. Stowplan stores no recoverable server snapshot for this operation. Export the portable workspace backup first, and export the full recovery bundle when pending or blocked commands exist. Those files preserve user-held data; they do not turn the deletion endpoint into an undelete service. Removing a replica from one device and leaving a membership are separate operations and never imply server deletion.

## Request, response, and error policy

Every response containing private workspace, membership, link, session, or administrative state sets `Cache-Control: no-store` and receives the normal application security headers. OAuth-start redirects carrying fresh one-time state are also uncached. OAuth return paths are limited to 2,048 characters, decoded until stable within a length-derived bound, and fail closed if malformed, cross-origin, unstable, or found to contain an invitation route at any layer. The service worker excludes `/api/`, and a successful background refresh does not need a user-facing toast.

Workspace access errors use a structured body with at least `code` and `error`; safe current access, member, quota, or confirmation details may be added when they help the caller recover. Malformed input returns `400 INVALID_REQUEST`, missing authentication returns `401 AUTHENTICATION_REQUIRED`, insufficient role returns `403`, and an inaccessible workspace or cross-workspace target returns a generic `404 NOT_FOUND_OR_INACCESSIBLE` without private data. Stale counters, no-ops, final-owner refusals, and quota conflicts return `409`; a caller-visible deletion tombstone returns `410 WORKSPACE_DELETED`; oversized bodies return `413 BODY_TOO_LARGE`; a non-JSON access mutation returns `415`; and missing storage returns `503 STORAGE_UNAVAILABLE`. Unexpected failures return a generic `500 INTERNAL_ERROR` without SQL, assertions, tokens, or another workspace's data.

Browser mutations require a trusted `Origin`, reject cross-site Fetch Metadata, and reject browser-shaped requests that omit `Origin`; non-browser clients without Fetch Metadata may omit `Origin` and still authenticate normally. Security headers apply a same-origin CSP, deny framing, restrict browser capabilities, and disable content-type sniffing. JSON bodies are streamed through a byte-counting parser rather than buffered without a limit. Invitation confirmations accept at most 4 KiB, workspace access mutations accept at most 32 KiB, sync and snapshot restore accept at most 8 MiB, and development sign-in plus remaining administrative control mutations accept at most 256 KiB. An oversized body returns before any state mutation. Dedicated guest-confirmation rate limits cover both the fixed and legacy API paths where the Cloudflare plan supports a separate rule.

## Live reconciliation

Live delivery is a wake-up path, not a second data protocol. The browser first calls the account-bound capability endpoint for the active server-backed workspace. The Node composition returns one long-lived same-origin SSE endpoint. A Cloudflare composition returns a short-lived HMAC capability in a WebSocket subprotocol and the browser connects directly to the relay Worker. Sites routes that Worker through the application origin's `/v1/*` path, while deployments whose CSP admits a separate relay may use its distinct origin. The capability binds the user, workspace, browser connection ID, application origin, snapshot revision, access revision, issuance time, and expiry. It is valid for at most one minute.

The relay and local SSE adapter send only protocol version, message type, snapshot revision, and access revision. Message types are `ready`, `change`, `access`, and `deleted`. They never carry commands, inventory, snapshots, member lists, session material, or guest credentials. Browser WebSocket messages are unsupported. A hint causes the client to call the ordinary authenticated `/api/sync` route with an empty batch when needed, so workspace authorization, field-aware reconciliation, and the authoritative snapshot stay on the existing path.

Every browser instance creates a non-secret connection ID and includes it as `X-Stowplan-Live-Connection-Id` on sync. A committed data notification suppresses that source connection while waking other connections. Access changes always reach every connection, update the relay's authoritative allowed-user set, and close removed users. Workspace deletion sends a final `deleted` hint and closes the room's sockets. Account disable, ban, deletion, ordinary membership changes, and global-admin access controls use the same notification boundary.

Clients coalesce adjacent hints, retain focus, visibility, online, and manual reconciliation fallbacks, and reconnect with equal-jitter exponential backoff capped at one minute. A connection must remain stable before the backoff resets, which prevents a flapping relay from producing a tight request loop. Idle WebSockets create no recurring HTTP requests. The Node SSE adapter may send response-stream comments to keep a proxy from buffering or closing the already-established response; those comments do not create new requests.

Notification publishing happens only after a primary mutation commits. Duplicate workspace impacts in one control operation are coalesced, relay publishing has a short timeout, and delivery failure never rolls back or misreports the durable mutation. Under normal connectivity, the client's bounded sync batch plus notification and authoritative pull target collaborator visibility within five seconds.

## Sync body

```json
{
  "workspaceId": "ws_…",
  "snapshot": { "schemaVersion": 2, "workspace": {} },
  "commands": [{ "id": "cmd_…", "baseRevision": 12, "expectations": [], "command": {} }]
}
```

The initial authenticated sync may include a fully validated local snapshot; the server creates it and assigns owner membership. A colliding workspace ID never grants membership to the second creator. Subsequent syncs require membership, and only editors/owners may submit commands. An empty member batch is an event-driven or lifecycle reconciliation pull, never a fixed-rate rapid poll. Before replay, the server replaces every command envelope's `actorId` with the authenticated user ID while preserving command IDs and order, so client-supplied attribution is never authoritative. The response contains the authoritative snapshot plus a receipt per command: `applied`, `duplicate`, or `rejected` with structured conflicts.

Owner restore validates the backup again, requires the caller's expected server revision, advances the restored revision, and uses the same persistence compare-and-swap as sync. A concurrent write returns `409` and leaves both versions unchanged.

Same-field stale edits reject. Unrelated stale edits can merge because expectations are field-specific. The client must retain rejected envelopes for user review and recovery export.

## Application quotas

`src/shared/quotas.js` is the commented source of truth for workspace limits and the guest-link expiry policy. `src/shared/governance-policy.ts` is the source of truth for public-launch account, session, identity, membership, allocation, and storage safeguards. Transport security ceilings, pagination and query bounds, retry timing, and presentation limits stay beside their enforcement because they are not application quotas.

| Resource | Limit |
|---|---:|
| Owned workspaces per account | 5 |
| Members per workspace | 25 |
| Active guest links per workspace | 10 |
| Retained guest links per workspace | 100 |
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

The public launch adds durable account and allocation safeguards:

| Scope | Limit or behavior |
|---|---:|
| New accounts per installation per UTC day | 25 by default; database-managed and adjustable by a global admin |
| Active sessions per account | 8; a new session revokes the oldest excess active session |
| Sessions issued per account per UTC day | 12 |
| Sessions issued per account per rolling 30 days | 60 |
| Retained terminal sessions per account | At most 32 and no longer than 30 days after terminal state |
| Linked direct sign-in identities per account | 5 |
| Workspace memberships per account | 25 |
| Aggregate stored snapshot bytes in account custody | 8,000,000 |
| Guest links created per account per UTC day | 10 |
| Guest links created per account per rolling 30 days | 50 |
| Server workspaces created per account per UTC day | 5 |
| Server workspaces created per account per rolling 30 days | 20 |
| Server workspaces created per account lifetime | 100 |

The daily new-account value is an installation fuse, not a permanent admission list. Changing it is an audited database mutation. Independent database-backed circuits cover `new_accounts`, `new_workspaces`, `snapshot_growth`, `guest_links`, and `guest_redemptions`. A capacity pause remains latched until an audited reopen. A security pause requires a bounded automatic resume time. Returning-account sign-in remains available when only new accounts are paused, existing workspaces remain readable when allocation or growth is paused, and local work and export remain available.

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
  "limit": 25,
  "actual": 26
}
```

Static capacity, membership, ownership, aggregate-storage, and lifetime-allocation conflicts return `409`. Oversized request batches and snapshots return `413`. Velocity safeguards return `429`, including new-account creation, session issuance, linked-identity allocation, and daily or rolling workspace and guest-link creation. Quota-limited authentication issuance and retriable sync responses include a quota-aware `Retry-After`: daily limits use the remaining seconds until the next UTC day, rolling session issuance and workspace allocation use the remaining seconds until enough counted events leave the 30-day window to admit one more allocation, simultaneous workspace velocity limits use the longer applicable floor, and other retriable refusals use a conservative fallback. A paused public-operation circuit returns `503 CIRCUIT_PAUSED`; automatic retry timing is provided only when the specific route has a safe server-held floor. Command-produced snapshot overages stay inside the normal `200` sync response as a rejected receipt carrying the same `code`, `quota`, `limit`, and `actual` fields. Cloudflare edge rate limiting can independently return `429` before a request reaches the application.
