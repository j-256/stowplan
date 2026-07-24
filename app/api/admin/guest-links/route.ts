import {
  AuthorizationError,
  authenticate,
  authorizeAdmin,
  canWriteWorkspace,
  createGuestLink,
  isTrustedMutation,
} from "../../../../src/server/auth";
import { workspaceReturnTo } from "../../../../src/domain/app-url";
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
    const env = await runtimeEnv();
    if (!isTrustedMutation(request, env.AUTH_BASE_URL)) {
      return Response.json({ error: "Cross-origin mutation denied" }, { status: 403 });
    }
    if (!env.DB) {
      return Response.json({ error: "Database is not configured" }, { status: 503 });
    }
    const user = await authenticate(env.DB, request);
    if (!user) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    const body = await readJsonRequest<{
      hours?: number;
      returnTo?: string;
      role?: "editor" | "viewer";
      workspaceId: string;
    }>(request, CONTROL_REQUEST_MAX_BYTES);
    const canWrite = await canWriteWorkspace(
      env.DB,
      user.userId,
      body.workspaceId,
    );
    if (!canWrite) {
      if (user.globalRole !== "admin") {
        return Response.json(
          { error: "Workspace write access required" },
          { status: 403 },
        );
      }
      await authorizeAdmin(env.DB, env, request);
    }
    const link = await createGuestLink(
      env.DB,
      body.workspaceId,
      user.userId,
      body.role ?? "editor",
      body.hours,
    );
    const returnTo = workspaceReturnTo(body.returnTo, body.workspaceId);
    const base = env.AUTH_BASE_URL ?? request.url;
    const url = new URL(`/guest/${link.raw}`, base);
    url.searchParams.set("returnTo", returnTo);
    return Response.json(
      { url: url.toString(), expiresAt: link.expiresAt },
      { status: 201 },
    );
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
      { error: error instanceof Error ? error.message : "Could not create guest link" },
      { status: error instanceof AuthorizationError ? error.status : 400 },
    );
  }
}
