# Cloudflare Access

Cloudflare Access can be an identity provider and an optional second gate for `/admin`.

## Dashboard path

1. Zero Trust → Access → Applications → Add application → Self-hosted.
2. Add the Stowplan hostname. For an admin-only gate, add `/admin*` and `/api/admin/*` as separate path applications/policies.
3. Create an Allow policy for your identity/email/group.
4. Copy the application audience (`AUD`) and note the team domain, such as `team-name.cloudflareaccess.com`.

## CLI/API-assisted path

Authenticate Wrangler for account work, then store Stowplan’s verification values:

```bash
npx wrangler secret put AUTH_CLOUDFLARE_ACCESS_AUD
npx wrangler secret put AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN
```

To make the application itself require the Access assertion for every admin API request—not only rely on the edge path policy—set:

```bash
npx wrangler secret put AUTH_ADMIN_REQUIRE_ACCESS
# enter: true
```

When enabled, Stowplan requires all three conditions: an active app session, app-level `admin` scope, and a valid Access assertion whose email matches the app session. Leave it `false` when running outside Cloudflare or when the reverse proxy does not supply Access assertions.

Access application/policy creation can also use the Cloudflare API or Terraform provider. Because account IDs, zones, identity-provider IDs, and policy expressions are installation-specific, the dashboard remains the safest initial path; export managed configuration afterward if desired.

Stowplan reads `Cf-Access-Jwt-Assertion`, fetches the team JWKS, and verifies signature, issuer, and audience. When an unauthenticated person opens Account behind Access, Stowplan exchanges the verified assertion for its own application session automatically. A valid Access assertion never bypasses Stowplan’s own user status, app session, workspace role, or global admin role.
