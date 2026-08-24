import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { POST } from "../app/api/auth/dev/route";
import type { RuntimeEnv } from "../src/server/runtime";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

const runtimeGlobal = globalThis as typeof globalThis & {
  __STOWPLAN_ENV?: RuntimeEnv;
};

afterEach(() => {
  delete runtimeGlobal.__STOWPLAN_ENV;
});

function signIn(email: string, name: string): Promise<Response> {
  return POST(new Request(
    "https://stowplan.test/api/auth/dev",
    {
      body: JSON.stringify({ email, name }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
  ));
}

describe("development authentication route", () => {
  it("bootstraps only the deterministic local owner persona", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    runtimeGlobal.__STOWPLAN_ENV = {
      AUTH_BASE_URL: "https://stowplan.test",
      AUTH_DEV_ENABLED: "true",
      AUTH_IDENTITY_DIGEST_KEY:
        "test-identity-digest-key-at-least-32-bytes",
      DB: database,
    };

    const ownerResponse = await signIn(
      "OWNER@example.test",
      "Local owner",
    );
    expect(ownerResponse.status).toBe(200);
    await expect(ownerResponse.json()).resolves.toMatchObject({
      user: {
        email: "owner@example.test",
        globalRole: "admin",
      },
    });
    expect(ownerResponse.headers.get("set-cookie")).toContain(
      "__Host-stowplan_session=",
    );

    const testerResponse = await signIn(
      "guest-persona@example.test",
      "Guest persona",
    );
    expect(testerResponse.status).toBe(200);
    await expect(testerResponse.json()).resolves.toMatchObject({
      user: {
        email: "guest-persona@example.test",
        globalRole: "user",
      },
    });
    expect(sqlite.prepare(
      `SELECT email,global_role
       FROM users
       ORDER BY email`,
    ).all()).toEqual([
      {
        email: "guest-persona@example.test",
        global_role: "user",
      },
      {
        email: "owner@example.test",
        global_role: "admin",
      },
    ]);
  });

  it("refuses non-synthetic email domains", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    runtimeGlobal.__STOWPLAN_ENV = {
      AUTH_BASE_URL: "https://stowplan.test",
      AUTH_DEV_ENABLED: "true",
      AUTH_IDENTITY_DIGEST_KEY:
        "test-identity-digest-key-at-least-32-bytes",
      DB: database,
    };

    const response = await signIn(
      "real-person@example.com",
      "Real person",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_REQUEST",
      error: "Development email must use the @example.test domain",
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM users",
    ).get()).toEqual({ count: 0 });
  });
});
