import { adminOverview } from "../../../../src/server/admin";
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

const PRIVATE_RESPONSE_HEADERS = { "cache-control": "no-store" };

export async function GET(request: Request) {
  let responseAccountId: string | null = null;
  try {
    const env = await runtimeEnv();
    if (!env.DB) {
      return Response.json(
        { error: "Database is not configured" },
        { headers: PRIVATE_RESPONSE_HEADERS, status: 503 },
      );
    }
    const user = await authorizeAdmin(env.DB, env, request);
    responseAccountId = user.userId;
    if (request.headers.has(ACCOUNT_CONTEXT_HEADER)) {
      requireExpectedAccount(request, user.userId);
    }
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return accountScopedJson(
      await adminOverview(env.DB, { query, viewerUserId: user.userId }),
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
    return withAccountContext(Response.json(
      {
        error: authorizationError
          ? error.message
          : "Could not load administrative data",
      },
      {
        headers: PRIVATE_RESPONSE_HEADERS,
        status: authorizationError ? error.status : 500,
      },
    ), responseAccountId);
  }
}
