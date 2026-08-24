import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { D1SnapshotStore } from "../src/adapters/d1-snapshot-store";
import { createEmptyState } from "../src/domain/factories";
import {
  accessPrincipalAuditDigest,
  accountCreationRefusal,
  assertIdentityNotBanned,
  banAccount,
  bootstrapGlobalAdmin,
  changeAccountStatus,
  changeGlobalRole,
  executeAccountDeletion,
  identityEnforcementDigest,
  liftAccountBan,
  prepareAccountDeletion,
  readCircuitBreakers,
  readGovernanceLimits,
  redactExpiredRoutineAuditDetails,
  recoverGlobalAdmin,
  sessionIssuanceOutcome,
  setCircuitBreaker,
  setGovernanceLimit,
  snapshotGrowthRefusal,
  workspaceAllocationRefusal,
} from "../src/server/account-governance";
import {
  createGuestLink,
  createOrLinkUser,
  issueSession,
} from "../src/server/auth";
import {
  AUTH_AUDIT_DETAIL_RETENTION_DAYS,
  AUTH_AUDIT_REDACTION_BATCH_SIZE,
  ADMIN_RECOVERY_MODE,
  CIRCUIT_BREAKER_PAUSE_KIND,
  CIRCUIT_BREAKER_SCOPE,
  CIRCUIT_BREAKER_STATE,
  CREATION_LEDGER_ROLLING_RETENTION_DAYS,
  GOVERNANCE_LIMIT_KEY,
  MAXIMUM_GOVERNANCE_LIMIT,
  PUBLIC_LAUNCH_LIMITS,
} from "../src/shared/governance-policy";
import { API_QUOTAS } from "../src/shared/api-quotas";
import {
  initializeOwnedWorkspace,
} from "../src/server/workspace-initialization";
import {
  applySqlDirectory,
  numberedMigrationDatabase,
} from "./helpers/sqlite-d1";
import { TEST_AUTH_ENV } from "./helpers/auth";

const DIGEST_KEY = "test-account-governance-digest-key-material";

async function testUser(
  database: ReturnType<typeof numberedMigrationDatabase>["database"],
  name: string,
) {
  return createOrLinkUser(database, TEST_AUTH_ENV, {
    displayName: name,
    email: `${name}@example.test`,
    provider: "test",
    subject: name,
  });
}

function request(name: string): Request {
  return new Request("https://stowplan.example.test/api/auth/test", {
    headers: { "user-agent": name },
  });
}

