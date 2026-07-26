import type {
  D1DatabaseLike,
  D1QueryResultLike,
  D1ResultLike,
  D1StatementLike,
} from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";
import {
  ACCOUNT_STATUS,
  ADMIN_RECOVERY_MODE,
  AUTH_AUDIT_DETAIL_RETENTION_DAYS,
  AUTH_AUDIT_REDACTION_BATCH_SIZE,
  CIRCUIT_BREAKER_SCOPE,
  CIRCUIT_BREAKER_PAUSE_KIND,
  CIRCUIT_BREAKER_STATE,
  GOVERNANCE_LIMIT_KEY,
  GLOBAL_ROLE,
  MAXIMUM_GOVERNANCE_LIMIT,
  PUBLIC_LAUNCH_LIMITS,
  type AccountDeletionBlocker,
  type AccountDeletionCustodyTransfer,
  type AccountStatus,
  type AdminRecoveryMode,
  type CircuitBreaker,
  type CircuitBreakerScope,
  type CircuitBreakerPauseKind,
  type CircuitBreakerState,
  type GlobalRole,
  type GovernanceLimit,
  type GovernanceLimitKey,
} from "../shared/governance-policy";
import { API_QUOTAS } from "../shared/api-quotas";
import { ApiProblem } from "./api-problem";
import { safeAuditDetailJson } from "./audit-detail";

interface Statement extends D1StatementLike {
  all<T>(): Promise<D1QueryResultLike<T>>;
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
}

interface GovernanceDatabase extends D1DatabaseLike {
  prepare(query: string): Statement;
}

const ROLLING_CREATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const UNNAMED_WORKSPACE_LABEL = "Unnamed workspace";

interface AccountRow {
  account_revision: number;
  deleted_at: string | null;
  global_role: GlobalRole;
  membership_revision: number;
  status: AccountStatus;
  user_id: string;
}

interface CustodyCandidateRow {
  candidate_bytes: number;
  candidate_count: number;
  candidate_user_id: string;
  snapshot_bytes: number;
  workspace_id: string;
}

interface CustodyWorkspaceRow {
  snapshot_bytes: number;
  workspace_id: string;
  workspace_name: string | null;
}

interface IdentityRow {
  provider: string;
  provider_subject: string;
}

export interface AccountDeletionPreparation {
  accountRevision: number;
  blockers: AccountDeletionBlocker[];
  custodyTransfers: AccountDeletionCustodyTransfer[];
  globalRole: GlobalRole;
  membershipRevision: number;
  membershipCount: number;
  status: AccountStatus;
  userId: string;
}

export interface AccountDeletionExecutionInput {
  confirmation: "DELETE";
  digestKey: string;
  expectedAccountRevision: number;
  expectedMembershipRevision: number;
  reauthenticatedAt: string;
  userId: string;
}

export interface AccountDeletionExecutionResult {
  deletedAt: string;
  deletionId: string;
  identitiesDeleted: number;
  membershipsDeleted: number;
  sessionsRevoked: number;
  unusedGuestLinksRevoked: number;
}

export interface BanAccountInput {
  actorUserId: string;
  digestKey: string;
  expectedAccountRevision: number;
  reason: string;
  targetUserId: string;
}

export interface ChangeGlobalRoleInput {
  actorUserId: string;
  expectedAccountRevision: number;
  role: GlobalRole;
  targetUserId: string;
}

export interface ChangeAccountStatusInput {
  actorUserId: string;
  expectedAccountRevision: number;
  status: "active" | "disabled";
  targetUserId: string;
}

export type BootstrapGlobalAdminResult =
  | { status: "active-admin-exists" }
  | { status: "already-admin"; userId: string }
  | { status: "ineligible" }
  | { status: "promoted"; userId: string };

export type RecoverGlobalAdminResult =
  | { status: "ineligible" }
  | {
      promoted: boolean;
      revokedSessions: number;
      status: "recovered";
      userId: string;
    };

export interface SessionIssuanceOutcome {
  replacedSessionIds: string[];
  sessionId: string;
}

const ACCOUNT_DIGEST_CONTEXT = "stowplan.account-deletion.v1";
const DIGEST_VERSION = "v1";
const IDENTITY_DIGEST_CONTEXT = "stowplan.identity-ban.v1";
const RECOVERY_PRINCIPAL_DIGEST_CONTEXT =
  "stowplan.recovery-principal-audit.v1";
const MAXIMUM_CIRCUIT_REASON_LENGTH = 500;
const MAXIMUM_GOVERNANCE_REASON_LENGTH = 500;
const MAXIMUM_REAUTHENTICATION_AGE_MS = 10 * 60 * 1_000;
const MAXIMUM_REAUTHENTICATION_FUTURE_SKEW_MS = 60 * 1_000;
const MAXIMUM_BAN_REASON_LENGTH = 500;
const TERMINAL_SESSION_TRIM_BATCH = 64;

function databaseLike(database: D1DatabaseLike): GovernanceDatabase {
  return database as GovernanceDatabase;
}

function changes(result: D1ResultLike | undefined): number {
  return result?.success ? result.meta?.changes ?? 0 : 0;
}

function requireDigestKey(value: string): string {
  if (new TextEncoder().encode(value).byteLength < 32) {
    throw new Error("The identity enforcement digest key is not configured");
  }
  return value;
}

function requireReason(value: string, maximumLength: number): string {
  const reason = value.trim();
  if (!reason || reason.length > maximumLength) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `A reason from 1 through ${maximumLength} characters is required`,
      400,
    );
  }
  return reason;
}

function requireVersionedDigest(value: string): string {
  if (!/^v1:[0-9a-f]{64}$/u.test(value)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The principal digest is invalid",
      400,
    );
  }
  return value;
}

function requireRevision(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `${field} is invalid`,
      400,
    );
  }
  return value;
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    byte => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function enforcementDigest(
  keyValue: string,
  context: string,
  values: string[],
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(requireDigestKey(keyValue)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const payload = [context, ...values].join("\u0000");
  const digest = encodeHex(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  )));
  return `${DIGEST_VERSION}:${digest}`;
}

export async function identityEnforcementDigest(
  key: string,
  provider: string,
  subject: string,
): Promise<string> {
  if (!provider || !subject) {
    throw new Error("An identity provider and subject are required");
  }
  return enforcementDigest(
    key,
    IDENTITY_DIGEST_CONTEXT,
    [provider, subject],
  );
}

export async function accessPrincipalAuditDigest(
  key: string,
  provider: string,
  subject: string,
): Promise<string> {
  return recoveryPrincipalAuditDigest(
    key,
    ADMIN_RECOVERY_MODE.ACCESS,
    provider,
    subject,
  );
}

export async function recoveryPrincipalAuditDigest(
  key: string,
  recoveryMode: AdminRecoveryMode,
  provider: string,
  subject: string,
): Promise<string> {
  if (!Object.values(ADMIN_RECOVERY_MODE).includes(recoveryMode)) {
    throw new Error("An administrator recovery mode is required");
  }
  if (!provider || !subject) {
    throw new Error("A recovery identity provider and subject are required");
  }
  return enforcementDigest(
    key,
    RECOVERY_PRINCIPAL_DIGEST_CONTEXT,
    [recoveryMode, provider, subject],
  );
}

async function accountDeletionDigest(
  key: string,
  userId: string,
): Promise<string> {
  return enforcementDigest(
    key,
    ACCOUNT_DIGEST_CONTEXT,
    [userId],
  );
}

export async function assertIdentityNotBanned(
  database: D1DatabaseLike,
  identityDigest: string,
): Promise<void> {
  const row = await database.prepare(
    `SELECT 1 AS banned
     FROM identity_ban_digests
     WHERE identity_digest = ?
       AND lifted_at IS NULL`,
  ).bind(identityDigest).first<{ banned: number }>();
  if (row) {
    throw new ApiProblem(
      "ACCOUNT_BANNED",
      "This sign-in identity cannot create or access an account",
      403,
    );
  }
}

async function requireActiveAdmin(
  db: GovernanceDatabase,
  actorUserId: string,
): Promise<void> {
  const actor = await db.prepare(
    `SELECT 1 AS allowed
     FROM users
     WHERE user_id = ?
       AND status = 'active'
       AND deleted_at IS NULL
       AND global_role = 'admin'`,
  ).bind(actorUserId).first<{ allowed: number }>();
  if (!actor) {
    throw new ApiProblem(
      "ADMIN_REQUIRED",
      "Active global administrator authority is required",
      403,
    );
  }
}

async function accountRow(
  db: GovernanceDatabase,
  userId: string,
): Promise<AccountRow | null> {
  return db.prepare(
    `SELECT
       account_revision,
       deleted_at,
       global_role,
       membership_revision,
       status,
       user_id
     FROM users
     WHERE user_id = ?`,
  ).bind(userId).first<AccountRow>();
}

async function hasRetainedIdentityBanDigests(
  db: GovernanceDatabase,
  userId: string,
): Promise<boolean> {
  return Boolean(await db.prepare(
    `SELECT 1 AS retained
     FROM identity_ban_digests
     WHERE source_user_id = ?
     LIMIT 1`,
  ).bind(userId).first<{ retained: number }>());
}

async function finalOwnedWorkspaceBlockers(
  db: GovernanceDatabase,
  userId: string,
): Promise<AccountDeletionBlocker[]> {
  const rows = await db.prepare(
    `SELECT
       owned.workspace_id,
       json_extract(
         snapshot.state_json,
         '$.workspace.name'
       ) AS workspace_name
     FROM workspace_members owned
     LEFT JOIN workspace_snapshots snapshot
       ON snapshot.workspace_id = owned.workspace_id
     WHERE owned.user_id = ?
       AND owned.role = 'owner'
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_deletions deleted
         WHERE deleted.workspace_id = owned.workspace_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_members other
         JOIN users other_user
           ON other_user.user_id = other.user_id
         WHERE other.workspace_id = owned.workspace_id
           AND other.user_id <> owned.user_id
           AND other.role = 'owner'
           AND other_user.status = 'active'
           AND other_user.deleted_at IS NULL
       )
     ORDER BY owned.workspace_id`,
  ).bind(userId).all<{
    workspace_id: string;
    workspace_name: string | null;
  }>();
  return rows.results.map(row => ({
    code: "FINAL_WORKSPACE_OWNER",
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name?.trim() ||
      UNNAMED_WORKSPACE_LABEL,
  }));
}

