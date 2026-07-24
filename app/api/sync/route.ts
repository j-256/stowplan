import { D1SnapshotStore } from "../../../src/adapters/d1-snapshot-store";
import { DomainError } from "../../../src/domain/errors";
import { validateImportSnapshot } from "../../../src/domain/import";
import type { CommandEnvelope, WorkspaceState } from "../../../src/domain/types";
import { authenticate, canOwnWorkspace, canReadWorkspace, canWriteWorkspace, claimWorkspace, isTrustedMutation } from "../../../src/server/auth";
import { readJsonRequest, RequestBodyTooLargeError, SYNC_REQUEST_MAX_BYTES } from "../../../src/server/request-body";
import { runtimeEnv } from "../../../src/server/runtime";
import { synchronize, WorkspaceNotFoundError } from "../../../src/server/sync-service";

export async function POST(request: Request) {
  try {
    const env = await runtimeEnv();
    if (!isTrustedMutation(request, env.AUTH_BASE_URL)) return Response.json({ error: "Cross-origin mutation denied" }, { status: 403 });
    if (!env.DB) return Response.json({ error: "Durable storage is not configured" }, { status: 503 });
    const user = await authenticate(env.DB, request);
    if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
    const parsed = await readJsonRequest<unknown>(
      request,
      SYNC_REQUEST_MAX_BYTES,
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "Invalid sync request" }, { status: 400 });
    }
    const body = parsed as { workspaceId?: string; commands?: CommandEnvelope[]; snapshot?: WorkspaceState };
    if (!body.workspaceId || !Array.isArray(body.commands)) return Response.json({ error: "Invalid sync request" }, { status: 400 });
    if (
      body.commands.some(
        (envelope) =>
          !envelope ||
          typeof envelope !== "object" ||
          envelope.workspaceId !== body.workspaceId,
      )
    ) {
      return Response.json(
        { error: "Every command must belong to the requested workspace" },
        { status: 400 },
      );
    }

    const store = new D1SnapshotStore(env.DB);
    const current = await store.load(body.workspaceId);
    if (!current) {
      if (!body.snapshot || body.snapshot.workspace?.id !== body.workspaceId) return Response.json({ error: "Initial snapshot is required" }, { status: 400 });
      const issues = validateImportSnapshot(body.snapshot).filter(candidate => candidate.severity === "error");
      if (issues.length) return Response.json({ error: "Initial snapshot is invalid", issues }, { status: 400 });
      const initialized = await store.initialize(body.snapshot);
      if (initialized === "created") {
        try {
          await claimWorkspace(env.DB, user.userId, body.workspaceId);
          if (!await canOwnWorkspace(env.DB, user.userId, body.workspaceId)) {
            throw new Error("The new workspace owner membership could not be recorded");
          }
        } catch (error) {
          await store.deleteIfUnclaimed(
            body.workspaceId,
            body.snapshot.workspace.revision,
          );
          throw error;
        }
      }
      else {
        const authorized = body.commands.length
          ? await canWriteWorkspace(env.DB, user.userId, body.workspaceId)
          : await canReadWorkspace(env.DB, user.userId, body.workspaceId);
        if (!authorized) {
          return Response.json(
            { error: "Workspace access denied" },
            { status: 403 },
          );
        }
      }
    } else {
      const authorized = body.commands.length
        ? await canWriteWorkspace(env.DB, user.userId, body.workspaceId)
        : await canReadWorkspace(env.DB, user.userId, body.workspaceId);
      if (!authorized) return Response.json({ error: "Workspace access denied" }, { status: 403 });
    }
    const result = await synchronize(store, body.workspaceId, body.commands);
    return Response.json({ receipts: result.receipts, state: result.snapshot }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return Response.json({ error: error.message }, { status: 404 });
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError || error instanceof DomainError) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid sync request" },
        { status: 400 },
      );
    }
    const busy = error instanceof Error && error.message.includes("remained busy");
    return Response.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: busy ? 409 : 500 },
    );
  }
}
