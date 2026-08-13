#!/bin/bash
set -euo pipefail

readonly EXPECTED_BRANCH="main"
readonly EXPECTED_DOCS_URL="https://docs.stowplan.lasers.app/"
readonly RETIRED_DOCS_URL="https://j-256.github.io/stowplan/"
# shellcheck disable=SC2016
readonly GENERATED_AGENTS_BLOCK='<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes \0342\0200\0224 APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file\0047s directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` \0342\0200\0224 verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->'

script_directory="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
default_repository="$(git -C "${script_directory}/../../../.." rev-parse --show-toplevel)"
readonly script_directory
readonly default_repository

repository="${1:-${default_repository}}"
archive="${repository}/work/stowplan-sites.tar.gz"
initially_clean=0

if [[ "$#" -gt 1 ]]; then
  echo "usage: prepare-release.sh [repository]" >&2
  exit 64
fi

cleanup_generated_agents() {
  local current_status
  local expected_agents
  local temporary_directory

  [[ "${initially_clean}" == "1" ]] || return 0
  current_status="$(git -C "${repository}" status --porcelain --untracked-files=all)"
  [[ "${current_status}" == " M AGENTS.md" ]] || return 0

  temporary_directory="$(mktemp -d /tmp/stowplan-release-agents.XXXXXX)"
  expected_agents="${temporary_directory}/AGENTS.md"
  git -C "${repository}" show HEAD:AGENTS.md >"${expected_agents}"
  printf '\n%b\n' "${GENERATED_AGENTS_BLOCK}" >>"${expected_agents}"
  if cmp -s "${expected_agents}" "${repository}/AGENTS.md"; then
    git -C "${repository}" checkout HEAD -- AGENTS.md
  fi
  rm -rf "${temporary_directory}"
}

trap cleanup_generated_agents EXIT

if ! git -C "${repository}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Stowplan repository not found at ${repository}" >&2
  exit 66
fi

branch="$(git -C "${repository}" branch --show-current)"
if [[ "${branch}" != "${EXPECTED_BRANCH}" ]]; then
  echo "Release requires branch ${EXPECTED_BRANCH}; found ${branch:-detached HEAD}" >&2
  exit 65
fi

initial_status="$(git -C "${repository}" status --porcelain --untracked-files=all)"
if [[ -n "${initial_status}" ]]; then
  echo "Release requires a clean worktree" >&2
  git -C "${repository}" status --short >&2
  exit 65
fi
initially_clean=1

initial_head="$(git -C "${repository}" rev-parse HEAD)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
npm_major="$(npm --version | cut -d. -f1)"
case "${node_major}" in
  24|26) ;;
  *)
    echo "Release requires supported Node 24 or 26; found $(node --version)" >&2
    exit 69
    ;;
esac
if [[ "${npm_major}" != "11" ]]; then
  echo "Release requires npm 11; found $(npm --version)" >&2
  exit 69
fi
if [[ ! -x "${repository}/node_modules/.bin/vinext" ]]; then
  echo "Dependencies are unavailable; run npm ci in ${repository}" >&2
  exit 69
fi

bash "${repository}/scripts/verify.sh"
cleanup_generated_agents

post_verify_status="$(git -C "${repository}" status --porcelain --untracked-files=all)"
if [[ -n "${post_verify_status}" ]]; then
  echo "Verification left unexpected worktree changes" >&2
  git -C "${repository}" status --short >&2
  exit 65
fi

verified_head="$(git -C "${repository}" rev-parse HEAD)"
if [[ "${verified_head}" != "${initial_head}" ]]; then
  echo "HEAD changed during verification" >&2
  exit 65
fi

if ! rg -q --fixed-strings "${EXPECTED_DOCS_URL}" "${repository}/dist"; then
  echo "Sites build does not contain the canonical documentation origin" >&2
  exit 65
fi
if rg -q --fixed-strings "${RETIRED_DOCS_URL}" "${repository}/dist"; then
  echo "Sites build still contains the retired GitHub Pages origin" >&2
  exit 65
fi

bash "${repository}/scripts/sites-env.sh" -- \
  bash "${repository}/scripts/archive-sites-artifact.sh" "${archive}"

final_head="$(git -C "${repository}" rev-parse HEAD)"
final_status="$(git -C "${repository}" status --porcelain --untracked-files=all)"
if [[ "${final_head}" != "${initial_head}" || -n "${final_status}" ]]; then
  echo "Repository changed while packaging the release" >&2
  git -C "${repository}" status --short >&2
  exit 65
fi

printf 'STOWPLAN_RELEASE_COMMIT=%s\n' "${initial_head}"
printf 'STOWPLAN_RELEASE_ARCHIVE=%s\n' "${archive}"
