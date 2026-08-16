#!/bin/bash
# Refuses npm version outside the release branch
set -euo pipefail

readonly EXPECTED_BRANCH="main"

branch=""
branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

if [ "${branch}" != "${EXPECTED_BRANCH}" ]; then
  echo "npm version requires branch ${EXPECTED_BRANCH}; found ${branch:-detached HEAD or non-Git checkout}" >&2
  exit 1
fi
