import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CloudflareApi,
  POST_MUTATION_VERIFICATION_INITIAL_BACKOFF_MS,
  POST_MUTATION_VERIFICATION_MAX_BACKOFF_MS,
  POST_MUTATION_VERIFICATION_READ_LIMIT,
  applyAccessPlan,
  buildPlan,
  createRollbackSnapshot,
  loadRemoteState,
  renderPlan,
  rollbackAccessPlan,
  validateConfig,
} from "../scripts/cloudflare-access.mjs";

const config = validateConfig(
  JSON.parse(
    readFileSync(
      new URL("../cloudflare/access.json", import.meta.url),
      "utf8",
    ),
  ),
);

const LEGACY_DESTINATIONS = [
  { type: "public", uri: "stowplan.lasers.app/account*" },
  { type: "public", uri: "stowplan.lasers.app/api/auth/access*" },
  { type: "public", uri: "stowplan.lasers.app/admin*" },
  { type: "public", uri: "stowplan.lasers.app/api/admin/*" },
];

const ADMIN_DESTINATIONS = [
  { type: "public", uri: "stowplan.lasers.app/admin" },
  { type: "public", uri: "stowplan.lasers.app/admin/*" },
  { type: "public", uri: "stowplan.lasers.app/api/admin" },
  { type: "public", uri: "stowplan.lasers.app/api/admin/*" },
];

function organization(authenticators = ["biometrics", "totp"]) {
  return {
    auth_domain: "example.cloudflareaccess.invalid",
    mfa_required_for_all_apps: true,
    mfa_config: {
      allowed_authenticators: authenticators,
      session_duration: "24h",
    },
  };
}

function legacyPolicy() {
  return {
    id: "legacy-policy-id",
    name: "legacy identity policy",
    decision: "allow",
    reusable: true,
    include: [
      { email: { email: "private-person@example.invalid" } },
    ],
    exclude: [],
    require: [],
    precedence: 1,
  };
}

function legacyRemoteState() {
  const policy = legacyPolicy();
  return {
    organization: organization(),
    identityProviders: [
      {
        id: "legacy-otp-id",
        name: "One-time PIN",
        type: "onetimepin",
        config: { redirect_url: "https://example.invalid" },
      },
    ],
    reusablePolicies: [policy],
    applications: [
      {
        id: "managed-app-id",
        aud: "private-audience-value",
        name: "Stowplan",
        type: "self_hosted",
        domain: "stowplan.lasers.app/account*",
        destinations: LEGACY_DESTINATIONS,
        session_duration: "24h",
        allowed_idps: ["legacy-otp-id"],
        policies: [policy],
      },
      {
        id: "foreign-app-id",
        name: "unmanaged application",
        type: "self_hosted",
        domain: "other.example.invalid/admin",
        destinations: [
          { type: "public", uri: "other.example.invalid/admin" },
        ],
        allowed_idps: ["legacy-otp-id"],
        policies: [policy],
      },
    ],
  };
}

function currentRemoteState() {
  const provider = {
    id: "cloudflare-idp-id",
    name: "Stowplan administrators",
    type: "cloudflare",
    config: {
      restrict_to_account_members: true,
      redirect_url: "https://example.invalid",
    },
  };
  const policy = {
    id: "admin-policy-id",
    name: "Stowplan administrator account members",
    decision: "allow",
    reusable: true,
    include: [{ cloudflare_account_member: {} }],
    exclude: [],
    require: [],
    session_duration: "2h",
    mfa_config: {
      mfa_disabled: false,
      allowed_authenticators: ["biometrics"],
    },
  };
  return {
    organization: organization(),
    identityProviders: [provider],
    reusablePolicies: [policy],
    applications: [
      {
        id: "managed-app-id",
        aud: "preserved-audience-value",
        name: "Stowplan",
        type: "self_hosted",
        domain: "stowplan.lasers.app/admin",
        destinations: ADMIN_DESTINATIONS,
        session_duration: "2h",
        app_launcher_visible: false,
        auto_redirect_to_identity: true,
        allow_authenticate_via_warp: false,
        http_only_cookie_attribute: true,
        options_preflight_bypass: false,
        allowed_idps: [provider.id],
        policies: [{ ...policy, precedence: 1 }],
      },
    ],
  };
}

type FakeResource = {
  id: string;
  [key: string]: unknown;
};

type FakeRemoteState = {
  organization: Record<string, unknown>;
  identityProviders: FakeResource[];
  reusablePolicies: FakeResource[];
  applications: FakeResource[];
};

class FakeCloudflareApi {
  accountId = "account-id";

  state = structuredClone(legacyRemoteState()) as unknown as FakeRemoteState;

  nextId = 1;

