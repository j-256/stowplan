import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import type { WorkspaceState } from "../src/domain/types";
import { serializedJsonBytes } from "../src/server/quotas";
import { API_QUOTAS } from "../src/shared/api-quotas";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";

const OWNER_ACCOUNT_ID = "usr_owner";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  loadAuthorized: vi.fn(),
  restoreOwnedWorkspace: vi.fn(),
}));

vi.mock("../src/adapters/d1-snapshot-store", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../src/adapters/d1-snapshot-store")
  >();
  return {
    ...actual,
    D1SnapshotStore: class {
      loadAuthorized = mocks.loadAuthorized;
    },
  };
});

vi.mock("../src/server/auth", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../src/server/auth")
  >();
  return {
    ...actual,
    authenticate: mocks.authenticate,
    isTrustedMutation: vi.fn(() => true),
  };
});

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({ DB: {} })),
}));

vi.mock("../src/server/workspace-initialization", () => ({
  restoreOwnedWorkspace: mocks.restoreOwnedWorkspace,
}));

import {
  GET,
  PUT,
} from "../app/api/snapshot/route";

function authorized(
  state: WorkspaceState,
  role: "editor" | "owner" | "viewer" = "owner",
) {
  return {
    accessRevision: 7,
    membershipRevision: 11,
    ownerCount: 1,
    role,
    state,
    updatedAt: "2026-07-25T12:00:00.000Z",
  };
}

function restoreRequest(state: WorkspaceState, extra = {}) {
  return new Request("https://stowplan.test/api/snapshot", {
    body: JSON.stringify({
      expectedRevision: state.workspace.revision,
      snapshot: state,
      workspaceId: state.workspace.id,
      ...extra,
    }),
    headers: {
      "content-type": "application/json",
      [ACCOUNT_CONTEXT_HEADER]: OWNER_ACCOUNT_ID,
    },
    method: "PUT",
  });
}

function snapshotRequest(
  workspaceId: string,
  accountId = OWNER_ACCOUNT_ID,
): Request {
  return new Request(
    `https://stowplan.test/api/snapshot?workspaceId=${workspaceId}`,
    { headers: { [ACCOUNT_CONTEXT_HEADER]: accountId } },
  );
}

