# Node 24 + SQLite

This reference composition root uses Node's built-in `node:sqlite`, the same migration, and a D1-compatible SQL wrapper. It requires a persistent writable path.

## Local development

```bash
nvm install 24.18.1
nvm use 24.18.1
npm ci
npm run build:next
STOWPLAN_SQLITE_PATH="$PWD/data/stowplan.sqlite" \
AUTH_BASE_URL="http://localhost:3000" \
AUTH_DEV_ENABLED="true" \
AUTH_IDENTITY_DIGEST_KEY="stowplan-local-identity-digest-key-not-for-production" \
npm run start:node
```

To exercise the full control plane, visit `http://localhost:3000/account?returnTo=/admin` and use the local development form with `owner@example.test`. That one synthetic development persona bootstraps the first local database administrator only while the development provider is enabled. Additional personas must use `@example.test`; they receive ordinary accounts and the same quotas and workspace authorization as other users. The automated equivalent is `npm run test:node-smoke`, which signs in, claims a workspace, enrolls a guest persona, and reads `/api/admin/overview` against a temporary SQLite database.

Never enable the development provider on a public origin. It is refused outside loopback, reserved `.test` hosts, or explicit `AUTH_DEV_ALLOWED_HOSTS`, and the reference production origin remains hard-blocked even if that list is misconfigured.

## Production authentication

For production, use HTTPS at the reverse proxy, remove `AUTH_DEV_ENABLED`, create a Google web OAuth client and Managed Turnstile widget for the exact public hostname, and set:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
STOWPLAN_SQLITE_PATH=/persistent/stowplan.sqlite
AUTH_BASE_URL=https://stowplan.example.com
AUTH_GOOGLE_CLIENT_ID=<secret>
AUTH_GOOGLE_CLIENT_SECRET=<secret>
AUTH_TURNSTILE_SITE_KEY=<public site key>
AUTH_TURNSTILE_SECRET_KEY=<secret>
AUTH_IDENTITY_DIGEST_KEY=<durable secret of at least 32 bytes>
AUTH_ACCESS_MIGRATION_ENABLED=false
```

Register `https://stowplan.example.com/api/auth/google/callback` exactly. Google is the ordinary-account provider and signup is public. Turnstile validates every Google OAuth initiation before the server allocates OAuth state. Keep `AUTH_IDENTITY_DIGEST_KEY` stable for the life of the database and back it up separately from deploy artifacts.

The recommended production admin perimeter is Cloudflare Access on a proxied custom hostname. Protect only `/admin`, `/admin/*`, `/api/admin`, and `/api/admin/*`, then add:

```text
AUTH_ADMIN_REQUIRE_ACCESS=true
AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN=<team domain>
AUTH_CLOUDFLARE_ACCESS_AUD=<admin application audience>
```

Normal admin requests then require the active Stowplan session to belong to a database global admin and to match the independently verified Access identity. A host that is not behind Access may leave `AUTH_ADMIN_REQUIRE_ACCESS=false`, but that removes the independent admin perimeter and is not the reference production posture.

Global-admin authority lives only in the database. For first bootstrap or lockout recovery, install a temporary high-entropy `AUTH_ADMIN_RECOVERY_TOKEN`, sign in to the intended ordinary app account, visit `/admin/recovery`, complete the configured Access gate when required, and enter the token. Recovery promotes only that account, retains the exact recovery session to avoid quota-related lockout, revokes every other active session belonging to every database global admin, and records a redacted audit event. Verify `/admin` and the audit through that retained session, remove the token immediately, confirm direct Google sign-in remains available, and maintain a second independently recoverable administrator. The database refuses demotion, disable, deletion, or direct removal of the final active administrator.

On startup, the server creates or reads the numbered migration ledger and applies every pending numbered migration in order, with each migration in its own transaction, before serving requests. Treat a release with pending migrations as an explicit upgrade window: stop writes, make and test a restorable SQLite backup including the `-wal` and `-shm` files when present, deploy one instance, let startup finish the migrations, and run health and smoke checks before restoring traffic. Do not mix the Node numbered migration ledger with the Sites Drizzle stream.

## Backup

Stop writes or use SQLite's online backup facility. At minimum, copy the database plus `-wal`/`-shm` files together while stopped. Test restore into a separate path and run the smoke checks before replacing production.

Health check: `GET /api/health`. Terminate the process gracefully through your service manager; do not expose port 3000 directly to the public internet.
