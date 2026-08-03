# Testing and release

## Local gates

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run typecheck
npm run lint
npm run test:coverage
DOCS_BASE=/stowplan/ npm run docs:build && DOCS_BASE=/stowplan/ npm run docs:check
DOCS_BASE=/ npm run docs:build && DOCS_BASE=/ npm run docs:check
npm run build
npm run test:render
npm run build:next
npm run test:node-smoke
npm run test:next-dev-smoke
npm run build:cloudflare
npx wrangler deploy --dry-run --config wrangler.jsonc
bash -n scripts/cloudflare-access.sh scripts/cloudflare-edge.sh scripts/github-pages.sh
bash scripts/cloudflare-access.sh check
bash scripts/cloudflare-edge.sh check
npm sbom --omit=dev --sbom-format cyclonedx > stowplan-sbom.cdx.json
```

The suite covers domain invariants, ordered and sequentially projected planning, whole-container planning, split/merge and mixed-destination bulk moves, field-aware conflicts, pluck/batch history, optimistic sync/idempotency, initialization-race authorization, D1-compatible SQLite persistence, authentication/session revocation, concurrent invite-link single use, multi-workspace IndexedDB persistence and compare-and-swap recovery, inactive-workspace reconnect targets, legacy v1 outbox normalization, isolated demo reset, UUID generation when `crypto.randomUUID` is unavailable, async runtime fallback, deep backup validation, and full recovery-bundle invariants. Authentication coverage includes Google OIDC claim validation, PKCE, nonce and browser binding, Managed Turnstile failure and replay, explicit identity linking and reauthentication, the disabled-by-default Access migration exchange, active and rolling session budgets, account disable and ban, database-only global roles, last-admin and final-owner races, temporary recovery, account deletion, public allocation quotas, and scoped circuit breakers. Capture coverage verifies that emptying a reviewed container changes its contents and status atomically, one undo restores both, stale review input is refused, and a completed space can return to uncounted. Coverage has checked-in minimums for the portable domain, server, and storage-adapter layers. The Node smoke starts the production standalone server against a temporary SQLite database and exercises health, security headers, development authentication, member-scoped workspace discovery without a known ID, idempotent sync, authorized snapshot restore, admin reads, owner self-service invite creation, scanner-safe enrollment, forged viewer-write and viewer-delete refusals, final-owner leave refusal, and guarded immediate server deletion through HTTP. The Next development smoke applies pending numbered migrations to its local D1 state before repeating the member discovery, owner access, viewer refusal, enrollment, lifecycle, and admin-control checks. A separate Sites D1 test applies the source Drizzle schema to SQLite, persists a snapshot, creates an identity, and claims a workspace. The artifact validation gate then requires the packaged manifest and complete Drizzle tree to match those sources byte for byte.

History regressions specifically cover later edits to unrelated fields on the same item or location, legacy metadata patches, version exhaustion and atomic refusal, mixed selective and batch operations, bulk merges, partial splits, nested deletion and restoration, plan side effects and invalidation, same-field conflicts, invariant failures, clock ties and skew, stale synchronized undo, and duplicate UI actions. Rendered coverage verifies newest-first editable and read-only timelines, bounded paging, meaningful patch summaries, visible audit targets, responsive overflow, and accessibility for an older same-item edit that is undone and reapplied while a newer field remains intact.

Browser gates use Chromium with Pixel 7 Pro phone profiles in portrait and landscape, plus tablet portrait and landscape, compact desktop, and wide desktop layouts. Safe-beta gates also run with Playwright WebKit phone and tablet profiles to catch engine-specific failures; these profiles are not evidence of testing on physical iPhone or iPad hardware or in macOS Safari. The Playwright server uses OpenSSL to generate an ephemeral localhost certificate and proxies HTTPS to the Node server so every browser exercises the production `__Host-` session-cookie contract; the certificate material stays under the ignored test-output directory, is removed when the harness stops, and leaves no retained private key. The gates exercise onboarding to demo to capture to search to plan to activity to theme, run axe, inspect console errors, test offline reload, and verify the service worker never caches APIs. Navigation coverage checks canonical tab, location, inventory-filter, and item-editor paths; reload and browser history restoration; real anchor destinations; and authorized snapshot hydration on a clean collaborator device. First-run workspace coverage keeps creation before the demo and optional backup explanation. Account coverage checks that return and sign-in controls precede optional privacy detail, and that workspace continuation precedes session management and deletion for signed-in users. Adaptive-layout coverage checks the persistent icon sidebar, the five-target phone bar and accessible More sheet, the focused two-action phone header, compact single-panel switching with preserved drafts, progressive disclosure of optional space metadata with guided reopening, stacked and side-by-side desktop panes, pointer and keyboard resizing, narrow header reachability, overflow, and Command-K or Control-K jump behavior. Capture regressions hold native mouse drags open to check source, valid-target, invalid-branch, and before-or-after feedback before a drop commits. Touch regressions use Chromium touch events instead of inferring touch support from mouse input. They reorder siblings in an untouched completed demo parent without reopening it or changing membership, exercise a valid Spaces touch reorder, verify the mobile active-row hierarchy controls and their parent-and-position dialog, and confirm that reparenting names and atomically reopens every affected completed parent. Capture coverage also verifies confirmation and atomic undo when an occupied container is marked empty, visible refusal for nested spaces, one-tap compact selection, and focused-panel readability.

## Known browser flakiness

Browser gates retry twice in CI, so an intermittent failure still reports success for the run. Treat a `flaky` line in the Playwright summary as a real signal rather than noise: it means a gate needed a retry to pass. Occurrences to date have all landed on the Chromium device-emulation projects and have not stayed on one test, including one Chromium `SIGSEGV` during context creation that no repository change caused. Record new occurrences, with the annotation text and run link, in [issue 10](https://github.com/j-256/stowplan/issues/10) before the workflow run ages out; Playwright annotations are discarded with the run. Read that issue before changing retry settings, adding a device project, or reworking a test that appears there, and prefer fixing the race over widening a timeout. Enabling `failOnFlakyTests` is deliberately deferred until the crash is understood, because it would turn a runner-level fault into a failed build.

## Authentication and abuse matrix

Local, CI, and isolated browser tests use Cloudflare's documented Turnstile test credentials and synthetic `@example.test` development identities. The development provider is allowed only on loopback, reserved `.test` hosts, or hosts explicitly named in `AUTH_DEV_ALLOWED_HOSTS`; production-host refusal is a required regression. `owner@example.test` bootstraps only the first local development administrator. Use distinct synthetic personas for admin, owner, editor, viewer, outsider, disabled, and banned states. Synthetic persona metadata never bypasses authentication or changes roles, per-account quotas, circuits, or authorization outcomes. The isolated E2E installation explicitly raises only the aggregate installation-wide `new_accounts_per_day` operator limit through `governance_limits` so the complete persona matrix does not consume the default launch capacity.

A full local matrix needs no additional personal Google accounts:

| Boundary | Required cases |
|---|---|
| Google plus Turnstile | Success, challenge refusal, expiry, replay, hostname/action mismatch, Siteverify outage, state/browser mismatch, PKCE, nonce, issuer, audience, optional and mismatched `azp`, time claims, verified-email requirement, callback replay |
| Linking and migration | Explicit authenticated Google link, subject collision, matching email without a link transaction, reauthentication of the exact session, existing-identity-only Access migration, fixed migration lifetime and provenance, disabled exchange, marked and legacy-null pre-Google revocation, zero-active-session cutover check |
| Sessions | Opaque hash storage, provider provenance, active replacement, daily and rolling budgets, current/other/all/pre-Google revocation, promotion and demotion revocation, disable and ban session plus unused-link revocation, terminal cleanup |
| Database administration | Ordinary user through Access, admin without Access, mismatched Access/app email, canonical fallback only before Google linking, stale canonical rejection after a Google email change, first recovery, recovery with separate Access operator, concurrent last-admin demotion/disable/delete, stale account revision |
| Workspace authority | Admin without membership, owner/editor/viewer/outsider boundaries, explicit inspection and custody, final owner, account membership cap, per-workspace member cap |
| Guest users | Scanner-safe fragment, signed-out continuation, viewer/editor enrollment, one-use race, expiry, revocation, active/retained/creation limits, redemption circuit, no owner/admin escalation |
| Public allocation | New-account fuse, workspace daily/rolling/lifetime limits, owned-workspace and aggregate-byte limits, per-snapshot limit, growth circuit, concurrent first allocation |
| Local-first refusal | `429` plus `Retry-After`, `503` breaker response, quota refusal, disable, ban, lost membership, retained replica/outbox, blocked work inspection, export |
| Access desired state | Exact roots, wildcard descendants, near-prefix public paths, unmanaged overlap refusal, reusable-policy sharing, adoption ambiguity, paginated inventory, sanitized plan, private rollback permissions |

One real production Google account is sufficient to canary Google's hosted flow, production Turnstile, callback and cookie behavior, ordinary account creation, explicit promotion, and the independent Access gate. Use synthetic local personas for the multi-account authorization matrix. A production cross-account guest canary should use a designated tester when available; it must remain an ordinary Google account with ordinary quotas rather than an impersonation or test bypass. Production test accounts use synthetic inventory, have a responsible operator and review date, and are disabled or deleted when no longer needed.

Quota and circuit tests assert both the preflight response and the transaction-time guard. A test that pauses one circuit must prove unaffected paths remain available. Security-pause tests cover future resume and repeated-trigger metadata; capacity-pause tests remain latched until an audited reopen. Reconnect tests limit concurrent workspaces, preserve the full `Retry-After` not-before floor while bounding local backoff and timer slices, and prove no outbox envelope is lost or reordered.

The release gate audits the production dependency tree. VitePress and migration/build CLIs are development-only tools and may inherit advisories that have no compatible upstream release; run them only against trusted source on localhost or in isolated CI, and review the full unfiltered `npm audit` report during dependency updates.

## Version policy

Stowplan pins the newest Node 24 LTS patch in `.nvmrc` as the deployment default and also verifies Node 26 in CI. Both supported Node lines use npm 11 because the committed lockfile depends on its peer-dependency layout. ESLint stays on the newest 9.x release until the React/JSX plugins bundled by `eslint-config-next` accept ESLint 10; TypeScript stays on the newest 6.x release accepted by `typescript-eslint`; and Vinext remains the Sites-preview adapter until its 1.x line is stable. The canonical Cloudflare build is OpenNext, so a preview-adapter pre-release never blocks a production dependency update.

## Release checklist

1. Review dependency updates and official release notes; do not update past peer compatibility.
2. Export/restore a representative workspace and run migration tests.
3. Run every gate above from a clean checkout.
4. Verify Google plus production Turnstile, ordinary-user, guest, disabled, banned, session-revocation, quota, circuit, and Access-protected database-admin paths with operator credentials.
5. Check light/dark/system, reduced motion, keyboard-only, screen-reader labels, phone and tablet orientations, compact desktop, and wide desktop.
6. Build docs with `/stowplan/` and `/` bases; inspect generated links.
7. Generate truthful screenshots from the final build.
8. Generate an SBOM, review licenses, update changelog/version, and sign/tag the release version.
9. Verify `AUTH_ACCESS_MIGRATION_ENABLED` and `AUTH_ADMIN_RECOVERY_TOKEN` are absent or disabled outside an approved migration or recovery window, the retired email-list setting is not used as authority, and the admin inventory reports zero active pre-Google sessions before Account leaves the Access perimeter.
10. For direct Wrangler, export the database, apply the numbered remote migrations, then deploy code. For Sites, do not apply the numbered stream; push the exact validated source, save a Sites version that references that pushed commit and matching archive, and deploy only the saved version so Sites applies its packaged Drizzle stream.
11. Run health, Google plus Turnstile login, ordinary authorization, guest enrollment, sync, export, restore, admin Access, last-admin, and session-revocation smoke checks in production.
12. Verify the Access application owns only exact and descendant admin routes, revoke pre-cutover Access application tokens, and retain the mode-`0600` rollback snapshot through the rollback window.

Security reports follow `SECURITY.md`; do not open a public issue containing an auth bypass, secret, guest URL, or production export.