async function custodyPlan(
  db: GovernanceDatabase,
  userId: string,
): Promise<{
  blockers: AccountDeletionBlocker[];
  transfers: AccountDeletionCustodyTransfer[];
}> {
  const custody = await db.prepare(
    `SELECT
       custody.workspace_id,
       snapshot.stored_bytes AS snapshot_bytes,
       json_extract(
         snapshot.state_json,
         '$.workspace.name'
       ) AS workspace_name
     FROM workspace_custody custody
     JOIN workspace_snapshots snapshot
       ON snapshot.workspace_id = custody.workspace_id
     WHERE custody.custodian_user_id = ?
     ORDER BY custody.workspace_id`,
  ).bind(userId).all<CustodyWorkspaceRow>();
  if (custody.results.length === 0) {
    return { blockers: [], transfers: [] };
  }
  const candidates = await db.prepare(
    `SELECT
       target.workspace_id,
       target_snapshot.stored_bytes AS snapshot_bytes,
       candidate.user_id AS candidate_user_id,
       (
         SELECT COUNT(*)
         FROM workspace_custody current_custody
         WHERE current_custody.custodian_user_id = candidate.user_id
       ) AS candidate_count,
       (
         SELECT COALESCE(SUM(current_snapshot.stored_bytes), 0)
         FROM workspace_custody current_custody
         JOIN workspace_snapshots current_snapshot
           ON current_snapshot.workspace_id =
              current_custody.workspace_id
         WHERE current_custody.custodian_user_id = candidate.user_id
       ) AS candidate_bytes
     FROM workspace_custody target
     JOIN workspace_snapshots target_snapshot
       ON target_snapshot.workspace_id = target.workspace_id
     JOIN workspace_members candidate
       ON candidate.workspace_id = target.workspace_id
      AND candidate.role = 'owner'
      AND candidate.user_id <> ?
     JOIN users candidate_user
       ON candidate_user.user_id = candidate.user_id
      AND candidate_user.status = 'active'
      AND candidate_user.deleted_at IS NULL
     WHERE target.custodian_user_id = ?
     ORDER BY target.workspace_id, candidate.created_at, candidate.user_id`,
  ).bind(userId, userId).all<CustodyCandidateRow>();
  const candidatesByWorkspace = new Map<string, CustodyCandidateRow[]>();
  for (const candidate of candidates.results) {
    const rows = candidatesByWorkspace.get(candidate.workspace_id) ?? [];
    rows.push(candidate);
    candidatesByWorkspace.set(candidate.workspace_id, rows);
  }
  const projected = new Map<string, { bytes: number; count: number }>();
  const transfers: AccountDeletionCustodyTransfer[] = [];
  const blockers: AccountDeletionBlocker[] = [];
  for (const target of custody.results) {
    const selected = (candidatesByWorkspace.get(target.workspace_id) ?? [])
      .find(candidate => {
        const usage = projected.get(candidate.candidate_user_id) ?? {
          bytes: candidate.candidate_bytes,
          count: candidate.candidate_count,
        };
        return usage.count < API_QUOTAS.ownedWorkspacesPerUser
          && usage.bytes + target.snapshot_bytes <=
            PUBLIC_LAUNCH_LIMITS.aggregateSnapshotBytesPerAccount;
      });
    if (!selected) {
      blockers.push({
        code: "CUSTODY_TRANSFER_UNAVAILABLE",
        workspaceId: target.workspace_id,
        workspaceName: target.workspace_name?.trim() ||
          UNNAMED_WORKSPACE_LABEL,
      });
      continue;
    }
    const usage = projected.get(selected.candidate_user_id) ?? {
      bytes: selected.candidate_bytes,
      count: selected.candidate_count,
    };
    projected.set(selected.candidate_user_id, {
      bytes: usage.bytes + target.snapshot_bytes,
      count: usage.count + 1,
    });
    transfers.push({
      fromUserId: userId,
      toUserId: selected.candidate_user_id,
      workspaceId: target.workspace_id,
    });
  }
  return { blockers, transfers };
}

