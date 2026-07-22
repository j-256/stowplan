# Render

**Maturity:** compatible recipe. Render can build the included Dockerfile and attach a persistent disk, but persistent disks are not available on free web services.

## Dashboard path

1. Create a **Web Service** from the Git repository and choose the Docker runtime.
2. Set the health check path to `/api/health`.
3. Add a persistent disk mounted at `/data`.
4. Set `STOWPLAN_SQLITE_PATH=/data/stowplan.sqlite`, `HOST=0.0.0.0`, `AUTH_BASE_URL` to the exact HTTPS service origin, `AUTH_ADMIN_EMAILS`, and provider credentials.
5. Deploy, register the provider callback, sign in, create one test record, wait for **Up to date**, and reload it.

Render supplies `PORT`; Stowplan reads it. Do not hard-code Render’s current default port.

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
      - key: AUTH_ADMIN_EMAILS
        sync: false
    disk:
      name: stowplan-data
      mountPath: /data
      sizeGB: 1
```

Keep OAuth secrets as `sync: false` and enter them in the dashboard. Validate a Blueprint with a current Render CLI (2.22.0 was current when this guide was verified; the official Blueprint command requires 2.7.0 or later):

```bash
render blueprints validate render.yaml
```

Render persistent disks support only a single attached service instance, which matches the SQLite adapter’s single-replica requirement. Render documents daily disk snapshots, but still perform and test an application-level backup before schema changes. A zero-downtime code deploy does not make a database migration reversible.

Current disk, health-check, Docker, Blueprint, and CLI behavior was checked against official Render documentation on 2026-07-22.
