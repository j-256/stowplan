import { D1SnapshotStore } from "../../../src/adapters/d1-snapshot-store";
import {
  normalizeWorkspaceState,
  validateImportSnapshot,
} from "../../../src/domain/import";
import type { WorkspaceState } from "../../../src/domain/types";
import { audit } from "../../../src/server/admin";
import { authenticate, canOwnWorkspace, canReadWorkspace, isTrustedMutation } from "../../../src/server/auth";
import {
  assertSnapshotWithinQuotas,
  QuotaExceededError,
  quotaProblem,
} from "../../../src/server/quotas";
import { readJsonRequest, RequestBodyTooLargeError, SNAPSHOT_REQUEST_MAX_BYTES } from "../../../src/server/request-body";
import { runtimeEnv } from "../../../src/server/runtime";

export async function GET(request: Request) {
  const env = await runtimeEnv();
  if (!env.DB) return Response.json({ error: "Durable storage is not configured" }, { status: 503 });
  const user = await authenticate(env.DB, request);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId) return Response.json({ error: "workspaceId is required" }, { status: 400 });
  if (!await canReadWorkspace(env.DB, user.userId, workspaceId)) {
    return Response.json({ error: "Workspace access denied" }, { status: 403 });
  }
  const state = await new D1SnapshotStore(env.DB).load(workspaceId);
  if (!state) return Response.json({ error: "Workspace was not found" }, { status: 404 });
  return Response.json({ state }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: Request) {
  try {
    const env = await runtimeEnv();
    if (!isTrustedMutation(request, env.AUTH_BASE_URL)) return Response.json({ error: "Cross-origin mutation denied" }, { status: 403 });
    if (!env.DB) return Response.json({ error: "Durable storage is not configured" }, { status: 503 });
    const user = await authenticate(env.DB, request);
    if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
    const body = await readJsonRequest<{
      expectedRevision?: number;
      snapshot?: WorkspaceState;
      workspaceId?: string;
    }>(request, SNAPSHOT_REQUEST_MAX_BYTES);
    if (!body.workspaceId || !body.snapshot || body.snapshot.workspace?.id !== body.workspaceId || !Number.isSafeInteger(body.expectedRevision)) {
      return Response.json({ error: "workspaceId, expectedRevision, and a matching snapshot are required" }, { status: 400 });
    }
    if (!await canOwnWorkspace(env.DB, user.userId, body.workspaceId)) return Response.json({ error: "Workspace owner access required" }, { status: 403 });
    assertSnapshotWithinQuotas(body.snapshot, { status: 413 });
    const issues = validateImportSnapshot(body.snapshot).filter(candidate => candidate.severity === "error");
    if (issues.length) return Response.json({ error: "Backup is invalid", issues }, { status: 400 });
    const store = new D1SnapshotStore(env.DB);
    const current = await store.load(body.workspaceId);
    if (!current) return Response.json({ error: "Workspace was not found" }, { status: 404 });
    if (current.workspace.revision !== body.expectedRevision) return Response.json({ error: "Server workspace changed; load it again before restoring", currentRevision: current.workspace.revision }, { status: 409 });
    if (current.workspace.revision >= Number.MAX_SAFE_INTEGER) {
      return Response.json({ error: "Server workspace revision counter is exhausted" }, { status: 409 });
    }
    const state = normalizeWorkspaceState(structuredClone(body.snapshot));
    state.workspace.revision = current.workspace.revision + 1;
    state.workspace.updatedAt = new Date().toISOString();
    assertSnapshotWithinQuotas(state, { status: 413 });
    if (!await store.replace(body.workspaceId, current.workspace.revision, state)) return Response.json({ error: "Server workspace changed during restore; retry the preview" }, { status: 409 });
    let auditRecorded = true;
    try {
      await audit(env.DB, user.userId, "snapshot.restore", "workspace", body.workspaceId, { fromRevision: body.snapshot.workspace.revision, toRevision: state.workspace.revision, items: state.items.length, locations: state.locations.length, plans: state.plans.length });
    } catch {
      auditRecorded = false;
    }
    return Response.json({ auditRecorded, state }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return Response.json(quotaProblem(error), { status: error.status });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not restore backup" },
      {
        status: error instanceof RequestBodyTooLargeError
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : 500,
      },
    );
  }
}
