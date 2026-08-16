import { describe, expect, it } from "vitest";
import {
  LIVE_AUTH_SUBPROTOCOL_PREFIX,
  LIVE_SUBPROTOCOL,
  liveRequestCost,
  parseLiveNotification,
  pollingRequestsPerDay,
  signLiveCapability,
  signLiveRelayRequest,
  verifyLiveCapability,
  verifyLiveRelayRequest,
} from "../src/shared/live-collaboration";

const SECRET = "test-live-relay-secret-with-at-least-32-bytes";
const NOW = Date.parse("2026-08-16T12:00:00.000Z");

describe("live collaboration protocol", () => {
  it("round-trips an origin-bound short-lived capability", async () => {
    const token = await signLiveCapability({
      accessRevision: 7,
      connectionId: "connection_a",
      expiresAt: NOW + 60_000,
      issuedAt: NOW,
      origin: "https://stowplan.example",
      revision: 12,
      userId: "user_a",
      workspaceId: "ws_a",
    }, SECRET);

    const verified = await verifyLiveCapability(token, SECRET, {
      now: NOW + 30_000,
      origin: "https://stowplan.example",
    });

    expect(verified).toMatchObject({
      accessRevision: 7,
      connectionId: "connection_a",
      revision: 12,
      userId: "user_a",
      workspaceId: "ws_a",
    });
    expect(`${LIVE_AUTH_SUBPROTOCOL_PREFIX}${token}`).not.toContain("=");
    expect(LIVE_SUBPROTOCOL).toBe("stowplan-live-v1");
  });

  it("rejects expired, cross-origin, and incorrectly signed capabilities", async () => {
    const token = await signLiveCapability({
      accessRevision: 0,
      connectionId: "connection_a",
      expiresAt: NOW + 1_000,
      issuedAt: NOW,
      origin: "https://stowplan.example",
      revision: 0,
      userId: "user_a",
      workspaceId: "ws_a",
    }, SECRET);

    await expect(verifyLiveCapability(token, SECRET, {
      now: NOW + 1_001,
      origin: "https://stowplan.example",
    })).rejects.toThrow("expired");
    await expect(verifyLiveCapability(token, SECRET, {
      now: NOW,
      origin: "https://other.example",
    })).rejects.toThrow("origin");
    await expect(verifyLiveCapability(
      token,
      "another-test-secret-with-at-least-32-bytes",
      { now: NOW, origin: "https://stowplan.example" },
    )).rejects.toThrow("signature");
  });

  it("signs the exact relay request body and timestamp", async () => {
    const body = JSON.stringify({ revision: 3, workspaceId: "ws_a" });
    const timestamp = String(NOW);
    const signature = await signLiveRelayRequest(
      body,
      timestamp,
      SECRET,
    );

    await expect(verifyLiveRelayRequest(
      body,
      timestamp,
      signature,
      SECRET,
      NOW + 30_000,
    )).resolves.toBeUndefined();
    await expect(verifyLiveRelayRequest(
      `${body} `,
      timestamp,
      signature,
      SECRET,
      NOW + 30_000,
    )).rejects.toThrow("signature");
    await expect(verifyLiveRelayRequest(
      body,
      timestamp,
      signature,
      SECRET,
      NOW + 61_000,
    )).rejects.toThrow("timestamp");
  });

  it("normalizes bounded workspace notifications", () => {
    expect(parseLiveNotification({
      accessRevision: 4,
      allowedUserIds: ["user_b", "user_a", "user_b"],
      deleted: false,
      revision: 9,
      sourceConnectionId: "connection_a",
      type: "workspace-change",
      version: 1,
      workspaceId: "ws_a",
    })).toEqual({
      accessRevision: 4,
      allowedUserIds: ["user_a", "user_b"],
      deleted: false,
      revision: 9,
      sourceConnectionId: "connection_a",
      type: "workspace-change",
      version: 1,
      workspaceId: "ws_a",
    });

    expect(() => parseLiveNotification({
      accessRevision: 4,
      allowedUserIds: ["user_a"],
      deleted: false,
      revision: -1,
      type: "workspace-change",
      version: 1,
      workspaceId: "ws_a",
    })).toThrow("revision");
  });
});

describe("live collaboration request model", () => {
  it("charges idle tabs only for connection establishment", () => {
    expect(liveRequestCost({
      committedBatches: 120,
      connectedTabs: 8,
      reconnects: 2,
    })).toEqual({
      applicationRequests: 130,
      durableObjectRequests: 130,
      relayWorkerRequests: 130,
    });
  });

  it("shows why five-second polling is outside the daily budget", () => {
    expect(pollingRequestsPerDay(5, 1)).toBe(17_280);
    expect(pollingRequestsPerDay(5, 6)).toBe(103_680);
  });
});
