import type { D1DatabaseLike } from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";
import { API_QUOTAS } from "../shared/api-quotas";
import {
  SESSION_AUTHENTICATION_PROVIDER,
  SESSION_REVOCATION_SCOPE,
} from "../shared/authentication";
import {
  CIRCUIT_BREAKER_PAUSE_KIND,
  CIRCUIT_BREAKER_SCOPE,
  CIRCUIT_BREAKER_STATE,
  GOVERNANCE_LIMIT_KEY,
  type CircuitBreakerPauseKind,
  type CircuitBreakerScope,
  type CircuitBreakerState,
  type GovernanceLimitKey,
} from "../shared/governance-policy";
import {
  banAccount,
  changeAccountStatus,
  changeGlobalRole,
  liftAccountBan,
  readCircuitBreakers,
  readGovernanceLimits,
  setCircuitBreaker,
  setGovernanceLimit,
} from "./account-governance";
import { ApiProblem } from "./api-problem";
import {
  safeAuditDetailJson,
  safeStoredAuditDetailJson,
} from "./audit-detail";
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
  expectedAccountRevision?: number;
  expectedAccessRevision?: number;
  expectedMembershipRevision?: number;
  pauseKind?: string;
  reason?: string;
  targetId: string;
  value?: string;
}

interface AdminMutationOptions {
  actorSessionId?: string;
  identityDigestKey?: string;
  signInProviderIds?: readonly string[];
}

const SECURITY_BREAKER_INITIAL_PAUSE_MS = 30 * 60 * 1_000;
const SECURITY_BREAKER_RETRIGGER_PAUSE_MS = 2 * 60 * 60 * 1_000;

const ADMIN_RESULT_LIMITS = Object.freeze({
  audit: 250,
  deletions: 250,
  guestLinks: 250,
  identities: 500,
  memberships: 500,
  migrations: 250,
  oauthStates: 250,
  sessions: 250,
  users: 250,
  workspaces: 250,
});

type AdminResultName = keyof typeof ADMIN_RESULT_LIMITS;

interface AdminOverviewOptions {
  page?: {
    offset: number;
    resource: AdminResultName;
  };
  query?: string;
  viewerSessionId?: string;
  viewerUserId?: string;
}

interface PagedResult {
  hasMore: boolean;
  limit: number;
  nextOffset: number | null;
  offset: number;
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

const ADMIN_RESULT_NAMES = Object.freeze(
  Object.keys(ADMIN_RESULT_LIMITS) as AdminResultName[],
);

interface MigrationRecord {
  applied_at: string | null;
  ledger_table: typeof MIGRATION_LEDGER_TABLES[number];
  migration_id: string | null;
  name: string | null;
}

function changes(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}

function refuseAdminMutation(message: string): never {
  throw new ApiProblem("INVALID_REQUEST", message, 400);
}

type AdminExpectedRevision =
  | "expectedAccountRevision"
  | "expectedAccessRevision"
  | "expectedMembershipRevision";

function requiredAdminRevision(
  input: AdminMutationInput,
  field: AdminExpectedRevision,
): number {
  const revision = input[field];
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `${field} is required and must be a non-negative safe integer`,
      400,
    );
  }
  return revision;
}

async function requireActiveAdminActor(
  db: Db,
  actor: string,
): Promise<void> {
  const current = await db.prepare(
    `SELECT 1 AS authorized
     FROM users
     WHERE user_id=?
       AND status='active'
       AND deleted_at IS NULL
       AND global_role='admin'`,
  ).bind(actor).first<{ authorized: number }>();
  if (!current) {
    throw new ApiProblem(
      "ADMIN_REQUIRED",
      "Global administrator access is required",
      403,
    );
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function page<T>(
  rows: T[],
  name: AdminResultName,
  offset = 0,
): { info: PagedResult; rows: T[] } {
  const limit = ADMIN_RESULT_LIMITS[name];
  const visible = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    info: {
      hasMore,
      limit,
      nextOffset: hasMore ? offset + visible.length : null,
      offset,
    },
    rows: visible,
  };
}

function resultOffset(
  options: AdminOverviewOptions,
  resource: AdminResultName,
): number {
  return options.page?.resource === resource
    ? options.page.offset
    : 0;
}

export function adminOverviewPage(
  searchParams: URLSearchParams,
): AdminOverviewOptions["page"] {
  const resource = searchParams.get("resource");
  const offset = searchParams.get("offset");
  if (resource === null && offset === null) return undefined;
  if (
    resource === null ||
    offset === null ||
    !ADMIN_RESULT_NAMES.includes(resource as AdminResultName) ||
    !/^\d+$/u.test(offset)
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "resource and offset must identify a valid admin result page",
      400,
    );
  }
  const value = Number(offset);
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "offset must be a non-negative safe integer",
      400,
    );
  }
  return {
    offset: value,
    resource: resource as AdminResultName,
  };
}

function searchPattern(query: string | undefined): string | null {
  const normalized = query?.trim().slice(0, 120).toLowerCase();
  return normalized ? `%${escapeLike(normalized)}%` : null;
}

