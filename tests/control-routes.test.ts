import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_REQUEST_MAX_BYTES } from "../src/server/request-body";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";
import { GUEST_LINK_EXPIRY_HOURS } from "../src/shared/api-quotas";

const OWNER_ACCOUNT_ID = "usr_owner";

const mocks = vi.hoisted(() => ({
  adminMutation: vi.fn(),
  adminOverview: vi.fn(),
  adminOverviewPage: vi.fn(),
  authenticate: vi.fn(),
  authorizeAdmin: vi.fn(),
  beginOAuth: vi.fn(),
  consumeGuestLink: vi.fn(),
  createWorkspaceGuestLink: vi.fn(),
  createOrLinkUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  issueSession: vi.fn(),
  isTrustedMutation: vi.fn(() => true),
  provider: vi.fn(),
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
  isTrustedMutation: mocks.isTrustedMutation,
  issueSession: mocks.issueSession,
  provider: mocks.provider,
  sessionCookie: vi.fn(() => "session=test"),
}));

vi.mock("../src/server/workspace-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/server/workspace-access")>(),
  createWorkspaceGuestLink: mocks.createWorkspaceGuestLink,
  getWorkspaceAccess: mocks.getWorkspaceAccess,
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({
    AUTH_DEV_ENABLED: "true",
    DB: {},
  })),
}));

import { POST as postGuestLink } from "../app/api/admin/guest-links/route";
import { POST as postAdminMutation } from "../app/api/admin/mutate/route";
import { GET as getAdminOverview } from "../app/api/admin/overview/route";
import { POST as postDevelopmentSignIn } from "../app/api/auth/dev/route";
import { POST as postGuestConfirmation } from "../app/api/auth/guest/route";
import { POST as postGuestInvitation } from "../app/api/auth/guest/[token]/route";
import { GET as getOAuthStart } from "../app/api/auth/[provider]/start/route";
import { ApiProblem } from "../src/server/api-problem";

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
    mocks.beginOAuth.mockResolvedValue(
      "https://identity.example.test/authorize?state=opaque",
    );
    mocks.provider.mockReturnValue({ id: "google" });
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
    mocks.getWorkspaceAccess.mockResolvedValue({
      access: { accessRevision: 4, role: "owner" },
    });
    mocks.createWorkspaceGuestLink.mockResolvedValue({
      guestLink: {
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      raw: "guest_token",
      returnTo: "/workspace/ws_owned",
    });
    mocks.consumeGuestLink.mockResolvedValue({
      workspaceId: "ws_invited",
    });
  });

  it.each([
    ["/api/admin/guest-links", postGuestLink],
    ["/api/admin/mutate", postAdminMutation],
    ["/api/auth/guest", postGuestConfirmation],
    ["/api/auth/dev", postDevelopmentSignIn],
  ])("rejects an oversized %s body before mutation", async (path, post) => {
    const response = await post(oversizedRequest(path));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("byte limit"),
    });
    if (path === "/api/admin/guest-links") {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(mocks.adminMutation).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceGuestLink).not.toHaveBeenCalled();
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
    const response = await getOAuthStart(
      new Request(
        "https://stowplan.test/api/auth/google/start?returnTo=%2Faccount",
      ),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      "https://identity.example.test/authorize?state=opaque",
    );
    expect(mocks.beginOAuth).toHaveBeenCalledWith(
      expect.anything(),
      { id: "google" },
      "https://stowplan.test",
      "/account",
    );
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
    );
  });

  it("does not treat a global admin as a workspace member", async () => {
    mocks.getWorkspaceAccess.mockRejectedValue(
      new ApiProblem(
        "NOT_FOUND_OR_INACCESSIBLE",
        "The workspace was not found or is not accessible",
        404,
      ),
    );

    const response = await postGuestLink(new Request(
      "https://stowplan.test/api/admin/guest-links",
      {
        body: JSON.stringify({ workspaceId: "ws_remote" }),
        headers: {
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "NOT_FOUND_OR_INACCESSIBLE",
    });
    expect(mocks.authorizeAdmin).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceGuestLink).not.toHaveBeenCalled();
  });

  it.each(["editor", "viewer"] as const)(
    "does not let a workspace %s use the legacy invitation route",
    async (role) => {
      mocks.getWorkspaceAccess.mockResolvedValue({
        access: { accessRevision: 4, role },
      });
      mocks.createWorkspaceGuestLink.mockRejectedValue(
        new ApiProblem(
          "OWNER_REQUIRED",
          "Workspace owner access is required",
          403,
        ),
      );

      const response = await postGuestLink(new Request(
        "https://stowplan.test/api/admin/guest-links",
        {
          body: JSON.stringify({ workspaceId: "ws_shared" }),
          headers: {
            "content-type": "application/json",
            [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
          },
          method: "POST",
        },
      ));

      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        code: "OWNER_REQUIRED",
      });
      expect(mocks.authorizeAdmin).not.toHaveBeenCalled();
    },
  );

  it.each([
    GUEST_LINK_EXPIRY_HOURS.minimum - 1,
    GUEST_LINK_EXPIRY_HOURS.maximum + 1,
    GUEST_LINK_EXPIRY_HOURS.minimum + 0.5,
  ])(
    "strictly refuses the invalid legacy expiry %s",
    async (hours) => {
      const response = await postGuestLink(new Request(
        "https://stowplan.test/api/admin/guest-links",
        {
          body: JSON.stringify({ hours, workspaceId: "ws_owned" }),
          headers: {
            "content-type": "application/json",
            [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
          },
          method: "POST",
        },
      ));

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_REQUEST",
        error: expect.stringContaining(
          `integer from ${GUEST_LINK_EXPIRY_HOURS.minimum} through ${GUEST_LINK_EXPIRY_HOURS.maximum}`,
        ),
      });
      expect(mocks.getWorkspaceAccess).not.toHaveBeenCalled();
      expect(mocks.createWorkspaceGuestLink).not.toHaveBeenCalled();
    },
  );

  it("lets a workspace owner create a strictly bounded guest link", async () => {
    const response = await postGuestLink(new Request(
      "https://stowplan.test/api/admin/guest-links",
      {
        body: JSON.stringify({
          hours: 48,
          role: "viewer",
          workspaceId: "ws_owned",
        }),
        headers: {
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { url: string };
    const invitation = new URL(body.url);
    expect(invitation.pathname).toBe("/guest");
    expect(invitation.search).toBe("");
    expect(new URLSearchParams(invitation.hash.slice(1)).get("token"))
      .toBe("guest_token");
    expect(mocks.authorizeAdmin).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceGuestLink).toHaveBeenCalledWith(
      {},
      "ws_owned",
      "usr_owner",
      {
        expectedAccessRevision: 4,
        expiresInHours: 48,
        returnTo: undefined,
        role: "viewer",
      },
    );
  });
});
