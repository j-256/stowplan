# Deployment targets

The domain, planner, command/history engine, sync protocol, and `SnapshotStore` contract are runtime-neutral. Each deployment supplies a composition root for SQL, environment values, static assets, and HTTP hosting.

| Target | Storage | Maturity | Free-tier posture |
|---|---|---|---|
| Cloudflare Workers + D1 | D1 | Reference-tested | Best-supported, scales to zero |
| Node 24 + SQLite | Node built-in SQLite | Reference-tested locally | Any persistent Node host or home server |
| Docker / Podman | SQLite volume | Reference recipe | Depends on host; no platform lock-in |
| [Fly.io](/deploy/fly-io) | SQLite Fly Volume | Compatible recipe | Single Machine; check current trial/pricing |
| [Railway](/deploy/railway) | SQLite Railway Volume | Compatible recipe | Volume available on free/trial; usage limits apply |
| [Render](/deploy/render) | SQLite persistent disk | Compatible recipe | Persistent disks require a paid service |

The documentation site is independent: GitHub Pages is canonical and costs no Worker requests; Cloudflare Pages or any static host is compatible.

Every deployment needs HTTPS in production because session cookies are `Secure`. Persist the database, set `AUTH_BASE_URL`, configure at least one identity adapter, and test `/api/health`, login, local capture, sync, export, and admin access before inviting users.
