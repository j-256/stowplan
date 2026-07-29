import { describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createEmptyState } from "../src/domain/factories";
import {
  guestInvitationRoleFromToken,
} from "../src/domain/app-url";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import {
  AUTH_CLEANUP_BATCH_SIZE,
  AuthorizationError,
  authenticate,
  authorizeAdmin,
  beginOAuth,
  claimWorkspace,
  cleanupAuthRecords,
  cookieValue,
  consumeGuestLink,
  createGuestLink,
  createOrLinkUser,
  finishOAuth,
  hasLinkedGoogleIdentity,
  InvitationError,
  isTrustedMutation,
  issueSession,
  markSessionReauthenticated,
  revokeCurrentSession,
  sessionCookie,
} from "../src/server/auth";
import { QuotaExceededError } from "../src/server/quotas";
import {
  API_QUOTAS,
  GUEST_LINK_EXPIRY_HOURS,
} from "../src/shared/api-quotas";
import {
  PUBLIC_LAUNCH_LIMITS,
} from "../src/shared/governance-policy";
import {
  CURRENT_TERMS_VERSION,
  SESSION_PERSISTENCE,
} from "../src/shared/terms";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";
import { TEST_AUTH_ENV } from "./helpers/auth";

function database() {
  return numberedMigrationDatabase().database;
}

const SIGN_IN_OAUTH_OPTIONS = Object.freeze({
  intent: "sign-in" as const,
  sessionPersistence: SESSION_PERSISTENCE.BROWSER_SESSION,
  termsVersion: CURRENT_TERMS_VERSION,
});

function bindingValue(cookie: string): string {
  return cookie.split(";", 1)[0]?.split("=", 2)[1] ?? "";
}

