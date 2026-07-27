import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_REQUEST_MAX_BYTES } from "../src/server/request-body";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";

const OWNER_ACCOUNT_ID = "usr_owner";

const mocks = vi.hoisted(() => ({
  adminMutation: vi.fn(),
  adminOverview: vi.fn(),
  adminOverviewPage: vi.fn(),
  authenticate: vi.fn(),
  authorizeAdmin: vi.fn(),
  beginOAuth: vi.fn(),
  consumeGuestLink: vi.fn(),
  createOrLinkUser: vi.fn(),
  hasLinkedGoogleIdentity: vi.fn(),
  issueSession: vi.fn(),
  isTrustedMutation: vi.fn(() => true),
  provider: vi.fn(),
  requireRecentIdentityLinkAuthentication: vi.fn(),
  verifyTurnstile: vi.fn(),
}));

vi.mock("../src/server/admin", () => ({
  adminMutation: mocks.adminMutation,
  adminOverview: mocks.adminOverview,
  adminOverviewPage: mocks.adminOverviewPage,
  audit: vi.fn(),
}));

vi.mock("../src/server/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/server/auth")>(),
  authenticate: mocks.authenticate,
  authorizeAdmin: mocks.authorizeAdmin,
  beginOAuth: mocks.beginOAuth,
  consumeGuestLink: mocks.consumeGuestLink,
  createOrLinkUser: mocks.createOrLinkUser,
  hasLinkedGoogleIdentity: mocks.hasLinkedGoogleIdentity,
  isTrustedMutation: mocks.isTrustedMutation,
  issueSession: mocks.issueSession,
  provider: mocks.provider,
  requireRecentIdentityLinkAuthentication:
    mocks.requireRecentIdentityLinkAuthentication,
  sessionCookie: vi.fn(() => "session=test"),
  verifyTurnstile: mocks.verifyTurnstile,
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({
    AUTH_DEV_ENABLED: "true",
    AUTH_IDENTITY_DIGEST_KEY:
      "test-identity-digest-key-at-least-32-bytes",
    DB: {},
  })),
}));

import { POST as postAdminMutation } from "../app/api/admin/mutate/route";
import { GET as getAdminOverview } from "../app/api/admin/overview/route";
import { POST as postDevelopmentSignIn } from "../app/api/auth/dev/route";
import { POST as postGuestConfirmation } from "../app/api/auth/guest/route";
import { POST as postGuestInvitation } from "../app/api/auth/guest/[token]/route";
import { POST as postOAuthStart } from "../app/api/auth/[provider]/start/route";
import { ApiProblem } from "../src/server/api-problem";
import { TurnstileVerificationError } from "../src/server/auth";

function oversizedRequest(path: string): Request {
  return new Request(`https://stowplan.test${path}`, {
    body: "{}",
    headers: {
      "content-length": String(CONTROL_REQUEST_MAX_BYTES + 1),
      "content-type": "application/json",
      [ACCOUNT_CONTEXT_HEADER]: path === "/api/admin/mutate"
        ? "usr_admin"
        : OWNER_ACCOUNT_ID,
    },
    method: "POST",
  });
}

