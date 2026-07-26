# Render

**Maturity:** compatible recipe. Render can build the included Dockerfile and attach a persistent disk, but persistent disks are not available on free web services.

## Dashboard path

1. Create a **Web Service** from the Git repository and choose the Docker runtime.
2. Set the health check path to `/api/health`.
3. Add a persistent disk mounted at `/data`.
4. Set `STOWPLAN_SQLITE_PATH=/data/stowplan.sqlite`, `HOST=0.0.0.0`, `AUTH_BASE_URL` to the exact HTTPS service origin, the Google and Turnstile values, and a durable `AUTH_IDENTITY_DIGEST_KEY` of at least 32 bytes.
5. Register the exact `/api/auth/google/callback`, restrict the production Managed Turnstile widget to the service hostname, deploy, sign in, create one test record, wait for **Up to date**, and reload it.

Render supplies `PORT`; Stowplan reads it. Do not hard-code Render's current default port.

## Blueprint-assisted path

A minimal `render.yaml` shape is:

```yaml
services:
  - type: web
    name: stowplan
    runtime: docker
    dockerfilePath: ./Dockerfile
    dockerContext: .
    healthCheckPath: /api/health
    envVars:
      - key: HOST
        value: 0.0.0.0
      - key: STOWPLAN_SQLITE_PATH
        value: /data/stowplan.sqlite
      - key: AUTH_BASE_URL
        sync: false
      - key: AUTH_GOOGLE_CLIENT_ID
        sync: false
      - key: AUTH_GOOGLE_CLIENT_SECRET
        sync: false
      - key: AUTH_TURNSTILE_SITE_KEY
        sync: false
      - key: AUTH_TURNSTILE_SECRET_KEY
        sync: false
      - key: AUTH_IDENTITY_DIGEST_KEY
        sync: false
    disk:
      name: stowplan-data
      mountPath: /data
      sizeGB: 1
```

Keep authentication values as `sync: false` and enter them in the dashboard. The Turnstile site key is public, but keeping all deployment-specific values out of the Blueprint avoids accidental cross-environment reuse. Keep the identity digest key stable and back it up with the database recovery material. Validate a Blueprint with a current Render CLI (2.22.0 was current when this guide was verified; the official Blueprint command requires 2.7.0 or later):

```bash
render blueprints validate render.yaml
```

Render persistent disks support only a single attached service instance, which matches the SQLite adapter's single-replica requirement. Render documents daily disk snapshots, but still perform and test an application-level backup before schema changes. A zero-downtime code deploy does not make a database migration reversible.

Google signup creates only an ordinary Stowplan account. Managed Turnstile protects OAuth initiation and does not grant application authority. For the reference admin posture, route a Cloudflare-proxied custom hostname to Render, protect only the exact admin roots and descendants, and set `AUTH_ADMIN_REQUIRE_ACCESS=true`, `AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN`, and `AUTH_CLOUDFLARE_ACCESS_AUD`. Bootstrap or recover database administration with a temporary `AUTH_ADMIN_RECOVERY_TOKEN` through `/admin/recovery`, then remove it and confirm that two independently recoverable administrators can pass Access.

Current disk, health-check, Docker, Blueprint, and CLI behavior was checked against official Render documentation on 2026-07-22.
