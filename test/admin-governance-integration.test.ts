import { describe, expect, it } from "vitest";
import type { D1DatabaseLike } from
  "../src/adapters/d1-snapshot-store";
import {
  adminMutation,
  adminOverview,
} from "../src/server/admin";
import {
  authenticate,
  createOrLinkUser,
  issueSession,
} from "../src/server/auth";
import {
  CIRCUIT_BREAKER_PAUSE_KIND,
  CIRCUIT_BREAKER_SCOPE,
  CIRCUIT_BREAKER_STATE,
  GOVERNANCE_LIMIT_KEY,
} from "../src/shared/governance-policy";
import {
  TEST_AUTH_ENV,
  TEST_IDENTITY_DIGEST_KEY,
} from "./helpers/auth";
import { numberedMigrationDatabase } from "./helpers/sqlite-d1";

async function createAdmin(database: D1DatabaseLike) {
  const user = await createOrLinkUser(
    database,
    TEST_AUTH_ENV,
    {
      displayName: "Governance administrator",
      email: "governance-admin@example.test",
      provider: "test",
      subject: "governance-admin",
    },
  );
  await database.prepare(
    `UPDATE users
     SET global_role='admin'
     WHERE user_id=?`,
  ).bind(user.userId).run();
  return { ...user, globalRole: "admin" as const };
}

async function accountRevision(
  database: D1DatabaseLike,
  userId: string,
): Promise<number> {
  const row = await database.prepare(
    `SELECT account_revision
     FROM users
     WHERE user_id=?`,
  ).bind(userId).first<{ account_revision: number }>();
  if (!row) throw new Error("Account revision is unavailable");
  return row.account_revision;
}

describe("admin governance integration", () => {
  it("revokes target sessions when assigning global authority", async () => {
    const { database } = numberedMigrationDatabase();
    const actor = await createAdmin(database);
    const target = await createOrLinkUser(
      database,
      TEST_AUTH_ENV,
      {
        displayName: "Promotion target",
        email: "promotion-target@example.test",
        provider: "test",
        subject: "promotion-target",
      },
    );
    const session = await issueSession(
      database,
      TEST_AUTH_ENV,
      target,
      new Request("https://stowplan.test"),
    );

    await expect(adminMutation(database, actor.userId, {
      action: "user.role",
      expectedAccountRevision:
        await accountRevision(database, target.userId),
      targetId: target.userId,
      value: "admin",
    })).resolves.toEqual({
      message: "User role changed to admin",
      revokedSessions: 1,
    });
    await expect(authenticate(
      database,
      new Request("https://stowplan.test", {
        headers: {
          cookie: `__Host-stowplan_session=${session.raw}`,
        },
      }),
    )).resolves.toBeNull();
  });

  it("redacts a ban and exposes only safe enforcement state", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const actor = await createAdmin(database);
    const targetEmail = "abuse-target@example.test";
    const targetSubject = "abuse-target-subject";
    const target = await createOrLinkUser(
      database,
      TEST_AUTH_ENV,
      {
        displayName: "Abuse target",
        email: targetEmail,
        provider: "google",
        subject: targetSubject,
      },
    );
    await issueSession(
      database,
      TEST_AUTH_ENV,
      target,
      new Request("https://stowplan.test"),
    );

    await expect(adminMutation(
      database,
      actor.userId,
      {
        action: "user.ban",
        expectedAccountRevision:
          await accountRevision(database, target.userId),
        reason: "Automated sign-up abuse",
        targetId: target.userId,
      },
      { identityDigestKey: TEST_IDENTITY_DIGEST_KEY },
    )).resolves.toMatchObject({
      message: "Account banned and sign-in identities redacted",
      revokedSessions: 1,
    });
    expect(sqlite.prepare(
      `SELECT display_name,email,status
       FROM users
       WHERE user_id=?`,
    ).get(target.userId)).toMatchObject({
      display_name: "Banned account",
      status: "banned",
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM identities
       WHERE user_id=?`,
    ).get(target.userId)).toEqual({ count: 0 });
    const overview = await adminOverview(database);
    const row = overview.users.find(
      candidate => candidate.user_id === target.userId,
    );
    expect(row).toMatchObject({
      active_identity_ban_count: 1,
      ban_reason: "Automated sign-up abuse",
      display_name: "Banned account",
      retained_identity_ban_count: 1,
      status: "banned",
    });
    expect(JSON.stringify(row)).not.toContain(targetEmail);
    expect(JSON.stringify(row)).not.toContain(targetSubject);

    await expect(adminMutation(database, actor.userId, {
      action: "user.ban.lift",
      expectedAccountRevision:
        await accountRevision(database, target.userId),
      targetId: target.userId,
    })).resolves.toEqual({
      message: "Account ban lifted; the account remains disabled",
    });
    expect((await adminOverview(database)).users.find(
      candidate => candidate.user_id === target.userId,
    )).toMatchObject({
      active_identity_ban_count: 0,
      retained_identity_ban_count: 1,
      status: "disabled",
    });
  });

  it("controls only named public breakers and governance limits", async () => {
    const { database } = numberedMigrationDatabase();
    const actor = await createAdmin(database);

    await adminMutation(database, actor.userId, {
      action: "circuit.set",
      pauseKind: CIRCUIT_BREAKER_PAUSE_KIND.SECURITY,
      reason: "Critical abuse alert windows",
      targetId: CIRCUIT_BREAKER_SCOPE.NEW_ACCOUNTS,
      value: CIRCUIT_BREAKER_STATE.PAUSED,
    });
    let overview = await adminOverview(database);
    expect(overview.circuitBreakers.find(
      candidate =>
        candidate.scope === CIRCUIT_BREAKER_SCOPE.NEW_ACCOUNTS,
    )).toMatchObject({
      effectiveState: CIRCUIT_BREAKER_STATE.PAUSED,
      pauseKind: CIRCUIT_BREAKER_PAUSE_KIND.SECURITY,
      state: CIRCUIT_BREAKER_STATE.PAUSED,
      triggerCount: 1,
    });

    await expect(adminMutation(database, actor.userId, {
      action: "governance.limit.set",
      reason: "Lower launch-day exposure",
      targetId: GOVERNANCE_LIMIT_KEY.NEW_ACCOUNTS_PER_DAY,
      value: "42",
    })).resolves.toEqual({
      message: "new_accounts_per_day limit changed to 42",
    });
    overview = await adminOverview(database);
    expect(overview.governanceLimits).toEqual([
      expect.objectContaining({
        key: GOVERNANCE_LIMIT_KEY.NEW_ACCOUNTS_PER_DAY,
        value: 42,
      }),
    ]);
    await expect(adminMutation(database, actor.userId, {
      action: "governance.limit.set",
      reason: "Unknown key probe",
      targetId: "arbitrary_limit",
      value: "1",
    })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
  });
});
