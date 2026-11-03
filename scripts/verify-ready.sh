#!/bin/bash
set -euo pipefail

project_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root
cd "${project_root}"

initially_clean=0
cleanup_generated_files() {
  if [[ "${initially_clean}" == "1" ]]; then
    node --input-type=module - "${project_root}/.vinext/cache/.rscinfo" <<'NODE'
import { rmSync } from "node:fs";

rmSync(process.argv[2], { force: true });
NODE
    bash "${project_root}/scripts/restore-next-generated-agents.sh" \
      "${project_root}"
  fi
}
trap cleanup_generated_files EXIT

initial_status="$(git status --porcelain --untracked-files=all)"
readonly initial_status
if [[ -n "${initial_status}" ]]; then
  echo "Ready verification requires a clean committed worktree" >&2
  git status --short --untracked-files=all >&2
  exit 1
fi
initially_clean=1

node --input-type=module - "${project_root}/.next" <<'NODE'
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

initial_head="$(git rev-parse --verify HEAD)"
readonly initial_head
python3 scripts/verification-state.py clear "${initial_head}"
bash scripts/install-git-hooks.sh

echo "[verify] running core verification for ${initial_head}"
bash scripts/verify.sh
cleanup_generated_files

echo "[verify] running browser verification for ${initial_head}"
bash scripts/verify-browser.sh
cleanup_generated_files

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
