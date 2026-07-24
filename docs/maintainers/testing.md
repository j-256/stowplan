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

The suite covers domain invariants, ordered and sequentially projected planning, whole-container planning, split/merge and mixed-destination bulk moves, field-aware conflicts, pluck/batch history, optimistic sync/idempotency, initialization-race authorization, D1-compatible SQLite persistence, authentication/session revocation, concurrent guest-link single use, multi-workspace IndexedDB persistence and compare-and-swap recovery, inactive-workspace reconnect targets, legacy v1 outbox normalization, isolated demo reset, UUID generation when `crypto.randomUUID` is unavailable, async runtime fallback, deep backup validation, and full recovery-bundle invariants. Capture coverage verifies that emptying a reviewed container changes its contents and status atomically, one undo restores both, stale review input is refused, and a completed space can return to uncounted. Coverage has checked-in minimums for the portable domain, server, and storage-adapter layers. The Node smoke starts the production standalone server against a temporary SQLite database and exercises health, security headers, authentication, provider discovery, workspace claiming, idempotent sync, authorized snapshot restore, admin reads, read-only guest reconciliation, and scanner-safe link redemption through HTTP. The Next development smoke applies pending numbered migrations to its local D1 state before testing development sign-in and the admin control panel, so it also works from a fresh checkout. A separate Sites D1 test applies the source Drizzle schema to SQLite, persists a snapshot, creates an identity, and claims a workspace. The artifact validation gate then requires the packaged manifest and complete Drizzle tree to match those sources byte for byte.

Browser gates use Chromium in phone portrait and landscape, tablet portrait and landscape, compact desktop, and wide desktop layouts. They exercise onboarding to demo to capture to search to plan to activity to theme, run axe, inspect console errors, test offline reload, and verify the service worker never caches APIs. Navigation coverage checks canonical tab, location, inventory-filter, and item-editor paths; reload and browser history restoration; real anchor destinations; and authorized snapshot hydration on a clean collaborator device. Adaptive-layout coverage checks the persistent icon sidebar, stacked and side-by-side panes, pointer and keyboard resizing, overflow, and Command-K or Control-K jump behavior. Capture regressions hold native mouse drags open to check source, valid-target, invalid-branch, and before-or-after feedback before a drop commits. They also verify confirmation and atomic undo when an occupied container is marked empty, visible refusal for nested spaces, compact two-pane readability, and Chromium touch events for touch-specific reorder behavior instead of inferring touch support from mouse input.

The release gate audits the production dependency tree. VitePress and migration/build CLIs are development-only tools and may inherit advisories that have no compatible upstream release; run them only against trusted source on localhost or in isolated CI, and review the full unfiltered `npm audit` report during dependency updates.

## Version policy

Stowplan targets the newest Node 24 LTS patch recorded in `.nvmrc`, not the short-lived Current line. `npm outdated` can therefore legitimately show Node 26 types. ESLint stays on the newest 9.x release until the React/JSX plugins bundled by `eslint-config-next` accept ESLint 10; TypeScript stays on the newest 6.x release accepted by `typescript-eslint`; and Vinext remains the Sites-preview adapter until its 1.x line is stable. The canonical Cloudflare build is OpenNext, so a preview-adapter pre-release never blocks a production dependency update.

## Release checklist

1. Review dependency updates and official release notes; do not update past peer compatibility.
2. Export/restore a representative workspace and run migration tests.
3. Run every gate above from a clean checkout.
4. Verify Google, GitHub, Access, guest, disabled-user, and admin-second-gate paths with operator credentials.
5. Check light/dark/system, reduced motion, keyboard-only, screen-reader labels, phone and tablet orientations, compact desktop, and wide desktop.
6. Build docs with `/stowplan/` and `/` bases; inspect generated links.
7. Generate truthful screenshots from the final build.
8. Generate an SBOM, review licenses, update changelog/version, and sign/tag the release version.
9. For direct Wrangler, export the database, apply the numbered remote migrations, then deploy code. For Sites, do not apply the numbered stream; save and deploy the exact validated artifact so Sites applies its packaged Drizzle stream.
10. Run health, login, sync, export, and restore smoke checks in production.

Security reports follow `SECURITY.md`; do not open a public issue containing an auth bypass, secret, guest URL, or production export.