export async function prepareAccountDeletion(
  database: D1DatabaseLike,
  userId: string,
): Promise<AccountDeletionPreparation> {
  const db = databaseLike(database);
  const user = await accountRow(db, userId);
  if (!user) {
    throw new ApiProblem(
      "NOT_FOUND_OR_INACCESSIBLE",
      "The account was not found",
      404,
    );
  }
  const blockers: AccountDeletionBlocker[] = [];
  if (user.status !== ACCOUNT_STATUS.ACTIVE || user.deleted_at) {
    blockers.push({ code: "ACCOUNT_INACTIVE" });
  }
  if (
    user.global_role === GLOBAL_ROLE.ADMIN
    && user.status === ACCOUNT_STATUS.ACTIVE
  ) {
    blockers.push({ code: "GLOBAL_ADMIN" });
    const activeAdmins = await db.prepare(
      `SELECT COUNT(*) AS count
       FROM users
       WHERE global_role = 'admin'
         AND status = 'active'
         AND deleted_at IS NULL`,
    ).first<{ count: number }>();
    if ((activeAdmins?.count ?? 0) <= 1) {
      blockers.push({ code: "FINAL_ADMIN" });
    }
  }
  blockers.push(...await finalOwnedWorkspaceBlockers(db, userId));
  const custody = await custodyPlan(db, userId);
  blockers.push(...custody.blockers);
  const membership = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM workspace_members
     WHERE user_id = ?`,
  ).bind(userId).first<{ count: number }>();
  return {
    accountRevision: user.account_revision,
    blockers,
    custodyTransfers: custody.transfers,
    globalRole: user.global_role,
    membershipCount: membership?.count ?? 0,
    membershipRevision: user.membership_revision,
    status: user.status,
    userId,
  };
}

function assertRecentAuthentication(
  value: string,
  now: Date,
): void {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp)
    || timestamp < now.getTime() - MAXIMUM_REAUTHENTICATION_AGE_MS
    || timestamp > now.getTime() + MAXIMUM_REAUTHENTICATION_FUTURE_SKEW_MS
  ) {
    throw new ApiProblem(
      "REAUTHENTICATION_REQUIRED",
      "Sign in again before deleting this account",
      403,
    );
  }
}

function deletionBlockerProblem(
  preparation: AccountDeletionPreparation,
): ApiProblem {
  return new ApiProblem(
    "ACCOUNT_DELETION_BLOCKED",
    "The account cannot be deleted until its authority and workspace custody are resolved",
    409,
    {
      accountRevision: preparation.accountRevision,
      blockers: preparation.blockers,
      membershipRevision: preparation.membershipRevision,
    },
  );
}

function custodyGuard(
  transfers: AccountDeletionCustodyTransfer[],
): { sql: string; values: unknown[] } {
  const byRecipient = new Map<
    string,
    { bytes: number; count: number; workspaceIds: string[] }
  >();
  for (const transfer of transfers) {
    const entry = byRecipient.get(transfer.toUserId) ?? {
      bytes: 0,
      count: 0,
      workspaceIds: [],
    };
    entry.count += 1;
    entry.workspaceIds.push(transfer.workspaceId);
    byRecipient.set(transfer.toUserId, entry);
  }
  const clauses: string[] = [];
  const values: unknown[] = [];
  for (const [recipient, plan] of byRecipient) {
    clauses.push(
      `EXISTS (
         SELECT 1
         FROM users recipient
         WHERE recipient.user_id = ?
           AND recipient.status = 'active'
           AND recipient.deleted_at IS NULL
       )
       AND (
         SELECT COUNT(*)
         FROM workspace_custody existing
         WHERE existing.custodian_user_id = ?
       ) + ? <= ?
       AND (
         SELECT COALESCE(SUM(snapshot.stored_bytes), 0)
         FROM workspace_custody existing
         JOIN workspace_snapshots snapshot
           ON snapshot.workspace_id = existing.workspace_id
         WHERE existing.custodian_user_id = ?
       ) + (
         SELECT COALESCE(SUM(snapshot.stored_bytes), 0)
         FROM workspace_snapshots snapshot
         WHERE snapshot.workspace_id IN (${
           plan.workspaceIds.map(() => "?").join(",")
         })
       ) <= ?`,
    );
    values.push(
      recipient,
      recipient,
      plan.count,
      API_QUOTAS.ownedWorkspacesPerUser,
      recipient,
      ...plan.workspaceIds,
      PUBLIC_LAUNCH_LIMITS.aggregateSnapshotBytesPerAccount,
    );
  }
  for (const transfer of transfers) {
    clauses.push(
      `EXISTS (
         SELECT 1
         FROM workspace_members recipient
         JOIN users recipient_user
           ON recipient_user.user_id = recipient.user_id
         WHERE recipient.workspace_id = ?
           AND recipient.user_id = ?
           AND recipient.role = 'owner'
           AND recipient_user.status = 'active'
           AND recipient_user.deleted_at IS NULL
       )`,
    );
    values.push(transfer.workspaceId, transfer.toUserId);
  }
  return {
    sql: clauses.length ? `AND ${clauses.join("\nAND ")}` : "",
    values,
  };
}

export async function executeAccountDeletion(
  database: D1DatabaseLike,
  input: AccountDeletionExecutionInput,
): Promise<AccountDeletionExecutionResult> {
  if (input.confirmation !== "DELETE") {
    throw new ApiProblem(
      "CONFIRMATION_REQUIRED",
      "Type DELETE to confirm account deletion",
      400,
    );
  }
  requireRevision(input.expectedAccountRevision, "account revision");
  requireRevision(input.expectedMembershipRevision, "membership revision");
  const at = new Date();
  assertRecentAuthentication(input.reauthenticatedAt, at);
  const db = databaseLike(database);
  const preparation = await prepareAccountDeletion(db, input.userId);
  if (
    preparation.accountRevision !== input.expectedAccountRevision
    || preparation.membershipRevision !==
      input.expectedMembershipRevision
  ) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "The account or its workspace memberships changed; review deletion again",
      409,
      {
        accountRevision: preparation.accountRevision,
        membershipRevision: preparation.membershipRevision,
      },
    );
  }
  if (preparation.blockers.length > 0) {
    throw deletionBlockerProblem(preparation);
  }

  const now = at.toISOString();
  const deletionId = newId("del");
  const digest = await accountDeletionDigest(
    input.digestKey,
    input.userId,
  );
  const deletedEmail = `${deletionId}@deleted.invalid`;
  const transferGuard = custodyGuard(preparation.custodyTransfers);
  const statements: D1StatementLike[] = [
    db.prepare(
      `UPDATE users
       SET
         email = ?,
         display_name = 'Deleted user',
         global_role = 'user',
         status = 'disabled',
         updated_at = ?,
         last_seen_at = NULL,
         deleted_at = ?
       WHERE user_id = ?
         AND status = 'active'
         AND deleted_at IS NULL
         AND global_role = 'user'
         AND account_revision = ?
         AND membership_revision = ?
         AND NOT (
           global_role = 'admin'
           AND (
             SELECT COUNT(*)
             FROM users
             WHERE global_role = 'admin'
               AND status = 'active'
               AND deleted_at IS NULL
           ) <= 1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_members owned
           WHERE owned.user_id = users.user_id
             AND owned.role = 'owner'
             AND NOT EXISTS (
               SELECT 1
               FROM workspace_members other
               JOIN users other_user
                 ON other_user.user_id = other.user_id
               WHERE other.workspace_id = owned.workspace_id
                 AND other.user_id <> owned.user_id
                 AND other.role = 'owner'
                 AND other_user.status = 'active'
                 AND other_user.deleted_at IS NULL
             )
         )
         ${transferGuard.sql}`,
    ).bind(
      deletedEmail,
      now,
      now,
      input.userId,
      input.expectedAccountRevision,
      input.expectedMembershipRevision,
      ...transferGuard.values,
    ),
  ];
  for (const transfer of preparation.custodyTransfers) {
    statements.push(db.prepare(
      `UPDATE workspace_custody
       SET custodian_user_id = ?, updated_at = ?
       WHERE workspace_id = ?
         AND custodian_user_id = ?
         AND EXISTS (
           SELECT 1
           FROM users deleted
           WHERE deleted.user_id = ?
             AND deleted.deleted_at = ?
         )`,
    ).bind(
      transfer.toUserId,
      now,
      transfer.workspaceId,
      input.userId,
      input.userId,
      now,
    ));
  }
  const sessionIndex = statements.length;
  statements.push(db.prepare(
    `UPDATE sessions
     SET revoked_at = ?, user_agent = NULL, ip_prefix = NULL
     WHERE user_id = ?
       AND revoked_at IS NULL
       AND expires_at > ?
       AND EXISTS (
         SELECT 1
         FROM users deleted
         WHERE deleted.user_id = sessions.user_id
           AND deleted.deleted_at = ?
       )`,
  ).bind(now, input.userId, now, now));
  statements.push(db.prepare(
    `UPDATE sessions
     SET user_agent = NULL, ip_prefix = NULL
     WHERE user_id = ?
       AND (user_agent IS NOT NULL OR ip_prefix IS NOT NULL)
       AND EXISTS (
         SELECT 1
         FROM users deleted
         WHERE deleted.user_id = sessions.user_id
           AND deleted.deleted_at = ?
       )`,
  ).bind(input.userId, now));
  const guestLinkIndex = statements.length;
  statements.push(db.prepare(
    `UPDATE guest_links
     SET revoked_at = ?
     WHERE created_by_user_id = ?
       AND revoked_at IS NULL
       AND consumed_at IS NULL
       AND expires_at > ?
       AND EXISTS (
         SELECT 1
         FROM users deleted
         WHERE deleted.user_id = guest_links.created_by_user_id
           AND deleted.deleted_at = ?
       )`,
  ).bind(now, input.userId, now, now));
  const identityIndex = statements.length;
  statements.push(db.prepare(
    `DELETE FROM identities
     WHERE user_id = ?
       AND EXISTS (
         SELECT 1
         FROM users deleted
         WHERE deleted.user_id = identities.user_id
           AND deleted.deleted_at = ?
       )`,
  ).bind(input.userId, now));
  const membershipIndex = statements.length;
  statements.push(db.prepare(
    `DELETE FROM workspace_members
     WHERE user_id = ?
       AND EXISTS (
         SELECT 1
         FROM users deleted
         WHERE deleted.user_id = workspace_members.user_id
           AND deleted.deleted_at = ?
       )`,
  ).bind(input.userId, now));
  statements.push(
    db.prepare(
      `UPDATE creation_ledger
       SET
         event_id = CASE
           WHEN event_id = ? THEN ?
           ELSE event_id
         END,
         scope_id = CASE
           WHEN scope_type = 'account' THEN ?
           ELSE scope_id
         END
       WHERE (
         (scope_type = 'account' AND scope_id = ?)
         OR event_id = ?
       )
         AND EXISTS (
           SELECT 1
           FROM users deleted
           WHERE deleted.user_id = ?
             AND deleted.deleted_at = ?
         )`,
    ).bind(
      `account:${input.userId}`,
      `account-deleted:${deletionId}`,
      `deleted:${deletionId}`,
      input.userId,
      `account:${input.userId}`,
      input.userId,
      now,
    ),
    db.prepare(
      `UPDATE auth_audit_events
       SET
         actor_user_id = CASE
           WHEN actor_user_id = ? THEN NULL
           ELSE actor_user_id
         END,
         target_id = CASE
           WHEN target_id = ? THEN ?
           WHEN
             target_id IS NOT NULL
             AND length(target_id) > length(?) + 2
             AND substr(
               target_id,
               -(length(?) + 2)
             ) = '::' || ?
           THEN
             substr(
               target_id,
               1,
               length(target_id) - length(?)
             ) || ?
           ELSE target_id
         END,
         detail_json = json_replace(
           detail_json,
           '$.createdByUserId',
           CASE
             WHEN json_extract(detail_json, '$.createdByUserId') = ? THEN ?
             ELSE json_extract(detail_json, '$.createdByUserId')
           END,
           '$.targetUserId',
           CASE
             WHEN json_extract(detail_json, '$.targetUserId') = ? THEN ?
             ELSE json_extract(detail_json, '$.targetUserId')
           END,
           '$.userId',
           CASE
             WHEN json_extract(detail_json, '$.userId') = ? THEN ?
             ELSE json_extract(detail_json, '$.userId')
           END
         )
       WHERE (
         actor_user_id = ?
         OR target_id = ?
         OR (
           target_id IS NOT NULL
           AND length(target_id) > length(?) + 2
           AND substr(
             target_id,
             -(length(?) + 2)
           ) = '::' || ?
         )
         OR json_extract(detail_json, '$.createdByUserId') = ?
         OR json_extract(detail_json, '$.targetUserId') = ?
         OR json_extract(detail_json, '$.userId') = ?
       )
         AND EXISTS (
           SELECT 1
           FROM users deleted
           WHERE deleted.user_id = ?
             AND deleted.deleted_at = ?
         )`,
    ).bind(
      input.userId,
      input.userId,
      `deleted:${deletionId}`,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      `deleted:${deletionId}`,
      input.userId,
      `deleted:${deletionId}`,
      input.userId,
      `deleted:${deletionId}`,
      input.userId,
      `deleted:${deletionId}`,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      now,
    ),
    db.prepare(
      `INSERT INTO account_deletion_receipts(
         deletion_id,
         account_digest,
         deleted_at
       )
       SELECT ?, ?, ?
       WHERE EXISTS (
         SELECT 1
         FROM users deleted
         WHERE deleted.user_id = ?
           AND deleted.deleted_at = ?
       )`,
    ).bind(deletionId, digest, now, input.userId, now),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id,
         actor_user_id,
         action,
         target_type,
         target_id,
         detail_json,
         created_at
       )
       SELECT ?, NULL, 'account.delete', 'account', ?, ?, ?
       WHERE EXISTS (
         SELECT 1
         FROM account_deletion_receipts
         WHERE deletion_id = ?
       )`,
    ).bind(
      newId("aud"),
      deletionId,
      safeAuditDetailJson("account.delete", {}),
      now,
      deletionId,
    ),
  );
  let results: D1ResultLike[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const current = await prepareAccountDeletion(db, input.userId);
    if (
      current.accountRevision !== input.expectedAccountRevision
      || current.membershipRevision !==
        input.expectedMembershipRevision
      || JSON.stringify(current.custodyTransfers) !==
        JSON.stringify(preparation.custodyTransfers)
    ) {
      throw new ApiProblem(
        "ACCESS_STALE",
        "The account or its workspace custody changed during deletion",
        409,
        {
          accountRevision: current.accountRevision,
          membershipRevision: current.membershipRevision,
        },
      );
    }
    if (current.blockers.length > 0) {
      throw deletionBlockerProblem(current);
    }
    throw error;
  }
  const receiptResult = results.at(-2);
  const auditResult = results.at(-1);
  if (changes(receiptResult) !== 1 || changes(auditResult) !== 1) {
    const current = await prepareAccountDeletion(db, input.userId);
    if (
      current.accountRevision !== input.expectedAccountRevision
      || current.membershipRevision !==
        input.expectedMembershipRevision
    ) {
      throw new ApiProblem(
        "ACCESS_STALE",
        "The account changed while deletion was being completed",
        409,
      );
    }
    throw deletionBlockerProblem(current);
  }
  return {
    deletedAt: now,
    deletionId,
    identitiesDeleted: changes(results[identityIndex]),
    membershipsDeleted: changes(results[membershipIndex]),
    sessionsRevoked: changes(results[sessionIndex]),
    unusedGuestLinksRevoked: changes(results[guestLinkIndex]),
  };
}

