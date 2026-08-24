import { describe, expect, it, vi } from "vitest";
import {
  boundedRetryDelay,
  MAXIMUM_TIMER_DELAY_MS,
  parseRetryAfter,
  retryWakeDelay,
  runWithConcurrency,
} from "../src/client/sync-scheduling";

describe("sync scheduling", () => {
  it("parses the full Retry-After floor from seconds and dates", () => {
    const now = Date.parse("2026-07-26T12:00:00.000Z");

    expect(parseRetryAfter("15", now)).toBe(15_000);
    expect(parseRetryAfter("2592000", now)).toBe(
      30 * 24 * 60 * 60 * 1_000,
    );
    expect(parseRetryAfter(
      "Sun, 26 Jul 2026 12:00:30 GMT",
      now,
    )).toBe(30_000);
    expect(parseRetryAfter("-1", now)).toBeNull();
    expect(parseRetryAfter("invalid", now)).toBeNull();
    expect(parseRetryAfter("9007199254741", now)).toBeNull();
    expect(parseRetryAfter(
      "Sun, 26 Jul 2026 11:59:00 GMT",
      now,
    )).toBe(0);
  });

  it("uses full jitter without retrying before the server deadline", () => {
    expect(boundedRetryDelay(0, null, () => 0.5)).toBe(2_500);
    expect(boundedRetryDelay(2, null, () => 0.5)).toBe(10_000);
    expect(boundedRetryDelay(2, 18_000, () => 0.1)).toBe(20_000);
    expect(boundedRetryDelay(99, null, () => 1)).toBe(300_000);
    expect(boundedRetryDelay(Number.NaN, null, () => 0.5)).toBe(2_500);
    expect(boundedRetryDelay(2, 299_000, () => 0.5)).toBe(309_000);
    expect(boundedRetryDelay(
      2,
      30 * 24 * 60 * 60 * 1_000,
      () => 0.5,
    )).toBe(30 * 24 * 60 * 60 * 1_000 + 10_000);
  });

  it("arms long retry floors in safe timer slices", () => {
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    const notBefore = now + 30 * 24 * 60 * 60 * 1_000;

    expect(retryWakeDelay(notBefore, now)).toBe(
      MAXIMUM_TIMER_DELAY_MS,
    );
    expect(retryWakeDelay(
      notBefore,
      now + MAXIMUM_TIMER_DELAY_MS,
    )).toBe(
      notBefore - now - MAXIMUM_TIMER_DELAY_MS,
    );
    expect(retryWakeDelay(notBefore, notBefore - 0.25)).toBe(1);
    expect(retryWakeDelay(notBefore, notBefore)).toBe(0);
  });

  it("runs reconciliation with a fixed concurrency ceiling", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const task = vi.fn(async (value: number) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value * 2;
    });
    const operation = runWithConcurrency([1, 2, 3, 4, 5], 2, task);

    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(4));
    releases.shift()?.();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(5));
    while (releases.length) releases.shift()?.();

    await expect(operation).resolves.toEqual([2, 4, 6, 8, 10]);
    expect(maximum).toBe(2);
  });

  it("rejects invalid concurrency without invoking work", async () => {
    const task = vi.fn();

    await expect(runWithConcurrency([1], 0, task)).rejects.toThrow(
      "Concurrency must be a positive integer",
    );
    expect(task).not.toHaveBeenCalled();
  });
});
