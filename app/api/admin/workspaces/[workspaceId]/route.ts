import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
} from "../../../../../src/server/account-context";
import {
  deleteAdminWorkspace,
  inspectAdminWorkspace,
  takeAdminWorkspaceOwnership,
} from "../../../../../src/server/admin-workspace";
import {
  ApiProblem,
  apiProblemResponse,
  privateJson,
} from "../../../../../src/server/api-problem";
import {
  AuthorizationError,
  authorizeAdmin,
  isTrustedMutation,
} from "../../../../../src/server/auth";
import {
  QuotaExceededError,
  quotaProblem,
} from "../../../../../src/server/quotas";
import {
  readJsonRequest,
  RequestBodyTooLargeError,
  WORKSPACE_ACCESS_REQUEST_MAX_BYTES,
} from "../../../../../src/server/request-body";
import { runtimeEnv } from "../../../../../src/server/runtime";

function adminWorkspaceErrorResponse(
  error: unknown,
  accountId: string | null,
  fallback: string,
): Response {
  if (error instanceof ApiProblem) {
    return withAccountContext(apiProblemResponse(error), accountId);
  }
  if (error instanceof RequestBodyTooLargeError) {
    return withAccountContext(
      apiProblemResponse(
        new ApiProblem(
          "BODY_TOO_LARGE",
          error.message,
          error.status,
        ),
      ),
      accountId,
    );
  }
  if (error instanceof QuotaExceededError) {
    return withAccountContext(
      privateJson(quotaProblem(error), { status: error.status }),
      accountId,
    );
  }
  if (error instanceof SyntaxError) {
    return withAccountContext(
      apiProblemResponse(
        new ApiProblem(
          "INVALID_REQUEST",
          "The workspace control JSON body is invalid",
          400,
        ),
      ),
      accountId,
    );
  }
  if (error instanceof AuthorizationError) {
    return withAccountContext(
      privateJson(
        {
          code: error.status === 401
            ? "AUTHENTICATION_REQUIRED"
            : "ADMIN_REQUIRED",
          error: error.message,
        },
        { status: error.status },
      ),
      accountId,
    );
  }
  return withAccountContext(
    privateJson(
      {
        code: "INTERNAL_ERROR",
        error: fallback,
      },
      { status: 500 },
    ),
    accountId,
  );
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
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
        "Database is not configured",
        503,
      );
    }
    const user = await authorizeAdmin(env.DB, env, request);
    responseAccountId = user.userId;
    requireExpectedAccount(request, user.userId);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Content-Type must be application/json",
        415,
      );
    }
    const result = await deleteAdminWorkspace(
      env.DB,
      user.userId,
      (await params).workspaceId,
      await readJsonRequest<unknown>(
        request,
        WORKSPACE_ACCESS_REQUEST_MAX_BYTES,
      ),
    );
    return accountScopedJson(result, user.userId);
  } catch (error) {
    return adminWorkspaceErrorResponse(
      error,
      responseAccountId,
      "Could not delete the workspace",
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
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
        "Database is not configured",
        503,
      );
    }
    const user = await authorizeAdmin(env.DB, env, request);
    responseAccountId = user.userId;
    requireExpectedAccount(request, user.userId);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Content-Type must be application/json",
        415,
      );
    }
    const body = await readJsonRequest<unknown>(
      request,
      WORKSPACE_ACCESS_REQUEST_MAX_BYTES,
    );
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "The request body must be a JSON object",
        400,
      );
    }
    const workspaceId = (await params).workspaceId;
    const result = "action" in body && body.action === "inspect"
      ? await inspectAdminWorkspace(
          env.DB,
          user.userId,
          workspaceId,
        )
      : "action" in body && body.action === "takeOwnership"
        ? await takeAdminWorkspaceOwnership(
            env.DB,
            user.userId,
            workspaceId,
            body,
          )
        : null;
    if (!result) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "action must be inspect or takeOwnership",
        400,
      );
    }
    return accountScopedJson(result, user.userId);
  } catch (error) {
    return adminWorkspaceErrorResponse(
      error,
      responseAccountId,
      "Could not complete the workspace control action",
    );
  }
}
