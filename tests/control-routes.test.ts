import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_REQUEST_MAX_BYTES } from "../src/server/request-body";

const mocks = vi.hoisted(() => ({
  adminMutation: vi.fn(),
  authenticate: vi.fn(),
  authorizeAdmin: vi.fn(),
  canWriteWorkspace: vi.fn(),
  createGuestLink: vi.fn(),
  createOrLinkUser: vi.fn(),
  issueSession: vi.fn(),
}));

vi.mock("../src/server/admin", () => ({
  adminMutation: mocks.adminMutation,
  audit: vi.fn(),
}));

vi.mock("../src/server/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/server/auth")>(),
  authenticate: mocks.authenticate,
  authorizeAdmin: mocks.authorizeAdmin,
  canWriteWorkspace: mocks.canWriteWorkspace,
  createGuestLink: mocks.createGuestLink,
  createOrLinkUser: mocks.createOrLinkUser,
  isTrustedMutation: vi.fn(() => true),
  issueSession: mocks.issueSession,
  sessionCookie: vi.fn(() => "session=test"),
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({
    AUTH_DEV_ENABLED: "true",
    DB: {},
  })),
}));

import { POST as postGuestLink } from "../app/api/admin/guest-links/route";
import { POST as postAdminMutation } from "../app/api/admin/mutate/route";
import { POST as postDevelopmentSignIn } from "../app/api/auth/dev/route";
import { AuthorizationError } from "../src/server/auth";

function oversizedRequest(path: string): Request {
  return new Request(`https://stowplan.test${path}`, {
    body: "{}",
    headers: {
      "content-length": String(CONTROL_REQUEST_MAX_BYTES + 1),
      "content-type": "application/json",
    },
    method: "POST",
  });
}

describe("control route request limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      globalRole: "admin",
      userId: "usr_owner",
    });
    mocks.authorizeAdmin.mockResolvedValue({ userId: "usr_admin" });
    mocks.canWriteWorkspace.mockResolvedValue(true);
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
    expect(mocks.adminMutation).not.toHaveBeenCalled();
    expect(mocks.createGuestLink).not.toHaveBeenCalled();
    expect(mocks.createOrLinkUser).not.toHaveBeenCalled();
    expect(mocks.issueSession).not.toHaveBeenCalled();
  });

  it("requires the admin gate for a nonmember admin guest link", async () => {
    mocks.canWriteWorkspace.mockResolvedValue(false);
    mocks.authorizeAdmin.mockRejectedValue(
      new AuthorizationError("Cloudflare Access assertion required", 403),
    );

    const response = await postGuestLink(new Request(
      "https://stowplan.test/api/admin/guest-links",
      {
        body: JSON.stringify({ workspaceId: "ws_remote" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ));

    expect(response.status).toBe(403);
    expect(mocks.authorizeAdmin).toHaveBeenCalledOnce();
    expect(mocks.createGuestLink).not.toHaveBeenCalled();
  });

  it("lets workspace writers create guest links without the admin gate", async () => {
    mocks.createGuestLink.mockResolvedValue({
      expiresAt: "2030-01-01T00:00:00.000Z",
      id: "guest_link",
      raw: "guest_token",
    });

    const response = await postGuestLink(new Request(
      "https://stowplan.test/api/admin/guest-links",
      {
        body: JSON.stringify({ workspaceId: "ws_owned" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ));

    expect(response.status).toBe(201);
    expect(mocks.authorizeAdmin).not.toHaveBeenCalled();
    expect(mocks.createGuestLink).toHaveBeenCalledOnce();
  });
});
