# Cloudflare Workers + D1

This is the reference deployment. Run commands from the repository root. Wrangler commands that support both local and remote D1 target the local database when neither flag is present; every remote `execute`, `export`, or `migrations` example below uses `--remote`. Resource-management commands such as `d1 create`, `d1 list`, and `d1 info`, plus `d1 time-travel`, are remote-only commands and do not accept a `--remote` flag.

The production application is deployed through Sites, whose artifact contains `.openai/hosting.json` plus generated Drizzle migrations. The direct Wrangler instructions remain the self-hosted Cloudflare composition root. Each database belongs to one deployment runtime and migration ledger: Sites applies the generated `drizzle/` stream, direct Wrangler applies numbered files from `migrations/` through its D1 ledger, and Node applies those numbered files through its Node ledger. Both streams satisfy the same runtime compatibility contract for application tables, columns, foreign keys, and named indexes, but their physical SQLite representations intentionally differ because the numbered stream retains legacy `STRICT` tables and inline constraints. Each stream writes an explicit durable marker, and the Node runtime refuses a Sites marker, a numbered marker without its Node ledger, or an unmarked non-`STRICT` Stowplan schema. Never apply multiple streams or ledgers to one database binding.

## 1. Local bootstrap

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

`whoami` is read-only and safe to repeat. Keep Node at the version in `.nvmrc`.

## 2. Create D1 and bind it

```bash
npx wrangler d1 create stowplan
```

This creates a **remote** database and prints its UUID. Replace the all-zero `database_id` in `wrangler.jsonc` with that exact UUID. Do not create another database on retry; use:

```bash
npx wrangler d1 list
npx wrangler d1 info stowplan
```

## 3. Apply schema locally

```bash
npx wrangler d1 migrations list stowplan
npx wrangler d1 migrations apply stowplan
```

The apply command is safe to repeat; applied files are skipped. Start a production-like local Worker:

```bash
cp .dev.vars.example .dev.vars
npm run build:cloudflare
npx wrangler dev --config wrangler.jsonc
```

Open the printed localhost URL and verify `/api/health`. `.dev.vars` is ignored by Git and enables the explicit local development adapter; it does not create or change any remote secret. Delete `AUTH_DEV_ENABLED` from that file when testing a production provider. Never install that variable in production.

## 4. Install production configuration and secrets

Set non-secret `AUTH_BASE_URL` and `AUTH_ADMIN_EMAILS` in `wrangler.jsonc` under `vars`, or use secrets for privacy. Secrets are entered interactively and never echoed by Wrangler:

```bash
npx wrangler secret put AUTH_BASE_URL
npx wrangler secret put AUTH_ADMIN_EMAILS
npx wrangler secret put AUTH_GOOGLE_CLIENT_ID
npx wrangler secret put AUTH_GOOGLE_CLIENT_SECRET
npx wrangler secret put AUTH_GITHUB_CLIENT_ID
npx wrangler secret put AUTH_GITHUB_CLIENT_SECRET
```

Only configure providers you will use. For Access:

```bash
npx wrangler secret put AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN
npx wrangler secret put AUTH_CLOUDFLARE_ACCESS_AUD
npx wrangler secret put AUTH_ADMIN_REQUIRE_ACCESS
# enter true only when every admin request passes through Access
```

Inspect secret **names** (values remain hidden):

```bash
npx wrangler secret list
```

### Cloudflare Access identity and admin gate

Stowplan includes an idempotent Access reconciler and parameterized JSON configuration. It protects `/account*`, `/api/auth/access*`, `/admin*`, and `/api/admin/*` in one self-hosted application, leaving the rest of the local-first app public:

```bash
bash scripts/cloudflare-access.sh check
STOWPLAN_ACCESS_EMAILS=owner@example.com bash scripts/cloudflare-access.sh plan
STOWPLAN_ACCESS_EMAILS=owner@example.com bash scripts/cloudflare-access.sh apply
```

The apply command prints the resulting `AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN` and `AUTH_CLOUDFLARE_ACCESS_AUD` exports. Add them to the Sites runtime environment together with `AUTH_ADMIN_REQUIRE_ACCESS=true`, then save and deploy a new Sites version. A direct Wrangler deployment can store the same values with `wrangler secret put`. Keep actual allowlist addresses out of `cloudflare/access.json`; provide them through `STOWPLAN_ACCESS_EMAILS` or a private config passed with `--config`. The API token needs `Access: Apps and Policies Write` plus `Access: Organizations, Identity Providers, and Groups Read`.

### Edge rate limits and WAF rules

The edge reconciler owns only descriptions beginning with `[stowplan]` and preserves unrelated zone rules:

