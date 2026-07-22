import { afterEach, describe, expect, it } from "vitest";
import { runtimeEnv, type RuntimeEnv } from "../src/server/runtime";

const runtimeGlobal = globalThis as typeof globalThis & { __STOWPLAN_ENV?: RuntimeEnv };
const originalAdminEmails = process.env.AUTH_ADMIN_EMAILS;

afterEach(() => {
  delete runtimeGlobal.__STOWPLAN_ENV;
  if (originalAdminEmails === undefined) delete process.env.AUTH_ADMIN_EMAILS;
  else process.env.AUTH_ADMIN_EMAILS = originalAdminEmails;
});

describe("runtime environment", () => {
  it("uses an explicitly injected adapter environment", async () => {
    runtimeGlobal.__STOWPLAN_ENV = { AUTH_ADMIN_EMAILS: "injected@example.test" };
    await expect(runtimeEnv()).resolves.toMatchObject({ AUTH_ADMIN_EMAILS: "injected@example.test" });
  });

  it("catches a missing asynchronous OpenNext context and falls back to process.env", async () => {
    process.env.AUTH_ADMIN_EMAILS = "node@example.test";
    await expect(runtimeEnv()).resolves.toMatchObject({ AUTH_ADMIN_EMAILS: "node@example.test" });
  });
});
