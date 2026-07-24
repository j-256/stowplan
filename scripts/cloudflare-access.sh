#!/bin/bash
# Reconcile the Stowplan Cloudflare Access application and allow policy

set -eu

script_dir="$(
  unset CDPATH
  cd -- "$(dirname -- "$0")"
  pwd
)"
default_config="$script_dir/../cloudflare/access.json"
api_root="https://api.cloudflare.com/client/v4"

usage() {
  cat <<'EOF'
Usage: scripts/cloudflare-access.sh COMMAND [options]

Commands:
  check                  Validate the local configuration without credentials
  plan                   Read Cloudflare state and print proposed changes
  apply                  Reconcile the Access application and allow policy

Options:
  --config PATH          Configuration file
  -h, --help             Show this help

Environment:
  CLOUDFLARE_API_TOKEN   Token with Access: Apps and Policies Write plus
                         Organizations, Identity Providers, and Groups Read
  CLOUDFLARE_ACCOUNT_ID  Account containing the Access organization
  STOWPLAN_ACCESS_EMAILS Comma-separated allowlist merged with policy.allowed_emails

The checked-in configuration leaves policy.allowed_emails empty. Supply at least
one address through STOWPLAN_ACCESS_EMAILS or a private configuration file when
running plan or apply.
EOF
}

error() {
  printf 'cloudflare-access: %s\n' "$*" >&2
}

info() {
  printf 'cloudflare-access: %s\n' "$*" >&2
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
  if ! jq -e '
    (.application.name | type == "string" and length > 0)
    and (.application.type == "self_hosted")
    and (.application.domain | type == "string" and length > 0)
    and (.application.destinations | type == "array" and length > 0)
    and all(
      .application.destinations[];
      .type == "public" and (.uri | type == "string" and length > 0)
    )
    and (.application.allowed_idps == null)
    and (.application.policies == null)
    and (.identity_provider.name | type == "string" and length > 0)
    and (.identity_provider.type | type == "string" and length > 0)
    and (.policy.name | type == "string" and length > 0)
    and (.policy.decision == "allow")
    and (.policy.precedence | type == "number")
    and (.policy.session_duration | type == "string" and length > 0)
    and (.policy.allowed_emails | type == "array")
    and all(.policy.allowed_emails[]; type == "string")
  ' "$config" >/dev/null; then
    error "invalid configuration structure: $config"
    exit 65
  fi
}

json_subset() {
  local actual
  local desired
  actual="$1"
  desired="$2"
  jq -en --argjson actual "$actual" --argjson desired "$desired" '
    def subset($current; $wanted):
      if ($wanted | type) == "object" then
        [
          ($wanted | keys[]) as $key
          |
          ($current | has($key)) and subset($current[$key]; $wanted[$key])
        ]
        | all
      else
        $current == $wanted
      end;
    subset($actual; $desired)
  ' >/dev/null
}

load_allowed_emails() {
  local configured
  configured="$(jq -c '.policy.allowed_emails' "$config")"
  allowed_emails="$(jq -cn \
    --argjson configured "$configured" \
    --arg supplied "${STOWPLAN_ACCESS_EMAILS:-}" '
      (
        $configured
        + (
          $supplied
          | split(",")
          | map(gsub("^[[:space:]]+|[[:space:]]+$"; ""))
          | map(select(length > 0))
        )
      )
      | map(ascii_downcase)
      | unique
    ')"
  if ! printf '%s' "$allowed_emails" | jq -e '
    all(.[];
      test("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$")
    )
  ' >/dev/null; then
    error "the Access allowlist contains an invalid email address"
    exit 65
  fi
}

