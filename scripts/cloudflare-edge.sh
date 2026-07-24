#!/bin/bash
# Reconcile Stowplan-owned Cloudflare WAF and rate limiting rules

set -eu

script_dir="$(
  unset CDPATH
  cd -- "$(dirname -- "$0")"
  pwd
)"
default_config="$script_dir/../cloudflare/edge-rules.json"
api_root="https://api.cloudflare.com/client/v4"

usage() {
  cat <<'EOF'
Usage: scripts/cloudflare-edge.sh COMMAND [options]

Commands:
  check                  Validate the local configuration without credentials
  plan                   Read Cloudflare state and print proposed changes
  apply                  Reconcile Cloudflare state to the selected profile

Options:
  --config PATH          Configuration file
  --profile NAME         Plan profile from the configuration
  --prune                Remove stale rules owned by the configured prefix
  -h, --help             Show this help

Environment:
  CLOUDFLARE_API_TOKEN   Token with Zone:Read and Zone WAF:Edit
  CLOUDFLARE_ACCOUNT_ID  Account containing the configured zone
EOF
}

error() {
  printf 'cloudflare-edge: %s\n' "$*" >&2
}

info() {
  printf 'cloudflare-edge: %s\n' "$*" >&2
}

require_command() {
  local command_name
  command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    error "required command not found: $command_name"
    exit 69
  fi
}

api_call() {
  local method
  local endpoint
  local payload
  local payload_file
  local response
  local curl_status
  method="$1"
  endpoint="$2"
  payload="${3:-}"
  payload_file=""

  if [ -n "$payload" ]; then
    payload_file="$(mktemp "${TMPDIR:-/tmp}/stowplan-cloudflare-payload.XXXXXX")"
    chmod 600 "$payload_file"
    printf '%s' "$payload" > "$payload_file"
    response="$(
      printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" |
        (
          unset CLOUDFLARE_API_TOKEN
          curl -q -sS -w '\n%{http_code}' \
            -X "$method" \
            -H @- \
            -H 'Content-Type: application/json' \
            --data-binary "@$payload_file" \
            "$api_root$endpoint"
        )
    )" || {
      curl_status="$?"
      rm -f "$payload_file"
      return "$curl_status"
    }
    rm -f "$payload_file"
  else
    response="$(
      printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" |
        (
          unset CLOUDFLARE_API_TOKEN
          curl -q -sS -w '\n%{http_code}' \
            -X "$method" \
            -H @- \
            "$api_root$endpoint"
        )
    )"
  fi

  API_STATUS="$(printf '%s' "$response" | tail -n 1)"
  API_BODY="$(printf '%s' "$response" | sed '$d')"
}

require_api_success() {
  local operation
  operation="$1"
  case "$API_STATUS" in
    2??) ;;
    *)
      error "$operation returned HTTP $API_STATUS"
      printf '%s\n' "$API_BODY" | jq -c '{errors, messages}' >&2 || true
      exit 1
      ;;
  esac
  if [ "$(printf '%s' "$API_BODY" | jq -r '.success // false')" != "true" ]; then
    error "$operation returned an API error"
    printf '%s\n' "$API_BODY" | jq -c '{errors, messages}' >&2
    exit 1
  fi
}

