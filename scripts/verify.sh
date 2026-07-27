#!/bin/bash
# Runs the full verification sequence shared by CI and release.
#
# CI and release must validate identically: a release that skips a check CI runs
# can ship what CI would have rejected. Keeping the sequence here instead of
# duplicated in each workflow makes that divergence impossible, and lets a
# maintainer reproduce the exact CI run locally with one command.
#
# Chain with scripts/deploy-checks.sh and scripts/release-artifacts.sh for the
# additional release-only steps.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"

# GitHub Pages serves the docs under the repository name; workflows override
# this so the path follows a rename. Root-hosted docs get the same validation
docs_pages_base="${DOCS_PAGES_BASE:-/stowplan/}"

# Collapsible sections keep a failure locatable in one combined log. Outside
# Actions these are inert markers, so local runs stay readable
group() {
  echo "::group::$1"
}
endgroup() {
  echo "::endgroup::"
}

group "npm audit"
npm audit --omit=dev --audit-level=high
endgroup

group "typecheck"
npm run typecheck
endgroup

group "lint"
npm run lint
endgroup

group "unit and integration tests"
npm run test:coverage
endgroup

group "docs build (${docs_pages_base})"
DOCS_BASE="${docs_pages_base}" npm run docs:build
DOCS_BASE="${docs_pages_base}" npm run docs:check
endgroup

group "docs build (/)"
DOCS_BASE=/ npm run docs:build
DOCS_BASE=/ npm run docs:check
endgroup

group "sites build"
npm run build
endgroup

group "rendered html"
npm run test:render
endgroup

group "next build"
npm run build:next
endgroup

group "node smoke"
npm run test:node-smoke
endgroup

group "local d1 migrations"
npx wrangler d1 migrations apply stowplan --local --config wrangler.jsonc
endgroup

group "next dev smoke"
npm run test:next-dev-smoke
endgroup

group "cloudflare build"
npm run build:cloudflare
endgroup

group "wrangler deploy dry run"
npx wrangler deploy --dry-run --config wrangler.jsonc
endgroup

echo "[verify] all checks passed"
