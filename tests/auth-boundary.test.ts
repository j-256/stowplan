import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import {
  authenticateAccessRecoveryPrincipals,
  authorizeAccessBoundSession,
  createOrLinkUser,
  developmentAuthenticationAllowed,
  issueSession,
  provider,
  TurnstileVerificationError,
  verifyAccess,
  verifyTurnstile,
} from "../src/server/auth";
import {
  identityEnforcementDigest,
} from "../src/server/account-governance";
import { OAUTH_TURNSTILE_ACTION } from "../src/shared/authentication";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

afterEach(() => {
  vi.restoreAllMocks();
});

function siteverifyResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    action: OAUTH_TURNSTILE_ACTION,
    challenge_ts: new Date().toISOString(),
    hostname: "stowplan.example",
    success: true,
    ...overrides,
  });
}

async function signedAccessRequest(input: {
  audience: string;
  email: string;
  privateKey: Awaited<
    ReturnType<typeof generateKeyPair>
  >["privateKey"];
  sessionToken: string;
  subject: string;
  teamDomain: string;
}): Promise<Request> {
  const assertion = await new SignJWT({
    email: input.email,
    name: "Access operator",
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: "access-test-key",
    })
    .setAudience(input.audience)
    .setIssuer(`https://${input.teamDomain}`)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(input.privateKey);
  return new Request(
    "https://stowplan.example/admin",
    {
      headers: {
        "cf-access-jwt-assertion": assertion,
        cookie:
          `__Host-stowplan_session=${input.sessionToken}`,
      },
    },
  );
}

describe("Turnstile verification", () => {
  it("accepts only the expected action and hostname", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(siteverifyResponse());

    await expect(verifyTurnstile(
      {
        AUTH_BASE_URL: "https://stowplan.example",
        AUTH_TURNSTILE_SECRET_KEY: "test-secret",
      },
      "browser-token",
      "https://stowplan.example",
      "192.0.2.44",
    )).resolves.toBeUndefined();

    const request = fetchSpy.mock.calls[0]?.[1];
    const body = request?.body as URLSearchParams;
    expect(body.get("response")).toBe("browser-token");
    expect(body.get("remoteip")).toBe("192.0.2.44");
  });

  it.each([
    { action: "different_action" },
    { hostname: "lookalike.example" },
    { success: false },
    { challenge_ts: "2020-01-01T00:00:00.000Z" },
  ])("rejects an invalid Siteverify result", async (override) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      siteverifyResponse(override),
    );

    await expect(verifyTurnstile(
      {
        AUTH_BASE_URL: "https://stowplan.example",
        AUTH_TURNSTILE_SECRET_KEY: "test-secret",
      },
      "browser-token",
      "https://stowplan.example",
    )).rejects.toMatchObject({
      status: 400,
    } satisfies Partial<TurnstileVerificationError>);
  });

  it("fails closed without configuration or Siteverify availability", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(verifyTurnstile(
      {},
      "browser-token",
      "https://stowplan.example",
    )).rejects.toMatchObject({
      status: 503,
    } satisfies Partial<TurnstileVerificationError>);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(verifyTurnstile(
      {
        AUTH_BASE_URL: "https://stowplan.example",
        AUTH_TURNSTILE_SECRET_KEY: "test-secret",
      },
      "browser-token",
      "https://stowplan.example",
    )).rejects.toMatchObject({
      status: 503,
    } satisfies Partial<TurnstileVerificationError>);
  });

  it("refuses official test credentials on a production hostname", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(verifyTurnstile(
      {
        AUTH_BASE_URL: "https://stowplan.jklein.dev",
        AUTH_TURNSTILE_SECRET_KEY:
          "1x0000000000000000000000000000000AA",
        AUTH_TURNSTILE_SITE_KEY:
          "1x00000000000000000000AA",
      },
      "dummy-token",
      "https://stowplan.jklein.dev",
    )).rejects.toMatchObject({
      status: 503,
    } satisfies Partial<TurnstileVerificationError>);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not forward an invalid client address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(siteverifyResponse());

    await verifyTurnstile(
      {
        AUTH_BASE_URL: "https://stowplan.example",
        AUTH_TURNSTILE_SECRET_KEY: "test-secret",
      },
      "browser-token",
      "https://stowplan.example",
      "not-an-ip",
    );

    const body = fetchSpy.mock.calls[0]?.[1]
      ?.body as URLSearchParams;
    expect(body.has("remoteip")).toBe(false);
  });
});