export async function changeGlobalRole(
  database: D1DatabaseLike,
  input: ChangeGlobalRoleInput,
): Promise<{
  accountRevision: number;
  revokedSessions: number;
  role: GlobalRole;
}> {
  requireRevision(input.expectedAccountRevision, "account revision");
  if (!Object.values(GLOBAL_ROLE).includes(input.role)) {
    throw new ApiProblem("INVALID_REQUEST", "Global role is invalid", 400);
  }
  const db = databaseLike(database);
  await requireActiveAdmin(db, input.actorUserId);
  const before = await accountRow(db, input.targetUserId);
  if (!before) {
    throw new ApiProblem(
      "NOT_FOUND_OR_INACCESSIBLE",
      "The account was not found",
      404,
    );
  }
  if (before.account_revision !== input.expectedAccountRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "The account changed; refresh and try again",
      409,
      { accountRevision: before.account_revision },
    );
  }
  if (
    input.role === GLOBAL_ROLE.ADMIN
    && (
      before.status !== ACCOUNT_STATUS.ACTIVE
      || before.deleted_at
    )
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Only an active account can be promoted to global administrator",
      409,
    );
  }
  const now = nowIso();
  let results: D1ResultLike[];
  try {
    results = await db.batch([
      db.prepare(
      `UPDATE users
       SET global_role = ?, updated_at = ?
       WHERE user_id = ?
         AND account_revision = ?
         AND deleted_at IS NULL
         AND global_role <> ?
         AND (
           ? <> 'admin'
           OR status = 'active'
         )
         AND EXISTS (
           SELECT 1
           FROM users actor
           WHERE actor.user_id = ?
             AND actor.status = 'active'
             AND actor.deleted_at IS NULL
             AND actor.global_role = 'admin'
         )`,
    ).bind(
      input.role,
      now,
      input.targetUserId,
      input.expectedAccountRevision,
      input.role,
      input.role,
      input.actorUserId,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       SELECT ?, ?, 'user.role', 'user', ?, ?, ?
       WHERE changes() = 1`,
    ).bind(
      newId("aud"),
      input.actorUserId,
      input.targetUserId,
      safeAuditDetailJson("user.role", { value: input.role }),
      now,
    ),
    db.prepare(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE user_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?
         AND EXISTS (
           SELECT 1
           FROM users target
           WHERE target.user_id = sessions.user_id
             AND target.global_role = ?
             AND target.updated_at = ?
         )`,
    ).bind(
      now,
      input.targetUserId,
      now,
      input.role,
      now,
      ),
    ]);
  } catch (error) {
    await requireActiveAdmin(db, input.actorUserId);
    const preparation = await prepareAccountDeletion(
      db,
      input.targetUserId,
    );
    if (
      input.role === GLOBAL_ROLE.USER
      && preparation.blockers.some(blocker =>
        blocker.code === "FINAL_ADMIN"
      )
    ) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "The last active administrator must be retained",
        409,
      );
    }
    throw error;
  }
  const [mutation, audit, sessionRevocation] = results;
  if (changes(mutation) !== 1 || changes(audit) !== 1) {
    await requireActiveAdmin(db, input.actorUserId);
    const target = await accountRow(db, input.targetUserId);
    if (!target) {
      throw new ApiProblem(
        "NOT_FOUND_OR_INACCESSIBLE",
        "The account was not found",
        404,
      );
    }
    if (target.account_revision !== input.expectedAccountRevision) {
      throw new ApiProblem(
        "ACCESS_STALE",
        "The account changed; refresh and try again",
        409,
        { accountRevision: target.account_revision },
      );
    }
    throw new ApiProblem(
      "INVALID_REQUEST",
      target.global_role === input.role
        ? `The account already has the ${input.role} role`
        : "The last active administrator must be retained",
      409,
    );
  }
  const updated = await accountRow(db, input.targetUserId);
  return {
    accountRevision: updated?.account_revision ??
      input.expectedAccountRevision + 1,
    role: input.role,
    revokedSessions: changes(sessionRevocation),
  };
}

export async function changeAccountStatus(
  database: D1DatabaseLike,
  input: ChangeAccountStatusInput,
): Promise<{
  accountRevision: number;
  revokedSessions: number;
  status: "active" | "disabled";
  unusedGuestLinksRevoked: number;
}> {
  requireRevision(input.expectedAccountRevision, "account revision");
  const db = databaseLike(database);
  await requireActiveAdmin(db, input.actorUserId);
  const target = await accountRow(db, input.targetUserId);
  if (!target) {
    throw new ApiProblem(
      "NOT_FOUND_OR_INACCESSIBLE",
      "The account was not found",
      404,
    );
  }
  if (target.account_revision !== input.expectedAccountRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "The account changed; refresh and try again",
      409,
      { accountRevision: target.account_revision },
    );
  }
  if (target.status === ACCOUNT_STATUS.BANNED) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Lift the account ban before changing its active status",
      409,
    );
  }
  if (target.status === input.status) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `The account is already ${input.status}`,
      409,
    );
  }
  if (
    input.status === ACCOUNT_STATUS.ACTIVE
    && await hasRetainedIdentityBanDigests(
      db,
      input.targetUserId,
    )
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "A redacted post-ban account cannot be enabled",
      409,
    );
  }
  if (input.status === ACCOUNT_STATUS.DISABLED) {
    const preparation = await prepareAccountDeletion(
      db,
      input.targetUserId,
    );
    const authorityBlockers = preparation.blockers.filter(blocker =>
      blocker.code === "FINAL_ADMIN"
      || blocker.code === "FINAL_WORKSPACE_OWNER"
    );
    if (authorityBlockers.length > 0) {
      throw new ApiProblem(
        "ACCOUNT_DELETION_BLOCKED",
        "Transfer required authority before disabling this account",
        409,
        { blockers: authorityBlockers },
      );
    }
  }
  const now = nowIso();
  let results: D1ResultLike[];
  try {
    results = await db.batch([
      db.prepare(
      `UPDATE users
       SET status = ?, updated_at = ?
       WHERE user_id = ?
         AND account_revision = ?
         AND deleted_at IS NULL
         AND status <> ?
         AND status <> 'banned'
         AND (
           ? <> 'active'
           OR NOT EXISTS (
             SELECT 1
             FROM identity_ban_digests retained_ban
             WHERE retained_ban.source_user_id = users.user_id
           )
         )
         AND EXISTS (
           SELECT 1
           FROM users actor
           WHERE actor.user_id = ?
             AND actor.status = 'active'
             AND actor.deleted_at IS NULL
             AND actor.global_role = 'admin'
         )`,
    ).bind(
      input.status,
      now,
      input.targetUserId,
      input.expectedAccountRevision,
      input.status,
      input.status,
      input.actorUserId,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       SELECT ?, ?, 'user.status', 'user', ?, ?, ?
       WHERE changes() = 1`,
    ).bind(
      newId("aud"),
      input.actorUserId,
      input.targetUserId,
      safeAuditDetailJson("user.status", { value: input.status }),
      now,
    ),
    db.prepare(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE user_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?
         AND ? = 'disabled'
         AND EXISTS (
           SELECT 1
           FROM users target
           WHERE target.user_id = sessions.user_id
             AND target.status = 'disabled'
             AND target.updated_at = ?
         )`,
    ).bind(
      now,
      input.targetUserId,
      now,
      input.status,
      now,
      ),
    db.prepare(
      `UPDATE guest_links
       SET revoked_at = ?
       WHERE created_by_user_id = ?
         AND revoked_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > ?
         AND ? = 'disabled'
         AND EXISTS (
           SELECT 1
           FROM users target
           WHERE target.user_id = guest_links.created_by_user_id
             AND target.status = 'disabled'
             AND target.updated_at = ?
         )`,
    ).bind(
      now,
      input.targetUserId,
      now,
      input.status,
      now,
    ),
    ]);
  } catch (error) {
    await requireActiveAdmin(db, input.actorUserId);
    if (input.status === ACCOUNT_STATUS.DISABLED) {
      const preparation = await prepareAccountDeletion(
        db,
        input.targetUserId,
      );
      const authorityBlockers = preparation.blockers.filter(blocker =>
        blocker.code === "FINAL_ADMIN"
        || blocker.code === "FINAL_WORKSPACE_OWNER"
      );
      if (authorityBlockers.length > 0) {
        throw new ApiProblem(
          "ACCOUNT_DELETION_BLOCKED",
          "Transfer required authority before disabling this account",
          409,
          { blockers: authorityBlockers },
        );
      }
    }
    throw error;
  }
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) {
    await requireActiveAdmin(db, input.actorUserId);
    if (
      input.status === ACCOUNT_STATUS.ACTIVE
      && await hasRetainedIdentityBanDigests(
        db,
        input.targetUserId,
      )
    ) {
      throw new ApiProblem(
        "INVALID_REQUEST",
        "A redacted post-ban account cannot be enabled",
        409,
      );
    }
    throw new ApiProblem(
      "ACCESS_STALE",
      "The account changed while its status was being updated",
      409,
    );
  }
  const updated = await accountRow(db, input.targetUserId);
  return {
    accountRevision: updated?.account_revision ??
      input.expectedAccountRevision + 1,
    revokedSessions: changes(results[2]),
    status: input.status,
    unusedGuestLinksRevoked: changes(results[3]),
  };
}

