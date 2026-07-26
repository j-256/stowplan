import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyState,
  createEnvelope,
} from "../src/domain";
import type {
  WorkspaceState,
} from "../src/domain/types";
import { ApiProblem } from "../src/server/api-problem";
import { SYNC_REQUEST_MAX_BYTES } from "../src/server/request-body";
import { API_QUOTAS } from "../src/shared/api-quotas";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";

const MEMBER_ACCOUNT_ID = "usr_member";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  initializeOwnedWorkspace: vi.fn(),
  loadAuthorization: vi.fn(),
  loadAuthorized: vi.fn(),
  synchronize: vi.fn(),
}));

vi.mock("../src/adapters/d1-snapshot-store", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../src/adapters/d1-snapshot-store")
  >();
  return {
    ...actual,
    D1SnapshotStore: class {
      loadAuthorization = mocks.loadAuthorization;
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

vi.mock("../src/server/sync-service", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../src/server/sync-service")
  >();
  return {
    ...actual,
    synchronize: mocks.synchronize,
  };
});

vi.mock("../src/server/workspace-initialization", () => ({
  initializeOwnedWorkspace: mocks.initializeOwnedWorkspace,
}));

import { POST } from "../app/api/sync/route";
import { GET as GET_AUTH_STATUS } from "../app/api/auth/me/route";
import {
  WorkspaceSyncAuthorizationError,
} from "../src/server/sync-service";

function authorized(
  state: WorkspaceState,
  role: "editor" | "owner" | "viewer" = "editor",
) {
  return {
    accessRevision: 7,
    membershipRevision: 11,
    role,
    state,
  };
}

function syncRequest(
  body: unknown,
  accountId = MEMBER_ACCOUNT_ID,
) {
  return new Request("https://stowplan.test/api/sync", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      [ACCOUNT_CONTEXT_HEADER]: accountId,
    },
    method: "POST",
  });
}

