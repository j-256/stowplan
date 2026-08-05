# Cloudflare Workers + D1

This is the reference deployment. Run commands from the repository root. Wrangler commands that support both local and remote D1 target the local database when neither flag is present; every remote `execute`, `export`, or `migrations` example below uses `--remote`. Resource-management commands such as `d1 create`, `d1 list`, and `d1 info`, plus `d1 time-travel`, are remote-only commands and do not accept a `--remote` flag.

The production application is deployed through Sites, whose artifact contains `.openai/hosting.json` plus generated Drizzle migrations. The direct Wrangler instructions remain the self-hosted Cloudflare composition root. Each database belongs to one deployment runtime and migration ledger: Sites applies the generated `drizzle/` stream, direct Wrangler applies numbered files from `migrations/` through its D1 ledger, and Node applies those numbered files through its Node ledger. Both streams satisfy the same runtime compatibility contract for application tables, columns, foreign keys, and named indexes, but their physical SQLite representations intentionally differ because the numbered stream retains legacy `STRICT` tables and inline constraints. Each stream writes an explicit durable marker. Never apply multiple streams or ledgers to one database binding.

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

This creates a remote database and prints its UUID. Replace the all-zero `database_id` in `wrangler.jsonc` with that exact UUID. Do not create another database on retry; use:

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

Open the printed localhost URL and verify `/api/health`. `.dev.vars` is ignored by Git and enables the explicit local development adapter. It does not create or change a remote secret. Remove `AUTH_DEV_ENABLED` when testing Google and never install it in production. Local and CI personas use only `@example.test` identities and the documented Turnstile test pair.

## 4. Ordinary Google authentication

Google OIDC is the public ordinary-account provider. Managed Turnstile protects the same-origin POST that starts every Google OAuth transaction. Turnstile is an abuse check, not an identity or authorization source; passing it never grants a database role or workspace membership.

Create an External Google web application, publish it for production use, request only `openid`, `email`, and `profile`, and register the callback for the exact public origin:

```text
https://YOUR_ORIGIN/api/auth/google/callback
```

Create a Managed Turnstile widget restricted to the exact production hostname. Stowplan requires a production Siteverify response to carry that hostname and the `oauth_start` action. Use a complete pair of separate documented test credentials on loopback, `.test`, CI, and isolated test deployments. Cloudflare's dummy response can carry a placeholder hostname and omit the requested action, so Stowplan relaxes only those metadata checks for a complete official test-key pair behind the isolated-host guard while still requiring a successful, fresh Siteverify result. Any known test site or secret key makes the provider unavailable on a public host before Siteverify is called.

Install the runtime values through Sites environment management or, for a direct Worker, with Wrangler:

```bash
npx wrangler secret put AUTH_BASE_URL
npx wrangler secret put AUTH_GOOGLE_CLIENT_ID
npx wrangler secret put AUTH_GOOGLE_CLIENT_SECRET
npx wrangler secret put AUTH_TURNSTILE_SITE_KEY
npx wrangler secret put AUTH_TURNSTILE_SECRET_KEY
npx wrangler secret put AUTH_IDENTITY_DIGEST_KEY
```

The Turnstile site key is public and may instead be a non-secret runtime variable. `AUTH_IDENTITY_DIGEST_KEY` must be an independently generated secret of at least 32 bytes. Keep it stable for every runtime sharing the database and back it up separately from deploy artifacts. The application has no multi-key transition window, so casual rotation breaks matching for ban enforcement, deletion receipts, and recovery-principal audit digests.

The ordinary provider is advertised only when the complete Google, Turnstile, identity-digest, and base-URL configuration is present. An unknown verified Google subject creates an active `user` account with no workspace membership. Email is not an automatic account-linking key. Existing accounts connect Google through the explicit authenticated link flow.

See [Google sign-in and Turnstile setup](/auth/google) for provider validation and troubleshooting.

## 5. Admin-only Cloudflare Access

The existing self-hosted Access application is adopted and converted in place. It protects exactly:

```text
/admin
/admin/*
/api/admin
/api/admin/*
```

The exact roots and wildcard descendants are both required because an Access wildcard does not cover its parent path. Account, Google callback, guest enrollment, sync, and snapshot paths stay outside Access. Cloudflare documents that a more specific overlapping Access path takes precedence and does not inherit a broader policy; the reconciler therefore refuses unmanaged overlaps instead of relying on implicit inheritance.

