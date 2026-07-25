import type {
  D1DatabaseLike,
  D1ResultLike,
} from "../adapters/d1-snapshot-store";
import {
  parseSnapshot,
  type WorkspaceState,
} from "../domain";
import { newId, nowIso } from "../domain/factories";
import { API_QUOTAS } from "../shared/api-quotas";
import { ApiProblem } from "./api-problem";
import { safeAuditDetailJson } from "./audit-detail";
import { QuotaExceededError } from "./quotas";

interface Statement {
  all<T>(): Promise<{ results: T[] }>;
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1ResultLike>;
}

interface AdminWorkspaceDatabase {
  batch(statements: Statement[]): Promise<D1ResultLike[]>;
  prepare(query: string): Statement;
}

interface AdminWorkspaceRow {
  access_revision: number;
  created_at: string;
  operator_role: "editor" | "owner" | "viewer" | null;
  revision: number;
  state_json: string;
  updated_at: string;
  workspace_id: string;
}

interface AdminWorkspaceContext {
  access_revision: number;
  name: string;
  revision: number;
  workspace_id: string;
}

interface DeleteAdminWorkspaceInput {
  confirmationName: string;
  expectedAccessRevision: number;
  expectedRevision: number;
}

interface TakeAdminWorkspaceOwnershipInput {
  expectedAccessRevision: number;
}

const MAXIMUM_SAFE_REVISION = Number.MAX_SAFE_INTEGER;
const MAXIMUM_WORKSPACE_ID_LENGTH = 128;

function databaseLike(
  database: D1DatabaseLike,
): AdminWorkspaceDatabase {
  return database as unknown as AdminWorkspaceDatabase;
}

function resultChanges(result: D1ResultLike | undefined): number {
  return result?.success ? result.meta?.changes ?? 0 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function requiredRevision(
  record: Record<string, unknown>,
  field: string,
): number {
  const value = record[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `${field} must be a non-negative safe integer`,
      400,
    );
  }
  return value;
}

function parseDeleteAdminWorkspace(
  value: unknown,
): DeleteAdminWorkspaceInput {
  if (!isRecord(value)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The request body must be a JSON object",
      400,
    );
  }
  if (
    typeof value.confirmationName !== "string" ||
    !value.confirmationName.trim()
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "confirmationName must be a non-empty string",
      400,
    );
  }
  return {
    confirmationName: value.confirmationName,
    expectedAccessRevision: requiredRevision(
      value,
      "expectedAccessRevision",
    ),
    expectedRevision: requiredRevision(value, "expectedRevision"),
  };
}

function parseTakeAdminWorkspaceOwnership(
  value: unknown,
): TakeAdminWorkspaceOwnershipInput {
  if (!isRecord(value)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The request body must be a JSON object",
      400,
    );
  }
  return {
    expectedAccessRevision: requiredRevision(
      value,
      "expectedAccessRevision",
    ),
  };
}

export function requireAdminWorkspaceId(value: string): string {
  if (!value || value.length > MAXIMUM_WORKSPACE_ID_LENGTH) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The workspace ID is invalid",
      400,
    );
  }
  return value;
}

async function requireActiveAdmin(
  db: AdminWorkspaceDatabase,
  actorUserId: string,
): Promise<void> {
  const actor = await db.prepare(
    `SELECT 1 AS authorized
     FROM users
     WHERE user_id=? AND status='active' AND global_role='admin'`,
  ).bind(actorUserId).first<{ authorized: number }>();
  if (!actor) {
    throw new ApiProblem(
      "ADMIN_REQUIRED",
      "Global administrator access is required",
      403,
    );
  }
}

async function explainMissingWorkspace(
  db: AdminWorkspaceDatabase,
  actorUserId: string,
  workspaceId: string,
): Promise<never> {
  await requireActiveAdmin(db, actorUserId);
  const deleted = await db.prepare(
    `SELECT deletion_id,deleted_at
     FROM workspace_deletions
     WHERE workspace_id=?`,
  ).bind(workspaceId).first<{
    deleted_at: string;
    deletion_id: string;
  }>();
  if (deleted) {
    throw new ApiProblem(
      "WORKSPACE_DELETED",
      "The server workspace was deleted",
      410,
      {
        deletedAt: deleted.deleted_at,
        deletionId: deleted.deletion_id,
      },
    );
  }
  throw new ApiProblem(
    "NOT_FOUND_OR_INACCESSIBLE",
    "The workspace was not found or is not accessible",
    404,
  );
}

