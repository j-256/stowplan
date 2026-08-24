import { afterEach, describe, expect, it } from "vitest";
import { GET as getAccountSessions } from "../app/api/auth/sessions/route";
import { DELETE as deleteAccountSession } from "../app/api/auth/sessions/[sessionId]/route";
import { POST as postLogout } from "../app/api/auth/logout/route";
import {
  createOrLinkUser,
  issueSession,
} from "../src/server/auth";
import type { RuntimeEnv } from "../src/server/runtime";
import { ACCOUNT_CONTEXT_HEADER } from "../src/shared/account-context";
import { TEST_AUTH_ENV } from "./helpers/auth";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

const runtimeGlobal = globalThis as typeof globalThis & {
  __STOWPLAN_ENV?: RuntimeEnv;
};

afterEach(() => {
  delete runtimeGlobal.__STOWPLAN_ENV;
});

async function routeFixture() {
  const { database, sqlite } = numberedMigrationDatabase();
  runtimeGlobal.__STOWPLAN_ENV = {
    ...TEST_AUTH_ENV,
    AUTH_BASE_URL: "https://stowplan.test",
    DB: database,
  };
  const owner = await createOrLinkUser(database, TEST_AUTH_ENV, {
    displayName: "Session route owner",
    email: "session-route-owner@example.test",
    provider: "test",
    subject: "session-route-owner",
  });
  const outsider = await createOrLinkUser(database, TEST_AUTH_ENV, {
    displayName: "Session route outsider",
    email: "session-route-outsider@example.test",
    provider: "test",
    subject: "session-route-outsider",
  });
  const current = await issueSession(
    database,
    runtimeGlobal.__STOWPLAN_ENV,
    owner,
    new Request("https://stowplan.test/sign-in"),
  );
  const other = await issueSession(
    database,
    runtimeGlobal.__STOWPLAN_ENV,
    owner,
    new Request("https://stowplan.test/sign-in"),
  );
  const outsiderSession = await issueSession(
    database,
    runtimeGlobal.__STOWPLAN_ENV,
    outsider,
    new Request("https://stowplan.test/sign-in"),
  );
  return {
    cookie: `__Host-stowplan_session=${current.raw}`,
    current,
    database,
    other,
    outsiderSession,
    owner,
    sqlite,
  };
}

function accountHeaders(
  cookie: string,
  accountId: string,
  initial: HeadersInit = {},
): Headers {
  return new Headers({
    [ACCOUNT_CONTEXT_HEADER]: accountId,
    cookie,
    ...Object.fromEntries(new Headers(initial)),
  });
}

function revokeRequest(
  sessionId: string,
  cookie: string,
  accountId: string,
  options: {
    body?: string;
    origin?: string;
  } = {},
) {
  return deleteAccountSession(
    new Request(
      `https://stowplan.test/api/auth/sessions/${sessionId}`,
      {
        ...(options.body === undefined ? {} : { body: options.body }),
        headers: accountHeaders(cookie, accountId, {
          origin: options.origin ?? "https://stowplan.test",
        }),
        method: "DELETE",
      },
    ),
    { params: Promise.resolve({ sessionId }) },
  );
}

