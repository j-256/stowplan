import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_AUTH_SUBPROTOCOL_PREFIX,
  LIVE_PROTOCOL_VERSION,
  LIVE_RELAY_SIGNATURE_HEADER,
  LIVE_RELAY_TIMESTAMP_HEADER,
  LIVE_SUBPROTOCOL,
  signLiveCapability,
  signLiveRelayRequest,
  type LiveNotification,
  type LiveWireMessage,
} from "../../src/shared/live-collaboration";
import relay from "../../worker/live-relay";

const SECRET = "test-live-relay-secret-with-at-least-32-bytes";
const APP_ORIGIN = "https://app.example";

function notification(input: Partial<LiveNotification> & {
  workspaceId: string;
}): LiveNotification {
  return {
    accessRevision: 1,
    allowedUserIds: ["user_a", "user_b"],
    deleted: false,
    revision: 0,
    type: "workspace-change",
    version: LIVE_PROTOCOL_VERSION,
    ...input,
  };
}

async function publish(value: LiveNotification): Promise<Response> {
  const body = JSON.stringify(value);
  const timestamp = String(Date.now());
  const signature = await signLiveRelayRequest(body, timestamp, SECRET);
  return relay.fetch(new Request("https://relay.example/v1/publish", {
    body,
    headers: {
      "content-type": "application/json",
      [LIVE_RELAY_SIGNATURE_HEADER]: signature,
      [LIVE_RELAY_TIMESTAMP_HEADER]: timestamp,
    },
    method: "POST",
  }), env);
}

async function connect(input: {
  accessRevision?: number;
  connectionId: string;
  revision?: number;
  userId: string;
  workspaceId: string;
}): Promise<{ ready: LiveWireMessage; socket: WebSocket }> {
  const now = Date.now();
  const token = await signLiveCapability({
    accessRevision: input.accessRevision ?? 1,
    connectionId: input.connectionId,
    expiresAt: now + 60_000,
    issuedAt: now,
    origin: APP_ORIGIN,
    revision: input.revision ?? 0,
    userId: input.userId,
    workspaceId: input.workspaceId,
  }, SECRET);
  const response = await relay.fetch(new Request(
    "https://relay.example/v1/connect",
    {
      headers: {
        origin: APP_ORIGIN,
        "sec-websocket-protocol": [
          LIVE_SUBPROTOCOL,
          `${LIVE_AUTH_SUBPROTOCOL_PREFIX}${token}`,
        ].join(", "),
        upgrade: "websocket",
      },
    },
  ), env);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected a relay WebSocket");
  socket.accept();
  return { ready: await nextMessage(socket), socket };
}