function normalizedSearch(query: string | undefined): string {
  return query?.trim().slice(0, 120).toLowerCase() ?? "";
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

async function migrationLedgerRecords(
  db: Db,
  query: string | undefined,
  offset = 0,
): Promise<{ info: PagedResult; rows: MigrationRecord[] }> {
  const available = await db.prepare(
    `SELECT name
     FROM sqlite_schema
     WHERE type='table'
       AND name IN (
         '__drizzle_migrations',
         'd1_migrations',
         'stowplan_node_migrations'
       )
     ORDER BY name`,
  ).all<{ name: string }>();
  const present = new Set(available.results.map(row => row.name));
  const pattern = searchPattern(query);
  const normalized = normalizedSearch(query);
  const records: MigrationRecord[] = [];
  const limit = ADMIN_RESULT_LIMITS.migrations + offset + 1;

  for (const table of MIGRATION_LEDGER_TABLES) {
    if (!present.has(table)) continue;
    const tableMatches = normalized && table.includes(normalized);
    if (table === "__drizzle_migrations") {
      const search = pattern && !tableMatches
        ? "WHERE lower(CAST(id AS TEXT)) LIKE ? ESCAPE '\\' OR lower(CAST(created_at AS TEXT)) LIKE ? ESCAPE '\\'"
        : "";
      const values = search ? [pattern, pattern] : [];
      const result = await db.prepare(
        `SELECT '__drizzle_migrations' AS ledger_table,
                CAST(id AS TEXT) AS migration_id,
                NULL AS name,
                strftime(
                  '%Y-%m-%dT%H:%M:%fZ',
                  created_at / 1000,
                  'unixepoch'
                ) AS applied_at
         FROM __drizzle_migrations
         ${search}
         ORDER BY created_at DESC,id DESC
         LIMIT ?`,
      ).bind(...values, limit).all<MigrationRecord>();
      records.push(...result.results);
      continue;
    }
    if (table === "d1_migrations") {
      const columns = await db.prepare(
        "PRAGMA table_info(d1_migrations)",
      ).all<{ name: string }>();
      const hasName = columns.results.some(column => column.name === "name");
      const searchableName = hasName
        ? " OR lower(name) LIKE ? ESCAPE '\\'"
        : "";
      const search = pattern && !tableMatches
        ? `WHERE lower(CAST(id AS TEXT)) LIKE ? ESCAPE '\\'
             OR lower(CAST(applied_at AS TEXT)) LIKE ? ESCAPE '\\'
             ${searchableName}`
        : "";
      const values = search
        ? hasName
          ? [pattern, pattern, pattern]
          : [pattern, pattern]
        : [];
      const result = await db.prepare(
        `SELECT 'd1_migrations' AS ledger_table,
                CAST(id AS TEXT) AS migration_id,
                ${hasName ? "name" : "NULL"} AS name,
                CAST(applied_at AS TEXT) AS applied_at
         FROM d1_migrations
         ${search}
         ORDER BY applied_at DESC,id DESC
         LIMIT ?`,
      ).bind(...values, limit).all<MigrationRecord>();
      records.push(...result.results);
      continue;
    }
    const search = pattern && !tableMatches
      ? "WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(applied_at) LIKE ? ESCAPE '\\'"
      : "";
    const values = search ? [pattern, pattern] : [];
    const result = await db.prepare(
      `SELECT 'stowplan_node_migrations' AS ledger_table,
              NULL AS migration_id,
              name,
              applied_at
       FROM stowplan_node_migrations
       ${search}
       ORDER BY applied_at DESC,name DESC
       LIMIT ?`,
    ).bind(...values, limit).all<MigrationRecord>();
    records.push(...result.results);
  }

  records.sort((left, right) =>
    String(right.applied_at ?? "").localeCompare(
      String(left.applied_at ?? ""),
    ) ||
    left.ledger_table.localeCompare(right.ledger_table) ||
    String(left.name ?? left.migration_id ?? "").localeCompare(
      String(right.name ?? right.migration_id ?? ""),
    )
  );
  return page(records.slice(offset), "migrations", offset);
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
    workspaceCustody,
    creationLedger,
    circuitBreakers,
    governanceLimits,
    identityBans,
    accountDeletionReceipts,
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
              COALESCE(SUM(CASE WHEN status='banned' THEN 1 ELSE 0 END),0)
                AS banned_count,
              COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END),0)
                AS deleted_count,
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
              COALESCE(SUM(
                CASE
                  WHEN (
                    authentication_provider='cloudflare-access'
                    OR authentication_provider IS NULL
                  )
                    AND revoked_at IS NULL
                    AND expires_at>? THEN 1
                  ELSE 0
                END
              ),0) AS active_pre_google_count,
              MIN(created_at) AS oldest_created_at,
              MAX(last_seen_at) AS latest_seen_at,
              MIN(
                CASE
                  WHEN revoked_at IS NULL AND expires_at>? THEN expires_at
                END
              ) AS next_expiry_at
       FROM sessions`,
    ).bind(now, now, now, now).first<Record<string, unknown>>(),
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
              COUNT(DISTINCT custody.custodian_user_id)
                AS custodian_count,
              COALESCE(SUM(snapshot.stored_bytes),0)
                AS total_bytes,
              MIN(custody.created_at) AS oldest_created_at,
              MAX(custody.updated_at) AS latest_updated_at
       FROM workspace_custody custody
       JOIN workspace_snapshots snapshot
         ON snapshot.workspace_id=custody.workspace_id`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(CASE WHEN resource='account' THEN 1 ELSE 0 END),0)
                AS account_count,
              COALESCE(SUM(CASE WHEN resource='workspace' THEN 1 ELSE 0 END),0)
                AS workspace_count,
              COALESCE(SUM(CASE WHEN resource='session' THEN 1 ELSE 0 END),0)
                AS session_count,
              COALESCE(SUM(CASE WHEN resource='guest_link' THEN 1 ELSE 0 END),0)
                AS guest_link_count,
              MIN(created_at) AS oldest_created_at,
              MAX(created_at) AS latest_created_at
       FROM creation_ledger`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(CASE WHEN state='paused' THEN 1 ELSE 0 END),0)
                AS paused_count,
              COALESCE(SUM(CASE WHEN pause_kind='capacity' THEN 1 ELSE 0 END),0)
                AS capacity_count,
              COALESCE(SUM(CASE WHEN pause_kind='security' THEN 1 ELSE 0 END),0)
                AS security_count,
              MAX(updated_at) AS latest_updated_at
       FROM circuit_breakers`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(MAX(limit_value),0) AS maximum_value,
              MAX(updated_at) AS latest_updated_at
       FROM governance_limits`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              COALESCE(SUM(CASE WHEN lifted_at IS NULL THEN 1 ELSE 0 END),0)
                AS active_count,
              COALESCE(SUM(CASE WHEN lifted_at IS NOT NULL THEN 1 ELSE 0 END),0)
                AS lifted_count,
              MIN(created_at) AS oldest_created_at,
              MAX(created_at) AS latest_created_at,
              MAX(lifted_at) AS latest_lifted_at
       FROM identity_ban_digests`,
    ).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT COUNT(*) AS row_count,
              MIN(deleted_at) AS oldest_deleted_at,
              MAX(deleted_at) AS latest_deleted_at
       FROM account_deletion_receipts`,
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
        metric("banned", "count", numberField(users, "banned_count")),
        metric("deleted", "count", numberField(users, "deleted_count")),
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
          "active pre-Google",
          "count",
          numberField(sessions, "active_pre_google_count"),
        ),
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
      key: "workspace-custody",
      label: "Workspace custody",
      metrics: [
        metric(
          "custodians",
          "count",
          numberField(workspaceCustody, "custodian_count"),
        ),
        metric(
          "stored size",
          "bytes",
          numberField(workspaceCustody, "total_bytes"),
        ),
        metric(
          "oldest creation",
          "date",
          textField(workspaceCustody, "oldest_created_at"),
        ),
        metric(
          "latest update",
          "date",
          textField(workspaceCustody, "latest_updated_at"),
        ),
      ],
      rowCount: numberField(workspaceCustody, "row_count"),
      table: "workspace_custody",
    },
    {
      key: "creation-ledger",
      label: "Durable creation ledger",
      metrics: [
        metric(
          "accounts",
          "count",
          numberField(creationLedger, "account_count"),
        ),
        metric(
          "workspaces",
          "count",
          numberField(creationLedger, "workspace_count"),
        ),
        metric(
          "sessions",
          "count",
          numberField(creationLedger, "session_count"),
        ),
        metric(
          "guest links",
          "count",
          numberField(creationLedger, "guest_link_count"),
        ),
        metric(
          "oldest creation",
          "date",
          textField(creationLedger, "oldest_created_at"),
        ),
        metric(
          "latest creation",
          "date",
          textField(creationLedger, "latest_created_at"),
        ),
      ],
      rowCount: numberField(creationLedger, "row_count"),
      table: "creation_ledger",
    },
    {
      key: "circuit-breakers",
      label: "Public abuse circuit breakers",
      metrics: [
        metric(
          "stored paused",
          "count",
          numberField(circuitBreakers, "paused_count"),
        ),
        metric(
          "capacity policy",
          "count",
          numberField(circuitBreakers, "capacity_count"),
        ),
        metric(
          "security policy",
          "count",
          numberField(circuitBreakers, "security_count"),
        ),
        metric(
          "latest update",
          "date",
          textField(circuitBreakers, "latest_updated_at"),
        ),
      ],
      rowCount: numberField(circuitBreakers, "row_count"),
      table: "circuit_breakers",
    },
    {
      key: "governance-limits",
      label: "Adjustable governance limits",
      metrics: [
        metric(
          "largest value",
          "count",
          numberField(governanceLimits, "maximum_value"),
        ),
        metric(
          "latest update",
          "date",
          textField(governanceLimits, "latest_updated_at"),
        ),
      ],
      rowCount: numberField(governanceLimits, "row_count"),
      table: "governance_limits",
    },
    {
      key: "identity-ban-digests",
      label: "Identity enforcement digests",
      metrics: [
        metric(
          "active",
          "count",
          numberField(identityBans, "active_count"),
        ),
        metric(
          "lifted",
          "count",
          numberField(identityBans, "lifted_count"),
        ),
        metric(
          "oldest creation",
          "date",
          textField(identityBans, "oldest_created_at"),
        ),
        metric(
          "latest creation",
          "date",
          textField(identityBans, "latest_created_at"),
        ),
        metric(
          "latest lift",
          "date",
          textField(identityBans, "latest_lifted_at"),
        ),
      ],
      rowCount: numberField(identityBans, "row_count"),
      table: "identity_ban_digests",
    },
    {
      key: "account-deletion-receipts",
      label: "Account deletion receipts",
      metrics: [
        metric(
          "oldest deletion",
          "date",
          textField(accountDeletionReceipts, "oldest_deleted_at"),
        ),
        metric(
          "latest deletion",
          "date",
          textField(accountDeletionReceipts, "latest_deleted_at"),
        ),
      ],
      rowCount: numberField(accountDeletionReceipts, "row_count"),
      table: "account_deletion_receipts",
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
  const offset = (resource: AdminResultName) =>
    resultOffset(options, resource);
  const bindSearch = (statement: Statement, values: unknown[]) =>
    statement.bind(
      ...values,
      ADMIN_RESULT_LIMITS.users + 1,
      offset("users"),
    );
  const usersSearch = pattern
    ? "WHERE lower(u.email) LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(u.user_id) LIKE ? ESCAPE '\\'"
    : "";
  const usersValues = pattern ? [pattern, pattern, pattern] : [];
  const usersStatement = db.prepare(
    `SELECT u.user_id,u.email,u.display_name,u.global_role,u.status,
            u.account_revision,u.membership_revision,u.created_at,
            u.updated_at,u.last_seen_at,u.deleted_at,
            (
              SELECT COUNT(*)
              FROM workspace_members owned
              WHERE owned.user_id=u.user_id AND owned.role='owner'
            ) AS owned_workspace_count,
            (
              SELECT COUNT(*)
              FROM identity_ban_digests ban
              WHERE ban.source_user_id=u.user_id
                AND ban.lifted_at IS NULL
            ) AS active_identity_ban_count,
            (
              SELECT COUNT(*)
              FROM identity_ban_digests ban
              WHERE ban.source_user_id=u.user_id
            ) AS retained_identity_ban_count,
            (
              SELECT ban.reason
              FROM identity_ban_digests ban
              WHERE ban.source_user_id=u.user_id
                AND ban.lifted_at IS NULL
              ORDER BY ban.created_at DESC,ban.identity_digest
              LIMIT 1
            ) AS ban_reason
     FROM users u
     ${usersSearch}
     ORDER BY u.created_at DESC,u.user_id DESC
     LIMIT ? OFFSET ?`,
  );
  const identitiesSearch = pattern
    ? "WHERE lower(u.email) LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(i.email) LIKE ? ESCAPE '\\' OR lower(i.provider) LIKE ? ESCAPE '\\' OR lower(i.provider_subject) LIKE ? ESCAPE '\\' OR lower(i.identity_id) LIKE ? ESCAPE '\\'"
    : "";
  const identitiesValues = pattern
    ? [pattern, pattern, pattern, pattern, pattern, pattern]
    : [];
  const membershipsSearch = pattern
    ? "WHERE lower(u.email) LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(m.user_id) LIKE ? ESCAPE '\\' OR lower(m.workspace_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(json_extract(s.state_json,'$.workspace.name'),'')) LIKE ? ESCAPE '\\'"
    : "";
  const membershipsValues = pattern
    ? [pattern, pattern, pattern, pattern, pattern]
    : [];
  const sessionsSearch = pattern
    ? "WHERE lower(u.email) LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(s.session_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(s.user_agent,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(s.ip_prefix,'')) LIKE ? ESCAPE '\\'"
    : "";
  const sessionsValues = pattern
    ? [pattern, pattern, pattern, pattern, pattern]
    : [];
  const guestLinksSearch = pattern
    ? "WHERE lower(g.workspace_id) LIKE ? ESCAPE '\\' OR lower(g.guest_link_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(g.redemption_id,'')) LIKE ? ESCAPE '\\' OR lower(creator.email) LIKE ? ESCAPE '\\' OR lower(COALESCE(redeemer.user_id,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(redeemer.email,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(redeemer.display_name,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(json_extract(s.state_json,'$.workspace.name'),'')) LIKE ? ESCAPE '\\'"
    : "";
  const guestLinksValues = pattern
    ? [
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
      ]
    : [];
  const auditSearch = pattern
    ? `WHERE lower(a.action) LIKE ? ESCAPE '\\'
       OR lower(COALESCE(a.target_id,'')) LIKE ? ESCAPE '\\'
       OR lower(COALESCE(u.email,'')) LIKE ? ESCAPE '\\'
       OR lower(COALESCE(u.display_name,'')) LIKE ? ESCAPE '\\'
       OR lower(
         CASE
           WHEN a.action='member.invite.accept' THEN
             CASE
               WHEN json_valid(a.detail_json) THEN
                 CASE
                   WHEN json_type(a.detail_json,'$.guestLinkId')='text'
                     THEN json_extract(a.detail_json,'$.guestLinkId')
                   ELSE ''
                 END
               ELSE ''
             END
           ELSE ''
         END
       ) LIKE ? ESCAPE '\\'`
    : "";
  const auditValues = pattern
    ? [pattern, pattern, pattern, pattern, pattern]
    : [];
  const workspacesSearch = pattern
    ? "WHERE lower(s.workspace_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(json_extract(s.state_json,'$.workspace.name'),'')) LIKE ? ESCAPE '\\'"
    : "";
  const workspacesValues = pattern ? [pattern, pattern] : [];
  const deletionsSearch = pattern
    ? "WHERE lower(deleted.workspace_id) LIKE ? ESCAPE '\\' OR lower(deleted.deletion_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(actor.email,'')) LIKE ? ESCAPE '\\'"
    : "";
  const deletionsValues = pattern ? [pattern, pattern, pattern] : [];
  const oauthStatesSearch = pattern
    ? "WHERE lower(oauth.provider) LIKE ? ESCAPE '\\'"
    : "";
  const oauthStatesValues = pattern ? [pattern] : [];
  const [
    usersResult,
    identitiesResult,
    membershipsResult,
    sessionsResult,
    linksResult,
    auditResult,
    workspacesResult,
    deletionsResult,
    oauthStatesResult,
    migrationRecords,
    databaseInventory,
    circuitBreakers,
    governanceLimitRows,
  ] = await Promise.all([
    bindSearch(usersStatement, usersValues)
      .all<Record<string, unknown>>(),
    db.prepare(
      `SELECT i.identity_id,i.user_id,u.email AS user_email,
              u.display_name AS user_display_name,
              u.global_role AS user_global_role,u.status AS user_status,
              u.membership_revision,i.provider,i.provider_subject,
              i.email,i.created_at,i.last_used_at
       FROM identities i
       JOIN users u ON u.user_id=i.user_id
       ${identitiesSearch}
       ORDER BY i.last_used_at DESC,i.identity_id DESC
       LIMIT ? OFFSET ?`,
    ).bind(
      ...identitiesValues,
      ADMIN_RESULT_LIMITS.identities + 1,
      offset("identities"),
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT m.workspace_id,m.user_id,u.email,m.role,m.created_at,
              u.display_name,u.status AS user_status,
              u.membership_revision,s.revision AS workspace_revision,
              s.access_revision AS workspace_access_revision,
              s.updated_at AS workspace_updated_at,
              COALESCE(
                NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
                m.workspace_id
              ) AS workspace_name
       FROM workspace_members m
       JOIN users u ON u.user_id=m.user_id
       JOIN workspace_snapshots s ON s.workspace_id=m.workspace_id
       ${membershipsSearch}
       ORDER BY workspace_name,u.email,m.workspace_id,m.user_id
       LIMIT ? OFFSET ?`,
    ).bind(
      ...membershipsValues,
      ADMIN_RESULT_LIMITS.memberships + 1,
      offset("memberships"),
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT s.session_id,s.user_id,u.email,s.created_at,s.expires_at,
              s.last_seen_at,s.revoked_at,s.user_agent,s.ip_prefix,
              s.authentication_provider,
              u.display_name,u.global_role,u.status,
              u.membership_revision,
              CASE WHEN s.session_id=? THEN 1 ELSE 0 END
                AS viewer_is_current
       FROM sessions s
       JOIN users u ON u.user_id=s.user_id
       ${sessionsSearch}
       ORDER BY
         CASE
           WHEN s.revoked_at IS NULL AND s.expires_at>? THEN 0
           ELSE 1
         END,
         s.created_at DESC,
         s.session_id DESC
       LIMIT ? OFFSET ?`,
    ).bind(
      options.viewerSessionId ?? "",
      ...sessionsValues,
      now,
      ADMIN_RESULT_LIMITS.sessions + 1,
      offset("sessions"),
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT g.guest_link_id,g.workspace_id,g.role,g.created_at,
              g.expires_at,g.consumed_at,g.revoked_at,
              g.created_by_user_id,g.redemption_id,
              creator.email AS created_by_email,
              creator.display_name AS created_by_display_name,
              creator.global_role AS created_by_global_role,
              creator.status AS created_by_status,
              creator.membership_revision
                AS created_by_membership_revision,
              acceptance.actor_user_id AS redeemed_by_user_id,
              redeemer.display_name AS redeemed_by_display_name,
              redeemer.email AS redeemed_by_email,
              acceptance.created_at AS accepted_at,
              s.revision AS workspace_revision,
              s.access_revision AS workspace_access_revision,
              s.updated_at AS workspace_updated_at,
              COALESCE(
                NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
                g.workspace_id
              ) AS workspace_name
       FROM guest_links g
       JOIN workspace_snapshots s ON s.workspace_id=g.workspace_id
       JOIN users creator ON creator.user_id=g.created_by_user_id
       LEFT JOIN auth_audit_events acceptance
         ON acceptance.event_id=(
           SELECT candidate.event_id
           FROM auth_audit_events candidate
           WHERE candidate.action='member.invite.accept'
             AND candidate.target_type='workspace_member'
             AND candidate.actor_user_id IS NOT NULL
             AND candidate.target_id=candidate.actor_user_id
             AND candidate.created_at=g.consumed_at
             AND (
               CASE
                 WHEN json_valid(candidate.detail_json) THEN
                   CASE
                     WHEN json_type(
                       candidate.detail_json,
                       '$.guestLinkId'
                     )='text'
                       THEN json_extract(
                         candidate.detail_json,
                         '$.guestLinkId'
                       )
                     ELSE NULL
                   END
                 ELSE NULL
               END
             )=g.guest_link_id
           ORDER BY candidate.created_at,candidate.event_id
           LIMIT 1
         )
       LEFT JOIN users redeemer
         ON redeemer.user_id=acceptance.actor_user_id
       ${guestLinksSearch}
       ORDER BY
         CASE
           WHEN g.revoked_at IS NULL
             AND g.consumed_at IS NULL
             AND g.expires_at>? THEN 0
           ELSE 1
         END,
         g.created_at DESC,
         g.guest_link_id DESC
       LIMIT ? OFFSET ?`,
    ).bind(
      ...guestLinksValues,
      now,
      ADMIN_RESULT_LIMITS.guestLinks + 1,
      offset("guestLinks"),
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT a.event_id,a.actor_user_id,u.email AS actor_email,a.action,
              u.display_name AS actor_display_name,
              a.target_type,a.target_id,a.detail_json,a.created_at,
              a.ip_prefix
       FROM auth_audit_events a
       LEFT JOIN users u ON u.user_id=a.actor_user_id
       ${auditSearch}
       ORDER BY a.created_at DESC,a.event_id DESC
       LIMIT ? OFFSET ?`,
    ).bind(
      ...auditValues,
      ADMIN_RESULT_LIMITS.audit + 1,
      offset("audit"),
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT s.workspace_id,
              COALESCE(
                NULLIF(json_extract(s.state_json,'$.workspace.name'),''),
                s.workspace_id
              ) AS workspace_name,
              s.revision,s.access_revision,s.created_at,s.updated_at,
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
       ORDER BY s.updated_at DESC,s.workspace_id DESC
       LIMIT ? OFFSET ?`,
    ).bind(
      options.viewerUserId ?? "",
      now,
      ...workspacesValues,
      ADMIN_RESULT_LIMITS.workspaces + 1,
      offset("workspaces"),
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT deleted.workspace_id,deleted.deletion_id,
              deleted.deleted_at,deleted.deleted_by_user_id,
              actor.email AS deleted_by_email,
              actor.display_name AS deleted_by_display_name,
              deleted.final_snapshot_revision,
              deleted.final_access_revision
       FROM workspace_deletions deleted
       LEFT JOIN users actor
         ON actor.user_id=deleted.deleted_by_user_id
       ${deletionsSearch}
       ORDER BY deleted.deleted_at DESC,deleted.workspace_id
       LIMIT ? OFFSET ?`,
    ).bind(
      ...deletionsValues,
      ADMIN_RESULT_LIMITS.deletions + 1,
      offset("deletions"),
    ).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT oauth.provider,oauth.created_at,oauth.expires_at,
              oauth.consumed_at,
              CASE
                WHEN oauth.consumed_at IS NOT NULL THEN 'consumed'
                WHEN oauth.expires_at<=? THEN 'expired'
                ELSE 'active'
              END AS status
       FROM oauth_states oauth
       ${oauthStatesSearch}
       ORDER BY oauth.created_at DESC,oauth.provider,
                oauth.expires_at,oauth.state_hash
       LIMIT ? OFFSET ?`,
    ).bind(
      now,
      ...oauthStatesValues,
      ADMIN_RESULT_LIMITS.oauthStates + 1,
      offset("oauthStates"),
    ).all<Record<string, unknown>>(),
    migrationLedgerRecords(
      db,
      options.query,
      offset("migrations"),
    ),
    adminDatabaseInventory(db, now),
    readCircuitBreakers(database),
    readGovernanceLimits(database),
  ]);
  const users = page(usersResult.results, "users", offset("users"));
  const identities = page(
    identitiesResult.results,
    "identities",
    offset("identities"),
  );
  const memberships = page(
    membershipsResult.results,
    "memberships",
    offset("memberships"),
  );
  const sessions = page(
    sessionsResult.results,
    "sessions",
    offset("sessions"),
  );
  const guestLinks = page(
    linksResult.results,
    "guestLinks",
    offset("guestLinks"),
  );
  const auditEvents = page<Record<string, unknown>>(
    auditResult.results.map(row => ({
      ...row,
      detail_json: safeStoredAuditDetailJson(row.action, row.detail_json),
    })),
    "audit",
    offset("audit"),
  );
  const workspaces = page(
    workspacesResult.results,
    "workspaces",
    offset("workspaces"),
  );
  const deletions = page(
    deletionsResult.results,
    "deletions",
    offset("deletions"),
  );
  const oauthStates = page(
    oauthStatesResult.results,
    "oauthStates",
    offset("oauthStates"),
  );
  return {
    audit: auditEvents.rows,
    circuitBreakers,
    databaseInventory,
    deletions: deletions.rows,
    guestLinks: guestLinks.rows,
    governanceLimits: governanceLimitRows,
    identities: identities.rows,
    limits: API_QUOTAS,
    listInfo: {
      audit: auditEvents.info,
      deletions: deletions.info,
      guestLinks: guestLinks.info,
      identities: identities.info,
      memberships: memberships.info,
      migrations: migrationRecords.info,
      oauthStates: oauthStates.info,
      sessions: sessions.info,
      users: users.info,
      workspaces: workspaces.info,
    },
    memberships: memberships.rows,
    migrations: migrationRecords.rows,
    oauthStates: oauthStates.rows,
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
    safeAuditDetailJson(action, detail),
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
      safeAuditDetailJson(
        input.action,
        input.value === undefined ? {} : { value: input.value },
      ),
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

interface AdminMemberMutationState {
  access_revision: number | null;
  deleted: number;
  membership_revision: number;
  role: string;
  status: string;
}

async function currentAdminMemberMutationState(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<AdminMemberMutationState> {
  const current = await db.prepare(
    `SELECT member.role,target_user.status,
            target_user.membership_revision,snapshot.access_revision,
            EXISTS(
              SELECT 1
              FROM workspace_deletions deleted
              WHERE deleted.workspace_id=member.workspace_id
            ) AS deleted
     FROM workspace_members member
     JOIN users target_user ON target_user.user_id=member.user_id
     LEFT JOIN workspace_snapshots snapshot
       ON snapshot.workspace_id=member.workspace_id
     WHERE member.workspace_id=? AND member.user_id=?`,
  ).bind(workspaceId, userId).first<AdminMemberMutationState>();
  if (!current) refuseAdminMutation("Workspace membership was not found");
  if (current.deleted) refuseAdminMutation("Workspace has been deleted");
  return current;
}

async function accountWorkspaceIds(
  db: Db,
  userId: string,
): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT workspace_id
     FROM workspace_members
     WHERE user_id=?
     ORDER BY workspace_id`,
  ).bind(userId).all<{ workspace_id: string }>();
  return rows.results.map(row => row.workspace_id);
}

function assertAdminMemberMutationRevisions(
  current: AdminMemberMutationState,
  expectedAccessRevision: number,
  expectedMembershipRevision: number,
): void {
  if (
    current.access_revision !== expectedAccessRevision ||
    current.membership_revision !== expectedMembershipRevision
  ) {
    throw new ApiProblem(
      "ACCESS_STALE",
      "Workspace access or membership changed; refresh and try again",
      409,
      {
        accessRevision: current.access_revision,
        membershipRevision: current.membership_revision,
      },
    );
  }
}

async function explainMemberRoleRefusal(
  db: Db,
  workspaceId: string,
  userId: string,
  role: string,
  expectedAccessRevision: number,
  expectedMembershipRevision: number,
): Promise<never> {
  const current = await currentAdminMemberMutationState(
    db,
    workspaceId,
    userId,
  );
  assertAdminMemberMutationRevisions(
    current,
    expectedAccessRevision,
    expectedMembershipRevision,
  );
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
  expectedAccessRevision: number,
  expectedMembershipRevision: number,
): Promise<never> {
  const current = await currentAdminMemberMutationState(
    db,
    workspaceId,
    userId,
  );
  assertAdminMemberMutationRevisions(
    current,
    expectedAccessRevision,
    expectedMembershipRevision,
  );
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
  options: AdminMutationOptions = {},
) {
  const db = database as unknown as Db;
  await requireActiveAdminActor(db, actor);
  const now = nowIso();
  let currentSessionRevoked: boolean | undefined;
  let affectedWorkspaceIds: string[] = [];
  let message = "Administrative change saved";
  let revokedSessions: number | undefined;
  let unusedGuestLinksRevoked: number | undefined;
  switch (input.action) {
    case "user.role": {
      if (!["admin", "user"].includes(input.value ?? "")) {
        refuseAdminMutation("Invalid role");
      }
      const role = input.value as "admin" | "user";
      const result = await changeGlobalRole(database, {
        actorUserId: actor,
        expectedAccountRevision: requiredAdminRevision(
          input,
          "expectedAccountRevision",
        ),
        role,
        targetUserId: input.targetId,
      });
      revokedSessions = result.revokedSessions;
      message = `User role changed to ${role}`;
      break;
    }
    case "user.status": {
      if (!["active", "disabled"].includes(input.value ?? "")) {
        refuseAdminMutation("Invalid status");
      }
      const status = input.value as "active" | "disabled";
      const result = await changeAccountStatus(database, {
        actorUserId: actor,
        expectedAccountRevision: requiredAdminRevision(
          input,
          "expectedAccountRevision",
        ),
        status,
        targetUserId: input.targetId,
      });
      if (status === "disabled") {
        revokedSessions = result.revokedSessions;
        unusedGuestLinksRevoked =
          result.unusedGuestLinksRevoked;
      }
      affectedWorkspaceIds = await accountWorkspaceIds(
        db,
        input.targetId,
      );
      message = status === "disabled"
        ? "User disabled"
        : "User enabled";
      break;
    }
    case "user.ban": {
      if (!options.identityDigestKey) {
        throw new ApiProblem(
          "STORAGE_UNAVAILABLE",
          "Identity enforcement is not configured",
          503,
        );
      }
      const result = await banAccount(database, {
        actorUserId: actor,
        digestKey: options.identityDigestKey,
        expectedAccountRevision: requiredAdminRevision(
          input,
          "expectedAccountRevision",
        ),
        reason: input.reason ?? "",
        targetUserId: input.targetId,
      });
      revokedSessions = result.revokedSessions;
      affectedWorkspaceIds = await accountWorkspaceIds(
        db,
        input.targetId,
      );
      message = "Account banned and sign-in identities redacted";
      break;
    }
    case "user.ban.lift": {
      await liftAccountBan(database, {
        actorUserId: actor,
        expectedAccountRevision: requiredAdminRevision(
          input,
          "expectedAccountRevision",
        ),
        targetUserId: input.targetId,
      });
      message = "Account ban lifted; the account remains disabled";
      break;
    }
    case "circuit.set": {
      if (
        !Object.values(CIRCUIT_BREAKER_SCOPE)
          .includes(input.targetId as CircuitBreakerScope)
      ) {
        refuseAdminMutation("Invalid circuit scope");
      }
      if (
        !Object.values(CIRCUIT_BREAKER_STATE)
          .includes(input.value as CircuitBreakerState)
      ) {
        refuseAdminMutation("Invalid circuit state");
      }
      if (
        !Object.values(CIRCUIT_BREAKER_PAUSE_KIND)
          .includes(input.pauseKind as CircuitBreakerPauseKind)
      ) {
        refuseAdminMutation("Invalid circuit pause kind");
      }
      const scope = input.targetId as CircuitBreakerScope;
      const state = input.value as CircuitBreakerState;
      const pauseKind =
        input.pauseKind as CircuitBreakerPauseKind;
      let resumeAt: string | null = null;
      if (
        state === CIRCUIT_BREAKER_STATE.PAUSED
        && pauseKind === CIRCUIT_BREAKER_PAUSE_KIND.SECURITY
      ) {
        const current = (await readCircuitBreakers(database))
          .find(candidate => candidate.scope === scope);
        const duration = (current?.triggerCount ?? 0) > 0
          ? SECURITY_BREAKER_RETRIGGER_PAUSE_MS
          : SECURITY_BREAKER_INITIAL_PAUSE_MS;
        resumeAt = new Date(Date.now() + duration).toISOString();
      }
      const result = await setCircuitBreaker(database, {
        actorUserId: actor,
        pauseKind,
        reason: state === CIRCUIT_BREAKER_STATE.PAUSED
          ? input.reason ?? null
          : null,
        resumeAt,
        scope,
        state,
      });
      message = result.state === CIRCUIT_BREAKER_STATE.OPEN
        ? `${scope} circuit opened`
        : `${scope} circuit paused`;
      break;
    }
    case "governance.limit.set": {
      if (
        !Object.values(GOVERNANCE_LIMIT_KEY)
          .includes(input.targetId as GovernanceLimitKey)
      ) {
        refuseAdminMutation("Invalid governance limit");
      }
      if (
        input.value === undefined ||
        !/^(0|[1-9]\d*)$/u.test(input.value)
      ) {
        refuseAdminMutation(
          "Governance limit value must be a non-negative integer",
        );
      }
      const value = Number(input.value);
      if (!Number.isSafeInteger(value)) {
        refuseAdminMutation(
          "Governance limit value must be a non-negative safe integer",
        );
      }
      const result = await setGovernanceLimit(database, {
        actorUserId: actor,
        key: input.targetId as GovernanceLimitKey,
        reason: input.reason ?? "",
        value,
      });
      message =
        `${result.key} limit changed to ${result.value.toLocaleString()}`;
      break;
    }
    case "identity.unlink": {
      const signInProviderIds = options.signInProviderIds
        ? [...new Set(
            options.signInProviderIds
              .map(providerId => providerId.trim())
              .filter(Boolean),
          )]
        : null;
      const remainingIdentityGuard = signInProviderIds
        ? signInProviderIds.length > 0
          ? `AND EXISTS (
               SELECT 1
               FROM identities remaining
               WHERE remaining.user_id=(
                 SELECT user_id
                 FROM identities
                 WHERE identity_id=?
               )
                 AND remaining.identity_id<>?
                 AND remaining.provider IN (${
                   signInProviderIds.map(() => "?").join(",")
                 })
             )`
          : "AND 0=1"
        : `AND (
             SELECT COUNT(*)
             FROM identities
             WHERE user_id=(
               SELECT user_id
               FROM identities
               WHERE identity_id=?
             )
           )>1`;
      const result = await runAuditedMutation(
        db,
        actor,
        input,
        db.prepare(
          `DELETE FROM identities
           WHERE identity_id=?
             ${remainingIdentityGuard}
             AND EXISTS (
               SELECT 1
               FROM users admin_actor
               WHERE admin_actor.user_id=?
                 AND admin_actor.status='active'
                 AND admin_actor.deleted_at IS NULL
                 AND admin_actor.global_role='admin'
             )`,
        ).bind(
          input.targetId,
          ...(signInProviderIds === null
            ? [input.targetId]
            : signInProviderIds.length > 0
              ? [
                  input.targetId,
                  input.targetId,
                  ...signInProviderIds,
                ]
              : []),
          actor,
        ),
      );
      if (changes(result) !== 1) {
        await requireActiveAdminActor(db, actor);
        const identity = await db.prepare(
          "SELECT user_id FROM identities WHERE identity_id=?",
        ).bind(input.targetId).first<{ user_id: string }>();
        if (!identity) refuseAdminMutation("Identity was not found");
        refuseAdminMutation(
          "A user must retain at least one configured direct sign-in identity",
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
      const expectedAccessRevision = requiredAdminRevision(
        input,
        "expectedAccessRevision",
      );
      const expectedMembershipRevision = requiredAdminRevision(
        input,
        "expectedMembershipRevision",
      );
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
             )
             AND EXISTS (
               SELECT 1
               FROM workspace_snapshots snapshot
               WHERE snapshot.workspace_id=workspace_members.workspace_id
                 AND snapshot.access_revision=?
             )
             AND EXISTS (
               SELECT 1
               FROM users target_user
               WHERE target_user.user_id=workspace_members.user_id
                 AND target_user.membership_revision=?
             )
             AND EXISTS (
               SELECT 1
               FROM users admin_actor
               WHERE admin_actor.user_id=?
                 AND admin_actor.status='active'
                 AND admin_actor.deleted_at IS NULL
                 AND admin_actor.global_role='admin'
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
          expectedAccessRevision,
          expectedMembershipRevision,
          actor,
        ),
      );
      if (changes(result) !== 1) {
        await requireActiveAdminActor(db, actor);
        await explainMemberRoleRefusal(
          db,
          target.workspaceId,
          target.userId,
          role,
          expectedAccessRevision,
          expectedMembershipRevision,
        );
      }
      affectedWorkspaceIds = [target.workspaceId];
      message = `Workspace role changed to ${role}`;
      break;
    }
    case "member.remove": {
      const target = membershipTarget(input.targetId);
      const expectedAccessRevision = requiredAdminRevision(
        input,
        "expectedAccessRevision",
      );
      const expectedMembershipRevision = requiredAdminRevision(
        input,
        "expectedMembershipRevision",
      );
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
             )
             AND EXISTS (
               SELECT 1
               FROM workspace_snapshots snapshot
               WHERE snapshot.workspace_id=workspace_members.workspace_id
                 AND snapshot.access_revision=?
             )
             AND EXISTS (
               SELECT 1
               FROM users target_user
               WHERE target_user.user_id=workspace_members.user_id
                 AND target_user.membership_revision=?
             )
             AND EXISTS (
               SELECT 1
               FROM users admin_actor
               WHERE admin_actor.user_id=?
                 AND admin_actor.status='active'
                 AND admin_actor.deleted_at IS NULL
                 AND admin_actor.global_role='admin'
             )`,
        ).bind(
          target.workspaceId,
          target.userId,
          target.workspaceId,
          expectedAccessRevision,
          expectedMembershipRevision,
          actor,
        ),
      );
      if (changes(result) !== 1) {
        await requireActiveAdminActor(db, actor);
        await explainMemberRemovalRefusal(
          db,
          target.workspaceId,
          target.userId,
          expectedAccessRevision,
          expectedMembershipRevision,
        );
      }
      affectedWorkspaceIds = [target.workspaceId];
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
             AND expires_at>?
             AND EXISTS (
               SELECT 1
               FROM users admin_actor
               WHERE admin_actor.user_id=?
                 AND admin_actor.status='active'
                 AND admin_actor.deleted_at IS NULL
                 AND admin_actor.global_role='admin'
             )`,
        ).bind(now, input.targetId, now, actor),
      );
      if (changes(result) !== 1) {
        await requireActiveAdminActor(db, actor);
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
    case "session.revoke-pre-google": {
      if (input.targetId !== SESSION_REVOCATION_SCOPE.PRE_GOOGLE) {
        refuseAdminMutation(
          "Only pre-Google sessions can be revoked in bulk",
        );
      }
      currentSessionRevoked = options.actorSessionId
        ? Boolean(await db.prepare(
            `SELECT 1 AS active
             FROM sessions
             WHERE session_id=?
               AND (
                 authentication_provider=?
                 OR authentication_provider IS NULL
               )
               AND revoked_at IS NULL
               AND expires_at>?`,
          ).bind(
            options.actorSessionId,
            SESSION_AUTHENTICATION_PROVIDER.ACCESS_MIGRATION,
            now,
          ).first<{ active: number }>())
        : false;
      const [mutationResult, auditResult] = await db.batch([
        db.prepare(
          `UPDATE sessions
           SET revoked_at=?
           WHERE (
               authentication_provider=?
               OR authentication_provider IS NULL
             )
             AND revoked_at IS NULL
             AND expires_at>?
             AND EXISTS (
               SELECT 1
               FROM users admin_actor
               WHERE admin_actor.user_id=?
                 AND admin_actor.status='active'
                 AND admin_actor.deleted_at IS NULL
                 AND admin_actor.global_role='admin'
             )`,
        ).bind(
          now,
          SESSION_AUTHENTICATION_PROVIDER.ACCESS_MIGRATION,
          now,
          actor,
        ),
        db.prepare(
          `INSERT INTO auth_audit_events(
             event_id,actor_user_id,action,target_type,target_id,
             detail_json,created_at
           )
           SELECT ?,?,'session.revoke-pre-google','session',?,'{}',?
           WHERE changes()>0`,
        ).bind(newId("aud"), actor, input.targetId, now),
      ]);
      revokedSessions = changes(mutationResult);
      if (revokedSessions < 1 || changes(auditResult) !== 1) {
        currentSessionRevoked = false;
        await requireActiveAdminActor(db, actor);
        refuseAdminMutation(
          "No active pre-Google sessions remain",
        );
      }
      message = "Pre-Google sessions revoked";
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
             )
             AND EXISTS (
               SELECT 1
               FROM users admin_actor
               WHERE admin_actor.user_id=?
                 AND admin_actor.status='active'
                 AND admin_actor.deleted_at IS NULL
                 AND admin_actor.global_role='admin'
             )`,
        ).bind(now, input.targetId, now, actor),
      );
      if (changes(result) !== 1) {
        await requireActiveAdminActor(db, actor);
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
      const changedLink = await db.prepare(
        `SELECT workspace_id
         FROM guest_links
         WHERE guest_link_id=?`,
      ).bind(input.targetId).first<{ workspace_id: string }>();
      if (!changedLink) {
        throw new Error("Revoked guest link workspace was not found");
      }
      affectedWorkspaceIds = [changedLink.workspace_id];
      message = "Guest link revoked";
      break;
    }
    case "guest.delete": {
      const link = await db.prepare(
        `SELECT guest_link_id,workspace_id,role,created_at,expires_at,
                consumed_at,revoked_at,created_by_user_id,redemption_id
         FROM guest_links
         WHERE guest_link_id=?`,
      ).bind(input.targetId).first<{
        consumed_at: string | null;
        created_at: string;
        created_by_user_id: string;
        expires_at: string;
        guest_link_id: string;
        redemption_id: string | null;
        revoked_at: string | null;
        role: string;
        workspace_id: string;
      }>();
      if (!link) refuseAdminMutation("Guest link was not found");
      const priorStatus = link.revoked_at
        ? "revoked"
        : link.consumed_at
          ? "used"
          : link.expires_at <= now
            ? "expired"
            : "active";
      const detail = safeAuditDetailJson(
        "guest.delete",
        {
          consumedAt: link.consumed_at,
          createdAt: link.created_at,
          createdByUserId: link.created_by_user_id,
          expiresAt: link.expires_at,
          priorStatus,
          redemptionId: link.redemption_id,
          revokedAt: link.revoked_at,
          role: link.role,
          workspaceId: link.workspace_id,
        },
      );
      const [, auditResult] = await db.batch([
        db.prepare(
          `DELETE FROM guest_links
           WHERE guest_link_id=?
             AND workspace_id=?
             AND role=?
             AND created_at=?
             AND expires_at=?
             AND consumed_at IS ?
             AND revoked_at IS ?
             AND created_by_user_id=?
             AND redemption_id IS ?
             AND EXISTS (
               SELECT 1
               FROM users admin_actor
               WHERE admin_actor.user_id=?
                 AND admin_actor.status='active'
                 AND admin_actor.deleted_at IS NULL
                 AND admin_actor.global_role='admin'
             )`,
        ).bind(
          input.targetId,
          link.workspace_id,
          link.role,
          link.created_at,
          link.expires_at,
          link.consumed_at,
          link.revoked_at,
          link.created_by_user_id,
          link.redemption_id,
          actor,
        ),
        db.prepare(
          `INSERT INTO auth_audit_events(
             event_id,actor_user_id,action,target_type,target_id,detail_json,
             created_at
           )
           SELECT ?,?,?,?,?,?,?
           WHERE changes()=1`,
        ).bind(
          newId("aud"),
          actor,
          input.action,
          "guest",
          input.targetId,
          detail,
          now,
        ),
      ]);
      if (changes(auditResult) !== 1) {
        await requireActiveAdminActor(db, actor);
        const current = await db.prepare(
          `SELECT 1 AS present
           FROM guest_links
           WHERE guest_link_id=?`,
        ).bind(input.targetId).first<{ present: number }>();
        refuseAdminMutation(
          current
            ? "Guest link changed; refresh before deleting it"
            : "Guest link was not found",
        );
      }
      affectedWorkspaceIds = [link.workspace_id];
      message = "Guest link deleted";
      break;
    }
    default:
      refuseAdminMutation("Unsupported admin action");
  }
  return {
    ...(affectedWorkspaceIds.length > 0
      ? { affectedWorkspaceIds }
      : {}),
    ...(currentSessionRevoked === undefined
      ? {}
      : { currentSessionRevoked }),
    message,
    ...(revokedSessions === undefined ? {} : { revokedSessions }),
    ...(unusedGuestLinksRevoked === undefined
      ? {}
      : { unusedGuestLinksRevoked }),
  };
}
