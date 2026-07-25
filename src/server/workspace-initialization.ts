import type {
  D1DatabaseLike,
  D1QueryResultLike,
} from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";
import type { WorkspaceRole } from "../domain/workspace-access";
import type {
  CommandAuthorizationBasis,
  WorkspaceState,
} from "../domain/types";
import { API_QUOTAS } from "../shared/api-quotas";
import { safeAuditDetailJson } from "./audit-detail";

export type WorkspaceInitializationStatus =
  | "created"
  | "deleted"
  | "exists"
  | "inactive"
  | "quota";

export interface WorkspaceInitializationResult {
  accessRevision: number | null;
  membershipRevision: number | null;
  ownerCount: number;
  status: WorkspaceInitializationStatus;
}

interface InitializationRow {
  access_revision: number | null;
  deleted: number;
  membership_revision: number | null;
  owner_count: number;
  snapshot_exists: number;
  user_active: number;
}

export type WorkspaceRestoreStatus =
  | "access-stale"
  | "busy"
  | "deleted"
  | "inactive"
  | "inaccessible"
  | "owner-required"
  | "restored"
  | "revision-stale";

export interface WorkspaceRestoreResult {
  accessRevision: number | null;
  membershipRevision: number | null;
  ownerCount: number;
  revision: number | null;
  role: WorkspaceRole | null;
  status: WorkspaceRestoreStatus;
  updatedAt: string | null;
}

interface RestoreRow {
  access_revision: number | null;
  deleted: number;
  membership_revision: number | null;
  owner_count: number;
  revision: number | null;
  role: WorkspaceRole | null;
  snapshot_exists: number;
  updated_at: string | null;
  user_active: number;
}

function changes(
  result: { meta?: { changes?: number }; success: boolean } | undefined,
): number {
  return result?.success ? result.meta?.changes ?? 0 : 0;
}

export async function initializeOwnedWorkspace(
  database: D1DatabaseLike,
  userId: string,
  state: WorkspaceState,
): Promise<WorkspaceInitializationResult> {
  const now = nowIso();
  const workspaceId = state.workspace.id;
  const results = await database.batch([
    database.prepare(
      `INSERT INTO workspace_snapshots(
         workspace_id, revision, access_revision, state_json,
         created_at, updated_at
       )
       SELECT ?, ?, 0, ?, ?, ?
       FROM users caller
       WHERE caller.user_id = ?
         AND caller.status = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_snapshots snapshots
           WHERE snapshots.workspace_id = ?
         )
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_deletions deletions
           WHERE deletions.workspace_id = ?
         )
         AND (
           SELECT COUNT(*)
           FROM workspace_members owned
           WHERE owned.user_id = caller.user_id
             AND owned.role = 'owner'
         ) < ?`,
    ).bind(
      workspaceId,
      state.workspace.revision,
      JSON.stringify(state),
      now,
      now,
      userId,
      workspaceId,
      workspaceId,
      API_QUOTAS.ownedWorkspacesPerUser,
    ),
    database.prepare(
      `INSERT INTO workspace_members(
         workspace_id, user_id, role, created_at
       )
       SELECT ?, ?, 'owner', ?
       WHERE changes() = 1`,
    ).bind(workspaceId, userId, now),
    database.prepare(
      `INSERT INTO auth_audit_events(
         event_id, actor_user_id, action, target_type, target_id,
         detail_json, created_at, ip_prefix
       )
       SELECT ?, ?, 'workspace.claim', 'workspace', ?, ?, ?, NULL
       WHERE changes() = 1`,
    ).bind(
      newId("audit"),
      userId,
      workspaceId,
      safeAuditDetailJson("workspace.claim", { role: "owner" }),
      now,
    ),
    database.prepare(
      `SELECT
         snapshots.access_revision,
         EXISTS(
           SELECT 1
           FROM workspace_deletions deletions
           WHERE deletions.workspace_id = ?
         ) AS deleted,
         caller.membership_revision,
         (
           SELECT COUNT(*)
           FROM workspace_members owned
           WHERE owned.user_id = ?
             AND owned.role = 'owner'
         ) AS owner_count,
         snapshots.workspace_id IS NOT NULL AS snapshot_exists,
         caller.status = 'active' AS user_active
       FROM users caller
       LEFT JOIN workspace_snapshots snapshots
         ON snapshots.workspace_id = ?
       WHERE caller.user_id = ?`,
    ).bind(workspaceId, userId, workspaceId, userId),
  ]);

  const row = (
    results[3] as D1QueryResultLike<InitializationRow> | undefined
  )?.results?.[0];
  if (!row) {
    return {
      accessRevision: null,
      membershipRevision: null,
      ownerCount: 0,
      status: "inactive",
    };
  }
  if (changes(results[2]) === 1) {
    return {
      accessRevision: row.access_revision,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      status: "created",
    };
  }
  if (row.deleted === 1) {
    return {
      accessRevision: null,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      status: "deleted",
    };
  }
  if (row.snapshot_exists === 1) {
    return {
      accessRevision: row.access_revision,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      status: "exists",
    };
  }
  return {
    accessRevision: null,
    membershipRevision: row.membership_revision,
    ownerCount: row.owner_count,
    status: row.user_active === 1 ? "quota" : "inactive",
  };
}