print_sites_environment() {
  local team_domain
  local audience
  team_domain="$1"
  audience="$2"
  if [ -z "$team_domain" ] || [ -z "$audience" ]; then
    return
  fi
  printf '\n# Add these values to the Sites runtime environment\n'
  printf 'export AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN=%q\n' "$team_domain"
  printf 'export AUTH_CLOUDFLARE_ACCESS_AUD=%q\n' "$audience"
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
validate_config
load_allowed_emails
email_count="$(printf '%s' "$allowed_emails" | jq 'length')"
info "configuration is valid with $email_count allowed identity address(es)"
if [ "$command" = "check" ]; then
  exit 0
fi
if [ "$email_count" -eq 0 ]; then
  error "plan and apply require at least one allowed identity address"
  exit 78
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

account_path="/accounts/$CLOUDFLARE_ACCOUNT_ID"
api_call GET "$account_path/access/organizations"
require_api_success "read Access organization"
team_domain="$(printf '%s' "$API_BODY" | jq -r '.result.auth_domain // empty')"
if [ -z "$team_domain" ]; then
  error "the Access organization does not report an auth_domain"
  exit 65
fi

idp_name="$(jq -r '.identity_provider.name' "$config")"
idp_type="$(jq -r '.identity_provider.type' "$config")"
api_call GET "$account_path/access/identity_providers"
require_api_success "list Access identity providers"
idp_matches="$(printf '%s' "$API_BODY" | jq -c --arg name "$idp_name" --arg type "$idp_type" '[.result[] | select(.name == $name and .type == $type)]')"
idp_count="$(printf '%s' "$idp_matches" | jq 'length')"
if [ "$idp_count" -ne 1 ]; then
  error "expected one identity provider named '$idp_name' with type '$idp_type', found $idp_count"
  exit 65
fi
idp_id="$(printf '%s' "$idp_matches" | jq -r '.[0].id')"

application_name="$(jq -r '.application.name' "$config")"
application_payload="$(jq -c --arg idp "$idp_id" '.application + {allowed_idps: [$idp]}' "$config")"
api_call GET "$account_path/access/apps?per_page=100"
require_api_success "list Access applications"
application_matches="$(printf '%s' "$API_BODY" | jq -c --arg name "$application_name" '[.result[] | select(.name == $name and .type == "self_hosted")]')"
application_count="$(printf '%s' "$application_matches" | jq 'length')"
if [ "$application_count" -gt 1 ]; then
  error "multiple self-hosted Access applications are named '$application_name'"
  exit 65
fi

application_id=""
application_aud=""
existing_application=""
if [ "$application_count" -eq 1 ]; then
  existing_application="$(printf '%s' "$application_matches" | jq -c '.[0]')"
  application_id="$(printf '%s' "$existing_application" | jq -r '.id')"
  application_aud="$(printf '%s' "$existing_application" | jq -r '.aud // empty')"

  api_call GET "$account_path/access/apps/$application_id/policies?per_page=100"
  require_api_success "list existing application policies"
  preflight_policies="$(printf '%s' "$API_BODY" | jq -c '.result // []')"
  unexpected_policy_count="$(printf '%s' "$preflight_policies" | jq -r --arg name "$(jq -r '.policy.name' "$config")" '[.[] | select(.name != $name)] | length')"
  if [ "$unexpected_policy_count" -gt 0 ]; then
    error "the managed application has unexpected policies; review them before reconciliation"
    printf '%s' "$preflight_policies" | jq -r --arg name "$(jq -r '.policy.name' "$config")" '.[] | select(.name != $name) | "  " + .name' >&2
    exit 65
  fi
fi

if [ "$application_count" -eq 0 ]; then
  if [ "$command" = "plan" ]; then
    info "would create Access application '$application_name'"
    info "would create its allow policy for $email_count configured address(es)"
    info "the Sites environment values become available after apply"
    exit 0
  fi
  api_call POST "$account_path/access/apps" "$application_payload"
  require_api_success "create Access application '$application_name'"
  application_id="$(printf '%s' "$API_BODY" | jq -r '.result.id')"
  application_aud="$(printf '%s' "$API_BODY" | jq -r '.result.aud // empty')"
  info "created Access application '$application_name'"
elif json_subset "$existing_application" "$application_payload"; then
  info "Access application '$application_name' is current"
else
  if [ "$command" = "plan" ]; then
    info "would update Access application '$application_name'"
  else
    api_call PUT "$account_path/access/apps/$application_id" "$application_payload"
    require_api_success "update Access application '$application_name'"
    application_aud="$(printf '%s' "$API_BODY" | jq -r '.result.aud // empty')"
    info "updated Access application '$application_name'"
  fi
fi

policy_name="$(jq -r '.policy.name' "$config")"
policy_payload="$(jq -cn \
  --argjson policy "$(jq -c '.policy | del(.allowed_emails)' "$config")" \
  --argjson emails "$allowed_emails" '
    $policy + {
      include: [$emails[] | {email: {email: .}}],
      exclude: [],
      require: []
    }
  ')"

api_call GET "$account_path/access/apps/$application_id/policies?per_page=100"
require_api_success "list application policies"
policies="$(printf '%s' "$API_BODY" | jq -c '.result // []')"
unexpected_policy_count="$(printf '%s' "$policies" | jq -r --arg name "$policy_name" '[.[] | select(.name != $name)] | length')"
if [ "$unexpected_policy_count" -gt 0 ]; then
  error "the managed application has unexpected policies after application reconciliation"
  printf '%s' "$policies" | jq -r --arg name "$policy_name" '.[] | select(.name != $name) | "  " + .name' >&2
  exit 65
fi
policy_matches="$(printf '%s' "$policies" | jq -c --arg name "$policy_name" '[.[] | select(.name == $name)]')"
policy_count="$(printf '%s' "$policy_matches" | jq 'length')"
if [ "$policy_count" -gt 1 ]; then
  error "multiple application policies are named '$policy_name'"
  exit 65
fi

if [ "$policy_count" -eq 0 ]; then
  if [ "$command" = "plan" ]; then
    info "would create allow policy '$policy_name' for $email_count configured address(es)"
  else
    api_call POST "$account_path/access/apps/$application_id/policies" "$policy_payload"
    require_api_success "create allow policy '$policy_name'"
    info "created allow policy '$policy_name'"
  fi
else
  existing_policy="$(printf '%s' "$policy_matches" | jq -c '.[0]')"
  policy_id="$(printf '%s' "$existing_policy" | jq -r '.id')"
  if json_subset "$existing_policy" "$policy_payload"; then
    info "allow policy '$policy_name' is current"
  elif [ "$command" = "plan" ]; then
    info "would update allow policy '$policy_name' for $email_count configured address(es)"
  else
    api_call PUT "$account_path/access/apps/$application_id/policies/$policy_id" "$policy_payload"
    require_api_success "update allow policy '$policy_name'"
    info "updated allow policy '$policy_name'"
  fi
fi

print_sites_environment "$team_domain" "$application_aud"
info "$command completed"
