import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_NOTIFICATION_COALESCE_MS,
  LIVE_RECONNECT_MAXIMUM_MS,
  LIVE_RECONNECT_STABLE_MS,
  liveReconnectDelay,
  parseLiveCapability,
  startLiveWorkspaceConnection,
} from "../src/client/live-reconciliation";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";

const ACCOUNT_ID = "usr_live";

class FakeSocket {
  closed = false;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

function accountResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set(ACCOUNT_CONTEXT_HEADER, ACCOUNT_ID);
  return Response.json(body, { ...init, headers });
}

function connectionOptions(overrides: Partial<Parameters<
  typeof startLiveWorkspaceConnection
>[0]> = {}) {
  return {
    accessRevision: 1,
    accountId: ACCOUNT_ID,
    connectionId: "connection_test",
    isOnline: () => true,
    onAccessLost: vi.fn(),
    onAccountMismatch: vi.fn(),
    onAuthenticationRequired: vi.fn(),
    onMessage: vi.fn(),
    random: () => 0,
    revision: 0,
    workspaceId: "ws_live",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("live workspace reconciliation", () => {
  it("validates transport-specific capabilities", () => {
    expect(parseLiveCapability({
      accessRevision: 2,
      endpoint: "wss://relay.example/v1/connect",
      protocols: ["stowplan-live-v1", "stowplan-auth.token"],
      revision: 7,
      transport: "websocket",
    })).toMatchObject({
      revision: 7,
      transport: "websocket",
    });
    expect(() => parseLiveCapability({
      accessRevision: 2,
      endpoint: "https://relay.example/v1/connect",
      protocols: ["stowplan-live-v1", "stowplan-auth.token"],
      revision: 7,
      transport: "websocket",
    })).toThrow("WebSocket endpoint");
  });

  it("uses bounded equal-jitter reconnect delays", () => {
    expect(liveReconnectDelay(0, () => 0)).toBe(500);
    expect(liveReconnectDelay(0, () => 1)).toBe(1_000);
    expect(liveReconnectDelay(30, () => 1)).toBe(
      LIVE_RECONNECT_MAXIMUM_MS,
    );
  });

  it("coalesces WebSocket hints and reconnects only after closure", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const fetcher = vi.fn(async () => accountResponse({
      accessRevision: 1,
      endpoint: "wss://relay.example/v1/connect",
      protocols: ["stowplan-live-v1", "stowplan-auth.token"],
      revision: 0,
      transport: "websocket",
    }));
    const options = connectionOptions({
      fetcher: fetcher as typeof fetch,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const connection = startLiveWorkspaceConnection(options);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        accessRevision: 1,
        revision: 2,
        type: "change",
        version: 1,
      }),
    });
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        accessRevision: 1,
        revision: 3,
        type: "change",
        version: 1,
      }),
    });

    await vi.advanceTimersByTimeAsync(LIVE_NOTIFICATION_COALESCE_MS);
    expect(options.onMessage).toHaveBeenCalledTimes(1);
    expect(options.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 3, type: "change" }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);

    sockets[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(499);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    connection.stop();
  });

  it("keeps backing off when WebSocket connections flap", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const fetcher = vi.fn(async () => accountResponse({
      accessRevision: 1,
      endpoint: "wss://relay.example/v1/connect",
      protocols: ["stowplan-live-v1", "stowplan-auth.token"],
      revision: 0,
      transport: "websocket",
    }));
    const connection = startLiveWorkspaceConnection(connectionOptions({
      fetcher: fetcher as typeof fetch,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    }));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();
    sockets[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.onopen?.();
    sockets[1]!.onclose?.();

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    connection.stop();
  });

  it("resets reconnect backoff after a stable WebSocket connection", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const connection = startLiveWorkspaceConnection(connectionOptions({
      fetcher: vi.fn(async () => accountResponse({
        accessRevision: 1,
        endpoint: "wss://relay.example/v1/connect",
        protocols: ["stowplan-live-v1", "stowplan-auth.token"],
        revision: 0,
        transport: "websocket",
      })) as typeof fetch,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    }));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();
    sockets[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.onopen?.();
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_STABLE_MS);
    sockets[1]!.onclose?.();

    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    connection.stop();
  });

  it("consumes a local SSE stream through one long-lived request", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: live\ndata: {"accessRevision":1,"revision":2,' +
            '"type":"change","version":1}\n\n',
        ));
      },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(accountResponse({
        accessRevision: 1,
        endpoint: "/api/live/events?connectionId=connection_test" +
          "&workspaceId=ws_live",
        revision: 0,
        transport: "sse",
      }))
      .mockResolvedValueOnce(new Response(stream, {
        headers: {
          [ACCOUNT_CONTEXT_HEADER]: ACCOUNT_ID,
          "content-type": "text/event-stream",
        },
      }));
    const options = connectionOptions({
      fetcher: fetcher as typeof fetch,
    });
    const connection = startLiveWorkspaceConnection(options);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(LIVE_NOTIFICATION_COALESCE_MS);
    expect(options.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 2, type: "change" }),
    );
    expect(fetcher.mock.calls[1]?.[0]).toContain("/api/live/events?");
    connection.stop();
  });

  it("stops after the server reports that live transport is unavailable", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => accountResponse({
      accessRevision: 1,
      revision: 0,
      transport: "unavailable",
    }));
    const options = connectionOptions({ fetcher: fetcher as typeof fetch });
    const connection = startLiveWorkspaceConnection(options);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10 * LIVE_RECONNECT_MAXIMUM_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(options.onMessage).not.toHaveBeenCalled();
    connection.stop();
  });

  it("surfaces account changes without reconnecting", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => Response.json(
      {
        code: "ACCOUNT_CONTEXT_CHANGED",
        error: "Account changed",
      },
      { status: 409 },
    ));
    const options = connectionOptions({ fetcher: fetcher as typeof fetch });
    const connection = startLiveWorkspaceConnection(options);

    await vi.waitFor(() => {
      expect(options.onAccountMismatch).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(LIVE_RECONNECT_MAXIMUM_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    connection.stop();
  });
});