function nextMessage(socket: WebSocket): Promise<LiveWireMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      try {
        resolve(JSON.parse(String(event.data)) as LiveWireMessage);
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before a live message arrived"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

afterEach(async () => {
  await reset();
});

describe("live relay Worker", () => {
  it("rejects unsigned publishes and origin-mismatched capabilities", async () => {
    const unsigned = await relay.fetch(new Request(
      "https://relay.example/v1/publish",
      {
        body: JSON.stringify(notification({ workspaceId: "ws_unsigned" })),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ), env);
    expect(unsigned.status).toBe(401);

    const now = Date.now();
    const token = await signLiveCapability({
      accessRevision: 1,
      connectionId: "connection_a",
      expiresAt: now + 60_000,
      issuedAt: now,
      origin: APP_ORIGIN,
      revision: 0,
      userId: "user_a",
      workspaceId: "ws_wrong_origin",
    }, SECRET);
    const mismatched = await relay.fetch(new Request(
      "https://relay.example/v1/connect",
      {
        headers: {
          origin: "https://other.example",
          "sec-websocket-protocol": [
            LIVE_SUBPROTOCOL,
            `${LIVE_AUTH_SUBPROTOCOL_PREFIX}${token}`,
          ].join(", "),
          upgrade: "websocket",
        },
      },
    ), env);
    expect(mismatched.status).toBe(401);
  });

  it("fans out revision signals while suppressing the source connection", async () => {
    const workspaceId = "ws_fanout";
    expect((await publish(notification({ workspaceId }))).status).toBe(204);
    const first = await connect({
      connectionId: "connection_a",
      userId: "user_a",
      workspaceId,
    });
    const second = await connect({
      connectionId: "connection_b",
      userId: "user_b",
      workspaceId,
    });
    expect(first.ready.type).toBe("ready");
    expect(second.ready.type).toBe("ready");
    const firstMessages: LiveWireMessage[] = [];
    first.socket.addEventListener("message", event => {
      firstMessages.push(JSON.parse(String(event.data)) as LiveWireMessage);
    });
    const secondMessage = nextMessage(second.socket);

    expect((await publish(notification({
      revision: 1,
      sourceConnectionId: "connection_a",
      workspaceId,
    }))).status).toBe(204);
    expect(await secondMessage).toMatchObject({ revision: 1, type: "change" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(firstMessages).toEqual([]);
    first.socket.close(1000, "done");
    second.socket.close(1000, "done");
  });

  it("notifies remaining members and closes revoked sockets", async () => {
    const workspaceId = "ws_revoke";
    await publish(notification({ workspaceId }));
    const first = await connect({
      connectionId: "connection_a",
      userId: "user_a",
      workspaceId,
    });
    const second = await connect({
      connectionId: "connection_b",
      userId: "user_b",
      workspaceId,
    });
    const firstMessage = nextMessage(first.socket);
    const secondMessage = nextMessage(second.socket);
    const secondClose = new Promise<CloseEvent>(resolve => {
      second.socket.addEventListener("close", resolve, { once: true });
    });

    expect((await publish(notification({
      accessRevision: 2,
      allowedUserIds: ["user_a"],
      revision: 1,
      workspaceId,
    }))).status).toBe(204);
    expect(await firstMessage).toMatchObject({ type: "access" });
    expect(await secondMessage).toMatchObject({ type: "access" });
    expect((await secondClose).code).toBe(4403);

    const stale = await publish(notification({
      accessRevision: 1,
      revision: 2,
      workspaceId,
    }));
    expect(stale.status).toBe(202);
    first.socket.close(1000, "done");
  });

  it("persists revision state and live sockets across object eviction", async () => {
    const workspaceId = "ws_hibernation";
    await publish(notification({
      allowedUserIds: ["user_a"],
      revision: 3,
      workspaceId,
    }));
    const connection = await connect({
      connectionId: "connection_a",
      revision: 3,
      userId: "user_a",
      workspaceId,
    });
    expect(connection.ready.revision).toBe(3);
    const id = env.WORKSPACES.idFromName(workspaceId);
    await evictDurableObject(env.WORKSPACES.get(id));
    const message = nextMessage(connection.socket);

    await publish(notification({
      allowedUserIds: ["user_a"],
      revision: 4,
      workspaceId,
    }));
    expect(await message).toMatchObject({ revision: 4, type: "change" });
    connection.socket.close(1000, "done");
  });

  it("closes every socket when a workspace is deleted", async () => {
    const workspaceId = "ws_deleted";
    await publish(notification({
      allowedUserIds: ["user_a"],
      workspaceId,
    }));
    const connection = await connect({
      connectionId: "connection_a",
      userId: "user_a",
      workspaceId,
    });
    const message = nextMessage(connection.socket);
    const closed = new Promise<CloseEvent>(resolve => {
      connection.socket.addEventListener("close", resolve, { once: true });
    });
    await publish(notification({
      accessRevision: 2,
      allowedUserIds: [],
      deleted: true,
      workspaceId,
    }));

    expect(await message).toMatchObject({ type: "deleted" });
    expect((await closed).code).toBe(4410);
  });
});
