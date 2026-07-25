import {
  D1SnapshotStore,
  type AuthorizedWorkspaceSnapshot,
  type WorkspaceAuthorizationState,
} from "../../../src/adapters/d1-snapshot-store";
import {
  normalizeWorkspaceState,
  validateImportSnapshot,
} from "../../../src/domain/import";
import type {
  CommandAuthorizationBasis,
  WorkspaceState,
} from "../../../src/domain/types";
import {
  capabilitiesForWorkspaceRole,
  serverWorkspaceAccess,
  type ServerWorkspaceSummary,
  type WorkspaceAccessState,
} from "../../../src/domain/workspace-access";
import {
  ApiProblem,
  apiProblemResponse,
  internalProblemResponse,
  privateJson,
} from "../../../src/server/api-problem";
import {
  accountScopedJson,
  requireExpectedAccount,
} from "../../../src/server/account-context";
import {
  authenticate,
  isTrustedMutation,
} from "../../../src/server/auth";
import {
  assertSnapshotWithinQuotas,
  QuotaExceededError,
  quotaProblem,
} from "../../../src/server/quotas";
import {
  readJsonRequest,
  RequestBodyTooLargeError,
  SNAPSHOT_REQUEST_MAX_BYTES,
} from "../../../src/server/request-body";
import { runtimeEnv } from "../../../src/server/runtime";
import {
  restoreOwnedWorkspace,
  type WorkspaceRestoreResult,
} from "../../../src/server/workspace-initialization";

interface SnapshotRestoreBody {
  authorization?: CommandAuthorizationBasis;
  expectedRevision?: number;
  snapshot?: WorkspaceState;
  workspaceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function workspaceSummary(
  authorized: AuthorizedWorkspaceSnapshot,
): ServerWorkspaceSummary {
  return {
    accessRevision: authorized.accessRevision,
    capabilities: capabilitiesForWorkspaceRole(
      authorized.role,
      authorized.role !== "owner" || authorized.ownerCount > 1,
    ),
    id: authorized.state.workspace.id,
    membershipRevision: authorized.membershipRevision,
    name: authorized.state.workspace.name,
    revision: authorized.state.workspace.revision,
    role: authorized.role,
    updatedAt: authorized.updatedAt,
  };
}

function workspaceAccess(
  authorized: AuthorizedWorkspaceSnapshot,
  checkedAt: string,
): WorkspaceAccessState {
  return serverWorkspaceAccess(authorized.role, {
    accessRevision: authorized.accessRevision,
    canLeave:
      authorized.role !== "owner" || authorized.ownerCount > 1,
    checkedAt,
    membershipRevision: authorized.membershipRevision,
  });
}

function refusedAccess(
  authorization: WorkspaceAuthorizationState,
  checkedAt: string,
): WorkspaceAccessState {
  const status = authorization.deleted
    ? "deleted"
    : authorization.role
      ? authorization.active
        ? "active"
        : "unknown"
      : "revoked";
  return {
    accessRevision: authorization.accessRevision ?? 0,
    capabilities: {
      delete: false,
      leave: false,
      manageAccess: false,
      read: Boolean(
        authorization.active &&
        authorization.role &&
        !authorization.deleted,
      ),
      write: false,
    },
    checkedAt,
    kind: "server",
    membershipRevision: authorization.membershipRevision,
    role: authorization.role,
    status,
  };
}

function restoreAuthorization(
  result: WorkspaceRestoreResult,
): WorkspaceAuthorizationState {
  return {
    accessRevision: result.accessRevision,
    active: result.status !== "inactive",
    deleted: result.status === "deleted",
    membershipRevision: result.membershipRevision ?? 0,
    role: result.role,
  };
}

function parseAuthorizationBasis(
  value: unknown,
  current: AuthorizedWorkspaceSnapshot,
): CommandAuthorizationBasis {
  if (value === undefined) {
    return {
      membershipRevision: current.membershipRevision,
      workspaceAccessRevision: current.accessRevision,
    };
  }
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.membershipRevision) ||
    (value.membershipRevision as number) < 0 ||
    !Number.isSafeInteger(value.workspaceAccessRevision) ||
    (value.workspaceAccessRevision as number) < 0
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Authorization revisions must be non-negative safe integers",
      400,
    );
  }
  return {
    membershipRevision: value.membershipRevision as number,
    workspaceAccessRevision: value.workspaceAccessRevision as number,
  };
}

