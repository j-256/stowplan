import {
  authenticate,
  authenticationBaseUrl,
  AuthorizationError,
  beginOAuth,
  hasLinkedGoogleIdentity,
  isTrustedMutation,
  provider,
  requireRecentIdentityLinkAuthentication,
  TurnstileVerificationError,
  verifyTurnstile,
  type OAuthIntent,
} from "../../../../../src/server/auth";
import { oauthReturnTo } from "../../../../../src/domain/app-url";
import {
  ApiProblem,
  privateJson,
} from "../../../../../src/server/api-problem";
import {
  readTextRequest,
  RequestBodyTooLargeError,
} from "../../../../../src/server/request-body";
import { runtimeEnv } from "../../../../../src/server/runtime";

const OAUTH_START_REQUEST_MAX_BYTES = 4 * 1_024;
const OAUTH_START_CONTENT_TYPE =
  "application/x-www-form-urlencoded";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  let googleIdentityLinked = false;
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
    const providerId = (await params).provider;
    const configuredProvider = provider(
      env,
      providerId,
      request.url,
    );
    if (!configuredProvider) {
      return privateJson(
        {
          code: "NOT_FOUND_OR_INACCESSIBLE",
          error: "Authentication provider is not configured",
        },
        { status: 404 },
      );
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (
      !contentType.toLowerCase().startsWith(
        OAUTH_START_CONTENT_TYPE,
      )
    ) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error:
            `Content-Type must be ${OAUTH_START_CONTENT_TYPE}`,
        },
        { status: 415 },
      );
    }
    const form = new URLSearchParams(
      await readTextRequest(
        request,
        OAUTH_START_REQUEST_MAX_BYTES,
      ),
    );
    const turnstileToken = form.get(
      "cf-turnstile-response",
    );
    const requestedIntent = form.get("intent") ?? "sign-in";
    if (
      !turnstileToken
      || (
        requestedIntent !== "sign-in"
        && requestedIntent !== "link"
        && requestedIntent !== "reauthenticate"
      )
    ) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "OAuth start fields are invalid",
        },
        { status: 400 },
      );
    }
    const intent = requestedIntent as OAuthIntent;
    const url = new URL(request.url);
    const base = authenticationBaseUrl(env, request.url);
    if (!base) {
      return privateJson(
        {
          code: "AUTHENTICATION_UNAVAILABLE",
          error: "Authentication origin is not configured",
        },
        { status: 503 },
      );
    }
    await verifyTurnstile(
      env,
      turnstileToken,
      request.url,
      request.headers.get("cf-connecting-ip"),
    );
    const principal = intent !== "sign-in"
      ? await authenticate(env.DB, request)
      : null;
    if (intent !== "sign-in" && !principal) {
      throw new AuthorizationError(
        "Authentication required for this Google account check",
        401,
      );
    }
    if (intent === "link" && principal) {
      googleIdentityLinked = await hasLinkedGoogleIdentity(
        env.DB,
        principal.userId,
      );
      await requireRecentIdentityLinkAuthentication(
        env.DB,
        {
          sessionId: principal.sessionId,
          userId: principal.userId,
        },
      );
    }
    const result = await beginOAuth(
      env.DB,
      configuredProvider,
      base,
      oauthReturnTo(url.searchParams.get("returnTo")),
      {
        intent,
        linkIntent: principal
          ? {
              sessionId: principal.sessionId,
              userId: principal.userId,
            }
          : undefined,
      },
    );
    return privateJson(
      { authorizationUrl: result.authorizationUrl },
      {
        headers: {
          "set-cookie": result.bindingCookie,
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
    if (error instanceof TurnstileVerificationError) {
      return privateJson(
        {
          code: error.status === 503
            ? "AUTHENTICATION_UNAVAILABLE"
            : "BROWSER_VERIFICATION_FAILED",
          error: error.message,
        },
        { status: error.status },
      );
    }
    if (error instanceof AuthorizationError) {
      return privateJson(
        {
          code: "AUTHENTICATION_REQUIRED",
          error: error.message,
        },
        { status: error.status },
      );
    }
    if (
      error instanceof ApiProblem
      && error.code === "REAUTHENTICATION_REQUIRED"
    ) {
      return privateJson(
        {
          code: error.code,
          error: googleIdentityLinked
            ? "Sign in again with an existing Google identity before linking another"
            : "Sign out and sign in again with this account's existing method, then link Google when you return",
          hasLinkedGoogleIdentity: googleIdentityLinked,
        },
        { status: 401 },
      );
    }
    if (error instanceof SyntaxError) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "OAuth start form is invalid",
        },
        { status: 400 },
      );
    }
    return privateJson(
      {
        code: "AUTHENTICATION_FAILED",
        error: "Authentication could not be started",
      },
      { status: 500 },
    );
  }
}