validate_config() {
  local server_limits_file
  local sync_formula
  local snapshot_formula
  local sync_limit
  local snapshot_limit
  local configured_limit
  local edge_limits
  if ! jq -e '
    (.zone_name | type == "string" and length > 0)
    and (.managed_description_prefix | type == "string" and length > 0)
    and (.default_profile | type == "string" and length > 0)
    and (.data_request_body_limit_bytes | type == "number" and . > 0)
    and (.profiles | type == "object" and length > 0)
    and (.profiles[.default_profile] != null)
    and all(
      .profiles[];
      (.phases | type == "object")
      and (.phases.http_request_firewall_custom | type == "array")
      and (.phases.http_ratelimit | type == "array")
    )
  ' "$config" >/dev/null; then
    error "invalid configuration structure: $config"
    exit 65
  fi

  if ! jq -e --arg prefix "$managed_prefix" --arg profile "$profile" '
    .profiles[$profile] as $selected
    | $selected != null
      and (
        [$selected.phases[][] | .description] as $descriptions
        | ($descriptions | length) == ($descriptions | unique | length)
      )
      and all(
        $selected.phases[][];
        (.description | type == "string" and startswith($prefix))
        and (.expression | type == "string" and length > 0)
        and (.action | type == "string" and length > 0)
        and (.enabled | type == "boolean")
      )
      and all(
        $selected.phases.http_ratelimit[];
        (.ratelimit.characteristics | type == "array" and length >= 2)
        and (.ratelimit.characteristics[0] == "cf.colo.id")
        and (.ratelimit.period | type == "number")
        and (.ratelimit.requests_per_period | type == "number")
        and (.ratelimit.mitigation_timeout | type == "number")
      )
  ' "$config" >/dev/null; then
    error "profile '$profile' is missing, duplicates descriptions, or contains invalid rules"
    exit 65
  fi

  server_limits_file="$script_dir/../src/server/request-body.ts"
  if [ -f "$server_limits_file" ]; then
    sync_formula="$(sed -n 's/^export const SYNC_REQUEST_MAX_BYTES = \([0-9][0-9]*\) \* \([0-9][0-9]*\) \* \([0-9][0-9]*\);$/\1 * \2 * \3/p' "$server_limits_file")"
    snapshot_formula="$(sed -n 's/^export const SNAPSHOT_REQUEST_MAX_BYTES = \([0-9][0-9]*\) \* \([0-9][0-9]*\) \* \([0-9][0-9]*\);$/\1 * \2 * \3/p' "$server_limits_file")"
    if [ -z "$sync_formula" ] || [ -z "$snapshot_formula" ]; then
      error "could not read server request-body constants"
      exit 65
    fi
    sync_limit=$((sync_formula))
    snapshot_limit=$((snapshot_formula))
    configured_limit="$(jq -r '.data_request_body_limit_bytes' "$config")"
    if [ "$sync_limit" -ne "$snapshot_limit" ] || [ "$sync_limit" -ne "$configured_limit" ]; then
      error "Cloudflare and server data request-body limits differ"
      exit 65
    fi
    edge_limits="$(jq -r '
      [
        .profiles.enterprise_advanced.phases.http_request_firewall_custom[]
        | select(.description == "[stowplan] Block oversized data API request bodies")
        | .expression
        | try capture("http\\.request\\.body\\.size gt (?<bytes>[0-9]+)").bytes
      ]
      | map(select(. != null))
      | unique
      | .[]
    ' "$config")"
    if [ "$edge_limits" != "$configured_limit" ]; then
      error "Enterprise edge rules do not match data_request_body_limit_bytes"
      exit 65
    fi
  fi
}

check_profile_entitlement() {
  local plan_name
  local plan_class
  plan_name="$1"
  plan_class="$(printf '%s' "$plan_name" | tr '[:upper:]' '[:lower:]')"
  case "$plan_class:$profile" in
    *free*:free|*pro*:free|*pro*:pro|*business*:free|*business*:pro|*business*:business|*enterprise*:*)
      return 0
      ;;
    *free*:*)
      error "Cloudflare reports '$plan_name'; select the free profile"
      exit 65
      ;;
    *pro*:*)
      error "Cloudflare reports '$plan_name'; select the free or pro profile"
      exit 65
      ;;
    *business*:*)
      error "Cloudflare reports '$plan_name'; select free, pro, or business"
      exit 65
      ;;
    *)
      info "could not map plan '$plan_name' to a profile; Cloudflare will validate feature availability"
      ;;
  esac
}

rule_matches() {
  local remote_rule
  local desired_rule
  remote_rule="$1"
  desired_rule="$2"
  jq -en --argjson actual "$remote_rule" --argjson desired "$desired_rule" '
    def subset($actual; $wanted):
      if ($wanted | type) == "object" then
        [
          ($wanted | keys[]) as $key
          |
          ($actual | has($key)) and subset($actual[$key]; $wanted[$key])
        ]
        | all
      else
        $actual == $wanted
      end;
    subset($actual; ($desired | del(.position)))
  ' >/dev/null
}

print_payload() {
  local payload
  payload="$1"
  printf '%s\n' "$payload" | jq .
}

prune_stale_rules() {
  local phase
  local ruleset_id
  local stale_rules
  local stale_rule
  local stale_description
  local stale_id
  phase="$1"
  ruleset_id="$2"
  stale_rules="$3"

  while IFS= read -r stale_rule; do
    [ -n "$stale_rule" ] || continue
    stale_description="$(printf '%s' "$stale_rule" | jq -r '.description')"
    stale_id="$(printf '%s' "$stale_rule" | jq -r '.id')"
    if [ "$command" = "plan" ]; then
      info "$phase: would delete stale managed rule '$stale_description'"
    else
      api_call DELETE "/zones/$zone_id/rulesets/$ruleset_id/rules/$stale_id"
      require_api_success "delete '$stale_description'"
      info "$phase: deleted stale managed rule '$stale_description'"
    fi
  done <<EOF
$(printf '%s' "$stale_rules" | jq -c '.[]')
EOF
}

