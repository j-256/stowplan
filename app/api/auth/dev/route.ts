import {
  createOrLinkUser,
  isTrustedMutation,
  issueSession,
  sessionCookie,
} from "../../../../src/server/auth";
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
    if (env.AUTH_DEV_ENABLED !== "true") {
      return Response.json(
        { error: "Development authentication is disabled" },
        { status: 404 },
      );
    }
    const body = await readJsonRequest<{
      email?: string;
      name?: string;
    }>(request, CONTROL_REQUEST_MAX_BYTES);
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      return Response.json({ error: "Email is required" }, { status: 400 });
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
    return Response.json(
      { user },
      {
        headers: {
          "cache-control": "no-store",
          "set-cookie": sessionCookie(session.raw, session.maxAge),
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Development sign-in failed",
      },
      {
        status: error instanceof RequestBodyTooLargeError
          ? error.status
          : 400,
      },
    );
  }
}