export async function banAccount(
  database: D1DatabaseLike,
  input: BanAccountInput,
): Promise<{
  accountRevision: number;
  identityDigests: number;
  revokedSessions: number;
}> {
  requireRevision(input.expectedAccountRevision, "account revision");
  const reason = requireReason(input.reason, MAXIMUM_BAN_REASON_LENGTH);
  const db = databaseLike(database);
  await requireActiveAdmin(db, input.actorUserId);
  const target = await accountRow(db, input.targetUserId);
  if (!target) {
    throw new ApiProblem(
      "NOT_FOUND_OR_INACCESSIBLE",
      "The account was not found",
      404,
    );
  }
  if (target.account_revision !== input.expectedAccountRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "The account changed; refresh and try again",
      409,
      { accountRevision: target.account_revision },
    );
  }
  if (target.status === ACCOUNT_STATUS.BANNED) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The account is already banned",
      409,
    );
  }
  if (target.global_role === GLOBAL_ROLE.ADMIN) {
    throw new ApiProblem(
      "ACCOUNT_DELETION_BLOCKED",
      "Demote the global administrator before banning this account",
      409,
      { blockers: [{ code: "GLOBAL_ADMIN" }] },
    );
  }
  if (target.status === ACCOUNT_STATUS.ACTIVE) {
    const preparation = await prepareAccountDeletion(
      db,
      input.targetUserId,
    );
    const authorityBlockers = preparation.blockers.filter(blocker =>
      blocker.code === "FINAL_ADMIN"
      || blocker.code === "FINAL_WORKSPACE_OWNER"
    );
    if (authorityBlockers.length > 0) {
      throw new ApiProblem(
        "ACCOUNT_DELETION_BLOCKED",
        "Transfer required authority before banning this account",
        409,
        { blockers: authorityBlockers },
      );
    }
  }
  const identities = await db.prepare(
    `SELECT provider, provider_subject
     FROM identities
     WHERE user_id = ?
     ORDER BY identity_id`,
  ).bind(input.targetUserId).all<IdentityRow>();
  if (
    identities.results.length === 0
    && !await hasRetainedIdentityBanDigests(
      db,
      input.targetUserId,
    )
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The account has no retained sign-in identity to enforce",
      409,
    );
  }
  const digests = await Promise.all(
    identities.results.map(identity =>
      identityEnforcementDigest(
        input.digestKey,
        identity.provider,
        identity.provider_subject,
      )
    ),
  );
  const now = nowIso();
  const banTombstoneId = newId("ban");
  const statements: D1StatementLike[] = [
    db.prepare(
      `UPDATE users
       SET
         email = ?,
         display_name = 'Banned account',
         status = 'banned',
         updated_at = ?,
         last_seen_at = NULL
       WHERE user_id = ?
         AND account_revision = ?
         AND deleted_at IS NULL
         AND status <> 'banned'
         AND global_role = 'user'
         AND EXISTS (
           SELECT 1
           FROM users actor
           WHERE actor.user_id = ?
             AND actor.status = 'active'
             AND actor.deleted_at IS NULL
             AND actor.global_role = 'admin'
         )`,
    ).bind(
      `${banTombstoneId}@banned.invalid`,
      now,
      input.targetUserId,
      input.expectedAccountRevision,
      input.actorUserId,
    ),
  ];
  for (const digest of digests) {
    statements.push(db.prepare(
      `INSERT INTO identity_ban_digests(
         identity_digest,
         source_user_id,
         reason,
         created_at,
         created_by_user_id,
         lifted_at,
         lifted_by_user_id
       )
       SELECT ?, ?, ?, ?, ?, NULL, NULL
       WHERE EXISTS (
         SELECT 1
         FROM users target
         WHERE target.user_id = ?
           AND target.status = 'banned'
           AND target.updated_at = ?
       )
       ON CONFLICT(identity_digest) DO UPDATE SET
         source_user_id = excluded.source_user_id,
         reason = excluded.reason,
         created_at = excluded.created_at,
         created_by_user_id = excluded.created_by_user_id,
         lifted_at = NULL,
         lifted_by_user_id = NULL`,
    ).bind(
      digest,
      input.targetUserId,
      reason,
      now,
      input.actorUserId,
      input.targetUserId,
      now,
    ));
  }
  statements.push(db.prepare(
    `UPDATE identity_ban_digests
     SET
       reason = ?,
       created_at = ?,
       created_by_user_id = ?,
       lifted_at = NULL,
       lifted_by_user_id = NULL
     WHERE source_user_id = ?
       AND EXISTS (
         SELECT 1
         FROM users target
         WHERE target.user_id = ?
           AND target.status = 'banned'
           AND target.updated_at = ?
       )`,
  ).bind(
    reason,
    now,
    input.actorUserId,
    input.targetUserId,
    input.targetUserId,
    now,
  ));
  statements.push(db.prepare(
    `DELETE FROM identities
     WHERE user_id = ?
       AND EXISTS (
         SELECT 1
         FROM users target
         WHERE target.user_id = identities.user_id
           AND target.status = 'banned'
           AND target.updated_at = ?
       )`,
  ).bind(input.targetUserId, now));
  const sessionIndex = statements.length;
  statements.push(
    db.prepare(
      `UPDATE sessions
       SET revoked_at = ?, user_agent = NULL
       WHERE user_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?
         AND EXISTS (
           SELECT 1
           FROM users target
           WHERE target.user_id = sessions.user_id
             AND target.status = 'banned'
             AND target.updated_at = ?
         )`,
    ).bind(now, input.targetUserId, now, now),
    db.prepare(
      `UPDATE guest_links
       SET revoked_at = ?
       WHERE created_by_user_id = ?
         AND revoked_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > ?
         AND EXISTS (
           SELECT 1
           FROM users target
           WHERE target.user_id = guest_links.created_by_user_id
             AND target.status = 'banned'
             AND target.updated_at = ?
         )`,
    ).bind(now, input.targetUserId, now, now),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       SELECT ?, ?, 'user.ban', 'user', ?, ?, ?
       WHERE EXISTS (
         SELECT 1
         FROM users target
         WHERE target.user_id = ?
           AND target.status = 'banned'
           AND target.updated_at = ?
       )`,
    ).bind(
      newId("aud"),
      input.actorUserId,
      input.targetUserId,
      safeAuditDetailJson("user.ban", {}),
      now,
      input.targetUserId,
      now,
    ),
  );
  let results: D1ResultLike[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    await requireActiveAdmin(db, input.actorUserId);
    const preparation = await prepareAccountDeletion(
      db,
      input.targetUserId,
    );
    const authorityBlockers = preparation.blockers.filter(blocker =>
      blocker.code === "FINAL_ADMIN"
      || blocker.code === "FINAL_WORKSPACE_OWNER"
      || blocker.code === "GLOBAL_ADMIN"
    );
    if (authorityBlockers.length > 0) {
      throw new ApiProblem(
        "ACCOUNT_DELETION_BLOCKED",
        "Transfer required authority before banning this account",
        409,
        { blockers: authorityBlockers },
      );
    }
    throw error;
  }
  if (changes(results[0]) !== 1 || changes(results.at(-1)) !== 1) {
    await requireActiveAdmin(db, input.actorUserId);
    throw new ApiProblem(
      "ACCESS_STALE",
      "The account changed while the ban was being applied",
      409,
    );
  }
  const enforcedDigests = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM identity_ban_digests
     WHERE source_user_id = ?
       AND lifted_at IS NULL`,
  ).bind(input.targetUserId).first<{ count: number }>();
  const updated = await accountRow(db, input.targetUserId);
  return {
    accountRevision: updated?.account_revision ??
      input.expectedAccountRevision + 1,
    identityDigests: enforcedDigests?.count ?? 0,
    revokedSessions: changes(results[sessionIndex]),
  };
}

export async function liftAccountBan(
  database: D1DatabaseLike,
  input: {
    actorUserId: string;
    expectedAccountRevision: number;
    targetUserId: string;
  },
): Promise<{ accountRevision: number; status: "disabled" }> {
  requireRevision(input.expectedAccountRevision, "account revision");
  const db = databaseLike(database);
  await requireActiveAdmin(db, input.actorUserId);
  const now = nowIso();
  const results = await db.batch([
    db.prepare(
      `UPDATE users
       SET status = 'disabled', updated_at = ?
       WHERE user_id = ?
         AND status = 'banned'
         AND deleted_at IS NULL
         AND account_revision = ?
         AND EXISTS (
           SELECT 1
           FROM users actor
           WHERE actor.user_id = ?
             AND actor.status = 'active'
             AND actor.deleted_at IS NULL
             AND actor.global_role = 'admin'
         )`,
    ).bind(
      now,
      input.targetUserId,
      input.expectedAccountRevision,
      input.actorUserId,
    ),
    db.prepare(
      `UPDATE identity_ban_digests
       SET lifted_at = ?, lifted_by_user_id = ?
       WHERE source_user_id = ?
         AND lifted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM users target
           WHERE target.user_id = ?
             AND target.status = 'disabled'
             AND target.updated_at = ?
         )`,
    ).bind(
      now,
      input.actorUserId,
      input.targetUserId,
      input.targetUserId,
      now,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       SELECT ?, ?, 'user.ban.lift', 'user', ?, ?, ?
       WHERE EXISTS (
         SELECT 1
         FROM users target
         WHERE target.user_id = ?
           AND target.status = 'disabled'
           AND target.updated_at = ?
       )`,
    ).bind(
      newId("aud"),
      input.actorUserId,
      input.targetUserId,
      safeAuditDetailJson("user.ban.lift", {}),
      now,
      input.targetUserId,
      now,
    ),
  ]);
  if (changes(results[0]) !== 1 || changes(results[2]) !== 1) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "The account changed while the ban was being lifted",
      409,
    );
  }
  const updated = await accountRow(db, input.targetUserId);
  return {
    accountRevision: updated?.account_revision ??
      input.expectedAccountRevision + 1,
    status: "disabled",
  };
}

export async function bootstrapGlobalAdmin(
  database: D1DatabaseLike,
  targetUserId: string,
): Promise<BootstrapGlobalAdminResult> {
  const db = databaseLike(database);
  const current = await accountRow(db, targetUserId);
  if (
    !current
    || current.status !== ACCOUNT_STATUS.ACTIVE
    || current.deleted_at
  ) {
    return { status: "ineligible" };
  }
  if (current.global_role === GLOBAL_ROLE.ADMIN) {
    return { status: "already-admin", userId: targetUserId };
  }
  const now = nowIso();
  const [mutation, audit] = await db.batch([
    db.prepare(
      `UPDATE users
       SET global_role = 'admin', updated_at = ?
       WHERE user_id = ?
         AND status = 'active'
         AND deleted_at IS NULL
         AND global_role = 'user'
         AND NOT EXISTS (
           SELECT 1
           FROM users active_admin
           WHERE active_admin.global_role = 'admin'
             AND active_admin.status = 'active'
             AND active_admin.deleted_at IS NULL
         )`,
    ).bind(now, targetUserId),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       SELECT ?, NULL, 'admin.bootstrap', 'user', ?, ?, ?
       WHERE changes() = 1`,
    ).bind(
      newId("aud"),
      targetUserId,
      safeAuditDetailJson("admin.bootstrap", {}),
      now,
    ),
  ]);
  if (changes(mutation) === 1 && changes(audit) === 1) {
    return { status: "promoted", userId: targetUserId };
  }
  const after = await accountRow(db, targetUserId);
  if (after?.global_role === GLOBAL_ROLE.ADMIN) {
    return { status: "already-admin", userId: targetUserId };
  }
  return { status: "active-admin-exists" };
}