```bash
bash scripts/cloudflare-edge.sh check
bash scripts/cloudflare-edge.sh plan --profile free
bash scripts/cloudflare-edge.sh apply --profile free
```

Profiles in `cloudflare/edge-rules.json` reflect Cloudflare plan capabilities. Every profile includes member-scoped workspace discovery and access management in its source-based control-plane budget. The Free profile uses a host-aware custom skip rule before the zone's single path-only rate rule, so Stowplan's rule applies only to `stowplan.jklein.dev`. The skip bypasses the entire rate-limit phase on other hosts, which dedicates the zone's only rate-rule slot to Stowplan; the reconciler refuses this profile if unrelated zone rate rules exist. Pro adds a separate host-scoped data-plane allowance. Business separates sensitive paths and gives sync/snapshot a higher burst budget. The Enterprise Advanced profile also limits authenticated sessions, rejects duplicate application session cookies, and applies edge body-size rules aligned with the server's separate workspace-access and data limits. Cloudflare's API remains the final entitlement check because Enterprise contracts vary.

Use `plan --prune` to preview removal of stale `[stowplan]` rules after switching profiles, then `apply --prune` only after reviewing those deletions. A transition to Free prunes stale managed rate rules before creating its single allowed rule. A transition away from Free is refused without `--prune` so its phase-wide sibling-host skip cannot remain active. The script never deletes unrelated rules. Set `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with zone read and WAF edit permissions.

## 5. Back up, migrate remotely, deploy

For an existing installation, export before migration:

```bash
npx wrangler d1 export stowplan --remote --output stowplan-before-upgrade.sql
npx wrangler d1 time-travel info stowplan
```

Review pending migrations, then apply explicitly to remote D1:

```bash
npx wrangler d1 migrations list stowplan --remote
npx wrangler d1 migrations apply stowplan --remote
```

Run those commands only for a direct Wrangler database. For Sites, build and validate the production artifact:

```bash
npm run build
npm run validate:artifact
npm run archive:sites
```

`npm run build` requires GNU `timeout`, available as `timeout` on Linux and commonly installed through GNU coreutils on macOS. `npm run archive:sites` writes the validated, portable tar archive to `work/stowplan-sites.tar.gz` and excludes local environment and Finder metadata. Push the exact source commit used for that build to the Sites source repository, save a Sites version against that commit and archive, then deploy only the saved version. Sites applies the packaged Drizzle migration stream to its bound D1 database. Source push, environment updates, version saves, and deployments are connector-owned operations rather than public repository CLI commands.

For a direct Wrangler deployment, build and deploy:

```bash
NEXT_PUBLIC_REPOSITORY_URL=https://github.com/YOUR_ACCOUNT/stowplan \
NEXT_PUBLIC_DOCS_URL=https://YOUR_ACCOUNT.github.io/stowplan/ \
npm run build:cloudflare
npx wrangler deploy --config wrangler.jsonc
```

`NEXT_PUBLIC_*` values are compiled into browser assets; setting them only as Worker runtime variables is too late. The explicit config flag prevents another local build adapter from redirecting Wrangler. `wrangler deploy` creates a new Worker version; it does not apply D1 migrations automatically. Verify:

```bash
npx wrangler deployments list
npx wrangler tail --status error
```

In another terminal, request `https://YOUR_ORIGIN/api/health`, sign in, create one local item, wait for "Up to date," reload, and inspect `/admin`.

## Preview and production origins

OAuth callbacks must be registered per origin. Use separate provider clients for localhost, preview/custom staging, and production where the provider requires one callback. Set `AUTH_BASE_URL` to the externally visible origin; do not rely on a proxy's internal hostname.

## Backup, restore, and rollback

Record the current bookmark before risky operations:

```bash
npx wrangler d1 time-travel info stowplan
```

Restore is destructive and cancels in-flight queries; replace the example timestamp only after reviewing it:

```bash
npx wrangler d1 time-travel info stowplan --timestamp="2026-07-22T12:00:00Z"
npx wrangler d1 time-travel restore stowplan --timestamp="2026-07-22T12:00:00Z"
```

Wrangler prints a bookmark that can undo the restore. For Worker code rollback, inspect versions and roll back using the Cloudflare dashboard or the current Wrangler versions/deployments command supported by your account; never roll database state back merely because code was rolled back. Prefer forward-compatible migrations and a corrected deployment.

## Free-tier discipline

The 1.8-second debounce, eight-second maximum wait, foreground/online triggers, and five-minute reconciliation reduce Worker and D1 churn. Static assets are served separately; API responses are not cached. Monitor D1 rows/read/write usage and Worker requests in the dashboard before increasing reconciliation frequency.
