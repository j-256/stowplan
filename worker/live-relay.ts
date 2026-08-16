import { DurableObject } from "cloudflare:workers";
import {
  LIVE_AUTH_SUBPROTOCOL_PREFIX,
  LIVE_PROTOCOL_VERSION,
  LIVE_RELAY_REQUEST_MAX_BYTES,
  LIVE_RELAY_SIGNATURE_HEADER,
  LIVE_RELAY_TIMESTAMP_HEADER,
  LIVE_SUBPROTOCOL,
  LiveProtocolError,
  liveBodyBytes,
  parseLiveNotification,
  verifyLiveCapability,
  verifyLiveRelayRequest,
  type LiveNotification,
  type LiveWireMessage,
} from "../src/shared/live-collaboration";

export interface LiveRelayEnv {
  LIVE_RELAY_SECRET: string;
  WORKSPACES: DurableObjectNamespace<WorkspaceLiveRoom>;
}

interface RoomState {
  accessRevision: number;
  allowedUserIds: string[] | null;
  deleted: boolean;
  revision: number;
}

interface SocketAttachment {
  connectionId: string;
  userId: string;
}

const ROOM_STATE_KEY = "room-state";
const INTERNAL_CONNECTION_ID_HEADER = "x-live-connection-id";
const INTERNAL_ACCESS_REVISION_HEADER = "x-live-access-revision";
const INTERNAL_REVISION_HEADER = "x-live-revision";
const INTERNAL_USER_ID_HEADER = "x-live-user-id";
const INTERNAL_WORKSPACE_ID_HEADER = "x-live-workspace-id";
const LIVE_CLOSE_INVALID_MESSAGE = 4400;
const LIVE_CLOSE_ACCESS_REVOKED = 4403;
const LIVE_CLOSE_WORKSPACE_DELETED = 4410;

function responseProblem(
  code: string,
  error: string,
  status: number,
): Response {
  return Response.json(
    { code, error },
    {
      headers: { "cache-control": "no-store" },
      status,
    },
  );
}

function offeredProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map(protocol => protocol.trim())
    .filter(Boolean);
}

function exactIntegerHeader(request: Request, name: string): number | null {
  const raw = request.headers.get(name);
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function requiredInternalHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) throw new LiveProtocolError("Live relay request is invalid");
  return value;
}

