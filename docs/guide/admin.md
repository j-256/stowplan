# Administration

`/admin` is a server-enforced control plane. Client-side navigation is not the security boundary.

Admins can inspect users, linked provider identities, workspace memberships, sessions, guest links, and auth audit events. The control plane can assign global admin scope, disable or enable users, unlink redundant identities, change/remove workspace roles, and revoke sessions or links. The first successfully created account—or any email in `AUTH_ADMIN_EMAILS`—receives admin scope.

For a single-owner installation, protect `/admin*` with Cloudflare Access as a second gate. Stowplan still verifies its own app session and admin role. Access alone does not grant workspace rights.

Stowplan refuses to remove or disable the final active administrator, demote/remove a workspace’s final owner, or unlink a user’s final sign-in identity. Add and verify a replacement first. All mutations are audited with actor, action, target, time, and non-secret details.

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

For a Next.js development server backed by local D1, copy `.dev.vars.example` to `.dev.vars`, then run:

```bash
npx wrangler d1 migrations apply stowplan --local --config wrangler.jsonc
npm run dev:next
```

`next.config.ts` initializes OpenNext’s development bindings, so `getCloudflareContext()` can see the local D1 database. `npm run dev` is the separate Sites agent-preview adapter; use `npm run dev:next` when testing Worker bindings and admin routes.

The owner-only `chatgpt.site` checkpoint is a client showcase and has no D1 binding. Its organizer remains fully local-first, but its `/admin` route deliberately reports that server storage is not configured. Test admin with Node + SQLite or a Cloudflare + D1 deployment.