export async function recoverGlobalAdmin(
  database: D1DatabaseLike,
  input: {
    emailMatched?: boolean;
    principalDigest: string;
    reason: string;
    recoveryMode: AdminRecoveryMode;
    retainedSessionId: string;
    targetUserId: string;
  },
): Promise<RecoverGlobalAdminResult> {
  if (!Object.values(ADMIN_RECOVERY_MODE).includes(input.recoveryMode)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Administrator recovery mode is invalid",
      400,
    );
  }
  const principalDigest = requireVersionedDigest(
    input.principalDigest,
  );
  if (
    input.emailMatched !== undefined
    && typeof input.emailMatched !== "boolean"
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The Access email match result is invalid",
      400,
    );
  }
  if (
    input.recoveryMode === ADMIN_RECOVERY_MODE.APP_SESSION
    && input.emailMatched !== undefined
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Access email matching does not apply to app-session recovery",
      400,
    );
  }
  const reason = requireReason(
    input.reason,
    MAXIMUM_CIRCUIT_REASON_LENGTH,
  );
  if (!input.retainedSessionId.trim()) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Administrator recovery session is required",
      400,
    );
  }
  const db = databaseLike(database);
  const before = await accountRow(db, input.targetUserId);
  if (
    !before
    || before.status !== ACCOUNT_STATUS.ACTIVE
    || before.deleted_at
  ) {
    return { status: "ineligible" };
  }
  const now = nowIso();
  const [promotion, sessionRevocation, audit] = await db.batch([
    db.prepare(
      `UPDATE users
       SET global_role = 'admin', updated_at = ?
       WHERE user_id = ?
         AND status = 'active'
         AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM sessions recovery_session
           WHERE recovery_session.session_id = ?
             AND recovery_session.user_id = users.user_id
             AND recovery_session.revoked_at IS NULL
             AND recovery_session.expires_at > ?
         )`,
    ).bind(
      now,
      input.targetUserId,
      input.retainedSessionId,
      now,
    ),
    db.prepare(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE revoked_at IS NULL
         AND expires_at > ?
         AND session_id <> ?
         AND user_id IN (
           SELECT admin.user_id
           FROM users admin
           WHERE admin.global_role = 'admin'
         )
         AND EXISTS (
           SELECT 1
           FROM users recovered
           WHERE recovered.user_id = ?
             AND recovered.global_role = 'admin'
             AND recovered.status = 'active'
             AND recovered.deleted_at IS NULL
             AND recovered.updated_at = ?
         )`,
    ).bind(
      now,
      now,
      input.retainedSessionId,
      input.targetUserId,
      now,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       SELECT ?, NULL, 'admin.recover', 'user', ?, ?, ?
       WHERE EXISTS (
         SELECT 1
         FROM users recovered
         WHERE recovered.user_id = ?
           AND recovered.global_role = 'admin'
           AND recovered.status = 'active'
           AND recovered.deleted_at IS NULL
           AND recovered.updated_at = ?
       )`,
    ).bind(
      newId("aud"),
      input.targetUserId,
      safeAuditDetailJson("admin.recover", {
        principalDigest,
        ...(input.emailMatched === undefined
          ? {}
          : { emailMatched: input.emailMatched }),
        reason,
        recoveryMode: input.recoveryMode,
      }),
      now,
      input.targetUserId,
      now,
    ),
  ]);
  if (changes(promotion) !== 1 || changes(audit) !== 1) {
    return { status: "ineligible" };
  }
  return {
    promoted: before.global_role !== GLOBAL_ROLE.ADMIN,
    revokedSessions: changes(sessionRevocation),
    status: "recovered",
    userId: input.targetUserId,
  };
}

export async function readCircuitBreakers(
  database: D1DatabaseLike,
): Promise<CircuitBreaker[]> {
  const result = await database.prepare(
    `SELECT
       scope,
       state,
       reason,
       updated_at,
       updated_by_user_id,
       pause_kind,
       resume_at,
       trigger_count
     FROM circuit_breakers
     ORDER BY scope`,
  ).all<{
    reason: string | null;
    pause_kind: CircuitBreakerPauseKind;
    resume_at: string | null;
    scope: CircuitBreakerScope;
    state: CircuitBreakerState;
    trigger_count: number;
    updated_at: string;
    updated_by_user_id: string | null;
  }>();
  const now = Date.now();
  return result.results.map(row => ({
    effectiveState:
      row.state === CIRCUIT_BREAKER_STATE.PAUSED
      && row.pause_kind === CIRCUIT_BREAKER_PAUSE_KIND.SECURITY
      && row.resume_at !== null
      && Date.parse(row.resume_at) <= now
        ? CIRCUIT_BREAKER_STATE.OPEN
        : row.state,
    pauseKind: row.pause_kind,
    reason: row.reason,
    resumeAt: row.resume_at,
    scope: row.scope,
    state: row.state,
    triggerCount: row.trigger_count,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
  }));
}

export async function readGovernanceLimits(
  database: D1DatabaseLike,
): Promise<GovernanceLimit[]> {
  const result = await database.prepare(
    `SELECT
       limit_key,
       limit_value,
       updated_at,
       updated_by_user_id
     FROM governance_limits
     ORDER BY limit_key`,
  ).all<{
    limit_key: GovernanceLimitKey;
    limit_value: number;
    updated_at: string;
    updated_by_user_id: string | null;
  }>();
  return result.results.map(row => ({
    key: row.limit_key,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
    value: row.limit_value,
  }));
}

export async function setGovernanceLimit(
  database: D1DatabaseLike,
  input: {
    actorUserId: string;
    key: GovernanceLimitKey;
    reason: string;
    value: number;
  },
): Promise<GovernanceLimit> {
  if (!Object.values(GOVERNANCE_LIMIT_KEY).includes(input.key)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Governance limit key is invalid",
      400,
    );
  }
  const maximum = MAXIMUM_GOVERNANCE_LIMIT[input.key];
  if (
    !Number.isSafeInteger(input.value)
    || input.value < 0
    || input.value > maximum
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `Governance limit must be an integer from 0 through ${maximum}`,
      400,
    );
  }
  const reason = requireReason(
    input.reason,
    MAXIMUM_GOVERNANCE_REASON_LENGTH,
  );
  const db = databaseLike(database);
  await requireActiveAdmin(db, input.actorUserId);
  const now = nowIso();
  const [mutation, audit] = await db.batch([
    db.prepare(
      `UPDATE governance_limits
       SET
         limit_value = ?,
         updated_at = ?,
         updated_by_user_id = ?
       WHERE limit_key = ?
         AND limit_value <> ?
         AND EXISTS (
           SELECT 1
           FROM users actor
           WHERE actor.user_id = ?
             AND actor.status = 'active'
             AND actor.deleted_at IS NULL
             AND actor.global_role = 'admin'
         )`,
    ).bind(
      input.value,
      now,
      input.actorUserId,
      input.key,
      input.value,
      input.actorUserId,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       SELECT ?, ?, 'governance.limit.set', 'governance-limit', ?, ?, ?
       WHERE changes() = 1`,
    ).bind(
      newId("aud"),
      input.actorUserId,
      input.key,
      safeAuditDetailJson("governance.limit.set", {
        key: input.key,
        reason,
        value: input.value,
      }),
      now,
    ),
  ]);
  const current = (await readGovernanceLimits(db))
    .find(candidate => candidate.key === input.key);
  if (
    changes(mutation) === 0
    && current?.value === input.value
  ) {
    await requireActiveAdmin(db, input.actorUserId);
    return current;
  }
  if (
    changes(mutation) !== 1
    || changes(audit) !== 1
    || !current
  ) {
    await requireActiveAdmin(db, input.actorUserId);
    throw new ApiProblem(
      "ACCESS_STALE",
      "The governance limit changed; refresh and try again",
      409,
    );
  }
  return current;
}

export async function setCircuitBreaker(
  database: D1DatabaseLike,
  input: {
    actorUserId: string;
    pauseKind: CircuitBreakerPauseKind;
    reason: string | null;
    resumeAt?: string | null;
    scope: CircuitBreakerScope;
    state: CircuitBreakerState;
  },
): Promise<CircuitBreaker> {
  if (!Object.values(CIRCUIT_BREAKER_SCOPE).includes(input.scope)) {
    throw new ApiProblem("INVALID_REQUEST", "Circuit scope is invalid", 400);
  }
  if (!Object.values(CIRCUIT_BREAKER_STATE).includes(input.state)) {
    throw new ApiProblem("INVALID_REQUEST", "Circuit state is invalid", 400);
  }
  if (
    !Object.values(CIRCUIT_BREAKER_PAUSE_KIND)
      .includes(input.pauseKind)
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Circuit pause kind is invalid",
      400,
    );
  }
  const reason = input.reason === null
    ? null
    : requireReason(input.reason, MAXIMUM_CIRCUIT_REASON_LENGTH);
  if (input.state === CIRCUIT_BREAKER_STATE.PAUSED && !reason) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "A reason is required when pausing a circuit",
      400,
    );
  }
  const requestedResumeAt = input.state === CIRCUIT_BREAKER_STATE.OPEN
    || input.pauseKind === CIRCUIT_BREAKER_PAUSE_KIND.CAPACITY
    ? null
    : input.resumeAt ?? null;
  if (
    input.state === CIRCUIT_BREAKER_STATE.PAUSED
    && input.pauseKind === CIRCUIT_BREAKER_PAUSE_KIND.SECURITY
    && (
      !requestedResumeAt
      || !Number.isFinite(Date.parse(requestedResumeAt))
      || Date.parse(requestedResumeAt) <= Date.now()
    )
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "A future resume time is required for a security pause",
      400,
    );
  }
  const resumeAt = requestedResumeAt === null
    ? null
    : new Date(Date.parse(requestedResumeAt)).toISOString();
  const db = databaseLike(database);
  await requireActiveAdmin(db, input.actorUserId);
  const now = nowIso();
  const [mutation, audit] = await db.batch([
    db.prepare(
      `UPDATE circuit_breakers
       SET
         state = ?,
         reason = ?,
         updated_at = ?,
         updated_by_user_id = ?,
         pause_kind = ?,
         resume_at = ?,
         trigger_count = CASE
           WHEN ? = 'paused' THEN trigger_count + 1
           ELSE trigger_count
         END
       WHERE scope = ?
         AND (
           state <> ?
           OR reason IS NOT ?
           OR pause_kind <> ?
           OR resume_at IS NOT ?
         )
         AND EXISTS (
           SELECT 1
           FROM users actor
           WHERE actor.user_id = ?
             AND actor.status = 'active'
             AND actor.deleted_at IS NULL
             AND actor.global_role = 'admin'
         )`,
    ).bind(
      input.state,
      reason,
      now,
      input.actorUserId,
      input.pauseKind,
      resumeAt,
      input.state,
      input.scope,
      input.state,
      reason,
      input.pauseKind,
      resumeAt,
      input.actorUserId,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at
       )
       SELECT ?, ?, 'circuit.set', 'circuit', ?, ?, ?
       WHERE changes() = 1`,
    ).bind(
      newId("aud"),
      input.actorUserId,
      input.scope,
      safeAuditDetailJson("circuit.set", {
        pauseKind: input.pauseKind,
        resumeAt,
        scope: input.scope,
        state: input.state,
      }),
      now,
    ),
  ]);
  if (changes(mutation) !== 1 || changes(audit) !== 1) {
    await requireActiveAdmin(db, input.actorUserId);
    const current = (await readCircuitBreakers(db))
      .find(candidate => candidate.scope === input.scope);
    if (
      current
      && current.state === input.state
      && current.reason === reason
      && current.pauseKind === input.pauseKind
      && current.resumeAt === resumeAt
    ) {
      return current;
    }
    throw new ApiProblem(
      "ACCESS_STALE",
      "The circuit changed; refresh and try again",
      409,
    );
  }
  const updated = (await readCircuitBreakers(db))
    .find(candidate => candidate.scope === input.scope);
  return updated ?? {
    effectiveState: input.state,
    pauseKind: input.pauseKind,
    reason,
    resumeAt,
    scope: input.scope,
    state: input.state,
    triggerCount: input.state === CIRCUIT_BREAKER_STATE.PAUSED ? 1 : 0,
    updatedAt: now,
    updatedByUserId: input.actorUserId,
  };
}