function wireMessage(
  state: RoomState,
  type: LiveWireMessage["type"],
): LiveWireMessage {
  return {
    accessRevision: state.accessRevision,
    revision: state.revision,
    type,
    version: LIVE_PROTOCOL_VERSION,
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function socketAttachment(socket: WebSocket): SocketAttachment | null {
  const value = socket.deserializeAttachment() as unknown;
  if (
    !value ||
    typeof value !== "object" ||
    !("connectionId" in value) ||
    !("userId" in value) ||
    typeof value.connectionId !== "string" ||
    typeof value.userId !== "string"
  ) {
    return null;
  }
  return {
    connectionId: value.connectionId,
    userId: value.userId,
  };
}

export class WorkspaceLiveRoom extends DurableObject<LiveRelayEnv> {
  private room: RoomState = {
    accessRevision: 0,
    allowedUserIds: null,
    deleted: false,
    revision: 0,
  };

  constructor(ctx: DurableObjectState, env: LiveRelayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get<RoomState>(ROOM_STATE_KEY) ??
        this.room;
    });
  }

  private async acceptConnection(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return responseProblem(
        "UPGRADE_REQUIRED",
        "A WebSocket upgrade is required",
        426,
      );
    }
    const accessRevision = exactIntegerHeader(
      request,
      INTERNAL_ACCESS_REVISION_HEADER,
    );
    const revision = exactIntegerHeader(request, INTERNAL_REVISION_HEADER);
    if (accessRevision === null || revision === null) {
      return responseProblem(
        "INVALID_REQUEST",
        "Live connection revisions are invalid",
        400,
      );
    }
    const attachment = {
      connectionId: requiredInternalHeader(
        request,
        INTERNAL_CONNECTION_ID_HEADER,
      ),
      userId: requiredInternalHeader(request, INTERNAL_USER_ID_HEADER),
    };
    if (this.room.deleted) {
      return responseProblem(
        "WORKSPACE_DELETED",
        "The workspace was deleted",
        410,
      );
    }
    if (
      this.room.allowedUserIds &&
      (
        accessRevision < this.room.accessRevision ||
        !this.room.allowedUserIds.includes(attachment.userId)
      )
    ) {
      return responseProblem(
        "MEMBERSHIP_REQUIRED",
        "Workspace membership is required",
        403,
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(wireMessage({
      ...this.room,
      accessRevision: Math.max(this.room.accessRevision, accessRevision),
      revision: Math.max(this.room.revision, revision),
    }, "ready")));
    return new Response(null, {
      headers: { "sec-websocket-protocol": LIVE_SUBPROTOCOL },
      status: 101,
      webSocket: client,
    });
  }

  private async publish(request: Request): Promise<Response> {
    let notification: LiveNotification;
    try {
      notification = parseLiveNotification(await request.json());
      if (
        notification.workspaceId !==
          requiredInternalHeader(request, INTERNAL_WORKSPACE_ID_HEADER)
      ) {
        throw new LiveProtocolError("Live workspace identity does not match");
      }
    } catch (error) {
      return responseProblem(
        "INVALID_REQUEST",
        error instanceof LiveProtocolError
          ? error.message
          : "Live workspace notification is invalid",
        400,
      );
    }
    if (notification.accessRevision < this.room.accessRevision) {
      return new Response(null, { status: 202 });
    }
    const prior = this.room;
    const accessChanged =
      notification.accessRevision > prior.accessRevision ||
      prior.allowedUserIds === null ||
      notification.deleted !== prior.deleted;
    const incomingAllowed = notification.allowedUserIds;
    const allowedUserIds = accessChanged
      ? incomingAllowed
      : prior.allowedUserIds ?? incomingAllowed;
    const next: RoomState = {
      accessRevision: Math.max(
        prior.accessRevision,
        notification.accessRevision,
      ),
      allowedUserIds,
      deleted: accessChanged ? notification.deleted : prior.deleted,
      revision: Math.max(prior.revision, notification.revision),
    };
    if (
      next.accessRevision !== prior.accessRevision ||
      next.deleted !== prior.deleted ||
      next.revision !== prior.revision ||
      !sameIds(next.allowedUserIds ?? [], prior.allowedUserIds ?? [])
    ) {
      await this.ctx.storage.put(ROOM_STATE_KEY, next);
      this.room = next;
    }
    const allowed = new Set(next.allowedUserIds ?? []);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(socket);
      if (!attachment || next.deleted || !allowed.has(attachment.userId)) {
        try {
          socket.send(JSON.stringify(wireMessage(
            next,
            next.deleted ? "deleted" : "access",
          )));
          socket.close(
            next.deleted
              ? LIVE_CLOSE_WORKSPACE_DELETED
              : LIVE_CLOSE_ACCESS_REVOKED,
            next.deleted
              ? "Workspace deleted"
              : "Workspace access revoked",
          );
        } catch {
          socket.close(LIVE_CLOSE_INVALID_MESSAGE, "Invalid live connection");
        }
        continue;
      }
      if (
        !accessChanged &&
        notification.sourceConnectionId === attachment.connectionId
      ) {
        continue;
      }
      try {
        socket.send(JSON.stringify(wireMessage(
          next,
          accessChanged ? "access" : "change",
        )));
      } catch {
        socket.close(LIVE_CLOSE_INVALID_MESSAGE, "Live delivery failed");
      }
    }
    return new Response(null, { status: 204 });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/connect" && request.method === "GET") {
      return this.acceptConnection(request);
    }
    if (path === "/publish" && request.method === "POST") {
      return this.publish(request);
    }
    return responseProblem("NOT_FOUND", "Route not found", 404);
  }

  webSocketMessage(socket: WebSocket): void {
    socket.close(
      LIVE_CLOSE_INVALID_MESSAGE,
      "Client messages are not supported",
    );
  }

  webSocketClose(): void {}

  webSocketError(): void {}
}

