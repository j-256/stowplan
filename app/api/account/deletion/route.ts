import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
} from "../../../../src/server/account-context";
import {
  executeAccountDeletion,
  prepareAccountDeletion,
} from "../../../../src/server/account-governance";
import {
  ApiProblem,
  apiProblemResponse,
  internalProblemResponse,
} from "../../../../src/server/api-problem";
import {
  authenticate,
  clearSessionCookie,
  identityEnforcementConfigured,
  isTrustedMutation,
} from "../../../../src/server/auth";
import { notifyWorkspaceChanges } from
  "../../../../src/server/live-notifications";
import {
  ACCOUNT_DELETION_REQUEST_MAX_BYTES,
  readJsonRequest,
  RequestBodyTooLargeError,
} from "../../../../src/server/request-body";
import { runtimeEnv } from "../../../../src/server/runtime";

interface AccountDeletionInput {
  confirmation: "DELETE";
  expectedAccountRevision: number;
  expectedMembershipRevision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function safeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseAccountDeletionInput(
  value: unknown,
): AccountDeletionInput {
  if (!isRecord(value)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Account deletion must be a JSON object",
      400,
    );
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "confirmation",
    "expectedAccountRevision",
    "expectedMembershipRevision",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Account deletion contains unsupported fields",
      400,
    );
  }
  if (value.confirmation !== "DELETE") {
    throw new ApiProblem(
      "CONFIRMATION_REQUIRED",
      "Type DELETE to confirm account deletion",
      400,
    );
  }
  if (
    !safeRevision(value.expectedAccountRevision) ||
    !safeRevision(value.expectedMembershipRevision)
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Account deletion revisions are invalid",
      400,
    );
  }
  return {
    confirmation: value.confirmation,
    expectedAccountRevision: value.expectedAccountRevision,
    expectedMembershipRevision: value.expectedMembershipRevision,
  };
}

function routeProblem(
  error: unknown,
  fallback: string,
): Response {
  if (error instanceof ApiProblem) return apiProblemResponse(error);
  if (error instanceof RequestBodyTooLargeError) {
    return apiProblemResponse(
      new ApiProblem("BODY_TOO_LARGE", error.message, error.status),
    );
  }
  if (error instanceof SyntaxError) {
    return apiProblemResponse(
      new ApiProblem(
        "INVALID_REQUEST",
        "Account deletion JSON is invalid",
        400,
      ),
    );
  }
  return internalProblemResponse(fallback);
}

export async function GET(request: Request) {
  let responseAccountId: string | null = null;
  try {
    const env = await runtimeEnv();
    if (!env.DB) {
      throw new ApiProblem(
        "STORAGE_UNAVAILABLE",
        "Durable storage is not configured",
        503,
      );
    }
    const principal = await authenticate(env.DB, request);
    if (!principal) {
      throw new ApiProblem(
        "AUTHENTICATION_REQUIRED",
        "Authentication required",
        401,
      );
    }
    responseAccountId = principal.userId;
    requireExpectedAccount(request, principal.userId);
    return accountScopedJson(
      {
        deletion: await prepareAccountDeletion(
          env.DB,
          principal.userId,
        ),
      },
      principal.userId,
    );
  } catch (error) {
    return withAccountContext(
      routeProblem(error, "Could not prepare account deletion"),
      responseAccountId,
    );
  }
}

export async function POST(request: Request) {
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
    if (!identityEnforcementConfigured(env)) {
      throw new ApiProblem(
        "STORAGE_UNAVAILABLE",
        "Account identity enforcement is not configured",
        503,
      );
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Content-Type must be application/json",
        415,
      );
    }
    const input = parseAccountDeletionInput(
      await readJsonRequest<unknown>(
        request,
        ACCOUNT_DELETION_REQUEST_MAX_BYTES,
      ),
    );
    const principal = await authenticate(env.DB, request);
    if (!principal) {
      throw new ApiProblem(
        "AUTHENTICATION_REQUIRED",
        "Authentication required",
        401,
      );
    }
    responseAccountId = principal.userId;
    requireExpectedAccount(request, principal.userId);
    const session = await env.DB.prepare(
      `SELECT COALESCE(reauthenticated_at, created_at)
                AS reauthenticated_at
       FROM sessions
       WHERE session_id = ?
         AND user_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?`,
    ).bind(
      principal.sessionId,
      principal.userId,
      new Date().toISOString(),
    ).first<{ reauthenticated_at: string }>();
    if (!session) {
      throw new ApiProblem(
        "REAUTHENTICATION_REQUIRED",
        "Sign in again before deleting this account",
        403,
      );
    }
    const deletionResult = await executeAccountDeletion(env.DB, {
      ...input,
      digestKey: env.AUTH_IDENTITY_DIGEST_KEY,
      reauthenticatedAt: session.reauthenticated_at,
      userId: principal.userId,
    });
    const {
      affectedWorkspaceIds = [],
      ...deletion
    } = deletionResult;
    await notifyWorkspaceChanges(
      env.DB,
      affectedWorkspaceIds,
      { force: true },
    );
    return accountScopedJson(
      { deletion },
      principal.userId,
      { headers: { "set-cookie": clearSessionCookie() } },
    );
  } catch (error) {
    return withAccountContext(
      routeProblem(error, "Could not delete the account"),
      responseAccountId,
    );
  }
}
