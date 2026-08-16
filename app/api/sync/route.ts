import {
  D1SnapshotStore,
  type AuthorizedWorkspaceSnapshot,
  type WorkspaceAuthorizationState,
} from "../../../src/adapters/d1-snapshot-store";
import { DomainError } from "../../../src/domain/errors";
import {
  normalizeWorkspaceState,
  validateImportSnapshot,
} from "../../../src/domain/import";
import type {
  CommandAuthorizationBasis,
  CommandEnvelope,
  SyncReceipt,
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
  apiProblemRetryAfter,
  apiProblemResponse,
  internalProblemResponse,
  privateJson,
} from "../../../src/server/api-problem";
import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
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
  SYNC_REQUEST_MAX_BYTES,
} from "../../../src/server/request-body";
import { runtimeEnv } from "../../../src/server/runtime";
import {
  synchronize,
  WorkspaceNotFoundError,
  WorkspaceSyncAuthorizationError,
} from "../../../src/server/sync-service";
import {
  initializeOwnedWorkspace,
} from "../../../src/server/workspace-initialization";
import {
  liveConnectionIdFromRequest,
  notifyWorkspaceChange,
} from "../../../src/server/live-notifications";
import { API_QUOTAS } from "../../../src/shared/api-quotas";

interface SyncBody {
  commands?: CommandEnvelope[];
  snapshot?: WorkspaceState;
  workspaceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function authorizationBasis(
  value: unknown,
): CommandAuthorizationBasis {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.membershipRevision) ||
    (value.membershipRevision as number) < 0 ||
    !Number.isSafeInteger(value.workspaceAccessRevision) ||
    (value.workspaceAccessRevision as number) < 0
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Command authorization revisions must be non-negative safe integers",
      400,
    );
  }
  return {
    membershipRevision: value.membershipRevision as number,
    workspaceAccessRevision: value.workspaceAccessRevision as number,
  };
}

function commonAuthorizationBasis(
  commands: CommandEnvelope[],
  current: AuthorizedWorkspaceSnapshot,
): CommandAuthorizationBasis {
  const explicit = commands.filter(
    command => command.authorization !== undefined,
  );
  if (explicit.length !== 0 && explicit.length !== commands.length) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "A sync batch cannot mix legacy and authorization-aware commands",
      400,
    );
  }
  if (explicit.length === 0) {
    return {
      membershipRevision: current.membershipRevision,
      workspaceAccessRevision: current.accessRevision,
    };
  }
  const first = authorizationBasis(explicit[0]?.authorization);
  for (const command of explicit.slice(1)) {
    const candidate = authorizationBasis(command.authorization);
    if (
      candidate.membershipRevision !== first.membershipRevision ||
      candidate.workspaceAccessRevision !== first.workspaceAccessRevision
    ) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Every command in a sync batch must use the same authorization basis",
        400,
      );
    }
  }
  return first;
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
  authorization: WorkspaceAuthorizationState | null,
  checkedAt: string,
): WorkspaceAccessState {
  const status = authorization?.deleted
    ? "deleted"
    : authorization?.role
      ? authorization.active
        ? "active"
        : "unknown"
      : "revoked";
  return {
    accessRevision: authorization?.accessRevision ?? 0,
    capabilities: {
      delete: false,
      leave: false,
      manageAccess: false,
      read: Boolean(
        authorization?.active &&
        authorization.role &&
        !authorization.deleted,
      ),
      write: false,
    },
    checkedAt,
    kind: "server",
    membershipRevision: authorization?.membershipRevision ?? 0,
    role: authorization?.role ?? null,
    status,
  };
}

function rejectedReceipts(
  commands: CommandEnvelope[],
  revision: number,
  message: string,
): SyncReceipt[] {
  return commands.map((command, index) => ({
    commandId: typeof command.id === "string" && command.id
      ? command.id
      : `invalid-command-${index + 1}`,
    message,
    revision,
    status: "rejected",
  }));
}

