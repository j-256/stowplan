#!/bin/bash
# Validates the deployment automation that only a release exercises.
#
# These scripts are not covered by typecheck or lint, so a syntax error in them
# would otherwise surface during a release rather than before one. The check
# subcommands compare desired Cloudflare state against the committed
# configuration without mutating anything.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"

group() {
  echo "::group::$1"
}
endgroup() {
  echo "::endgroup::"
}

group "deployment script syntax"
bash -n \
  scripts/cloudflare-access.sh \
  scripts/cloudflare-edge.sh
endgroup

group "documentation Worker"
DOCS_BASE=/ npm run docs:build
DOCS_BASE=/ npm run docs:check
npm run docs:publish:stamp -- --revision "$(git rev-parse HEAD)"
npm run deploy:docs:dry-run
endgroup

group "cloudflare access desired state"
bash scripts/cloudflare-access.sh check
endgroup

group "cloudflare edge desired state"
bash scripts/cloudflare-edge.sh check
endgroup

echo "[deploy-checks] all checks passed"
