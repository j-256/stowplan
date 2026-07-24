# Cloudflare Access

Cloudflare Access can be an identity provider and a second gate for `/admin`.

## Repository automation

The checked-in configuration protects only the account identity exchange and administration surfaces. The rest of Stowplan remains public and local-first:

- `/account*`
- `/api/auth/access*`
- `/admin*`
- `/api/admin/*`

Validate locally, preview the remote diff, then apply it with an explicit email allowlist:

```bash
bash scripts/cloudflare-access.sh check
STOWPLAN_ACCESS_EMAILS=owner@example.com bash scripts/cloudflare-access.sh plan
STOWPLAN_ACCESS_EMAILS=owner@example.com bash scripts/cloudflare-access.sh apply
```

`check` needs no credentials, `plan` performs read-only API calls, and `apply` creates or updates the self-hosted application and its single Allow policy. The script discovers the account, One-time PIN identity provider, application ID, policy ID, audience, and team domain instead of committing opaque remote identifiers. You can also copy `cloudflare/access.json` to a private path, populate `policy.allowed_emails`, and pass it with `--config`.

The apply command prints shell exports for `AUTH_CLOUDFLARE_ACCESS_AUD` and `AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN`. Add those names and values to the Sites runtime environment, set `AUTH_ADMIN_REQUIRE_ACCESS=true`, save a Sites version, and deploy that saved version. The values identify the Access application and organization; the email allowlist stays in Cloudflare and must not be added to the checked-in template.

The API token needs `Access: Apps and Policies Write` plus `Access: Organizations, Identity Providers, and Groups Read`. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are read from the environment. Re-running apply is idempotent. The script refuses to reconcile an application containing unexpected policies so it cannot silently preserve a broader access path.

## Dashboard path

If automation is unavailable:

1. Open Zero Trust, then Access, Applications, and Add application.
2. Create one self-hosted application with all four paths above.
3. Select One-time PIN and enable automatic identity-provider redirect.
4. Create one Allow policy for the intended email identities.
5. Copy the application audience (`AUD`) and note the team domain, such as `team-name.cloudflareaccess.com`.

## CLI/API-assisted path

For a direct Wrangler deployment, store Stowplan's verification values interactively:

```bash
npx wrangler secret put AUTH_CLOUDFLARE_ACCESS_AUD
npx wrangler secret put AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN
```

To make the application itself require the Access assertion for every admin API request, rather than relying only on the edge path policy, set:

```bash
npx wrangler secret put AUTH_ADMIN_REQUIRE_ACCESS
# enter: true
```

When enabled, Stowplan requires all three conditions: an active app session, app-level `admin` scope, and a valid Access assertion whose email matches the app session. Leave it `false` when running outside Cloudflare or when the reverse proxy does not supply Access assertions.

The repository automation uses the Cloudflare API and resolves installation-specific IDs at runtime. Terraform remains a compatible alternative for operators who already manage their Cloudflare account that way.

Stowplan reads `Cf-Access-Jwt-Assertion`, fetches the team JWKS, and verifies signature, issuer, and audience. When an unauthenticated person opens Account behind Access, Stowplan exchanges the verified assertion for its own application session automatically. A valid Access assertion never bypasses Stowplan's own user status, app session, workspace role, or global admin role.