function authorizationProblem(
  error: WorkspaceSyncAuthorizationError,
  previous: AuthorizedWorkspaceSnapshot,
): Response {
  const checkedAt = new Date().toISOString();
  const authorization = refusedAccess(error.authorization, checkedAt);
  const detail: Record<string, unknown> = {
    authorization,
    receipts: error.receipts,
  };
  if (
    error.authorization?.active &&
    !error.authorization.deleted &&
    error.authorization.role
  ) {
    detail.workspace = workspaceSummary({
      accessRevision: error.authorization.accessRevision ?? 0,
      membershipRevision: error.authorization.membershipRevision,
      ownerCount: previous.ownerCount,
      role: error.authorization.role,
      state: previous.state,
      updatedAt: previous.updatedAt,
    });
  }
  const problem = error.failure === "deleted"
    ? new ApiProblem(
        "WORKSPACE_DELETED",
        error.message,
        410,
        detail,
      )
    : error.failure === "inactive"
      ? new ApiProblem(
          "AUTHENTICATION_REQUIRED",
          error.message,
          401,
          detail,
        )
      : error.failure === "revoked"
        ? new ApiProblem(
            "MEMBERSHIP_REQUIRED",
            error.message,
            403,
            detail,
          )
        : error.failure === "write"
          ? new ApiProblem(
              "WRITE_ACCESS_REQUIRED",
              error.message,
              403,
              detail,
            )
          : new ApiProblem(
              "ACCESS_STALE",
              error.message,
              409,
              detail,
            );
  return apiProblemResponse(problem);
}

function syncErrorResponse(error: unknown): Response {
  if (error instanceof ApiProblem) {
    const response = apiProblemResponse(error);
    if (error.status === 429 || error.status === 503) {
      response.headers.set(
        "retry-after",
        apiProblemRetryAfter(error),
      );
    }
    return response;
  }
  if (error instanceof QuotaExceededError) {
    return privateJson(quotaProblem(error), { status: error.status });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return apiProblemResponse(
      new ApiProblem("BODY_TOO_LARGE", error.message, error.status),
    );
  }
  if (error instanceof WorkspaceNotFoundError) {
    return apiProblemResponse(
      new ApiProblem(
        "NOT_FOUND_OR_INACCESSIBLE",
        "Workspace was not found or is inaccessible",
        404,
      ),
    );
  }
  if (error instanceof SyntaxError) {
    return apiProblemResponse(
      new ApiProblem("INVALID_REQUEST", "The JSON body is invalid", 400),
    );
  }
  if (error instanceof DomainError) {
    return apiProblemResponse(
      new ApiProblem("INVALID_REQUEST", error.message, 400),
    );
  }
  const busy = error instanceof Error &&
    error.message.includes("remained busy");
  if (busy) {
    return apiProblemResponse(
      new ApiProblem(
        "WORKSPACE_BUSY",
        "Workspace changed repeatedly; retry synchronization",
        409,
      ),
    );
  }
  return internalProblemResponse("Sync could not be completed");
}

