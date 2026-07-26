# Railway

**Maturity:** compatible recipe. Railway detects the included Dockerfile; Stowplan stores server data in a mounted SQLite volume.

## CLI-assisted path

Install the current Railway CLI, authenticate, initialize a project, and upload the repository:

```bash
npm install --global @railway/cli
railway login
railway init
railway up
```

The first deployment can start before persistence is attached; do not enter real inventory yet. In the project canvas, attach a Volume to the service with mount path `/data`, then set:

```text
HOST=0.0.0.0
PORT=3000
STOWPLAN_SQLITE_PATH=/data/stowplan.sqlite
AUTH_BASE_URL=https://YOUR_RAILWAY_DOMAIN
AUTH_GOOGLE_CLIENT_ID=<secret>
AUTH_GOOGLE_CLIENT_SECRET=<secret>
AUTH_TURNSTILE_SITE_KEY=<public site key>
AUTH_TURNSTILE_SECRET_KEY=<secret>
AUTH_IDENTITY_DIGEST_KEY=<durable secret of at least 32 bytes>
AUTH_ACCESS_MIGRATION_ENABLED=false
```

Generate a public domain under **Service → Settings → Networking**, update `AUTH_BASE_URL` to that exact HTTPS origin, register its `/api/auth/google/callback`, and restrict the production Managed Turnstile widget to the exact hostname. Keep every secret in the Variables panel and keep `AUTH_IDENTITY_DIGEST_KEY` stable across deploys and restores. Redeploy and inspect:

```bash
railway up
railway logs
railway status
```

## UI path

Create a project from the GitHub repository, choose the Dockerfile deployment, attach one Volume at `/data`, add the environment variables, and generate a domain. The volume is mounted only at runtime, not during image build or pre-deploy commands, so database initialization belongs in Stowplan's start process as implemented.

Railway documents a 0.5 GB Volume default for Free/Trial as of 2026-07-22, but compute/network pricing and sleep behavior can change. Verify the current plan before relying on it. Keep a single service replica with this SQLite adapter.

Public Google signup creates an ordinary database user with no workspace authority. Managed Turnstile protects each OAuth initiation; it does not grant a role. To retain the independent admin gate, put a Cloudflare-proxied custom hostname in front of Railway, protect only the exact admin roots and descendants with the Stowplan Access application, and set `AUTH_ADMIN_REQUIRE_ACCESS=true`, `AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN`, and `AUTH_CLOUDFLARE_ACCESS_AUD`. Use a temporary `AUTH_ADMIN_RECOVERY_TOKEN` at `/admin/recovery` for first bootstrap or lockout recovery. Verify administration and the audit through the exact retained recovery session, remove the token immediately, confirm direct Google sign-in remains available, and keep two independently recoverable database administrators.

## Backup and rollback

Use Railway Volume backups when available for the plan, separately test a stopped SQLite copy, and back up the durable identity digest key. A service rollback changes code, not database state. Check health, Google plus Turnstile sign-in, guest enrollment, sync, admin gating, and recovery export after every restore.
