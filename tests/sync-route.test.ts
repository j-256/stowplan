import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import { QuotaExceededError } from "../src/server/quotas";
import { SYNC_REQUEST_MAX_BYTES } from "../src/server/request-body";
import { API_QUOTAS } from "../src/shared/api-quotas";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  canOwnWorkspace: vi.fn(),
  canReadWorkspace: vi.fn(),
  canWriteWorkspace: vi.fn(),
  claimWorkspace: vi.fn(),
  deleteIfUnclaimed: vi.fn(),
  initialize: vi.fn(),
  load: vi.fn(),
  synchronize: vi.fn(),
}));

vi.mock("../src/adapters/d1-snapshot-store", () => ({
  D1SnapshotStore: class {
    load = mocks.load;
    initialize = mocks.initialize;
    deleteIfUnclaimed = mocks.deleteIfUnclaimed;
  },
}));

vi.mock("../src/server/auth", () => ({
  authenticate: mocks.authenticate,
  canOwnWorkspace: mocks.canOwnWorkspace,
  canReadWorkspace: mocks.canReadWorkspace,
  canWriteWorkspace: mocks.canWriteWorkspace,
  claimWorkspace: mocks.claimWorkspace,
  isTrustedMutation: vi.fn(() => true),
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({ DB: {} })),
}));

vi.mock("../src/server/sync-service", () => ({
  synchronize: mocks.synchronize,
  WorkspaceNotFoundError: class extends Error {},
}));

import { POST } from "../app/api/sync/route";
import { GET as GET_AUTH_STATUS } from "../app/api/auth/me/route";

describe("sync route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      userId: "usr_viewer",
      email: "viewer@example.com",
      displayName: "Viewer",
      globalRole: "user",
      expiresAt: "",
    });
    mocks.load.mockResolvedValue(null);
    mocks.initialize.mockResolvedValue("exists");
    mocks.claimWorkspace.mockResolvedValue(undefined);
    mocks.canOwnWorkspace.mockResolvedValue(true);
    mocks.deleteIfUnclaimed.mockResolvedValue(true);
    mocks.canReadWorkspace.mockResolvedValue(true);
    mocks.canWriteWorkspace.mockResolvedValue(false);
  });

  it("does not let a viewer write when another request wins initialization", async () => {
    const state = createEmptyState("Race");
    const response = await POST(new Request("https://stowplan.test/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: state.workspace.id,
        snapshot: state,
        commands: [{
          id: "cmd_race",
          workspaceId: state.workspace.id,
          actorId: "usr_viewer",
          deviceId: "device_test",
          timestamp: "2026-07-23T00:00:00.000Z",
          baseRevision: state.workspace.revision,
          command: { type: "workspace.update", changes: { name: "Unauthorized" } },
        }],
      }),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Workspace access denied",
    });
    expect(mocks.canWriteWorkspace).toHaveBeenCalledWith(
      {},
      "usr_viewer",
      state.workspace.id,
    );
    expect(mocks.canReadWorkspace).not.toHaveBeenCalled();
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
        },
        method: "POST",
      },
    ));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("byte limit"),
    });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("rejects an oversized command batch before storage work", async () => {
    const state = createEmptyState("Oversized batch");
    const commands = Array.from(
      { length: API_QUOTAS.commandsPerSyncRequest + 1 },
      (_, index) => ({
        actorId: "spoofed-user",
        baseRevision: 0,
        command: { type: "workspace.rename", name: `Name ${index}` },
        deviceId: "device_test",
        expectations: [],
        id: `cmd_${index}`,
        timestamp: "2026-07-24T00:00:00.000Z",
        workspaceId: state.workspace.id,
      }),
    );
    const response = await POST(new Request(
      "https://stowplan.test/api/sync",
      {
        body: JSON.stringify({
          commands,
          workspaceId: state.workspace.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      actual: API_QUOTAS.commandsPerSyncRequest + 1,
      code: "QUOTA_EXCEEDED",
      error: "This sync request contains too many commands",
      limit: API_QUOTAS.commandsPerSyncRequest,
      quota: "commandsPerSyncRequest",
    });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("rejects an oversized initial snapshot before initialization", async () => {
    const state = createEmptyState("Oversized snapshot");
    state.locations = Array.from(
      { length: API_QUOTAS.locationsPerSnapshot + 1 },
      (_, index) => ({ id: `loc_${index}` }) as never,
    );
    const response = await POST(new Request(
      "https://stowplan.test/api/sync",
      {
        body: JSON.stringify({
          commands: [],
          snapshot: state,
          workspaceId: state.workspace.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      actual: API_QUOTAS.locationsPerSnapshot + 1,
      code: "QUOTA_EXCEEDED",
      limit: API_QUOTAS.locationsPerSnapshot,
      quota: "locationsPerSnapshot",
    });
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("attributes commands to the authenticated user without changing their order", async () => {
    const state = createEmptyState("Attribution");
    const commands = ["cmd_second", "cmd_first"].map((id, index) => ({
      actorId: `spoofed-user-${index}`,
      baseRevision: state.workspace.revision,
      command: { type: "workspace.rename" as const, name: `Name ${index}` },
      deviceId: "device_test",
      expectations: [],
      id,
      timestamp: "2026-07-24T00:00:00.000Z",
      workspaceId: state.workspace.id,
    }));
    mocks.load.mockResolvedValue(state);
    mocks.canWriteWorkspace.mockResolvedValue(true);
    mocks.synchronize.mockResolvedValue({
      receipts: [],
      snapshot: state,
    });

    const response = await POST(new Request(
      "https://stowplan.test/api/sync",
      {
        body: JSON.stringify({
          commands,
          workspaceId: state.workspace.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.synchronize).toHaveBeenCalledTimes(1);
    const synchronized = mocks.synchronize.mock.calls[0]?.[2];
    expect(synchronized.map((command: { id: string }) => command.id)).toEqual([
      "cmd_second",
      "cmd_first",
    ]);
    expect(synchronized.map((command: { actorId: string }) => command.actorId))
      .toEqual(["usr_viewer", "usr_viewer"]);
    expect(commands.map((command) => command.actorId)).toEqual([
      "spoofed-user-0",
      "spoofed-user-1",
    ]);
  });

  it("removes a new snapshot when the owner workspace quota is full", async () => {
    const state = createEmptyState("Owner quota");
    mocks.initialize.mockResolvedValue("created");
    mocks.claimWorkspace.mockRejectedValue(new QuotaExceededError(
      "ownedWorkspacesPerUser",
      API_QUOTAS.ownedWorkspacesPerUser + 1,
    ));

    const response = await POST(new Request(
      "https://stowplan.test/api/sync",
      {
        body: JSON.stringify({
          commands: [],
          snapshot: state,
          workspaceId: state.workspace.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "QUOTA_EXCEEDED",
      quota: "ownedWorkspacesPerUser",
    });
    expect(mocks.deleteIfUnclaimed).toHaveBeenCalledWith(
      state.workspace.id,
      state.workspace.revision,
    );
    expect(mocks.synchronize).not.toHaveBeenCalled();
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
      configured: true,
      providers: [],
      user: null,
    });
  });
});