describe("account session routes", () => {
  it("returns an uncached account-scoped session list", async () => {
    const fixture = await routeFixture();
    const response = await getAccountSessions(new Request(
      "https://stowplan.test/api/auth/sessions?limit=1",
      {
        headers: accountHeaders(
          fixture.cookie,
          fixture.owner.userId,
        ),
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.owner.userId,
    );
    await expect(response.json()).resolves.toMatchObject({
      currentSession: {
        current: true,
        id: fixture.current.sessionId,
      },
      otherSessions: [{
        current: false,
        id: fixture.other.sessionId,
      }],
      page: {
        hasMore: false,
        limit: 1,
        nextCursor: null,
      },
    });
  });

  it("requires authentication and an exact account context", async () => {
    const fixture = await routeFixture();
    const anonymous = await getAccountSessions(new Request(
      "https://stowplan.test/api/auth/sessions",
    ));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    await expect(anonymous.json()).resolves.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });

    const missingContext = await getAccountSessions(new Request(
      "https://stowplan.test/api/auth/sessions",
      { headers: { cookie: fixture.cookie } },
    ));
    expect(missingContext.status).toBe(409);
    expect(missingContext.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.owner.userId,
    );
    await expect(missingContext.json()).resolves.toMatchObject({
      code: "ACCOUNT_CONTEXT_CHANGED",
    });

    const staleContext = await getAccountSessions(new Request(
      "https://stowplan.test/api/auth/sessions",
      {
        headers: accountHeaders(
          fixture.cookie,
          "usr_previous_account",
        ),
      },
    ));
    expect(staleContext.status).toBe(409);
    expect(staleContext.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.owner.userId,
    );
  });

  it("revokes another own session without clearing the current cookie", async () => {
    const fixture = await routeFixture();
    const response = await revokeRequest(
      fixture.other.sessionId,
      fixture.cookie,
      fixture.owner.userId,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(ACCOUNT_CONTEXT_HEADER)).toBe(
      fixture.owner.userId,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      current: false,
      revoked: true,
      sessionId: fixture.other.sessionId,
    });

    const repeated = await revokeRequest(
      fixture.other.sessionId,
      fixture.cookie,
      fixture.owner.userId,
    );
    expect(repeated.status).toBe(409);
    expect(repeated.headers.get("cache-control")).toBe("no-store");
    await expect(repeated.json()).resolves.toMatchObject({
      error: "The session is already revoked",
      status: "revoked",
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
       WHERE action='session.revoke' AND target_id=?`,
    ).get(fixture.other.sessionId)).toEqual({ count: 1 });
  });

  it("clears the cookie when the caller revokes the current session", async () => {
    const fixture = await routeFixture();
    const response = await revokeRequest(
      fixture.current.sessionId,
      fixture.cookie,
      fixture.owner.userId,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-stowplan_session=",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(response.json()).resolves.toMatchObject({
      current: true,
      revoked: true,
    });
  });

  it("does not expose or revoke another account's session", async () => {
    const fixture = await routeFixture();
    const response = await revokeRequest(
      fixture.outsiderSession.sessionId,
      fixture.cookie,
      fixture.owner.userId,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      error: "The session was not found or is not accessible",
    });
    expect(fixture.sqlite.prepare(
      "SELECT revoked_at FROM sessions WHERE session_id=?",
    ).get(fixture.outsiderSession.sessionId)).toEqual({
      revoked_at: null,
    });
  });

  it("rejects cross-origin and body-bearing revocations before mutation", async () => {
    const fixture = await routeFixture();
    const crossOrigin = await revokeRequest(
      fixture.other.sessionId,
      fixture.cookie,
      fixture.owner.userId,
      { origin: "https://evil.test" },
    );
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("cache-control")).toBe("no-store");
    await expect(crossOrigin.json()).resolves.toMatchObject({
      code: "CROSS_ORIGIN_DENIED",
    });

    const bodyBearing = await revokeRequest(
      fixture.other.sessionId,
      fixture.cookie,
      fixture.owner.userId,
      { body: "{}" },
    );
    expect(bodyBearing.status).toBe(400);
    expect(bodyBearing.headers.get("cache-control")).toBe("no-store");
    await expect(bodyBearing.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
      error: "Session revocation does not accept a request body",
    });
    expect(fixture.sqlite.prepare(
      "SELECT revoked_at FROM sessions WHERE session_id=?",
    ).get(fixture.other.sessionId)).toEqual({
      revoked_at: null,
    });
  });

  it("keeps logout idempotent while auditing an active current session", async () => {
    const fixture = await routeFixture();
    const request = () => new Request(
      "https://stowplan.test/api/auth/logout",
      {
        headers: {
          cookie: fixture.cookie,
          origin: "https://stowplan.test",
        },
        method: "POST",
      },
    );
    const response = await postLogout(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(fixture.sqlite.prepare(
      `SELECT detail_json FROM auth_audit_events
       WHERE action='session.revoke' AND target_id=?`,
    ).get(fixture.current.sessionId)).toEqual({
      detail_json: JSON.stringify({ source: "logout" }),
    });

    const repeated = await postLogout(request());
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({ ok: true });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
       WHERE action='session.revoke' AND target_id=?`,
    ).get(fixture.current.sessionId)).toEqual({ count: 1 });
  });
});