describe("development authentication boundary", () => {
  it("allows loopback, reserved test hosts, and explicit staging hosts", () => {
    expect(developmentAuthenticationAllowed(
      { AUTH_DEV_ENABLED: "true" },
      "http://localhost:3000/api/auth/dev",
    )).toBe(true);
    expect(developmentAuthenticationAllowed(
      { AUTH_DEV_ENABLED: "true" },
      "https://stowplan.test/api/auth/dev",
    )).toBe(true);
    expect(developmentAuthenticationAllowed(
      {
        AUTH_DEV_ALLOWED_HOSTS: "auth-staging.example",
        AUTH_DEV_ENABLED: "true",
      },
      "https://auth-staging.example/api/auth/dev",
    )).toBe(true);
  });

  it("always refuses the production host", () => {
    expect(developmentAuthenticationAllowed(
      {
        AUTH_BASE_URL: "https://stowplan.jklein.dev",
        AUTH_DEV_ALLOWED_HOSTS: "stowplan.jklein.dev",
        AUTH_DEV_ENABLED: "true",
      },
      "https://stowplan.jklein.dev/api/auth/dev",
    )).toBe(false);
  });

  it("validates the request host even when AUTH_BASE_URL is local", () => {
    expect(developmentAuthenticationAllowed(
      {
        AUTH_BASE_URL: "http://localhost:3000",
        AUTH_DEV_ENABLED: "true",
      },
      "https://public.example/api/auth/dev",
    )).toBe(false);
  });

  it("requires explicit enablement outside production", () => {
    expect(developmentAuthenticationAllowed(
      {},
      "http://localhost:3000/api/auth/dev",
    )).toBe(false);
  });
});

