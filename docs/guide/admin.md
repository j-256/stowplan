# Administration

`/admin` is a server-enforced control plane. Client-side navigation is not the security boundary.

Admins can search users, linked provider identities, workspace memberships, sessions, guest links, and auth audit events. The workspace overview names each workspace and shows member, guest-link, storage, location, item, plan, plan-step, activity, patch, history-audit, and compact-receipt usage against every enforced snapshot quota. Usage at 80 percent or more of a limit is highlighted for review. Bounded result sets say when more matches exist instead of silently appearing complete. The control plane can assign global admin scope, disable or enable users, unlink redundant identities, change/remove workspace roles, and revoke sessions or links. Any email in `AUTH_ADMIN_EMAILS` receives admin scope. The first successfully created account receives admin scope only when no admin allowlist is configured.

For a single-owner installation, protect `/admin*` with Cloudflare Access as a second gate. Stowplan still verifies its own app session and admin role. Access alone does not grant workspace rights.

Stowplan refuses to remove or disable the final active administrator, demote/remove a workspace's final owner, or unlink a user's final sign-in identity. These invariants and ownership quotas are enforced inside conditional database mutations, including when requests race. Add and verify a replacement first. Stale, repeated, and otherwise refused operations return a visible error and do not create a misleading audit record. Successful mutations are audited with actor, action, target, time, and non-secret details.

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

The production Sites project declares a Sites-managed D1 binding named `DB`; it does not depend on a separate D1 or KV namespace in the operator's Cloudflare account. The artifact packages the Drizzle migrations needed for workspace snapshots, identities, sessions, memberships, guest links, OAuth state, and audit events. A Sites version must include both `.openai/hosting.json` and the generated SQL under `.openai/drizzle`; the artifact validator rejects a D1 declaration without a packaged migration. Configure provider secrets before testing public sign-in. Node + SQLite and the local Cloudflare D1 adapter remain the fastest ways to exercise admin flows with development sign-in.
