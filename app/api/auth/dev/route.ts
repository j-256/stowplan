import {
  createOrLinkUser,
  developmentAuthenticationAllowed,
  identityEnforcementConfigured,
  isTrustedMutation,
  issueSession,
  sessionCookie,
} from "../../../../src/server/auth";
import {
  apiProblemRetryAfter,
  ApiProblem,
  privateJson,
} from "../../../../src/server/api-problem";
import {
  bootstrapGlobalAdmin,
} from "../../../../src/server/account-governance";
import {
  CONTROL_REQUEST_MAX_BYTES,
  readJsonRequest,
  RequestBodyTooLargeError,
} from "../../../../src/server/request-body";
import { runtimeEnv } from "../../../../src/server/runtime";
import {
  SESSION_AUTHENTICATION_PROVIDER,
} from "../../../../src/shared/authentication";
import { SESSION_PERSISTENCE } from "../../../../src/shared/terms";

const SYNTHETIC_DEVELOPMENT_EMAIL_PATTERN =
  /^[^@\s]+@example\.test$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" &&
    !Array.isArray(value);
}

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
    if (!developmentAuthenticationAllowed(env, request.url)) {
      return privateJson(
        {
          code: "AUTHENTICATION_UNAVAILABLE",
          error: "Development authentication is disabled",
        },
        { status: 404 },
      );
    }
    if (!identityEnforcementConfigured(env)) {
      return privateJson(
        {
          code: "AUTHENTICATION_UNAVAILABLE",
          error: "Development authentication is not configured",
        },
        { status: 503 },
      );
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "Content-Type must be application/json",
        },
        { status: 415 },
      );
    }
    const body = await readJsonRequest<unknown>(
      request,
      CONTROL_REQUEST_MAX_BYTES,
    );
    if (!isRecord(body)) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "The development sign-in request must be a JSON object",
        },
        { status: 400 },
      );
    }
    if (
      typeof body.email !== "string" ||
      (
        body.name !== undefined &&
        typeof body.name !== "string"
      )
    ) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "Development sign-in fields are invalid",
        },
        { status: 400 },
      );
    }
    const email = body.email.trim().toLowerCase();
    if (!SYNTHETIC_DEVELOPMENT_EMAIL_PATTERN.test(email)) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "Development email must use the @example.test domain",
        },
        { status: 400 },
      );
    }
    let user = await createOrLinkUser(
      env.DB,
      env,
      {
        provider: "development",
        subject: email,
        email,
        displayName: body.name?.trim() || email,
      },
    );
    if (email === "owner@example.test") {
      const bootstrap = await bootstrapGlobalAdmin(
        env.DB,
        user.userId,
      );
      if (
        bootstrap.status === "promoted"
        || bootstrap.status === "already-admin"
      ) {
        user = { ...user, globalRole: "admin" };
      }
    }
    const session = await issueSession(
      env.DB,
      env,
      user,
      request,
      {
        authenticationProvider:
          SESSION_AUTHENTICATION_PROVIDER.DEVELOPMENT,
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
    if (error instanceof RequestBodyTooLargeError) {
      return privateJson(
        {
          code: "BODY_TOO_LARGE",
          error: error.message,
        },
        { status: error.status },
      );
    }
    if (error instanceof SyntaxError) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "The development sign-in JSON body is invalid",
        },
        { status: 400 },
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
      if (error.code === "CIRCUIT_PAUSED") {
        return privateJson(
          {
            code: "CIRCUIT_PAUSED",
            error: "New sign-ins are temporarily unavailable",
          },
          { status: 503 },
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
        error: "Development sign-in could not be completed",
      },
      { status: 500 },
    );
  }
}
