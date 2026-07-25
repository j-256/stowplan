import {
  createOrLinkUser,
  isTrustedMutation,
  issueSession,
  sessionCookie,
} from "../../../../src/server/auth";
import { privateJson } from "../../../../src/server/api-problem";
import {
  CONTROL_REQUEST_MAX_BYTES,
  readJsonRequest,
  RequestBodyTooLargeError,
} from "../../../../src/server/request-body";
import { runtimeEnv } from "../../../../src/server/runtime";

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
    if (env.AUTH_DEV_ENABLED !== "true") {
      return privateJson(
        {
          code: "AUTHENTICATION_UNAVAILABLE",
          error: "Development authentication is disabled",
        },
        { status: 404 },
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
    if (!email) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "Email is required",
        },
        { status: 400 },
      );
    }
    const user = await createOrLinkUser(
      env.DB,
      env,
      {
        provider: "development",
        subject: email,
        email,
        displayName: body.name?.trim() || email,
      },
    );
    const session = await issueSession(env.DB, env, user, request);
    return privateJson(
      { user },
      {
        headers: {
          "set-cookie": sessionCookie(session.raw, session.maxAge),
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
    return privateJson(
      {
        code: "AUTHENTICATION_FAILED",
        error: "Development sign-in could not be completed",
      },
      { status: 500 },
    );
  }
}
