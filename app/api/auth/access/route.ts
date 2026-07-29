import {
  AccessVerificationError,
  createOrLinkUser,
  identityEnforcementConfigured,
  isTrustedMutation,
  issueSession,
  sessionCookie,
  verifyAccess,
} from "../../../../src/server/auth";
import {
  apiProblemRetryAfter,
  ApiProblem,
  privateJson,
} from "../../../../src/server/api-problem";
import { runtimeEnv } from "../../../../src/server/runtime";
import {
  SESSION_AUTHENTICATION_PROVIDER,
} from "../../../../src/shared/authentication";
import { SESSION_PERSISTENCE } from "../../../../src/shared/terms";

const ACCESS_MIGRATION_SESSION_TTL_SECONDS = 2 * 60 * 60;

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
    if (env.AUTH_ACCESS_MIGRATION_ENABLED !== "true") {
      return privateJson(
        {
          code: "NOT_FOUND_OR_INACCESSIBLE",
          error: "Authentication route is not available",
        },
        { status: 404 },
      );
    }
    if (!env.DB) {
      return privateJson(
        {
          code: "STORAGE_UNAVAILABLE",
          error: "Database is not configured",
        },
        { status: 503 },
      );
    }
    if (!identityEnforcementConfigured(env)) {
      return privateJson(
        {
          code: "AUTHENTICATION_UNAVAILABLE",
          error: "Access authentication is not configured",
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
    const user = await createOrLinkUser(
      env.DB,
      env,
      profile,
      { requireExistingIdentity: true },
    );
    const session = await issueSession(
      env.DB,
      env,
      user,
      request,
      {
        authenticationProvider:
          SESSION_AUTHENTICATION_PROVIDER.ACCESS_MIGRATION,
        maximumSeconds: ACCESS_MIGRATION_SESSION_TTL_SECONDS,
      },
    );
    return privateJson(
      { user },
      {
        headers: {
          "set-cookie": sessionCookie(
            session.raw,
            session.maxAge,
            SESSION_PERSISTENCE.PERSISTENT,
          ),
        },
      },
    );
  } catch (error) {
    if (
      error instanceof AccessVerificationError
      && error.status === 503
    ) {
      return privateJson(
        {
          code: "AUTHENTICATION_UNAVAILABLE",
          error: "Access authentication is temporarily unavailable",
        },
        { status: 503 },
      );
    }
    if (error instanceof ApiProblem) {
      if (error.code === "ACCOUNT_BANNED") {
        return privateJson(
          {
            code: "ACCOUNT_BANNED",
            error: "This account cannot sign in",
          },
          { status: 403 },
        );
      }
      if (error.code === "QUOTA_EXCEEDED") {
        return privateJson(
          {
            code: "QUOTA_EXCEEDED",
            error: "Sign-in capacity is temporarily unavailable; try again later",
          },
          {
            headers: {
              "retry-after": apiProblemRetryAfter(error),
            },
            status: 429,
          },
        );
      }
    }
    return privateJson(
      {
        code: "AUTHENTICATION_FAILED",
        error: "Access authentication could not be completed",
      },
      { status: 401 },
    );
  }
}
