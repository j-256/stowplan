import {
  createOrLinkUser,
  isTrustedMutation,
  issueSession,
  sessionCookie,
  verifyAccess,
} from "../../../../src/server/auth";
import { privateJson } from "../../../../src/server/api-problem";
import { runtimeEnv } from "../../../../src/server/runtime";

export async function POST(request: Request) {
  try {
    if (!isTrustedMutation(request)) {
      return privateJson(
        {
          code: "CROSS_ORIGIN_DENIED",
          error: "Cross-origin mutation denied",
        },
        { status: 403 },
      );
    }
    const env = await runtimeEnv();
    if (!env.DB) {
      return privateJson(
        {
          code: "STORAGE_UNAVAILABLE",
          error: "Database is not configured",
        },
        { status: 503 },
      );
    }
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) {
      return privateJson(
        {
          code: "AUTHENTICATION_REQUIRED",
          error: "Cloudflare Access assertion is missing",
        },
        { status: 401 },
      );
    }
    const profile = await verifyAccess(env, assertion);
    const user = await createOrLinkUser(env.DB, env, profile);
    const session = await issueSession(env.DB, env, user, request);
    return privateJson(
      { user },
      {
        headers: {
          "set-cookie": sessionCookie(session.raw, session.maxAge),
        },
      },
    );
  } catch {
    return privateJson(
      {
        code: "AUTHENTICATION_FAILED",
        error: "Access authentication could not be completed",
      },
      { status: 401 },
    );
  }
}