  requests: Array<{ method: string; endpoint: string }> = [];

  expandApplication(application: FakeResource) {
    const policyById = new Map(
      this.state.reusablePolicies.map((policy) => [policy.id, policy]),
    );
    const policies = (
      (application.policies ?? []) as Array<{ id: string; precedence: number }>
    ).map((link) => ({
      ...policyById.get(link.id),
      id: link.id,
      precedence: link.precedence,
    }));
    return { ...application, policies };
  }

  async list(endpoint: string) {
    if (endpoint === "/access/identity_providers") {
      return structuredClone(this.state.identityProviders);
    }
    if (endpoint === "/access/policies") {
      return structuredClone(this.state.reusablePolicies);
    }
    if (endpoint === "/access/apps") {
      return structuredClone(
        this.state.applications.map(({ id, name, type, domain }) => ({
          id,
          name,
          type,
          domain,
        })),
      );
    }
    throw new Error("unexpected fake list endpoint");
  }

  async request(
    method: string,
    endpoint: string,
    payload?: Record<string, unknown>,
  ) {
    this.requests.push({ method, endpoint });
    if (method === "GET" && endpoint === "/access/organizations") {
      return {
        success: true,
        result: structuredClone(this.state.organization),
      };
    }
    if (method === "GET" && endpoint.startsWith("/access/apps/")) {
      const id = endpoint.split("/").at(-1);
      const application = this.state.applications.find(
        (resource) => resource.id === id,
      );
      if (application === undefined) {
        throw new Error("unexpected fake application ID");
      }
      return {
        success: true,
        result: structuredClone(this.expandApplication(application)),
      };
    }
    const resources = endpoint.startsWith("/access/identity_providers")
      ? this.state.identityProviders
      : endpoint.startsWith("/access/policies")
        ? this.state.reusablePolicies
        : this.state.applications;
    const id = endpoint.split("/").at(-1);
    if (method === "POST") {
      const created: FakeResource = {
        ...structuredClone(payload ?? {}),
        id: `created-${this.nextId}`,
      };
      this.nextId += 1;
      resources.push(created);
      return { success: true, result: structuredClone(created) };
    }
    const index = resources.findIndex((resource) => resource.id === id);
    if (index === -1) {
      throw new Error("unexpected fake resource ID");
    }
    if (method === "PUT") {
      const updated: FakeResource = {
        ...structuredClone(payload ?? {}),
        id: id ?? "",
        ...(resources[index].aud === undefined
          ? {}
          : { aud: resources[index].aud }),
      };
      resources[index] = updated;
      return {
        success: true,
        result: structuredClone(
          endpoint.startsWith("/access/apps")
            ? this.expandApplication(updated)
            : updated,
        ),
      };
    }
    if (method === "DELETE") {
      resources.splice(index, 1);
      return { success: true, result: null };
    }
    throw new Error("unexpected fake request");
  }
}

