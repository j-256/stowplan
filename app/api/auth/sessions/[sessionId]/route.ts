import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
} from "../../../../../src/server/account-context";
import {
  requireAccountSessionId,
  revokeAccountSession,
} from "../../../../../src/server/account-sessions";
import {
  ApiProblem,
  apiProblemResponse,
  internalProblemResponse,
} from "../../../../../src/server/api-problem";
import {
  authenticate,
  clearSessionCookie,
  isTrustedMutation,
} from "../../../../../src/server/auth";
import { runtimeEnv } from "../../../../../src/server/runtime";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
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
    if (request.body !== null) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Session revocation does not accept a request body",
        400,
      );
    }
    const sessionId = requireAccountSessionId((await params).sessionId);
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
    const result = await revokeAccountSession(
      env.DB,
      principal,
      sessionId,
    );
    return accountScopedJson(
      result,
      principal.userId,
      result.current
        ? { headers: { "set-cookie": clearSessionCookie() } }
        : undefined,
    );
  } catch (error) {
    const response = error instanceof ApiProblem
      ? apiProblemResponse(error)
      : internalProblemResponse("Could not revoke the account session");
    return withAccountContext(response, responseAccountId);
  }
}
