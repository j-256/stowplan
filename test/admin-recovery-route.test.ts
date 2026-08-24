import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";
import { ADMIN_RECOVERY_TOKEN_HEADER } from "../src/server/admin-recovery-token";

const RECOVERY_TOKEN =
  "test-admin-recovery-token-000000000000000000000000";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authenticateAccessRecoveryPrincipals: vi.fn(),
  recoverGlobalAdmin: vi.fn(),
  runtimeEnv: vi.fn(),
}));

vi.mock("../src/server/account-governance", async importOriginal => ({
  ...await importOriginal<
    typeof import("../src/server/account-governance")
  >(),
  recoverGlobalAdmin: mocks.recoverGlobalAdmin,
}));

vi.mock("../src/server/auth", async importOriginal => ({
  ...await importOriginal<typeof import("../src/server/auth")>(),
  authenticate: mocks.authenticate,
  authenticateAccessRecoveryPrincipals:
    mocks.authenticateAccessRecoveryPrincipals,
  isTrustedMutation: vi.fn(() => true),
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: mocks.runtimeEnv,
}));

import { POST as recoverAdministrator } from
  "../app/api/admin/recovery/route";

function recoveryRequest(token = RECOVERY_TOKEN): Request {
  return new Request(
    "https://stowplan.test/api/admin/recovery",
    {
      headers: {
        [ACCOUNT_CONTEXT_HEADER]: "usr_app",
        [ADMIN_RECOVERY_TOKEN_HEADER]: token,
      },
      method: "POST",
    },
  );
}

describe("administrator recovery route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeEnv.mockResolvedValue({
      AUTH_ADMIN_REQUIRE_ACCESS: "true",
      AUTH_ADMIN_RECOVERY_TOKEN: RECOVERY_TOKEN,
      AUTH_BASE_URL: "https://stowplan.test",
      AUTH_IDENTITY_DIGEST_KEY:
        "test-recovery-audit-key-at-least-32-bytes",
      DB: {},
    });
    mocks.authenticateAccessRecoveryPrincipals.mockResolvedValue({
      access: {
        displayName: "Access operator",
        email: "operator@access.example",
        provider: "cloudflare-access",
        subject: "access-operator",
      },
      user: {
        displayName: "Recovery account",
        email: "recovery@google.example",
        expiresAt: "2030-01-01T00:00:00.000Z",
        globalRole: "user",
        sessionId: "ses_recovery",
        userId: "usr_app",
      },
    });
    mocks.authenticate.mockResolvedValue({
      displayName: "Recovery account",
      email: "recovery@google.example",
      expiresAt: "2030-01-01T00:00:00.000Z",
      globalRole: "user",
      sessionId: "ses_recovery",
      userId: "usr_app",
    });
    mocks.recoverGlobalAdmin.mockResolvedValue({
      promoted: true,
      revokedSessions: 1,
      status: "recovered",
      userId: "usr_app",
    });
  });

  it("promotes only the authenticated app user despite principal mismatch", async () => {
    const response = await recoverAdministrator(recoveryRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe("usr_app");
    expect(mocks.recoverGlobalAdmin).toHaveBeenCalledWith(
      expect.anything(),
      {
        principalDigest:
          expect.stringMatching(/^v1:[0-9a-f]{64}$/u),
        emailMatched: false,
        reason: "Access and emergency recovery token",
        recoveryMode: "access",
        retainedSessionId: "ses_recovery",
        targetUserId: "usr_app",
      },
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      promoted: true,
      revokedSessions: 1,
      status: "recovered",
    });
  });

  it("fails closed without revealing recovery token state", async () => {
    const response = await recoverAdministrator(
      recoveryRequest(
        "test-wrong-recovery-token-000000000000000000000000",
      ),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.recoverGlobalAdmin).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).toEqual({
      code: "ADMIN_REQUIRED",
      error: "Administrator recovery authorization failed",
    });
    expect(JSON.stringify(body)).not.toContain(RECOVERY_TOKEN);
  });

  it("uses the app session plus token when Access is not required", async () => {
    mocks.runtimeEnv.mockResolvedValue({
      AUTH_ADMIN_REQUIRE_ACCESS: "false",
      AUTH_ADMIN_RECOVERY_TOKEN: RECOVERY_TOKEN,
      AUTH_BASE_URL: "https://stowplan.test",
      AUTH_IDENTITY_DIGEST_KEY:
        "test-recovery-audit-key-at-least-32-bytes",
      DB: {},
    });

    const response = await recoverAdministrator(recoveryRequest());

    expect(response.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Request),
    );
    expect(mocks.authenticateAccessRecoveryPrincipals)
      .not.toHaveBeenCalled();
    expect(mocks.recoverGlobalAdmin).toHaveBeenCalledWith(
      expect.anything(),
      {
        principalDigest:
          expect.stringMatching(/^v1:[0-9a-f]{64}$/u),
        reason: "App session and emergency recovery token",
        recoveryMode: "app-session",
        retainedSessionId: "ses_recovery",
        targetUserId: "usr_app",
      },
    );
  });

  it("requires an app session in non-Access deployments", async () => {
    mocks.runtimeEnv.mockResolvedValue({
      AUTH_ADMIN_REQUIRE_ACCESS: "false",
      AUTH_ADMIN_RECOVERY_TOKEN: RECOVERY_TOKEN,
      AUTH_BASE_URL: "https://stowplan.test",
      AUTH_IDENTITY_DIGEST_KEY:
        "test-recovery-audit-key-at-least-32-bytes",
      DB: {},
    });
    mocks.authenticate.mockResolvedValue(null);

    const response = await recoverAdministrator(recoveryRequest());

    expect(response.status).toBe(401);
    expect(mocks.authenticateAccessRecoveryPrincipals)
      .not.toHaveBeenCalled();
    expect(mocks.recoverGlobalAdmin).not.toHaveBeenCalled();
  });

  it("keeps ineligible recovery attempts signed in and unchanged", async () => {
    mocks.recoverGlobalAdmin.mockResolvedValue({
      status: "ineligible",
    });

    const response = await recoverAdministrator(recoveryRequest());

    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("rejects request bodies before authenticating or reading the token", async () => {
    const response = await recoverAdministrator(new Request(
      "https://stowplan.test/api/admin/recovery",
      {
        body: "{}",
        headers: {
          [ACCOUNT_CONTEXT_HEADER]: "usr_app",
          [ADMIN_RECOVERY_TOKEN_HEADER]: RECOVERY_TOKEN,
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(400);
    expect(mocks.authenticateAccessRecoveryPrincipals)
      .not.toHaveBeenCalled();
    expect(mocks.recoverGlobalAdmin).not.toHaveBeenCalled();
  });
});
