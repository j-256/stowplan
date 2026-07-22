# Node 24 + SQLite

This reference composition root uses Node’s built-in `node:sqlite`, the same migration, and a D1-compatible SQL wrapper. It requires a persistent writable path.

```bash
nvm install 24.18.0
nvm use 24.18.0
npm ci
npm run build:next
STOWPLAN_SQLITE_PATH="$PWD/data/stowplan.sqlite" \
AUTH_BASE_URL="http://localhost:3000" \
AUTH_DEV_ENABLED="true" \
npm run start:node
```

For production, use HTTPS at the reverse proxy, remove `AUTH_DEV_ENABLED`, set provider secrets in the service manager, and set:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
STOWPLAN_SQLITE_PATH=/persistent/stowplan.sqlite
AUTH_BASE_URL=https://stowplan.example.com
AUTH_ADMIN_EMAILS=owner@example.com
```

The server applies the initial migration only to an empty database. Future numbered migrations must run during an explicit upgrade step before the new process starts.

## Backup

Stop writes or use SQLite’s online backup facility. At minimum, copy the database plus `-wal`/`-shm` files together while stopped. Test restore into a separate path and run the smoke checks before replacing production.

Health check: `GET /api/health`. Terminate the process gracefully through your service manager; do not expose port 3000 directly to the public internet.
