export const CONTROL_REQUEST_MAX_BYTES = 256 * 1024;
export const ACCOUNT_DELETION_REQUEST_MAX_BYTES = 4 * 1024;
export const INVITATION_REQUEST_MAX_BYTES = 4 * 1024;
export const WORKSPACE_ACCESS_REQUEST_MAX_BYTES = 32 * 1024;
export const SNAPSHOT_REQUEST_MAX_BYTES = 8 * 1024 * 1024;
export const SYNC_REQUEST_MAX_BYTES = 8 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly status = 413;

  constructor(maximumBytes: number) {
    super(`Request body exceeds the ${maximumBytes}-byte limit`);
    this.name = "RequestBodyTooLargeError";
  }
}

function declaredLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

export async function readTextRequest(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  const length = declaredLength(request);
  if (length !== null && length > maximumBytes) {
    throw new RequestBodyTooLargeError(maximumBytes);
  }

  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("Request body is empty");

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError(maximumBytes);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SyntaxError("Request body is not valid UTF-8");
  }
}

export async function readJsonRequest<T>(
  request: Request,
  maximumBytes: number,
): Promise<T> {
  const text = await readTextRequest(request, maximumBytes);
  return JSON.parse(text) as T;
}
