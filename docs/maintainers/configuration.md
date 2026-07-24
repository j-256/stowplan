# Configuration reference

| Variable/binding | Required | Scope | Meaning |
|---|---:|---|---|
| `DB` | Cloudflare | server binding | D1 database |
| `STOWPLAN_SQLITE_PATH` | Node | server | Persistent SQLite file |
| `AUTH_BASE_URL` | production | server | Public origin used for callbacks |
| `AUTH_ADMIN_EMAILS` | recommended | server | Comma-separated bootstrap admin emails |
| `AUTH_ADMIN_REQUIRE_ACCESS` | no | server | `true` requires a matching verified Access assertion on admin APIs |
| `AUTH_SESSION_TTL_SECONDS` | no | server | App session TTL; default 30 days, clamped to 1 hour–90 days |
| `AUTH_GOOGLE_CLIENT_ID` | per provider | server secret | Google web client ID |
| `AUTH_GOOGLE_CLIENT_SECRET` | per provider | server secret | Google client secret |
| `AUTH_GITHUB_CLIENT_ID` | per provider | server secret | GitHub OAuth app client ID |
| `AUTH_GITHUB_CLIENT_SECRET` | per provider | server secret | GitHub OAuth app secret |
| `AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Access only | server secret/config | `team.cloudflareaccess.com` hostname |
| `AUTH_CLOUDFLARE_ACCESS_AUD` | Access only | server secret | Access application audience |
| `AUTH_DEV_ENABLED` | local only | server | Enables development provider; forbidden in production |
| `NEXT_PUBLIC_REPOSITORY_URL` | no | build/client | Quiet Help/About source link for forks |
| `NEXT_PUBLIC_DOCS_URL` | no | build/client | Independently hosted full documentation link |
| `DOCS_BASE` | docs build | build | `/repo/` for project Pages, `/` for root hosts |
| `DOCS_REPOSITORY_URL` | no | docs build | Source link; the Pages workflow derives it for forks |

Commit only `.env.example`-style names and harmless defaults. OAuth secrets, session values, guest URLs, Access assertions, and exported production data are secrets.

Sites reads its binding name from `.openai/hosting.json`; keep it aligned with the `DB` entry above. The production artifact must package the matching Drizzle SQL directory so a new D1 database can be initialized before collaborative routes receive traffic.

The client receives only `NEXT_PUBLIC_*` values. Adding that prefix to a secret permanently exposes it in built JavaScript.