export async function POST(request: Request) {
  let priorAuthorized: AuthorizedWorkspaceSnapshot | null = null;
  let responseAccountId: string | null = null;
  try {
    const env = await runtimeEnv();
    if (!isTrustedMutation(request, env.AUTH_BASE_URL)) {
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
    responseAccountId = user.userId;
    requireExpectedAccount(request, user.userId);
    const parsed = await readJsonRequest<unknown>(
      request,
      SYNC_REQUEST_MAX_BYTES,
    );
    if (!isRecord(parsed)) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "The sync request must be a JSON object",
        400,
      );
    }
    const body = parsed as SyncBody;
    if (
      typeof body.workspaceId !== "string" ||
      !body.workspaceId ||
      !Array.isArray(body.commands)
    ) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "workspaceId and commands are required",
        400,
      );
    }
    if (
      body.commands.some(
        envelope =>
          !isRecord(envelope) ||
          envelope.workspaceId !== body.workspaceId,
      )
    ) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Every command must belong to the requested workspace",
        400,
      );
    }
    if (body.commands.length > API_QUOTAS.commandsPerSyncRequest) {
      throw new QuotaExceededError(
        "commandsPerSyncRequest",
        body.commands.length,
        413,
      );
    }

    const store = new D1SnapshotStore(env.DB);
    priorAuthorized = await store.loadAuthorized(
      body.workspaceId,
      user.userId,
    );
    if (!priorAuthorized) {
      if (
        !body.snapshot ||
        body.snapshot.workspace?.id !== body.workspaceId
      ) {
        throw new ApiProblem(
          "INVALID_REQUEST",
          "A matching initial snapshot is required",
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
          "Initial snapshot is invalid",
          400,
          { issues },
        );
      }
      const initialSnapshot = normalizeWorkspaceState(
        structuredClone(body.snapshot),
      );
      assertSnapshotWithinQuotas(initialSnapshot, { status: 413 });
      const initialized = await initializeOwnedWorkspace(
        env.DB,
        user.userId,
        initialSnapshot,
      );
      if (initialized.status === "quota") {
        throw new QuotaExceededError(
          "ownedWorkspacesPerUser",
          initialized.ownerCount + 1,
        );
      }
      if (initialized.status === "inactive") {
        throw new ApiProblem(
          "AUTHENTICATION_REQUIRED",
          "The signed-in account is no longer active",
          401,
        );
      }
      priorAuthorized = await store.loadAuthorized(
        body.workspaceId,
        user.userId,
      );
      if (!priorAuthorized) {
        throw new ApiProblem(
          "NOT_FOUND_OR_INACCESSIBLE",
          "Workspace was not found or is inaccessible",
          404,
        );
      }
    }

    const basis = commonAuthorizationBasis(
      body.commands,
      priorAuthorized,
    );
    const commands = body.commands.map(envelope => ({
      ...envelope,
      actorId: user.userId,
      authorization: basis,
    }));
    if (
      commands.length &&
      priorAuthorized.role === "viewer"
    ) {
      const message =
        "Viewer access does not allow workspace changes";
      throw new ApiProblem(
        "WRITE_ACCESS_REQUIRED",
        message,
        403,
        {
          authorization: workspaceAccess(
            priorAuthorized,
            new Date().toISOString(),
          ),
          receipts: rejectedReceipts(
            commands,
            priorAuthorized.state.workspace.revision,
            message,
          ),
          workspace: workspaceSummary(priorAuthorized),
        },
      );
    }
    let result;
    try {
      result = await synchronize(
        store,
        body.workspaceId,
        commands,
        {
          authorization: {
            basis,
            userId: user.userId,
          },
        },
      );
    } catch (error) {
      if (error instanceof WorkspaceSyncAuthorizationError) {
        const refreshed = error.authorization?.active &&
            !error.authorization.deleted &&
            error.authorization.role
          ? await store.loadAuthorized(
              body.workspaceId,
              user.userId,
            )
          : null;
        return withAccountContext(authorizationProblem(
          error,
          refreshed ?? priorAuthorized,
        ), user.userId);
      }
      throw error;
    }
    const latestAuthorized = await store.loadAuthorized(
      body.workspaceId,
      user.userId,
    );
    if (!latestAuthorized) {
      const latestAuthorization = await store.loadAuthorization(
        body.workspaceId,
        user.userId,
      );
      const failure = !latestAuthorization?.active
        ? "inactive"
        : latestAuthorization.deleted
          ? "deleted"
          : "revoked";
      const message = failure === "inactive"
        ? "The signed-in account is no longer active"
        : failure === "deleted"
          ? "The server workspace was deleted"
          : "Workspace access was removed";
      return withAccountContext(authorizationProblem(
        new WorkspaceSyncAuthorizationError(
          failure,
          message,
          result.receipts,
          result.snapshot.workspace.revision,
          latestAuthorization,
        ),
        {
          ...priorAuthorized,
          state: result.snapshot,
        },
      ), user.userId);
    }
    const checkedAt = new Date().toISOString();
    await notifyWorkspaceChange(env.DB, body.workspaceId, {
      environment: env,
      previousRevision: priorAuthorized.state.workspace.revision,
      sourceConnectionId: liveConnectionIdFromRequest(request),
    });
    return accountScopedJson({
      authorization: workspaceAccess(latestAuthorized, checkedAt),
      receipts: result.receipts,
      state: latestAuthorized.state,
      workspace: workspaceSummary(latestAuthorized),
    }, user.userId);
  } catch (error) {
    if (
      error instanceof WorkspaceSyncAuthorizationError &&
      priorAuthorized
    ) {
      return withAccountContext(
        authorizationProblem(error, priorAuthorized),
        responseAccountId,
      );
    }
    return withAccountContext(
      syncErrorResponse(error),
      responseAccountId,
    );
  }
}