validate_remote_expressions() {
  local expression
  local payload
  while IFS= read -r expression; do
    [ -n "$expression" ] || continue
    payload="$(jq -cn --arg expression "$expression" '{expression: $expression}')"
    api_call POST "/filters/validate-expr" "$payload"
    require_api_success "validate Cloudflare rule expression"
  done <<EOF
$(jq -r --arg profile "$profile" '[.profiles[$profile].phases[][] | .expression] | unique[]' "$config")
EOF
  info "Cloudflare accepted every expression in profile '$profile'"
}

reconcile_phase() {
  local phase
  local desired_count
  local response
  local ruleset_id
  local existing_rules
  local unrelated_rate_count
  local create_payload
  local desired_rule
  local description
  local match_count
  local remote_rule
  local rule_id
  local payload
  local rule_index
  local stale_rules
  local stale_count
  local stale_rate_skip_count
  phase="$1"
  desired_count="$(jq -r --arg profile "$profile" --arg phase "$phase" '.profiles[$profile].phases[$phase] | length' "$config")"

  api_call GET "/zones/$zone_id/rulesets/phases/$phase/entrypoint"
  if [ "$API_STATUS" = "404" ]; then
    if [ "$desired_count" -eq 0 ]; then
      info "$phase: no entry point and no configured rules"
      return
    fi
    create_payload="$(jq -c --arg profile "$profile" --arg phase "$phase" '
      {
        name: ("stowplan-" + $phase),
        kind: "zone",
        phase: $phase,
        rules: [.profiles[$profile].phases[$phase][] | del(.position)]
      }
    ' "$config")"
    if [ "$command" = "plan" ]; then
      info "$phase: would create entry point with $desired_count managed rule(s)"
      print_payload "$create_payload"
      return
    fi
    api_call POST "/zones/$zone_id/rulesets" "$create_payload"
    require_api_success "create $phase entry point"
    info "$phase: created entry point with $desired_count managed rule(s)"
    return
  fi
  require_api_success "read $phase entry point"

  response="$API_BODY"
  ruleset_id="$(printf '%s' "$response" | jq -r '.result.id')"
  existing_rules="$(printf '%s' "$response" | jq -c '.result.rules // []')"
  if [ "$phase" = "http_ratelimit" ] && [ "$profile" = "free" ]; then
    unrelated_rate_count="$(printf '%s' "$existing_rules" | jq -r --arg prefix "$managed_prefix" '[.[] | select((.description // "") | startswith($prefix) | not)] | length')"
    if [ "$unrelated_rate_count" -gt 0 ]; then
      error "the free profile cannot coexist with unrelated zone rate rules"
      error "its hostname guard skips the entire rate-limit phase on other hosts"
      exit 65
    fi
  fi
  stale_rules="$(jq -cn \
    --argjson existing "$existing_rules" \
    --arg prefix "$managed_prefix" \
    --argjson desired "$(jq -c --arg profile "$profile" --arg phase "$phase" '[.profiles[$profile].phases[$phase][].description]' "$config")" '
      [
        $existing[]
        | select(.description | startswith($prefix))
        | select(.description as $description | $desired | index($description) | not)
      ]
    ')"

  stale_count="$(printf '%s' "$stale_rules" | jq 'length')"
  stale_rate_skip_count="$(printf '%s' "$stale_rules" | jq '
    [
      .[]
      | select(.action == "skip")
      | select(
          (.action_parameters.phases // [])
          | index("http_ratelimit")
      )
    ]
    | length
  ')"
  if [ "$phase" = "http_request_firewall_custom" ] &&
    [ "$profile" != "free" ] &&
    [ "$stale_rate_skip_count" -gt 0 ] &&
    [ "$prune" != "true" ]; then
    error "$phase: switching away from the free profile requires --prune"
    error "the stale hostname guard would continue skipping sibling-host rate limits"
    exit 65
  fi
  if [ "$stale_count" -gt 0 ] && [ "$prune" != "true" ]; then
    info "$phase: stale managed rules remain; rerun with --prune for exact convergence"
    printf '%s\n' "$stale_rules" | jq -r '.[].description | "  " + .' >&2
  fi
  if [ "$prune" = "true" ] &&
    [ "$phase" = "http_ratelimit" ] &&
    [ "$profile" = "free" ] &&
    [ "$stale_count" -gt 0 ]; then
    info "$phase: pruning stale managed rules before creating the constrained free rule"
    prune_stale_rules "$phase" "$ruleset_id" "$stale_rules"
    stale_rules="[]"
  fi

  rule_index=0
  while IFS= read -r desired_rule; do
    [ -n "$desired_rule" ] || continue
    rule_index=$((rule_index + 1))
    description="$(printf '%s' "$desired_rule" | jq -r '.description')"
    match_count="$(printf '%s' "$existing_rules" | jq -r --arg description "$description" '[.[] | select(.description == $description)] | length')"
    if [ "$match_count" -gt 1 ]; then
      error "$phase contains duplicate remote rules named '$description'"
      exit 65
    fi

    payload="$(printf '%s' "$desired_rule" | jq -c 'del(.position)')"
    if [ "$phase" = "http_request_firewall_custom" ]; then
      payload="$(printf '%s' "$payload" | jq -c --argjson index "$rule_index" '. + {position: {index: $index}}')"
    fi

    if [ "$match_count" -eq 0 ]; then
      if [ "$command" = "plan" ]; then
        info "$phase: would create '$description'"
        print_payload "$payload"
      else
        api_call POST "/zones/$zone_id/rulesets/$ruleset_id/rules" "$payload"
        require_api_success "create '$description'"
        info "$phase: created '$description'"
      fi
      continue
    fi

    remote_rule="$(printf '%s' "$existing_rules" | jq -c --arg description "$description" '.[] | select(.description == $description)')"
    rule_id="$(printf '%s' "$remote_rule" | jq -r '.id')"
    if rule_matches "$remote_rule" "$desired_rule"; then
      info "$phase: '$description' is current"
      continue
    fi

    if [ "$command" = "plan" ]; then
      info "$phase: would update '$description'"
      print_payload "$payload"
    else
      api_call PATCH "/zones/$zone_id/rulesets/$ruleset_id/rules/$rule_id" "$payload"
      require_api_success "update '$description'"
      info "$phase: updated '$description'"
    fi
  done <<EOF
$(jq -c --arg profile "$profile" --arg phase "$phase" '.profiles[$profile].phases[$phase][]' "$config")
EOF

  if [ "$prune" = "true" ]; then
    prune_stale_rules "$phase" "$ruleset_id" "$stale_rules"
  fi
}

command="${1:-}"
case "$command" in
  check|plan|apply) shift ;;
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

