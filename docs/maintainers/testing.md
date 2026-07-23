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
npm sbom --omit=dev --sbom-format cyclonedx > stowplan-sbom.cdx.json
```

The suite covers domain invariants, ordered and sequentially projected planning, whole-container planning, split/merge and mixed-destination bulk moves, field-aware conflicts, pluck/batch history, optimistic sync/idempotency, initialization-race authorization, D1-compatible SQLite persistence, authentication/session revocation, concurrent guest-link single use, multi-workspace IndexedDB persistence and compare-and-swap recovery, inactive-workspace reconnect targets, legacy v1 outbox normalization, isolated demo reset, UUID generation when `crypto.randomUUID` is unavailable, async runtime fallback, deep backup validation, and full recovery-bundle invariants. Coverage has checked-in minimums for the portable domain, server, and storage-adapter layers. The Node smoke starts the production standalone server against a temporary SQLite database and exercises health, security headers, authentication, provider discovery, workspace claiming, idempotent sync, authorized snapshot restore, admin reads, read-only guest reconciliation, and scanner-safe link redemption through HTTP. The Next development smoke applies pending numbered migrations to its local D1 state before testing development sign-in and the admin control panel, so it also works from a fresh checkout.

Browser gates use Chromium at mobile and desktop sizes, exercise onboarding → demo → capture → search → plan → activity → theme, run axe, inspect console errors, test offline reload, and verify the service worker never caches APIs. Capture regressions hold native mouse drags open to check source, valid-target, invalid-branch, and before-or-after feedback before a drop commits. They also check compact two-pane readability and use Chromium touch events for touch-specific reorder behavior instead of inferring touch support from mouse input.

The release gate audits the production dependency tree. VitePress and migration/build CLIs are development-only tools and may inherit advisories that have no compatible upstream release; run them only against trusted source on localhost or in isolated CI, and review the full unfiltered `npm audit` report during dependency updates.

## Version policy

Stowplan targets the newest Node 24 LTS patch recorded in `.nvmrc`, not the short-lived Current line. `npm outdated` can therefore legitimately show Node 26 types. ESLint stays on the newest 9.x release until the React/JSX plugins bundled by `eslint-config-next` accept ESLint 10; TypeScript stays on the newest 6.x release accepted by `typescript-eslint`; and Vinext remains the Sites-preview adapter until its 1.x line is stable. The canonical Cloudflare build is OpenNext, so a preview-adapter pre-release never blocks a production dependency update.

## Release checklist

1. Review dependency updates and official release notes; do not update past peer compatibility.
2. Export/restore a representative workspace and run migration tests.
3. Run every gate above from a clean checkout.
4. Verify Google, GitHub, Access, guest, disabled-user, and admin-second-gate paths with operator credentials.
5. Check light/dark/system, reduced motion, keyboard-only, screen-reader labels, Pixel-class mobile viewport, and wide desktop.
6. Build docs with `/stowplan/` and `/` bases; inspect generated links.
7. Generate truthful screenshots from the final build.
8. Generate an SBOM, review licenses, update changelog/version, sign/tag the release version, and deploy code only after remote migrations.
9. Run health, login, sync, export, and restore smoke checks in production.

Security reports follow `SECURITY.md`; do not open a public issue containing an auth bypass, secret, guest URL, or production export.
