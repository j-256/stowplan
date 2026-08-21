#!/bin/bash
set -euo pipefail

project_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root

configured_hooks_path="$(git -C "${project_root}" config --get core.hooksPath || true)"
readonly configured_hooks_path
if [[ -n "${configured_hooks_path}" ]]; then
  echo "Cannot install Stowplan hooks while core.hooksPath is set to ${configured_hooks_path}" >&2
  exit 1
fi

common_git_directory="$(git -C "${project_root}" rev-parse --git-common-dir)"
case "${common_git_directory}" in
  /*) ;;
  *) common_git_directory="${project_root}/${common_git_directory}" ;;
esac
readonly common_git_directory
source_hook="${project_root}/.githooks/pre-push"
readonly source_hook
target_directory="${common_git_directory}/hooks"
readonly target_directory
target_hook="${target_directory}/pre-push"
readonly target_hook

mkdir -p "${target_directory}"
if [[ -L "${target_hook}" ]]; then
  echo "Refusing to replace the symlinked pre-push hook at ${target_hook}" >&2
  exit 1
fi
if [[ -e "${target_hook}" ]] && ! cmp -s "${source_hook}" "${target_hook}"; then
  if ! grep -q '^# Managed by Stowplan local verification$' "${target_hook}"; then
    echo "Refusing to replace the existing pre-push hook at ${target_hook}" >&2
    exit 1
  fi
fi

cp "${source_hook}" "${target_hook}"
chmod 0755 "${target_hook}"
echo "[verify] installed ${target_hook}"