async function adminWorkspaceContext(
  db: AdminWorkspaceDatabase,
  actorUserId: string,
  workspaceId: string,
): Promise<AdminWorkspaceContext> {
  const context = await db.prepare(
    `SELECT snapshot.workspace_id,snapshot.revision,
            snapshot.access_revision,
            COALESCE(
              NULLIF(
                json_extract(snapshot.state_json,'$.workspace.name'),
                ''
              ),
              snapshot.workspace_id
            ) AS name
     FROM workspace_snapshots snapshot
     JOIN users actor
       ON actor.user_id=?
      AND actor.status='active'
      AND actor.global_role='admin'
     WHERE snapshot.workspace_id=?
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_deletions deleted
         WHERE deleted.workspace_id=snapshot.workspace_id
       )`,
  ).bind(actorUserId, workspaceId).first<AdminWorkspaceContext>();
  if (!context) {
    return explainMissingWorkspace(db, actorUserId, workspaceId);
  }
  if (
    !Number.isSafeInteger(context.revision) ||
    context.revision < 0 ||
    !Number.isSafeInteger(context.access_revision) ||
    context.access_revision < 0
  ) {
    throw new Error("Stored workspace revisions are invalid");
  }
  return context;
}

function inspectionDetail(
  state: WorkspaceState,
  accessRevision: number,
  snapshotBytes: number,
) {
  return {
    accessRevision,
    activityCount: state.activities.length,
    auditEventCount: state.audit.length,
    commandReceiptCount: state.commandReceipts.length,
    itemCount: state.items.length,
    locationCount: state.locations.length,
    planCount: state.plans.length,
    snapshotBytes,
    snapshotRevision: state.workspace.revision,
    workspaceId: state.workspace.id,
  };
}

export async function inspectAdminWorkspace(
  database: D1DatabaseLike,
  actorUserId: string,
  requestedWorkspaceId: string,
) {
  const workspaceId = requireAdminWorkspaceId(requestedWorkspaceId);
  const db = databaseLike(database);
  const row = await db.prepare(
    `SELECT snapshot.workspace_id,snapshot.revision,
            snapshot.access_revision,snapshot.state_json,
            snapshot.created_at,snapshot.updated_at,
            (
              SELECT member.role
              FROM workspace_members member
              WHERE member.workspace_id=snapshot.workspace_id
                AND member.user_id=actor.user_id
            ) AS operator_role
     FROM workspace_snapshots snapshot
     JOIN users actor
       ON actor.user_id=?
      AND actor.status='active'
      AND actor.global_role='admin'
     WHERE snapshot.workspace_id=?
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_deletions deleted
         WHERE deleted.workspace_id=snapshot.workspace_id
       )`,
  ).bind(actorUserId, workspaceId).first<AdminWorkspaceRow>();
  if (!row) {
    return explainMissingWorkspace(db, actorUserId, workspaceId);
  }
  let state: WorkspaceState;
  try {
    state = parseSnapshot(row.state_json);
  } catch {
    throw new Error("Stored workspace snapshot failed validation");
  }
  if (
    state.workspace.id !== row.workspace_id ||
    state.workspace.revision !== row.revision
  ) {
    throw new Error(
      "Stored workspace identity does not match its snapshot row",
    );
  }
  const inspectedAt = nowIso();
  const snapshotBytes = new TextEncoder().encode(row.state_json).byteLength;
  const auditResult = await db.prepare(
    `INSERT INTO auth_audit_events(
       event_id,actor_user_id,action,target_type,target_id,detail_json,
       created_at
     )
     SELECT ?,?,'workspace.inspect','workspace',?,?,?
     FROM users actor
     JOIN workspace_snapshots snapshot
       ON snapshot.workspace_id=?
      AND snapshot.revision=?
      AND snapshot.access_revision=?
      AND snapshot.updated_at=?
     WHERE actor.user_id=?
       AND actor.status='active'
       AND actor.global_role='admin'
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_deletions deleted
         WHERE deleted.workspace_id=snapshot.workspace_id
       )`,
  ).bind(
    newId("aud"),
    actorUserId,
    workspaceId,
    safeAuditDetailJson(
      "workspace.inspect",
      inspectionDetail(state, row.access_revision, snapshotBytes),
    ),
    inspectedAt,
    workspaceId,
    row.revision,
    row.access_revision,
    row.updated_at,
    actorUserId,
  ).run();
  if (resultChanges(auditResult) !== 1) {
    await requireActiveAdmin(db, actorUserId);
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "The workspace changed during inspection; refresh and try again",
      409,
    );
  }
  return {
    accessRevision: row.access_revision,
    createdAt: row.created_at,
    inspectedAt,
    operatorRole: row.operator_role,
    snapshotBytes,
    state,
    updatedAt: row.updated_at,
    workspaceId,
  };
}

