#!/bin/bash
# Applies pending local D1 migrations before the Vite dev server starts.
#
# The local Miniflare D1 volume under .wrangler/ survives across branches and
# pulls, so a database created before a migration landed keeps serving the old
# schema. Every sign-in path touches the newest tables, so a stale volume fails
# at runtime with an opaque 500 instead of anything pointing at migrations.
# CI never sees this because it migrates explicitly on a fresh database.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Opt out for offline work or when deliberately inspecting an unmigrated volume
if [[ "${STOWPLAN_SKIP_DEV_MIGRATIONS:-}" == "1" ]]; then
  echo "[dev] STOWPLAN_SKIP_DEV_MIGRATIONS=1, leaving the local database as-is"
  exit 0
fi

cd "${project_root}"

# A dev server must never be blocked by migration failures: the database may be
# intentionally absent, and local organizing works without a backend at all
if ! npx wrangler d1 migrations apply stowplan --local --config wrangler.jsonc; then
  echo "[dev] Could not apply local D1 migrations." >&2
  echo "[dev] Starting anyway; server-backed sign-in and sync may fail until this succeeds." >&2
  echo "[dev] Retry with: npx wrangler d1 migrations apply stowplan --local --config wrangler.jsonc" >&2
fi
