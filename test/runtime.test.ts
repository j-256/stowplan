import { afterEach, describe, expect, it } from "vitest";
import { runtimeEnv, type RuntimeEnv } from "../src/server/runtime";

const runtimeGlobal = globalThis as typeof globalThis & { __STOWPLAN_ENV?: RuntimeEnv };
const originalBaseUrl = process.env.AUTH_BASE_URL;

afterEach(() => {
  delete runtimeGlobal.__STOWPLAN_ENV;
  if (originalBaseUrl === undefined) delete process.env.AUTH_BASE_URL;
  else process.env.AUTH_BASE_URL = originalBaseUrl;
});

describe("runtime environment", () => {
  it("uses an explicitly injected adapter environment", async () => {
    runtimeGlobal.__STOWPLAN_ENV = {
      AUTH_BASE_URL: "https://injected.example.test",
    };
    await expect(runtimeEnv()).resolves.toMatchObject({
      AUTH_BASE_URL: "https://injected.example.test",
    });
  });

  it("catches a missing asynchronous OpenNext context and falls back to process.env", async () => {
    process.env.AUTH_BASE_URL = "https://node.example.test";
    await expect(runtimeEnv()).resolves.toMatchObject({
      AUTH_BASE_URL: "https://node.example.test",
    });
  });
});
