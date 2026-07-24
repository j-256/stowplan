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
AUTH_ADMIN_EMAILS=owner@example.com
```

Add provider credentials in the Variables panel. Generate a public domain under **Service → Settings → Networking**, update `AUTH_BASE_URL` to that exact HTTPS origin, and register its OAuth callback. Redeploy and inspect:

```bash
railway up
railway logs
railway status
```

## UI path

Create a project from the GitHub repository, choose the Dockerfile deployment, attach one Volume at `/data`, add the environment variables, and generate a domain. The volume is mounted only at runtime, not during image build or pre-deploy commands, so database initialization belongs in Stowplan's start process as implemented.

Railway documents a 0.5 GB Volume default for Free/Trial as of 2026-07-22, but compute/network pricing and sleep behavior can change. Verify the current plan before relying on it. Keep a single service replica with this SQLite adapter.

## Backup and rollback

Use Railway Volume backups when available for the plan, and separately test a stopped SQLite copy. A service rollback changes code, not database state. Check the health endpoint, login, sync, and recovery export after every restore.