export async function takeAdminWorkspaceOwnership(
  database: D1DatabaseLike,
  actorUserId: string,
  requestedWorkspaceId: string,
  value: unknown,
) {
  const workspaceId = requireAdminWorkspaceId(requestedWorkspaceId);
  const input = parseTakeAdminWorkspaceOwnership(value);
  const db = databaseLike(database);
  const context = await adminWorkspaceContext(
    db,
    actorUserId,
    workspaceId,
  );
  if (context.access_revision !== input.expectedAccessRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access changed; refresh and try again",
      409,
      { accessRevision: context.access_revision },
    );
  }
  if (context.access_revision >= MAXIMUM_SAFE_REVISION) {
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "The workspace access revision counter is exhausted",
      409,
    );
  }
  const changedAt = nowIso();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO workspace_members(
         workspace_id,user_id,role,created_at
       )
       SELECT snapshot.workspace_id,actor.user_id,'owner',?
       FROM workspace_snapshots snapshot
       JOIN users actor
         ON actor.user_id=?
        AND actor.status='active'
        AND actor.global_role='admin'
       WHERE snapshot.workspace_id=?
         AND snapshot.access_revision=?
         AND snapshot.access_revision<?
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_deletions deleted
           WHERE deleted.workspace_id=snapshot.workspace_id
         )
         AND (
           EXISTS (
             SELECT 1
             FROM workspace_members current
             WHERE current.workspace_id=snapshot.workspace_id
               AND current.user_id=actor.user_id
           )
           OR (
             SELECT COUNT(*)
             FROM workspace_members retained
             WHERE retained.workspace_id=snapshot.workspace_id
           )<?
         )
         AND (
           SELECT COUNT(*)
           FROM workspace_members owned
           WHERE owned.user_id=actor.user_id
             AND owned.role='owner'
         )<?
       ON CONFLICT(workspace_id,user_id) DO UPDATE
       SET role='owner'
       WHERE workspace_members.role<>'owner'`,
    ).bind(
      changedAt,
      actorUserId,
      workspaceId,
      input.expectedAccessRevision,
      MAXIMUM_SAFE_REVISION,
      API_QUOTAS.membersPerWorkspace,
      API_QUOTAS.ownedWorkspacesPerUser,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id,actor_user_id,action,target_type,target_id,detail_json,
         created_at
       )
       SELECT ?,?,'workspace.custody','workspace',?,?,?
       WHERE changes()=1`,
    ).bind(
      newId("aud"),
      actorUserId,
      workspaceId,
      safeAuditDetailJson(
        "workspace.custody",
        {
          role: "owner",
          source: "global-admin",
          workspaceId,
        },
      ),
      changedAt,
    ),
    db.prepare(
      `SELECT snapshot.access_revision
       FROM workspace_snapshots snapshot
       WHERE snapshot.workspace_id=?
         AND EXISTS (
           SELECT 1
           FROM workspace_members member
           WHERE member.workspace_id=snapshot.workspace_id
             AND member.user_id=?
             AND member.role='owner'
         )
         AND changes()=1`,
    ).bind(workspaceId, actorUserId),
  ]);
  const result = results[2]?.results?.[0] as
    | { access_revision: number }
    | undefined;
  if (resultChanges(results[1]) === 1 && result) {
    return {
      accessRevision: result.access_revision,
      operatorRole: "owner" as const,
      workspaceId,
    };
  }
  await requireActiveAdmin(db, actorUserId);
  const current = await adminWorkspaceContext(
    db,
    actorUserId,
    workspaceId,
  );
  if (current.access_revision !== input.expectedAccessRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access changed; refresh and try again",
      409,
      { accessRevision: current.access_revision },
    );
  }
  const membership = await db.prepare(
    `SELECT role
     FROM workspace_members
     WHERE workspace_id=? AND user_id=?`,
  ).bind(workspaceId, actorUserId).first<{ role: string }>();
  if (membership?.role === "owner") {
    throw new ApiProblem(
      "ROLE_UNCHANGED",
      "The administrator is already an owner",
      409,
      { accessRevision: current.access_revision },
    );
  }
  const counts = await db.prepare(
    `SELECT
       (
         SELECT COUNT(*)
         FROM workspace_members
         WHERE workspace_id=?
       ) AS member_count,
       (
         SELECT COUNT(*)
         FROM workspace_members
         WHERE user_id=? AND role='owner'
       ) AS owned_count`,
  ).bind(workspaceId, actorUserId).first<{
    member_count: number;
    owned_count: number;
  }>();
  if (
    !membership &&
    (counts?.member_count ?? 0) >= API_QUOTAS.membersPerWorkspace
  ) {
    throw new QuotaExceededError(
      "membersPerWorkspace",
      (counts?.member_count ?? 0) + 1,
    );
  }
  if (
    (counts?.owned_count ?? 0) >= API_QUOTAS.ownedWorkspacesPerUser
  ) {
    throw new QuotaExceededError(
      "ownedWorkspacesPerUser",
      (counts?.owned_count ?? 0) + 1,
    );
  }
  throw new ApiProblem(
    "WORKSPACE_BUSY",
    "Workspace custody changed concurrently; refresh and try again",
    409,
  );
}