describe("sync route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      displayName: "Member",
      email: "member@example.com",
      expiresAt: "",
      globalRole: "user",
      userId: MEMBER_ACCOUNT_ID,
    });
    mocks.initializeOwnedWorkspace.mockResolvedValue({
      accessRevision: null,
      membershipRevision: 11,
      ownerCount: 1,
      status: "exists",
    });
    mocks.loadAuthorization.mockResolvedValue({
      accessRevision: 7,
      active: true,
      deleted: false,
      membershipRevision: 11,
      role: "editor",
    });
    mocks.loadAuthorized.mockResolvedValue(null);
  });

  it("rejects a forged viewer mutation before synchronization", async () => {
    const state = createEmptyState("Read only");
    const command = createEnvelope(
      state,
      { type: "workspace.rename", name: "Unauthorized" },
      { id: "cmd_viewer" },
    );
    mocks.loadAuthorized.mockResolvedValue(
      authorized(state, "viewer"),
    );

    const response = await POST(syncRequest({
      commands: [command],
      workspaceId: state.workspace.id,
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      authorization: {
        capabilities: { write: false },
        role: "viewer",
        status: "active",
      },
      code: "WRITE_ACCESS_REQUIRED",
      receipts: [{
        commandId: "cmd_viewer",
        status: "rejected",
      }],
      workspace: {
        id: state.workspace.id,
        role: "viewer",
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      MEMBER_ACCOUNT_ID,
    );
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("rejects an oversized sync body before storage work", async () => {
    const response = await POST(new Request(
      "https://stowplan.test/api/sync",
      {
        body: "{}",
        headers: {
          "content-length": String(SYNC_REQUEST_MAX_BYTES + 1),
          "content-type": "application/json",
          [ACCOUNT_CONTEXT_HEADER]: MEMBER_ACCOUNT_ID,
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "BODY_TOO_LARGE",
      error: expect.stringContaining("byte limit"),
    });
    expect(mocks.loadAuthorized).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("rejects an oversized command batch before storage work", async () => {
    const state = createEmptyState("Oversized batch");
    const commands = Array.from(
      { length: API_QUOTAS.commandsPerSyncRequest + 1 },
      (_, index) => ({
        actorId: "spoofed-user",
        baseRevision: 0,
        command: {
          name: `Name ${index}`,
          type: "workspace.rename",
        },
        deviceId: "device_test",
        expectations: [],
        id: `cmd_${index}`,
        timestamp: "2026-07-24T00:00:00.000Z",
        workspaceId: state.workspace.id,
      }),
    );

    const response = await POST(syncRequest({
      commands,
      workspaceId: state.workspace.id,
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      actual: API_QUOTAS.commandsPerSyncRequest + 1,
      code: "QUOTA_EXCEEDED",
      error: "This sync request contains too many commands",
      limit: API_QUOTAS.commandsPerSyncRequest,
      quota: "commandsPerSyncRequest",
    });
    expect(mocks.loadAuthorized).not.toHaveBeenCalled();
  });

  it("rejects a sync request bound to a different account", async () => {
    const state = createEmptyState("Changed account");
    const response = await POST(syncRequest({
      commands: [],
      workspaceId: state.workspace.id,
    }, "usr_other"));

    expect(response.status).toBe(409);
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      MEMBER_ACCOUNT_ID,
    );
    await expect(response.json()).resolves.toEqual({
      code: "ACCOUNT_CONTEXT_CHANGED",
      error: "The signed-in account changed; refresh before continuing",
    });
    expect(mocks.loadAuthorized).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("rejects an oversized initial snapshot before initialization", async () => {
    const state = createEmptyState("Oversized snapshot");
    state.locations = Array.from(
      { length: API_QUOTAS.locationsPerSnapshot + 1 },
      (_, index) => ({ id: `loc_${index}` }) as never,
    );

    const response = await POST(syncRequest({
      commands: [],
      snapshot: state,
      workspaceId: state.workspace.id,
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      actual: API_QUOTAS.locationsPerSnapshot + 1,
      code: "QUOTA_EXCEEDED",
      quota: "locationsPerSnapshot",
    });
    expect(mocks.initializeOwnedWorkspace).not.toHaveBeenCalled();
  });

  it("attributes commands and attaches one current authorization basis", async () => {
    const state = createEmptyState("Attribution");
    const commands = ["cmd_second", "cmd_first"].map(
      (id, index) => ({
        ...createEnvelope(
          state,
          {
            name: `Name ${index}`,
            type: "workspace.rename" as const,
          },
          { id },
        ),
        actorId: `spoofed-user-${index}`,
      }),
    );
    mocks.loadAuthorized.mockResolvedValue(authorized(state));
    mocks.synchronize.mockResolvedValue({
      receipts: [],
      snapshot: state,
    });

    const response = await POST(syncRequest({
      commands,
      workspaceId: state.workspace.id,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      MEMBER_ACCOUNT_ID,
    );
    const synchronized = mocks.synchronize.mock.calls[0]?.[2];
    expect(synchronized.map(
      (command: { id: string }) => command.id,
    )).toEqual(["cmd_second", "cmd_first"]);
    expect(synchronized.map(
      (command: { actorId: string }) => command.actorId,
    )).toEqual(["usr_member", "usr_member"]);
    expect(synchronized.map(
      (command: { authorization: unknown }) =>
        command.authorization,
    )).toEqual([
      {
        membershipRevision: 11,
        workspaceAccessRevision: 7,
      },
      {
        membershipRevision: 11,
        workspaceAccessRevision: 7,
      },
    ]);
    expect(mocks.synchronize.mock.calls[0]?.[3]).toEqual({
      authorization: {
        basis: {
          membershipRevision: 11,
          workspaceAccessRevision: 7,
        },
        userId: "usr_member",
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      authorization: {
        accessRevision: 7,
        membershipRevision: 11,
        role: "editor",
      },
      state,
      workspace: {
        id: state.workspace.id,
        role: "editor",
      },
    });
  });

  it("rejects mixed or differently paired authorization bases", async () => {
    const state = createEmptyState("Pairing");
    const legacy = createEnvelope(
      state,
      { type: "workspace.rename", name: "Legacy" },
      { id: "cmd_legacy" },
    );
    const aware = {
      ...createEnvelope(
        state,
        { type: "workspace.rename", name: "Aware" },
        { id: "cmd_aware" },
      ),
      authorization: {
        membershipRevision: 11,
        workspaceAccessRevision: 7,
      },
    };
    mocks.loadAuthorized.mockResolvedValue(authorized(state));

    const mixed = await POST(syncRequest({
      commands: [legacy, aware],
      workspaceId: state.workspace.id,
    }));
    expect(mixed.status).toBe(400);
    await expect(mixed.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
      error: expect.stringContaining("cannot mix"),
    });

    const differentlyPaired = await POST(syncRequest({
      commands: [
        aware,
        {
          ...aware,
          authorization: {
            membershipRevision: 12,
            workspaceAccessRevision: 7,
          },
          id: "cmd_other_basis",
        },
      ],
      workspaceId: state.workspace.id,
    }));
    expect(differentlyPaired.status).toBe(400);
    await expect(differentlyPaired.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
      error: expect.stringContaining("same authorization basis"),
    });
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("initializes snapshot and owner membership atomically", async () => {
    const state = createEmptyState("New workspace");
    mocks.initializeOwnedWorkspace.mockResolvedValue({
      accessRevision: 1,
      membershipRevision: 1,
      ownerCount: 1,
      status: "created",
    });
    mocks.loadAuthorized
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(authorized(state, "owner"))
      .mockResolvedValueOnce(authorized(state, "owner"));
    mocks.synchronize.mockResolvedValue({
      receipts: [],
      snapshot: state,
    });

    const response = await POST(syncRequest({
      commands: [],
      snapshot: state,
      workspaceId: state.workspace.id,
    }));

    expect(response.status).toBe(200);
    expect(mocks.initializeOwnedWorkspace).toHaveBeenCalledWith(
      {},
      "usr_member",
      state,
    );
    expect(mocks.synchronize).toHaveBeenCalledTimes(1);
  });

  it("returns quota and tombstone initialization refusals without cleanup", async () => {
    const state = createEmptyState("Unavailable workspace");
    mocks.initializeOwnedWorkspace.mockResolvedValueOnce({
      accessRevision: null,
      membershipRevision: 11,
      ownerCount: API_QUOTAS.ownedWorkspacesPerUser,
      status: "quota",
    });
    const quotaResponse = await POST(syncRequest({
      commands: [],
      snapshot: state,
      workspaceId: state.workspace.id,
    }));
    expect(quotaResponse.status).toBe(409);
    await expect(quotaResponse.json()).resolves.toMatchObject({
      code: "QUOTA_EXCEEDED",
      quota: "ownedWorkspacesPerUser",
    });

    mocks.initializeOwnedWorkspace.mockResolvedValueOnce({
      accessRevision: null,
      membershipRevision: 11,
      ownerCount: 0,
      status: "deleted",
    });
    const deletedResponse = await POST(syncRequest({
      commands: [],
      snapshot: state,
      workspaceId: state.workspace.id,
    }));
    expect(deletedResponse.status).toBe(404);
    await expect(deletedResponse.json()).resolves.toEqual({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      error: "Workspace was not found or is inaccessible",
    });
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("emits Retry-After for retriable allocation refusals", async () => {
    const state = createEmptyState("Deferred workspace");
    mocks.initializeOwnedWorkspace.mockRejectedValueOnce(
      new ApiProblem(
        "QUOTA_EXCEEDED",
        "Workspace allocation is temporarily limited",
        429,
        {
          retryAfterSeconds: 86_400,
          quota: "workspacesCreatedPerAccountDay",
        },
      ),
    );

    const quotaResponse = await POST(syncRequest({
      commands: [],
      snapshot: state,
      workspaceId: state.workspace.id,
    }));

    expect(quotaResponse.status).toBe(429);
    expect(quotaResponse.headers.get("retry-after")).toBe("86400");
    await expect(quotaResponse.json()).resolves.toMatchObject({
      code: "QUOTA_EXCEEDED",
      quota: "workspacesCreatedPerAccountDay",
      retryAfterSeconds: 86_400,
    });

    mocks.initializeOwnedWorkspace.mockRejectedValueOnce(
      new ApiProblem(
        "CIRCUIT_PAUSED",
        "New server workspace allocation is temporarily paused",
        503,
      ),
    );
    const circuitResponse = await POST(syncRequest({
      commands: [],
      snapshot: state,
      workspaceId: state.workspace.id,
    }));

    expect(circuitResponse.status).toBe(503);
    expect(circuitResponse.headers.get("retry-after")).toBe("3600");
  });

  it("surfaces a role downgrade race with rejected command context", async () => {
    const state = createEmptyState("Downgrade");
    const command = createEnvelope(
      state,
      { type: "workspace.rename", name: "Queued edit" },
      { id: "cmd_downgraded" },
    );
    mocks.loadAuthorized.mockResolvedValue(authorized(state));
    mocks.synchronize.mockRejectedValue(
      new WorkspaceSyncAuthorizationError(
        "write",
        "Viewer access does not allow workspace changes",
        [{
          commandId: command.id,
          message: "Viewer access does not allow workspace changes",
          revision: state.workspace.revision,
          status: "rejected",
        }],
        state.workspace.revision,
        {
          accessRevision: 8,
          active: true,
          deleted: false,
          membershipRevision: 12,
          role: "viewer",
        },
      ),
    );

    const response = await POST(syncRequest({
      commands: [command],
      workspaceId: state.workspace.id,
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      authorization: {
        accessRevision: 8,
        membershipRevision: 12,
        role: "viewer",
      },
      code: "WRITE_ACCESS_REQUIRED",
      receipts: [{
        commandId: "cmd_downgraded",
        status: "rejected",
      }],
      workspace: {
        role: "viewer",
      },
    });
  });

  it("returns a role change that lands after an accepted sync", async () => {
    const state = createEmptyState("Accepted before downgrade");
    const updated = structuredClone(state);
    updated.workspace.revision += 1;
    updated.workspace.name = "Accepted edit";
    mocks.loadAuthorized
      .mockResolvedValueOnce(authorized(state))
      .mockResolvedValueOnce({
        ...authorized(updated, "viewer"),
        accessRevision: 8,
        membershipRevision: 12,
      });
    mocks.synchronize.mockResolvedValue({
      receipts: [{
        commandId: "cmd_accepted",
        revision: updated.workspace.revision,
        status: "applied",
      }],
      snapshot: updated,
    });
    const command = createEnvelope(
      state,
      { type: "workspace.rename", name: "Accepted edit" },
      { id: "cmd_accepted" },
    );

    const response = await POST(syncRequest({
      commands: [command],
      workspaceId: state.workspace.id,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorization: {
        role: "viewer",
      },
      receipts: [{
        commandId: "cmd_accepted",
        status: "applied",
      }],
      state: {
        workspace: {
          name: "Accepted edit",
          revision: updated.workspace.revision,
        },
      },
      workspace: {
        role: "viewer",
      },
    });
  });

  it("does not expose unexpected storage errors", async () => {
    const state = createEmptyState("Storage error");
    mocks.loadAuthorized.mockResolvedValue(authorized(state));
    mocks.synchronize.mockRejectedValue(
      new Error("SQL contained secret inventory data"),
    );

    const response = await POST(syncRequest({
      commands: [],
      workspaceId: state.workspace.id,
    }));

    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body).toEqual({
      code: "INTERNAL_ERROR",
      error: "Sync could not be completed",
    });
    expect(body.error).not.toContain("SQL");
    expect(body.error).not.toContain("inventory");
  });
});

describe("authentication status", () => {
  it("reports a configured signed-out server without an error response", async () => {
    mocks.authenticate.mockResolvedValue(null);

    const response = await GET_AUTH_STATUS(
      new Request("https://stowplan.test/api/auth/me"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accessMigrationAvailable: false,
      adminAccessRequired: false,
      configured: true,
      providers: [],
      turnstileSiteKey: null,
      user: null,
    });
  });
});
