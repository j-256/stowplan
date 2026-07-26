import { adminMutation } from "../../../../src/server/admin";
import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
} from "../../../../src/server/account-context";
import {
  ApiProblem,
  apiProblemResponse,
  privateJson,
} from "../../../../src/server/api-problem";
import {
  AuthorizationError,
  authorizeAdmin,
  clearSessionCookie,
  developmentAuthenticationAllowed,
  isTrustedMutation,
  provider,
} from "../../../../src/server/auth";
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

interface AdminMutationBody {
  action: string;
  expectedAccountRevision?: number;
  expectedAccessRevision?: number;
  expectedMembershipRevision?: number;
  pauseKind?: string;
  reason?: string;
  targetId: string;
  value?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" &&
    !Array.isArray(value);
}

function parseAdminMutationBody(value: unknown): AdminMutationBody {
  if (
    !isRecord(value) ||
    typeof value.action !== "string" ||
    !value.action.trim() ||
    typeof value.targetId !== "string" ||
    !value.targetId.trim() ||
    (
      value.value !== undefined &&
      typeof value.value !== "string"
    ) ||
    (
      value.expectedAccountRevision !== undefined &&
      (
        typeof value.expectedAccountRevision !== "number" ||
        !Number.isSafeInteger(value.expectedAccountRevision) ||
        value.expectedAccountRevision < 0
      )
    ) ||
    (
      value.expectedAccessRevision !== undefined &&
      (
        typeof value.expectedAccessRevision !== "number" ||
        !Number.isSafeInteger(value.expectedAccessRevision) ||
        value.expectedAccessRevision < 0
      )
    ) ||
    (
      value.expectedMembershipRevision !== undefined &&
      (
        typeof value.expectedMembershipRevision !== "number" ||
        !Number.isSafeInteger(value.expectedMembershipRevision) ||
        value.expectedMembershipRevision < 0
      )
    ) ||
    (
      value.pauseKind !== undefined &&
      typeof value.pauseKind !== "string"
    ) ||
    (
      value.reason !== undefined &&
      typeof value.reason !== "string"
    )
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "action and targetId are required strings; value, pauseKind, and reason must be strings and expected revisions must be non-negative safe integers when provided",
      400,
    );
  }
  return {
    action: value.action,
    ...(value.expectedAccountRevision === undefined
      ? {}
      : { expectedAccountRevision: value.expectedAccountRevision }),
    ...(value.expectedAccessRevision === undefined
      ? {}
      : { expectedAccessRevision: value.expectedAccessRevision }),
    ...(value.expectedMembershipRevision === undefined
      ? {}
      : { expectedMembershipRevision: value.expectedMembershipRevision }),
    ...(value.pauseKind === undefined
      ? {}
      : { pauseKind: value.pauseKind }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    targetId: value.targetId,
    ...(value.value === undefined ? {} : { value: value.value }),
  };
}

export async function POST(request: Request) {
  let responseAccountId: string | null = null;
  try {
    if (!isTrustedMutation(request)) {
      throw new ApiProblem(
        "CROSS_ORIGIN_DENIED",
        "Cross-origin mutation denied",
        403,
      );
    }
    const env = await runtimeEnv();
    if (!env.DB) {
      throw new ApiProblem(
        "STORAGE_UNAVAILABLE",
        "Database is not configured",
        503,
      );
    }
    const user = await authorizeAdmin(env.DB, env, request);
    responseAccountId = user.userId;
    requireExpectedAccount(request, user.userId);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Content-Type must be application/json",
        415,
      );
    }
    const body = parseAdminMutationBody(
      await readJsonRequest<unknown>(
        request,
        CONTROL_REQUEST_MAX_BYTES,
      ),
    );
    const result = await adminMutation(
      env.DB,
      user.userId,
      body,
      {
        actorSessionId: user.sessionId,
        identityDigestKey: env.AUTH_IDENTITY_DIGEST_KEY,
        signInProviderIds: [
          provider(env, "google", request.url)?.id,
          developmentAuthenticationAllowed(env, request.url)
            ? "development"
            : null,
        ].filter(
          (providerId): providerId is string =>
            typeof providerId === "string",
        ),
      },
    );
    const currentSessionRevoked =
      result.currentSessionRevoked === true ||
      (
        body.action === "session.revoke" &&
        body.targetId === user.sessionId
      ) ||
      (
        body.targetId === user.userId &&
        result.revokedSessions !== undefined &&
        result.revokedSessions > 0
      );
    return accountScopedJson(
      {
        ok: true,
        ...result,
        ...(currentSessionRevoked
          ? { currentSessionRevoked: true }
          : {}),
      },
      user.userId,
      currentSessionRevoked
        ? { headers: { "set-cookie": clearSessionCookie() } }
        : undefined,
    );
  } catch (error) {
    if (error instanceof ApiProblem) {
      return withAccountContext(
        apiProblemResponse(error),
        responseAccountId,
      );
    }
    if (error instanceof QuotaExceededError) {
      return withAccountContext(
        privateJson(quotaProblem(error), { status: error.status }),
        responseAccountId,
      );
    }
    if (error instanceof RequestBodyTooLargeError) {
      return withAccountContext(
        apiProblemResponse(
          new ApiProblem(
            "BODY_TOO_LARGE",
            error.message,
            error.status,
          ),
        ),
        responseAccountId,
      );
    }
    if (error instanceof SyntaxError) {
      return withAccountContext(
        apiProblemResponse(
          new ApiProblem(
            "INVALID_REQUEST",
            "The admin mutation JSON body is invalid",
            400,
          ),
        ),
        responseAccountId,
      );
    }
    if (error instanceof AuthorizationError) {
      return withAccountContext(privateJson(
        {
          code: error.status === 401
            ? "AUTHENTICATION_REQUIRED"
            : "ADMIN_REQUIRED",
          error: error.message,
        },
        { status: error.status },
      ), responseAccountId);
    }
    return withAccountContext(privateJson(
      {
        code: "INTERNAL_ERROR",
        error: "Admin mutation failed",
      },
      { status: 500 },
    ), responseAccountId);
  }
}