async function connect(
  request: Request,
  env: LiveRelayEnv,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return responseProblem(
      "UPGRADE_REQUIRED",
      "A WebSocket upgrade is required",
      426,
    );
  }
  const protocols = offeredProtocols(request);
  const authorization = protocols.find(protocol =>
    protocol.startsWith(LIVE_AUTH_SUBPROTOCOL_PREFIX)
  );
  if (!protocols.includes(LIVE_SUBPROTOCOL) || !authorization) {
    return responseProblem(
      "AUTHENTICATION_REQUIRED",
      "A live collaboration capability is required",
      401,
    );
  }
  const origin = request.headers.get("origin");
  if (!origin) {
    return responseProblem(
      "AUTHENTICATION_REQUIRED",
      "The live collaboration origin is required",
      401,
    );
  }
  let capability;
  try {
    capability = await verifyLiveCapability(
      authorization.slice(LIVE_AUTH_SUBPROTOCOL_PREFIX.length),
      env.LIVE_RELAY_SECRET,
      { origin },
    );
  } catch {
    return responseProblem(
      "AUTHENTICATION_REQUIRED",
      "The live collaboration capability is invalid",
      401,
    );
  }
  const id = env.WORKSPACES.idFromName(capability.workspaceId);
  return env.WORKSPACES.get(id).fetch(
    new Request("https://workspace.internal/connect", {
      headers: {
        [INTERNAL_ACCESS_REVISION_HEADER]: String(
          capability.accessRevision,
        ),
        [INTERNAL_CONNECTION_ID_HEADER]: capability.connectionId,
        [INTERNAL_REVISION_HEADER]: String(capability.revision),
        [INTERNAL_USER_ID_HEADER]: capability.userId,
        upgrade: "websocket",
      },
    }),
  );
}

async function publish(
  request: Request,
  env: LiveRelayEnv,
): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    Number(contentLength) > LIVE_RELAY_REQUEST_MAX_BYTES
  ) {
    return responseProblem(
      "BODY_TOO_LARGE",
      "Live relay request body is too large",
      413,
    );
  }
  const body = await request.text();
  if (liveBodyBytes(body) > LIVE_RELAY_REQUEST_MAX_BYTES) {
    return responseProblem(
      "BODY_TOO_LARGE",
      "Live relay request body is too large",
      413,
    );
  }
  try {
    await verifyLiveRelayRequest(
      body,
      request.headers.get(LIVE_RELAY_TIMESTAMP_HEADER) ?? "",
      request.headers.get(LIVE_RELAY_SIGNATURE_HEADER) ?? "",
      env.LIVE_RELAY_SECRET,
    );
  } catch {
    return responseProblem(
      "AUTHENTICATION_REQUIRED",
      "The live relay signature is invalid",
      401,
    );
  }
  let notification: LiveNotification;
  try {
    notification = parseLiveNotification(JSON.parse(body) as unknown);
  } catch (error) {
    return responseProblem(
      "INVALID_REQUEST",
      error instanceof Error
        ? error.message
        : "Live workspace notification is invalid",
      400,
    );
  }
  const id = env.WORKSPACES.idFromName(notification.workspaceId);
  return env.WORKSPACES.get(id).fetch(
    new Request("https://workspace.internal/publish", {
      body: JSON.stringify(notification),
      headers: {
        "content-type": "application/json",
        [INTERNAL_WORKSPACE_ID_HEADER]: notification.workspaceId,
      },
      method: "POST",
    }),
  );
}

const worker = {
  async fetch(request: Request, env: LiveRelayEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return Response.json({ ok: true });
    }
    if (path === "/v1/connect" && request.method === "GET") {
      return connect(request, env);
    }
    if (path === "/v1/publish" && request.method === "POST") {
      return publish(request, env);
    }
    return responseProblem("NOT_FOUND", "Route not found", 404);
  },
};

export default worker;
