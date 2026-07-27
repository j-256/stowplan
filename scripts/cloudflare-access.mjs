#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_ROOT = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
export const POST_MUTATION_VERIFICATION_READ_LIMIT = 5;
export const POST_MUTATION_VERIFICATION_INITIAL_BACKOFF_MS = 250;
export const POST_MUTATION_VERIFICATION_MAX_BACKOFF_MS = 2_000;
const RESOURCE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
const DURATION_PATTERN = /^(?:[1-9][0-9]*)(?:ms|s|m|h)$/;
const SNAPSHOT_SCHEMA_VERSION = 2;
const SNAPSHOT_MUTATION_STATES = new Set([
  "not_started",
  "pending",
  "applied",
  "rolled_back",
]);
const MFA_AUTHENTICATORS = new Set([
  "biometrics",
  "security_key",
  "totp",
]);
const FORBIDDEN_SNAPSHOT_KEY = /(assertion|email|password|secret|token)/i;
const EMAIL_VALUE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const APP_WRITABLE_FIELDS = [
  "allow_authenticate_via_warp",
  "allow_iframe",
  "allowed_idps",
  "app_launcher_visible",
  "auto_redirect_to_identity",
  "cors_headers",
  "custom_deny_message",
  "custom_deny_url",
  "custom_non_identity_deny_url",
  "custom_pages",
  "destinations",
  "domain",
  "eager_redirect_cookie_setting",
  "enable_binding_cookie",
  "http_only_cookie_attribute",
  "logo_url",
  "mfa_config",
  "name",
  "oauth_configuration",
  "options_preflight_bypass",
  "path_cookie_attribute",
  "policies",
  "read_service_tokens_from_header",
  "same_site_cookie_attribute",
  "scim_config",
  "self_hosted_domains",
  "service_auth_401_redirect",
  "session_duration",
  "skip_interstitial",
  "tags",
  "type",
  "use_clientless_isolation_app_launcher_url",
];