config="$default_config"
profile=""
prune="false"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || {
        error "--config requires a path"
        exit 64
      }
      config="$2"
      shift 2
      ;;
    --profile)
      [ "$#" -ge 2 ] || {
        error "--profile requires a name"
        exit 64
      }
      profile="$2"
      shift 2
      ;;
    --prune)
      prune="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "unknown option: $1"
      usage >&2
      exit 64
      ;;
  esac
done

require_command jq
[ -f "$config" ] || {
  error "configuration not found: $config"
  exit 66
}
jq empty "$config"

managed_prefix="$(jq -r '.managed_description_prefix // empty' "$config")"
if [ -z "$profile" ]; then
  profile="$(jq -r '.default_profile // empty' "$config")"
fi
validate_config

custom_count="$(jq -r --arg profile "$profile" '.profiles[$profile].phases.http_request_firewall_custom | length' "$config")"
rate_count="$(jq -r --arg profile "$profile" '.profiles[$profile].phases.http_ratelimit | length' "$config")"
info "configuration is valid: profile=$profile, custom=$custom_count, rate=$rate_count"
if [ "$command" = "check" ]; then
  exit 0
fi

require_command curl
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || {
  error "CLOUDFLARE_API_TOKEN is unset"
  exit 78
}
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || {
  error "CLOUDFLARE_ACCOUNT_ID is unset"
  exit 78
}

zone_name="$(jq -r '.zone_name' "$config")"
api_call GET "/zones?account.id=$CLOUDFLARE_ACCOUNT_ID&name=$zone_name"
require_api_success "look up zone '$zone_name'"
zone_count="$(printf '%s' "$API_BODY" | jq -r '.result | length')"
if [ "$zone_count" -ne 1 ]; then
  error "expected one zone named '$zone_name' in the configured account, found $zone_count"
  exit 65
fi
zone_id="$(printf '%s' "$API_BODY" | jq -r '.result[0].id')"
plan_name="$(printf '%s' "$API_BODY" | jq -r '.result[0].plan.name // "unknown"')"
check_profile_entitlement "$plan_name"
info "zone '$zone_name' uses '$plan_name'"

validate_remote_expressions
reconcile_phase http_request_firewall_custom
reconcile_phase http_ratelimit
info "$command completed for profile '$profile'"