function auditWorkspaceDeletion(
  db: AdminWorkspaceDatabase,
  actorUserId: string,
  workspaceId: string,
  deletionId: string,
  revision: number,
  deletedAt: string,
): Statement {
  return db.prepare(
    `INSERT INTO auth_audit_events(
       event_id,actor_user_id,action,target_type,target_id,detail_json,
       created_at
     )
     SELECT ?,?,'workspace.delete','workspace',?,?,?
     WHERE changes()=1`,
  ).bind(
    newId("aud"),
    actorUserId,
    workspaceId,
    safeAuditDetailJson(
      "workspace.delete",
      {
        deletionId,
        finalSnapshotRevision: revision,
        source: "global-admin",
        workspaceId,
      },
    ),
    deletedAt,
  );
}

export async function deleteAdminWorkspace(
  database: D1DatabaseLike,
  actorUserId: string,
  requestedWorkspaceId: string,
  value: unknown,
) {
  const workspaceId = requireAdminWorkspaceId(requestedWorkspaceId);
  const input = parseDeleteAdminWorkspace(value);
  const db = databaseLike(database);
  const context = await adminWorkspaceContext(
    db,
    actorUserId,
    workspaceId,
  );
  if (context.access_revision !== input.expectedAccessRevision) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access changed; refresh and try again",
      409,
      { accessRevision: context.access_revision },
    );
  }
  if (
    context.revision !== input.expectedRevision ||
    context.name !== input.confirmationName
  ) {
    throw new ApiProblem(
      "CONFIRMATION_REQUIRED",
      "The workspace changed; confirm its current name and revision",
      409,
      {
        currentAccessRevision: context.access_revision,
        currentName: context.name,
        currentRevision: context.revision,
      },
    );
  }
  if (context.access_revision >= MAXIMUM_SAFE_REVISION) {
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "The workspace access revision counter is exhausted",
      409,
    );
  }
  const deletionId = newId("deletion");
  const deletedAt = nowIso();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO workspace_deletions(
         workspace_id,deletion_id,deleted_at,deleted_by_user_id,
         final_snapshot_revision,final_access_revision
       )
       SELECT snapshot.workspace_id,?,?,?,
              snapshot.revision,snapshot.access_revision+1
       FROM workspace_snapshots snapshot
       JOIN users actor
         ON actor.user_id=?
        AND actor.status='active'
        AND actor.global_role='admin'
       WHERE snapshot.workspace_id=?
         AND snapshot.revision=?
         AND snapshot.access_revision=?
         AND json_extract(
           snapshot.state_json,
           '$.workspace.name'
         )=?
         AND snapshot.access_revision<?
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_deletions prior
           WHERE prior.workspace_id=snapshot.workspace_id
         )`,
    ).bind(
      deletionId,
      deletedAt,
      actorUserId,
      actorUserId,
      workspaceId,
      input.expectedRevision,
      input.expectedAccessRevision,
      input.confirmationName,
      MAXIMUM_SAFE_REVISION,
    ),
    auditWorkspaceDeletion(
      db,
      actorUserId,
      workspaceId,
      deletionId,
      context.revision,
      deletedAt,
    ),
    db.prepare(
      `UPDATE sessions
       SET revoked_at=?
       WHERE revoked_at IS NULL
         AND expires_at>?
         AND user_id IN (
           SELECT member.user_id
           FROM workspace_members member
           WHERE member.workspace_id=?
             AND EXISTS (
               SELECT 1
               FROM identities identity
               WHERE identity.user_id=member.user_id
                 AND identity.provider='guest'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM identities identity
               WHERE identity.user_id=member.user_id
                 AND identity.provider<>'guest'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM workspace_members other
               WHERE other.user_id=member.user_id
                 AND other.workspace_id<>member.workspace_id
             )
         )
         AND EXISTS (
           SELECT 1
           FROM workspace_deletions deleted
           WHERE deleted.workspace_id=?
             AND deleted.deletion_id=?
         )`,
    ).bind(
      deletedAt,
      deletedAt,
      workspaceId,
      workspaceId,
      deletionId,
    ),
    db.prepare(
      `DELETE FROM guest_links
       WHERE workspace_id=?
         AND EXISTS (
           SELECT 1
           FROM workspace_deletions deleted
           WHERE deleted.workspace_id=guest_links.workspace_id
             AND deleted.deletion_id=?
         )`,
    ).bind(workspaceId, deletionId),
    db.prepare(
      `DELETE FROM workspace_members
       WHERE workspace_id=?
         AND EXISTS (
           SELECT 1
           FROM workspace_deletions deleted
           WHERE deleted.workspace_id=workspace_members.workspace_id
             AND deleted.deletion_id=?
         )`,
    ).bind(workspaceId, deletionId),
    db.prepare(
      `UPDATE workspace_deletions
       SET final_access_revision=(
         SELECT snapshot.access_revision+1
         FROM workspace_snapshots snapshot
         WHERE snapshot.workspace_id=workspace_deletions.workspace_id
       )
       WHERE workspace_id=?
         AND deletion_id=?
         AND EXISTS (
           SELECT 1
           FROM workspace_snapshots snapshot
           WHERE snapshot.workspace_id=workspace_deletions.workspace_id
             AND snapshot.access_revision<?
         )`,
    ).bind(workspaceId, deletionId, MAXIMUM_SAFE_REVISION),
    db.prepare(
      `DELETE FROM workspace_snapshots
       WHERE workspace_id=?
         AND revision=?
         AND EXISTS (
           SELECT 1
           FROM workspace_deletions deleted
           WHERE deleted.workspace_id=workspace_snapshots.workspace_id
             AND deleted.deletion_id=?
         )`,
    ).bind(workspaceId, input.expectedRevision, deletionId),
  ]);
  if (
    resultChanges(results[0]) !== 1 ||
    resultChanges(results[1]) !== 1 ||
    resultChanges(results[5]) !== 1 ||
    resultChanges(results[6]) !== 1
  ) {
    const deleted = await db.prepare(
      `SELECT deletion_id,deleted_at
       FROM workspace_deletions
       WHERE workspace_id=?`,
    ).bind(workspaceId).first<{
      deleted_at: string;
      deletion_id: string;
    }>();
    if (deleted) {
      throw new ApiProblem(
        "WORKSPACE_DELETED",
        "The server workspace was already deleted",
        410,
        {
          deletedAt: deleted.deleted_at,
          deletionId: deleted.deletion_id,
        },
      );
    }
    const current = await adminWorkspaceContext(
      db,
      actorUserId,
      workspaceId,
    );
    throw new ApiProblem(
      "WORKSPACE_BUSY",
      "The workspace changed during deletion; refresh and try again",
      409,
      {
        currentAccessRevision: current.access_revision,
        currentName: current.name,
        currentRevision: current.revision,
      },
    );
  }
  const deletion = await db.prepare(
    `SELECT final_access_revision
     FROM workspace_deletions
     WHERE workspace_id=? AND deletion_id=?`,
  ).bind(workspaceId, deletionId).first<{
    final_access_revision: number;
  }>();
  return {
    deleted: true,
    deletedAt,
    deletionId,
    finalAccessRevision: deletion?.final_access_revision ??
      context.access_revision + 1,
    finalSnapshotRevision: context.revision,
    recovery: "not_available",
    workspaceId,
  };
}