export class AccessReconcileError extends Error {
  constructor(message, exitCode = 65) {
    super(message);
    this.name = "AccessReconcileError";
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 65) {
  throw new AccessReconcileError(message, exitCode);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    fail(`${label} must be an object`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
}

function requireDuration(value, label) {
  requireNonEmptyString(value, label);
  if (!DURATION_PATTERN.test(value)) {
    fail(`${label} must use a supported duration unit`);
  }
}

function requireResourceArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  const keys = new Set();
  for (const resource of value) {
    requireObject(resource, `${label} entry`);
    if (!RESOURCE_KEY_PATTERN.test(resource.key ?? "")) {
      fail(`${label} entries require a stable lowercase key`);
    }
    if (keys.has(resource.key)) {
      fail(`${label} contains duplicate key '${resource.key}'`);
    }
    keys.add(resource.key);
    requireNonEmptyString(resource.name, `${label}.${resource.key}.name`);
  }
}

function validateAdoption(adopt, label) {
  requireObject(adopt, `${label}.adopt`);
  if (
    !Array.isArray(adopt.aliases)
    || !adopt.aliases.every((alias) => typeof alias === "string" && alias.length > 0)
  ) {
    fail(`${label}.adopt.aliases must contain non-empty strings`);
  }
  if (
    !Array.isArray(adopt.fingerprints)
    || !adopt.fingerprints.every(isObject)
  ) {
    fail(`${label}.adopt.fingerprints must contain objects`);
  }
}

function ruleSelectorTypes(rules) {
  return rules.map((rule) => Object.keys(rule).sort().join(","));
}

function containsForbiddenIdentitySelector(rules) {
  const forbidden = new Set([
    "email",
    "email_domain",
    "email_list",
    "everyone",
  ]);
  return ruleSelectorTypes(rules).some((selector) => forbidden.has(selector));
}

function parsePublicDestination(uri) {
  if (
    typeof uri !== "string"
    || uri.length === 0
    || uri.includes("://")
    || uri.includes("?")
    || uri.includes("#")
  ) {
    fail("Access public destinations must be host-and-path values without a scheme, query, or fragment");
  }
  const slashIndex = uri.indexOf("/");
  const host = slashIndex === -1 ? uri : uri.slice(0, slashIndex);
  const path = slashIndex === -1 ? "/*" : uri.slice(slashIndex);
  if (host.length === 0 || host.includes(":")) {
    fail("Access public destinations must use a hostname without a port");
  }
  return { host: host.toLowerCase(), path };
}

function validatePolicy(policy, organizationGuard) {
  const label = `reusable_policies.${policy.key}`;
  if (policy.decision !== "allow") {
    fail(`${label}.decision must be 'allow'`);
  }
  for (const field of ["include", "exclude", "require"]) {
    if (!Array.isArray(policy[field]) || !policy[field].every(isObject)) {
      fail(`${label}.${field} must contain rule objects`);
    }
  }
  if (policy.include.length === 0) {
    fail(`${label}.include must not be empty`);
  }
  if (
    containsForbiddenIdentitySelector([
      ...policy.include,
      ...policy.exclude,
      ...policy.require,
    ])
  ) {
    fail(`${label} cannot use email, email-domain, email-list, or everyone selectors`);
  }
  if (
    policy.include.some(
      (rule) => Object.keys(rule).length !== 1
        || !Object.hasOwn(rule, "cloudflare_account_member")
        || !isObject(rule.cloudflare_account_member),
    )
  ) {
    fail(`${label}.include must use Cloudflare account membership`);
  }
  requireDuration(policy.session_duration, `${label}.session_duration`);
  if (policy.session_duration !== "2h") {
    fail(`${label}.session_duration must be '2h'`);
  }
  requireObject(policy.mfa_config, `${label}.mfa_config`);
  if (policy.mfa_config.mfa_disabled !== false) {
    fail(`${label}.mfa_config must require independent MFA`);
  }
  const authenticators = policy.mfa_config.allowed_authenticators;
  if (
    !Array.isArray(authenticators)
    || authenticators.length === 0
    || !authenticators.every((value) => MFA_AUTHENTICATORS.has(value))
  ) {
    fail(`${label}.mfa_config.allowed_authenticators is invalid`);
  }
  if (authenticators.includes("totp")) {
    fail(`${label} must use a WebAuthn authenticator rather than TOTP`);
  }
  const requiredAtOrganization = new Set(
    organizationGuard.required_mfa_authenticators,
  );
  for (const authenticator of authenticators) {
    if (!requiredAtOrganization.has(authenticator)) {
      fail(`${label} requests an authenticator absent from the organization guard`);
    }
  }
  validateAdoption(policy.adopt, label);
}

function validateApplication(application, idpKeys, policyKeys) {
  const label = `applications.${application.key}`;
  if (application.type !== "self_hosted") {
    fail(`${label}.type must be 'self_hosted'`);
  }
  requireNonEmptyString(application.domain, `${label}.domain`);
  requireDuration(application.session_duration, `${label}.session_duration`);
  if (application.session_duration !== "2h") {
    fail(`${label}.session_duration must be '2h'`);
  }
  for (const [field, expected] of [
    ["app_launcher_visible", false],
    ["auto_redirect_to_identity", true],
    ["allow_authenticate_via_warp", false],
    ["http_only_cookie_attribute", true],
    ["options_preflight_bypass", false],
  ]) {
    if (application[field] !== expected) {
      fail(`${label}.${field} must be ${String(expected)}`);
    }
  }
  if (!Array.isArray(application.destinations) || application.destinations.length === 0) {
    fail(`${label}.destinations must not be empty`);
  }
  for (const destination of application.destinations) {
    if (
      !isObject(destination)
      || destination.type !== "public"
      || typeof destination.uri !== "string"
    ) {
      fail(`${label}.destinations must contain public URI objects`);
    }
    const { path } = parsePublicDestination(destination.uri);
    if (
      path.startsWith("/account")
      || path.startsWith("/api/auth")
      || path.startsWith("/api/sync")
      || path.startsWith("/api/snapshot")
    ) {
      fail(`${label} contains an ordinary-user or data-plane destination`);
    }
  }
  if (!application.destinations.some(({ uri }) => uri === application.domain)) {
    fail(`${label}.domain must be an exact configured destination`);
  }
  if (application.key === "admin") {
    const { host } = parsePublicDestination(application.domain);
    const expectedDestinations = [
      `${host}/admin`,
      `${host}/admin/*`,
      `${host}/api/admin`,
      `${host}/api/admin/*`,
    ].sort();
    const actualDestinations = application.destinations
      .map(({ uri }) => uri)
      .sort();
    if (canonicalJson(actualDestinations) !== canonicalJson(expectedDestinations)) {
      fail(`${label}.destinations must contain the exact admin root and wildcard paths`);
    }
  }
  if (
    !Array.isArray(application.identity_providers)
    || application.identity_providers.length !== 1
    || !idpKeys.has(application.identity_providers[0])
  ) {
    fail(`${label}.identity_providers must reference exactly one managed provider`);
  }
  if (
    !Array.isArray(application.policy_attachments)
    || application.policy_attachments.length === 0
  ) {
    fail(`${label}.policy_attachments must not be empty`);
  }
  const precedences = new Set();
  for (const attachment of application.policy_attachments) {
    if (
      !isObject(attachment)
      || !policyKeys.has(attachment.policy)
      || !Number.isInteger(attachment.precedence)
      || attachment.precedence < 1
    ) {
      fail(`${label}.policy_attachments contains an invalid link`);
    }
    if (precedences.has(attachment.precedence)) {
      fail(`${label}.policy_attachments contains duplicate precedence`);
    }
    precedences.add(attachment.precedence);
  }
  validateAdoption(application.adopt, label);
  if (
    !Array.isArray(application.adopt.detachable_policy_fingerprints)
    || !application.adopt.detachable_policy_fingerprints.every(isObject)
  ) {
    fail(`${label}.adopt.detachable_policy_fingerprints must contain objects`);
  }
}

export function validateConfig(config) {
  requireObject(config, "configuration");
  if (config.schema_version !== 2) {
    fail("configuration.schema_version must be 2");
  }
  requireObject(config.organization_guard, "organization_guard");
  if (config.organization_guard.mfa_required_for_all_apps !== true) {
    fail("organization_guard.mfa_required_for_all_apps must be true");
  }
  requireDuration(
    config.organization_guard.mfa_session_duration,
    "organization_guard.mfa_session_duration",
  );
  if (
    !Array.isArray(config.organization_guard.required_mfa_authenticators)
    || config.organization_guard.required_mfa_authenticators.length === 0
    || !config.organization_guard.required_mfa_authenticators.every(
      (value) => MFA_AUTHENTICATORS.has(value),
    )
  ) {
    fail("organization_guard.required_mfa_authenticators is invalid");
  }
  requireResourceArray(config.identity_providers, "identity_providers");
  requireResourceArray(config.reusable_policies, "reusable_policies");
  requireResourceArray(config.applications, "applications");
  if (!Array.isArray(config.groups) || config.groups.length !== 0) {
    fail("groups must be empty when no Access group is required");
  }
  if (config.identity_providers.length === 0) {
    fail("identity_providers must not be empty");
  }
  for (const provider of config.identity_providers) {
    const label = `identity_providers.${provider.key}`;
    if (provider.type !== "cloudflare") {
      fail(`${label}.type must be 'cloudflare'`);
    }
    requireObject(provider.config, `${label}.config`);
    if (provider.config.restrict_to_account_members !== true) {
      fail(`${label} must restrict authentication to account members`);
    }
    validateAdoption(provider.adopt, label);
  }
  for (const policy of config.reusable_policies) {
    validatePolicy(policy, config.organization_guard);
  }
  const idpKeys = new Set(config.identity_providers.map(({ key }) => key));
  const policyKeys = new Set(config.reusable_policies.map(({ key }) => key));
  for (const application of config.applications) {
    validateApplication(application, idpKeys, policyKeys);
  }
  for (let index = 0; index < config.applications.length; index += 1) {
    const left = config.applications[index];
    for (
      let otherIndex = index + 1;
      otherIndex < config.applications.length;
      otherIndex += 1
    ) {
      const right = config.applications[otherIndex];
      if (destinationsOverlap(left.destinations, right.destinations)) {
        fail(`managed applications '${left.key}' and '${right.key}' overlap`);
      }
    }
  }
  return config;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sortedObjects(values) {
  return values
    .map((value) => canonicalize(value))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function normalizeMfaConfig(value) {
  if (!isObject(value)) {
    return value;
  }
  const normalized = { ...value };
  if (Array.isArray(normalized.allowed_authenticators)) {
    normalized.allowed_authenticators = [
      ...normalized.allowed_authenticators,
    ].sort();
  }
  return canonicalize(normalized);
}

function normalizeIdentityProvider(value) {
  return canonicalize({
    ...(Object.hasOwn(value, "name") ? { name: value.name } : {}),
    ...(Object.hasOwn(value, "type") ? { type: value.type } : {}),
    ...(Object.hasOwn(value, "config") ? { config: value.config } : {}),
  });
}

function normalizePolicy(value) {
  const normalized = {};
  for (const field of [
    "name",
    "decision",
    "reusable",
    "session_duration",
  ]) {
    if (Object.hasOwn(value, field)) {
      normalized[field] = value[field];
    }
  }
  for (const field of ["include", "exclude", "require"]) {
    if (Object.hasOwn(value, field)) {
      normalized[field] = sortedObjects(value[field] ?? []);
    }
  }
  if (Object.hasOwn(value, "mfa_config")) {
    normalized.mfa_config = normalizeMfaConfig(value.mfa_config);
  }
  return canonicalize(normalized);
}

function policyLinks(policies) {
  return (policies ?? [])
    .map((policy) => ({
      id: typeof policy === "string" ? policy : policy.id,
      precedence: typeof policy === "string" ? undefined : policy.precedence,
    }))
    .filter(({ id }) => typeof id === "string")
    .sort((left, right) => {
      const precedenceDifference = (left.precedence ?? 0) - (right.precedence ?? 0);
      return precedenceDifference || left.id.localeCompare(right.id);
    });
}

function normalizeApplication(value) {
  const normalized = {};
  for (const field of APP_WRITABLE_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      continue;
    }
    if (field === "destinations") {
      normalized.destinations = sortedObjects(value.destinations ?? []);
    } else if (
      field === "allowed_idps"
      || field === "self_hosted_domains"
      || field === "tags"
    ) {
      normalized[field] = [...(value[field] ?? [])].sort();
    } else if (field === "policies") {
      normalized.policies = policyLinks(value.policies);
    } else {
      normalized[field] = value[field];
    }
  }
  return canonicalize(normalized);
}

function isSubset(actual, desired) {
  if (Array.isArray(desired)) {
    return Array.isArray(actual)
      && actual.length === desired.length
      && desired.every((entry, index) => isSubset(actual[index], entry));
  }
  if (isObject(desired)) {
    return isObject(actual)
      && Object.entries(desired).every(
        ([key, value]) => Object.hasOwn(actual, key)
          && isSubset(actual[key], value),
      );
  }
  return Object.is(actual, desired);
}

function normalizerFor(kind) {
  if (kind === "identity_provider") {
    return normalizeIdentityProvider;
  }
  if (kind === "reusable_policy") {
    return normalizePolicy;
  }
  return normalizeApplication;
}

function resolveAdoption(kind, desired, candidates) {
  const normalize = normalizerFor(kind);
  const names = new Set([desired.name, ...desired.adopt.aliases]);
  const normalizedFingerprints = desired.adopt.fingerprints.map(normalize);
  const matches = candidates.filter((candidate) => {
    if (names.has(candidate.name)) {
      return true;
    }
    const normalizedCandidate = normalize(candidate);
    return normalizedFingerprints.some(
      (fingerprint) => isSubset(normalizedCandidate, fingerprint),
    );
  });
  const uniqueMatches = [
    ...new Map(matches.map((match) => [match.id, match])).values(),
  ];
  if (uniqueMatches.length > 1) {
    fail(`${kind} '${desired.key}' matched multiple remote resources`);
  }
  if (kind === "identity_provider") {
    const sameType = candidates.filter(({ type }) => type === desired.type);
    if (sameType.length > 1) {
      fail(`identity_provider '${desired.key}' has duplicate type resources`);
    }
    if (uniqueMatches.length === 0 && sameType.length > 0) {
      fail(`identity_provider '${desired.key}' has an unadopted type collision`);
    }
  }
  return uniqueMatches[0] ?? null;
}

function enforceOneToOneAdoption(kind, resolutions) {
  const adoptedIds = new Map();
  for (const [key, resolution] of Object.entries(resolutions)) {
    const id = resolution.actual?.id;
    if (id === undefined) {
      continue;
    }
    requireNonEmptyString(id, `${kind} '${key}' remote ID`);
    const existingKey = adoptedIds.get(id);
    if (existingKey !== undefined) {
      fail(
        `${kind} '${key}' and '${existingKey}' adopted the same remote resource`,
      );
    }
    adoptedIds.set(id, key);
  }
}

function globRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

function globPatternsMayOverlap(left, right) {
  const leftHasWildcard = left.includes("*");
  const rightHasWildcard = right.includes("*");
  if (!leftHasWildcard) {
    return globRegex(right).test(left);
  }
  if (!rightHasWildcard) {
    return globRegex(left).test(right);
  }
  const leftPrefix = left.slice(0, left.indexOf("*"));
  const rightPrefix = right.slice(0, right.indexOf("*"));
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

function publicDestinations(application) {
  const destinations = Array.isArray(application.destinations)
    ? application.destinations.filter(
      (destination) => destination?.type === "public"
        && typeof destination.uri === "string",
    )
    : [];
  if (Array.isArray(application.self_hosted_domains)) {
    for (const uri of application.self_hosted_domains) {
      if (typeof uri === "string" && uri.length > 0) {
        destinations.push({ type: "public", uri });
      }
    }
  }
  if (
    destinations.length === 0
    && ["self_hosted", "ssh", "vnc", "rdp"].includes(application.type)
    && typeof application.domain === "string"
    && application.domain.length > 0
  ) {
    destinations.push({ type: "public", uri: application.domain });
  }
  return [
    ...new Map(
      destinations.map((destination) => [destination.uri, destination]),
    ).values(),
  ];
}

export function destinationsOverlap(leftDestinations, rightDestinations) {
  return leftDestinations.some((leftDestination) => {
    const left = parsePublicDestination(leftDestination.uri);
    return rightDestinations.some((rightDestination) => {
      const right = parsePublicDestination(rightDestination.uri);
      return globPatternsMayOverlap(left.host, right.host)
        && globPatternsMayOverlap(left.path, right.path);
    });
  });
}

function identityProviderPayload(desired) {
  return {
    name: desired.name,
    type: desired.type,
    config: canonicalize(desired.config),
  };
}

function reusablePolicyPayload(desired) {
  return {
    name: desired.name,
    decision: desired.decision,
    include: sortedObjects(desired.include),
    exclude: sortedObjects(desired.exclude),
    require: sortedObjects(desired.require),
    session_duration: desired.session_duration,
    mfa_config: normalizeMfaConfig(desired.mfa_config),
  };
}

function applicationPayload(
  desired,
  actual,
  idpResolutions,
  policyResolutions,
) {
  const excludedFields = new Set([
    "key",
    "identity_providers",
    "policy_attachments",
    "adopt",
  ]);
  const desiredPayload = Object.fromEntries(
    Object.entries(desired).filter(([key]) => !excludedFields.has(key)),
  );
  const payload = {
    ...(actual === null ? {} : extractApplicationPayload(actual)),
    ...desiredPayload,
  };
  payload.allowed_idps = desired.identity_providers.map(
    (key) => idpResolutions[key]?.id ?? `@identity_provider:${key}`,
  );
  payload.policies = desired.policy_attachments
    .map((attachment) => ({
      id: policyResolutions[attachment.policy]?.id
        ?? `@reusable_policy:${attachment.policy}`,
      precedence: attachment.precedence,
    }))
    .sort((left, right) => left.precedence - right.precedence);
  return normalizeApplication(payload);
}

function currentAction(kind, actual, desiredPayload) {
  if (actual === null) {
    return "create";
  }
  const normalize = normalizerFor(kind);
  return isSubset(normalize(actual), normalize(desiredPayload))
    ? "current"
    : "update";
}

function attachmentMatchesFingerprint(policy, fingerprint) {
  const { include_selector_types: selectorTypes, ...subset } = fingerprint;
  if (!isSubset(normalizePolicy(policy), normalizePolicy(subset))) {
    return false;
  }
  if (selectorTypes === undefined) {
    return true;
  }
  if (
    !Array.isArray(selectorTypes)
    || selectorTypes.length === 0
    || !Array.isArray(policy.include)
    || policy.include.length === 0
  ) {
    return false;
  }
  const allowed = new Set(selectorTypes);
  return ruleSelectorTypes(policy.include).every((selector) => allowed.has(selector));
}

function enforceOrganizationGuard(config, organization) {
  if (organization?.mfa_required_for_all_apps !== true) {
    fail("the Access organization does not require MFA for all applications");
  }
  const actualMfa = organization?.mfa_config;
  if (!isObject(actualMfa)) {
    fail("the Access organization does not have independent MFA enabled");
  }
  if (
    !Array.isArray(actualMfa.allowed_authenticators)
    || actualMfa.allowed_authenticators.length === 0
    || typeof actualMfa.session_duration !== "string"
  ) {
    fail("the Access organization does not have independent MFA enabled");
  }
  if (
    actualMfa.session_duration
    !== config.organization_guard.mfa_session_duration
  ) {
    fail("the Access organization MFA duration differs from the guarded value");
  }
  const actualAuthenticators = new Set(actualMfa.allowed_authenticators ?? []);
  for (
    const authenticator
    of config.organization_guard.required_mfa_authenticators
  ) {
    if (!actualAuthenticators.has(authenticator)) {
      fail(`the Access organization does not allow '${authenticator}'`);
    }
  }
  for (const policy of config.reusable_policies) {
    for (const authenticator of policy.mfa_config.allowed_authenticators) {
      if (!actualAuthenticators.has(authenticator)) {
        fail(`policy '${policy.key}' requests an unavailable MFA authenticator`);
      }
    }
  }
}

function appUsesPolicy(application, policyId) {
  return policyLinks(application.policies).some(({ id }) => id === policyId);
}

function appUsesIdentityProvider(application, providerId) {
  return (application.allowed_idps ?? []).includes(providerId);
}

function dependencyDigestEntries({
  ids,
  resources,
  kind,
  applicationKey,
}) {
  return [...new Set(ids)]
    .sort()
    .map((id) => {
      const matches = resources.filter((resource) => resource.id === id);
      if (matches.length !== 1) {
        fail(
          `application '${applicationKey}' has an unresolved ${kind} dependency`,
        );
      }
      return {
        id,
        sha256: digest(extractForKind(kind, matches[0])),
      };
    });
}

function applicationDependencyDigests(application, remote, applicationKey) {
  if (application === null) {
    return {
      identity_providers: [],
      reusable_policies: [],
    };
  }
  if (
    !Array.isArray(application.allowed_idps)
    || application.allowed_idps.length === 0
  ) {
    fail(
      `application '${applicationKey}' uses default-all identity providers and cannot be safely adopted`,
    );
  }
  return {
    identity_providers: dependencyDigestEntries({
      ids: application.allowed_idps,
      resources: remote.identityProviders,
      kind: "identity_provider",
      applicationKey,
    }),
    reusable_policies: dependencyDigestEntries({
      ids: policyLinks(application.policies).map(({ id }) => id),
      resources: remote.reusablePolicies,
      kind: "reusable_policy",
      applicationKey,
    }),
  };
}

export function buildPlan(configInput, remote) {
  const config = validateConfig(configInput);
  requireObject(remote, "remote state");
  for (const field of [
    "identityProviders",
    "reusablePolicies",
    "applications",
  ]) {
    if (!Array.isArray(remote[field])) {
      fail(`remote state.${field} must be an array`);
    }
  }
  enforceOrganizationGuard(config, remote.organization);

  const idpResolutions = {};
  const policyResolutions = {};
  const appResolutions = {};
  const actions = [];

  for (const desired of config.identity_providers) {
    const actual = resolveAdoption(
      "identity_provider",
      desired,
      remote.identityProviders,
    );
    const payload = identityProviderPayload(desired);
    const action = currentAction("identity_provider", actual, payload);
    idpResolutions[desired.key] = { actual, id: actual?.id ?? null, payload, action };
    actions.push({
      kind: "identity_provider",
      key: desired.key,
      action,
    });
  }
  enforceOneToOneAdoption("identity_provider", idpResolutions);

  for (const desired of config.reusable_policies) {
    const actual = resolveAdoption(
      "reusable_policy",
      desired,
      remote.reusablePolicies,
    );
    const payload = reusablePolicyPayload(desired);
    const action = currentAction("reusable_policy", actual, payload);
    policyResolutions[desired.key] = {
      actual,
      id: actual?.id ?? null,
      payload,
      action,
    };
    actions.push({
      kind: "reusable_policy",
      key: desired.key,
      action,
    });
  }
  enforceOneToOneAdoption("reusable_policy", policyResolutions);

  for (const desired of config.applications) {
    const actual = resolveAdoption(
      "application",
      desired,
      remote.applications.filter(({ type }) => type === "self_hosted"),
    );
    appResolutions[desired.key] = {
      actual,
      id: actual?.id ?? null,
      dependencies: applicationDependencyDigests(
        actual,
        remote,
        desired.key,
      ),
    };
  }
  enforceOneToOneAdoption("application", appResolutions);

  const managedAppIds = new Set(
    Object.values(appResolutions)
      .map(({ id }) => id)
      .filter(Boolean),
  );

  for (const [key, resolution] of Object.entries(policyResolutions)) {
    if (resolution.id === null) {
      continue;
    }
    const foreignUsers = remote.applications.filter(
      (application) => appUsesPolicy(application, resolution.id)
        && !managedAppIds.has(application.id),
    );
    if (foreignUsers.length > 0) {
      fail(`reusable_policy '${key}' is attached outside the managed application set`);
    }
  }

  for (const [key, resolution] of Object.entries(idpResolutions)) {
    const foreignUsers = remote.applications.filter(
      (application) => !managedAppIds.has(application.id)
        && (
          (application.allowed_idps ?? []).length === 0
          || (
            resolution.id !== null
            && appUsesIdentityProvider(application, resolution.id)
          )
        ),
    );
    if (foreignUsers.length > 0) {
      const impact = resolution.action === "create"
        ? "would change default-all identity provider selection outside the managed application set"
        : "is available outside the managed application set";
      fail(`identity_provider '${key}' ${impact}`);
    }
  }

  const unmanagedApplications = remote.applications.filter(
    ({ id }) => !managedAppIds.has(id),
  );
  for (const desired of config.applications) {
    const overlapping = unmanagedApplications.filter((application) =>
      destinationsOverlap(
        desired.destinations,
        publicDestinations(application),
      ));
    if (overlapping.length > 0) {
      fail(`application '${desired.key}' overlaps an unmanaged Access application`);
    }
  }

  for (const desired of config.applications) {
    const resolution = appResolutions[desired.key];
    const payload = applicationPayload(
      desired,
      resolution.actual,
      idpResolutions,
      policyResolutions,
    );
    let approvedDetachCount = 0;
    if (resolution.actual !== null) {
      const desiredPolicyIds = new Set(
        desired.policy_attachments
          .map(({ policy }) => policyResolutions[policy].id)
          .filter(Boolean),
      );
      const unexpected = (resolution.actual.policies ?? []).filter(
        (policy) => !desiredPolicyIds.has(policy.id),
      );
      for (const policy of unexpected) {
        const approved = desired.adopt.detachable_policy_fingerprints.some(
          (fingerprint) => attachmentMatchesFingerprint(policy, fingerprint),
        );
        if (!approved) {
          fail(`application '${desired.key}' has an unapproved policy attachment`);
        }
        approvedDetachCount += 1;
      }
    }
    const hasUnresolvedReference = [
      ...payload.allowed_idps,
      ...payload.policies.map(({ id }) => id),
    ].some((id) => id.startsWith("@"));
    const action = hasUnresolvedReference
      ? (resolution.actual === null ? "create" : "update")
      : currentAction("application", resolution.actual, payload);
    appResolutions[desired.key] = {
      ...resolution,
      payload,
      action,
      approvedDetachCount,
    };
    actions.push({
      kind: "application",
      key: desired.key,
      action,
      approvedDetachCount,
    });
  }

  return {
    actions,
    changeCount: actions.filter(({ action }) => action !== "current").length,
    resolved: {
      identityProviders: idpResolutions,
      reusablePolicies: policyResolutions,
      applications: appResolutions,
    },
  };
}

export function renderPlan(plan) {
  const lines = ["Cloudflare Access plan"];
  for (const action of plan.actions) {
    let line = `${action.kind} ${action.key}: ${action.action}`;
    if (action.approvedDetachCount > 0) {
      line += ` (${action.approvedDetachCount} approved legacy attachment removal)`;
    }
    lines.push(line);
  }
  lines.push(`${plan.changeCount} change(s)`);
  return lines.join("\n");
}

function apiErrorCodes(body) {
  const codes = Array.isArray(body?.errors)
    ? body.errors
      .map(({ code }) => code)
      .filter((code) => typeof code === "number" || typeof code === "string")
    : [];
  return codes.length > 0 ? `, codes ${[...new Set(codes)].join(",")}` : "";
}

export class CloudflareApi {
  constructor({ accountId, apiToken, fetchImpl = fetch, apiRoot = API_ROOT }) {
    requireNonEmptyString(accountId, "CLOUDFLARE_ACCOUNT_ID");
    requireNonEmptyString(apiToken, "CLOUDFLARE_API_TOKEN");
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
    this.apiRoot = apiRoot;
  }

  async request(method, endpoint, payload) {
    let response;
    try {
      response = await this.fetchImpl(
        `${this.apiRoot}/accounts/${this.accountId}${endpoint}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            ...(payload === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        },
      );
    } catch {
      fail("Cloudflare API network request failed", 1);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      fail(`Cloudflare API returned invalid JSON (HTTP ${response.status})`, 1);
    }
    if (!response.ok || body?.success !== true) {
      fail(
        `Cloudflare API request failed (HTTP ${response.status}${apiErrorCodes(body)})`,
        1,
      );
    }
    return body;
  }

  async list(endpoint) {
    const allResults = [];
    const seenIds = new Set();
    let expectedTotalCount = null;
    let expectedTotalPages = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const response = await this.request(
        "GET",
        `${endpoint}${separator}page=${page}&per_page=${PAGE_SIZE}`,
      );
      if (!Array.isArray(response.result)) {
        fail("Cloudflare API list response did not contain an array", 1);
      }
      const resultInfo = response.result_info;
      if (
        !isObject(resultInfo)
        || resultInfo.page !== page
        || resultInfo.per_page !== PAGE_SIZE
        || resultInfo.count !== response.result.length
        || !Number.isInteger(resultInfo.total_count)
        || resultInfo.total_count < 0
        || !Number.isInteger(resultInfo.total_pages)
        || resultInfo.total_pages < 1
      ) {
        fail("Cloudflare API pagination metadata is incomplete or inconsistent", 1);
      }
      const calculatedTotalPages = Math.max(
        1,
        Math.ceil(resultInfo.total_count / PAGE_SIZE),
      );
      if (resultInfo.total_pages !== calculatedTotalPages) {
        fail("Cloudflare API pagination total page count is inconsistent", 1);
      }
      if (expectedTotalCount === null) {
        expectedTotalCount = resultInfo.total_count;
        expectedTotalPages = resultInfo.total_pages;
      } else if (
        resultInfo.total_count !== expectedTotalCount
        || resultInfo.total_pages !== expectedTotalPages
      ) {
        fail("Cloudflare API pagination changed while inventory was read", 1);
      }
      const expectedPageCount = Math.min(
        PAGE_SIZE,
        Math.max(0, expectedTotalCount - ((page - 1) * PAGE_SIZE)),
      );
      if (response.result.length !== expectedPageCount) {
        fail("Cloudflare API pagination page count is inconsistent", 1);
      }
      for (const result of response.result) {
        if (typeof result?.id !== "string" || result.id.length === 0) {
          fail("Cloudflare API pagination returned a resource without an ID", 1);
        }
        if (seenIds.has(result.id)) {
          fail("Cloudflare API pagination returned a duplicate resource", 1);
        }
        seenIds.add(result.id);
        allResults.push(result);
      }
      if (page === expectedTotalPages) {
        if (allResults.length !== expectedTotalCount) {
          fail("Cloudflare API pagination total count is inconsistent", 1);
        }
        return allResults;
      }
    }
    fail("Cloudflare API pagination exceeded the safety limit", 1);
  }
}

export async function loadRemoteState(api) {
  const [
    organizationResponse,
    identityProviders,
    reusablePolicies,
    applicationSummaries,
  ] = await Promise.all([
    api.request("GET", "/access/organizations"),
    api.list("/access/identity_providers"),
    api.list("/access/policies"),
    api.list("/access/apps"),
  ]);
  const applications = await Promise.all(
    applicationSummaries.map(async (summary) => {
      const response = await api.request(
        "GET",
        `/access/apps/${summary.id}`,
      );
      if (
        !isObject(response.result)
        || response.result.id !== summary.id
      ) {
        fail("Cloudflare API application detail did not match its listing", 1);
      }
      return response.result;
    }),
  );
  return {
    organization: organizationResponse.result,
    identityProviders,
    reusablePolicies,
    applications,
  };
}

export function extractIdentityProviderPayload(actual) {
  return identityProviderPayload({
    ...actual,
    config: {
      restrict_to_account_members:
        actual.config?.restrict_to_account_members === true,
    },
  });
}

export function extractReusablePolicyPayload(actual) {
  return canonicalize({
    name: actual.name,
    decision: actual.decision,
    include: sortedObjects(actual.include ?? []),
    exclude: sortedObjects(actual.exclude ?? []),
    require: sortedObjects(actual.require ?? []),
    ...(typeof actual.session_duration === "string"
      ? { session_duration: actual.session_duration }
      : {}),
    ...(isObject(actual.mfa_config)
      ? { mfa_config: normalizeMfaConfig(actual.mfa_config) }
      : {}),
  });
}

export function extractApplicationPayload(actual) {
  return normalizeApplication(
    Object.fromEntries(
      APP_WRITABLE_FIELDS
        .filter((field) => Object.hasOwn(actual, field))
        .map((field) => [field, actual[field]]),
    ),
  );
}

function assertSnapshotHasNoSensitiveSelectors(snapshot) {
  const visit = (value, path = "snapshot") => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (typeof value === "string" && EMAIL_VALUE_PATTERN.test(value)) {
      fail(`rollback snapshot would contain an identity value at ${path}`);
    }
    if (!isObject(value)) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_SNAPSHOT_KEY.test(key)) {
        fail(`rollback snapshot would contain forbidden field at ${path}`);
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(snapshot);
}

function snapshotRecord(kind, resolution) {
  const extractor = kind === "identity_provider"
    ? extractIdentityProviderPayload
    : kind === "reusable_policy"
      ? extractReusablePolicyPayload
      : extractApplicationPayload;
  return {
    id: resolution.actual?.id ?? null,
    before: resolution.actual === null
      ? null
      : extractor(resolution.actual),
    created_id: null,
    after_digest: null,
    mutation_state: "not_started",
    ...(kind === "application"
      ? { dependencies: resolution.dependencies }
      : {}),
  };
}

export function createRollbackSnapshot(config, accountId, plan) {
  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    account_sha256: digest(accountId),
    config_sha256: digest(config),
    resources: {
      identity_providers: Object.fromEntries(
        Object.entries(plan.resolved.identityProviders).map(
          ([key, resolution]) => [
            key,
            snapshotRecord("identity_provider", resolution),
          ],
        ),
      ),
      reusable_policies: Object.fromEntries(
        Object.entries(plan.resolved.reusablePolicies).map(
          ([key, resolution]) => [
            key,
            snapshotRecord("reusable_policy", resolution),
          ],
        ),
      ),
      applications: Object.fromEntries(
        Object.entries(plan.resolved.applications).map(
          ([key, resolution]) => [
            key,
            snapshotRecord("application", resolution),
          ],
        ),
      ),
    },
  };
  assertSnapshotHasNoSensitiveSelectors(snapshot);
  return snapshot;
}

async function writeNewPrivateJson(path, value) {
  const handle = await open(path, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") {
      fail("rollback snapshot path already exists", 73);
    }
    fail("could not create rollback snapshot", 73);
  });
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function replacePrivateJson(path, value) {
  const temporaryPath = `${path}.next`;
  const handle = await open(temporaryPath, "wx", 0o600).catch(() => {
    fail("could not create rollback snapshot update", 73);
  });
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch {
    await unlink(temporaryPath).catch(() => {});
    fail("could not update rollback snapshot", 73);
  }
}

function actionFor(plan, kind, key) {
  return plan.actions.find(
    (action) => action.kind === kind && action.key === key,
  );
}

function mutationEndpoint(kind, id) {
  if (kind === "identity_provider") {
    return `/access/identity_providers${id ? `/${id}` : ""}`;
  }
  if (kind === "reusable_policy") {
    return `/access/policies${id ? `/${id}` : ""}`;
  }
  return `/access/apps${id ? `/${id}` : ""}`;
}

function snapshotCollectionName(kind) {
  if (kind === "identity_provider") {
    return "identity_providers";
  }
  if (kind === "reusable_policy") {
    return "reusable_policies";
  }
  return "applications";
}

function resolvedCollectionName(kind) {
  if (kind === "identity_provider") {
    return "identityProviders";
  }
  if (kind === "reusable_policy") {
    return "reusablePolicies";
  }
  return "applications";
}

function extractForKind(kind, value) {
  if (kind === "identity_provider") {
    return extractIdentityProviderPayload(value);
  }
  if (kind === "reusable_policy") {
    return extractReusablePolicyPayload(value);
  }
  return extractApplicationPayload(value);
}

function assertResourceStillMatchesSnapshot(kind, key, resolved, record) {
  if (record.before === null) {
    if (resolved.actual !== null) {
      fail(`${kind} '${key}' appeared after the rollback snapshot was created`);
    }
    return;
  }
  if (
    resolved.actual === null
    || resolved.id !== record.id
    || digest(extractForKind(kind, resolved.actual)) !== digest(record.before)
  ) {
    fail(`${kind} '${key}' changed after the rollback snapshot was created`);
  }
}

function waitForPostMutationVerification(delay) {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, delay);
  });
}

function postMutationVerificationBackoff(staleReadCount) {
  return Math.min(
    POST_MUTATION_VERIFICATION_MAX_BACKOFF_MS,
    POST_MUTATION_VERIFICATION_INITIAL_BACKOFF_MS
      * (2 ** (staleReadCount - 1)),
  );
}

function postMutationVerificationOptions(overrides) {
  if (!isObject(overrides)) {
    fail("post-mutation verification options must be an object");
  }
  const readRemoteState =
    overrides.readRemoteState ?? loadRemoteState;
  const wait = overrides.wait ?? waitForPostMutationVerification;
  if (
    typeof readRemoteState !== "function"
    || typeof wait !== "function"
  ) {
    fail("post-mutation verification hooks must be functions");
  }
  return { readRemoteState, wait };
}

async function verifyMutationAfterWrite({
  api,
  kind,
  key,
  mutationId,
  payload,
  verification,
}) {
  for (
    let readNumber = 1;
    readNumber <= POST_MUTATION_VERIFICATION_READ_LIMIT;
    readNumber += 1
  ) {
    const state = await verification.readRemoteState(api);
    const current = findRemoteById(state, kind, mutationId);
    if (
      current !== null
      && currentAction(kind, current, payload) === "current"
    ) {
      return { current, state };
    }
    if (readNumber < POST_MUTATION_VERIFICATION_READ_LIMIT) {
      await verification.wait(
        postMutationVerificationBackoff(readNumber),
      );
    }
  }
  fail(
    `${kind} '${key}' could not be verified after ${POST_MUTATION_VERIFICATION_READ_LIMIT} post-mutation reads`,
    1,
  );
}

async function applyResourceKind({
  api,
  config,
  state,
  snapshot,
  snapshotPath,
  kind,
  desiredResources,
  verification,
}) {
  let workingState = state;
  for (const desired of desiredResources) {
    const plan = buildPlan(config, workingState);
    const action = actionFor(plan, kind, desired.key);
    if (action.action === "current") {
      continue;
    }
    const resolved = plan.resolved[resolvedCollectionName(kind)][desired.key];
    const record = snapshot.resources[snapshotCollectionName(kind)][desired.key];
    assertResourceStillMatchesSnapshot(kind, desired.key, resolved, record);
    record.mutation_state = "pending";
    await replacePrivateJson(snapshotPath, snapshot);
    const response = await api.request(
      action.action === "create" ? "POST" : "PUT",
      mutationEndpoint(kind, action.action === "create" ? null : resolved.id),
      resolved.payload,
    );
    let mutationId = resolved.id;
    if (action.action === "create") {
      if (typeof response.result?.id !== "string") {
        fail("Cloudflare API create response omitted the resource ID", 1);
      }
      mutationId = response.result.id;
    }
    const verified = await verifyMutationAfterWrite({
      api,
      kind,
      key: desired.key,
      mutationId,
      payload: resolved.payload,
      verification,
    });
    workingState = verified.state;
    const current = verified.current;
    if (action.action === "create") {
      record.created_id = mutationId;
    }
    record.after_digest = digest(extractForKind(kind, current));
    record.mutation_state = "applied";
    await replacePrivateJson(snapshotPath, snapshot);
  }
  return workingState;
}

function refreshSnapshotDigests(snapshot, plan) {
  for (const [kind, collectionName] of [
    ["identity_provider", "identityProviders"],
    ["reusable_policy", "reusablePolicies"],
    ["application", "applications"],
  ]) {
    const snapshotCollection = snapshot.resources[snapshotCollectionName(kind)];
    for (const [key, resolution] of Object.entries(plan.resolved[collectionName])) {
      if (
        resolution.actual !== null
        && snapshotCollection[key].mutation_state === "applied"
      ) {
        snapshotCollection[key].after_digest = digest(
          extractForKind(kind, resolution.actual),
        );
      }
    }
  }
}

export async function applyAccessPlan({
  api,
  config,
  initialState,
  rollbackPath,
  verification: verificationOverrides = {},
}) {
  const verification =
    postMutationVerificationOptions(verificationOverrides);
  const initialPlan = buildPlan(config, initialState);
  const snapshot = createRollbackSnapshot(config, api.accountId, initialPlan);
  await writeNewPrivateJson(rollbackPath, snapshot);
  let state = initialState;
  state = await applyResourceKind({
    api,
    config,
    state,
    snapshot,
    snapshotPath: rollbackPath,
    kind: "identity_provider",
    desiredResources: config.identity_providers,
    verification,
  });
  state = await applyResourceKind({
    api,
    config,
    state,
    snapshot,
    snapshotPath: rollbackPath,
    kind: "reusable_policy",
    desiredResources: config.reusable_policies,
    verification,
  });
  state = await applyResourceKind({
    api,
    config,
    state,
    snapshot,
    snapshotPath: rollbackPath,
    kind: "application",
    desiredResources: config.applications,
    verification,
  });
  const finalPlan = buildPlan(config, state);
  if (finalPlan.changeCount !== 0) {
    fail("post-apply verification found remaining Access drift", 1);
  }
  refreshSnapshotDigests(snapshot, finalPlan);
  await replacePrivateJson(rollbackPath, snapshot);
  return finalPlan;
}

async function readRollbackSnapshot(path, config, accountId) {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    fail("rollback snapshot could not be read", 66);
  }
  if ((fileStat.mode & 0o077) !== 0) {
    fail("rollback snapshot permissions must be 0600", 77);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("rollback snapshot is invalid", 65);
  }
  if (
    snapshot?.schema_version !== SNAPSHOT_SCHEMA_VERSION
    || snapshot.account_sha256 !== digest(accountId)
    || snapshot.config_sha256 !== digest(config)
  ) {
    fail("rollback snapshot does not match this account and configuration");
  }
  requireObject(snapshot.resources, "rollback snapshot resources");
  for (const [collectionName, desiredResources] of [
    ["identity_providers", config.identity_providers],
    ["reusable_policies", config.reusable_policies],
    ["applications", config.applications],
  ]) {
    requireObject(
      snapshot.resources[collectionName],
      `rollback snapshot ${collectionName}`,
    );
    for (const { key } of desiredResources) {
      const record = snapshot.resources[collectionName][key];
      requireObject(
        record,
        `rollback snapshot ${collectionName}.${key}`,
      );
      if (!SNAPSHOT_MUTATION_STATES.has(record.mutation_state)) {
        fail(
          `rollback snapshot ${collectionName}.${key} has an invalid mutation state`,
        );
      }
      if (
        record.id !== null
        && (typeof record.id !== "string" || record.id.length === 0)
      ) {
        fail(`rollback snapshot ${collectionName}.${key} has an invalid ID`);
      }
      if (
        record.created_id !== null
        && (
          typeof record.created_id !== "string"
          || record.created_id.length === 0
        )
      ) {
        fail(
          `rollback snapshot ${collectionName}.${key} has an invalid created ID`,
        );
      }
      if (
        record.after_digest !== null
        && !/^[a-f0-9]{64}$/.test(record.after_digest)
      ) {
        fail(
          `rollback snapshot ${collectionName}.${key} has an invalid digest`,
        );
      }
      if (
        (record.before === null) !== (record.id === null)
        || (
          record.before !== null
          && !isObject(record.before)
        )
        || (
          record.before !== null
          && record.created_id !== null
        )
        || (
          ["applied", "rolled_back"].includes(record.mutation_state)
          && (
            record.after_digest === null
            || (record.before === null && record.created_id === null)
          )
        )
        || (
          ["not_started", "pending"].includes(record.mutation_state)
          && (
            record.created_id !== null
            || record.after_digest !== null
          )
        )
      ) {
        fail(
          `rollback snapshot ${collectionName}.${key} has inconsistent mutation metadata`,
        );
      }
      if (collectionName === "applications") {
        requireObject(
          record.dependencies,
          `rollback snapshot ${collectionName}.${key}.dependencies`,
        );
        for (const dependencyKind of [
          "identity_providers",
          "reusable_policies",
        ]) {
          const dependencies = record.dependencies[dependencyKind];
          if (
            !Array.isArray(dependencies)
            || !dependencies.every(
              (entry) => isObject(entry)
                && canonicalJson(Object.keys(entry).sort())
                  === canonicalJson(["id", "sha256"])
                && typeof entry.id === "string"
                && entry.id.length > 0
                && /^[a-f0-9]{64}$/.test(entry.sha256),
            )
          ) {
            fail(
              `rollback snapshot ${collectionName}.${key}.${dependencyKind} is invalid`,
            );
          }
        }
      }
    }
  }
  assertSnapshotHasNoSensitiveSelectors(snapshot);
  return snapshot;
}

function findRemoteById(state, kind, id) {
  if (typeof id !== "string") {
    return null;
  }
  return state[resolvedCollectionName(kind)].find(
    (resource) => resource.id === id,
  ) ?? null;
}

function verifyRollbackRecord(state, kind, key, record) {
  if (record.mutation_state === "not_started") {
    return "not_started";
  }
  if (record.mutation_state === "rolled_back") {
    return "rolled_back";
  }
  if (record.mutation_state === "pending") {
    fail(`${kind} '${key}' has an uncertain mutation; rollback refused`);
  }
  const id = record.created_id ?? record.id;
  const current = findRemoteById(state, kind, id);
  if (record.before === null && current === null) {
    return "already_rolled_back";
  }
  if (current === null) {
    fail(`${kind} '${key}' is missing during rollback`);
  }
  const currentDigest = digest(extractForKind(kind, current));
  if (currentDigest === record.after_digest) {
    return "needs_rollback";
  }
  if (
    record.before !== null
    && currentDigest === digest(record.before)
  ) {
    return "already_rolled_back";
  }
  fail(`${kind} '${key}' changed after apply; rollback refused`);
}

function findSnapshotDependencyRecord(snapshot, collectionName, id) {
  return Object.values(snapshot.resources[collectionName]).find(
    (record) => record.id === id || record.created_id === id,
  ) ?? null;
}

function verifyApplicationDependencies(state, snapshot, key, record) {
  if (record.before === null) {
    return;
  }
  for (const [collectionName, kind] of [
    ["identity_providers", "identity_provider"],
    ["reusable_policies", "reusable_policy"],
  ]) {
    for (const dependency of record.dependencies[collectionName]) {
      const current = findRemoteById(state, kind, dependency.id);
      if (current === null) {
        fail(
          `application '${key}' has a missing ${kind} dependency; rollback refused`,
        );
      }
      const currentDigest = digest(extractForKind(kind, current));
      if (currentDigest === dependency.sha256) {
        continue;
      }
      const managedRecord = findSnapshotDependencyRecord(
        snapshot,
        collectionName,
        dependency.id,
      );
      if (
        managedRecord?.mutation_state === "applied"
        && managedRecord.after_digest === currentDigest
      ) {
        continue;
      }
      fail(
        `application '${key}' has a changed ${kind} dependency; rollback refused`,
      );
    }
  }
}

function verifyApplicationRestoreOverlap(state, snapshot, key, record) {
  if (record.before === null) {
    return;
  }
  const restoredDestinations = publicDestinations(record.before);
  const managedApplicationIds = new Set(
    Object.values(snapshot.resources.applications)
      .flatMap((applicationRecord) => [
        applicationRecord.id,
        applicationRecord.created_id,
      ])
      .filter((id) => typeof id === "string"),
  );
  const overlapping = state.applications.filter(
    (application) => !managedApplicationIds.has(application.id)
      && destinationsOverlap(
        restoredDestinations,
        publicDestinations(application),
      ),
  );
  if (overlapping.length > 0) {
    fail(
      `application '${key}' legacy destinations overlap an unmanaged Access application; rollback refused`,
    );
  }
}

async function rollbackKind({
  api,
  state,
  snapshot,
  snapshotPath,
  kind,
  keys,
}) {
  let workingState = state;
  for (const key of keys) {
    const record = snapshot.resources[snapshotCollectionName(kind)][key];
    const status = verifyRollbackRecord(workingState, kind, key, record);
    if (status === "not_started" || status === "rolled_back") {
      continue;
    }
    if (kind === "application") {
      verifyApplicationDependencies(workingState, snapshot, key, record);
      verifyApplicationRestoreOverlap(workingState, snapshot, key, record);
    }
    if (status === "already_rolled_back") {
      record.mutation_state = "rolled_back";
      await replacePrivateJson(snapshotPath, snapshot);
      continue;
    }
    if (record.before !== null) {
      await api.request(
        "PUT",
        mutationEndpoint(kind, record.id),
        record.before,
      );
    } else if (record.created_id !== null) {
      if (kind === "reusable_policy") {
        const inUse = workingState.applications.some(
          (application) => appUsesPolicy(application, record.created_id),
        );
        if (inUse) {
          fail(`reusable_policy '${key}' is still attached; rollback refused`);
        }
      }
      if (kind === "identity_provider") {
        const inUse = workingState.applications.some(
          (application) =>
            !Array.isArray(application.allowed_idps)
            || application.allowed_idps.length === 0
            || appUsesIdentityProvider(application, record.created_id),
        );
        if (inUse) {
          fail(`identity_provider '${key}' is still in use; rollback refused`);
        }
      }
      await api.request("DELETE", mutationEndpoint(kind, record.created_id));
    }
    workingState = await loadRemoteState(api);
    if (
      verifyRollbackRecord(workingState, kind, key, record)
      !== "already_rolled_back"
    ) {
      fail(`${kind} '${key}' could not be verified after rollback`, 1);
    }
    record.mutation_state = "rolled_back";
    await replacePrivateJson(snapshotPath, snapshot);
  }
  return workingState;
}

export async function rollbackAccessPlan({
  api,
  config,
  rollbackPath,
}) {
  const snapshot = await readRollbackSnapshot(
    rollbackPath,
    config,
    api.accountId,
  );
  const pending = Object.entries(snapshot.resources).flatMap(
    ([collectionName, records]) =>
      Object.entries(records)
        .filter(([, record]) => record.mutation_state === "pending")
        .map(([key]) => `${collectionName}.${key}`),
  );
  if (pending.length > 0) {
    fail("rollback snapshot contains an uncertain pending mutation; rollback refused");
  }
  let state = await loadRemoteState(api);
  state = await rollbackKind({
    api,
    state,
    snapshot,
    snapshotPath: rollbackPath,
    kind: "application",
    keys: [...config.applications.map(({ key }) => key)].reverse(),
  });
  state = await rollbackKind({
    api,
    state,
    snapshot,
    snapshotPath: rollbackPath,
    kind: "reusable_policy",
    keys: [...config.reusable_policies.map(({ key }) => key)].reverse(),
  });
  await rollbackKind({
    api,
    state,
    snapshot,
    snapshotPath: rollbackPath,
    kind: "identity_provider",
    keys: [...config.identity_providers.map(({ key }) => key)].reverse(),
  });
}

function usage() {
  return `Usage: scripts/cloudflare-access.sh COMMAND [options]

Commands:
  check                         Validate local desired state
  plan                          Read Cloudflare state and print a sanitized plan
  apply                         Reconcile Access after explicit cutover confirmation
  rollback                      Restore the private pre-apply snapshot

Options:
  --config PATH                 Desired-state configuration
  --rollback-out PATH           New mode-0600 snapshot required by apply
  --snapshot PATH               Existing mode-0600 snapshot required by rollback
  --confirm-admin-cutover       Confirm the in-place admin gate replacement
  --confirm-rollback            Confirm restoration of the pre-apply state
  -h, --help                    Show this help

Environment:
  CLOUDFLARE_API_TOKEN          Access write token
  CLOUDFLARE_ACCOUNT_ID         Access account
`;
}

function parseArguments(argv, defaultConfig) {
  const command = argv[0];
  if (command === undefined || command === "-h" || command === "--help") {
    return { help: true };
  }
  if (!["check", "plan", "apply", "rollback"].includes(command)) {
    fail(`unknown command '${command}'`, 64);
  }
  const options = {
    command,
    configPath: defaultConfig,
    rollbackOut: null,
    snapshotPath: null,
    confirmAdminCutover: false,
    confirmRollback: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      options.configPath = argv[index + 1];
      index += 1;
    } else if (argument === "--rollback-out") {
      options.rollbackOut = argv[index + 1];
      index += 1;
    } else if (argument === "--snapshot") {
      options.snapshotPath = argv[index + 1];
      index += 1;
    } else if (argument === "--confirm-admin-cutover") {
      options.confirmAdminCutover = true;
    } else if (argument === "--confirm-rollback") {
      options.confirmRollback = true;
    } else if (argument === "-h" || argument === "--help") {
      return { help: true };
    } else {
      fail(`unknown option '${argument}'`, 64);
    }
  }
  if (typeof options.configPath !== "string") {
    fail("--config requires a path", 64);
  }
  return options;
}

async function readConfig(path) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`configuration '${basename(path)}' could not be read`, 66);
  }
  return validateConfig(config);
}

function requireCloudflareEnvironment() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    fail("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required", 78);
  }
  return { accountId, apiToken };
}

async function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const defaultConfig = resolve(scriptDirectory, "../cloudflare/access.json");
  const options = parseArguments(process.argv.slice(2), defaultConfig);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const config = await readConfig(options.configPath);
  if (options.command === "check") {
    process.stderr.write("cloudflare-access: configuration is valid\n");
    return;
  }
  const environment = requireCloudflareEnvironment();
  const api = new CloudflareApi(environment);
  if (options.command === "rollback") {
    if (!options.confirmRollback || !options.snapshotPath) {
      fail("rollback requires --snapshot and --confirm-rollback", 64);
    }
    await rollbackAccessPlan({
      api,
      config,
      rollbackPath: options.snapshotPath,
    });
    process.stderr.write("cloudflare-access: rollback completed\n");
    return;
  }
  const state = await loadRemoteState(api);
  const plan = buildPlan(config, state);
  process.stdout.write(`${renderPlan(plan)}\n`);
  if (options.command === "plan") {
    return;
  }
  if (!options.confirmAdminCutover || !options.rollbackOut) {
    fail("apply requires --rollback-out and --confirm-admin-cutover", 64);
  }
  await applyAccessPlan({
    api,
    config,
    initialState: state,
    rollbackPath: options.rollbackOut,
  });
  process.stderr.write("cloudflare-access: apply completed and verified\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    if (error instanceof AccessReconcileError) {
      process.stderr.write(`cloudflare-access: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write("cloudflare-access: unexpected failure\n");
    process.exitCode = 1;
  });
}
