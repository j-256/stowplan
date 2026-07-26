# Fly.io

**Maturity:** compatible recipe, not part of the reference-tested Cloudflare path. The included Dockerfile and Node/SQLite adapter are used unchanged.

SQLite requires a Fly Volume and one application Machine. A Fly Volume belongs to one region and cannot be attached to several Machines concurrently; do not scale this recipe horizontally without first introducing and testing a SQLite replication layer.

## CLI path

Install `flyctl`, authenticate, and let Fly detect the Dockerfile without deploying yet:

```bash
fly auth login
fly launch --no-deploy
fly volumes create stowplan_data --size 1 --region YOUR_REGION
```

Add the volume and HTTP service to the generated `fly.toml`:

```toml
[env]
  HOST = "0.0.0.0"
  PORT = "3000"
  STOWPLAN_SQLITE_PATH = "/data/stowplan.sqlite"

[mounts]
  source = "stowplan_data"
  destination = "/data"

[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "stop"
  min_machines_running = 0

  [[http_service.checks]]
    method = "GET"
    path = "/api/health"
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"
```

Install secrets. Replace the origin and configure only providers you use:

```bash
fly secrets set \
  AUTH_BASE_URL=https://YOUR_APP.fly.dev \
  AUTH_GOOGLE_CLIENT_ID=YOUR_ID \
  AUTH_GOOGLE_CLIENT_SECRET=YOUR_SECRET \
  AUTH_TURNSTILE_SITE_KEY=YOUR_SITE_KEY \
  AUTH_TURNSTILE_SECRET_KEY=YOUR_TURNSTILE_SECRET \
  AUTH_IDENTITY_DIGEST_KEY=REPLACE_WITH_GENERATED_32_BYTE_VALUE
fly secrets list
fly deploy
fly status
fly logs
```

`fly secrets list` shows names, not values. Register `https://YOUR_APP.fly.dev/api/auth/google/callback` exactly and restrict the production Managed Turnstile widget to that hostname. Use an identity digest key of at least 32 bytes, keep it stable across deploys, and back it up with the database recovery material. The values shown above are placeholders; do not paste real secrets into shared shell history.

## Dashboard path

Create an app from the Git repository and Dockerfile, attach a volume named `stowplan_data` at `/data` in the app's region, set the variables above, keep one Machine, deploy, then configure the health check at `/api/health`.

Public Google signup creates an ordinary database account with no workspace membership. Turnstile checks each OAuth initiation but grants no authority. For the independent admin perimeter, route a Cloudflare-proxied custom hostname to Fly, protect only `/admin`, `/admin/*`, `/api/admin`, and `/api/admin/*`, and add `AUTH_ADMIN_REQUIRE_ACCESS=true`, `AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN`, and `AUTH_CLOUDFLARE_ACCESS_AUD`. Use a temporary `AUTH_ADMIN_RECOVERY_TOKEN` at `/admin/recovery` for first bootstrap or lockout recovery, remove it after use, and maintain two independently recoverable database administrators.

## Backup and rollback

Fly Volume snapshots are useful infrastructure recovery points, but still test an application-level SQLite backup and preserve the durable identity digest key. Check `fly volumes list`, `fly volumes snapshots list VOLUME_ID`, and `fly releases` before an upgrade. A code rollback does not automatically roll back the SQLite schema.

Current command shapes were checked against the official Fly Dockerfile, secrets, volume, and deploy documentation on 2026-07-22.