describe("control route request limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      globalRole: "admin",
      userId: OWNER_ACCOUNT_ID,
    });
    mocks.authorizeAdmin.mockResolvedValue({
      sessionId: "ses_current_admin",
      userId: "usr_admin",
    });
    mocks.beginOAuth.mockResolvedValue({
      authorizationUrl:
        "https://identity.example.test/authorize?state=opaque",
      bindingCookie: "oauth-binding=test",
    });
    mocks.provider.mockReturnValue({ id: "google" });
    mocks.hasLinkedGoogleIdentity.mockResolvedValue(true);
    mocks.adminOverviewPage.mockReturnValue(undefined);
    mocks.adminOverview.mockResolvedValue({
      audit: [],
      databaseInventory: {
        entries: [{
          key: "sessions",
          label: "Sessions",
          metrics: [{ kind: "count", label: "active", value: 2 }],
          rowCount: 3,
          table: "sessions",
        }],
        generatedAt: "2026-07-25T00:00:00.000Z",
      },
      guestLinks: [],
      identities: [],
      memberships: [],
      sessions: [],
      users: [],
      workspaces: [],
    });
    mocks.consumeGuestLink.mockResolvedValue({
      workspaceId: "ws_invited",
    });
  });

  it.each([
    ["/api/admin/mutate", postAdminMutation],
    ["/api/auth/guest", postGuestConfirmation],
    ["/api/auth/dev", postDevelopmentSignIn],
  ])("rejects an oversized %s body before mutation", async (path, post) => {
    const response = await post(oversizedRequest(path));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("byte limit"),
    });
    expect(mocks.adminMutation).not.toHaveBeenCalled();
    expect(mocks.createOrLinkUser).not.toHaveBeenCalled();
    expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
    expect(mocks.issueSession).not.toHaveBeenCalled();
  });

  it("returns uncached aggregate database inventory to an authorized administrator", async () => {
    const response = await getAdminOverview(new Request(
      "https://stowplan.test/api/admin/overview?q=retention",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      "usr_admin",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.adminOverview).toHaveBeenCalledWith(
      expect.anything(),
      {
        page: undefined,
        query: "retention",
        viewerSessionId: "ses_current_admin",
        viewerUserId: "usr_admin",
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      databaseInventory: {
        entries: [{
          key: "sessions",
          rowCount: 3,
          table: "sessions",
        }],
      },
    });
  });

  it("keeps OAuth start redirects with one-time state uncached", async () => {
    const response = await postOAuthStart(
      new Request(
        "https://stowplan.test/api/auth/google/start?returnTo=%2Faccount",
        {
          body: new URLSearchParams({
            "cf-turnstile-response": "turnstile-token",
            intent: "sign-in",
          }),
          headers: {
            "content-type":
              "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBe(
      "oauth-binding=test",
    );
    await expect(response.json()).resolves.toEqual({
      authorizationUrl:
        "https://identity.example.test/authorize?state=opaque",
    });
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith(
      expect.anything(),
      "turnstile-token",
      "https://stowplan.test/api/auth/google/start?returnTo=%2Faccount",
      null,
    );
    expect(mocks.beginOAuth).toHaveBeenCalledWith(
      expect.anything(),
      { id: "google" },
      "https://stowplan.test",
      "/account",
      {
        intent: "sign-in",
        linkIntent: undefined,
      },
    );
  });

  it("does not allocate OAuth state after a failed browser check", async () => {
    mocks.verifyTurnstile.mockRejectedValueOnce(
      new TurnstileVerificationError(
        "Browser verification was not accepted; try again",
        400,
      ),
    );
    const response = await postOAuthStart(
      new Request(
        "https://stowplan.test/api/auth/google/start",
        {
          body: new URLSearchParams({
            "cf-turnstile-response": "invalid-token",
            intent: "sign-in",
          }),
          headers: {
            "content-type":
              "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "BROWSER_VERIFICATION_FAILED",
    });
    expect(mocks.beginOAuth).not.toHaveBeenCalled();
  });

  it("binds explicit identity linking to the current app session", async () => {
    mocks.authenticate.mockResolvedValueOnce({
      sessionId: "ses_linking",
      userId: OWNER_ACCOUNT_ID,
    });
    const response = await postOAuthStart(
      new Request(
        "https://stowplan.test/api/auth/google/start",
        {
          body: new URLSearchParams({
            "cf-turnstile-response": "turnstile-token",
            intent: "link",
          }),
          headers: {
            "content-type":
              "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(200);
    expect(
      mocks.requireRecentIdentityLinkAuthentication,
    ).toHaveBeenCalledWith(
      expect.anything(),
      {
        sessionId: "ses_linking",
        userId: OWNER_ACCOUNT_ID,
      },
    );
    expect(mocks.beginOAuth).toHaveBeenCalledWith(
      expect.anything(),
      { id: "google" },
      "https://stowplan.test",
      "/",
      {
        intent: "link",
        linkIntent: {
          sessionId: "ses_linking",
          userId: OWNER_ACCOUNT_ID,
        },
      },
    );
  });

  it("requires recent authentication before allocating link state", async () => {
    mocks.authenticate.mockResolvedValueOnce({
      sessionId: "ses_stale",
      userId: OWNER_ACCOUNT_ID,
    });
    mocks.requireRecentIdentityLinkAuthentication.mockRejectedValueOnce(
      new ApiProblem(
        "REAUTHENTICATION_REQUIRED",
        "private stale-session detail",
        401,
      ),
    );
    const response = await postOAuthStart(
      new Request(
        "https://stowplan.test/api/auth/google/start",
        {
          body: new URLSearchParams({
            "cf-turnstile-response": "turnstile-token",
            intent: "link",
          }),
          headers: {
            "content-type":
              "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "REAUTHENTICATION_REQUIRED",
      error:
        "Sign in again with an existing Google identity before linking another",
      hasLinkedGoogleIdentity: true,
    });
    expect(mocks.beginOAuth).not.toHaveBeenCalled();
  });

  it("explains how to refresh recovery before a first Google link", async () => {
    mocks.authenticate.mockResolvedValueOnce({
      sessionId: "ses_stale_recovery",
      userId: OWNER_ACCOUNT_ID,
    });
    mocks.hasLinkedGoogleIdentity.mockResolvedValueOnce(false);
    mocks.requireRecentIdentityLinkAuthentication.mockRejectedValueOnce(
      new ApiProblem(
        "REAUTHENTICATION_REQUIRED",
        "private stale-session detail",
        401,
      ),
    );
    const response = await postOAuthStart(
      new Request(
        "https://stowplan.test/api/auth/google/start",
        {
          body: new URLSearchParams({
            "cf-turnstile-response": "turnstile-token",
            intent: "link",
          }),
          headers: {
            "content-type":
              "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "REAUTHENTICATION_REQUIRED",
      error:
        "Sign out and sign in again with this account's existing method, then link Google when you return",
      hasLinkedGoogleIdentity: false,
    });
    expect(mocks.beginOAuth).not.toHaveBeenCalled();
  });

  it("refuses GitHub before allocating OAuth state", async () => {
    mocks.provider.mockReturnValueOnce(null);
    const response = await postOAuthStart(
      new Request(
        "https://stowplan.test/api/auth/github/start",
        {
          body: new URLSearchParams({
            "cf-turnstile-response": "turnstile-token",
            intent: "reauthenticate",
          }),
          headers: {
            "content-type":
              "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ provider: "github" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      error: "Authentication provider is not configured",
    });
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.beginOAuth).not.toHaveBeenCalled();
  });

  it("clears the cookie after an administrator revokes the current session", async () => {
    mocks.adminMutation.mockResolvedValue({
      message: "Session revoked",
    });
    const response = await postAdminMutation(new Request(
      "https://stowplan.test/api/admin/mutate",
      {
        body: JSON.stringify({
          action: "session.revoke",
          targetId: "ses_current_admin",
        }),
        headers: {
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: "usr_admin",
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(response.json()).resolves.toMatchObject({
      currentSessionRevoked: true,
      message: "Session revoked",
      ok: true,
    });
  });

  it("refuses stale admin account context before reading or mutating", async () => {
    const overview = await getAdminOverview(new Request(
      "https://stowplan.test/api/admin/overview",
      {
        headers: {
          [ACCOUNT_CONTEXT_HEADER]: "usr_previous_admin",
        },
      },
    ));
    expect(overview.status).toBe(409);
    await expect(overview.json()).resolves.toMatchObject({
      code: "ACCOUNT_CONTEXT_CHANGED",
    });
    expect(mocks.adminOverview).not.toHaveBeenCalled();

    const mutation = await postAdminMutation(new Request(
      "https://stowplan.test/api/admin/mutate",
      {
        body: JSON.stringify({
          action: "session.revoke",
          targetId: "ses_target",
        }),
        headers: {
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: "usr_previous_admin",
        },
        method: "POST",
      },
    ));
    expect(mutation.status).toBe(409);
    await expect(mutation.json()).resolves.toMatchObject({
      code: "ACCOUNT_CONTEXT_CHANGED",
    });
    expect(mocks.adminMutation).not.toHaveBeenCalled();
  });

  it("requires sign-in before consuming an invitation", async () => {
    mocks.authenticate.mockResolvedValueOnce(null);
    const response = await postGuestInvitation(
      new Request(
        "https://stowplan.test/api/auth/guest/raw_token?returnTo=%2Fworkspaces%2Fws_invited%2Fsettings",
        {
          body: new URLSearchParams(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://stowplan.test",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ token: "raw_token" }) },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/guest");
    expect(location.search).toBe("");
    expect(new URLSearchParams(location.hash.slice(1)).get("token"))
      .toBe("raw_token");
    expect(new URLSearchParams(location.hash.slice(1)).get("returnTo"))
      .toBe("/workspaces/ws_invited/settings");
    expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
  });

  it("returns a structured sign-in refusal from the fixed invitation endpoint", async () => {
    mocks.authenticate.mockResolvedValueOnce(null);
    const response = await postGuestConfirmation(new Request(
      "https://stowplan.test/api/auth/guest",
      {
        body: JSON.stringify({
          expectedAccountId: OWNER_ACCOUNT_ID,
          returnTo: "/workspaces/ws_invited/settings",
          token: "raw_token",
        }),
        headers: {
          "content-type": "application/json",
          origin: "https://stowplan.test",
          [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      code: "AUTHENTICATION_REQUIRED",
      error: "Sign in before accepting this invitation",
    });
    expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
  });

  it("confirms an invitation at a fixed URL without replacing the session", async () => {
    const response = await postGuestConfirmation(new Request(
      "https://stowplan.test/api/auth/guest",
      {
        body: JSON.stringify({
          expectedAccountId: OWNER_ACCOUNT_ID,
          returnTo: "/workspaces/ws_invited/settings",
          token: "raw_token",
        }),
        headers: {
          "content-type": "application/json",
          origin: "https://stowplan.test",
          [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      OWNER_ACCOUNT_ID,
    );
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      returnTo: "/workspaces/ws_invited/settings",
      workspaceId: "ws_invited",
    });
    expect(mocks.consumeGuestLink).toHaveBeenCalledWith(
      expect.anything(),
      "raw_token",
      OWNER_ACCOUNT_ID,
    );
  });

  it("refuses changed account context before consuming a fixed-path invitation", async () => {
    const response = await postGuestConfirmation(new Request(
      "https://stowplan.test/api/auth/guest",
      {
        body: JSON.stringify({
          expectedAccountId: "usr_previous",
          token: "raw_token",
        }),
        headers: {
          "content-type": "application/json",
          origin: "https://stowplan.test",
          [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      OWNER_ACCOUNT_ID,
    );
    await expect(response.json()).resolves.toMatchObject({
      code: "ACCOUNT_CONTEXT_CHANGED",
    });
    expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
  });

  it("origin-protects fixed-path invitation confirmation", async () => {
    mocks.isTrustedMutation.mockReturnValueOnce(false);
    const response = await postGuestConfirmation(new Request(
      "https://stowplan.test/api/auth/guest",
      {
        body: JSON.stringify({
          expectedAccountId: OWNER_ACCOUNT_ID,
          token: "raw_token",
        }),
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.test",
          [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "CROSS_ORIGIN_DENIED",
    });
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
  });

  it("enrolls the signed-in account without replacing its session", async () => {
    const response = await postGuestInvitation(
      new Request(
        "https://stowplan.test/api/auth/guest/raw_token?returnTo=%2Fworkspaces%2Fws_invited%2Fsettings",
        {
          body: new URLSearchParams({
            expectedAccountId: "usr_owner",
          }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://stowplan.test",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ token: "raw_token" }) },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBe(
      "https://stowplan.test/workspaces/ws_invited/settings",
    );
    expect(mocks.consumeGuestLink).toHaveBeenCalledWith(
      expect.anything(),
      "raw_token",
      "usr_owner",
    );
  });

  it.each([
    {
      code: "QUOTA_EXCEEDED" as const,
      detail: {
        actual: 11,
        limit: 10,
        quota: "guestLinksCreatedPerAccountDay",
      },
      message: "This account has reached a durable usage limit",
      status: 429,
    },
    {
      code: "QUOTA_EXCEEDED" as const,
      detail: {
        actual: 26,
        limit: 25,
        quota: "membershipsPerAccount",
      },
      message: "This account has reached a durable usage limit",
      status: 409,
    },
    {
      code: "CIRCUIT_PAUSED" as const,
      detail: {},
      message: "Guest link redemption is temporarily paused",
      status: 503,
    },
  ])(
    "preserves the $status guest admission refusal",
    async ({ code, detail, message, status }) => {
      mocks.consumeGuestLink.mockRejectedValueOnce(
        new ApiProblem(code, message, status, detail),
      );
      const response = await postGuestConfirmation(new Request(
        "https://stowplan.test/api/auth/guest",
        {
          body: JSON.stringify({
            expectedAccountId: OWNER_ACCOUNT_ID,
            token: "raw_token",
          }),
          headers: {
            "content-type": "application/json",
            origin: "https://stowplan.test",
            [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
          },
          method: "POST",
        },
      ));

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        code,
        error: message,
        ...detail,
      });
    },
  );

  it("preserves a coded refusal on the legacy invitation route", async () => {
    mocks.consumeGuestLink.mockRejectedValueOnce(
      new ApiProblem(
        "CIRCUIT_PAUSED",
        "Guest link redemption is temporarily paused",
        503,
      ),
    );
    const response = await postGuestInvitation(
      new Request(
        "https://stowplan.test/api/auth/guest/raw_token",
        {
          body: new URLSearchParams({
            expectedAccountId: OWNER_ACCOUNT_ID,
          }),
          headers: {
            "content-type":
              "application/x-www-form-urlencoded",
            origin: "https://stowplan.test",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ token: "raw_token" }) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "CIRCUIT_PAUSED",
      error: "Guest link redemption is temporarily paused",
    });
  });

  it("keeps database failures and private responses uncached and non-secret", async () => {
    mocks.adminOverview.mockRejectedValue(
      new Error("SQLITE_ERROR token_hash=private_hash"),
    );

    const response = await getAdminOverview(new Request(
      "https://stowplan.test/api/admin/overview",
    ));

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { error: string };
    expect(body.error).toBe("Could not load administrative data");
    expect(JSON.stringify(body)).not.toContain("private_hash");
    expect(JSON.stringify(body)).not.toContain("SQLITE");

    mocks.adminMutation.mockRejectedValue(
      new Error("SQLITE_CONSTRAINT token_hash=private_hash"),
    );
    const mutation = await postAdminMutation(new Request(
      "https://stowplan.test/api/admin/mutate",
      {
        body: JSON.stringify({
          action: "session.revoke",
          targetId: "ses_private",
        }),
        headers: {
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: "usr_admin",
        },
        method: "POST",
      },
    ));

    expect(mutation.status).toBe(500);
    expect(mutation.headers.get("cache-control")).toBe("no-store");
    const mutationBody = await mutation.json() as { error: string };
    expect(mutationBody.error).toBe("Admin mutation failed");
    expect(JSON.stringify(mutationBody)).not.toContain("private_hash");
    expect(JSON.stringify(mutationBody)).not.toContain("SQLITE");
  });

  it("preserves an intentional admin no-op refusal", async () => {
    mocks.adminMutation.mockRejectedValue(
      new ApiProblem(
        "INVALID_REQUEST",
        "Session is already revoked",
        400,
      ),
    );

    const response = await postAdminMutation(new Request(
      "https://stowplan.test/api/admin/mutate",
      {
        body: JSON.stringify({
          action: "session.revoke",
          targetId: "ses_revoked",
        }),
        headers: {
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: "usr_admin",
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
      error: "Session is already revoked",
    });
  });

  it("preserves structured stale admin membership revisions", async () => {
    mocks.adminMutation.mockRejectedValue(
      new ApiProblem(
        "ACCESS_STALE",
        "Workspace access or membership changed; refresh and try again",
        409,
        {
          accessRevision: 9,
          membershipRevision: 14,
        },
      ),
    );

    const response = await postAdminMutation(new Request(
      "https://stowplan.test/api/admin/mutate",
      {
        body: JSON.stringify({
          action: "member.role",
          expectedAccessRevision: 8,
          expectedMembershipRevision: 13,
          targetId: "ws_target::usr_target",
          value: "editor",
        }),
        headers: {
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: "usr_admin",
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      accessRevision: 9,
      code: "ACCESS_STALE",
      membershipRevision: 14,
    });
    expect(mocks.adminMutation).toHaveBeenCalledWith(
      expect.anything(),
      "usr_admin",
      {
        action: "member.role",
        expectedAccessRevision: 8,
        expectedMembershipRevision: 13,
        targetId: "ws_target::usr_target",
        value: "editor",
      },
      {
        actorSessionId: "ses_current_admin",
        identityDigestKey:
          "test-identity-digest-key-at-least-32-bytes",
        signInProviderIds: ["google", "development"],
      },
    );
  });

});