describe("authentication",()=>{
  it("uses host-only session and persistent cookies and rejects duplicate values", () => {
    expect(sessionCookie(
      "opaque",
      3_600,
      SESSION_PERSISTENCE.PERSISTENT,
    )).toMatch(
      /^__Host-stowplan_session=opaque; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600$/u,
    );
    expect(sessionCookie(
      "opaque",
      3_600,
      SESSION_PERSISTENCE.BROWSER_SESSION,
    )).toBe(
      "__Host-stowplan_session=opaque; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    expect(cookieValue(
      new Request("https://example.test", {
        headers: {
          cookie:
            "__Host-stowplan_session=first; __Host-stowplan_session=second",
        },
      }),
      "__Host-stowplan_session",
    )).toBeNull();
  });
  it("links identities, issues opaque sessions, and revokes them",async()=>{const db=database(),env=TEST_AUTH_ENV;const user=await createOrLinkUser(db,env,{provider:"test",subject:"one",email:"OWNER@example.com",displayName:"Owner"});expect(user.globalRole).toBe("user");const request=new Request("https://example.test",{headers:{"user-agent":"test"}}),session=await issueSession(db,env,user,request);expect(session.raw).toHaveLength(64);const authenticated=await authenticate(db,new Request("https://example.test",{headers:{cookie:`__Host-stowplan_session=${session.raw}`}}));expect(authenticated?.email).toBe("owner@example.com");await revokeCurrentSession(db,new Request("https://example.test",{headers:{cookie:`__Host-stowplan_session=${session.raw}`}}));expect(await authenticate(db,new Request("https://example.test",{headers:{cookie:`__Host-stowplan_session=${session.raw}`}}))).toBeNull()});
  it("reports whether the account has a linked Google identity", async () => {
    const db = database();
    const user = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Migration user",
      email: "migration-user@example.com",
      provider: "cloudflare-access",
      subject: "migration-user",
    });
    expect(await hasLinkedGoogleIdentity(db, user.userId)).toBe(
      false,
    );
    const session = await issueSession(
      db,
      {},
      user,
      new Request("https://example.test"),
    );
    await createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      {
        displayName: "Migration user",
        email: "migration-user@example.com",
        provider: "google",
        subject: "migration-user-google",
      },
      {
        linkIntent: {
          sessionId: session.sessionId,
          userId: user.userId,
        },
      },
    );
    expect(await hasLinkedGoogleIdentity(db, user.userId)).toBe(
      true,
    );
  });
  it("records reauthentication without consuming a session issuance budget", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const user = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Reauthentication user",
      email: "reauthentication@example.com",
      provider: "test",
      subject: "reauthentication-user",
    });
    const request = new Request("https://example.test");
    const session = await issueSession(
      db,
      TEST_AUTH_ENV,
      user,
      request,
    );
    const ledgerInsert = sqlite.prepare(
      `INSERT INTO creation_ledger(
         event_id, scope_type, scope_id, resource, created_at
       ) VALUES(?, 'account', ?, 'session', ?)`,
    );
    for (
      let index = 1;
      index < PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountDay;
      index += 1
    ) {
      ledgerInsert.run(
        `reauthentication-budget-${index}`,
        user.userId,
        new Date().toISOString(),
      );
    }

    await expect(issueSession(
      db,
      TEST_AUTH_ENV,
      user,
      request,
    )).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 429,
    });
    await expect(markSessionReauthenticated(
      db,
      user.userId,
      session.sessionId,
    )).resolves.toEqual({
      reauthenticatedAt: expect.any(String),
    });
    expect(sqlite.prepare(
      `SELECT reauthenticated_at
       FROM sessions
       WHERE session_id=?`,
    ).get(session.sessionId)).toEqual({
      reauthenticated_at: expect.any(String),
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM creation_ledger
       WHERE scope_id=? AND resource='session'`,
    ).get(user.userId)).toEqual({
      count: PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountDay,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='session.reauthenticate'
         AND target_id=?`,
    ).get(session.sessionId)).toEqual({ count: 1 });
  });
  it("scrubs OAuth credentials as soon as a state is claimed", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const oauthProvider = {
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "client-id",
      clientSecret: "client-secret",
      id: "google" as const,
      scopes: "openid email profile",
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
    const start = await beginOAuth(
      db,
      oauthProvider,
      "https://stowplan.example",
      "/spaces",
      SIGN_IN_OAUTH_OPTIONS,
    );
    const state = new URL(
      start.authorizationUrl,
    ).searchParams.get("state");
    expect(state).toBeTruthy();
    const before = sqlite.prepare(
      `SELECT verifier_ciphertext, return_to
       FROM oauth_states`,
    ).get() as {
      return_to: string;
      verifier_ciphertext: string;
    };
    expect(before.return_to).toBe("/spaces");
    expect(before.verifier_ciphertext).not.toBe("");
    const transaction = JSON.parse(
      before.verifier_ciphertext,
    ) as {
      sessionPersistence: string;
      termsVersion: string;
      verifier: string;
      version: number;
    };
    expect(transaction).toMatchObject({
      sessionPersistence:
        SESSION_PERSISTENCE.BROWSER_SESSION,
      termsVersion: CURRENT_TERMS_VERSION,
      version: 2,
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    try {
      await expect(finishOAuth(
        db,
        oauthProvider,
        "https://stowplan.example",
        state!,
        "authorization-code",
        bindingValue(start.bindingCookie),
      )).rejects.toThrow("OAuth token exchange failed");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const requestBody = new URLSearchParams(
        String(fetchSpy.mock.calls[0]?.[1]?.body),
      );
      expect(requestBody.get("code_verifier")).toBe(
        transaction.verifier,
      );
    } finally {
      fetchSpy.mockRestore();
    }

    expect(sqlite.prepare(
      `SELECT verifier_ciphertext, return_to, consumed_at
       FROM oauth_states`,
    ).get()).toMatchObject({
      consumed_at: expect.any(String),
      return_to: "/",
      verifier_ciphertext: "",
    });
  });
  it("binds each OAuth state to one browser without letting mismatches consume it", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const oauthProvider = {
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "client-id",
      clientSecret: "client-secret",
      id: "google" as const,
      scopes: "openid email profile",
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
    const start = await beginOAuth(
      db,
      oauthProvider,
      "https://stowplan.example",
      "/",
      SIGN_IN_OAUTH_OPTIONS,
    );
    const state = new URL(start.authorizationUrl)
      .searchParams.get("state")!;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(finishOAuth(
      db,
      oauthProvider,
      "https://stowplan.example",
      state,
      "authorization-code",
      "wrong-browser-binding",
    )).rejects.toThrow("OAuth browser binding is invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sqlite.prepare(
      `SELECT consumed_at,return_to,verifier_ciphertext
       FROM oauth_states`,
    ).get()).toMatchObject({
      consumed_at: null,
      return_to: "/",
      verifier_ciphertext: expect.not.stringMatching(/^$/u),
    });
  });
  it("restarts legacy sign-in states while preserving legacy authenticated intents", async () => {
    const oauthProvider = {
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "client-id",
      clientSecret: "client-secret",
      id: "google" as const,
      scopes: "openid email profile",
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
    const legacyTransaction = async (
      options: Parameters<typeof beginOAuth>[4],
    ) => {
      const { database: db, sqlite } = numberedMigrationDatabase();
      const start = await beginOAuth(
        db,
        oauthProvider,
        "https://stowplan.example",
        "/account",
        options,
      );
      const row = sqlite.prepare(
        "SELECT verifier_ciphertext FROM oauth_states",
      ).get() as { verifier_ciphertext: string };
      const envelope = JSON.parse(
        row.verifier_ciphertext,
      ) as Record<string, unknown>;
      envelope.version = 1;
      delete envelope.sessionPersistence;
      delete envelope.termsVersion;
      sqlite.prepare(
        "UPDATE oauth_states SET verifier_ciphertext=?",
      ).run(JSON.stringify(envelope));
      return { db, start };
    };
    const signIn = await legacyTransaction(
      SIGN_IN_OAUTH_OPTIONS,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(finishOAuth(
      signIn.db,
      oauthProvider,
      "https://stowplan.example",
      new URL(signIn.start.authorizationUrl)
        .searchParams.get("state")!,
      "authorization-code",
      bindingValue(signIn.start.bindingCookie),
    )).rejects.toThrow("OAuth transaction is invalid");
    expect(fetchSpy).not.toHaveBeenCalled();

    const link = await legacyTransaction({
      intent: "link",
      linkIntent: {
        sessionId: "ses_existing",
        userId: "usr_existing",
      },
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 503 }),
    );
    try {
      await expect(finishOAuth(
        link.db,
        oauthProvider,
        "https://stowplan.example",
        new URL(link.start.authorizationUrl)
          .searchParams.get("state")!,
        "authorization-code",
        bindingValue(link.start.bindingCookie),
      )).rejects.toThrow("OAuth token exchange failed");
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("reports Google signing-key outages as temporary unavailability", async () => {
    const db = database();
    const { privateKey } = await generateKeyPair("RS256");
    const oauthProvider = {
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "stowplan-jwks-outage-client",
      clientSecret: "client-secret",
      id: "google" as const,
      scopes: "openid email profile",
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
    const start = await beginOAuth(
      db,
      oauthProvider,
      "https://stowplan.example",
      "/account",
      SIGN_IN_OAUTH_OPTIONS,
    );
    const authorization = new URL(start.authorizationUrl);
    const nonce = authorization.searchParams.get("nonce")!;
    const state = authorization.searchParams.get("state")!;
    const idToken = await new SignJWT({
      azp: oauthProvider.clientId,
      email: "person@example.com",
      email_verified: true,
      nonce,
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: "unavailable-google-key",
      })
      .setIssuer("https://accounts.google.com")
      .setAudience(oauthProvider.clientId)
      .setSubject("google-jwks-outage-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const requestUrl = input instanceof Request
          ? input.url
          : String(input);
        if (requestUrl === oauthProvider.tokenUrl) {
          return Response.json({ id_token: idToken });
        }
        if (
          requestUrl ===
            "https://www.googleapis.com/oauth2/v3/certs"
        ) {
          return new Response(null, { status: 503 });
        }
        throw new Error(`Unexpected request to ${requestUrl}`);
      });
    try {
      await expect(finishOAuth(
        db,
        oauthProvider,
        "https://stowplan.example",
        state,
        "authorization-code",
        bindingValue(start.bindingCookie),
      )).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("strictly validates Google OIDC identity claims", async () => {
    const db = database();
    const { privateKey, publicKey } = await generateKeyPair(
      "RS256",
    );
    const jwk = {
      ...await exportJWK(publicKey),
      alg: "RS256",
      kid: "stowplan-google-test-key",
      use: "sig",
    };
    const oauthProvider = {
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "stowplan-client-id",
      clientSecret: "client-secret",
      id: "google" as const,
      scopes: "openid email profile",
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
    let nextIdToken = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const requestUrl = input instanceof Request
          ? input.url
          : String(input);
        if (requestUrl === oauthProvider.tokenUrl) {
          return Response.json({ id_token: nextIdToken });
        }
        if (
          requestUrl ===
            "https://www.googleapis.com/oauth2/v3/certs"
        ) {
          return Response.json({ keys: [jwk] });
        }
        throw new Error(`Unexpected request to ${requestUrl}`);
      });

    interface TokenClaims {
      audience?: string | string[];
      azp?: string | null;
      emailVerified?: boolean;
      expiresAt?: number;
      issuedAt?: number | null;
      issuer?: string;
      intent?: "link" | "reauthenticate" | "sign-in";
      nonce?: string;
      subject?: string | null;
    }
    const complete = async (
      claims: TokenClaims = {},
    ) => {
      const start = await beginOAuth(
        db,
        oauthProvider,
        "https://stowplan.example",
        "/account",
        claims.intent && claims.intent !== "sign-in"
          ? {
              intent: claims.intent,
              linkIntent: {
                sessionId: "ses_existing",
                userId: "usr_existing",
              },
            }
          : SIGN_IN_OAUTH_OPTIONS,
      );
      const authorization = new URL(start.authorizationUrl);
      const nonce = authorization.searchParams.get("nonce")!;
      const state = authorization.searchParams.get("state")!;
      const now = Math.floor(Date.now() / 1_000);
      const payload: Record<string, unknown> = {
        email: "person@example.com",
        email_verified: claims.emailVerified ?? true,
        name: "Test Person",
        nonce: claims.nonce ?? nonce,
      };
      if (claims.azp !== null) {
        payload.azp = claims.azp ?? oauthProvider.clientId;
      }
      let jwt = new SignJWT(payload)
        .setProtectedHeader({
          alg: "RS256",
          kid: "stowplan-google-test-key",
        })
        .setIssuer(
          claims.issuer ?? "https://accounts.google.com",
        )
        .setAudience(
          claims.audience ?? oauthProvider.clientId,
        )
        .setExpirationTime(claims.expiresAt ?? now + 300);
      if (claims.subject !== null) {
        jwt = jwt.setSubject(
          claims.subject ?? "google-subject-123",
        );
      }
      if (claims.issuedAt !== null) {
        jwt = jwt.setIssuedAt(claims.issuedAt ?? now);
      }
      nextIdToken = await jwt.sign(privateKey);
      return finishOAuth(
        db,
        oauthProvider,
        "https://stowplan.example",
        state,
        "authorization-code",
        bindingValue(start.bindingCookie),
      );
    };

    await expect(complete()).resolves.toMatchObject({
      intent: "sign-in",
      sessionPersistence:
        SESSION_PERSISTENCE.BROWSER_SESSION,
      termsVersion: CURRENT_TERMS_VERSION,
      profile: {
        displayName: "Test Person",
        email: "person@example.com",
        provider: "google",
        subject: "google-subject-123",
      },
      returnTo: "/account",
    });
    const now = Math.floor(Date.now() / 1_000);
    await expect(complete({
      intent: "reauthenticate",
    })).resolves.toMatchObject({
      intent: "reauthenticate",
      linkIntent: {
        sessionId: "ses_existing",
        userId: "usr_existing",
      },
      sessionPersistence: null,
      termsVersion: null,
    });
    await expect(complete({
      azp: null,
    })).resolves.toMatchObject({
      profile: {
        provider: "google",
        subject: "google-subject-123",
      },
    });
    for (const invalid of [
      { issuer: "https://lookalike.example" },
      { audience: "another-client" },
      { azp: "another-client" },
      {
        audience: [
          oauthProvider.clientId,
          "another-client",
        ],
        azp: null,
      },
      { nonce: "another-nonce" },
      { emailVerified: false },
      { subject: null },
      { issuedAt: null },
      { issuedAt: now - 700 },
      { issuedAt: now + 120 },
      { expiresAt: now - 120 },
    ] satisfies TokenClaims[]) {
      await expect(complete(invalid)).rejects.toThrow();
    }
    expect(fetchSpy).toHaveBeenCalled();
  });
  it("requests explicit Google account selection for linking and reauthentication", async () => {
    const db = database();
    const oauthProvider = {
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "stowplan-client-id",
      clientSecret: "client-secret",
      id: "google" as const,
      scopes: "openid email profile",
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
    const link = new URL((await beginOAuth(
      db,
      oauthProvider,
      "https://stowplan.example",
      "/account",
      {
        intent: "link",
        linkIntent: {
          sessionId: "ses_existing",
          userId: "usr_existing",
        },
      },
    )).authorizationUrl);
    expect(link.searchParams.get("prompt")).toBe(
      "select_account",
    );

    const reauthenticate = new URL((await beginOAuth(
      db,
      oauthProvider,
      "https://stowplan.example",
      "/account",
      {
        intent: "reauthenticate",
        linkIntent: {
          sessionId: "ses_existing",
          userId: "usr_existing",
        },
      },
    )).authorizationUrl);
    expect(reauthenticate.searchParams.get("prompt")).toBe(
      "select_account",
    );
    expect(reauthenticate.searchParams.has("max_age")).toBe(false);
  });
  it("creates every provider-backed account with ordinary user scope", async () => {
    const db = database();
    const env = TEST_AUTH_ENV;
    const unlisted = await createOrLinkUser(db, env, {
      displayName: "Unlisted",
      email: "unlisted@example.com",
      provider: "test",
      subject: "unlisted-first",
    });
    const configured = await createOrLinkUser(db, env, {
      displayName: "Configured",
      email: "configured-admin@example.com",
      provider: "test",
      subject: "configured-second",
    });

    expect(unlisted.globalRole).toBe("user");
    expect(configured.globalRole).toBe("user");
  });
  it("records Terms acceptance for new and returning accounts", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const returningProfile = {
      displayName: "Returning user",
      email: "returning@example.com",
      provider: "google",
      subject: "returning-google-subject",
    };
    const returning = await createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      returningProfile,
    );
    expect(sqlite.prepare(
      `SELECT terms_version, terms_accepted_at
       FROM users
       WHERE user_id=?`,
    ).get(returning.userId)).toEqual({
      terms_accepted_at: null,
      terms_version: null,
    });

    await createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      returningProfile,
      { termsVersion: CURRENT_TERMS_VERSION },
    );
    expect(sqlite.prepare(
      `SELECT terms_version, terms_accepted_at
       FROM users
       WHERE user_id=?`,
    ).get(returning.userId)).toEqual({
      terms_accepted_at: expect.any(String),
      terms_version: CURRENT_TERMS_VERSION,
    });

    const newcomer = await createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      {
        displayName: "New user",
        email: "new@example.com",
        provider: "google",
        subject: "new-google-subject",
      },
      { termsVersion: CURRENT_TERMS_VERSION },
    );
    expect(sqlite.prepare(
      `SELECT terms_version, terms_accepted_at
       FROM users
       WHERE user_id=?`,
    ).get(newcomer.userId)).toEqual({
      terms_accepted_at: expect.any(String),
      terms_version: CURRENT_TERMS_VERSION,
    });
  });
  it("never promotes an existing account during sign-in", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Initial owner",
      email: "initial-owner@example.com",
      provider: "test",
      subject: "initial-owner",
    });
    const existing = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Configured admin",
      email: "configured-admin@example.com",
      provider: "test",
      subject: "configured-admin",
    });
    expect(existing.globalRole).toBe("user");

    const signedIn = await createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      {
        displayName: "Configured admin",
        email: "configured-admin@example.com",
        provider: "test",
        subject: "configured-admin",
      },
    );

    expect(signedIn.globalRole).toBe("user");
    expect(sqlite.prepare(
      "SELECT global_role FROM users WHERE user_id = ?",
    ).get(existing.userId)).toEqual({ global_role: "user" });
  });
  it("requires authenticated intent to link a new subject to an existing account", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const user = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Linked account",
      email: "linked@example.com",
      provider: "google",
      subject: "google-primary",
    });
    await expect(createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Linked account",
      email: "linked@example.com",
      provider: "github",
      subject: "github-secondary",
    })).rejects.toThrow(
      "without that provider identity",
    );
    const session = await issueSession(
      db,
      {},
      user,
      new Request("https://example.test"),
    );
    await expect(createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      {
        displayName: "Linked account",
        email: "linked@example.com",
        provider: "github",
        subject: "github-secondary",
      },
      {
        linkIntent: {
          sessionId: session.sessionId,
          userId: user.userId,
        },
        requireRecentAuthentication: true,
      },
    )).resolves.toMatchObject({
      globalRole: "user",
      userId: user.userId,
    });
    sqlite.prepare(
      `UPDATE sessions
       SET created_at='2026-01-01T00:00:00.000Z',
           reauthenticated_at=NULL
       WHERE session_id=?`,
    ).run(session.sessionId);
    await expect(createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      {
        displayName: "Linked account",
        email: "linked@example.com",
        provider: "test",
        subject: "stale-secondary",
      },
      {
        linkIntent: {
          sessionId: session.sessionId,
          userId: user.userId,
        },
        requireRecentAuthentication: true,
      },
    )).rejects.toThrow(
      "Authenticated identity-link intent is no longer valid",
    );
    expect(sqlite.prepare(
      `SELECT provider,provider_subject,user_id
       FROM identities
       ORDER BY provider`,
    ).all()).toEqual([
      {
        provider: "github",
        provider_subject: "github-secondary",
        user_id: user.userId,
      },
      {
        provider: "google",
        provider_subject: "google-primary",
        user_id: user.userId,
      },
    ]);
  });
  it("caps retained identities for one account", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const user = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Identity quota",
      email: "identity-quota@example.com",
      provider: "google",
      subject: "identity-quota-primary",
    });
    const session = await issueSession(
      db,
      {},
      user,
      new Request("https://example.test"),
    );
    for (
      let index = 1;
      index < PUBLIC_LAUNCH_LIMITS.linkedIdentitiesPerAccount;
      index += 1
    ) {
      await createOrLinkUser(
        db,
        TEST_AUTH_ENV,
        {
          displayName: "Identity quota",
          email: "identity-quota@example.com",
          provider: `test-${index}`,
          subject: `identity-quota-${index}`,
        },
        {
          linkIntent: {
            sessionId: session.sessionId,
            userId: user.userId,
          },
        },
      );
    }
    await expect(createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      {
        displayName: "Identity quota",
        email: "identity-quota@example.com",
        provider: "test-over-limit",
        subject: "identity-quota-over-limit",
      },
      {
        linkIntent: {
          sessionId: session.sessionId,
          userId: user.userId,
        },
      },
    )).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 429,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM identities
       WHERE user_id=?`,
    ).get(user.userId)).toEqual({
      count: PUBLIC_LAUNCH_LIMITS.linkedIdentitiesPerAccount,
    });
  });
  it("stores only validated anonymous IP prefixes for normal sessions", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const user = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "prefix-owner",
      email: "prefix-owner@example.com",
      displayName: "Owner",
    });
    await issueSession(
      db,
      {},
      user,
      new Request("https://example.test", {
        headers: { "cf-connecting-ip": "2001:db8:1234:5678::1" },
      }),
    );
    await issueSession(
      db,
      {},
      user,
      new Request("https://example.test", {
        headers: { "cf-connecting-ip": "not-an-ip-address" },
      }),
    );
    await issueSession(
      db,
      {},
      user,
      new Request("https://example.test", {
        headers: { "cf-connecting-ip": "::ffff:192.0.2.33" },
      }),
    );

    expect(sqlite.prepare(
      `SELECT ip_prefix
       FROM sessions
       WHERE user_id = ?
       ORDER BY rowid`,
    ).all(user.userId)).toEqual([
      { ip_prefix: "2001:db8:1234::/48" },
      { ip_prefix: null },
      { ip_prefix: "192.0.2.0/24" },
    ]);
  });
  it("accepts an invite with D1 trigger-inclusive change metadata", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase({
      triggerInclusiveChanges: true,
    });
    const state = createEmptyState("Guest prefix");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "guest-prefix-owner",
      email: "guest-prefix-owner@example.com",
      displayName: "Owner",
    });
    const recipient = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "guest-prefix-recipient",
      email: "guest-prefix-recipient@example.com",
      displayName: "Recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    expect(guestInvitationRoleFromToken(link.raw)).toBe("viewer");
    await expect(consumeGuestLink(
      db,
      link.raw.replace("_viewer_", "_editor_"),
      recipient.userId,
    )).rejects.toThrow(/invalid, expired, used, or revoked/);
    await consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    );

    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, recipient.userId)).toEqual({
      role: "viewer",
    });
    expect(sqlite.prepare(
      `SELECT actor_user_id,target_id
       FROM auth_audit_events
       WHERE action='member.invite.accept'`,
    ).get()).toEqual({
      actor_user_id: recipient.userId,
      target_id: recipient.userId,
    });
  });
  it("rolls back a guest link when its audit insert fails", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest audit rollback");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Guest audit owner",
      email: "guest-audit-owner@example.com",
      provider: "test",
      subject: "guest-audit-owner",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    sqlite.exec(
      `CREATE TRIGGER reject_guest_audit
       BEFORE INSERT ON auth_audit_events
       WHEN NEW.action = 'guest.create'
       BEGIN
         SELECT RAISE(ABORT, 'injected guest audit failure');
       END`,
    );

    await expect(createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
    )).rejects.toThrow(/injected guest audit failure/);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM auth_audit_events",
    ).get()).toEqual({ count: 0 });
  });
  it("returns coded guest circuit refusals when breakers race mutations", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest circuit races");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Guest circuit owner",
      email: "guest-circuit-owner@example.com",
      provider: "test",
      subject: "guest-circuit-owner",
    });
    const recipient = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Guest circuit recipient",
      email: "guest-circuit-recipient@example.com",
      provider: "test",
      subject: "guest-circuit-recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    let creationRaced = false;
    const creationDatabase = {
      prepare: db.prepare.bind(db),
      async batch(statements: Parameters<typeof db.batch>[0]) {
        if (!creationRaced && statements.length === 2) {
          creationRaced = true;
          sqlite.prepare(
            `UPDATE circuit_breakers
             SET state='paused', pause_kind='security', resume_at=NULL
             WHERE scope='guest_links'`,
          ).run();
        }
        return db.batch(statements);
      },
    };
    const creationError = await createGuestLink(
      creationDatabase,
      state.workspace.id,
      owner.userId,
      "viewer",
    ).then(() => null, (error: unknown) => error);
    expect(creationError).toMatchObject({
      code: "CIRCUIT_PAUSED",
      status: 503,
    });
    expect(String(creationError)).not.toContain(
      "guest link creation is temporarily unavailable",
    );
    sqlite.prepare(
      `UPDATE circuit_breakers
       SET state='open'
       WHERE scope='guest_links'`,
    ).run();
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
    );

    let redemptionRaced = false;
    const redemptionDatabase = {
      prepare: db.prepare.bind(db),
      async batch(statements: Parameters<typeof db.batch>[0]) {
        if (!redemptionRaced && statements.length === 4) {
          redemptionRaced = true;
          sqlite.prepare(
            `UPDATE circuit_breakers
             SET state='paused', pause_kind='security', resume_at=NULL
             WHERE scope='guest_redemptions'`,
          ).run();
        }
        return db.batch(statements);
      },
    };
    const redemptionError = await consumeGuestLink(
      redemptionDatabase,
      link.raw,
      recipient.userId,
    ).then(() => null, (error: unknown) => error);
    expect(redemptionError).toMatchObject({
      code: "CIRCUIT_PAUSED",
      status: 503,
    });
    expect(String(redemptionError)).not.toContain(
      "guest link redemption is temporarily unavailable",
    );
    expect(sqlite.prepare(
      `SELECT consumed_at
       FROM guest_links
       WHERE guest_link_id=?`,
    ).get(link.id)).toEqual({ consumed_at: null });
  });
  it("requires an active workspace owner and strictly validates link expiry", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Owner-only guest links");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Owner",
      email: "owner-only@example.com",
      provider: "test",
      subject: "owner-only",
    });
    const editor = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Editor",
      email: "editor-only@example.com",
      provider: "test",
      subject: "editor-only",
    });
    const viewer = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Viewer",
      email: "viewer-only@example.com",
      provider: "test",
      subject: "viewer-only",
    });
    const outsider = await createOrLinkUser(
      db,
      TEST_AUTH_ENV,
      {
        displayName: "Global admin",
        email: "global-admin@example.com",
        provider: "test",
        subject: "global-admin-only",
      },
    );
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const createdAt = "2026-07-24T00:00:00.000Z";
    sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,?,?)`,
    ).run(state.workspace.id, editor.userId, "editor", createdAt);
    sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       ) VALUES(?,?,?,?)`,
    ).run(state.workspace.id, viewer.userId, "viewer", createdAt);

    for (const unauthorized of [editor, viewer, outsider]) {
      await expect(createGuestLink(
        db,
        state.workspace.id,
        unauthorized.userId,
        "viewer",
      )).rejects.toMatchObject({
        status: 403,
      } satisfies Partial<AuthorizationError>);
    }
    for (const hours of [
      GUEST_LINK_EXPIRY_HOURS.minimum - 1,
      GUEST_LINK_EXPIRY_HOURS.maximum + 1,
      GUEST_LINK_EXPIRY_HOURS.minimum + 0.5,
    ]) {
      await expect(createGuestLink(
        db,
        state.workspace.id,
        owner.userId,
        "viewer",
        hours,
      )).rejects.toThrow(
        `integer from ${GUEST_LINK_EXPIRY_HOURS.minimum} through ${GUEST_LINK_EXPIRY_HOURS.maximum} hours`,
      );
    }
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM auth_audit_events",
    ).get()).toEqual({ count: 0 });
  });
  it("advances access and membership revisions during guest redemption", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest redemption revisions");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Owner",
      email: "guest-revision-owner@example.com",
      provider: "test",
      subject: "guest-revision-owner",
    });
    const recipient = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Recipient",
      email: "guest-revision-recipient@example.com",
      provider: "test",
      subject: "guest-revision-recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ access_revision: 1 });

    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ access_revision: 2 });

    await consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    );
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id)).toEqual({ access_revision: 4 });
    expect(sqlite.prepare(
      `SELECT membership_revision
       FROM users
       WHERE user_id=?`,
    ).get(recipient.userId)).toEqual({ membership_revision: 1 });
    expect(sqlite.prepare(
      `SELECT detail_json
       FROM auth_audit_events
       WHERE action='guest.create'`,
    ).get()).toEqual({
      detail_json: JSON.stringify({
        expiresAt: link.expiresAt,
        role: "viewer",
        workspaceId: state.workspace.id,
      }),
    });
    expect(sqlite.prepare(
      `SELECT actor_user_id,target_id,detail_json
       FROM auth_audit_events
       WHERE action='member.invite.accept'`,
    ).get()).toEqual({
      actor_user_id: recipient.userId,
      target_id: recipient.userId,
      detail_json: JSON.stringify({
        guestLinkId: link.id,
        role: "viewer",
        workspaceId: state.workspace.id,
      }),
    });
  });
  it("does not redeem or recreate access through a deletion tombstone", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Deleted guest workspace");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Owner",
      email: "deleted-guest-owner@example.com",
      provider: "test",
      subject: "deleted-guest-owner",
    });
    const recipient = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Recipient",
      email: "deleted-guest-recipient@example.com",
      provider: "test",
      subject: "deleted-guest-recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    const snapshot = sqlite.prepare(
      `SELECT access_revision,revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(state.workspace.id) as {
      access_revision: number;
      revision: number;
    };
    sqlite.prepare(
      `INSERT INTO workspace_deletions(
         workspace_id,deletion_id,deleted_at,deleted_by_user_id,
         final_snapshot_revision,final_access_revision
       ) VALUES(?,?,?,?,?,?)`,
    ).run(
      state.workspace.id,
      "deletion_guest_test",
      "2026-07-24T00:00:00.000Z",
      owner.userId,
      snapshot.revision,
      snapshot.access_revision,
    );

    await expect(consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    )).rejects.toThrow(/invalid, expired, used, or revoked/);
    await expect(createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
    )).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<AuthorizationError>);
    expect(sqlite.prepare(
      `SELECT consumed_at,redemption_id
       FROM guest_links
       WHERE guest_link_id=?`,
    ).get(link.id)).toEqual({
      consumed_at: null,
      redemption_id: null,
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM identities WHERE provider='guest'",
    ).get()).toEqual({ count: 0 });
  });
  it("reports an invitation refusal when deletion removes a link during enrollment", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Invite deletion race");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Owner",
      email: "invite-race-owner@example.com",
      provider: "test",
      subject: "invite-race-owner",
    });
    const recipient = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Recipient",
      email: "invite-race-recipient@example.com",
      provider: "test",
      subject: "invite-race-recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    let raced = false;
    const racingDatabase = {
      prepare: db.prepare.bind(db),
      async batch(statements: Parameters<typeof db.batch>[0]) {
        if (!raced && statements.length === 4) {
          raced = true;
          sqlite.prepare(
            "DELETE FROM guest_links WHERE guest_link_id=?",
          ).run(link.id);
        }
        return db.batch(statements);
      },
    };

    const error = await consumeGuestLink(
      racingDatabase,
      link.raw,
      recipient.userId,
    ).then(() => null, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(InvitationError);
    expect(error).toMatchObject({
      message: "Invite link is invalid, expired, used, or revoked",
      status: 409,
    });
    expect(error).not.toBeInstanceOf(AuthorizationError);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, recipient.userId)).toEqual({ count: 0 });
  });
  it("atomically enrolls one signed-in account with an invite", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Invite concurrency");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Owner",
      email: "invite-owner@example.com",
      provider: "test",
      subject: "invite-owner",
    });
    const first = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "First recipient",
      email: "invite-first@example.com",
      provider: "test",
      subject: "invite-first",
    });
    const second = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Second recipient",
      email: "invite-second@example.com",
      provider: "test",
      subject: "invite-second",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "editor",
      1,
    );

    const results = await Promise.allSettled([
      consumeGuestLink(db, link.raw, first.userId),
      consumeGuestLink(db, link.raw, second.userId),
    ]);

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected"))
      .toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND role='editor'`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='member.invite.accept'`,
    ).get()).toEqual({ count: 1 });
  });
  it("rolls back invite enrollment when its audit insert fails", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest rollback");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "rollback-owner",
      email: "rollback-owner@example.com",
      displayName: "Owner",
    });
    const recipient = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "rollback-recipient",
      email: "rollback-recipient@example.com",
      displayName: "Recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const link = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "viewer",
      1,
    );
    sqlite.exec(`
      CREATE TRIGGER fail_invite_accept_audit
      BEFORE INSERT ON auth_audit_events
      WHEN NEW.action = 'member.invite.accept'
      BEGIN
        SELECT RAISE(ABORT, 'injected invite audit failure');
      END
    `);

    await expect(consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    )).rejects.toThrow(/injected invite audit failure/);
    expect(sqlite.prepare(
      `SELECT consumed_at, redemption_id
       FROM guest_links
       WHERE guest_link_id = ?`,
    ).get(link.id)).toEqual({
      consumed_at: null,
      redemption_id: null,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, recipient.userId)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action='member.invite.accept'`,
    ).get()).toEqual({ count: 0 });

    sqlite.exec("DROP TRIGGER fail_invite_accept_audit");
    await expect(consumeGuestLink(
      db,
      link.raw,
      recipient.userId,
    )).resolves.toMatchObject({ workspaceId: state.workspace.id });
  });
  it("bounds retained auth cleanup without expiring accepted membership", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Cleanup");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "cleanup-owner",
      email: "cleanup-owner@example.com",
      displayName: "Owner",
    });
    const stale = "2020-01-01T00:00:00.000Z";
    const now = new Date("2026-07-24T12:00:00.000Z");
    for (let index = 0; index < AUTH_CLEANUP_BATCH_SIZE + 1; index += 1) {
      sqlite.prepare(
        `INSERT INTO sessions(
           session_id, user_id, token_hash, created_at, expires_at, last_seen_at
         ) VALUES(?,?,?,?,?,?)`,
      ).run(
        `ses_stale_${index}`,
        owner.userId,
        `hash_stale_${index}`,
        stale,
        stale,
        stale,
      );
      sqlite.prepare(
        `INSERT INTO oauth_states(
           state_hash, provider, verifier_ciphertext, return_to, created_at,
           expires_at
         ) VALUES(?,?,?,?,?,?)`,
      ).run(
        `state_stale_${index}`,
        "google",
        "verifier",
        "/",
        stale,
        stale,
      );
      sqlite.prepare(
        `INSERT INTO guest_links(
           guest_link_id, workspace_id, created_by_user_id, token_hash, role,
           created_at, expires_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        `guest_stale_${index}`,
        state.workspace.id,
        owner.userId,
        `guest_hash_stale_${index}`,
        "viewer",
        stale,
        stale,
      );
    }

    for (const guest of [
      { id: "usr_unreachable", active: false },
      { id: "usr_reachable", active: true },
    ]) {
      const email = `${guest.id}@stowplan.invalid`;
      sqlite.prepare(
        `INSERT INTO users(
           user_id, email, display_name, global_role, status, created_at,
           updated_at, last_seen_at
         ) VALUES(?,?,'Guest','user','active',?,?,?)`,
      ).run(guest.id, email, stale, stale, stale);
      sqlite.prepare(
        `INSERT INTO identities(
           identity_id, user_id, provider, provider_subject, email, created_at,
           last_used_at
         ) VALUES(?,?,'guest',?,?,?,?)`,
      ).run(
        `idn_${guest.id}`,
        guest.id,
        `link_${guest.id}`,
        email,
        stale,
        stale,
      );
      sqlite.prepare(
        `INSERT INTO workspace_members(
           workspace_id, user_id, role, created_at
         ) VALUES(?,?,'viewer',?)`,
      ).run(state.workspace.id, guest.id, stale);
      if (guest.active) {
        sqlite.prepare(
          `INSERT INTO sessions(
             session_id, user_id, token_hash, created_at, expires_at,
             last_seen_at
           ) VALUES(?,?,?,?,?,?)`,
        ).run(
          "ses_reachable",
          guest.id,
          "hash_reachable",
          now.toISOString(),
          "2026-07-25T12:00:00.000Z",
          now.toISOString(),
        );
      }
    }

    const retainedSessions = sqlite.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE expires_at = ?",
    ).get(stale) as { count: number };
    await expect(cleanupAuthRecords(db, now)).resolves.toEqual({
      guestLinks: AUTH_CLEANUP_BATCH_SIZE,
      guestMemberships: 0,
      guestUsers: 0,
      oauthStates: AUTH_CLEANUP_BATCH_SIZE,
      sessions: Math.min(
        AUTH_CLEANUP_BATCH_SIZE,
        retainedSessions.count,
      ),
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE expires_at = ?",
    ).get(stale)).toEqual({
      count: Math.max(
        0,
        retainedSessions.count - AUTH_CLEANUP_BATCH_SIZE,
      ),
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM oauth_states",
    ).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(
      "SELECT user_id FROM users WHERE user_id = 'usr_unreachable'",
    ).get()).toEqual({ user_id: "usr_unreachable" });
    expect(sqlite.prepare(
      "SELECT user_id FROM users WHERE user_id = 'usr_reachable'",
    ).get()).toEqual({ user_id: "usr_reachable" });

    await cleanupAuthRecords(db, now);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE expires_at = ?",
    ).get(stale)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM oauth_states",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });
  });
  it("scrubs expired OAuth credentials before lifecycle-row cleanup", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    sqlite.prepare(
      `INSERT INTO oauth_states(
         state_hash, provider, verifier_ciphertext, return_to, created_at,
         expires_at
       ) VALUES(?,?,?,?,?,?)`,
    ).run(
      "recently-expired-state",
      "github",
      "private-verifier",
      "/private-return",
      "2026-07-24T11:50:00.000Z",
      "2026-07-24T12:00:00.000Z",
    );

    await expect(cleanupAuthRecords(
      db,
      new Date("2026-07-24T12:01:00.000Z"),
    )).resolves.toMatchObject({ oauthStates: 0 });
    expect(sqlite.prepare(
      `SELECT verifier_ciphertext, return_to, consumed_at
       FROM oauth_states
       WHERE state_hash='recently-expired-state'`,
    ).get()).toEqual({
      consumed_at: null,
      return_to: "/",
      verifier_ciphertext: "",
    });

    await expect(cleanupAuthRecords(
      db,
      new Date("2026-07-25T12:01:00.000Z"),
    )).resolves.toMatchObject({ oauthStates: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM oauth_states`,
    ).get()).toEqual({ count: 0 });
  });
  it("retains legacy accepted guest memberships regardless of session age", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const shared = createEmptyState("Cleanup revisions");
    const guestOwned = createEmptyState("Guest final owner");
    await new D1SnapshotStore(db).initialize(shared);
    await new D1SnapshotStore(db).initialize(guestOwned);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      displayName: "Owner",
      email: "cleanup-revision-owner@example.com",
      provider: "test",
      subject: "cleanup-revision-owner",
    });
    await claimWorkspace(db, owner.userId, shared.workspace.id);
    const createdAt = "2026-07-24T00:00:00.000Z";
    for (const guest of [
      {
        role: "viewer",
        userId: "usr_cleanup_viewer",
        workspaceId: shared.workspace.id,
      },
      {
        role: "owner",
        userId: "usr_cleanup_final_owner",
        workspaceId: guestOwned.workspace.id,
      },
    ]) {
      const email = `${guest.userId}@stowplan.invalid`;
      sqlite.prepare(
        `INSERT INTO users(
           user_id,email,display_name,global_role,status,created_at,updated_at,
           last_seen_at
         ) VALUES(?,?,'Guest','user','active',?,?,?)`,
      ).run(guest.userId, email, createdAt, createdAt, createdAt);
      sqlite.prepare(
        `INSERT INTO identities(
           identity_id,user_id,provider,provider_subject,email,created_at,
           last_used_at
         ) VALUES(?,?,'guest',?,?,?,?)`,
      ).run(
        `idn_${guest.userId}`,
        guest.userId,
        `subject_${guest.userId}`,
        email,
        createdAt,
        createdAt,
      );
      sqlite.prepare(
        `INSERT INTO workspace_members(
           workspace_id,user_id,role,created_at
         ) VALUES(?,?,?,?)`,
      ).run(
        guest.workspaceId,
        guest.userId,
        guest.role,
        createdAt,
      );
    }

    await expect(cleanupAuthRecords(
      db,
      new Date("2030-01-01T00:00:00.000Z"),
    )).resolves.toMatchObject({
      guestMemberships: 0,
      guestUsers: 0,
    });
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(shared.workspace.id)).toEqual({ access_revision: 2 });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      shared.workspace.id,
      "usr_cleanup_viewer",
    )).toEqual({ role: "viewer" });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(
      guestOwned.workspace.id,
      "usr_cleanup_final_owner",
    )).toEqual({ role: "owner" });
    expect(sqlite.prepare(
      `SELECT access_revision
       FROM workspace_snapshots
       WHERE workspace_id=?`,
    ).get(guestOwned.workspace.id)).toEqual({ access_revision: 1 });
  });
  it("preserves durable invite membership after retained links expire", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Guest creator cleanup");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "guest-creator-owner",
      email: "guest-creator-owner@example.com",
      displayName: "Owner",
    });
    const recipient = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "guest-creator-recipient",
      email: "guest-creator-recipient@example.com",
      displayName: "Recipient",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const invitation = await createGuestLink(
      db,
      state.workspace.id,
      owner.userId,
      "editor",
      1,
    );
    await consumeGuestLink(
      db,
      invitation.raw,
      recipient.userId,
    );
    sqlite.prepare(
      `UPDATE workspace_members
       SET role='owner'
       WHERE workspace_id=? AND user_id=?`,
    ).run(state.workspace.id, recipient.userId);
    await createGuestLink(
      db,
      state.workspace.id,
      recipient.userId,
      "viewer",
      1,
    );

    const cleanupTime = new Date("2030-01-01T00:00:00.000Z");
    await expect(cleanupAuthRecords(db, cleanupTime)).resolves.toMatchObject({
      guestLinks: 2,
      guestMemberships: 0,
      guestUsers: 0,
      sessions: 0,
    });
    expect(sqlite.prepare(
      "SELECT user_id FROM users WHERE user_id = ?",
    ).get(recipient.userId)).toEqual({ user_id: recipient.userId });
    expect(sqlite.prepare(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id=? AND user_id=?`,
    ).get(state.workspace.id, recipient.userId)).toEqual({
      role: "owner",
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM guest_links",
    ).get()).toEqual({ count: 0 });

    await expect(cleanupAuthRecords(db, cleanupTime)).resolves.toMatchObject({
      guestMemberships: 0,
      guestUsers: 0,
    });
  });
  it("limits the workspaces owned by one account", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "workspace-quota-owner",
      email: "workspace-quota-owner@example.com",
      displayName: "Owner",
    });
    let existingWorkspaceId = "";
    for (
      let index = 0;
      index < API_QUOTAS.ownedWorkspacesPerUser;
      index += 1
    ) {
      const state = createEmptyState(`Workspace ${index}`);
      await new D1SnapshotStore(db).initialize(state);
      await claimWorkspace(db, owner.userId, state.workspace.id);
      existingWorkspaceId = state.workspace.id;
    }
    await expect(claimWorkspace(
      db,
      owner.userId,
      existingWorkspaceId,
    )).resolves.toBeUndefined();
    const overage = createEmptyState("Workspace overage");
    await new D1SnapshotStore(db).initialize(overage);

    await expect(claimWorkspace(
      db,
      owner.userId,
      overage.workspace.id,
    )).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      detail: {
        actual: API_QUOTAS.ownedWorkspacesPerUser + 1,
        limit: API_QUOTAS.ownedWorkspacesPerUser,
        quota: "ownedWorkspacesPerUser",
      },
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE user_id = ? AND role = 'owner'`,
    ).get(owner.userId)).toEqual({
      count: API_QUOTAS.ownedWorkspacesPerUser,
    });
  });
  it("limits active and retained guest links independently", async () => {
    const activeDatabase = numberedMigrationDatabase();
    const activeState = createEmptyState("Active guest link quota");
    await new D1SnapshotStore(activeDatabase.database).initialize(activeState);
    const activeOwner = await createOrLinkUser(activeDatabase.database, TEST_AUTH_ENV, {
      provider: "test",
      subject: "active-link-owner",
      email: "active-link-owner@example.com",
      displayName: "Owner",
    });
    await claimWorkspace(
      activeDatabase.database,
      activeOwner.userId,
      activeState.workspace.id,
    );
    const now = "2020-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    const insertLink = activeDatabase.sqlite.prepare(
      `INSERT INTO guest_links(
         guest_link_id, workspace_id, created_by_user_id, token_hash, role,
         created_at, expires_at, revoked_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (
      let index = 0;
      index < API_QUOTAS.activeGuestLinksPerWorkspace;
      index += 1
    ) {
      insertLink.run(
        `guest_active_${index}`,
        activeState.workspace.id,
        activeOwner.userId,
        `hash_active_${index}`,
        "viewer",
        now,
        future,
        null,
      );
    }

    await expect(createGuestLink(
      activeDatabase.database,
      activeState.workspace.id,
      activeOwner.userId,
      "viewer",
    )).rejects.toMatchObject({
      actual: API_QUOTAS.activeGuestLinksPerWorkspace + 1,
      code: "QUOTA_EXCEEDED",
      limit: API_QUOTAS.activeGuestLinksPerWorkspace,
      quota: "activeGuestLinksPerWorkspace",
    } satisfies Partial<QuotaExceededError>);

    const retainedDatabase = numberedMigrationDatabase();
    const retainedState = createEmptyState("Retained guest link quota");
    await new D1SnapshotStore(retainedDatabase.database).initialize(
      retainedState,
    );
    const retainedOwner = await createOrLinkUser(
      retainedDatabase.database,
      TEST_AUTH_ENV,
      {
        provider: "test",
        subject: "retained-link-owner",
        email: "retained-link-owner@example.com",
        displayName: "Owner",
      },
    );
    await claimWorkspace(
      retainedDatabase.database,
      retainedOwner.userId,
      retainedState.workspace.id,
    );
    const insertRetainedLink = retainedDatabase.sqlite.prepare(
      `INSERT INTO guest_links(
         guest_link_id, workspace_id, created_by_user_id, token_hash, role,
         created_at, expires_at, revoked_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (
      let index = 0;
      index < API_QUOTAS.retainedGuestLinksPerWorkspace;
      index += 1
    ) {
      insertRetainedLink.run(
        `guest_retained_${index}`,
        retainedState.workspace.id,
        retainedOwner.userId,
        `hash_retained_${index}`,
        "viewer",
        now,
        future,
        now,
      );
    }

    await expect(createGuestLink(
      retainedDatabase.database,
      retainedState.workspace.id,
      retainedOwner.userId,
      "viewer",
    )).rejects.toMatchObject({
      actual: API_QUOTAS.retainedGuestLinksPerWorkspace + 1,
      code: "QUOTA_EXCEEDED",
      limit: API_QUOTAS.retainedGuestLinksPerWorkspace,
      quota: "retainedGuestLinksPerWorkspace",
    } satisfies Partial<QuotaExceededError>);
  });
  it("atomically reserves the final workspace member slot", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const state = createEmptyState("Member quota");
    await new D1SnapshotStore(db).initialize(state);
    const owner = await createOrLinkUser(db, TEST_AUTH_ENV, {
      provider: "test",
      subject: "member-quota-owner",
      email: "member-quota-owner@example.com",
      displayName: "Owner",
    });
    await claimWorkspace(db, owner.userId, state.workspace.id);
    const timestamp = "2026-07-24T00:00:00.000Z";
    const insertUser = sqlite.prepare(
      `INSERT INTO users(
         user_id, email, display_name, global_role, status, created_at,
         updated_at, last_seen_at
       ) VALUES(?,?,'Member','user','active',?,?,?)`,
    );
    const insertMembership = sqlite.prepare(
      `INSERT INTO workspace_members(
         workspace_id, user_id, role, created_at
       ) VALUES(?,?,'viewer',?)`,
    );
    for (
      let index = 1;
      index < API_QUOTAS.membersPerWorkspace - 1;
      index += 1
    ) {
      const userId = `usr_member_quota_${index}`;
      insertUser.run(
        userId,
        `member-quota-${index}@example.com`,
        timestamp,
        timestamp,
        timestamp,
      );
      insertMembership.run(state.workspace.id, userId, timestamp);
    }
    const links = await Promise.all([
      createGuestLink(db, state.workspace.id, owner.userId, "viewer"),
      createGuestLink(db, state.workspace.id, owner.userId, "viewer"),
    ]);
    const recipients = await Promise.all([
      createOrLinkUser(db, TEST_AUTH_ENV, {
        displayName: "First quota recipient",
        email: "first-quota-recipient@example.com",
        provider: "test",
        subject: "first-quota-recipient",
      }),
      createOrLinkUser(db, TEST_AUTH_ENV, {
        displayName: "Second quota recipient",
        email: "second-quota-recipient@example.com",
        provider: "test",
        subject: "second-quota-recipient",
      }),
    ]);

    const results = await Promise.allSettled(links.map((link, index) =>
      consumeGuestLink(
        db,
        link.raw,
        recipients[index].userId,
      )
    ));

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      actual: API_QUOTAS.membersPerWorkspace + 1,
      code: "QUOTA_EXCEEDED",
      limit: API_QUOTAS.membersPerWorkspace,
      quota: "membersPerWorkspace",
    } satisfies Partial<QuotaExceededError>);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE workspace_id = ?`,
    ).get(state.workspace.id)).toEqual({
      count: API_QUOTAS.membersPerWorkspace,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM guest_links
       WHERE workspace_id = ? AND consumed_at IS NOT NULL`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
  });
  it("requires a global admin role and optionally matching Access assertion", async () => {
    const { database: db, sqlite } = numberedMigrationDatabase();
    const baseEnv = TEST_AUTH_ENV;
    const user = await createOrLinkUser(db, baseEnv, {
      displayName: "Owner",
      email: "owner@example.com",
      provider: "test",
      subject: "owner",
    });
    const ordinarySession = await issueSession(
      db,
      baseEnv,
      user,
      new Request("https://example.test"),
    );
    const ordinaryRequest = new Request("https://example.test/admin", {
      headers: {
        cookie: `__Host-stowplan_session=${ordinarySession.raw}`,
      },
    });
    await expect(authorizeAdmin(
      db,
      baseEnv,
      ordinaryRequest,
    )).rejects.toMatchObject({
      message: "Global administrator access is required",
      status: 403,
    } satisfies Partial<AuthorizationError>);
    sqlite.prepare(
      "UPDATE users SET global_role='admin' WHERE user_id=?",
    ).run(user.userId);
    const session = await issueSession(
      db,
      baseEnv,
      { ...user, globalRole: "admin" },
      new Request("https://example.test"),
    );
    const request = new Request("https://example.test/admin", {
      headers: {
        cookie: `__Host-stowplan_session=${session.raw}`,
      },
    });
    expect(
      (await authorizeAdmin(db, baseEnv, request)).userId,
    ).toBe(user.userId);
    await expect(authorizeAdmin(
      db,
      { ...baseEnv, AUTH_ADMIN_REQUIRE_ACCESS: "true" },
      request,
    )).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<AuthorizationError>);
  });
  it("rejects cross-origin browser mutations while supporting trusted proxy origins",()=>{expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST"}))).toBe(true);expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST",headers:{"sec-fetch-mode":"cors","sec-fetch-site":"same-origin"}}))).toBe(false);expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST",headers:{origin:"https://example.test","sec-fetch-site":"cross-site"}}))).toBe(false);expect(isTrustedMutation(new Request("https://example.test/api/sync",{method:"POST",headers:{origin:"https://evil.test"}}))).toBe(false);expect(isTrustedMutation(new Request("http://internal:3000/api/sync",{method:"POST",headers:{origin:"https://stowplan.example","x-forwarded-host":"stowplan.example","x-forwarded-proto":"https"}}))).toBe(true);expect(isTrustedMutation(new Request("http://internal:3000/api/sync",{method:"POST",headers:{origin:"https://stowplan.example"}}),"https://stowplan.example")).toBe(true)});
});
