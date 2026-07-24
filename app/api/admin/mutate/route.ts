import { adminMutation } from "../../../../src/server/admin";
import {
  AuthorizationError,
  authorizeAdmin,
  isTrustedMutation,
} from "../../../../src/server/auth";
import {
  QuotaExceededError,
  quotaProblem,
} from "../../../../src/server/quotas";
import {
  CONTROL_REQUEST_MAX_BYTES,
  readJsonRequest,
  RequestBodyTooLargeError,
} from "../../../../src/server/request-body";
import { runtimeEnv } from "../../../../src/server/runtime";

export async function POST(request: Request) {
  try {
    if (!isTrustedMutation(request)) {
      return Response.json(
        { error: "Cross-origin mutation denied" },
        { status: 403 },
      );
    }
    const env = await runtimeEnv();
    if (!env.DB) {
      return Response.json(
        { error: "Database is not configured" },
        { status: 503 },
      );
    }
    const user = await authorizeAdmin(env.DB, env, request);
    const body = await readJsonRequest<{
      action: string;
      targetId: string;
      value?: string;
    }>(request, CONTROL_REQUEST_MAX_BYTES);
    const result = await adminMutation(env.DB, user.userId, body);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return Response.json(quotaProblem(error), { status: error.status });
    }
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Admin mutation failed",
      },
      { status: error instanceof AuthorizationError ? error.status : 400 },
    );
  }
}
