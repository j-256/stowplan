#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
output="${1:-${project_root}/work/stowplan-sites.tar.gz}"

case "${output}" in
  /*) ;;
  *) output="${project_root}/${output}" ;;
esac

mkdir -p "$(dirname "${output}")"
"${script_dir}/validate-artifact.sh"

tar \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --exclude=".DS_Store" \
  --exclude="*/.DS_Store" \
  --exclude=".dev.vars" \
  --exclude="*/.dev.vars" \
  --exclude=".env" \
  --exclude=".env.*" \
  --exclude="*/.env" \
  --exclude="*/.env.*" \
  -czf "${output}" \
  -C "${project_root}" \
  dist

if ! tar -tzf "${output}" \
  dist/server/index.js \
  dist/.openai/hosting.json \
  >/dev/null; then
  echo "The Sites archive is missing its deployable dist entrypoints" >&2
  exit 65
fi

if tar -tzf "${output}" | grep -Eq '(^|/)(\.DS_Store|\.dev\.vars|\.env(\..*)?)$'; then
  echo "The Sites archive contains local metadata" >&2
  exit 65
fi

echo "${output}"