describe("identity enforcement boundary", () => {
  const digestKey =
    "test-identity-digest-key-at-least-32-bytes";

  it("advertises Google only with a valid digest key and complete configuration", () => {
    const google = {
      AUTH_BASE_URL: "https://stowplan.example",
      AUTH_GOOGLE_CLIENT_ID: "client-id",
      AUTH_GOOGLE_CLIENT_SECRET: "client-secret",
      AUTH_TURNSTILE_SECRET_KEY: "turnstile-secret",
      AUTH_TURNSTILE_SITE_KEY: "turnstile-site-key",
    };
    expect(provider(
      {
        ...google,
        AUTH_IDENTITY_DIGEST_KEY: "too-short",
      },
      "google",
    )).toBeNull();
    expect(provider(
      {
        ...google,
        AUTH_IDENTITY_DIGEST_KEY: digestKey,
      },
      "google",
    )).toMatchObject({ id: "google" });
    expect(provider(
      {
        ...google,
        AUTH_IDENTITY_DIGEST_KEY: digestKey,
      },
      "github",
    )).toBeNull();
    expect(provider(
      {
        ...google,
        AUTH_BASE_URL: undefined,
        AUTH_IDENTITY_DIGEST_KEY: digestKey,
      },
      "google",
    )).toBeNull();
    expect(provider(
      {
        ...google,
        AUTH_BASE_URL: "https://stowplan.example/account",
        AUTH_IDENTITY_DIGEST_KEY: digestKey,
      },
      "google",
    )).toBeNull();
  });

  it("refuses every account link path without a digest key", async () => {
    const { database, sqlite } = numberedMigrationDatabase();

    await expect(createOrLinkUser(
      database,
      {},
      {
        displayName: "Unconfigured",
        email: "unconfigured@example.com",
        provider: "google",
        subject: "unconfigured-google-subject",
      },
    )).rejects.toThrow(
      "Identity enforcement is not configured",
    );
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM users",
    ).get()).toEqual({ count: 0 });
  });

  it("advertises test-key Google only on an isolated hostname", () => {
    const testGoogle = {
      AUTH_GOOGLE_CLIENT_ID: "client-id",
      AUTH_GOOGLE_CLIENT_SECRET: "client-secret",
      AUTH_IDENTITY_DIGEST_KEY: digestKey,
      AUTH_TURNSTILE_SECRET_KEY:
        "1x0000000000000000000000000000000AA",
      AUTH_TURNSTILE_SITE_KEY:
        "1x00000000000000000000AA",
    };
    expect(provider(
      {
        ...testGoogle,
        AUTH_BASE_URL: "https://stowplan.jklein.dev",
      },
      "google",
    )).toBeNull();
    expect(provider(
      {
        ...testGoogle,
        AUTH_BASE_URL: "http://localhost:3000",
      },
      "google",
    )).toMatchObject({ id: "google" });
    expect(provider(
      testGoogle,
      "google",
      "http://localhost:5173/api/auth/me",
    )).toMatchObject({ id: "google" });
  });

  it("checks a provider subject ban before account creation", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const digest = await identityEnforcementDigest(
      digestKey,
      "google",
      "banned-google-subject",
    );
    sqlite.prepare(
      `INSERT INTO identity_ban_digests(
         identity_digest,reason,created_at
       ) VALUES(?,?,?)`,
    ).run(
      digest,
      "Abuse prevention",
      new Date().toISOString(),
    );

    await expect(createOrLinkUser(
      database,
      { AUTH_IDENTITY_DIGEST_KEY: digestKey },
      {
        displayName: "Blocked",
        email: "blocked@example.com",
        provider: "google",
        subject: "banned-google-subject",
      },
    )).rejects.toMatchObject({
      code: "ACCOUNT_BANNED",
      status: 403,
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM users",
    ).get()).toEqual({ count: 0 });
  });

  it("separates recovery principals from normal email-bound admin access", async () => {
    const { database } = numberedMigrationDatabase();
    const user = await createOrLinkUser(
      database,
      { AUTH_IDENTITY_DIGEST_KEY: digestKey },
      {
        displayName: "App user",
        email: "app-user@example.com",
        provider: "test",
        subject: "app-user",
      },
    );
    const session = await issueSession(
      database,
      {},
      user,
      new Request("https://stowplan.example"),
    );
    const teamDomain = "team.cloudflareaccess.example";
    const audience = "access-audience";
    const { privateKey, publicKey } = await generateKeyPair(
      "RS256",
    );
    const jwk = {
      ...await exportJWK(publicKey),
      alg: "RS256",
      kid: "access-test-key",
      use: "sig",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => Response.json({ keys: [jwk] }),
    );
    const request = await signedAccessRequest({
      audience,
      email: "recovery-operator@example.com",
      privateKey,
      sessionToken: session.raw,
      subject: "access-operator-subject",
      teamDomain,
    });
    const canonicalRequest = await signedAccessRequest({
      audience,
      email: "app-user@example.com",
      privateKey,
      sessionToken: session.raw,
      subject: "access-canonical-subject",
      teamDomain,
    });
    const env = {
      AUTH_CLOUDFLARE_ACCESS_AUD: audience,
      AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN: teamDomain,
    };

    await expect(authorizeAccessBoundSession(
      database,
      env,
      canonicalRequest,
    )).resolves.toMatchObject({
      email: "app-user@example.com",
      userId: user.userId,
    });
    await expect(authenticateAccessRecoveryPrincipals(
      database,
      env,
      request,
    )).resolves.toMatchObject({
      access: {
        email: "recovery-operator@example.com",
        subject: "access-operator-subject",
      },
      user: {
        email: "app-user@example.com",
        userId: user.userId,
      },
    });
    await expect(authorizeAccessBoundSession(
      database,
      env,
      request,
    )).rejects.toMatchObject({
      status: 403,
    });

    await createOrLinkUser(
      database,
      { AUTH_IDENTITY_DIGEST_KEY: digestKey },
      {
        displayName: "Renamed operator",
        email: "recovery-operator@example.com",
        provider: "google",
        subject: "renamed-google-subject",
      },
      {
        linkIntent: {
          sessionId: session.sessionId,
          userId: user.userId,
        },
        requireRecentAuthentication: true,
      },
    );
    await expect(authorizeAccessBoundSession(
      database,
      env,
      request,
    )).resolves.toMatchObject({
      email: "app-user@example.com",
      userId: user.userId,
    });
    await expect(authorizeAccessBoundSession(
      database,
      env,
      canonicalRequest,
    )).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects a stale canonical email after Google reports an address change", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const user = await createOrLinkUser(
      database,
      { AUTH_IDENTITY_DIGEST_KEY: digestKey },
      {
        displayName: "Google operator",
        email: "old-operator@example.com",
        provider: "google",
        subject: "stable-google-operator",
      },
    );
    const session = await issueSession(
      database,
      {},
      user,
      new Request("https://stowplan.example"),
    );
    await createOrLinkUser(
      database,
      { AUTH_IDENTITY_DIGEST_KEY: digestKey },
      {
        displayName: "Google operator",
        email: "current-operator@example.com",
        provider: "google",
        subject: "stable-google-operator",
      },
    );
    expect(sqlite.prepare(
      `SELECT u.email AS canonical_email,i.email AS identity_email
       FROM users u
       JOIN identities i ON i.user_id=u.user_id
       WHERE u.user_id=? AND i.provider='google'`,
    ).get(user.userId)).toEqual({
      canonical_email: "old-operator@example.com",
      identity_email: "current-operator@example.com",
    });

    const teamDomain =
      "changed-email-team.cloudflareaccess.example";
    const audience = "changed-email-access-audience";
    const { privateKey, publicKey } = await generateKeyPair(
      "RS256",
    );
    const jwk = {
      ...await exportJWK(publicKey),
      alg: "RS256",
      kid: "access-test-key",
      use: "sig",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => Response.json({ keys: [jwk] }),
    );
    const oldAddressRequest = await signedAccessRequest({
      audience,
      email: "old-operator@example.com",
      privateKey,
      sessionToken: session.raw,
      subject: "access-reassigned-address-holder",
      teamDomain,
    });
    const currentAddressRequest = await signedAccessRequest({
      audience,
      email: "current-operator@example.com",
      privateKey,
      sessionToken: session.raw,
      subject: "access-current-google-holder",
      teamDomain,
    });
    const env = {
      AUTH_CLOUDFLARE_ACCESS_AUD: audience,
      AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN: teamDomain,
    };

    await expect(authorizeAccessBoundSession(
      database,
      env,
      oldAddressRequest,
    )).rejects.toMatchObject({
      status: 403,
    });
    await expect(authorizeAccessBoundSession(
      database,
      env,
      currentAddressRequest,
    )).resolves.toMatchObject({
      email: "old-operator@example.com",
      userId: user.userId,
    });
  });

  it("distinguishes Access signing-key outages from invalid assertions", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const assertion = await new SignJWT({
      email: "operator@example.com",
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: "unavailable-access-key",
      })
      .setAudience("outage-audience")
      .setIssuer("https://outage.cloudflareaccess.example")
      .setSubject("outage-operator")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    await expect(verifyAccess(
      {
        AUTH_CLOUDFLARE_ACCESS_AUD: "outage-audience",
        AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN:
          "outage.cloudflareaccess.example",
      },
      assertion,
    )).rejects.toMatchObject({
      status: 503,
    });
  });
});
