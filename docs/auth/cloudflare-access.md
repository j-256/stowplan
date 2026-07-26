# Cloudflare Access administrator perimeter

Cloudflare Access is an independent administrator perimeter. It is not an ordinary Stowplan identity provider, signup admission list, global-role source, or workspace-role source. Public users sign in directly with Google, and Stowplan assigns a new account the database `user` role with no workspace membership.

The production Access application protects exactly these roots and descendants:

```text
/admin
/admin/*
/api/admin
/api/admin/*
```

Account, Google OAuth, guest enrollment, sync, and snapshot paths remain outside Access. Exact roots and wildcard descendants are both present because a wildcard path does not protect its parent. Stowplan verifies the Access assertion again at the origin. A normal administrative request requires a valid app session, an active database global admin, the configured Access audience and issuer, and a normalized Access email matching one of the account's linked verified Google identities whenever any are linked. Only a legacy account with no linked Google identity may fall back to its canonical email. A linked Cloudflare Access identity never satisfies the direct sign-in or email-match safeguards.

Passing Access never creates an account, promotes a user, grants workspace membership, or bypasses workspace-scoped server authorization. The database `users.global_role` value is the only ongoing source of global-admin authority.

## Desired state

`cloudflare/access.json` converts the existing `Stowplan` self-hosted application in place. It selects the Cloudflare identity provider restricted to account members and attaches a Stowplan-owned reusable Allow policy using the Cloudflare Account Member selector. The application and policy sessions last two hours. The policy requires platform-biometric WebAuthn, while the read-only organization guard requires organization-wide MFA, a twenty-four-hour MFA session, and both biometrics and TOTP to remain enabled.

There is no Access email allowlist, Access group, ordinary-account rule, One-time PIN dependency, Bypass policy, or Service Auth policy in the managed design.

## Read-only checks

Validate the checked-in model without credentials, then inspect a sanitized remote plan:

```bash
bash scripts/cloudflare-access.sh check
bash scripts/cloudflare-access.sh plan
```

`plan` reads every paginated identity-provider, reusable-policy, and application result, then reads each application detail before calculating a safe full PUT payload. It validates pagination continuity and totals, one-to-one adoption, the organization MFA guard, reusable-resource ownership, explicit identity-provider selection, legacy `self_hosted_domains`, and overlap with every unmanaged public Access application. A new identity provider is refused when it would silently become available to an unmanaged application that uses Cloudflare's default-all provider behavior.

The plan prints logical resource keys and action names only. It does not print remote IDs, audiences, policy members, identity inventory, assertions, or credentials.

## Approved cutover and rollback

Apply requires an explicit cutover flag and a new private snapshot path outside the repository:

```bash
bash scripts/cloudflare-access.sh apply \
  --rollback-out /secure/stowplan-access-rollback.json \
  --confirm-admin-cutover
```

Before each remote write, the reconciler persists that resource as `pending`. A verified write becomes `applied`; an untouched resource remains `not_started`. If a write response is lost, rollback refuses the uncertain snapshot instead of guessing whether Cloudflare changed. The private mode-`0600` snapshot stores managed before-payloads and only IDs plus SHA-256 digests for linked legacy providers and policies. It never stores legacy policy contents or identity values.

Rollback uses the unchanged desired-state file and the private snapshot:

```bash
bash scripts/cloudflare-access.sh rollback \
  --snapshot /secure/stowplan-access-rollback.json \
  --confirm-rollback
```

Rollback verifies every applied resource, rechecks the redacted legacy dependency digests, and repeats unmanaged public-path overlap checks before restoring an application. Each completed resource becomes `rolled_back`, so a later invocation can resume after a definite partial rollback. A `pending` apply mutation, changed dependency, new overlap, shared created resource, or other post-apply drift requires operator investigation.

See the [Cloudflare deployment runbook](/deploy/cloudflare#_5-admin-only-cloudflare-access) for the full migration order, origin environment values, token revocation, verification, and lockout-recovery procedure.

## Temporary legacy exchange

`POST /api/auth/access` is disabled unless `AUTH_ACCESS_MIGRATION_ENABLED=true`. During the bounded pre-cutover migration window, it may recover a two-hour session only for an already linked Cloudflare Access subject. It cannot create an account or link by email. Every such session records `cloudflare-access` provenance. Connect and verify Google for each required account, disable the exchange, use **Revoke pre-Google sessions** to revoke both marked Access migration sessions and legacy active sessions without provenance, and verify the admin inventory's `active pre-Google` count is zero before narrowing the Access application to the admin paths.
