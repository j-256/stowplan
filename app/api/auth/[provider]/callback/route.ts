import {
  authenticate,
  authenticationBaseUrl,
  clearOAuthBindingCookie,
  createOrLinkUser,
  finishOAuth,
  issueSession,
  markSessionReauthenticated,
  OAuthCallbackError,
  oauthBrowserBinding,
  provider,
  sessionCookie,
} from "../../../../../src/server/auth";
import {
  apiProblemRetryAfter,
  ApiProblem,
  privateJson,
} from "../../../../../src/server/api-problem";
import { runtimeEnv } from "../../../../../src/server/runtime";
import {
  SESSION_AUTHENTICATION_PROVIDER,
} from "../../../../../src/shared/authentication";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  let bindingClearCookie: string | null = null;
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
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    if (!state) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "OAuth callback is incomplete",
        },
        { status: 400 },
      );
    }
    try {
      bindingClearCookie = clearOAuthBindingCookie(
        configuredProvider.id,
        state,
      );
    } catch {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "OAuth callback state is invalid",
        },
        { status: 400 },
      );
    }
    const code = url.searchParams.get("code");
    if (!code) {
      return privateJson(
        {
          code: "INVALID_REQUEST",
          error: "OAuth callback was not completed",
        },
        {
          headers: { "set-cookie": bindingClearCookie },
          status: 400,
        },
      );
    }
    const base = authenticationBaseUrl(env, request.url);
    if (!base) {
      return privateJson(
        {
          code: "AUTHENTICATION_UNAVAILABLE",
          error: "Authentication origin is not configured",
        },
        {
          headers: { "set-cookie": bindingClearCookie },
          status: 503,
        },
      );
    }
    const result = await finishOAuth(
      env.DB,
      configuredProvider,
      base,
      state,
      code,
      oauthBrowserBinding(
        request,
        configuredProvider.id,
        state,
      ),
    );
    const principal = result.intent !== "sign-in"
      ? await authenticate(env.DB, request)
      : null;
    if (
      result.linkIntent
      && (
        !principal
        || principal.userId !== result.linkIntent.userId
        || principal.sessionId !== result.linkIntent.sessionId
      )
    ) {
      throw new Error(
        "Authenticated identity-link intent does not match the callback session",
      );
    }
    const user = await createOrLinkUser(
      env.DB,
      env,
      result.profile,
      result.intent === "sign-in"
        ? {
            termsVersion: result.termsVersion,
          }
        : result.intent === "link"
          ? {
              linkIntent: result.linkIntent,
              requireRecentAuthentication: true,
            }
          : {
              linkIntent: result.linkIntent,
              requireExistingIdentity: true,
            },
    );
    if (
      result.intent === "reauthenticate"
      && result.linkIntent
    ) {
      await markSessionReauthenticated(
        env.DB,
        result.linkIntent.userId,
        result.linkIntent.sessionId,
      );
    }
    const session = result.intent === "sign-in"
      ? await issueSession(
          env.DB,
          env,
          user,
          request,
          {
            authenticationProvider:
              SESSION_AUTHENTICATION_PROVIDER.GOOGLE,
          },
        )
      : null;
    const headers = new Headers({
      "cache-control": "no-store",
      location: new URL(result.returnTo, base).toString(),
    });
    headers.append("set-cookie", bindingClearCookie);
    if (session && result.intent === "sign-in") {
      headers.append(
        "set-cookie",
        sessionCookie(
          session.raw,
          session.maxAge,
          result.sessionPersistence,
        ),
      );
    }
    return new Response(null, {
      headers,
      status: 302,
    });
  } catch (error) {
    const headers = new Headers();
    if (bindingClearCookie) {
      headers.set("set-cookie", bindingClearCookie);
    }
    if (error instanceof ApiProblem) {
      if (error.code === "ACCOUNT_BANNED") {
        return privateJson(
          {
            code: "ACCOUNT_BANNED",
            error: "This account cannot sign in",
          },
          { headers, status: 403 },
        );
      }
      if (error.code === "CIRCUIT_PAUSED") {
        return privateJson(
          {
            code: "CIRCUIT_PAUSED",
            error: "New sign-ins are temporarily unavailable",
          },
          { headers, status: 503 },
        );
      }
      if (error.code === "QUOTA_EXCEEDED") {
        headers.set("retry-after", apiProblemRetryAfter(error));
        return privateJson(
          {
            code: "QUOTA_EXCEEDED",
            error: "Sign-in capacity is temporarily unavailable; try again later",
          },
          { headers, status: 429 },
        );
      }
      if (error.code === "AUTHENTICATION_REQUIRED") {
        return privateJson(
          {
            code: "AUTHENTICATION_FAILED",
            error: "Authentication could not be completed",
          },
          { headers, status: 401 },
        );
      }
    }
    if (error instanceof OAuthCallbackError) {
      const providerUnavailable = error.status >= 500;
      return privateJson(
        {
          code: providerUnavailable
            ? "AUTHENTICATION_UNAVAILABLE"
            : error.status === 400
              ? "INVALID_REQUEST"
              : "AUTHENTICATION_FAILED",
          error: providerUnavailable
            ? "The identity provider is temporarily unavailable"
            : "Authentication could not be completed",
        },
        { headers, status: error.status },
      );
    }
    return privateJson(
      {
        code: "AUTHENTICATION_FAILED",
        error: "Authentication could not be completed",
      },
      { headers, status: 500 },
    );
  }
}
