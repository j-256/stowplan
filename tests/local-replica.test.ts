import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyState } from "../src/domain/factories";
import { clearReplica, readReplica, writeReplica } from "../src/client/local-replica";

describe("local replica", () => {
  beforeEach(async () => clearReplica());
  it("atomically preserves the workspace and durable outbox", async () => {
    const state = createEmptyState("Offline home", "2026-07-22T00:00:00.000Z");
    await writeReplica({ state, outbox: [], updatedAt: state.workspace.updatedAt });
    expect((await readReplica())?.state.workspace.name).toBe("Offline home");
  });
});
