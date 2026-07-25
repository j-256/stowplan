import {
  authenticate,
  isTrustedMutation,
} from "../../../../src/server/auth";
import { guestInvitationUrl } from "../../../../src/domain/app-url";
import {
  ApiProblem,
} from "../../../../src/server/api-problem";
import {
  accountScopedJson,
  requireExpectedAccount,
} from "../../../../src/server/account-context";
import {
  readJsonRequest,
  WORKSPACE_ACCESS_REQUEST_MAX_BYTES,
} from "../../../../src/server/request-body";
import { runtimeEnv } from "../../../../src/server/runtime";
import { GUEST_LINK_EXPIRY_HOURS } from "../../../../src/shared/api-quotas";
import {
  createWorkspaceGuestLink,
  getWorkspaceAccess,
  workspaceAccessErrorResponse,
} from "../../../../src/server/workspace-access";

interface GuestLinkInput {
  hours: number;
  returnTo?: string;
  role: "editor" | "viewer";
  workspaceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseGuestLinkInput(value: unknown): GuestLinkInput {
  if (!isRecord(value)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The request body must be a JSON object",
      400,
    );
  }
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "workspaceId must be a non-empty string",
      400,
    );
  }
  const role = value.role ?? "editor";
  if (role !== "editor" && role !== "viewer") {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "role must be editor or viewer",
      400,
    );
  }
  const hours = value.hours ?? GUEST_LINK_EXPIRY_HOURS.default;
  if (
    typeof hours !== "number"
    || !Number.isSafeInteger(hours)
    || hours < GUEST_LINK_EXPIRY_HOURS.minimum
    || hours > GUEST_LINK_EXPIRY_HOURS.maximum
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `hours must be an integer from ${GUEST_LINK_EXPIRY_HOURS.minimum} through ${GUEST_LINK_EXPIRY_HOURS.maximum}`,
      400,
    );
  }
  if (value.returnTo !== undefined && typeof value.returnTo !== "string") {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "returnTo must be a string",
      400,
    );
  }
  return {
    hours,
    returnTo: value.returnTo as string | undefined,
    role,
    workspaceId: value.workspaceId,
  };
}

function workspaceAccessRevision(value: unknown): number {
  if (
    !isRecord(value)
    || typeof value.accessRevision !== "number"
    || !Number.isSafeInteger(value.accessRevision)
    || value.accessRevision < 0
  ) {
    throw new ApiProblem(
      "INTERNAL_ERROR",
      "Workspace access could not be loaded",
      500,
    );
  }
  return value.accessRevision;
}

export async function POST(request: Request) {
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
    const user = await authenticate(env.DB, request);
    if (!user) {
      throw new ApiProblem(
        "AUTHENTICATION_REQUIRED",
        "Authentication required",
        401,
      );
    }
    requireExpectedAccount(request, user.userId);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "Content-Type must be application/json",
        415,
      );
    }
    const body = parseGuestLinkInput(await readJsonRequest<unknown>(
      request,
      WORKSPACE_ACCESS_REQUEST_MAX_BYTES,
    ));
    const access = await getWorkspaceAccess(
      env.DB,
      body.workspaceId,
      user.userId,
    );
    const link = await createWorkspaceGuestLink(
      env.DB,
      body.workspaceId,
      user.userId,
      {
        expectedAccessRevision: workspaceAccessRevision(access.access),
        expiresInHours: body.hours,
        returnTo: body.returnTo,
        role: body.role,
      },
    );
    const base = env.AUTH_BASE_URL ?? request.url;
    const url = guestInvitationUrl(base, link.raw, link.returnTo);
    return accountScopedJson(
      { url, expiresAt: link.guestLink.expiresAt },
      user.userId,
      { status: 201 },
    );
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
