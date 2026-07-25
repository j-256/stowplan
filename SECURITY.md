# Security policy

## Supported versions

Security fixes target the latest `1.x` release and `main`. Self-hosters should remain current and subscribe to releases and security advisories.

## Reporting

Use GitHub's private vulnerability reporting for `j-256/stowplan`. If that surface is unavailable, contact the maintainer privately through the security contact published on the GitHub profile. Do not open a public issue with exploit details, credentials, guest URLs, tokens, Access assertions, or production data.

Include affected version/commit, deployment adapter, impact, reproduction with synthetic data, and any suggested mitigation. You should receive acknowledgement within seven days; coordinated disclosure timing depends on severity and deployment impact.

## Operator responsibilities

Use HTTPS, keep provider secrets in a platform secret manager, set a deterministic admin allowlist, protect `/admin` with a second gate where possible, apply migrations explicitly, export and restore-test backups, revoke lost sessions/links, and never enable development auth in production.

At the hosting edge, rate-limit `/api/auth/*`, `/api/admin/*`, `/api/workspaces`, `/api/workspaces/*`, and guest-link redemption by source and, when the platform supports a safe session characteristic, authenticated session. Give `/api/sync` and `/api/snapshot` a higher burst allowance because reconnecting devices legitimately replay a batch, but cap sustained request rates and payload sizes. Do not cache authenticated API responses. Platform-neutral core code intentionally does not pretend to provide a globally consistent distributed rate limiter; operators should use Cloudflare WAF/rate limiting, a reverse proxy, or the equivalent control for their host.

Cloudflare operators should validate and plan `cloudflare/edge-rules.json` with `scripts/cloudflare-edge.sh` before applying the profile matching the zone plan. The Free plan cannot include a hostname in its single rate-rule expression, so the checked-in profile first skips the entire rate-limit phase for every host except `stowplan.jklein.dev`. This prevents Stowplan's path-only rule from affecting sibling traffic, but dedicates the zone's only rate-rule slot to Stowplan. The reconciler refuses the Free profile if unrelated zone rate rules exist. Free also cannot enforce request-body size through WAF, so Stowplan's server-side request limits remain authoritative. Higher profiles add a separate data-plane budget, and the Enterprise Advanced profile adds session and body-size controls aligned with the separate workspace-access and snapshot limits. The reconciler manages only `[stowplan]` rules and requires an explicit `--prune` before deleting stale managed rules.

Production releases fail CI when the runtime dependency tree has a high-severity advisory, and publish a production CycloneDX SBOM. Development servers and migration generators are not production services: run them against trusted source, bind them to localhost, and keep their transitive advisories under review until compatible upstream fixes exist.
