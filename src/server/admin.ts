import type { D1DatabaseLike } from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";
import { API_QUOTAS } from "../shared/api-quotas";
import { ApiProblem } from "./api-problem";
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

type InventoryMetricKind = "bytes" | "count" | "date" | "text";

interface InventoryMetric {
  kind: InventoryMetricKind;
  label: string;
  value: number | string | null;
}

interface InventoryEntry {
  key: string;
  label: string;
  metrics: InventoryMetric[];
  rowCount: number;
  table: string;
}

const MIGRATION_LEDGER_TABLES = Object.freeze([
  "__drizzle_migrations",
  "d1_migrations",
  "stowplan_node_migrations",
] as const);

function changes(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}

function refuseAdminMutation(message: string): never {
  throw new ApiProblem("INVALID_REQUEST", message, 400);
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

function numberField(
  row: Record<string, unknown> | null,
  name: string,
): number {
  const value = row?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textField(
  row: Record<string, unknown> | null,
  name: string,
): string | null {
  const value = row?.[name];
  return typeof value === "string" && value ? value : null;
}

function metric(
  label: string,
  kind: InventoryMetricKind,
  value: number | string | null,
): InventoryMetric {
  return { kind, label, value };
}

async function migrationLedgerSummary(
  db: Db,
  table: typeof MIGRATION_LEDGER_TABLES[number],
): Promise<Record<string, unknown> | null> {
  if (table === "__drizzle_migrations") {
    return db.prepare(
      `SELECT COUNT(*) AS row_count,
              strftime(
                '%Y-%m-%dT%H:%M:%fZ',
                MIN(created_at) / 1000,
                'unixepoch'
              ) AS oldest_applied_at,
              strftime(
                '%Y-%m-%dT%H:%M:%fZ',
                MAX(created_at) / 1000,
                'unixepoch'
              ) AS latest_applied_at
       FROM __drizzle_migrations`,
    ).first<Record<string, unknown>>();
  }
  if (table === "d1_migrations") {
    return db.prepare(
      `SELECT COUNT(*) AS row_count,
              MIN(applied_at) AS oldest_applied_at,
              MAX(applied_at) AS latest_applied_at
       FROM d1_migrations`,
    ).first<Record<string, unknown>>();
  }
  return db.prepare(
    `SELECT COUNT(*) AS row_count,
            MIN(applied_at) AS oldest_applied_at,
            MAX(applied_at) AS latest_applied_at
     FROM stowplan_node_migrations`,
  ).first<Record<string, unknown>>();
}

async function adminDatabaseInventory(
  db: Db,
  now: string,
): Promise<{ entries: InventoryEntry[]; generatedAt: string }> {
  const [
    snapshots,
    deletions,
    users,
    identities,
    memberships,
    sessions,
    guestLinks,
    oauthStates,
    auditEvents,
    migrationStream,
    ledgerTables,
  ] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(length(CAST(state_json AS BLOB))),0)
                AS total_bytes,
              MIN(created_at) AS oldest_created_at,
              MAX(updated_at) AS latest_updated_at,
              COALESCE(MAX(revision),0) AS max_revision,
              COALESCE(MAX(access_revision),0) AS max_access_revision
       FROM workspace_snapshots`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              MIN(deleted_at) AS oldest_deleted_at,
              MAX(deleted_at) AS latest_deleted_at,
              COALESCE(MAX(final_snapshot_revision),0)
                AS max_snapshot_revision,
              COALESCE(MAX(final_access_revision),0)
                AS max_access_revision
       FROM workspace_deletions`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0)
                AS active_count,
              COALESCE(SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END),0)
                AS disabled_count,
              COALESCE(SUM(CASE WHEN global_role='admin' THEN 1 ELSE 0 END),0)
                AS admin_count,
              MIN(created_at) AS oldest_created_at,
              MAX(updated_at) AS latest_updated_at,
              MAX(last_seen_at) AS latest_seen_at
       FROM users`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COUNT(DISTINCT provider) AS provider_count,
              COALESCE(SUM(CASE WHEN provider='guest' THEN 1 ELSE 0 END),0)
                AS guest_count,
              MIN(created_at) AS oldest_created_at,
              MAX(last_used_at) AS latest_used_at
       FROM identities`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(CASE WHEN role='owner' THEN 1 ELSE 0 END),0)
                AS owner_count,
              COALESCE(SUM(CASE WHEN role='editor' THEN 1 ELSE 0 END),0)
                AS editor_count,
              COALESCE(SUM(CASE WHEN role='viewer' THEN 1 ELSE 0 END),0)
                AS viewer_count,
              MIN(created_at) AS oldest_created_at,
              MAX(created_at) AS latest_created_at
       FROM workspace_members`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(
                CASE
                  WHEN revoked_at IS NULL AND expires_at>? THEN 1
                  ELSE 0
                END
              ),0) AS active_count,
              COALESCE(SUM(
                CASE
                  WHEN revoked_at IS NULL AND expires_at<=? THEN 1
                  ELSE 0
                END
              ),0) AS expired_count,
              COALESCE(SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END),0)
                AS revoked_count,
              MIN(created_at) AS oldest_created_at,
              MAX(last_seen_at) AS latest_seen_at,
              MIN(
                CASE
                  WHEN revoked_at IS NULL AND expires_at>? THEN expires_at
                END
              ) AS next_expiry_at
       FROM sessions`,
    ).bind(now, now, now).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(
                CASE
                  WHEN revoked_at IS NULL
                    AND consumed_at IS NULL
                    AND expires_at>? THEN 1
                  ELSE 0
                END
              ),0) AS active_count,
              COALESCE(SUM(
                CASE
                  WHEN revoked_at IS NULL AND consumed_at IS NOT NULL THEN 1
                  ELSE 0
                END
              ),0) AS used_count,
              COALESCE(SUM(
                CASE
                  WHEN revoked_at IS NULL
                    AND consumed_at IS NULL
                    AND expires_at<=? THEN 1
                  ELSE 0
                END
              ),0) AS expired_count,
              COALESCE(SUM(
                CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END
              ),0) AS revoked_count,
              MIN(created_at) AS oldest_created_at,
              MAX(created_at) AS latest_created_at,
              MIN(
                CASE
                  WHEN revoked_at IS NULL
                    AND consumed_at IS NULL
                    AND expires_at>? THEN expires_at
                END
              ) AS next_expiry_at
       FROM guest_links`,
    ).bind(now, now, now).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(
                CASE
                  WHEN consumed_at IS NULL AND expires_at>? THEN 1
                  ELSE 0
                END
              ),0) AS active_count,
              COALESCE(SUM(
                CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END
              ),0) AS consumed_count,
              COALESCE(SUM(
                CASE
                  WHEN consumed_at IS NULL AND expires_at<=? THEN 1
                  ELSE 0
                END
              ),0) AS expired_count,
              MIN(created_at) AS oldest_created_at,
              MAX(created_at) AS latest_created_at,
              MIN(
                CASE
                  WHEN consumed_at IS NULL AND expires_at>? THEN expires_at
                END
              ) AS next_expiry_at
       FROM oauth_states`,
    ).bind(now, now, now).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(
                CASE WHEN actor_user_id IS NULL THEN 1 ELSE 0 END
              ),0) AS system_count,
              MIN(created_at) AS oldest_created_at,
              MAX(created_at) AS latest_created_at
       FROM auth_audit_events`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              MIN(stream) AS stream
       FROM stowplan_migration_stream`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type='table'
         AND name IN (
           '__drizzle_migrations',
           'd1_migrations',
           'stowplan_node_migrations'
         )
       ORDER BY name`,
    ).all<{ name: string }>(),
  ]);
  const entries: InventoryEntry[] = [
    {
      key: "workspace-snapshots",
      label: "Workspace snapshots",
      metrics: [
        metric("stored size", "bytes", numberField(snapshots, "total_bytes")),
        metric(
          "oldest creation",
          "date",
          textField(snapshots, "oldest_created_at"),
        ),
        metric(
          "latest update",
          "date",
          textField(snapshots, "latest_updated_at"),
        ),
        metric(
          "highest snapshot revision",
          "count",
          numberField(snapshots, "max_revision"),
        ),
        metric(
          "highest access revision",
          "count",
          numberField(snapshots, "max_access_revision"),
        ),
      ],
      rowCount: numberField(snapshots, "row_count"),
      table: "workspace_snapshots",
    },
    {
      key: "workspace-deletions",
      label: "Deletion tombstones",
      metrics: [
        metric(
          "oldest deletion",
          "date",
          textField(deletions, "oldest_deleted_at"),
        ),
        metric(
          "latest deletion",
          "date",
          textField(deletions, "latest_deleted_at"),
        ),
        metric(
          "highest final snapshot revision",
          "count",
          numberField(deletions, "max_snapshot_revision"),
        ),
        metric(
          "highest final access revision",
          "count",
          numberField(deletions, "max_access_revision"),
        ),
      ],
      rowCount: numberField(deletions, "row_count"),
      table: "workspace_deletions",
    },
    {
      key: "users",
      label: "Users",
      metrics: [
        metric("active", "count", numberField(users, "active_count")),
        metric("disabled", "count", numberField(users, "disabled_count")),
        metric(
          "global administrators",
          "count",
          numberField(users, "admin_count"),
        ),
        metric(
          "oldest creation",
          "date",
          textField(users, "oldest_created_at"),
        ),
        metric(
          "latest update",
          "date",
          textField(users, "latest_updated_at"),
        ),
        metric(
          "latest activity",
          "date",
          textField(users, "latest_seen_at"),
        ),
      ],
      rowCount: numberField(users, "row_count"),
      table: "users",
    },
    {
      key: "identities",
      label: "Linked identities",
      metrics: [
        metric(
          "provider types",
          "count",
          numberField(identities, "provider_count"),
        ),
        metric(
          "guest identities",
          "count",
          numberField(identities, "guest_count"),
        ),
        metric(
          "oldest creation",
          "date",
          textField(identities, "oldest_created_at"),
        ),
        metric(
          "latest use",
          "date",
          textField(identities, "latest_used_at"),
        ),
      ],
      rowCount: numberField(identities, "row_count"),
      table: "identities",
    },
    {
      key: "workspace-members",
      label: "Workspace memberships",
      metrics: [
        metric(
          "owners",
          "count",
          numberField(memberships, "owner_count"),
        ),
        metric(
          "editors",
          "count",
          numberField(memberships, "editor_count"),
        ),
        metric(
          "viewers",
          "count",
          numberField(memberships, "viewer_count"),
        ),
        metric(
          "oldest creation",
          "date",
          textField(memberships, "oldest_created_at"),
        ),
        metric(
          "latest creation",
          "date",
          textField(memberships, "latest_created_at"),
        ),
      ],
      rowCount: numberField(memberships, "row_count"),
      table: "workspace_members",
    },
    {
      key: "sessions",
      label: "Sessions",
      metrics: [
        metric("active", "count", numberField(sessions, "active_count")),
        metric("expired", "count", numberField(sessions, "expired_count")),
        metric("revoked", "count", numberField(sessions, "revoked_count")),
        metric(
          "oldest creation",
          "date",
          textField(sessions, "oldest_created_at"),
        ),
        metric(
          "latest activity",
          "date",
          textField(sessions, "latest_seen_at"),
        ),
        metric(
          "next active expiry",
          "date",
          textField(sessions, "next_expiry_at"),
        ),
      ],
      rowCount: numberField(sessions, "row_count"),
      table: "sessions",
    },
    {
      key: "guest-links",
      label: "One-time invite links",
      metrics: [
        metric("active", "count", numberField(guestLinks, "active_count")),
        metric("used", "count", numberField(guestLinks, "used_count")),
        metric("expired", "count", numberField(guestLinks, "expired_count")),
        metric("revoked", "count", numberField(guestLinks, "revoked_count")),
        metric(
          "oldest creation",
          "date",
          textField(guestLinks, "oldest_created_at"),
        ),
        metric(
          "latest creation",
          "date",
          textField(guestLinks, "latest_created_at"),
        ),
        metric(
          "next active expiry",
          "date",
          textField(guestLinks, "next_expiry_at"),
        ),
      ],
      rowCount: numberField(guestLinks, "row_count"),
      table: "guest_links",
    },
    {
      key: "oauth-states",
      label: "OAuth state rows",
      metrics: [
        metric("active", "count", numberField(oauthStates, "active_count")),
        metric(
          "consumed",
          "count",
          numberField(oauthStates, "consumed_count"),
        ),
        metric("expired", "count", numberField(oauthStates, "expired_count")),
        metric(
          "oldest creation",
          "date",
          textField(oauthStates, "oldest_created_at"),
        ),
        metric(
          "latest creation",
          "date",
          textField(oauthStates, "latest_created_at"),
        ),
        metric(
          "next active expiry",
          "date",
          textField(oauthStates, "next_expiry_at"),
        ),
      ],
      rowCount: numberField(oauthStates, "row_count"),
      table: "oauth_states",
    },
    {
      key: "auth-audit-events",
      label: "Authentication audit rows",
      metrics: [
        metric(
          "system actor",
          "count",
          numberField(auditEvents, "system_count"),
        ),
        metric(
          "oldest creation",
          "date",
          textField(auditEvents, "oldest_created_at"),
        ),
        metric(
          "latest creation",
          "date",
          textField(auditEvents, "latest_created_at"),
        ),
      ],
      rowCount: numberField(auditEvents, "row_count"),
      table: "auth_audit_events",
    },
    {
      key: "migration-stream",
      label: "Migration stream marker",
      metrics: [
        metric(
          "active stream",
          "text",
          textField(migrationStream, "stream") ?? "unknown",
        ),
      ],
      rowCount: numberField(migrationStream, "row_count"),
      table: "stowplan_migration_stream",
    },
  ];
  const presentLedgerTables = new Set(
    ledgerTables.results.map(row => row.name),
  );
  for (const table of MIGRATION_LEDGER_TABLES) {
    if (!presentLedgerTables.has(table)) continue;
    const ledger = await migrationLedgerSummary(db, table);
    entries.push({
      key: `migration-ledger:${table}`,
      label: "Migration ledger",
      metrics: [
        metric(
          "oldest application",
          "date",
          textField(ledger, "oldest_applied_at"),
        ),
        metric(
          "latest application",
          "date",
          textField(ledger, "latest_applied_at"),
        ),
      ],
      rowCount: numberField(ledger, "row_count"),
      table,
    });
  }
  return { entries, generatedAt: now };
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
    databaseInventory,
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
    adminDatabaseInventory(db, now),
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
    databaseInventory,
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
  const auditChanges = changes(auditResult);
  if (auditChanges !== 0 && auditChanges !== 1) {
    throw new Error("Administrative change and audit record were inconsistent");
  }
  return auditResult;
}

function membershipTarget(targetId: string) {
  const [workspaceId, userId, ...rest] = targetId.split("::");
  if (!workspaceId || !userId || rest.length) {
    refuseAdminMutation("Invalid membership target");
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
  if (!target) refuseAdminMutation("User was not found");
  if (target.global_role === role) {
    refuseAdminMutation(`User already has the ${role} role`);
  }
  if (
    role === "user" &&
    target.global_role === "admin" &&
    target.status === "active"
  ) {
    refuseAdminMutation(
      "The last active administrator cannot be removed or disabled",
    );
  }
  refuseAdminMutation("User role could not be updated");
}

async function explainUserStatusRefusal(
  db: Db,
  targetId: string,
  status: string,
): Promise<never> {
  const target = await db.prepare(
    "SELECT global_role,status FROM users WHERE user_id=?",
  ).bind(targetId).first<{ global_role: string; status: string }>();
  if (!target) refuseAdminMutation("User was not found");
  if (target.status === status) {
    refuseAdminMutation(`User is already ${status}`);
  }
  if (
    status === "disabled" &&
    target.global_role === "admin" &&
    target.status === "active"
  ) {
    const activeAdmins = await db.prepare(
      `SELECT COUNT(*) AS count
       FROM users
       WHERE global_role='admin' AND status='active'`,
    ).first<{ count: number }>();
    if ((activeAdmins?.count ?? 0) <= 1) {
      refuseAdminMutation(
        "The last active administrator cannot be removed or disabled",
      );
    }
  }
  if (status === "disabled" && target.status === "active") {
    const finalOwnedWorkspace = await db.prepare(
      `SELECT owned.workspace_id
       FROM workspace_members owned
       WHERE owned.user_id=?
         AND owned.role='owner'
         AND NOT EXISTS (
           SELECT 1 FROM workspace_deletions deleted
           WHERE deleted.workspace_id=owned.workspace_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_members other
           JOIN users other_user ON other_user.user_id=other.user_id
           WHERE other.workspace_id=owned.workspace_id
             AND other.user_id<>owned.user_id
             AND other.role='owner'
             AND other_user.status='active'
         )
       LIMIT 1`,
    ).bind(targetId).first<{ workspace_id: string }>();
    if (finalOwnedWorkspace) {
      refuseAdminMutation(
        "A user who is the final active workspace owner cannot be disabled",
      );
    }
  }
  refuseAdminMutation("User status could not be updated");
}

async function explainMemberRoleRefusal(
  db: Db,
  workspaceId: string,
  userId: string,
  role: string,
): Promise<never> {
  const current = await db.prepare(
    `SELECT member.role,target_user.status,
            EXISTS(
              SELECT 1
              FROM workspace_deletions deleted
              WHERE deleted.workspace_id=member.workspace_id
            ) AS deleted
     FROM workspace_members member
     JOIN users target_user ON target_user.user_id=member.user_id
     WHERE member.workspace_id=? AND member.user_id=?`,
  ).bind(workspaceId, userId).first<{
    deleted: number;
    role: string;
    status: string;
  }>();
  if (!current) refuseAdminMutation("Workspace membership was not found");
  if (current.deleted) refuseAdminMutation("Workspace has been deleted");
  if (current.role === role) {
    refuseAdminMutation(`Workspace member already has the ${role} role`);
  }
  if (
    role === "owner" &&
    current.role !== "owner" &&
    current.status !== "active"
  ) {
    refuseAdminMutation(
      "A disabled account cannot be assigned workspace ownership",
    );
  }
  if (
    current.role === "owner" &&
    current.status === "active" &&
    role !== "owner"
  ) {
    const activeOwners = await db.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members owner
       JOIN users owner_user ON owner_user.user_id=owner.user_id
       WHERE owner.workspace_id=?
         AND owner.role='owner'
         AND owner_user.status='active'`,
    ).bind(workspaceId).first<{ count: number }>();
    if ((activeOwners?.count ?? 0) <= 1) {
      refuseAdminMutation("A workspace must retain at least one owner");
    }
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
  refuseAdminMutation("Workspace membership role could not be updated");
}