function snapshotErrorResponse(error: unknown): Response {
  if (error instanceof ApiProblem) return apiProblemResponse(error);
  if (error instanceof QuotaExceededError) {
    return privateJson(quotaProblem(error), { status: error.status });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return apiProblemResponse(
      new ApiProblem("BODY_TOO_LARGE", error.message, error.status),
    );
  }
  if (error instanceof SyntaxError) {
    return apiProblemResponse(
      new ApiProblem("INVALID_REQUEST", "The JSON body is invalid", 400),
    );
  }
  return internalProblemResponse("The snapshot request could not be completed");
}

async function requiredPrincipal(
  request: Request,
  mutation = false,
) {
  const env = await runtimeEnv();
  if (
    mutation &&
    !isTrustedMutation(request, env.AUTH_BASE_URL)
  ) {
    throw new ApiProblem(
      "CROSS_ORIGIN_DENIED",
      "Cross-origin mutation denied",
      403,
    );
  }
  if (!env.DB) {
    throw new ApiProblem(
      "STORAGE_UNAVAILABLE",
      "Durable storage is not configured",
      503,
    );
  }
  const user = await authenticate(env.DB, request);
  if (!user) {
    throw new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      "Authentication required",
      401,
    );
  }
  requireExpectedAccount(request, user.userId);
  return { database: env.DB, env, user };
}

function inaccessibleProblem(): ApiProblem {
  return new ApiProblem(
    "NOT_FOUND_OR_INACCESSIBLE",
    "Workspace was not found or is inaccessible",
    404,
  );
}

