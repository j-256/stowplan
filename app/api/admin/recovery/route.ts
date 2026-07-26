import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
} from "../../../../src/server/account-context";
import {
  recoverGlobalAdmin,
  recoveryPrincipalAuditDigest,
} from "../../../../src/server/account-governance";
import {
  ADMIN_RECOVERY_TOKEN_HEADER,
  adminRecoveryTokenMatches,
} from "../../../../src/server/admin-recovery-token";
import {
  ApiProblem,
  apiProblemResponse,
  privateJson,
} from "../../../../src/server/api-problem";
import {
  authenticate,
  authenticateAccessRecoveryPrincipals,
  AuthorizationError,
  identityEnforcementConfigured,
  isTrustedMutation,
} from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";
import {
  ADMIN_RECOVERY_MODE,
} from "../../../../src/shared/governance-policy";

const ADMIN_RECOVERY_AUDIT_REASON =
  "Access and emergency recovery token";
const APP_SESSION_RECOVERY_AUDIT_REASON =
  "App session and emergency recovery token";
const APP_SESSION_RECOVERY_PROVIDER = "stowplan-app-session";

export async function POST(request: Request) {
  let responseAccountId: string | null = null;
  try {
    const env = await runtimeEnv();
    if (!isTrustedMutation(request, env.AUTH_BASE_URL)) {
      throw new ApiProblem(
        "CROSS_ORIGIN_DENIED",
        "Cross-origin mutation denied",
        403,
      );
    }
    if (request.body !== null) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Administrator recovery requests do not accept a body",
        400,
      );
    }
    if (!env.DB) {
      throw new ApiProblem(
        "STORAGE_UNAVAILABLE",
        "Database is not configured",
        503,
      );
    }
    const accessRequired =
      env.AUTH_ADMIN_REQUIRE_ACCESS === "true";
    const recoveryMode = accessRequired
      ? ADMIN_RECOVERY_MODE.ACCESS
      : ADMIN_RECOVERY_MODE.APP_SESSION;
    let access: Awaited<
      ReturnType<typeof authenticateAccessRecoveryPrincipals>
    >["access"] | null = null;
    let user: Awaited<ReturnType<typeof authenticate>>;
    if (accessRequired) {
      const principals =
        await authenticateAccessRecoveryPrincipals(
          env.DB,
          env,
          request,
        );
      access = principals.access;
      user = principals.user;
    } else {
      user = await authenticate(env.DB, request);
      if (!user) {
        throw new AuthorizationError(
          "Authentication required",
          401,
        );
      }
    }
    responseAccountId = user.userId;
    requireExpectedAccount(request, user.userId);
    if (
      !await adminRecoveryTokenMatches(
        env.AUTH_ADMIN_RECOVERY_TOKEN,
        request.headers.get(ADMIN_RECOVERY_TOKEN_HEADER),
      )
    ) {
      throw new ApiProblem(
        "ADMIN_REQUIRED",
        "Administrator recovery authorization failed",
        403,
      );
    }
    if (!identityEnforcementConfigured(env)) {
      throw new ApiProblem(
        "STORAGE_UNAVAILABLE",
        "Identity enforcement is not configured",
        503,
      );
    }
    const principalDigest =
      await recoveryPrincipalAuditDigest(
        env.AUTH_IDENTITY_DIGEST_KEY,
        recoveryMode,
        access?.provider ?? APP_SESSION_RECOVERY_PROVIDER,
        access?.subject ?? user.userId,
      );
    const emailMatched = access
      ? access.email.trim().toLocaleLowerCase() ===
        user.email.trim().toLocaleLowerCase()
      : undefined;
    const result = await recoverGlobalAdmin(env.DB, {
      ...(emailMatched === undefined ? {} : { emailMatched }),
      principalDigest,
      reason: accessRequired
        ? ADMIN_RECOVERY_AUDIT_REASON
        : APP_SESSION_RECOVERY_AUDIT_REASON,
      recoveryMode,
      retainedSessionId: user.sessionId,
      targetUserId: user.userId,
    });
    if (result.status === "ineligible") {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "The authenticated app account is not eligible for recovery",
        409,
      );
    }
    return accountScopedJson(
      {
        ok: true,
        promoted: result.promoted,
        revokedSessions: result.revokedSessions,
        status: result.status,
      },
      user.userId,
    );
  } catch (error) {
    if (error instanceof ApiProblem) {
      return withAccountContext(
        apiProblemResponse(error),
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
        error: "Administrator recovery failed",
      },
      { status: 500 },
    ), responseAccountId);
  }
}
