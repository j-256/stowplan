import { D1SnapshotStore } from "../../../../src/adapters/d1-snapshot-store";
import { ApiProblem } from "../../../../src/server/api-problem";
import {
  liveTransport,
  subscribeLocalLiveWorkspace,
} from "../../../../src/server/live-notifications";
import { runtimeEnv } from "../../../../src/server/runtime";
import { ACCOUNT_CONTEXT_HEADER } from "../../../../src/shared/account-context";
import {
  LIVE_PROTOCOL_VERSION,
  normalizeLiveConnectionId,
  type LiveWireMessage,
} from "../../../../src/shared/live-collaboration";
import {
  requireWorkspacePrincipal,
  workspaceAccessErrorResponse,
} from "../../../../src/server/workspace-access";

const SSE_HEARTBEAT_INTERVAL_MS = 25_000;

function liveEvent(message: LiveWireMessage): Uint8Array {
  return new TextEncoder().encode(
    `event: live\ndata: ${JSON.stringify(message)}\n\n`,
  );
}

export async function GET(request: Request) {
  try {
    const principal = await requireWorkspacePrincipal(request);
    const transport = liveTransport(await runtimeEnv());
    if (transport.kind !== "local") {
      throw new ApiProblem(
        "NOT_FOUND_OR_INACCESSIBLE",
        "Local live collaboration is unavailable",
        404,
      );
    }
    const searchParams = new URL(request.url).searchParams;
    const workspaceId = searchParams.get("workspaceId");
    const connectionId = normalizeLiveConnectionId(
      searchParams.get("connectionId"),
    );
    if (!workspaceId || workspaceId.trim() !== workspaceId || !connectionId) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Valid workspaceId and connectionId values are required",
        400,
      );
    }
    const store = new D1SnapshotStore(principal.database);
    const authorized = await store.loadAuthorized(
      workspaceId,
      principal.user.userId,
    );
    if (!authorized) {
      throw new ApiProblem(
        "NOT_FOUND_OR_INACCESSIBLE",
        "Workspace was not found or is inaccessible",
        404,
      );
    }

    let dispose = () => {};
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const timers: {
          heartbeat?: ReturnType<typeof setInterval>;
        } = {};
        let unsubscribe = () => {};
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (timers.heartbeat) clearInterval(timers.heartbeat);
          unsubscribe();
          request.signal.removeEventListener("abort", close);
        };
        const close = () => {
          if (closed) return;
          cleanup();
          try {
            controller.close();
          } catch {}
        };
        const send = (message: LiveWireMessage) => {
          if (closed) return;
          try {
            controller.enqueue(liveEvent(message));
          } catch {
            cleanup();
          }
        };
        unsubscribe = subscribeLocalLiveWorkspace({
          accessRevision: authorized.accessRevision,
          connectionId,
          userId: principal.user.userId,
          workspaceId,
        }, { close, send });
        dispose = close;
        request.signal.addEventListener("abort", close, { once: true });
        const latest = await store.loadAuthorized(
          workspaceId,
          principal.user.userId,
        );
        if (!latest) {
          send({
            accessRevision: authorized.accessRevision,
            revision: authorized.state.workspace.revision,
            type: "access",
            version: LIVE_PROTOCOL_VERSION,
          });
          close();
          return;
        }
        send({
          accessRevision: latest.accessRevision,
          revision: latest.state.workspace.revision,
          type: "ready",
          version: LIVE_PROTOCOL_VERSION,
        });
        timers.heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          } catch {
            cleanup();
          }
        }, SSE_HEARTBEAT_INTERVAL_MS);
      },
      cancel() {
        dispose();
      },
    });
    return new Response(body, {
      headers: {
        [ACCOUNT_CONTEXT_HEADER]: principal.user.userId,
        "cache-control": "no-cache, no-store",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