The desired state in `cloudflare/access.json` uses:

- The Cloudflare identity provider restricted to Cloudflare account members
- A Stowplan-owned reusable Allow policy with the Cloudflare Account Member selector
- Independent platform-biometric WebAuthn
- A two-hour application and policy session
- The organization guard's twenty-four-hour independent-MFA duration with biometrics and TOTP enabled
- No Access group, email selector, domain selector, Bypass, Service Auth, or ordinary-user rule

Review the configured hostname before using this desired state for a fork. The organization MFA guard is read-only: configure the twenty-four-hour biometrics-plus-TOTP organization setting first, and expect the plan to refuse a mismatch rather than mutate it.

The two-hour value is application-token wall-clock lifetime, not an idle timeout. Access rechecks the policy when that token expires. The independent MFA session has its own twenty-four-hour lifetime, so a policy recheck need not display another biometric prompt until the MFA session is also outside its duration. See Cloudflare's [session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) and [application path](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) references.

Stowplan still verifies the Access assertion at the origin. A normal admin request requires all of:

1. A valid Stowplan app session
2. An active database account with `global_role=admin`
3. A valid assertion for the configured admin Access audience and issuer
4. A normalized Access email matching one of the signed-in account's linked verified Google emails, or the canonical email only for a legacy account with no linked Google identity

Passing Access alone never creates an account, promotes a user, or grants workspace authority. Global administration also never implies membership in any workspace.

Install the origin-verification values:

```bash
npx wrangler secret put AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN
npx wrangler secret put AUTH_CLOUDFLARE_ACCESS_AUD
npx wrangler secret put AUTH_ADMIN_REQUIRE_ACCESS
# enter true
```

Validate desired state and produce a sanitized read-only plan:

```bash
bash scripts/cloudflare-access.sh check
bash scripts/cloudflare-access.sh plan
```

The plan discovers all pages of remote identity providers, reusable policies, and applications. It adopts only a unique name, alias, or normalized fingerprint; refuses unmanaged path overlap, ambiguous matches, shared-resource mutation, and unexpected policy detachment; and prints logical keys rather than remote IDs, audiences, policy members, or identity inventory.

`plan`, `apply`, and `rollback` require `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Give the token only the account Access read/write permissions needed for organizations, identity providers, reusable policies, and applications.

Apply only during an approved cutover. The rollback output path must not already exist and must be outside the repository:

```bash
bash scripts/cloudflare-access.sh apply \
  --rollback-out /secure/stowplan-access-rollback.json \
  --confirm-admin-cutover
```

The reconciler writes the private snapshot with mode `0600`, creates or adopts the account-member identity provider and reusable policy, updates the existing application, detaches only the approved legacy email-policy attachment, and verifies the resulting state. It does not edit or delete that legacy reusable policy.

After conversion, use **Zero Trust > Access controls > Applications > Configure > Revoke existing tokens** for this application, then perform a fresh administrator login. Cloudflare documents that application-token revocation terminates existing application sessions but eligible users can start a new one.

Rollback requires the unchanged desired-state file and the private snapshot:

```bash
bash scripts/cloudflare-access.sh rollback \
  --snapshot /secure/stowplan-access-rollback.json \
  --confirm-rollback
