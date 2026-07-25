import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
} from "../../../../src/server/account-context";
import {
  listAccountSessions,
} from "../../../../src/server/account-sessions";
import {
  ApiProblem,
  apiProblemResponse,
  internalProblemResponse,
} from "../../../../src/server/api-problem";
import { authenticate } from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";

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
      await listAccountSessions(
        env.DB,
        principal,
        new URL(request.url).searchParams,
      ),
      principal.userId,
    );
  } catch (error) {
    const response = error instanceof ApiProblem
      ? apiProblemResponse(error)
      : internalProblemResponse("Could not load account sessions");
    return withAccountContext(response, responseAccountId);
  }
}
