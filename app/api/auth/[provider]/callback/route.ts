import {
  createOrLinkUser,
  finishOAuth,
  issueSession,
  provider,
  sessionCookie,
} from "../../../../../src/server/auth";
import { privateJson } from "../../../../../src/server/api-problem";
import { runtimeEnv } from "../../../../../src/server/runtime";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
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
    const providerId = (await params).provider;
    const configuredProvider = provider(env, providerId);
    if (!configuredProvider) {
      return privateJson(
        {
          code: "NOT_FOUND_OR_INACCESSIBLE",
          error: "Authentication provider is not configured",
        },
        { status: 404 },
      );
    }
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !code) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "OAuth callback is incomplete",
        },
        { status: 400 },
      );
    }
    const base = env.AUTH_BASE_URL ?? url.origin;
    const result = await finishOAuth(
      env.DB,
      configuredProvider,
      base,
      state,
      code,
    );
    const user = await createOrLinkUser(
      env.DB,
      env,
      result.profile,
    );
    const session = await issueSession(env.DB, env, user, request);
    return new Response(null, {
      headers: {
        "cache-control": "no-store",
        location: new URL(result.returnTo, base).toString(),
        "set-cookie": sessionCookie(session.raw, session.maxAge),
      },
      status: 302,
    });
  } catch {
    return privateJson(
      {
        code: "AUTHENTICATION_FAILED",
        error: "Authentication could not be completed",
      },
      { status: 401 },
    );
  }
}