async function circuitState(
  db: GovernanceDatabase,
  scope: CircuitBreakerScope,
  at = new Date(),
): Promise<CircuitBreakerState | null> {
  const row = await db.prepare(
    `SELECT
       CASE
         WHEN state = 'paused'
           AND pause_kind = 'security'
           AND resume_at IS NOT NULL
           AND resume_at <= ?
         THEN 'open'
         ELSE state
       END AS state
     FROM circuit_breakers
     WHERE scope = ?`,
  ).bind(
    at.toISOString(),
    scope,
  ).first<{ state: CircuitBreakerState }>();
  return row?.state ?? null;
}

function pausedProblem(action: string): ApiProblem {
  return new ApiProblem(
    "CIRCUIT_PAUSED",
    `${action} is temporarily paused`,
    503,
  );
}

function quotaProblem(
  quota: string,
  limit: number,
  actual: number,
  status = 409,
  retryAfterSeconds?: number,
): ApiProblem {
  return new ApiProblem(
    "QUOTA_EXCEEDED",
    "This account has reached a durable usage limit",
    status,
    {
      actual,
      limit,
      quota,
      ...(retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds }),
    },
  );
}

function secondsUntilNextUtcDay(at: Date): number {
  return Math.max(
    1,
    Math.ceil((
      Date.UTC(
        at.getUTCFullYear(),
        at.getUTCMonth(),
        at.getUTCDate() + 1,
      ) - at.getTime()
    ) / 1_000),
  );
}

export async function accountCreationRefusal(
  database: D1DatabaseLike,
  at = new Date(),
): Promise<ApiProblem | null> {
  const db = databaseLike(database);
  if (
    await circuitState(db, CIRCUIT_BREAKER_SCOPE.NEW_ACCOUNTS, at) !==
      CIRCUIT_BREAKER_STATE.OPEN
  ) {
    return pausedProblem("New account creation");
  }
  const row = await db.prepare(
    `SELECT
       (
         SELECT COUNT(*)
         FROM creation_ledger
         WHERE scope_type = 'installation'
           AND scope_id = 'installation'
           AND resource = 'account'
           AND date(created_at) = date(?)
       ) AS actual,
       (
         SELECT limit_value
         FROM governance_limits
         WHERE limit_key = 'new_accounts_per_day'
       ) AS limit_value`,
  ).bind(at.toISOString()).first<{
    actual: number;
    limit_value: number | null;
  }>();
  const limit = row?.limit_value ?? 0;
  return (row?.actual ?? 0) >= limit
    ? quotaProblem(
      "newAccountsPerDay",
      limit,
      (row?.actual ?? 0) + 1,
      429,
      secondsUntilNextUtcDay(at),
    )
    : null;
}

export async function sessionIssuanceRefusal(
  database: D1DatabaseLike,
  userId: string,
  at = new Date(),
): Promise<ApiProblem | null> {
  const db = databaseLike(database);
  const row = await db.prepare(
    `SELECT
       user.status,
       user.deleted_at,
       (
         SELECT COUNT(*)
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = user.user_id
           AND resource = 'session'
           AND date(created_at) = date(?)
       ) AS issued_day,
       (
         SELECT COUNT(*)
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = user.user_id
           AND resource = 'session'
           AND julianday(created_at) > julianday(?) - 30
       ) AS issued_rolling,
       (
         SELECT MIN(created_at)
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = user.user_id
           AND resource = 'session'
           AND julianday(created_at) > julianday(?) - 30
       ) AS oldest_rolling_created_at
     FROM users user
     WHERE user.user_id = ?`,
  ).bind(
    at.toISOString(),
    at.toISOString(),
    at.toISOString(),
    userId,
  ).first<{
    deleted_at: string | null;
    issued_day: number;
    issued_rolling: number;
    oldest_rolling_created_at: string | null;
    status: AccountStatus;
  }>();
  if (!row || row.deleted_at || row.status !== ACCOUNT_STATUS.ACTIVE) {
    return new ApiProblem(
      row?.status === ACCOUNT_STATUS.BANNED
        ? "ACCOUNT_BANNED"
        : "AUTHENTICATION_REQUIRED",
      row?.status === ACCOUNT_STATUS.BANNED
        ? "This account is banned"
        : "This account is not active",
      row?.status === ACCOUNT_STATUS.BANNED ? 403 : 401,
    );
  }
  if (
    row.issued_day >=
      PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountDay
  ) {
    return quotaProblem(
      "sessionsIssuedPerAccountDay",
      PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountDay,
      row.issued_day + 1,
      429,
      secondsUntilNextUtcDay(at),
    );
  }
  if (
    row.issued_rolling >=
      PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountRolling30Days
  ) {
    return quotaProblem(
      "sessionsIssuedPerAccountRolling30Days",
      PUBLIC_LAUNCH_LIMITS.sessionsIssuedPerAccountRolling30Days,
      row.issued_rolling + 1,
      429,
      Math.max(
        1,
        Math.ceil((
          Date.parse(row.oldest_rolling_created_at ?? "") +
            ROLLING_CREATION_WINDOW_MS -
            at.getTime()
        ) / 1_000) || 1,
      ),
    );
  }
  return null;
}

export async function sessionIssuanceOutcome(
  database: D1DatabaseLike,
  userId: string,
  sessionId: string,
): Promise<SessionIssuanceOutcome> {
  const replaced = await database.prepare(
    `SELECT session_id
     FROM sessions
     WHERE user_id = ?
       AND replaced_by_session_id = ?
     ORDER BY created_at, session_id`,
  ).bind(userId, sessionId).all<{ session_id: string }>();
  return {
    replacedSessionIds: replaced.results.map(row => row.session_id),
    sessionId,
  };
}

export async function trimTerminalSessions(
  database: D1DatabaseLike,
  at = new Date(),
  userId?: string,
): Promise<number> {
  const now = at.toISOString();
  const result = await database.prepare(
    `DELETE FROM sessions
     WHERE session_id IN (
       SELECT terminal.session_id
       FROM sessions terminal
       WHERE (
           terminal.revoked_at IS NOT NULL
           OR terminal.expires_at <= ?
         )
         AND (
           julianday(COALESCE(
             terminal.revoked_at,
             terminal.expires_at
           )) <= julianday(?) - ?
           OR (
             SELECT COUNT(*)
             FROM sessions newer
             WHERE newer.user_id = terminal.user_id
               AND (
                 newer.revoked_at IS NOT NULL
                 OR newer.expires_at <= ?
               )
               AND (
                 COALESCE(newer.revoked_at, newer.expires_at) >
                   COALESCE(
                     terminal.revoked_at,
                     terminal.expires_at
                   )
                 OR (
                   COALESCE(
                     newer.revoked_at,
                     newer.expires_at
                   ) = COALESCE(
                     terminal.revoked_at,
                     terminal.expires_at
                   )
                   AND newer.session_id > terminal.session_id
                 )
               )
           ) >= ?
         )
         AND (? IS NULL OR terminal.user_id = ?)
       ORDER BY COALESCE(
         terminal.revoked_at,
         terminal.expires_at
       ), terminal.session_id
       LIMIT ?
     )`,
  ).bind(
    now,
    now,
    PUBLIC_LAUNCH_LIMITS.terminalSessionRetentionDays,
    now,
    PUBLIC_LAUNCH_LIMITS.terminalSessionsPerAccount,
    userId ?? null,
    userId ?? null,
    TERMINAL_SESSION_TRIM_BATCH,
  ).run();
  return changes(result);
}

export async function membershipAdmissionRefusal(
  database: D1DatabaseLike,
  userId: string,
): Promise<ApiProblem | null> {
  const row = await database.prepare(
    `SELECT
       user.status,
       user.deleted_at,
       (
         SELECT COUNT(*)
         FROM workspace_members
         WHERE user_id = user.user_id
       ) AS memberships
     FROM users user
     WHERE user.user_id = ?`,
  ).bind(userId).first<{
    deleted_at: string | null;
    memberships: number;
    status: AccountStatus;
  }>();
  if (!row || row.deleted_at || row.status !== ACCOUNT_STATUS.ACTIVE) {
    return new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      "This account is not active",
      401,
    );
  }
  return row.memberships >=
      PUBLIC_LAUNCH_LIMITS.membershipsPerAccount
    ? quotaProblem(
      "membershipsPerAccount",
      PUBLIC_LAUNCH_LIMITS.membershipsPerAccount,
      row.memberships + 1,
    )
    : null;
}

