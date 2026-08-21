#!/bin/bash
set -euo pipefail

project_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root
cd "${project_root}"

npm run test:e2e
