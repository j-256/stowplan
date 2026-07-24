import type { D1DatabaseLike } from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";
import { API_QUOTAS } from "../shared/api-quotas";
import { QuotaExceededError } from "./quotas";

interface Statement {
  bind(...values: unknown[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<RunResult>;
}

interface RunResult {
  success: boolean;
  meta?: { changes?: number };
}

type Db = {
  batch(statements: Statement[]): Promise<RunResult[]>;
  prepare(query: string): Statement;
};

interface AdminMutationInput {
  action: string;
  targetId: string;
  value?: string;
}

const ADMIN_RESULT_LIMITS = Object.freeze({
  audit: 250,
  guestLinks: 250,
  identities: 500,
  memberships: 500,
  sessions: 250,
  users: 250,
  workspaces: 250,
});

type AdminResultName = keyof typeof ADMIN_RESULT_LIMITS;

interface AdminOverviewOptions {
  query?: string;
  viewerUserId?: string;
}

interface PagedResult {
  hasMore: boolean;
  limit: number;
}

function changes(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function page<T>(
  rows: T[],
  name: AdminResultName,
): { info: PagedResult; rows: T[] } {
  const limit = ADMIN_RESULT_LIMITS[name];
  return {
    info: { hasMore: rows.length > limit, limit },
    rows: rows.slice(0, limit),
  };
}

function searchPattern(query: string | undefined): string | null {
  const normalized = query?.trim().slice(0, 120).toLowerCase();
  return normalized ? `%${escapeLike(normalized)}%` : null;
}

export async function adminOverview(
  database: D1DatabaseLike,
  options: AdminOverviewOptions = {},
) {
  const db = database as unknown as Db;
  const now = nowIso();
  const pattern = searchPattern(options.query);
  const bindSearch = (statement: Statement, values: unknown[]) =>
    statement.bind(...values, ADMIN_RESULT_LIMITS.users + 1);
  const usersSearch = pattern
    ? "WHERE lower(u.email) LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(u.user_id) LIKE ? ESCAPE '\\'"
    : "";
  const usersValues = pattern ? [pattern, pattern, pattern] : [];
  const usersStatement = db.prepare(
    `SELECT u.user_id,u.email,u.display_name,u.global_role,u.status,
            u.created_at,u.last_seen_at,
            (
              SELECT COUNT(*)
              FROM workspace_members owned
              WHERE owned.user_id=u.user_id AND owned.role='owner'
            ) AS owned_workspace_count
     FROM users u
     ${usersSearch}
     ORDER BY u.created_at DESC
     LIMIT ?`,
  );
  const identitiesSearch = pattern
    ? "WHERE lower(u.email) LIKE ? ESCAPE '\\' OR lower(i.email) LIKE ? ESCAPE '\\' OR lower(i.provider) LIKE ? ESCAPE '\\' OR lower(i.identity_id) LIKE ? ESCAPE '\\'"
    : "";
  const identitiesValues = pattern
    ? [pattern, pattern, pattern, pattern]
    : [];
  const membershipsSearch = pattern
    ? "WHERE lower(u.email) LIKE ? ESCAPE '\\' OR lower(m.workspace_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(json_extract(s.state_json,'$.workspace.name'),'')) LIKE ? ESCAPE '\\'"
    : "";
  const membershipsValues = pattern ? [pattern, pattern, pattern] : [];
  const sessionsSearch = pattern
    ? "WHERE lower(u.email) LIKE ? ESCAPE '\\' OR lower(s.session_id) LIKE ? ESCAPE '\\'"
    : "";
  const sessionsValues = pattern ? [pattern, pattern] : [];
  const guestLinksSearch = pattern
    ? "WHERE lower(g.workspace_id) LIKE ? ESCAPE '\\' OR lower(g.guest_link_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(json_extract(s.state_json,'$.workspace.name'),'')) LIKE ? ESCAPE '\\'"
    : "";
  const guestLinksValues = pattern ? [pattern, pattern, pattern] : [];
  const auditSearch = pattern
    ? "WHERE lower(a.action) LIKE ? ESCAPE '\\' OR lower(COALESCE(a.target_id,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(u.email,'')) LIKE ? ESCAPE '\\'"
    : "";
  const auditValues = pattern ? [pattern, pattern, pattern] : [];
  const workspacesSearch = pattern
    ? "WHERE lower(s.workspace_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(json_extract(s.state_json,'$.workspace.name'),'')) LIKE ? ESCAPE '\\'"
    : "";
  const workspacesValues = pattern ? [pattern, pattern] : [];
  const [
    usersResult,
    identitiesResult,
    membershipsResult,
    sessionsResult,
    linksResult,
    auditResult,
    workspacesResult,
  ] = await Promise.all([
    bindSearch(usersStatement, usersValues)
      .all<Record<string, unknown>>(),
    db.prepare(
      `SELECT i.identity_id,i.user_id,u.email AS user_email,i.provider,
              i.email,i.created_at,i.last_used_at
       FROM identities i
       JOIN users u ON u.user_id=i.user_id
       ${identitiesSearch}
       ORDER BY i.last_used_at DESC
       LIMIT ?`,
    ).bind(
      ...identitiesValues,
      ADMIN_RESULT_LIMITS.identities + 1,
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT m.workspace_id,m.user_id,u.email,m.role,m.created_at,
              COALESCE(
                NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
                m.workspace_id
              ) AS workspace_name
       FROM workspace_members m
       JOIN users u ON u.user_id=m.user_id
       JOIN workspace_snapshots s ON s.workspace_id=m.workspace_id
       ${membershipsSearch}
       ORDER BY workspace_name,u.email
       LIMIT ?`,
    ).bind(
      ...membershipsValues,
      ADMIN_RESULT_LIMITS.memberships + 1,
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT s.session_id,s.user_id,u.email,s.created_at,s.expires_at,
              s.last_seen_at,s.revoked_at
       FROM sessions s
       JOIN users u ON u.user_id=s.user_id
       ${sessionsSearch}
       ORDER BY
         CASE
           WHEN s.revoked_at IS NULL AND s.expires_at>? THEN 0
           ELSE 1
         END,
         s.created_at DESC
       LIMIT ?`,
    ).bind(
      ...sessionsValues,
      now,
      ADMIN_RESULT_LIMITS.sessions + 1,
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT g.guest_link_id,g.workspace_id,g.role,g.created_at,
              g.expires_at,g.consumed_at,g.revoked_at,
              COALESCE(
                NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
                g.workspace_id
              ) AS workspace_name
       FROM guest_links g
       JOIN workspace_snapshots s ON s.workspace_id=g.workspace_id
       ${guestLinksSearch}
       ORDER BY
         CASE
           WHEN g.revoked_at IS NULL
             AND g.consumed_at IS NULL
             AND g.expires_at>? THEN 0
           ELSE 1
         END,
         g.created_at DESC
       LIMIT ?`,
    ).bind(
      ...guestLinksValues,
      now,
      ADMIN_RESULT_LIMITS.guestLinks + 1,
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT a.event_id,a.actor_user_id,u.email AS actor_email,a.action,
              a.target_type,a.target_id,a.detail_json,a.created_at
       FROM auth_audit_events a
       LEFT JOIN users u ON u.user_id=a.actor_user_id
       ${auditSearch}
       ORDER BY a.created_at DESC
       LIMIT ?`,
    ).bind(
      ...auditValues,
      ADMIN_RESULT_LIMITS.audit + 1,
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT s.workspace_id,
              COALESCE(
                NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
                s.workspace_id
              ) AS workspace_name,
              s.revision,s.updated_at,
              length(CAST(s.state_json AS BLOB)) AS snapshot_bytes,
              COALESCE(json_array_length(s.state_json,'$.activities'),0)
                AS activity_count,
              COALESCE(
                (
                  SELECT SUM(
                    COALESCE(
                      json_array_length(activity.value,'$.patches'),
                      0
                    )
                  )
                  FROM json_each(s.state_json,'$.activities') activity
                ),
                0
              ) AS activity_patch_count,
              COALESCE(json_array_length(s.state_json,'$.audit'),0)
                AS audit_event_count,
              COALESCE(json_array_length(s.state_json,'$.locations'),0)
                AS location_count,
              COALESCE(json_array_length(s.state_json,'$.items'),0)
                AS item_count,
              COALESCE(json_array_length(s.state_json,'$.plans'),0)
                AS plan_count,
              COALESCE(
                (
                  SELECT SUM(
                    COALESCE(
                      json_array_length(plan.value,'$.steps'),
                      0
                    )
                  )
                  FROM json_each(s.state_json,'$.plans') plan
                ),
                0
              ) AS plan_step_count,
              COALESCE(json_array_length(s.state_json,'$.commandReceipts'),0)
                AS command_receipt_count,
              EXISTS(
                SELECT 1
                FROM workspace_members viewer
                WHERE viewer.workspace_id=s.workspace_id
                  AND viewer.user_id=?
              ) AS viewer_is_member,
              (
                SELECT COUNT(*)
                FROM workspace_members members
                WHERE members.workspace_id=s.workspace_id
              ) AS member_count,
              (
                SELECT COUNT(*)
                FROM workspace_members owners
                WHERE owners.workspace_id=s.workspace_id
                  AND owners.role='owner'
              ) AS owner_count,
              (
                SELECT COUNT(*)
                FROM guest_links active_links
                WHERE active_links.workspace_id=s.workspace_id
                  AND active_links.revoked_at IS NULL
                  AND active_links.consumed_at IS NULL
                  AND active_links.expires_at>?
              ) AS active_guest_link_count,
              (
                SELECT COUNT(*)
                FROM guest_links retained_links
                WHERE retained_links.workspace_id=s.workspace_id
              ) AS retained_guest_link_count
       FROM workspace_snapshots s
       ${workspacesSearch}
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    ).bind(
      options.viewerUserId ?? "",
      now,
      ...workspacesValues,
      ADMIN_RESULT_LIMITS.workspaces + 1,
    ).all<Record<string, unknown>>(),
  ]);
  const users = page(usersResult.results, "users");
  const identities = page(identitiesResult.results, "identities");
  const memberships = page(membershipsResult.results, "memberships");
  const sessions = page(sessionsResult.results, "sessions");
  const guestLinks = page(linksResult.results, "guestLinks");
  const auditEvents = page(auditResult.results, "audit");
  const workspaces = page(workspacesResult.results, "workspaces");
  return {
    audit: auditEvents.rows,
    guestLinks: guestLinks.rows,
    identities: identities.rows,
    limits: API_QUOTAS,
    listInfo: {
      audit: auditEvents.info,
      guestLinks: guestLinks.info,
      identities: identities.info,
      memberships: memberships.info,
      sessions: sessions.info,
      users: users.info,
      workspaces: workspaces.info,
    },
    memberships: memberships.rows,
    query: options.query?.trim().slice(0, 120) ?? "",
    sessions: sessions.rows,
    users: users.rows,
    workspaces: workspaces.rows,
  };
}

export async function audit(
  database: D1DatabaseLike,
  actor: string,
  action: string,
  targetType: string,
  targetId: string | null,
  detail: Record<string, unknown> = {},
) {
  const db = database as unknown as Db;
  await db.prepare(
    `INSERT INTO auth_audit_events(
       event_id,actor_user_id,action,target_type,target_id,detail_json,created_at
     ) VALUES(?,?,?,?,?,?,?)`,
  ).bind(
    newId("aud"),
    actor,
    action,
    targetType,
    targetId,
    JSON.stringify(detail),
    nowIso(),
  ).run();
}

async function runAuditedMutation(
  db: Db,
  actor: string,
  input: AdminMutationInput,
  mutation: Statement,
): Promise<RunResult> {
  const [mutationResult, auditResult] = await db.batch([
    mutation,
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id,actor_user_id,action,target_type,target_id,detail_json,created_at
       )
       SELECT ?,?,?,?,?,?,?
       WHERE changes()=1`,
    ).bind(
      newId("aud"),
      actor,
      input.action,
      input.action.split(".")[0],
      input.targetId,
      JSON.stringify({ value: input.value }),
      nowIso(),
    ),
  ]);
  if (!mutationResult || !auditResult) {
    throw new Error("Administrative change did not return complete results");
  }
  const mutationChanges = changes(mutationResult);
  const auditChanges = changes(auditResult);
  if (
    (mutationChanges === 1 && auditChanges !== 1) ||
    (mutationChanges !== 1 && auditChanges !== 0)
  ) {
    throw new Error("Administrative change and audit record were inconsistent");
  }
  return mutationResult;
}

function membershipTarget(targetId: string) {
  const [workspaceId, userId, ...rest] = targetId.split("::");
  if (!workspaceId || !userId || rest.length) {
    throw new Error("Invalid membership target");
  }
  return { workspaceId, userId };
}

async function explainUserRoleRefusal(
  db: Db,
  targetId: string,
  role: string,
): Promise<never> {
  const target = await db.prepare(
    "SELECT global_role,status FROM users WHERE user_id=?",
  ).bind(targetId).first<{ global_role: string; status: string }>();
  if (!target) throw new Error("User was not found");
  if (target.global_role === role) {
    throw new Error(`User already has the ${role} role`);
  }
  if (
    role === "user" &&
    target.global_role === "admin" &&
    target.status === "active"
  ) {
    throw new Error("The last active administrator cannot be removed or disabled");
  }
  throw new Error("User role could not be updated");
}

async function explainUserStatusRefusal(
  db: Db,
  targetId: string,
  status: string,
): Promise<never> {
  const target = await db.prepare(
    "SELECT global_role,status FROM users WHERE user_id=?",
  ).bind(targetId).first<{ global_role: string; status: string }>();
  if (!target) throw new Error("User was not found");
  if (target.status === status) {
    throw new Error(`User is already ${status}`);
  }
  if (
    status === "disabled" &&
    target.global_role === "admin" &&
    target.status === "active"
  ) {
    throw new Error("The last active administrator cannot be removed or disabled");
  }
  throw new Error("User status could not be updated");
}

async function explainMemberRoleRefusal(
  db: Db,
  workspaceId: string,
  userId: string,
  role: string,
): Promise<never> {
  const current = await db.prepare(
    `SELECT role
     FROM workspace_members
     WHERE workspace_id=? AND user_id=?`,
  ).bind(workspaceId, userId).first<{ role: string }>();
  if (!current) throw new Error("Workspace membership was not found");
  if (current.role === role) {
    throw new Error(`Workspace member already has the ${role} role`);
  }
  if (current.role === "owner" && role !== "owner") {
    throw new Error("A workspace must retain at least one owner");
  }
  if (role === "owner") {
    const usage = await db.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE user_id=? AND role='owner'`,
    ).bind(userId).first<{ count: number }>();
    const actual = usage?.count ?? 0;
    if (actual >= API_QUOTAS.ownedWorkspacesPerUser) {
      throw new QuotaExceededError(
        "ownedWorkspacesPerUser",
        actual + 1,
      );
    }
  }
  throw new Error("Workspace membership role could not be updated");
}

async function explainMemberRemovalRefusal(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<never> {
  const current = await db.prepare(
    `SELECT role
     FROM workspace_members
     WHERE workspace_id=? AND user_id=?`,
  ).bind(workspaceId, userId).first<{ role: string }>();
  if (!current) throw new Error("Workspace membership was not found");
  throw new Error("A workspace must retain at least one owner");
}

export async function adminMutation(
  database: D1DatabaseLike,
  actor: string,
  input: AdminMutationInput,
) {
  const db = database as unknown as Db;
  const now = nowIso();
  let message = "Administrative change saved";
  switch (input.action) {
    case "user.role": {
      if (!["admin", "user"].includes(input.value ?? "")) {
        throw new Error("Invalid role");
      }
      const role = input.value as "admin" | "user";
      const result = await runAuditedMutation(
        db,
        actor,
        input,
        db.prepare(
          `UPDATE users
           SET global_role=?,updated_at=?
           WHERE user_id=?
             AND global_role<>?
             AND NOT (
               ?='user'
               AND global_role='admin'
               AND status='active'
               AND (
                 SELECT COUNT(*)
                 FROM users
                 WHERE global_role='admin' AND status='active'
               )<=1
             )`,
        ).bind(role, now, input.targetId, role, role),
      );
      if (changes(result) !== 1) {
        await explainUserRoleRefusal(db, input.targetId, role);
      }
      message = `User role changed to ${role}`;
      break;
    }
    case "user.status": {
      if (!["active", "disabled"].includes(input.value ?? "")) {
        throw new Error("Invalid status");
      }
      const status = input.value as "active" | "disabled";
      const result = await runAuditedMutation(
        db,
        actor,
        input,
        db.prepare(
          `UPDATE users
           SET status=?,updated_at=?
           WHERE user_id=?
             AND status<>?
             AND NOT (
               ?='disabled'
               AND global_role='admin'
               AND status='active'
               AND (
                 SELECT COUNT(*)
                 FROM users
                 WHERE global_role='admin' AND status='active'
               )<=1
             )`,
        ).bind(status, now, input.targetId, status, status),
      );
      if (changes(result) !== 1) {
        await explainUserStatusRefusal(db, input.targetId, status);
      }
      message = status === "disabled"
        ? "User disabled"
        : "User enabled";
      break;
    }
    case "identity.unlink": {
      const result = await runAuditedMutation(
        db,
        actor,
        input,
        db.prepare(
          `DELETE FROM identities
           WHERE identity_id=?
             AND (
               SELECT COUNT(*)
               FROM identities
               WHERE user_id=(
                 SELECT user_id
                 FROM identities
                 WHERE identity_id=?
               )
             )>1`,
        ).bind(input.targetId, input.targetId),
      );
      if (changes(result) !== 1) {
        const identity = await db.prepare(
          "SELECT user_id FROM identities WHERE identity_id=?",
        ).bind(input.targetId).first<{ user_id: string }>();
        if (!identity) throw new Error("Identity was not found");
        throw new Error("A user must retain at least one sign-in identity");
      }
      message = "Sign-in identity unlinked";
      break;
    }
    case "member.role": {
      if (!["owner", "editor", "viewer"].includes(input.value ?? "")) {
        throw new Error("Invalid workspace role");
      }
      const role = input.value as "owner" | "editor" | "viewer";
      const target = membershipTarget(input.targetId);
      const result = await runAuditedMutation(
        db,
        actor,
        input,
        db.prepare(
          `UPDATE workspace_members
           SET role=?
           WHERE workspace_id=?
             AND user_id=?
             AND role<>?
             AND NOT (
               ?<>'owner'
               AND role='owner'
               AND (
                 SELECT COUNT(*)
                 FROM workspace_members owners
                 WHERE owners.workspace_id=?
                   AND owners.role='owner'
               )<=1
             )
             AND NOT (
               ?='owner'
               AND role<>'owner'
               AND (
                 SELECT COUNT(*)
                 FROM workspace_members owned
                 WHERE owned.user_id=?
                   AND owned.role='owner'
               )>=?
             )`,
        ).bind(
          role,
          target.workspaceId,
          target.userId,
          role,
          role,
          target.workspaceId,
          role,
          target.userId,
          API_QUOTAS.ownedWorkspacesPerUser,
        ),
      );
      if (changes(result) !== 1) {
        await explainMemberRoleRefusal(
          db,
          target.workspaceId,
          target.userId,
          role,
        );
      }
      message = `Workspace role changed to ${role}`;
      break;
    }
    case "member.remove": {
      const target = membershipTarget(input.targetId);
      const result = await runAuditedMutation(
        db,
        actor,
        input,
        db.prepare(
          `DELETE FROM workspace_members
           WHERE workspace_id=?
             AND user_id=?
             AND (
               role<>'owner'
               OR (
                 SELECT COUNT(*)
                 FROM workspace_members owners
                 WHERE owners.workspace_id=?
                   AND owners.role='owner'
               )>1
             )`,
        ).bind(
          target.workspaceId,
          target.userId,
          target.workspaceId,
        ),
      );
      if (changes(result) !== 1) {
        await explainMemberRemovalRefusal(
          db,
          target.workspaceId,
          target.userId,
        );
      }
      message = "Workspace member removed";
      break;
    }
    case "session.revoke": {
      const result = await runAuditedMutation(
        db,
        actor,
        input,
        db.prepare(
          `UPDATE sessions
           SET revoked_at=?
           WHERE session_id=?
             AND revoked_at IS NULL
             AND expires_at>?`,
        ).bind(now, input.targetId, now),
      );
      if (changes(result) !== 1) {
        const session = await db.prepare(
          `SELECT expires_at,revoked_at
           FROM sessions
           WHERE session_id=?`,
        ).bind(input.targetId).first<{
          expires_at: string;
          revoked_at: string | null;
        }>();
        if (!session) throw new Error("Session was not found");
        if (session.revoked_at) throw new Error("Session is already revoked");
        throw new Error("Expired sessions cannot be revoked");
      }
      message = "Session revoked";
      break;
    }
    case "guest.revoke": {
      const result = await runAuditedMutation(
        db,
        actor,
        input,
        db.prepare(
          `UPDATE guest_links
           SET revoked_at=?
           WHERE guest_link_id=?
             AND revoked_at IS NULL
             AND consumed_at IS NULL
             AND expires_at>?`,
        ).bind(now, input.targetId, now),
      );
      if (changes(result) !== 1) {
        const link = await db.prepare(
          `SELECT consumed_at,expires_at,revoked_at
           FROM guest_links
           WHERE guest_link_id=?`,
        ).bind(input.targetId).first<{
          consumed_at: string | null;
          expires_at: string;
          revoked_at: string | null;
        }>();
        if (!link) throw new Error("Guest link was not found");
        if (link.revoked_at) throw new Error("Guest link is already revoked");
        if (link.consumed_at) throw new Error("Used guest links cannot be revoked");
        throw new Error("Expired guest links cannot be revoked");
      }
      message = "Guest link revoked";
      break;
    }
    default:
      throw new Error("Unsupported admin action");
  }
  return { message };
}
