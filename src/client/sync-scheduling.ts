export const DEFAULT_SYNC_RETRY_BASE_MS = 5_000;
export const MAXIMUM_SYNC_RETRY_MS = 5 * 60 * 1_000;
export const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;

const MAXIMUM_SAFE_RETRY_AFTER_SECONDS = Math.floor(
  Number.MAX_SAFE_INTEGER / 1_000,
);

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) &&
        seconds <= MAXIMUM_SAFE_RETRY_AFTER_SECONDS
      ? seconds * 1_000
      : null;
  }
  if (/^[+-]?\d+$/u.test(normalized)) return null;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return null;
  return Math.max(0, timestamp - now);
}

export function boundedRetryDelay(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const normalizedAttempt = Number.isFinite(attempt) ? attempt : 0;
  const boundedAttempt = Math.max(
    0,
    Math.min(30, Math.floor(normalizedAttempt)),
  );
  const exponential = Math.min(
    MAXIMUM_SYNC_RETRY_MS,
    DEFAULT_SYNC_RETRY_BASE_MS * 2 ** boundedAttempt,
  );
  const serverFloor = typeof retryAfterMs === "number" &&
      Number.isFinite(retryAfterMs)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, retryAfterMs))
    : 0;
  const randomFraction = Math.min(1, Math.max(0, random()));
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    serverFloor + Math.floor(
      randomFraction * exponential,
    ),
  );
}

export function retryWakeDelay(
  notBefore: number,
  now = Date.now(),
): number {
  if (!Number.isFinite(notBefore) || !Number.isFinite(now)) return 0;
  return Math.min(
    MAXIMUM_TIMER_DELAY_MS,
    Math.max(0, Math.ceil(notBefore - now)),
  );
}

export async function runWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index] as T, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      worker,
    ),
  );
  return results;
}
