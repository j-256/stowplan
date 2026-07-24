# Docker and Podman

Build the included image:

```bash
docker build -t stowplan:1.0.0 .
docker volume create stowplan-data
docker run --name stowplan --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v stowplan-data:/data \
  -e AUTH_BASE_URL=https://stowplan.example.com \
  -e AUTH_ADMIN_EMAILS=owner@example.com \
  stowplan:1.0.0
```

Pass provider secrets with your orchestrator's secret mechanism, not `-e SECRET=value` in shared shell history. Put an HTTPS reverse proxy in front.

Podman uses equivalent commands:

```bash
podman build -t stowplan:1.0.0 .
podman volume create stowplan-data
podman run --name stowplan -p 127.0.0.1:3000:3000 \
  -v stowplan-data:/data:Z --env-file /secure/stowplan.env stowplan:1.0.0
```

For a managed host, follow the separate [Fly.io](/deploy/fly-io), [Railway](/deploy/railway), or [Render](/deploy/render) recipe. Do not use an ephemeral filesystem: redeploying would discard server backups, users, and sessions. SQLite deployments must remain a single application replica unless you deliberately add a replication layer and its operational guarantees.
