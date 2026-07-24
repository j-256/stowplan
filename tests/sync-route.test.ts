import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import { SYNC_REQUEST_MAX_BYTES } from "../src/server/request-body";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  canReadWorkspace: vi.fn(),
  canWriteWorkspace: vi.fn(),
  initialize: vi.fn(),
  load: vi.fn(),
  synchronize: vi.fn(),
}));

vi.mock("../src/adapters/d1-snapshot-store", () => ({
  D1SnapshotStore: class {
    load = mocks.load;
    initialize = mocks.initialize;
    deleteIfUnclaimed = vi.fn();
  },
}));

vi.mock("../src/server/auth", () => ({
  authenticate: mocks.authenticate,
  canOwnWorkspace: vi.fn(),
  canReadWorkspace: mocks.canReadWorkspace,
  canWriteWorkspace: mocks.canWriteWorkspace,
  claimWorkspace: vi.fn(),
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
