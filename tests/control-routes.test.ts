import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_REQUEST_MAX_BYTES } from "../src/server/request-body";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";
import { GUEST_LINK_EXPIRY_HOURS } from "../src/shared/api-quotas";

const OWNER_ACCOUNT_ID = "usr_owner";

const mocks = vi.hoisted(() => ({
  adminMutation: vi.fn(),
  adminOverview: vi.fn(),
  authenticate: vi.fn(),
  authorizeAdmin: vi.fn(),
  consumeGuestLink: vi.fn(),
  createWorkspaceGuestLink: vi.fn(),
  createOrLinkUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  issueSession: vi.fn(),
}));

vi.mock("../src/server/admin", () => ({
  adminMutation: mocks.adminMutation,
  adminOverview: mocks.adminOverview,
  audit: vi.fn(),
}));

vi.mock("../src/server/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/server/auth")>(),
  authenticate: mocks.authenticate,
  authorizeAdmin: mocks.authorizeAdmin,
  consumeGuestLink: mocks.consumeGuestLink,
  createOrLinkUser: mocks.createOrLinkUser,
  isTrustedMutation: vi.fn(() => true),
  issueSession: mocks.issueSession,
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
import { POST as postGuestInvitation } from "../app/api/auth/guest/[token]/route";
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
    mocks.authorizeAdmin.mockResolvedValue({ userId: "usr_admin" });
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
      { query: "retention", viewerUserId: "usr_admin" },
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
    expect(location.pathname).toBe("/account");
    expect(location.searchParams.get("returnTo")).toBe(
      "/guest/raw_token?returnTo=%2Fworkspaces%2Fws_invited%2Fsettings",
    );
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
