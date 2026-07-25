import { privateJson } from "../../../../src/server/api-problem";
import {
  clearSessionCookie,
  isTrustedMutation,
  revokeCurrentSession,
} from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";

export async function POST(request: Request) {
  try {
    const env = await runtimeEnv();
    if (!isTrustedMutation(request, env.AUTH_BASE_URL)) {
      return privateJson(
        {
          code: "CROSS_ORIGIN_DENIED",
          error: "Cross-origin mutation denied",
        },
        { status: 403 },
      );
    }
    if (env.DB) await revokeCurrentSession(env.DB, request);
    return privateJson(
      { ok: true },
      { headers: { "set-cookie": clearSessionCookie() } },
    );
  } catch {
    return privateJson(
      {
        code: "INTERNAL_ERROR",
        error: "Could not sign out",
      },
      { status: 500 },
    );
  }
}
