#!/bin/bash
set -euo pipefail

# shellcheck disable=SC2016
readonly GENERATED_AGENTS_BLOCK='<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes \0342\0200\0224 APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file\0047s directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` \0342\0200\0224 verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->'

project_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root
repository="${1:-${project_root}}"
readonly repository

if [[ "$#" -gt 1 ]]; then
  echo "usage: restore-next-generated-agents.sh [repository]" >&2
  exit 64
fi

current_status="$(git -C "${repository}" status --porcelain --untracked-files=all)"
readonly current_status
if [[ "${current_status}" != " M AGENTS.md" ]]; then
  exit 0
fi

temporary_directory="$(mktemp -d /tmp/stowplan-generated-agents.XXXXXX)"
readonly temporary_directory
expected_agents="${temporary_directory}/AGENTS.md"
readonly expected_agents
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT

git -C "${repository}" show HEAD:AGENTS.md >"${expected_agents}"
printf '\n%b\n' "${GENERATED_AGENTS_BLOCK}" >>"${expected_agents}"
if cmp -s "${expected_agents}" "${repository}/AGENTS.md"; then
  git -C "${repository}" checkout HEAD -- AGENTS.md
  echo "[verify] removed the exact Next-generated AGENTS.md block"
fi
