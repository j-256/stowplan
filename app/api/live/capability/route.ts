import { D1SnapshotStore } from "../../../../src/adapters/d1-snapshot-store";
import { accountScopedJson } from "../../../../src/server/account-context";
import { ApiProblem } from "../../../../src/server/api-problem";
import {
  liveTransport,
} from "../../../../src/server/live-notifications";
import { runtimeEnv } from "../../../../src/server/runtime";
import {
  LIVE_AUTH_SUBPROTOCOL_PREFIX,
  LIVE_CAPABILITY_TTL_MS,
  LIVE_SUBPROTOCOL,
  normalizeLiveConnectionId,
  signLiveCapability,
} from "../../../../src/shared/live-collaboration";
import {
  requireWorkspacePrincipal,
  workspaceAccessErrorResponse,
} from "../../../../src/server/workspace-access";

function requiredWorkspaceId(value: string | null): string {
  if (!value || value.trim() !== value) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "A valid workspaceId is required",
      400,
    );
  }
  return value;
}

function requiredConnectionId(value: string | null): string {
  const connectionId = normalizeLiveConnectionId(value);
  if (!connectionId) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "A valid connectionId is required",
      400,
    );
  }
  return connectionId;
}

export async function GET(request: Request) {
  try {
    const principal = await requireWorkspacePrincipal(request);
    const requestUrl = new URL(request.url);
    const workspaceId = requiredWorkspaceId(
      requestUrl.searchParams.get("workspaceId"),
    );
    const connectionId = requiredConnectionId(
      requestUrl.searchParams.get("connectionId"),
    );
    const authorized = await new D1SnapshotStore(
      principal.database,
    ).loadAuthorized(workspaceId, principal.user.userId);
    if (!authorized) {
      throw new ApiProblem(
        "NOT_FOUND_OR_INACCESSIBLE",
        "Workspace was not found or is inaccessible",
        404,
      );
    }
    let transport;
    try {
      transport = liveTransport(await runtimeEnv());
    } catch {
      throw new ApiProblem(
        "STORAGE_UNAVAILABLE",
        "Live collaboration is not configured correctly",
        503,
      );
    }
    const common = {
      accessRevision: authorized.accessRevision,
      revision: authorized.state.workspace.revision,
    };
    if (transport.kind === "unavailable") {
      return accountScopedJson({
        ...common,
        transport: "unavailable",
      }, principal.user.userId);
    }
    if (transport.kind === "local") {
      const endpoint = new URLSearchParams({
        connectionId,
        workspaceId,
      });
      return accountScopedJson({
        ...common,
        endpoint: `/api/live/events?${endpoint}`,
        transport: "sse",
      }, principal.user.userId);
    }
    const issuedAt = Date.now();
    const token = await signLiveCapability({
      ...common,
      connectionId,
      expiresAt: issuedAt + LIVE_CAPABILITY_TTL_MS,
      issuedAt,
      origin: requestUrl.origin,
      userId: principal.user.userId,
      workspaceId,
    }, transport.secret);
    const endpoint = new URL("/v1/connect", transport.url);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return accountScopedJson({
      ...common,
      endpoint: endpoint.toString(),
      protocols: [
        LIVE_SUBPROTOCOL,
        `${LIVE_AUTH_SUBPROTOCOL_PREFIX}${token}`,
      ],
      transport: "websocket",
    }, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
