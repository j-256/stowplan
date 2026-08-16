import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_DELETION_REQUEST_MAX_BYTES,
} from "../src/server/request-body";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";

const mocks = vi.hoisted(() => {
  const statement = {
    bind: vi.fn(),
    first: vi.fn(),
  };
  statement.bind.mockReturnValue(statement);
  return {
    authenticate: vi.fn(),
    executeAccountDeletion: vi.fn(),
    isTrustedMutation: vi.fn(() => true),
    notifyWorkspaceChanges: vi.fn(),
    prepareAccountDeletion: vi.fn(),
    statement,
  };
});

vi.mock("../src/server/account-governance", () => ({
  executeAccountDeletion: mocks.executeAccountDeletion,
  prepareAccountDeletion: mocks.prepareAccountDeletion,
}));

vi.mock("../src/server/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/server/auth")>(),
  authenticate: mocks.authenticate,
  clearSessionCookie: vi.fn(() => "__Host-stowplan_session=; Max-Age=0"),
  identityEnforcementConfigured: vi.fn(() => true),
  isTrustedMutation: mocks.isTrustedMutation,
}));

vi.mock("../src/server/live-notifications", () => ({
  notifyWorkspaceChanges: mocks.notifyWorkspaceChanges,
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({
    AUTH_BASE_URL: "https://stowplan.test",
    AUTH_IDENTITY_DIGEST_KEY:
      "test-account-deletion-digest-key-material",
    DB: {
      prepare: vi.fn(() => mocks.statement),
    },
  })),
}));

import {
  GET as prepareDeletion,
  POST as executeDeletion,
} from "../app/api/account/deletion/route";

const ACCOUNT_ID = "usr_delete";
const ACCOUNT_REVISION = 7;
const MEMBERSHIP_REVISION = 11;
const SESSION_CREATED_AT = "2026-07-26T12:00:00.000Z";

function request(
  method: "GET" | "POST",
  body?: BodyInit,
): Request {
  return new Request(
    "https://stowplan.test/api/account/deletion",
    {
      body,
      headers: {
        ...(body
          ? { "content-type": "application/json" }
          : {}),
        [ACCOUNT_CONTEXT_HEADER]: ACCOUNT_ID,
      },
      method,
    },
  );
}

function deletionBody(
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    confirmation: "DELETE",
    expectedAccountRevision: ACCOUNT_REVISION,
    expectedMembershipRevision: MEMBERSHIP_REVISION,
    ...extra,
  });
}

describe("account deletion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.statement.bind.mockReturnValue(mocks.statement);
    mocks.authenticate.mockResolvedValue({
      globalRole: "user",
      sessionId: "ses_recent",
      userId: ACCOUNT_ID,
    });
    mocks.prepareAccountDeletion.mockResolvedValue({
      accountRevision: ACCOUNT_REVISION,
      blockers: [],
      custodyTransfers: [],
      globalRole: "user",
      membershipCount: 2,
      membershipRevision: MEMBERSHIP_REVISION,
      status: "active",
      userId: ACCOUNT_ID,
    });
    mocks.statement.first.mockResolvedValue({
      reauthenticated_at: SESSION_CREATED_AT,
    });
    mocks.executeAccountDeletion.mockResolvedValue({
      affectedWorkspaceIds: ["ws_first", "ws_second"],
      deletedAt: "2026-07-26T12:01:00.000Z",
      deletionId: "del_test",
      identitiesDeleted: 1,
      membershipsDeleted: 2,
      sessionsRevoked: 1,
      unusedGuestLinksRevoked: 0,
    });
  });

  it("prepares blockers and custody without mutating the account", async () => {
    const response = await prepareDeletion(request("GET"));

    expect(response.status).toBe(200);
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      ACCOUNT_ID,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      deletion: {
        accountRevision: ACCOUNT_REVISION,
        membershipRevision: MEMBERSHIP_REVISION,
      },
    });
    expect(mocks.prepareAccountDeletion).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
    );
    expect(mocks.executeAccountDeletion).not.toHaveBeenCalled();
  });

  it("derives recent authentication from the server session", async () => {
    const response = await executeDeletion(
      request("POST", deletionBody()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.statement.bind).toHaveBeenCalledWith(
      "ses_recent",
      ACCOUNT_ID,
      expect.any(String),
    );
    expect(mocks.executeAccountDeletion).toHaveBeenCalledWith(
      expect.anything(),
      {
        confirmation: "DELETE",
        digestKey: "test-account-deletion-digest-key-material",
        expectedAccountRevision: ACCOUNT_REVISION,
        expectedMembershipRevision: MEMBERSHIP_REVISION,
        reauthenticatedAt: SESSION_CREATED_AT,
        userId: ACCOUNT_ID,
      },
    );
    expect(mocks.notifyWorkspaceChanges).toHaveBeenCalledWith(
      expect.anything(),
      ["ws_first", "ws_second"],
      { force: true },
    );
    await expect(response.json()).resolves.not.toHaveProperty(
      "deletion.affectedWorkspaceIds",
    );
  });

  it("rejects a client-supplied authentication timestamp", async () => {
    const response = await executeDeletion(request(
      "POST",
      deletionBody({
        reauthenticatedAt: "2099-01-01T00:00:00.000Z",
      }),
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
      error: expect.stringContaining("unsupported fields"),
    });
    expect(mocks.executeAccountDeletion).not.toHaveBeenCalled();
  });

  it("rejects oversized input before deletion", async () => {
    const deletionRequest = request("POST", "{}");
    deletionRequest.headers.set(
      "content-length",
      String(ACCOUNT_DELETION_REQUEST_MAX_BYTES + 1),
    );

    const response = await executeDeletion(deletionRequest);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
    expect(mocks.executeAccountDeletion).not.toHaveBeenCalled();
  });
});
