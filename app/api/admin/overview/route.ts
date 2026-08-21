import {
  adminOverview,
  adminOverviewPage,
} from "../../../../src/server/admin";
import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
} from "../../../../src/server/account-context";
import {
  ApiProblem,
  apiProblemResponse,
} from "../../../../src/server/api-problem";
import {
  AuthorizationError,
  authorizeAdmin,
} from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";
import { ACCOUNT_CONTEXT_HEADER } from "../../../../src/shared/account-context";

export async function GET(request: Request) {
  let responseAccountId: string | null = null;
  try {
    const env = await runtimeEnv();
    if (!env.DB) {
      return apiProblemResponse(
        new ApiProblem(
          "STORAGE_UNAVAILABLE",
          "Database is not configured",
          503,
        ),
      );
    }
    const user = await authorizeAdmin(env.DB, env, request);
    responseAccountId = user.userId;
    if (request.headers.has(ACCOUNT_CONTEXT_HEADER)) {
      requireExpectedAccount(request, user.userId);
    }
    const searchParams = new URL(request.url).searchParams;
    const query = searchParams.get("q") ?? "";
    return accountScopedJson(
      await adminOverview(env.DB, {
        page: adminOverviewPage(searchParams),
        query,
        viewerSessionId: user.sessionId,
        viewerUserId: user.userId,
      }),
      user.userId,
    );
  } catch (error) {
    if (error instanceof ApiProblem) {
      return withAccountContext(
        apiProblemResponse(error),
        responseAccountId,
      );
    }
    const authorizationError = error instanceof AuthorizationError;
    return withAccountContext(
      apiProblemResponse(
        new ApiProblem(
          authorizationError
            ? error.status === 401
              ? "AUTHENTICATION_REQUIRED"
              : "ADMIN_REQUIRED"
            : "INTERNAL_ERROR",
          authorizationError
            ? error.message
            : "Could not load administrative data",
          authorizationError ? error.status : 500,
        ),
      ),
      responseAccountId,
    );
  }
}
