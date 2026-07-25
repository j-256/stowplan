import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_REQUEST_MAX_BYTES,
  INVITATION_REQUEST_MAX_BYTES,
} from "../src/server/request-body";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";
import {
  GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS,
  GUEST_INVITATION_TOKEN_MAX_CHARACTERS,
} from "../src/domain/app-url";

const mocks = vi.hoisted(() => ({
  adminMutation: vi.fn(),
  authenticate: vi.fn(),
  authorizeAdmin: vi.fn(),
  consumeGuestLink: vi.fn(),
  createOrLinkUser: vi.fn(),
  finishOAuth: vi.fn(),
  issueSession: vi.fn(),
  provider: vi.fn(),
  verifyAccess: vi.fn(),
}));

vi.mock("../src/server/admin", () => ({
  adminMutation: mocks.adminMutation,
}));

vi.mock("../src/server/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/server/auth")>(),
  authenticate: mocks.authenticate,
  authorizeAdmin: mocks.authorizeAdmin,
  consumeGuestLink: mocks.consumeGuestLink,
  createOrLinkUser: mocks.createOrLinkUser,
  finishOAuth: mocks.finishOAuth,
  isTrustedMutation: vi.fn(() => true),
  issueSession: mocks.issueSession,
  provider: mocks.provider,
  sessionCookie: vi.fn(() => "stowplan_session=test"),
  verifyAccess: mocks.verifyAccess,
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({
    AUTH_BASE_URL: "https://stowplan.test",
    AUTH_DEV_ENABLED: "true",
    DB: {},
  })),
}));

import { POST as postAdminMutation } from "../app/api/admin/mutate/route";
import { POST as postAccessAuthentication } from "../app/api/auth/access/route";
import { GET as getOAuthCallback } from "../app/api/auth/[provider]/callback/route";
import { POST as postDevelopmentSignIn } from "../app/api/auth/dev/route";
import { POST as postGuestConfirmation } from "../app/api/auth/guest/route";
import {
  GET as getGuestInvitation,
  POST as postGuestInvitation,
} from "../app/api/auth/guest/[token]/route";

function jsonRequest(
  path: string,
  body: BodyInit,
  contentType = "application/json",
): Request {
  return new Request(`https://stowplan.test${path}`, {
    body,
    headers: {
      "content-type": contentType,
      [ACCOUNT_CONTEXT_HEADER]: "usr_admin",
    },
    method: "POST",
  });
}

