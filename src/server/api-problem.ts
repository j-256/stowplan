export type ApiProblemCode =
  | "ACCOUNT_CONTEXT_CHANGED"
  | "ACCESS_STALE"
  | "AUTHENTICATION_REQUIRED"
  | "BODY_TOO_LARGE"
  | "CONFIRMATION_REQUIRED"
  | "CROSS_ORIGIN_DENIED"
  | "FINAL_OWNER_REQUIRED"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST"
  | "MEMBERSHIP_REQUIRED"
  | "NOT_FOUND_OR_INACCESSIBLE"
  | "OWNER_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "ROLE_UNCHANGED"
  | "STORAGE_UNAVAILABLE"
  | "WORKSPACE_BUSY"
  | "WORKSPACE_DELETED"
  | "WRITE_ACCESS_REQUIRED";

export interface ApiProblemBody {
  code: ApiProblemCode | string;
  error: string;
  [key: string]: unknown;
}

export class ApiProblem extends Error {
  readonly code: ApiProblemCode;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly status: number;

  constructor(
    code: ApiProblemCode,
    message: string,
    status: number,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApiProblem";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export function privateJson(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

export function apiProblemResponse(error: ApiProblem): Response {
  return privateJson(
    {
      code: error.code,
      error: error.message,
      ...error.detail,
    } satisfies ApiProblemBody,
    { status: error.status },
  );
}

export function internalProblemResponse(
  message = "The request could not be completed",
): Response {
  return apiProblemResponse(
    new ApiProblem("INTERNAL_ERROR", message, 500),
  );
}
