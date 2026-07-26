# Configuration reference

| Variable/binding | Required | Scope | Meaning |
|---|---:|---|---|
| `DB` | Cloudflare | server binding | D1 database |
| `STOWPLAN_SQLITE_PATH` | Node | server | Persistent SQLite file |
| `AUTH_BASE_URL` | production | server | Exact public origin used for callbacks, trusted-origin checks, and Turnstile hostname validation |
| `AUTH_ACCESS_MIGRATION_ENABLED` | no | server | `true` temporarily enables the existing-identity-only Cloudflare Access session exchange; keep false outside a bounded migration window |
| `AUTH_ADMIN_RECOVERY_TOKEN` | bootstrap/recovery only | server secret | Temporary high-entropy break-glass token of 43 through 256 characters without ASCII whitespace or controls |
| `AUTH_ADMIN_REQUIRE_ACCESS` | no | server | `true` requires a verified Access assertion matching a linked verified Google email on normal admin APIs, with canonical-email fallback only for a legacy account without Google, and a verified assertion without email matching on recovery |
| `AUTH_IDENTITY_DIGEST_KEY` | authentication | durable server secret | Stable key of at least 32 UTF-8 bytes for identity enforcement, deletion receipts, and recovery audit digests |
| `AUTH_SESSION_TTL_SECONDS` | no | server | App session TTL; default 30 days, clamped from 1 hour to 90 days |
| `AUTH_GOOGLE_CLIENT_ID` | public sign-in | server secret | Google Web application client ID |
| `AUTH_GOOGLE_CLIENT_SECRET` | public sign-in | server secret | Google Web application client secret |
| `AUTH_TURNSTILE_SITE_KEY` | public sign-in | server/client config | Managed Turnstile site key returned by `/api/auth/me`; production widgets must restrict the exact public hostname |
| `AUTH_TURNSTILE_SECRET_KEY` | public sign-in | server secret | Turnstile Siteverify secret paired with the site key |
| `AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Access admin gate or migration | server config | Access team hostname such as `team.cloudflareaccess.com` |
| `AUTH_CLOUDFLARE_ACCESS_AUD` | Access admin gate or migration | server secret | Audience of the Access application protecting the admin routes |
| `AUTH_DEV_ENABLED` | isolated development only | server | `true` enables the synthetic development provider only when every relevant hostname passes the isolation guard |
| `AUTH_DEV_ALLOWED_HOSTS` | isolated development only | server | Optional comma-separated extra hostnames for development authentication; the production hostname remains forbidden |
| `NEXT_PUBLIC_REPOSITORY_URL` | no | build/client | Quiet Help/About source link for forks |
| `NEXT_PUBLIC_DOCS_URL` | no | build/client | Independently hosted full documentation link |
| `DOCS_BASE` | docs build | build | `/repo/` for project Pages, `/` for root hosts |
| `DOCS_REPOSITORY_URL` | no | docs build | Source link; the Pages workflow derives it for forks |

Commit only `.env.example`-style names and harmless defaults. OAuth secrets, session values, guest URLs, Access assertions, and exported production data are secrets.

Global admin authority is stored only in `users.global_role`. `AUTH_ADMIN_EMAILS` is retired, is not read by the application, and must not be retained as a bootstrap or ongoing authority mechanism. Ordinary authentication, an Access allow decision, and workspace membership do not promote an account.

Public Google discovery requires the Google client pair, both Turnstile keys, and a valid `AUTH_IDENTITY_DIGEST_KEY`. A partial configuration fails closed and does not advertise Google through `/api/auth/me`. The launch does not support GitHub as an ordinary sign-in provider. Do not install GitHub OAuth credentials or callbacks for production.

Set `AUTH_BASE_URL` to the exact externally visible origin with no path or trailing slash. For the production origin `https://stowplan.jklein.dev`, Google's callback is `https://stowplan.jklein.dev/api/auth/google/callback`. The same base controls OAuth callbacks, same-origin mutation checks, and the hostname expected in a production Turnstile result.