export async function GET(request: Request) {
  try {
    const { database, user } = await requiredPrincipal(request);
    const workspaceId = new URL(request.url).searchParams.get(
      "workspaceId",
    );
    if (!workspaceId) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "workspaceId is required",
        400,
      );
    }
    const authorized = await new D1SnapshotStore(
      database,
    ).loadAuthorized(workspaceId, user.userId);
    if (!authorized) throw inaccessibleProblem();
    const checkedAt = new Date().toISOString();
    return accountScopedJson({
      authorization: workspaceAccess(authorized, checkedAt),
      state: authorized.state,
      workspace: workspaceSummary(authorized),
    }, user.userId);
  } catch (error) {
    return snapshotErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { database, user } = await requiredPrincipal(request, true);
    const parsed = await readJsonRequest<unknown>(
      request,
      SNAPSHOT_REQUEST_MAX_BYTES,
    );
    if (!isRecord(parsed)) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "The restore request must be a JSON object",
        400,
      );
    }
    const body = parsed as SnapshotRestoreBody;
    if (
      typeof body.workspaceId !== "string" ||
      !body.workspaceId ||
      !body.snapshot ||
      body.snapshot.workspace?.id !== body.workspaceId ||
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 0
    ) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "workspaceId, a non-negative expectedRevision, and a matching snapshot are required",
        400,
      );
    }
    assertSnapshotWithinQuotas(body.snapshot, { status: 413 });
    const issues = validateImportSnapshot(body.snapshot).filter(
      candidate => candidate.severity === "error",
    );
    if (issues.length) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Backup is invalid",
        400,
        { issues },
      );
    }

    const store = new D1SnapshotStore(database);
    const current = await store.loadAuthorized(
      body.workspaceId,
      user.userId,
    );
    if (!current) throw inaccessibleProblem();
    const checkedAt = new Date().toISOString();
    if (current.role !== "owner") {
      throw new ApiProblem(
        "OWNER_REQUIRED",
        "Workspace owner access is required to restore a backup",
        403,
        {
          authorization: workspaceAccess(current, checkedAt),
          workspace: workspaceSummary(current),
        },
      );
    }
    const basis = parseAuthorizationBasis(
      body.authorization,
      current,
    );
    if (
      current.state.workspace.revision !== body.expectedRevision
    ) {
      throw new ApiProblem(
        "WORKSPACE_BUSY",
        "Server workspace changed; load it again before restoring",
        409,
        {
          authorization: workspaceAccess(current, checkedAt),
          currentRevision: current.state.workspace.revision,
          workspace: workspaceSummary(current),
        },
      );
    }
    if (
      current.state.workspace.revision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new ApiProblem(
        "WORKSPACE_BUSY",
        "Server workspace revision counter is exhausted",
        409,
      );
    }

    const state = normalizeWorkspaceState(
      structuredClone(body.snapshot),
    );
    state.workspace.revision =
      current.state.workspace.revision + 1;
    state.workspace.updatedAt = new Date().toISOString();
    assertSnapshotWithinQuotas(state, { status: 413 });
    const result = await restoreOwnedWorkspace(
      database,
      user.userId,
      current.state.workspace.revision,
      basis,
      state,
      body.snapshot.workspace.revision,
    );
    if (result.status === "restored") {
      if (
        result.accessRevision === null ||
        result.membershipRevision === null ||
        result.role !== "owner" ||
        !result.updatedAt
      ) {
        throw new Error(
          "Workspace restore context was incomplete",
        );
      }
      const restored: AuthorizedWorkspaceSnapshot = {
        accessRevision: result.accessRevision,
        membershipRevision: result.membershipRevision,
        ownerCount: result.ownerCount,
        role: result.role,
        state,
        updatedAt: result.updatedAt,
      };
      return accountScopedJson({
        auditRecorded: true,
        authorization: workspaceAccess(
          restored,
          new Date().toISOString(),
        ),
        state,
        workspace: workspaceSummary(restored),
      }, user.userId);
    }

    const refreshed = await store.loadAuthorized(
      body.workspaceId,
      user.userId,
    );
    const latestCheckedAt = new Date().toISOString();
    const context = refreshed
      ? {
          authorization: workspaceAccess(
            refreshed,
            latestCheckedAt,
          ),
          workspace: workspaceSummary(refreshed),
        }
      : {
          authorization: refusedAccess(
            restoreAuthorization(result),
            latestCheckedAt,
          ),
        };
    if (result.status === "inactive") {
      throw new ApiProblem(
        "AUTHENTICATION_REQUIRED",
        "The signed-in account is no longer active",
        401,
        context,
      );
    }
    if (result.status === "deleted") {
      throw new ApiProblem(
        "WORKSPACE_DELETED",
        "The server workspace was deleted",
        410,
        context,
      );
    }
    if (result.status === "inaccessible") {
      throw new ApiProblem(
        "MEMBERSHIP_REQUIRED",
        "Workspace access was removed",
        403,
        context,
      );
    }
    if (result.status === "owner-required") {
      throw new ApiProblem(
        "OWNER_REQUIRED",
        "Workspace owner access is required to restore a backup",
        403,
        context,
      );
    }
    if (result.status === "access-stale") {
      throw new ApiProblem(
        "ACCESS_STALE",
        "Workspace access changed after the restore was prepared",
        409,
        context,
      );
    }
    if (result.status === "revision-stale") {
      throw new ApiProblem(
        "WORKSPACE_BUSY",
        "Server workspace changed during restore; retry the preview",
        409,
        {
          ...context,
          currentRevision: result.revision,
        },
      );
    }
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "Workspace changed during restore; retry the preview",
      409,
      context,
    );
  } catch (error) {
    return snapshotErrorResponse(error);
  }
}
