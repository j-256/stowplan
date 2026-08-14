#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="${SITES_PROJECT_ROOT:-$(cd "${script_dir}/.." && pwd)}"
next_output="${project_root}/.next"
quarantine_root="${project_root}/.sites-runtime/next-quarantine"
quarantine_path=""

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "$#" -eq 0 ]]; then
  echo "usage: scripts/with-clean-next-output.sh -- command [args...]" >&2
  exit 64
fi

cleanup_quarantine() {
  local status="$?"

  trap - EXIT
  if [[ -n "${quarantine_path}" ]]; then
    if ! node --input-type=module - "${quarantine_path}" <<'NODE'
import { rmSync } from "node:fs";

const CLEANUP_MAX_RETRIES = 12;
const CLEANUP_RETRY_DELAY_MILLISECONDS = 100;

rmSync(process.argv[2], {
  force: true,
  maxRetries: CLEANUP_MAX_RETRIES,
  recursive: true,
  retryDelay: CLEANUP_RETRY_DELAY_MILLISECONDS,
});
NODE
    then
      echo "[next-build] warning: could not remove quarantined output at ${quarantine_path}" >&2
    fi
    rmdir "${quarantine_root}" 2>/dev/null || true
  fi
  exit "${status}"
}

trap cleanup_quarantine EXIT

# Next scans directories before deleting them, so a late metadata file can make
# its final rmdir fail without giving the cleanup another chance to scan
# Renaming the complete tree first removes that race from the live build path
if [[ -e "${next_output}" || -L "${next_output}" ]]; then
  mkdir -p "${quarantine_root}"
  quarantine_path="$(mktemp -d "${quarantine_root}/output.XXXXXX")"
  mv "${next_output}" "${quarantine_path}/.next"
  echo "[next-build] quarantined previous .next output"
fi

cd "${project_root}"
"$@"
