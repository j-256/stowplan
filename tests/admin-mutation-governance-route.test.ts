import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";
import { TEST_IDENTITY_DIGEST_KEY } from "./helpers/auth";

const mocks = vi.hoisted(() => ({
  adminMutation: vi.fn(),
  authorizeAdmin: vi.fn(),
}));

vi.mock("../src/server/admin", () => ({
  adminMutation: mocks.adminMutation,
}));

vi.mock("../src/server/auth", async importOriginal => ({
  ...await importOriginal<typeof import("../src/server/auth")>(),
  authorizeAdmin: mocks.authorizeAdmin,
  isTrustedMutation: vi.fn(() => true),
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({
    AUTH_IDENTITY_DIGEST_KEY:
      TEST_IDENTITY_DIGEST_KEY,
    DB: {},
  })),
}));

import { POST as mutateAdministrator } from
  "../app/api/admin/mutate/route";

function mutationRequest(body: unknown): Request {
  return new Request(
    "https://stowplan.test/api/admin/mutate",
    {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        [ACCOUNT_CONTEXT_HEADER]: "usr_admin",
      },
      method: "POST",
    },
  );
}

describe("admin governance mutation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeAdmin.mockResolvedValue({
      sessionId: "ses_admin",
      userId: "usr_admin",
    });
  });

  it("forwards ban metadata and clears a self-revoked session", async () => {
    mocks.adminMutation.mockResolvedValue({
      message: "Account banned and sign-in identities redacted",
      revokedSessions: 2,
    });

    const response = await mutateAdministrator(mutationRequest({
      action: "user.ban",
      expectedAccountRevision: 7,
      reason: "Confirmed abuse",
      targetId: "usr_admin",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.adminMutation).toHaveBeenCalledWith(
      expect.anything(),
      "usr_admin",
      {
        action: "user.ban",
        expectedAccountRevision: 7,
        reason: "Confirmed abuse",
        targetId: "usr_admin",
      },
      {
        actorSessionId: "ses_admin",
        identityDigestKey: TEST_IDENTITY_DIGEST_KEY,
        signInProviderIds: [],
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      currentSessionRevoked: true,
      revokedSessions: 2,
    });
  });

  it("does not clear the operator cookie for another account", async () => {
    mocks.adminMutation.mockResolvedValue({
      message: "User role changed to admin",
      revokedSessions: 1,
    });

    const response = await mutateAdministrator(mutationRequest({
      action: "user.role",
      expectedAccountRevision: 2,
      targetId: "usr_target",
      value: "admin",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.not.toHaveProperty(
      "currentSessionRevoked",
    );
  });

  it("rejects malformed account revisions before mutation", async () => {
    const response = await mutateAdministrator(mutationRequest({
      action: "user.status",
      expectedAccountRevision: -1,
      targetId: "usr_target",
      value: "disabled",
    }));

    expect(response.status).toBe(400);
    expect(mocks.adminMutation).not.toHaveBeenCalled();
  });
});
