import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSessions } from "../src/client/account-sessions";
import {
  listAccountSessions,
  revokeAccountSession,
} from "../src/server/account-sessions";
import {
  authenticate,
  createOrLinkUser,
  issueSession,
  SESSION_ACTIVITY_TOUCH_INTERVAL_MS,
} from "../src/server/auth";
import {
  applySqlDirectory,
  numberedMigrationDatabase,
  sqliteD1Database,
} from "./helpers/sqlite-d1";

function authenticatedRequest(raw: string): Request {
  return new Request("https://stowplan.test/api/auth/sessions", {
    headers: { cookie: `stowplan_session=${raw}` },
  });
}

function sitesDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  applySqlDirectory(sqlite, new URL("../drizzle/", import.meta.url));
  return { database: sqliteD1Database(sqlite), sqlite };
}

async function userFixture(
  database: ReturnType<typeof numberedMigrationDatabase>["database"],
  subject: string,
) {
  return createOrLinkUser(database, {}, {
    displayName: subject,
    email: `${subject}@example.test`,
    provider: "test",
    subject,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("account sessions", () => {
  it("keeps sign-out available while session inventory is loading", () => {
    const markup = renderToStaticMarkup(createElement(AccountSessions, {
      accountId: "usr_loading",
      onSignOut: async () => null,
    }));

    expect(markup).toContain("Loading sessions...");
    expect(markup).toContain(">Sign out this session</button>");
  });

  it("lists and revokes sessions through numbered and Sites schemas", async () => {
    for (const [index, fixture] of [
      numberedMigrationDatabase(),
      sitesDatabase(),
    ].entries()) {
      const owner = await userFixture(
        fixture.database,
        `session-stream-owner-${index}`,
      );
      const current = await issueSession(
        fixture.database,
        {},
        owner,
        new Request("https://stowplan.test/sign-in"),
      );
      const other = await issueSession(
        fixture.database,
        {},
        owner,
        new Request("https://stowplan.test/sign-in"),
      );
      const principal = await authenticate(
        fixture.database,
        authenticatedRequest(current.raw),
      );

      await expect(listAccountSessions(
        fixture.database,
        principal!,
        new URLSearchParams(),
      )).resolves.toMatchObject({
        currentSession: { id: current.sessionId },
        otherSessions: [{ id: other.sessionId }],
      });
      await expect(revokeAccountSession(
        fixture.database,
        principal!,
        other.sessionId,
      )).resolves.toMatchObject({
        revoked: true,
        sessionId: other.sessionId,
      });
      expect(fixture.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM auth_audit_events
         WHERE action='session.revoke' AND target_id=?`,
      ).get(other.sessionId)).toEqual({ count: 1 });
    }
  });

  it("lists only the caller's current and retained sessions with stable pagination", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await userFixture(database, "session-list-owner");
    const outsider = await userFixture(database, "session-list-outsider");
    const current = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in", {
        headers: {
          "cf-connecting-ip": "192.0.2.41",
          "user-agent": "Current browser",
        },
      }),
    );
    const retained = await Promise.all([
      issueSession(database, {}, owner, new Request(
        "https://stowplan.test/sign-in",
      )),
      issueSession(database, {}, owner, new Request(
        "https://stowplan.test/sign-in",
      )),
      issueSession(database, {}, owner, new Request(
        "https://stowplan.test/sign-in",
      )),
    ]);
    const outsiderSession = await issueSession(
      database,
      {},
      outsider,
      new Request("https://stowplan.test/sign-in"),
    );
    const timestamps = [
      "2026-07-25T03:00:00.000Z",
      "2026-07-25T02:00:00.000Z",
      "2026-07-25T01:00:00.000Z",
    ];
    for (const [index, session] of retained.entries()) {
      sqlite.prepare(
        `UPDATE sessions
         SET created_at=?,last_seen_at=?,user_agent=?,ip_prefix=?
         WHERE session_id=?`,
      ).run(
        timestamps[index],
        timestamps[index],
        index === 0 ? "Desktop\u0007 browser" : null,
        index === 0 ? "private ip value" : null,
        session.sessionId,
      );
    }
    const principal = await authenticate(
      database,
      authenticatedRequest(current.raw),
    );
    expect(principal).not.toBeNull();

    const first = await listAccountSessions(
      database,
      principal!,
      new URLSearchParams({ limit: "2" }),
    );

    expect(first.currentSession).toMatchObject({
      current: true,
      id: current.sessionId,
      ipPrefix: "192.0.2.0/24",
      status: "active",
      userAgent: "Current browser",
    });
    expect(first.otherSessions.map(session => session.id)).toEqual([
      retained[0].sessionId,
      retained[1].sessionId,
    ]);
    expect(first.otherSessions[0]).toMatchObject({
      ipPrefix: null,
      userAgent: "Desktop  browser",
    });
    expect(first.page).toMatchObject({
      hasMore: true,
      limit: 2,
    });
    expect(first.page.nextCursor).toEqual(expect.any(String));

    const second = await listAccountSessions(
      database,
      principal!,
      new URLSearchParams({
        cursor: first.page.nextCursor!,
        limit: "2",
      }),
    );
    expect(second.otherSessions.map(session => session.id)).toEqual([
      retained[2].sessionId,
    ]);
    expect(second.page).toEqual({
      hasMore: false,
      limit: 2,
      nextCursor: null,
    });
    expect([
      ...first.otherSessions,
      ...second.otherSessions,
    ].map(session => session.id)).not.toContain(outsiderSession.sessionId);

    const outsiderPrincipal = await authenticate(
      database,
      authenticatedRequest(outsiderSession.raw),
    );
    await expect(listAccountSessions(
      database,
      outsiderPrincipal!,
      new URLSearchParams({
        cursor: first.page.nextCursor!,
        limit: "2",
      }),
    )).rejects.toMatchObject({
      message: "The cursor is invalid",
      status: 400,
    });
    expect(JSON.stringify(first)).not.toContain("token_hash");
    expect(JSON.stringify(first)).not.toContain(current.raw);
  });

  it("advances session and user activity monotonically at the touch interval", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T00:00:00.000Z"));
    const owner = await userFixture(database, "session-touch-owner");
    const session = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const stale = "2026-07-24T00:00:00.000Z";
    sqlite.prepare(
      "UPDATE sessions SET last_seen_at=? WHERE session_id=?",
    ).run(stale, session.sessionId);
    sqlite.prepare(
      "UPDATE users SET last_seen_at=? WHERE user_id=?",
    ).run(stale, owner.userId);
    const request = authenticatedRequest(session.raw);

    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    await expect(authenticate(database, request)).resolves.toMatchObject({
      sessionId: session.sessionId,
      userId: owner.userId,
    });
    const firstTouch = "2026-07-25T01:00:00.000Z";
    expect(sqlite.prepare(
      `SELECT session.last_seen_at AS session_seen,
              user.last_seen_at AS user_seen
       FROM sessions session
       JOIN users user ON user.user_id=session.user_id
       WHERE session.session_id=?`,
    ).get(session.sessionId)).toEqual({
      session_seen: firstTouch,
      user_seen: firstTouch,
    });

    vi.advanceTimersByTime(SESSION_ACTIVITY_TOUCH_INTERVAL_MS - 1);
    await authenticate(database, request);
    expect(sqlite.prepare(
      "SELECT last_seen_at FROM sessions WHERE session_id=?",
    ).get(session.sessionId)).toEqual({ last_seen_at: firstTouch });

    vi.advanceTimersByTime(1);
    await authenticate(database, request);
    expect(sqlite.prepare(
      "SELECT last_seen_at FROM sessions WHERE session_id=?",
    ).get(session.sessionId)).toEqual({
      last_seen_at: "2026-07-25T01:05:00.000Z",
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
       WHERE action='session.issue'`,
    ).get()).toEqual({ count: 1 });
  });

  it("keeps valid authentication available when activity telemetry fails", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await userFixture(database, "session-touch-failure");
    const session = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const stale = "2026-07-24T00:00:00.000Z";
    sqlite.prepare(
      "UPDATE sessions SET last_seen_at=? WHERE session_id=?",
    ).run(stale, session.sessionId);
    sqlite.prepare(
      "UPDATE users SET last_seen_at=? WHERE user_id=?",
    ).run(stale, owner.userId);
    const unavailableTelemetry = {
      batch: async () => {
        throw new Error("injected activity telemetry failure");
      },
      prepare: (query: string) => database.prepare(query),
    };

    await expect(authenticate(
      unavailableTelemetry,
      authenticatedRequest(session.raw),
    )).resolves.toMatchObject({
      sessionId: session.sessionId,
      userId: owner.userId,
    });
    expect(sqlite.prepare(
      "SELECT last_seen_at FROM sessions WHERE session_id=?",
    ).get(session.sessionId)).toEqual({ last_seen_at: stale });
  });

  it("revokes another own session exactly once without affecting the caller", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await userFixture(database, "session-revoke-owner");
    const outsider = await userFixture(database, "session-revoke-outsider");
    const current = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const target = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const outsiderSession = await issueSession(
      database,
      {},
      outsider,
      new Request("https://stowplan.test/sign-in"),
    );
    const principal = await authenticate(
      database,
      authenticatedRequest(current.raw),
    );

    await expect(revokeAccountSession(
      database,
      principal!,
      target.sessionId,
    )).resolves.toMatchObject({
      current: false,
      revoked: true,
      sessionId: target.sessionId,
    });
    await expect(authenticate(
      database,
      authenticatedRequest(target.raw),
    )).resolves.toBeNull();
    await expect(authenticate(
      database,
      authenticatedRequest(current.raw),
    )).resolves.toMatchObject({ userId: owner.userId });
    await expect(revokeAccountSession(
      database,
      principal!,
      target.sessionId,
    )).rejects.toMatchObject({
      message: "The session is already revoked",
      status: 409,
    });
    await expect(revokeAccountSession(
      database,
      principal!,
      outsiderSession.sessionId,
    )).rejects.toMatchObject({
      code: "NOT_FOUND_OR_INACCESSIBLE",
      status: 404,
    });
    expect(sqlite.prepare(
      `SELECT actor_user_id,detail_json,target_id
       FROM auth_audit_events
       WHERE action='session.revoke'`,
    ).all()).toEqual([{
      actor_user_id: owner.userId,
      detail_json: JSON.stringify({ source: "account" }),
      target_id: target.sessionId,
    }]);
  });

  it("lets only one concurrent revocation commit and audit", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await userFixture(database, "session-race-owner");
    const current = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const target = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const principal = await authenticate(
      database,
      authenticatedRequest(current.raw),
    );

    const results = await Promise.allSettled([
      revokeAccountSession(database, principal!, target.sessionId),
      revokeAccountSession(database, principal!, target.sessionId),
    ]);

    expect(results.filter(result => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
       WHERE action='session.revoke' AND target_id=?`,
    ).get(target.sessionId)).toEqual({ count: 1 });
  });

  it("rolls back session issue and revocation when audit insertion fails", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await userFixture(database, "session-audit-owner");
    sqlite.exec(
      `CREATE TRIGGER reject_session_issue_audit
       BEFORE INSERT ON auth_audit_events
       WHEN NEW.action='session.issue'
       BEGIN
         SELECT RAISE(ABORT, 'injected session issue audit failure');
       END`,
    );
    await expect(issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    )).rejects.toThrow(/injected session issue audit failure/);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id=?",
    ).get(owner.userId)).toEqual({ count: 0 });
    sqlite.exec("DROP TRIGGER reject_session_issue_audit");

    const current = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const target = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const principal = await authenticate(
      database,
      authenticatedRequest(current.raw),
    );
    sqlite.exec(
      `CREATE TRIGGER reject_session_revoke_audit
       BEFORE INSERT ON auth_audit_events
       WHEN NEW.action='session.revoke'
       BEGIN
         SELECT RAISE(ABORT, 'injected session revoke audit failure');
       END`,
    );

    await expect(revokeAccountSession(
      database,
      principal!,
      target.sessionId,
    )).rejects.toThrow(/injected session revoke audit failure/);
    await expect(authenticate(
      database,
      authenticatedRequest(target.raw),
    )).resolves.toMatchObject({ userId: owner.userId });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
       WHERE action='session.revoke'`,
    ).get()).toEqual({ count: 0 });
  });

  it("revokes the current session with an audited logout source", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await userFixture(database, "session-current-owner");
    const current = await issueSession(
      database,
      {},
      owner,
      new Request("https://stowplan.test/sign-in"),
    );
    const principal = await authenticate(
      database,
      authenticatedRequest(current.raw),
    );

    await expect(revokeAccountSession(
      database,
      principal!,
      current.sessionId,
      "logout",
    )).resolves.toMatchObject({
      current: true,
      revoked: true,
    });
    await expect(authenticate(
      database,
      authenticatedRequest(current.raw),
    )).resolves.toBeNull();
    expect(sqlite.prepare(
      `SELECT detail_json FROM auth_audit_events
       WHERE action='session.revoke' AND target_id=?`,
    ).get(current.sessionId)).toEqual({
      detail_json: JSON.stringify({ source: "logout" }),
    });
  });
});
