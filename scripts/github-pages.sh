#!/bin/bash
# Configure and dispatch the docs-only GitHub Pages deployment

set -eu

usage() {
  cat <<'EOF'
Usage: scripts/github-pages.sh COMMAND

Commands:
  status   Show the repository Pages build type and URL
  enable   Create Pages or switch it to the GitHub Actions build type
  deploy   Dispatch, wait for, and verify the Documentation workflow
  -h       Show this help

Set GH_REPO to target a repository other than the current checkout.
EOF
}

error() {
  printf 'github-pages: %s\n' "$*" >&2
}

require_command() {
  local command_name
  command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    error "required command not found: $command_name"
    exit 69
  fi
}

read_pages() {
  local response
  response="$(gh api -i 'repos/{owner}/{repo}/pages' 2>/dev/null || true)"
  PAGES_STATUS="$(printf '%s' "$response" | awk 'NR == 1 {print $2}')"
  PAGES_BODY="$(printf '%s' "$response" | sed '1,/^[[:space:]]*$/d')"
}

command="${1:-}"
case "$command" in
  status|enable|deploy) ;;
  -h|--help|"")
    usage
    exit 0
    ;;
  *)
    error "unknown command: $command"
    usage >&2
    exit 64
    ;;
esac

require_command gh
require_command jq
gh auth status >/dev/null

if [ "$command" = "deploy" ]; then
  require_command curl
  default_branch="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')"
  head_sha="$(gh api "repos/{owner}/{repo}/commits/${default_branch}" --jq '.sha')"
  dispatched_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  gh workflow run docs.yml --ref "$default_branch"
  discovery_attempts="${PAGES_RUN_DISCOVERY_ATTEMPTS:-30}"
  case "$discovery_attempts" in
    *[!0-9]*|"")
      error "PAGES_RUN_DISCOVERY_ATTEMPTS must be a positive integer"
      exit 64
      ;;
  esac
  if [ "$discovery_attempts" -lt 1 ]; then
    error "PAGES_RUN_DISCOVERY_ATTEMPTS must be a positive integer"
    exit 64
  fi

  attempt=0
  run_id=""
  while [ "$attempt" -lt "$discovery_attempts" ] && [ -z "$run_id" ]; do
    run_id="$(
      gh run list \
        --workflow docs.yml \
        --branch "$default_branch" \
        --commit "$head_sha" \
        --event workflow_dispatch \
        --limit 10 \
        --json createdAt,databaseId |
        jq -r \
          --arg dispatched_at "$dispatched_at" \
          '[.[] | select(.createdAt >= $dispatched_at)] | sort_by(.createdAt) | last.databaseId // empty'
    )"
    [ -n "$run_id" ] || sleep 2
    attempt=$((attempt + 1))
  done
  if [ -z "$run_id" ]; then
    error "could not find the dispatched Documentation run"
    exit 1
  fi

  gh run watch "$run_id" --compact --exit-status
  read_pages
  if [ "$PAGES_STATUS" != "200" ]; then
    error "Documentation succeeded, but the Pages site could not be read"
    exit 1
  fi
  page_url="$(printf '%s' "$PAGES_BODY" | jq -r '.html_url // empty')"
  if [ -z "$page_url" ]; then
    error "Documentation succeeded, but Pages returned no public URL"
    exit 1
  fi
  curl --fail --silent --show-error --location --output /dev/null "$page_url"
  printf 'Verified Documentation run %s at %s\n' "$run_id" "$page_url"
  exit 0
fi

read_pages
case "$PAGES_STATUS" in
  200)
    build_type="$(printf '%s' "$PAGES_BODY" | jq -r '.build_type // "legacy"')"
    page_url="$(printf '%s' "$PAGES_BODY" | jq -r '.html_url // empty')"
    if [ "$command" = "status" ]; then
      printf 'build_type=%s\n' "$build_type"
      printf 'url=%s\n' "$page_url"
      exit 0
    fi
    if [ "$build_type" = "workflow" ]; then
      printf 'GitHub Pages already uses the GitHub Actions build type\n'
      exit 0
    fi
    printf '{"build_type":"workflow"}' | gh api \
      --method PUT \
      -H 'Accept: application/vnd.github+json' \
      'repos/{owner}/{repo}/pages' \
      --input - \
      --silent
    printf 'Changed GitHub Pages to the GitHub Actions build type\n'
    ;;
  404)
    if [ "$command" = "status" ]; then
      printf 'GitHub Pages is not enabled\n'
      exit 1
    fi
    printf '{"build_type":"workflow"}' | gh api \
      --method POST \
      -H 'Accept: application/vnd.github+json' \
      'repos/{owner}/{repo}/pages' \
      --input - \
      --silent
    printf 'Enabled GitHub Pages with the GitHub Actions build type\n'
    ;;
  *)
    error "could not read GitHub Pages state"
    [ -n "$PAGES_BODY" ] && printf '%s\n' "$PAGES_BODY" >&2
    exit 1
    ;;
esac