describe("private route request hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue(null);
    mocks.authorizeAdmin.mockResolvedValue({ userId: "usr_admin" });
    mocks.provider.mockReturnValue({
      authorizationUrl: "https://provider.test/authorize",
      clientId: "client",
      clientSecret: "secret",
      id: "github",
      scopes: "profile",
      tokenUrl: "https://provider.test/token",
    });
  });

  it("does not expose OAuth callback failures", async () => {
    mocks.finishOAuth.mockRejectedValue(
      new Error("OAuth SQL included provider_secret=private"),
    );

    const response = await getOAuthCallback(
      new Request(
        "https://stowplan.test/api/auth/github/callback?state=state&code=code",
      ),
      { params: Promise.resolve({ provider: "github" }) },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      code: "AUTHENTICATION_FAILED",
      error: "Authentication could not be completed",
    });
    expect(JSON.stringify(body)).not.toContain("provider_secret");
    expect(JSON.stringify(body)).not.toContain("SQL");
  });

  it("does not expose Access assertion verification failures", async () => {
    mocks.verifyAccess.mockRejectedValue(
      new Error("Access assertion private.claim failed"),
    );

    const response = await postAccessAuthentication(new Request(
      "https://stowplan.test/api/auth/access",
      {
        headers: {
          "cf-access-jwt-assertion": "private-assertion",
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      code: "AUTHENTICATION_FAILED",
      error: "Access authentication could not be completed",
    });
    expect(JSON.stringify(body)).not.toContain("private.claim");
    expect(JSON.stringify(body)).not.toContain("private-assertion");
  });

  it("does not expose development sign-in storage failures", async () => {
    mocks.createOrLinkUser.mockRejectedValue(
      new Error("SQLITE_ERROR token_hash=private"),
    );

    const response = await postDevelopmentSignIn(jsonRequest(
      "/api/auth/dev",
      JSON.stringify({ email: "member@example.com" }),
    ));

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      code: "AUTHENTICATION_FAILED",
      error: "Development sign-in could not be completed",
    });
    expect(JSON.stringify(body)).not.toContain("token_hash");
    expect(JSON.stringify(body)).not.toContain("SQLITE");
  });

  it.each([
    {
      body: "{",
      contentType: "application/json",
      label: "malformed JSON",
      status: 400,
    },
    {
      body: "[]",
      contentType: "application/json",
      label: "a non-object JSON body",
      status: 400,
    },
    {
      body: JSON.stringify({
        action: "session.revoke",
        targetId: "ses_target",
      }),
      contentType: "text/plain",
      label: "the wrong media type",
      status: 415,
    },
  ])(
    "returns a structured refusal for $label",
    async ({ body, contentType, status }) => {
      const response = await postAdminMutation(jsonRequest(
        "/api/admin/mutate",
        body,
        contentType,
      ));

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
        "usr_admin",
      );
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_REQUEST",
        error: expect.any(String),
      });
      expect(mocks.adminMutation).not.toHaveBeenCalled();
    },
  );

  it("returns a coded oversized admin request refusal", async () => {
    const request = jsonRequest("/api/admin/mutate", "{}");
    request.headers.set(
      "content-length",
      String(CONTROL_REQUEST_MAX_BYTES + 1),
    );

    const response = await postAdminMutation(request);

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
      error: expect.stringContaining("byte limit"),
    });
    expect(mocks.adminMutation).not.toHaveBeenCalled();
  });

  it("bounds an invitation form before redirecting a signed-out user", async () => {
    const response = await postGuestInvitation(
      new Request(
        "https://stowplan.test/api/auth/guest/raw_token",
        {
          body: "expectedAccountId=",
          headers: {
            "content-length": String(
              INVITATION_REQUEST_MAX_BYTES + 1,
            ),
            "content-type":
              "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ token: "raw_token" }) },
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
      error: expect.stringContaining("byte limit"),
    });
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
  });

  it.each([
    {
      request: "https://stowplan.test/api/auth/guest/raw_token?returnTo=" +
        "x".repeat(GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS + 1),
      token: "raw_token",
    },
    {
      request: "https://stowplan.test/api/auth/guest/oversized",
      token: "x".repeat(GUEST_INVITATION_TOKEN_MAX_CHARACTERS + 1),
    },
  ])("returns a coded malformed legacy invitation redirect", async ({
    request,
    token,
  }) => {
    const response = await getGuestInvitation(
      new Request(request),
      { params: Promise.resolve({ token }) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
      error: "Invitation URL is invalid",
    });
  });

  it("validates invitation media type before redirecting", async () => {
    const response = await postGuestInvitation(
      new Request(
        "https://stowplan.test/api/auth/guest/raw_token",
        {
          body: "{}",
          headers: {
            "content-type": "application/json",
          },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ token: "raw_token" }) },
    );

    expect(response.status).toBe(415);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
  });

  it("bounds fixed-path invitation JSON before authentication", async () => {
    const request = jsonRequest(
      "/api/auth/guest",
      JSON.stringify({
        expectedAccountId: "usr_invited",
        token: "raw_token",
      }),
    );
    request.headers.set(
      "content-length",
      String(INVITATION_REQUEST_MAX_BYTES + 1),
    );

    const response = await postGuestConfirmation(request);

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
      error: expect.stringContaining("byte limit"),
    });
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
  });

  it.each([
    {
      body: "{",
      contentType: "application/json",
      label: "malformed JSON",
      status: 400,
    },
    {
      body: JSON.stringify({
        expectedAccountId: "usr_invited",
        token: "raw_token",
      }),
      contentType: "text/plain",
      label: "a non-JSON content type",
      status: 415,
    },
    {
      body: JSON.stringify({
        expectedAccountId: "usr_invited",
        token: " raw_token ",
      }),
      contentType: "application/json",
      label: "a whitespace-padded token",
      status: 400,
    },
  ])(
    "returns a structured fixed invitation refusal for $label",
    async ({ body, contentType, status }) => {
      const response = await postGuestConfirmation(
        jsonRequest("/api/auth/guest", body, contentType),
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_REQUEST",
        error: expect.any(String),
      });
      expect(mocks.authenticate).not.toHaveBeenCalled();
      expect(mocks.consumeGuestLink).not.toHaveBeenCalled();
    },
  );
});
