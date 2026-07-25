export const ACCOUNT_CONTEXT_HEADER = "x-stowplan-account-id";

export function accountContextHeaders(
  accountId: string,
  initial?: HeadersInit,
): Headers {
  const headers = new Headers(initial);
  headers.set(ACCOUNT_CONTEXT_HEADER, accountId);
  return headers;
}

export function responseMatchesAccount(
  response: Response,
  accountId: string,
): boolean {
  return response.headers.get(ACCOUNT_CONTEXT_HEADER) === accountId;
}
