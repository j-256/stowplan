import { workspaceReturnTo } from "../../../../../src/domain/app-url";
import {
  authenticate,
  AuthorizationError,
  consumeGuestLink,
  InvitationError,
  isTrustedMutation,
} from "../../../../../src/server/auth";
import { privateJson } from "../../../../../src/server/api-problem";
import {
  QuotaExceededError,
  quotaProblem,
} from "../../../../../src/server/quotas";
import {
  INVITATION_REQUEST_MAX_BYTES,
  readTextRequest,
  RequestBodyTooLargeError,
} from "../../../../../src/server/request-body";
import { runtimeEnv } from "../../../../../src/server/runtime";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const env = await runtimeEnv();
  const token = (await params).token;
  const requestUrl = new URL(request.url);
  const base = env.AUTH_BASE_URL ?? request.url;
  const guestUrl = new URL(`/guest/${encodeURIComponent(token)}`, base);
  const returnTo = requestUrl.searchParams.get("returnTo");
  if (returnTo) guestUrl.searchParams.set("returnTo", returnTo);
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      location: guestUrl.toString(),
    },
    status: 302,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
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
    if (!env.DB) {
      return privateJson(
        {
          code: "STORAGE_UNAVAILABLE",
          error: "Database is not configured",
        },
        { status: 503 },
      );
    }
    const token = (await params).token;
    const base = env.AUTH_BASE_URL ?? request.url;
    const requestUrl = new URL(request.url);
    const requested = requestUrl.searchParams.get("returnTo");
    const contentType = request.headers.get("content-type") ?? "";
    if (
      !contentType.toLowerCase().startsWith(
        "application/x-www-form-urlencoded",
      )
    ) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "Invitation confirmation form is invalid",
        },
        { status: 415 },
      );
    }
    const form = new URLSearchParams(await readTextRequest(
      request,
      INVITATION_REQUEST_MAX_BYTES,
    ));
    const user = await authenticate(env.DB, request);
    if (!user) {
      const guestReturn = new URL(
        `/guest/${encodeURIComponent(token)}`,
        base,
      );
      if (requested) guestReturn.searchParams.set("returnTo", requested);
      const account = new URL("/account", base);
      account.searchParams.set(
        "returnTo",
        `${guestReturn.pathname}${guestReturn.search}`,
      );
      return new Response(null, {
        status: 303,
        headers: {
          location: account.toString(),
          "cache-control": "no-store",
        },
      });
    }
    if (form.get("expectedAccountId") !== user.userId) {
      return privateJson(
        {
          code: "ACCOUNT_CONTEXT_CHANGED",
          error:
            "The signed-in account changed; reload the invitation before accepting",
        },
        { status: 409 },
      );
    }
    const result = await consumeGuestLink(env.DB, token, user.userId);
    const returnTo = workspaceReturnTo(requested, result.workspaceId);
    return new Response(null, {
      status: 303,
      headers: {
        location: new URL(returnTo, base).toString(),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return privateJson(
        {
          code: "AUTHENTICATION_REQUIRED",
          error: error.message,
        },
        { status: error.status },
      );
    }
    if (error instanceof InvitationError) {
      return privateJson(
        {
          code: "INVITATION_UNAVAILABLE",
          error: error.message,
        },
        { status: error.status },
      );
    }
    if (error instanceof QuotaExceededError) {
      return privateJson(quotaProblem(error), {
        status: error.status,
      });
    }
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
          error: "Invitation confirmation form is invalid",
        },
        { status: 400 },
      );
    }
    return privateJson(
      {
        code: "INTERNAL_ERROR",
        error: "Invitation acceptance could not be completed",
      },
      { status: 500 },
    );
  }
}
