import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyState } from "../src/domain/factories";

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
});