Keep `AUTH_IDENTITY_DIGEST_KEY` durable and identical for every runtime instance that shares a database. Back it up separately from deploy artifacts. The application has no multi-key transition window, so replacing the key without a planned digest migration prevents new identity and recovery-principal digests from matching rows created with the previous key.

Set `AUTH_ADMIN_RECOVERY_TOKEN` only for a controlled bootstrap or lockout recovery window. Sign in to the target app account, use `/admin/recovery`, confirm normal admin access and the `admin.recover` audit, then remove or rotate the token immediately. Recovery promotes only that app account, retains the exact recovery session, and revokes every other active session belonging to every database global admin. The environment secret remains reusable until an operator removes or replaces it. With `AUTH_ADMIN_REQUIRE_ACCESS=true`, recovery also requires a valid Access assertion but deliberately permits the Access principal and app account emails to differ. Normal admin requests require the Access email to match one of the account's linked verified Google identities whenever any are linked; only a legacy account with no linked Google identity may fall back to its canonical email. With the setting false, recovery uses the app session and token without Access.

Keep `AUTH_ACCESS_MIGRATION_ENABLED=false` for normal operation. A temporary `true` enables `POST /api/auth/access` only for a Cloudflare Access subject that is already linked to an existing Stowplan account. The exchange cannot create an account or link by email. It issues a session with a fixed two-hour maximum lifetime and `cloudflare-access` provenance. Verify direct Google sign-in for every account that needs migration recovery, return the flag to false, bulk-revoke all active pre-Google sessions, and verify the admin inventory's `active pre-Google` count is zero before removing Access from ordinary account routes. The pre-Google scope includes both marked Access migration sessions and legacy active sessions created before provenance recording.

`AUTH_DEV_ENABLED=true` never overrides the hostname guard. Loopback names, `.localhost`, and reserved `.test` names are accepted; `AUTH_DEV_ALLOWED_HOSTS` can name an additional isolated test host. The production hostname is explicitly blocked even if it appears in that list. Development identities must use `@example.test`, and only `owner@example.test` may bootstrap the first administrator in an empty isolated database.

The database refuses any role or status change that would remove the final active, non-deleted global admin. Promoting or demoting an administrator revokes that target account's active sessions. Disabling an account atomically revokes its active sessions and active unused guest links, is refused for a final active workspace owner, and does not restore either resource when later enabled. Banning is available only after global-admin demotion, replaces raw profile and sign-in identity data with redacted state plus keyed enforcement digests, revokes active sessions and unused invite links, and remains disabled after a ban is lifted.

Sites reads its binding name from `.openai/hosting.json`; keep it aligned with the `DB` entry above. The production artifact must package the matching Drizzle SQL directory so a new D1 database can be initialized before collaborative routes receive traffic. Each database belongs to one deployment runtime and ledger: Sites applies the generated `drizzle/` migration stream, direct Wrangler applies the numbered `migrations/` stream through its D1 ledger, and Node applies the numbered stream through `stowplan_node_migrations`. The two streams provide the same runtime-required tables, columns, foreign keys, and named indexes while intentionally retaining different SQLite `STRICT`, collation, and inline-index representations. Both write a durable `stowplan_migration_stream` marker. The Node runtime preserves a legacy unmarked database only when `workspace_snapshots` is `STRICT`; it refuses Sites-marked, unmarked non-`STRICT`, and numbered-but-non-Node databases so ledgers cannot be mixed.

`cloudflare/access.json` and `cloudflare/edge-rules.json` contain portable desired state without account, zone, application, policy, identity-provider, or audience IDs. The reconciliation scripts discover those IDs through authenticated API reads.

The client receives only `NEXT_PUBLIC_*` values. Adding that prefix to a secret permanently exposes it in built JavaScript.