export async function restoreOwnedWorkspace(
  database: D1DatabaseLike,
  userId: string,
  expectedRevision: number,
  authorization: CommandAuthorizationBasis,
  state: WorkspaceState,
  sourceRevision: number,
): Promise<WorkspaceRestoreResult> {
  const now = nowIso();
  const workspaceId = state.workspace.id;
  const [restoreResult, auditResult, contextResult] =
    await database.batch([
      database.prepare(
        `UPDATE workspace_snapshots
         SET revision = ?, state_json = ?, updated_at = ?
         WHERE workspace_id = ?
           AND revision = ?
           AND NOT EXISTS (
             SELECT 1
             FROM workspace_deletions deletions
             WHERE deletions.workspace_id =
               workspace_snapshots.workspace_id
           )
           AND EXISTS (
             SELECT 1
             FROM workspace_members members
             JOIN users caller
               ON caller.user_id = members.user_id
             WHERE members.workspace_id =
                 workspace_snapshots.workspace_id
               AND members.user_id = ?
               AND members.role = 'owner'
               AND caller.status = 'active'
               AND (
                 caller.membership_revision = ?
                 OR workspace_snapshots.access_revision = ?
               )
           )`,
      ).bind(
        state.workspace.revision,
        JSON.stringify(state),
        now,
        workspaceId,
        expectedRevision,
        userId,
        authorization.membershipRevision,
        authorization.workspaceAccessRevision,
      ),
      database.prepare(
        `INSERT INTO auth_audit_events(
           event_id, actor_user_id, action, target_type, target_id,
           detail_json, created_at, ip_prefix
         )
         SELECT ?, ?, 'snapshot.restore', 'workspace', ?, ?, ?, NULL
         WHERE changes() = 1`,
      ).bind(
        newId("audit"),
        userId,
        workspaceId,
        safeAuditDetailJson(
          "snapshot.restore",
          {
            fromRevision: sourceRevision,
            items: state.items.length,
            locations: state.locations.length,
            plans: state.plans.length,
            toRevision: state.workspace.revision,
          },
        ),
        now,
      ),
      database.prepare(
        `SELECT
           snapshots.access_revision,
           EXISTS(
             SELECT 1
             FROM workspace_deletions deletions
             WHERE deletions.workspace_id = ?
           ) AS deleted,
           caller.membership_revision,
           (
             SELECT COUNT(*)
             FROM workspace_members owners
             JOIN users owner_user
               ON owner_user.user_id = owners.user_id
             WHERE owners.workspace_id = snapshots.workspace_id
               AND owners.role = 'owner'
               AND owner_user.status = 'active'
           ) AS owner_count,
           snapshots.revision,
           members.role,
           snapshots.workspace_id IS NOT NULL AS snapshot_exists,
           snapshots.updated_at,
           caller.status = 'active' AS user_active
         FROM users caller
         LEFT JOIN workspace_snapshots snapshots
           ON snapshots.workspace_id = ?
         LEFT JOIN workspace_members members
           ON members.workspace_id = snapshots.workspace_id
          AND members.user_id = caller.user_id
         WHERE caller.user_id = ?`,
      ).bind(workspaceId, workspaceId, userId),
    ]);
  const row = (
    contextResult as D1QueryResultLike<RestoreRow> | undefined
  )?.results?.[0];
  if (
    changes(restoreResult) === 1 &&
    changes(auditResult) === 1
  ) {
    if (!row || row.role !== "owner" || !row.updated_at) {
      throw new Error(
        "Workspace restore context was not returned",
      );
    }
    return {
      accessRevision: row.access_revision,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      revision: state.workspace.revision,
      role: row.role,
      status: "restored",
      updatedAt: row.updated_at,
    };
  }
  if (changes(restoreResult) !== changes(auditResult)) {
    throw new Error("Workspace restore and audit were inconsistent");
  }
  if (!row || row.user_active !== 1) {
    return {
      accessRevision: row?.access_revision ?? null,
      membershipRevision: row?.membership_revision ?? null,
      ownerCount: row?.owner_count ?? 0,
      revision: row?.revision ?? null,
      role: row?.role ?? null,
      status: "inactive",
      updatedAt: row?.updated_at ?? null,
    };
  }
  if (row.deleted === 1) {
    return {
      accessRevision: null,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      revision: null,
      role: null,
      status: "deleted",
      updatedAt: null,
    };
  }
  if (row.snapshot_exists !== 1 || !row.role) {
    return {
      accessRevision: row.access_revision,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      revision: row.revision,
      role: row.role,
      status: "inaccessible",
      updatedAt: row.updated_at,
    };
  }
  if (row.role !== "owner") {
    return {
      accessRevision: row.access_revision,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      revision: row.revision,
      role: row.role,
      status: "owner-required",
      updatedAt: row.updated_at,
    };
  }
  if (row.revision !== expectedRevision) {
    return {
      accessRevision: row.access_revision,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      revision: row.revision,
      role: row.role,
      status: "revision-stale",
      updatedAt: row.updated_at,
    };
  }
  if (
    row.membership_revision !== authorization.membershipRevision &&
    row.access_revision !== authorization.workspaceAccessRevision
  ) {
    return {
      accessRevision: row.access_revision,
      membershipRevision: row.membership_revision,
      ownerCount: row.owner_count,
      revision: row.revision,
      role: row.role,
      status: "access-stale",
      updatedAt: row.updated_at,
    };
  }
  return {
    accessRevision: row.access_revision,
    membershipRevision: row.membership_revision,
    ownerCount: row.owner_count,
    revision: row.revision,
    role: row.role,
    status: "busy",
    updatedAt: row.updated_at,
  };
}