export async function guestLinkCreationRefusal(
  database: D1DatabaseLike,
  userId: string,
  at = new Date(),
): Promise<ApiProblem | null> {
  const db = databaseLike(database);
  if (
    await circuitState(db, CIRCUIT_BREAKER_SCOPE.GUEST_LINKS, at) !==
      CIRCUIT_BREAKER_STATE.OPEN
  ) {
    return pausedProblem("Guest link creation");
  }
  const row = await db.prepare(
    `SELECT
       (
         SELECT COUNT(*)
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = ?
           AND resource = 'guest_link'
           AND date(created_at) = date(?)
       ) AS created_day,
       (
         SELECT COUNT(*)
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = ?
           AND resource = 'guest_link'
           AND julianday(created_at) > julianday(?) - 30
       ) AS created_rolling`,
  ).bind(
    userId,
    at.toISOString(),
    userId,
    at.toISOString(),
  ).first<{ created_day: number; created_rolling: number }>();
  if (
    (row?.created_day ?? 0) >=
      PUBLIC_LAUNCH_LIMITS.guestLinksCreatedPerAccountDay
  ) {
    return quotaProblem(
      "guestLinksCreatedPerAccountDay",
      PUBLIC_LAUNCH_LIMITS.guestLinksCreatedPerAccountDay,
      (row?.created_day ?? 0) + 1,
      429,
    );
  }
  if (
    (row?.created_rolling ?? 0) >=
      PUBLIC_LAUNCH_LIMITS.guestLinksCreatedPerAccountRolling30Days
  ) {
    return quotaProblem(
      "guestLinksCreatedPerAccountRolling30Days",
      PUBLIC_LAUNCH_LIMITS.guestLinksCreatedPerAccountRolling30Days,
      (row?.created_rolling ?? 0) + 1,
      429,
    );
  }
  return null;
}

export async function guestRedemptionRefusal(
  database: D1DatabaseLike,
  userId: string,
): Promise<ApiProblem | null> {
  const db = databaseLike(database);
  if (
    await circuitState(db, CIRCUIT_BREAKER_SCOPE.GUEST_REDEMPTIONS) !==
      CIRCUIT_BREAKER_STATE.OPEN
  ) {
    return pausedProblem("Guest link redemption");
  }
  return membershipAdmissionRefusal(db, userId);
}

export async function snapshotGrowthRefusal(
  database: D1DatabaseLike,
  workspaceId: string,
  nextStoredBytes: number,
  at = new Date(),
): Promise<ApiProblem | null> {
  if (!Number.isSafeInteger(nextStoredBytes) || nextStoredBytes < 0) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "Snapshot storage size is invalid",
      400,
    );
  }
  const db = databaseLike(database);
  const row = await db.prepare(
    `SELECT
       snapshot.stored_bytes,
       custody.custodian_user_id,
       (
         SELECT COALESCE(SUM(owned_snapshot.stored_bytes), 0)
         FROM workspace_custody owned_custody
         JOIN workspace_snapshots owned_snapshot
           ON owned_snapshot.workspace_id =
              owned_custody.workspace_id
         WHERE owned_custody.custodian_user_id =
           custody.custodian_user_id
       ) AS aggregate_stored_bytes
     FROM workspace_snapshots snapshot
     LEFT JOIN workspace_custody custody
       ON custody.workspace_id = snapshot.workspace_id
     WHERE snapshot.workspace_id = ?`,
  ).bind(workspaceId).first<{
    aggregate_stored_bytes: number;
    custodian_user_id: string | null;
    stored_bytes: number;
  }>();
  if (!row || nextStoredBytes <= row.stored_bytes) return null;
  if (
    await circuitState(
      db,
      CIRCUIT_BREAKER_SCOPE.SNAPSHOT_GROWTH,
      at,
    ) !== CIRCUIT_BREAKER_STATE.OPEN
  ) {
    return pausedProblem("Server snapshot growth");
  }
  const aggregate = row.aggregate_stored_bytes -
    row.stored_bytes +
    nextStoredBytes;
  return row.custodian_user_id &&
      aggregate >
        PUBLIC_LAUNCH_LIMITS.aggregateSnapshotBytesPerAccount
    ? quotaProblem(
      "aggregateSnapshotBytesPerAccount",
      PUBLIC_LAUNCH_LIMITS.aggregateSnapshotBytesPerAccount,
      aggregate,
    )
    : null;
}

export async function workspaceAllocationRefusal(
  database: D1DatabaseLike,
  userId: string,
  snapshotBytes: number,
  at = new Date(),
): Promise<ApiProblem | null> {
  const db = databaseLike(database);
  if (
    await circuitState(db, CIRCUIT_BREAKER_SCOPE.NEW_WORKSPACES, at) !==
      CIRCUIT_BREAKER_STATE.OPEN
  ) {
    return pausedProblem("New server workspace allocation");
  }
  const row = await db.prepare(
    `SELECT
       user.status,
       user.deleted_at,
       (
         SELECT COUNT(*)
         FROM workspace_custody
         WHERE custodian_user_id = user.user_id
       ) AS workspace_count,
       (
         SELECT COALESCE(SUM(snapshot.stored_bytes), 0)
         FROM workspace_custody custody
         JOIN workspace_snapshots snapshot
           ON snapshot.workspace_id = custody.workspace_id
         WHERE custody.custodian_user_id = user.user_id
       ) AS stored_bytes,
       (
         SELECT COUNT(*)
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = user.user_id
           AND resource = 'workspace'
           AND date(created_at) = date(?)
       ) AS created_day,
       (
         SELECT COUNT(*)
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = user.user_id
           AND resource = 'workspace'
           AND julianday(created_at) > julianday(?) - 30
       ) AS created_rolling,
       (
         SELECT COUNT(*)
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = user.user_id
           AND resource = 'workspace'
       ) AS created_lifetime
     FROM users user
     WHERE user.user_id = ?`,
  ).bind(
    at.toISOString(),
    at.toISOString(),
    userId,
  ).first<{
    created_day: number;
    created_lifetime: number;
    created_rolling: number;
    deleted_at: string | null;
    status: AccountStatus;
    stored_bytes: number;
    workspace_count: number;
  }>();
  if (!row || row.deleted_at || row.status !== ACCOUNT_STATUS.ACTIVE) {
    return new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      "This account is not active",
      401,
    );
  }
  const durableChecks: Array<[boolean, string, number, number]> = [
    [
      row.workspace_count >= API_QUOTAS.ownedWorkspacesPerUser,
      "ownedWorkspacesPerUser",
      API_QUOTAS.ownedWorkspacesPerUser,
      row.workspace_count + 1,
    ],
    [
      row.stored_bytes + snapshotBytes >
        PUBLIC_LAUNCH_LIMITS.aggregateSnapshotBytesPerAccount,
      "aggregateSnapshotBytesPerAccount",
      PUBLIC_LAUNCH_LIMITS.aggregateSnapshotBytesPerAccount,
      row.stored_bytes + snapshotBytes,
    ],
    [
      row.created_lifetime >=
        PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountLifetime,
      "workspacesCreatedPerAccountLifetime",
      PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountLifetime,
      row.created_lifetime + 1,
    ],
  ];
  const durableRefusal = durableChecks.find(([blocked]) => blocked);
  if (durableRefusal) {
    return quotaProblem(
      durableRefusal[1],
      durableRefusal[2],
      durableRefusal[3],
    );
  }
  const rollingLimit =
    PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountRolling30Days;
  const rollingBlocked = row.created_rolling >= rollingLimit;
  const rollingUnblock = rollingBlocked
    ? await db.prepare(
        `SELECT created_at
         FROM creation_ledger
         WHERE scope_type = 'account'
           AND scope_id = ?
           AND resource = 'workspace'
           AND julianday(created_at) > julianday(?) - 30
         ORDER BY julianday(created_at), created_at, event_id
         LIMIT 1 OFFSET ?`,
      ).bind(
        userId,
        at.toISOString(),
        row.created_rolling - rollingLimit,
      ).first<{ created_at: string }>()
    : null;
  const velocityChecks: Array<{
    actual: number;
    blocked: boolean;
    limit: number;
    quota: string;
    retryAfterSeconds: number;
  }> = [
    {
      actual: row.created_day + 1,
      blocked: row.created_day >=
        PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountDay,
      limit: PUBLIC_LAUNCH_LIMITS.workspacesCreatedPerAccountDay,
      quota: "workspacesCreatedPerAccountDay",
      retryAfterSeconds: secondsUntilNextUtcDay(at),
    },
    {
      actual: row.created_rolling + 1,
      blocked: rollingBlocked,
      limit: rollingLimit,
      quota: "workspacesCreatedPerAccountRolling30Days",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((
          Date.parse(rollingUnblock?.created_at ?? "") +
            ROLLING_CREATION_WINDOW_MS -
            at.getTime()
        ) / 1_000) || 1,
      ),
    },
  ];
  const velocityRefusal = velocityChecks
    .filter(check => check.blocked)
    .sort(
      (left, right) =>
        right.retryAfterSeconds - left.retryAfterSeconds,
    )[0];
  return velocityRefusal
    ? quotaProblem(
        velocityRefusal.quota,
        velocityRefusal.limit,
        velocityRefusal.actual,
        429,
        velocityRefusal.retryAfterSeconds,
      )
    : null;
}

export async function redactExpiredRoutineAuditDetails(
  database: D1DatabaseLike,
  at = new Date(),
  batchSize = AUTH_AUDIT_REDACTION_BATCH_SIZE,
): Promise<number> {
  if (
    !Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > 1_000
  ) {
    throw new RangeError(
      "Audit redaction batch size must be an integer from 1 through 1000",
    );
  }
  const result = await database.prepare(
    `UPDATE auth_audit_events
     SET detail_json = '{}'
     WHERE event_id IN (
       SELECT event_id
       FROM auth_audit_events
       WHERE action IN ('session.issue', 'session.revoke')
         AND detail_json <> '{}'
         AND julianday(created_at) <= julianday(?) - ?
       ORDER BY created_at, event_id
       LIMIT ?
     )`,
  ).bind(
    at.toISOString(),
    AUTH_AUDIT_DETAIL_RETENTION_DAYS,
    batchSize,
  ).run();
  return changes(result);
}