```

Rollback refuses a snapshot with wrong permissions, account/configuration digests, shared-resource use, or post-apply drift. Retain the snapshot until the application rollback window closes, then dispose of it through the operator's protected secret-retention process. After the rollback window, inventory every attachment of the retired email policy. Delete it only when no application still uses it; if another application does, migrate that application through a separately reviewed change before removing the policy so the old email inventory is not retained indefinitely.

## 6. Database administration and recovery

The database is the only ongoing source of global-admin authority. Promotion, demotion, disable, ban, and deletion use account revisions and audited conditional writes. Promotion and demotion revoke the target's active sessions. Database triggers refuse any role, status, soft-deletion, or direct deletion change that would remove the final active, non-deleted administrator. Maintain at least two operators who can independently sign in with Google, pass Access, complete WebAuthn, and recover one another.

First bootstrap and lockout recovery use the same temporary path:

1. Generate a temporary high-entropy token between 43 and 256 characters without whitespace or control characters. The application cannot remove an environment secret itself, so the token remains reusable during the brief recovery window.
2. Install it as the secret `AUTH_ADMIN_RECOVERY_TOKEN`.
3. Sign in to the exact Stowplan account that should receive authority.
4. Pass the Access application when `AUTH_ADMIN_REQUIRE_ACCESS=true`.
5. Visit `/admin/recovery`, enter the temporary token, and confirm recovery.
6. Remove or rotate the secret immediately.
7. Continue with the exact app session used for recovery. Recovery retains only that session and revokes every other active session belonging to every global admin, so it remains usable even when its ordinary session-issuance budget is exhausted.
8. Verify the `admin.recover` audit event and confirm another independently recoverable administrator.

Normal admin authorization requires the Access email to match one of the app account's linked verified Google identities whenever any are linked. Only a legacy account with no linked Google identity may fall back to its canonical email. Recovery deliberately permits the Access operator and target app account to be different so an approved operator can recover a separate app account. Its audit detail records the recovery mode and a versioned keyed principal digest, never the raw Access identity, token, assertion, or email inventory.

Account disable is reversible and atomically revokes active sessions and active unused guest links created by that account; enabling does not restore either. Ban requires prior global-admin demotion, revokes sessions and unused guest links, removes raw profile and identity data, and retains only versioned keyed enforcement digests needed to reject the banned identity. Lifting a ban permits the external identity to register a new account, but it never makes the permanently redacted retained account enableable. Re-banning that retained account reactivates every retained identity digest with the new enforcement reason. None of these server controls remove an IndexedDB replica or outbox from a user's device.

## 7. Public quotas, circuits, and edge controls

Public registration is open, but each account has a bounded server cost:

| Resource | Launch limit |
|---|---:|
| New accounts | 25 per installation day by default, operator-adjustable |
| Owned server workspaces | 5 active, 5 created per day, 20 per rolling 30 days, 100 lifetime |
| Stored snapshots | 1.8 MB per workspace, 8 MB aggregate per custodian account |
| Workspace membership | 25 memberships per account, 25 active members per workspace |
| Linked sign-in identities | 5 per account |
| App sessions | 8 active, 12 issued per day, 60 per rolling 30 days |
| Terminal session history | 32 per account, with 30-day time retention |
| Guest links | 10 active and 100 retained per workspace; 10 created per account day and 50 per rolling 30 days |

A valid fresh sign-in can replace the oldest active app session at the active cap. Reauthentication refreshes the exact current session and does not allocate another session. Guest-link redemption creates an ordinary persistent viewer or editor membership and is subject to the recipient membership limit; it never creates an owner or global admin.

The admin control plane exposes independently scoped circuits for `new_accounts`, `new_workspaces`, `snapshot_growth`, `guest_links`, and `guest_redemptions`. Pause only the narrow resource under pressure. Existing account sign-in is unaffected by the new-account circuit, and local-only work, inspection, and export remain available when allocation is paused.

Security pauses require a future resume time. Treat the first critical trigger as a 30-minute pause and a retrigger after reopening as a two-hour pause. Require two consecutive critical observation windows before opening a security pause unless an active attack makes immediate containment necessary. Capacity pauses are latched and require an explicit operator reopen after capacity is verified. Every circuit or mutable signup-limit change requires a reason and writes an audit event.

Use these aggregate operational thresholds:

| Signal | Warning | Urgent | Critical | Capacity action |
|---|---:|---:|---:|---:|
| Database storage allowance | 60% | 75% | 85% | Pause new workspace allocation and snapshot growth at 90% |
| Daily request, read, or write allowance | 50% | 70% | 85% | Pause the narrow growth paths responsible at 90% |

These are runbook thresholds, not an internal notification-delivery guarantee. Connect them to the chosen monitoring scheduler and alert provider. Until that integration exists, review the Cloudflare and Stowplan admin dashboards on the same cadence. Alerts and notes use aggregate counts and opaque internal IDs only; they exclude emails, provider subjects, raw network addresses, tokens, assertions, guest URLs, and inventory.

Signup volume by itself does not close public registration. Use the hard daily account fuse and a narrow security circuit only for verified abuse or cost risk.

The edge reconciler owns only descriptions beginning with `[stowplan]` and preserves unrelated zone rules:

```bash
bash scripts/cloudflare-edge.sh check
bash scripts/cloudflare-edge.sh plan --profile free
bash scripts/cloudflare-edge.sh apply --profile free
```

Set `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with zone read and WAF edit permissions. Plan output remains the review boundary before any apply.