describe("account governance", () => {
  it("bootstraps only when no active administrator exists and guards the last admin", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const first = await testUser(database, "bootstrap-first");
    const second = await testUser(database, "bootstrap-second");

    await expect(bootstrapGlobalAdmin(database, first.userId))
      .resolves.toEqual({
        status: "promoted",
        userId: first.userId,
      });
    await expect(bootstrapGlobalAdmin(database, first.userId))
      .resolves.toEqual({
        status: "already-admin",
        userId: first.userId,
      });
    await expect(bootstrapGlobalAdmin(database, second.userId))
      .resolves.toEqual({ status: "active-admin-exists" });

    expect(() => sqlite.prepare(
      `UPDATE users
       SET global_role = 'user'
       WHERE user_id = ?`,
    ).run(first.userId)).toThrow(/last active administrator/u);
    expect(() => sqlite.prepare(
      `UPDATE users
       SET deleted_at = ?
       WHERE user_id = ?`,
    ).run(new Date().toISOString(), first.userId))
      .toThrow(/last active administrator/u);
    const firstPreparation = await prepareAccountDeletion(
      database,
      first.userId,
    );
    await expect(changeGlobalRole(database, {
      actorUserId: first.userId,
      expectedAccountRevision: firstPreparation.accountRevision,
      role: "user",
      targetUserId: first.userId,
    })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT global_role
       FROM users
       WHERE user_id = ?`,
    ).get(first.userId)).toEqual({ global_role: "admin" });
    expect(sqlite.prepare(
      `SELECT action
       FROM auth_audit_events
       WHERE action = 'admin.bootstrap'`,
    ).get()).toEqual({ action: "admin.bootstrap" });
  });

  it("records ban digests, revokes sessions, and rejects the banned identity", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const admin = await testUser(database, "ban-admin");
    const target = await testUser(database, "ban-target");
    expect((await bootstrapGlobalAdmin(database, admin.userId)).status)
      .toBe("promoted");
    await issueSession(database, {}, target, request("target-session"));
    const targetRow = sqlite.prepare(
      `SELECT account_revision
       FROM users
       WHERE user_id = ?`,
    ).get(target.userId) as { account_revision: number };

    const result = await banAccount(database, {
      actorUserId: admin.userId,
      digestKey: DIGEST_KEY,
      expectedAccountRevision: targetRow.account_revision,
      reason: "automated abuse",
      targetUserId: target.userId,
    });

    expect(result.identityDigests).toBe(1);
    expect(result.revokedSessions).toBe(1);
    expect(sqlite.prepare(
      `SELECT
         status,
         display_name,
         email LIKE '%@banned.invalid' AS redacted_email
       FROM users
       WHERE user_id = ?`,
    ).get(target.userId)).toEqual({
      display_name: "Banned account",
      redacted_email: 1,
      status: "banned",
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM identities
       WHERE user_id = ?`,
    ).get(target.userId)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT revoked_at,user_agent
       FROM sessions
       WHERE user_id = ?`,
    ).get(target.userId)).toMatchObject({
      revoked_at: expect.any(String),
      user_agent: null,
    });
    const digest = await identityEnforcementDigest(
      DIGEST_KEY,
      "test",
      "ban-target",
    );
    expect(digest).toMatch(/^v1:[0-9a-f]{64}$/u);
    await expect(assertIdentityNotBanned(database, digest))
      .rejects.toMatchObject({
        code: "ACCOUNT_BANNED",
        status: 403,
      });
  });

  it("keeps redacted accounts disabled and reactivates enforcement on re-ban", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const admin = await testUser(database, "reban-admin");
    const target = await testUser(database, "reban-target");
    expect((await bootstrapGlobalAdmin(database, admin.userId)).status)
      .toBe("promoted");
    const digest = await identityEnforcementDigest(
      DIGEST_KEY,
      "test",
      "reban-target",
    );
    const revision = () => (
      sqlite.prepare(
        `SELECT account_revision
         FROM users
         WHERE user_id = ?`,
      ).get(target.userId) as { account_revision: number }
    ).account_revision;

    await banAccount(database, {
      actorUserId: admin.userId,
      digestKey: DIGEST_KEY,
      expectedAccountRevision: revision(),
      reason: "first enforcement",
      targetUserId: target.userId,
    });
    await liftAccountBan(database, {
      actorUserId: admin.userId,
      expectedAccountRevision: revision(),
      targetUserId: target.userId,
    });
    await expect(changeAccountStatus(database, {
      actorUserId: admin.userId,
      expectedAccountRevision: revision(),
      status: "active",
      targetUserId: target.userId,
    })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 409,
    });

    const result = await banAccount(database, {
      actorUserId: admin.userId,
      digestKey: DIGEST_KEY,
      expectedAccountRevision: revision(),
      reason: "repeat enforcement",
      targetUserId: target.userId,
    });

    expect(result.identityDigests).toBe(1);
    await expect(assertIdentityNotBanned(database, digest))
      .rejects.toMatchObject({
        code: "ACCOUNT_BANNED",
        status: 403,
      });
    expect(sqlite.prepare(
      `SELECT lifted_at, reason
       FROM identity_ban_digests
       WHERE identity_digest = ?`,
    ).get(digest)).toEqual({
      lifted_at: null,
      reason: "repeat enforcement",
    });
  });

  it("revokes sessions on every global-role change and blocks admin deletion until demotion", async () => {
    const { database } = numberedMigrationDatabase();
    const firstAdmin = await testUser(database, "role-first-admin");
    const target = await testUser(database, "role-target");
    expect((await bootstrapGlobalAdmin(
      database,
      firstAdmin.userId,
    )).status).toBe("promoted");
    await issueSession(database, {}, target, request("role-session"));
    const preparation = await prepareAccountDeletion(
      database,
      target.userId,
    );
    const promotion = await changeGlobalRole(database, {
      actorUserId: firstAdmin.userId,
      expectedAccountRevision: preparation.accountRevision,
      role: "admin",
      targetUserId: target.userId,
    });
    expect(promotion.revokedSessions).toBe(1);
    const adminPreparation = await prepareAccountDeletion(
      database,
      target.userId,
    );
    expect(adminPreparation.blockers).toContainEqual({
      code: "GLOBAL_ADMIN",
    });
    await expect(banAccount(database, {
      actorUserId: firstAdmin.userId,
      digestKey: DIGEST_KEY,
      expectedAccountRevision: adminPreparation.accountRevision,
      reason: "test demotion requirement",
      targetUserId: target.userId,
    })).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BLOCKED",
      detail: {
        blockers: expect.arrayContaining([{ code: "GLOBAL_ADMIN" }]),
      },
    });

    const disabled = await changeAccountStatus(database, {
      actorUserId: firstAdmin.userId,
      expectedAccountRevision: adminPreparation.accountRevision,
      status: "disabled",
      targetUserId: target.userId,
    });
    await expect(banAccount(database, {
      actorUserId: firstAdmin.userId,
      digestKey: DIGEST_KEY,
      expectedAccountRevision: disabled.accountRevision,
      reason: "disabled administrator still requires demotion",
      targetUserId: target.userId,
    })).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BLOCKED",
      detail: {
        blockers: [{ code: "GLOBAL_ADMIN" }],
      },
    });
    const demotion = await changeGlobalRole(database, {
      actorUserId: firstAdmin.userId,
      expectedAccountRevision: disabled.accountRevision,
      role: "user",
      targetUserId: target.userId,
    });
    expect(demotion.revokedSessions).toBe(0);
    await expect(changeGlobalRole(database, {
      actorUserId: firstAdmin.userId,
      expectedAccountRevision: demotion.accountRevision,
      role: "admin",
      targetUserId: target.userId,
    })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 409,
    });
    expect((await prepareAccountDeletion(
      database,
      target.userId,
    )).blockers).not.toContainEqual({ code: "GLOBAL_ADMIN" });
  });

  it("recovers administration and retains only the recovery session", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const inaccessible = await testUser(
      database,
      "recovery-inaccessible",
    );
    const replacement = await testUser(database, "recovery-target");
    expect((await bootstrapGlobalAdmin(
      database,
      inaccessible.userId,
    )).status).toBe("promoted");
    const inaccessibleSession = await issueSession(
      database,
      {},
      inaccessible,
      request("inaccessible-session"),
    );
    const recoverySession = await issueSession(
      database,
      {},
      replacement,
      request("replacement-session"),
    );

    await expect(recoverGlobalAdmin(database, {
      principalDigest: await accessPrincipalAuditDigest(
        DIGEST_KEY,
        "access",
        "recovery-operator",
      ),
      emailMatched: true,
      reason: "primary operator cannot satisfy Access",
      recoveryMode: ADMIN_RECOVERY_MODE.ACCESS,
      retainedSessionId: recoverySession.sessionId,
      targetUserId: replacement.userId,
    })).resolves.toMatchObject({
      promoted: true,
      revokedSessions: 1,
      status: "recovered",
      userId: replacement.userId,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM users
       WHERE global_role = 'admin' AND status = 'active'`,
    ).get()).toEqual({ count: 2 });
    expect(sqlite.prepare(
      `SELECT session_id, revoked_at
       FROM sessions
       WHERE session_id IN (?,?)
       ORDER BY session_id`,
    ).all(
      inaccessibleSession.sessionId,
      recoverySession.sessionId,
    )).toEqual([
      {
        session_id: inaccessibleSession.sessionId,
        revoked_at: expect.any(String),
      },
      {
        session_id: recoverySession.sessionId,
        revoked_at: null,
      },
    ].sort((left, right) =>
      left.session_id.localeCompare(right.session_id)
    ));
    expect(sqlite.prepare(
      `SELECT detail_json
       FROM auth_audit_events
       WHERE action = 'admin.recover'`,
    ).get()).toEqual({
      detail_json: JSON.stringify({
        principalDigest: await accessPrincipalAuditDigest(
          DIGEST_KEY,
          "access",
          "recovery-operator",
        ),
        emailMatched: true,
        reason: "primary operator cannot satisfy Access",
        recoveryMode: "access",
      }),
    });
  });

  it("recovers through the current session after its issuance budget is exhausted", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const existingAdmin = await testUser(
      database,
      "recovery-budget-admin",
    );
    const replacement = await testUser(
      database,
      "recovery-budget-target",
    );
    expect((await bootstrapGlobalAdmin(
      database,
      existingAdmin.userId,
    )).status).toBe("promoted");
    await issueSession(
      database,
      {},
      existingAdmin,
      request("recovery-budget-admin-session"),
    );
    let recoverySession:
      Awaited<ReturnType<typeof issueSession>> | null = null;
    for (
      let index = 0;
      index < PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountDay;
      index += 1
    ) {
      recoverySession = await issueSession(
        database,
        {},
        replacement,
        request(`recovery-budget-${index}`),
      );
    }
    await expect(issueSession(
      database,
      {},
      replacement,
      request("recovery-budget-refused"),
    )).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 429,
    });

    await expect(recoverGlobalAdmin(database, {
      emailMatched: true,
      principalDigest: await accessPrincipalAuditDigest(
        DIGEST_KEY,
        "access",
        "recovery-budget-operator",
      ),
      reason: "session issuance budget exhausted",
      recoveryMode: ADMIN_RECOVERY_MODE.ACCESS,
      retainedSessionId: recoverySession!.sessionId,
      targetUserId: replacement.userId,
    })).resolves.toMatchObject({
      promoted: true,
      status: "recovered",
    });
    expect(sqlite.prepare(
      `SELECT revoked_at
       FROM sessions
       WHERE session_id=?`,
    ).get(recoverySession!.sessionId)).toEqual({
      revoked_at: null,
    });
  });

  it("keeps eight active sessions and marks the oldest replacement", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const user = await testUser(database, "session-budget");
    const issued: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const session = await issueSession(
        database,
        {},
        user,
        request(`session-${index}`),
      );
      issued.push(session.sessionId);
    }

    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM sessions
       WHERE user_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?`,
    ).get(user.userId, new Date().toISOString())).toEqual({ count: 8 });
    expect(await sessionIssuanceOutcome(
      database,
      user.userId,
      issued.at(-1)!,
    )).toEqual({
      replacedSessionIds: [issued[0]],
      sessionId: issued.at(-1),
    });
  });

  it("prepares and executes deletion with profile and identity redaction", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const admin = await testUser(database, "delete-admin");
    const target = await testUser(database, "delete-target");
    expect((await bootstrapGlobalAdmin(database, admin.userId)).status)
      .toBe("promoted");
    const activeSession = await issueSession(
      database,
      {},
      target,
      new Request("https://stowplan.example.test/api/auth/test", {
        headers: {
          "cf-connecting-ip": "192.0.2.44",
          "user-agent": "delete-session",
        },
      }),
    );
    sqlite.prepare(
      `INSERT INTO sessions(
         session_id,user_id,token_hash,created_at,expires_at,last_seen_at,
         revoked_at,user_agent,ip_prefix
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      "ses_delete_terminal",
      target.userId,
      "terminal-delete-token-hash",
      "2026-06-01T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T01:00:00.000Z",
      "terminal-browser",
      "198.51.100.0/24",
    );
    sqlite.prepare(
      `INSERT INTO auth_audit_events(
         event_id,actor_user_id,action,target_type,target_id,detail_json,
         created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    ).run(
      "aud_delete_reference",
      target.userId,
      "member.remove",
      "user",
      `wsp_retained::${target.userId}`,
      JSON.stringify({
        targetUserId: target.userId,
        workspaceId: "wsp_retained",
      }),
      "2026-07-01T00:00:00.000Z",
    );
    const preparation = await prepareAccountDeletion(
      database,
      target.userId,
    );
    expect(preparation.blockers).toEqual([]);

    const result = await executeAccountDeletion(database, {
      confirmation: "DELETE",
      digestKey: DIGEST_KEY,
      expectedAccountRevision: preparation.accountRevision,
      expectedMembershipRevision: preparation.membershipRevision,
      reauthenticatedAt: new Date().toISOString(),
      userId: target.userId,
    });

    expect(result.identitiesDeleted).toBe(1);
    expect(result.sessionsRevoked).toBe(1);
    expect(sqlite.prepare(
      `SELECT display_name, status, deleted_at,
              email LIKE '%@deleted.invalid' AS redacted_email
       FROM users
       WHERE user_id = ?`,
    ).get(target.userId)).toMatchObject({
      deleted_at: result.deletedAt,
      display_name: "Deleted user",
      redacted_email: 1,
      status: "disabled",
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM identities
       WHERE user_id = ?`,
    ).get(target.userId)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT revoked_at,user_agent,ip_prefix
       FROM sessions
       WHERE session_id = ?`,
    ).get(activeSession.sessionId)).toMatchObject({
      ip_prefix: null,
      revoked_at: result.deletedAt,
      user_agent: null,
    });
    expect(sqlite.prepare(
      `SELECT revoked_at,user_agent,ip_prefix
       FROM sessions
       WHERE session_id = 'ses_delete_terminal'`,
    ).get()).toEqual({
      ip_prefix: null,
      revoked_at: "2026-06-01T01:00:00.000Z",
      user_agent: null,
    });
    expect(sqlite.prepare(
      `SELECT deletion_id, account_digest
       FROM account_deletion_receipts`,
    ).get()).toEqual({
      account_digest: expect.stringMatching(/^v1:[0-9a-f]{64}$/u),
      deletion_id: result.deletionId,
    });
    expect(sqlite.prepare(
      `SELECT
         actor_user_id,
         target_id,
         json_extract(detail_json, '$.targetUserId') AS target_user_id,
         json_extract(detail_json, '$.workspaceId') AS workspace_id
       FROM auth_audit_events
       WHERE event_id = 'aud_delete_reference'`,
    ).get()).toEqual({
      actor_user_id: null,
      target_id:
        `wsp_retained::deleted:${result.deletionId}`,
      target_user_id: `deleted:${result.deletionId}`,
      workspace_id: "wsp_retained",
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE actor_user_id = ?
          OR target_id = ?
          OR target_id LIKE ?
          OR json_extract(detail_json, '$.createdByUserId') = ?
          OR json_extract(detail_json, '$.targetUserId') = ?
          OR json_extract(detail_json, '$.userId') = ?`,
    ).get(
      target.userId,
      target.userId,
      `%::${target.userId}`,
      target.userId,
      target.userId,
      target.userId,
    )).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM creation_ledger
       WHERE event_id LIKE ?
          OR scope_id = ?`,
    ).get(`%${target.userId}%`, target.userId)).toEqual({
      count: 0,
    });
  });

  it("reports final-owner deletion blockers without changing local or server state", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const owner = await testUser(database, "deletion-owner");
    const state = createEmptyState("Deletion blocker");
    await initializeOwnedWorkspace(database, owner.userId, state);

    const preparation = await prepareAccountDeletion(
      database,
      owner.userId,
    );
    expect(preparation.blockers).toContainEqual({
      code: "FINAL_WORKSPACE_OWNER",
      workspaceId: state.workspace.id,
      workspaceName: state.workspace.name,
    });
    await expect(executeAccountDeletion(database, {
      confirmation: "DELETE",
      digestKey: DIGEST_KEY,
      expectedAccountRevision: preparation.accountRevision,
      expectedMembershipRevision: preparation.membershipRevision,
      reauthenticatedAt: new Date().toISOString(),
      userId: owner.userId,
    })).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BLOCKED",
      status: 409,
    });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_snapshots
       WHERE workspace_id = ?`,
    ).get(state.workspace.id)).toEqual({ count: 1 });
  });

  it("stores security expiry and capacity latch breaker metadata", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const admin = await testUser(database, "breaker-admin");
    expect((await bootstrapGlobalAdmin(database, admin.userId)).status)
      .toBe("promoted");
    const resumeAt = new Date(Date.now() + 30 * 60 * 1_000)
      .toISOString();

    await expect(setCircuitBreaker(database, {
      actorUserId: admin.userId,
      pauseKind: CIRCUIT_BREAKER_PAUSE_KIND.SECURITY,
      reason: "critical signup velocity",
      resumeAt,
      scope: CIRCUIT_BREAKER_SCOPE.NEW_ACCOUNTS,
      state: CIRCUIT_BREAKER_STATE.PAUSED,
    })).resolves.toMatchObject({
      pauseKind: "security",
      resumeAt,
      state: "paused",
      triggerCount: 1,
    });
    await expect(setCircuitBreaker(database, {
      actorUserId: admin.userId,
      pauseKind: CIRCUIT_BREAKER_PAUSE_KIND.SECURITY,
      reason: null,
      scope: CIRCUIT_BREAKER_SCOPE.NEW_ACCOUNTS,
      state: CIRCUIT_BREAKER_STATE.OPEN,
    })).resolves.toMatchObject({
      state: "open",
      triggerCount: 1,
    });
    const secondResumeAt = new Date(Date.now() + 2 * 60 * 60 * 1_000)
      .toISOString();
    await expect(setCircuitBreaker(database, {
      actorUserId: admin.userId,
      pauseKind: CIRCUIT_BREAKER_PAUSE_KIND.SECURITY,
      reason: "repeated signup velocity",
      resumeAt: secondResumeAt,
      scope: CIRCUIT_BREAKER_SCOPE.NEW_ACCOUNTS,
      state: CIRCUIT_BREAKER_STATE.PAUSED,
    })).resolves.toMatchObject({
      state: "paused",
      triggerCount: 2,
    });
    sqlite.prepare(
      `UPDATE circuit_breakers
       SET resume_at = ?
       WHERE scope = 'new_accounts'`,
    ).run(new Date(Date.now() - 60_000).toISOString());
    await expect(accountCreationRefusal(database)).resolves.toBeNull();
    expect((await readCircuitBreakers(database)).find(
      breaker => breaker.scope === CIRCUIT_BREAKER_SCOPE.NEW_ACCOUNTS,
    )).toMatchObject({
      effectiveState: "open",
      state: "paused",
      triggerCount: 2,
    });
    await expect(testUser(database, "breaker-expired-account"))
      .resolves.toMatchObject({
        email: "breaker-expired-account@example.test",
      });
    await expect(setCircuitBreaker(database, {
      actorUserId: admin.userId,
      pauseKind: CIRCUIT_BREAKER_PAUSE_KIND.CAPACITY,
      reason: "database high-water mark",
      scope: CIRCUIT_BREAKER_SCOPE.NEW_WORKSPACES,
      state: CIRCUIT_BREAKER_STATE.PAUSED,
    })).resolves.toMatchObject({
      pauseKind: "capacity",
      resumeAt: null,
      state: "paused",
    });
    sqlite.prepare(
      `UPDATE circuit_breakers
       SET resume_at = ?
       WHERE scope = 'new_workspaces'`,
    ).run(new Date(Date.now() - 60_000).toISOString());
    expect((await readCircuitBreakers(database)).find(
      breaker => breaker.scope === CIRCUIT_BREAKER_SCOPE.NEW_WORKSPACES,
    )).toMatchObject({
      effectiveState: "paused",
      pauseKind: "capacity",
    });
  });

  it("adjusts only the bounded account fuse and audits the operator reason", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const admin = await testUser(database, "limit-admin");
    expect((await bootstrapGlobalAdmin(database, admin.userId)).status)
      .toBe("promoted");
    await expect(readGovernanceLimits(database)).resolves.toEqual([
      {
        key: GOVERNANCE_LIMIT_KEY.NEW_ACCOUNTS_PER_DAY,
        updatedAt: "1970-01-01T00:00:00.000Z",
        updatedByUserId: null,
        value: PUBLIC_LAUNCH_LIMITS.newAccountsPerDay,
      },
    ]);

    await expect(setGovernanceLimit(database, {
      actorUserId: admin.userId,
      key: GOVERNANCE_LIMIT_KEY.NEW_ACCOUNTS_PER_DAY,
      reason: "pause public signup while capacity is inspected",
      value: 0,
    })).resolves.toMatchObject({
      key: "new_accounts_per_day",
      updatedByUserId: admin.userId,
      value: 0,
    });
    await expect(accountCreationRefusal(database))
      .resolves.toMatchObject({
        code: "QUOTA_EXCEEDED",
        detail: {
          limit: 0,
          quota: "newAccountsPerDay",
        },
      });
    expect(sqlite.prepare(
      `SELECT detail_json
       FROM auth_audit_events
       WHERE action = 'governance.limit.set'`,
    ).get()).toEqual({
      detail_json: JSON.stringify({
        key: "new_accounts_per_day",
        reason: "pause public signup while capacity is inspected",
        value: 0,
      }),
    });
    await expect(setGovernanceLimit(database, {
      actorUserId: admin.userId,
      key: GOVERNANCE_LIMIT_KEY.NEW_ACCOUNTS_PER_DAY,
      reason: "invalid upper bound",
      value:
        MAXIMUM_GOVERNANCE_LIMIT.new_accounts_per_day + 1,
    })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
    expect(() => sqlite.prepare(
      `UPDATE governance_limits
       SET limit_value = ?
       WHERE limit_key = 'new_accounts_per_day'`,
    ).run(
      MAXIMUM_GOVERNANCE_LIMIT.new_accounts_per_day + 1,
    )).toThrow(/CHECK constraint failed/u);
  });

  it("reports the complete workspace-allocation retry floor", async () => {
    const at = new Date("2026-07-26T12:00:00.000Z");
    const daily = numberedMigrationDatabase();
    const dailyUser = await testUser(
      daily.database,
      "allocation-daily",
    );
    const insertDaily = daily.sqlite.prepare(
      `INSERT INTO creation_ledger(
         event_id, scope_type, scope_id, resource, created_at
       )
       VALUES (?, 'account', ?, 'workspace', ?)`,
    );
    for (
      let index = 0;
      index <
        PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountDay;
      index += 1
    ) {
      insertDaily.run(
        `daily-workspace-${index}`,
        dailyUser.userId,
        `2026-07-26T0${index}:00:00.000Z`,
      );
    }

    await expect(workspaceAllocationRefusal(
      daily.database,
      dailyUser.userId,
      0,
      at,
    )).resolves.toMatchObject({
      code: "QUOTA_EXCEEDED",
      detail: {
        quota: "workspacesCreatedPerAccountDay",
        retryAfterSeconds: 43_200,
      },
      status: 429,
    });

    const rolling = numberedMigrationDatabase();
    const rollingUser = await testUser(
      rolling.database,
      "allocation-rolling",
    );
    const insertRolling = rolling.sqlite.prepare(
      `INSERT INTO creation_ledger(
         event_id, scope_type, scope_id, resource, created_at
       )
       VALUES (?, 'account', ?, 'workspace', ?)`,
    );
    const rollingCreatedAt = [
      "2026-06-27T20:00:00.000Z",
      "2026-06-28T20:00:00.000Z",
      "2026-06-29T20:00:00.000Z",
      ...Array.from(
        {
          length:
            PUBLIC_LAUNCH_LIMITS
              .workspacesCreatedPerAccountRolling30Days -
            PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountDay -
            1,
        },
        (_, index) =>
          `2026-07-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
      ),
      ...Array.from(
        {
          length:
            PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountDay,
        },
        (_, index) =>
          `2026-07-26T0${index}:00:00.000Z`,
      ),
    ];
    for (const [index, createdAt] of rollingCreatedAt.entries()) {
      insertRolling.run(
        `rolling-workspace-${index}`,
        rollingUser.userId,
        createdAt,
      );
    }

    await expect(workspaceAllocationRefusal(
      rolling.database,
      rollingUser.userId,
      0,
      at,
    )).resolves.toMatchObject({
      code: "QUOTA_EXCEEDED",
      detail: {
        quota: "workspacesCreatedPerAccountRolling30Days",
        retryAfterSeconds: 288_000,
      },
      status: 429,
    });
  });

  it("pauses only byte-increasing snapshot persistence", async () => {
    const { database } = numberedMigrationDatabase();
    const owner = await testUser(database, "snapshot-growth-owner");
    expect((await bootstrapGlobalAdmin(database, owner.userId)).status)
      .toBe("promoted");
    const state = createEmptyState("x".repeat(500));
    await initializeOwnedWorkspace(database, owner.userId, state);
    await setCircuitBreaker(database, {
      actorUserId: owner.userId,
      pauseKind: CIRCUIT_BREAKER_PAUSE_KIND.CAPACITY,
      reason: "D1 write allowance high-water mark",
      scope: CIRCUIT_BREAKER_SCOPE.SNAPSHOT_GROWTH,
      state: CIRCUIT_BREAKER_STATE.PAUSED,
    });
    const store = new D1SnapshotStore(database);
    const smaller = structuredClone(state);
    smaller.workspace.name = "x";
    smaller.workspace.revision += 1;
    smaller.workspace.updatedAt = new Date().toISOString();
    await expect(store.compareAndSwap(
      state.workspace.id,
      state.workspace.revision,
      smaller,
    )).resolves.toBe(true);

    const larger = structuredClone(smaller);
    larger.workspace.name = "y".repeat(700);
    larger.workspace.revision += 1;
    larger.workspace.updatedAt = new Date().toISOString();
    await expect(snapshotGrowthRefusal(
      database,
      state.workspace.id,
      new TextEncoder().encode(JSON.stringify(larger)).byteLength,
    )).resolves.toMatchObject({
      code: "CIRCUIT_PAUSED",
      status: 503,
    });
    await expect(store.compareAndSwap(
      state.workspace.id,
      smaller.workspace.revision,
      larger,
    )).rejects.toMatchObject({
      code: "CIRCUIT_PAUSED",
      status: 503,
    });

    await setCircuitBreaker(database, {
      actorUserId: owner.userId,
      pauseKind: CIRCUIT_BREAKER_PAUSE_KIND.CAPACITY,
      reason: null,
      scope: CIRCUIT_BREAKER_SCOPE.SNAPSHOT_GROWTH,
      state: CIRCUIT_BREAKER_STATE.OPEN,
    });
    await expect(store.compareAndSwap(
      state.workspace.id,
      smaller.workspace.revision,
      larger,
    )).resolves.toBe(true);
  });

  it("bounds rolling ledgers and redacts only routine audit details", async () => {
    const { database, sqlite } = numberedMigrationDatabase();
    const user = await testUser(database, "retention-user");
    const state = createEmptyState("Retention workspace");
    await initializeOwnedWorkspace(database, user.userId, state);
    const oldAt = new Date(
      Date.now() - 32 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    sqlite.prepare(
      `INSERT INTO creation_ledger(
         event_id, scope_type, scope_id, resource, created_at
       )
       VALUES
         ('old-session', 'account', ?, 'session', ?),
         ('old-guest', 'account', ?, 'guest_link', ?)`,
    ).run(user.userId, oldAt, user.userId, oldAt);

    await issueSession(database, TEST_AUTH_ENV, user, request(
      "retention-session",
    ));
    await createGuestLink(
      database,
      state.workspace.id,
      user.userId,
      "viewer",
    );
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM creation_ledger
       WHERE event_id IN ('old-session', 'old-guest')`,
    ).get()).toEqual({ count: 0 });

    const routineInsert = sqlite.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       VALUES (?, ?, 'session.revoke', 'session', ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      routineInsert.run(
        `old-routine-${index}`,
        user.userId,
        `session-${index}`,
        JSON.stringify({ source: "account", stale: index }),
        new Date(
          Date.now() - 181 * 24 * 60 * 60 * 1_000 - index,
        ).toISOString(),
      );
    }
    sqlite.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       VALUES (
         'old-security', ?, 'user.ban', 'user', ?, '{"retained":true}', ?
       )`,
    ).run(user.userId, user.userId, oldAt);
    sqlite.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       VALUES (
         'retention-tick', NULL, 'admin.bootstrap', 'user', ?, '{}', ?
       )`,
    ).run(user.userId, new Date().toISOString());
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_audit_events
       WHERE action = 'session.revoke'
         AND detail_json <> '{}'`,
    ).get()).toEqual({ count: 1 });
    await expect(redactExpiredRoutineAuditDetails(
      database,
      new Date(),
      1,
    )).resolves.toBe(1);
    expect(sqlite.prepare(
      `SELECT detail_json
       FROM auth_audit_events
       WHERE event_id = 'old-security'`,
    ).get()).toEqual({
      detail_json: JSON.stringify({ retained: true }),
    });
  });
});

describe("governance schema policy parity", () => {
  function sitesDatabase() {
    const sqlite = new DatabaseSync(":memory:");
    applySqlDirectory(
      sqlite,
      new URL("../drizzle/", import.meta.url),
    );
    return sqlite;
  }

  it("keeps hard guards aligned with the shared launch policy in both streams", () => {
    const streams = [
      numberedMigrationDatabase().sqlite,
      sitesDatabase(),
    ];
    for (const sqlite of streams) {
      const trigger = (name: string) => (
        sqlite.prepare(
          `SELECT sql
           FROM sqlite_schema
           WHERE type = 'trigger' AND name = ?`,
        ).get(name) as { sql: string }
      ).sql;
      expect(trigger("workspace_custody_insert_guard"))
        .toContain(`>= ${API_QUOTAS.ownedWorkspacesPerUser}`);
      expect(trigger("workspace_custody_insert_guard"))
        .toContain(`> ${PUBLIC_LAUNCH_LIMITS.aggregateSnapshotBytesPerAccount}`);
      expect(trigger("workspace_snapshots_account_storage_guard"))
        .toContain(`> ${PUBLIC_LAUNCH_LIMITS.aggregateSnapshotBytesPerAccount}`);
      expect(trigger("workspace_custody_insert_guard"))
        .toContain(`>= ${PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountDay}`);
      expect(trigger("workspace_custody_insert_guard"))
        .toContain(`>= ${PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountRolling30Days}`);
      expect(trigger("workspace_custody_insert_guard"))
        .toContain(`>= ${PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountLifetime}`);
      expect(trigger("workspace_members_account_quota_guard"))
        .toContain(`>= ${PUBLIC_LAUNCH_LIMITS.membershipsPerAccount}`);
      expect(trigger("sessions_public_issuance_guard"))
        .toContain(`>= ${PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountDay}`);
      expect(trigger("sessions_public_issuance_guard"))
        .toContain(`>= ${PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountRolling30Days}`);
      expect(trigger("sessions_public_issuance_ledger"))
        .toContain(`OFFSET ${PUBLIC_LAUNCH_LIMITS.activeSessionsPerAccount - 1}`);
      expect(trigger("sessions_public_issuance_ledger"))
        .toContain(`OFFSET ${PUBLIC_LAUNCH_LIMITS.terminalSessionsPerAccount}`);
      expect(trigger("sessions_public_issuance_ledger"))
        .toContain(`- ${PUBLIC_LAUNCH_LIMITS.terminalSessionRetentionDays}`);
      expect(trigger("guest_links_public_creation_guard"))
        .toContain(`>= ${PUBLIC_LAUNCH_LIMITS.guestLinksCreatedPerAccountDay}`);
      expect(trigger("guest_links_public_creation_guard"))
        .toContain(`>= ${PUBLIC_LAUNCH_LIMITS.guestLinksCreatedPerAccountRolling30Days}`);
      for (const name of [
        "guest_links_public_creation_guard",
        "guest_links_public_redemption_guard",
        "users_public_creation_guard",
        "workspace_custody_insert_guard",
        "workspace_snapshots_growth_guard",
      ]) {
        expect(trigger(name)).toContain("pause_kind");
        expect(trigger(name)).toContain("resume_at");
      }
      expect(trigger("workspace_snapshots_growth_guard"))
        .toContain("length(CAST");
      expect(trigger("sessions_public_issuance_ledger"))
        .toContain(`- ${CREATION_LEDGER_ROLLING_RETENTION_DAYS}`);
      expect(trigger("guest_links_public_creation_ledger"))
        .toContain(`- ${CREATION_LEDGER_ROLLING_RETENTION_DAYS}`);
      expect(trigger("auth_audit_routine_detail_retention"))
        .toContain(`- ${AUTH_AUDIT_DETAIL_RETENTION_DAYS}`);
      expect(trigger("auth_audit_routine_detail_retention"))
        .toContain(`LIMIT ${AUTH_AUDIT_REDACTION_BATCH_SIZE}`);
      expect(trigger("users_final_owner_status_guard"))
        .toContain("last active workspace owner");
      for (const name of [
        "users_last_admin_delete_guard",
        "users_last_admin_role_guard",
        "users_last_admin_status_guard",
      ]) {
        expect(trigger(name)).toContain("deleted_at");
      }
      expect(sqlite.prepare(
        `SELECT limit_value
         FROM governance_limits
         WHERE limit_key = 'new_accounts_per_day'`,
      ).get()).toEqual({
        limit_value: PUBLIC_LAUNCH_LIMITS.newAccountsPerDay,
      });
      expect(sqlite.prepare(
        `SELECT scope, pause_kind
         FROM circuit_breakers
         ORDER BY scope`,
      ).all()).toEqual([
        { pause_kind: "security", scope: "guest_links" },
        { pause_kind: "security", scope: "guest_redemptions" },
        { pause_kind: "security", scope: "new_accounts" },
        { pause_kind: "capacity", scope: "new_workspaces" },
        { pause_kind: "capacity", scope: "snapshot_growth" },
      ]);
    }
  });
});
