# Administration

`/admin` is the installation-wide, server-enforced control plane. It is separate from workspace-owner self-service, and client-side navigation is not the security boundary.

Workspace owners manage routine member roles, ownership transfer, removal, and viewer/editor enrollment links from the workspace access surface without global admin scope. Editors and viewers cannot use that surface to manage access, and the final owner must transfer ownership or delete the server workspace instead of leaving. The legacy `/api/admin/guest-links` path follows the same owner-only policy despite its historical prefix.

Global admins can search users, linked provider identities, workspace memberships, sessions, single-use enrollment links, and auth audit events. The workspace overview names each workspace and shows member, invite-link, storage, location, item, plan, plan-step, activity, patch, history-audit, and compact-receipt usage against every enforced snapshot quota. Usage at 80 percent or more of a limit is highlighted for review. Bounded result sets say when more matches exist instead of silently appearing complete. The control plane can assign global admin scope, disable or enable users, unlink redundant identities, make explicit operator changes to workspace roles and memberships, and revoke sessions or invite links. Any email in `AUTH_ADMIN_EMAILS` receives admin scope. The first successfully created account receives admin scope only when no admin allowlist is configured.

The first admin overview response binds the page to the authenticated account. Later reads and every mutation must match that account before server data is read or changed. If another tab changes the shared session, reload the admin page instead of applying stale controls under the replacement account. Disabling a user is refused when it would leave any live workspace without an active owner, including under concurrent disable requests.

The database inventory section reports a fixed, bounded set of aggregate counts, lifecycle statuses, storage totals, retention timestamps, migration-stream state, and migration-ledger counts for the durable tables present in the active runtime. It covers workspace snapshots, deletion tombstones, users, identities, workspace memberships, sessions, `guest_links`, OAuth state rows, authentication audit rows, and the numbered, Node, D1, or Sites migration metadata that exists in that database. It never returns workspace inventory contents, record identifiers, raw invite URLs, token hashes, OAuth verifier ciphertext, provider assertions, provider subjects, audit details, user agents, or IP metadata. The aggregate view does not make a global admin a workspace member or create a path to open ordinary workspace data.

Global admin scope alone does not list, open, sync, restore, manage, leave, or delete a workspace through ordinary member APIs. An explicit global control-plane mutation can repair membership or revoke access, but it remains subject to final-owner and ownership-quota checks, advances the same membership and workspace-access revision triggers, and commits with a non-secret audit record. See the [workspace access API contract](/maintainers/api#access-mutations-and-concurrency).

For a single-owner installation, protect `/admin*` with Cloudflare Access as a second gate. Stowplan still verifies its own app session and admin role. Access alone does not grant workspace rights.

Stowplan refuses to remove or disable the final active administrator, demote/remove a workspace's final owner, or unlink a user's final sign-in identity. These invariants and ownership quotas are enforced inside conditional database mutations, including when requests race. Add and verify a replacement first. Stale, repeated, missing-target, tombstoned, and otherwise refused operations return a visible error and do not create a misleading audit record. Successful mutations are audited with actor, action, target, time, and non-secret details.

## Workspace access and deletion

Owners can create only `viewer` or `editor` enrollment links and must choose an expiry inside the server-advertised range. Each link can enroll one signed-in account. The raw URL is returned once; stored and listed records contain only a hash plus non-secret role, creation, expiry, and lifecycle status. Expiry controls whether enrollment can occur. Once a person accepts an invite, the resulting membership persists until that person leaves, an owner removes the membership, or the workspace is deleted. Only the confirmation `POST` consumes an invite link. Repeated revocation, expired links, used links, quota refusals, and member-capacity races are explicit failures rather than success messages.

`Remove from this device`, `Leave shared workspace`, and `Delete server workspace` are intentionally different operations. Device removal does not change membership or server state. Leaving removes only the caller's membership after the final-owner check and leaves local-replica disposition to the user. Server deletion requires owner role, the exact workspace name, and matching snapshot, access, and membership revisions.

Server deletion is immediate and has no server-side recovery window. Its transaction records a tombstone and audit event, revokes any retained legacy guest-only sessions, removes enrollment links and memberships, and deletes the snapshot. The tombstone prevents the stable workspace ID from being resurrected through sync, restore, role changes, or invitation redemption. Export the portable workspace backup before deletion. If any device has pending or blocked commands, export its full recovery bundle too. Those files retain user-held data but do not provide an undelete operation for the removed server workspace.

## Test the control panel locally

The shortest complete test uses the Node + SQLite adapter. It exercises the same authentication, authorization, admin routes, and SQL repositories as the Cloudflare deployment without requiring OAuth credentials.

```bash
npm ci
npm run build:next
AUTH_BASE_URL="http://localhost:3000" \
AUTH_ADMIN_EMAILS="owner@example.test" \
AUTH_DEV_ENABLED="true" \
STOWPLAN_SQLITE_PATH="$PWD/data/admin-test.sqlite" \
npm run start:node
```

Open `http://localhost:3000/account?returnTo=/admin`, use the **Local development sign-in** form with `owner@example.test`, and Stowplan will return you to `/admin`. The allowlisted email becomes an administrator. Keep `AUTH_DEV_ENABLED` unset on every public server.

The Sites-style local preview binds D1, listens on the loopback interface, and enables the same immediate development sign-in only while `npm run dev` is serving. Open `http://localhost:5173/account?returnTo=/admin`; no email or one-time code is sent. The default local administrator is `owner@example.test`. To use another address deterministically, set `AUTH_ADMIN_EMAILS` before starting the server. Restart the development server after changing Vite configuration or authentication variables.

To exercise the separate OpenNext development path backed by local D1, copy `.dev.vars.example` to `.dev.vars`, then run:

```bash
npx wrangler d1 migrations apply stowplan --config wrangler.jsonc
npm run dev:next
```

`next.config.ts` initializes OpenNext's development bindings, so `getCloudflareContext()` can see the local D1 database. Use `npm run dev` for the Sites preview path and `npm run dev:next` for the OpenNext path; both expose development sign-in locally, but neither enables it in a production build.

The production Sites project declares a Sites-managed D1 binding named `DB`; it does not depend on a separate D1 or KV namespace in the operator's Cloudflare account. The artifact packages the Drizzle migrations needed for workspace snapshots, identities, sessions, memberships, one-time invite records, OAuth state, and audit events. A Sites version must include both `.openai/hosting.json` and the generated SQL under `.openai/drizzle`; the artifact validator rejects a D1 declaration without a packaged migration. Configure provider secrets before testing public sign-in. Node + SQLite and the local Cloudflare D1 adapter remain the fastest ways to exercise admin flows with development sign-in.
