import {
  ACCOUNT_CONTEXT_HEADER,
} from "../shared/account-context";
import {
  ApiProblem,
  privateJson,
} from "./api-problem";

export function requireExpectedAccount(
  request: Request,
  authenticatedAccountId: string,
): void {
  if (
    request.headers.get(ACCOUNT_CONTEXT_HEADER) !==
      authenticatedAccountId
  ) {
    throw new ApiProblem(
      "ACCOUNT_CONTEXT_CHANGED",
      "The signed-in account changed; refresh before continuing",
      409,
    );
  }
}

export function accountScopedJson(
  body: unknown,
  accountId: string,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set(ACCOUNT_CONTEXT_HEADER, accountId);
  return privateJson(body, { ...init, headers });
}

export function withAccountContext(
  response: Response,
  accountId: string | null,
): Response {
  if (accountId) {
    response.headers.set(ACCOUNT_CONTEXT_HEADER, accountId);
  }
  return response;
}
