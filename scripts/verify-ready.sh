#!/bin/bash
set -euo pipefail

project_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root
cd "${project_root}"

initially_clean=0
cleanup_generated_agents() {
  if [[ "${initially_clean}" == "1" ]]; then
    bash "${project_root}/scripts/restore-next-generated-agents.sh" \
      "${project_root}"
  fi
}
trap cleanup_generated_agents EXIT

initial_status="$(git status --porcelain --untracked-files=all)"
readonly initial_status
if [[ -n "${initial_status}" ]]; then
  echo "Ready verification requires a clean committed worktree" >&2
  git status --short --untracked-files=all >&2
  exit 1
fi
initially_clean=1

initial_head="$(git rev-parse --verify HEAD)"
readonly initial_head
python3 scripts/verification-state.py clear "${initial_head}"
bash scripts/install-git-hooks.sh

echo "[verify] running core verification for ${initial_head}"
bash scripts/verify.sh
cleanup_generated_agents

echo "[verify] running browser verification for ${initial_head}"
bash scripts/verify-browser.sh
cleanup_generated_agents

final_head="$(git rev-parse --verify HEAD)"
readonly final_head
final_status="$(git status --porcelain --untracked-files=all)"
readonly final_status
if [[ "${final_head}" != "${initial_head}" ]]; then
  echo "HEAD changed during ready verification" >&2
  exit 1
fi
if [[ -n "${final_status}" ]]; then
  echo "Ready verification left unexpected worktree changes" >&2
  git status --short --untracked-files=all >&2
  exit 1
fi

python3 scripts/verification-state.py record "${initial_head}"
echo "[verify] exact HEAD ${initial_head} is ready to push"