Apply the Free profile that includes `/api/sync` and `/api/snapshot` only after the retry-aware client from the same release is deployed. The client limits reconnect concurrency, preserves the full server `Retry-After` not-before floor, bounds only its local jittered backoff, arms long waits in safe timer slices, and retains every local replica and outbox entry across `429` and `503` responses.

Profiles in `cloudflare/edge-rules.json` reflect Cloudflare plan capabilities. Every profile includes member-scoped workspace discovery and access management in its source-based control-plane budget. The Free profile uses a host-aware custom skip rule before the zone's single path-only rate rule. The skip bypasses the rate-limit phase on other hosts, dedicating the zone's only rate-rule slot to Stowplan; the reconciler refuses this profile if unrelated zone rate rules exist. Pro adds a separate host-scoped data-plane allowance. Business separates sensitive paths and gives sync/snapshot a higher burst budget. Enterprise Advanced also limits authenticated sessions, rejects duplicate application session cookies, and applies edge body-size rules aligned with server limits. Cloudflare's API remains the final entitlement check.

Use `plan --prune` to preview removal of stale `[stowplan]` rules after switching profiles, then `apply --prune` only after reviewing those deletions. A transition to Free prunes stale managed rate rules before creating its single allowed rule. A transition away from Free is refused without `--prune` so its phase-wide sibling-host skip cannot remain active. The script never deletes unrelated rules.

Browser Integrity Check and standard DDoS controls complement the application budgets. Do not enable a zone-wide bot mode that cannot exempt Stowplan API traffic without testing its effect on sync, shared NATs, guest redemption, and accessibility.

## 8. Back up, migrate, and build

For an existing direct Wrangler installation, export before migration:

```bash
npx wrangler d1 export stowplan --remote --output stowplan-before-upgrade.sql
npx wrangler d1 time-travel info stowplan
```

Review pending migrations, then apply explicitly:

```bash
npx wrangler d1 migrations list stowplan --remote
npx wrangler d1 migrations apply stowplan --remote
```

Run those commands only for a direct Wrangler database. For Sites, do not run the numbered migration stream. Build and validate the production artifact:

```bash
npm run build
npm run validate:artifact
npm run archive:sites
```

`npm run build` requires GNU `timeout`, available as `timeout` on Linux and commonly installed through GNU coreutils on macOS. `npm run archive:sites` writes the validated portable archive to `work/stowplan-sites.tar.gz` and excludes local environment and Finder metadata.

Push the exact source state used for the build to the Sites source repository. Save a Sites version that references that exact pushed commit and its archive, then deploy only the saved version. The `commit_sha` must identify the pushed source state packaged in the archive. Sites applies the packaged Drizzle stream to its bound D1 database. Never save or deploy a version from an unpushed working tree, a different commit, or an archive rebuilt after the commit was selected.

For a direct Wrangler deployment:

```bash
NEXT_PUBLIC_REPOSITORY_URL=https://github.com/YOUR_ACCOUNT/stowplan \
NEXT_PUBLIC_DOCS_URL=https://YOUR_ACCOUNT.github.io/stowplan/ \
npm run build:cloudflare
npx wrangler deploy --config wrangler.jsonc
```

`NEXT_PUBLIC_*` values are compiled into browser assets; setting them only as Worker runtime variables is too late. `wrangler deploy` creates a Worker version and does not apply D1 migrations automatically.

## 9. Public-auth cutover

Use this order for the legacy Access-to-Google transition:

