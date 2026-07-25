import {
  GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS,
  GUEST_INVITATION_TOKEN_MAX_CHARACTERS,
  workspaceReturnTo,
} from "../../../../src/domain/app-url";
import {
  authenticate,
  AuthorizationError,
  consumeGuestLink,
  InvitationError,
  isTrustedMutation,
} from "../../../../src/server/auth";
import {
  accountScopedJson,
  requireExpectedAccount,
  withAccountContext,
} from "../../../../src/server/account-context";
import {
  ApiProblem,
  apiProblemResponse,
  internalProblemResponse,
  privateJson,
} from "../../../../src/server/api-problem";
import {
  QuotaExceededError,
  quotaProblem,
} from "../../../../src/server/quotas";
import {
  INVITATION_REQUEST_MAX_BYTES,
  readJsonRequest,
  RequestBodyTooLargeError,
} from "../../../../src/server/request-body";
import { runtimeEnv } from "../../../../src/server/runtime";

const MAX_EXPECTED_ACCOUNT_ID_LENGTH = 256;

interface GuestConfirmationInput {
  expectedAccountId: string;
  returnTo?: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function parseGuestConfirmation(value: unknown): GuestConfirmationInput {
  if (!isRecord(value)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Invitation confirmation must be a JSON object",
      400,
    );
  }
  if (
    typeof value.token !== "string" ||
    !value.token ||
    value.token.trim() !== value.token ||
    value.token.length > GUEST_INVITATION_TOKEN_MAX_CHARACTERS
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Invitation token is missing or invalid",
      400,
    );
  }
  if (
    typeof value.expectedAccountId !== "string" ||
    !value.expectedAccountId ||
    value.expectedAccountId.length > MAX_EXPECTED_ACCOUNT_ID_LENGTH
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Expected account is missing or invalid",
      400,
    );
  }
  if (
    value.returnTo !== undefined &&
    (
      typeof value.returnTo !== "string" ||
      value.returnTo.length >
        GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS
    )
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Invitation return path is invalid",
      400,
    );
  }
  return {
    expectedAccountId: value.expectedAccountId,
    returnTo: value.returnTo as string | undefined,
    token: value.token,
  };
}

function guestConfirmationErrorResponse(error: unknown): Response {
  if (error instanceof ApiProblem) return apiProblemResponse(error);
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
    return apiProblemResponse(
      new ApiProblem("BODY_TOO_LARGE", error.message, error.status),
    );
  }
  if (error instanceof SyntaxError) {
    return apiProblemResponse(
      new ApiProblem(
        "INVALID_REQUEST",
        "Invitation confirmation JSON is invalid",
        400,
      ),
    );
  }
  return internalProblemResponse(
    "Invitation acceptance could not be completed",
  );
}

export async function POST(request: Request) {
  let authenticatedAccountId: string | null = null;
  try {
    const env = await runtimeEnv();
    if (!isTrustedMutation(request, env.AUTH_BASE_URL)) {
      throw new ApiProblem(
        "CROSS_ORIGIN_DENIED",
        "Cross-origin mutation denied",
        403,
      );
    }
    if (!env.DB) {
      throw new ApiProblem(
        "STORAGE_UNAVAILABLE",
        "Database is not configured",
        503,
      );
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Content-Type must be application/json",
        415,
      );
    }
    const body = parseGuestConfirmation(await readJsonRequest<unknown>(
      request,
      INVITATION_REQUEST_MAX_BYTES,
    ));
    const user = await authenticate(env.DB, request);
    if (!user) {
      throw new ApiProblem(
        "AUTHENTICATION_REQUIRED",
        "Sign in before accepting this invitation",
        401,
      );
    }
    authenticatedAccountId = user.userId;
    requireExpectedAccount(request, user.userId);
    if (body.expectedAccountId !== user.userId) {
      throw new ApiProblem(
        "ACCOUNT_CONTEXT_CHANGED",
        "The signed-in account changed; reload the invitation before accepting",
        409,
      );
    }
    const result = await consumeGuestLink(
      env.DB,
      body.token,
      user.userId,
    );
    return accountScopedJson(
      {
        accepted: true,
        returnTo: workspaceReturnTo(
          body.returnTo,
          result.workspaceId,
        ),
        workspaceId: result.workspaceId,
      },
      user.userId,
    );
  } catch (error) {
    return withAccountContext(
      guestConfirmationErrorResponse(error),
      authenticatedAccountId,
    );
  }
}
