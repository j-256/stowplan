import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import { serializedJsonBytes } from "../src/server/quotas";
import { API_QUOTAS } from "../src/shared/api-quotas";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  canOwnWorkspace: vi.fn(),
  load: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("../src/adapters/d1-snapshot-store", () => ({
  D1SnapshotStore: class {
    load = mocks.load;
    replace = mocks.replace;
  },
}));

vi.mock("../src/server/admin", () => ({
  audit: vi.fn(),
}));

vi.mock("../src/server/auth", () => ({
  authenticate: mocks.authenticate,
  canOwnWorkspace: mocks.canOwnWorkspace,
  canReadWorkspace: vi.fn(),
  isTrustedMutation: vi.fn(() => true),
}));

vi.mock("../src/server/runtime", () => ({
  runtimeEnv: vi.fn(async () => ({ DB: {} })),
}));

import { PUT } from "../app/api/snapshot/route";

describe("snapshot route quotas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      displayName: "Owner",
      email: "owner@example.com",
      expiresAt: "",
      globalRole: "user",
      userId: "usr_owner",
    });
    mocks.canOwnWorkspace.mockResolvedValue(true);
  });

  it("rejects an oversized restore before loading or replacing state", async () => {
    const state = createEmptyState("Oversized restore");
    state.items = Array.from(
      { length: API_QUOTAS.itemsPerSnapshot + 1 },
      (_, index) => ({ id: `item_${index}` }) as never,
    );

    const response = await PUT(new Request(
      "https://stowplan.test/api/snapshot",
      {
        body: JSON.stringify({
          expectedRevision: 0,
          snapshot: state,
          workspaceId: state.workspace.id,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    ));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      actual: API_QUOTAS.itemsPerSnapshot + 1,
      code: "QUOTA_EXCEEDED",
      error: "This workspace has reached its item record limit",
      limit: API_QUOTAS.itemsPerSnapshot,
      quota: "itemsPerSnapshot",
    });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("rechecks stored bytes after assigning the server revision", async () => {
    const state = createEmptyState("Boundary restore");
    const remaining = API_QUOTAS.storedSnapshotBytes -
      serializedJsonBytes(state);
    state.workspace.name += "x".repeat(remaining);
    expect(serializedJsonBytes(state))
      .toBe(API_QUOTAS.storedSnapshotBytes);
    const current = createEmptyState("Server state");
    current.workspace.id = state.workspace.id;
    current.workspace.revision = 9_999_999;
    mocks.load.mockResolvedValue(current);

    const response = await PUT(new Request(
      "https://stowplan.test/api/snapshot",
      {
        body: JSON.stringify({
          expectedRevision: current.workspace.revision,
          snapshot: state,
          workspaceId: state.workspace.id,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    ));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "QUOTA_EXCEEDED",
      error: "This workspace has reached its stored snapshot size limit",
      limit: API_QUOTAS.storedSnapshotBytes,
      quota: "storedSnapshotBytes",
    });
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