1. Export or bookmark the database, validate both migration streams, and record the last known-good saved Sites version.
2. Create production Google and Turnstile resources, install the complete provider configuration, and keep the Access application unchanged.
3. Set `AUTH_ACCESS_MIGRATION_ENABLED=true` only for the migration window. It exposes an explicit Account-page recovery action that can issue a provenance-marked session with a fixed two-hour maximum lifetime only for an already linked Access identity; it cannot create an account or link by email.
4. Push the exact validated source, save its Sites version and matching archive, and deploy the application while the legacy Access perimeter still covers Account and the Access exchange.
5. Canary Google plus Turnstile with a new ordinary account. Verify that it has `global_role=user`, no workspace membership, and no admin access.
6. Sign legacy accounts in through the explicit Access migration action, connect Google from the authenticated Account page, sign out, and verify direct Google sign-in returns to the same account.
7. Use the temporary recovery procedure if the database lacks a verified administrator. Verify at least two independently recoverable database admins and fresh post-promotion sessions.
8. Canary workspace creation, reconnect, owner/editor/viewer authorization, one scanner-safe guest invitation, quota refusal, disable, session revocation, and narrow circuit behavior. Confirm local replicas and queued work survive every refusal.
9. Set `AUTH_ACCESS_MIGRATION_ENABLED=false`, remove the temporary recovery token and retired email-list configuration, save and deploy that environment revision while the legacy Access perimeter still protects Account, and verify the migration action is gone.
10. From a Google-authenticated database-admin session, choose **Revoke pre-Google sessions**. The audited action revokes every active session with `cloudflare-access` provenance and every active legacy session whose provenance is `null`. If that control revokes the current session, sign in directly with Google and return through Access. Verify the admin inventory's `active pre-Google` count is zero.
11. Run `cloudflare-access.sh plan`, have each operator preflight account-member plus biometric Access, create the private rollback snapshot, and apply the in-place Access conversion only after the zero-session check passes.
12. Revoke existing Access application tokens. Verify exact and descendant admin routes require Access, an ordinary account that passes Access still fails database admin authorization, Account and Google paths are public, and guest/sync/snapshot APIs retain their own server authorization.
13. Apply the reviewed edge profile only after the retry-aware application version is active. Retain the Access rollback snapshot and the prior saved Sites version through the rollback window.

Do not place test accounts on a quota or authorization bypass. Local and CI use synthetic `@example.test` personas and Turnstile test keys. Production canary accounts use real Google identities, synthetic inventory, ordinary quotas, an assigned operator, and a review date. A guest canary is an ordinary account with a viewer or editor membership, not a separate weak identity class.

## 10. Verification and rollback

After each deployment:

```bash
npx wrangler deployments list
npx wrangler tail --status error
```

Request `https://YOUR_ORIGIN/api/health`, complete Google plus Turnstile sign-in, create one local item, wait for "Up to date", reload, redeem a guest link with another ordinary account, and inspect the admin control plane through Access. Do not put assertions, OAuth material, guest URLs, environment values, or inventory into tail filters, screenshots, or incident notes.

Before the Access conversion, application rollback needs no Access mutation: deploy the last known-good saved Sites version and restore only the environment expected by that version.

After the Access conversion, restore the private Access snapshot first so the previous release can reach the ordinary Account and Access-exchange paths it expects. Revoke the Access application's existing tokens, verify the restored provider, policy attachment, exact paths, and ordinary login, then deploy the previous saved Sites version. Restore the old environment only when that previous code requires it.

If direct Google fails but the new application is otherwise healthy, leave local data untouched, restore the legacy Access perimeter and migration exchange before deploying code that depends on them, and verify one legacy account before broad rollback. Do not leave both ordinary Google and an unintended overlapping Access application in an ambiguous state.

Repair database roles, account states, quotas, circuits, custody, and audits through forward, reviewed operations. Do not roll D1 backward merely to reverse an authority mistake. A schema/data disaster is separate: inspect the current time-travel bookmark and restore only after reviewing the destructive effect on all writes since that point.

```bash
npx wrangler d1 time-travel info stowplan
npx wrangler d1 time-travel info stowplan --timestamp="2026-07-22T12:00:00Z"
npx wrangler d1 time-travel restore stowplan --timestamp="2026-07-22T12:00:00Z"
```

Wrangler prints a bookmark that can undo a restore. A code rollback never implies a database rollback.

## Preview and production origins

OAuth callbacks are origin-specific. Use separate Google clients and Turnstile widgets for localhost, preview or staging, and production when their trust boundaries differ. Set `AUTH_BASE_URL` to the externally visible origin; do not rely on a proxy's internal hostname. Never use production credentials or real inventory in an untrusted preview.