describe("Cloudflare Access desired state", () => {
  it("contains only the exact admin destinations and account-member gate", () => {
    expect(config.identity_providers).toHaveLength(1);
    expect(config.identity_providers[0]).toMatchObject({
      type: "cloudflare",
      config: { restrict_to_account_members: true },
    });
    expect(config.reusable_policies[0]).toMatchObject({
      include: [{ cloudflare_account_member: {} }],
      session_duration: "2h",
      mfa_config: {
        mfa_disabled: false,
        allowed_authenticators: ["biometrics"],
      },
    });
    expect(config.applications[0].destinations).toEqual(ADMIN_DESTINATIONS);
    expect(
      JSON.stringify({
        identityProviders: config.identity_providers.map(
          (provider: { type: string; config: unknown }) => ({
            type: provider.type,
            config: provider.config,
          }),
        ),
        policies: config.reusable_policies.map(
          (policy: {
            include: unknown[];
            exclude: unknown[];
            require: unknown[];
          }) => ({
            include: policy.include,
            exclude: policy.exclude,
            require: policy.require,
          }),
        ),
        destinations: config.applications.flatMap(
          (application: { destinations: unknown[] }) =>
            application.destinations,
        ),
      }),
    ).not.toMatch(/onetimepin|allowed_emails|\/account|\/api\/auth/);
  });

  it("renders a sanitized snapshot of the in-place legacy conversion", () => {
    const plan = buildPlan(config, legacyRemoteState());
    expect(renderPlan(plan)).toMatchInlineSnapshot(`
      "Cloudflare Access plan
      identity_provider admin-cloudflare: create
      reusable_policy admin-account-members: create
      application admin: update (1 approved legacy attachment removal)
      3 change(s)"
    `);
    expect(renderPlan(plan)).not.toMatch(
      /private-person|private-audience|managed-app-id|legacy-policy-id/,
    );
    const applicationResolution = Object.values(
      plan.resolved.applications,
    )[0] as {
      actual: { aud: string };
      payload: Record<string, unknown>;
    };
    expect(applicationResolution.actual.aud).toBe(
      "private-audience-value",
    );
    expect(applicationResolution.payload).not.toHaveProperty("aud");
  });

  it("is idempotent once every managed resource matches", () => {
    const plan = buildPlan(config, currentRemoteState());
    expect(plan.changeCount).toBe(0);
    expect(plan.actions.map(({ action }) => action)).toEqual([
      "current",
      "current",
      "current",
    ]);
  });

  it("refuses duplicate application adoption", () => {
    const state = legacyRemoteState();
    const duplicateState = {
      ...state,
      applications: [
        ...state.applications,
        {
          ...state.applications[0],
          id: "duplicate-managed-app-id",
          name: "Stowplan account identity",
        },
      ],
    };
    expect(() => buildPlan(config, duplicateState)).toThrow(
      "matched multiple remote resources",
    );
  });

  it("refuses duplicate Cloudflare identity providers", () => {
    const state = currentRemoteState();
    state.identityProviders.push({
      ...state.identityProviders[0],
      id: "duplicate-cloudflare-idp-id",
      name: "unmanaged Cloudflare login",
    });
    expect(() => buildPlan(config, state)).toThrow(
      "matched multiple remote resources",
    );
  });

  it("refuses many-to-one desired-resource adoption", () => {
    const duplicatePolicyConfig = structuredClone(config);
    duplicatePolicyConfig.reusable_policies.push({
      ...structuredClone(duplicatePolicyConfig.reusable_policies[0]),
      key: "duplicate-admin-policy",
    });
    expect(() =>
      buildPlan(duplicatePolicyConfig, currentRemoteState())
    ).toThrow("adopted the same remote resource");
  });

  it("refuses overlap with an unmanaged application", () => {
    const state = legacyRemoteState();
    const overlapState = {
      ...state,
      applications: [
      {
        ...state.applications[0],
        id: "overlapping-app-id",
        name: "unmanaged broad application",
        domain: "stowplan.lasers.app/*",
        destinations: [
          { type: "public", uri: "stowplan.lasers.app/*" },
        ],
        policies: [],
      },
      ],
    };
    expect(() => buildPlan(config, overlapState)).toThrow(
      "overlaps an unmanaged Access application",
    );
  });

  it("checks legacy domains and every application type for overlap", () => {
    const legacyDomainState = structuredClone(
      legacyRemoteState(),
    ) as unknown as FakeRemoteState;
    legacyDomainState.applications.push({
      id: "legacy-domain-app-id",
      name: "unmanaged legacy domain application",
      type: "self_hosted",
      domain: "other.example.invalid/admin",
      destinations: [],
      self_hosted_domains: ["stowplan.lasers.app/admin/*"],
      allowed_idps: ["legacy-otp-id"],
      policies: [],
    });
    expect(() => buildPlan(config, legacyDomainState)).toThrow(
      "overlaps an unmanaged Access application",
    );

    const otherTypeState = structuredClone(
      legacyRemoteState(),
    ) as unknown as FakeRemoteState;
    otherTypeState.applications.push({
      id: "other-type-app-id",
      name: "unmanaged public destination",
      type: "bookmark",
      domain: "https://other.example.invalid",
      destinations: [
        { type: "public", uri: "stowplan.lasers.app/api/admin/*" },
      ],
      allowed_idps: ["legacy-otp-id"],
      policies: [],
    });
    expect(() => buildPlan(config, otherTypeState)).toThrow(
      "overlaps an unmanaged Access application",
    );
  });

  it("refuses identity-provider creation that changes a foreign default-all app", () => {
    const state = legacyRemoteState();
    state.applications[1].allowed_idps = [];
    expect(() => buildPlan(config, state)).toThrow(
      "would change default-all identity provider selection",
    );
  });

  it("refuses foreign identity-provider use after managed resources are current", () => {
    const defaultAllState = currentRemoteState();
    defaultAllState.applications.push({
      ...defaultAllState.applications[0],
      id: "foreign-default-all-app-id",
      name: "foreign default-all application",
      domain: "foreign-default-all.example.invalid/admin",
      destinations: [
        {
          type: "public",
          uri: "foreign-default-all.example.invalid/admin",
        },
      ],
      allowed_idps: [],
      policies: [],
    });
    expect(() => buildPlan(config, defaultAllState)).toThrow(
      "is available outside the managed application set",
    );

    const explicitState = currentRemoteState();
    explicitState.applications.push({
      ...explicitState.applications[0],
      id: "foreign-explicit-app-id",
      name: "foreign explicit application",
      domain: "foreign-explicit.example.invalid/admin",
      destinations: [
        {
          type: "public",
          uri: "foreign-explicit.example.invalid/admin",
        },
      ],
      policies: [],
    });
    expect(() => buildPlan(config, explicitState)).toThrow(
      "is available outside the managed application set",
    );
  });

  it("refuses to manage a reusable policy attached elsewhere", () => {
    const state = currentRemoteState();
    state.applications.push({
      ...state.applications[0],
      id: "foreign-app-id",
      name: "foreign application",
      domain: "foreign.example.invalid/admin",
      destinations: [
        { type: "public", uri: "foreign.example.invalid/admin" },
      ],
      policies: [
        {
          ...state.reusablePolicies[0],
          precedence: 1,
        },
      ],
    });
    expect(() => buildPlan(config, state)).toThrow(
      "attached outside the managed application set",
    );
  });

  it("refuses unapproved attachment removal", () => {
    const state = legacyRemoteState();
    state.applications[0].policies.push({
      ...legacyPolicy(),
      id: "unexpected-policy-id",
      name: "unexpected bypass",
      decision: "bypass",
      precedence: 2,
    });
    state.reusablePolicies.push({
      ...legacyPolicy(),
      id: "unexpected-policy-id",
      name: "unexpected bypass",
      decision: "bypass",
    });
    expect(() => buildPlan(config, state)).toThrow(
      "has an unapproved policy attachment",
    );
  });

  it("requires organization-wide MFA to remain enabled", () => {
    const state = legacyRemoteState();
    state.organization.mfa_required_for_all_apps = false;
    expect(() => buildPlan(config, state)).toThrow(
      "does not require MFA for all applications",
    );
  });

  it("refuses a policy authenticator unavailable at the organization", () => {
    const securityKeyConfig = structuredClone(config);
    securityKeyConfig.organization_guard.required_mfa_authenticators.push(
      "security_key",
    );
    securityKeyConfig.reusable_policies[0].mfa_config.allowed_authenticators = [
      "biometrics",
      "security_key",
    ];
    expect(() =>
      buildPlan(securityKeyConfig, legacyRemoteState())
    ).toThrow("does not allow 'security_key'");
  });

  it("keeps identity inventory out of the private rollback snapshot", () => {
    const state = legacyRemoteState();
    const plan = buildPlan(config, state);
    const snapshot = createRollbackSnapshot(config, "account-id", plan);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(
      /private-person|private-audience|example\.invalid/,
    );
    const applicationSnapshot = Object.values(
      snapshot.resources.applications,
    )[0] as {
      before: { policies: Array<{ id: string; precedence: number }> };
      dependencies: {
        identity_providers: Array<{ id: string; sha256: string }>;
        reusable_policies: Array<{ id: string; sha256: string }>;
      };
      mutation_state: string;
    };
    expect(applicationSnapshot.before.policies).toEqual([
      { id: "legacy-policy-id", precedence: 1 },
    ]);
    expect(applicationSnapshot).toMatchObject({
      dependencies: {
        identity_providers: [
          {
            id: "legacy-otp-id",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
        reusable_policies: [
          {
            id: "legacy-policy-id",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
      },
      mutation_state: "not_started",
    });
    expect(
      Object.keys(applicationSnapshot.dependencies.reusable_policies[0]),
    ).toEqual(["id", "sha256"]);
  });

  it("preserves every unrelated writable application setting on PUT", () => {
    const state = legacyRemoteState();
    const preserved = {
      allow_iframe: true,
      cors_headers: {
        allow_all_headers: false,
        allowed_headers: ["X-Example"],
      },
      custom_deny_message: "Synthetic denial",
      custom_deny_url: "https://deny.example.invalid",
      custom_non_identity_deny_url: "https://deny.example.invalid/non-id",
      custom_pages: ["synthetic-page-id"],
      eager_redirect_cookie_setting: false,
      enable_binding_cookie: true,
      logo_url: "https://assets.example.invalid/logo.svg",
      mfa_config: {
        allowed_authenticators: ["biometrics"],
        mfa_disabled: false,
        session_duration: "24h",
      },
      oauth_configuration: {
        enabled: false,
      },
      path_cookie_attribute: true,
      read_service_tokens_from_header: "X-Synthetic-Service-Token",
      same_site_cookie_attribute: "strict",
      scim_config: {
        idp_uid: "synthetic-idp",
        remote_uri: "https://scim.example.invalid",
        enabled: false,
      },
      self_hosted_domains: ["stowplan.lasers.app/account*"],
      service_auth_401_redirect: true,
      skip_interstitial: true,
      tags: ["synthetic-tag"],
      use_clientless_isolation_app_launcher_url: true,
    };
    Object.assign(state.applications[0], preserved);
    const plan = buildPlan(config, state);
    const resolution = Object.values(plan.resolved.applications)[0] as {
      payload: Record<string, unknown>;
    };
    expect(resolution.payload).toMatchObject(preserved);
    expect(resolution.payload).toMatchObject({
      domain: "stowplan.lasers.app/admin",
      destinations: ADMIN_DESTINATIONS,
      allowed_idps: ["@identity_provider:admin-cloudflare"],
      policies: [
        {
          id: "@reusable_policy:admin-account-members",
          precedence: 1,
        },
      ],
    });
  });

  it("loads application detail before building writable PUT state", async () => {
    const api = new FakeCloudflareApi();
    api.state.applications[0].allow_iframe = true;
    const state = await loadRemoteState(api);
    expect(state?.applications[0]).toMatchObject({
      id: "managed-app-id",
      allow_iframe: true,
      policies: [
        {
          id: "legacy-policy-id",
          precedence: 1,
        },
      ],
    });
    expect(
      api.requests.filter(
        ({ method, endpoint }) =>
          method === "GET" && endpoint.startsWith("/access/apps/"),
      ),
    ).toHaveLength(api.state.applications.length);
  });

  it("refuses a rollback snapshot that would persist a credential field", () => {
    const state = legacyRemoteState();
    Object.assign(state.applications[0], {
      scim_config: {
        idp_uid: "synthetic-idp",
        remote_uri: "https://scim.example.invalid",
        authentication: {
          scheme: "access_service_token",
          client_id: "synthetic-client",
          client_secret: "synthetic-secret",
        },
      },
    });
    const plan = buildPlan(config, state);
    expect(() =>
      createRollbackSnapshot(config, "account-id", plan)
    ).toThrow("rollback snapshot would contain forbidden field");
  });

  it("applies in dependency order and restores the private snapshot", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "stowplan-access-test-"),
    );
    const rollbackPath = join(temporaryDirectory, "rollback.json");
    const api = new FakeCloudflareApi();
    try {
      const finalPlan = await applyAccessPlan({
        api,
        config,
        initialState: structuredClone(api.state),
        rollbackPath,
      });
      expect(finalPlan.changeCount).toBe(0);
      expect((await stat(rollbackPath)).mode & 0o077).toBe(0);
      const serializedSnapshot = await readFile(rollbackPath, "utf8");
      expect(serializedSnapshot).not.toMatch(
        /private-person|private-audience|example\.invalid/,
      );
      expect(api.state.applications[0]).toMatchObject({
        id: "managed-app-id",
        aud: "private-audience-value",
        domain: "stowplan.lasers.app/admin",
        destinations: ADMIN_DESTINATIONS,
        session_duration: "2h",
      });
      expect(api.state.identityProviders).toHaveLength(2);
      expect(api.state.reusablePolicies).toHaveLength(2);

      await rollbackAccessPlan({ api, config, rollbackPath });
      expect(api.state.applications[0]).toMatchObject({
        id: "managed-app-id",
        aud: "private-audience-value",
        domain: "stowplan.lasers.app/account*",
        destinations: expect.arrayContaining(LEGACY_DESTINATIONS),
        session_duration: "24h",
        allowed_idps: ["legacy-otp-id"],
      });
      expect(api.state.identityProviders).toHaveLength(1);
      expect(api.state.reusablePolicies).toHaveLength(1);
      const completedSnapshot = JSON.parse(
        await readFile(rollbackPath, "utf8"),
      );
      expect([
        completedSnapshot.resources.identity_providers["admin-cloudflare"]
          .mutation_state,
        completedSnapshot.resources.reusable_policies[
          "admin-account-members"
        ].mutation_state,
        completedSnapshot.resources.applications.admin.mutation_state,
      ]).toEqual([
        "rolled_back",
        "rolled_back",
        "rolled_back",
      ]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("verifies a successful mutation after bounded stale reads without repeating it", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "stowplan-access-test-"),
    );
    const rollbackPath = join(temporaryDirectory, "rollback.json");
    const api = new FakeCloudflareApi();
    const staleState = structuredClone(api.state);
    const delays: number[] = [];
    let verificationReads = 0;
    try {
      const finalPlan = await applyAccessPlan({
        api,
        config,
        initialState: structuredClone(api.state),
        rollbackPath,
        verification: {
          readRemoteState: async (candidateApi: FakeCloudflareApi) => {
            verificationReads += 1;
            if (verificationReads <= 2) {
              return structuredClone(staleState);
            }
            return loadRemoteState(candidateApi);
          },
          wait: async (delay: number) => {
            delays.push(delay);
          },
        },
      });

      expect(finalPlan.changeCount).toBe(0);
      expect(delays).toEqual([
        POST_MUTATION_VERIFICATION_INITIAL_BACKOFF_MS,
        Math.min(
          POST_MUTATION_VERIFICATION_INITIAL_BACKOFF_MS * 2,
          POST_MUTATION_VERIFICATION_MAX_BACKOFF_MS,
        ),
      ]);
      expect(api.requests.filter(
        ({ method, endpoint }) =>
          method === "POST"
          && endpoint === "/access/identity_providers",
      )).toHaveLength(1);
      expect(api.requests.filter(
        ({ method, endpoint }) =>
          method === "POST"
          && endpoint === "/access/policies",
      )).toHaveLength(1);
      expect(api.requests.filter(
        ({ method, endpoint }) =>
          method === "PUT"
          && endpoint === "/access/apps/managed-app-id",
      )).toHaveLength(1);
      const snapshot = JSON.parse(
        await readFile(rollbackPath, "utf8"),
      );
      expect(
        snapshot.resources.identity_providers["admin-cloudflare"],
      ).toMatchObject({
        after_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        created_id: expect.any(String),
        mutation_state: "applied",
      });
      expect(snapshot.resources.applications.admin).toMatchObject({
        after_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        mutation_state: "applied",
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("leaves an exhausted verification pending without duplicate or dependent mutations", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "stowplan-access-test-"),
    );
    const rollbackPath = join(temporaryDirectory, "rollback.json");
    const api = new FakeCloudflareApi();
    const staleState = structuredClone(api.state);
    let verificationReads = 0;
    let waits = 0;
    try {
      await expect(applyAccessPlan({
        api,
        config,
        initialState: structuredClone(api.state),
        rollbackPath,
        verification: {
          readRemoteState: async () => {
            verificationReads += 1;
            return structuredClone(staleState);
          },
          wait: async () => {
            waits += 1;
          },
        },
      })).rejects.toThrow(
        `could not be verified after ${POST_MUTATION_VERIFICATION_READ_LIMIT} post-mutation reads`,
      );
      expect(verificationReads).toBe(
        POST_MUTATION_VERIFICATION_READ_LIMIT,
      );
      expect(waits).toBe(
        POST_MUTATION_VERIFICATION_READ_LIMIT - 1,
      );
      expect(api.requests.filter(
        ({ method }) => method === "POST" || method === "PUT",
      )).toEqual([{
        endpoint: "/access/identity_providers",
        method: "POST",
      }]);
      expect(api.state.applications[0].domain).toBe(
        "stowplan.lasers.app/account*",
      );
      const snapshot = JSON.parse(
        await readFile(rollbackPath, "utf8"),
      );
      expect(
        snapshot.resources.identity_providers["admin-cloudflare"],
      ).toMatchObject({
        after_digest: null,
        created_id: null,
        mutation_state: "pending",
      });
      expect(
        snapshot.resources.reusable_policies[
          "admin-account-members"
        ].mutation_state,
      ).toBe("not_started");
      expect(
        snapshot.resources.applications.admin.mutation_state,
      ).toBe("not_started");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("refuses rollback when a redacted legacy dependency changed", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "stowplan-access-test-"),
    );
    const rollbackPath = join(temporaryDirectory, "rollback.json");
    const api = new FakeCloudflareApi();
    try {
      await applyAccessPlan({
        api,
        config,
        initialState: structuredClone(api.state),
        rollbackPath,
      });
      const legacy = api.state.reusablePolicies.find(
        ({ id }) => id === "legacy-policy-id",
      );
      if (legacy === undefined) {
        throw new Error("synthetic legacy policy is missing");
      }
      legacy.name = "changed outside the reconciler";
      await expect(
        rollbackAccessPlan({ api, config, rollbackPath }),
      ).rejects.toThrow("changed reusable_policy dependency");
      expect(api.state.applications[0].domain).toBe(
        "stowplan.lasers.app/admin",
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("refuses rollback when a redacted legacy provider changed", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "stowplan-access-test-"),
    );
    const rollbackPath = join(temporaryDirectory, "rollback.json");
    const api = new FakeCloudflareApi();
    try {
      await applyAccessPlan({
        api,
        config,
        initialState: structuredClone(api.state),
        rollbackPath,
      });
      const legacy = api.state.identityProviders.find(
        ({ id }) => id === "legacy-otp-id",
      );
      if (legacy === undefined) {
        throw new Error("synthetic legacy provider is missing");
      }
      legacy.name = "changed outside the reconciler";
      await expect(
        rollbackAccessPlan({ api, config, rollbackPath }),
      ).rejects.toThrow("changed identity_provider dependency");
      expect(api.state.applications[0].domain).toBe(
        "stowplan.lasers.app/admin",
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rechecks unmanaged overlap before restoring legacy paths", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "stowplan-access-test-"),
    );
    const rollbackPath = join(temporaryDirectory, "rollback.json");
    const api = new FakeCloudflareApi();
    try {
      api.state.applications[0].self_hosted_domains = [
        "stowplan.lasers.app/legacy-hidden/*",
      ];
      await applyAccessPlan({
        api,
        config,
        initialState: structuredClone(api.state),
        rollbackPath,
      });
      api.state.applications.push({
        id: "new-overlap-id",
        name: "new unmanaged overlap",
        type: "bookmark",
        domain: "https://other.example.invalid",
        destinations: [
          {
            type: "public",
            uri: "stowplan.lasers.app/legacy-hidden/*",
          },
        ],
        allowed_idps: ["legacy-otp-id"],
        policies: [],
      });
      await expect(
        rollbackAccessPlan({ api, config, rollbackPath }),
      ).rejects.toThrow(
        "legacy destinations overlap an unmanaged Access application",
      );
      expect(api.state.applications[0].domain).toBe(
        "stowplan.lasers.app/admin",
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("persists uncertain writes and refuses automatic rollback", async () => {
    class UncertainCreateApi extends FakeCloudflareApi {
      failed = false;

      async request(
        method: string,
        endpoint: string,
        payload?: Record<string, unknown>,
      ) {
        if (
          !this.failed
          && method === "POST"
          && endpoint === "/access/identity_providers"
        ) {
          this.failed = true;
          await super.request(method, endpoint, payload);
          throw new Error("synthetic response loss");
        }
        return super.request(method, endpoint, payload);
      }
    }

    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "stowplan-access-test-"),
    );
    const rollbackPath = join(temporaryDirectory, "rollback.json");
    const api = new UncertainCreateApi();
    try {
      await expect(
        applyAccessPlan({
          api,
          config,
          initialState: structuredClone(api.state),
          rollbackPath,
        }),
      ).rejects.toThrow("synthetic response loss");
      const snapshot = JSON.parse(await readFile(rollbackPath, "utf8"));
      expect(snapshot.schema_version).toBe(2);
      expect(
        snapshot.resources.identity_providers["admin-cloudflare"]
          .mutation_state,
      ).toBe("pending");
      const requestCount = api.requests.length;
      await expect(
        rollbackAccessPlan({ api, config, rollbackPath }),
      ).rejects.toThrow("uncertain pending mutation");
      expect(api.requests).toHaveLength(requestCount);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("resumes rollback after a successful write lost its response", async () => {
    class InterruptedRollbackApi extends FakeCloudflareApi {
      failed = false;

      async request(
        method: string,
        endpoint: string,
        payload?: Record<string, unknown>,
      ) {
        if (
          !this.failed
          && method === "DELETE"
          && endpoint.startsWith("/access/policies/")
        ) {
          this.failed = true;
          await super.request(method, endpoint, payload);
          throw new Error("synthetic rollback response loss");
        }
        return super.request(method, endpoint, payload);
      }
    }

    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "stowplan-access-test-"),
    );
    const rollbackPath = join(temporaryDirectory, "rollback.json");
    const api = new InterruptedRollbackApi();
    try {
      await applyAccessPlan({
        api,
        config,
        initialState: structuredClone(api.state),
        rollbackPath,
      });
      await expect(
        rollbackAccessPlan({ api, config, rollbackPath }),
      ).rejects.toThrow("synthetic rollback response loss");
      const interruptedSnapshot = JSON.parse(
        await readFile(rollbackPath, "utf8"),
      );
      expect(
        interruptedSnapshot.resources.applications.admin.mutation_state,
      ).toBe("rolled_back");
      expect(
        interruptedSnapshot.resources.reusable_policies[
          "admin-account-members"
        ].mutation_state,
      ).toBe("applied");

      await rollbackAccessPlan({ api, config, rollbackPath });
      const appPuts = api.requests.filter(
        ({ method, endpoint }) =>
          method === "PUT"
          && endpoint === "/access/apps/managed-app-id",
      );
      expect(appPuts).toHaveLength(2);
      expect(api.state.identityProviders).toHaveLength(1);
      expect(api.state.reusablePolicies).toHaveLength(1);
      expect(api.state.applications[0].domain).toBe(
        "stowplan.lasers.app/account*",
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("Cloudflare Access pagination", () => {
  it("collects every page and refuses duplicate resources", async () => {
    const requestedPages: number[] = [];
    const api = new CloudflareApi({
      accountId: "account-id",
      apiToken: "api-token",
      fetchImpl: async (url) => {
        const page = Number(new URL(String(url)).searchParams.get("page"));
        requestedPages.push(page);
        const start = (page - 1) * 100;
        const count = page === 1 ? 100 : 1;
        return new Response(
          JSON.stringify({
            success: true,
            result: Array.from({ length: count }, (_, index) => ({
              id: `resource-${start + index + 1}`,
            })),
            result_info: {
              page,
              per_page: 100,
              count,
              total_count: 101,
              total_pages: 2,
            },
          }),
          { status: 200 },
        );
      },
      apiRoot: "https://api.example.invalid",
    });
    const resources = await api.list("/access/apps");
    expect(resources).toHaveLength(101);
    expect(resources?.at(0)).toEqual({ id: "resource-1" });
    expect(resources?.at(-1)).toEqual({ id: "resource-101" });
    expect(requestedPages).toEqual([1, 2]);

    const duplicateApi = new CloudflareApi({
      accountId: "account-id",
      apiToken: "api-token",
      fetchImpl: async (url) => {
        const page = Number(new URL(String(url)).searchParams.get("page"));
        const count = page === 1 ? 100 : 1;
        return new Response(
          JSON.stringify({
            success: true,
            result: Array.from({ length: count }, (_, index) => ({
              id: index === 0 ? "duplicate-id" : `resource-${index}`,
            })),
            result_info: {
              page,
              per_page: 100,
              count,
              total_count: 101,
              total_pages: 2,
            },
          }),
          { status: 200 },
        );
      },
      apiRoot: "https://api.example.invalid",
    });
    await expect(duplicateApi.list("/access/apps")).rejects.toThrow(
      "pagination returned a duplicate resource",
    );
  });

  it.each([
    {
      label: "a discontinuous page number",
      resultInfo: {
        page: 2,
        per_page: 100,
        count: 1,
        total_count: 1,
        total_pages: 1,
      },
      message: "metadata is incomplete or inconsistent",
    },
    {
      label: "an incorrect page count",
      resultInfo: {
        page: 1,
        per_page: 100,
        count: 2,
        total_count: 1,
        total_pages: 1,
      },
      message: "metadata is incomplete or inconsistent",
    },
    {
      label: "an incorrect total page count",
      resultInfo: {
        page: 1,
        per_page: 100,
        count: 1,
        total_count: 101,
        total_pages: 1,
      },
      message: "total page count is inconsistent",
    },
  ])("refuses $label", async ({ resultInfo, message }) => {
    const api = new CloudflareApi({
      accountId: "account-id",
      apiToken: "api-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "resource-id" }],
            result_info: resultInfo,
          }),
          { status: 200 },
        ),
      apiRoot: "https://api.example.invalid",
    });
    await expect(api.list("/access/apps")).rejects.toThrow(message);
  });

  it("refuses changing totals and resources without stable IDs", async () => {
    const changingApi = new CloudflareApi({
      accountId: "account-id",
      apiToken: "api-token",
      fetchImpl: async (url) => {
        const page = Number(new URL(String(url)).searchParams.get("page"));
        const totalCount = page === 1 ? 101 : 102;
        const count = page === 1 ? 100 : 2;
        return new Response(
          JSON.stringify({
            success: true,
            result: Array.from({ length: count }, (_, index) => ({
              id: `resource-${page}-${index}`,
            })),
            result_info: {
              page,
              per_page: 100,
              count,
              total_count: totalCount,
              total_pages: 2,
            },
          }),
          { status: 200 },
        );
      },
      apiRoot: "https://api.example.invalid",
    });
    await expect(changingApi.list("/access/apps")).rejects.toThrow(
      "changed while inventory was read",
    );

    const missingIdApi = new CloudflareApi({
      accountId: "account-id",
      apiToken: "api-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [{}],
            result_info: {
              page: 1,
              per_page: 100,
              count: 1,
              total_count: 1,
              total_pages: 1,
            },
          }),
          { status: 200 },
        ),
      apiRoot: "https://api.example.invalid",
    });
    await expect(missingIdApi.list("/access/apps")).rejects.toThrow(
      "resource without an ID",
    );
  });

  it("redacts API error messages", async () => {
    const api = new CloudflareApi({
      accountId: "account-id",
      apiToken: "api-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [
              {
                code: 999,
                message: "private-person@example.invalid failed",
              },
            ],
          }),
          { status: 400 },
        ),
      apiRoot: "https://api.example.invalid",
    });
    await expect(api.list("/access/apps")).rejects.toThrow(
      "Cloudflare API request failed (HTTP 400, codes 999)",
    );
    await expect(api.list("/access/apps")).rejects.not.toThrow(
      "private-person",
    );
  });
});