describe("snapshot route authorization and quotas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      displayName: "Owner",
      email: "owner@example.com",
      expiresAt: "",
      globalRole: "user",
      userId: OWNER_ACCOUNT_ID,
    });
    mocks.loadAuthorized.mockResolvedValue(null);
  });

  it("loads state and authorization in one member-scoped lookup", async () => {
    const state = createEmptyState("Server workspace");
    mocks.loadAuthorized.mockResolvedValue(authorized(state, "viewer"));

    const response = await GET(snapshotRequest(state.workspace.id));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      OWNER_ACCOUNT_ID,
    );
    await expect(response.json()).resolves.toMatchObject({
      authorization: {
        accessRevision: 7,
        capabilities: {
          read: true,
          write: false,
        },
        membershipRevision: 11,
        role: "viewer",
      },
      state,
      workspace: {
        id: state.workspace.id,
        name: state.workspace.name,
        role: "viewer",
      },
    });
    expect(mocks.loadAuthorized).toHaveBeenCalledWith(
      state.workspace.id,
      "usr_owner",
    );
  });

  it("does not reveal whether an inaccessible workspace exists", async () => {
    const response = await GET(snapshotRequest("ws_private"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      error: "Workspace was not found or is inaccessible",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not treat a global admin as an implicit workspace member", async () => {
    mocks.authenticate.mockResolvedValue({
      displayName: "Administrator",
      email: "admin@example.com",
      expiresAt: "",
      globalRole: "admin",
      userId: "usr_admin",
    });

    const response = await GET(snapshotRequest(
      "ws_member_only",
      "usr_admin",
    ));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "NOT_FOUND_OR_INACCESSIBLE",
    });
    expect(mocks.loadAuthorized).toHaveBeenCalledWith(
      "ws_member_only",
      "usr_admin",
    );
  });

  it("rejects a request bound to a different signed-in account", async () => {
    const response = await GET(snapshotRequest(
      "ws_account_changed",
      "usr_other",
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "ACCOUNT_CONTEXT_CHANGED",
      error: "The signed-in account changed; refresh before continuing",
    });
    expect(mocks.loadAuthorized).not.toHaveBeenCalled();
  });

  it("rejects an oversized restore before loading state", async () => {
    const state = createEmptyState("Oversized restore");
    state.items = Array.from(
      { length: API_QUOTAS.itemsPerSnapshot + 1 },
      (_, index) => ({ id: `item_${index}` }) as never,
    );

    const response = await PUT(restoreRequest(state));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      actual: API_QUOTAS.itemsPerSnapshot + 1,
      code: "QUOTA_EXCEEDED",
      error: "This workspace has reached its item record limit",
      limit: API_QUOTAS.itemsPerSnapshot,
      quota: "itemsPerSnapshot",
    });
    expect(mocks.loadAuthorized).not.toHaveBeenCalled();
    expect(mocks.restoreOwnedWorkspace).not.toHaveBeenCalled();
  });

  it("rechecks stored bytes after assigning the server revision", async () => {
    const state = createEmptyState("Boundary restore");
    const remaining = API_QUOTAS.storedSnapshotBytes -
      serializedJsonBytes(state);
    state.workspace.name += "x".repeat(remaining);
    expect(serializedJsonBytes(state))
      .toBe(API_QUOTAS.storedSnapshotBytes);
    const current = structuredClone(state);
    current.workspace.name = "Server state";
    current.workspace.revision = 9_999_999;
    mocks.loadAuthorized.mockResolvedValue(authorized(current));

    const response = await PUT(restoreRequest(state, {
      expectedRevision: current.workspace.revision,
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "QUOTA_EXCEEDED",
      error: "This workspace has reached its stored snapshot size limit",
      limit: API_QUOTAS.storedSnapshotBytes,
      quota: "storedSnapshotBytes",
    });
    expect(mocks.restoreOwnedWorkspace).not.toHaveBeenCalled();
  });

  it("rejects an editor restore before any database mutation", async () => {
    const state = createEmptyState("Editor workspace");
    mocks.loadAuthorized.mockResolvedValue(authorized(state, "editor"));

    const response = await PUT(restoreRequest(state));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      authorization: {
        capabilities: { write: true },
        role: "editor",
      },
      code: "OWNER_REQUIRED",
      workspace: {
        id: state.workspace.id,
        role: "editor",
      },
    });
    expect(mocks.restoreOwnedWorkspace).not.toHaveBeenCalled();
  });

  it("restores and audits with one authorization-aware transaction", async () => {
    const current = createEmptyState("Restore target");
    current.workspace.revision = 4;
    const backup = createEmptyState("Restored name");
    backup.workspace.id = current.workspace.id;
    backup.workspace.revision = 2;
    mocks.loadAuthorized.mockResolvedValue(authorized(current));
    mocks.restoreOwnedWorkspace.mockResolvedValue({
      accessRevision: 7,
      membershipRevision: 11,
      ownerCount: 1,
      revision: 5,
      role: "owner",
      status: "restored",
      updatedAt: "2026-07-25T12:01:00.000Z",
    });

    const response = await PUT(restoreRequest(backup, {
      authorization: {
        membershipRevision: 11,
        workspaceAccessRevision: 7,
      },
      expectedRevision: 4,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      OWNER_ACCOUNT_ID,
    );
    const restored = mocks.restoreOwnedWorkspace.mock.calls[0];
    expect(restored?.slice(0, 4)).toEqual([
      {},
      "usr_owner",
      4,
      {
        membershipRevision: 11,
        workspaceAccessRevision: 7,
      },
    ]);
    expect(restored?.[4]).toMatchObject({
      workspace: {
        id: current.workspace.id,
        name: "Restored name",
        revision: 5,
      },
    });
    expect(restored?.[5]).toBe(2);
    await expect(response.json()).resolves.toMatchObject({
      auditRecorded: true,
      authorization: {
        role: "owner",
      },
      state: {
        workspace: {
          name: "Restored name",
          revision: 5,
        },
      },
      workspace: {
        revision: 5,
        role: "owner",
      },
    });
  });

  it("surfaces an atomic role-change refusal with current access", async () => {
    const state = createEmptyState("Downgrade target");
    state.workspace.revision = 4;
    mocks.loadAuthorized
      .mockResolvedValueOnce(authorized(state))
      .mockResolvedValueOnce(authorized(state, "editor"));
    mocks.restoreOwnedWorkspace.mockResolvedValue({
      accessRevision: 8,
      membershipRevision: 12,
      revision: 4,
      role: "editor",
      status: "owner-required",
    });

    const response = await PUT(restoreRequest(state, {
      authorization: {
        membershipRevision: 11,
        workspaceAccessRevision: 7,
      },
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      authorization: {
        role: "editor",
      },
      code: "OWNER_REQUIRED",
      workspace: {
        role: "editor",
      },
    });
  });

  it("uses a structured stale-access error without changing state", async () => {
    const state = createEmptyState("Stale access");
    mocks.loadAuthorized.mockResolvedValue(authorized(state));
    mocks.restoreOwnedWorkspace.mockResolvedValue({
      accessRevision: 8,
      membershipRevision: 12,
      revision: state.workspace.revision,
      role: "owner",
      status: "access-stale",
    });

    const response = await PUT(restoreRequest(state, {
      authorization: {
        membershipRevision: 10,
        workspaceAccessRevision: 6,
      },
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ACCESS_STALE",
      error: expect.stringContaining("access changed"),
    });
  });
});
