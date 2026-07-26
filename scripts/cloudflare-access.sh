#!/bin/bash
# Run the testable Node Access reconciler

set -eu

script_dir="$(
  unset CDPATH
  cd -- "$(dirname -- "$0")"
  pwd
)"

exec node "$script_dir/cloudflare-access.mjs" "$@"