async function explainMemberRemovalRefusal(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<never> {
  const current = await db.prepare(
    `SELECT member.role,target_user.status,
            EXISTS(
              SELECT 1
              FROM workspace_deletions deleted
              WHERE deleted.workspace_id=member.workspace_id
            ) AS deleted
     FROM workspace_members member
     JOIN users target_user ON target_user.user_id=member.user_id
     WHERE member.workspace_id=? AND member.user_id=?`,
  ).bind(workspaceId, userId).first<{
    deleted: number;
    role: string;
    status: string;
  }>();
  if (!current) refuseAdminMutation("Workspace membership was not found");
  if (current.deleted) refuseAdminMutation("Workspace has been deleted");
  if (current.role === "owner" && current.status === "active") {
    const activeOwners = await db.prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members owner
       JOIN users owner_user ON owner_user.user_id=owner.user_id
       WHERE owner.workspace_id=?
         AND owner.role='owner'
         AND owner_user.status='active'`,
    ).bind(workspaceId).first<{ count: number }>();
    if ((activeOwners?.count ?? 0) <= 1) {
      refuseAdminMutation("A workspace must retain at least one owner");
    }
  }
  refuseAdminMutation("Workspace membership could not be removed");
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
        refuseAdminMutation("Invalid role");
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
        refuseAdminMutation("Invalid status");
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
             )
             AND NOT (
               ?='disabled'
               AND status='active'
               AND EXISTS (
                 SELECT 1
                 FROM workspace_members owned
                 WHERE owned.user_id=users.user_id
                   AND owned.role='owner'
                   AND NOT EXISTS (
                     SELECT 1
                     FROM workspace_deletions deleted
                     WHERE deleted.workspace_id=owned.workspace_id
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM workspace_members other
                     JOIN users other_user
                       ON other_user.user_id=other.user_id
                     WHERE other.workspace_id=owned.workspace_id
                       AND other.user_id<>owned.user_id
                       AND other.role='owner'
                       AND other_user.status='active'
                   )
               )
             )`,
        ).bind(status, now, input.targetId, status, status, status),
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
        if (!identity) refuseAdminMutation("Identity was not found");
        refuseAdminMutation(
          "A user must retain at least one sign-in identity",
        );
      }
      message = "Sign-in identity unlinked";
      break;
    }
    case "member.role": {
      if (!["owner", "editor", "viewer"].includes(input.value ?? "")) {
        refuseAdminMutation("Invalid workspace role");
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
             AND NOT EXISTS (
               SELECT 1
               FROM workspace_deletions deleted
               WHERE deleted.workspace_id=workspace_members.workspace_id
             )
             AND NOT (
               ?<>'owner'
               AND role='owner'
               AND EXISTS (
                 SELECT 1 FROM users target_user
                 WHERE target_user.user_id=workspace_members.user_id
                   AND target_user.status='active'
               )
               AND (
                 SELECT COUNT(*)
                 FROM workspace_members owners
                 JOIN users owner_user ON owner_user.user_id=owners.user_id
                 WHERE owners.workspace_id=?
                   AND owners.role='owner'
                   AND owner_user.status='active'
               )<=1
             )
             AND (
               ?<>'owner'
               OR EXISTS (
                 SELECT 1 FROM users target_user
                 WHERE target_user.user_id=workspace_members.user_id
                   AND target_user.status='active'
               )
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
             AND NOT EXISTS (
               SELECT 1
               FROM workspace_deletions deleted
               WHERE deleted.workspace_id=workspace_members.workspace_id
             )
             AND (
               role<>'owner'
               OR NOT EXISTS (
                 SELECT 1 FROM users target_user
                 WHERE target_user.user_id=workspace_members.user_id
                   AND target_user.status='active'
               )
               OR (
                 SELECT COUNT(*)
                 FROM workspace_members owners
                 JOIN users owner_user ON owner_user.user_id=owners.user_id
                 WHERE owners.workspace_id=?
                   AND owners.role='owner'
                   AND owner_user.status='active'
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
        if (!session) refuseAdminMutation("Session was not found");
        if (session.revoked_at) {
          refuseAdminMutation("Session is already revoked");
        }
        refuseAdminMutation("Expired sessions cannot be revoked");
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
             AND expires_at>?
             AND NOT EXISTS (
               SELECT 1
               FROM workspace_deletions deleted
               WHERE deleted.workspace_id=guest_links.workspace_id
             )`,
        ).bind(now, input.targetId, now),
      );
      if (changes(result) !== 1) {
        const link = await db.prepare(
          `SELECT link.consumed_at,link.expires_at,link.revoked_at,
                  EXISTS(
                    SELECT 1
                    FROM workspace_deletions deleted
                    WHERE deleted.workspace_id=link.workspace_id
                  ) AS deleted
           FROM guest_links link
           WHERE link.guest_link_id=?`,
        ).bind(input.targetId).first<{
          consumed_at: string | null;
          deleted: number;
          expires_at: string;
          revoked_at: string | null;
        }>();
        if (!link) refuseAdminMutation("Guest link was not found");
        if (link.deleted) refuseAdminMutation("Workspace has been deleted");
        if (link.revoked_at) {
          refuseAdminMutation("Guest link is already revoked");
        }
        if (link.consumed_at) {
          refuseAdminMutation("Used guest links cannot be revoked");
        }
        refuseAdminMutation("Expired guest links cannot be revoked");
      }
      message = "Guest link revoked";
      break;
    }
    default:
      refuseAdminMutation("Unsupported admin action");
  }
  return { message };
}
