# Docker and Podman

Build the included image:

```bash
docker build -t stowplan:1.0.0 .
docker volume create stowplan-data
docker run --name stowplan --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v stowplan-data:/data \
  -e AUTH_BASE_URL=https://stowplan.example.com \
  --env-file /secure/stowplan.env \
  stowplan:1.0.0
```

The protected environment file or orchestrator secret set must provide `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_TURNSTILE_SITE_KEY`, `AUTH_TURNSTILE_SECRET_KEY`, and a durable `AUTH_IDENTITY_DIGEST_KEY` of at least 32 bytes. Public Google registration is available only when the complete Google, Turnstile, digest-key, and exact `AUTH_BASE_URL` configuration is present. Register `/api/auth/google/callback` at that exact origin and restrict the production Turnstile widget to its hostname.

Pass provider secrets with your orchestrator's secret mechanism, not `-e SECRET=value` in shared shell history. Keep the identity digest key stable and backed up with the database recovery material. Put an HTTPS reverse proxy in front.

Podman uses equivalent commands:

```bash
podman build -t stowplan:1.0.0 .
podman volume create stowplan-data
podman run --name stowplan -p 127.0.0.1:3000:3000 \
  -v stowplan-data:/data:Z --env-file /secure/stowplan.env stowplan:1.0.0
```

For the reference admin posture, proxy the public hostname through Cloudflare and protect only `/admin`, `/admin/*`, `/api/admin`, and `/api/admin/*` with the admin Access application. Set `AUTH_ADMIN_REQUIRE_ACCESS=true`, `AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN`, and `AUTH_CLOUDFLARE_ACCESS_AUD`. Access is not an ordinary-account provider and never creates database authority. Use a temporary `AUTH_ADMIN_RECOVERY_TOKEN` at `/admin/recovery` for first bootstrap or lockout recovery, remove it after use, and keep two independently recoverable database administrators.

For a managed host, follow the separate [Fly.io](/deploy/fly-io), [Railway](/deploy/railway), or [Render](/deploy/render) recipe. Do not use an ephemeral filesystem: redeploying would discard server backups, users, and sessions. SQLite deployments must remain a single application replica unless you deliberately add a replication layer and its operational guarantees.
